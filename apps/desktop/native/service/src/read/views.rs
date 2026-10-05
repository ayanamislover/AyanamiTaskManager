//! 实体视图：任务（core / context / full）、记录、session、进度、项目摘要。
//!
//! 任务视图沿用 2.x 的 camelCase DTO（`task-views.ts`），对外由 [`snake`] 转成 snake_case（MCP 是唯一的
//! snake_case 边界）；记录、session、进度、项目摘要直接产出 2.x MCP 的紧凑形状（`paging/entities.ts`）。

use super::{Ctx, db};
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::keys::{self, RecordLetter};
use rusqlite::{OptionalExtension, Row, params};
use serde_json::{Map, Value, json};

pub(crate) fn parse_json(text: Option<String>, fallback: Value) -> Value {
    text.and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(fallback)
}

fn snake_key(key: &str) -> String {
    let mut out = String::with_capacity(key.len() + 4);
    for c in key.chars() {
        if c.is_ascii_uppercase() {
            out.push('_');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// 2.x `externalizeTaskView`：键递归转成 snake_case。
pub(crate) fn snake(v: Value) -> Value {
    match v {
        Value::Array(items) => Value::Array(items.into_iter().map(snake).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(k, v)| (snake_key(&k), snake(v)))
                .collect(),
        ),
        other => other,
    }
}

pub(crate) fn record_letter(kind: &str) -> RecordLetter {
    if kind == "DECISION" {
        RecordLetter::Decision
    } else {
        RecordLetter::Other
    }
}

// ---------- 任务 ----------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskView {
    Core,
    Context,
    Full,
}

impl TaskView {
    pub fn parse(text: &str) -> Option<Self> {
        match text.trim().to_ascii_lowercase().as_str() {
            "core" => Some(TaskView::Core),
            "context" => Some(TaskView::Context),
            "full" => Some(TaskView::Full),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            TaskView::Core => "core",
            TaskView::Context => "context",
            TaskView::Full => "full",
        }
    }
}

pub(crate) const TASK_COLS: &str =
    "id, local_no, priority, sort_key, created_at, status, phase, waiting_on,
    computed_progress, progress_source, version, updated_at, title, description, acceptance_json,
    assignee_agent_id, claimed_by_session_id, claim_lease_until, waiting_for, blocked_reason";

/// 优先级序（2.x `priority_rank`）：CRITICAL 0、HIGH 1、NORMAL 2、其他 3。
pub(crate) const PRIORITY_RANK_SQL: &str =
    "CASE priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END";

#[derive(Clone, Debug)]
pub(crate) struct TaskRow {
    pub id: String,
    pub local_no: i64,
    pub priority: String,
    pub sort_key: i64,
    pub created_at: String,
    pub status: String,
    pub phase: String,
    pub waiting_on: Option<String>,
    pub progress: f64,
    pub progress_source: String,
    pub version: i64,
    pub updated_at: String,
    pub title: String,
    pub description: String,
    pub acceptance_json: String,
    pub assignee: Option<String>,
    pub claimed_by: Option<String>,
    pub lease: Option<String>,
    pub waiting_for: Option<String>,
    pub blocked_reason: Option<String>,
}

impl TaskRow {
    pub(crate) fn from_row(r: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(TaskRow {
            id: r.get(0)?,
            local_no: r.get(1)?,
            priority: r.get(2)?,
            sort_key: r.get(3)?,
            created_at: r.get(4)?,
            status: r.get(5)?,
            phase: r.get(6)?,
            waiting_on: r.get(7)?,
            progress: r.get(8)?,
            progress_source: r.get(9)?,
            version: r.get(10)?,
            updated_at: r.get(11)?,
            title: r.get(12)?,
            description: r.get(13)?,
            acceptance_json: r.get(14)?,
            assignee: r.get(15)?,
            claimed_by: r.get(16)?,
            lease: r.get(17)?,
            waiting_for: r.get(18)?,
            blocked_reason: r.get(19)?,
        })
    }

    pub(crate) fn priority_rank(&self) -> i64 {
        match self.priority.as_str() {
            "CRITICAL" => 0,
            "HIGH" => 1,
            "NORMAL" => 2,
            _ => 3,
        }
    }

    fn acceptance(&self) -> Vec<Value> {
        match serde_json::from_str::<Value>(&self.acceptance_json) {
            Ok(Value::Array(items)) => items.into_iter().filter(Value::is_string).collect(),
            _ => Vec::new(),
        }
    }
}

pub(crate) fn not_found(cx: &Ctx<'_>, reference: &str) -> DomainError {
    DomainError::new(
        ErrorCode::WORK_ITEM_NOT_FOUND,
        format!("项目 {} 里没有任务 {reference}", cx.p.code),
    )
    .detail("entity", "WORK_ITEM")
    .detail("reference", reference)
}

/// 按公开 key 读任务行（大小写与首尾空白不敏感，00 01 C-15）。
pub(crate) fn task_by_key(cx: &Ctx<'_>, reference: &str) -> Result<TaskRow, DomainError> {
    let Some(no) = keys::parse_task_key(&cx.p.code, reference) else {
        return Err(not_found(cx, reference));
    };
    cx.tx
        .query_row(
            &format!("SELECT {TASK_COLS} FROM work_items WHERE project_id = ?1 AND local_no = ?2"),
            params![cx.p.id, no],
            TaskRow::from_row,
        )
        .optional()
        .map_err(db)?
        .ok_or_else(|| not_found(cx, reference))
}

pub(crate) fn task_key(cx: &Ctx<'_>, local_no: i64) -> String {
    keys::task_key(&cx.p.code, local_no)
}

fn checklist_summary(cx: &Ctx<'_>, task: &str) -> Result<Value, DomainError> {
    cx.tx
        .query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(status = 'TODO'), 0), COALESCE(SUM(status = 'DOING'), 0),
                    COALESCE(SUM(status = 'DONE'), 0), COALESCE(SUM(status = 'SKIPPED'), 0),
                    COALESCE(SUM(evidence_required = 1), 0),
                    COALESCE(SUM(evidence_required = 1 AND status <> 'SKIPPED'
                                 AND COALESCE(json_array_length(evidence_json), 0) = 0), 0)
             FROM checklist_items WHERE project_id = ?1 AND work_item_id = ?2",
            params![cx.p.id, task],
            |r| {
                Ok(json!({
                    "total": r.get::<_, i64>(0)?,
                    "todo": r.get::<_, i64>(1)?,
                    "doing": r.get::<_, i64>(2)?,
                    "done": r.get::<_, i64>(3)?,
                    "skipped": r.get::<_, i64>(4)?,
                    "evidenceRequired": r.get::<_, i64>(5)?,
                    "evidenceMissing": r.get::<_, i64>(6)?,
                }))
            },
        )
        .map_err(db)
}

pub(crate) fn checklist_items(cx: &Ctx<'_>, task: &str) -> Result<Vec<Value>, DomainError> {
    cx.tx
        .prepare_cached(
            "SELECT id, title, kind, status, weight, evidence_required, evidence_json, version
             FROM checklist_items WHERE project_id = ?1 AND work_item_id = ?2 ORDER BY created_at, id",
        )
        .map_err(db)?
        .query_map(params![cx.p.id, task], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "title": r.get::<_, String>(1)?,
                "kind": r.get::<_, String>(2)?,
                "status": r.get::<_, String>(3)?,
                "weight": r.get::<_, f64>(4)?,
                "evidenceRequired": r.get::<_, i64>(5)? == 1,
                "evidence": parse_json(r.get(6)?, json!([])),
                "version": r.get::<_, i64>(7)?,
            }))
        })
        .map_err(db)?
        .collect::<rusqlite::Result<_>>()
        .map_err(db)
}

fn relations(cx: &Ctx<'_>, task: &str) -> Result<Vec<Value>, DomainError> {
    cx.tx
        .prepare_cached(
            "SELECT 'PARENT', 'OUTGOING', p.local_no, 0 FROM work_items c JOIN work_items p
               ON p.project_id = c.project_id AND p.id = c.parent_id WHERE c.project_id = ?1 AND c.id = ?2
             UNION ALL
             SELECT 'CHILD', 'INCOMING', c.local_no, 1 FROM work_items c WHERE c.project_id = ?1 AND c.parent_id = ?2
             UNION ALL
             SELECT r.relation_type, 'OUTGOING', t.local_no, 2 FROM work_item_relations r JOIN work_items t
               ON t.project_id = r.project_id AND t.id = r.target_id WHERE r.project_id = ?1 AND r.source_id = ?2
             UNION ALL
             SELECT r.relation_type, 'INCOMING', s.local_no, 3 FROM work_item_relations r JOIN work_items s
               ON s.project_id = r.project_id AND s.id = r.source_id WHERE r.project_id = ?1 AND r.target_id = ?2
             ORDER BY 4, 1, 3",
        )
        .map_err(db)?
        .query_map(params![cx.p.id, task], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
        })
        .map_err(db)?
        .map(|row| {
            row.map(|(kind, direction, no)| {
                json!({ "type": kind, "direction": direction, "taskKey": task_key(cx, no) })
            })
        })
        .collect::<rusqlite::Result<_>>()
        .map_err(db)
}

/// 2.x `projectTaskView`（camelCase）。
pub(crate) fn task_view(cx: &Ctx<'_>, t: &TaskRow, view: TaskView) -> Result<Value, DomainError> {
    let mut v = json!({
        "key": task_key(cx, t.local_no),
        "status": t.status,
        "phase": t.phase,
        "waitingOn": t.waiting_on,
        "progress": t.progress,
        "progressSource": t.progress_source,
        "version": t.version,
        "updatedAt": t.updated_at,
    });
    if view == TaskView::Core {
        return Ok(v);
    }
    let preview: String = t.description.chars().take(240).collect();
    let extra = json!({
        "title": t.title,
        "descriptionPreview": preview,
        "acceptance": t.acceptance(),
        "checklistSummary": checklist_summary(cx, &t.id)?,
        "assigneeAgentId": t.assignee,
        "claimedBySessionId": t.claimed_by,
        "claimLeaseUntil": t.lease,
        "waitingFor": t.waiting_for,
        "blockedReason": t.blocked_reason,
    });
    extend(&mut v, extra);
    if view == TaskView::Full {
        let full = json!({
            "description": t.description,
            "checklist": checklist_items(cx, &t.id)?,
            "relations": relations(cx, &t.id)?,
        });
        extend(&mut v, full);
    }
    Ok(v)
}

pub(crate) fn extend(target: &mut Value, extra: Value) {
    if let (Value::Object(a), Value::Object(b)) = (target, extra) {
        for (k, v) in b {
            a.insert(k, v);
        }
    }
}

/// 前置依赖（BLOCKS 关系里以本任务为 target 的 source），按 local_no。
pub(crate) fn dependencies(cx: &Ctx<'_>, task: &str) -> Result<Vec<String>, DomainError> {
    cx.tx
        .prepare_cached(
            "SELECT s.local_no FROM work_item_relations r JOIN work_items s ON s.project_id = r.project_id AND s.id = r.source_id
             WHERE r.project_id = ?1 AND r.target_id = ?2 AND r.relation_type = 'BLOCKS' ORDER BY s.local_no",
        )
        .map_err(db)?
        .query_map(params![cx.p.id, task], |r| r.get::<_, i64>(0))
        .map_err(db)?
        .map(|n| n.map(|n| task_key(cx, n)))
        .collect::<rusqlite::Result<_>>()
        .map_err(db)
}

// ---------- 记录 ----------

const RECORD_COLS: &str = "id, local_no, kind, title, summary, detail, importance, scope, work_item_id, supersedes_id,
    status, topic, subject_key, op_id, source_type, source_actor_id, source_session_id, source_ref, created_at, updated_at";

pub(crate) fn record_not_found(reference: &str) -> DomainError {
    DomainError::new(
        ErrorCode::RECORD_NOT_FOUND,
        format!("记录 {reference} 不存在"),
    )
    .detail("entity", "RECORD")
    .detail("reference", reference)
}

/// 记录的内部 id：按 id，或按公开 key（字母要与 kind 一致）。
pub(crate) fn record_id(cx: &Ctx<'_>, reference: &str) -> Result<String, DomainError> {
    let trimmed = atm_domain::text::js_trim(reference);
    let by_id: Option<String> = cx
        .tx
        .query_row(
            "SELECT id FROM records WHERE project_id = ?1 AND id = ?2",
            params![cx.p.id, trimmed],
            |r| r.get(0),
        )
        .optional()
        .map_err(db)?;
    if let Some(id) = by_id {
        return Ok(id);
    }
    let Some((letter, no)) = keys::parse_record_key(&cx.p.code, trimmed) else {
        return Err(record_not_found(reference));
    };
    let row: Option<(String, String)> = cx
        .tx
        .query_row(
            "SELECT id, kind FROM records WHERE project_id = ?1 AND local_no = ?2",
            params![cx.p.id, no],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(db)?;
    match row {
        Some((id, kind)) if record_letter(&kind) == letter => Ok(id),
        _ => Err(record_not_found(reference)),
    }
}

fn record_key_of(cx: &Ctx<'_>, id: &str) -> Result<Option<String>, DomainError> {
    let row: Option<(i64, String)> = cx
        .tx
        .query_row(
            "SELECT local_no, kind FROM records WHERE project_id = ?1 AND id = ?2",
            params![cx.p.id, id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(db)?;
    Ok(row.map(|(no, kind)| keys::record_key(&cx.p.code, record_letter(&kind), no)))
}

fn task_key_of(cx: &Ctx<'_>, id: &str) -> Result<Option<String>, DomainError> {
    let no: Option<i64> = cx
        .tx
        .query_row(
            "SELECT local_no FROM work_items WHERE project_id = ?1 AND id = ?2",
            params![cx.p.id, id],
            |r| r.get(0),
        )
        .optional()
        .map_err(db)?;
    Ok(no.map(|n| task_key(cx, n)))
}

/// 同 topic 或同 subject_key 的其他 ACTIVE 记录，updated_at 降序最多 20 条（02 §1.6）。
pub(crate) fn related_records(
    cx: &Ctx<'_>,
    id: &str,
    topic: Option<&str>,
    subject: Option<&str>,
) -> Result<Vec<String>, DomainError> {
    if topic.is_none() && subject.is_none() {
        return Ok(Vec::new());
    }
    cx.tx
        .prepare_cached(
            "SELECT local_no, kind FROM records WHERE project_id = ?1 AND status = 'ACTIVE' AND id <> ?2
               AND ((?3 IS NOT NULL AND topic = ?3) OR (?4 IS NOT NULL AND subject_key = ?4))
             ORDER BY updated_at DESC, local_no DESC LIMIT 20",
        )
        .map_err(db)?
        .query_map(params![cx.p.id, id, topic, subject], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(db)?
        .map(|row| row.map(|(no, kind)| keys::record_key(&cx.p.code, record_letter(&kind), no)))
        .collect::<rusqlite::Result<_>>()
        .map_err(db)
}

/// 2.x `compactRecord`（snake_case）。
pub(crate) fn record(cx: &Ctx<'_>, id: &str) -> Result<Value, DomainError> {
    let row = cx
        .tx
        .query_row(
            &format!("SELECT {RECORD_COLS} FROM records WHERE project_id = ?1 AND id = ?2"),
            params![cx.p.id, id],
            |r| {
                Ok((
                    (
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, String>(6)?,
                        r.get::<_, String>(7)?,
                        r.get::<_, Option<String>>(8)?,
                        r.get::<_, Option<String>>(9)?,
                    ),
                    (
                        r.get::<_, String>(10)?,
                        r.get::<_, Option<String>>(11)?,
                        r.get::<_, Option<String>>(12)?,
                        r.get::<_, Option<String>>(13)?,
                        r.get::<_, String>(14)?,
                        r.get::<_, Option<String>>(15)?,
                        r.get::<_, Option<String>>(16)?,
                        r.get::<_, Option<String>>(17)?,
                        r.get::<_, String>(18)?,
                        r.get::<_, String>(19)?,
                    ),
                ))
            },
        )
        .optional()
        .map_err(db)?
        .ok_or_else(|| record_not_found(id))?;
    let (
        (id, no, kind, title, summary, detail, importance, scope, work_item, supersedes),
        (status, topic, subject, op_id, source_type, actor, session, source_ref, created, updated),
    ) = row;
    let work_item_key = match &work_item {
        Some(w) => task_key_of(cx, w)?,
        None => None,
    };
    let supersedes_key = match &supersedes {
        Some(s) => record_key_of(cx, s)?,
        None => None,
    };
    let related = related_records(cx, &id, topic.as_deref(), subject.as_deref())?;
    Ok(json!({
        "id": id,
        "key": keys::record_key(&cx.p.code, record_letter(&kind), no),
        "kind": kind,
        "title": title,
        "summary": summary,
        "detail": detail,
        "importance": importance,
        "scope": scope,
        "work_item_key": work_item_key,
        "supersedes": supersedes_key,
        "status": status,
        "topic": topic,
        "subject_key": subject,
        "related_records": related,
        "op_id": op_id,
        "source_type": source_type,
        "source_actor_id": actor,
        "source_session_id": session,
        "source_ref": source_ref,
        "created_at": created,
        "updated_at": updated,
    }))
}

// ---------- session ----------

pub(crate) const SESSION_COLS: &str = "s.id, s.agent_id, a.display_name, a.client_kind, a.capabilities_json,
    s.parent_session_id, s.predecessor_session_id, s.thread_id, s.role, s.cwd, s.work_state, s.connection_state,
    t.local_no, s.heartbeat_at, s.version, s.started_at, s.updated_at, s.closed_at, s.retirement_reason,
    s.close_reason, s.git_available, s.git_repo_root, s.worktree_root, s.git_common_dir, s.git_is_linked_worktree,
    s.git_branch, s.git_head, s.git_detached, s.git_dirty, s.git_error";

pub(crate) const SESSION_FROM: &str = "agent_sessions s
    JOIN agents a ON a.project_id = s.project_id AND a.id = s.agent_id
    LEFT JOIN work_items t ON t.project_id = s.project_id AND t.id = s.current_work_item_id";

/// 2.x `compactSession`（snake_case）。
pub(crate) fn session_from_row(code: &str, r: &Row<'_>) -> rusqlite::Result<Value> {
    let tri = |i: usize| -> rusqlite::Result<Value> {
        Ok(r.get::<_, Option<i64>>(i)?
            .map_or(Value::Null, |v| json!(v != 0)))
    };
    let heartbeat: Option<String> = r.get(13)?;
    let updated: String = r.get(16)?;
    Ok(json!({
        "id": r.get::<_, String>(0)?,
        "agent_id": r.get::<_, String>(1)?,
        "display_name": r.get::<_, String>(2)?,
        "client_kind": r.get::<_, String>(3)?,
        "capabilities": parse_json(r.get(4)?, json!([])),
        "parent_session_id": r.get::<_, Option<String>>(5)?,
        "predecessor_session_id": r.get::<_, Option<String>>(6)?,
        "thread_id": r.get::<_, Option<String>>(7)?,
        "role": r.get::<_, String>(8)?,
        "cwd": r.get::<_, Option<String>>(9)?,
        "work_state": r.get::<_, String>(10)?,
        "connection_state": r.get::<_, String>(11)?,
        "current_task_key": r.get::<_, Option<i64>>(12)?.map(|n| keys::task_key(code, n)),
        "heartbeat_at": heartbeat,
        "last_seen_at": heartbeat.clone().unwrap_or_else(|| updated.clone()),
        "version": r.get::<_, i64>(14)?,
        "started_at": r.get::<_, String>(15)?,
        "updated_at": updated,
        "closed_at": r.get::<_, Option<String>>(17)?,
        "retirement_reason": r.get::<_, Option<String>>(18)?,
        "close_reason": r.get::<_, Option<String>>(19)?,
        "git": {
            "available": r.get::<_, i64>(20)? != 0,
            "repo_root": r.get::<_, Option<String>>(21)?,
            "worktree_root": r.get::<_, Option<String>>(22)?,
            "common_dir": r.get::<_, Option<String>>(23)?,
            "is_linked_worktree": tri(24)?,
            "branch": r.get::<_, Option<String>>(25)?,
            "head": r.get::<_, Option<String>>(26)?,
            "detached": tri(27)?,
            "dirty": tri(28)?,
            "error": r.get::<_, Option<String>>(29)?,
        },
    }))
}

pub(crate) fn session(cx: &Ctx<'_>, id: &str) -> Result<Value, DomainError> {
    cx.tx
        .query_row(
            &format!(
                "SELECT {SESSION_COLS} FROM {SESSION_FROM} WHERE s.project_id = ?1 AND s.id = ?2"
            ),
            params![cx.p.id, id],
            |r| session_from_row(&cx.p.code, r),
        )
        .optional()
        .map_err(db)?
        .ok_or_else(|| {
            DomainError::new(
                ErrorCode::SESSION_NOT_FOUND,
                format!("Session 不存在：{id}"),
            )
            .detail("entity", "SESSION")
            .detail("reference", id)
        })
}

// ---------- 进度与项目摘要 ----------

pub(crate) const PROGRESS_COLS: &str =
    "p.id, w.local_no, p.percent, p.progress_bucket, p.summary, p.completed_json,
    p.next_json, p.blocker_text, p.actor, p.session_id, p.evidence_json, p.op_id, p.created_at";

pub(crate) const PROGRESS_FROM: &str =
    "progress_updates p JOIN work_items w ON w.project_id = p.project_id AND w.id = p.work_item_id";

fn completed_entries(v: Value) -> Value {
    match v {
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|entry| match entry {
                    Value::Object(m) => {
                        let mut out = Map::new();
                        out.insert("text".into(), m.get("text").cloned().unwrap_or(Value::Null));
                        if let Some(k) = m.get("workItemKey") {
                            out.insert("work_item_key".into(), k.clone());
                        }
                        Value::Object(out)
                    }
                    other => other,
                })
                .collect(),
        ),
        _ => json!([]),
    }
}

/// 2.x `compactProgress`（snake_case）。
pub(crate) fn progress_from_row(code: &str, r: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, String>(0)?,
        "task_key": keys::task_key(code, r.get(1)?),
        "percent": r.get::<_, Option<f64>>(2)?,
        "progress_bucket": r.get::<_, Option<i64>>(3)?,
        "summary": r.get::<_, String>(4)?,
        "completed": completed_entries(parse_json(r.get(5)?, json!([]))),
        "next": parse_json(r.get(6)?, json!([])),
        "blocker": r.get::<_, Option<String>>(7)?,
        "actor": r.get::<_, String>(8)?,
        "session_id": r.get::<_, Option<String>>(9)?,
        "evidence": parse_json(r.get(10)?, json!([])),
        "op_id": r.get::<_, Option<String>>(11)?,
        "created_at": r.get::<_, String>(12)?,
    }))
}

pub(crate) fn progress(cx: &Ctx<'_>, id: &str) -> Result<Value, DomainError> {
    cx.tx
        .query_row(
            &format!(
                "SELECT {PROGRESS_COLS} FROM {PROGRESS_FROM} WHERE p.project_id = ?1 AND p.id = ?2"
            ),
            params![cx.p.id, id],
            |r| progress_from_row(&cx.p.code, r),
        )
        .optional()
        .map_err(db)?
        .ok_or_else(|| {
            DomainError::new(
                ErrorCode::PROGRESS_NOT_FOUND,
                format!("进度记录不存在：{id}"),
            )
            .detail("entity", "PROGRESS")
            .detail("reference", id)
        })
}

/// 某任务最近 n 条进度，新的在前（ULID 在同一毫秒内也保持写入顺序）。
pub(crate) fn recent_progress(cx: &Ctx<'_>, task: &str, n: i64) -> Result<Vec<Value>, DomainError> {
    cx.tx
        .prepare_cached(&format!(
            "SELECT {PROGRESS_COLS} FROM {PROGRESS_FROM} WHERE p.project_id = ?1 AND p.work_item_id = ?2
             ORDER BY p.created_at DESC, p.id DESC LIMIT ?3"
        ))
        .map_err(db)?
        .query_map(params![cx.p.id, task, n], |r| progress_from_row(&cx.p.code, r))
        .map_err(db)?
        .collect::<rusqlite::Result<_>>()
        .map_err(db)
}

pub(crate) const PROJECT_UPDATE_COLS: &str = "id, health, summary, completed_json, risks_json, next_json, evidence_json,
    from_sequence, to_sequence, status, actor, published_at, created_at, updated_at, op_id, session_id";

pub(crate) fn project_update_from_row(r: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, String>(0)?,
        "health": r.get::<_, String>(1)?,
        "summary": r.get::<_, String>(2)?,
        "completed": parse_json(r.get(3)?, json!([])),
        "risks": parse_json(r.get(4)?, json!([])),
        "next": parse_json(r.get(5)?, json!([])),
        "evidence": parse_json(r.get(6)?, json!([])),
        "from_sequence": r.get::<_, i64>(7)?,
        "to_sequence": r.get::<_, i64>(8)?,
        "status": r.get::<_, String>(9)?,
        "actor": r.get::<_, String>(10)?,
        "published_at": r.get::<_, Option<String>>(11)?,
        "created_at": r.get::<_, String>(12)?,
        "updated_at": r.get::<_, String>(13)?,
        "op_id": r.get::<_, Option<String>>(14)?,
        "session_id": r.get::<_, Option<String>>(15)?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snake_case_keys() {
        let v = snake(
            json!({ "checklistSummary": { "evidenceRequired": 1 }, "relations": [{ "taskKey": "K" }] }),
        );
        assert_eq!(
            v,
            json!({ "checklist_summary": { "evidence_required": 1 }, "relations": [{ "task_key": "K" }] })
        );
    }
}
