//! Back to Electron (plan v9 §6 "回到 Electron"): a reverse migration with its own steps
//! and its own failure branch, UNDO_LEGACY. Two snapshots with separate jobs:
//! `state\rollback\migration.json` (read-only history: what Electron's install looked like)
//! and this transaction's SNAPSHOT (how to put B back if anything fails).

use std::time::Duration;

use atm_install_state::{AppPointer, Outcome, Transaction, TxnKind, TxnState};

use crate::env;
use crate::fsx;
use crate::legacy;
use crate::procs;
use crate::quiesce;
use crate::snapshot::{self, Snapshot};
use crate::store;
use crate::txn::Setup;

type Step = Result<(), String>;

fn io(error: std::io::Error) -> String {
    error.to_string()
}

fn migration(setup: &Setup) -> Result<Snapshot, String> {
    fsx::read_json_limited(
        &legacy::migration_record(&setup.env.rollback_dir()),
        16 * 1024 * 1024,
    )
    .map_err(io)?
    .ok_or_else(|| "LEGACY_MIGRATION_RECORD_MISSING".into())
}

fn newstyle_record(setup: &Setup, txn: &Transaction) -> std::path::PathBuf {
    setup.env.txn_dir(&txn.id).join("newstyle.json")
}

pub fn run(setup: &mut Setup, pointer: &AppPointer, version: &str) -> Result<Outcome, String> {
    let record = migration(setup)?;
    let legacy = record
        .legacy
        .clone()
        .ok_or("LEGACY_MIGRATION_RECORD_INCOMPLETE")?;
    let isolated = legacy::isolated_dir(&setup.env.rollback_dir());
    for item in &legacy.items {
        if !isolated.join(item).exists() {
            return Err(format!("LEGACY_ASSET_MISSING: {item}"));
        }
    }
    if !legacy::saved_stub(&setup.env.rollback_dir()).is_file() {
        return Err("LEGACY_STUB_MISSING".into());
    }
    let mut txn = Transaction::new(
        store::new_txn_id(),
        Some(pointer.current.clone()),
        legacy::legacy_pointer(version),
        TxnKind::Legacy,
    );
    txn.started_at_ms = store::now_ms();
    txn.from_running = quiesce::service_running(&setup.env);
    say!("LOCK {} Legacy {} -> {}", txn.id, pointer.current, txn.to);
    store::enter(&setup.store, &mut txn, TxnState::Lock).map_err(io)?;
    // SNAPSHOT of B: only ever used to put B back.
    store::enter(&setup.store, &mut txn, TxnState::Snapshot).map_err(io)?;
    snapshot::take(&setup.env, &txn.id, Some(pointer.clone()), None)?;
    txn.snapshot_complete = true;
    setup.store.save(&txn).map_err(io)?;
    // R_QUIESCE: a failure here leaves B untouched.
    store::enter(&setup.store, &mut txn, TxnState::ReverseQuiesce).map_err(io)?;
    if let Err(error) = quiesce::stop_new_style(&setup.env, true, Duration::from_secs(60)) {
        say!("R_QUIESCE failed: {error}");
        txn.error = Some("R_QUIESCE".into());
        return recover_quiesce(setup, &mut txn).inspect(|_| {
            say!("reverse migration abandoned: {error}");
        });
    }
    match forward(setup, &mut txn, &record, version) {
        Ok(()) => {
            store::finish(&setup.store, &mut txn, Outcome::Committed).map_err(io)?;
            say!("COMMITTED back to Electron {version}");
            Ok(Outcome::Committed)
        }
        Err(error) => {
            say!("{:?} failed: {error}", txn.state);
            txn.error = Some(error.chars().take(64).collect());
            let outcome = undo_legacy(setup, &mut txn, 1)?;
            Err(format!("{error} (outcome {outcome:?})"))
        }
    }
}

fn forward(setup: &mut Setup, txn: &mut Transaction, record: &Snapshot, version: &str) -> Step {
    let env = setup.env.clone();
    let legacy = record
        .legacy
        .as_ref()
        .ok_or("LEGACY_MIGRATION_RECORD_INCOMPLETE")?;
    // R_RESTORE_LEGACY
    store::enter(&setup.store, txn, TxnState::ReverseRestoreLegacy).map_err(io)?;
    legacy::move_items(
        &legacy.items,
        &legacy::isolated_dir(&env.rollback_dir()),
        &env.install_root,
    )?;
    fsx::replace_file(&env.launcher(), &legacy::saved_stub(&env.rollback_dir())).map_err(io)?;
    snapshot::restore_current_link(&env, record)?;
    snapshot::restore_registrations(&env, record)?;
    // R_ISOLATE_NEW: the Squirrel stub starts the highest `app-*`; a new-style directory
    // left in place would win and hand straight back to the launcher, forever.
    store::enter(&setup.store, txn, TxnState::ReverseIsolateNew).map_err(io)?;
    let moved: Vec<String> = fsx::list_dir(&env.install_root)
        .into_iter()
        .filter(|dir| legacy::is_new_style_dir(dir))
        .filter_map(|dir| {
            dir.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .collect();
    fsx::write_json_atomic(&newstyle_record(setup, txn), &moved).map_err(io)?;
    // An earlier round trip (to Electron, forward again) left its copies here; the version
    // directories in the root are the live ones and replace them.
    let newstyle = legacy::newstyle_dir(&env.rollback_dir());
    for name in &moved {
        let stale = newstyle.join(name);
        if stale.exists() {
            fsx::remove_tree_within(&stale, &env.install_root).map_err(io)?;
            say!("R_ISOLATE_NEW replaced the stale {}", stale.display());
        }
    }
    legacy::move_items(&moved, &env.install_root, &newstyle)?;
    // R_POINTER: `legacy:` never equals any `app-x.y.z`, so every new-style admission ends.
    store::enter(&setup.store, txn, TxnState::ReversePointer).map_err(io)?;
    setup
        .store
        .set_pointer(&AppPointer {
            current: legacy::legacy_pointer(version),
            previous: txn.from.clone(),
        })
        .map_err(io)?;
    // R_START_LEGACY
    store::enter(&setup.store, txn, TxnState::ReverseStartLegacy).map_err(io)?;
    if crate::fault::fail_at(TxnState::ReverseStartLegacy) {
        return Err("DRILL_FAIL_AT: R_START_LEGACY".into());
    }
    let identity = setup.restart_legacy(version, txn.started_at_ms)?;
    txn.legacy = Some(identity);
    setup.store.save(txn).map_err(io)?;
    Ok(())
}

/// R_QUIESCE died or failed: B was never touched beyond being stopped.
pub fn recover_quiesce(setup: &mut Setup, txn: &mut Transaction) -> Result<Outcome, String> {
    if txn.from_running
        && !quiesce::service_running(&setup.env)
        && let Some(from) = txn.from.clone()
    {
        store::enter_undo(
            &setup.store,
            txn,
            TxnState::RollbackStart,
            Outcome::Aborted,
            3,
        )
        .map_err(io)?;
        if let Err(error) = setup.start_version(txn, &from) {
            say!("restart {from} failed: {error}");
            store::recovery_failed(&setup.store, txn).map_err(io)?;
            return Ok(Outcome::RecoveryFailed);
        }
    }
    store::finish(&setup.store, txn, Outcome::Aborted).map_err(io)?;
    Ok(Outcome::Aborted)
}

/// UNDO_LEGACY (§6), resumable at `step`.
pub fn undo_legacy(
    setup: &mut Setup,
    txn: &mut Transaction,
    from_step: u8,
) -> Result<Outcome, String> {
    let snap = snapshot::load(&setup.env, &txn.id)?;
    let record = migration(setup)?;
    let mut step = from_step.max(1);
    let mut rounds = 0;
    while step <= 5 {
        store::enter_undo(
            &setup.store,
            txn,
            TxnState::UndoLegacy,
            Outcome::Aborted,
            step,
        )
        .map_err(io)?;
        let result = undo_legacy_step(setup, txn, &snap, &record, step);
        match result {
            Ok(()) => step += 1,
            // Step 3 failing sends us back to step 1, at most three rounds.
            Err(error) if step == 3 && rounds < 2 => {
                rounds += 1;
                say!("UNDO_LEGACY re-seal round {rounds}: {error}");
                step = 1;
            }
            Err(error) => {
                say!("RECOVERY_FAILED at UNDO_LEGACY step {step}: {error}");
                txn.error = Some(error.chars().take(64).collect());
                store::recovery_failed(&setup.store, txn).map_err(io)?;
                return Ok(Outcome::RecoveryFailed);
            }
        }
    }
    store::finish(&setup.store, txn, Outcome::Aborted).map_err(io)?;
    say!(
        "ABORTED: reverse migration undone, still on {}",
        txn.from.as_deref().unwrap_or("?")
    );
    Ok(Outcome::Aborted)
}

fn undo_legacy_step(
    setup: &mut Setup,
    txn: &mut Transaction,
    snap: &Snapshot,
    record: &Snapshot,
    step: u8,
) -> Step {
    let env = setup.env.clone();
    let legacy = record
        .legacy
        .as_ref()
        .ok_or("LEGACY_MIGRATION_RECORD_INCOMPLETE")?;
    match step {
        // 1. Stop the Electron this transaction started, and anything running from app-1.*.
        1 => {
            if let Some(identity) = &txn.legacy {
                procs::terminate(identity);
            }
            for proc in quiesce::legacy_app(&env, u64::MAX) {
                procs::terminate(&proc.identity());
            }
            Ok(())
        }
        // 2. Re-seal: B's launcher back at the root, Electron assets isolated again,
        //    current → install root.
        2 => {
            let launcher = snapshot::saved_root_file(&env, &snap.txn, env::LAUNCHER);
            fsx::replace_file(&env.launcher(), &launcher).map_err(io)?;
            // While Electron ran again its updater may have produced new entries: record them
            // (write-ahead, in the migration record) and seal them away with the rest.
            let items = match legacy::with_new_items(
                &legacy.items,
                legacy::scan_items(&env.install_root),
            ) {
                Some(all) => {
                    let mut updated = record.clone();
                    if let Some(entry) = updated.legacy.as_mut() {
                        entry.items = all.clone();
                    }
                    fsx::write_json_atomic(
                        &legacy::migration_record(&env.rollback_dir()),
                        &updated,
                    )
                    .map_err(io)?;
                    say!(
                        "UNDO_LEGACY: Squirrel added {:?}",
                        &all[legacy.items.len()..]
                    );
                    all
                }
                None => legacy.items.clone(),
            };
            // Undo of R_RESTORE_LEGACY (isolated → root), resumable item by item.
            legacy::move_back(
                &items,
                &legacy::isolated_dir(&env.rollback_dir()),
                &env.install_root,
            )?;
            fsx::retarget_junction(&env.current_link(), &env.install_root).map_err(io)
        }
        // 3. The SEAL invariants, re-established.
        3 => {
            let left = legacy::scan_items(&env.install_root);
            if !left.is_empty() {
                return Err(format!("{left:?} still in the install root"));
            }
            let alive = quiesce::legacy_app(&env, u64::MAX);
            if !alive.is_empty() {
                return Err(format!("{} Electron process(es) alive", alive.len()));
            }
            if quiesce::service(&env).is_some() {
                return Err("lease still held".into());
            }
            if atm_install_state::ipc::primary_alive(&env.data_dir) {
                return Err("a host still holds the single-instance lock".into());
            }
            match fsx::link_state(&env.current_link()) {
                fsx::LinkState::Link(target) if fsx::same_path(&target, &env.install_root) => {
                    Ok(())
                }
                other => Err(format!("current is {other:?}")),
            }
        }
        // 4. B's version directories, pointer, root files and registrations back.
        4 => {
            let moved: Vec<String> =
                fsx::read_json_limited(&newstyle_record(setup, txn), 256 * 1024)
                    .map_err(io)?
                    .unwrap_or_default();
            legacy::move_back(
                &moved,
                &env.install_root,
                &legacy::newstyle_dir(&env.rollback_dir()),
            )?;
            if let Some(pointer) = &snap.pointer {
                setup.store.set_pointer(pointer).map_err(io)?;
            }
            snapshot::restore_root_files(&env, snap)?;
            snapshot::restore_registrations(&env, snap)
        }
        // 5. Restart B if it had been running (ROLLBACK_START, dual-process witness).
        5 => {
            if !txn.from_running || quiesce::service_running(&env) {
                return Ok(());
            }
            let from = txn.from.clone().ok_or("UNDO_LEGACY_WITHOUT_FROM")?;
            store::enter_undo(
                &setup.store,
                txn,
                TxnState::RollbackStart,
                Outcome::Aborted,
                5,
            )
            .map_err(io)?;
            let result = setup.start_version(txn, &from);
            // Stay in UNDO_LEGACY for the journal; the next loop turn finishes.
            txn.state = TxnState::UndoLegacy;
            result
        }
        _ => Ok(()),
    }
}
