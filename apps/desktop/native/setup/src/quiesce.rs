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
use crate::runtime::Layout;
use crate::{fsx, legacy, log, runtime};

fn file_name_is(path: &Option<std::path::PathBuf>, name: &str) -> bool {
    path.as_ref()
        .and_then(|path| path.file_name())
        .is_some_and(|file| file.to_string_lossy().eq_ignore_ascii_case(name))
}

/// The process holding the service lease and whether it is an Electron 1.x main process.
pub fn service(env: &Env) -> Option<(Proc, bool)> {
    service_with_layout(env).map(|(proc, legacy, _)| (proc, legacy))
}

fn service_with_layout(env: &Env) -> Option<(Proc, bool, Layout)> {
    let (pid, layout) = env.service_lease()?;
    let proc = procs::find(pid)?;
    let legacy = is_legacy(&proc.image, layout, &env.install_root);
    Some((proc, legacy, layout))
}

/// 2.x: the lease holder is the core child, `atm-core.exe`. 3.x (`single`): it is the host
/// image of this install. Electron 1.x holds the lease from a host-named image too, but its
/// lock never declares `single`, so it stays legacy.
fn is_legacy(image: &Option<std::path::PathBuf>, layout: Layout, install_root: &Path) -> bool {
    match layout {
        Layout::HostAndCore => !file_name_is(image, "atm-core.exe"),
        Layout::Single => {
            !(file_name_is(image, crate::env::LAUNCHER)
                && image
                    .as_ref()
                    .is_some_and(|image| fsx::is_within(image, install_root)))
        }
    }
}

pub fn service_running(env: &Env) -> bool {
    service(env).is_some()
}

/// The primary host as `runtime\host.json` records it — only if that process is alive,
/// started when the record says, and is a host image of this install. A 3.x host keeps the
/// record under `N` (it writes nothing in the 2.x root), a 2.x host under the data root.
pub fn recorded_host(env: &Env) -> Option<Proc> {
    host_records(env).into_iter().find_map(|record| {
        let proc = procs::find(record.pid)?;
        let ours = proc.started_at_ms() == record.started_at_ms
            && file_name_is(&proc.image, crate::env::LAUNCHER)
            && proc
                .image
                .as_ref()
                .is_some_and(|image| fsx::is_within(image, &env.install_root));
        ours.then_some(proc)
    })
}

/// Every `runtime\host.json` there is: a 2.x host's under the data root first, then a 3.x
/// host's under `N` (since W5a the 3.x host writes nothing in the 2.x root).
pub fn host_records(env: &Env) -> Vec<ipc::HostRecord> {
    [&env.data_dir, &env.v3_root]
        .into_iter()
        .filter_map(|root| ipc::read_host_record(root))
        .collect()
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

/// Who quiesce waits for and, with `--force`, terminates.
///
/// - 2.x: the core, its host parent, and the recorded host if it is another process.
/// - 3.x single: the lease holder alone — its parent is whatever started it (an Agent, the
///   launcher). A recorded host that is a *different* process contradicts the lease: fail
///   closed rather than let a file widen the set of processes we may terminate.
/// - No lease but a live primary: the recorded host.
fn quiesce_targets(
    service: Option<(&Proc, Layout)>,
    core_parent: Option<&Proc>,
    recorded: Option<&Proc>,
) -> Result<Vec<ProcessIdentity>, String> {
    let mut targets: Vec<ProcessIdentity> = Vec::new();
    match service {
        Some((holder, Layout::Single)) => {
            if let Some(recorded) = recorded
                && (recorded.pid != holder.pid || recorded.created != holder.created)
            {
                return Err(format!(
                    "QUIESCE_IDENTITY_MISMATCH: the single-process lease holder ({}) is not the recorded host ({})",
                    holder.pid, recorded.pid
                ));
            }
            targets.push(holder.identity());
        }
        Some((core, Layout::HostAndCore)) => {
            targets.push(core.identity());
            targets.extend(core_parent.map(Proc::identity));
        }
        None => {}
    }
    if let Some(host) = recorded
        && !targets.iter().any(|target| target.pid == host.pid)
    {
        targets.push(host.identity());
    }
    Ok(targets)
}

pub fn stop_new_style(env: &Env, force: bool, timeout: Duration) -> Result<(), String> {
    let service = service_with_layout(env);
    if let Some((_, true, _)) = &service {
        return Err("QUIESCE_UNEXPECTED_LEGACY_SERVICE".into());
    }
    if service.is_none() && !ipc::primary_alive(&env.data_dir) {
        return Ok(());
    }
    let core_parent = match &service {
        Some((core, _, Layout::HostAndCore)) => {
            let all = procs::snapshot();
            let parent = all.iter().find(|p| p.pid == core.pid).map(|p| p.parent);
            all.into_iter()
                .find(|proc| Some(proc.pid) == parent)
                .filter(|proc| {
                    file_name_is(&proc.image, crate::env::LAUNCHER) && proc.created <= core.created
                })
        }
        _ => None,
    };
    let targets = quiesce_targets(
        service.as_ref().map(|(proc, _, layout)| (proc, *layout)),
        core_parent.as_ref(),
        recorded_host(env).as_ref(),
    )?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn host_records_are_found_under_the_data_root_and_under_n() {
        let dir = std::path::absolute(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("target")
                .join("setup-tests")
                .join("host-records"),
        )
        .unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        let env = Env {
            install_root: dir.join("install"),
            data_dir: dir.join("data"),
            v3_root: dir.join("v3-data"),
            start_menu_dir: dir.join("start-menu"),
            desktop_dir: dir.join("desktop"),
            uninstall_key: r"Software\AyanamiTaskManagerUnitTest\Uninstall".into(),
            run_key: r"Software\AyanamiTaskManagerUnitTest\Run".into(),
            sandbox: true,
        };
        let write = |root: &Path, pid: u32| {
            let path = ipc::host_record_path(root);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, format!(r#"{{"pid":{pid},"startedAtMs":1}}"#)).unwrap();
        };
        let pids = |env: &Env| -> Vec<u32> { host_records(env).iter().map(|r| r.pid).collect() };
        assert!(pids(&env).is_empty());
        // A 3.x host records itself only under N.
        write(&env.v3_root, 30);
        assert_eq!(pids(&env), vec![30]);
        // A 2.x host's record comes first.
        write(&env.data_dir, 20);
        assert_eq!(pids(&env), vec![20, 30]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_lease_layout_tells_3x_from_electron() {
        let root = PathBuf::from(r"C:\Users\u\AppData\Local\AyanamiTaskManager");
        let host = Some(root.join("app-3.0.0").join("AyanamiTaskManager.exe"));
        let core = Some(root.join("app-2.0.0").join("runtime").join("atm-core.exe"));
        let elsewhere = Some(PathBuf::from(r"C:\Temp\AyanamiTaskManager.exe"));
        // 2.x: only the core child is new-style.
        assert!(!is_legacy(&core, Layout::HostAndCore, &root));
        // Electron 1.x: host-named image, no `single` in its lock.
        assert!(is_legacy(&host, Layout::HostAndCore, &root));
        // 3.x: host image of this install, lock says `single`.
        assert!(!is_legacy(&host, Layout::Single, &root));
        // A `single` claim from outside the install root or from another image is not 3.x.
        assert!(is_legacy(&elsewhere, Layout::Single, &root));
        assert!(is_legacy(&core, Layout::Single, &root));
        assert!(is_legacy(&None, Layout::Single, &root));
    }

    fn proc(pid: u32, created: u64, name: &str) -> Proc {
        Proc {
            pid,
            parent: 1,
            image: Some(PathBuf::from(r"C:\i").join(name)),
            created,
        }
    }

    fn pids(targets: &[ProcessIdentity]) -> Vec<u32> {
        targets.iter().map(|t| t.pid).collect()
    }

    #[test]
    fn a_single_service_is_stopped_alone() {
        let holder = proc(10, 100, "AyanamiTaskManager.exe");
        let starter = proc(9, 50, "AyanamiTaskManager.exe");
        // The process that started it is never a target, even if it looks like a host.
        let only = quiesce_targets(Some((&holder, Layout::Single)), Some(&starter), None).unwrap();
        assert_eq!(pids(&only), vec![10]);
        // The recorded host being the same process adds nothing.
        let same = quiesce_targets(Some((&holder, Layout::Single)), None, Some(&holder)).unwrap();
        assert_eq!(pids(&same), vec![10]);
    }

    #[test]
    fn a_recorded_host_that_contradicts_a_single_lease_fails_closed() {
        let holder = proc(10, 100, "AyanamiTaskManager.exe");
        let other = proc(11, 101, "AyanamiTaskManager.exe");
        let recycled = proc(10, 999, "AyanamiTaskManager.exe");
        for recorded in [&other, &recycled] {
            let refused = quiesce_targets(Some((&holder, Layout::Single)), None, Some(recorded));
            assert!(
                refused
                    .as_ref()
                    .is_err_and(|e| e.starts_with("QUIESCE_IDENTITY_MISMATCH")),
                "{refused:?}"
            );
        }
    }

    #[test]
    fn two_process_and_lease_less_targets_are_unchanged() {
        let core = proc(20, 200, "atm-core.exe");
        let host = proc(19, 150, "AyanamiTaskManager.exe");
        let recorded = proc(18, 140, "AyanamiTaskManager.exe");
        let both =
            quiesce_targets(Some((&core, Layout::HostAndCore)), Some(&host), Some(&host)).unwrap();
        assert_eq!(pids(&both), vec![20, 19]);
        let three = quiesce_targets(
            Some((&core, Layout::HostAndCore)),
            Some(&host),
            Some(&recorded),
        )
        .unwrap();
        assert_eq!(pids(&three), vec![20, 19, 18]);
        let lease_less = quiesce_targets(None, None, Some(&recorded)).unwrap();
        assert_eq!(pids(&lease_less), vec![18]);
        assert!(quiesce_targets(None, None, None).unwrap().is_empty());
    }
}
