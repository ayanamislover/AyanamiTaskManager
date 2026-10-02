#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! AyanamiTaskManager desktop host: a WebView2 window, the tray and the core supervisor.
//! Replaces the Electron main process (de-electron plan).

mod app;
mod args;
mod assets;
mod bridge;
mod core_process;
mod dpapi;
mod headless;
mod health;
mod identity;
mod notify;
mod paths;
mod probe;
mod session_end;
mod single_instance;
mod tray;
mod update;
mod webview_frames;
mod win;

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use atm_install_state::{Admission, Context, LaunchIntent};

const INSTALLER_WAIT: Duration = Duration::from_secs(60);
const MAX_HOST_LOG_BYTES: u64 = 512 * 1024;

pub fn log(data_dir: &Path, line: &str) {
    let dir = data_dir.join("logs");
    let _ = fs::create_dir_all(&dir);
    let path = dir.join("host.log");
    if fs::metadata(&path).is_ok_and(|metadata| metadata.len() > MAX_HOST_LOG_BYTES) {
        let _ = fs::rename(&path, dir.join("host.1.log"));
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs())
            .unwrap_or_default();
        let _ = writeln!(
            file,
            "{secs} pid={} {}",
            std::process::id(),
            line.replace('\n', " ")
        );
    }
}

fn message_box(text: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};
    let text = win::wide(text);
    let title = win::wide("AyanamiTaskManager");
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        )
    };
}

/// WebView2 and Node read these from the environment and would override what the host
/// configures (debug ports, browser args, user data folders). Remove them before any
/// thread or child exists.
fn scrub_own_environment() {
    let keys: Vec<_> = std::env::vars_os()
        .filter_map(|(key, _)| key.into_string().ok())
        .filter(|key| {
            let upper = key.to_ascii_uppercase();
            upper.starts_with("WEBVIEW2_") || upper == "NODE_OPTIONS"
        })
        .collect();
    for key in keys {
        // SAFETY: single-threaded at this point, nothing else reads the environment.
        unsafe { std::env::remove_var(key) };
    }
}

fn relaunch_through(launcher: &Path, argv: &[String], headless: bool) -> i32 {
    if headless {
        // The caller (an Agent, a script) talks to this process: stdio and the exit code go
        // through to the current version's entry.
        return match Command::new(launcher).args(argv).status() {
            Ok(status) => status.code().unwrap_or(1),
            Err(error) => {
                eprintln!("ATM_CURRENT_VERSION_UNAVAILABLE: {error}");
                2
            }
        };
    }
    match Command::new(launcher).args(argv).spawn() {
        Ok(_) => 0,
        Err(error) => {
            message_box(&format!("无法启动当前版本：{error}"));
            2
        }
    }
}

/// GUI starts explain in a message box; headless entries (CLI, MCP stdio) on stderr — a
/// box nobody sees would hang an Agent's tool call.
fn refuse(headless: bool, text: &str) {
    if headless {
        eprintln!("ATM_INSTALL_STATE: {text}");
    } else {
        message_box(text);
    }
}

fn run_recovery(install_root: &Path, app_dir: &Path) -> bool {
    let candidates = [
        install_root.join("atm-setup.exe"),
        app_dir.join("atm-setup.exe"),
    ];
    let Some(setup) = candidates.iter().find(|path| path.is_file()) else {
        return false;
    };
    Command::new(setup)
        .arg("--recover")
        .status()
        .is_ok_and(|status| status.success())
}

/// §3.0 admission for installed layouts. Returns the exit code to stop with, if any.
/// §3.0 admission, for every physical entry — the headless ones too: a cached
/// `app-<old>\AyanamiTaskManager.exe --mcp-stdio` lands on the current version, and waits
/// out (or is refused by) an unfinished transaction like a GUI start.
fn admit(layout: &paths::Layout, parsed: &args::Args, argv: &[String]) -> Result<Context, i32> {
    let headless = parsed.headless.is_some();
    let intent = match (&parsed.txn_start, &parsed.health_probe) {
        (Some(txn), _) => LaunchIntent::TxnStart(txn.clone()),
        (None, Some(txn)) => LaunchIntent::Probe(txn.clone()),
        _ => LaunchIntent::Normal,
    };
    let started = Instant::now();
    let mut recovered = false;
    loop {
        let context = atm_install_state::detect_context(
            &layout.app_dir,
            &intent,
            atm_install_state::read_journal,
            atm_install_state::lock_held,
        );
        if !layout.packaged && context == Context::Unknown {
            return Ok(Context::Portable);
        }
        let decision = atm_install_state::admit(
            &context,
            atm_install_state::read_pointer,
            atm_install_state::read_journal,
            atm_install_state::lock_held,
        );
        match decision {
            Admission::Proceed => return Ok(context),
            Admission::RedirectToLauncher(root) => {
                return Err(relaunch_through(
                    &root.join("AyanamiTaskManager.exe"),
                    argv,
                    headless,
                ));
            }
            Admission::WaitForInstaller if started.elapsed() < INSTALLER_WAIT => {
                std::thread::sleep(Duration::from_millis(500));
            }
            Admission::WaitForInstaller => {
                refuse(
                    headless,
                    "正在安装或更新 AyanamiTaskManager，请稍后再打开。",
                );
                return Err(3);
            }
            Admission::NeedsRecovery if !recovered => {
                recovered = true;
                let root = layout
                    .app_dir
                    .parent()
                    .map(Path::to_path_buf)
                    .unwrap_or_default();
                if !run_recovery(&root, &layout.app_dir) {
                    refuse(headless, "安装状态不完整，请运行开始菜单里的「ATM 修复」。");
                    return Err(3);
                }
            }
            Admission::NeedsRecovery | Admission::RecoveryFailed => {
                refuse(headless, "安装未完成，请运行开始菜单里的「ATM 修复」。");
                return Err(3);
            }
            Admission::Reject(reason) => {
                log(&layout.data_dir, &format!("admission rejected: {reason}"));
                return Err(2);
            }
        }
    }
}

fn autostart_target(layout: &paths::Layout, context: &Context) -> PathBuf {
    match context {
        Context::InstalledNormal { install_root, .. } | Context::TxnStart { install_root, .. } => {
            install_root.join("AyanamiTaskManager.exe")
        }
        _ => layout.host_exe.clone(),
    }
}

/// `runtime\host.json`: who holds the primary mutex, so setup can stop this host by
/// identity even before (or between) core leases. Stale records are harmless: setup checks
/// pid *and* start time.
fn publish_host_record(data_dir: &Path) {
    let pid = std::process::id();
    let record = atm_install_state::ipc::HostRecord {
        pid,
        started_at_ms: health::process_started_at_ms(),
    };
    let Ok(body) = serde_json::to_value(&record) else {
        return;
    };
    if let Err(error) = health::write_atomically(&data_dir.join("runtime"), "host.json", &body) {
        log(data_dir, &format!("host record not written: {error}"));
    }
}

fn real_main() -> i32 {
    scrub_own_environment();
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let electron_as_node =
        std::env::var_os("ELECTRON_RUN_AS_NODE").is_some_and(|value| value == "1");
    let parsed = match args::parse(&argv, electron_as_node) {
        Ok(parsed) => parsed,
        Err(error) => {
            eprintln!("{error}");
            return 2;
        }
    };
    // Old Squirrel Update.exe may still call these during migration; nothing to do.
    if parsed.squirrel_event.is_some() {
        return 0;
    }
    let layout = match paths::resolve() {
        Ok(layout) => layout,
        Err(error) => {
            eprintln!("{error}");
            return 2;
        }
    };
    if let Some(txn) = &parsed.health_probe {
        // Decided before admission: an unbound probe must not fall into the GUI paths
        // (recovery prompt, redirect), get nothing, and leave nothing in the data root.
        let context = atm_install_state::detect_context(
            &layout.app_dir,
            &LaunchIntent::Probe(txn.clone()),
            atm_install_state::read_journal,
            atm_install_state::lock_held,
        );
        return match &context {
            Context::SetupProbe {
                install_root,
                version,
                txn,
            } => probe::run(&layout, install_root, version, txn),
            _ => 3,
        };
    }
    let context = match admit(&layout, &parsed, &argv) {
        Ok(context) => context,
        Err(code) => return code,
    };
    if let Some(mode) = &parsed.headless {
        return headless::run(&layout, mode);
    }
    let Some(primary) = single_instance::acquire(&layout.data_dir) else {
        let command = if parsed.agent_wake || parsed.background {
            single_instance::Command::Wake
        } else {
            single_instance::Command::Show
        };
        #[cfg(feature = "smoke")]
        let command = if parsed.smoke_quit {
            single_instance::Command::SmokeQuit
        } else {
            command
        };
        single_instance::send(&layout.data_dir, &command, Duration::from_secs(5));
        return 0;
    };
    publish_host_record(&layout.data_dir);
    notify::set_process_identity();
    let version =
        atm_install_state::app_dir_version(&layout.app_dir).unwrap_or_else(|| "dev".into());
    let target = autostart_target(&layout, &context);
    let witness = match &context {
        Context::TxnStart {
            install_root, txn, ..
        } => Some(health::Witness {
            install_root: install_root.clone(),
            txn: txn.clone(),
        }),
        _ => None,
    };
    app::run(layout, parsed, primary, target, version, witness)
}

fn main() {
    // Read-only query for the core and daemon; nothing else of the host runs (identity.rs).
    let mut argv = std::env::args().skip(1);
    match argv.next().as_deref() {
        Some(identity::FLAG) => std::process::exit(identity::run(argv.next().as_deref())),
        // Sealing the phone-sync secrets for the core (dpapi.rs); also nothing else of the host.
        Some(dpapi::FLAG) => std::process::exit(dpapi::run(argv.next().as_deref())),
        _ => {}
    }
    atm_install_state::stop_std_handle_inheritance();
    std::process::exit(real_main());
}
