//! Agent REST 需要、而 MCP 工具没有的读（06 §2 的 A / A+U 路由，W4h）。
//!
//! - 项目列表（#11）、quick 列表（#84）：注册表与 quick 的整表读。
//! - 事件分页（#79）：`atm_delta` 底下的同一页事件，不做体积裁剪——它是 delta 大事件的回取入口
//!   （`oversized_event.continuation.path`），必须原样给出那一条。
//! - review 请求（#70）：`CANDIDATE_HASH_MISMATCH` 的 `request_lookup.path` 指向这里。
//! - 系统状态（#1）：单库的健康与计数；转换状态由运行时补上（服务层不知道）。
//!
//! 输出用 snake_case，与 MCP 工具的输出同一套词汇。

use crate::project::dom_read_error;
use crate::read::delta::events;
use crate::write::{Service, internal};
use atm_domain::capability::{self, Capability};
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::keys;
use atm_domain::principal::Principal;
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Value, json};

/// 事件分页一次最多给的条数（与 delta 同一上限）。
pub const EVENTS_MAX: usize = 100;

const QUICK_STATUSES: &[&str] = &[
    "OPEN",
    "IN_PROGRESS",
    "BLOCKED",
    "DONE",
    "CANCELLED",
    "PROMOTED",
];

fn db(e: rusqlite::Error) -> DomainError {
    internal(e)
}

impl Service {
    /// 注册的全部项目（`project.read`），按代码排序；每个项目带主路径。生命周期照实给出，不过滤。
    pub fn project_list(&self, principal: &Principal) -> Result<Value, DomainError> {
        capability::require(principal, Capability::ProjectRead)?;
        self.store()
            .read(|tx| -> Result<Value, DomainError> {
                let projects: Vec<Value> = tx
                    .prepare(
                        "SELECT p.id, p.code, p.name, p.lifecycle, p.version, p.updated_at,
                                (SELECT canonical_path FROM project_paths pp
                                  WHERE pp.project_id = p.id ORDER BY is_primary DESC, canonical_path LIMIT 1)
                         FROM projects p ORDER BY p.code",
                    )
                    .map_err(db)?
                    .query_map([], |r| {
                        Ok(json!({
                            "id": r.get::<_, String>(0)?,
                            "code": r.get::<_, String>(1)?,
                            "name": r.get::<_, String>(2)?,
                            "lifecycle": r.get::<_, String>(3)?,
                            "version": r.get::<_, i64>(4)?,
                            "updated_at": r.get::<_, String>(5)?,
                            "primary_path": r.get::<_, Option<String>>(6)?,
                        }))
                    })
                    .map_err(db)?
                    .collect::<rusqlite::Result<_>>()
                    .map_err(db)?;
                Ok(json!({ "projects": projects }))
            })
            .map_err(dom_read_error)
    }

    /// quick 列表（`quick.read`），最近更新的在前；`status` 给了就只要那一种。
    pub fn quick_list(
        &self,
        principal: &Principal,
        status: Option<&str>,
    ) -> Result<Value, DomainError> {
        capability::require(principal, Capability::QuickRead)?;
        let status = match status.map(|s| s.trim().to_ascii_uppercase()) {
            None => None,
            Some(s) if QUICK_STATUSES.contains(&s.as_str()) => Some(s),
            Some(s) => {
                return Err(DomainError::invalid_argument(vec![
                    atm_domain::error::Problem::new("status", atm_domain::error::ProblemKind::Enum)
                        .got(s)
                        .allowed(QUICK_STATUSES.join("|")),
                ]));
            }
        };
        self.store()
            .read(move |tx| -> Result<Value, DomainError> {
                let ids: Vec<String> = tx
                    .prepare(
                        "SELECT id FROM quick_tasks WHERE ?1 IS NULL OR status = ?1
                         ORDER BY updated_at DESC, local_no DESC",
                    )
                    .map_err(db)?
                    .query_map([&status], |r| r.get(0))
                    .map_err(db)?
                    .collect::<rusqlite::Result<_>>()
                    .map_err(db)?;
                let items = ids
                    .iter()
                    .map(|id| crate::quick::view(tx, id))
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(json!({ "quick_tasks": items }))
            })
            .map_err(dom_read_error)
    }

    /// 一页项目事件（`events.read`）：`since` 之后按序号升序；不给 `since` 是最新的一页。
    /// 不裁剪体积——delta 的 `oversized_event` 让 Agent 到这里取回整条事件。
    pub fn events_page(
        &self,
        principal: &Principal,
        project: &str,
        since: Option<i64>,
        limit: usize,
        types: &[String],
    ) -> Result<Value, DomainError> {
        if since.is_some_and(|s| s < 0) {
            return Err(DomainError::invalid_argument(vec![
                atm_domain::error::Problem::new("since", atm_domain::error::ProblemKind::Pattern)
                    .allowed("a non-negative event sequence"),
            ]));
        }
        self.read_project(principal, Capability::EventsRead, project, |cx| {
            let page = events(cx, since, limit.clamp(1, EVENTS_MAX), types)?;
            Ok(json!({
                "project": { "code": cx.p.code, "name": cx.p.name },
                "since_seq": since,
                "events": page.events,
                "current_sequence": cx.p.seq,
                "has_more": page.has_more,
            }))
        })
    }

    /// 一条 review 请求与它的提交（`work.read`）。
    pub fn review_request_get(
        &self,
        principal: &Principal,
        project: &str,
        request_key: &str,
    ) -> Result<Value, DomainError> {
        self.read_project(principal, Capability::WorkRead, project, |cx| {
            let not_found = || {
                DomainError::new(
                    ErrorCode::REVIEW_REQUEST_NOT_FOUND,
                    format!("项目 {} 里没有 review 请求 {request_key}", cx.p.code),
                )
                .detail("project", cx.p.code.clone())
                .detail("request_key", request_key)
            };
            let no =
                keys::parse_review_request_key(&cx.p.code, request_key).ok_or_else(not_found)?;
            review_request(cx.tx, &cx.p.id, &cx.p.code, no)?.ok_or_else(not_found)
        })
    }

    /// 单库的健康与计数（`system.status`）。转换与数据来源状态由运行时补在外层。
    pub fn system_status(&self, principal: &Principal) -> Result<Value, DomainError> {
        capability::require(principal, Capability::SystemStatus)?;
        let at = self.clock().to_string();
        self.store()
            .read(move |tx| -> Result<Value, DomainError> {
                let counts: Vec<(String, i64)> = tx
                    .prepare("SELECT lifecycle, count(*) FROM projects GROUP BY lifecycle ORDER BY lifecycle")
                    .map_err(db)?
                    .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                    .map_err(db)?
                    .collect::<rusqlite::Result<_>>()
                    .map_err(db)?;
                let total: i64 = counts.iter().map(|(_, n)| n).sum();
                let by_lifecycle: serde_json::Map<String, Value> =
                    counts.into_iter().map(|(k, n)| (k, json!(n))).collect();
                let global_seq: i64 = tx
                    .query_row("SELECT coalesce(max(global_seq), 0) FROM global_feed", [], |r| r.get(0))
                    .map_err(db)?;
                Ok(json!({
                    "ok": true,
                    "impl": "rust",
                    "layout": "single",
                    "sqlite": { "version": rusqlite::version() },
                    "project_count": total,
                    "project_counts": by_lifecycle,
                    "global_sequence": global_seq,
                    "at": at,
                }))
            })
            .map_err(dom_read_error)
    }
}

/// review_requests 的一行连同提交，按 key 的序号查。
fn review_request(
    tx: &Transaction<'_>,
    project_id: &str,
    code: &str,
    local_no: i64,
) -> Result<Option<Value>, DomainError> {
    let task_key = |id: &str| -> Result<String, DomainError> {
        let no: i64 = tx
            .query_row(
                "SELECT local_no FROM work_items WHERE project_id = ?1 AND id = ?2",
                params![project_id, id],
                |r| r.get(0),
            )
            .map_err(db)?;
        Ok(keys::task_key(code, no))
    };
    let row = tx
        .query_row(
            "SELECT id, review_work_item_id, parent_work_item_id, parent_checklist_id, parent_checklist_version,
                    expected_candidate_hashes_json, created_by_agent_id, created_by_session_id, created_at, op_id
             FROM review_requests WHERE project_id = ?1 AND local_no = ?2",
            params![project_id, local_no],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, String>(5)?,
                    (
                        r.get::<_, String>(6)?,
                        r.get::<_, String>(7)?,
                        r.get::<_, String>(8)?,
                        r.get::<_, String>(9)?,
                    ),
                ))
            },
        )
        .optional()
        .map_err(db)?;
    let Some((id, review, parent, checklist, checklist_version, hashes, (agent, session, at, op))) =
        row
    else {
        return Ok(None);
    };
    let submission = tx
        .query_row(
            "SELECT local_no, verdict, reviewed_hashes_json, evidence_json, reviewer_agent_id, reviewer_session_id,
                    review_task_version, parent_checklist_version, created_at, op_id
             FROM review_submissions WHERE project_id = ?1 AND request_id = ?2",
            params![project_id, id],
            |r| {
                Ok(json!({
                    "key": keys::review_submission_key(code, r.get::<_, i64>(0)?),
                    "verdict": r.get::<_, String>(1)?,
                    "reviewed_hashes": parse(&r.get::<_, String>(2)?),
                    "evidence": parse(&r.get::<_, String>(3)?),
                    "reviewer_agent_id": r.get::<_, String>(4)?,
                    "reviewer_session_id": r.get::<_, String>(5)?,
                    "review_task_version": r.get::<_, i64>(6)?,
                    "parent_checklist_version": r.get::<_, i64>(7)?,
                    "created_at": r.get::<_, String>(8)?,
                    "op_id": r.get::<_, String>(9)?,
                }))
            },
        )
        .optional()
        .map_err(db)?;
    Ok(Some(json!({
        "key": keys::review_request_key(code, local_no),
        "review_task_key": task_key(&review)?,
        "parent_task_key": task_key(&parent)?,
        "parent_checklist_id": checklist,
        "parent_checklist_version": checklist_version,
        "expected_candidate_hashes": parse(&hashes),
        "created_by_agent_id": agent,
        "created_by_session_id": session,
        "created_at": at,
        "op_id": op,
        "submission": submission,
    })))
}

fn parse(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or(Value::Null)
}
