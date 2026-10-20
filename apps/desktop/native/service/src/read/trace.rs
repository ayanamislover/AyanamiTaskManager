//! op_id 精确回查（02 §4.6，S-069）：ACK 的 `details_cursor` 就是这个查询。
//!
//! 按 op_id（可加 session）在本项目里收集回执、记录、进度、项目摘要与事件，全空 → `OPERATION_NOT_FOUND`。
//! session 过滤用回执所属的 session（作者、SESSION 命名空间或 2.x 的 actor_session_id），与 ACK 一致（C-05）。

use super::ack::entities;
use super::views::{self, PROGRESS_COLS, PROGRESS_FROM, PROJECT_UPDATE_COLS, parse_json};
use super::{Ctx, db};
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::text::js_trim;
use rusqlite::params;
use serde_json::{Value, json};

pub(crate) fn trace(
    cx: &Ctx<'_>,
    op_id: &str,
    session: Option<&str>,
) -> Result<Value, DomainError> {
    let op = js_trim(op_id);
    if op.is_empty() {
        return Err(
            DomainError::new(ErrorCode::OPERATION_ID_INVALID, "op_id 不能为空")
                .detail("field", "op_id"),
        );
    }
    let session = session.map(js_trim).filter(|s| !s.is_empty());
    if let Some(s) = session {
        views::session(cx, s)?;
    }
    let tx = cx.tx;
    let pid = &cx.p.id;
    let mutations: Vec<(String, Value, Option<String>, Option<String>)> = tx
        .prepare_cached(
            "SELECT operation, receipt_json, owner, created_at FROM (
               SELECT receipt_id, operation, receipt_json, created_at,
                      COALESCE(author_session, CASE WHEN ns_kind = 'SESSION' THEN ns_id END, actor_session_id) AS owner
               FROM idempotency_receipts
               WHERE scope_kind = 'PROJECT' AND scope_id = ?1 AND (op_id = ?2 OR legacy_op_id = ?2))
             WHERE ?3 IS NULL OR owner = ?3
             ORDER BY created_at, receipt_id",
        )
        .map_err(db)?
        .query_map(params![pid, op, session], |r| {
            Ok((
                r.get(0)?,
                parse_json(r.get(1)?, Value::Null),
                r.get(2)?,
                r.get(3)?,
            ))
        })
        .map_err(db)?
        .collect::<rusqlite::Result<_>>()
        .map_err(db)?;
    let record_ids: Vec<String> = tx
        .prepare_cached(
            "SELECT id FROM records WHERE project_id = ?1 AND op_id = ?2 AND (?3 IS NULL OR source_session_id = ?3)
             ORDER BY created_at, local_no",
        )
        .map_err(db)?
        .query_map(params![pid, op, session], |r| r.get(0))
        .map_err(db)?
        .collect::<rusqlite::Result<_>>()
        .map_err(db)?;
    let records = record_ids
        .iter()
        .map(|id| views::record(cx, id))
        .collect::<Result<Vec<_>, _>>()?;
    let progress: Vec<Value> = tx
        .prepare_cached(&format!(
            "SELECT {PROGRESS_COLS} FROM {PROGRESS_FROM}
             WHERE p.project_id = ?1 AND p.op_id = ?2 AND (?3 IS NULL OR p.session_id = ?3) ORDER BY p.created_at, p.id"
        ))
        .map_err(db)?
        .query_map(params![pid, op, session], |r| views::progress_from_row(&cx.p.code, r))
        .map_err(db)?
        .collect::<rusqlite::Result<_>>()
        .map_err(db)?;
    let updates: Vec<Value> = tx
        .prepare_cached(&format!(
            "SELECT {PROJECT_UPDATE_COLS} FROM project_updates
             WHERE project_id = ?1 AND op_id = ?2 AND (?3 IS NULL OR session_id = ?3) ORDER BY created_at, id"
        ))
        .map_err(db)?
        .query_map(params![pid, op, session], views::project_update_from_row)
        .map_err(db)?
        .collect::<rusqlite::Result<_>>()
        .map_err(db)?;
    let events: Vec<Value> = tx
        .prepare_cached(
            "SELECT seq, type, aggregate_type, aggregate_id, actor_id, session_id, payload_json, created_at, op_id
             FROM events WHERE project_id = ?1 AND op_id = ?2 AND (?3 IS NULL OR session_id = ?3) ORDER BY seq",
        )
        .map_err(db)?
        .query_map(params![pid, op, session], |r| {
            Ok(json!({
                "seq": r.get::<_, i64>(0)?,
                "type": r.get::<_, String>(1)?,
                "aggregate_type": r.get::<_, String>(2)?,
                "aggregate_id": r.get::<_, String>(3)?,
                "actor": r.get::<_, String>(4)?,
                "session_id": r.get::<_, Option<String>>(5)?,
                "payload": parse_json(r.get(6)?, json!({})),
                "at": r.get::<_, String>(7)?,
                "op_id": r.get::<_, Option<String>>(8)?,
            }))
        })
        .map_err(db)?
        .collect::<rusqlite::Result<_>>()
        .map_err(db)?;
    if mutations.is_empty()
        && records.is_empty()
        && progress.is_empty()
        && updates.is_empty()
        && events.is_empty()
    {
        return Err(
            DomainError::new(ErrorCode::OPERATION_NOT_FOUND, format!("操作不存在：{op}"))
                .detail("entity", "OPERATION")
                .detail("reference", op),
        );
    }
    let mut all = Vec::new();
    for (operation, response, _, _) in &mutations {
        for e in entities(operation, response) {
            if !all
                .iter()
                .any(|a: &Value| a["entity_type"] == e["entity_type"] && a["key"] == e["key"])
            {
                all.push(e);
            } else if !e["version"].is_null()
                && let Some(prev) = all
                    .iter_mut()
                    .find(|a| a["entity_type"] == e["entity_type"] && a["key"] == e["key"])
            {
                *prev = e;
            }
        }
    }
    Ok(json!({
        "op_id": op,
        "entities": all,
        "mutations": mutations
            .into_iter()
            .map(|(operation, response, owner, at)| {
                json!({ "operation": operation, "response": response, "session_id": owner, "created_at": at })
            })
            .collect::<Vec<_>>(),
        "records": records,
        "progress": progress,
        "project_updates": updates,
        "events": events,
    }))
}
