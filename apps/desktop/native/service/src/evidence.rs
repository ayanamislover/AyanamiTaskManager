//! 证据规范化里需要查库的部分（01 W-012；02 §3.3、§5.1）。格式校验与 trim 在 `atm_domain::evidence`。
//!
//! - 字符串、以及 kind 不是 atm_record / atm_task 的对象原样保留，不验证内容（D17）。
//! - atm_record：`{CODE}-D-<≥3 位>` 或 `{CODE}-R-<≥3 位>`，按 local_no 查本项目记录，D 必须是 DECISION、
//!   R 必须不是；改写成规范 key。否则 RECORD_NOT_FOUND。
//! - atm_task：按 W-001 解析到本项目任务，改写成规范 key。否则 WORK_ITEM_NOT_FOUND。
//!
//! 指纹用 [`normalize_or_raw`]：失败时退回原样，让指纹对不上，由业务动作报出准确的错误（2.x session 闸门）。

use crate::write::internal;
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::evidence::{Evidence, EvidenceKind};
use atm_domain::keys::{self, RecordLetter};
use rusqlite::{OptionalExtension, Transaction};
use serde_json::Value;

/// 规范化一组证据。`path` 用于错误定位（如 `evidence`、`items[2].evidence`）。
pub(crate) fn normalize(
    tx: &Transaction<'_>,
    project: &str,
    code: &str,
    path: &str,
    items: Vec<Evidence>,
) -> Result<Vec<Evidence>, DomainError> {
    items
        .into_iter()
        .enumerate()
        .map(|(i, e)| one(tx, project, code, &format!("{path}[{i}]"), e))
        .collect()
}

fn one(
    tx: &Transaction<'_>,
    project: &str,
    code: &str,
    path: &str,
    e: Evidence,
) -> Result<Evidence, DomainError> {
    let Evidence::Item { kind, value, note } = e else {
        return Ok(e);
    };
    let value = match kind {
        EvidenceKind::AtmRecord => record(tx, project, code, path, &value)?,
        EvidenceKind::AtmTask => task(tx, project, code, path, &value)?,
        _ => value,
    };
    Ok(Evidence::Item { kind, value, note })
}

fn record(
    tx: &Transaction<'_>,
    project: &str,
    code: &str,
    path: &str,
    value: &str,
) -> Result<String, DomainError> {
    let not_found = || {
        DomainError::new(
            ErrorCode::RECORD_NOT_FOUND,
            format!("证据 {path} 引用的记录 {value} 在项目 {code} 里不存在"),
        )
        .detail("entity", "RECORD")
        .detail("reference", value)
        .detail("field", path)
    };
    let (letter, no) = keys::parse_record_key(code, value).ok_or_else(not_found)?;
    let kind: Option<String> = tx
        .query_row(
            "SELECT kind FROM records WHERE project_id = ?1 AND local_no = ?2",
            rusqlite::params![project, no],
            |r| r.get(0),
        )
        .optional()
        .map_err(internal)?;
    let matches = match (letter, kind.as_deref()) {
        (_, None) => false,
        (RecordLetter::Decision, Some(k)) => k == "DECISION",
        (RecordLetter::Other, Some(k)) => k != "DECISION",
    };
    if !matches {
        return Err(not_found());
    }
    Ok(keys::record_key(code, letter, no))
}

fn task(
    tx: &Transaction<'_>,
    project: &str,
    code: &str,
    path: &str,
    value: &str,
) -> Result<String, DomainError> {
    let found = match keys::parse_task_key(code, value) {
        Some(no) => tx
            .query_row(
                "SELECT 1 FROM work_items WHERE project_id = ?1 AND local_no = ?2",
                rusqlite::params![project, no],
                |_| Ok(no),
            )
            .optional()
            .map_err(internal)?,
        None => None,
    };
    match found {
        Some(no) => Ok(keys::task_key(code, no)),
        None => Err(DomainError::new(
            ErrorCode::WORK_ITEM_NOT_FOUND,
            format!("证据 {path} 引用的任务 {value} 在项目 {code} 里不存在"),
        )
        .detail("entity", "WORK_ITEM")
        .detail("reference", value)
        .detail("field", path)),
    }
}

/// 指纹用：能规范化就规范化，任何一条失败（或项目不存在）就整组退回原样。
pub(crate) fn normalize_or_raw(
    tx: &Transaction<'_>,
    project: &str,
    items: &[Evidence],
) -> Vec<Evidence> {
    let code: Option<String> = tx
        .query_row("SELECT code FROM projects WHERE id = ?1", [project], |r| {
            r.get(0)
        })
        .optional()
        .ok()
        .flatten();
    code.and_then(|code| normalize(tx, project, &code, "evidence", items.to_vec()).ok())
        .unwrap_or_else(|| items.to_vec())
}

/// 存储与回执里的形状（evidence_json）。
pub(crate) fn to_json(items: &[Evidence]) -> Value {
    serde_json::to_value(items).unwrap_or(Value::Array(Vec::new()))
}
