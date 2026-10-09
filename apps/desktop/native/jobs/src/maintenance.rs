//! job `maintenance`（W5h；03 §2.4，2.x `core-main.ts:338-340`）：入口开放后 2.5 s 跑第一轮，之后每小时一轮。
//! 一轮做什么见 [`atm_service::maintenance`]；同一时刻只有这一个线程在跑，自然是单飞。

use std::sync::Arc;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use atm_domain::principal::{JobId, Principal};
use atm_domain::time::Timestamp;
use atm_service::maintenance::MaintenanceReport;
use atm_service::write::Service;

/// 第一轮在开放后多久跑。
pub const FIRST_RUN: Duration = Duration::from_millis(2500);
/// 之后每轮的间隔。
pub const EVERY: Duration = Duration::from_secs(60 * 60);

fn now() -> Timestamp {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    Timestamp::from_millis(i64::try_from(ms).unwrap_or(i64::MAX))
}

/// 跑一轮（以 job `maintenance` 的身份）。
pub fn run_once(svc: &Service, at: Timestamp) -> Result<MaintenanceReport, String> {
    svc.run_maintenance(&Principal::system_job(JobId::Maintenance), at)
        .map_err(|e| e.to_string())
}

pub struct Maintenance {
    stop: mpsc::Sender<()>,
    thread: JoinHandle<()>,
}

impl Maintenance {
    /// 过 `first` 跑第一轮，之后每 `every` 一轮。
    pub fn start(svc: Arc<Service>, first: Duration, every: Duration) -> Maintenance {
        let (stop, stopped) = mpsc::channel::<()>();
        let thread = std::thread::Builder::new()
            .name("atm-maintenance".into())
            .spawn(move || {
                let mut wait = first;
                loop {
                    match stopped.recv_timeout(wait) {
                        Err(RecvTimeoutError::Timeout) => {}
                        _ => return,
                    }
                    match run_once(&svc, now()) {
                        Ok(report) if !report.errors.is_empty() => {
                            eprintln!("atm-runtime: maintenance: {}", report.errors.join("; "));
                        }
                        Ok(_) => {}
                        Err(e) => eprintln!("atm-runtime: maintenance failed: {e}"),
                    }
                    wait = every;
                }
            })
            .expect("spawn the maintenance thread");
        Maintenance { stop, thread }
    }

    /// 停下并等正在跑的那一轮结束。
    pub fn stop(self) {
        let _ = self.stop.send(());
        let _ = self.thread.join();
    }
}
