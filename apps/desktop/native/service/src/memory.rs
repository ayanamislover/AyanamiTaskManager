//! 进度上报与记录类写入（02 §1.5–1.8、§5；00 02 C-02、C-13、C-23；10 R1、R2；R11 P2-1）。
//!
//! - 任务进度（`work.progress`）：R1 领取归属、去重桶（D29）、blocker 转 BLOCKED 并写阻塞记录、证据推进
//!   last_evidence_at。版本：任务行直接写入 +1，事务末尾的重算按 C-02 / C-21 不再额外加（02 S-083 的「至少 +2」
//!   是逐次重算的 2.x 现状，被 C-02 取代）。
//! - 项目进度（`project-update.publish`）：直接发布，没有去重。
//! - 记录（`record.create`）与反馈（同一 operation，固定形状）。

use crate::evidence;
use crate::fp::JsValue;
use crate::receipts::ReceiptScope;
use crate::work::Target;
use crate::work::core::{NewProgress, Work, db, invalid_argument, validation};
use crate::write::{Author, Family, FpInput, Rebind, Service, SessionRef, WriteRequest, Written};
use atm_domain::capability::Capability;
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::evidence::{Evidence, EvidenceSite};
use atm_domain::keys::{self, RecordLetter};
use atm_domain::ownership;
use atm_domain::principal::Principal;
use atm_domain::text::{js_trim, utf16_len};
use atm_domain::work::{Operation, WaitingOn, resolve};
use atm_store::search::{self, Doc};
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Map, Value, json};

pub const PROGRESS_OPERATION: &str = "work.progress";
pub const PROJECT_UPDATE_OPERATION: &str = "project-update.publish";
pub const RECORD_OPERATION: &str = "record.create";

fn request(
    target: &Target,
    capability: Capability,
    operation: &'static str,
    fingerprint: FpInput,
) -> WriteRequest {
    WriteRequest {
        capability,
        operation,
        op_id: target.op_id.clone(),
        scope: ReceiptScope::project(target.project_id.clone()),
        session: target.session.as_ref().map(|s| SessionRef {
            project_id: target.project_id.clone(),
            session_id: s.clone(),
        }),
        actor: None,
        expected_generation: target.expected_generation,
        fingerprint,
        compat_v1: None,
        replay_guard: None,
        rebind: Rebind::Create,
    }
}

fn bounded(field: &str, v: &str, max: usize) -> Result<(), DomainError> {
    if utf16_len(v) > max {
        return Err(
            invalid_argument(field, format!("{field} 最多 {max} 个字符")).detail("max", max),
        );
    }
    Ok(())
}

fn trimmed_list(list: &[String]) -> Vec<String> {
    list.iter().map(|s| js_trim(s).to_owned()).collect()
}

fn fp_evidence(tx: &Transaction<'_>, project: &str, list: &[Evidence]) -> Value {
    let trimmed = atm_domain::evidence::validate("evidence", EvidenceSite::Progress, list.to_vec())
        .unwrap_or_else(|_| list.to_vec());
    evidence::to_json(&evidence::normalize_or_raw(tx, project, &trimmed))
}

// ---------- 进度 ----------

/// `completed[]` 的一条：字符串，或 `{text, work_item_key?}`（02 §5.1）。
#[derive(Clone, Debug, PartialEq)]
pub enum Completed {
    Text(String),
    Item {
        text: String,
        work_item_key: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProgressScope {
    Task,
    Project,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProgressRequest {
    pub scope: ProgressScope,
    pub task_key: Option<String>,
    pub summary: String,
    /// 只用于 task。
    pub percent: Option<f64>,
    pub completed: Vec<Completed>,
    pub next: Vec<String>,
    pub evidence: Vec<Evidence>,
    /// None：这次不新写 blocker（不关闭已有的）。
    pub blocker: Option<String>,
    /// 只用于 project：`ON_TRACK` / `AT_RISK` / `OFF_TRACK` / `UNKNOWN`。
    pub health: Option<String>,
}

impl ProgressRequest {
    pub fn task(key: impl Into<String>, summary: impl Into<String>) -> Self {
        ProgressRequest {
            scope: ProgressScope::Task,
            task_key: Some(key.into()),
            summary: summary.into(),
            percent: None,
            completed: Vec::new(),
            next: Vec::new(),
            evidence: Vec::new(),
            blocker: None,
            health: None,
        }
    }
}

const HEALTH: [&str; 4] = ["ON_TRACK", "AT_RISK", "OFF_TRACK", "UNKNOWN"];

fn validate_progress(r: &ProgressRequest) -> Result<(), DomainError> {
    let summary = js_trim(&r.summary);
    if summary.is_empty() {
        return Err(invalid_argument("summary", "summary 不能为空"));
    }
    bounded("summary", summary, 500)?;
    if r.completed.len() > 20 {
        return Err(invalid_argument("completed", "completed 最多 20 条"));
    }
    for c in &r.completed {
        let text = match c {
            Completed::Text(t) => t.as_str(),
            Completed::Item { text, .. } => {
                if js_trim(text).is_empty() {
                    return Err(invalid_argument(
                        "completed.text",
                        "completed 的 text 不能为空",
                    ));
                }
                text.as_str()
            }
        };
        bounded("completed", js_trim(text), 500)?;
    }
    if r.next.len() > 20 {
        return Err(invalid_argument("next", "next 最多 20 条"));
    }
    for n in &r.next {
        bounded("next", js_trim(n), 500)?;
    }
    atm_domain::evidence::validate("evidence", EvidenceSite::Progress, r.evidence.clone())
        .map_err(DomainError::invalid_argument)?;
    if let Some(b) = &r.blocker {
        bounded("blocker", b, 1000)?;
    }
    match r.scope {
        ProgressScope::Task => {
            if r.health.is_some() {
                return Err(invalid_argument("health", "health 只用于 scope=project"));
            }
            if r.task_key.is_none() {
                return Err(validation("task_key", "scope=task 需要 task_key"));
            }
            if let Some(p) = r.percent
                && !(0.0..=100.0).contains(&p)
            {
                return Err(invalid_argument("percent", "percent 必须在 0 到 100 之间"));
            }
        }
        ProgressScope::Project => {
            if r.percent.is_some() {
                return Err(invalid_argument("percent", "percent 只用于 scope=task"));
            }
            if let Some(h) = &r.health
                && !HEALTH.contains(&js_trim(h).to_uppercase().as_str())
            {
                return Err(invalid_argument(
                    "health",
                    format!("health 只能是 {}", HEALTH.join(" / ")),
                )
                .detail("allowed", HEALTH.to_vec()));
            }
        }
    }
    Ok(())
}

/// S-080：`round(clamp(p)/10)*10`，JS `Math.round`（.5 向上）。
pub fn bucket(percent: f64) -> i64 {
    let p = percent.clamp(0.0, 100.0);
    #[allow(clippy::cast_possible_truncation)]
    let b = ((p / 10.0) + 0.5).floor() as i64;
    b * 10
}

/// 00 02 C-13：纯空白的 blocker 视为没有。
fn blocker_text(r: &ProgressRequest) -> Option<&str> {
    r.blocker.as_deref().map(js_trim).filter(|b| !b.is_empty())
}

fn completed_json(list: &[Completed], keys_of: impl Fn(&str) -> Value) -> Value {
    Value::Array(
        list.iter()
            .map(|c| match c {
                Completed::Text(t) => json!(t),
                Completed::Item {
                    text,
                    work_item_key,
                } => {
                    let mut m = Map::new();
                    m.insert("text".into(), json!(js_trim(text)));
                    if let Some(k) = work_item_key {
                        m.insert("workItemKey".into(), keys_of(k));
                    }
                    Value::Object(m)
                }
            })
            .collect(),
    )
}

fn progress_fp(
    tx: &Transaction<'_>,
    project: &str,
    r: &ProgressRequest,
    family: Family,
) -> Option<JsValue> {
    let ev = fp_evidence(tx, project, &r.evidence);
    let v = match (family, r.scope) {
        (Family::CanonV2, scope) => {
            let mut m = Map::new();
            m.insert(
                "scope".into(),
                json!(if scope == ProgressScope::Task {
                    "task"
                } else {
                    "project"
                }),
            );
            if let Some(k) = &r.task_key {
                m.insert("task_key".into(), json!(keys::normalize(k)));
            }
            m.insert("summary".into(), json!(js_trim(&r.summary)));
            if let Some(p) = r.percent {
                m.insert("percent".into(), json!(p));
            }
            // 00 02 C-02：只规范化一次，completed 里的任务 key 也规范化（修掉 X-06）。
            m.insert(
                "completed".into(),
                completed_json(&r.completed, |k| json!(keys::normalize(k))),
            );
            m.insert("next".into(), json!(trimmed_list(&r.next)));
            m.insert("evidence".into(), ev);
            if let Some(b) = blocker_text(r) {
                m.insert("blocker".into(), json!(b));
            }
            if let Some(h) = &r.health {
                m.insert("health".into(), json!(js_trim(h).to_uppercase()));
            }
            Value::Object(m)
        }
        (Family::KernelV1, ProgressScope::Task) => {
            let mut m = Map::new();
            m.insert("taskKey".into(), json!(r.task_key.as_deref().map(js_trim)?));
            m.insert("summary".into(), json!(js_trim(&r.summary)));
            m.insert(
                "completed".into(),
                completed_json(&r.completed, |k| json!(k)),
            );
            m.insert("next".into(), json!(r.next));
            m.insert("evidence".into(), ev);
            if let Some(p) = r.percent {
                m.insert("percent".into(), json!(p));
            }
            if let Some(b) = &r.blocker {
                m.insert("blocker".into(), json!(b));
            }
            Value::Object(m)
        }
        (Family::KernelV1, ProgressScope::Project) => {
            let health = r.health.as_deref().map_or_else(
                || {
                    if blocker_text(r).is_some() {
                        "AT_RISK".to_owned()
                    } else {
                        "UNKNOWN".to_owned()
                    }
                },
                |h| js_trim(h).to_uppercase(),
            );
            let risks: Vec<&str> = blocker_text(r).into_iter().collect();
            json!({
                "health": health,
                "summary": js_trim(&r.summary),
                "completed": completed_json(&r.completed, |k| json!(k)),
                "risks": risks,
                "next": r.next,
                "evidence": ev,
            })
        }
        (Family::KnowledgeV1, _) => return None,
    };
    Some(JsValue::from_json(&v))
}

fn task_progress(w: &mut Work<'_>, r: &ProgressRequest) -> Result<Value, DomainError> {
    let ev = evidence::normalize(
        w.tx,
        &w.project,
        &w.code,
        "evidence",
        atm_domain::evidence::validate("evidence", EvidenceSite::Progress, r.evidence.clone())
            .map_err(DomainError::invalid_argument)?,
    )?;
    let key_in = r.task_key.as_deref().unwrap_or_default();
    let mut task = w.load_by_key(key_in)?;
    let key = w.task_key(&task);
    // R1：进度上报无论带不带 blocker、percent 都受领取归属约束。
    let claim = task.claim();
    if let Err(e) = ownership::may_modify(claim, w.requester(&claim), w.now) {
        return Err(crate::work::claim_not_owned(&key, e));
    }
    let blocker = blocker_text(r);
    let block_target = match blocker {
        Some(_) => Some(resolve(Operation::Block, task.state, false).map_err(|e| {
            crate::work::invalid_transition(&key, e, false).detail("reason", "progress blocker")
        })?),
        None => None,
    };
    let summary = js_trim(&r.summary).to_owned();
    let bucket = r.percent.map(bucket);
    // S-081：同一任务最近一条进度桶相同、摘要相同、没有证据、没有 blocker → noop。
    use sha2::{Digest, Sha256};
    let hash = format!("{:x}", Sha256::digest(summary.as_bytes()));
    let last: Option<(String, Option<i64>, String)> = w
        .tx
        .query_row(
            "SELECT id, progress_bucket, summary_hash FROM progress_updates WHERE project_id = ?1 AND work_item_id = ?2
             ORDER BY created_at DESC, id DESC LIMIT 1",
            [&w.project, &task.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(db)?;
    if let Some((last_id, last_bucket, last_hash)) = &last
        && *last_bucket == bucket
        && *last_hash == hash
        && ev.is_empty()
        && blocker.is_none()
    {
        let seq: i64 =
            w.tx.query_row(
                "SELECT project_seq FROM projects WHERE id = ?1",
                [&w.project],
                |row| row.get(0),
            )
            .map_err(db)?;
        return progress_receipt(w, &task.id, &key, last_id, true, seq);
    }

    let completed = completed_json(&r.completed, |k| json!(k));
    let progress_id = w.add_progress(
        &task,
        &key,
        &NewProgress {
            summary: &summary,
            percent: r.percent,
            bucket,
            completed,
            next: json!(trimmed_list(&r.next)),
            blocker,
            evidence: evidence::to_json(&ev),
        },
    )?;
    // 00 02 C-23：不带 percent 时保留原来的 reported_progress。
    if let Some(b) = bucket {
        #[allow(clippy::cast_precision_loss)]
        {
            task.reported_progress = Some(b as f64);
        }
    }
    if let (Some(text), Some(target)) = (blocker, block_target) {
        task.state = target;
        task.clear_waiting();
        task.blocked_reason = Some(text.to_owned());
        w.add_blocker(&task.id, text)?;
    }
    if !ev.is_empty() {
        task.last_evidence_at = Some(w.now_iso.clone());
    }
    w.transfer_claim(&mut task);
    task.version += 1;
    w.save(&task)?;
    w.recompute_from(&task.id);
    w.finish()?;
    let seq = w.sequence;
    progress_receipt(w, &task.id, &key, &progress_id, false, seq)
}

fn progress_receipt(
    w: &Work<'_>,
    id: &str,
    key: &str,
    progress_id: &str,
    noop: bool,
    sequence: i64,
) -> Result<Value, DomainError> {
    let t = w.load(id)?;
    Ok(json!({
        "taskKey": key,
        "progressId": progress_id,
        "noop": noop,
        "taskVersion": t.version,
        "state": {
            "status": t.state.status().as_str(),
            "waitingOn": t.state.waiting_on().map(WaitingOn::as_str),
            "claimedBySessionId": t.claimed_by,
            "claimLeaseUntil": t.lease,
        },
        "sequence": sequence,
    }))
}

fn project_progress(w: &mut Work<'_>, r: &ProgressRequest) -> Result<Value, DomainError> {
    let ev = evidence::normalize(
        w.tx,
        &w.project,
        &w.code,
        "evidence",
        atm_domain::evidence::validate("evidence", EvidenceSite::Progress, r.evidence.clone())
            .map_err(DomainError::invalid_argument)?,
    )?;
    // 02 §5.6 + C-02：completed 里引用的任务必须存在，并改写成规范 key。
    let mut completed = Vec::with_capacity(r.completed.len());
    for c in &r.completed {
        completed.push(match c {
            Completed::Text(t) => json!(t),
            Completed::Item {
                text,
                work_item_key,
            } => {
                let mut m = Map::new();
                m.insert("text".into(), json!(js_trim(text)));
                if let Some(k) = work_item_key {
                    let t = w.load_by_key(k)?;
                    m.insert("workItemKey".into(), json!(w.task_key(&t)));
                }
                Value::Object(m)
            }
        });
    }
    let blocker = blocker_text(r);
    let health = r.health.as_deref().map_or_else(
        || {
            if blocker.is_some() {
                "AT_RISK".to_owned()
            } else {
                "UNKNOWN".to_owned()
            }
        },
        |h| js_trim(h).to_uppercase(),
    );
    let risks: Vec<&str> = blocker.into_iter().collect();
    let from: i64 = w
        .tx
        .query_row(
            "SELECT COALESCE(MAX(to_sequence), 0) FROM project_updates WHERE project_id = ?1 AND status = 'PUBLISHED'",
            [&w.project],
            |row| row.get(0),
        )
        .map_err(db)?;
    let to: i64 =
        w.tx.query_row(
            "SELECT project_seq FROM projects WHERE id = ?1",
            [&w.project],
            |row| row.get(0),
        )
        .map_err(db)?;
    let id = w.ulid()?;
    let actor = w.actor().clone();
    let summary = js_trim(&r.summary).to_owned();
    w.tx.execute(
        "INSERT INTO project_updates (project_id, id, health, summary, completed_json, risks_json, next_json, from_sequence,
           to_sequence, status, actor, published_at, created_at, updated_at, op_id, evidence_json, session_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'PUBLISHED', ?10, ?11, ?11, ?11, ?12, ?13, ?14)",
        params![
            w.project,
            id,
            health,
            summary,
            Value::Array(completed.clone()).to_string(),
            json!(risks).to_string(),
            json!(trimmed_list(&r.next)).to_string(),
            from,
            to,
            actor.id,
            w.now_iso,
            w.ctx.op_id,
            evidence::to_json(&ev).to_string(),
            actor.session,
        ],
    )
    .map_err(db)?;
    w.emit(
        "project.update.published",
        "PROJECT_UPDATE",
        &id,
        &json!({ "id": id, "health": health, "summary": summary, "fromSequence": from, "toSequence": to }),
    )?;
    Ok(json!({
        "projectUpdateId": id,
        "health": health,
        "fromSequence": from,
        "toSequence": to,
        "sequence": w.sequence,
    }))
}

// ---------- 记录与反馈 ----------

const KINDS: [&str; 6] = [
    "DECISION",
    "CONSTRAINT",
    "FACT",
    "RISK",
    "REFERENCE",
    "LESSON",
];
const IMPORTANCE: [&str; 4] = ["LOW", "NORMAL", "HIGH", "CRITICAL"];
/// 记录 summary 的上限（code point，02 §1.8、MCP schema）。
pub const SUMMARY_MAX: usize = 300;

#[derive(Clone, Debug, PartialEq)]
pub struct RecordRequest {
    pub kind: String,
    pub title: String,
    pub summary: String,
    pub detail: String,
    pub importance: Option<String>,
    pub scope: Option<String>,
    pub work_item_key: Option<String>,
    pub supersedes: Option<String>,
    pub topic: Option<String>,
    pub subject_key: Option<String>,
}

impl RecordRequest {
    pub fn new(kind: &str, title: &str, summary: &str) -> Self {
        RecordRequest {
            kind: kind.into(),
            title: title.into(),
            summary: summary.into(),
            detail: String::new(),
            importance: None,
            scope: None,
            work_item_key: None,
            supersedes: None,
            topic: None,
            subject_key: None,
        }
    }
}

/// 规范化之后的记录请求（只规范化一次，C-02）。
#[derive(Clone, Debug)]
struct Record {
    kind: String,
    title: String,
    summary: String,
    detail: String,
    importance: String,
    scope: String,
    work_item_key: Option<String>,
    supersedes: Option<String>,
    topic: Option<String>,
    subject_key: Option<String>,
    /// R11 P2-1：summary 超长时截断，全文移到 detail。
    truncated: bool,
}

fn empty_null(v: &Option<String>) -> Option<String> {
    v.as_deref()
        .map(js_trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn normalize_record(r: &RecordRequest, kinds: &[&str]) -> Result<Record, DomainError> {
    let kind = js_trim(&r.kind).to_uppercase();
    if !kinds.contains(&kind.as_str()) {
        return Err(
            invalid_argument("kind", format!("kind 只能是 {}", kinds.join(" / ")))
                .detail("got", r.kind.as_str())
                .detail("allowed", kinds.to_vec()),
        );
    }
    let title = js_trim(&r.title).to_owned();
    if title.is_empty() {
        return Err(invalid_argument("title", "title 不能为空"));
    }
    bounded("title", &title, 400)?;
    let full = js_trim(&r.summary).to_owned();
    if full.is_empty() {
        return Err(invalid_argument("summary", "summary 不能为空"));
    }
    bounded("detail", &r.detail, 100_000)?;
    let truncated = full.chars().count() > SUMMARY_MAX;
    let (summary, detail) = if truncated {
        let head: String = full.chars().take(SUMMARY_MAX - 1).collect();
        let detail = if r.detail.trim().is_empty() {
            full.clone()
        } else {
            format!("{full}\n\n{}", r.detail)
        };
        (format!("{head}…"), detail)
    } else {
        (full, r.detail.clone())
    };
    let importance = r
        .importance
        .as_deref()
        .map_or("NORMAL".to_owned(), |i| js_trim(i).to_uppercase());
    if !IMPORTANCE.contains(&importance.as_str()) {
        return Err(invalid_argument(
            "importance",
            format!("importance 只能是 {}", IMPORTANCE.join(" / ")),
        )
        .detail("allowed", IMPORTANCE.to_vec()));
    }
    let topic = empty_null(&r.topic);
    let subject_key = empty_null(&r.subject_key);
    if let Some(t) = &topic {
        bounded("topic", t, 200)?;
    }
    if let Some(s) = &subject_key {
        bounded("subject_key", s, 200)?;
    }
    Ok(Record {
        kind,
        title,
        summary,
        detail,
        importance,
        scope: r
            .scope
            .as_deref()
            .map(js_trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("PROJECT")
            .to_owned(),
        work_item_key: empty_null(&r.work_item_key),
        supersedes: empty_null(&r.supersedes),
        topic,
        subject_key,
        truncated,
    })
}

/// kernel-v1 的 `record.create`：supersedes 在 2.x 闸门里换成了记录 **id**（02 §3.3）。
fn record_fp(tx: &Transaction<'_>, project: &str, r: &Record, family: Family) -> Option<JsValue> {
    let v = match family {
        Family::CanonV2 => json!({
            "kind": r.kind, "title": r.title, "summary": r.summary, "detail": r.detail,
            "importance": r.importance, "scope": r.scope,
            "work_item_key": r.work_item_key.as_deref().map(keys::normalize),
            "supersedes": r.supersedes.as_deref().map(keys::normalize),
            "topic": r.topic, "subject_key": r.subject_key,
        }),
        Family::KernelV1 => {
            let mut m = Map::new();
            for (k, v) in [
                ("kind", &r.kind),
                ("title", &r.title),
                ("summary", &r.summary),
                ("detail", &r.detail),
                ("importance", &r.importance),
                ("scope", &r.scope),
            ] {
                m.insert(k.into(), json!(v));
            }
            if let Some(k) = &r.work_item_key {
                m.insert("workItemKey".into(), json!(k));
            }
            if let Some(s) = &r.supersedes {
                let code: Option<String> = tx
                    .query_row(
                        "SELECT code FROM projects WHERE id = ?1",
                        [project],
                        |row| row.get(0),
                    )
                    .ok();
                let id = code
                    .and_then(|c| keys::parse_record_key(&c, s))
                    .and_then(|(_, no)| {
                        tx.query_row(
                            "SELECT id FROM records WHERE project_id = ?1 AND local_no = ?2",
                            params![project, no],
                            |row| row.get::<_, String>(0),
                        )
                        .ok()
                    })
                    .unwrap_or_else(|| s.clone());
                m.insert("supersedes".into(), json!(id));
            }
            if let Some(t) = &r.topic {
                m.insert("topic".into(), json!(t));
            }
            if let Some(s) = &r.subject_key {
                m.insert("subjectKey".into(), json!(s));
            }
            Value::Object(m)
        }
        Family::KnowledgeV1 => return None,
    };
    Some(JsValue::from_json(&v))
}

fn record_not_found(reference: &str) -> DomainError {
    DomainError::new(
        ErrorCode::RECORD_NOT_FOUND,
        format!("记录 {reference} 不存在"),
    )
    .detail("entity", "RECORD")
    .detail("reference", reference)
}

fn create_record(w: &mut Work<'_>, r: &Record) -> Result<Value, DomainError> {
    let work_item = match &r.work_item_key {
        Some(k) => Some(w.load_by_key(k)?),
        None => None,
    };
    let supersedes = match &r.supersedes {
        Some(reference) => {
            let (_, no) = keys::parse_record_key(&w.code, reference)
                .ok_or_else(|| record_not_found(reference))?;
            let row: Option<(String, String)> =
                w.tx.query_row(
                    "SELECT id, scope FROM records WHERE project_id = ?1 AND local_no = ?2",
                    params![w.project, no],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(db)?;
            let (id, scope) = row.ok_or_else(|| record_not_found(reference))?;
            if scope == "REVIEW_AUDIT" {
                return Err(DomainError::new(
                    ErrorCode::IMMUTABLE_RECORD,
                    format!("记录 {reference} 是 Review 审计记录，不能被替代"),
                )
                .detail("record_key", reference.as_str()));
            }
            Some(id)
        }
        None => None,
    };
    if let Some(old) = &supersedes {
        w.tx.execute(
            "UPDATE records SET status = 'SUPERSEDED', version = version + 1, updated_at = ?3 WHERE project_id = ?1 AND id = ?2",
            params![w.project, old, w.now_iso],
        )
        .map_err(db)?;
    }
    let no = w.next_number("record")?;
    let letter = if r.kind == "DECISION" {
        RecordLetter::Decision
    } else {
        RecordLetter::Other
    };
    let key = keys::record_key(&w.code, letter, no);
    let id = w.ulid()?;
    let actor = w.actor().clone();
    w.tx.execute(
        "INSERT INTO records (project_id, id, local_no, kind, title, summary, detail, importance, status, supersedes_id, scope,
           work_item_id, actor, version, created_at, updated_at, source_type, source_actor_id, source_session_id, topic,
           subject_key, op_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'ACTIVE', ?9, ?10, ?11, ?12, 0, ?13, ?13, ?14, ?12, ?15, ?16, ?17, ?18)",
        params![
            w.project,
            id,
            no,
            r.kind,
            r.title,
            r.summary,
            r.detail,
            r.importance,
            supersedes,
            r.scope,
            work_item.as_ref().map(|t| t.id.clone()),
            actor.id,
            w.now_iso,
            actor.event_type,
            actor.session,
            r.topic,
            r.subject_key,
            w.ctx.op_id
        ],
    )
    .map_err(db)?;
    w.emit(
        "record.created",
        "RECORD",
        &id,
        &json!({ "key": key, "kind": r.kind, "title": r.title, "summary": r.summary, "topic": r.topic, "subjectKey": r.subject_key }),
    )?;
    search::upsert_doc(
        w.tx,
        &Doc {
            project_id: &w.project,
            entity_type: "RECORD",
            entity_id: &id,
            entity_key: &key,
            title: &r.title,
            body: &format!("{}\n{}", r.summary, r.detail),
            updated_at: &w.now_iso,
        },
    )
    .map_err(db)?;
    // 02 §1.6：同 topic 或同 subject_key 的其他 ACTIVE 记录，updated_at 降序最多 20 条。
    let related: Vec<String> = w
        .tx
        .prepare(
            "SELECT local_no, kind FROM records WHERE project_id = ?1 AND status = 'ACTIVE' AND id <> ?2
               AND ((?3 IS NOT NULL AND topic = ?3) OR (?4 IS NOT NULL AND subject_key = ?4))
             ORDER BY updated_at DESC, local_no DESC LIMIT 20",
        )
        .map_err(db)?
        .query_map(params![w.project, id, r.topic, r.subject_key], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(db)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db)?
        .into_iter()
        .map(|(n, k)| {
            let l = if k == "DECISION" { RecordLetter::Decision } else { RecordLetter::Other };
            keys::record_key(&w.code, l, n)
        })
        .collect();
    let mut result = json!({
        "record": {
            "id": id,
            "key": key,
            "kind": r.kind,
            "title": r.title,
            "summary": r.summary,
            "importance": r.importance,
            "status": "ACTIVE",
            "scope": r.scope,
            "workItemKey": work_item.as_ref().map(|t| w.task_key(t)),
            "supersedes": r.supersedes,
            "topic": r.topic,
            "subjectKey": r.subject_key,
            "version": 0,
            "createdAt": w.now_iso,
            "relatedRecords": related,
        },
        "sequence": w.sequence,
    });
    if r.truncated {
        result["summaryTruncated"] = json!(true);
    }
    Ok(result)
}

/// atm_feedback 的输入（02 §1.8）。
#[derive(Clone, Debug, PartialEq)]
pub struct FeedbackRequest {
    pub summary: String,
    pub detail: Option<String>,
    pub tool: Option<String>,
    pub severity: Option<String>,
    pub task_key: Option<String>,
}

fn feedback_record(f: &FeedbackRequest) -> RecordRequest {
    let summary = js_trim(&f.summary).to_owned();
    let mut detail =
        String::from("本条反馈仅保存在本机 ATM 项目数据库，不会自动上传到任何外部服务。");
    if let Some(t) = f.tool.as_deref().map(js_trim).filter(|t| !t.is_empty()) {
        detail.push_str(&format!("\n涉及工具：{t}"));
    }
    detail.push_str("\n\n");
    detail.push_str(
        f.detail
            .as_deref()
            .map(js_trim)
            .filter(|d| !d.is_empty())
            .unwrap_or("未提供详细说明。"),
    );
    RecordRequest {
        kind: "RISK".into(),
        title: format!("ATM Agent 反馈：{summary}"),
        summary,
        detail,
        importance: f.severity.clone(),
        scope: Some("ATM_FEEDBACK".into()),
        work_item_key: f.task_key.clone(),
        supersedes: None,
        topic: Some("atm-agent-feedback".into()),
        subject_key: None,
    }
}

impl Service {
    /// atm_progress_add（02 §5）。
    pub fn add_progress(
        &self,
        principal: &Principal,
        target: &Target,
        req: ProgressRequest,
    ) -> Result<Written, DomainError> {
        validate_progress(&req)?;
        let project = target.project_id.clone();
        let fp_req = req.clone();
        let fingerprint: FpInput =
            Box::new(move |tx, family, _: &Author| progress_fp(tx, &project, &fp_req, family));
        let operation = match req.scope {
            ProgressScope::Task => PROGRESS_OPERATION,
            ProgressScope::Project => PROJECT_UPDATE_OPERATION,
        };
        self.write(
            principal,
            request(target, Capability::ProgressAdd, operation, fingerprint),
            move |tx, ctx| {
                let mut w = Work::open(tx, ctx)?;
                match req.scope {
                    ProgressScope::Task => task_progress(&mut w, &req),
                    ProgressScope::Project => project_progress(&mut w, &req),
                }
            },
        )
    }

    /// atm_record（02 §1.6）。公开入口只能写前六种 kind。
    pub fn create_record(
        &self,
        principal: &Principal,
        target: &Target,
        req: RecordRequest,
    ) -> Result<Written, DomainError> {
        let r = normalize_record(&req, &KINDS)?;
        self.record_write(principal, target, Capability::RecordCreate, r)
    }

    /// atm_feedback（02 §1.8）：固定形状的 RISK 记录，operation 与 record 相同。
    pub fn feedback(
        &self,
        principal: &Principal,
        target: &Target,
        req: FeedbackRequest,
    ) -> Result<Written, DomainError> {
        if js_trim(&req.summary).is_empty() {
            return Err(invalid_argument("summary", "summary 不能为空"));
        }
        let r = normalize_record(&feedback_record(&req), &KINDS)?;
        self.record_write(principal, target, Capability::RecordFeedback, r)
    }

    fn record_write(
        &self,
        principal: &Principal,
        target: &Target,
        capability: Capability,
        r: Record,
    ) -> Result<Written, DomainError> {
        let project = target.project_id.clone();
        let fp_r = r.clone();
        let fingerprint: FpInput =
            Box::new(move |tx, family, _: &Author| record_fp(tx, &project, &fp_r, family));
        self.write(
            principal,
            request(target, capability, RECORD_OPERATION, fingerprint),
            move |tx, ctx| {
                let mut w = Work::open(tx, ctx)?;
                let result = create_record(&mut w, &r)?;
                Ok(result)
            },
        )
    }
}
