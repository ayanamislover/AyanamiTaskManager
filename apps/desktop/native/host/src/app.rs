//! Event loop: window/WebView lifecycle, renderer bridge, tray, second instance and the
//! core supervisor (de-electron §4, §5, §8).

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tao::dpi::LogicalSize;
use tao::event::{Event, StartCause, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy, EventLoopWindowTarget};
use tao::platform::windows::{IconExtWindows, WindowBuilderExtWindows};
use tao::window::{Icon as WindowIcon, Window, WindowBuilder};
use tray_icon::menu::MenuEvent;
use tray_icon::{MouseButton, MouseButtonState, TrayIcon, TrayIconEvent};
use wry::{PageLoadEvent, WebContext, WebView, WebViewBuilder, WebViewBuilderExtWindows};

use crate::args::Args;
use crate::assets;
use crate::bridge::{self, Call, Local, Method};
use crate::core_process::{CORE_EXIT_REJECTED, Core, CoreEvent, Launch, Spawn};
use crate::paths::Layout;
use crate::single_instance::{Command, Primary, Route};
use crate::tray::{self, Snapshot};
use crate::win;

/// Upper bound for waiting on the renderer's ready signal (window-readiness.ts).
const RENDERER_READY_TIMEOUT: Duration = Duration::from_secs(10);
const STARTUP_DELAY_MAX_MS: u64 = 5_000;
const CORE_RESTART_WINDOW: Duration = Duration::from_secs(600);
const CORE_RESTART_LIMIT: usize = 5;
const MAX_QUEUED_CALLS: usize = 256;
const LIGHT_BACKGROUND: (u8, u8, u8, u8) = (0xFB, 0xF7, 0xFF, 0xFF);
const DARK_BACKGROUND: (u8, u8, u8, u8) = (0x24, 0x1E, 0x30, 0xFF);

#[derive(Debug)]
pub enum UserEvent {
    Core(u64, CoreEvent),
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
    RestartCore,
}

struct PendingCall {
    generation: u64,
    epoch: u64,
    js_id: u64,
}

struct QueuedCall {
    generation: u64,
    epoch: u64,
    js_id: u64,
    method: &'static str,
    args: Vec<Value>,
}

pub struct App {
    proxy: EventLoopProxy<UserEvent>,
    layout: Layout,
    args: Args,
    run_id: String,
    version: String,
    /// Set when setup started this host with `--txn-start`: the SERVICE_HEALTHY witness goes
    /// to that transaction once the core is ready.
    witness: Option<crate::health::Witness>,
    autostart_target: PathBuf,
    _primary: Primary,

    core: Option<Core>,
    core_generation: u64,
    core_ready: bool,
    core_starting: bool,
    core_restarts: Vec<Instant>,
    queued: Vec<QueuedCall>,
    pending: HashMap<u64, PendingCall>,
    next_core_id: u64,

    web_context: WebContext,
    window: Option<Window>,
    webview: Option<WebView>,
    generation: u64,
    epoch: u64,
    page_loaded: bool,
    renderer_ready: bool,
    show_pending: bool,
    route_pending: Option<&'static str>,
    ready_deadline: Option<Instant>,
    maximized: bool,

    tray: Option<TrayIcon>,
    snapshot: Snapshot,
    startup_delay_pending: bool,
    quitting: bool,
    exit_code: i32,
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

pub fn run(
    layout: Layout,
    args: Args,
    primary: Primary,
    autostart_target: PathBuf,
    version: String,
    witness: Option<crate::health::Witness>,
) -> i32 {
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    crate::session_end::install(&layout.data_dir);
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
        if let Err(error) = crate::single_instance::serve(&layout.data_dir, move |command| {
            let _ = proxy.send_event(UserEvent::Second(command));
        }) {
            crate::log(
                &layout.data_dir,
                &format!("second-instance pipe unavailable: {error}"),
            );
        }
    }
    let web_context = WebContext::new(Some(layout.data_dir.join("webview")));
    let mut app = App {
        proxy,
        show_pending: !args.background,
        startup_delay_pending: args.random_startup_delay && !args.agent_wake,
        layout,
        args,
        run_id: run_id(),
        version,
        witness,
        autostart_target,
        _primary: primary,
        core: None,
        core_generation: 0,
        core_ready: false,
        core_starting: false,
        core_restarts: Vec::new(),
        queued: Vec::new(),
        pending: HashMap::new(),
        next_core_id: 1,
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
        if app.quitting && app.core.is_none() {
            *control_flow = ControlFlow::ExitWithCode(app.exit_code);
        }
    })
}

impl App {
    fn on_init(&mut self) {
        match tray::build(&self.snapshot) {
            Ok(tray) => self.tray = Some(tray),
            Err(error) => crate::log(&self.layout.data_dir, &format!("tray unavailable: {error}")),
        }
        if self.startup_delay_pending {
            let proxy = self.proxy.clone();
            let delay = random_delay();
            std::thread::spawn(move || {
                std::thread::sleep(delay);
                let _ = proxy.send_event(UserEvent::StartupDelayElapsed);
            });
        } else {
            self.start_core();
        }
    }

    fn start_core(&mut self) {
        if self.core.is_some() || self.core_starting || self.quitting {
            return;
        }
        self.startup_delay_pending = false;
        self.core_starting = true;
        self.core_generation += 1;
        let generation = self.core_generation;
        let proxy = self.proxy.clone();
        let launch = Launch {
            background: self.args.background,
            agent_wake: self.args.agent_wake,
            random_startup_delay: self.args.random_startup_delay,
        };
        match Core::spawn(
            &self.layout.core,
            &self.layout.data_dir,
            Spawn {
                run_id: &self.run_id,
                version: &self.version,
                launch,
                probe_txn: None,
                stderr_log: Some(self.layout.data_dir.join("logs").join("core-stderr.log")),
            },
            move |event| {
                let _ = proxy.send_event(UserEvent::Core(generation, event));
            },
        ) {
            Ok(core) => {
                crate::session_end::set_core(Some(core.session_marker()));
                self.core = Some(core);
            }
            Err(error) => {
                self.core_starting = false;
                crate::log(&self.layout.data_dir, &error);
                self.schedule_core_restart();
            }
        }
    }

    fn schedule_core_restart(&mut self) {
        let now = Instant::now();
        self.core_restarts
            .retain(|at| now.duration_since(*at) < CORE_RESTART_WINDOW);
        if self.core_restarts.len() >= CORE_RESTART_LIMIT {
            crate::log(
                &self.layout.data_dir,
                "core keeps failing; giving up until the next start",
            );
            self.reject_all_calls("CORE_UNAVAILABLE");
            return;
        }
        self.core_restarts.push(now);
        let backoff = Duration::from_secs(1 << self.core_restarts.len().min(4));
        let proxy = self.proxy.clone();
        std::thread::spawn(move || {
            std::thread::sleep(backoff);
            let _ = proxy.send_event(UserEvent::RestartCore);
        });
    }

    fn on_user_event(&mut self, event: UserEvent, target: &EventLoopWindowTarget<UserEvent>) {
        match event {
            UserEvent::StartupDelayElapsed => self.start_core(),
            UserEvent::RestartCore => self.start_core(),
            UserEvent::Core(generation, event) if generation == self.core_generation => {
                self.on_core_event(event, target)
            }
            UserEvent::Core(..) => {}
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
                Some(tray::Action::NotificationMode(mode)) => {
                    if let Some(core) = self.core.as_ref().filter(|_| self.core_ready) {
                        let id = self.next_core_id;
                        self.next_core_id += 1;
                        core.request(id, "setNotificationMode", json!([mode]));
                    }
                }
                Some(tray::Action::Quit) => self.quit(),
                None => {}
            },
        }
    }

    fn on_second_instance(&mut self, command: Command, target: &EventLoopWindowTarget<UserEvent>) {
        match command {
            Command::Show => {
                self.start_core();
                self.request_show(None, target);
            }
            Command::Navigate { route } => {
                self.start_core();
                self.request_show(Some(route.as_str()), target);
            }
            // An Agent woke us: cancel the login delay, stay in the background.
            Command::Wake => self.start_core(),
            Command::Quit => self.quit(),
            #[cfg(feature = "smoke")]
            Command::SmokeQuit => self.quit(),
        }
    }

    fn on_core_event(&mut self, event: CoreEvent, target: &EventLoopWindowTarget<UserEvent>) {
        match event {
            CoreEvent::Ready(frame) => {
                if let Some(witness) = &self.witness {
                    crate::health::service_witness(witness, &self.version, &self.run_id, &frame);
                }
                self.core_starting = false;
                self.core_ready = true;
                let queued = std::mem::take(&mut self.queued);
                for call in queued {
                    self.forward(call);
                }
                if self.show_pending && self.window.is_none() {
                    self.ensure_window(target);
                }
            }
            CoreEvent::Response { id, frame } => {
                let Some(pending) = self.pending.remove(&id) else {
                    return;
                };
                if pending.generation != self.generation || pending.epoch != self.epoch {
                    return;
                }
                let mut answer = json!({ "id": pending.js_id, "ok": frame.get("ok").cloned().unwrap_or(Value::Bool(false)) });
                if let Some(value) = frame.get("value") {
                    answer["value"] = value.clone();
                }
                if let Some(error) = frame.get("error") {
                    answer["error"] = error.clone();
                }
                self.deliver(&answer);
            }
            CoreEvent::Tray(snapshot) => {
                if let Ok(snapshot) = serde_json::from_value::<Snapshot>(snapshot)
                    && snapshot != self.snapshot
                {
                    self.snapshot = snapshot;
                    if let Some(tray) = &self.tray {
                        tray.set_menu(Some(Box::new(tray::menu(&self.snapshot))));
                    }
                }
            }
            // Only the install probe asks for this; a service core never sends it.
            CoreEvent::Probed(_) => {}
            CoreEvent::Notify { title, body } => {
                crate::notify::show(&self.layout.data_dir, &title, &body)
            }
            CoreEvent::Fatal { code, message } => {
                crate::log(
                    &self.layout.data_dir,
                    &format!("core fatal {code}: {message}"),
                );
            }
            CoreEvent::Exited(code) => {
                crate::session_end::set_core(None);
                self.core = None;
                self.core_ready = false;
                self.core_starting = false;
                let lost: Vec<u64> = self.pending.keys().copied().collect();
                for id in lost {
                    if let Some(pending) = self.pending.remove(&id)
                        && pending.generation == self.generation
                        && pending.epoch == self.epoch
                    {
                        // A write may or may not have happened; say so instead of retrying.
                        self.deliver(&bridge::error(
                            pending.js_id,
                            "CORE_RESTARTED",
                            "服务已重启，这次操作的结果未知，请刷新后确认",
                        ));
                    }
                }
                if self.quitting {
                    return;
                }
                if code == Some(CORE_EXIT_REJECTED) {
                    crate::log(&self.layout.data_dir, "core rejected this host (exit 64)");
                    self.exit_code = 1;
                    self.quit();
                    return;
                }
                crate::log(
                    &self.layout.data_dir,
                    &format!("core exited unexpectedly: {code:?}"),
                );
                self.schedule_core_restart();
            }
        }
    }

    fn reject_all_calls(&mut self, code: &str) {
        let queued = std::mem::take(&mut self.queued);
        for call in queued {
            if call.generation == self.generation && call.epoch == self.epoch {
                self.deliver(&bridge::error(call.js_id, code, "服务暂时不可用"));
            }
        }
    }

    fn forward(&mut self, call: QueuedCall) {
        if call.generation != self.generation || call.epoch != self.epoch {
            return;
        }
        let Some(core) = self.core.as_ref() else {
            self.deliver(&bridge::error(
                call.js_id,
                "CORE_UNAVAILABLE",
                "服务暂时不可用",
            ));
            return;
        };
        let id = self.next_core_id;
        self.next_core_id += 1;
        self.pending.insert(
            id,
            PendingCall {
                generation: call.generation,
                epoch: call.epoch,
                js_id: call.js_id,
            },
        );
        core.request(id, call.method, Value::Array(call.args));
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
                    &self.layout.data_dir,
                    &format!("renderer message rejected: {rejected:?}"),
                );
                return;
            }
        };
        let Call { id, method, args } = call;
        match method {
            Method::Local(local) => self.on_local(id, local, &args),
            Method::Core(name) => {
                let queued = QueuedCall {
                    generation: self.generation,
                    epoch: self.epoch,
                    js_id: id,
                    method: name,
                    args,
                };
                if self.core_ready {
                    self.forward(queued);
                } else if self.queued.len() < MAX_QUEUED_CALLS {
                    self.queued.push(queued);
                } else {
                    self.deliver(&bridge::error(id, "CORE_BUSY", "服务尚未就绪"));
                }
            }
        }
    }

    fn on_local(&mut self, id: u64, local: Local, args: &[Value]) {
        let value = match local {
            Local::NotifyRendererReady => {
                self.renderer_ready = true;
                if let Some(core) = &self.core {
                    core.event("renderer-ready");
                }
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
            Local::ShowItemInFolder => {
                win::show_item_in_folder(args[0].as_str().unwrap_or_default());
                Value::Null
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

    fn request_show(
        &mut self,
        route: Option<&'static str>,
        target: &EventLoopWindowTarget<UserEvent>,
    ) {
        self.show_pending = true;
        if route.is_some() {
            self.route_pending = route;
        }
        if self.startup_delay_pending {
            self.start_core();
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
            &self.layout.data_dir,
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
        if let Ok(icon) = WindowIcon::from_resource(1, None) {
            builder = builder.with_window_icon(Some(icon));
        }
        let window = match builder.build(target) {
            Ok(window) => window,
            Err(error) => {
                crate::log(
                    &self.layout.data_dir,
                    &format!("window creation failed: {error}"),
                );
                return;
            }
        };
        self.generation += 1;
        self.epoch += 1;
        self.page_loaded = false;
        self.renderer_ready = false;
        self.maximized = false;
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
        match builder.build(&window) {
            Ok(webview) => {
                crate::webview_frames::deny_frames(&webview);
                self.webview = Some(webview);
            }
            Err(error) => crate::log(
                &self.layout.data_dir,
                &format!("webview creation failed: {error}"),
            ),
        }
        self.window = Some(window);
        self.ready_deadline = Some(Instant::now() + RENDERER_READY_TIMEOUT);
        if let Some(core) = &self.core {
            core.event("window-shown");
        }
    }

    /// Closing drops the whole WebView (its WebView2 processes exit) and the window; the
    /// core, tray and notifications keep running.
    fn close_window(&mut self) {
        self.webview = None;
        self.window = None;
        self.ready_deadline = None;
        self.show_pending = false;
        self.route_pending = None;
        self.pending
            .retain(|_, pending| pending.generation != self.generation);
        self.queued
            .retain(|call| call.generation != self.generation);
        self.generation += 1;
        if let Some(core) = &self.core {
            core.event("window-closed");
        }
    }

    fn on_window_event(&mut self, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => self.close_window(),
            WindowEvent::Resized(_) => {
                let maximized = self.window.as_ref().is_some_and(Window::is_maximized);
                if maximized != self.maximized {
                    self.maximized = maximized;
                    self.emit("maximized", json!(maximized));
                }
            }
            _ => {}
        }
    }

    fn quit(&mut self) {
        if self.quitting {
            return;
        }
        self.quitting = true;
        self.close_window();
        self.tray = None;
        if let Some(core) = self.core.take() {
            core.shutdown();
            core.wait_or_kill(Duration::from_secs(8));
        }
    }
}
