//! 进程内的 ATM 3 服务（W5a）：宿主链接 `atm-runtime`，在自己的工作线程上跑 [`atm_runtime::start`]，
//! 事件循环与托盘不等它（转换可能要几分钟）。不再拉起 Node core，宿主与服务之间也没有进程间的帧协议。
//!
//! - 开着的入口（[`Serving`]）与数据源冲突时的准入（[`Conflicted`]）都由宿主持有到退出；
//!   丢弃 `Serving` 走 runtime 的有序关闭：后台比较不再动手 → 撤入口 → 最后放准入。
//! - 文件归属：服务的一切在新根 `N`；宿主自己的日志、`host.json`、WebView2 数据也在 `N`（06 §8、05 §2 R 类）。
//!   旧根 `L` 只用它的路径给单实例互斥与管道起名（setup 的 QUIT、launcher 的 SHOW / WAKE 照旧找得到），不写任何文件。

use std::sync::Arc;
use std::sync::mpsc;
use std::time::Duration;

use atm_runtime::{Background, BootError, Event, Handoff, Options, Started};
use tao::event_loop::EventLoopProxy;

use crate::app::UserEvent;
use crate::paths::Layout;

/// 一次启动的结果，经事件循环交回宿主。
pub struct Booted(pub Result<Started, BootError>);

impl std::fmt::Debug for Booted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.0 {
            Ok(Started::Serving(s)) => write!(f, "Serving(127.0.0.1:{})", s.port()),
            Ok(Started::Conflict(c)) => write!(f, "Conflict({})", c.state.reason),
            Err(e) => write!(f, "Failed({e})"),
        }
    }
}

/// 启动参数。`L` 是宿主一直用的数据根（`ATM_DATA_DIR` 可覆盖），`N` 是 3.x 根（`ATM3_DATA_DIR` 可覆盖）。
/// 正式宿主允许转换真实的 2.x 根（conversion 的真实根保护只拦开发与演练入口）。
///
/// 托盘计数与通知经 `proxy` 交回事件循环（观察器在服务的线程上，toast 与托盘菜单在 UI 线程上做）。
pub fn options(
    layout: &Layout,
    version: &str,
    handoff: Option<Handoff>,
    proxy: EventLoopProxy<UserEvent>,
) -> Options {
    let log_root = layout.v3_root.clone();
    let observe: Arc<dyn Fn(Event) + Send + Sync> =
        Arc::new(move |e| crate::log(&log_root, &format!("runtime: {e:?}")));
    let legacy = layout.data_dir.clone();
    let quiesce_root = legacy.clone();
    Options {
        n: layout.v3_root.clone(),
        legacy,
        version: version.to_string(),
        handoff,
        quiesce: Box::new(move || atm_runtime::legacy_quiesce(&quiesce_root)),
        allow_real_data_root: true,
        real_data_root: None,
        secrets_check: Some(atm_runtime::secrets::check),
        sweep_every: Duration::from_secs(60),
        drill: atm_runtime::Drill::default(),
        observe,
        notify: Some(Arc::new(move |observation| {
            let _ = proxy.send_event(UserEvent::Observed(observation));
        })),
        maintenance: true,
        metrics_capture: true,
    }
}

/// 在工作线程上启动；结果带着 `attempt` 交回，过期的结果（宿主已经退出或重试过）由事件循环丢掉。
pub fn spawn(options: Options, attempt: u64, proxy: EventLoopProxy<UserEvent>) {
    let fallback = proxy.clone();
    let started = std::thread::Builder::new()
        .name("atm-boot".into())
        .spawn(move || {
            let result = atm_runtime::start(&options);
            let _ = proxy.send_event(UserEvent::Booted(attempt, Booted(result)));
        });
    if let Err(error) = started {
        // 线程都起不来：当作这次启动失败，交给重试的节流。
        let failed = BootError::Failed(format!("spawn the boot thread: {error}"));
        let _ = fallback.send_event(UserEvent::Booted(attempt, Booted(Err(failed))));
    }
}

/// 等后台比较的结论（入口开着、比较还在跑），交回事件循环。
pub fn watch_background(receiver: mpsc::Receiver<Background>, proxy: EventLoopProxy<UserEvent>) {
    let _ = std::thread::Builder::new()
        .name("atm-compare-watch".into())
        .spawn(move || {
            if let Ok(outcome) = receiver.recv() {
                let _ = proxy.send_event(UserEvent::Background(outcome));
            }
        });
}
