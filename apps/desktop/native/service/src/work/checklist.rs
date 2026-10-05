//! 检查项更新（01 W-051、W-053～W-056；00 C-07/10 R1、C-10、C-12、C-27；R11 P1-1 第 2、4 条）。
//!
//! 检查顺序：
//! - single：证据规范化（W-012）→ 检查项存在 → 属于 task_key → 领取归属（R1）→ 任务不是终态（C-27）
//!   → **检查项**版本 → 必证（W-055 决议后的证据）。
//! - batch：证据规范化 → 任务 → R1 → C-27 → 汇总全部问题（任务版本 + 逐条 NOT_FOUND / TASK_MISMATCH /
//!   EVIDENCE_REQUIRED）→ 一次拒绝：只有版本问题时 VERSION_CONFLICT，否则 COMPLETION_GATE_FAILED（C-10）。
//!   **不**比较各检查项自己的版本。
//! - complete 带 checklist：引用可以是 id、从 1 开始的序号或标题全文；规则同 batch，但没有版本问题
//!   （版本由 complete 自己比）。
//!
//! 写入：检查项 status、证据（不传保留、`[]` 清空、非空替换）、version+1；所属任务 version+1（W-056：
//! 检查项是任务自己的数据，直接写入，不受 C-02 约束），证据非空时推进 last_evidence_at，lineage 写入照 R2
//! 转移并续租领取；祖先只在派生进度确实变化时加一（C-02，事务末尾统一重算一次，C-21）。

use super::core::{Task, Work, checklist_status, db, invalid_argument, validation, with_next};
use super::patch::{checked_evidence, claim_not_owned, lineage_holds, version_required};
use crate::write::internal;
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::evidence::{Evidence, EvidenceSite};
use atm_domain::gate::{self, BatchRejection, ChecklistProblem, ChecklistStatus};
use atm_domain::ownership;
use atm_domain::text::js_trim;
use atm_domain::work::{PatchKind, Status, VersionNeed, version_need};
use rusqlite::{OptionalExtension, Row as SqlRow, params};
use serde_json::{Value, json};
use std::collections::HashSet;

/// 一次最多更新的检查项条数（W-054）。
pub const MAX_ITEMS: usize = 100;

pub fn status_str(s: ChecklistStatus) -> &'static str {
    match s {
        ChecklistStatus::Todo => "TODO",
        ChecklistStatus::Doing => "DOING",
        ChecklistStatus::Done => "DONE",
        ChecklistStatus::Skipped => "SKIPPED",
    }
}

/// checklist_single 的入参。
#[derive(Clone, Debug, PartialEq)]
pub struct ChecklistSingle {
    /// 检查项所属任务。MCP 恒给；REST 与界面的 `PATCH /checklist/:id` 不给，跳过归属校验（W-053 第 3 步）。
    pub task_key: Option<String>,
    pub checklist_id: String,
    /// 比的是检查项自己的版本（W-051）。R11 P1-1：本 lineage 持有任务的领取时可省略。
    pub expected_checklist_version: Option<i64>,
    /// 调用方用的是 v6 之前的参数名 `expected_version`（C-12）：照样接受，回执里给弃用提示。
    pub legacy_version_name: bool,
    pub status: ChecklistStatus,
    /// W-055：None 保留原证据，`Some([])` 清空，非空整体替换。
    pub evidence: Option<Vec<Evidence>>,
}

/// checklist_batch 的一条。
#[derive(Clone, Debug, PartialEq)]
pub struct ChecklistChange {
    pub checklist_id: String,
    pub status: ChecklistStatus,
    pub evidence: Option<Vec<Evidence>>,
}

/// checklist_batch 的入参。
#[derive(Clone, Debug, PartialEq)]
pub struct ChecklistBatch {
    pub task_key: String,
    /// 比的是任务版本（W-051）。R11 P1-1：本 lineage 持有领取时可省略。
    pub expected_version: Option<i64>,
    pub items: Vec<ChecklistChange>,
}

/// complete 带的检查项引用（R11 P1-1 第 4 条）。
#[derive(Clone, Debug, PartialEq)]
pub enum ChecklistRef {
    /// 从 1 开始的序号，按检查项的创建顺序。
    Index(usize),
    /// 检查项 id；不是本任务检查项的 id 时，按标题全文（trim 后）匹配。
    Text(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct CompleteChecklist {
    pub item: ChecklistRef,
    pub status: ChecklistStatus,
    pub evidence: Option<Vec<Evidence>>,
}

/// 检查项的一行。
#[derive(Clone, Debug)]
pub(crate) struct Row {
    pub id: String,
    pub work_item_id: String,
    pub title: String,
    pub kind: String,
    pub status: ChecklistStatus,
    pub weight: f64,
    pub evidence_required: bool,
    pub evidence: Value,
    pub version: i64,
}

const COLUMNS: &str =
    "id, work_item_id, title, kind, status, weight, evidence_required, evidence_json, version";

fn row(r: &SqlRow<'_>) -> rusqlite::Result<Result<Row, String>> {
    let status: String = r.get(4)?;
    let evidence: String = r.get(7)?;
    let Some(status) = checklist_status(&status) else {
        return Ok(Err(format!("checklist status {status}")));
    };
    let Ok(evidence) = serde_json::from_str::<Value>(&evidence) else {
        return Ok(Err(format!("checklist evidence_json {evidence}")));
    };
    Ok(Ok(Row {
        id: r.get(0)?,
        work_item_id: r.get(1)?,
        title: r.get(2)?,
        kind: r.get(3)?,
        status,
        weight: r.get(5)?,
        evidence_required: r.get::<_, i64>(6)? != 0,
        evidence,
        version: r.get(8)?,
    }))
}

impl Row {
    fn evidence_len(&self) -> usize {
        self.evidence.as_array().map_or(0, Vec::len)
    }

    /// 2.x TaskChecklistView 的字段。
    pub fn view(&self) -> Value {
        json!({
            "id": self.id,
            "title": self.title,
            "kind": self.kind,
            "status": status_str(self.status),
            "weight": self.weight,
            "evidenceRequired": self.evidence_required,
            "evidence": self.evidence,
            "version": self.version,
        })
    }
}

pub(crate) fn load(w: &Work<'_>, id: &str) -> Result<Option<Row>, DomainError> {
    let sql = format!("SELECT {COLUMNS} FROM checklist_items WHERE project_id = ?1 AND id = ?2");
    match w
        .tx
        .query_row(&sql, params![w.project, id], row)
        .optional()
        .map_err(db)?
    {
        None => Ok(None),
        Some(Ok(r)) => Ok(Some(r)),
        Some(Err(bad)) => Err(internal(format!("corrupt checklist row: {bad}"))),
    }
}

/// 任务的全部检查项，按创建顺序（与完成门、序号引用同序）。
fn for_task(w: &Work<'_>, task_id: &str) -> Result<Vec<Row>, DomainError> {
    let sql = format!(
        "SELECT {COLUMNS} FROM checklist_items WHERE project_id = ?1 AND work_item_id = ?2 ORDER BY created_at, id"
    );
    w.tx.prepare_cached(&sql)
        .map_err(db)?
        .query_map(params![w.project, task_id], row)
        .map_err(db)?
        .map(|r| {
            r.map_err(db)?
                .map_err(|bad| internal(format!("corrupt checklist row: {bad}")))
        })
        .collect()
}

/// 写一条检查项（W-055 的证据决议），返回写后的行。
pub(crate) fn write_row(
    w: &Work<'_>,
    r: &Row,
    status: ChecklistStatus,
    evidence: Option<&[Evidence]>,
) -> Result<Row, DomainError> {
    let evidence = match evidence {
        Some(list) => crate::evidence::to_json(list),
        None => r.evidence.clone(),
    };
    w.tx.execute(
        "UPDATE checklist_items SET status = ?3, evidence_json = ?4, version = version + 1, updated_at = ?5
         WHERE project_id = ?1 AND id = ?2",
        params![w.project, r.id, status_str(status), evidence.to_string(), w.now_iso],
    )
    .map_err(db)?;
    Ok(Row {
        status,
        evidence,
        version: r.version + 1,
        ..r.clone()
    })
}

/// 检查项写入对所属任务的效果（W-056），只改内存里的行；调用方负责写回。
pub(crate) fn bump_task(w: &mut Work<'_>, task: &mut Task, evidence_given: bool) {
    w.transfer_claim(task);
    task.version += 1;
    if evidence_given {
        task.last_evidence_at = Some(w.now_iso.clone());
    }
    w.recompute_from(&task.id);
}

fn checklist_not_found(reference: &str) -> DomainError {
    DomainError::new(
        ErrorCode::CHECKLIST_NOT_FOUND,
        format!("检查项 {reference} 不存在"),
    )
    .detail("entity", "CHECKLIST")
    .detail("reference", reference)
}

/// C-27：终态任务的检查项只读。
fn terminal(task: &Task, key: &str) -> Result<(), DomainError> {
    let status = task.status();
    if !matches!(status, Status::Done | Status::Cancelled) {
        return Ok(());
    }
    Err(with_next(
        DomainError::new(
            ErrorCode::WORK_ITEM_TERMINAL,
            format!(
                "任务 {key} 已是 {}，检查项只读；要改先 reopen",
                status.as_str()
            ),
        )
        .detail("task_key", key)
        .detail("status", status.as_str()),
        json!({ "operation": "reopen", "task_key": key, "expected_version": task.version }),
    ))
}

fn may_modify(w: &Work<'_>, task: &Task, key: &str) -> Result<(), DomainError> {
    let claim = task.claim();
    ownership::may_modify(claim, w.requester(&claim), w.now).map_err(|e| claim_not_owned(key, e))
}

fn normalized(
    w: &Work<'_>,
    path: &str,
    list: Option<&Vec<Evidence>>,
) -> Result<Option<Vec<Evidence>>, DomainError> {
    let Some(list) = list else { return Ok(None) };
    let list = checked_evidence(path, EvidenceSite::Checklist, list)?;
    crate::evidence::normalize(w.tx, &w.project, &w.code, path, list).map(Some)
}

fn evidence_violated(r: &Row, status: ChecklistStatus, evidence: Option<&Vec<Evidence>>) -> bool {
    gate::evidence_required_violated(
        status,
        r.evidence_required,
        gate::resolved_evidence_count(r.evidence_len(), evidence.map(Vec::len)),
    )
}

/// 02 §3.3 的兼容重放：旧形状不含 taskKey，重放前仍做 W-053 第 2、3 步（检查项存在、属于 task_key）。
pub(crate) fn replay_guard(
    tx: &rusqlite::Transaction<'_>,
    project: &str,
    checklist_id: &str,
    task_key: &str,
) -> Result<(), DomainError> {
    let code: String = tx
        .query_row("SELECT code FROM projects WHERE id = ?1", [project], |r| {
            r.get(0)
        })
        .map_err(db)?;
    let owner: Option<i64> = tx
        .query_row(
            "SELECT w.local_no FROM checklist_items c
             JOIN work_items w ON w.project_id = c.project_id AND w.id = c.work_item_id
             WHERE c.project_id = ?1 AND c.id = ?2",
            [project, checklist_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(db)?;
    let Some(owner) = owner else {
        return Err(checklist_not_found(checklist_id));
    };
    let given = atm_domain::keys::parse_task_key(&code, task_key);
    let exists = match given {
        Some(no) => tx
            .query_row(
                "SELECT 1 FROM work_items WHERE project_id = ?1 AND local_no = ?2",
                params![project, no],
                |_| Ok(()),
            )
            .optional()
            .map_err(db)?
            .is_some(),
        None => false,
    };
    if !exists {
        return Err(DomainError::new(
            ErrorCode::WORK_ITEM_NOT_FOUND,
            format!("项目 {code} 里没有任务 {task_key}"),
        )
        .detail("entity", "WORK_ITEM")
        .detail("reference", task_key));
    }
    if given != Some(owner) {
        let actual = atm_domain::keys::task_key(&code, owner);
        let expected = given.map(|no| atm_domain::keys::task_key(&code, no));
        return Err(DomainError::new(
            ErrorCode::CHECKLIST_TASK_MISMATCH,
            format!("检查项 {checklist_id} 属于任务 {actual}，不属于 {task_key}"),
        )
        .detail("entity", "CHECKLIST")
        .detail("key", checklist_id)
        .detail("expected_task", expected)
        .detail("actual_task", actual));
    }
    Ok(())
}

// ---------- 入参校验（不碰存储）----------

pub(crate) fn validate_single(req: &ChecklistSingle) -> Result<(), DomainError> {
    if let Some(v) = req.expected_checklist_version
        && v < 0
    {
        return Err(invalid_argument(
            "expected_checklist_version",
            "expected_checklist_version 不能是负数",
        ));
    }
    if let Some(list) = &req.evidence {
        checked_evidence("evidence", EvidenceSite::Checklist, list)?;
    }
    Ok(())
}

pub(crate) fn validate_batch(req: &ChecklistBatch) -> Result<(), DomainError> {
    if req.items.is_empty() || req.items.len() > MAX_ITEMS {
        return Err(
            validation("items", format!("items 必须是 1 至 {MAX_ITEMS} 条"))
                .detail("min", 1)
                .detail("max", MAX_ITEMS)
                .detail("actual", req.items.len()),
        );
    }
    if let Some(v) = req.expected_version
        && v < 0
    {
        return Err(invalid_argument(
            "expected_version",
            "expected_version 不能是负数",
        ));
    }
    let mut seen = HashSet::new();
    for (i, item) in req.items.iter().enumerate() {
        if !seen.insert(item.checklist_id.as_str()) {
            return Err(validation(
                "items",
                format!("检查项 {} 在 items 里出现了不止一次", item.checklist_id),
            )
            .detail("issue", "duplicate_checklist_id")
            .detail("checklist_id", item.checklist_id.as_str())
            .detail("item_index", i));
        }
        if let Some(list) = &item.evidence {
            checked_evidence(
                &format!("items[{i}].evidence"),
                EvidenceSite::Checklist,
                list,
            )?;
        }
    }
    Ok(())
}

pub(crate) fn validate_complete(list: &[CompleteChecklist]) -> Result<(), DomainError> {
    if list.is_empty() || list.len() > MAX_ITEMS {
        return Err(
            invalid_argument("checklist", format!("checklist 必须是 1 至 {MAX_ITEMS} 条"))
                .detail("min", 1)
                .detail("max", MAX_ITEMS)
                .detail("actual", list.len()),
        );
    }
    for (i, c) in list.iter().enumerate() {
        match &c.item {
            ChecklistRef::Index(0) => {
                return Err(
                    invalid_argument("checklist.item", "checklist 的序号从 1 开始")
                        .detail("item_index", i),
                );
            }
            ChecklistRef::Text(t) if js_trim(t).is_empty() => {
                return Err(
                    invalid_argument("checklist.item", "checklist 的 item 不能为空")
                        .detail("item_index", i),
                );
            }
            _ => {}
        }
        if let Some(list) = &c.evidence {
            checked_evidence(
                &format!("checklist[{i}].evidence"),
                EvidenceSite::Checklist,
                list,
            )?;
        }
    }
    Ok(())
}

// ---------- checklist_single ----------

pub(crate) fn single(w: &mut Work<'_>, req: &ChecklistSingle) -> Result<Value, DomainError> {
    let evidence = normalized(w, "evidence", req.evidence.as_ref())?;
    let r = load(w, &req.checklist_id)?.ok_or_else(|| checklist_not_found(&req.checklist_id))?;
    let mut task = match &req.task_key {
        Some(task_key) => {
            let task = w.load_by_key(task_key)?;
            if task.id != r.work_item_id {
                let actual = w.task_key(&w.load(&r.work_item_id)?);
                let expected = w.task_key(&task);
                return Err(DomainError::new(
                    ErrorCode::CHECKLIST_TASK_MISMATCH,
                    format!("检查项 {} 属于任务 {actual}，不属于 {expected}", r.id),
                )
                .detail("entity", "CHECKLIST")
                .detail("key", r.id.as_str())
                .detail("expected_task", expected)
                .detail("actual_task", actual));
            }
            task
        }
        None => w.load(&r.work_item_id)?,
    };
    let key = w.task_key(&task);
    may_modify(w, &task, &key)?;
    terminal(&task, &key)?;
    match req.expected_checklist_version {
        Some(expected) if expected != r.version => {
            return Err(with_next(
                checklist_conflict(&r, expected, &key, Some(task.version)),
                json!({ "operation": "checklist", "task_key": key, "checklist_id": r.id, "expected_checklist_version": r.version }),
            ));
        }
        Some(_) => {}
        None => {
            if version_need(PatchKind::ChecklistSingle, lineage_holds(w, &task))
                == VersionNeed::Required
            {
                return Err(checklist_version_required(&r, &key));
            }
        }
    }
    if evidence_violated(&r, req.status, evidence.as_ref()) {
        return Err(DomainError::new(
            ErrorCode::COMPLETION_GATE_FAILED,
            format!("检查项 {} 要求证据：置 DONE 时带上 evidence", r.id),
        )
        .detail("task_key", key.as_str())
        .detail(
            "reasons",
            json!([{ "checklist_id": r.id, "code": "EVIDENCE_REQUIRED" }]),
        ));
    }

    let written = write_row(w, &r, req.status, evidence.as_deref())?;
    bump_task(
        w,
        &mut task,
        evidence.as_ref().is_some_and(|e| !e.is_empty()),
    );
    w.save(&task)?;
    w.emit(
        "checklist.updated",
        "CHECKLIST",
        &r.id,
        &json!({ "workItemId": task.id, "taskKey": key, "status": status_str(req.status) }),
    )?;
    w.finish()?;
    let view = w.view(&task.id)?;
    let mut result = json!({
        "checklist": written.view(),
        "taskKey": key,
        "taskProgress": view["progress"],
        "taskVersion": view["version"],
        "sequence": w.sequence,
    });
    if req.legacy_version_name {
        // C-12：旧参数名在 v6 期间照样接受。
        result["deprecations"] = json!([{
            "field": "expected_version",
            "use": "expected_checklist_version",
            "message": "checklist 的 expected_version 已改名为 expected_checklist_version（比的是检查项自己的版本）",
        }]);
    }
    Ok(result)
}

/// 检查项的 VERSION_CONFLICT（W-053 第 4 步、W-057 第 5 步、W-059 第 9 步；C-19 快照按 entity 分支）。
/// `task_version`：给了且恰好等于 expected 时，提示传成了任务版本（TASK_VERSION_PASSED）。
pub(crate) fn checklist_conflict(
    r: &Row,
    expected: i64,
    task_key: &str,
    task_version: Option<i64>,
) -> DomainError {
    let passed_task_version = task_version == Some(expected);
    let message = if passed_task_version {
        format!(
            "expected_checklist_version 比的是检查项 {} 自己的版本（{}），传进来的 {expected} 是任务 {task_key} 的版本",
            r.id, r.version
        )
    } else {
        format!(
            "检查项 {} 的版本已是 {}，请求基于 {expected}：先看 current，再决定是否重做",
            r.id, r.version
        )
    };
    let mut e = DomainError::new(ErrorCode::VERSION_CONFLICT, message)
        .detail("entity", "CHECKLIST")
        .detail("key", r.id.as_str())
        .detail("checklist_id", r.id.as_str())
        .detail("task_key", task_key)
        .detail("expected", expected)
        .detail("actual", r.version)
        .detail("expected_version", expected)
        .detail("current_version", r.version)
        .detail("version_gap", r.version - expected)
        .detail("current", r.view());
    if passed_task_version {
        e = e
            .detail("hint", "TASK_VERSION_PASSED")
            .detail("task_version", expected)
            .detail("checklist_version", r.version)
            .detail(
                "usage",
                "这个版本参数比的是检查项自己的 version（task_get 的 checklist[].version），不是任务版本",
            );
    }
    e
}

fn checklist_version_required(r: &Row, task_key: &str) -> DomainError {
    with_next(
        DomainError::new(
            ErrorCode::EXPECTED_VERSION_REQUIRED,
            format!(
                "改别人领取中或未领取的任务的检查项需要 expected_checklist_version：检查项 {} 当前版本是 {}",
                r.id, r.version
            ),
        )
        .detail("task_key", task_key)
        .detail("checklist_id", r.id.as_str())
        .detail("operation", "checklist")
        .detail("current_version", r.version),
        json!({ "operation": "checklist", "task_key": task_key, "checklist_id": r.id, "expected_checklist_version": r.version }),
    )
}

// ---------- checklist_batch ----------

/// 一条已解析、已规范化的变更。
struct Planned {
    row: Row,
    status: ChecklistStatus,
    evidence: Option<Vec<Evidence>>,
}

pub(crate) fn batch(w: &mut Work<'_>, req: &ChecklistBatch) -> Result<Value, DomainError> {
    let mut evidence = Vec::with_capacity(req.items.len());
    for (i, item) in req.items.iter().enumerate() {
        evidence.push(normalized(
            w,
            &format!("items[{i}].evidence"),
            item.evidence.as_ref(),
        )?);
    }
    let mut task = w.load_by_key(&req.task_key)?;
    let key = w.task_key(&task);
    may_modify(w, &task, &key)?;
    terminal(&task, &key)?;
    if req.expected_version.is_none()
        && version_need(PatchKind::ChecklistBatch, lineage_holds(w, &task)) == VersionNeed::Required
    {
        return Err(version_required(&key, "checklist", task.version));
    }

    let mut problems = Vec::new();
    let conflict = req.expected_version.filter(|v| *v != task.version);
    let mut planned = Vec::with_capacity(req.items.len());
    let mut valid_versions = Vec::new();
    for (item, evidence) in req.items.iter().zip(evidence) {
        let Some(r) = load(w, &item.checklist_id)? else {
            problems.push(ChecklistProblem::NotFound {
                checklist_id: item.checklist_id.clone(),
            });
            continue;
        };
        if r.work_item_id != task.id {
            problems.push(ChecklistProblem::TaskMismatch {
                checklist_id: item.checklist_id.clone(),
            });
            continue;
        }
        valid_versions.push(r.version);
        if evidence_violated(&r, item.status, evidence.as_ref()) {
            problems.push(ChecklistProblem::EvidenceRequired {
                checklist_id: item.checklist_id.clone(),
            });
            continue;
        }
        planned.push(Planned {
            row: r,
            status: item.status,
            evidence,
        });
    }
    if let Some(expected) = conflict {
        // W-054：传进来的恰好是某个有效检查项的版本，多半是把检查项版本当成了任务版本。
        let hint = valid_versions
            .contains(&expected)
            .then_some("CHECKLIST_VERSION_PASSED");
        problems.insert(
            0,
            ChecklistProblem::VersionConflict {
                task_key: key.clone(),
                expected,
                actual: task.version,
                hint,
            },
        );
    }
    if let Some(rejection) = gate::batch_rejection(&problems) {
        return Err(batch_rejected(w, &task, &key, rejection, &problems)?);
    }

    let evidence_given = planned
        .iter()
        .any(|p| p.evidence.as_ref().is_some_and(|e| !e.is_empty()));
    let mut views = Vec::with_capacity(planned.len());
    let mut items = Vec::with_capacity(planned.len());
    for p in &planned {
        views.push(write_row(w, &p.row, p.status, p.evidence.as_deref())?.view());
        items.push(json!({ "checklistId": p.row.id, "status": status_str(p.status) }));
    }
    bump_task(w, &mut task, evidence_given);
    w.save(&task)?;
    w.emit(
        "checklist.batch_updated",
        "WORK_ITEM",
        &task.id,
        &json!({
            "key": key,
            "taskKey": key,
            "expectedVersion": req.expected_version,
            "taskVersion": task.version,
            "items": items,
        }),
    )?;
    w.finish()?;
    let view = w.view(&task.id)?;
    Ok(json!({
        "taskKey": key,
        "checklist": views,
        "taskProgress": view["progress"],
        "taskVersion": view["version"],
        "updatedCount": planned.len(),
        "sequence": w.sequence,
    }))
}

fn batch_rejected(
    w: &Work<'_>,
    task: &Task,
    key: &str,
    rejection: BatchRejection,
    problems: &[ChecklistProblem],
) -> Result<DomainError, DomainError> {
    let reasons = serde_json::to_value(problems).map_err(internal)?;
    match rejection {
        BatchRejection::VersionConflict => {
            let Some(ChecklistProblem::VersionConflict { expected, hint, .. }) = problems.first()
            else {
                return Err(internal("version-only rejection without a version problem"));
            };
            let mut e = w
                .version_conflict(task, *expected)?
                .detail("reasons", reasons);
            if let Some(hint) = hint {
                e = e.detail("hint", *hint).detail(
                    "usage",
                    "checklist_batch 的 expected_version 比的是任务版本，不是检查项的 version",
                );
            }
            Ok(with_next(
                e,
                json!({ "operation": "checklist", "task_key": key, "expected_version": task.version }),
            ))
        }
        BatchRejection::GateFailed => Ok(gate_failed(key, problems, reasons)),
    }
}

fn gate_failed(key: &str, problems: &[ChecklistProblem], reasons: Value) -> DomainError {
    let parts: Vec<String> = problems
        .iter()
        .map(|p| match p {
            ChecklistProblem::VersionConflict {
                expected, actual, ..
            } => format!("任务版本已是 {actual}（请求基于 {expected}）"),
            ChecklistProblem::NotFound { checklist_id } => {
                format!("检查项 {checklist_id} 不存在")
            }
            ChecklistProblem::TaskMismatch { checklist_id } => {
                format!("检查项 {checklist_id} 不属于任务 {key}")
            }
            ChecklistProblem::EvidenceRequired { checklist_id } => {
                format!("检查项 {checklist_id} 要求证据")
            }
        })
        .collect();
    DomainError::new(
        ErrorCode::COMPLETION_GATE_FAILED,
        format!("检查项更新被拒绝，全部未写入：{}", parts.join("；")),
    )
    .detail("task_key", key)
    .detail("reasons", reasons)
}

// ---------- complete 带 checklist ----------

/// R11 P1-1 第 4 条：在 complete 的事务里先写检查项。任务行只在内存里改（版本 +1），由 complete 写回。
pub(crate) fn for_complete(
    w: &mut Work<'_>,
    task: &mut Task,
    key: &str,
    list: &[CompleteChecklist],
) -> Result<(), DomainError> {
    let rows = for_task(w, &task.id)?;
    let mut problems = Vec::new();
    let mut planned: Vec<Planned> = Vec::with_capacity(list.len());
    let mut seen = HashSet::new();
    for (i, c) in list.iter().enumerate() {
        let evidence = normalized(w, &format!("checklist[{i}].evidence"), c.evidence.as_ref())?;
        let (reference, found) = match &c.item {
            ChecklistRef::Index(n) => (format!("#{n}"), rows.get(n - 1).cloned()),
            ChecklistRef::Text(text) => {
                let text = js_trim(text);
                match rows.iter().find(|r| r.id == text) {
                    Some(r) => (text.to_owned(), Some(r.clone())),
                    None => {
                        let by_title: Vec<&Row> = rows.iter().filter(|r| r.title == text).collect();
                        if by_title.len() > 1 {
                            let ids: Vec<&str> = by_title.iter().map(|r| r.id.as_str()).collect();
                            return Err(validation(
                                "checklist.item",
                                format!(
                                    "任务 {key} 有多个标题为「{text}」的检查项：改用 id 或序号"
                                ),
                            )
                            .detail("issue", "ambiguous_title")
                            .detail("item_index", i)
                            .detail("candidates", ids));
                        }
                        if by_title.is_empty() && load(w, text)?.is_some() {
                            problems.push(ChecklistProblem::TaskMismatch {
                                checklist_id: text.to_owned(),
                            });
                            continue;
                        }
                        (text.to_owned(), by_title.first().map(|r| (*r).clone()))
                    }
                }
            }
        };
        let Some(r) = found else {
            problems.push(ChecklistProblem::NotFound {
                checklist_id: reference,
            });
            continue;
        };
        if !seen.insert(r.id.clone()) {
            return Err(validation(
                "checklist",
                format!("检查项 {} 在 checklist 里出现了不止一次", r.id),
            )
            .detail("issue", "duplicate_checklist_id")
            .detail("checklist_id", r.id.as_str())
            .detail("item_index", i));
        }
        if evidence_violated(&r, c.status, evidence.as_ref()) {
            problems.push(ChecklistProblem::EvidenceRequired {
                checklist_id: r.id.clone(),
            });
            continue;
        }
        planned.push(Planned {
            row: r,
            status: c.status,
            evidence,
        });
    }
    if !problems.is_empty() {
        let reasons = serde_json::to_value(&problems).map_err(internal)?;
        return Err(gate_failed(key, &problems, reasons));
    }
    let evidence_given = planned
        .iter()
        .any(|p| p.evidence.as_ref().is_some_and(|e| !e.is_empty()));
    let mut items = Vec::with_capacity(planned.len());
    for p in &planned {
        write_row(w, &p.row, p.status, p.evidence.as_deref())?;
        items.push(json!({ "checklistId": p.row.id, "status": status_str(p.status) }));
    }
    let expected = task.version;
    bump_task(w, task, evidence_given);
    w.emit(
        "checklist.batch_updated",
        "WORK_ITEM",
        &task.id,
        &json!({
            "key": key,
            "taskKey": key,
            "operation": "complete",
            "expectedVersion": expected,
            "taskVersion": task.version,
            "items": items,
        }),
    )?;
    Ok(())
}
