//! Root launcher (`<installRoot>\AyanamiTaskManager.exe`, de-electron plan v9 §3.1).
//!
//! Every stable entry lands here: Start-menu/desktop shortcuts, the Run value, the MCP
//! shim's wake-up, and old Agent commands resolved through `<dataDir>\current`. It holds
//! no token and never talks to the daemon. Per start, in milliseconds:
//!
//! 1. barrier — an unfinished install transaction makes it wait for the installer, or run
//!    `atm-setup --recover` if the installer died; RECOVERY_FAILED stops every start;
//! 2. read `app.json.current` and check that version's host exists;
//! 3. route — GUI starts are handed over without waiting; `--cli`/`--doctor`/`--mcp-stdio`
//!    and the Electron-as-node legacy form are run with inherited stdio and their exit code
//!    passed through; Squirrel events exit 0; anything else is an error, never a GUI.
#![windows_subsystem = "windows"]

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use atm_install_state::Outcome;

const INSTALLER_WAIT: Duration = Duration::from_secs(60);
const RECOVERY_WAIT: Duration = Duration::from_secs(300);
use atm_install_state::LEGACY_PREFIX;

const GUI_ARGS: &[&str] = &[
    "--background",
    "--random-startup-delay",
    "--agent-wake",
    "--squirrel-firstrun",
];
const SQUIRREL_EVENTS: &[&str] = &[
    "--squirrel-install",
    "--squirrel-updated",
    "--squirrel-uninstall",
    "--squirrel-obsolete",
];

#[derive(Debug, PartialEq, Eq)]
enum Route {
    Gui(Vec<String>),
    /// Inherited stdio, wait, pass the exit code through.
    Headless(Vec<String>),
    Exit(i32),
    Usage(String),
}

fn route(argv: &[String], electron_run_as_node: bool) -> Route {
    let first = argv.first().map(String::as_str);
    if electron_run_as_node {
        // Validated again by the host; the launcher only decides "not a GUI".
        return Route::Headless(argv.to_vec());
    }
    match first {
        Some("--cli" | "--doctor" | "--mcp-stdio") => Route::Headless(argv.to_vec()),
        Some(event) if SQUIRREL_EVENTS.contains(&event) => Route::Exit(0),
        _ if argv.iter().all(|arg| GUI_ARGS.contains(&arg.as_str())) => Route::Gui(
            argv.iter()
                .filter(|arg| *arg != "--squirrel-firstrun")
                .cloned()
                .collect(),
        ),
        _ => Route::Usage(format!("unknown arguments {argv:?}")),
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn message(text: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONWARNING, MB_OK, MessageBoxW};
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            wide(text).as_ptr(),
            wide("AyanamiTaskManager").as_ptr(),
            MB_OK | MB_ICONWARNING,
        )
    };
}

/// Headless callers (an Agent's MCP spawn, a terminal) must never get a modal dialog.
fn fail(headless: bool, text: &str, code: i32) -> i32 {
    eprintln!("ATM_LAUNCHER: {text}");
    if !headless {
        message(text);
    }
    code
}

/// `app.json` 指着什么。
#[derive(Debug, PartialEq, Eq)]
enum Pointed {
    /// 新式宿主 `app-<current>\AyanamiTaskManager.exe`（文件在不在由调用方看）。
    Host(PathBuf),
    /// `legacy:<1.x>`：装着的是 Electron 1.x，没有新式宿主可以启动。
    Legacy,
    /// 没有 `app.json`，或读不出来。
    Missing,
}

/// 读 `app.json` 并把 `legacy:` 分流出去，再拼宿主路径。首次读取和 `--recover` 之后的再读都只走这里：
/// 恢复期间指针可能变成 `legacy:`，直接拼会得到 `app-legacy:1.4.0`（冒号在 Windows 路径里是备用数据流）
/// （W4i peer r5 P2-01）。
fn pointed(root: &Path) -> Pointed {
    match atm_install_state::read_pointer(root) {
        Ok(Some(pointer)) if pointer.current.starts_with(LEGACY_PREFIX) => Pointed::Legacy,
        Ok(Some(pointer)) => Pointed::Host(
            atm_install_state::app_dir_for(root, &pointer.current).join("AyanamiTaskManager.exe"),
        ),
        _ => Pointed::Missing,
    }
}

fn setup_candidates(root: &Path) -> Vec<PathBuf> {
    let mut candidates = vec![root.join("atm-setup.exe")];
    if let Ok(Some(pointer)) = atm_install_state::read_pointer(root)
        && !pointer.current.starts_with(LEGACY_PREFIX)
    {
        candidates
            .push(atm_install_state::app_dir_for(root, &pointer.current).join("atm-setup.exe"));
    }
    candidates
}

fn run_setup(root: &Path, args: &[&str], wait: bool) -> bool {
    for setup in setup_candidates(root) {
        if !setup.is_file() {
            continue;
        }
        let mut command = Command::new(&setup);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let Ok(mut child) = command.spawn() else {
            continue;
        };
        if !wait {
            return true;
        }
        let deadline = Instant::now() + RECOVERY_WAIT;
        while Instant::now() < deadline {
            if let Ok(Some(status)) = child.try_wait() {
                return status.success();
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        return false;
    }
    false
}

/// The barrier (§3.0 installed-normal). `Err` is the exit code to use.
fn barrier(root: &Path, headless: bool) -> Result<(), i32> {
    let started = Instant::now();
    let mut recovered = false;
    loop {
        let journal = match atm_install_state::read_journal(root) {
            Ok(journal) => journal,
            Err(_) if !recovered => {
                recovered = true;
                run_setup(root, &["--recover", "--quiet"], true);
                continue;
            }
            Err(error) => {
                return Err(fail(
                    headless,
                    &format!("安装状态无法读取（{error}），请运行开始菜单里的「ATM 修复」。"),
                    3,
                ));
            }
        };
        let Some(journal) = journal else {
            return Ok(());
        };
        if journal.outcome == Some(Outcome::RecoveryFailed) {
            return Err(fail(
                headless,
                "上次安装没有完成，请运行开始菜单里的「ATM 修复」。",
                3,
            ));
        }
        if journal.is_terminal() {
            if journal.commit_pending {
                // Registrations left over by COMMIT: finish them in the background.
                run_setup(root, &["--repair", "--quiet"], false);
            }
            return Ok(());
        }
        if atm_install_state::lock_held(root) {
            if started.elapsed() >= INSTALLER_WAIT {
                return Err(fail(
                    headless,
                    "正在安装或更新 AyanamiTaskManager，请稍后再打开。",
                    3,
                ));
            }
            std::thread::sleep(Duration::from_millis(500));
            continue;
        }
        if recovered {
            return Err(fail(
                headless,
                "安装没有完成，请运行开始菜单里的「ATM 修复」。",
                3,
            ));
        }
        recovered = true;
        run_setup(root, &["--recover", "--quiet"], true);
    }
}

fn real_main() -> i32 {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let electron_as_node =
        std::env::var_os("ELECTRON_RUN_AS_NODE").is_some_and(|value| value == "1");
    let decision = route(&argv, electron_as_node);
    let headless = matches!(decision, Route::Headless(_));
    let args = match decision {
        Route::Exit(code) => return code,
        Route::Usage(text) => {
            eprintln!("{text}");
            return 2;
        }
        Route::Gui(args) | Route::Headless(args) => args,
    };
    let Ok(me) = std::env::current_exe() else {
        return 2;
    };
    // Canonicalize: started through `<dataDir>\current`, the root is the junction target.
    let me = std::fs::canonicalize(&me).unwrap_or(me);
    let me = PathBuf::from(me.to_string_lossy().trim_start_matches(r"\\?\"));
    let Some(root) = me.parent().map(Path::to_path_buf) else {
        return 2;
    };
    if let Err(code) = barrier(&root, headless) {
        return code;
    }
    let Pointed::Host(mut host) = pointed(&root) else {
        return fail(
            headless,
            "没有找到已安装的版本，请运行开始菜单里的「ATM 修复」。",
            3,
        );
    };
    if !host.is_file() {
        run_setup(&root, &["--recover", "--quiet"], true);
        host = match pointed(&root) {
            Pointed::Host(host) if host.is_file() => host,
            Pointed::Legacy => {
                return fail(
                    headless,
                    "恢复把 ATM 装回了旧版（1.x），请从旧版的开始菜单项启动。",
                    3,
                );
            }
            _ => {
                return fail(
                    headless,
                    "当前版本的文件不完整，请运行开始菜单里的「ATM 修复」。",
                    3,
                );
            }
        };
    }
    let mut command = Command::new(&host);
    command.args(&args);
    if headless {
        // Inherited stdio: the host (and the Node entry behind it) talks to our caller.
        match command.status() {
            Ok(status) => status.code().unwrap_or(1),
            Err(error) => fail(true, &format!("ATM_HOST_START_FAILED: {error}"), 1),
        }
    } else {
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        match command.spawn() {
            Ok(_) => 0,
            Err(error) => fail(false, &format!("无法启动 AyanamiTaskManager：{error}"), 1),
        }
    }
}

fn main() {
    atm_install_state::stop_std_handle_inheritance();
    std::process::exit(real_main());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| (*arg).to_owned()).collect()
    }

    /// W4i peer r5 P2-01：`app.json` 的 `legacy:` 指针不会被拼成宿主路径；普通版本指向 `app-<v>` 下的宿主。
    #[test]
    fn a_legacy_pointer_never_becomes_a_host_path() {
        let root = std::path::absolute(
            std::env::var_os("CARGO_TARGET_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target")),
        )
        .unwrap()
        .join("launcher-unit")
        .join("pointed");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(pointed(&root), Pointed::Missing);
        let write = |current: &str| {
            std::fs::write(
                root.join(atm_install_state::APP_POINTER),
                format!(r#"{{"current":"{current}"}}"#),
            )
            .unwrap();
        };
        write("legacy:1.4.0");
        assert_eq!(pointed(&root), Pointed::Legacy);
        write("3.0.0");
        assert_eq!(
            pointed(&root),
            Pointed::Host(
                atm_install_state::app_dir_for(&root, "3.0.0").join("AyanamiTaskManager.exe")
            )
        );
        std::fs::write(root.join(atm_install_state::APP_POINTER), b"{nope").unwrap();
        assert_eq!(pointed(&root), Pointed::Missing);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn routes_cover_every_old_and_new_entry() {
        assert_eq!(route(&[], false), Route::Gui(vec![]));
        assert_eq!(
            route(&args(&["--background", "--random-startup-delay"]), false),
            Route::Gui(args(&["--background", "--random-startup-delay"]))
        );
        assert_eq!(
            route(&args(&["--squirrel-firstrun"]), false),
            Route::Gui(vec![])
        );
        assert_eq!(
            route(&args(&["--squirrel-updated", "1.2.2"]), false),
            Route::Exit(0)
        );
        assert_eq!(
            route(&args(&["--mcp-stdio", "--profile", "core"]), false),
            Route::Headless(args(&["--mcp-stdio", "--profile", "core"]))
        );
        assert_eq!(
            route(&args(&[r"C:\d\mcp-stdio.cjs", "--profile", "memory"]), true),
            Route::Headless(args(&[r"C:\d\mcp-stdio.cjs", "--profile", "memory"]))
        );
        assert!(matches!(
            route(&args(&["--cli", "status"]), false),
            Route::Headless(_)
        ));
        // Unknown input is an error, never a GUI start.
        assert!(matches!(
            route(&args(&["--inspect"]), false),
            Route::Usage(_)
        ));
        assert!(matches!(
            route(&args(&["--background", "x"]), false),
            Route::Usage(_)
        ));
    }
}
