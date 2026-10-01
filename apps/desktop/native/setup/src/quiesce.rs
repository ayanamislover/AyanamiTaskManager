//! QUIESCE / UNDO_STOP / R_QUIESCE: stop the running service before the pointer moves.
//!
//! New-style: QUIT over the second-instance pipe, the host shuts the core down gracefully
//! (lease released, daemon.json cleared). Electron 1.x does not know that pipe: the user is
//! asked to quit it from the tray, and only an explicit `--force` terminates it — by pid
//! *and* creation time, never by name.
//!
//! Electron-as-node MCP bridges left over from old Agent sessions are not waited for: they
//! hold no lease, read daemon.json on every call, and wake through `current`, which by then
//! is the root launcher. Waiting for them would wait on Agent sessions (plan v9 deviation,
//! recorded in ATM).

use std::path::Path;
use std::time::{Duration, Instant};

use atm_install_state::ProcessIdentity;
use atm_install_state::ipc::{self, Command};

use crate::env::Env;
use crate::procs::{self, Proc};
use crate::{fsx, legacy, log, runtime};

fn file_name_is(path: &Option<std::path::PathBuf>, name: &str) -> bool {
    path.as_ref()
        .and_then(|path| path.file_name())
        .is_some_and(|file| file.to_string_lossy().eq_ignore_ascii_case(name))
}

/// The process holding the service lease and whether it is an Electron 1.x main process.
pub fn service(env: &Env) -> Option<(Proc, bool)> {
    let pid = runtime::lease_holder(&env.runtime_dir())?;
    let proc = procs::find(pid)?;
    let legacy = !file_name_is(&proc.image, "atm-core.exe");
    Some((proc, legacy))
}

pub fn service_running(env: &Env) -> bool {
    service(env).is_some()
}

/// The primary host as `runtime\host.json` records it — only if that process is alive,
/// started when the record says, and is a host image of this install.
pub fn recorded_host(env: &Env) -> Option<Proc> {
    let record = ipc::read_host_record(&env.data_dir)?;
    let proc = procs::find(record.pid)?;
    let ours = proc.started_at_ms() == record.started_at_ms
        && file_name_is(&proc.image, crate::env::LAUNCHER)
        && proc
            .image
            .as_ref()
            .is_some_and(|image| fsx::is_within(image, &env.install_root));
    ours.then_some(proc)
}

/// Any new-style instance for this data root: a lease holder, or a primary host without
/// one yet — waiting out `--random-startup-delay`, or between core restarts (Codex P1-1).
pub fn new_style_alive(env: &Env) -> bool {
    matches!(service(env), Some((_, false))) || ipc::primary_alive(&env.data_dir)
}

fn drained(env: &Env, targets: &[ProcessIdentity]) -> bool {
    targets.iter().all(|target| !procs::alive(target)) && !new_style_alive(env)
}

fn wait_drained(env: &Env, targets: &[ProcessIdentity], timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if drained(env, targets) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

pub fn stop_new_style(env: &Env, force: bool, timeout: Duration) -> Result<(), String> {
    let service = service(env);
    if let Some((_, true)) = &service {
        return Err("QUIESCE_UNEXPECTED_LEGACY_SERVICE".into());
    }
    if service.is_none() && !ipc::primary_alive(&env.data_dir) {
        return Ok(());
    }
    let mut targets: Vec<ProcessIdentity> = Vec::new();
    if let Some((core, _)) = &service {
        let all = procs::snapshot();
        let parent = all.iter().find(|p| p.pid == core.pid).map(|p| p.parent);
        let host = all
            .iter()
            .find(|proc| Some(proc.pid) == parent)
            .filter(|proc| {
                file_name_is(&proc.image, crate::env::LAUNCHER) && proc.created <= core.created
            });
        targets.push(core.identity());
        targets.extend(host.map(Proc::identity));
    }
    if let Some(host) = recorded_host(env)
        && !targets.iter().any(|target| target.pid == host.pid)
    {
        targets.push(host.identity());
    }
    let delivered = ipc::send(&env.data_dir, &Command::Quit, Duration::from_secs(5));
    say!(
        "quiesce: QUIT delivered={delivered} targets={:?}",
        targets.iter().map(|target| target.pid).collect::<Vec<_>>()
    );
    if wait_drained(env, &targets, timeout) {
        return Ok(());
    }
    if !force {
        return Err("QUIESCE_TIMEOUT: the running ATM did not exit".into());
    }
    say!("quiesce: --force, terminating by identity");
    for target in targets.iter().rev() {
        procs::terminate(target);
    }
    if wait_drained(env, &targets, Duration::from_secs(10)) {
        Ok(())
    } else if ipc::primary_alive(&env.data_dir) {
        Err("QUIESCE_PRIMARY_UNKNOWN: a host holds the single-instance lock and is not the recorded one".into())
    } else {
        Err("QUIESCE_TERMINATE_FAILED".into())
    }
}

/// Electron 1.x app processes (main + renderer/GPU helpers), told apart from lingering
/// Electron-as-node MCP bridges by the process tree: the app has helpers or holds the lease,
/// a bridge is a lone child of an Agent.
pub fn legacy_app(env: &Env, before_ms: u64) -> Vec<Proc> {
    let all = procs::snapshot();
    let current_exe = env.current_link().join(crate::env::LAUNCHER);
    let isolated = legacy::isolated_dir(&env.rollback_dir());
    // Squirrel's updater: no lease, no helpers, not under an app dir — and it rebuilds
    // `app-*` directories and entries while it runs, so it is always part of the app.
    let updater = env.install_root.join("Update.exe");
    let is_updater = |proc: &Proc| {
        proc.image.as_ref().is_some_and(|image| {
            fsx::same_path(image, &updater)
                || (fsx::is_within(image, &isolated) && file_name_is(&proc.image, "Update.exe"))
        })
    };
    let is_candidate = |proc: &Proc| {
        let Some(image) = &proc.image else {
            return false;
        };
        let in_electron_dir = fsx::list_dir(&env.install_root)
            .iter()
            .filter(|dir| legacy::is_electron_dir(dir))
            .any(|dir| fsx::is_within(image, dir));
        let via_current = fsx::same_path(image, &current_exe) && proc.started_at_ms() < before_ms;
        in_electron_dir || via_current || fsx::is_within(image, &isolated)
    };
    let candidates: Vec<&Proc> = all.iter().filter(|proc| is_candidate(proc)).collect();
    let lease = runtime::lease_holder(&env.runtime_dir());
    candidates
        .iter()
        .filter(|proc| {
            Some(proc.pid) == lease
                || candidates.iter().any(|other| other.pid == proc.parent)
                || candidates.iter().any(|other| other.parent == proc.pid)
        })
        .map(|proc| (*proc).clone())
        .chain(all.iter().filter(|proc| is_updater(proc)).cloned())
        .collect()
}

pub fn stop_legacy(
    env: &Env,
    force: bool,
    before_ms: u64,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let mut asked = false;
    loop {
        let app = legacy_app(env, before_ms);
        if app.is_empty() {
            return Ok(());
        }
        if force {
            say!(
                "quiesce legacy: --force, terminating {} process(es)",
                app.len()
            );
            // Main process first (it has no candidate parent), helpers follow it down.
            for proc in app
                .iter()
                .filter(|proc| !app.iter().any(|other| other.pid == proc.parent))
            {
                procs::terminate(&proc.identity());
            }
            for proc in &app {
                procs::terminate(&proc.identity());
            }
            let identities: Vec<ProcessIdentity> = app.iter().map(Proc::identity).collect();
            if !procs::wait_all_gone(&identities, Duration::from_secs(10)) {
                return Err("QUIESCE_TERMINATE_FAILED".into());
            }
            continue;
        }
        if Instant::now() >= deadline {
            return Err("LEGACY_STILL_RUNNING: 旧版 ATM 没有退出".into());
        }
        if !asked || Instant::now() + Duration::from_secs(1) >= deadline {
            asked = true;
            if !log::confirm(
                "旧版 AyanamiTaskManager 仍在运行。\n\n请在任务栏托盘的 ATM 图标上右键，选择「完全退出」，然后点「确定」继续安装。\n点「取消」放弃这次安装，旧版保持不变。",
            ) {
                return Err("LEGACY_QUIT_DECLINED".into());
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// UNDO_STOP: the host setup itself started (START / ROLLBACK_START), and any service
/// whose core runs from `app_dir`.
pub fn stop_started(
    env: &Env,
    started: Option<&ProcessIdentity>,
    app_dir: &Path,
) -> Result<(), String> {
    if let Some((core, false)) = service(env)
        && core
            .image
            .as_ref()
            .is_some_and(|image| fsx::is_within(image, app_dir))
    {
        stop_new_style(env, true, Duration::from_secs(30))?;
    }
    if let Some(started) = started
        && procs::alive(started)
    {
        let _ = ipc::send(&env.data_dir, &Command::Quit, Duration::from_secs(3));
        if !procs::wait_all_gone(std::slice::from_ref(started), Duration::from_secs(20)) {
            procs::terminate(started);
            procs::wait_all_gone(std::slice::from_ref(started), Duration::from_secs(10));
        }
    }
    // Probe or START leftovers from this version (setup started them; they are ours).
    for proc in procs::under(app_dir) {
        procs::terminate(&proc.identity());
    }
    Ok(())
}
