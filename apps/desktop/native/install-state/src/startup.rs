//! ATM 3 的新根 `N` 与 setup 之间的交接（07 §8）：启动进度协议、setup 的等待判定、按持久阶段回滚。
//!
//! 写进度的是新进程（转换循环每处理一批写一次 `N\runtime\startup-progress.json`），
//! 读进度并判定的是 setup。两边共用这里的格式与规则，免得各写一份、慢慢对不上。
//!
//! - 进度只说明「还在干活」，**永远不是健康证明**：健康只认 SERVICE_HEALTHY 见证。
//! - setup 只接受与本次 txn、本次进程身份（pid + 创建时间）一致的进度；旧进程、旧事务留下的一律不算。
//! - 失败、取消或超时后，setup 先确认新进程已退出并放掉了 `N` 的准入，再按实际持久阶段处理：
//!   还没到 PUBLISHED 回滚时不写 `A`；已经 PUBLISHED 就先写 `A=legacy by setup-rollback`，再切回 2.x。

use crate::ProcessIdentity;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// `%LOCALAPPDATA%` 下新根的目录名（07 §1）。
pub const V3_DIR_NAME: &str = "AyanamiTaskManager3";
pub const PROGRESS_FILE: &str = "startup-progress.json";
/// 进入数据源冲突（07 §7）的新进程写的阶段：它在等用户在窗口里选数据来源，不是卡住。
/// setup 这时不按「多久没动」判卡住，只按总上限等（用户可能不在机器前）。
pub const AWAITING_USER: &str = "SOURCE_CONFLICT";
const MANIFEST: &str = "conversion.json";
const AUTHORITY: &str = "authority.json";
/// `N\runtime\startup-state.json`：数据源冲突的启动状态（07 §7，由 3.x 写）。
const STARTUP_STATE: &str = "startup-state.json";
/// 这几个文件都很小；大得离谱就是坏了。
const MAX_BYTES: u64 = 4 * 1024 * 1024;

/// 新根 `N`：`ATM3_DATA_DIR` 覆盖（演练、测试），否则 `%LOCALAPPDATA%\AyanamiTaskManager3`。
pub fn v3_root() -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os("ATM3_DATA_DIR").filter(|value| !value.is_empty()) {
        return std::path::absolute(PathBuf::from(value)).map_err(|error| error.to_string());
    }
    let local = std::env::var_os("LOCALAPPDATA").ok_or("ATM_DATA_DIRECTORY_UNAVAILABLE")?;
    Ok(PathBuf::from(local).join(V3_DIR_NAME))
}

/// `3.0.0`、`3.1.2-beta` 这类版本带转换状态机（主版本号 ≥ 3）。`legacy:1.x`、`2.0.0` 不是。
pub fn is_v3(version: &str) -> bool {
    version
        .split(['.', '-', '+'])
        .next()
        .and_then(|major| major.parse::<u32>().ok())
        .is_some_and(|major| major >= 3)
}

fn runtime(n: &Path) -> PathBuf {
    n.join("runtime")
}

pub fn progress_path(n: &Path) -> PathBuf {
    runtime(n).join(PROGRESS_FILE)
}

/// `{done, total, work}`：`done / total` 给人看；`work` 是转换做完的有界工作批次数，单调递增，
/// 只随真实的工作增加（见 `atm_store::progress`）。旧文件没有 `work` 时按 0 读。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Counter {
    pub done: u64,
    pub total: u64,
    #[serde(default)]
    pub work: u64,
}

/// `N\runtime\startup-progress.json`（07 §8）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartupProgress {
    pub txn: String,
    pub pid: u32,
    /// 进程创建时间，Unix 毫秒（与 [`ProcessIdentity::started_at_ms`] 同一口径）。
    pub process_created_at: u64,
    pub generation: Option<String>,
    /// `SNAPSHOT`、`IMPORT`、`VERIFY`、`PUBLISHING`、`PUBLISHED`、`COMPARE`，以及 [`AWAITING_USER`]。
    pub phase: String,
    pub progress: Counter,
    /// Unix 毫秒。只给人看，判定不用（判定只看 phase / done / total 有没有动）。
    pub updated_at: u64,
}

/// 进度与 `A` 都按共用的持久化契约写（[`crate::durable`]；W3 peer r1 P2-04）。
fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    crate::durable::write_atomic(path, bytes)
}

/// 新进程写进度。写不成功调用方可以忽略：进度只是让 setup 多等一会儿的依据。
pub fn write_progress(n: &Path, progress: &StartupProgress) -> io::Result<()> {
    let bytes = serde_json::to_vec(progress).map_err(io::Error::other)?;
    write_atomic(&progress_path(n), &bytes)
}

fn read_small(path: &Path) -> Option<Vec<u8>> {
    let metadata = fs::metadata(path).ok()?;
    (metadata.len() <= MAX_BYTES)
        .then(|| fs::read(path).ok())
        .flatten()
}

/// 读不到、坏了都是 `None`：没有可接受的进度。
pub fn read_progress(n: &Path) -> Option<StartupProgress> {
    serde_json::from_slice(&read_small(&progress_path(n))?).ok()
}

/// setup 的等待预算（07 §8）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WaitPolicy {
    /// 一条可接受的进度都还没有时，等多久就算启动失败（原来固定的 60 s，不转换的启动照旧）。
    pub first_progress: Duration,
    /// 有过进度之后，多久没动就判为卡住。
    pub stall: Duration,
    /// 总上限。
    pub cap: Duration,
}

impl Default for WaitPolicy {
    fn default() -> WaitPolicy {
        WaitPolicy {
            first_progress: Duration::from_secs(60),
            stall: Duration::from_secs(10 * 60),
            cap: Duration::from_secs(2 * 60 * 60),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WaitVerdict {
    /// 见证 SERVICE_HEALTHY 成立。只有这一种是成功。
    Healthy,
    /// 继续等。
    Waiting,
    /// 有过进度，但 `stall` 内没动：判为卡住。setup 确认进程退出后回滚。
    Stuck(String),
    /// 新进程没了。
    Dead,
    /// 没等到第一条进度，或者到了总上限。
    TimedOut(String),
}

/// setup 等一个 START 的过程。setup 重启后接管等待时，用日志里记下的同一个 txn 与进程身份重建它：
/// 那个进程写的进度照样接受，其他 txn、其他进程（含同一个 pid 被复用）的一律不算（F18）。
#[derive(Debug, Clone)]
pub struct ProgressWatch {
    txn: String,
    identity: ProcessIdentity,
    policy: WaitPolicy,
    started: Instant,
    last: Option<(String, u64, u64, u64)>,
    /// `last` 是哪个 generation 的：重转（Reconvert、Restart）换了 generation 从头报，同样的数字也是新的推进。
    last_generation: Option<String>,
    changed_at: Instant,
}

/// 一次 START 等待的预算记账，setup 落盘（txn 目录下）。setup 重启后接管同一个进程的等待时按它续算：
/// 总上限、首条进度期限与「多久没动」都从这个进程被拉起时算起，不因为重建 [`ProgressWatch`] 而重来
/// （W3 peer r1 P2-02）。时间用墙钟毫秒，只有落盘与续算时才与 `Instant` 互换。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WaitLedger {
    pub txn: String,
    pub pid: u32,
    pub process_created_at: u64,
    /// 等待开始（墙钟毫秒）。
    pub started_ms: u64,
    /// 进度最后一次推进（墙钟毫秒）。
    pub changed_ms: u64,
    /// 最后看到的 (phase, done, total, work)。
    pub last: Option<(String, u64, u64, u64)>,
    /// `last` 所属的 generation。旧记账没有这一项时按没有读。
    #[serde(default)]
    pub last_generation: Option<String>,
}

impl ProgressWatch {
    pub fn new(
        txn: &str,
        identity: &ProcessIdentity,
        policy: WaitPolicy,
        now: Instant,
    ) -> ProgressWatch {
        ProgressWatch {
            txn: txn.to_string(),
            identity: identity.clone(),
            policy,
            started: now,
            last: None,
            last_generation: None,
            changed_at: now,
        }
    }

    /// 接管等待：`ledger` 是同一 txn、同一进程（pid + 创建时间）记下的，就按它续算。
    /// 没有可信的 ledger（缺失、损坏、首次落盘之前中断、对不上本次进程）时，总预算从被等进程的创建时间算起：
    /// 这个进程就是本次 START 拉起的，它的创建时间不晚于等待开始；不从接管时刻重新给满预算（W4i peer r1 P2-01）。
    /// 无推进的窗口这时从接管时刻算（之前的推进时刻不知道）。
    /// 墙钟往回拨时按「还没过去」算（只会多等，不会提前判死）。
    pub fn resume(
        txn: &str,
        identity: &ProcessIdentity,
        policy: WaitPolicy,
        ledger: Option<&WaitLedger>,
        now: Instant,
        now_ms: u64,
    ) -> ProgressWatch {
        let mut watch = ProgressWatch::new(txn, identity, policy, now);
        let back = |ms: u64| {
            now.checked_sub(Duration::from_millis(now_ms.saturating_sub(ms)))
                .unwrap_or(now)
        };
        let Some(ledger) = ledger.filter(|l| {
            l.txn == txn && l.pid == identity.pid && l.process_created_at == identity.started_at_ms
        }) else {
            watch.started = back(identity.started_at_ms);
            return watch;
        };
        watch.started = back(ledger.started_ms);
        watch.changed_at = back(ledger.changed_ms.max(ledger.started_ms));
        watch.last = ledger.last.clone();
        watch.last_generation = ledger.last_generation.clone();
        watch
    }

    /// 现在的记账，供落盘。
    pub fn ledger(&self, now: Instant, now_ms: u64) -> WaitLedger {
        let at =
            |t: Instant| now_ms.saturating_sub(now.saturating_duration_since(t).as_millis() as u64);
        WaitLedger {
            txn: self.txn.clone(),
            pid: self.identity.pid,
            process_created_at: self.identity.started_at_ms,
            started_ms: at(self.started),
            changed_ms: at(self.changed_at),
            last: self.last.clone(),
            last_generation: self.last_generation.clone(),
        }
    }

    /// 这条进度是不是本次 txn、本次进程写的。
    pub fn accepts(&self, progress: &StartupProgress) -> bool {
        progress.txn == self.txn
            && progress.pid == self.identity.pid
            && progress.process_created_at == self.identity.started_at_ms
    }

    /// 看一眼：`healthy` 是见证的结论，`alive` 是进程还在不在，`progress` 是刚读到的进度文件。
    pub fn observe(
        &mut self,
        now: Instant,
        healthy: bool,
        alive: bool,
        progress: Option<&StartupProgress>,
    ) -> WaitVerdict {
        if healthy {
            return WaitVerdict::Healthy;
        }
        if !alive {
            return WaitVerdict::Dead;
        }
        if let Some(p) = progress.filter(|p| self.accepts(p)) {
            // 四项里任何一项变了都算推进：一个大项目的 IMPORT 里 done / total 长时间不变，work 在涨（W3 peer r1 P2-03）。
            // 换了 generation 也算：重转从头报，数字可能和上一代停下时一样。
            let key = (
                p.phase.clone(),
                p.progress.done,
                p.progress.total,
                p.progress.work,
            );
            if self.last.as_ref() != Some(&key) || self.last_generation != p.generation {
                self.last = Some(key);
                self.last_generation = p.generation.clone();
                self.changed_at = now;
            }
        }
        let waited = now.saturating_duration_since(self.started);
        let awaiting_user = self
            .last
            .as_ref()
            .is_some_and(|(phase, ..)| phase == AWAITING_USER);
        if waited >= self.policy.cap {
            return WaitVerdict::TimedOut(if awaiting_user {
                format!(
                    "the data source was not chosen within {} min",
                    self.policy.cap.as_secs() / 60
                )
            } else {
                format!(
                    "still not healthy after {} min",
                    self.policy.cap.as_secs() / 60
                )
            });
        }
        if awaiting_user {
            return WaitVerdict::Waiting;
        }
        match &self.last {
            None if waited >= self.policy.first_progress => WaitVerdict::TimedOut(format!(
                "no startup progress within {} s",
                self.policy.first_progress.as_secs()
            )),
            None => WaitVerdict::Waiting,
            Some((phase, done, total, _))
                if now.saturating_duration_since(self.changed_at) >= self.policy.stall =>
            {
                WaitVerdict::Stuck(format!(
                    "{phase} {done}/{total} has not moved for {} min",
                    self.policy.stall.as_secs() / 60
                ))
            }
            Some(_) => WaitVerdict::Waiting,
        }
    }
}

/// `N` 里转换实际走到了哪一步（读 `M`；不打开任何库）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DurablePhase {
    /// 没有 `M`：没开始转换，或 `N` 不存在。
    None,
    /// `M` 在，但还没到 PUBLISHED（SNAPSHOT / IMPORT / VERIFY / PUBLISHING / FAILED）。
    Unpublished(String),
    Published {
        generation: String,
    },
    /// `M` 读不出或形状不对。下次启动按 S5 隔离，与 `A` 无关。
    Unreadable,
}

pub fn durable_phase(n: &Path) -> DurablePhase {
    let path = n.join(MANIFEST);
    match fs::metadata(&path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return DurablePhase::None,
        Err(_) => return DurablePhase::Unreadable,
        Ok(_) => {}
    }
    let Some(manifest) =
        read_small(&path).and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
    else {
        return DurablePhase::Unreadable;
    };
    let text = |key: &str| {
        manifest
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::to_string)
    };
    match (text("phase"), text("generation")) {
        (Some(phase), Some(generation)) if phase == "PUBLISHED" => {
            DurablePhase::Published { generation }
        }
        (Some(phase), Some(_)) => DurablePhase::Unpublished(phase),
        _ => DurablePhase::Unreadable,
    }
}

/// 新进程放掉了 `N` 的准入（`N\runtime\service.lock` 没人持有）。锁文件不存在也算放掉了。
pub fn admission_released(n: &Path) -> bool {
    let path = runtime(n).join("service.lock");
    match fs::OpenOptions::new().read(true).write(true).open(&path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => true,
        Err(_) => false,
        Ok(file) => file.try_lock().is_ok(),
    }
}

/// 进程结束之后，系统释放它持有的文件锁是异步的（`LockFileEx` 的文档如此），刚确认进程退出时锁可能还在。
/// 写 `A` 之前给它这么久放掉准入（W4i 的真实进程用例里实测到过）。
pub const ADMISSION_GRACE: Duration = Duration::from_secs(10);

/// 在 `timeout` 内等 [`admission_released`] 成立。
pub fn await_admission_released(n: &Path, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if admission_released(n) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// [`settle_for_rollback`] 做了什么。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RollbackAuthority {
    /// 不写 `A`（还没发布、没转换过，或 `M` 读不出），附原因。
    NotWritten(String),
    /// 写了 `A=legacy by setup-rollback`，绑定这个 generation。
    Written { generation: String },
}

/// Unix 毫秒 → `2026-10-07T01:02:03.004Z`（与 `toISOString` 同形）。
pub fn iso_utc(ms: u64) -> String {
    let (secs, millis) = (ms / 1000, ms % 1000);
    let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
    // Howard Hinnant 的 civil_from_days。
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// 07 §8：setup 回滚到 2.x、切换版本目录之前调用。
///
/// 1. 新进程必须已经放掉 `N` 的准入（给 [`ADMISSION_GRACE`] 等系统释放锁），否则拒绝（它可能还在写 `M`）。
/// 2. 按 `M` 的实际阶段：没到 PUBLISHED（或没转换过）不写 `A`；PUBLISHED 了写
///    `A={authority: legacy, by: setup-rollback, txn, at, generation}`，并带上原来 `A` 里同一个 generation
///    下用户接受过的摘要——否则回滚后没动过 2.x 也会被当成「变了」而重转（07 §6，W3e）。
///
/// 可以重复调用：同一个 txn 再写一次结果相同。
pub fn settle_for_rollback(n: &Path, txn: &str, at_ms: u64) -> Result<RollbackAuthority, String> {
    if !await_admission_released(n, ADMISSION_GRACE) {
        return Err(
            "V3_STILL_ADMITTED: the new process still holds N\\runtime\\service.lock".into(),
        );
    }
    let generation = match durable_phase(n) {
        DurablePhase::None => {
            return Ok(RollbackAuthority::NotWritten("no conversion in N".into()));
        }
        DurablePhase::Unpublished(phase) => {
            return Ok(RollbackAuthority::NotWritten(format!(
                "the conversion stopped at {phase}"
            )));
        }
        DurablePhase::Unreadable => {
            return Ok(RollbackAuthority::NotWritten(
                "the manifest is unreadable; the next start quarantines the publication".into(),
            ));
        }
        DurablePhase::Published { generation } => generation,
    };
    let previous: Option<serde_json::Value> =
        read_small(&n.join(AUTHORITY)).and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let accepted = previous
        .as_ref()
        .filter(|a| a.get("generation").and_then(|g| g.as_str()) == Some(generation.as_str()))
        .and_then(|a| a.get("accepted_source_digest"))
        .filter(|d| d.is_object())
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let record = serde_json::json!({
        "authority": "legacy",
        "by": "setup-rollback",
        "txn": txn,
        "at": iso_utc(at_ms),
        "generation": generation,
        "accepted_source_digest": accepted,
    });
    let bytes = serde_json::to_vec(&record).map_err(|error| error.to_string())?;
    write_atomic(&n.join(AUTHORITY), &bytes)
        .map_err(|error| format!("AUTHORITY_WRITE: {error}"))?;
    // 回到 2.x 就是以 2.x 为准：之前那次数据源冲突（等用户在 3.0 里选）随之了结。留着它，再升级时
    // 3.0 会直接再问一次，而不是按 `A=legacy` 正常判定（没动过就接回、动过就重转、比较不了才再问）。
    match fs::remove_file(runtime(n).join(STARTUP_STATE)) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => {
            return Err(format!("STARTUP_STATE_CLEAR: {error}"));
        }
        _ => {}
    }
    Ok(RollbackAuthority::Written { generation })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("target")
            .join("install-state-tests")
            .join(name);
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn me() -> ProcessIdentity {
        ProcessIdentity {
            pid: 4242,
            started_at_ms: 1_790_000_000_000,
            image: r"C:\app-3.0.0\AyanamiTaskManager.exe".into(),
        }
    }

    fn progress(txn: &str, who: &ProcessIdentity, phase: &str, done: u64) -> StartupProgress {
        StartupProgress {
            txn: txn.into(),
            pid: who.pid,
            process_created_at: who.started_at_ms,
            generation: Some("G1".into()),
            phase: phase.into(),
            progress: Counter {
                done,
                total: 10,
                work: 0,
            },
            updated_at: 0,
        }
    }

    const MIN: Duration = Duration::from_secs(60);

    /// W4i peer r1 P2-01：没有可信的记账（缺失、损坏、首次落盘之前中断、对不上本次进程）时，总预算从被等进程的
    /// 创建时间算起，不在接管时重新给满：3 h 前拉起、进度还在动的进程，接管后立刻到总上限。
    #[test]
    fn a_takeover_without_a_ledger_counts_from_the_host_creation() {
        let t = Instant::now();
        let policy = WaitPolicy::default();
        let who = me();
        let at = |d: Duration| who.started_at_ms + d.as_millis() as u64;
        let moving = progress("T3", &who, "IMPORT", 9);
        let foreign = WaitLedger {
            txn: "T9".into(),
            pid: who.pid,
            process_created_at: who.started_at_ms,
            started_ms: at(MIN * 179),
            changed_ms: at(MIN * 179),
            last: None,
            last_generation: None,
        };
        for ledger in [None, Some(&foreign)] {
            let mut old = ProgressWatch::resume("T3", &who, policy, ledger, t, at(MIN * 180));
            assert!(
                matches!(
                    old.observe(t, false, true, Some(&moving)),
                    WaitVerdict::TimedOut(_)
                ),
                "{ledger:?}"
            );
        }
        // 刚拉起 1 min 的进程：接管后照常等。
        let mut young = ProgressWatch::resume("T3", &who, policy, None, t, at(MIN));
        assert_eq!(
            young.observe(t, false, true, Some(&moving)),
            WaitVerdict::Waiting
        );
    }

    /// F15：进度一直在推进，过了 60 s、过了 1 h 也接着等；最后见证成立才算成功。
    #[test]
    fn progress_keeps_setup_waiting_past_the_old_60_seconds() {
        let t0 = Instant::now();
        let mut watch = ProgressWatch::new("T1", &me(), WaitPolicy::default(), t0);
        assert_eq!(watch.observe(t0, false, true, None), WaitVerdict::Waiting);
        for minute in 1..=100u64 {
            let p = progress("T1", &me(), "IMPORT", minute / 10);
            let now = t0 + MIN * minute as u32;
            assert_eq!(
                watch.observe(now, false, true, Some(&p)),
                WaitVerdict::Waiting,
                "minute {minute}"
            );
        }
        let done = progress("T1", &me(), "PUBLISHED", 10);
        assert_eq!(
            watch.observe(t0 + MIN * 101, true, true, Some(&done)),
            WaitVerdict::Healthy
        );
    }

    /// W3 peer r1 P2-03：setup 每秒看一次。首条进度在 60 s 之内到（哪怕是第 59 s）就接着等；
    /// 一直没有，第 60 s 判超时，不早也不晚。
    #[test]
    fn the_first_progress_has_until_the_first_budget_ends() {
        let t0 = Instant::now();
        let sec = Duration::from_secs(1);
        let mut late = ProgressWatch::new("T1", &me(), WaitPolicy::default(), t0);
        let mut never = ProgressWatch::new("T1", &me(), WaitPolicy::default(), t0);
        let first = progress("T1", &me(), "SNAPSHOT", 0);
        for s in 0..60u32 {
            let now = t0 + sec * s;
            let p = (s == 59).then_some(&first);
            assert_eq!(
                late.observe(now, false, true, p),
                WaitVerdict::Waiting,
                "{s} s"
            );
            assert_eq!(
                never.observe(now, false, true, None),
                WaitVerdict::Waiting,
                "{s} s"
            );
        }
        assert_eq!(
            late.observe(t0 + sec * 60, false, true, None),
            WaitVerdict::Waiting
        );
        assert!(matches!(
            never.observe(t0 + sec * 60, false, true, None),
            WaitVerdict::TimedOut(_)
        ));
    }

    /// W3 peer r1 P2-03：一个大项目的 IMPORT 里 done / total 长时间不变，只有工作量在涨：照样算推进。
    /// 工作量也不动了，10 min 后判卡住。
    #[test]
    fn work_alone_counts_as_movement() {
        let t0 = Instant::now();
        let mut watch = ProgressWatch::new("T1", &me(), WaitPolicy::default(), t0);
        let mut p = progress("T1", &me(), "IMPORT", 0);
        for k in 1..=12u32 {
            p.progress.work = u64::from(k);
            assert_eq!(
                watch.observe(t0 + MIN * (9 * k), false, true, Some(&p)),
                WaitVerdict::Waiting,
                "batch {k}"
            );
        }
        let last = t0 + MIN * (9 * 12);
        assert_eq!(
            watch.observe(last + MIN * 9, false, true, Some(&p)),
            WaitVerdict::Waiting
        );
        assert!(matches!(
            watch.observe(last + MIN * 10, false, true, Some(&p)),
            WaitVerdict::Stuck(_)
        ));
    }

    /// W8b（A5）：重转换了 generation 从头报，数字可能与上一代停下时一样；换了 generation 就是新的推进，
    /// 不能被当成「10 min 没动」。同一个 generation 里数字不动仍然判卡住。
    #[test]
    fn a_new_generation_counts_as_movement() {
        let t0 = Instant::now();
        let mut watch = ProgressWatch::new("T1", &me(), WaitPolicy::default(), t0);
        let first = progress("T1", &me(), "SNAPSHOT", 0);
        assert_eq!(
            watch.observe(t0, false, true, Some(&first)),
            WaitVerdict::Waiting
        );
        let again = StartupProgress {
            generation: Some("G2".into()),
            ..first.clone()
        };
        assert_eq!(
            watch.observe(t0 + MIN * 9, false, true, Some(&again)),
            WaitVerdict::Waiting
        );
        assert_eq!(
            watch.observe(t0 + MIN * 18, false, true, Some(&again)),
            WaitVerdict::Waiting
        );
        assert!(matches!(
            watch.observe(t0 + MIN * 19, false, true, Some(&again)),
            WaitVerdict::Stuck(_)
        ));
        // 记账带着 generation：接管后同一代同样的数字不算推进，另一代算。
        let ledger = watch.ledger(t0 + MIN * 9, 1_800_000_000_000);
        assert_eq!(ledger.last_generation.as_deref(), Some("G2"));
        let json = serde_json::to_value(&ledger).unwrap();
        assert_eq!(serde_json::from_value::<WaitLedger>(json).unwrap(), ledger);
        // 旧记账没有 last_generation：照样读得出。
        let mut old = serde_json::to_value(&ledger).unwrap();
        old.as_object_mut().unwrap().remove("last_generation");
        assert_eq!(
            serde_json::from_value::<WaitLedger>(old)
                .unwrap()
                .last_generation,
            None
        );
    }

    /// W8b：进入数据源冲突的进程写 [`AWAITING_USER`]：在等用户选，不按 10 min 判卡住；
    /// 总上限照样算，超时的说明写明是没选数据来源。
    #[test]
    fn a_source_conflict_waits_for_the_user_until_the_cap() {
        let t0 = Instant::now();
        let mut watch = ProgressWatch::new("T1", &me(), WaitPolicy::default(), t0);
        let compare = progress("T1", &me(), "COMPARE", 5);
        assert_eq!(
            watch.observe(t0, false, true, Some(&compare)),
            WaitVerdict::Waiting
        );
        let conflict = StartupProgress {
            phase: AWAITING_USER.into(),
            progress: Counter {
                done: 0,
                total: 0,
                work: 0,
            },
            ..compare.clone()
        };
        for minute in [1u32, 11, 60, 119] {
            assert_eq!(
                watch.observe(t0 + MIN * minute, false, true, Some(&conflict)),
                WaitVerdict::Waiting,
                "minute {minute}"
            );
        }
        match watch.observe(t0 + MIN * 120, false, true, Some(&conflict)) {
            WaitVerdict::TimedOut(why) => assert!(why.contains("not chosen"), "{why}"),
            other => panic!("{other:?}"),
        }
        // 用户选好了，服务开起来：见证成立就是健康。
        let mut chosen = ProgressWatch::new("T1", &me(), WaitPolicy::default(), t0);
        chosen.observe(t0, false, true, Some(&conflict));
        assert_eq!(
            chosen.observe(t0 + MIN * 30, true, true, Some(&conflict)),
            WaitVerdict::Healthy
        );
        // 冲突中的进程没了，照样立刻判死。
        assert_eq!(
            chosen.observe(t0 + MIN * 31, false, false, Some(&conflict)),
            WaitVerdict::Dead
        );
    }

    /// 进度不是健康证明：哪怕报了 PUBLISHED 10/10，见证不成立就只是在等，最后照样超时。
    #[test]
    fn progress_is_never_taken_for_health() {
        let t0 = Instant::now();
        let mut watch = ProgressWatch::new("T1", &me(), WaitPolicy::default(), t0);
        let done = progress("T1", &me(), "PUBLISHED", 10);
        assert_eq!(
            watch.observe(t0 + MIN, false, true, Some(&done)),
            WaitVerdict::Waiting
        );
        assert!(matches!(
            watch.observe(t0 + MIN * 11, false, true, Some(&done)),
            WaitVerdict::Stuck(_)
        ));
        let mut capped = ProgressWatch::new("T1", &me(), WaitPolicy::default(), t0);
        for minute in 1..=120u64 {
            let p = progress("T1", &me(), "IMPORT", minute);
            let v = capped.observe(t0 + MIN * minute as u32, false, true, Some(&p));
            if minute < 120 {
                assert_eq!(v, WaitVerdict::Waiting, "minute {minute}");
            } else {
                assert!(
                    matches!(v, WaitVerdict::TimedOut(ref why) if why.contains("120 min")),
                    "{v:?}"
                );
            }
        }
    }

    /// F16：有过进度，之后 10 min 没动（只刷新 updated_at 不算动）→ 卡住。没有任何进度的启动仍按 60 s 判失败。
    #[test]
    fn a_stalled_or_silent_start_is_given_up() {
        let t0 = Instant::now();
        let mut watch = ProgressWatch::new("T1", &me(), WaitPolicy::default(), t0);
        let mut p = progress("T1", &me(), "VERIFY", 3);
        assert_eq!(
            watch.observe(t0 + MIN, false, true, Some(&p)),
            WaitVerdict::Waiting
        );
        p.updated_at = 99;
        assert_eq!(
            watch.observe(t0 + MIN * 10, false, true, Some(&p)),
            WaitVerdict::Waiting
        );
        match watch.observe(t0 + MIN * 11, false, true, Some(&p)) {
            WaitVerdict::Stuck(why) => assert!(why.contains("VERIFY 3/10"), "{why}"),
            other => panic!("{other:?}"),
        }
        let mut silent = ProgressWatch::new("T1", &me(), WaitPolicy::default(), t0);
        assert_eq!(
            silent.observe(t0 + Duration::from_secs(59), false, true, None),
            WaitVerdict::Waiting
        );
        assert!(matches!(
            silent.observe(t0 + MIN, false, true, None),
            WaitVerdict::TimedOut(_)
        ));
    }

    /// F17：进程死了立刻判死，不管进度。
    #[test]
    fn a_dead_process_ends_the_wait() {
        let t0 = Instant::now();
        let mut watch = ProgressWatch::new("T1", &me(), WaitPolicy::default(), t0);
        let p = progress("T1", &me(), "IMPORT", 1);
        assert_eq!(
            watch.observe(t0 + MIN, false, false, Some(&p)),
            WaitVerdict::Dead
        );
    }

    /// F18：setup 重启后用同一个 txn 与进程身份接管：那个进程的进度照收；别的 txn、别的进程、
    /// 同一 pid 被复用（创建时间不同）的都不算，不能让 setup 一直等下去。
    #[test]
    fn a_takeover_accepts_only_this_txn_and_process() {
        let t0 = Instant::now();
        let mut watch = ProgressWatch::new("T2", &me(), WaitPolicy::default(), t0);
        let reused = ProcessIdentity {
            started_at_ms: me().started_at_ms + 1,
            ..me()
        };
        let other = ProcessIdentity { pid: 7, ..me() };
        for (i, stale) in [
            progress("T1", &me(), "IMPORT", 1),
            progress("T2", &reused, "IMPORT", 2),
            progress("T2", &other, "IMPORT", 3),
        ]
        .iter()
        .enumerate()
        {
            assert!(!watch.accepts(stale), "{i}");
            let now = t0 + Duration::from_secs(10 * (i as u64 + 1));
            assert_eq!(
                watch.observe(now, false, true, Some(stale)),
                WaitVerdict::Waiting
            );
        }
        assert!(matches!(
            watch.observe(t0 + MIN, false, true, None),
            WaitVerdict::TimedOut(_)
        ));
        let mut taken_over = ProgressWatch::new("T2", &me(), WaitPolicy::default(), t0);
        let mine = progress("T2", &me(), "IMPORT", 4);
        assert!(taken_over.accepts(&mine));
        assert_eq!(
            taken_over.observe(t0 + MIN * 5, false, true, Some(&mine)),
            WaitVerdict::Waiting
        );
    }

    /// W3 peer r1 P2-02：setup 重启后接管同一个进程，预算从那个进程的等待开始时算，不因重建 watch 重来。
    /// 墙钟毫秒 `base` 对应 `t0`。
    #[test]
    fn a_takeover_keeps_the_budget_of_the_same_process() {
        let t0 = Instant::now();
        let base = 1_800_000_000_000u64;
        let ms = |d: Duration| base + d.as_millis() as u64;
        let policy = WaitPolicy::default();
        let p = progress("T2", &me(), "VERIFY", 3);

        // 1 min 时有过一次进度，之后没动；第 9 min setup 被杀，记账已落盘。
        let mut first = ProgressWatch::new("T2", &me(), policy, t0);
        assert_eq!(
            first.observe(t0 + MIN, false, true, Some(&p)),
            WaitVerdict::Waiting
        );
        let ledger = first.ledger(t0 + MIN * 9, ms(MIN * 9));
        assert_eq!(ledger.started_ms, base);
        assert_eq!(ledger.changed_ms, ms(MIN));

        // 接管后再过 2 min：从最后一次推进算已经 11 min，判卡住。重新开始计时的话还在等。
        let t1 = t0 + MIN * 9;
        let mut resumed =
            ProgressWatch::resume("T2", &me(), policy, Some(&ledger), t1, ms(MIN * 9));
        match resumed.observe(t1 + MIN * 2, false, true, Some(&p)) {
            WaitVerdict::Stuck(why) => assert!(why.contains("VERIFY 3/10"), "{why}"),
            other => panic!("{other:?}"),
        }
        let mut fresh = ProgressWatch::new("T2", &me(), policy, t1);
        assert_eq!(
            fresh.observe(t1 + MIN * 2, false, true, Some(&p)),
            WaitVerdict::Waiting
        );

        // 总上限：119 min 前开始等，进度一直在动，接管 1 min 后到上限。
        let mut long = ledger.clone();
        long.started_ms = ms(MIN * 9) - 119 * 60_000;
        let mut capped = ProgressWatch::resume("T2", &me(), policy, Some(&long), t1, ms(MIN * 9));
        let moving = progress("T2", &me(), "IMPORT", 9);
        assert!(matches!(
            capped.observe(t1 + MIN, false, true, Some(&moving)),
            WaitVerdict::TimedOut(_)
        ));

        // 首条进度期限：50 s 前开始等、还没有进度，接管 10 s 后到期。
        let silent = WaitLedger {
            started_ms: ms(MIN * 9) - 50_000,
            changed_ms: ms(MIN * 9) - 50_000,
            last: None,
            ..ledger.clone()
        };
        let mut late = ProgressWatch::resume("T2", &me(), policy, Some(&silent), t1, ms(MIN * 9));
        assert!(matches!(
            late.observe(t1 + Duration::from_secs(10), false, true, None),
            WaitVerdict::TimedOut(_)
        ));

        // 别的进程（pid 复用）、别的 txn 的记账不算：里面 8 min 没推进的记录不作数，总预算从本进程的创建时间算
        // （W4i peer r1 P2-01）。本进程 1 min 前才创建，照常等。
        let young = ProcessIdentity {
            started_at_ms: ms(MIN * 8),
            ..me()
        };
        let moved = progress("T2", &young, "VERIFY", 3);
        for other in [
            WaitLedger {
                process_created_at: young.started_at_ms + 1,
                ..ledger.clone()
            },
            WaitLedger {
                txn: "T1".into(),
                process_created_at: young.started_at_ms,
                ..ledger.clone()
            },
        ] {
            let mut w = ProgressWatch::resume("T2", &young, policy, Some(&other), t1, ms(MIN * 9));
            assert_eq!(
                w.observe(t1 + MIN * 2, false, true, Some(&moved)),
                WaitVerdict::Waiting
            );
        }

        // 墙钟往回拨：按「还没过去」算，只会多等。
        let mut back = ProgressWatch::resume("T2", &me(), policy, Some(&ledger), t1, base - 1);
        assert_eq!(
            back.observe(t1 + MIN * 2, false, true, Some(&p)),
            WaitVerdict::Waiting
        );
    }

    #[test]
    fn progress_files_round_trip_and_damage_reads_as_none() {
        let n = dir("progress");
        assert_eq!(read_progress(&n), None);
        let p = progress("T1", &me(), "SNAPSHOT", 2);
        write_progress(&n, &p).unwrap();
        assert_eq!(read_progress(&n), Some(p));
        let text = fs::read_to_string(progress_path(&n)).unwrap();
        for key in [
            "\"txn\"",
            "\"pid\"",
            "\"process_created_at\"",
            "\"generation\"",
            "\"phase\"",
            "\"done\"",
            "\"total\"",
            "\"updated_at\"",
        ] {
            assert!(text.contains(key), "{key}: {text}");
        }
        fs::write(progress_path(&n), b"{").unwrap();
        assert_eq!(read_progress(&n), None);
    }

    fn manifest(n: &Path, phase: &str, generation: &str) {
        fs::write(
            n.join(MANIFEST),
            serde_json::json!({"schema": 1, "phase": phase, "generation": generation}).to_string(),
        )
        .unwrap();
    }

    /// 回滚前按持久阶段：没转换、没发布、`M` 坏了都不写 `A`；发布了写 `A=legacy`，带上同一个 generation
    /// 下接受过的摘要（别的 generation 的不带）；新进程还拿着准入就拒绝。
    #[test]
    fn rollback_writes_the_authority_only_after_publish() {
        let n = dir("rollback");
        assert!(matches!(
            settle_for_rollback(&n, "T1", 0),
            Ok(RollbackAuthority::NotWritten(_))
        ));
        manifest(&n, "VERIFY", "G1");
        assert_eq!(
            durable_phase(&n),
            DurablePhase::Unpublished("VERIFY".into())
        );
        assert!(
            matches!(settle_for_rollback(&n, "T1", 0), Ok(RollbackAuthority::NotWritten(ref w)) if w.contains("VERIFY"))
        );
        assert!(!n.join(AUTHORITY).exists());
        fs::write(n.join(MANIFEST), b"{").unwrap();
        assert_eq!(durable_phase(&n), DurablePhase::Unreadable);
        assert!(matches!(
            settle_for_rollback(&n, "T1", 0),
            Ok(RollbackAuthority::NotWritten(_))
        ));
        assert!(!n.join(AUTHORITY).exists());

        manifest(&n, "PUBLISHED", "G1");
        fs::write(
            n.join(AUTHORITY),
            serde_json::json!({"authority": "v3", "by": "user-choice", "txn": null, "at": "x",
                "generation": "G1", "accepted_source_digest": {"r/projects": "ab"}})
            .to_string(),
        )
        .unwrap();
        let lock = fs::create_dir_all(runtime(&n))
            .and_then(|()| fs::File::create(runtime(&n).join("service.lock")))
            .unwrap();
        lock.lock().unwrap();
        assert!(!admission_released(&n));
        assert!(
            settle_for_rollback(&n, "T1", 0)
                .unwrap_err()
                .starts_with("V3_STILL_ADMITTED")
        );
        drop(lock);
        assert!(admission_released(&n));
        // W8b：之前那次数据源冲突随回滚了结（以 2.x 为准）；写 `A` 之后清掉启动状态。
        fs::write(
            runtime(&n).join(STARTUP_STATE),
            br#"{"state":"SOURCE_CONFLICT","since":"x","generation":"G1","reason":"r"}"#,
        )
        .unwrap();
        // W3 peer r1 P2-04：`A` 走共用的持久化契约——刷盘后 MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)，
        // 是这次写入里唯一的一次改名。
        let (written, ops) =
            crate::durable::record(|| settle_for_rollback(&n, "T1", 1_790_000_000_004));
        assert_eq!(
            written.unwrap(),
            RollbackAuthority::Written {
                generation: "G1".into()
            }
        );
        assert!(
            matches!(&ops[..], [crate::durable::Op::Move { to, flags: 0x9, .. }] if *to == n.join(AUTHORITY)),
            "{ops:?}"
        );
        assert!(!runtime(&n).join(STARTUP_STATE).exists());
        let a: serde_json::Value =
            serde_json::from_slice(&fs::read(n.join(AUTHORITY)).unwrap()).unwrap();
        assert_eq!(a["authority"], "legacy");
        assert_eq!(a["by"], "setup-rollback");
        assert_eq!(a["txn"], "T1");
        assert_eq!(a["generation"], "G1");
        assert_eq!(a["at"], "2026-09-21T14:13:20.004Z");
        assert_eq!(a["accepted_source_digest"]["r/projects"], "ab");

        manifest(&n, "PUBLISHED", "G2");
        settle_for_rollback(&n, "T2", 0).unwrap();
        let a: serde_json::Value =
            serde_json::from_slice(&fs::read(n.join(AUTHORITY)).unwrap()).unwrap();
        assert_eq!(a["generation"], "G2");
        assert!(a["accepted_source_digest"].is_null(), "{a}");
    }

    #[test]
    fn only_major_3_and_later_carry_the_conversion() {
        for v3 in ["3.0.0", "3.1.2-beta.1", "10.0.0"] {
            assert!(is_v3(v3), "{v3}");
        }
        for not in ["2.0.0", "2.9.9", "legacy:1.4.0", "", "x.0.0"] {
            assert!(!is_v3(not), "{not}");
        }
    }

    #[test]
    fn iso_times_match_to_iso_string() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_utc(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(iso_utc(1_790_000_000_004), "2026-09-21T14:13:20.004Z");
    }
}
