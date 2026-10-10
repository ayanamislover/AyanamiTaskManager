//! 电脑侧同步连接器（docs/mobile-sync.md §7，2.x `packages/sync/src/connector.ts`）：配置与密钥、快照发布、
//! 命令处理、在线状态。只做出站 HTTPS，默认关闭，未启用时不联网。
//!
//! 线程：每轮同步循环一个线程（连上 → 首次同步 → 推进变更流），外加在线状态心跳、发布计时与存储观察线程。
//! 对中继的写操作（发布、命令、在线状态）经 [`Chain`] 串行；设置页操作（改配置、配对、重置）经 `admin` 串行。
//!
//! 能力（03 §3）：设置页的操作要 User 的 `sync.status` / `sync.configure` / `sync.test_relay` /
//! `sync.pairing_create` / `sync.reset`，先于一切副作用检查；同步循环用 System `sync.loop`，命令以手机（Phone）
//! 的身份执行。

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use atm_domain::capability::{self, Capability};
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::principal::{JobId, Principal};
use atm_service::write::Service;
use atm_sync_protocol::pairing::{PairingPayload, encode_pairing_code, generate_space};
use serde_json::{Value, json};

use crate::config::{SyncConfig, default_config, default_device_name, hostname, is_valid};
use crate::dispatch::DispatchPort;
use crate::errors::{Failure, RELAY_REJECTED_MESSAGE, describe, redact};
use crate::feed::backoff_delay;
use crate::host::{Clock, Host, Log, LoopState, NoLog};
use crate::relay::{RelayClient, RelayClientOptions};
use crate::scheduler::{Scheduler, SchedulerHooks, Watcher};
use crate::secrets::{Cipher, Dpapi, DpapiSecretStore, SecretError, SecretVault};
use crate::session::{Dirty, Session, SessionOptions};
use crate::settings::{
    parse_relay_candidate, plan_config_change, probe_result, purge_space, revoke_space,
};
use crate::time::{iso, now_ms};
use crate::transport::{Cancel, Sleeper, Transport};

/// 内部阶段，比对外的 state 细：对外 unconfigured / retrying / rejected / failed 都是 error，stopped 是 disabled。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Disabled,
    Unconfigured,
    Connecting,
    Online,
    Retrying,
    Rejected,
    Failed,
    Stopped,
}

impl Phase {
    pub fn public(self) -> &'static str {
        match self {
            Phase::Disabled | Phase::Stopped => "disabled",
            Phase::Connecting => "connecting",
            Phase::Online => "online",
            Phase::Unconfigured | Phase::Retrying | Phase::Rejected | Phase::Failed => "error",
        }
    }
}

pub const UNCONFIGURED_MESSAGE: &str = "已启用手机同步，但还没有填写中继地址或 token";

#[derive(Debug, Clone, Copy)]
pub struct Timings {
    /// 任务变化后等多久再发布（去抖），默认 1.5 s。
    pub debounce: Duration,
    /// 持续变化时最多攒多久，默认 10 s。
    pub max_delay: Duration,
    /// 在线状态间隔，默认 5 分钟。
    pub presence: Duration,
    /// 不支持长轮询时的轮询间隔，默认 4 s。
    pub poll_interval: Duration,
    /// 发布失败后多久重试，默认 15 s。
    pub retry_publish: Duration,
    /// 停止的总预算（等在途的中继写操作、写离线状态），默认 5 s；到点掐断会话的全部中继请求。
    pub stop_timeout: Duration,
}

impl Default for Timings {
    fn default() -> Self {
        Timings {
            debounce: Duration::from_millis(1500),
            max_delay: Duration::from_secs(10),
            presence: Duration::from_secs(5 * 60),
            poll_interval: Duration::from_secs(4),
            retry_publish: Duration::from_secs(15),
            stop_timeout: Duration::from_secs(5),
        }
    }
}

/// 停止预算用完、掐断中继请求后，再等在途任务落定的时间。
const ABORT_SETTLE: Duration = Duration::from_millis(500);

pub struct ConnectorOptions<C: Cipher = Dpapi> {
    pub service: Arc<Service>,
    /// `<数据目录>/sync` 下的密钥文件（`secrets.dpapi.json`）。
    pub secrets: DpapiSecretStore<C>,
    /// 写进 head 与在线状态的 ATM 版本。
    pub app_version: String,
    pub dispatch: Option<Arc<dyn DispatchPort>>,
    pub transport: Arc<dyn Transport>,
    pub log: Option<Arc<dyn Log>>,
    pub now: Option<Clock>,
    /// 默认设备名，缺省取主机名。
    pub device_name: Option<String>,
    pub timings: Timings,
    /// 退避与轮询用的等待（用例换掉）。
    pub sleep: Option<Sleeper>,
}

/// 对中继写操作的串行链：同一时刻只有一个在跑；停下时可以限时等它空下来。
#[derive(Default)]
pub struct Chain {
    busy: Mutex<bool>,
    idle: Condvar,
}

struct ChainTurn<'a>(&'a Chain);

impl Drop for ChainTurn<'_> {
    fn drop(&mut self) {
        *self.0.busy.lock().unwrap_or_else(|e| e.into_inner()) = false;
        self.0.idle.notify_all();
    }
}

impl Chain {
    pub fn run<T>(&self, f: impl FnOnce() -> T) -> T {
        {
            let mut busy = self.busy.lock().unwrap_or_else(|e| e.into_inner());
            while *busy {
                busy = self.idle.wait(busy).unwrap_or_else(|e| e.into_inner());
            }
            *busy = true;
        }
        let _turn = ChainTurn(self);
        f()
    }

    /// 在 `timeout` 内空下来返回 `true`。
    pub fn wait_idle(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut busy = self.busy.lock().unwrap_or_else(|e| e.into_inner());
        while *busy {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            busy = self
                .idle
                .wait_timeout(busy, deadline - now)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        true
    }
}

/// 一轮同步循环：从连上配对空间到停下（停用、改连接设置、重置配对、退出）。
struct Loop {
    id: u64,
    /// 中断循环本身：长轮询、退避等待、心跳。
    stop: Cancel,
    /// 会话的全部中继请求；停下收尾后或到预算时取消。
    relay: Cancel,
    /// 已停下：之后这个会话迟到的任务不能再碰服务与派单（core 随后就会关库）。
    retired: Arc<AtomicBool>,
    session: Mutex<Option<Arc<Session>>>,
    /// 首次同步已完成，可以接受去抖发布与在线状态心跳。
    ready: AtomicBool,
    /// 已经因为游标被拒（400）清过一次游标；再被拒就按普通错误处理。
    cursor_rescued: AtomicBool,
    finished: Mutex<bool>,
    finished_changed: Condvar,
}

impl Loop {
    fn session(&self) -> Option<Arc<Session>> {
        self.session
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn retire(&self) {
        self.retired.store(true, Ordering::SeqCst);
        self.relay.cancel();
    }

    fn mark_finished(&self) {
        *self.finished.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.finished_changed.notify_all();
    }

    fn wait_finished(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut done = self.finished.lock().unwrap_or_else(|e| e.into_inner());
        while !*done {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            done = self
                .finished_changed
                .wait_timeout(done, deadline - now)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        true
    }
}

struct State<C: Cipher> {
    config: SyncConfig,
    vault: SecretVault<C>,
    phase: Phase,
    last_error: Option<String>,
    long_poll: Option<bool>,
    devices: Vec<Value>,
    pending: usize,
    started: bool,
    current: Option<Arc<Loop>>,
    /// 设置页发起的中继请求（测试连接、清理旧空间）；停止时一并取消。
    management: Cancel,
}

struct Inner<C: Cipher> {
    service: Arc<Service>,
    dispatch: Option<Arc<dyn DispatchPort>>,
    transport: Arc<dyn Transport>,
    log: Arc<dyn Log>,
    now: Clock,
    sleep: Option<Sleeper>,
    app_version: String,
    timings: Timings,
    state: Mutex<State<C>>,
    chain: Chain,
    admin: Mutex<()>,
    /// 进行中的停下（改连接设置、重置配对、停止各自发起）：停止要等它们全部收尾。
    halts: Mutex<usize>,
    halts_changed: Condvar,
    next_loop: AtomicU64,
    scheduler: Mutex<Option<Arc<Scheduler>>>,
    timer: Mutex<Option<JoinHandle<()>>>,
    watcher: Mutex<Option<Watcher>>,
    me: Weak<Inner<C>>,
}

/// 同步循环自己的主体。
fn loop_principal() -> Principal {
    Principal::system_job(JobId::SyncLoop)
}

fn secret_failure(e: SecretError) -> DomainError {
    DomainError::new(ErrorCode::VALIDATION_ERROR, e.to_string()).detail("reason", e.reason())
}

/// 日志外面包一层：消息与 meta 里的字符串（任意层）都先抹掉密钥字面量（2.x `redactingLogger`）。
struct Redacting<C: Cipher> {
    inner: Arc<dyn Log>,
    owner: Weak<Inner<C>>,
}

fn scrub(v: &Value, secrets: &[&str], depth: usize) -> Value {
    match v {
        Value::String(s) => Value::String(redact(s, secrets)),
        Value::Array(items) if depth > 0 => {
            Value::Array(items.iter().map(|i| scrub(i, secrets, depth - 1)).collect())
        }
        Value::Object(m) if depth > 0 => Value::Object(
            m.iter()
                .map(|(k, i)| (k.clone(), scrub(i, secrets, depth - 1)))
                .collect(),
        ),
        Value::Array(_) | Value::Object(_) => Value::String("[…]".into()),
        other => other.clone(),
    }
}

impl<C: Cipher + Send + Sync + 'static> Redacting<C> {
    fn emit(&self, level: u8, message: &str, meta: &Value) {
        let secrets = self
            .owner
            .upgrade()
            .map(|o| o.secret_values())
            .unwrap_or_default();
        let refs: Vec<&str> = secrets.iter().map(String::as_str).collect();
        let message = redact(message, &refs);
        let meta = scrub(meta, &refs, 6);
        match level {
            0 => self.inner.info(&message, &meta),
            1 => self.inner.warn(&message, &meta),
            _ => self.inner.error(&message, &meta),
        }
    }
}

impl<C: Cipher + Send + Sync + 'static> Log for Redacting<C> {
    fn info(&self, m: &str, meta: &Value) {
        self.emit(0, m, meta)
    }
    fn warn(&self, m: &str, meta: &Value) {
        self.emit(1, m, meta)
    }
    fn error(&self, m: &str, meta: &Value) {
        self.emit(2, m, meta)
    }
}

/// 一轮循环交给会话的状态出口：被替换（停止、换空间）的会话迟到的写入不再落到配置里。
struct Cell<C: Cipher> {
    owner: Weak<Inner<C>>,
    id: u64,
}

impl<C: Cipher + Send + Sync + 'static> LoopState for Cell<C> {
    fn config(&self) -> SyncConfig {
        match self.owner.upgrade() {
            Some(o) => o.lock().config.clone(),
            None => default_config("ATM 电脑").unwrap_or_else(unreachable_config),
        }
    }

    fn commit(
        &self,
        mutate: &mut dyn FnMut(&SyncConfig) -> Option<SyncConfig>,
    ) -> Result<(), Failure> {
        let Some(owner) = self.owner.upgrade() else {
            return Ok(());
        };
        let mut s = owner.lock();
        if s.current.as_ref().map(|l| l.id) != Some(self.id) {
            return Ok(());
        }
        if let Some(next) = mutate(&s.config) {
            owner.persist(&loop_principal(), &next)?;
            s.config = next;
        }
        Ok(())
    }

    fn on_devices(&self, devices: Vec<Value>) {
        if let Some(owner) = self.owner.upgrade() {
            let mut s = owner.lock();
            if s.current.as_ref().map(|l| l.id) == Some(self.id) {
                s.devices = devices;
            }
        }
    }

    fn on_pending(&self, count: usize) {
        if let Some(owner) = self.owner.upgrade() {
            let mut s = owner.lock();
            if s.current.as_ref().map(|l| l.id) == Some(self.id) {
                s.pending = count;
            }
        }
    }
}

fn unreachable_config() -> SyncConfig {
    SyncConfig {
        enabled: false,
        relay_url: None,
        app_id: crate::config::DEFAULT_APP_ID.into(),
        device_id: "pc-000000000000".into(),
        device_name: "ATM 电脑".into(),
        space_id: None,
        cursor: None,
        published: Default::default(),
        head_digest: None,
        processed: Vec::new(),
        last_sync_at: None,
        last_ack_sweep_at: None,
    }
}

pub struct Connector<C: Cipher + Send + Sync + 'static = Dpapi> {
    inner: Arc<Inner<C>>,
}

impl<C: Cipher + Send + Sync + 'static> Inner<C> {
    fn lock(&self) -> MutexGuard<'_, State<C>> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn arc(&self) -> Arc<Inner<C>> {
        self.me.upgrade().expect("connector alive")
    }

    fn secret_values(&self) -> Vec<String> {
        let s = self.lock();
        [s.vault.token(), s.vault.secret()]
            .into_iter()
            .flatten()
            .map(str::to_owned)
            .collect()
    }

    /// 错误写进 lastError、日志或设置页结果前统一走这里：本地文案，再抹一遍密钥字面量。
    fn describe(&self, e: &Failure) -> String {
        let secrets = self.secret_values();
        let refs: Vec<&str> = secrets.iter().map(String::as_str).collect();
        redact(&describe(e), &refs)
    }

    fn persist(&self, principal: &Principal, config: &SyncConfig) -> Result<(), Failure> {
        self.service
            .save_sync_ledger(principal, config)
            .map_err(Failure::Domain)
    }

    fn configured(s: &State<C>) -> bool {
        s.config.relay_url.is_some() && !s.config.app_id.is_empty() && s.vault.token().is_some()
    }

    fn idle_phase(s: &State<C>) -> Phase {
        if !s.config.enabled {
            Phase::Disabled
        } else if !Self::configured(s) {
            Phase::Unconfigured
        } else {
            Phase::Connecting
        }
    }

    fn ready_session(&self) -> Option<Arc<Session>> {
        let l = self.lock().current.clone()?;
        if l.ready.load(Ordering::SeqCst) {
            l.session()
        } else {
            None
        }
    }

    fn client(
        &self,
        relay_url: &str,
        app_id: &str,
        token: &str,
        lifetime: Cancel,
    ) -> Result<RelayClient, Failure> {
        RelayClient::new(RelayClientOptions {
            base_url: relay_url.to_owned(),
            app_id: app_id.to_owned(),
            token: token.to_owned(),
            transport: self.transport.clone(),
            timeout: None,
            lifetime: Some(lifetime),
        })
        .map_err(|e| match e {
            crate::relay::ClientError::Url(e) => Failure::Protocol(e),
            crate::relay::ClientError::Relay(e) => Failure::Relay(e),
        })
    }

    /// 没有配对空间就建一个（单飞）：检查与新建在同一把状态锁里，同步循环与配对请求并发时也只建一次。
    fn ensure_space(&self, principal: &Principal) -> Result<(), Failure> {
        let mut s = self.lock();
        if s.config.space_id.is_some() && s.vault.secret().is_some() {
            return Ok(());
        }
        self.create_space_locked(&mut s, principal)
    }

    fn create_space(&self, principal: &Principal) -> Result<(), Failure> {
        let mut s = self.lock();
        self.create_space_locked(&mut s, principal)
    }

    /// 新空间：先落密钥再改配置；游标、已发布摘要一并作废（新会话的修订号缓存也从零开始）。
    fn create_space_locked(&self, s: &mut State<C>, principal: &Principal) -> Result<(), Failure> {
        let (space_id, secret) = generate_space()
            .ok_or_else(|| Failure::Other("系统随机数不可用，建不了配对空间".into()))?;
        s.vault
            .set_space(&space_id, &secret)
            .map_err(|e| Failure::Domain(secret_failure(e)))?;
        let mut next = s.config.clone();
        next.space_id = Some(space_id);
        next.cursor = None;
        next.published.clear();
        next.head_digest = None;
        next.last_ack_sweep_at = None;
        self.persist(principal, &next)?;
        s.config = next;
        s.devices.clear();
        Ok(())
    }

    fn launch(&self) {
        let mut s = self.lock();
        if !s.started || s.current.is_some() {
            return;
        }
        s.phase = Self::idle_phase(&s);
        if s.phase != Phase::Connecting {
            return;
        }
        let l = Arc::new(Loop {
            id: self.next_loop.fetch_add(1, Ordering::SeqCst) + 1,
            stop: Cancel::new(),
            relay: Cancel::new(),
            retired: Arc::new(AtomicBool::new(false)),
            session: Mutex::new(None),
            ready: AtomicBool::new(false),
            cursor_rescued: AtomicBool::new(false),
            finished: Mutex::new(false),
            finished_changed: Condvar::new(),
        });
        s.current = Some(l.clone());
        drop(s);
        let me = self.arc();
        let spawned = std::thread::Builder::new()
            .name("atm-sync-loop".into())
            .spawn(move || {
                me.run(&l);
                l.mark_finished();
            });
        if spawned.is_err() {
            let mut s = self.lock();
            s.current = None;
            s.phase = Phase::Failed;
            s.last_error = Some("同步线程启动失败".into());
        }
    }

    fn host_for(&self, l: &Loop) -> Host {
        let me = self.arc();
        Host::new(
            self.service.clone(),
            self.dispatch.clone(),
            l.retired.clone(),
            self.app_version.clone(),
            self.log.clone(),
            self.now.clone(),
            Arc::new(Cell {
                owner: Arc::downgrade(&me),
                id: l.id,
            }),
        )
    }

    fn open(&self, l: &Loop) -> Result<Option<Session>, Failure> {
        let (relay_url, app_id, space_id, token, secret) = {
            let s = self.lock();
            (
                s.config.relay_url.clone(),
                s.config.app_id.clone(),
                s.config.space_id.clone(),
                s.vault.token().map(str::to_owned),
                s.vault.secret().map(str::to_owned),
            )
        };
        let (Some(relay_url), Some(space_id), Some(token), Some(secret)) =
            (relay_url, space_id, token, secret)
        else {
            return Ok(None);
        };
        let session = Session::open(
            self.host_for(l),
            SessionOptions {
                relay_url,
                app_id,
                token,
                space_id,
                secret,
                transport: self.transport.clone(),
                poll_interval: self.timings.poll_interval,
                sleep: self.sleep.clone(),
                lifetime: l.relay.clone(),
            },
        )?;
        self.lock().long_poll = Some(session.probe.long_poll);
        Ok(Some(session))
    }

    fn sleep_in(&self, l: &Loop, d: Duration) {
        match &self.sleep {
            Some(s) => {
                s(d);
            }
            None => {
                l.stop.sleep(d);
            }
        }
    }

    fn run(&self, l: &Loop) {
        let mut failures: u32 = 0;
        while !l.stop.is_cancelled() {
            match self.step(l) {
                Ok(true) => failures = 0,
                Ok(false) => return,
                Err(e) => {
                    if l.stop.is_cancelled() {
                        return;
                    }
                    if e.is_auth_failure() {
                        return self.reject(l);
                    }
                    failures += 1;
                    let message = self.describe(&e);
                    {
                        let mut s = self.lock();
                        if s.current.as_ref().map(|c| c.id) == Some(l.id) {
                            s.phase = Phase::Retrying;
                            s.last_error = Some(message.clone());
                        }
                    }
                    self.log.warn(
                        "同步失败，稍后重试",
                        &json!({ "error": message, "failures": failures }),
                    );
                    // 中继限流（429）给了 retry_after 就至少等那么久。
                    let asked = e
                        .relay()
                        .and_then(|r| r.retry_after)
                        .map_or(Duration::ZERO, Duration::from_secs_f64);
                    let delay = backoff_delay(failures)
                        .max(asked)
                        .min(Duration::from_secs(60));
                    self.sleep_in(l, delay);
                }
            }
        }
    }

    /// 一轮：`Ok(true)` 继续，`Ok(false)` 循环结束（停下或不可恢复）。
    fn step(&self, l: &Loop) -> Result<bool, Failure> {
        if l.session().is_none() {
            if let Err(e) = self.ensure_space(&loop_principal()) {
                // 建不了配对空间（例如系统加密不可用）：重试没用，停下并说明原因。
                self.fail(l, &e);
                return Ok(false);
            }
            let Some(session) = self.open(l)? else {
                return Ok(false);
            };
            *l.session.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(session));
        }
        let Some(session) = l.session() else {
            return Ok(false);
        };
        if l.stop.is_cancelled() {
            return Ok(false);
        }
        if !l.ready.load(Ordering::SeqCst) {
            if let Some(s) = self.scheduler() {
                s.begin_full_publish();
            }
            // 第一次连这个中继：先翻到变更流头部拿游标，全量交给首次同步，不再重写第二遍。
            if session.cursor().is_none() {
                session.feed().next(Some(&l.stop))?;
            }
            self.chain.run(|| session.initial_sync())?;
            l.ready.store(true, Ordering::SeqCst);
            self.arm_presence(l);
            self.mark_synced(l, &session)?;
            if let Some(s) = self.scheduler() {
                s.after_full_publish();
            }
        }
        // 之前有游标却被要求重来 = 游标过期（410），可能漏了变更：全量重写。之前就没有游标只是第一次拿到。
        let had_cursor = session.cursor().is_some();
        // 先放开变更流的锁再看结果：救援分支的 reset_feed 要重新拿这把锁。
        let next = session.feed().next(Some(&l.stop));
        let batch = match next {
            Ok(b) => b,
            Err(e) => {
                if !had_cursor || l.cursor_rescued.load(Ordering::SeqCst) || e.status != 400 {
                    return Err(e.into());
                }
                // 中继不认保存的游标（换过中继类型时会回 400）：清掉从头来一次，再失败才报错。
                l.cursor_rescued.store(true, Ordering::SeqCst);
                session.reset_feed()?;
                self.commit_current(l, |c| {
                    let mut next = c.clone();
                    next.cursor = None;
                    Some(next)
                })?;
                self.log
                    .warn("中继不认保存的变更游标，已清空并全量重同步", &Value::Null);
                return Ok(true);
            }
        };
        if l.stop.is_cancelled() {
            return Ok(false);
        }
        if !batch.reset {
            l.cursor_rescued.store(false, Ordering::SeqCst);
        }
        self.chain.run(|| -> Result<(), Failure> {
            if batch.reset {
                session.full_resync(had_cursor)?;
            }
            if !batch.changes.is_empty() {
                session.apply_changes(&batch.changes)
            } else if session.pending_count() > 0 {
                session.process_pending()
            } else {
                Ok(())
            }
        })?;
        self.mark_synced(l, &session)?;
        Ok(true)
    }

    fn commit_current(
        &self,
        l: &Loop,
        mutate: impl FnOnce(&SyncConfig) -> Option<SyncConfig>,
    ) -> Result<(), Failure> {
        let mut s = self.lock();
        if s.current.as_ref().map(|c| c.id) != Some(l.id) {
            return Ok(());
        }
        if let Some(next) = mutate(&s.config) {
            self.persist(&loop_principal(), &next)?;
            s.config = next;
        }
        Ok(())
    }

    /// 一轮成功：在线、清掉错误；游标变了才落库（顺带记下 lastSyncAt）。
    fn mark_synced(&self, l: &Loop, session: &Session) -> Result<(), Failure> {
        let cursor = session.cursor();
        let now = iso((self.now)());
        let mut s = self.lock();
        if s.current.as_ref().map(|c| c.id) != Some(l.id) {
            return Ok(());
        }
        s.phase = Phase::Online;
        s.last_error = None;
        let changed = cursor != s.config.cursor;
        let mut next = s.config.clone();
        next.cursor = cursor;
        next.last_sync_at = Some(now);
        if changed {
            self.persist(&loop_principal(), &next)?;
        }
        s.config = next;
        Ok(())
    }

    /// 中继拒绝 token：停下，等用户改 token（改完会重建连接）。
    fn reject(&self, l: &Loop) {
        self.stop_loop(l, Phase::Rejected, RELAY_REJECTED_MESSAGE.to_owned());
        self.log.warn("中继拒绝了 token，同步已停止", &Value::Null);
    }

    /// 重试也没用的错误（例如系统加密不可用、建不了配对空间）：停下并说明原因。
    fn fail(&self, l: &Loop, e: &Failure) {
        let message = self.describe(e);
        self.stop_loop(l, Phase::Failed, message.clone());
        self.log.error("同步已停止", &json!({ "error": message }));
    }

    fn stop_loop(&self, l: &Loop, phase: Phase, message: String) {
        let mut s = self.lock();
        if s.current.as_ref().map(|c| c.id) != Some(l.id) {
            return;
        }
        s.current = None;
        l.stop.cancel();
        l.retire();
        s.phase = phase;
        s.last_error = Some(message);
    }

    fn arm_presence(&self, l: &Loop) {
        let me = self.arc();
        let (stop, id) = (l.stop.clone(), l.id);
        let every = self.timings.presence;
        let _ = std::thread::Builder::new()
            .name("atm-sync-presence".into())
            .spawn(move || {
                while stop.sleep(every) {
                    let current = me.lock().current.clone();
                    let Some(l) = current.filter(|c| c.id == id) else {
                        return;
                    };
                    let Some(session) = l.session() else {
                        return;
                    };
                    if let Err(e) = me.chain.run(|| session.presence_tick()) {
                        if e.is_auth_failure() {
                            me.reject(&l);
                        } else {
                            let message = me.describe(&e);
                            me.lock().last_error = Some(message);
                        }
                    }
                }
            });
    }

    fn scheduler(&self) -> Option<Arc<Scheduler>> {
        self.scheduler
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 停下当前循环：中断长轮询与退避，等在途的中继写操作收尾，再写离线状态。整个过程共用一个预算：
    /// 宿主只给 core 有限的退出时间，到点还没收尾就掐断这个会话的全部中继请求、不再写离线状态。
    fn halt(&self, offline: bool) {
        let Some(l) = self.lock().current.take() else {
            return;
        };
        *self.halts.lock().unwrap_or_else(|e| e.into_inner()) += 1;
        self.halt_loop(&l, offline);
        let mut n = self.halts.lock().unwrap_or_else(|e| e.into_inner());
        *n -= 1;
        self.halts_changed.notify_all();
    }

    fn halt_loop(&self, l: &Arc<Loop>, offline: bool) {
        let deadline = Instant::now() + self.timings.stop_timeout;
        let remaining = || deadline.saturating_duration_since(Instant::now());
        l.stop.cancel();
        // 会话还没建起来（还在探测中继）：没有离线状态可写，直接掐断。
        if l.session().is_none() {
            l.relay.cancel();
        }
        let settled = l.wait_finished(remaining()) && self.chain.wait_idle(remaining());
        if !settled {
            self.log
                .warn("停止时中继迟迟没有响应，已中断在途请求", &Value::Null);
            l.retire();
            let _ = l.wait_finished(ABORT_SETTLE) && self.chain.wait_idle(ABORT_SETTLE);
            return;
        }
        if offline
            && l.ready.load(Ordering::SeqCst)
            && let Some(session) = l.session()
            && !remaining().is_zero()
        {
            let me = self.arc();
            let done = Arc::new((Mutex::new(None::<Result<(), Failure>>), Condvar::new()));
            let slot = done.clone();
            let _ = std::thread::Builder::new()
                .name("atm-sync-offline".into())
                .spawn(move || {
                    let r = me.chain.run(|| session.write_presence("offline"));
                    *slot.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(r);
                    slot.1.notify_all();
                });
            let mut r = done.0.lock().unwrap_or_else(|e| e.into_inner());
            while r.is_none() && !remaining().is_zero() {
                r = done
                    .1
                    .wait_timeout(r, remaining())
                    .unwrap_or_else(|e| e.into_inner())
                    .0;
            }
            if let Some(Err(e)) = r.take() {
                drop(r);
                let message = self.describe(&e);
                self.log
                    .warn("写离线状态失败", &json!({ "error": message }));
            }
        }
        l.retire();
    }

    fn wait_halts(&self) {
        let mut n = self.halts.lock().unwrap_or_else(|e| e.into_inner());
        while *n > 0 {
            n = self
                .halts_changed
                .wait(n)
                .unwrap_or_else(|e| e.into_inner());
        }
    }
}

impl<C: Cipher + Send + Sync + 'static> Connector<C> {
    /// 读配置（没有或不合格就用默认值）。不联网、不起线程；[`Connector::start`] 才开始。
    pub fn new(options: ConnectorOptions<C>) -> Result<Connector<C>, DomainError> {
        let log = options.log.unwrap_or_else(|| Arc::new(NoLog));
        let device_name =
            default_device_name(&options.device_name.clone().unwrap_or_else(hostname));
        let loaded = options.service.sync_ledger(&loop_principal())?;
        let config = match loaded {
            Some(c) if is_valid(&c) => c,
            Some(_) => {
                log.warn("同步配置不合法，已回退默认配置", &Value::Null);
                fresh(&device_name)?
            }
            None => fresh(&device_name)?,
        };
        let raw = log;
        let inner = Arc::new_cyclic(|me: &Weak<Inner<C>>| Inner {
            service: options.service,
            dispatch: options.dispatch,
            transport: options.transport,
            // 日志统一抹密钥：连接器自己的日志与会话的日志都走这一层。
            log: Arc::new(Redacting {
                inner: raw,
                owner: me.clone(),
            }),
            now: options.now.unwrap_or_else(|| Arc::new(now_ms)),
            sleep: options.sleep,
            app_version: options.app_version,
            timings: options.timings,
            state: Mutex::new(State {
                config,
                vault: SecretVault::new(options.secrets),
                phase: Phase::Disabled,
                last_error: None,
                long_poll: None,
                devices: Vec::new(),
                pending: 0,
                started: false,
                current: None,
                management: Cancel::new(),
            }),
            chain: Chain::default(),
            admin: Mutex::new(()),
            halts: Mutex::new(0),
            halts_changed: Condvar::new(),
            next_loop: AtomicU64::new(0),
            scheduler: Mutex::new(None),
            timer: Mutex::new(None),
            watcher: Mutex::new(None),
            me: me.clone(),
        });
        let weak = Arc::downgrade(&inner);
        let weak_ready = weak.clone();
        let weak_failed = weak.clone();
        let t = inner.timings;
        let scheduler = Scheduler::new(
            t.debounce,
            t.max_delay,
            t.retry_publish,
            SchedulerHooks {
                ready: Box::new(move || {
                    weak_ready
                        .upgrade()
                        .is_some_and(|i| i.ready_session().is_some())
                }),
                publish: Box::new(move |dirty| {
                    let Some(i) = weak.upgrade() else {
                        return Ok(());
                    };
                    match i.ready_session() {
                        Some(session) => i
                            .chain
                            .run(|| session.publish(&Dirty::Some(dirty), false).map(drop)),
                        None => Ok(()),
                    }
                }),
                failed: Box::new(move |e| {
                    let Some(i) = weak_failed.upgrade() else {
                        return false;
                    };
                    let Some(l) = i.lock().current.clone() else {
                        return false;
                    };
                    if e.is_auth_failure() {
                        i.reject(&l);
                        return false;
                    }
                    let message = i.describe(e);
                    i.lock().last_error = Some(message.clone());
                    i.log
                        .warn("发布快照失败，稍后重试", &json!({ "error": message }));
                    true
                }),
            },
        );
        *inner.scheduler.lock().unwrap_or_else(|e| e.into_inner()) = Some(scheduler);
        Ok(Connector { inner })
    }

    /// 读密钥、固定设备 ID、开始观察任务变化；已启用且配置齐全就开始同步。
    pub fn start(&self) -> Result<(), Failure> {
        let i = &self.inner;
        {
            let mut s = i.lock();
            if s.started {
                return Ok(());
            }
            s.started = true;
            if s.management.is_cancelled() {
                s.management = Cancel::new();
            }
            let space = s.config.space_id.clone();
            s.vault.load(space.as_deref());
            let config = s.config.clone();
            i.persist(&loop_principal(), &config)?;
        }
        if let Some(sched) = i.scheduler() {
            sched.activate();
            let mut timer = i.timer.lock().unwrap_or_else(|e| e.into_inner());
            if timer.is_none() {
                *timer = Some(sched.spawn_timer());
            }
            let mark_sched = sched.clone();
            let watcher = Watcher::spawn(
                i.service.clone(),
                Arc::new(move |project: Option<String>| mark_sched.mark_dirty(project.as_deref())),
            );
            *i.watcher.lock().unwrap_or_else(|e| e.into_inner()) = Some(watcher);
        }
        i.launch();
        Ok(())
    }

    /// 中断长轮询、写离线状态，然后停下。总耗时不超过 `stop_timeout`（再加掐断后的短暂收尾）。
    /// 返回后不会再有同步任务碰服务。
    pub fn stop(&self) {
        let i = &self.inner;
        {
            let mut s = i.lock();
            if !s.started {
                return;
            }
            s.started = false;
            s.management.cancel();
        }
        let watcher = i.watcher.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(w) = watcher {
            w.stop();
        }
        if let Some(sched) = i.scheduler() {
            sched.stop();
        }
        i.halt(true);
        // 改连接设置、重置配对可能已经在停旧会话：等它们作废完，停止才算数。
        i.wait_halts();
        let config = i.lock().config.clone();
        if let Err(e) = i.persist(&loop_principal(), &config) {
            let message = i.describe(&e);
            i.log.warn("保存同步配置失败", &json!({ "error": message }));
        }
        i.lock().phase = Phase::Stopped;
    }

    /// 有变化的项目（派单状态变化等）：去抖后发布。`None` 只影响项目列表或 head。
    pub fn mark_dirty(&self, project: Option<&str>) {
        if let Some(s) = self.inner.scheduler() {
            s.mark_dirty(project);
        }
    }

    /// 立刻发布积攒的变化、处理待办命令，并等它们做完（设置页「立即同步」与用例）。
    pub fn sync_now(&self) {
        let i = &self.inner;
        if let Some(s) = i.scheduler() {
            s.flush();
        }
        if let Some(session) = i.ready_session() {
            let _ = i.chain.run(|| session.process_pending());
        }
        i.chain.wait_idle(Duration::from_secs(3600));
    }

    /// `GET /api/v1/sync/status`。**不含任何密钥**：token、空间 secret、配对码都不在这里。
    pub fn status(&self, principal: &Principal) -> Result<Value, DomainError> {
        capability::require(principal, Capability::SyncStatus)?;
        Ok(self.status_value())
    }

    fn status_value(&self) -> Value {
        let i = &self.inner;
        let secrets = i.secret_values();
        let refs: Vec<&str> = secrets.iter().map(String::as_str).collect();
        let mut s = i.lock();
        let space = s.config.space_id.clone();
        s.vault.load(space.as_deref());
        let phase = if s.started {
            s.phase
        } else {
            Inner::idle_phase(&s)
        };
        let reason = s.vault.unavailable_reason().map(str::to_owned);
        let last_error =
            s.last_error.clone().or(reason).or_else(|| {
                (phase == Phase::Unconfigured).then(|| UNCONFIGURED_MESSAGE.to_owned())
            });
        json!({
            "enabled": s.config.enabled,
            "configured": Inner::configured(&s),
            "relayUrl": s.config.relay_url,
            "appId": s.config.app_id,
            "deviceName": s.config.device_name,
            "state": if s.started { phase.public() } else { "disabled" },
            "lastError": last_error.map(|e| redact(&e, &refs)),
            "lastSyncAt": s.config.last_sync_at,
            "longPoll": s.long_poll,
            "secretStore": s.vault.status_kind(),
            "paired": s.devices,
            "pendingCommands": s.pending,
        })
    }

    /// `{enabled?, relayUrl?, appId?, token?, deviceName?}`；token 只写不读，空串表示清除。
    pub fn update_config(
        &self,
        principal: &Principal,
        patch: &Value,
    ) -> Result<Value, DomainError> {
        capability::require(principal, Capability::SyncConfigure)?;
        let i = &self.inner;
        let _admin = i.admin.lock().unwrap_or_else(|e| e.into_inner());
        let change = {
            let mut s = i.lock();
            let space = s.config.space_id.clone();
            s.vault.load(space.as_deref());
            let change = plan_config_change(&s.config, s.vault.token(), patch)?;
            if let Some(token) = &change.token {
                s.vault
                    .set_token(token.as_deref())
                    .map_err(secret_failure)?;
            }
            i.persist(principal, &change.next).map_err(to_domain)?;
            s.config = change.next.clone();
            change
        };
        if change.reconnect {
            i.lock().last_error = None;
            i.halt(true);
            i.launch();
        } else if change.name_changed {
            self.mark_dirty(None);
            if let Some(session) = i.ready_session() {
                let me = i.arc();
                let _ = std::thread::Builder::new()
                    .name("atm-sync-rename".into())
                    .spawn(move || {
                        if let Err(e) = me.chain.run(|| session.write_presence("online")) {
                            let message = me.describe(&e);
                            me.lock().last_error = Some(message);
                        }
                    });
            }
        }
        Ok(self.status_value())
    }

    /// 用给定或已存的配置探测中继并计时。连不上不报错，结果里带中文原因。
    pub fn test_relay(
        &self,
        principal: &Principal,
        candidate: &Value,
    ) -> Result<Value, DomainError> {
        capability::require(principal, Capability::SyncTestRelay)?;
        let i = &self.inner;
        let Some(input) = parse_relay_candidate(candidate) else {
            return Ok(
                json!({ "ok": false, "latencyMs": 0, "longPoll": false, "error": "测试参数不合法" }),
            );
        };
        let (relay_url, app_id, token, management) = {
            let mut s = i.lock();
            let space = s.config.space_id.clone();
            s.vault.load(space.as_deref());
            (
                input.relay_url.clone().or(s.config.relay_url.clone()),
                input.app_id.clone().unwrap_or(s.config.app_id.clone()),
                input.token.clone().or(s.vault.token().map(str::to_owned)),
                s.management.clone(),
            )
        };
        let Some(relay_url) = relay_url else {
            return Ok(
                json!({ "ok": false, "latencyMs": 0, "longPoll": false, "error": "还没有填写中继地址" }),
            );
        };
        let Some(token) = token else {
            return Ok(
                json!({ "ok": false, "latencyMs": 0, "longPoll": false, "error": "还没有填写 token" }),
            );
        };
        let mut secrets = vec![token.clone()];
        secrets.extend(i.secret_values());
        let refs: Vec<&str> = secrets.iter().map(String::as_str).collect();
        let result = probe_result(|| i.client(&relay_url, &app_id, &token, management), &refs);
        let mut s = i.lock();
        if result["ok"] == true
            && Some(&relay_url) == s.config.relay_url.as_ref()
            && app_id == s.config.app_id
        {
            s.long_poll = result["longPoll"].as_bool();
        }
        Ok(result)
    }

    /// 配对码（含中继 token 与空间密钥，只给设置页显示）。没有空间先建一个，并发请求也只建一次；已有空间就
    /// 返回同一个配对码。
    pub fn create_pairing(&self, principal: &Principal) -> Result<Value, DomainError> {
        capability::require(principal, Capability::SyncPairingCreate)?;
        let i = &self.inner;
        let _admin = i.admin.lock().unwrap_or_else(|e| e.into_inner());
        let (relay_url, token) = {
            let mut s = i.lock();
            let space = s.config.space_id.clone();
            s.vault.load(space.as_deref());
            (
                s.config.relay_url.clone(),
                s.vault.token().map(str::to_owned),
            )
        };
        let (Some(relay_url), Some(token)) = (relay_url, token) else {
            return Err(DomainError::new(
                ErrorCode::VALIDATION_ERROR,
                "请先填写中继地址和 token 并保存，再生成配对码",
            ));
        };
        i.ensure_space(principal).map_err(to_domain)?;
        let s = i.lock();
        let (Some(space_id), Some(secret)) = (
            s.config.space_id.clone(),
            s.vault.secret().map(str::to_owned),
        ) else {
            return Err(DomainError::new(
                ErrorCode::INTERNAL_ERROR,
                "配对空间没有建好",
            ));
        };
        let code = encode_pairing_code(&PairingPayload {
            relay_url,
            app_id: s.config.app_id.clone(),
            relay_token: token,
            space_id: space_id.clone(),
            space_secret: secret,
            host_name: s.config.device_name.clone(),
        })
        .map_err(|e| DomainError::new(ErrorCode::VALIDATION_ERROR, e.message()))?;
        Ok(json!({ "pairingCode": code, "spaceId": space_id }))
    }

    /// 轮换空间：删掉旧空间里的文档（尽力而为），再留一条用旧密钥加密的撤销标记，然后换新空间与密钥。
    /// 旧手机读到撤销标记就提示重新扫码。
    pub fn reset_space(&self, principal: &Principal) -> Result<Value, DomainError> {
        capability::require(principal, Capability::SyncReset)?;
        let i = &self.inner;
        let _admin = i.admin.lock().unwrap_or_else(|e| e.into_inner());
        {
            let mut s = i.lock();
            let space = s.config.space_id.clone();
            s.vault.load(space.as_deref());
            s.vault.assert_writable().map_err(secret_failure)?;
        }
        // 先停循环再认旧空间：循环停下之后不会再建空间，正在建的也已在状态锁里建完，
        // 不会有刚建出来、既没清理也没撤销标记的空间。
        i.halt(false);
        let (previous, relay_url, app_id, device, token, previous_secret, management) = {
            let mut s = i.lock();
            let space = s.config.space_id.clone();
            s.vault.load(space.as_deref());
            (
                s.config.space_id.clone(),
                s.config.relay_url.clone(),
                s.config.app_id.clone(),
                (s.config.device_id.clone(), s.config.device_name.clone()),
                s.vault.token().map(str::to_owned),
                s.vault.secret().map(str::to_owned),
                s.management.clone(),
            )
        };
        let mut removed = 0;
        let mut errors: Vec<String> = Vec::new();
        if let (Some(previous), Some(relay_url), Some(token)) = (&previous, &relay_url, &token) {
            match i.client(relay_url, &app_id, token, management) {
                Ok(client) => {
                    match purge_space(&client, previous) {
                        Ok(n) => removed = n,
                        Err(e) => {
                            let m = i.describe(&e);
                            i.log.warn("清理旧配对空间失败", &json!({ "error": m }));
                            errors.push(m);
                        }
                    }
                    // 撤销标记必须在清空之后写（先写会被一起删掉）；清理失败也照写，旧手机只认它。
                    if let Some(secret) = &previous_secret
                        && let Err(e) = revoke_space(
                            &client,
                            previous,
                            secret,
                            (&device.0, &device.1),
                            &iso((i.now)()),
                        )
                    {
                        let m = i.describe(&e);
                        i.log.warn("写撤销标记失败", &json!({ "error": m }));
                        errors.push(m);
                    }
                }
                Err(e) => errors.push(i.describe(&e)),
            }
        }
        i.create_space(principal).map_err(to_domain)?;
        i.launch();
        let space_id = i.lock().config.space_id.clone();
        let mut out = json!({ "spaceId": space_id, "removed": removed });
        if !errors.is_empty() {
            out["cleanupError"] = json!(errors.join("；"));
        }
        Ok(out)
    }
}

impl<C: Cipher + Send + Sync + 'static> Drop for Connector<C> {
    fn drop(&mut self) {
        self.stop();
        if let Some(s) = self.inner.scheduler() {
            s.close();
        }
        let timer = self
            .inner
            .timer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(t) = timer {
            let _ = t.join();
        }
        *self
            .inner
            .scheduler
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
    }
}

fn to_domain(e: Failure) -> DomainError {
    match e {
        Failure::Domain(d) => d,
        other => DomainError::new(ErrorCode::INTERNAL_ERROR, describe(&other)),
    }
}

fn fresh(device_name: &str) -> Result<SyncConfig, DomainError> {
    default_config(device_name)
        .ok_or_else(|| DomainError::new(ErrorCode::INTERNAL_ERROR, "系统随机数不可用"))
}

/// 默认的密钥存储：`<数据目录>/sync/secrets.dpapi.json`，进程内 DPAPI。
pub fn default_secrets(data_dir: &Path) -> DpapiSecretStore<Dpapi> {
    DpapiSecretStore::open(&data_dir.join("sync"), Some(Dpapi))
}

/// 用例与诊断：当前阶段。
impl<C: Cipher + Send + Sync + 'static> Connector<C> {
    pub fn phase(&self) -> Phase {
        self.inner.lock().phase
    }

    pub fn config(&self) -> SyncConfig {
        self.inner.lock().config.clone()
    }

    pub fn scheduler_dirty(&self) -> BTreeSet<String> {
        self.inner
            .scheduler()
            .map(|s| s.dirty())
            .unwrap_or_default()
    }
}
