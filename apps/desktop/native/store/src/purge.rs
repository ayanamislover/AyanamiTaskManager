//! Remove one project's live rows from ATM 3's shared database.
//!
//! This is deliberately a transaction helper, not a public deletion operation. The caller must
//! enforce User-only confirmation, serialize with backup/attachment operations, and finish the
//! external marker/attachment cleanup. Old whole-database backups are never touched here.

use crate::Store;
use crate::backup::{AttachmentsGuard, attachments_lock};
use crate::restore::refuse_pending_swaps;
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Value, json};
use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

const STAGING: &str = ".purge-staging";

#[derive(Debug)]
pub enum PurgeError {
    NotFound,
    NotTrashed,
    VersionChanged,
    ActiveDispatch,
    SyncEnabled,
    Storage(String),
    /// The SQL commit succeeded. Startup will retry the remaining file cleanup before exposing
    /// the service. A caller must never describe this as a rolled-back deletion.
    CleanupPending(String),
}

impl std::fmt::Display for PurgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => write!(f, "project not found"),
            Self::NotTrashed => write!(f, "project must be in the trash"),
            Self::VersionChanged => write!(f, "project changed after confirmation"),
            Self::ActiveDispatch => write!(f, "project still has a queued or running dispatch"),
            Self::SyncEnabled => write!(
                f,
                "disable mobile sync before permanently deleting a project"
            ),
            Self::Storage(e) => write!(f, "project deletion storage error: {e}"),
            Self::CleanupPending(e) => write!(f, "project was deleted; cleanup pending: {e}"),
        }
    }
}

impl std::error::Error for PurgeError {}

fn storage(e: impl std::fmt::Debug) -> PurgeError {
    PurgeError::Storage(format!("{e:?}"))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PurgeOutcome {
    pub id: String,
    pub code: String,
}

struct Plan {
    id: String,
    paths: Vec<String>,
    current_runs: Vec<String>,
}

type ProjectRow = (String, String, i64, Vec<String>, Vec<String>);

fn plain_name(name: &str) -> bool {
    let mut parts = Path::new(name).components();
    matches!(parts.next(), Some(Component::Normal(_))) && parts.next().is_none()
}

fn present(path: &Path) -> Result<bool, PurgeError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(storage(e)),
    }
}

fn plan(store: &Store, id: &str, code: &str, version: i64) -> Result<Plan, PurgeError> {
    let key = id.to_owned();
    let row = store
        .read(move |tx| -> rusqlite::Result<Option<ProjectRow>> {
            let p: Option<(String, String, i64)> = tx
                .query_row(
                    "SELECT code,lifecycle,version FROM projects WHERE id = ?1",
                    [&key],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            let Some((actual_code, lifecycle, actual_version)) = p else {
                return Ok(None);
            };
            let paths = tx
                .prepare("SELECT canonical_path FROM project_paths WHERE project_id = ?1 ORDER BY canonical_path")?
                .query_map([&key], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let current_runs = tx
                .prepare("SELECT run FROM dispatch_runs WHERE project_code = ?1 AND log_root = 'CURRENT' ORDER BY run")?
                .query_map([&actual_code], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(Some((actual_code, lifecycle, actual_version, paths, current_runs)))
        })
        .map_err(storage)?
        .ok_or(PurgeError::NotFound)?;
    if row.0 != code || row.2 != version {
        return Err(PurgeError::VersionChanged);
    }
    if row.1 != "TRASHED" {
        return Err(PurgeError::NotTrashed);
    }
    if !row.4.iter().all(|run| plain_name(run)) {
        return Err(storage("project has an unsafe historical dispatch id"));
    }
    Ok(Plan {
        id: id.to_owned(),
        paths: row.3,
        current_runs: row.4,
    })
}

fn journal_path(stage: &Path, id: &str) -> PathBuf {
    stage.join(format!("{id}.json"))
}

fn write_journal(stage: &Path, plan: &Plan) -> Result<(), PurgeError> {
    let path = journal_path(stage, &plan.id);
    let temporary = stage.join(format!("{}.json.tmp", plan.id));
    if temporary.exists() {
        fs::remove_file(&temporary).map_err(storage)?;
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(storage)?;
    file.write_all(
        json!({"id": plan.id, "paths": plan.paths, "currentRuns": plan.current_runs})
            .to_string()
            .as_bytes(),
    )
    .map_err(storage)?;
    file.sync_all().map_err(storage)?;
    drop(file);
    fs::rename(temporary, path).map_err(storage)?;
    Ok(())
}

fn read_journal(path: &Path) -> Result<Plan, PurgeError> {
    let text = fs::read_to_string(path).map_err(storage)?;
    let v: Value = serde_json::from_str(&text).map_err(storage)?;
    let id = v["id"]
        .as_str()
        .ok_or_else(|| storage("purge journal has no id"))?;
    if !plain_name(id) || path.file_name() != Some(OsStr::new(&format!("{id}.json"))) {
        return Err(storage("purge journal has an invalid id"));
    }
    let paths: Vec<String> = v["paths"]
        .as_array()
        .ok_or_else(|| storage("purge journal has no paths"))?
        .iter()
        .map(|p| {
            p.as_str()
                .map(str::to_owned)
                .ok_or_else(|| storage("invalid path in purge journal"))
        })
        .collect::<Result<_, _>>()?;
    let current_runs: Vec<String> = v["currentRuns"]
        .as_array()
        .map(|values| {
            values
                .iter()
                .map(|value| {
                    let run = value
                        .as_str()
                        .ok_or_else(|| storage("invalid run in purge journal"))?;
                    if !plain_name(run) {
                        return Err(storage("unsafe run in purge journal"));
                    }
                    Ok(run.to_owned())
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    Ok(Plan {
        id: id.into(),
        paths,
        current_runs,
    })
}

/// What [`finish_pending`] did. `pending` lists deletions that are already committed but whose
/// external files could not all be removed yet: `(project id, reason)`. None of them is a live
/// project, so they are retried at the next start instead of blocking anything else.
#[derive(Debug, Default)]
pub struct Settled {
    pub finished: usize,
    pub pending: Vec<(String, String)>,
}

/// Called before the runtime publishes HTTP/MCP/UI entries, and after a purge attempt. If the
/// project row survived, put its attachments back. If the row is gone, finish erasing only its
/// own marker and staged attachment directory. An ambiguous pair of directories is left intact.
///
/// An `Err` means a journal whose project may still be live could not be settled: exposing that
/// project now would show it without its attachments.
pub fn finish_pending(store: &Store) -> Result<Settled, PurgeError> {
    let mut guard = attachments_lock(store, "finish_project_purges").map_err(storage)?;
    finish_pending_locked(store, &mut guard)
}

fn finish_pending_locked(
    store: &Store,
    guard: &mut AttachmentsGuard,
) -> Result<Settled, PurgeError> {
    let mut settled = Settled::default();
    let Some(stage) = guard.existing(&[STAGING]).map_err(storage)? else {
        return Ok(settled);
    };
    let mut journals = fs::read_dir(&stage)
        .map_err(storage)?
        .map(|e| e.map(|e| e.path()).map_err(storage))
        .collect::<Result<Vec<_>, _>>()?;
    journals.retain(|p| p.extension().is_some_and(|e| e == "json"));
    journals.sort();
    for path in &journals {
        let plan = read_journal(path)?;
        let id = plan.id.clone();
        let exists: bool = store
            .read(move |tx| {
                tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
                    [&id],
                    |r| r.get(0),
                )
            })
            .map_err(storage)?;
        if exists {
            restore_staged(guard, &stage, &plan.id)?;
            fs::remove_file(path).map_err(storage)?;
            settled.finished += 1;
        } else {
            // One committed deletion whose files are still held open must not stop the others,
            // nor be reported as the outcome of a later, unrelated deletion.
            match erase_deleted(store, guard, &stage, &plan, path) {
                Ok(()) => settled.finished += 1,
                Err(reason) => settled.pending.push((plan.id, reason)),
            }
        }
    }
    Ok(settled)
}

/// The project row is still there: move its staged attachments back.
fn restore_staged(guard: &mut AttachmentsGuard, stage: &Path, id: &str) -> Result<(), PurgeError> {
    if !present(&stage.join(id))? {
        return Ok(());
    }
    if present(&guard.artifacts().join(id))? {
        return Err(storage(format!(
            "both live and staged attachments exist for {id}"
        )));
    }
    let source = guard
        .dir(&[STAGING])
        .ok_or_else(|| storage("purge staging not pinned"))?;
    let movable = crate::pin::open_movable(source, OsStr::new(id)).map_err(storage)?;
    let target = guard
        .dir(&[])
        .ok_or_else(|| storage("artifacts root not pinned"))?;
    movable.move_into(target, OsStr::new(id)).map_err(storage)
}

/// The project row is gone: remove its own marker, current dispatch logs, staged attachments and
/// finally the journal. Any failure leaves the journal for the next retry.
fn erase_deleted(
    store: &Store,
    guard: &mut AttachmentsGuard,
    stage: &Path,
    plan: &Plan,
    journal: &Path,
) -> Result<(), String> {
    for p in &plan.paths {
        remove_owned_marker(p, &plan.id);
    }
    remove_current_logs(store, &plan.current_runs).map_err(|e| e.to_string())?;
    let staged = stage.join(&plan.id);
    if present(&staged).map_err(|e| e.to_string())? {
        let source = guard
            .dir(&[STAGING])
            .ok_or_else(|| "purge staging not pinned".to_string())?;
        let movable =
            crate::pin::open_movable(source, OsStr::new(&plan.id)).map_err(|e| e.to_string())?;
        drop(movable);
        fs::remove_dir_all(&staged).map_err(|e| e.to_string())?;
    }
    fs::remove_file(journal).map_err(|e| e.to_string())
}

fn remove_current_logs(store: &Store, runs: &[String]) -> Result<(), PurgeError> {
    if runs.is_empty() {
        return Ok(());
    }
    let data = store
        .real_path()
        .parent()
        .ok_or_else(|| storage("database has no data root"))?;
    let mut pinned =
        crate::chain::pin_inside(data, &[Path::new("dispatch/logs")]).map_err(storage)?;
    let Some(logs) = pinned
        .existing(Path::new("dispatch/logs"))
        .map_err(storage)?
    else {
        return Ok(());
    };
    for run in runs {
        for suffix in [".jsonl", ".stderr.log"] {
            let file = logs.join(format!("{run}{suffix}"));
            match fs::remove_file(file) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(storage(e)),
            }
        }
    }
    Ok(())
}

/// Source directories may be offline or user-modified. Never make a committed deletion prevent
/// ATM from starting because an external marker cannot be removed; the in-database tombstone
/// makes this exact old id inert even if its marker later reappears.
fn remove_owned_marker(source: &str, id: &str) {
    let directory = Path::new(source).join(".ayanami-task");
    let Ok(meta) = fs::symlink_metadata(&directory) else {
        return;
    };
    if !meta.is_dir() || reparse(&meta) {
        return;
    }
    let file = directory.join("project.json");
    let Ok(meta) = fs::symlink_metadata(&file) else {
        return;
    };
    if !meta.is_file() || reparse(&meta) {
        return;
    }
    if let Ok(text) = fs::read_to_string(&file)
        && let Ok(v) = serde_json::from_str::<Value>(&text)
        && v["project_id"] == id
    {
        let _ = fs::remove_file(&file);
    }
}

#[cfg(windows)]
fn reparse(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    meta.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn reparse(meta: &fs::Metadata) -> bool {
    meta.file_type().is_symlink()
}

/// Stage the project's external attachments, delete live database rows, then finish the external
/// cleanup. No whole-database backup or unrelated source directory is removed.
pub fn purge_project(
    store: &Store,
    id: &str,
    code: &str,
    expected_version: i64,
) -> Result<PurgeOutcome, PurgeError> {
    if !plain_name(id) {
        return Err(storage("invalid project id"));
    }
    let mut guard = attachments_lock(store, "purge_project").map_err(storage)?;
    refuse_pending_swaps(store, &mut guard).map_err(storage)?;
    // Earlier deletions whose files are still held open stay pending for the next start; they
    // neither block this deletion nor become its result.
    finish_pending_locked(store, &mut guard)?;
    let plan = plan(store, id, code, expected_version)?;
    let stage = guard.ensure(&[STAGING]).map_err(storage)?;
    let journal = journal_path(&stage, id);
    if present(&journal)? || present(&stage.join(id))? {
        return Err(storage("an earlier purge is still pending"));
    }
    write_journal(&stage, &plan)?;
    let live = guard.artifacts().join(id);
    if present(&live)? {
        let root = guard
            .dir(&[])
            .ok_or_else(|| storage("artifacts root not pinned"))?;
        let movable = crate::pin::open_movable(root, OsStr::new(id)).map_err(storage)?;
        let target = guard
            .dir(&[STAGING])
            .ok_or_else(|| storage("purge staging not pinned"))?;
        movable.move_into(target, OsStr::new(id)).map_err(storage)?;
    }
    let (id_owned, code_owned) = (id.to_owned(), code.to_owned());
    let result = store.write(move |tx| -> Result<(), PurgeError> {
        let row: Option<(String, String, i64)> = tx
            .query_row("SELECT code,lifecycle,version FROM projects WHERE id=?1", [&id_owned], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))
            .optional()
            .map_err(storage)?;
        let (actual_code, lifecycle, actual_version) = row.ok_or(PurgeError::NotFound)?;
        if actual_code != code_owned || actual_version != expected_version {
            return Err(PurgeError::VersionChanged);
        }
        if lifecycle != "TRASHED" {
            return Err(PurgeError::NotTrashed);
        }
        let sync_enabled: Option<i64> = tx.query_row("SELECT enabled FROM sync_state WHERE singleton = 1", [], |r| r.get(0)).optional().map_err(storage)?;
        if sync_enabled == Some(1) {
            return Err(PurgeError::SyncEnabled);
        }
        let active_run: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM dispatch_runs WHERE project_code = ?1 AND state IN ('queued','running'))",
            [&actual_code], |r| r.get(0),
        ).map_err(storage)?;
        if active_run {
            return Err(PurgeError::ActiveDispatch);
        }
        delete_live_rows(tx, &id_owned).map_err(storage)?;
        Ok(())
    });
    match result {
        Ok(()) => {
            // Committed: from here on every failure is "deleted, cleanup pending", never a
            // rolled-back deletion. Only this project's own leftovers are reported.
            let settled = finish_pending_locked(store, &mut guard)
                .map_err(|e| PurgeError::CleanupPending(e.to_string()))?;
            if let Some((_, reason)) = settled.pending.iter().find(|(p, _)| p == id) {
                return Err(PurgeError::CleanupPending(reason.clone()));
            }
            Ok(PurgeOutcome {
                id: id.into(),
                code: code.into(),
            })
        }
        Err(e) => {
            let refused = match e {
                crate::WriteError::Rejected(e) => e,
                other => storage(format!("{other:?}")),
            };
            // Nothing was deleted, but the attachments were staged. If they cannot be put back
            // now, say so instead of reporting only the refusal; startup puts them back.
            match finish_pending_locked(store, &mut guard) {
                Ok(_) => Err(refused),
                Err(restore) => Err(storage(format!(
                    "{refused}; staged attachments are put back at the next start: {restore}"
                ))),
            }
        }
    }
}

/// Tables whose rows belong wholly to a project. Foreign keys are deferred in schema v1, so the
/// order here is not a substitute for a transaction. Keep this list in sync with the schema guard
/// in `tests/purge.rs` when adding a project-scoped table.
pub const PROJECT_ROWS: &[&str] = &[
    "counters",
    "objectives",
    "milestones",
    "work_items",
    "work_item_relations",
    "checklist_items",
    "progress_updates",
    "project_updates",
    "blockers",
    "records",
    "artifacts",
    "agents",
    "agent_sessions",
    "handoffs",
    "events",
    "review_requests",
    "review_submissions",
    "engineering_project_metrics",
    "engineering_work_item_metrics",
    "import_history",
    "project_paths",
    "project_restore_requests",
    "saved_views",
    "search_docs",
];

/// Delete the *live* project. The caller must already have checked lifecycle, confirmation and
/// version in this same transaction. The result is `false` if the id no longer exists; in that
/// case this function does not alter a replacement project with the same public code.
pub fn delete_live_rows(tx: &Transaction<'_>, project_id: &str) -> rusqlite::Result<bool> {
    let code: Option<String> = tx
        .query_row(
            "SELECT code FROM projects WHERE id = ?1",
            [project_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(code) = code else {
        return Ok(false);
    };

    // A queued/running dispatch can still write after this transaction. The service must stop it
    // before purging instead of silently erasing an in-flight run.
    let active_run: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM dispatch_runs WHERE project_code = ?1 AND state IN ('queued','running'))",
        [&code],
        |r| r.get(0),
    )?;
    if active_run {
        return Err(rusqlite::Error::InvalidParameterName(
            "project has an active dispatch run".into(),
        ));
    }

    // Quick tasks promoted into this project and its saved views are removed below. Their GLOBAL
    // receipts and global events live outside the project scope and carry copies of them (titles,
    // notes, queries, the promoted project), so remove those too. Ownership is matched only on the
    // field that names the entity — `quick.id` / `view.id` in a receipt of that operation, and the
    // event's aggregate — never on any string that happens to equal an id elsewhere in the JSON.
    let quicks: Vec<String> = tx
        .prepare("SELECT id FROM quick_tasks WHERE promoted_project_id = ?1")?
        .query_map([project_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    // Views the User already deleted have no row left; their create/update receipts and their
    // events still name this project as the owner (`view.projectId`, event `projectId`). A view
    // that now lives under another project or globally is not ours, whatever its history says.
    let candidates: Vec<String> = tx
        .prepare(
            "SELECT id FROM saved_views WHERE project_id = ?1
             UNION
             SELECT json_extract(receipt_json, '$.view.id') FROM idempotency_receipts
              WHERE scope_kind = 'GLOBAL'
                AND operation IN ('saved_view.create','saved_view.update')
                AND json_valid(receipt_json)
                AND json_extract(receipt_json, '$.view.projectId') = ?1
             UNION
             SELECT aggregate_id FROM global_feed
              WHERE type IN ('saved_view.created','saved_view.updated','saved_view.deleted')
                AND json_valid(payload_json)
                AND json_extract(payload_json, '$.projectId') = ?1",
        )?
        .query_map([project_id], |r| r.get::<_, Option<String>>(0))?
        .filter_map(|id| id.transpose())
        .collect::<rusqlite::Result<_>>()?;
    let mut views = Vec::new();
    for id in candidates {
        let elsewhere: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM saved_views WHERE id = ?1 AND project_id IS NOT ?2)",
            [id.as_str(), project_id],
            |r| r.get(0),
        )?;
        if !elsewhere {
            views.push(id);
        }
    }
    for id in &quicks {
        tx.execute(
            "DELETE FROM idempotency_receipts
             WHERE scope_kind = 'GLOBAL'
               AND operation IN ('quick.create','quick.update','quick.promote','session.recover-or-begin')
               AND json_valid(receipt_json) AND json_extract(receipt_json, '$.quick.id') = ?1",
            [id],
        )?;
    }
    for id in &views {
        // create/update answer with the view; delete answers `{ok, id}`.
        tx.execute(
            "DELETE FROM idempotency_receipts
             WHERE scope_kind = 'GLOBAL' AND json_valid(receipt_json)
               AND ((operation IN ('saved_view.create','saved_view.update')
                     AND json_extract(receipt_json, '$.view.id') = ?1)
                 OR (operation = 'saved_view.delete'
                     AND json_extract(receipt_json, '$.id') = ?1))",
            [id],
        )?;
    }
    for id in quicks.iter().chain(&views) {
        tx.execute("DELETE FROM global_feed WHERE aggregate_id = ?1", [id])?;
    }

    // A promoted quick task is a copy of project work. Remove it and its updates rather than
    // leaving an Agent-readable pointer/title after the project is gone.
    tx.execute(
        "DELETE FROM quick_task_updates WHERE quick_task_id IN
         (SELECT id FROM quick_tasks WHERE promoted_project_id = ?1)",
        [project_id],
    )?;
    tx.execute(
        "DELETE FROM quick_tasks WHERE promoted_project_id = ?1",
        [project_id],
    )?;
    tx.execute(
        "DELETE FROM sync_published WHERE project_code = ?1",
        [&code],
    )?;
    tx.execute("DELETE FROM dispatch_runs WHERE project_code = ?1", [&code])?;
    tx.execute(
        "DELETE FROM dispatch_requests WHERE json_valid(run_snapshot_json)
         AND (json_extract(run_snapshot_json, '$.project') = ?1
              OR json_extract(run_snapshot_json, '$.projectCode') = ?1)",
        [&code],
    )?;

    // Project-scoped receipts include project.create's CALL receipt; keeping it would replay the
    // deleted identity after code reuse. Legacy import receipts also use the same scope id.
    tx.execute(
        "DELETE FROM idempotency_receipts WHERE scope_kind = 'PROJECT' AND scope_id = ?1",
        [project_id],
    )?;
    tx.execute(
        "DELETE FROM global_feed WHERE project_id = ?1 OR aggregate_id = ?1",
        [project_id],
    )?;
    for table in PROJECT_ROWS {
        tx.execute(
            &format!("DELETE FROM {table} WHERE project_id = ?1"),
            [project_id],
        )?;
    }
    tx.execute("DELETE FROM projects WHERE id = ?1", params![project_id])?;
    // A source directory may be disconnected while the user deletes the project. Its old marker
    // can reappear later. This non-identifying tombstone lets begin ignore only markers that ATM
    // itself deliberately purged; an arbitrary missing marker still fails closed.
    tx.execute(
        "INSERT INTO settings(key,value_json,updated_at) VALUES (?1,'{}',strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(key) DO NOTHING",
        [format!("internal.purged-project.{project_id}")],
    )?;
    // `scope_generations` remains as an opaque high-water/timeline ledger. It contains no name,
    // code or content and prevents old generation numbers from being reused.
    Ok(true)
}
