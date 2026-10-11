//! Claude Code 无头派单（2.x `dispatcher.ts`）：只处理用户点名的任务，排队、限并发、起进程、落日志、记历史。
//!
//! 会话进程 detached，stdout / stderr 直接写日志文件，宿主退出后会话照常跑完；宿主重启时 [`Dispatcher::start`]
//! 只接管身份（PID + 出生标识，精确相等）确认无误的残留进程。带 requestId 的请求（手机命令）经 [`Ledger`] 持久幂等：
//! 同一个 ID 绝不起第二次会话。
//!
//! **谁能起会话**（03 §2.4、P-017）：只有 User 与 Phone 有 `dispatch.launch`。入队时判权，通过后这个主体就是这次派单
//! 的启动授权，只存在内存里；排队中的派单只有带着授权才会被泵起来。跟踪作业（System `dispatch.track`）核对进程、
//! 定结局、写历史，进程结束后可以泵队列，但只会启动已经带授权的派单，自己从不产生授权。上次进程留下（或转换来）
//! 的排队派单没有授权，启动时记为取消并说明，请用户重新交给 Claude（2.x 会直接把它们拉起来）。

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::time::Duration;

use atm_domain::capability::{self, Capability};
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::principal::{JobId, Principal};
use atm_domain::time::Timestamp;
use atm_service::dispatch_state::{ConfigRow, DispatchWrite, Target, TargetTask};
use atm_service::write::Service;
use atm_sync::host::Log;
use serde_json::{Map, Value, json};

use crate::config::DispatchConfig;
use crate::errors::{
    CLAUDE_LOGIN_REQUIRED_MESSAGE, Code, DispatchError, Error, closed, disabled, invalid,
};
use crate::launch::{
    child_env, claude_arguments, launch_command, new_run_id, new_session_id, task_key_ok,
};
use crate::ledger::{Gate, Ledger, LedgerLog, Loaded, Reservation, request_id_ok};
use crate::outcome::{self, Outcome, identity_lost_message, log_has_result};
use crate::probe::{ClaudeProbe, Runner};
use crate::process::{self, Child, KillResult, Probe, SpawnRequest, Spawner, Verdict};
use crate::prompt::{self, PromptInput};
use crate::record::{self, ExitCode, Record, State};

/// 接管的进程连续这么多次查不到出生标识（身份核验不了）就停止跟踪；进程本身不动。
pub const IDENTITY_MISS_LIMIT: u32 = 3;
/// 接管的会话多久重核一次 PID + 出生标识（2.x `TRACK_INTERVAL_MS = 5000`）。宿主把它作为 [`Options::poll`] 传入，
/// 用例传更短的间隔。
pub const TRACK_INTERVAL: Duration = Duration::from_secs(5);
/// 可以派单的任务状态：还没人开工的。
const DISPATCHABLE: &[&str] = &["READY", "BACKLOG"];
/// 关闭时等在途步骤的间隔。
const LIFETIME_TICK: Duration = Duration::from_millis(25);

pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

pub struct Options {
    pub service: Arc<Service>,
    /// 本数据根下的 `dispatch\logs`。
    pub logs: PathBuf,
    /// 2.x 数据根下的 `dispatch\logs`：转换时还在跑的会话（`log_root='LEGACY'`）仍往那里写。只读。
    pub legacy_logs: Option<PathBuf>,
    pub resolve_claude: Arc<dyn Fn() -> Option<PathBuf> + Send + Sync>,
    pub spawner: Arc<dyn Spawner>,
    pub probe: Arc<dyn Probe>,
    pub runner: Arc<dyn Runner>,
    /// 子进程环境的来源（宿主进程的环境）。
    pub base_env: Vec<(OsString, OsString)>,
    pub comspec: Option<PathBuf>,
    pub now: Clock,
    pub log: Arc<dyn Log>,
    /// 接管的会话（不是本进程的子进程）多久查一次，默认 5 秒。
    pub poll: Duration,
    pub auth_timeout: Duration,
}

/// 派单状态或配置变化：`Some(project)` 是某次派单，`None` 是配置（影响全局）。
pub type Listener = Arc<dyn Fn(Option<&str>) + Send + Sync>;

struct CancelSlot {
    result: Mutex<Option<Result<Map<String, Value>, Error>>>,
    done: Condvar,
}

struct Watch {
    pid: u32,
    identity: String,
    misses: u32,
}

struct State_ {
    config: DispatchConfig,
    /// 按创建时间升序。
    runs: Vec<Record>,
    ledger: Ledger,
    /// 上次落盘的样子：落盘只写变了的行。
    saved: HashMap<String, record::RawRun>,
    launching: HashSet<String>,
    cancelling: HashMap<String, Arc<CancelSlot>>,
    /// 启动授权：入队时判过 `dispatch.launch` 的主体。
    grants: HashMap<String, Principal>,
    /// 项目名只在排队到启动之间用来渲染提示词，不进历史。
    prompt_context: HashMap<String, String>,
    children: HashMap<String, Arc<dyn Child>>,
    watchers: HashMap<String, Watch>,
    /// 解锁后再通知的变化。
    events: Vec<Option<String>>,
}

struct Inner {
    service: Arc<Service>,
    logs: PathBuf,
    legacy_logs: Option<PathBuf>,
    resolve_claude: Arc<dyn Fn() -> Option<PathBuf> + Send + Sync>,
    spawner: Arc<dyn Spawner>,
    probe: Arc<dyn Probe>,
    claude: Arc<ClaudeProbe>,
    base_env: Vec<(OsString, OsString)>,
    comspec: Option<PathBuf>,
    now: Clock,
    log: Arc<dyn Log>,
    poll: Duration,
    tracker: Principal,
    state: Mutex<State_>,
    closed: AtomicBool,
    /// 关闭、在途步骤落定都在这里通知。
    lifetime: (Mutex<()>, Condvar),
    listeners: Mutex<Vec<Listener>>,
    track_thread: Mutex<Option<std::thread::JoinHandle<()>>>,
    me: Weak<Inner>,
}

#[derive(Clone)]
pub struct Dispatcher {
    inner: Arc<Inner>,
}

/// 入队的参数（2.x `EnqueueInput`）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Enqueue {
    pub project: String,
    pub key: String,
    pub mobile: bool,
    /// 谁发起的（例如手机设备名），只进历史与提示词的「来源」一行。
    pub requested_by: Option<String>,
    /// 幂等键：手机命令传命令 ID，桌面点按不传。
    pub request_id: Option<String>,
}

struct LogAdapter<'a>(&'a dyn Log);
impl LedgerLog for LogAdapter<'_> {
    fn warn(&self, message: &str, meta: &Value) {
        self.0.warn(message, meta);
    }
}

fn iso(ms: i64) -> String {
    Timestamp::from_millis(ms).to_string()
}

/// 任务现在不能派单的原因；可以派单是 `None`（2.x `taskBlocker`）。
pub fn task_blocker(task: &TargetTask, now: i64) -> Option<String> {
    if !DISPATCHABLE.contains(&task.status.as_str()) {
        return Some(format!(
            "任务状态是 {}，只有 READY 或 BACKLOG 的任务可以交给 Claude",
            task.status
        ));
    }
    if let Some(session) = task
        .claimed_by_session_id
        .as_deref()
        .filter(|s| !s.is_empty())
    {
        let lease = task
            .claim_lease_until
            .as_deref()
            .and_then(Timestamp::parse)
            .map(Timestamp::millis);
        if lease.is_none_or(|l| l > now) {
            return Some(format!("任务已被会话 {session} 领取"));
        }
    }
    None
}

/// 来源一行（例如手机设备名）：去掉控制字符，截到 60 个字。
fn clean_requester(value: Option<&str>) -> Option<String> {
    let flat = prompt::flatten_controls(value?);
    let flat = prompt::js_trim(&flat);
    (!flat.is_empty()).then(|| flat.chars().take(60).collect())
}

fn domain(e: DomainError) -> Error {
    Error::Domain(e)
}

fn not_active(run: &str, state: State) -> DispatchError {
    DispatchError::new(
        Code::DISPATCH_RUN_NOT_ACTIVE,
        format!("派单已结束（{}）", state.as_str()),
    )
    .detail("run", run)
    .detail("state", state.as_str())
}

impl Dispatcher {
    /// 读配置与历史、账本。历史读不出来就起不来（宿主把派单记为不可用）；账本读不出来只让手机派单暂停。
    pub fn new(o: Options) -> Result<Dispatcher, DomainError> {
        let tracker = Principal::system_job(JobId::DispatchTrack);
        let (config, raw_runs) = o.service.dispatch_runs(&tracker)?;
        let mut runs = Vec::new();
        let mut saved = HashMap::new();
        for raw in raw_runs {
            match Record::from_raw(&raw) {
                Some(r) => {
                    saved.insert(r.run.clone(), raw);
                    runs.push(r);
                }
                None => {
                    o.log.warn(
                        "派单历史里有一条记录不合法，已丢弃",
                        &json!({ "run": raw.run }),
                    );
                    // 不在 saved 里：下次落盘时按「已删」处理。
                    saved.insert(raw.run.clone(), raw);
                }
            }
        }
        runs.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        let config = config
            .map(|c| DispatchConfig {
                enabled: c.enabled,
                permission_mode: c.permission_mode,
                max_concurrent: u32::try_from(c.max_concurrent).unwrap_or(0),
                model: c.model,
                effort: c.effort,
            })
            .unwrap_or_default();
        let config = if config.is_valid() {
            config
        } else {
            o.log.warn("派单配置不合法，已回退默认配置", &Value::Null);
            DispatchConfig::default()
        };
        let claude = Arc::new(ClaudeProbe::new(
            o.runner.clone(),
            o.base_env.clone(),
            o.comspec.clone(),
            o.now.clone(),
            o.auth_timeout,
        ));
        let inner = Arc::new_cyclic(|me| Inner {
            service: o.service,
            logs: o.logs,
            legacy_logs: o.legacy_logs,
            resolve_claude: o.resolve_claude,
            spawner: o.spawner,
            probe: o.probe,
            claude,
            base_env: o.base_env,
            comspec: o.comspec,
            now: o.now,
            log: o.log,
            poll: o.poll,
            tracker,
            state: Mutex::new(State_ {
                config,
                runs,
                ledger: Ledger::unavailable(),
                saved,
                launching: HashSet::new(),
                cancelling: HashMap::new(),
                grants: HashMap::new(),
                prompt_context: HashMap::new(),
                children: HashMap::new(),
                watchers: HashMap::new(),
                events: Vec::new(),
            }),
            closed: AtomicBool::new(false),
            lifetime: (Mutex::new(()), Condvar::new()),
            listeners: Mutex::new(Vec::new()),
            track_thread: Mutex::new(None),
            me: me.clone(),
        });
        {
            let mut s = inner.lock();
            inner.reload_ledger(&mut s);
        }
        Ok(Dispatcher { inner })
    }

    /// 修正上次留下的 running 记录、取消没有授权的排队记录、清理旧日志，然后开始跟踪。
    /// 期间 [`Dispatcher::close`]（宿主收尾）：剩下的残留留给下次启动。
    pub fn start(&self) {
        let i = &self.inner;
        let residual: Vec<(String, Option<u32>, Option<String>)> = {
            let s = i.lock();
            s.runs
                .iter()
                .filter(|r| r.state == State::Running)
                .map(|r| (r.run.clone(), r.pid, r.process_identity.clone()))
                .collect()
        };
        for (run, pid, identity) in residual {
            if i.is_closed() {
                return;
            }
            let verdict = match pid {
                None => Verdict::Gone,
                Some(pid) => process::check(i.probe.as_ref(), pid, identity.as_deref()),
            };
            i.with_state(|s| i.reconcile(s, &run, verdict));
        }
        if i.is_closed() {
            return;
        }
        i.with_state(|s| {
            let reason = if s.config.enabled {
                "ATM 重启前这次派单还在排队，没有启动：需要的话请重新交给 Claude"
            } else {
                "派单已关闭"
            };
            i.cancel_queued(s, reason);
            let p = i.tracker.clone();
            i.persist(s, &p);
        });
        let me = i.clone();
        let handle = std::thread::Builder::new()
            .name("atm-dispatch-track".into())
            .spawn(move || me.track_loop())
            .ok();
        *i.track_thread.lock().unwrap_or_else(|e| e.into_inner()) = handle;
    }

    /// 停下跟踪与等待；不结束任何会话（它们本来就与宿主解耦）。在途的入队以 DISPATCH_CLOSED 结束。
    pub fn close(&self) {
        let i = &self.inner;
        if i.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        {
            let _g = i.lifetime.0.lock().unwrap_or_else(|e| e.into_inner());
            i.lifetime.1.notify_all();
        }
        let children: Vec<Arc<dyn Child>> = i.lock().children.values().cloned().collect();
        for c in children {
            c.abandon();
        }
        i.listeners
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        let handle = i
            .track_thread
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(h) = handle {
            let _ = h.join();
        }
    }

    pub fn on_change(&self, listener: Listener) {
        if self.inner.is_closed() {
            return;
        }
        self.inner
            .listeners
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(listener);
    }

    pub fn config(&self) -> DispatchConfig {
        self.inner.lock().config.clone()
    }

    /// 运行中的派单数（手机 head 里的摘要）。
    pub fn running(&self) -> usize {
        self.inner
            .lock()
            .runs
            .iter()
            .filter(|r| r.state == State::Running)
            .count()
    }

    /// 最近的在前（对外视图）。
    pub fn list_runs(&self) -> Vec<Map<String, Value>> {
        self.inner
            .lock()
            .runs
            .iter()
            .rev()
            .map(Record::view)
            .collect()
    }

    /// 该任务最近一次派单（进行中的优先）；从没派过是 `None`。
    pub fn run_for_task(&self, project: &str, key: &str) -> Option<Record> {
        let s = self.inner.lock();
        let mine: Vec<&Record> = s
            .runs
            .iter()
            .filter(|r| r.project == project && r.key == key)
            .collect();
        mine.iter()
            .rev()
            .find(|r| r.state.active())
            .or(mine.last())
            .map(|r| (*r).clone())
    }

    /// 设置页的派单状态（2.x `status()`）：配置、claude 路径 / 版本 / 登录、历史、账本健康状况。
    /// 历史里每条带上 `targetUndone`（R5）：记下的任务实体已不在（被按范围恢复撤销）时为 true。
    pub fn status(&self, principal: &Principal) -> Result<Value, Error> {
        capability::require(principal, Capability::DispatchStatus).map_err(domain)?;
        let i = &self.inner;
        let path = (i.resolve_claude)();
        let (version, auth) = match &path {
            Some(p) => (i.claude.version(p), Some(i.claude.auth(p, false).0)),
            None => (None, None),
        };
        let (config, runs, ledger) = {
            let mut s = i.lock();
            if !s.ledger.is_available() {
                i.reload_ledger(&mut s);
            }
            let now = (i.now)();
            let (lost, until, unavailable) = s.ledger.status(now);
            let runs: Vec<Record> = s.runs.iter().rev().cloned().collect();
            (s.config.clone(), runs, (lost, until, unavailable))
        };
        let refs: Vec<(String, String)> = runs
            .iter()
            .filter_map(|r| r.task_id.clone().map(|id| (r.project.clone(), id)))
            .collect();
        let alive = i
            .service
            .dispatch_live_tasks(principal, &refs)
            .map_err(domain)?;
        let mut alive = alive.into_iter();
        let views: Vec<Value> = runs
            .iter()
            .map(|r| {
                let mut v = r.view();
                if r.task_id.is_some() {
                    v.insert("targetUndone".into(), json!(!alive.next().unwrap_or(true)));
                }
                Value::Object(v)
            })
            .collect();
        let mut claude =
            json!({ "found": path.is_some(), "path": path.as_ref().map(|p| p.to_string_lossy()) });
        if let Some(v) = version {
            claude["version"] = json!(v);
        }
        claude["loggedIn"] = json!(auth.as_ref().and_then(|a| a.logged_in));
        if let Some(m) = auth.and_then(|a| a.auth_method) {
            claude["authMethod"] = json!(m);
        }
        let mut out = config.to_json();
        out["claude"] = claude;
        out["runs"] = Value::Array(views);
        out["requestLedger"] = json!({
            "lostBefore": ledger.0,
            "lostUntil": ledger.1,
            "unavailable": ledger.2,
        });
        Ok(out)
    }

    /// 改配置（只给用户）。关掉派单会取消排队中的，运行中的照常跑完。
    pub fn update_config(&self, principal: &Principal, patch: &Value) -> Result<Value, Error> {
        capability::require(principal, Capability::DispatchConfigure).map_err(domain)?;
        let i = &self.inner;
        i.with_state(|s| {
            let next = s.config.merge(patch)?;
            i.service
                .dispatch_save(
                    principal,
                    &DispatchWrite {
                        config: Some(ConfigRow {
                            enabled: next.enabled,
                            permission_mode: next.permission_mode.clone(),
                            max_concurrent: i64::from(next.max_concurrent),
                            model: next.model.clone(),
                            effort: next.effort.clone(),
                            source_state: "OK".into(),
                        }),
                        ..DispatchWrite::default()
                    },
                )
                .map_err(domain)?;
            s.config = next.clone();
            if !next.enabled {
                i.cancel_queued(s, "派单已关闭");
            }
            i.persist(s, principal);
            s.events.push(None);
            i.pump(s);
            Ok(next.to_json())
        })
    }

    /// 排队一次派单（2.x `enqueue`）。带 `request_id` 时先过请求账本：记过的直接回放那次的结局（派单的当前视图，
    /// 或当初的拒绝），绝不再起会话；其余预留名额后照常校验，建出派单或业务拒绝都记进账本。
    /// 关闭后（宿主收尾）是 DISPATCH_CLOSED，不记账本。
    pub fn enqueue(
        &self,
        principal: &Principal,
        input: &Enqueue,
    ) -> Result<Map<String, Value>, Error> {
        capability::require(principal, Capability::DispatchLaunch).map_err(domain)?;
        let i = &self.inner;
        if i.is_closed() {
            return Err(closed().into());
        }
        if !task_key_ok(&input.key) {
            return Err(invalid(format!("任务键格式不合法：{}", input.key)).into());
        }
        let Some(request_id) = input.request_id.as_deref() else {
            return i.enqueue_new(principal, input, None);
        };
        if !request_id_ok(request_id) {
            return Err(invalid("requestId 格式不合法").into());
        }
        let gate = i.with_state(|s| {
            if !s.ledger.is_available() {
                i.reload_ledger(s);
            }
            let now = (i.now)();
            let gate = s.ledger.admit(request_id, now);
            if gate.is_ok() {
                // 回补、裁剪的改动随手落盘。
                let p = principal.clone();
                i.persist(s, &p);
            }
            gate
        })?;
        let reservation = match gate {
            Gate::Replay(entry) => return i.replay(&entry),
            Gate::New(r) => r,
        };
        let result = i.enqueue_new(principal, input, Some(&reservation));
        i.with_state(|s| {
            // 业务上的拒绝也记下来：同一条命令以后再来照样拒绝，不会因为期间开了派单、任务变回 READY 就补起
            // 一次会话。临时故障与可重试的拒绝（例如宿主正在退出）不记：那不是对这条命令的判断。
            if let Err(Error::Dispatch(e)) = &result
                && !e.retryable()
            {
                let now = (i.now)();
                s.ledger.record_rejection(&reservation, e, now);
                i.persist(s, principal);
            }
            s.ledger.release(&reservation);
        });
        result
    }

    /// 取消（只给用户）。排队中的直接取消；运行中的先核验进程身份再结束整棵进程树，确认结束后才记为取消并释放
    /// 名额。结束失败（或身份核验不了）时派单保持运行中、名额不释放，回 DISPATCH_CANCEL_FAILED，可以重试。
    pub fn cancel(&self, principal: &Principal, run: &str) -> Result<Map<String, Value>, Error> {
        capability::require(principal, Capability::DispatchCancel).map_err(domain)?;
        let i = &self.inner;
        enum Next {
            Done(Map<String, Value>),
            Wait(Arc<CancelSlot>),
            Kill(Arc<CancelSlot>, Option<u32>, Option<String>),
        }
        let next = i.with_state(|s| -> Result<Next, Error> {
            if let Some(slot) = s.cancelling.get(run) {
                return Ok(Next::Wait(slot.clone()));
            }
            let Some(at) = s.runs.iter().position(|r| r.run == run) else {
                return Err(DispatchError::new(
                    Code::DISPATCH_RUN_NOT_FOUND,
                    format!("派单不存在：{run}"),
                )
                .detail("run", run)
                .into());
            };
            let r = &s.runs[at];
            match r.state {
                State::Queued => {
                    i.finish(
                        s,
                        at,
                        principal,
                        State::Cancelled,
                        None,
                        Some("用户取消".into()),
                        None,
                    );
                    Ok(Next::Done(
                        s.runs
                            .iter()
                            .find(|r| r.run == run)
                            .map(Record::view)
                            .unwrap_or_default(),
                    ))
                }
                State::Running => {
                    let slot = Arc::new(CancelSlot {
                        result: Mutex::new(None),
                        done: Condvar::new(),
                    });
                    s.cancelling.insert(run.to_owned(), slot.clone());
                    Ok(Next::Kill(slot, r.pid, r.process_identity.clone()))
                }
                state => Err(not_active(run, state).into()),
            }
        })?;
        match next {
            Next::Done(view) => Ok(view),
            Next::Wait(slot) => {
                let mut r = slot.result.lock().unwrap_or_else(|e| e.into_inner());
                while r.is_none() {
                    r = slot.done.wait(r).unwrap_or_else(|e| e.into_inner());
                }
                r.clone().unwrap_or_else(|| Err(closed().into()))
            }
            Next::Kill(slot, pid, identity) => {
                let outcome = i.terminate(run, pid, identity.as_deref());
                let result = i.with_state(|s| {
                    s.cancelling.remove(run);
                    let at = s.runs.iter().position(|r| r.run == run);
                    match outcome {
                        Ok(exited) => {
                            if let Some(at) = at
                                && s.runs[at].state == State::Running
                            {
                                if exited {
                                    // 核验发现原进程早已退出（PID 不在或已换人），没动任何进程，按日志定结局。
                                    let o = i.judge(&s.runs[at], None);
                                    i.finish_outcome(s, at, principal, o, None);
                                } else {
                                    i.finish(
                                        s,
                                        at,
                                        principal,
                                        State::Cancelled,
                                        None,
                                        Some("用户取消".into()),
                                        None,
                                    );
                                }
                            }
                            Ok(at.map(|at| s.runs[at].view()).unwrap_or_default())
                        }
                        Err(e) => Err(Error::Dispatch(e)),
                    }
                });
                *slot.result.lock().unwrap_or_else(|e| e.into_inner()) = Some(result.clone());
                slot.done.notify_all();
                result
            }
        }
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State_> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn arc(&self) -> Arc<Inner> {
        self.me
            .upgrade()
            .expect("dispatcher is alive while it runs")
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// 拿锁做一件事，解锁后再通知变化（监听器可能回调派单器）。
    fn with_state<R>(&self, f: impl FnOnce(&mut State_) -> R) -> R {
        let (r, events) = {
            let mut s = self.lock();
            let r = f(&mut s);
            (r, std::mem::take(&mut s.events))
        };
        if !events.is_empty() && !self.is_closed() {
            let listeners: Vec<Listener> = self
                .listeners
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            for e in &events {
                for l in &listeners {
                    l(e.as_deref());
                }
            }
        }
        r
    }

    fn reload_ledger(&self, s: &mut State_) {
        let loaded = match self.service.dispatch_requests(&self.tracker) {
            Ok((rows, lost)) => Loaded::Ok(rows, lost),
            Err(e) => Loaded::Unavailable(e.message),
        };
        let history: Vec<(String, String, Map<String, Value>)> = s
            .runs
            .iter()
            .filter_map(|r| {
                r.request_id
                    .clone()
                    .map(|id| (id, r.created_at.clone(), r.snapshot()))
            })
            .collect();
        let now = (self.now)();
        s.ledger
            .reload(loaded, &history, now, &LogAdapter(self.log.as_ref()));
    }

    /// 落盘（2.x `#persist`）：先用完整历史刷新账本快照，再裁剪历史，最后只写变了的行，并删掉不属于保留历史的日志。
    /// 写失败只记日志：内存里的状态照旧，下次状态变化时再写。
    fn persist(&self, s: &mut State_, principal: &Principal) {
        if let Err(e) = self.try_persist(s, principal) {
            self.log
                .error("写派单历史失败", &json!({ "error": e.message }));
        }
    }

    fn try_persist(&self, s: &mut State_, principal: &Principal) -> Result<(), DomainError> {
        let snapshots: HashMap<String, Map<String, Value>> = s
            .runs
            .iter()
            .map(|r| (r.run.clone(), r.snapshot()))
            .collect();
        s.ledger.sync(&snapshots);
        record::trim(&mut s.runs);
        let mut write = DispatchWrite::default();
        let live: HashSet<&str> = s.runs.iter().map(|r| r.run.as_str()).collect();
        for r in &s.runs {
            let raw = r.to_raw();
            if s.saved.get(&r.run) != Some(&raw) {
                write.upsert_runs.push(raw);
            }
        }
        for run in s.saved.keys() {
            if !live.contains(run.as_str()) {
                write.delete_runs.push(run.clone());
            }
        }
        let changes = s.ledger.take_changes();
        for id in &changes.delete {
            write.delete_requests.push(id.clone());
        }
        for id in &changes.upsert {
            if let Some(e) = s.ledger.entry(id) {
                write.upsert_requests.push(e.to_raw());
            }
        }
        if changes.watermark {
            write.lost_before = Some(s.ledger.lost_before().map(iso));
        }
        if !write.is_empty() {
            if let Err(e) = self.service.dispatch_save(principal, &write) {
                s.ledger.restore_changes(changes);
                return Err(e);
            }
            for raw in write.upsert_runs {
                s.saved.insert(raw.run.clone(), raw);
            }
            for run in write.delete_runs {
                s.saved.remove(&run);
            }
        }
        let keep: HashSet<String> = s
            .runs
            .iter()
            .filter(|r| !r.legacy_logs)
            .map(|r| r.run.clone())
            .collect();
        for (file, error) in record::prune_logs(&self.logs, &keep) {
            self.log.warn(
                "清理旧的派单日志失败，下次再试",
                &json!({ "file": file, "error": error }),
            );
        }
        Ok(())
    }

    fn logs_of(&self, r: &Record) -> (PathBuf, PathBuf) {
        let dir = if r.legacy_logs {
            self.legacy_logs.as_deref().unwrap_or(&self.logs)
        } else {
            &self.logs
        };
        (
            record::stdout_log(dir, &r.run),
            record::stderr_log(dir, &r.run),
        )
    }

    /// 按日志判定结局；鉴权失败时让登录状态缓存失效，状态页与下次派单都会重新探。
    fn judge(&self, r: &Record, exit: Option<i64>) -> Outcome {
        let (out, err) = self.logs_of(r);
        let o = outcome::judge(&out, &err, exit);
        if o.auth_failure {
            self.claude.invalidate_auth();
        }
        o
    }

    #[allow(clippy::too_many_arguments)]
    fn finish(
        &self,
        s: &mut State_,
        at: usize,
        principal: &Principal,
        state: State,
        summary: Option<outcome::Summary>,
        error: Option<String>,
        exit: Option<ExitCode>,
    ) {
        let now = (self.now)();
        let r = &mut s.runs[at];
        r.state = state;
        r.ended_at = Some(iso(now));
        if summary.is_some() {
            r.summary = summary;
        }
        if error.is_some() {
            r.error = error;
        }
        if let Some(e) = exit {
            r.exit_code = e;
        }
        let (run, project) = (r.run.clone(), r.project.clone());
        s.prompt_context.remove(&run);
        s.grants.remove(&run);
        s.events.push(Some(project));
        self.persist(s, principal);
        self.pump(s);
    }

    fn finish_outcome(
        &self,
        s: &mut State_,
        at: usize,
        principal: &Principal,
        o: Outcome,
        exit: Option<ExitCode>,
    ) {
        let state = if o.succeeded {
            State::Succeeded
        } else {
            State::Failed
        };
        self.finish(s, at, principal, state, o.summary, o.error, exit);
    }

    fn cancel_queued(&self, s: &mut State_, reason: &str) {
        let now = iso((self.now)());
        let mut changed = Vec::new();
        for r in s.runs.iter_mut().filter(|r| r.state == State::Queued) {
            r.state = State::Cancelled;
            r.ended_at = Some(now.clone());
            r.error = Some(reason.to_owned());
            changed.push((r.run.clone(), r.project.clone()));
        }
        for (run, project) in changed {
            s.prompt_context.remove(&run);
            s.grants.remove(&run);
            s.events.push(Some(project));
        }
    }

    /// 上次宿主退出时仍在跑的记录（2.x `#reconcileResidual`）。只有「记录里的出生标识已知 + 现查的已知 + 两者逐字
    /// 相同」才接着跟踪；PID 不在或已换人（原进程肯定已退出）按日志定结局；身份核验不了时绝不接管、绝不结束：
    /// 日志里已有 result 行（会话已结束）按日志定结局，否则记为失败并说明（进程可能还在，由用户处理）。
    fn reconcile(&self, s: &mut State_, run: &str, verdict: Verdict) {
        let Some(at) = s
            .runs
            .iter()
            .position(|r| r.run == run && r.state == State::Running)
        else {
            return;
        };
        let r = &s.runs[at];
        if verdict == Verdict::Same
            && let (Some(pid), Some(identity)) = (r.pid, r.process_identity.clone())
        {
            s.watchers.insert(
                run.to_owned(),
                Watch {
                    pid,
                    identity,
                    misses: 0,
                },
            );
            return;
        }
        let (out, _) = self.logs_of(r);
        let now = iso((self.now)());
        if verdict == Verdict::Unknown && !log_has_result(&out) {
            let message = identity_lost_message(r.pid, "宿主重启后");
            let r = &mut s.runs[at];
            r.state = State::Failed;
            r.error = Some(message);
            r.ended_at = Some(now);
        } else {
            let o = self.judge(r, None);
            let r = &mut s.runs[at];
            r.state = if o.succeeded {
                State::Succeeded
            } else {
                State::Failed
            };
            if o.summary.is_some() {
                r.summary = o.summary;
            }
            if let Some(e) = o.error {
                r.error = Some(format!("宿主重启时会话已结束；{e}"));
            }
            r.ended_at = Some(now);
        }
        s.events.push(Some(s.runs[at].project.clone()));
    }

    fn assert_not_active(s: &State_, project: &str, key: &str) -> Result<(), DispatchError> {
        match s
            .runs
            .iter()
            .find(|r| r.project == project && r.key == key && r.state.active())
        {
            Some(r) => Err(DispatchError::new(
                Code::DISPATCH_ALREADY_ACTIVE,
                format!("{key} 已经在派单中（{}）", r.state.as_str()),
            )
            .detail("run", r.run.clone())
            .detail("state", r.state.as_str())),
            None => Ok(()),
        }
    }

    /// 等一个可能很慢的步骤（登录探测）；关闭就不再等，立即以 DISPATCH_CLOSED 结束。
    fn while_open<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T, DispatchError> {
        let slot = Arc::new(Mutex::new(None::<T>));
        let filled = slot.clone();
        let me = self.arc();
        std::thread::spawn(move || {
            let v = work();
            *filled.lock().unwrap_or_else(|e| e.into_inner()) = Some(v);
            let _g = me.lifetime.0.lock().unwrap_or_else(|e| e.into_inner());
            me.lifetime.1.notify_all();
        });
        let mut g = self.lifetime.0.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if self.is_closed() {
                return Err(closed());
            }
            if let Some(v) = slot.lock().unwrap_or_else(|e| e.into_inner()).take() {
                return Ok(v);
            }
            g = self
                .lifetime
                .1
                .wait_timeout(g, LIFETIME_TICK)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }

    /// 缓存说「未登录」时先强制重探一次（用户可能刚在终端登录完），仍未登录才拒绝；探不出来照常排队，真没登录会在
    /// 会话结束时按鉴权失败报出来。
    fn assert_logged_in(&self, claude: &Path) -> Result<(), DispatchError> {
        let probe = self.claude.clone();
        let path = claude.to_path_buf();
        let state = self.while_open(move || {
            let (mut state, cached) = probe.auth(&path, false);
            if state.logged_in == Some(false) && cached {
                state = probe.auth(&path, true).0;
            }
            state
        })?;
        if state.logged_in == Some(false) {
            let mut e = DispatchError::new(
                Code::DISPATCH_CLAUDE_NOT_LOGGED_IN,
                CLAUDE_LOGIN_REQUIRED_MESSAGE,
            );
            if let Some(m) = state.auth_method {
                e = e.detail("authMethod", m);
            }
            return Err(e);
        }
        Ok(())
    }

    /// 项目存在且有可用的工作目录、任务属于该项目且现在可以派单（2.x `admitTask`）。
    fn admit_task(
        &self,
        principal: &Principal,
        input: &Enqueue,
    ) -> Result<(Target, TargetTask, String), Error> {
        let target = self
            .service
            .dispatch_target(principal, &input.project, &input.key)
            .map_err(domain)?;
        let Some(target) = target else {
            return Err(DispatchError::new(
                Code::DISPATCH_PROJECT_NOT_FOUND,
                format!("项目不存在：{}", input.project),
            )
            .detail("project", input.project.clone())
            .into());
        };
        let Some(cwd) = target.paths.iter().find(|p| Path::new(p).is_dir()).cloned() else {
            let message = if target.paths.is_empty() {
                format!(
                    "项目 {} 没有绑定工作目录，Claude 不知道在哪里干活：请先在 ATM 里给项目绑定目录",
                    target.code
                )
            } else {
                format!("项目 {} 绑定的目录都不存在", target.code)
            };
            return Err(
                DispatchError::new(Code::DISPATCH_PROJECT_PATH_MISSING, message)
                    .detail("project", target.code.clone())
                    .detail("paths", target.paths.clone())
                    .into(),
            );
        };
        if !input.key.starts_with(&format!("{}-", target.code)) {
            return Err(DispatchError::new(
                Code::DISPATCH_TASK_NOT_FOUND,
                format!("{} 不属于项目 {}", input.key, target.code),
            )
            .detail("project", target.code.clone())
            .detail("key", input.key.clone())
            .into());
        }
        let Some(task) = target.task.clone() else {
            return Err(DispatchError::new(
                Code::DISPATCH_TASK_NOT_FOUND,
                format!("任务不存在：{}", input.key),
            )
            .detail("project", target.code.clone())
            .detail("key", input.key.clone())
            .into());
        };
        if let Some(blocker) = task_blocker(&task, (self.now)()) {
            return Err(DispatchError::new(Code::DISPATCH_TASK_NOT_READY, blocker)
                .detail("key", task.key.clone())
                .detail("status", task.status.clone())
                .detail("claimedBySessionId", task.claimed_by_session_id.clone())
                .detail("claimLeaseUntil", task.claim_lease_until.clone())
                .into());
        }
        Ok((target, task, cwd))
    }

    fn enqueue_new(
        &self,
        principal: &Principal,
        input: &Enqueue,
        reservation: Option<&Reservation>,
    ) -> Result<Map<String, Value>, Error> {
        {
            let s = self.lock();
            if !s.config.enabled {
                return Err(disabled().into());
            }
            Self::assert_not_active(&s, &input.project, &input.key)?;
        }
        let Some(claude) = (self.resolve_claude)() else {
            return Err(DispatchError::new(
                Code::DISPATCH_CLAUDE_NOT_FOUND,
                "找不到 Claude Code 命令行（claude）：请先安装 Claude Code 并确认能在终端里运行 claude",
            )
            .into());
        };
        self.assert_logged_in(&claude)?;
        if self.is_closed() {
            return Err(closed().into());
        }
        let (target, task, cwd) = self.admit_task(principal, input)?;
        // 上面读了库：期间可能已关闭，或同一任务（或同一请求）的两次调用交错，插入前再查一次。
        if self.is_closed() {
            return Err(closed().into());
        }
        self.with_state(|s| {
            let now = (self.now)();
            if let Some(r) = reservation
                && let Some(raced) = s.ledger.find(&r.id, now)
            {
                return Self::replay_in(s, &raced);
            }
            if !s.config.enabled {
                return Err(disabled().into());
            }
            Self::assert_not_active(s, &target.code, &task.key)?;
            let (Some(run), Some(session_id)) = (new_run_id(now), new_session_id()) else {
                return Err(Error::Domain(DomainError::new(
                    ErrorCode::INTERNAL_ERROR,
                    "系统随机数不可用，没有启动 Claude",
                )));
            };
            let record = Record {
                run: run.clone(),
                project: target.code.clone(),
                key: task.key.clone(),
                title: task.title.clone(),
                task_id: Some(task.id.clone()),
                mobile: input.mobile,
                state: State::Queued,
                session_id,
                created_at: iso(now),
                started_at: None,
                ended_at: None,
                exit_code: ExitCode::Unset,
                summary: None,
                error: None,
                cwd: cwd.clone(),
                requested_by: clean_requester(input.requested_by.as_deref()),
                pid: None,
                process_identity: None,
                // 历史里也存一份命令 ID：账本缺了还能据此补回「这条命令派过哪次」。
                request_id: reservation.map(|r| r.id.clone()),
                legacy_logs: false,
            };
            s.runs.push(record.clone());
            if let Some(r) = reservation {
                // 先落账本再排队起进程：账本与派单行同一个事务，写不下去就不派。
                s.ledger.record_run(r, record.snapshot(), now);
                if let Err(e) = self.try_persist(s, principal) {
                    s.runs.retain(|x| x.run != run);
                    s.ledger.forget(&r.id);
                    return Err(Error::Domain(DomainError::new(
                        e.code,
                        format!("写派单请求账本失败，没有启动 Claude：{}", e.message),
                    )));
                }
            } else {
                self.persist(s, principal);
            }
            s.grants.insert(run.clone(), principal.clone());
            s.prompt_context.insert(run.clone(), target.name.clone());
            s.events.push(Some(record.project.clone()));
            self.pump(s);
            Ok(s.runs
                .iter()
                .find(|r| r.run == run)
                .map(Record::view)
                .unwrap_or_else(|| record.view()))
        })
    }

    /// 账本里记过的请求：返回那次派单的当前视图（还在历史里用历史，已被裁剪用账本快照），或原样拒绝。
    fn replay(&self, entry: &crate::ledger::Entry) -> Result<Map<String, Value>, Error> {
        let s = self.lock();
        Self::replay_in(&s, entry)
    }

    fn replay_in(s: &State_, entry: &crate::ledger::Entry) -> Result<Map<String, Value>, Error> {
        match &entry.outcome {
            crate::ledger::Outcome::Rejected { code, message } => {
                Err(DispatchError::new(*code, message.clone())
                    .detail("requestId", entry.id.clone())
                    .into())
            }
            crate::ledger::Outcome::Run(snapshot) => {
                let run = snapshot.get("run").and_then(Value::as_str).unwrap_or("");
                Ok(s.runs
                    .iter()
                    .find(|r| r.run == run)
                    .map(Record::view)
                    .unwrap_or_else(|| snapshot.clone()))
            }
        }
    }

    /// 按并发上限拉起排队中、带授权的派单。
    fn pump(&self, s: &mut State_) {
        if self.is_closed() || !s.config.enabled {
            return;
        }
        let running = s.runs.iter().filter(|r| r.state == State::Running).count();
        let mut slots =
            (s.config.max_concurrent as usize).saturating_sub(running + s.launching.len());
        let queued: Vec<String> = s
            .runs
            .iter()
            .filter(|r| {
                r.state == State::Queued
                    && !s.launching.contains(&r.run)
                    && s.grants.contains_key(&r.run)
            })
            .map(|r| r.run.clone())
            .collect();
        for run in queued {
            if slots == 0 {
                break;
            }
            slots -= 1;
            s.launching.insert(run.clone());
            let me = self.arc();
            let spawned = std::thread::Builder::new()
                .name("atm-dispatch-launch".into())
                .spawn(move || {
                    me.launch(&run);
                    me.with_state(|s| {
                        s.launching.remove(&run);
                        me.pump(s);
                    });
                });
            if spawned.is_err() {
                self.log.error("起不了派单启动线程", &Value::Null);
            }
        }
    }

    fn launch(&self, run: &str) {
        // 只在没关时被泵起来；之后每一步都再看一眼：宿主收尾后不起会话，记录留在队列里（下次启动时取消）。
        let (principal, project, key) = {
            let s = self.lock();
            let Some(r) = s
                .runs
                .iter()
                .find(|r| r.run == run && r.state == State::Queued)
            else {
                return;
            };
            let Some(p) = s.grants.get(run).cloned() else {
                return;
            };
            (p, r.project.clone(), r.key.clone())
        };
        let fail = |message: String| {
            self.with_state(|s| {
                if self.is_closed() {
                    return;
                }
                if let Some(at) = s
                    .runs
                    .iter()
                    .position(|r| r.run == run && r.state == State::Queued)
                {
                    self.finish(s, at, &principal, State::Failed, None, Some(message), None);
                }
            })
        };
        let Some(claude) = (self.resolve_claude)() else {
            return fail("找不到 Claude Code 命令行（claude）".into());
        };
        // 排队期间任务可能已被别人领取或改了状态，起一个注定要退出的会话没有意义。
        let target = match self.service.dispatch_target(&principal, &project, &key) {
            Ok(t) => t,
            Err(e) => return fail(format!("启动失败：{}", e.message)),
        };
        let spawned = self.with_state(|s| -> Option<Arc<dyn Child>> {
            if self.is_closed() {
                return None;
            }
            let at = s
                .runs
                .iter()
                .position(|r| r.run == run && r.state == State::Queued)?;
            let now = (self.now)();
            let task = target.as_ref().and_then(|t| t.task.clone());
            let blocker = match &task {
                Some(t) => task_blocker(t, now),
                None => Some("任务已不存在".into()),
            };
            if let Some(b) = blocker {
                self.finish(
                    s,
                    at,
                    &principal,
                    State::Cancelled,
                    None,
                    Some(format!("排队期间任务状态已变化：{b}")),
                    None,
                );
                return None;
            }
            let r = s.runs[at].clone();
            let project_name = s
                .prompt_context
                .get(run)
                .cloned()
                .or_else(|| target.as_ref().map(|t| t.name.clone()))
                .unwrap_or_else(|| r.project.clone());
            let title = task.map_or(r.title.clone(), |t| t.title);
            let prepared = claude_arguments(&r.session_id, &r.key, &s.config)
                .and_then(|args| launch_command(&claude, &args, self.comspec.as_deref()));
            let command = match prepared {
                Ok(c) => c,
                Err(e) => {
                    self.finish(
                        s,
                        at,
                        &principal,
                        State::Failed,
                        None,
                        Some(format!("启动失败：{}", e.message)),
                        None,
                    );
                    return None;
                }
            };
            let text = prompt::render(&PromptInput {
                run: &r.run,
                project_code: &r.project,
                project_name: &project_name,
                cwd: &r.cwd,
                key: &r.key,
                title: &title,
                mobile: r.mobile,
                requested_by: r.requested_by.as_deref(),
            });
            let (out, err) = self.logs_of(&r);
            let env = child_env(&self.base_env, &r.run);
            // 在锁里起：结束检查与「记为运行中」之间不能插进一次取消。
            let child = match self.spawner.spawn(&SpawnRequest {
                command: &command,
                cwd: Path::new(&r.cwd),
                env: &env,
                stdout_log: &out,
                stderr_log: &err,
                stdin: text.as_bytes(),
            }) {
                Ok(c) => Arc::<dyn Child>::from(c),
                Err(e) => {
                    self.finish(
                        s,
                        at,
                        &principal,
                        State::Failed,
                        None,
                        Some(format!("启动失败：{e}")),
                        None,
                    );
                    return None;
                }
            };
            let identity = child.identity();
            let rec = &mut s.runs[at];
            rec.pid = Some(child.pid());
            rec.process_identity = identity.clone();
            rec.state = State::Running;
            rec.started_at = Some(iso(now));
            s.prompt_context.remove(run);
            s.grants.remove(run);
            s.children.insert(run.to_owned(), child.clone());
            if identity.is_none() {
                self.log.warn(
                    "查不到会话进程的出生标识：宿主重启后不会接管它",
                    &json!({ "run": run }),
                );
            }
            self.persist(s, &principal);
            s.events.push(Some(r.project.clone()));
            self.log.info(
                "已派单",
                &json!({ "run": run, "key": r.key, "pid": child.pid() }),
            );
            Some(child)
        });
        if let Some(child) = spawned {
            let me = self.arc();
            let run = run.to_owned();
            let _ = std::thread::Builder::new()
                .name("atm-dispatch-wait".into())
                .spawn(move || {
                    if let Some(code) = child.wait(None) {
                        me.on_exit(&run, Some(code));
                    }
                });
        }
    }

    /// 进程结束：句柄的退出（带退出码）或接管轮询发现进程已不在（不带）。取消进行中时结局由取消流程定。
    fn on_exit(&self, run: &str, code: Option<i64>) {
        let p = self.tracker.clone();
        self.with_state(|s| {
            if code.is_some() {
                s.children.remove(run);
            }
            let Some(at) = s.runs.iter().position(|r| r.run == run) else {
                return;
            };
            if s.runs[at].state != State::Running || s.cancelling.contains_key(run) {
                if let Some(c) = code {
                    s.runs[at].exit_code = ExitCode::Code(c);
                }
                self.persist(s, &p);
                return;
            }
            let o = self.judge(&s.runs[at], code);
            self.finish_outcome(s, at, &p, o, code.map(ExitCode::Code));
        });
    }

    /// 结束会话进程树。`Ok(true)`：核验发现原进程早已退出，没动任何进程；`Ok(false)`：已结束（或结束前它已经不在）。
    fn terminate(
        &self,
        run: &str,
        pid: Option<u32>,
        identity: Option<&str>,
    ) -> Result<bool, DispatchError> {
        let (child, watching) = {
            let mut s = self.lock();
            (s.children.get(run).cloned(), s.watchers.remove(run))
        };
        let failed = |pid: u32, message: String| {
            DispatchError::new(Code::DISPATCH_CANCEL_FAILED, message)
                .detail("run", run)
                .detail("pid", pid)
        };
        let kill = |pid: u32, still_alive: &dyn Fn() -> bool| -> Result<bool, DispatchError> {
            match self.probe.kill_tree(pid) {
                KillResult::Killed | KillResult::Gone => Ok(false),
                // 结束命令报错，但进程其实已经没了（例如恰好自己退出）：照样算结束。
                KillResult::Failed(_) if !still_alive() => Ok(false),
                KillResult::Failed(reason) => {
                    self.log.warn(
                        "结束派单进程失败",
                        &json!({ "run": run, "pid": pid, "reason": reason }),
                    );
                    Err(failed(
                        pid,
                        format!(
                            "没能结束 Claude 进程（PID {pid}）：{reason}。派单仍在进行，可以稍后再点「结束」重试"
                        ),
                    ))
                }
            }
        };
        if let Some(child) = child {
            // 本宿主起的：句柄说还没退出就结束（此时 PID 不可能被复用）。
            if !child.running() {
                return Ok(false);
            }
            let pid = child.pid();
            return kill(pid, &|| child.running() && self.probe.is_alive(pid));
        }
        let Some(pid) = pid else {
            return Ok(true);
        };
        // 接管的：打开并持有这个进程，从同一个句柄核对出生标识，持有到结束完进程树——中间 PID 不会被回收给
        // 别的进程（只核对一次再按裸 PID 结束，核对之后原进程退出、PID 换主，结束的就是别人）。
        let (verdict, held) = process::check_held(self.probe.as_ref(), pid, identity);
        let result = match verdict {
            Verdict::Gone | Verdict::Different => Ok(true),
            Verdict::Unknown => Err(failed(
                pid,
                format!(
                    "暂时确认不了 PID {pid} 还是不是这次派单的 Claude 进程，为免误杀别的程序没有结束任何进程；请稍后重试，或在任务管理器里手动结束"
                ),
            )),
            Verdict::Same => kill(pid, &|| held.as_ref().is_some_and(|h| h.alive())),
        };
        drop(held);
        if result.is_err()
            && let Some(w) = watching
            && !self.is_closed()
        {
            self.lock().watchers.insert(run.to_owned(), w);
        }
        result
    }

    /// 接管的会话：每隔 `poll` 重核一次 PID + 出生标识。
    fn track_loop(&self) {
        loop {
            {
                let g = self.lifetime.0.lock().unwrap_or_else(|e| e.into_inner());
                if self.is_closed() {
                    return;
                }
                let _ = self.lifetime.1.wait_timeout(g, self.poll);
            }
            if self.is_closed() {
                return;
            }
            let watched: Vec<(String, u32, String)> = self
                .lock()
                .watchers
                .iter()
                .map(|(run, w)| (run.clone(), w.pid, w.identity.clone()))
                .collect();
            for (run, pid, identity) in watched {
                let verdict = process::check(self.probe.as_ref(), pid, Some(&identity));
                if self.is_closed() {
                    return;
                }
                let gone = self.with_state(|s| {
                    let Some(w) = s.watchers.get_mut(&run) else {
                        return false; // 核验期间被取消。
                    };
                    match verdict {
                        Verdict::Gone | Verdict::Different => {
                            s.watchers.remove(&run);
                            true
                        }
                        Verdict::Unknown => {
                            w.misses += 1;
                            if w.misses >= IDENTITY_MISS_LIMIT {
                                s.watchers.remove(&run);
                                self.log.warn(
                                    "接管的会话进程身份连续核验不了，已停止跟踪",
                                    &json!({ "run": run, "pid": pid }),
                                );
                                if let Some(at) = s
                                    .runs
                                    .iter()
                                    .position(|r| r.run == run && r.state == State::Running)
                                {
                                    let p = self.tracker.clone();
                                    let message =
                                        identity_lost_message(Some(pid), "接管后连续几次");
                                    self.finish(
                                        s,
                                        at,
                                        &p,
                                        State::Failed,
                                        None,
                                        Some(message),
                                        None,
                                    );
                                }
                            }
                            false
                        }
                        Verdict::Same => {
                            w.misses = 0;
                            false
                        }
                    }
                });
                if gone {
                    self.on_exit(&run, None);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(status: &str, claimed: Option<&str>, lease: Option<&str>) -> TargetTask {
        TargetTask {
            id: "01T".into(),
            key: "ATM-T-0001".into(),
            title: "t".into(),
            status: status.into(),
            description: String::new(),
            claimed_by_session_id: claimed.map(str::to_owned),
            claim_lease_until: lease.map(str::to_owned),
        }
    }

    #[test]
    fn the_tracking_interval_is_the_2x_five_seconds() {
        assert_eq!(TRACK_INTERVAL, Duration::from_millis(5000));
    }

    #[test]
    fn only_unclaimed_ready_or_backlog_tasks_can_be_dispatched() {
        let now = Timestamp::parse("2026-10-10T00:00:00.000Z")
            .unwrap()
            .millis();
        assert_eq!(task_blocker(&task("READY", None, None), now), None);
        assert_eq!(task_blocker(&task("BACKLOG", None, None), now), None);
        assert!(
            task_blocker(&task("IN_PROGRESS", None, None), now)
                .unwrap()
                .contains("IN_PROGRESS")
        );
        assert!(
            task_blocker(&task("READY", Some("S1"), None), now)
                .unwrap()
                .contains("S1")
        );
        assert!(
            task_blocker(
                &task("READY", Some("S1"), Some("2026-10-10T00:00:00.001Z")),
                now
            )
            .is_some()
        );
        assert!(task_blocker(&task("READY", Some("S1"), Some("garbage")), now).is_some());
        // 租约过期的领取不算。
        assert_eq!(
            task_blocker(
                &task("READY", Some("S1"), Some("2026-10-10T00:00:00.000Z")),
                now
            ),
            None
        );
    }

    #[test]
    fn the_requester_line_is_flattened_and_clipped() {
        assert_eq!(clean_requester(Some("  Pixel\n9 ")), Some("Pixel 9".into()));
        assert_eq!(clean_requester(Some(" \u{1} ")), None);
        assert_eq!(clean_requester(None), None);
        assert_eq!(
            clean_requester(Some(&"机".repeat(70)))
                .unwrap()
                .chars()
                .count(),
            60
        );
    }
}
