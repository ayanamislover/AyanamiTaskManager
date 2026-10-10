//! 派单请求账本（2.x `request-ledger.ts` + `ledger-file.ts`）：requestId（手机命令 ID）→ 那次请求的结局
//! （建出来的派单，或被拒的原因）。同一个 requestId 再来，派单层直接回放这个结局，绝不再起会话。
//!
//! 3.0 里账本是 `dispatch_requests` 表，与 `dispatch_runs` 同一个写事务落盘（05 §7「条目在起进程之前落盘」变成
//! 事务保证），所以 2.x 防「两份文件分别丢失」的 `requestsSince` 标记不再需要。恢复状态机照旧：
//! - **unavailable**：账本读不出来（库报错）。带 requestId 的派单一律 503 `DISPATCH_LEDGER_UNAVAILABLE`，
//!   每次派单 / 查状态前重读，读出来就转入正常状态。
//! - **正常、无水位线**：照常幂等。
//! - **正常、有水位线 `lost_before`**（发现数据丢失的时刻，持久化）：记得住的请求照常精确回放；记不住的、发送时间
//!   ≤ 水位线或取不出发送时间的一律 409 `DISPATCH_REQUEST_STATE_LOST`（不记进账本，免得把它固化）；水位线之后发出
//!   的照常办理。水位线在 `lost_before + 保留期` 后自动清除：那之前发出的命令到时都已过期。
//!
//! 什么算丢失：转换时 2.x 的账本文件坏了（转换器落成水位线），或库里有一行读不懂（码不认识、快照不是对象）。
//! 读不懂的行删掉并记日志：留着的话每次启动都会再判一次丢失、把水位线往后推。

use std::collections::{BTreeSet, HashMap};

use serde_json::{Map, Value};

use crate::errors::{Code, DispatchError};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// 手机命令的有效期：与 sync-protocol 的 `COMMAND_MAX_AGE_MS` 同值（7 天）。
pub const REQUEST_MAX_AGE_MS: i64 = 7 * DAY_MS;
/// 条目从记下起保留多久：命令有效期 7 天 + 手机时钟最多快 1 天 + 1 天余量吸收电脑时钟回拨。
pub const REQUEST_RETENTION_MS: i64 = REQUEST_MAX_AGE_MS + 2 * DAY_MS;
/// 保留期内最多记这么多条（含已预留名额的请求）；满了拒收新的手机派单，而不是挤掉旧条目
/// （否则被挤掉的命令在有效期内重放就能再起一次会话）。
pub const REQUEST_LIMIT: usize = 2_000;

const UNAVAILABLE_MESSAGE: &str = "电脑上的派单记录暂时读不出来（文件权限或磁盘问题），为防重复执行暂不接收手机派单；稍后会自动重试，也可以在电脑上直接派单";
/// 发送时间早于水位线的手机派单被拒时给用户看的话。
pub const STATE_LOST_MESSAGE: &str =
    "电脑上的派单记录损坏过，无法确认这条命令是否已经执行；如需再派，请在手机上重新交给 Claude";

/// `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`：requestId 只是不透明的幂等键。
pub fn request_id_ok(id: &str) -> bool {
    let b = id.as_bytes();
    (1..=128).contains(&b.len())
        && b[0].is_ascii_alphanumeric()
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b':' | b'-'))
}

/// 手机命令 ID `<deviceId>.<13 位 base36 毫秒时间><8 位 hex>` 里的发送时间；不是这个形状是 `None`。
pub fn request_timestamp(id: &str) -> Option<i64> {
    let (device, rest) = id.split_once('.')?;
    let hex12 = device
        .strip_prefix("pc-")
        .or_else(|| device.strip_prefix("m-"))?;
    let lower_hex = |s: &str| {
        s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    if hex12.len() != 12 || !lower_hex(hex12) || rest.len() != 21 {
        return None;
    }
    let (stamp, random) = rest.split_at(13);
    if !lower_hex(random)
        || !stamp
            .bytes()
            .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase())
    {
        return None;
    }
    let at = i64::from_str_radix(stamp, 36).ok()?;
    // Number.isSafeInteger。
    (at <= (1i64 << 53) - 1).then_some(at)
}

/// 一条账本记录。
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    /// 那次派单的快照（对外视图去掉摘要，2.x `snapshotOf`；3.0 另带 `taskId`）。
    Run(Map<String, Value>),
    Rejected {
        code: Code,
        message: String,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub id: String,
    pub at: String,
    pub outcome: Outcome,
}

/// 库里的一行（服务层不解释内容）。
pub use atm_service::dispatch_state::RequestRow as RawEntry;

impl Entry {
    pub fn parse(raw: &RawEntry) -> Option<Entry> {
        if !request_id_ok(&raw.id) {
            return None;
        }
        let outcome = match (&raw.run_snapshot_json, &raw.rejected_code) {
            (Some(json), None) => match serde_json::from_str::<Value>(json).ok()? {
                Value::Object(o) if snapshot_ok(&o) => Outcome::Run(o),
                _ => return None,
            },
            (None, Some(code)) => Outcome::Rejected {
                code: Code::parse(code)?,
                message: raw.rejected_message.clone()?,
            },
            _ => return None,
        };
        Some(Entry {
            id: raw.id.clone(),
            at: raw.at.clone(),
            outcome,
        })
    }

    pub fn to_raw(&self) -> RawEntry {
        match &self.outcome {
            Outcome::Run(snapshot) => RawEntry {
                id: self.id.clone(),
                at: self.at.clone(),
                run_snapshot_json: Some(Value::Object(snapshot.clone()).to_string()),
                rejected_code: None,
                rejected_message: None,
            },
            Outcome::Rejected { code, message } => RawEntry {
                id: self.id.clone(),
                at: self.at.clone(),
                run_snapshot_json: None,
                rejected_code: Some(code.as_str().to_owned()),
                rejected_message: Some(message.clone()),
            },
        }
    }
}

/// 2.x `SnapshotSchema` 的必填字段与取值。
fn snapshot_ok(o: &Map<String, Value>) -> bool {
    let text = |k: &str| o.get(k).and_then(Value::as_str);
    let nonempty = |k: &str| text(k).is_some_and(|s| !s.is_empty());
    nonempty("run")
        && nonempty("project")
        && nonempty("key")
        && text("title").is_some()
        && matches!(text("origin"), Some("mobile" | "desktop"))
        && matches!(
            text("state"),
            Some("queued" | "running" | "succeeded" | "failed" | "cancelled")
        )
        && nonempty("sessionId")
        && text("createdAt").is_some()
}

/// 给新请求预留的一个账本名额：成功或业务拒绝时转成条目，否则还回去。
#[derive(Debug, PartialEq, Eq, Hash)]
pub struct Reservation {
    token: u64,
    pub id: String,
}

pub enum Gate {
    Replay(Entry),
    New(Reservation),
}

/// 一次读盘的结果。
pub enum Loaded {
    Ok(Vec<RawEntry>, Option<String>),
    /// 库读不出来。
    Unavailable(String),
}

pub trait LedgerLog {
    fn warn(&self, message: &str, meta: &Value);
}

/// 账本这次改了什么，交给派单器与派单历史一起落盘。
#[derive(Debug, Default, PartialEq)]
pub struct Changes {
    pub upsert: BTreeSet<String>,
    pub delete: BTreeSet<String>,
    pub watermark: bool,
}

impl Changes {
    pub fn is_empty(&self) -> bool {
        self.upsert.is_empty() && self.delete.is_empty() && !self.watermark
    }
}

pub struct Ledger {
    available: bool,
    entries: Vec<Entry>,
    lost_before: Option<i64>,
    reserved: HashMap<u64, String>,
    next_token: u64,
    pending: Changes,
}

fn iso(ms: i64) -> String {
    atm_domain::time::Timestamp::from_millis(ms).to_string()
}

fn parse_ms(text: &str) -> Option<i64> {
    atm_domain::time::Timestamp::parse(text).map(|t| t.millis())
}

impl Ledger {
    /// 账本还没读过（或读不出来）。
    pub fn unavailable() -> Ledger {
        Ledger {
            available: false,
            entries: Vec::new(),
            lost_before: None,
            reserved: HashMap::new(),
            next_token: 1,
            pending: Changes::default(),
        }
    }

    pub fn is_available(&self) -> bool {
        self.available
    }

    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    pub fn lost_before(&self) -> Option<i64> {
        self.lost_before
    }

    /// 读盘。`history` 是派单历史里带 requestId 的那些：账本里没有的补回成精确条目（它们不受水位线影响）。
    pub fn reload(
        &mut self,
        loaded: Loaded,
        history: &[(String, String, Map<String, Value>)],
        now: i64,
        log: &dyn LedgerLog,
    ) {
        let (rows, lost) = match loaded {
            Loaded::Unavailable(reason) => {
                log.warn(
                    "派单请求账本读不出来，暂停接收手机派单，下次派单时重读",
                    &serde_json::json!({ "error": reason }),
                );
                self.available = false;
                return;
            }
            Loaded::Ok(rows, lost) => (rows, lost),
        };
        self.available = true;
        self.entries.clear();
        self.lost_before = None;
        let mut loss = None;
        match lost.as_deref().map(parse_ms) {
            Some(Some(ms)) => self.lost_before = Some(ms),
            Some(None) => loss = Some("账本里的水位线不合法"),
            None => {}
        }
        for raw in &rows {
            match Entry::parse(raw) {
                Some(e) => self.entries.push(e),
                None => {
                    loss = Some("账本里有记录不合法");
                    self.pending.delete.insert(raw.id.clone());
                }
            }
        }
        // 新的在前：同一个 requestId 在历史里出现两次（旧条目过期后又派过一次）时，以最近那次为准。
        for (id, at, snapshot) in history.iter().rev() {
            if self.entries.iter().any(|e| &e.id == id) {
                continue;
            }
            self.entries.push(Entry {
                id: id.clone(),
                at: at.clone(),
                outcome: Outcome::Run(snapshot.clone()),
            });
            self.pending.upsert.insert(id.clone());
        }
        if let Some(reason) = loss {
            log.warn(
                "派单请求账本数据丢失，设下水位线",
                &serde_json::json!({ "reason": reason }),
            );
            self.lost_before = Some(self.lost_before.map_or(now, |l| l.max(now)));
            self.pending.watermark = true;
        }
        self.prune(now);
    }

    /// 裁掉超过保留期的条目；水位线到期就清除。记下时间看不懂的条目宁可留着（受条数上限约束）。
    fn prune(&mut self, now: i64) {
        let cutoff = now - REQUEST_RETENTION_MS;
        let mut gone = Vec::new();
        self.entries.retain(|e| {
            let keep = parse_ms(&e.at).is_none_or(|at| at >= cutoff);
            if !keep {
                gone.push(e.id.clone());
            }
            keep
        });
        for id in gone {
            self.pending.upsert.remove(&id);
            self.pending.delete.insert(id);
        }
        if self.lost_before.is_some_and(|l| l < cutoff) {
            self.lost_before = None;
            self.pending.watermark = true;
        }
    }

    /// 取走还没落盘的改动。
    pub fn take_changes(&mut self) -> Changes {
        std::mem::take(&mut self.pending)
    }

    /// 落盘失败：改动放回去，下次再写。
    pub fn restore_changes(&mut self, changes: Changes) {
        self.pending.upsert.extend(changes.upsert);
        self.pending.delete.extend(changes.delete);
        self.pending.watermark |= changes.watermark;
    }

    pub fn entry(&self, id: &str) -> Option<&Entry> {
        self.entries.iter().find(|e| e.id == id)
    }

    /// `(lostBefore, lostUntil, unavailable)`。
    pub fn status(&mut self, now: i64) -> (Option<String>, Option<String>, bool) {
        if self.available {
            self.prune(now);
        }
        let lost = self.lost_before.filter(|_| self.available);
        (
            lost.map(iso),
            lost.map(|l| iso(l + REQUEST_RETENTION_MS)),
            !self.available,
        )
    }

    pub fn find(&mut self, id: &str, now: i64) -> Option<Entry> {
        self.prune(now);
        self.entry(id).cloned()
    }

    /// 带 requestId 的派单入口：记过的 → 回放；读不出来 → 503；水位线之前发出的 → 409（不记账）；
    /// 满了 → 429（不记账，过期后同一 ID 仍可办理）；否则预留一个名额。整段在派单器的锁里，并发请求不会越过上限。
    pub fn admit(&mut self, id: &str, now: i64) -> Result<Gate, DispatchError> {
        if !self.available {
            return Err(DispatchError::new(
                Code::DISPATCH_LEDGER_UNAVAILABLE,
                UNAVAILABLE_MESSAGE,
            ));
        }
        if let Some(e) = self.find(id, now) {
            return Ok(Gate::Replay(e));
        }
        if let Some(lost) = self.lost_before {
            let sent = request_timestamp(id);
            if sent.is_none_or(|s| s <= lost) {
                return Err(DispatchError::new(
                    Code::DISPATCH_REQUEST_STATE_LOST,
                    STATE_LOST_MESSAGE,
                )
                .detail("requestId", id)
                .detail("lostBefore", iso(lost)));
            }
        }
        if self.entries.len() + self.reserved.len() >= REQUEST_LIMIT {
            return Err(DispatchError::new(
                Code::DISPATCH_TOO_MANY_REQUESTS,
                format!(
                    "最近 {} 天收到的手机派单已达 {REQUEST_LIMIT} 次，为防重放暂不接收新的手机派单；可以在电脑上直接派单，或过几天再试",
                    REQUEST_RETENTION_MS / DAY_MS
                ),
            ));
        }
        let token = self.next_token;
        self.next_token += 1;
        self.reserved.insert(token, id.to_owned());
        Ok(Gate::New(Reservation {
            token,
            id: id.to_owned(),
        }))
    }

    /// 没用上的名额还回去（记账后再调也无妨）。
    pub fn release(&mut self, r: &Reservation) {
        self.reserved.remove(&r.token);
    }

    /// 写入端也守上限：只认 admit 发出且还没用掉的名额。
    fn append(&mut self, r: &Reservation, entry: Entry) -> bool {
        if self.reserved.get(&r.token) != Some(&entry.id) {
            return false;
        }
        self.reserved.remove(&r.token);
        self.pending.upsert.insert(entry.id.clone());
        self.pending.delete.remove(&entry.id);
        self.entries.push(entry);
        true
    }

    /// 记下建出来的派单（调用方随后与派单行同一个事务落盘，写失败调 [`Ledger::forget`] 撤回）。
    pub fn record_run(&mut self, r: &Reservation, snapshot: Map<String, Value>, now: i64) -> bool {
        self.append(
            r,
            Entry {
                id: r.id.clone(),
                at: iso(now),
                outcome: Outcome::Run(snapshot),
            },
        )
    }

    /// 撤回一条还没落盘成功的记录。
    pub fn forget(&mut self, id: &str) {
        self.entries.retain(|e| e.id != id);
        self.pending.upsert.remove(id);
    }

    /// 记下被拒的结局：同一请求再来时原样拒绝，不会因为状态变了就补起一次会话。
    pub fn record_rejection(&mut self, r: &Reservation, error: &DispatchError, now: i64) {
        if self.entries.iter().any(|e| e.id == r.id) {
            return;
        }
        self.append(
            r,
            Entry {
                id: r.id.clone(),
                at: iso(now),
                outcome: Outcome::Rejected {
                    code: error.code,
                    message: error.message.clone(),
                },
            },
        );
    }

    /// 用派单历史刷新快照（在历史裁剪之前调）：被裁掉的派单在账本里留下的是它最后的状态。
    /// 历史里已经没有、快照却还停在排队 / 运行中的（例如宿主在两次写盘之间退出）标成失败。
    pub fn sync(&mut self, snapshots: &HashMap<String, Map<String, Value>>) {
        if !self.available {
            return;
        }
        for e in &mut self.entries {
            let Outcome::Run(current) = &e.outcome else {
                continue;
            };
            let run = current.get("run").and_then(Value::as_str).unwrap_or("");
            let next = match snapshots.get(run) {
                Some(s) => s.clone(),
                None if matches!(
                    current.get("state").and_then(Value::as_str),
                    Some("queued" | "running")
                ) =>
                {
                    let mut s = current.clone();
                    s.insert("state".into(), "failed".into());
                    s.insert(
                        "error".into(),
                        "这次派单已不在派单历史里（宿主可能在写盘途中退出）".into(),
                    );
                    s
                }
                None => continue,
            };
            if &next != current {
                e.outcome = Outcome::Run(next);
                self.pending.upsert.insert(e.id.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Quiet;
    impl LedgerLog for Quiet {
        fn warn(&self, _m: &str, _v: &Value) {}
    }

    const NOW: i64 = 1_791_024_100_252;

    fn command_id(at: i64) -> String {
        let mut stamp = String::new();
        let mut n = at as u64;
        while n > 0 {
            let d = (n % 36) as u8;
            stamp.insert(0, char::from(if d < 10 { b'0' + d } else { b'a' + d - 10 }));
            n /= 36;
        }
        format!("m-0123456789ab.{stamp:0>13}deadbeef")
    }

    fn snapshot(run: &str, state: &str) -> Map<String, Value> {
        json!({
            "run": run, "project": "ATM", "key": "ATM-T-0001", "title": "t", "origin": "mobile",
            "state": state, "sessionId": "s", "createdAt": iso(NOW)
        })
        .as_object()
        .unwrap()
        .clone()
    }

    fn fresh() -> Ledger {
        let mut l = Ledger::unavailable();
        l.reload(Loaded::Ok(Vec::new(), None), &[], NOW, &Quiet);
        l
    }

    #[test]
    fn command_ids_carry_their_send_time() {
        let id = command_id(NOW);
        assert_eq!(request_timestamp(&id), Some(NOW));
        assert_eq!(
            request_timestamp("pc-0123456789ab.000000000000zdeadbeef"),
            Some(35)
        );
        for bad in [
            "x",
            "m-0123456789ab.short",
            "q-0123456789ab.0000000000001deadbeef",
            "m-0123456789AB.0000000000001deadbeef",
        ] {
            assert_eq!(request_timestamp(bad), None, "{bad}");
        }
        assert!(request_id_ok(&id));
        assert!(!request_id_ok(".x"));
        assert!(!request_id_ok(&"a".repeat(129)));
        assert!(!request_id_ok("a b"));
    }

    #[test]
    fn a_recorded_request_replays_and_a_rejection_sticks() {
        let mut l = fresh();
        let Gate::New(r) = l.admit("req-1", NOW).unwrap() else {
            panic!()
        };
        assert!(l.record_run(&r, snapshot("run-1", "queued"), NOW));
        l.release(&r);
        // 用过的名额不能再写。
        assert!(!l.record_run(&r, snapshot("run-2", "queued"), NOW));
        let Gate::Replay(e) = l.admit("req-1", NOW).unwrap() else {
            panic!()
        };
        assert_eq!(e.outcome, Outcome::Run(snapshot("run-1", "queued")));
        let Gate::New(r2) = l.admit("req-2", NOW).unwrap() else {
            panic!()
        };
        l.record_rejection(
            &r2,
            &DispatchError::new(Code::DISPATCH_DISABLED, "关着"),
            NOW,
        );
        let Gate::Replay(e) = l.admit("req-2", NOW).unwrap() else {
            panic!()
        };
        assert_eq!(
            e.outcome,
            Outcome::Rejected {
                code: Code::DISPATCH_DISABLED,
                message: "关着".into()
            }
        );
        let c = l.take_changes();
        assert_eq!(
            c.upsert,
            BTreeSet::from(["req-1".to_owned(), "req-2".to_owned()])
        );
    }

    #[test]
    fn entries_expire_after_nine_days_and_the_limit_refuses_instead_of_evicting() {
        let mut l = fresh();
        let Gate::New(r) = l.admit("old", NOW).unwrap() else {
            panic!()
        };
        l.record_run(&r, snapshot("run-old", "succeeded"), NOW);
        assert!(l.find("old", NOW + REQUEST_RETENTION_MS).is_some());
        assert!(l.find("old", NOW + REQUEST_RETENTION_MS + 1).is_none());
        assert!(l.take_changes().delete.contains("old"));
        let mut held = Vec::new();
        for i in 0..REQUEST_LIMIT {
            let Gate::New(r) = l.admit(&format!("r{i}"), NOW).unwrap() else {
                panic!()
            };
            held.push(r);
        }
        let e = l.admit("one-more", NOW).err().unwrap();
        assert_eq!(e.code, Code::DISPATCH_TOO_MANY_REQUESTS);
        l.release(&held.pop().unwrap());
        assert!(matches!(l.admit("one-more", NOW), Ok(Gate::New(_))));
    }

    #[test]
    fn a_bad_row_sets_a_watermark_and_older_unknown_commands_are_refused() {
        let good = Entry {
            id: "kept".into(),
            at: iso(NOW),
            outcome: Outcome::Run(snapshot("run-k", "succeeded")),
        };
        let bad = RawEntry {
            id: "bad".into(),
            at: iso(NOW),
            run_snapshot_json: Some("[1]".into()),
            rejected_code: None,
            rejected_message: None,
        };
        let unknown_code = RawEntry {
            rejected_code: Some("NOPE".into()),
            rejected_message: Some("x".into()),
            run_snapshot_json: None,
            ..bad.clone()
        };
        let mut l = Ledger::unavailable();
        l.reload(
            Loaded::Ok(vec![good.to_raw(), bad, unknown_code], None),
            &[],
            NOW,
            &Quiet,
        );
        assert_eq!(l.lost_before(), Some(NOW));
        let c = l.take_changes();
        assert!(c.watermark && c.delete.contains("bad"));
        assert!(matches!(l.admit("kept", NOW + 1), Ok(Gate::Replay(_))));
        let before = l.admit(&command_id(NOW - 1), NOW + 1).err().unwrap();
        assert_eq!(before.code, Code::DISPATCH_REQUEST_STATE_LOST);
        assert!(!before.retryable());
        assert_eq!(
            l.admit("not-a-command", NOW + 1).err().unwrap().code,
            Code::DISPATCH_REQUEST_STATE_LOST
        );
        assert!(matches!(
            l.admit(&command_id(NOW + 1), NOW + 2),
            Ok(Gate::New(_))
        ));
        // 水位线保留期满后清除。
        let (lost, until, unavailable) = l.status(NOW);
        assert_eq!(lost, Some(iso(NOW)));
        assert_eq!(until, Some(iso(NOW + REQUEST_RETENTION_MS)));
        assert!(!unavailable);
        assert_eq!(l.status(NOW + REQUEST_RETENTION_MS + 1).0, None);
        assert!(l.take_changes().watermark);
    }

    #[test]
    fn an_unreadable_ledger_refuses_with_503_until_it_reads() {
        let mut l = Ledger::unavailable();
        l.reload(Loaded::Unavailable("disk".into()), &[], NOW, &Quiet);
        let e = l.admit("x", NOW).err().unwrap();
        assert_eq!(e.code, Code::DISPATCH_LEDGER_UNAVAILABLE);
        assert!(e.retryable());
        assert!(l.status(NOW).2);
        // 历史里带 requestId 的派单补回成精确条目。
        l.reload(
            Loaded::Ok(Vec::new(), None),
            &[("req-h".into(), iso(NOW), snapshot("run-h", "running"))],
            NOW,
            &Quiet,
        );
        assert!(matches!(l.admit("req-h", NOW), Ok(Gate::Replay(_))));
        assert!(l.take_changes().upsert.contains("req-h"));
    }

    #[test]
    fn snapshots_follow_the_history_and_vanished_active_runs_fail() {
        let mut l = fresh();
        for (id, run) in [("a", "run-a"), ("b", "run-b")] {
            let Gate::New(r) = l.admit(id, NOW).unwrap() else {
                panic!()
            };
            l.record_run(&r, snapshot(run, "running"), NOW);
        }
        l.take_changes();
        let mut now = HashMap::new();
        now.insert("run-a".to_owned(), snapshot("run-a", "succeeded"));
        l.sync(&now);
        let Outcome::Run(a) = &l.entry("a").unwrap().outcome else {
            panic!()
        };
        assert_eq!(a["state"], "succeeded");
        let Outcome::Run(b) = &l.entry("b").unwrap().outcome else {
            panic!()
        };
        assert_eq!(b["state"], "failed");
        assert_eq!(
            b["error"],
            "这次派单已不在派单历史里（宿主可能在写盘途中退出）"
        );
        assert_eq!(l.take_changes().upsert.len(), 2);
        l.sync(&now);
        assert!(l.take_changes().is_empty());
    }
}
