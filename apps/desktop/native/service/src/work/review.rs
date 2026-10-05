//! Review 请求与提交（01 W-057～W-061；00 C-20、C-21、C-26；10 R1 的例外、R2 对 D14 的改写）。
//!
//! - 请求：绑定父任务的一条检查项与它此刻的版本、规范化的候选哈希。不改 Review 任务与检查项。
//! - 提交：只有 Review 任务领取者所在 lineage 里、ONLINE 的同 agent REVIEWER session 能提交，且不能是请求
//!   发起者的 agent（C-26：只防同名自审，**不**证明审查独立，W-061）。哈希逐字节等于绑定值、父检查项版本
//!   仍是绑定版本、Review 任务过完成门，才写 VERIFICATION 记录、（APPROVED 时）父检查项 DONE、Review 任务 DONE、
//!   提交行。reviewer 写父任务的检查项是绑定授权的受托写入，不检查父任务的领取归属（R1 唯一例外）。
//!
//! 任何一步失败都整事务回滚（W-062），计数器也不前进。

use super::checklist::{self, checklist_conflict, status_str};
use super::core::{Task, Work, db, with_next};
use super::patch::{
    check_gate, checked_evidence, claim_not_owned, complete_write, invalid_transition,
    version_required,
};
use crate::write::internal;
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::evidence::{self, Evidence, EvidenceSite, diff_hashes};
use atm_domain::gate::ChecklistStatus;
use atm_domain::keys::{self, RecordLetter};
use atm_domain::ownership;
use atm_domain::work::{Operation, Status, resolve};
use atm_store::search::{self, Doc};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

/// 规范化后的候选哈希：`(name, value)`，都已小写，按 name 排序（W-010）。
pub type Hashes = Vec<(String, String)>;

/// review_request 的入参。
#[derive(Clone, Debug, PartialEq)]
pub struct ReviewRequest {
    pub review_task_key: String,
    /// Review 任务版本（W-051）。review 的绑定版本本身就是语义，不能省（R11）；省略时报 EXPECTED_VERSION_REQUIRED。
    pub expected_review_task_version: Option<i64>,
    pub parent_checklist_id: String,
    pub expected_parent_checklist_version: i64,
    pub candidate_hashes: Hashes,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Approved,
    ChangesRequested,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Approved => "APPROVED",
            Verdict::ChangesRequested => "CHANGES_REQUESTED",
        }
    }
}

/// review_submit 的入参。
#[derive(Clone, Debug, PartialEq)]
pub struct ReviewSubmit {
    pub request_key: String,
    /// 给了就必须是请求绑定的 Review 任务（REST 可以只给 request_key）。
    pub review_task_key: Option<String>,
    pub expected_review_task_version: Option<i64>,
    pub verdict: Verdict,
    pub reviewed_hashes: Hashes,
    /// 只能是对象，1–100 条（W-011）。
    pub evidence: Vec<Evidence>,
}

fn hashes(path: &str, h: &Hashes) -> Result<Hashes, DomainError> {
    evidence::normalize_hashes(path, h.clone()).map_err(DomainError::invalid_argument)
}

/// 不碰存储的入参校验；返回哈希已规范化的请求（存储、比较与指纹都用它）。
pub(crate) fn validate_request(req: &ReviewRequest) -> Result<ReviewRequest, DomainError> {
    Ok(ReviewRequest {
        candidate_hashes: hashes("expected_candidate_hashes", &req.candidate_hashes)?,
        ..req.clone()
    })
}

pub(crate) fn validate_submit(req: &ReviewSubmit) -> Result<ReviewSubmit, DomainError> {
    let reviewed_hashes = hashes("reviewed_hashes", &req.reviewed_hashes)?;
    let evidence = checked_evidence("evidence", EvidenceSite::ReviewSubmit, &req.evidence)?;
    Ok(ReviewSubmit {
        reviewed_hashes,
        evidence,
        ..req.clone()
    })
}

pub(crate) fn hashes_json(h: &Hashes) -> Value {
    Value::Array(
        h.iter()
            .map(|(name, value)| json!({ "name": name, "value": value }))
            .collect(),
    )
}

fn parse_hashes(text: &str) -> Result<Hashes, DomainError> {
    let v: Value = serde_json::from_str(text).map_err(internal)?;
    v.as_array()
        .ok_or_else(|| internal("expected_candidate_hashes_json"))?
        .iter()
        .map(|h| {
            match (
                h.get("name").and_then(Value::as_str),
                h.get("value").and_then(Value::as_str),
            ) {
                (Some(n), Some(v)) => Ok((n.to_owned(), v.to_owned())),
                _ => Err(internal("expected_candidate_hashes_json item")),
            }
        })
        .collect()
}

/// review_requests 的一行。
struct RequestRow {
    id: String,
    local_no: i64,
    review_work_item_id: String,
    parent_work_item_id: String,
    parent_checklist_id: String,
    parent_checklist_version: i64,
    hashes: Hashes,
    created_by_agent_id: String,
    created_by_session_id: String,
    created_at: String,
}

fn load_request(
    w: &Work<'_>,
    clause: &str,
    value: &str,
) -> Result<Option<RequestRow>, DomainError> {
    let sql = format!(
        "SELECT id, local_no, review_work_item_id, parent_work_item_id, parent_checklist_id, parent_checklist_version,
                expected_candidate_hashes_json, created_by_agent_id, created_by_session_id, created_at
         FROM review_requests WHERE project_id = ?1 AND {clause}"
    );
    let row =
        w.tx.query_row(&sql, params![w.project, value], |r| {
            Ok((
                (
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ),
                (
                    r.get::<_, i64>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, String>(7)?,
                    r.get::<_, String>(8)?,
                    r.get::<_, String>(9)?,
                ),
            ))
        })
        .optional()
        .map_err(db)?;
    let Some(((id, local_no, review, parent, checklist_id), (version, hashes, agent, session, at))) =
        row
    else {
        return Ok(None);
    };
    Ok(Some(RequestRow {
        id,
        local_no,
        review_work_item_id: review,
        parent_work_item_id: parent,
        parent_checklist_id: checklist_id,
        parent_checklist_version: version,
        hashes: parse_hashes(&hashes)?,
        created_by_agent_id: agent,
        created_by_session_id: session,
        created_at: at,
    }))
}

fn request_view(w: &Work<'_>, r: &RequestRow, submission: Value) -> Result<Value, DomainError> {
    Ok(json!({
        "id": r.id,
        "key": keys::review_request_key(&w.code, r.local_no),
        "reviewTaskKey": w.task_key(&w.load(&r.review_work_item_id)?),
        "parentTaskKey": w.task_key(&w.load(&r.parent_work_item_id)?),
        "parentChecklistId": r.parent_checklist_id,
        "parentChecklistVersion": r.parent_checklist_version,
        "expectedCandidateHashes": hashes_json(&r.hashes),
        "createdByAgentId": r.created_by_agent_id,
        "createdBySessionId": r.created_by_session_id,
        "createdAt": r.created_at,
        "submission": submission,
    }))
}

fn task_version_check(
    w: &Work<'_>,
    task: &Task,
    key: &str,
    expected: Option<i64>,
    operation: &str,
) -> Result<(), DomainError> {
    match expected {
        None => Err(version_required(key, operation, task.version)),
        Some(e) if e != task.version => Err(w.version_conflict(task, e)?),
        Some(_) => Ok(()),
    }
}

// ---------- review_request（W-057）----------

pub(crate) fn request(w: &mut Work<'_>, req: &ReviewRequest) -> Result<Value, DomainError> {
    // 1. 需要 session。
    let Some(session) = w.actor().session.clone() else {
        return Err(DomainError::new(
            ErrorCode::REVIEW_REQUEST_REQUIRES_SESSION,
            "发起 Review 需要 session：先调用 atm_begin",
        ));
    };
    // 2. Review 任务。
    let review = w.load_by_key(&req.review_task_key)?;
    let review_key = w.task_key(&review);
    if review.kind != "REVIEW" {
        return Err(DomainError::new(
            ErrorCode::REVIEW_TASK_INVALID,
            format!(
                "任务 {review_key} 的类型是 {}，不是 REVIEW：先建一个 type=REVIEW 的子任务",
                review.kind
            ),
        )
        .detail("task_key", review_key.as_str())
        .detail("type", review.kind.as_str()));
    }
    // R1：review_request 也在领取归属的覆盖范围里。
    let claim = review.claim();
    ownership::may_modify(claim, w.requester(&claim), w.now)
        .map_err(|e| claim_not_owned(&review_key, e))?;
    // 3. 版本。
    task_version_check(
        w,
        &review,
        &review_key,
        req.expected_review_task_version,
        "review_request",
    )?;
    // 4. Review 任务不能已关闭。
    if matches!(review.status(), Status::Done | Status::Cancelled) {
        return Err(DomainError::new(
            ErrorCode::REVIEW_TASK_CLOSED,
            format!(
                "Review 任务 {review_key} 已是 {}：再审需要新建 REVIEW 任务",
                review.status().as_str()
            ),
        )
        .detail("task_key", review_key.as_str())
        .detail("status", review.status().as_str()));
    }
    // 5. 父检查项与它的版本。
    let item = checklist::load(w, &req.parent_checklist_id)?.ok_or_else(|| {
        DomainError::new(
            ErrorCode::CHECKLIST_NOT_FOUND,
            format!("检查项 {} 不存在", req.parent_checklist_id),
        )
        .detail("entity", "CHECKLIST")
        .detail("reference", req.parent_checklist_id.as_str())
    })?;
    let parent = w.load(&item.work_item_id)?;
    let parent_key = w.task_key(&parent);
    if item.version != req.expected_parent_checklist_version {
        return Err(checklist_conflict(
            &item,
            req.expected_parent_checklist_version,
            &parent_key,
            Some(parent.version),
        ));
    }
    // 6. Review 任务必须挂在检查项所属任务下面。
    if review.parent_id.as_deref() != Some(item.work_item_id.as_str()) {
        let actual = match &review.parent_id {
            Some(p) => Some(w.task_key(&w.load(p)?)),
            None => None,
        };
        return Err(DomainError::new(
            ErrorCode::REVIEW_BINDING_MISMATCH,
            format!("Review 任务 {review_key} 的父任务不是检查项所属的 {parent_key}"),
        )
        .detail("review_task_key", review_key.as_str())
        .detail("expected_parent_task_key", parent_key.as_str())
        .detail("actual_parent_task_key", actual));
    }
    // 7. 检查项不能已关闭。
    if matches!(
        item.status,
        ChecklistStatus::Done | ChecklistStatus::Skipped
    ) {
        return Err(DomainError::new(
            ErrorCode::REVIEW_CHECKLIST_CLOSED,
            format!(
                "检查项 {} 已是 {}，不需要再审",
                item.id,
                status_str(item.status)
            ),
        )
        .detail("checklist_id", item.id.as_str())
        .detail("status", status_str(item.status)));
    }
    // 8. 一个 Review 任务只绑定一个请求。
    if let Some(existing) = load_request(w, "review_work_item_id = ?2", &review.id)? {
        let existing_key = keys::review_request_key(&w.code, existing.local_no);
        return Err(DomainError::new(
            ErrorCode::REVIEW_REQUEST_CONFLICT,
            format!("Review 任务 {review_key} 已经有请求 {existing_key}：再审需要新建 REVIEW 任务"),
        )
        .detail("review_task_key", review_key.as_str())
        .detail("request_key", existing_key));
    }

    // 9. 写请求。
    let no = w.next_number("review_request")?;
    let id = w.ulid()?;
    let agent = w.actor().id.clone();
    w.tx.execute(
        "INSERT INTO review_requests (project_id, id, local_no, review_work_item_id, parent_work_item_id,
           parent_checklist_id, parent_checklist_version, expected_candidate_hashes_json, created_by_agent_id,
           created_by_session_id, created_at, op_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            w.project,
            id,
            no,
            review.id,
            item.work_item_id,
            item.id,
            item.version,
            hashes_json(&req.candidate_hashes).to_string(),
            agent,
            session,
            w.now_iso,
            w.ctx.op_id
        ],
    )
    .map_err(db)?;
    let key = keys::review_request_key(&w.code, no);
    w.emit(
        "review.requested",
        "REVIEW_REQUEST",
        &id,
        &json!({
            "key": key,
            "reviewTaskKey": review_key,
            "parentTaskKey": parent_key,
            "parentChecklistId": item.id,
            "expectedCandidateHashes": hashes_json(&req.candidate_hashes),
        }),
    )?;
    w.finish()?;
    let row =
        load_request(w, "id = ?2", &id)?.ok_or_else(|| internal("review request vanished"))?;
    Ok(json!({ "request": request_view(w, &row, Value::Null)?, "sequence": w.sequence }))
}

// ---------- review_submit（W-058～W-060）----------

fn begin_reviewer() -> Value {
    json!({
        "action": "begin_reviewer_session",
        "steps": [
            "用 atm_begin(role:\"REVIEWER\") 开一个 REVIEWER session",
            "用这个 session 领取并 start Review 任务",
            "用同一个 session 提交",
        ],
        "begin_arguments": { "role": "REVIEWER" },
    })
}

pub(crate) fn submit(w: &mut Work<'_>, req: &ReviewSubmit) -> Result<Value, DomainError> {
    let evidence =
        crate::evidence::normalize(w.tx, &w.project, &w.code, "evidence", req.evidence.clone())?;

    // 1–2. 提交者：ONLINE 的同 agent REVIEWER session。
    let Some(session) = w.actor().session.clone() else {
        return Err(with_next(
            DomainError::new(
                ErrorCode::REVIEWER_SESSION_REQUIRED,
                "提交 Review 需要 REVIEWER session",
            )
            .detail("recovery", begin_reviewer()),
            json!({ "operation": "begin", "role": "REVIEWER" }),
        ));
    };
    let agent = w.actor().id.clone();
    let (role, session_agent, connection): (String, String, String) = w
        .tx
        .query_row(
            "SELECT role, agent_id, connection_state FROM agent_sessions WHERE project_id = ?1 AND id = ?2",
            [&w.project, &session],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(db)?;
    let reason = if role != "REVIEWER" {
        Some("ROLE_NOT_REVIEWER")
    } else if session_agent != agent || connection != "ONLINE" {
        Some("SESSION_IDENTITY_INVALID")
    } else {
        None
    };
    if let Some(reason) = reason {
        return Err(with_next(
            DomainError::new(
                ErrorCode::REVIEWER_REQUIRED,
                "提交 Review 需要一个 ONLINE 的 REVIEWER session",
            )
            .detail("reason", reason)
            .detail("session_id", session.as_str())
            .detail("role", role)
            .detail("connection_state", connection)
            .detail("recovery", begin_reviewer()),
            json!({ "operation": "begin", "role": "REVIEWER" }),
        ));
    }

    // 3. 请求。
    let not_found = || {
        DomainError::new(
            ErrorCode::REVIEW_REQUEST_NOT_FOUND,
            format!("项目 {} 里没有 Review 请求 {}", w.code, req.request_key),
        )
        .detail("entity", "REVIEW_REQUEST")
        .detail("reference", req.request_key.as_str())
    };
    let no = keys::parse_review_request_key(&w.code, &req.request_key).ok_or_else(not_found)?;
    let request = load_request(w, "local_no = ?2", &no.to_string())?.ok_or_else(not_found)?;
    let request_key = keys::review_request_key(&w.code, request.local_no);
    let submitted: Option<i64> =
        w.tx.query_row(
            "SELECT local_no FROM review_submissions WHERE project_id = ?1 AND request_id = ?2",
            [&w.project, &request.id],
            |r| r.get(0),
        )
        .optional()
        .map_err(db)?;
    if let Some(sub) = submitted {
        return Err(DomainError::new(
            ErrorCode::REVIEW_ALREADY_SUBMITTED,
            format!("Review 请求 {request_key} 已经提交过：再审需要新建 REVIEW 任务并发起新请求"),
        )
        .detail("request_key", request_key.as_str())
        .detail("submission_key", keys::review_submission_key(&w.code, sub)));
    }

    // 4. 请求绑定的 Review 任务。
    let mut review = w.load(&request.review_work_item_id)?;
    if review.kind != "REVIEW" {
        return Err(internal(format!(
            "review request {request_key} points at a {} task",
            review.kind
        )));
    }
    let review_key = w.task_key(&review);
    if let Some(given) = &req.review_task_key {
        let given_task = w.load_by_key(given)?;
        if given_task.id != review.id {
            return Err(DomainError::new(
                ErrorCode::REVIEW_BINDING_MISMATCH,
                format!("Review 请求 {request_key} 绑定的是 {review_key}，不是 {given}"),
            )
            .detail("request_key", request_key.as_str())
            .detail("expected_review_task_key", review_key.as_str())
            .detail("actual_review_task_key", w.task_key(&given_task)));
        }
    }
    // C-26：不能审自己发起的请求。
    if request.created_by_agent_id == agent {
        return Err(DomainError::new(
            ErrorCode::REVIEW_SELF_NOT_ALLOWED,
            format!("Review 请求 {request_key} 是 agent {agent} 自己发起的，不能由同一个 agent 提交：请另一个 agent 来审"),
        )
        .detail("request_key", request_key.as_str())
        .detail("agent_id", agent.as_str()));
    }

    // 5. Review 任务版本。
    task_version_check(
        w,
        &review,
        &review_key,
        req.expected_review_task_version,
        "review_submit",
    )?;

    // 6. 领取身份（R2 改写的 D14）：领取者在提交者的 lineage 里、assignee 是提交者的 agent。不看租约。
    let claim = review.claim();
    let identity = match claim.session {
        None => Some(("REVIEW_TASK_UNCLAIMED", "claim_review_task")),
        Some(holder) if !w.actor().in_lineage(holder) || claim.assignee != Some(agent.as_str()) => {
            let stale = ownership::is_stale(claim.lease_until, w.now);
            Some((
                "REVIEW_TASK_CLAIMED_BY_OTHER_SESSION",
                if stale {
                    "take_over_stale_claim"
                } else {
                    "transfer_review_claim"
                },
            ))
        }
        Some(_) => None,
    };
    if let Some((reason, action)) = identity {
        return Err(with_next(
            DomainError::new(
                ErrorCode::REVIEW_IDENTITY_MISMATCH,
                format!("Review 任务 {review_key} 不是由这个 session（或它的 lineage）领取的：先领取再提交"),
            )
            .detail("reason", reason)
            .detail("review_task_key", review_key.as_str())
            .detail("assignee_agent_id", claim.assignee)
            .detail("claimed_by_session_id", claim.session)
            .detail("claim_lease_until", review.lease.as_deref())
            .detail("session_id", session.as_str())
            .detail("recovery", json!({ "action": action, "task_key": review_key })),
            json!({ "operation": "start", "task_key": review_key, "takeover_stale": action == "take_over_stale_claim" }),
        ));
    }

    // 7. 候选哈希逐字节比较。
    if let Some(diff) = diff_hashes(&request.hashes, &req.reviewed_hashes) {
        let bound = hashes_json(&request.hashes);
        let submitted = hashes_json(&req.reviewed_hashes);
        // 字段顺序有意义：MCP 错误正文截断时先保留可操作的差异（RV:567–570）。
        return Err(DomainError::new(
            ErrorCode::CANDIDATE_HASH_MISMATCH,
            format!("提交的候选哈希与请求 {request_key} 绑定的不一致：审的不是请求时的那一版"),
        )
        .detail("request_key", request_key.as_str())
        .detail("missing", diff.missing)
        .detail("extra", diff.extra)
        .detail(
            "mismatch",
            serde_json::to_value(diff.mismatch).map_err(internal)?,
        )
        .detail(
            "request",
            json!({
                "key": request_key,
                "review_task_key": review_key,
                "expected_review_task_version": review.version,
                "parent_checklist_id": request.parent_checklist_id,
                "parent_checklist_version": request.parent_checklist_version,
            }),
        )
        .detail(
            "request_lookup",
            json!({
                "project": w.code,
                "request_key": request_key,
                "transport": "REST",
                "method": "GET",
                "path": format!("/api/v1/projects/{}/reviews/requests/{request_key}", w.code),
                "authentication": "daemon_bearer",
            }),
        )
        .detail("bound", bound.clone())
        .detail("submitted", submitted.clone())
        .detail("expected", bound)
        .detail("actual", submitted));
    }

    // 8. 绑定关系仍成立（不成立是数据损坏）。
    let item = checklist::load(w, &request.parent_checklist_id)?.ok_or_else(|| {
        internal(format!(
            "review request {request_key}: parent checklist missing"
        ))
    })?;
    if item.work_item_id != request.parent_work_item_id
        || review.parent_id.as_deref() != Some(request.parent_work_item_id.as_str())
    {
        return Err(internal(format!(
            "review request {request_key}: binding no longer holds"
        )));
    }
    let mut parent = w.load(&request.parent_work_item_id)?;
    let parent_key = w.task_key(&parent);
    // 9. 父检查项从请求之后没被改过（D16：不继承旧绑定）。
    if item.version != request.parent_checklist_version {
        return Err(
            checklist_conflict(&item, request.parent_checklist_version, &parent_key, None)
                .detail("request_key", request_key.as_str()),
        );
    }
    // 10. Review 任务自己要能 complete，并过完成门。
    let target = resolve(Operation::Complete, review.state, false)
        .map_err(|e| invalid_transition(&review_key, e, false))?;
    check_gate(w, &review, &review_key, false)?;

    // ---------- 写入（W-060）----------
    let submission_no = w.next_number("review_submission")?;
    let record_no = w.next_number("record")?;
    let submission_key = keys::review_submission_key(&w.code, submission_no);
    let record_key = keys::record_key(&w.code, RecordLetter::Other, record_no);
    let verdict = req.verdict.as_str();
    let evidence_json = crate::evidence::to_json(&evidence);

    // 1. VERIFICATION 记录。
    let record_id = w.ulid()?;
    let title = format!("Review {verdict}: {review_key}");
    let summary = format!("{verdict} review for {review_key}");
    let detail = serde_json::to_string_pretty(&json!({
        "requestKey": request_key,
        "submissionKey": submission_key,
        "verdict": verdict,
        "expectedCandidateHashes": hashes_json(&request.hashes),
        "reviewedHashes": hashes_json(&req.reviewed_hashes),
        "evidence": evidence_json,
        "reviewerAgentId": agent,
        "reviewerSessionId": session,
    }))
    .map_err(internal)?;
    w.tx.execute(
        "INSERT INTO records (project_id, id, local_no, kind, title, summary, detail, importance, status, scope,
           work_item_id, actor, version, created_at, updated_at, source_type, source_actor_id, source_session_id,
           source_ref, topic, subject_key, op_id)
         VALUES (?1, ?2, ?3, 'VERIFICATION', ?4, ?5, ?6, 'HIGH', 'ACTIVE', 'REVIEW_AUDIT', ?7, ?8, 0, ?9, ?9,
                 'AGENT', ?8, ?10, ?11, 'review-verdict', ?12, ?13)",
        params![
            w.project,
            record_id,
            record_no,
            title,
            summary,
            detail,
            review.id,
            agent,
            w.now_iso,
            session,
            submission_key,
            review_key,
            w.ctx.op_id
        ],
    )
    .map_err(db)?;
    w.emit(
        "record.created",
        "RECORD",
        &record_id,
        &json!({
            "key": record_key,
            "kind": "VERIFICATION",
            "title": title,
            "summary": summary,
            "topic": "review-verdict",
            "subjectKey": review_key,
        }),
    )?;
    search::upsert_doc(
        w.tx,
        &Doc {
            project_id: &w.project,
            entity_type: "RECORD",
            entity_id: &record_id,
            entity_key: &record_key,
            title: &title,
            body: &format!("{summary}\n{detail}"),
            updated_at: &w.now_iso,
        },
    )
    .map_err(db)?;

    // 2. 只有 APPROVED：父检查项 DONE，证据换成提交的证据。父任务的领取不检查（R1 的唯一例外）。
    let mut item_after = item.clone();
    if req.verdict == Verdict::Approved {
        item_after = checklist::write_row(w, &item, ChecklistStatus::Done, Some(&evidence))?;
        checklist::bump_task(w, &mut parent, true);
        w.save(&parent)?;
        w.emit(
            "checklist.updated",
            "CHECKLIST",
            &item.id,
            &json!({
                "workItemId": parent.id,
                "taskKey": parent_key,
                "status": "DONE",
                "reviewRequestKey": request_key,
                "reviewSubmissionKey": submission_key,
            }),
        )?;
    } else {
        // 证据非空时仍推进父任务的 last_evidence_at（W-060 第 5 步），不算对父任务的修改，不推版本。
        w.tx.execute(
            "UPDATE work_items SET last_evidence_at = ?3 WHERE project_id = ?1 AND id = ?2",
            params![w.project, parent.id, w.now_iso],
        )
        .map_err(db)?;
    }

    // 3. Review 任务 DONE（C-03 清领取），会话 IDLE。
    let before = review.clone();
    review.last_evidence_at = Some(w.now_iso.clone());
    complete_write(
        w,
        &mut review,
        target,
        &review_key,
        Operation::Complete,
        &before,
        json!({ "operation": "review_submit", "reviewRequestKey": request_key, "verdict": verdict }),
    )?;
    // 4. 父任务链统一重算一次（C-21）。
    w.recompute_from(&parent.id);
    w.finish()?;

    // 5. 提交行：版本取事务里的最终值。
    let review_view = w.view(&review.id)?;
    let parent_view = w.view(&parent.id)?;
    let item_final = checklist::load(w, &item.id)?.unwrap_or(item_after);
    let submission_id = w.ulid()?;
    w.tx.execute(
        "INSERT INTO review_submissions (project_id, id, local_no, request_id, verdict, reviewed_hashes_json,
           evidence_json, record_id, reviewer_agent_id, reviewer_session_id, review_task_version,
           parent_checklist_version, created_at, op_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            w.project,
            submission_id,
            submission_no,
            request.id,
            verdict,
            hashes_json(&req.reviewed_hashes).to_string(),
            evidence_json.to_string(),
            record_id,
            agent,
            session,
            review_view["version"].as_i64(),
            item_final.version,
            w.now_iso,
            w.ctx.op_id
        ],
    )
    .map_err(db)?;

    // 6. review.submitted。
    w.emit(
        "review.submitted",
        "REVIEW_SUBMISSION",
        &submission_id,
        &json!({
            "key": submission_key,
            "requestKey": request_key,
            "reviewTaskKey": review_key,
            "parentTaskKey": parent_key,
            "parentChecklistId": item.id,
            "recordKey": record_key,
            "verdict": verdict,
            "reviewedHashes": hashes_json(&req.reviewed_hashes),
        }),
    )?;
    Ok(json!({
        "requestKey": request_key,
        "submissionKey": submission_key,
        "recordKey": record_key,
        "verdict": verdict,
        "reviewTask": { "key": review_key, "status": review_view["status"], "version": review_view["version"] },
        "parentChecklist": { "id": item.id, "status": status_str(item_final.status), "version": item_final.version },
        "parentTask": { "key": parent_key, "status": parent_view["status"], "version": parent_view["version"] },
        "sequence": w.sequence,
    }))
}
