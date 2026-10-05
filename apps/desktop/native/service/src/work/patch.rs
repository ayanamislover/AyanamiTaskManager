//! 十二种基础操作的批次（01 §2.3、§5；00 C-03～C-09、C-13～C-15、C-28、C-29；10 R1、R2、R11 P1-1）。
//!
//! 每条 patch 的检查顺序：
//! 1. 解析 task key（W-001）；
//! 2. **领取归属**（R1 `may_modify`，只对会改已领取任务的操作）——排在版本检查之前：非领取者无论带不带版本
//!    都过不去，先告诉它 CLAIM_NOT_OWNED，省掉一次「补版本 → 再被拒」的往返（R11 原则）；
//! 3. 版本（W-100、W-101 安全合并、R11 P1-1 的可省略与批内接力）；
//! 4. 自动补 start（R11 P1-1）；
//! 5. 状态机（W-020）；
//! 6. 操作自己的前置条件与写入。
//!
//! 批内任一条失败，整个事务回滚（W-041）。

use super::checklist::CompleteChecklist;
use super::core::{SessionEffect, Task, Work, db, invalid_argument, validation, with_next};
use super::graph::{self, GraphError};
use crate::write::internal;
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::evidence::{self, Evidence, EvidenceSite};
use atm_domain::gate::{self, GateBlocker, GateChecklist, GateInput, GateTask};
use atm_domain::keys;
use atm_domain::ownership::{
    self, Acquire, AlreadyClaimed, ClaimNotOwned, OwnerRequired, Requester, renewed_lease,
};
use atm_domain::text::{js_trim, utf16_len};
use atm_domain::work::{
    AutoStart, InvalidTransition, Operation, PatchKind, StateWrite, Status, VersionNeed, WaitingOn,
    WorkState, auto_start, resolve, version_need,
};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::collections::HashMap;

/// edit 可改的字段（W-035）。`Option<Option<_>>`：外层 None 表示没给，`Some(None)` 表示显式置空。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct EditFields {
    pub title: Option<String>,
    pub description: Option<String>,
    pub acceptance: Option<Vec<String>>,
    pub assignee_agent_id: Option<Option<String>>,
    pub target_date: Option<Option<String>>,
    pub parent_key: Option<Option<String>>,
    pub depends_on: Option<Vec<String>>,
    pub discovered_from: Option<Option<String>>,
}

impl EditFields {
    fn is_empty(&self) -> bool {
        *self == EditFields::default()
    }
}

/// W-101 / W-102 的比较值。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ExpectedFields {
    pub title: Option<String>,
    pub description: Option<String>,
    pub acceptance: Option<Vec<String>>,
    pub target_date: Option<Option<String>>,
    pub parent_key: Option<Option<String>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PatchItem {
    pub task_key: String,
    pub operation: Operation,
    /// R11 P1-1：本 lineage 持有领取时可省略；批内同一任务第二次出现起可省略（接力）。
    pub expected_version: Option<i64>,
    pub takeover_stale: bool,
    pub blocked_reason: Option<String>,
    pub waiting_for: Option<String>,
    pub cancel_reason: Option<String>,
    pub duplicate_of: Option<Option<String>>,
    pub superseded_by: Option<Option<String>>,
    pub edit: EditFields,
    pub expected_fields: Option<ExpectedFields>,
    /// complete 一步写全（R11 P1-1 第 4 条）：同一事务里写一条任务进度。
    pub note: Option<String>,
    /// complete 附带的证据，随 note 的那条进度落库（没给 note 时进度摘要用 [`COMPLETE_NOTE`]）。
    pub evidence: Option<Vec<Evidence>>,
    /// complete 之前先更新的检查项，效果同一事务里先做 checklist_batch。
    pub checklist: Option<Vec<CompleteChecklist>>,
}

impl PatchItem {
    pub fn new(task_key: impl Into<String>, operation: Operation) -> Self {
        PatchItem {
            task_key: task_key.into(),
            operation,
            expected_version: None,
            takeover_stale: false,
            blocked_reason: None,
            waiting_for: None,
            cancel_reason: None,
            duplicate_of: None,
            superseded_by: None,
            edit: EditFields::default(),
            expected_fields: None,
            note: None,
            evidence: None,
            checklist: None,
        }
    }

    pub fn version(mut self, v: i64) -> Self {
        self.expected_version = Some(v);
        self
    }
}

pub const MAX_BATCH: usize = 50;

/// complete 只带 evidence、没带 note 时那条进度的摘要。
pub const COMPLETE_NOTE: &str = "完成";

/// 不碰存储的入参校验（相当于 2.x 的 schema 层，W-102；违反报 INVALID_ARGUMENT）。
pub(crate) fn validate(items: &[PatchItem]) -> Result<(), DomainError> {
    if items.is_empty() || items.len() > MAX_BATCH {
        return Err(
            invalid_argument("items", format!("items 必须是 1 至 {MAX_BATCH} 条"))
                .detail("min", 1)
                .detail("max", MAX_BATCH)
                .detail("actual", items.len()),
        );
    }
    for (index, item) in items.iter().enumerate() {
        validate_item(item).map_err(|e| e.detail("item_index", index))?;
    }
    Ok(())
}

/// W-011 的格式校验与 trim；违反报 INVALID_ARGUMENT（带 problems）。
pub(crate) fn checked_evidence(
    path: &str,
    site: EvidenceSite,
    list: &[Evidence],
) -> Result<Vec<Evidence>, DomainError> {
    evidence::validate(path, site, list.to_vec()).map_err(DomainError::invalid_argument)
}

fn too_long(field: &str, max: usize) -> DomainError {
    invalid_argument(field, format!("{field} 最多 {max} 个字符")).detail("max", max)
}

fn check_text(field: &str, value: &str, max: usize) -> Result<(), DomainError> {
    if utf16_len(value) > max {
        return Err(too_long(field, max));
    }
    Ok(())
}

pub(crate) fn check_date(field: &str, value: &str) -> Result<(), DomainError> {
    let ok = value.len() == 10
        && atm_domain::time::Timestamp::parse(&format!("{value}T00:00:00.000Z")).is_some();
    if ok {
        Ok(())
    } else {
        Err(
            invalid_argument(field, format!("{field} 必须是 YYYY-MM-DD 格式的日期"))
                .detail("got", value),
        )
    }
}

fn validate_item(item: &PatchItem) -> Result<(), DomainError> {
    let op = item.operation;
    let unexpected = |field: &str| {
        invalid_argument(field, format!("{} 不接受 {field}", op.as_str()))
            .detail("operation", op.as_str())
    };
    if item.blocked_reason.is_some() && op != Operation::Block {
        return Err(unexpected("blocked_reason"));
    }
    if item.waiting_for.is_some() && !matches!(op, Operation::WaitAgent | Operation::WaitUser) {
        return Err(unexpected("waiting_for"));
    }
    if op != Operation::Cancel {
        for (field, given) in [
            ("cancel_reason", item.cancel_reason.is_some()),
            ("duplicate_of", item.duplicate_of.is_some()),
            ("superseded_by", item.superseded_by.is_some()),
        ] {
            if given {
                return Err(unexpected(field));
            }
        }
    }
    if op != Operation::Complete {
        for (field, given) in [
            ("note", item.note.is_some()),
            ("evidence", item.evidence.is_some()),
            ("checklist", item.checklist.is_some()),
        ] {
            if given {
                return Err(unexpected(field));
            }
        }
    }
    if let Some(note) = &item.note {
        let note = js_trim(note);
        if note.is_empty() {
            return Err(invalid_argument("note", "note 不能为空白；不需要时省略它"));
        }
        check_text("note", note, 500)?;
    }
    if let Some(list) = &item.evidence {
        checked_evidence("evidence", EvidenceSite::Progress, list)?;
    }
    if let Some(list) = &item.checklist {
        super::checklist::validate_complete(list)?;
    }
    if op != Operation::Edit {
        if !item.edit.is_empty() {
            return Err(unexpected("edit 字段"));
        }
        if item.expected_fields.is_some() {
            return Err(unexpected("expected_fields"));
        }
    }
    if let Some(v) = item.expected_version
        && v < 0
    {
        return Err(invalid_argument(
            "expected_version",
            "expected_version 不能是负数",
        ));
    }
    if let Some(r) = &item.blocked_reason {
        check_text("blocked_reason", js_trim(r), 2000)?;
    }
    if let Some(r) = &item.waiting_for {
        check_text("waiting_for", js_trim(r), 1000)?;
    }
    if let Some(r) = &item.cancel_reason {
        let r = js_trim(r);
        if r.is_empty() {
            return Err(invalid_argument(
                "cancel_reason",
                "cancel_reason 不能为空白；不需要原因时省略它",
            ));
        }
        check_text("cancel_reason", r, 2000)?;
    }
    let e = &item.edit;
    if let Some(t) = &e.title {
        let t = js_trim(t);
        if t.is_empty() {
            return Err(invalid_argument("title", "title 不能为空"));
        }
        check_text("title", t, 400)?;
    }
    if let Some(d) = &e.description {
        check_text("description", d, 50_000)?;
    }
    if let Some(list) = &e.acceptance {
        check_acceptance(list)?;
    }
    if let Some(Some(d)) = &e.target_date {
        check_date("target_date", d)?;
    }
    if let Some(list) = &e.depends_on
        && list.len() > 50
    {
        return Err(too_long("depends_on", 50));
    }
    if let Some(expected) = &item.expected_fields {
        // W-102。
        if *expected == ExpectedFields::default() {
            return Err(invalid_argument(
                "expected_fields",
                "expected_fields 至少包含一个字段",
            ));
        }
        for (field, given) in [
            ("assignee_agent_id", e.assignee_agent_id.is_some()),
            ("depends_on", e.depends_on.is_some()),
            ("discovered_from", e.discovered_from.is_some()),
        ] {
            if given {
                return Err(invalid_argument(
                    field,
                    format!(
                        "{field} 必须使用严格的 expected_version，不能和 expected_fields 一起用"
                    ),
                ));
            }
        }
        let changed = changed_whitelist(e);
        if changed.is_empty() {
            return Err(invalid_argument(
                "expected_fields",
                "expected_fields 要求至少编辑一个白名单字段",
            ));
        }
        for field in changed {
            if !expected_has(expected, field) {
                return Err(invalid_argument(
                    "expected_fields",
                    format!("缺少被修改字段 {field} 的比较值"),
                )
                .detail("missing", field));
            }
        }
    }
    Ok(())
}

pub(crate) fn check_acceptance(list: &[String]) -> Result<(), DomainError> {
    if list.len() > 100 {
        return Err(too_long("acceptance", 100));
    }
    for a in list {
        let a = js_trim(a);
        if a.is_empty() {
            return Err(invalid_argument(
                "acceptance",
                "acceptance 的每一项都不能为空",
            ));
        }
        check_text("acceptance", a, 1000)?;
    }
    Ok(())
}

/// W-101 白名单里被修改的字段。
fn changed_whitelist(e: &EditFields) -> Vec<&'static str> {
    let mut out = Vec::new();
    if e.title.is_some() {
        out.push("title");
    }
    if e.description.is_some() {
        out.push("description");
    }
    if e.acceptance.is_some() {
        out.push("acceptance");
    }
    if e.target_date.is_some() {
        out.push("target_date");
    }
    if e.parent_key.is_some() {
        out.push("parent_key");
    }
    out
}

fn expected_has(x: &ExpectedFields, field: &str) -> bool {
    match field {
        "title" => x.title.is_some(),
        "description" => x.description.is_some(),
        "acceptance" => x.acceptance.is_some(),
        "target_date" => x.target_date.is_some(),
        "parent_key" => x.parent_key.is_some(),
        _ => false,
    }
}

fn trimmed_list(list: &[String]) -> Vec<String> {
    list.iter().map(|a| js_trim(a).to_owned()).collect()
}

/// 执行一个批次。返回回执（`{items, sequence, merges?, autoApplied?}`）。
pub(crate) fn run(w: &mut Work<'_>, items: &[PatchItem]) -> Result<Value, DomainError> {
    let mut relay: HashMap<String, i64> = HashMap::new();
    let mut ids = Vec::with_capacity(items.len());
    let mut merges = Vec::new();
    let mut auto = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let outcome = apply(w, &relay, item).map_err(|e| {
            if items.len() > 1 {
                e.detail("item_index", index)
            } else {
                e
            }
        })?;
        relay.insert(outcome.task_id.clone(), outcome.version);
        if let Some(m) = outcome.merge {
            merges.push(m);
        }
        if outcome.auto_started {
            auto.push(json!({ "taskKey": outcome.key, "operations": ["start"] }));
        }
        ids.push(outcome.task_id);
    }
    w.finish()?;
    // 视图取事务提交时的最终状态：末尾的统一重算（C-21）也已反映在里面。
    let views = ids
        .iter()
        .map(|id| w.view(id))
        .collect::<Result<Vec<_>, _>>()?;
    let mut result = json!({ "items": views, "sequence": w.sequence });
    if !merges.is_empty() {
        result["merges"] = Value::Array(merges);
    }
    if !auto.is_empty() {
        result["autoApplied"] = Value::Array(auto);
    }
    Ok(result)
}

struct Outcome {
    task_id: String,
    key: String,
    version: i64,
    merge: Option<Value>,
    auto_started: bool,
}

fn apply(
    w: &mut Work<'_>,
    relay: &HashMap<String, i64>,
    item: &PatchItem,
) -> Result<Outcome, DomainError> {
    let op = item.operation;
    // ① key
    let mut task = w.load_by_key(&item.task_key)?;
    let key = w.task_key(&task);

    // ② 领取归属（R1）
    if op.guarded_by_claim() {
        let claim = task.claim();
        let requester = w.requester(&claim);
        if let Err(e) = ownership::may_modify(claim, requester, w.now) {
            return Err(claim_not_owned(&key, e));
        }
    }

    // ③ 版本
    let merge = check_version(w, relay, item, &task, &key)?;

    // ④ 自动补 start
    let auto = auto_start(StateWrite::Basic(op), task.status());
    let mut auto_started = false;
    if auto == AutoStart::Apply {
        let acquired = start_preconditions(w, &task, &key, item.takeover_stale)?;
        let target = resolve(Operation::Start, task.state, false)
            .map_err(|e| invalid_transition(&key, e, false))?;
        let _ = acquired;
        claim_and_start(w, &mut task, target, Operation::Start, &key)?;
        auto_started = true;
    }

    // ⑤ 状态机
    let successor = op == Operation::Claim
        && task.status() == Status::InProgress
        && ownership::is_successor_reclaim(task.claim(), w.requester(&task.claim()));
    let target = resolve(op, task.state, successor)
        .map_err(|e| invalid_transition(&key, e, auto == AutoStart::SuggestStart))?;

    // ⑥ 前置条件与写入
    let before = task.clone();
    let parent_before = task.parent_id.clone();
    match op {
        Operation::Claim | Operation::Start => {
            start_preconditions(w, &task, &key, item.takeover_stale)?;
            claim_and_start(w, &mut task, target, op, &key)?;
        }
        Operation::Release => {
            let claim = task.claim();
            let requester = w.requester(&claim);
            ownership::may_release(claim, requester, item.takeover_stale, w.now)
                .map_err(|e| owner_required(&key, e, w.actor().session.as_deref(), requester))?;
            task.state = target;
            task.clear_waiting();
            task.assignee = None;
            task.drop_claim();
            // 00 C-06：释放时一并解除阻塞。
            task.blocked_reason = None;
            w.resolve_blockers(&task.id)?;
            commit(
                w,
                &mut task,
                &key,
                "work.released",
                op,
                &before,
                Value::Null,
                false,
            )?;
            w.session_effect(&task.id, SessionEffect::Idle)?;
        }
        Operation::Ready => {
            task.state = target;
            commit(
                w,
                &mut task,
                &key,
                "work.readied",
                op,
                &before,
                Value::Null,
                true,
            )?;
        }
        Operation::Block => {
            let reason = item
                .blocked_reason
                .as_deref()
                .map(js_trim)
                .unwrap_or_default();
            if reason.is_empty() {
                return Err(DomainError::new(
                    ErrorCode::BLOCKED_REASON_REQUIRED,
                    "block 需要写明阻塞原因",
                )
                .detail("task_key", key.as_str()));
            }
            task.state = target;
            task.clear_waiting();
            task.blocked_reason = Some(reason.to_owned());
            // 00 C-28：block 也建阻塞记录，完成门照旧只看 ACTIVE 记录。
            let blocker = w.add_blocker(&task.id, reason)?;
            let extra = json!({ "blockedReason": reason, "blockerKey": blocker });
            commit(w, &mut task, &key, "work.blocked", op, &before, extra, true)?;
            w.session_effect(&task.id, SessionEffect::Waiting)?;
        }
        Operation::WaitAgent | Operation::WaitUser => {
            let reason = item.waiting_for.as_deref().map(js_trim).unwrap_or_default();
            if reason.is_empty() {
                return Err(DomainError::new(
                    ErrorCode::WAITING_FOR_REQUIRED,
                    "等待需要写明在等什么",
                )
                .detail("task_key", key.as_str()));
            }
            if before.status() == Status::Blocked {
                // W-031：重新归类，不是开始，不写 started_at。
                task.blocked_reason = None;
                w.resolve_blockers(&task.id)?;
            }
            task.state = target;
            task.waiting_for = Some(reason.to_owned());
            let extra = json!({ "waitingFor": reason });
            commit(w, &mut task, &key, "work.waiting", op, &before, extra, true)?;
            w.session_effect(&task.id, SessionEffect::Waiting)?;
        }
        Operation::Verify => {
            task.state = target;
            task.clear_waiting();
            commit(
                w,
                &mut task,
                &key,
                "work.verification_requested",
                op,
                &before,
                Value::Null,
                true,
            )?;
            w.session_effect(&task.id, SessionEffect::Working)?;
        }
        Operation::Complete => {
            // R11 P1-1 第 4 条：先按 checklist_batch 的规则写检查项，门在写过之后的状态上求值。
            if let Some(list) = &item.checklist {
                super::checklist::for_complete(w, &mut task, &key, list)?;
            }
            check_gate(w, &task, &key, auto == AutoStart::SuggestStart)?;
            if item.note.is_some() || item.evidence.is_some() {
                complete_note(w, &mut task, &key, item)?;
            }
            complete_write(w, &mut task, target, &key, op, &before, Value::Null)?;
        }
        Operation::Cancel => {
            let dup = resolve_ref(w, &task, &key, "duplicate_of", item.duplicate_of.as_ref())?;
            let sup = resolve_ref(w, &task, &key, "superseded_by", item.superseded_by.as_ref())?;
            task.state = target;
            task.clear_waiting();
            task.cancel_reason = item.cancel_reason.as_deref().map(|r| js_trim(r).to_owned());
            task.duplicate_of_id = dup.as_ref().map(|(id, _)| id.clone());
            task.superseded_by_id = sup.as_ref().map(|(id, _)| id.clone());
            task.drop_claim();
            let extra = json!({
                "cancelReason": task.cancel_reason,
                "duplicateOf": dup.map(|(_, k)| k),
                "supersededBy": sup.map(|(_, k)| k),
            });
            commit(
                w,
                &mut task,
                &key,
                "work.cancelled",
                op,
                &before,
                extra,
                false,
            )?;
            w.session_effect(&task.id, SessionEffect::Idle)?;
        }
        Operation::Reopen => {
            let from = before.status();
            task.state = target;
            task.completed_at = None;
            task.blocked_reason = None;
            task.clear_waiting();
            w.resolve_blockers(&task.id)?;
            // 00 C-04：清掉上报值，重算自身。
            task.reported_progress = None;
            w.recompute_from(&task.id);
            let mut extra = json!({ "fromStatus": from.as_str() });
            if from == Status::Cancelled {
                // 00 C-05：历史留在事件里。
                extra["previous"] = json!({
                    "cancelReason": task.cancel_reason,
                    "duplicateOf": w.view(&task.id)?["duplicateOf"],
                    "supersededBy": w.view(&task.id)?["supersededBy"],
                });
                task.cancel_reason = None;
                task.duplicate_of_id = None;
                task.superseded_by_id = None;
            }
            commit(
                w,
                &mut task,
                &key,
                "work.reopened",
                op,
                &before,
                extra,
                true,
            )?;
            w.session_effect(&task.id, SessionEffect::Working)?;
        }
        Operation::Edit => {
            edit(w, &mut task, &key, item, &before, merge.as_ref())?;
        }
    }

    // W-040：写之前的父链；改父时新父链由 edit 自己登记。
    if let Some(parent) = parent_before {
        w.recompute_from(&parent);
    }
    Ok(Outcome {
        task_id: task.id.clone(),
        key,
        version: task.version,
        merge,
        auto_started,
    })
}

/// 完成门（§4）。不过时报 COMPLETION_GATE_FAILED；`suggest_start`：附上「先 start」的下一步。
pub(crate) fn check_gate(
    w: &Work<'_>,
    task: &Task,
    key: &str,
    suggest_start: bool,
) -> Result<(), DomainError> {
    let outcome = gate::evaluate(&gate_input(w, task)?);
    if outcome.passed() {
        return Ok(());
    }
    let mut e = DomainError::new(
        ErrorCode::COMPLETION_GATE_FAILED,
        "任务尚未满足完成条件：按 reasons 逐条处理",
    )
    .detail("task_key", key)
    .detail(
        "reasons",
        serde_json::to_value(&outcome.reasons).map_err(internal)?,
    )
    .detail("truncated", outcome.truncated)
    .detail(
        "reason_limit_per_predicate",
        outcome.reason_limit_per_predicate,
    )
    .detail(
        "truncation",
        serde_json::to_value(&outcome.truncation).map_err(internal)?,
    );
    if suggest_start {
        e = with_next(e, json!({ "operation": "start", "task_key": key }));
    }
    Err(e)
}

/// W-032 的写入：DONE、completed_at、进度 100、来源 NONE（C-24）、清领取（C-03），会话 IDLE。
pub(crate) fn complete_write(
    w: &mut Work<'_>,
    task: &mut Task,
    target: WorkState,
    key: &str,
    op: Operation,
    before: &Task,
    extra: Value,
) -> Result<(), DomainError> {
    task.state = target;
    task.clear_waiting();
    task.completed_at = Some(w.now_iso.clone());
    task.computed_progress = 100.0;
    task.reported_progress = Some(100.0);
    // 00 C-24
    task.progress_source = "NONE".to_owned();
    // 00 C-03：终态没有领取。
    task.drop_claim();
    commit(w, task, key, "work.completed", op, before, extra, false)?;
    w.session_effect(&task.id, SessionEffect::Idle)
}

/// complete 带的 note / evidence：一条进度（不单独推版本，随 complete 的 +1）。
fn complete_note(
    w: &mut Work<'_>,
    task: &mut Task,
    key: &str,
    item: &PatchItem,
) -> Result<(), DomainError> {
    let summary = item
        .note
        .as_deref()
        .map_or(COMPLETE_NOTE, js_trim)
        .to_owned();
    let evidence = match &item.evidence {
        Some(list) => {
            let list = checked_evidence("evidence", EvidenceSite::Progress, list)?;
            crate::evidence::normalize(w.tx, &w.project, &w.code, "evidence", list)?
        }
        None => Vec::new(),
    };
    if !evidence.is_empty() {
        task.last_evidence_at = Some(w.now_iso.clone());
    }
    w.add_progress(
        task,
        key,
        &super::core::NewProgress {
            summary: &summary,
            percent: None,
            bucket: None,
            completed: Value::Array(Vec::new()),
            next: Value::Array(Vec::new()),
            blocker: None,
            evidence: crate::evidence::to_json(&evidence),
        },
    )?;
    Ok(())
}

/// 写回一行并发一条事件。`transfer`：R2 的自动转移与续租（领取仍在、写入者在领取的 lineage 里）。
#[allow(clippy::too_many_arguments)]
fn commit(
    w: &mut Work<'_>,
    task: &mut Task,
    key: &str,
    kind: &str,
    op: Operation,
    before: &Task,
    extra: Value,
    transfer: bool,
) -> Result<(), DomainError> {
    if transfer {
        w.transfer_claim(task);
    }
    task.version += 1;
    w.save(task)?;
    let mut payload = json!({
        "key": key,
        "title": before.title,
        "operation": op.as_str(),
        "status": task.state.status().as_str(),
        "phase": task.state.phase().as_str(),
        "waitingOn": task.state.waiting_on().map(WaitingOn::as_str),
    });
    if let (Value::Object(p), Value::Object(e)) = (&mut payload, extra) {
        p.extend(e);
    }
    w.emit(kind, "WORK_ITEM", &task.id, &payload)?;
    Ok(())
}

// ---------- 版本 ----------

fn holds_claim(w: &Work<'_>, task: &Task, write: StateWrite, takeover: bool) -> bool {
    let claim = task.claim();
    let requester = w.requester(&claim);
    let Requester::Agent {
        holder_in_lineage, ..
    } = requester
    else {
        // User、Phone、System 的写入一律要版本（R11 P1-1：非 owner 的写入都要）。
        return false;
    };
    if claim.is_held() && holder_in_lineage {
        return true;
    }
    // 这次 claim / start / 自动 start 能拿到领取（不含接管别人的过期领取）。
    let acquires = matches!(
        write,
        StateWrite::Basic(Operation::Claim | Operation::Start)
    ) || auto_start(write, task.status()) == AutoStart::Apply;
    acquires
        && matches!(
            ownership::acquire(claim, requester, takeover, w.now),
            Ok(Acquire::Free | Acquire::Lineage)
        )
}

fn check_version(
    w: &Work<'_>,
    relay: &HashMap<String, i64>,
    item: &PatchItem,
    task: &Task,
    key: &str,
) -> Result<Option<Value>, DomainError> {
    let op = item.operation;
    match item.expected_version {
        Some(expected) if expected != task.version => {
            if op == Operation::Edit
                && let Some(fields) = safe_merge(w, item, task)?
            {
                return Ok(Some(json!({
                    "taskKey": key,
                    "expectedVersion": expected,
                    "actualVersion": task.version,
                    "fields": fields,
                })));
            }
            Err(w.version_conflict(task, expected)?)
        }
        Some(_) => Ok(None),
        // 批内接力：同一任务在本批里已经出现过，版本由前一条接上。
        None if relay.contains_key(&task.id) => Ok(None),
        None => {
            if version_need(
                PatchKind::Basic(op),
                holds_claim(w, task, StateWrite::Basic(op), item.takeover_stale),
            ) == VersionNeed::Required
            {
                return Err(version_required(key, op.as_str(), task.version));
            }
            Ok(None)
        }
    }
}

/// EXPECTED_VERSION_REQUIRED（R11 P1-1）：带上当前版本与填好版本的下一步。
pub(crate) fn version_required(key: &str, operation: &str, current: i64) -> DomainError {
    let e = DomainError::new(
        ErrorCode::EXPECTED_VERSION_REQUIRED,
        format!("{operation} 需要 expected_version：任务 {key} 当前版本是 {current}"),
    )
    .detail("task_key", key)
    .detail("operation", operation)
    .detail("current_version", current);
    with_next(
        e,
        json!({ "operation": operation, "task_key": key, "expected_version": current }),
    )
}

/// 本 lineage 是否持有这个任务的领取（不含这次才拿到的）。
pub(crate) fn lineage_holds(w: &Work<'_>, task: &Task) -> bool {
    let claim = task.claim();
    matches!(
        w.requester(&claim),
        Requester::Agent {
            holder_in_lineage: true,
            ..
        }
    ) && claim.is_held()
}

/// W-101：版本不等时，edit 只有在「每个比较值都等于当前值」时才继续。返回被修改的字段。
fn safe_merge(
    w: &Work<'_>,
    item: &PatchItem,
    task: &Task,
) -> Result<Option<Vec<&'static str>>, DomainError> {
    let Some(expected) = &item.expected_fields else {
        return Ok(None);
    };
    let e = &item.edit;
    if e.assignee_agent_id.is_some() || e.depends_on.is_some() || e.discovered_from.is_some() {
        return Ok(None);
    }
    let changed = changed_whitelist(e);
    if changed.is_empty() || changed.iter().any(|f| !expected_has(expected, f)) {
        return Ok(None);
    }
    let parent_key = match &task.parent_id {
        Some(p) => Some(w.task_key(&w.load(p)?)),
        None => None,
    };
    let equal = expected
        .title
        .as_ref()
        .is_none_or(|t| js_trim(t) == task.title)
        && expected
            .description
            .as_ref()
            .is_none_or(|d| *d == task.description)
        && expected
            .acceptance
            .as_ref()
            .is_none_or(|a| trimmed_list(a) == task.acceptance)
        && expected
            .target_date
            .as_ref()
            .is_none_or(|d| *d == task.target_date)
        && expected
            .parent_key
            .as_ref()
            .is_none_or(|p| p.as_deref().map(js_trim) == parent_key.as_deref());
    Ok(equal.then_some(changed))
}

// ---------- claim / start ----------

/// W-024 + W-025：依赖就绪，再看领取是否可用。
fn start_preconditions(
    w: &Work<'_>,
    task: &Task,
    key: &str,
    takeover: bool,
) -> Result<Acquire, DomainError> {
    check_dependencies(w, task, key)?;
    let claim = task.claim();
    ownership::acquire(claim, w.requester(&claim), takeover, w.now)
        .map_err(|e| already_claimed(key, e))
}

fn check_dependencies(w: &Work<'_>, task: &Task, key: &str) -> Result<(), DomainError> {
    let unready: Vec<(i64, String)> = w
        .tx
        .prepare_cached(
            "SELECT p.local_no, p.status FROM work_item_relations r
             JOIN work_items p ON p.project_id = r.project_id AND p.id = r.source_id
             WHERE r.project_id = ?1 AND r.target_id = ?2 AND r.relation_type = 'BLOCKS' AND p.status <> 'DONE'
             ORDER BY p.local_no, p.id",
        )
        .map_err(db)?
        .query_map([&w.project, &task.id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(db)?
        .collect::<rusqlite::Result<_>>()
        .map_err(db)?;
    if unready.is_empty() {
        return Ok(());
    }
    let total = unready.len();
    let cancelled = unready.iter().any(|(_, s)| s == "CANCELLED");
    let list: Vec<Value> = unready
        .iter()
        .take(gate::REASON_LIMIT_PER_PREDICATE)
        .map(
            |(no, s)| json!({ "task_key": w.key(*no), "status": s, "cancelled": s == "CANCELLED" }),
        )
        .collect();
    // 00 C-11、C-29：列出全部未就绪前置的 key；有已取消的前置时写明出路。
    let message = if cancelled {
        format!(
            "任务 {key} 的前置没有全部完成；其中有已取消的前置，需要 edit 去掉这条依赖，或者 reopen 前置并完成它"
        )
    } else {
        format!("任务 {key} 的前置没有全部完成：先完成 dependencies 里的任务")
    };
    Err(DomainError::new(ErrorCode::DEPENDENCY_NOT_READY, message)
        .detail("task_key", key)
        .detail("dependencies", list)
        .detail("total", total)
        .detail("truncated", total > gate::REASON_LIMIT_PER_PREDICATE))
}

/// claim / start 的写入（W-023、W-026、W-027）。`target` 已经由状态机给出。
fn claim_and_start(
    w: &mut Work<'_>,
    task: &mut Task,
    target: atm_domain::work::WorkState,
    op: Operation,
    key: &str,
) -> Result<(), DomainError> {
    let before = task.clone();
    let actor = w.actor().clone();
    task.state = target;
    task.assignee = Some(actor.id.clone());
    task.claimed_by = actor.session.clone();
    task.lease = actor
        .session
        .as_ref()
        .map(|_| renewed_lease(w.now).to_string());
    if task.ever_claimed_at.is_none() {
        task.ever_claimed_at = Some(w.now_iso.clone());
    }
    let started = target.status() == Status::InProgress;
    if started {
        if task.started_at.is_none() {
            task.started_at = Some(w.now_iso.clone());
        }
        if task
            .last_started_at
            .as_deref()
            .is_none_or(|t| t < w.now_iso.as_str())
        {
            task.last_started_at = Some(w.now_iso.clone());
        }
        task.blocked_reason = None;
        task.clear_waiting();
        w.resolve_blockers(&task.id)?;
    }
    let kind = if started {
        "work.started"
    } else {
        "work.claimed"
    };
    commit(w, task, key, kind, op, &before, Value::Null, false)?;
    w.session_effect(&task.id, SessionEffect::Working)?;
    Ok(())
}

// ---------- complete ----------

/// 完成门的输入，按各谓词规定的顺序读出（W-090）。
pub(crate) fn gate_input(w: &Work<'_>, task: &Task) -> Result<GateInput, DomainError> {
    let checklist = w
        .tx
        .prepare_cached(
            "SELECT id, status, evidence_required, json_array_length(evidence_json) FROM checklist_items
             WHERE project_id = ?1 AND work_item_id = ?2 ORDER BY created_at, id",
        )
        .map_err(db)?
        .query_map([&w.project, &task.id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?))
        })
        .map_err(db)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db)?
        .into_iter()
        .map(|(id, status, required, count)| {
            let status = super::core::checklist_status(&status)
                .ok_or_else(|| internal(format!("checklist status {status}")))?;
            Ok(GateChecklist {
                id,
                status,
                evidence_required: required != 0,
                evidence_count: usize::try_from(count).unwrap_or(0),
            })
        })
        .collect::<Result<Vec<_>, DomainError>>()?;
    let tasks = |sql: &str| -> Result<Vec<GateTask>, DomainError> {
        w.tx.prepare_cached(sql)
            .map_err(db)?
            .query_map([&w.project, &task.id], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(db)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db)?
            .into_iter()
            .map(|(no, s)| {
                Status::parse(&s)
                    .map(|status| GateTask {
                        key: w.key(no),
                        status,
                    })
                    .ok_or_else(|| internal(format!("status {s}")))
            })
            .collect()
    };
    let children = tasks(
        "SELECT local_no, status FROM work_items WHERE project_id = ?1 AND parent_id = ?2 ORDER BY local_no, id",
    )?;
    let dependencies = tasks(
        "SELECT p.local_no, p.status FROM work_item_relations r
         JOIN work_items p ON p.project_id = r.project_id AND p.id = r.source_id
         WHERE r.project_id = ?1 AND r.target_id = ?2 AND r.relation_type = 'BLOCKS' ORDER BY p.local_no, p.id",
    )?;
    let blockers = w
        .tx
        .prepare_cached(
            "SELECT local_no FROM blockers WHERE project_id = ?1 AND work_item_id = ?2 AND status = 'ACTIVE'
             ORDER BY local_no, id",
        )
        .map_err(db)?
        .query_map([&w.project, &task.id], |r| r.get::<_, i64>(0))
        .map_err(db)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db)?
        .into_iter()
        .map(|no| GateBlocker { key: keys::blocker_key(&w.code, no), active: true })
        .collect();
    Ok(GateInput {
        state: task.state,
        verification_required: task.verification_required,
        checklist,
        children,
        blockers,
        dependencies,
    })
}

// ---------- cancel ----------

/// W-033：duplicate_of / superseded_by 的引用。返回 `(id, 规范 key)`。
fn resolve_ref(
    w: &Work<'_>,
    task: &Task,
    key: &str,
    field: &str,
    value: Option<&Option<String>>,
) -> Result<Option<(String, String)>, DomainError> {
    let Some(Some(reference)) = value else {
        return Ok(None);
    };
    let target = w
        .load_by_key(reference)
        .map_err(|e| e.detail("field", field))?;
    if target.id == task.id {
        return Err(validation(field, format!("{field} 不能指向任务自己"))
            .detail("issue", "self_reference")
            .detail("task_key", key));
    }
    let target_key = w.task_key(&target);
    Ok(Some((target.id, target_key)))
}

// ---------- edit ----------

fn edit(
    w: &mut Work<'_>,
    task: &mut Task,
    key: &str,
    item: &PatchItem,
    before: &Task,
    merge: Option<&Value>,
) -> Result<(), DomainError> {
    let e = &item.edit;
    if e.is_empty() {
        return Err(validation("edit", "edit 至少要改一个字段").detail("issue", "empty_patch"));
    }
    let mut fields: Vec<&str> = Vec::new();
    let mut extra = json!({});
    if let Some(t) = &e.title {
        task.title = js_trim(t).to_owned();
        fields.push("title");
    }
    if let Some(d) = &e.description {
        task.description = d.clone();
        fields.push("description");
    }
    if let Some(a) = &e.acceptance {
        let after = trimmed_list(a);
        if after != before.acceptance {
            extra["changes"] =
                json!({ "acceptance": { "before": before.acceptance, "after": after } });
        }
        task.acceptance = after;
        fields.push("acceptance");
    }
    if let Some(a) = &e.assignee_agent_id {
        task.assignee = a.clone();
        fields.push("assignee_agent_id");
    }
    if let Some(d) = &e.target_date {
        task.target_date = d.clone();
        fields.push("target_date");
    }
    let mut new_parent_chain = None;
    if let Some(parent) = &e.parent_key {
        let parent_id = match parent {
            None => None,
            Some(reference) => {
                let p = w
                    .load_by_key(reference)
                    .map_err(|e| e.detail("field", "parent_key"))?;
                let mut parents = parent_map(w)?;
                parents.remove(&task.id);
                if let Err(g) = graph::parent_ok(&task.id, &p.id, &parents) {
                    return Err(hierarchy_error(g, key, &w.task_key(&p)));
                }
                Some(p.id)
            }
        };
        if parent_id != task.parent_id
            && let Some(new_parent) = &parent_id
        {
            new_parent_chain = Some(new_parent.clone());
        }
        task.parent_id = parent_id;
        fields.push("parent_key");
    }
    let mut relations = json!({});
    let mut search_neighbours = Vec::new();
    if let Some(list) = &e.depends_on {
        let mut seen = Vec::new();
        let mut deps = Vec::new();
        for raw in list {
            let normalized = keys::normalize(raw);
            if seen.contains(&normalized) {
                return Err(
                    validation("depends_on", format!("depends_on 里 {normalized} 重复了"))
                        .detail("duplicate", normalized),
                );
            }
            seen.push(normalized);
            let dep = w
                .load_by_key(raw)
                .map_err(|e| e.detail("field", "depends_on"))?;
            if deps.iter().any(|(id, _)| *id == dep.id) {
                return Err(
                    validation("depends_on", "depends_on 里同一个任务出现了两次")
                        .detail("duplicate", w.task_key(&dep)),
                );
            }
            let dep_key = w.task_key(&dep);
            deps.push((dep.id, dep_key));
        }
        let mut prereqs = prereq_map(w)?;
        prereqs.insert(
            task.id.clone(),
            deps.iter().map(|(id, _)| id.clone()).collect(),
        );
        for (dep, dep_key) in &deps {
            if let Err(g) = graph::dependency_ok(&task.id, dep, &prereqs) {
                return Err(dependency_cycle(g, key, dep_key));
            }
        }
        w.tx.execute(
            "DELETE FROM work_item_relations WHERE project_id = ?1 AND target_id = ?2 AND relation_type = 'BLOCKS'",
            params![w.project, task.id],
        )
        .map_err(db)?;
        for (dep, _) in &deps {
            w.tx.execute(
                "INSERT INTO work_item_relations (project_id, source_id, target_id, relation_type, created_at)
                 VALUES (?1, ?2, ?3, 'BLOCKS', ?4)",
                params![w.project, dep, task.id, w.now_iso],
            )
            .map_err(db)?;
        }
        relations["dependsOn"] = json!(deps.iter().map(|(_, k)| k.clone()).collect::<Vec<_>>());
        fields.push("depends_on");
    }
    if let Some(origin) = &e.discovered_from {
        let old: Option<String> = w
            .tx
            .query_row(
                "SELECT target_id FROM work_item_relations WHERE project_id = ?1 AND source_id = ?2 AND relation_type = 'DISCOVERED_FROM'",
                [&w.project, &task.id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db)?;
        let new = match origin {
            None => None,
            Some(reference) => {
                let o = w
                    .load_by_key(reference)
                    .map_err(|e| e.detail("field", "discovered_from"))?;
                if o.id == task.id {
                    return Err(
                        validation("discovered_from", "discovered_from 不能指向任务自己")
                            .detail("issue", "self_reference"),
                    );
                }
                Some(o)
            }
        };
        w.tx.execute(
            "DELETE FROM work_item_relations WHERE project_id = ?1 AND source_id = ?2 AND relation_type = 'DISCOVERED_FROM'",
            params![w.project, task.id],
        )
        .map_err(db)?;
        if let Some(o) = &new {
            w.tx.execute(
                "INSERT INTO work_item_relations (project_id, source_id, target_id, relation_type, created_at)
                 VALUES (?1, ?2, ?3, 'DISCOVERED_FROM', ?4)",
                params![w.project, task.id, o.id, w.now_iso],
            )
            .map_err(db)?;
            search_neighbours.push(o.id.clone());
        }
        search_neighbours.extend(old);
        relations["discoveredFrom"] = json!(new.as_ref().map(|o| w.task_key(o)));
        fields.push("discovered_from");
    }
    if e.title.is_some() {
        // 邻居的搜索文档里带着这个标题（「工作中发现 …」）。
        let neighbours: Vec<String> = w
            .tx
            .prepare_cached(
                "SELECT CASE WHEN source_id = ?2 THEN target_id ELSE source_id END FROM work_item_relations
                 WHERE project_id = ?1 AND relation_type = 'DISCOVERED_FROM' AND (source_id = ?2 OR target_id = ?2)",
            )
            .map_err(db)?
            .query_map([&w.project, &task.id], |r| r.get(0))
            .map_err(db)?
            .collect::<rusqlite::Result<_>>()
            .map_err(db)?;
        search_neighbours.extend(neighbours);
    }
    // 00 C-14：完整刷新自己与受影响邻居的搜索文档。
    w.refresh_search(&task.id);
    for n in search_neighbours {
        w.refresh_search(&n);
    }
    if let Some(p) = new_parent_chain {
        w.recompute_from(&p);
    }

    // 00 C-13：事件带全部变更字段；title 取新值，另附 previousTitle。
    let kind = if e.parent_key.is_some() {
        "work.moved"
    } else if e.depends_on.is_some() || e.discovered_from.is_some() {
        "work.relations_changed"
    } else {
        "work.updated"
    };
    extra["fields"] = json!(fields);
    extra["title"] = json!(task.title);
    extra["previousTitle"] = json!(before.title);
    if relations.as_object().is_some_and(|r| !r.is_empty()) {
        extra["relations"] = relations;
    }
    if let Some(m) = merge {
        extra["mergedAcrossVersion"] = m.clone();
    }
    commit(w, task, key, kind, Operation::Edit, before, extra, true)?;
    Ok(())
}

pub(crate) fn parent_map(w: &Work<'_>) -> Result<HashMap<String, String>, DomainError> {
    w.tx.prepare_cached(
        "SELECT id, parent_id FROM work_items WHERE project_id = ?1 AND parent_id IS NOT NULL",
    )
    .map_err(db)?
    .query_map([&w.project], |r| Ok((r.get(0)?, r.get(1)?)))
    .map_err(db)?
    .collect::<rusqlite::Result<_>>()
    .map_err(db)
}

pub(crate) fn prereq_map(w: &Work<'_>) -> Result<HashMap<String, Vec<String>>, DomainError> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    let rows: Vec<(String, String)> = w
        .tx
        .prepare_cached(
            "SELECT target_id, source_id FROM work_item_relations WHERE project_id = ?1 AND relation_type = 'BLOCKS'",
        )
        .map_err(db)?
        .query_map([&w.project], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(db)?
        .collect::<rusqlite::Result<_>>()
        .map_err(db)?;
    for (target, source) in rows {
        out.entry(target).or_default().push(source);
    }
    Ok(out)
}

pub(crate) fn hierarchy_error(g: GraphError, item: &str, parent: &str) -> DomainError {
    match g {
        GraphError::TooDeep { prospective_depth } => DomainError::new(
            ErrorCode::HIERARCHY_DEPTH,
            format!(
                "层级最多 {} 层，把 {item} 挂到 {parent} 下会到第 {prospective_depth} 层",
                graph::MAX_DEPTH
            ),
        )
        .detail("task", item)
        .detail("parent", parent)
        .detail("max_depth", graph::MAX_DEPTH)
        .detail("prospective_depth", prospective_depth),
        other => DomainError::new(
            ErrorCode::HIERARCHY_CYCLE,
            format!("把 {item} 挂到 {parent} 下会形成环"),
        )
        .detail("task", item)
        .detail("parent", parent)
        .detail("reason", other.reason()),
    }
}

pub(crate) fn dependency_cycle(g: GraphError, task: &str, dep: &str) -> DomainError {
    DomainError::new(
        ErrorCode::DEPENDENCY_CYCLE,
        format!("{task} 依赖 {dep} 会形成环"),
    )
    .detail("task", task)
    .detail("depends_on", dep)
    .detail("reason", g.reason())
}

// ---------- verify_and_complete ----------

/// W-052 的入参。
#[derive(Clone, Debug, PartialEq)]
pub struct VerifyAndComplete {
    pub task_key: String,
    /// 比的是目标任务版本（W-051）。R11 P1-1：本 lineage 持有领取（含这次自动 start 拿到）时可省略。
    pub expected_version: Option<i64>,
}

/// W-052：verify（不在 VERIFYING 时）→ 在 VERIFYING 上求完成门 → DONE，一个事务。
/// 门不过整事务回滚：不留 VERIFYING、会话改动、第一条事件、序号与回执（W-062）。
pub(crate) fn verify_and_complete(
    w: &mut Work<'_>,
    req: &VerifyAndComplete,
) -> Result<Value, DomainError> {
    const OPERATION: &str = "verify_and_complete";
    let mut task = w.load_by_key(&req.task_key)?;
    let key = w.task_key(&task);
    let from_status = task.status();
    let from_version = task.version;

    // R1：verify_and_complete 改的是领取中的任务。
    let claim = task.claim();
    if let Err(e) = ownership::may_modify(claim, w.requester(&claim), w.now) {
        return Err(claim_not_owned(&key, e));
    }
    match req.expected_version {
        Some(expected) if expected != task.version => {
            return Err(w.version_conflict(&task, expected)?);
        }
        Some(_) => {}
        None => {
            let holds = holds_claim(w, &task, StateWrite::VerifyAndComplete, false);
            if version_need(PatchKind::VerifyAndComplete, holds) == VersionNeed::Required {
                return Err(version_required(&key, OPERATION, task.version));
            }
        }
    }

    let auto = auto_start(StateWrite::VerifyAndComplete, task.status());
    let mut auto_applied = false;
    if auto == AutoStart::Apply {
        start_preconditions(w, &task, &key, false)?;
        let target = resolve(Operation::Start, task.state, false)
            .map_err(|e| invalid_transition(&key, e, false))?;
        claim_and_start(w, &mut task, target, Operation::Start, &key)?;
        auto_applied = true;
    }

    let parent_before = task.parent_id.clone();
    let mut transitions = Vec::new();
    let mut verification_sequence = None;
    if task.status() != Status::Verifying {
        let target = resolve(Operation::Verify, task.state, false)
            .map_err(|e| invalid_transition(&key, e, auto == AutoStart::SuggestStart))?;
        let before = task.clone();
        task.state = target;
        task.clear_waiting();
        commit(
            w,
            &mut task,
            &key,
            "work.verification_requested",
            Operation::Verify,
            &before,
            json!({ "operation": OPERATION, "composite": true }),
            true,
        )?;
        w.session_effect(&task.id, SessionEffect::Working)?;
        transitions.push(Status::Verifying.as_str());
        verification_sequence = Some(w.sequence);
    }

    let target = resolve(Operation::Complete, task.state, false)
        .map_err(|e| invalid_transition(&key, e, false))?;
    check_gate(w, &task, &key, false)?;
    let before = task.clone();
    let mut extra = json!({ "operation": OPERATION, "composite": true });
    if let Some(seq) = verification_sequence {
        extra["verificationSequence"] = json!(seq);
    }
    complete_write(
        w,
        &mut task,
        target,
        &key,
        Operation::Complete,
        &before,
        extra,
    )?;
    transitions.push(Status::Done.as_str());
    if let Some(parent) = parent_before {
        w.recompute_from(&parent);
    }
    w.finish()?;
    let item = w.view(&task.id)?;
    let mut result = json!({
        "taskKey": key,
        "fromStatus": from_status.as_str(),
        "status": Status::Done.as_str(),
        "fromVersion": from_version,
        "taskVersion": item["version"],
        "transitions": transitions,
        "item": item,
        "sequence": w.sequence,
    });
    if auto_applied {
        result["autoApplied"] = json!([{ "taskKey": key, "operations": ["start"] }]);
    }
    Ok(result)
}

// ---------- 错误 ----------

pub(crate) fn claim_not_owned(key: &str, e: ClaimNotOwned) -> DomainError {
    with_next(
        DomainError::new(
            ErrorCode::CLAIM_NOT_OWNED,
            format!("任务 {key} 正由另一个 session 领取中，不能修改；换一个可做的任务"),
        )
        .detail("task_key", key)
        .detail("claimed_by_session_id", e.holder_session)
        .detail("holder_agent_id", e.holder_agent)
        .detail("claim_lease_until", e.lease_until.map(|t| t.to_string()))
        .detail("stale", false),
        json!({ "operation": "task_list", "ready_only": true }),
    )
}

fn already_claimed(key: &str, e: AlreadyClaimed) -> DomainError {
    let message = if e.stale {
        format!("任务 {key} 的领取已过期：带 takeover_stale=true 接管")
    } else {
        format!("任务 {key} 正由另一个 session 领取中")
    };
    let next = if e.stale {
        json!({ "task_key": key, "takeover_stale": true })
    } else {
        json!({ "operation": "task_list", "ready_only": true })
    };
    with_next(
        DomainError::new(ErrorCode::TASK_ALREADY_CLAIMED, message)
            .detail("task_key", key)
            .detail("claimed_by_session_id", e.holder_session)
            .detail("claim_lease_until", e.lease_until.map(|t| t.to_string()))
            .detail("stale", e.stale),
        next,
    )
}

fn owner_required(
    key: &str,
    e: OwnerRequired,
    actor_session: Option<&str>,
    requester: Requester<'_>,
) -> DomainError {
    let mut error = DomainError::new(
        ErrorCode::CLAIM_OWNER_REQUIRED,
        format!("只有领取者（或领取过期后）才能释放任务 {key}"),
    )
    .detail("task_key", key)
    .detail("claimed_by_session_id", e.holder_session)
    .detail("actor_session_id", actor_session)
    .detail("stale", e.stale);
    if e.stale && matches!(requester, Requester::Agent { .. }) {
        error = with_next(
            error,
            json!({ "operation": "release", "task_key": key, "takeover_stale": true }),
        );
    }
    error
}

pub(crate) fn invalid_transition(
    key: &str,
    e: InvalidTransition,
    suggest_start: bool,
) -> DomainError {
    let legal: Vec<&str> = e.legal_operations.iter().map(|op| op.as_str()).collect();
    let error = DomainError::new(
        ErrorCode::INVALID_TRANSITION,
        format!(
            "任务 {key} 当前是 {}，不能 {}；可用的操作见 legal_operations",
            e.current.as_str(),
            e.operation.as_str()
        ),
    )
    .detail("task_key", key)
    .detail("operation", e.operation.as_str())
    .detail("current_status", e.current.as_str())
    .detail("requested_status", e.requested.as_str())
    .detail("legal_operations", legal);
    if suggest_start {
        with_next(error, json!({ "operation": "start", "task_key": key }))
    } else {
        error
    }
}
