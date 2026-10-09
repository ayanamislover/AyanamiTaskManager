//! Event loop: window/WebView lifecycle, renderer bridge, tray, second instance and the
//! in-process ATM 3 service (W5a; de-electron §4, §5, §8 for the window and the bridge).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use atm_runtime::{Background, BootError, Conflicted, Handoff, Observation, Serving, Started};
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
use crate::paths::Layout;
use crate::service::Booted;
use crate::single_instance::{Command, Primary, Route};
use crate::tray::{self, Snapshot};
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
    /// The boot thread finished attempt `n`.
    Booted(u64, Booted),
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
    /// 观察器（W5f）：要弹的通知、托盘计数的变化、或一轮读失败。
    Observed(Observation),
    /// 托盘切换通知方式的写入结束了（成功时观察器会随后推来新的托盘快照）。
    ModeSet(Result<(), String>),
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
    /// the user chooses (W6, B2).
    Conflict {
        _held: Conflicted,
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
    boot_failures: Vec<Instant>,
    /// The last reason the 2.x service was waited for, logged once per change.
    legacy_wait: Option<String>,
    queued: Vec<QueuedCall>,
    /// 进程内的界面 API（W5e），服务开始服务后第一次界面请求时建好。
    ui: Option<Arc<Ui>>,
    ui_in_flight: usize,
    /// 托盘切换通知方式的次数：给每次写入一个不重复的 op_id。
    mode_writes: u64,

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
        boot_failures: Vec::new(),
        legacy_wait: None,
        queued: Vec::new(),
        ui: None,
        ui_in_flight: 0,
        mode_writes: 0,
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
        self.boot_attempt += 1;
        self.service = Service::Booting;
        let options = crate::service::options(
            &self.layout,
            &self.version,
            self.handoff.clone(),
            self.proxy.clone(),
        );
        crate::service::spawn(options, self.boot_attempt, self.proxy.clone());
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
                self.legacy_wait = None;
                self.service = Service::Serving(serving);
                self.answer_queued();
            }
            Ok(Started::Conflict(conflicted)) => {
                crate::log(
                    &self.layout.v3_root,
                    &format!("SOURCE_CONFLICT: {}", conflicted.state.reason),
                );
                self.service = Service::Conflict { _held: conflicted };
                self.answer_queued();
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
                self.schedule_retry();
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
            UserEvent::Booted(attempt, booted) => self.on_booted(attempt, booted),
            UserEvent::Background(outcome) => self.on_background(outcome),
            UserEvent::Observed(observation) => self.on_observed(observation),
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
                // Installing an update is wired with the update coordinator (W5g).
                Some(tray::Action::InstallUpdate) => {
                    crate::log(&self.layout.v3_root, "tray action not wired yet");
                }
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
        }
    }

    /// What a renderer call that needs the service gets while the service cannot take it.
    /// `None`: still starting (keep it queued) or serving. Serving but withdrawn (a background
    /// comparison found a source conflict) answers like a conflict: the entries are closed.
    fn unavailable(&self) -> Option<(&'static str, &'static str)> {
        match &self.service {
            Service::Idle | Service::Booting | Service::Retrying => None,
            Service::Conflict { .. } => Some(("SOURCE_CONFLICT", "数据源冲突，需要先选择数据源")),
            Service::Unavailable => Some(("SERVICE_UNAVAILABLE", "服务暂时不可用")),
            Service::Serving(serving) if serving.service().is_none() => {
                Some(("SOURCE_CONFLICT", "数据源冲突，需要先选择数据源"))
            }
            Service::Serving(_) => None,
        }
    }

    /// The service settled (serving, conflict or given up): answer what waited for it.
    fn answer_queued(&mut self) {
        let serving = matches!(self.service, Service::Serving(_));
        if !serving && self.unavailable().is_none() {
            return;
        }
        let queued = std::mem::take(&mut self.queued);
        for call in queued {
            if call.generation == self.generation && call.epoch == self.epoch {
                self.on_core(call.js_id, &call.method, call.args);
            }
        }
    }

    /// 要服务的宿主方法。`runtimeRequest` 进 ui-bridge（W5e）；其余在各自的阶段接上之前回明确的「不可用」，
    /// 界面按出错显示，不会等不到回答：更新（W5g）、Agent 接入与 MCP 观测（W6，atm-agents）。
    fn on_core(&mut self, id: u64, method: &Method, args: Vec<Value>) {
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
            // 还没有更新状态（更新协调在 W5g）：与 2.0「没有状态」同一个回答。
            Method::Core("getUpdateStatus") => self.deliver(&bridge::ok(id, Value::Null)),
            Method::Core("checkForUpdates" | "applyUpdate") => self.deliver(&bridge::error(
                id,
                "UPDATE_UNAVAILABLE",
                "更新功能在这个版本里还不可用",
            )),
            _ => self.deliver(&bridge::error(
                id,
                "AGENTS_UNAVAILABLE",
                "Agent 接入管理在这个版本里还不可用",
            )),
        }
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
        let call = match crate::ui_api::parse(input) {
            Ok(call) => call,
            Err(code) => {
                self.deliver(&bridge::error(id, code, "界面请求不合格"));
                return;
            }
        };
        if self.ui_in_flight >= MAX_UI_IN_FLIGHT {
            self.deliver(&bridge::error(id, "SERVICE_BUSY", "界面请求太多，稍后再试"));
            return;
        }
        let version = self.version.clone();
        let ui = self
            .ui
            .get_or_insert_with(|| {
                let started_at =
                    atm_install_state::startup::iso_utc(crate::health::process_started_at_ms());
                let runtime: atm_ui_bridge::RuntimeStatus =
                    Arc::new(move || json!({ "version": version }));
                Arc::new(Ui::new(svc, runtime, started_at))
            })
            .clone();
        self.ui_in_flight += 1;
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
        if generation != self.generation || epoch != self.epoch {
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
        };
        self.deliver(&bridge::ok(id, value));
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
        self.webview = None;
        self.window = None;
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
        self.close_window();
        self.tray = None;
        let service = std::mem::replace(&mut self.service, Service::Idle);
        if let Service::Serving(serving) = service {
            let log_root = self.layout.v3_root.clone();
            serving.stop(&move |e| crate::log(&log_root, &format!("runtime: {e:?}")));
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
