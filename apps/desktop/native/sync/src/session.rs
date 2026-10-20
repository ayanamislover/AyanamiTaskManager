//! 一次与中继的连接（2.x `packages/sync/src/session.ts`）：一个空间、一份密钥、一条变更流。
//!
//! 写操作由连接器串行调用（同一时刻只有一个在跑）；变更流只由同步循环的线程推进。

use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use atm_sync_protocol::SpaceKeys;
use atm_sync_protocol::keys::{KeyKind, classify_key, command_timestamp, is_project_code};
use atm_sync_protocol::schema::{COMMAND_MAX_AGE_MS, PERMISSION_MODES};
use serde_json::{Value, json};

use crate::commands::{execute_command, phone_principal, validate_command};
use crate::config::remember_processed;
use crate::errors::{Failure, ack_error, describe};
use crate::feed::{ChangeFeed, ChangeFeedOptions};
use crate::host::{Host, RETIRED};
use crate::relay::{Change, ChangeOp, Probe, RelayClient, RelayClientOptions};
use crate::snapshot::{build_head_body, build_project_snapshot, project_head_of, reader};
use crate::space::{SpaceStore, SpaceStoreOptions, StoreError};
use crate::text::clip_text;
use crate::time::{iso, js_date_parse};
use crate::transport::{Cancel, Sleeper, Transport};

/// 可重试的命令最多试几次，之后写失败 ack。
pub const COMMAND_ATTEMPTS: u32 = 5;
const ACK_SWEEP_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;
const HEAD_PROJECT_LIMIT: usize = 500;

pub struct SessionOptions {
    pub relay_url: String,
    pub app_id: String,
    pub token: String,
    pub space_id: String,
    pub secret: String,
    pub transport: Arc<dyn Transport>,
    /// 不支持长轮询的中继（AyanamiCloud）多久问一次，默认 4 s。
    pub poll_interval: Duration,
    /// 退避与轮询用的等待（用例换掉）。
    pub sleep: Option<Sleeper>,
    /// 会话的生命周期：取消后探测、发布、命令、在线状态等全部中继请求立即失败。
    pub lifetime: Cancel,
}

/// 一条命令这一轮的结局：处理完（含写了失败 ack）、稍后重试（算一次尝试）、延后到下次启动（不算）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Done,
    Retry,
    Deferred,
}

/// 发布的范围：全部项目，或这些项目码。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Dirty {
    All,
    Some(BTreeSet<String>),
}

impl Dirty {
    fn has(&self, code: &str) -> bool {
        match self {
            Dirty::All => true,
            Dirty::Some(s) => s.contains(code),
        }
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Published {
    pub written: Vec<String>,
    pub removed: Vec<String>,
    pub head_written: bool,
}

pub struct Session {
    pub client: RelayClient,
    pub store: SpaceStore,
    pub probe: Probe,
    host: Host,
    space_id: String,
    poll_interval: Duration,
    sleep: Option<Sleeper>,
    /// 命令 ID → 已经试过的次数，按排进来的先后。
    pending: Mutex<Vec<(String, u32)>>,
    devices: Mutex<HashMap<String, Value>>,
    feed: Mutex<ChangeFeed>,
    /// 游标被中继判为无效后重建了变更流：下一次全量重同步必须重写全部快照。
    force_resync: AtomicBool,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Session {
    /// 探测中继、派生密钥、建立变更流。探测失败直接返回（由连接器决定退避还是停止）。
    pub fn open(host: Host, options: SessionOptions) -> Result<Session, Failure> {
        let client = RelayClient::new(RelayClientOptions {
            base_url: options.relay_url.clone(),
            app_id: options.app_id.clone(),
            token: options.token.clone(),
            transport: options.transport.clone(),
            timeout: None,
            lifetime: Some(options.lifetime.clone()),
        })
        .map_err(|e| match e {
            crate::relay::ClientError::Url(e) => Failure::Protocol(e),
            crate::relay::ClientError::Relay(e) => Failure::Relay(e),
        })?;
        let probe = client.probe()?;
        let keys = SpaceKeys::derive(&options.secret)?;
        let store = SpaceStore::new(SpaceStoreOptions {
            client: client.clone(),
            keys,
            space_id: options.space_id.clone(),
            retry_delay: None,
            lifetime: Some(options.lifetime.clone()),
            sleep: None,
        })?;
        let cursor = host.config().cursor;
        let feed = new_feed(
            &client,
            &options.space_id,
            &probe,
            cursor,
            options.poll_interval,
            options.sleep.clone(),
        )?;
        Ok(Session {
            client,
            store,
            probe,
            host,
            space_id: options.space_id,
            poll_interval: options.poll_interval,
            sleep: options.sleep,
            pending: Mutex::new(Vec::new()),
            devices: Mutex::new(HashMap::new()),
            feed: Mutex::new(feed),
            force_resync: AtomicBool::new(false),
        })
    }

    pub fn space_id(&self) -> &str {
        &self.space_id
    }

    pub fn feed(&self) -> MutexGuard<'_, ChangeFeed> {
        lock(&self.feed)
    }

    pub fn cursor(&self) -> Option<String> {
        self.feed().cursor().map(str::to_owned)
    }

    /// 中继不认保存的游标（atm-relay 与 AyanamiCloud 的游标格式互不通用，回 400）：丢掉游标从头建变更流，
    /// 下一次全量重同步强制重写。
    pub fn reset_feed(&self) -> Result<(), Failure> {
        let feed = new_feed(
            &self.client,
            &self.space_id,
            &self.probe,
            None,
            self.poll_interval,
            self.sleep.clone(),
        )?;
        *self.feed() = feed;
        self.force_resync.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub fn pending_count(&self) -> usize {
        lock(&self.pending).len()
    }

    /// 其它设备（不含本机），按最后在线时间倒序；去掉版本号 `v`。
    pub fn devices(&self) -> Vec<Value> {
        let mut out: Vec<Value> = lock(&self.devices)
            .values()
            .map(|d| {
                let mut v = d.clone();
                if let Some(m) = v.as_object_mut() {
                    m.remove("v");
                }
                v
            })
            .collect();
        out.sort_by(|a, b| {
            b["at"]
                .as_str()
                .unwrap_or_default()
                .cmp(a["at"].as_str().unwrap_or_default())
        });
        out
    }

    // ─── 整体流程 ───

    /// 连上以后：报在线 → 读设备 → 兜底处理漏掉的命令 → 发布（摘要不变不写）→ 按天清旧回执。
    pub fn initial_sync(&self) -> Result<(), Failure> {
        self.write_presence("online")?;
        self.refresh_devices()?;
        self.scan_commands()?;
        self.process_pending()?;
        self.publish(&Dirty::All, false)?;
        self.sweep_acks_if_due()
    }

    /// 变更流重来（游标过期 410 或第一次拿到游标）：重读设备与命令、重建全部快照。`force` 时不管摘要一律重写。
    pub fn full_resync(&self, force: bool) -> Result<(), Failure> {
        let force = force || self.force_resync.load(Ordering::SeqCst);
        self.refresh_devices()?;
        self.scan_commands()?;
        self.process_pending()?;
        self.publish(&Dirty::All, force)?;
        self.force_resync.store(false, Ordering::SeqCst);
        Ok(())
    }

    /// 每 5 分钟：报在线、刷新设备、按天清旧回执。
    pub fn presence_tick(&self) -> Result<(), Failure> {
        self.write_presence("online")?;
        self.refresh_devices()?;
        self.sweep_acks_if_due()
    }

    pub fn apply_changes(&self, changes: &[Change]) -> Result<(), Failure> {
        let own = self.host.config().device_id;
        for change in changes {
            let Some(key) = classify_key(&self.space_id, &change.key) else {
                continue;
            };
            if change.op == ChangeOp::Delete {
                self.store.forget(&change.key);
            }
            if key.part != 0 {
                continue;
            }
            match key.kind {
                KeyKind::Command(id) if change.op == ChangeOp::Put => self.enqueue(&id),
                KeyKind::Device(id) if id != own => self.on_device(&id, change.op)?,
                _ => {}
            }
        }
        self.process_pending()
    }

    // ─── 快照 ───

    /// 重建受影响项目的快照，摘要变了才写；已不再活动的项目删掉；head 最后写。
    pub fn publish(&self, dirty: &Dirty, force: bool) -> Result<Published, Failure> {
        let host = &self.host;
        let now = host.now_ms();
        let at = iso(now);
        let projects: Vec<(String, String)> = host
            .service()?
            .ui_projects(&reader())?
            .as_array()
            .into_iter()
            .flatten()
            .filter(|p| p["lifecycle"] == "ACTIVE")
            .filter_map(|p| {
                Some((
                    p["code"].as_str()?.to_owned(),
                    p["name"].as_str().unwrap_or_default().to_owned(),
                ))
            })
            .filter(|(code, _)| is_project_code(code))
            .collect();
        let mut out = Published::default();
        for (code, name) in &projects {
            let previous = host.config().published.get(code).cloned();
            let renamed = previous
                .as_ref()
                .is_some_and(|p| p.head["name"].as_str() != Some(clip_text(name, 200).as_str()));
            let wanted = force || dirty.has(code) || previous.is_none() || renamed;
            if !wanted {
                continue;
            }
            let snapshot = build_project_snapshot(host, code, name, now)?;
            if !force && previous.as_ref().is_some_and(|p| p.d == snapshot.digest) {
                continue;
            }
            let hash = self.store.project_hash(code);
            let mut doc = snapshot.body.clone();
            doc["at"] = json!(at);
            self.store.write_project(&hash, &doc)?;
            let entry = atm_service::sync_state::Published {
                h: hash.clone(),
                d: snapshot.digest.clone(),
                head: project_head_of(&snapshot, &hash, &at),
            };
            host.commit(|c| {
                let mut next = c.clone();
                next.published.insert(code.clone(), entry.clone());
                Some(next)
            })?;
            out.written.push(code.clone());
        }
        let live: BTreeSet<&str> = projects.iter().map(|(c, _)| c.as_str()).collect();
        let stale: Vec<(String, String)> = host
            .config()
            .published
            .iter()
            .filter(|(code, _)| !live.contains(code.as_str()))
            .map(|(code, p)| (code.clone(), p.h.clone()))
            .collect();
        for (code, hash) in stale {
            self.store.delete_project(&hash)?;
            host.commit(|c| {
                let mut next = c.clone();
                next.published.remove(&code);
                Some(next)
            })?;
            out.removed.push(code);
        }
        out.head_written = self.write_head(&at, force)?;
        Ok(out)
    }

    fn write_head(&self, at: &str, force: bool) -> Result<bool, Failure> {
        let host = &self.host;
        let config = host.config();
        let dispatch = match host.dispatch()? {
            Some(d) => {
                let s = d.summary();
                let mode = if PERMISSION_MODES.contains(&s.mode.as_str()) {
                    s.mode
                } else {
                    "auto".to_owned()
                };
                json!({ "enabled": s.enabled, "mode": mode, "running": s.running })
            }
            None => json!({ "enabled": false, "mode": "auto", "running": 0 }),
        };
        let heads: Vec<Value> = config
            .published
            .values()
            .map(|p| p.head.clone())
            .take(HEAD_PROJECT_LIMIT)
            .collect();
        let (body, digest) = build_head_body(
            json!({ "id": config.device_id, "name": config.device_name, "app": clip_text(&host.app_version, 32) }),
            dispatch,
            heads,
        );
        if !force && config.head_digest.as_deref() == Some(digest.as_str()) {
            return Ok(false);
        }
        let mut doc = body;
        doc["at"] = json!(at);
        self.store.write_head(&doc)?;
        host.commit(|c| {
            let mut next = c.clone();
            next.head_digest = Some(digest.clone());
            Some(next)
        })?;
        Ok(true)
    }

    // ─── 命令 ───

    fn enqueue(&self, command_id: &str) {
        let count = {
            let mut pending = lock(&self.pending);
            if !pending.iter().any(|(id, _)| id == command_id) {
                pending.push((command_id.to_owned(), 0));
            }
            pending.len()
        };
        self.host.state.on_pending(count);
    }

    /// 列出空间里还在的命令，全部排进待处理（漏掉的变更、重启前没处理完的）。
    pub fn scan_commands(&self) -> Result<(), Failure> {
        for key in self.store.list_keys("cmd")? {
            if let Some(c) = classify_key(&self.space_id, &key)
                && let KeyKind::Command(id) = c.kind
            {
                self.enqueue(&id);
            }
        }
        Ok(())
    }

    /// 逐条处理。中继错误原样返回（连接器退避后重来），待处理的留着下次继续。
    pub fn process_pending(&self) -> Result<(), Failure> {
        let batch: Vec<(String, u32)> = lock(&self.pending).clone();
        let result = (|| {
            for (id, attempts) in batch {
                match self.process_command(&id, attempts)? {
                    Outcome::Done => lock(&self.pending).retain(|(p, _)| *p != id),
                    Outcome::Retry => {
                        if let Some(entry) = lock(&self.pending).iter_mut().find(|(p, _)| *p == id)
                        {
                            entry.1 = attempts + 1;
                        }
                    }
                    // 派单器已随宿主退出：这一批剩下的命令也留给下次启动，不再白耗它们的尝试次数。
                    Outcome::Deferred => break,
                }
            }
            Ok(())
        })();
        self.host.state.on_pending(self.pending_count());
        result
    }

    fn process_command(&self, id: &str, attempts: u32) -> Result<Outcome, Failure> {
        let host = &self.host;
        if host.config().processed.iter().any(|p| p == id) {
            // 回执已经写过（上次删命令没成功，或中继把旧密文原样放了回来）：只补删，不再执行。
            self.store.delete_command(id)?;
            return Ok(Outcome::Done);
        }
        let doc = match self.store.read_command(id) {
            Ok(doc) => doc,
            Err(StoreError::Relay(e)) => return Err(Failure::Relay(e)),
            Err(e) => {
                if e.is_incomplete() && attempts + 1 < COMMAND_ATTEMPTS {
                    return Ok(Outcome::Retry);
                }
                let ack = json!({
                    "v": 1, "id": id, "at": iso(host.now_ms()), "ok": false,
                    "error": { "code": "COMMAND_UNREADABLE", "message": describe(&e.into()) },
                });
                self.finish(id, &ack)?;
                return Ok(Outcome::Done);
            }
        };
        let Some(doc) = doc else {
            return Ok(Outcome::Done);
        };
        let executed = validate_command(&doc, id, host.now_ms()).and_then(|()| {
            let phone = phone_principal(&self.space_id, &doc);
            execute_command(host, &phone, &doc)
        });
        let ack = match executed {
            Ok(result) => {
                host.log.info(
                    "已执行手机命令",
                    &json!({ "command": id, "type": doc["type"], "key": result["key"] }),
                );
                json!({ "v": 1, "id": id, "at": iso(host.now_ms()), "ok": true, "result": result })
            }
            // 会话已经停下：迟到的这一步不是命令的结局，什么都不写。
            Err(Failure::Other(e)) if e == RETIRED => return Err(Failure::Other(e)),
            // 派单器已随宿主退出关闭：不写 ack、不算尝试，命令留在中继上，下次启动再处理。
            Err(e) if e.is_deferred() => return Ok(Outcome::Deferred),
            Err(e) if e.is_retryable() && attempts + 1 < COMMAND_ATTEMPTS => {
                return Ok(Outcome::Retry);
            }
            Err(e) => {
                let (code, message) = ack_error(&e);
                host.log
                    .warn("手机命令未执行", &json!({ "command": id, "code": code }));
                json!({ "v": 1, "id": id, "at": iso(host.now_ms()), "ok": false, "error": { "code": code, "message": message } })
            }
        };
        self.finish(id, &ack)?;
        Ok(Outcome::Done)
    }

    /// 先写回执、记下已处理，再删命令。回执写失败时命令留在待处理里、稍后整条重做：建任务靠 ATM 的
    /// op_id（`mobile:<命令 ID>`，回执与任务同一个事务提交）拿回同一个任务，派单靠派单层以命令 ID 为键的
    /// 请求账本拿回同一次派单，所以重做只会补写回执。
    fn finish(&self, id: &str, ack: &Value) -> Result<(), Failure> {
        self.store.write_ack(ack)?;
        let now = self.host.now_ms().max(0) as u64;
        self.host.commit(|c| remember_processed(c, id, now))?;
        self.store.delete_command(id)?;
        Ok(())
    }

    /// 每天一次：删掉 7 天前的回执（手机没来得及删的）。命令 ID 自带时间，不用解密。
    pub fn sweep_acks_if_due(&self) -> Result<(), Failure> {
        let now = self.host.now_ms();
        if let Some(last) = self
            .host
            .config()
            .last_ack_sweep_at
            .as_deref()
            .and_then(js_date_parse)
            && now - last < ACK_SWEEP_INTERVAL_MS
        {
            return Ok(());
        }
        for key in self.store.list_keys("ack")? {
            let Some(c) = classify_key(&self.space_id, &key) else {
                continue;
            };
            let KeyKind::Ack(id) = c.kind else {
                continue;
            };
            if let Some(sent) = command_timestamp(&id)
                && i128::from(now) - i128::from(sent) > i128::from(COMMAND_MAX_AGE_MS)
            {
                self.store.delete_ack(&id)?;
            }
        }
        self.host.commit(|c| {
            let mut next = c.clone();
            next.last_ack_sweep_at = Some(iso(now));
            Some(next)
        })
    }

    // ─── 设备 ───

    pub fn write_presence(&self, state: &str) -> Result<(), Failure> {
        let config = self.host.config();
        self.store.write_device(&json!({
            "v": 1,
            "id": config.device_id,
            "name": config.device_name,
            "kind": if cfg!(windows) { "windows" } else { "other" },
            "role": "host",
            "app": clip_text(&self.host.app_version, 32),
            "at": iso(self.host.now_ms()),
            "state": state,
        }))?;
        Ok(())
    }

    pub fn refresh_devices(&self) -> Result<(), Failure> {
        let own = self.host.config().device_id;
        let mut next = HashMap::new();
        for key in self.store.list_keys("dev")? {
            let Some(c) = classify_key(&self.space_id, &key) else {
                continue;
            };
            let KeyKind::Device(id) = c.kind else {
                continue;
            };
            if id == own {
                continue;
            }
            if let Some(doc) = self.read_device(&id)? {
                let id = doc["id"].as_str().unwrap_or_default().to_owned();
                next.insert(id, doc);
            }
        }
        *lock(&self.devices) = next;
        self.host.state.on_devices(self.devices());
        Ok(())
    }

    fn on_device(&self, id: &str, op: ChangeOp) -> Result<(), Failure> {
        let doc = match op {
            ChangeOp::Delete => None,
            ChangeOp::Put => self.read_device(id)?,
        };
        {
            let mut devices = lock(&self.devices);
            match doc {
                Some(d) => {
                    devices.insert(id.to_owned(), d);
                }
                None => {
                    devices.remove(id);
                }
            }
        }
        self.host.state.on_devices(self.devices());
        Ok(())
    }

    /// 解不开的设备文档（旧密钥、损坏）不算已配对设备；中继的错误照常返回。
    fn read_device(&self, id: &str) -> Result<Option<Value>, Failure> {
        match self.store.read_device(id) {
            Ok(d) => Ok(d),
            Err(StoreError::Relay(e)) => Err(Failure::Relay(e)),
            Err(_) => Ok(None),
        }
    }
}

fn new_feed(
    client: &RelayClient,
    space_id: &str,
    probe: &Probe,
    cursor: Option<String>,
    interval: Duration,
    sleep: Option<Sleeper>,
) -> Result<ChangeFeed, Failure> {
    ChangeFeed::new(ChangeFeedOptions {
        client: client.clone(),
        space_id: space_id.to_owned(),
        cursor,
        long_poll: probe.long_poll,
        max_wait: (probe.max_wait > 0.0).then_some(probe.max_wait),
        interval,
        sleep,
    })
    .ok_or_else(|| Failure::command("COMMAND_FAILED", "空间 ID 不合法"))
}
