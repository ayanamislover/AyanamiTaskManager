//! 调度器（W4i 的最小集合）：每分钟按客户端存活扫一次过期 session（S-012、R11 P1-3）。
//! 只在入口开放之后起，数据源冲突时先于启动状态停下（由 `atm-runtime` 起停）。
//!
//! System 主体只在这个 crate 里构造（`domain/tests/principal_guard.rs`）。

pub mod liveness;
pub mod notify;
pub mod update;

use std::sync::Arc;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread::JoinHandle;
use std::time::Duration;

use atm_domain::principal::{JobId, Principal};
use atm_service::session::{SweepPolicy, SweepReport};
use atm_service::write::Service;

/// 扫一次。客户端是否存活按 [`crate::liveness::alive`]：活着的客户端只在 120 min 没心跳时才收，
/// 退出了的立刻收，没有身份的按普通超时。
pub fn sweep_once(svc: &Service) -> Result<SweepReport, String> {
    svc.sweep_sessions(
        &Principal::system_job(JobId::StartupRecover),
        SweepPolicy::default(),
        &crate::liveness::alive,
    )
    .map_err(|e| e.to_string())
}

pub struct Scheduler {
    stop: mpsc::Sender<()>,
    thread: JoinHandle<()>,
}

impl Scheduler {
    /// 立刻扫一次（启动恢复），之后每 `every` 一次。
    pub fn start(svc: Arc<Service>, every: Duration) -> Scheduler {
        let (stop, stopped) = mpsc::channel::<()>();
        let thread = std::thread::Builder::new()
            .name("atm-jobs".into())
            .spawn(move || {
                loop {
                    if let Err(e) = sweep_once(&svc) {
                        eprintln!("atm-runtime: sweep_sessions failed: {e}");
                    }
                    match stopped.recv_timeout(every) {
                        Err(RecvTimeoutError::Timeout) => continue,
                        _ => break,
                    }
                }
            })
            .expect("spawn the job thread");
        Scheduler { stop, thread }
    }

    /// 停下并等正在跑的那一轮结束：返回之后调度器不会再写任何东西。
    pub fn stop(self) {
        let _ = self.stop.send(());
        let _ = self.thread.join();
    }
}
