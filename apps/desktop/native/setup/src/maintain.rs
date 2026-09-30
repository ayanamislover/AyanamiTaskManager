//! `--repair`, `--uninstall`, `--status`: the non-transactional entry points.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use atm_install_state::{Outcome, Transaction, TxnKind, TxnState};

use crate::env::{self, Env};
use crate::fsx::{self, LinkState};
use crate::snapshot::{LinkSnapshot, ShortcutSnapshot, Snapshot};
use crate::txn::Setup;
use crate::{legacy, log, procs, quiesce, register, registry, shortcut, store};

fn io(error: std::io::Error) -> String {
    error.to_string()
}

/// Registrations as they are right now, shaped like a snapshot, so COMMIT's rules
/// (keep the Run arguments, keep a desktop shortcut only if the user has one) apply.
fn live(env: &Env) -> Result<Snapshot, String> {
    let mut shortcuts = Vec::new();
    for path in crate::snapshot::shortcut_paths(env) {
        shortcuts.push(ShortcutSnapshot {
            value: shortcut::read(&path)?,
            path,
        });
    }
    Ok(Snapshot {
        txn: "live".into(),
        pointer: None,
        root_files: Vec::new(),
        current_link: LinkSnapshot::Missing,
        uninstall: registry::read_key(&env.uninstall_key)?,
        run: registry::read_value(&env.run_key, env::RUN_VALUE)?,
        shortcuts,
        legacy: None,
    })
}

/// "ATM 修复": finish or undo an interrupted transaction, then make the root files, the
/// `current` junction and the registrations match `app.json.current` again.
pub fn repair(setup: &mut Setup) -> Result<(), String> {
    if let Some(txn) = setup.store.load(&setup.env).map_err(io)?
        && !txn.is_terminal()
    {
        let outcome = setup.recover()?;
        say!("repair: recovery finished with {outcome:?}");
    }
    let pointer = setup
        .store
        .pointer(&setup.env)
        .map_err(io)?
        .ok_or("REPAIR_NOT_INSTALLED: 没有找到安装记录，请重新运行安装包")?;
    if legacy::parse_legacy_pointer(&pointer.current).is_some() {
        return Err("REPAIR_LEGACY: 当前是旧版（Electron）安装，由旧版自己的更新器维护".into());
    }
    let app = setup.env.app_dir(&pointer.current);
    if !legacy::is_new_style_dir(&app) {
        return Err(format!(
            "REPAIR_VERSION_MISSING: app-{} 不完整",
            pointer.current
        ));
    }
    for (from, relative) in env::stable_sources(&app) {
        fsx::replace_file(&setup.env.install_root.join(relative), &from)
            .map_err(|error| format!("{relative}: {error}"))?;
    }
    fsx::retarget_junction(&setup.env.current_link(), &setup.env.install_root).map_err(io)?;
    register::commit(&setup.env, &pointer.current, &live(&setup.env)?, false)?;
    // A RECOVERY_FAILED journal blocks every start; after a successful repair the install
    // is consistent again, which a fresh terminal record says.
    let mut record = Transaction::new(
        format!("repair-{}", store::new_txn_id()),
        Some(pointer.current.clone()),
        pointer.current.clone(),
        TxnKind::Install,
    );
    record.snapshot_complete = true;
    record.state = TxnState::Done;
    record.outcome = Some(Outcome::Committed);
    setup.store.save(&record).map_err(io)?;
    say!("repair: {} consistent", pointer.current);
    Ok(())
}

fn launcher_running_from(env: &Env) -> bool {
    let me = std::env::current_exe().unwrap_or_default();
    fsx::is_within(&me, &env.install_root)
}

/// Uninstall keeps user data (§6). Run from inside the install root, it re-runs itself
/// from a temporary copy so the root can be deleted.
pub fn uninstall(env: &Env, quiet: bool, force: bool) -> Result<(), String> {
    if !quiet
        && !log::confirm(&format!(
            "卸载 AyanamiTaskManager？\n\n你的任务数据会保留在：\n{}",
            env.data_dir.display()
        ))
    {
        return Err("UNINSTALL_CANCELLED".into());
    }
    if launcher_running_from(env) {
        return relaunch_from_temp(env, force);
    }
    {
        let mut setup = Setup::open(env.clone(), crate::txn::Options { force })?;
        if let Some(txn) = setup.store.load(env).map_err(io)?
            && !txn.is_terminal()
        {
            let _ = setup.recover();
        }
        if legacy::detect(&env.install_root).is_some() {
            return Err(
                "UNINSTALL_LEGACY: 这是旧版（Electron）安装，请用系统「应用」里的卸载".into(),
            );
        }
        quiesce::stop_new_style(env, true, Duration::from_secs(30))?;
        register::remove(env)?;
        if let LinkState::Link(target) = fsx::link_state(&env.current_link())
            && fsx::same_path(&target, &env.install_root)
        {
            fs::remove_dir(env.current_link()).map_err(io)?;
        }
    }
    // Lock released (Setup dropped): now the whole root can go.
    let leftovers = remove_root(&env.install_root);
    if leftovers.is_empty() {
        say!("uninstalled {}", env.install_root.display());
    } else {
        say!(
            "uninstalled; {} file(s) still in use: {:?}",
            leftovers.len(),
            leftovers
        );
    }
    Ok(())
}

/// Delete the install root; files held open (an Agent's running MCP shim) are reported,
/// not fought over.
fn remove_root(root: &Path) -> Vec<PathBuf> {
    if fs::remove_dir_all(root).is_ok() {
        return Vec::new();
    }
    let mut left = Vec::new();
    fn walk(dir: &Path, left: &mut Vec<PathBuf>) {
        for entry in fsx::list_dir(dir) {
            let is_link =
                fs::symlink_metadata(&entry).is_ok_and(|meta| meta.file_type().is_symlink());
            if entry.is_dir() && !is_link {
                walk(&entry, left);
                let _ = fs::remove_dir(&entry);
            } else if fs::remove_file(&entry).is_err() && fs::remove_dir(&entry).is_err() {
                left.push(entry);
            }
        }
    }
    walk(root, &mut left);
    let _ = fs::remove_dir(root);
    left
}

fn relaunch_from_temp(env: &Env, force: bool) -> Result<(), String> {
    let me = std::env::current_exe().map_err(io)?;
    let temp = std::env::temp_dir().join(format!("atm-setup-uninstall-{}.exe", std::process::id()));
    fs::copy(&me, &temp).map_err(io)?;
    let mut args = vec!["--uninstall", "--quiet", "--from-temp"];
    if force {
        args.push("--force");
    }
    // Same environment: a drill's sandbox and data root carry over.
    procs::spawn(&temp, &args).map_err(io)?;
    let _ = env;
    Ok(())
}

/// The temporary copy deletes itself once it has exited.
pub fn schedule_self_delete() {
    use std::os::windows::process::CommandExt;
    let Ok(me) = std::env::current_exe() else {
        return;
    };
    let command = format!("ping -n 3 127.0.0.1 >nul & del /f /q \"{}\"", me.display());
    let _ = std::process::Command::new("cmd.exe")
        .raw_arg(format!("/d /c {command}"))
        .creation_flags(0x0800_0000 | 0x0000_0008)
        .spawn();
}

pub fn status(env: &Env) -> serde_json::Value {
    let pointer = atm_install_state::read_pointer(&env.install_root)
        .ok()
        .flatten();
    let journal = atm_install_state::read_journal(&env.install_root)
        .ok()
        .flatten();
    let service = quiesce::service(env)
        .map(|(proc, legacy)| serde_json::json!({ "pid": proc.pid, "legacy": legacy }));
    serde_json::json!({
        "installRoot": env.install_root,
        "dataDir": env.data_dir,
        "sandbox": env.sandbox,
        "pointer": pointer,
        "journal": journal,
        "legacy": legacy::detect(&env.install_root),
        "current": format!("{:?}", fsx::link_state(&env.current_link())),
        "service": service,
        "lockHeld": atm_install_state::lock_held(&env.install_root),
    })
}
