//! 临时任务（quick task；04 §4.1、L-013～L-015；03 C-11～C-13）。
//!
//! quick registry 是全局实体，不随任何范围恢复回退（10 A3 的 NONE 分支）。

use crate::write::internal;
use atm_domain::error::DomainError;
use atm_domain::keys;
use atm_store::events as store_events;
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Value, json};

fn db(e: rusqlite::Error) -> DomainError {
    internal(e)
}

/// 2.x `quickTaskFromRow`（camelCase）。
pub(crate) fn view(tx: &Transaction<'_>, id: &str) -> Result<Value, DomainError> {
    tx.query_row(
        "SELECT id, local_no, title, note, status, due_date, percent, latest_summary, source_cwd, version, updated_at,
                promoted_project_id, promoted_work_item_key
         FROM quick_tasks WHERE id = ?1",
        [id],
        |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "key": keys::quick_key(r.get(1)?),
                "title": r.get::<_, String>(2)?,
                "note": r.get::<_, String>(3)?,
                "status": r.get::<_, String>(4)?,
                "dueDate": r.get::<_, Option<String>>(5)?,
                "percent": r.get::<_, Option<i64>>(6)?,
                "latestSummary": r.get::<_, Option<String>>(7)?,
                "sourceCwd": r.get::<_, Option<String>>(8)?,
                "version": r.get::<_, i64>(9)?,
                "updatedAt": r.get::<_, String>(10)?,
                "promotedProjectId": r.get::<_, Option<String>>(11)?,
                "promotedWorkItemKey": r.get::<_, Option<String>>(12)?,
            }))
        },
    )
    .optional()
    .map_err(db)?
    .ok_or_else(|| internal(format!("quick task {id} vanished")))
}

/// 新建一条 OPEN 的 quick task（version 0）。编号全局递增。
pub(crate) fn create_tx(
    tx: &Transaction<'_>,
    title: &str,
    note: &str,
    due_date: Option<&str>,
    source_cwd: Option<&str>,
    actor: &str,
    at: &str,
) -> Result<Value, DomainError> {
    let local_no: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(local_no), 0) + 1 FROM quick_tasks",
            [],
            |r| r.get(0),
        )
        .map_err(db)?;
    let id = store_events::ulid(tx).map_err(db)?;
    tx.execute(
        "INSERT INTO quick_tasks (id, local_no, title, note, status, due_date, source_cwd, actor, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'OPEN', ?5, ?6, ?7, 0, ?8, ?8)",
        params![id, local_no, title, note, due_date, source_cwd, actor, at],
    )
    .map_err(db)?;
    store_events::append_global(
        tx,
        "quick.created",
        &id,
        actor,
        &json!({ "localNo": local_no, "title": title }).to_string(),
        None,
        at,
    )
    .map_err(|e| internal(format!("{e:?}")))?;
    view(tx, &id)
}
