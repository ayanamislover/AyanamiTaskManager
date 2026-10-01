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

/// "ATM 修复": finish or undo an interrupted transaction — retrying a failed recovery from
/// the exact step it failed in — then make the root files, the `current` junction and the
/// registrations match `app.json.current` again.
pub fn repair(setup: &mut Setup) -> Result<(), String> {
    let mut unresumable_failure = false;
    if let Some(mut txn) = setup.store.load(&setup.env).map_err(io)? {
        if txn.kind == TxnKind::Uninstall && !txn.is_terminal() {
            return Err("REPAIR_UNINSTALLING: 卸载没有完成，请从系统「应用」里再卸载一次".into());
        }
        if txn.outcome == Some(Outcome::RecoveryFailed) {
            if txn.state == TxnState::Done {
                // A record without a resumable step: only the consistency pass below remains.
                unresumable_failure = true;
            } else {
                say!(
                    "repair: retrying the recovery of {} at {:?} (undo {:?})",
                    txn.id,
                    txn.state,
                    txn.undo
                );
                txn.outcome = None;
                setup.store.save(&txn).map_err(io)?;
            }
        }
        if !txn.is_terminal() && !unresumable_failure {
            let outcome = setup.recover()?;
            say!("repair: recovery finished with {outcome:?}");
            if outcome == Outcome::RecoveryFailed {
                return Err(
                    "REPAIR_RECOVERY_FAILED: 撤销仍然没有完成，原因见安装目录的 state\\setup.log"
                        .into(),
                );
            }
        }
    }
    let pointer = setup
        .store
        .pointer(&setup.env)
        .map_err(io)?
        .ok_or("REPAIR_NOT_INSTALLED: 没有找到已安装的版本，请重新运行安装包")?;
    if let Some(version) = legacy::parse_legacy_pointer(&pointer.current) {
        // The recovery put Electron back: that is the consistent state; its own updater
        // maintains it from here.
        say!("repair: back on Electron {version}");
        return Ok(());
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
    if unresumable_failure {
        // Nothing left to resume, and the files, link and registrations are consistent
        // again: close the failed record so starts are admitted.
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
    }
    say!("repair: {} consistent", pointer.current);
    Ok(())
}

fn launcher_running_from(env: &Env) -> bool {
    let me = std::env::current_exe().unwrap_or_default();
    fsx::is_within(&me, &env.install_root)
}

/// Uninstall keeps user data (§6) and is a transaction like the others (Codex P1-2): its
/// journal entry (state UNINSTALL) holds every start behind the barrier from before the
/// service is stopped until the files are gone, the lock is held for all of the deleting,
/// and a killed or incomplete uninstall is resumed by running it again. Run from inside the
/// install root, it re-runs itself from a temporary copy so the root can be deleted.
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
    let mut setup = Setup::open(env.clone(), crate::txn::Options { force, show: false })?;
    let mut txn = match setup.store.load(env).map_err(io)? {
        Some(txn) if txn.kind == TxnKind::Uninstall && !txn.is_terminal() => {
            say!("uninstall: resuming {}", txn.id);
            txn
        }
        existing => {
            if let Some(existing) = &existing
                && !existing.is_terminal()
                && existing.outcome != Some(Outcome::RecoveryFailed)
                && let Err(error) = setup.recover()
            {
                say!("uninstall: unfinished transaction not recovered ({error}); removing anyway");
            }
            if legacy::detect(&env.install_root).is_some() {
                return Err(
                    "UNINSTALL_LEGACY: 这是旧版（Electron）安装，请用系统「应用」里的卸载".into(),
                );
            }
            let from = setup
                .store
                .pointer(env)
                .ok()
                .flatten()
                .map(|pointer| pointer.current);
            let mut txn = Transaction::new(
                store::new_txn_id(),
                from,
                "uninstall".into(),
                TxnKind::Uninstall,
            );
            txn.started_at_ms = store::now_ms();
            txn.snapshot_complete = true;
            say!("LOCK {} Uninstall {:?}", txn.id, txn.from);
            store::enter(&setup.store, &mut txn, TxnState::Uninstall).map_err(io)?;
            txn
        }
    };
    let left = remove_install(&setup)?;
    if !left.is_empty() {
        say!("uninstall incomplete; in use: {left:?}");
        return Err(format!(
            "UNINSTALL_INCOMPLETE: {} 个文件仍被占用（{}）。关闭使用它们的程序后，从系统「应用」里再卸载一次即可继续。",
            left.len(),
            left[0].display()
        ));
    }
    register::remove_uninstall_entry(env)?;
    store::finish(&setup.store, &mut txn, Outcome::Committed).map_err(io)?;
    let id = txn.id.clone();
    drop(setup);
    finish_removal(env, &id);
    say!("uninstalled {}", env.install_root.display());
    Ok(())
}

/// Everything of the install but `state\` (journal, lock) and `atm-setup.exe` (the Apps
/// list runs it to resume): service stopped, entry points removed, pointer first — from
/// that moment no start resolves a version — then the files. Returns what is still in use.
fn remove_install(setup: &Setup) -> Result<Vec<PathBuf>, String> {
    let env = &setup.env;
    quiesce::stop_new_style(env, true, Duration::from_secs(30))?;
    register::remove_entries(env)?;
    if let LinkState::Link(target) = fsx::link_state(&env.current_link())
        && fsx::same_path(&target, &env.install_root)
    {
        fs::remove_dir(env.current_link()).map_err(io)?;
    }
    setup.store.remove_pointer().map_err(io)?;
    let mut left = Vec::new();
    for entry in fsx::list_dir(&env.install_root) {
        let name = entry
            .file_name()
            .map(|name| name.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if name == atm_install_state::STATE_DIR || name == env::SETUP {
            continue;
        }
        remove_collecting(&entry, &env.install_root, &mut left);
    }
    if left.is_empty() {
        // The install's own records under state\, except the journal and the lock.
        for entry in fsx::list_dir(&env.state_dir()) {
            let name = entry
                .file_name()
                .map(|name| name.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if name != atm_install_state::JOURNAL && name != atm_install_state::LOCK {
                remove_collecting(&entry, &env.install_root, &mut left);
            }
        }
    }
    Ok(left)
}

/// Guarded delete; what cannot go (held open by an Agent's MCP shim, say) is collected,
/// not fought over. Links are removed as links, never followed.
fn remove_collecting(path: &Path, root: &Path, left: &mut Vec<PathBuf>) {
    if fsx::remove_tree_within(path, root).is_ok() {
        return;
    }
    let is_real_dir = fs::symlink_metadata(path)
        .is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink());
    if is_real_dir {
        for child in fsx::list_dir(path) {
            remove_collecting(&child, root, left);
        }
        if fs::remove_dir(path).is_ok() {
            return;
        }
        if fsx::list_dir(path).is_empty() {
            left.push(path.to_path_buf());
        }
    } else if path.exists() || fs::symlink_metadata(path).is_ok() {
        left.push(path.to_path_buf());
    }
}

/// After the lock is released: only single-entry, non-recursive removals. If another setup
/// started in this instant, its files make these fail instead of being deleted.
fn finish_removal(env: &Env, txn_id: &str) {
    let _ = fs::remove_file(env.setup());
    let journal = env.state_dir().join(atm_install_state::JOURNAL);
    if atm_install_state::read_journal(&env.install_root)
        .ok()
        .flatten()
        .is_some_and(|journal| journal.id == txn_id)
    {
        let _ = fs::remove_file(&journal);
    }
    let _ = fs::remove_file(env.state_dir().join(atm_install_state::LOCK));
    let _ = fs::remove_dir(env.state_dir());
    let _ = fs::remove_dir(&env.install_root);
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
