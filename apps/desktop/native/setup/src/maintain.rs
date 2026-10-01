//! `--repair`, `--uninstall`, `--status`: the non-transactional entry points.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use atm_install_state::{Outcome, Transaction, TxnKind, TxnState, UndoProgress};

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
    if let Some(mut txn) = setup.store.load(&setup.env).map_err(io)? {
        if txn.kind == TxnKind::Uninstall && !txn.is_terminal() {
            return Err("REPAIR_UNINSTALLING: 卸载没有完成，请从系统「应用」里再卸载一次".into());
        }
        if txn.outcome == Some(Outcome::RecoveryFailed) {
            if txn.state == TxnState::Done {
                // The first implementation closed a failed recovery as DONE: convert it
                // back into the step it failed in, or leave it standing (Codex r2 P2-6).
                let snapshot_loads = crate::snapshot::load(&setup.env, &txn.id).is_ok();
                let migration_record = legacy::migration_record(&setup.env.rollback_dir());
                let Some((state, undo)) =
                    resumable_failure(&txn, snapshot_loads, migration_record.is_file())
                else {
                    return Err(manual_repair(&setup.env, &txn, snapshot_loads));
                };
                say!(
                    "repair: converting the old RECOVERY_FAILED record of {} into {state:?} (undo {undo:?})",
                    txn.id
                );
                txn.state = state;
                txn.undo = Some(undo);
            }
            say!(
                "repair: retrying the recovery of {} at {:?} (undo {:?})",
                txn.id,
                txn.state,
                txn.undo
            );
            txn.outcome = None;
            setup.store.save(&txn).map_err(io)?;
        }
        if !txn.is_terminal() {
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
    // Nothing below may report success over a record that still bars every start.
    if let Some(txn) = setup.store.load(&setup.env).map_err(io)?
        && (!txn.is_terminal() || txn.outcome == Some(Outcome::RecoveryFailed))
    {
        return Err(format!(
            "REPAIR_BARRIER_REMAINS: 安装记录 {} 仍是 {:?}/{:?}，没有修复；原因见安装目录的 state\\setup.log",
            txn.id, txn.state, txn.outcome
        ));
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
    say!("repair: {} consistent", pointer.current);
    Ok(())
}

/// A RECOVERY_FAILED record of the first implementation: state DONE, but `undo` still says
/// which step failed and toward which outcome. Returns the state and progress the current
/// recovery dispatch resumes from — or `None` when the record does not say enough to resume
/// safely (no undo progress, no complete snapshot, no migration record for a reverse
/// migration), in which case it must stay as it is.
///
/// A reverse migration's step 3 is ambiguous: R_QUIESCE recovery (restart B) and UNDO_LEGACY
/// (re-seal) both wrote it. UNDO_LEGACY from step 1 covers either — every step is
/// idempotent and B's own SNAPSHOT is what it restores — and is what a failed re-seal does
/// next anyway.
fn resumable_failure(
    txn: &Transaction,
    snapshot_loads: bool,
    migration_record: bool,
) -> Option<(TxnState, UndoProgress)> {
    let undo = txn.undo?;
    if txn.state != TxnState::Done
        || txn.outcome != Some(Outcome::RecoveryFailed)
        || !txn.snapshot_complete
        || !snapshot_loads
    {
        return None;
    }
    match txn.kind {
        TxnKind::Install | TxnKind::Migrate | TxnKind::Activate => {
            let target_ok = matches!(undo.target, Outcome::Aborted | Outcome::RolledBack);
            (target_ok && (1..=3).contains(&undo.step)).then_some((TxnState::Undo, undo))
        }
        TxnKind::Legacy if migration_record && undo.target == Outcome::Aborted => {
            let step = match undo.step {
                3 => 1,
                step @ (1 | 2 | 4 | 5) => step,
                _ => return None,
            };
            Some((
                TxnState::UndoLegacy,
                UndoProgress {
                    target: Outcome::Aborted,
                    step,
                },
            ))
        }
        _ => None,
    }
}

/// What a person has to do when an old failed record cannot be resumed. The record stays:
/// declaring the install consistent without the undo having run would be a guess.
fn manual_repair(env: &Env, txn: &Transaction, snapshot_loads: bool) -> String {
    let missing = if txn.undo.is_none() {
        "没有记录失败在哪一步"
    } else if !txn.snapshot_complete || !snapshot_loads {
        "撤销所需的快照不完整或已丢失"
    } else {
        "缺少回到 Electron 所需的迁移记录"
    };
    let next = if legacy::detect(&env.install_root).is_some() {
        "安装目录里同时有旧版（Electron）文件，卸载也会拒绝处理：请保持安装目录原样，按日志里最后失败的那一步人工核对后再处理。"
    } else {
        "请从系统「应用」里卸载 AyanamiTaskManager（任务数据会保留），再重新运行安装包。"
    };
    format!(
        "REPAIR_MANUAL_REQUIRED: 上一次撤销失败的记录（{} → {}，事务 {}）来自旧版安装器，{missing}，无法确定安装处于什么状态，因此没有自动修复，也没有把它标记为完成。{next}详情见 {}",
        txn.from.as_deref().unwrap_or("(none)"),
        txn.to,
        txn.id,
        env.state_dir().join("setup.log").display()
    )
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
    remove_shared_names(env);
    drop(setup);
    crate::fault::pause_unlocked();
    finish_removal(env);
    // `state\` is gone by now (or kept by a newer setup's files): this line only reaches
    // stderr, or the temporary copy's own log.
    say!("uninstalled {}", env.install_root.display());
    Ok(())
}

/// Still holding the lock: the root `atm-setup.exe` and the journal. Both are names the
/// next setup writes as soon as *it* holds the lock (FENCE, LOCK), so once the lock is
/// released neither may be deleted by name — that would delete the next install's files
/// (Codex r2 P2-3). What fails here stays behind: harmless, the next FENCE replaces it.
fn remove_shared_names(env: &Env) {
    // Run from the Apps list, the root copy re-ran us from a temporary copy and is exiting.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while let Err(error) = fs::remove_file(env.setup()) {
        if error.kind() == std::io::ErrorKind::NotFound {
            break;
        }
        if std::time::Instant::now() >= deadline {
            say!("uninstall: {} stays ({error})", env::SETUP);
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    let journal = env.state_dir().join(atm_install_state::JOURNAL);
    if let Err(error) = fs::remove_file(&journal)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        say!("uninstall: the finished journal stays ({error})");
    }
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

/// After the lock is released: the lock file and the two (by now empty) directories, no
/// other name. Each is safe against a setup that started in this instant: the lock file
/// cannot be deleted while that setup holds it (opened without sharing) and is recreated
/// when it takes it; a directory with anything of a new install in it is not empty, so
/// `remove_dir` fails instead of deleting it. No log line: it would recreate `state\`.
fn finish_removal(env: &Env) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use atm_install_state::{AppPointer, JOURNAL, LOCK};

    fn scratch_env(name: &str) -> Env {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("target")
            .join("setup-tests")
            .join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let dir = std::path::absolute(dir).unwrap();
        Env {
            install_root: dir.join("install"),
            data_dir: dir.join("data"),
            start_menu_dir: dir.join("start-menu"),
            desktop_dir: dir.join("desktop"),
            // Never opened by these tests; a private name all the same.
            uninstall_key: r"Software\AyanamiTaskManagerUnitTest\Uninstall".into(),
            run_key: r"Software\AyanamiTaskManagerUnitTest\Run".into(),
            sandbox: true,
        }
    }

    fn cleanup(env: &Env) {
        let _ = fs::remove_dir_all(env.install_root.parent().unwrap());
    }

    /// The first implementation's RECOVERY_FAILED: closed as DONE, undo progress kept.
    fn old_failure(kind: TxnKind, undo: Option<UndoProgress>) -> Transaction {
        let mut txn = Transaction::new("t-old".into(), Some("2.0.0".into()), "2.0.1".into(), kind);
        txn.snapshot_complete = true;
        txn.undo = undo;
        txn.state = TxnState::Done;
        txn.outcome = Some(Outcome::RecoveryFailed);
        txn
    }

    fn progress(target: Outcome, step: u8) -> Option<UndoProgress> {
        Some(UndoProgress { target, step })
    }

    #[test]
    fn old_failure_records_resume_where_they_failed_or_not_at_all() {
        let undo = old_failure(TxnKind::Install, progress(Outcome::RolledBack, 2));
        assert_eq!(
            resumable_failure(&undo, true, false),
            Some((TxnState::Undo, progress(Outcome::RolledBack, 2).unwrap()))
        );
        let restart = old_failure(TxnKind::Activate, progress(Outcome::RolledBack, 3));
        assert_eq!(
            resumable_failure(&restart, true, false).map(|(state, undo)| (state, undo.step)),
            Some((TxnState::Undo, 3))
        );
        // Reverse migration: step 5 is UNDO_LEGACY's restart; step 3 is ambiguous with the
        // R_QUIESCE recovery and resumes UNDO_LEGACY from its first step.
        for (step, resumed) in [(1, 1), (2, 2), (3, 1), (4, 4), (5, 5)] {
            let legacy = old_failure(TxnKind::Legacy, progress(Outcome::Aborted, step));
            assert_eq!(
                resumable_failure(&legacy, true, true),
                Some((
                    TxnState::UndoLegacy,
                    progress(Outcome::Aborted, resumed).unwrap()
                )),
                "legacy step {step}"
            );
        }
        // Not enough to resume: the record stays as it is.
        let legacy = old_failure(TxnKind::Legacy, progress(Outcome::Aborted, 5));
        assert_eq!(
            resumable_failure(&legacy, true, false),
            None,
            "no migration record"
        );
        assert_eq!(
            resumable_failure(&undo, false, false),
            None,
            "snapshot missing"
        );
        let mut incomplete = undo.clone();
        incomplete.snapshot_complete = false;
        assert_eq!(resumable_failure(&incomplete, true, false), None);
        let silent = old_failure(TxnKind::Install, None);
        assert_eq!(
            resumable_failure(&silent, true, false),
            None,
            "no undo progress"
        );
        let odd = old_failure(TxnKind::Install, progress(Outcome::Committed, 2));
        assert_eq!(resumable_failure(&odd, true, false), None, "odd target");
        let beyond = old_failure(TxnKind::Install, progress(Outcome::RolledBack, 4));
        assert_eq!(resumable_failure(&beyond, true, false), None, "odd step");
        let uninstall = old_failure(TxnKind::Uninstall, progress(Outcome::Aborted, 1));
        assert_eq!(resumable_failure(&uninstall, true, true), None);
        // The current format keeps its state: not this conversion's business.
        let mut current = undo.clone();
        current.state = TxnState::Undo;
        assert_eq!(resumable_failure(&current, true, false), None);
    }

    /// Codex r2 P2-6: an old failed record that cannot be resumed is never closed as
    /// COMMITTED, and a legacy pointer is no excuse to report success over it.
    #[test]
    fn repair_keeps_an_unresumable_old_failure_and_says_so() {
        let env = scratch_env("repair-old-failure");
        fs::create_dir_all(env.state_dir()).unwrap();
        let journal = env.state_dir().join(JOURNAL);
        fsx::write_json_atomic(
            &env.install_root.join(atm_install_state::APP_POINTER),
            &AppPointer {
                current: legacy::legacy_pointer("1.9.0"),
                previous: Some("2.0.0".into()),
            },
        )
        .unwrap();
        // With undo progress but no snapshot, and without any undo progress at all.
        for record in [
            old_failure(TxnKind::Install, progress(Outcome::RolledBack, 2)),
            old_failure(TxnKind::Legacy, None),
        ] {
            fsx::write_json_atomic(&journal, &record).unwrap();
            let before = fs::read(&journal).unwrap();
            let mut setup = Setup::open(
                env.clone(),
                crate::txn::Options {
                    force: false,
                    show: false,
                },
            )
            .unwrap();
            let error = repair(&mut setup).expect_err("repair must not report success");
            assert!(error.starts_with("REPAIR_MANUAL_REQUIRED"), "{error}");
            assert!(error.contains("t-old"), "{error}");
            drop(setup);
            assert_eq!(fs::read(&journal).unwrap(), before, "record left untouched");
        }
        cleanup(&env);
    }

    /// Codex r2 P2-3: once the lock is released, an uninstall deletes no name another setup
    /// writes — that setup may hold the lock and have written them already.
    #[test]
    fn uninstall_deletes_shared_names_only_under_its_lock() {
        let env = scratch_env("uninstall-names");
        let journal = env.state_dir().join(JOURNAL);
        let lock = store::acquire_lock(&env, Duration::from_secs(1)).unwrap();
        fs::write(env.setup(), b"ours").unwrap();
        fs::write(&journal, b"ours").unwrap();
        remove_shared_names(&env);
        assert!(!env.setup().exists() && !journal.exists());
        drop(lock);

        // The gap: the next setup takes the lock and writes its own files.
        let next = store::acquire_lock(&env, Duration::from_secs(1)).unwrap();
        fs::write(env.setup(), b"next").unwrap();
        fs::write(&journal, b"next").unwrap();
        finish_removal(&env);
        assert_eq!(fs::read(env.setup()).unwrap(), b"next");
        assert_eq!(fs::read(&journal).unwrap(), b"next");
        assert!(env.state_dir().join(LOCK).is_file(), "a held lock stays");
        drop(next);
        // …and a later finish over an install nobody left anything in removes it all.
        fs::remove_file(env.setup()).unwrap();
        fs::remove_file(&journal).unwrap();
        finish_removal(&env);
        assert!(!env.install_root.exists());
        cleanup(&env);
    }
}
