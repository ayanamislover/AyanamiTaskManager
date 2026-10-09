//! job `metrics.capture`（W5h2；03 §2.4；2.x `engineering-metrics-observer.ts`）：任务操作提交之后的工程指标采集。
//!
//! 服务在 claim / start / complete / cancel、`verify_and_complete`、atm_end 释放之后把信号交给这里登记的去处；
//! 这个线程逐个处理（2.x「后台补扫一次只跑一个」：一批状态变更可能一次登记几十个任务，每次扫描又要开好几个
//! git 子进程）。任务操作的应答不等它；采集失败也从不回滚已经提交的操作。

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::thread::JoinHandle;

use atm_domain::principal::{JobId, Principal};
use atm_service::metrics::{CaptureReport, Signal};
use atm_service::write::Service;

enum Msg {
    Signal(Signal),
    Stop,
}

/// 处理一个信号（以 job `metrics.capture` 的身份）。
pub fn capture_once(svc: &Service, signal: &Signal) -> Result<CaptureReport, String> {
    svc.metrics_capture(&Principal::system_job(JobId::MetricsCapture), signal)
        .map_err(|e| e.to_string())
}

pub struct MetricsCapture {
    svc: Arc<Service>,
    tx: mpsc::Sender<Msg>,
    stopped: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

fn run(svc: &Service, rx: &Receiver<Msg>, stopped: &AtomicBool) {
    while let Ok(Msg::Signal(signal)) = rx.recv() {
        if stopped.load(Ordering::SeqCst) {
            return;
        }
        match capture_once(svc, &signal) {
            Ok(report) if !report.errors.is_empty() => {
                eprintln!("atm-runtime: metrics.capture: {}", report.errors.join("; "));
            }
            Ok(_) => {}
            Err(e) => eprintln!("atm-runtime: metrics.capture failed: {e}"),
        }
    }
}

impl MetricsCapture {
    /// 起采集线程并把去处登记到服务上。
    pub fn start(svc: Arc<Service>) -> MetricsCapture {
        let (tx, rx) = mpsc::channel::<Msg>();
        let stopped = Arc::new(AtomicBool::new(false));
        let thread = {
            let (svc, stopped) = (svc.clone(), stopped.clone());
            std::thread::Builder::new()
                .name("atm-metrics".into())
                .spawn(move || run(&svc, &rx, &stopped))
                .expect("spawn the metrics thread")
        };
        let sink = tx.clone();
        svc.set_metrics_sink(Some(Arc::new(move |signal| {
            let _ = sink.send(Msg::Signal(signal));
        })));
        MetricsCapture {
            svc,
            tx,
            stopped,
            thread,
        }
    }

    /// 撤下去处，等正在做的那一次结束；排着的不再做（下一次任务操作或刷新会补上）。
    pub fn stop(self) {
        self.svc.set_metrics_sink(None);
        self.stopped.store(true, Ordering::SeqCst);
        let _ = self.tx.send(Msg::Stop);
        let _ = self.thread.join();
    }
}
