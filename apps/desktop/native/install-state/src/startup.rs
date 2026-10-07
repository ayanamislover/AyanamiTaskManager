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
const MANIFEST: &str = "conversion.json";
const AUTHORITY: &str = "authority.json";
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

/// `{done, total}`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Counter {
    pub done: u64,
    pub total: u64,
}

/// `N\runtime\startup-progress.json`（07 §8）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartupProgress {
    pub txn: String,
    pub pid: u32,
    /// 进程创建时间，Unix 毫秒（与 [`ProcessIdentity::started_at_ms`] 同一口径）。
    pub process_created_at: u64,
    pub generation: Option<String>,
    /// `SNAPSHOT`、`IMPORT`、`VERIFY`、`PUBLISHING`、`PUBLISHED`。
    pub phase: String,
    pub progress: Counter,
    /// Unix 毫秒。只给人看，判定不用（判定只看 phase / done / total 有没有动）。
    pub updated_at: u64,
}

fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let temporary = path.with_file_name(format!("{name}.{}.tmp", std::process::id()));
    {
        let mut file = fs::File::create(&temporary)?;
        io::Write::write_all(&mut file, bytes)?;
        file.sync_all()?;
    }
    let result = fs::rename(&temporary, path);
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
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
    last: Option<(String, u64, u64)>,
    changed_at: Instant,
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
            changed_at: now,
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
            let key = (p.phase.clone(), p.progress.done, p.progress.total);
            if self.last.as_ref() != Some(&key) {
                self.last = Some(key);
                self.changed_at = now;
            }
        }
        let waited = now.saturating_duration_since(self.started);
        if waited >= self.policy.cap {
            return WaitVerdict::TimedOut(format!(
                "still not healthy after {} min",
                self.policy.cap.as_secs() / 60
            ));
        }
        match &self.last {
            None if waited >= self.policy.first_progress => WaitVerdict::TimedOut(format!(
                "no startup progress within {} s",
                self.policy.first_progress.as_secs()
            )),
            None => WaitVerdict::Waiting,
            Some((phase, done, total))
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
/// 1. 新进程必须已经放掉 `N` 的准入，否则拒绝（它可能还在写 `M`）。
/// 2. 按 `M` 的实际阶段：没到 PUBLISHED（或没转换过）不写 `A`；PUBLISHED 了写
///    `A={authority: legacy, by: setup-rollback, txn, at, generation}`，并带上原来 `A` 里同一个 generation
///    下用户接受过的摘要——否则回滚后没动过 2.x 也会被当成「变了」而重转（07 §6，W3e）。
///
/// 可以重复调用：同一个 txn 再写一次结果相同。
pub fn settle_for_rollback(n: &Path, txn: &str, at_ms: u64) -> Result<RollbackAuthority, String> {
    if !admission_released(n) {
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
        "accepted_unknown": null,
    });
    let bytes = serde_json::to_vec(&record).map_err(|error| error.to_string())?;
    write_atomic(&n.join(AUTHORITY), &bytes)
        .map_err(|error| format!("AUTHORITY_WRITE: {error}"))?;
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
            progress: Counter { done, total: 10 },
            updated_at: 0,
        }
    }

    const MIN: Duration = Duration::from_secs(60);

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
                "generation": "G1", "accepted_source_digest": {"r/projects": "ab"}, "accepted_unknown": null})
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
        assert_eq!(
            settle_for_rollback(&n, "T1", 1_790_000_000_004).unwrap(),
            RollbackAuthority::Written {
                generation: "G1".into()
            }
        );
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
