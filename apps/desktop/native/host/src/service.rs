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
        may_open: None,
    }
}

/// 退出时等一个已经开始开放入口的启动做完的上限。开放入口的几步（lease、HTTP、daemon.json、调度器）正常
/// 是毫秒级；转换不算在内（还没开始开放入口的启动不等，转换的每一步都能续做，07 §4）。
pub const OPENING_WAIT: Duration = Duration::from_secs(30);

/// 启动线程与事件循环之间的交接（peer W6 r8）。结果放在这里，事件只是通知；退出这一侧也从这里拿。
///
/// 只靠事件交回会漏一种情况：入口已经开了（daemon.json 写了、`/health` 答了），结果还没被事件循环处理，
/// 这时退出——事件循环不再处理事件，进程照常以 0 退出，daemon.json 留在那里。所以：
/// - 启动开始开放入口之前先问（[`BootSlot::begin_opening`]）：已经在退出就不开；
/// - 退出时（[`BootSlot::quit`]）：结果已经交回但没处理的，拿走由退出这一侧收尾；已经在开放入口、还没做完的，
///   等它做完（至多 [`OPENING_WAIT`]），启动线程看到正在退出，自己收尾（[`BootSlot::finish`] 交回 `Some`）；
///   还没开始开放入口的不等。
pub struct BootSlot<T> {
    state: std::sync::Mutex<BootState<T>>,
    done: std::sync::Condvar,
}

struct BootState<T> {
    opening: bool,
    quitting: bool,
    finished: bool,
    result: Option<T>,
}

impl<T> Default for BootSlot<T> {
    fn default() -> Self {
        BootSlot {
            state: std::sync::Mutex::new(BootState {
                opening: false,
                quitting: false,
                finished: false,
                result: None,
            }),
            done: std::sync::Condvar::new(),
        }
    }
}

impl<T> BootSlot<T> {
    fn lock(&self) -> std::sync::MutexGuard<'_, BootState<T>> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 启动要开始开放入口了（写 lease 之前，runtime 的 `may_open`）：已经在退出就不许（返回 false），否则记下、
    /// 之后的退出会等它做完。与 [`BootSlot::quit`] 在同一把锁里，两者互斥（peer W6 r9 P2-01）。
    pub fn begin_opening(&self) -> bool {
        let mut s = self.lock();
        if s.quitting {
            return false;
        }
        s.opening = true;
        true
    }

    /// 启动做完：没有在退出就放进来、返回 `None`（调用方再发通知）；正在退出就原样还给启动线程收尾。
    pub fn finish(&self, result: T) -> Option<T> {
        let mut s = self.lock();
        let left = if s.quitting {
            Some(result)
        } else {
            s.result = Some(result);
            None
        };
        if left.is_none() {
            s.finished = true;
            self.done.notify_all();
        }
        left
    }

    /// 启动线程收尾完了（[`BootSlot::finish`] 交回 `Some` 之后）。
    pub fn settled(&self) {
        self.lock().finished = true;
        self.done.notify_all();
    }

    /// 事件循环拿结果（通知到了）。
    pub fn take(&self) -> Option<T> {
        self.lock().result.take()
    }

    /// 退出：之后的结果都由启动线程自己收尾。已经交回、还没处理的结果交给 `settle` 收尾（在锁外）。
    pub fn quit(&self, wait: Duration, settle: impl FnOnce(T)) {
        let left = self.quit_inner(wait);
        if let Some(r) = left {
            settle(r);
        }
    }

    fn quit_inner(&self, wait: Duration) -> Option<T> {
        let mut s = self.lock();
        s.quitting = true;
        if let Some(r) = s.result.take() {
            return Some(r);
        }
        if s.opening {
            let deadline = std::time::Instant::now() + wait;
            while !s.finished {
                let now = std::time::Instant::now();
                if now >= deadline {
                    break;
                }
                s = self
                    .done
                    .wait_timeout(s, deadline - now)
                    .unwrap_or_else(|e| e.into_inner())
                    .0;
            }
        }
        s.result.take()
    }
}

/// 收掉一个没人接手的启动结果：开着的入口按顺序撤下，冲突时的准入放掉。
pub fn settle(booted: Booted, log_root: &std::path::Path) {
    if let Ok(Started::Serving(serving)) = booted.0 {
        let root = log_root.to_path_buf();
        serving.stop(&move |e| crate::log(&root, &format!("runtime: {e:?}")));
    }
}

/// 在工作线程上启动；结果放进 `slot`，再带着 `attempt` 通知事件循环，过期的通知（宿主已经退出或重试过）由事件循环丢掉。
pub fn spawn(
    mut options: Options,
    attempt: u64,
    proxy: EventLoopProxy<UserEvent>,
    slot: Arc<BootSlot<Booted>>,
) {
    let fallback = (proxy.clone(), slot.clone());
    gate(&mut options, &slot);
    let started = std::thread::Builder::new()
        .name("atm-boot".into())
        .spawn(move || {
            if boot(&options, &slot) {
                let _ = proxy.send_event(UserEvent::Booted(attempt));
            }
        });
    if let Err(error) = started {
        // 线程都起不来：当作这次启动失败，交给重试的节流。
        let failed = BootError::Failed(format!("spawn the boot thread: {error}"));
        let (proxy, slot) = fallback;
        if slot.finish(Booted(Err(failed))).is_none() {
            let _ = proxy.send_event(UserEvent::Booted(attempt));
        }
    }
}

/// 让 runtime 开放入口之前先问交接槽：已经在退出就不开（[`BootSlot::begin_opening`]）。
fn gate(options: &mut Options, slot: &Arc<BootSlot<Booted>>) {
    let slot = slot.clone();
    options.may_open = Some(Arc::new(move || slot.begin_opening()));
}

/// 在当前线程上启动一次，结果交给交接槽；正在退出就自己收尾。返回 true 时调用方要通知事件循环。
fn boot(options: &Options, slot: &BootSlot<Booted>) -> bool {
    let result = Booted(atm_runtime::start(options));
    match slot.finish(result) {
        None => true,
        Some(left) => {
            settle(left, &options.n);
            slot.settled();
            false
        }
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

#[cfg(test)]
mod tests {
    use super::BootSlot;
    use std::sync::Arc;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};

    /// 退出时交给 `settle` 的结果。
    fn quit<T>(slot: &BootSlot<T>, wait: Duration) -> Option<T> {
        let got = Mutex::new(None);
        slot.quit(wait, |t| *got.lock().unwrap() = Some(t));
        got.into_inner().unwrap()
    }

    /// 正常：结果放进槽、通知之后被事件循环拿走；退出时没有剩下的。
    #[test]
    fn a_result_handed_over_is_taken_by_the_event_loop() {
        let slot = BootSlot::default();
        assert!(slot.begin_opening());
        assert_eq!(slot.finish(1), None);
        assert_eq!(slot.take(), Some(1));
        assert_eq!(quit(&slot, Duration::from_secs(5)), None);
    }

    /// 结果已经交回、事件循环还没处理就退出：退出这一侧拿到它、负责收尾（peer W6 r8）。
    #[test]
    fn quitting_before_the_event_loop_took_the_result_settles_it() {
        let slot = BootSlot::default();
        assert!(slot.begin_opening());
        assert_eq!(slot.finish(7), None);
        assert_eq!(quit(&slot, Duration::from_secs(5)), Some(7));
        assert_eq!(slot.take(), None);
    }

    /// 正在开放入口时退出：等启动线程做完、自己收尾；之后退出才返回。
    #[test]
    fn quitting_while_the_entries_open_waits_for_the_boot_to_withdraw_them() {
        let slot = Arc::new(BootSlot::default());
        assert!(slot.begin_opening());
        let withdrawn = Arc::new(AtomicBool::new(false));
        let boot = {
            let (slot, withdrawn) = (slot.clone(), withdrawn.clone());
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(300));
                if let Some(left) = slot.finish(9) {
                    assert_eq!(left, 9);
                    std::thread::sleep(Duration::from_millis(100));
                    withdrawn.store(true, Ordering::SeqCst);
                    slot.settled();
                }
            })
        };
        let began = Instant::now();
        assert_eq!(quit(&*slot, Duration::from_secs(10)), None);
        assert!(withdrawn.load(Ordering::SeqCst), "退出返回时入口已经撤下");
        assert!(began.elapsed() >= Duration::from_millis(300));
        boot.join().unwrap();
    }

    /// 还没开始开放入口（例如在转换）：退出不等；之后做完的结果由启动线程自己收尾。
    #[test]
    fn quitting_before_the_entries_open_does_not_wait() {
        let slot = BootSlot::default();
        let began = Instant::now();
        assert_eq!(quit(&slot, Duration::from_secs(10)), None);
        assert!(began.elapsed() < Duration::from_secs(1));
        assert_eq!(slot.finish(3), Some(3), "启动线程自己收尾");
    }

    /// 开放入口卡住超过上限：退出不再等。
    #[test]
    fn a_stuck_opening_is_waited_for_only_up_to_the_limit() {
        let slot = BootSlot::<u8>::default();
        assert!(slot.begin_opening());
        let began = Instant::now();
        assert_eq!(quit(&slot, Duration::from_millis(200)), None);
        let took = began.elapsed();
        assert!(
            took >= Duration::from_millis(200) && took < Duration::from_secs(5),
            "{took:?}"
        );
    }

    /// 退出与开始开放入口互斥：先退出的，之后的启动不许再开（不留 daemon.json）；先开始开放的，退出等它。
    #[test]
    fn quitting_and_opening_exclude_each_other() {
        let slot = BootSlot::<u8>::default();
        assert_eq!(quit(&slot, Duration::from_secs(5)), None);
        assert!(!slot.begin_opening(), "退出之后不许再开放入口");
        let slot = BootSlot::<u8>::default();
        assert!(slot.begin_opening());
        let began = Instant::now();
        assert_eq!(quit(&slot, Duration::from_millis(300)), None);
        assert!(
            began.elapsed() >= Duration::from_millis(300),
            "开放入口中，等到上限"
        );
    }

    /// 真实的 runtime 在子进程里启动，在固定的观察点停住启动线程，再退出（peer W6 r9 P2-01 的反例）：
    /// - 开放入口之前退出：之后启动线程被放行，runtime 问 `may_open` 得到 false，什么入口都不开；
    /// - 开始开放入口之后退出：退出等启动线程做完、撤下入口才返回。
    ///
    /// 宿主在退出返回后就结束进程。开放入口之前退出的那一种里，启动线程一旦写下 `daemon.json`（`Descriptor`）
    /// 子进程就立即结束，模拟宿主在开放到一半时退出；正确时走不到那一步。走完的子进程留一个 `ran` 标记，父进程
    /// 查标记与 `daemon.json` 在不在，不读内容。
    #[test]
    #[ignore = "由 the_boot_never_leaves_a_descriptor_behind_a_quit 拉起"]
    fn quit_against_a_real_boot_child() {
        let root = std::path::PathBuf::from(std::env::var_os("ATM_TEST_BOOT_ROOT").unwrap());
        let after_gate = std::env::var("ATM_TEST_BOOT_AFTER_GATE").as_deref() == Ok("1");
        let slot = Arc::new(BootSlot::<super::Booted>::default());
        let (paused_tx, paused_rx) = std::sync::mpsc::channel();
        let (go_tx, go_rx) = std::sync::mpsc::channel::<()>();
        let go_rx = Mutex::new(go_rx);
        let stop_at = if after_gate {
            atm_runtime::Event::Lease
        } else {
            atm_runtime::Event::Published
        };
        let quiesce_root = root.join("L-missing");
        let mut options = atm_runtime::Options {
            n: root.join("N"),
            legacy: root.join("L-missing"),
            version: "3.0.0-test".into(),
            handoff: None,
            quiesce: Box::new(move || atm_runtime::legacy_quiesce(&quiesce_root)),
            allow_real_data_root: false,
            real_data_root: None,
            secrets_check: Some(atm_runtime::secrets::check),
            sweep_every: Duration::from_secs(3600),
            drill: atm_runtime::Drill::default(),
            observe: Arc::new(move |e| {
                if !after_gate && e == atm_runtime::Event::Descriptor {
                    std::process::exit(0);
                }
                if e == stop_at {
                    paused_tx.send(()).unwrap();
                    go_rx.lock().unwrap().recv().unwrap();
                }
            }),
            notify: None,
            maintenance: false,
            metrics_capture: false,
            may_open: None,
        };
        super::gate(&mut options, &slot);
        let job = slot.clone();
        let booting = std::thread::spawn(move || super::boot(&options, &job));
        paused_rx.recv_timeout(Duration::from_secs(60)).unwrap();
        let descriptor = root.join("N").join("runtime").join("daemon.json");
        if after_gate {
            let job = slot.clone();
            let quitting = std::thread::spawn(move || {
                job.quit(super::OPENING_WAIT, |_| {
                    panic!("the boot has no result yet")
                })
            });
            std::thread::sleep(Duration::from_millis(200));
            assert!(!quitting.is_finished(), "退出等着开放入口的启动");
            go_tx.send(()).unwrap();
            quitting.join().unwrap();
        } else {
            slot.quit(super::OPENING_WAIT, |_| {
                panic!("the boot has no result yet")
            });
            go_tx.send(()).unwrap();
            assert!(!booting.join().unwrap(), "启动线程自己收尾，不交回");
        }
        assert!(!descriptor.exists(), "退出返回时 daemon.json 还在");
        std::fs::write(root.join("ran"), b"").unwrap();
        std::process::exit(0);
    }

    #[test]
    fn the_boot_never_leaves_a_descriptor_behind_a_quit() {
        let deps = std::env::current_exe().unwrap();
        let target = deps.parent().unwrap().parent().unwrap().to_path_buf();
        for after_gate in [false, true] {
            let root = target
                .join("host-unit")
                .join(format!("boot-quit-{after_gate}"));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(root.join("local")).unwrap();
            let mut cmd = std::process::Command::new(&deps);
            cmd.args([
                "--exact",
                "service::tests::quit_against_a_real_boot_child",
                "--ignored",
                "--nocapture",
            ])
            .env("ATM_TEST_BOOT_ROOT", &root)
            .env(
                "ATM_TEST_BOOT_AFTER_GATE",
                if after_gate { "1" } else { "0" },
            )
            .env("LOCALAPPDATA", root.join("local"));
            for key in ["ATM_DATA_DIR", "AYANAMI_TASK_DATA_DIR", "ATM3_DATA_DIR"] {
                cmd.env_remove(key);
            }
            let mut child = cmd.spawn().unwrap();
            let began = Instant::now();
            let status = loop {
                if let Some(s) = child.try_wait().unwrap() {
                    break s;
                }
                if began.elapsed() > Duration::from_secs(120) {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("the child did not finish");
                }
                std::thread::sleep(Duration::from_millis(20));
            };
            assert!(status.success(), "after_gate={after_gate}: {status}");
            assert!(
                root.join("ran").exists(),
                "after_gate={after_gate}: 子进程没有走完"
            );
            assert!(
                !root.join("N").join("runtime").join("daemon.json").exists(),
                "after_gate={after_gate}: daemon.json 留在了退出之后"
            );
        }
    }

    /// `fn quit(&mut self)` 的函数体（到下一个同级 `fn` 为止）。
    fn quit_body(src: &str) -> Option<&str> {
        let start = src.find("    fn quit(&mut self) {")?;
        let rest = &src[start..];
        let end = rest[1..].find("\n    fn ").map_or(rest.len(), |i| i + 1);
        Some(&rest[..end])
    }

    /// 静态守卫：宿主退出时把正在交接的启动交给 [`BootSlot::quit`]，开放入口的启动由它等到撤下（peer W6 r8）。
    /// 启动交接的竞态在用例里没法稳定复现，这一步由这里钉住；对照是去掉这一调用的写法。
    #[test]
    fn the_host_quit_hands_the_boot_slot_over() {
        let check = |src: &str| {
            quit_body(src).is_some_and(|b| {
                b.contains("self.boot.take()")
                    && b.contains("slot.quit(crate::service::OPENING_WAIT")
            })
        };
        let src = include_str!("app.rs");
        assert!(check(src), "app.rs 的 quit 没有交接启动");
        let broken = src.replace(
            "slot.quit(crate::service::OPENING_WAIT",
            "drop((slot, crate::service::OPENING_WAIT",
        );
        assert!(!check(&broken), "对照：去掉交接查得出");
    }
}
