//! Event loop: window/WebView lifecycle, renderer bridge, tray, second instance and the
//! in-process ATM 3 service (W5a; de-electron §4, §5, §8 for the window and the bridge).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use atm_runtime::update::{self as updates, Coordinator, Schedule};
use atm_runtime::{
    Background, BootError, Conflicted, Handoff, Observation, Serving, SourceChoice, Started,
};
use atm_store::conversion::{StartupState, conflict_cause};
use atm_ui_bridge::{Reply, Ui};
use serde_json::{Value, json};
use tao::dpi::{LogicalSize, PhysicalPosition, PhysicalSize};
use tao::event::{Event, StartCause, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy, EventLoopWindowTarget};
use tao::platform::windows::{IconExtWindows, WindowBuilderExtWindows, WindowExtWindows};
use tao::window::{Icon as WindowIcon, Window, WindowBuilder};
use tray_icon::menu::MenuEvent;
use tray_icon::{MouseButton, MouseButtonState, TrayIcon, TrayIconEvent};
use wry::{PageLoadEvent, WebContext, WebView, WebViewBuilder, WebViewBuilderExtWindows};

use crate::args::Args;
use crate::assets;
use crate::bridge::{self, Call, Local, Method};
use crate::lifecycle::{self as life, Event as Life};
use crate::paths::Layout;
use crate::service::{BootSlot, Booted};
use crate::single_instance::{Command, Primary, Route};
use crate::tray::{self, Snapshot};
use crate::watchdog::{self, Probes, Pulse, Watchdog};
use crate::win;

/// Upper bound for waiting on the renderer's ready signal (window-readiness.ts).
const RENDERER_READY_TIMEOUT: Duration = Duration::from_secs(10);
const STARTUP_DELAY_MAX_MS: u64 = 5_000;
/// A failed start is retried with backoff, at most this many times in this window; then the
/// host keeps its window and tray and says the service is unavailable until the next start.
const BOOT_RETRY_WINDOW: Duration = Duration::from_secs(600);
const BOOT_RETRY_LIMIT: usize = 5;
/// The 2.x service has not quiesced yet: look again this often (not counted as a failure).
const LEGACY_RECHECK: Duration = Duration::from_secs(5);
const MAX_QUEUED_CALLS: usize = 256;
/// 同时在途的界面请求（W5e）：超过就回 SERVICE_BUSY，不排队（一个失控的渲染端占不满入口的工作线程）。
const MAX_UI_IN_FLIGHT: usize = 64;
const LIGHT_BACKGROUND: (u8, u8, u8, u8) = (0xFB, 0xF7, 0xFF, 0xFF);
const DARK_BACKGROUND: (u8, u8, u8, u8) = (0x24, 0x1E, 0x30, 0xFF);

#[derive(Debug)]
pub enum UserEvent {
    /// The boot thread finished attempt `n`; the result is in that attempt's [`BootSlot`].
    Booted(u64),
    /// The background comparison of a serving start reached its verdict.
    Background(Background),
    Second(Command),
    Ipc {
        generation: u64,
        source: String,
        body: String,
    },
    PageLoad {
        generation: u64,
        started: bool,
    },
    Tray(TrayIconEvent),
    Menu(MenuEvent),
    StartupDelayElapsed,
    RetryService,
    /// 看门狗的 ping（W5g）：事件循环处理它就说明事件循环还活着。
    Ping,
    /// 观察器（W5f）：要弹的通知、托盘计数的变化、或一轮读失败。
    Observed(Observation),
    /// 托盘切换通知方式的写入结束了（成功时观察器会随后推来新的托盘快照）。
    ModeSet(Result<(), String>),
    /// 待安装的版本变了（W5g）：刷托盘，有了新版本时按通知方式提示。
    UpdatePending(Option<String>),
    /// 「立即更新」确认了包：在 UI 线程上复核路径并拉起 setup。
    InstallUpdate(PathBuf),
    /// 宿主方法在工作线程上做完了（更新检查与应用、Agent 接入）。投递前核对代次，与界面请求一样。
    HostReply {
        generation: u64,
        epoch: u64,
        js_id: u64,
        result: Result<Value, crate::agents::Failure>,
    },
    /// 一次界面请求在工作线程上分发完了。投递前再核对 `(generation, epoch)`（03 U4）。
    UiReply {
        generation: u64,
        epoch: u64,
        js_id: u64,
        reply: Option<Reply>,
    },
}

struct QueuedCall {
    generation: u64,
    epoch: u64,
    js_id: u64,
    method: Method,
    args: Vec<Value>,
}

/// Where the in-process service is.
enum Service {
    /// Not started yet: login delay, or waiting for an install transaction's lock.
    Idle,
    /// The boot thread is running attempt `boot_attempt`.
    Booting,
    /// A retry is scheduled.
    Retrying,
    Serving(Serving),
    /// Source conflict: no entry is open; the admission is held (by keeping this value) until
    /// the user chooses in the window (W8h, B2).
    Conflict {
        held: Conflicted,
    },
    /// Gave up after repeated failures; the next start tries again.
    Unavailable,
}

pub struct App {
    proxy: EventLoopProxy<UserEvent>,
    layout: Layout,
    run_id: String,
    version: String,
    /// Set when setup started this host with `--txn-start`: the runtime writes the
    /// SERVICE_HEALTHY witness for that transaction once its entries are open.
    handoff: Option<Handoff>,
    autostart_target: PathBuf,
    _primary: Primary,

    service: Service,
    boot_attempt: u64,
    /// The running (or last) boot's hand-over slot.
    boot: Option<Arc<BootSlot<Booted>>>,
    boot_failures: Vec<Instant>,
    /// The last reason the 2.x service was waited for, logged once per change.
    legacy_wait: Option<String>,
    queued: Vec<QueuedCall>,
    /// 进程内的界面 API（W5e），服务开始服务后第一次界面请求时建好。
    ui: Option<Arc<Ui>>,
    /// Agent 接入（W6d），服务开始服务时建好。
    agents: Option<Arc<atm_agents::integrations::Agents>>,
    ui_in_flight: usize,
    /// 托盘切换通知方式的次数：给每次写入一个不重复的 op_id。
    mode_writes: u64,
    /// 本地更新的协调与周期检查（W5g），第一次启动服务时建好。
    updates: Option<(Arc<Coordinator>, Schedule)>,
    /// 看门狗（W5g）：事件循环的脉搏与写线程的探针。
    pulse: Arc<Pulse>,
    writer_probe: WriterProbe,
    watchdog: Option<Watchdog>,

    web_context: WebContext,
    window: Option<Window>,
    webview: Option<WebView>,
    generation: u64,
    epoch: u64,
    page_loaded: bool,
    renderer_ready: bool,
    show_pending: bool,
    route_pending: Option<String>,
    ready_deadline: Option<Instant>,
    maximized: bool,
    /// What the last window looked like when it closed, so reopening from the tray lands
    /// where the user left (Electron hid the window; this host drops it to free WebView2).
    saved: SavedWindow,

    tray: Option<TrayIcon>,
    snapshot: Snapshot,
    /// The data-source conflict the service is in (07 §7): at boot, or found by the
    /// background comparison after the entries opened. Cleared once it serves again.
    conflict: Option<StartupState>,
    /// The user's choice is being carried out (the boot after it is running).
    choosing: bool,
    /// Why the last choice could not be carried out, shown next to the choice again.
    choice_error: Option<String>,
    startup_delay_pending: bool,
    quitting: bool,
    exit_code: i32,
}

#[derive(Default)]
struct SavedWindow {
    route: Option<String>,
    /// Normal (restored) bounds, physical pixels.
    bounds: Option<(PhysicalPosition<i32>, PhysicalSize<u32>)>,
    maximized: bool,
}

/// The renderer route in the entry document's fragment, if it is one the UI knows
/// (`Route` in packages/ui/src/contracts.ts). Anything else is dropped, not replayed.
fn route_from_url(url: &str) -> Option<String> {
    let (document, fragment) = url.split_once('#')?;
    if !assets::navigation_allowed(document) {
        return None;
    }
    const ROUTES: [&str; 9] = [
        "overview",
        "projects",
        "my",
        "quick",
        "blockers",
        "agents",
        "timeline",
        "knowledge",
        "settings",
    ];
    let project = fragment.strip_prefix("project:").is_some_and(|code| {
        (1..=64).contains(&code.len())
            && code
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    });
    (ROUTES.contains(&fragment) || project).then(|| fragment.to_owned())
}

/// Restore the saved position only if its title bar still lands on a monitor (a monitor
/// may have been unplugged since).
fn on_some_monitor(
    target: &EventLoopWindowTarget<UserEvent>,
    position: PhysicalPosition<i32>,
) -> bool {
    target.available_monitors().any(|monitor| {
        let origin = monitor.position();
        let size = monitor.size();
        let (x, y) = (position.x + 48, position.y + 16);
        x >= origin.x
            && y >= origin.y
            && x < origin.x + size.width as i32
            && y < origin.y + size.height as i32
    })
}

/// 应答、排队的调用只交给发出它的那一代页面（03 U4、P-013）：`(generation, epoch)` 两个都要相同。
/// 窗口关过再开 generation 加一，同一个窗口里页面重新加载 epoch 加一；任何一个变了，旧页面的 Promise
/// 已经不在了，答给新页面就是答错了人。
fn same_page(sent: (u64, u64), current: (u64, u64)) -> bool {
    sent == current
}

/// 宿主眼里服务走到了哪一步：只用来决定要服务的界面调用怎么答。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Starting,
    Conflict,
    Unavailable,
    /// `open`：入口还开着。后台比较发现数据源冲突时入口撤下，宿主还没换到 Conflict。
    Serving {
        open: bool,
    },
}

/// 服务接不了时，要服务的界面调用得到什么（07 §7）。`None`：还在启动（先排队）或在服务。
/// 入口撤下的在服务与数据源冲突一样答：入口关了，不再写业务数据。
fn unavailable_in(phase: Phase) -> Option<(&'static str, &'static str)> {
    match phase {
        Phase::Starting | Phase::Serving { open: true } => None,
        Phase::Conflict | Phase::Serving { open: false } => {
            Some(("SOURCE_CONFLICT", "数据源冲突，需要先选择数据源"))
        }
        Phase::Unavailable => Some(("SERVICE_UNAVAILABLE", "服务暂时不可用")),
    }
}

#[cfg(test)]
mod phase_tests {
    use super::{Phase, unavailable_in};

    #[test]
    fn a_source_conflict_answers_every_service_call_and_starting_queues_them() {
        let code = |phase| unavailable_in(phase).map(|(code, _)| code);
        assert_eq!(code(Phase::Conflict), Some("SOURCE_CONFLICT"));
        // 后台比较撤下了入口：同样是冲突，不是「暂时不可用」，也不能当成还在服务。
        assert_eq!(
            code(Phase::Serving { open: false }),
            Some("SOURCE_CONFLICT")
        );
        assert_eq!(code(Phase::Unavailable), Some("SERVICE_UNAVAILABLE"));
        assert_eq!(code(Phase::Starting), None);
        assert_eq!(code(Phase::Serving { open: true }), None);
    }
}

#[cfg(test)]
mod page_tests {
    use super::same_page;

    #[test]
    fn p013_only_the_page_that_asked_gets_the_answer() {
        assert!(same_page((3, 7), (3, 7)));
        // 反例：页面在同一个窗口里重新加载过（epoch + 1）。
        assert!(!same_page((3, 7), (3, 8)));
        // 反例：窗口关过又开（generation + 1，epoch 也跟着加一）。
        assert!(!same_page((3, 7), (4, 8)));
        // 反例：只有 generation 变了。
        assert!(!same_page((3, 7), (4, 7)));
    }
}

#[cfg(test)]
mod route_tests {
    use super::route_from_url;

    #[test]
    fn keeps_known_routes_of_the_entry_document_only() {
        let entry = crate::assets::ENTRY_SOURCE;
        assert_eq!(
            route_from_url(&format!("{entry}#settings")).as_deref(),
            Some("settings")
        );
        assert_eq!(
            route_from_url(&format!("{entry}#project:ATM")).as_deref(),
            Some("project:ATM")
        );
        for rejected in [
            entry.to_string(),
            format!("{entry}#"),
            format!("{entry}#nowhere"),
            format!("{entry}#project:"),
            format!("{entry}#project:a/b"),
            format!("{entry}#project:{}", "x".repeat(65)),
            "https://example.com/index.html#settings".to_owned(),
        ] {
            assert_eq!(route_from_url(&rejected), None, "{rejected}");
        }
    }
}

fn run_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    format!("{:x}-{:x}", std::process::id(), nanos)
}

fn random_delay() -> Duration {
    // Spread logins across 0–5 s like startup.ts; nanosecond jitter is random enough.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.subsec_nanos() as u64)
        .unwrap_or_default();
    Duration::from_millis(nanos % (STARTUP_DELAY_MAX_MS + 1))
}

fn after(delay: Duration, proxy: &EventLoopProxy<UserEvent>, event: UserEvent) {
    let proxy = proxy.clone();
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        let _ = proxy.send_event(event);
    });
}

pub fn run(
    layout: Layout,
    args: Args,
    primary: Primary,
    autostart_target: PathBuf,
    version: String,
    handoff: Option<Handoff>,
) -> i32 {
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    crate::session_end::install(&layout.v3_root);
    {
        let proxy = proxy.clone();
        TrayIconEvent::set_event_handler(Some(move |event| {
            let _ = proxy.send_event(UserEvent::Tray(event));
        }));
    }
    {
        let proxy = proxy.clone();
        MenuEvent::set_event_handler(Some(move |event| {
            let _ = proxy.send_event(UserEvent::Menu(event));
        }));
    }
    {
        let proxy = proxy.clone();
        // Named after `L` like the mutex: setup's QUIT and the launcher's SHOW / WAKE find it.
        if let Err(error) = crate::single_instance::serve(&layout.data_dir, move |command| {
            let _ = proxy.send_event(UserEvent::Second(command));
        }) {
            crate::log(
                &layout.v3_root,
                &format!("second-instance pipe unavailable: {error}"),
            );
        }
    }
    let web_context = WebContext::new(Some(layout.v3_root.join("webview")));
    let mut app = App {
        proxy,
        show_pending: !args.background,
        startup_delay_pending: args.random_startup_delay && !args.agent_wake,
        layout,
        run_id: run_id(),
        version,
        handoff,
        autostart_target,
        _primary: primary,
        service: Service::Idle,
        boot_attempt: 0,
        boot: None,
        boot_failures: Vec::new(),
        legacy_wait: None,
        queued: Vec::new(),
        ui: None,
        agents: None,
        ui_in_flight: 0,
        mode_writes: 0,
        updates: None,
        pulse: Pulse::new(),
        writer_probe: Arc::new(std::sync::Mutex::new(None)),
        watchdog: None,
        web_context,
        window: None,
        webview: None,
        generation: 0,
        epoch: 0,
        page_loaded: false,
        renderer_ready: false,
        route_pending: None,
        ready_deadline: None,
        maximized: false,
        saved: SavedWindow::default(),
        tray: None,
        conflict: None,
        choosing: false,
        choice_error: None,
        snapshot: Snapshot {
            notification_mode: "ALL".into(),
            ..Snapshot::default()
        },
        quitting: false,
        exit_code: 0,
    };

    event_loop.run(move |event, target, control_flow| {
        *control_flow = match app.ready_deadline {
            Some(deadline) => ControlFlow::WaitUntil(deadline),
            None => ControlFlow::Wait,
        };
        match event {
            Event::NewEvents(StartCause::Init) => app.on_init(),
            Event::NewEvents(StartCause::ResumeTimeReached { .. }) => app.on_ready_timeout(),
            Event::UserEvent(event) => app.on_user_event(event, target),
            Event::WindowEvent { event, .. } => app.on_window_event(event),
            _ => {}
        }
        if app.quitting {
            *control_flow = ControlFlow::ExitWithCode(app.exit_code);
        }
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Gate {
    Open,
    Wait,
    Closed,
}

impl App {
    fn on_init(&mut self) {
        self.start_watchdog();
        match tray::build(&self.snapshot) {
            Ok(tray) => self.tray = Some(tray),
            Err(error) => crate::log(&self.layout.v3_root, &format!("tray unavailable: {error}")),
        }
        if self.startup_delay_pending {
            after(random_delay(), &self.proxy, UserEvent::StartupDelayElapsed);
        } else {
            self.start_service();
        }
        // The window does not wait for the service: a conversion can take minutes, and the
        // renderer reports its own loading and unavailable states.
        if self.show_pending {
            self.request_show_later();
        }
    }

    /// Admission was decided once, at start; a delayed start or a retry can come after a
    /// setup began a transaction (Codex review P1-1). Checked before every start attempt.
    fn install_gate(&self) -> Gate {
        if self.handoff.is_some() || !self.layout.packaged {
            return Gate::Open;
        }
        let Some(root) = self.layout.app_dir.parent() else {
            return Gate::Open;
        };
        if !root.join(atm_install_state::APP_POINTER).is_file() {
            return Gate::Open;
        }
        match atm_install_state::read_journal(root) {
            Ok(Some(journal))
                if !journal.is_terminal()
                    || journal.outcome == Some(atm_install_state::Outcome::RecoveryFailed) =>
            {
                return Gate::Closed;
            }
            Err(_) => return Gate::Closed,
            _ => {}
        }
        // A setup holding the lock may still be in PRECHECK (no journal yet): wait, do not
        // quit — the install may be refused and this service is still wanted.
        if atm_install_state::lock_held(root) {
            return Gate::Wait;
        }
        match atm_install_state::read_pointer(root) {
            Ok(Some(pointer)) if pointer.current == self.version => Gate::Open,
            _ => Gate::Closed,
        }
    }

    fn start_service(&mut self) {
        if !matches!(self.service, Service::Idle | Service::Retrying) || self.quitting {
            return;
        }
        match self.install_gate() {
            Gate::Open => {}
            Gate::Wait => {
                self.service = Service::Retrying;
                after(Duration::from_secs(1), &self.proxy, UserEvent::RetryService);
                return;
            }
            Gate::Closed => {
                crate::log(
                    &self.layout.v3_root,
                    "service not started: an install transaction began after this host started",
                );
                self.quit();
                return;
            }
        }
        self.startup_delay_pending = false;
        self.start_updates();
        self.boot_attempt += 1;
        self.service = Service::Booting;
        let options = crate::service::options(
            &self.layout,
            &self.version,
            self.handoff.clone(),
            self.proxy.clone(),
        );
        let slot = Arc::new(BootSlot::default());
        self.boot = Some(slot.clone());
        crate::service::spawn(options, self.boot_attempt, self.proxy.clone(), slot);
    }

    fn on_booted(&mut self, attempt: u64, booted: Booted) {
        if attempt != self.boot_attempt || !matches!(self.service, Service::Booting) {
            return;
        }
        match booted.0 {
            Ok(Started::Serving(mut serving)) => {
                crate::log(
                    &self.layout.v3_root,
                    &format!(
                        "service serving on 127.0.0.1:{} (instance {}, lease {})",
                        serving.port(),
                        serving.instance_id(),
                        serving.lease_generation()
                    ),
                );
                if let Some(receiver) = serving.take_background() {
                    crate::service::watch_background(receiver, self.proxy.clone());
                }
                record(
                    Life::Ready,
                    &[
                        ("generation", json!(serving.lease_generation())),
                        ("instanceId", json!(serving.instance_id())),
                    ],
                );
                if let Some((svc, _)) = serving.service() {
                    let agents = crate::agents::build(&self.layout, svc.clone());
                    let (job, layout) = (agents.clone(), self.layout.clone());
                    let _ = std::thread::Builder::new()
                        .name("atm-agents-startup".into())
                        .spawn(move || {
                            for line in crate::agents::startup(&job, &layout) {
                                crate::log(&layout.v3_root, &line);
                            }
                        });
                    self.agents = Some(agents);
                    let service = Arc::downgrade(&svc);
                    *self.writer_probe.lock().unwrap_or_else(|e| e.into_inner()) =
                        Some(Box::new(move || {
                            service.upgrade().and_then(|svc| svc.store().current_job())
                        }));
                }
                self.legacy_wait = None;
                self.service = Service::Serving(serving);
                self.answer_queued();
                self.source_settled(None);
            }
            Ok(Started::Conflict(conflicted)) => {
                crate::log(
                    &self.layout.v3_root,
                    &format!("SOURCE_CONFLICT: {}", conflicted.state.reason),
                );
                record(Life::Conflict, &[]);
                let state = conflicted.state.clone();
                self.service = Service::Conflict { held: conflicted };
                self.answer_queued();
                self.source_settled(Some(state));
            }
            Err(BootError::WaitLegacyQuiesce(why)) => {
                if self.legacy_wait.as_deref() != Some(why.as_str()) {
                    crate::log(&self.layout.v3_root, &format!("WAIT_LEGACY_QUIESCE: {why}"));
                    self.legacy_wait = Some(why);
                }
                self.service = Service::Retrying;
                after(LEGACY_RECHECK, &self.proxy, UserEvent::RetryService);
            }
            Err(error) => {
                crate::log(
                    &self.layout.v3_root,
                    &format!("service start failed: {error}"),
                );
                record(
                    Life::BootstrapFailed,
                    &life::error_detail("BootError", &error.to_string()),
                );
                if self.choosing {
                    // The next boot finds the conflict again (nothing was decided) and asks
                    // again, with this reason next to the choice.
                    self.choosing = false;
                    self.choice_error = Some(error.to_string());
                }
                self.schedule_retry();
                self.emit_data_source();
            }
        }
    }

    fn schedule_retry(&mut self) {
        let now = Instant::now();
        self.boot_failures
            .retain(|at| now.duration_since(*at) < BOOT_RETRY_WINDOW);
        if self.boot_failures.len() >= BOOT_RETRY_LIMIT {
            crate::log(
                &self.layout.v3_root,
                "service keeps failing; giving up until the next start",
            );
            self.service = Service::Unavailable;
            self.answer_queued();
            self.emit_data_source();
            return;
        }
        self.boot_failures.push(now);
        self.service = Service::Retrying;
        let backoff = Duration::from_secs(1 << self.boot_failures.len().min(4));
        after(backoff, &self.proxy, UserEvent::RetryService);
    }

    fn on_background(&mut self, outcome: Background) {
        match outcome {
            Background::Unchanged => {}
            // The runtime already withdrew every entry before writing the startup state; the
            // admission stays held (the user chooses the source, W6).
            Background::Conflict(state) => {
                crate::log(
                    &self.layout.v3_root,
                    &format!(
                        "SOURCE_CONFLICT after the background comparison: {}",
                        state.reason
                    ),
                );
                // 入口已经撤下：界面也不再分发（`Serving::service` 从此是 None），缓存的分发器一并丢掉。
                self.ui = None;
                *self.writer_probe.lock().unwrap_or_else(|e| e.into_inner()) = None;
                record(Life::Conflict, &[("reason", json!("background"))]);
                self.source_settled(Some(state));
            }
            Background::Failed(error) => crate::log(
                &self.layout.v3_root,
                &format!("background comparison: {error}"),
            ),
        }
    }

    fn on_user_event(&mut self, event: UserEvent, target: &EventLoopWindowTarget<UserEvent>) {
        match event {
            UserEvent::StartupDelayElapsed | UserEvent::RetryService => self.start_service(),
            UserEvent::Booted(attempt) => {
                let booted = (attempt == self.boot_attempt)
                    .then(|| self.boot.as_ref().and_then(|slot| slot.take()))
                    .flatten();
                if let Some(booted) = booted {
                    self.on_booted(attempt, booted);
                }
            }
            UserEvent::Background(outcome) => self.on_background(outcome),
            UserEvent::Ping => self.pulse.beat(),
            UserEvent::Observed(observation) => self.on_observed(observation),
            UserEvent::UpdatePending(version) => self.on_update_pending(version),
            UserEvent::InstallUpdate(manifest) => self.install_update(&manifest),
            UserEvent::HostReply {
                generation,
                epoch,
                js_id,
                result,
            } => {
                self.ui_in_flight = self.ui_in_flight.saturating_sub(1);
                if same_page((generation, epoch), (self.generation, self.epoch)) {
                    match result {
                        Ok(value) => self.deliver(&bridge::ok(js_id, value)),
                        Err((code, message, details)) => {
                            self.deliver(&bridge::error_with(js_id, &code, &message, details))
                        }
                    }
                }
            }
            UserEvent::ModeSet(Ok(())) => {}
            UserEvent::ModeSet(Err(error)) => {
                crate::log(&self.layout.v3_root, &format!("notification mode: {error}"))
            }
            UserEvent::UiReply {
                generation,
                epoch,
                js_id,
                reply,
            } => self.on_ui_reply(generation, epoch, js_id, reply),
            UserEvent::Second(command) => self.on_second_instance(command, target),
            UserEvent::Ipc {
                generation,
                source,
                body,
            } if generation == self.generation => {
                self.on_ipc(&source, &body);
            }
            UserEvent::Ipc { .. } => {}
            UserEvent::PageLoad {
                generation,
                started,
            } if generation == self.generation => {
                if started {
                    // A new document: answers for the previous one must not reach it.
                    self.epoch += 1;
                    self.renderer_ready = false;
                    self.page_loaded = false;
                } else {
                    self.page_loaded = true;
                    self.drain_readiness();
                }
            }
            UserEvent::PageLoad { .. } => {}
            UserEvent::Tray(TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            })
            | UserEvent::Tray(TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            }) => {
                self.request_show(None, target);
            }
            UserEvent::Tray(_) => {}
            UserEvent::Menu(event) => match tray::action(event.id()) {
                Some(tray::Action::Open) => self.request_show(None, target),
                Some(tray::Action::QuickTask) => {
                    self.request_show(Some(Route::Quick.as_str()), target)
                }
                Some(tray::Action::Settings) => {
                    self.request_show(Some(Route::Settings.as_str()), target)
                }
                Some(tray::Action::NotificationMode(mode)) => self.set_notification_mode(mode),
                Some(tray::Action::InstallUpdate) => self.apply_update(atm_ui_bridge::tray(), None),
                Some(tray::Action::Quit) => self.quit(),
                None => {}
            },
        }
    }

    /// 观察器的结果（W5f）。通知照方式与去重的决定直接弹；托盘只在快照变了时才推来。
    /// 日志只记有没有弹出去，不记任务内容。
    fn on_observed(&mut self, observation: Observation) {
        match observation {
            Observation::Notice(notice) => {
                crate::notify::show(&self.layout.v3_root, &notice.title, &notice.body)
            }
            Observation::Tray(counts) => {
                self.snapshot.blocked = counts.blocked;
                self.snapshot.waiting = counts.waiting;
                self.snapshot.notification_mode = counts.mode.to_owned();
                if let Some(tray) = &self.tray {
                    tray.set_menu(Some(Box::new(tray::menu(&self.snapshot))));
                }
            }
            Observation::Failed(error) => {
                crate::log(&self.layout.v3_root, &format!("notify observer: {error}"))
            }
        }
    }

    /// 托盘的「系统通知」子菜单（03 §2.4：User{Tray}，能力 notification.mode_set）。写入在入口的工作线程上做，
    /// 不阻塞事件循环；成功后观察器读到这次写入，推来新的托盘快照（勾选项随之改变）。
    fn set_notification_mode(&mut self, mode: &'static str) {
        let Service::Serving(serving) = &self.service else {
            crate::log(
                &self.layout.v3_root,
                "notification mode: service unavailable",
            );
            return;
        };
        let Some((svc, handle)) = serving.service() else {
            crate::log(&self.layout.v3_root, "notification mode: entries withdrawn");
            return;
        };
        self.mode_writes += 1;
        let op_id = format!(
            "tray.notification-mode:{}:{}",
            self.run_id, self.mode_writes
        );
        let proxy = self.proxy.clone();
        drop(handle.spawn_blocking(move || {
            let outcome = svc
                .set_notification_mode(&atm_ui_bridge::tray(), mode, None, &op_id)
                .map(|_| ())
                .map_err(|e| format!("{}: {}", e.code.as_str(), e.message));
            let _ = proxy.send_event(UserEvent::ModeSet(outcome));
        }));
    }

    /// 本地更新（W5g）：启动服务时建一次，此后与服务的状态无关。版本在 `N\updates`，诊断在 `N\logs`。
    fn start_updates(&mut self) {
        if self.updates.is_some() {
            return;
        }
        let proxy = self.proxy.clone();
        let coordinator = Arc::new(Coordinator::new(updates::Options {
            data_dir: self.layout.v3_root.clone(),
            current_version: self.version.clone(),
            install_root: updates::install_root_of(&self.layout.app_dir),
            on_pending: Arc::new(move |version| {
                let _ = proxy.send_event(UserEvent::UpdatePending(version));
            }),
            now: None,
        }));
        let schedule = Schedule::start(coordinator.clone(), updates::CHECK_INTERVAL);
        self.updates = Some((coordinator, schedule));
    }

    fn on_update_pending(&mut self, version: Option<String>) {
        let announce = version.is_some() && self.snapshot.notification_mode != "OFF";
        self.snapshot.pending_update = version.clone();
        if let Some(tray) = &self.tray {
            tray.set_menu(Some(Box::new(tray::menu(&self.snapshot))));
            if let Some(version) = &version {
                crate::log(
                    &self.layout.v3_root,
                    &format!("tray offers update {version}"),
                );
            }
        }
        if let (true, Some(version)) = (announce, version) {
            crate::notify::show(
                &self.layout.v3_root,
                "AyanamiTaskManager 有新版本",
                &format!("{version} 已就绪，在托盘或设置里点「立即更新」。"),
            );
        }
    }

    /// 更新的宿主方法（W5g）：不要服务。读状态就地回；检查与应用会读写文件，在工作线程上做。
    fn on_update_call(&mut self, id: u64, name: &str) {
        let Some((coordinator, _)) = &self.updates else {
            self.deliver(&bridge::error(
                id,
                "UPDATE_UNAVAILABLE",
                "更新协调还没有启动",
            ));
            return;
        };
        let principal = atm_ui_bridge::webview(self.generation, self.epoch);
        match name {
            "getUpdateStatus" => {
                let answer = match coordinator.status(&principal) {
                    Ok(status) => bridge::ok(id, json!(status)),
                    Err(e) => bridge::error(id, e.code.as_str(), &e.message),
                };
                self.deliver(&answer);
            }
            "checkForUpdates" => {
                let coordinator = coordinator.clone();
                if !self.take_ui_slot(id) {
                    return;
                }
                let proxy = self.proxy.clone();
                let (generation, epoch) = (self.generation, self.epoch);
                std::thread::spawn(move || {
                    let result = coordinator
                        .check(&principal)
                        .map(|status| json!(status))
                        .map_err(|e| (e.code.as_str().to_owned(), e.message.clone(), None));
                    let _ = proxy.send_event(UserEvent::HostReply {
                        generation,
                        epoch,
                        js_id: id,
                        result,
                    });
                });
            }
            _ => self.apply_update(principal, Some(id)),
        }
    }

    /// 「立即更新」（窗口或托盘，都是 User）：工作线程上重新确认包，有包就交回 UI 线程拉起 setup。
    /// 窗口发起的回 INSTALLING 状态（与 2.0 一样，不等 setup）；托盘发起的不回。
    fn apply_update(&mut self, principal: atm_domain::principal::Principal, id: Option<u64>) {
        let Some((coordinator, _)) = &self.updates else {
            if let Some(id) = id {
                self.deliver(&bridge::error(
                    id,
                    "UPDATE_UNAVAILABLE",
                    "更新协调还没有启动",
                ));
            }
            return;
        };
        let coordinator = coordinator.clone();
        // 窗口发起的要回答，占一个在途名额；托盘发起的不回答，也不占。
        if let Some(id) = id
            && !self.take_ui_slot(id)
        {
            return;
        }
        let proxy = self.proxy.clone();
        let (generation, epoch) = (self.generation, self.epoch);
        std::thread::spawn(move || {
            let result = match coordinator.apply(&principal) {
                Ok(applied) => {
                    if let Some(manifest) = applied.manifest {
                        let _ = proxy.send_event(UserEvent::InstallUpdate(manifest));
                    }
                    Ok(json!(applied.status))
                }
                Err(e) => Err((e.code.as_str().to_owned(), e.message.clone(), None)),
            };
            if let Some(js_id) = id {
                let _ = proxy.send_event(UserEvent::HostReply {
                    generation,
                    epoch,
                    js_id,
                    result,
                });
            }
        });
    }

    /// 复核路径后拉起 `atm-setup --update`（`update.rs`）：它会停掉本实例、装好后带窗口启动新版本。
    /// 复核不过或没能拉起时记 INSTALL_FAILED，当前版本照常用。
    fn install_update(&mut self, manifest: &std::path::Path) {
        let Some((coordinator, _)) = &self.updates else {
            return;
        };
        match crate::update::install(
            &self.layout.app_dir,
            &self.layout.v3_root,
            &manifest.to_string_lossy(),
        ) {
            Ok(()) => crate::log(&self.layout.v3_root, "update installer started"),
            Err(error) => {
                coordinator.launch_failed();
                crate::log(
                    &self.layout.v3_root,
                    &format!("update not started: {error}"),
                );
            }
        }
    }

    /// 看门狗（W5g）：事件循环靠 ping、写线程靠当前作业的时长；挂住就记诊断并结束进程。
    fn start_watchdog(&mut self) {
        let Some(lifecycle) = life::global() else {
            return;
        };
        let proxy = self.proxy.clone();
        let probe = self.writer_probe.clone();
        self.watchdog = Some(Watchdog::start(
            lifecycle,
            Probes {
                ping: Box::new(move || {
                    let _ = proxy.send_event(UserEvent::Ping);
                }),
                pulse: self.pulse.clone(),
                writer: Box::new(move || {
                    probe
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .as_ref()
                        .and_then(|current| current())
                }),
                on_stall: Box::new(watchdog::terminate),
            },
            watchdog_config(),
        ));
    }

    fn on_second_instance(&mut self, command: Command, target: &EventLoopWindowTarget<UserEvent>) {
        match command {
            Command::Show => {
                self.start_service();
                self.request_show(None, target);
            }
            Command::Navigate { route } => {
                self.start_service();
                self.request_show(Some(route.as_str()), target);
            }
            // An Agent woke us: cancel the login delay, stay in the background.
            Command::Wake => self.start_service(),
            Command::Quit => self.quit(),
            #[cfg(feature = "smoke")]
            Command::SmokeQuit => self.quit(),
            // lifecycle 冒烟：Windows 结束会话时窗口过程做的事；之后由冒烟脚本把进程杀掉。
            #[cfg(feature = "smoke")]
            Command::SmokeSessionEnd => crate::session_end::ended(),
            // 看门狗冒烟：让事件循环停住，或让写线程卡在一个预算很小的作业里。
            #[cfg(feature = "smoke")]
            Command::SmokeStallUi => std::thread::sleep(Duration::from_secs(60)),
            #[cfg(feature = "smoke")]
            Command::SmokeStallWriter => {
                if let Service::Serving(serving) = &self.service
                    && let Some((svc, _)) = serving.service()
                {
                    drop(svc.store().submit_with(Duration::from_millis(200), |_| {
                        std::thread::sleep(Duration::from_secs(60));
                        Ok::<(), ()>(())
                    }));
                }
            }
        }
    }

    fn phase(&self) -> Phase {
        match &self.service {
            Service::Idle | Service::Booting | Service::Retrying => Phase::Starting,
            Service::Conflict { .. } => Phase::Conflict,
            Service::Unavailable => Phase::Unavailable,
            Service::Serving(serving) => Phase::Serving {
                open: serving.service().is_some(),
            },
        }
    }

    /// What a renderer call that needs the service gets while the service cannot take it
    /// ([`unavailable_in`]).
    fn unavailable(&self) -> Option<(&'static str, &'static str)> {
        unavailable_in(self.phase())
    }

    /// The service settled (serving, conflict or given up): answer what waited for it.
    fn answer_queued(&mut self) {
        let serving = matches!(self.service, Service::Serving(_));
        if !serving && self.unavailable().is_none() {
            return;
        }
        let queued = std::mem::take(&mut self.queued);
        for call in queued {
            if same_page((call.generation, call.epoch), (self.generation, self.epoch)) {
                self.on_core(call.js_id, &call.method, call.args);
            }
        }
    }

    /// 要服务的宿主方法。`runtimeRequest` 进 ui-bridge（W5e）；更新（W5g）不要服务，先拦下；
    /// Agent 接入与 MCP 观测（W6d）交给 atm-agents，在工作线程上做。
    fn on_core(&mut self, id: u64, method: &Method, args: Vec<Value>) {
        if let Method::Core(name @ ("getUpdateStatus" | "checkForUpdates" | "applyUpdate")) = method
        {
            self.on_update_call(id, name);
            return;
        }
        if let Some((code, message)) = self.unavailable() {
            self.deliver(&bridge::error(id, code, message));
            return;
        }
        if !matches!(self.service, Service::Serving(_)) {
            if self.queued.len() < MAX_QUEUED_CALLS {
                self.queued.push(QueuedCall {
                    generation: self.generation,
                    epoch: self.epoch,
                    js_id: id,
                    method: method.clone(),
                    args,
                });
            } else {
                self.deliver(&bridge::error(id, "SERVICE_BUSY", "服务尚未就绪"));
            }
            return;
        }
        match method {
            Method::Core("runtimeRequest") => self.dispatch_ui(id, &args[0]),
            Method::Core(name) => self.dispatch_agents(id, name, args),
            Method::Local(_) => {}
        }
    }

    /// Agent 接入的七个方法（W6d）：主体是这一代 WebView 的 User，与界面请求共用在途名额。
    fn dispatch_agents(&mut self, id: u64, name: &'static str, args: Vec<Value>) {
        let Service::Serving(serving) = &self.service else {
            return;
        };
        let endpoint = serving.agent_endpoint();
        let Some(agents) = self.agents.clone() else {
            self.deliver(&bridge::error(id, "SERVICE_UNAVAILABLE", "服务暂时不可用"));
            return;
        };
        if !self.take_ui_slot(id) {
            return;
        }
        let principal = atm_ui_bridge::webview(self.generation, self.epoch);
        let proxy = self.proxy.clone();
        let (generation, epoch) = (self.generation, self.epoch);
        let spawned = std::thread::Builder::new()
            .name("atm-agents".into())
            .spawn(move || {
                let result = crate::agents::call(&agents, &principal, name, &args, endpoint);
                let _ = proxy.send_event(UserEvent::HostReply {
                    generation,
                    epoch,
                    js_id: id,
                    result,
                });
            });
        if spawned.is_err() {
            self.ui_in_flight = self.ui_in_flight.saturating_sub(1);
            self.deliver(&bridge::error(id, "SERVICE_BUSY", "服务尚未就绪"));
        }
    }

    /// 占一个界面在途名额：`runtimeRequest` 与更新的检查 / 应用共用（它们各开一个工作线程，不占名额就不受
    /// 上限约束，peer W5 r1 P2-01）。满了就回 SERVICE_BUSY，不排队。名额在应答回到事件循环时释放
    /// （`UiReply` / `HostReply`），旧页面的应答也释放。
    fn take_ui_slot(&mut self, id: u64) -> bool {
        if self.ui_in_flight >= MAX_UI_IN_FLIGHT {
            self.deliver(&bridge::error(id, "SERVICE_BUSY", "界面请求太多，稍后再试"));
            return false;
        }
        self.ui_in_flight += 1;
        true
    }

    /// 界面请求在入口的 tokio 运行时上分发（`spawn_blocking`，与 Agent 入口共用工作线程），主体是这一代
    /// WebView 的 User（`webview(generation, epoch)`）。结果经事件循环交回，投递前再核对代次。
    fn dispatch_ui(&mut self, id: u64, input: &Value) {
        let Service::Serving(serving) = &self.service else {
            return;
        };
        let Some((svc, handle)) = serving.service() else {
            self.deliver(&bridge::error(
                id,
                "SOURCE_CONFLICT",
                "数据源冲突，需要先选择数据源",
            ));
            return;
        };
        let conversion = serving.conversion();
        let mobile = serving.mobile();
        let call = match crate::ui_api::parse(input) {
            Ok(call) => call,
            Err(code) => {
                self.deliver(&bridge::error(id, code, "界面请求不合格"));
                return;
            }
        };
        if !self.take_ui_slot(id) {
            return;
        }
        let version = self.version.clone();
        let ui = self
            .ui
            .get_or_insert_with(|| {
                let started_at =
                    atm_install_state::startup::iso_utc(crate::health::process_started_at_ms());
                let runtime: atm_ui_bridge::RuntimeStatus =
                    Arc::new(move || json!({ "version": version, "conversion": conversion }));
                let ui = Ui::new(svc, runtime, started_at);
                Arc::new(match mobile {
                    Some(m) => ui.with_mobile(m),
                    None => ui,
                })
            })
            .clone();
        let principal = atm_ui_bridge::webview(self.generation, self.epoch);
        let mut reply = PendingReply {
            proxy: self.proxy.clone(),
            generation: self.generation,
            epoch: self.epoch,
            js_id: id,
            sent: false,
        };
        // 运行时已经关闭时任务不会执行：PendingReply 在丢弃时照样交回一个「不可用」，计数与渲染端都不会悬着。
        drop(handle.spawn_blocking(move || {
            #[cfg(feature = "smoke")]
            if let Some((hold, marker)) = crate::ui_api::smoke_hold(&call.target) {
                std::thread::sleep(hold);
                reply.send(Some(Reply {
                    status: 200,
                    body: json!({ "held": marker }),
                }));
                return;
            }
            let answer = ui.dispatch(
                &principal,
                atm_ui_bridge::Request {
                    method: &call.method,
                    target: &call.target,
                    body: call.body.as_deref(),
                },
            );
            reply.send(Some(answer));
        }));
    }

    fn on_ui_reply(&mut self, generation: u64, epoch: u64, js_id: u64, reply: Option<Reply>) {
        self.ui_in_flight = self.ui_in_flight.saturating_sub(1);
        // 应答只交给发出请求的那一代页面（03 U4、P-013）：窗口关过、页面重新加载过，就丢掉。
        if !same_page((generation, epoch), (self.generation, self.epoch)) {
            return;
        }
        match reply {
            Some(reply) => self.deliver(&bridge::ok(js_id, crate::ui_api::response(&reply))),
            None => self.deliver(&bridge::error(
                js_id,
                "SERVICE_UNAVAILABLE",
                "服务暂时不可用",
            )),
        }
    }

    fn deliver(&self, answer: &Value) {
        if let Some(webview) = &self.webview {
            let _ = webview.evaluate_script(&bridge::resolve_script(answer));
        }
    }

    fn emit(&self, name: &str, value: Value) {
        if let Some(webview) = &self.webview {
            let _ = webview.evaluate_script(&bridge::emit_script(name, value));
        }
    }

    fn on_ipc(&mut self, source: &str, body: &str) {
        let call = match bridge::parse(source, body) {
            Ok(call) => call,
            Err(rejected) => {
                crate::log(
                    &self.layout.v3_root,
                    &format!("renderer message rejected: {rejected:?}"),
                );
                return;
            }
        };
        let Call { id, method, args } = call;
        match method {
            Method::Local(local) => self.on_local(id, local, &args),
            core @ Method::Core(_) => self.on_core(id, &core, args),
        }
    }

    fn on_local(&mut self, id: u64, local: Local, args: &[Value]) {
        let value = match local {
            Local::NotifyRendererReady => {
                self.renderer_ready = true;
                crate::health::ui_confirmed(&self.layout, &self.version, &self.run_id);
                self.drain_readiness();
                return;
            }
            Local::GetAutoLaunch => json!(win::autostart_enabled(&self.autostart_target)),
            Local::SetAutoLaunch => {
                let enabled = args[0].as_bool().unwrap_or(false);
                win::set_autostart(&self.autostart_target, enabled);
                json!(win::autostart_enabled(&self.autostart_target))
            }
            Local::CopyText => json!(win::set_clipboard_text(
                args[0].as_str().unwrap_or_default()
            )),
            Local::MinimizeWindow => {
                if let Some(window) = &self.window {
                    window.set_minimized(true);
                }
                Value::Null
            }
            Local::ToggleMaximizeWindow => {
                let maximized = self.window.as_ref().map(|window| {
                    window.set_maximized(!window.is_maximized());
                    window.is_maximized()
                });
                json!(maximized.unwrap_or(false))
            }
            Local::IsWindowMaximized => {
                json!(self.window.as_ref().is_some_and(Window::is_maximized))
            }
            Local::CloseWindow => {
                self.deliver(&bridge::ok(id, Value::Null));
                self.close_window();
                return;
            }
            Local::GetDataSource => self.data_source(),
            Local::ChooseDataSource => {
                let choice = match args[0].as_str() {
                    Some("KEEP_V3") => SourceChoice::KeepV3,
                    _ => SourceChoice::Reconvert,
                };
                match self.choose_source(choice) {
                    Ok(()) => self.data_source(),
                    Err((code, message)) => {
                        self.deliver(&bridge::error(id, code, message));
                        return;
                    }
                }
            }
        };
        self.deliver(&bridge::ok(id, value));
    }

    /// Where the service is, for the window (07 §7). Conflict details carry no credential.
    fn data_source(&self) -> Value {
        if self.choosing {
            return json!({ "state": "STARTING", "choosing": true });
        }
        if let Some(state) = &self.conflict {
            return json!({
                "state": "SOURCE_CONFLICT",
                "cause": conflict_cause(&state.reason),
                "reason": state.reason,
                "since": state.since,
                "error": self.choice_error,
            });
        }
        let state = match &self.service {
            Service::Serving(_) => "SERVING",
            Service::Unavailable => "UNAVAILABLE",
            _ => "STARTING",
        };
        json!({ "state": state, "choosing": false, "error": self.choice_error })
    }

    /// Carry out the user's choice (B2: only this trusted WebView reaches here): hand the
    /// held conflict to a boot thread that records the choice, releases the admission and
    /// starts again. After a background conflict the withdrawn service is stopped first;
    /// that boot finds the conflict on disk and records the choice the same way.
    fn choose_source(&mut self, choice: SourceChoice) -> Result<(), (&'static str, &'static str)> {
        if self.choosing {
            return Err(("SOURCE_CHOICE_RUNNING", "正在按上一次的选择启动"));
        }
        if self.conflict.is_none() || self.quitting {
            return Err(("SOURCE_NOT_IN_CONFLICT", "现在没有需要选择的数据来源"));
        }
        let held = match std::mem::replace(&mut self.service, Service::Booting) {
            Service::Conflict { held } => Some(held),
            Service::Serving(serving) => {
                let root = self.layout.v3_root.clone();
                serving.stop(&move |e| crate::log(&root, &format!("runtime: {e:?}")));
                None
            }
            other => {
                self.service = other;
                return Err(("SOURCE_NOT_IN_CONFLICT", "现在没有需要选择的数据来源"));
            }
        };
        crate::log(
            &self.layout.v3_root,
            &format!("data source chosen by the user: {choice:?}"),
        );
        record(
            Life::SourceChosen,
            &[("reason", json!(format!("{choice:?}")))],
        );
        self.ui = None;
        self.choosing = true;
        self.choice_error = None;
        self.boot_attempt += 1;
        let options = crate::service::options(
            &self.layout,
            &self.version,
            self.handoff.clone(),
            self.proxy.clone(),
        );
        let slot = Arc::new(BootSlot::default());
        self.boot = Some(slot.clone());
        crate::service::spawn_choice(
            options,
            self.boot_attempt,
            self.proxy.clone(),
            slot,
            held,
            choice,
        );
        self.emit_data_source();
        Ok(())
    }

    /// The service settled into serving (`None`) or a conflict: tell the window, mark the
    /// tray, and bring the window up for a conflict (only the user can resolve it).
    fn source_settled(&mut self, conflict: Option<StartupState>) {
        let entered = conflict.is_some();
        self.conflict = conflict;
        self.choosing = false;
        if !entered {
            self.choice_error = None;
        }
        if self.snapshot.needs_source != entered {
            self.snapshot.needs_source = entered;
            if let Some(tray) = &self.tray {
                tray.set_menu(Some(Box::new(tray::menu(&self.snapshot))));
                let _ = tray.set_tooltip(Some(tray::tooltip(&self.snapshot)));
            }
        }
        self.emit_data_source();
        if entered {
            self.request_show_later();
        }
    }

    fn emit_data_source(&self) {
        self.emit("dataSource", self.data_source());
    }

    /// The first window of a foreground start is built on the first turn of the loop that
    /// has a target (`on_init` has none).
    fn request_show_later(&mut self) {
        let _ = self.proxy.send_event(UserEvent::Second(Command::Show));
    }

    fn request_show(
        &mut self,
        route: Option<&'static str>,
        target: &EventLoopWindowTarget<UserEvent>,
    ) {
        self.show_pending = true;
        // An explicit destination (tray menu, NAVIGATE) beats the route saved at close.
        if let Some(route) = route {
            self.route_pending = Some(route.to_owned());
            self.saved.route = None;
        }
        if self.startup_delay_pending {
            self.start_service();
        }
        if self.window.is_none() {
            self.ensure_window(target);
        } else {
            self.drain_readiness();
        }
    }

    /// Readiness gate (window-readiness.ts): show only once the page loaded and the renderer
    /// reported in, or once the wait is abandoned; never show a blank window.
    fn drain_readiness(&mut self) {
        if !self.show_pending || !(self.page_loaded && self.renderer_ready) {
            return;
        }
        let Some(window) = &self.window else { return };
        self.ready_deadline = None;
        self.show_pending = false;
        window.set_visible(true);
        window.set_minimized(false);
        window.set_focus();
        if let Some(route) = self.route_pending.take() {
            self.emit("navigate", json!(route));
        }
    }

    fn on_ready_timeout(&mut self) {
        let Some(deadline) = self.ready_deadline else {
            return;
        };
        if Instant::now() < deadline {
            return;
        }
        // The renderer will not report in (load failure, crash). Showing a window the user
        // can close beats a tray icon that never opens anything.
        crate::log(
            &self.layout.v3_root,
            "renderer did not report ready in time",
        );
        self.renderer_ready = true;
        self.page_loaded = true;
        self.drain_readiness();
    }

    fn ensure_window(&mut self, target: &EventLoopWindowTarget<UserEvent>) {
        if self.window.is_some() {
            return;
        }
        let dark = win::prefers_dark();
        let mut builder = WindowBuilder::new()
            .with_title("AyanamiTaskManager")
            .with_decorations(false)
            .with_undecorated_shadow(true)
            .with_visible(false)
            .with_inner_size(LogicalSize::new(1440.0, 900.0))
            .with_min_inner_size(LogicalSize::new(1100.0, 680.0));
        if let Some((position, size)) = self.saved.bounds {
            builder = builder.with_inner_size(size);
            if on_some_monitor(target, position) {
                builder = builder.with_position(position);
            }
        }
        if self.saved.maximized {
            builder = builder.with_maximized(true);
        }
        if let Ok(icon) = WindowIcon::from_resource(1, None) {
            builder = builder.with_window_icon(Some(icon));
        }
        let window = match builder.build(target) {
            Ok(window) => window,
            Err(error) => {
                crate::log(
                    &self.layout.v3_root,
                    &format!("window creation failed: {error}"),
                );
                return;
            }
        };
        self.generation += 1;
        self.epoch += 1;
        self.page_loaded = false;
        self.renderer_ready = false;
        self.maximized = self.saved.maximized;
        if self.route_pending.is_none() {
            self.route_pending = self.saved.route.take();
        }
        let generation = self.generation;
        let renderer_dir = self.layout.renderer_dir.clone();
        let (ipc_proxy, load_proxy) = (self.proxy.clone(), self.proxy.clone());
        let background = if dark {
            DARK_BACKGROUND
        } else {
            LIGHT_BACKGROUND
        };
        let builder = WebViewBuilder::new_with_web_context(&mut self.web_context)
            .with_https_scheme(true)
            .with_background_color(background)
            .with_devtools(cfg!(feature = "smoke"))
            .with_browser_accelerator_keys(false)
            .with_default_context_menus(false)
            .with_initialization_script(bridge::INIT_SCRIPT)
            .with_custom_protocol("atm".into(), move |_id, request| {
                assets::serve(&renderer_dir, &request)
            })
            .with_ipc_handler(move |request| {
                let _ = ipc_proxy.send_event(UserEvent::Ipc {
                    generation,
                    source: request.uri().to_string(),
                    body: request.body().clone(),
                });
            })
            .with_navigation_handler(assets::navigation_allowed_owned)
            .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny)
            .with_on_page_load_handler(move |event, _url| {
                let _ = load_proxy.send_event(UserEvent::PageLoad {
                    generation,
                    started: matches!(event, PageLoadEvent::Started),
                });
            })
            .with_url(assets::ENTRY_URL);
        // Test builds only: a DevTools endpoint on a port the OS picks. Chromium writes it to
        // `<N>\webview\EBWebView\DevToolsActivePort`, where the smoke scripts read it —
        // nobody guesses a port. Setting the args replaces wry's defaults, so they are repeated.
        #[cfg(feature = "smoke")]
        let builder = builder.with_additional_browser_args(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port=0",
        );
        match builder.build(&window) {
            Ok(webview) => {
                crate::webview_frames::deny_frames(&webview);
                self.webview = Some(webview);
            }
            Err(error) => crate::log(
                &self.layout.v3_root,
                &format!("webview creation failed: {error}"),
            ),
        }
        self.window = Some(window);
        self.ready_deadline = Some(Instant::now() + RENDERER_READY_TIMEOUT);
        record(Life::WindowShown, &rss());
    }

    /// Closing drops the whole WebView (its WebView2 processes exit) and the window; the
    /// service, tray and notifications keep running.
    fn close_window(&mut self) {
        if let Some(route) = self
            .webview
            .as_ref()
            .and_then(|webview| webview.url().ok())
            .and_then(|url| route_from_url(&url))
        {
            self.saved.route = Some(route);
        }
        self.remember_normal_bounds();
        if let Some(window) = &self.window {
            self.saved.maximized = window.is_maximized();
        }
        let had_window = self.window.is_some();
        self.webview = None;
        self.window = None;
        if had_window {
            record(Life::WindowClosed, &rss());
        }
        self.ready_deadline = None;
        self.show_pending = false;
        self.route_pending = None;
        self.queued
            .retain(|call| call.generation != self.generation);
        self.generation += 1;
    }

    /// Maximized or minimized bounds are not the ones to come back to. They are tracked on
    /// every move and resize, not read at close: a window moved, then maximized and closed,
    /// must come back restoring to where it was moved, not to an older position. The state is
    /// read from Windows, not tao's cache (see `win::shown_normal`).
    fn remember_normal_bounds(&mut self) {
        if let Some(window) = &self.window
            && win::shown_normal(window.hwnd())
            && let Ok(position) = window.outer_position()
        {
            self.saved.bounds = Some((position, window.inner_size()));
        }
    }

    fn on_window_event(&mut self, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => self.close_window(),
            WindowEvent::Moved(_) => self.remember_normal_bounds(),
            WindowEvent::Resized(_) => {
                self.remember_normal_bounds();
                let maximized = self.window.as_ref().is_some_and(Window::is_maximized);
                if maximized != self.maximized {
                    self.maximized = maximized;
                    self.emit("maximized", json!(maximized));
                }
            }
            _ => {}
        }
    }

    /// Window and tray go first; then the service shuts down in order (scheduler → HTTP →
    /// daemon.json, the admission last). A boot still running (a conversion) is left to the
    /// process exit: every conversion step is resumable (07 §4).
    fn quit(&mut self) {
        if self.quitting {
            return;
        }
        self.quitting = true;
        record(Life::ShutdownBegin, &[]);
        self.close_window();
        self.tray = None;
        if let Some((_, schedule)) = self.updates.take() {
            schedule.stop();
        }
        let service = std::mem::replace(&mut self.service, Service::Idle);
        if let Service::Serving(serving) = service {
            let log_root = self.layout.v3_root.clone();
            serving.stop(&move |e| crate::log(&log_root, &format!("runtime: {e:?}")));
        }
        // A boot whose result has not reached the event loop yet: if it already began opening the
        // entries, wait for it and withdraw them here (or the boot thread does, seeing the quit);
        // otherwise daemon.json would outlive the process (peer W6 r8).
        if let Some(slot) = self.boot.take() {
            let root = self.layout.v3_root.clone();
            slot.quit(crate::service::OPENING_WAIT, |left| {
                crate::service::settle(left, &root)
            });
        }
        record(Life::ShutdownComplete, &[]);
        if let Some(watchdog) = self.watchdog.take() {
            watchdog.stop();
        }
        if let Some(lifecycle) = life::global() {
            lifecycle.finish(self.exit_code, true);
        }
        crate::log(&self.layout.v3_root, "host quit");
    }
}

/// 一次分发的回执：任务执行完就带结果交回；没执行就被丢掉（运行时关了）时交回 `None`。
struct PendingReply {
    proxy: EventLoopProxy<UserEvent>,
    generation: u64,
    epoch: u64,
    js_id: u64,
    sent: bool,
}

impl PendingReply {
    fn send(&mut self, reply: Option<Reply>) {
        self.sent = true;
        let _ = self.proxy.send_event(UserEvent::UiReply {
            generation: self.generation,
            epoch: self.epoch,
            js_id: self.js_id,
            reply,
        });
    }
}

impl Drop for PendingReply {
    fn drop(&mut self) {
        if !self.sent {
            self.send(None);
        }
    }
}

/// 写线程探针：服务在服务时读它当前的作业（`(已跑的时间, 预算)`），撤下或退出后为空。
type WriterProbe =
    Arc<std::sync::Mutex<Option<Box<dyn Fn() -> Option<(Duration, Duration)> + Send>>>>;

fn record(event: Life, detail: &[(&str, Value)]) {
    if let Some(lifecycle) = life::global() {
        lifecycle.record(event, detail);
    }
}

fn rss() -> Vec<(&'static str, Value)> {
    watchdog::working_set()
        .map(|rss| vec![("rss", json!(rss))])
        .unwrap_or_default()
}

/// smoke 构建可以用 `ATM_SMOKE_WATCHDOG_MS` 把阈值与心跳调短（lifecycle 冒烟）；正式构建固定 120 s / 60 s。
fn watchdog_config() -> watchdog::Config {
    #[cfg(feature = "smoke")]
    if let Some(ms) = std::env::var("ATM_SMOKE_WATCHDOG_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|ms| (500..=600_000).contains(ms))
    {
        return watchdog::Config {
            tick: Duration::from_millis(ms / 4),
            // 心跳比阈值长一些：会话结束的标记写下之后到被杀之间，少被心跳覆盖。
            heartbeat: Duration::from_millis(ms * 3),
            threshold: Duration::from_millis(ms),
        };
    }
    watchdog::Config::default()
}
