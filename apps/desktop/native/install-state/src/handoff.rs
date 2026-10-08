//! setup 等一个 START 的完整循环（07 §8），setup 与 3.x 运行时的端到端用例共用这一份（W4i，W3 peer r1 P2-02）：
//! 健康只认 SERVICE_HEALTHY 见证；进度只让等待继续；预算记账落盘，setup 重启后接管同一进程时续算。

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::ProcessIdentity;
use crate::procs;
use crate::service;
use crate::startup::{self, ProgressWatch, WaitLedger, WaitPolicy, WaitVerdict};

/// 记账文件的名字（在 txn 目录里）。
pub const LEDGER_FILE: &str = "start-wait.json";

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 被等的那个服务的运行目录：3.x 在新根 `N\runtime`（与 atm-mcp 桥读的是同一份 daemon.json），
/// 更早的版本在 2.x 数据根下。
pub fn runtime_dir_for(version: &str, legacy_runtime: &Path, v3_root: &Path) -> PathBuf {
    if startup::is_v3(version) {
        v3_root.join("runtime")
    } else {
        legacy_runtime.to_path_buf()
    }
}

/// 一次等待的全部输入。
pub struct Await<'a> {
    /// `<installRoot>\state\health`：见证所在。
    pub health_dir: &'a Path,
    /// 2.x 数据根的 `runtime`；3.x 由 [`runtime_dir_for`] 换成 `N\runtime`。
    pub legacy_runtime: &'a Path,
    /// 新根 `N`：进度文件所在。
    pub v3_root: &'a Path,
    /// 记账文件（[`LEDGER_FILE`]，在 txn 目录里）。
    pub ledger: &'a Path,
    pub txn: &'a str,
    pub version: &'a str,
    pub identity: &'a ProcessIdentity,
    pub policy: WaitPolicy,
    /// 两次查看之间睡多久（setup 用 250 ms）。
    pub poll: Duration,
}

fn read_ledger(path: &Path) -> Option<WaitLedger> {
    crate::read_json_limited(path, 64 * 1024).ok().flatten()
}

fn write_ledger(path: &Path, ledger: &WaitLedger) {
    // 写不下只是让接管时少一段已用的预算记录；等待本身照常。
    if let Ok(bytes) = serde_json::to_vec(ledger) {
        let _ = crate::durable::write_atomic(path, &bytes);
    }
}

/// 等到 SERVICE_HEALTHY，或者判定失败。`say` 收进度与结论，给日志。
///
/// 失败的形状：`START_HOST_EXITED`、`START_STUCK`、`START_TIMEOUT`，后面跟原因与最后一次健康核对没过的理由。
pub fn await_healthy(a: &Await<'_>, say: &mut dyn FnMut(String)) -> Result<(), String> {
    let runtime_dir = runtime_dir_for(a.version, a.legacy_runtime, a.v3_root);
    let mut watch = ProgressWatch::resume(
        a.txn,
        a.identity,
        a.policy,
        read_ledger(a.ledger).as_ref(),
        Instant::now(),
        now_ms(),
    );
    let mut saved = watch.ledger(Instant::now(), now_ms());
    write_ledger(a.ledger, &saved);
    let mut last = String::new();
    let mut reported = String::new();
    loop {
        let healthy = match service::service_healthy(
            a.health_dir,
            &runtime_dir,
            a.txn,
            a.version,
            a.identity,
            Instant::now() + Duration::from_secs(10),
        ) {
            Ok(()) => true,
            Err(error) => {
                last = error;
                false
            }
        };
        let progress = startup::read_progress(a.v3_root);
        if let Some(p) = progress.as_ref().filter(|p| watch.accepts(p)) {
            let now = format!("{} {}/{}", p.phase, p.progress.done, p.progress.total);
            if now != reported {
                say(format!("START {}: {now}", a.version));
                reported = now;
            }
        }
        let verdict = watch.observe(
            Instant::now(),
            healthy,
            procs::alive(a.identity),
            progress.as_ref(),
        );
        let ledger = watch.ledger(Instant::now(), now_ms());
        if ledger.last != saved.last {
            write_ledger(a.ledger, &ledger);
            saved = ledger;
        }
        match verdict {
            WaitVerdict::Healthy => {
                say(format!(
                    "START {} SERVICE_HEALTHY (host {})",
                    a.version, a.identity.pid
                ));
                return Ok(());
            }
            WaitVerdict::Waiting => std::thread::sleep(a.poll),
            WaitVerdict::Dead => return Err(format!("START_HOST_EXITED: {last}")),
            WaitVerdict::Stuck(why) => return Err(format!("START_STUCK: {why}; {last}")),
            WaitVerdict::TimedOut(why) => return Err(format!("START_TIMEOUT: {why}; {last}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 3.x 的 lease 与 daemon.json 在新根（与桥读的是同一份）；更早的版本在 2.x 数据根。
    #[test]
    fn a_3x_service_is_looked_up_under_the_new_root() {
        let (legacy, n) = (Path::new(r"C:\L\runtime"), Path::new(r"C:\N"));
        assert_eq!(runtime_dir_for("3.0.0", legacy, n), n.join("runtime"));
        assert_eq!(runtime_dir_for("3.1.0-beta", legacy, n), n.join("runtime"));
        assert_eq!(runtime_dir_for("2.0.0", legacy, n), legacy);
        assert_eq!(runtime_dir_for("legacy:1.4.0", legacy, n), legacy);
    }
}
