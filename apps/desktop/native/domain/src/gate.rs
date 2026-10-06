//! 完成门（01 §4 W-090～W-099；00 C-10、C-11、C-16、C-29）。
//!
//! 七个谓词按固定顺序**全部**求值、汇总所有原因（W-090）；实体类谓词每个最多给 50 条，
//! 但如实报告总数（W-098）。00 C-16：archived_at 不建，检查项 kind 只有 ACCEPTANCE（转换时按
//! store/NORMALIZATION.md N-02g 改写），所以检查项谓词不看 kind、子项谓词不过滤归档。C-11：原因里给公开 key，不再外泄内部 id。
//!
//! 输入由服务读出、按各谓词规定的顺序排好（检查项 created_at,id；子项 local_no,id；
//! blocker local_no,id；前置 local_no,id）。条件判断都在这里，便于变异验红。

use crate::work::{Operation, Status, WorkState, legal_operations};
use serde::Serialize;

/// 每个实体类谓词最多给出的原因条数。
pub const REASON_LIMIT_PER_PREDICATE: usize = 50;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ChecklistStatus {
    Todo,
    Doing,
    Done,
    Skipped,
}

#[derive(Clone, Debug)]
pub struct GateChecklist {
    pub id: String,
    pub status: ChecklistStatus,
    pub evidence_required: bool,
    /// 证据数组长度（W-092：ATM 3 按「数组为空」判断，不比较字面 `[]`）。
    pub evidence_count: usize,
}

#[derive(Clone, Debug)]
pub struct GateTask {
    pub key: String,
    pub status: Status,
}

#[derive(Clone, Debug)]
pub struct GateBlocker {
    pub key: String,
    pub active: bool,
}

/// 被求值的任务，以及它的检查项、子项、blocker、BLOCKS 前置。
#[derive(Clone, Debug)]
pub struct GateInput {
    pub state: WorkState,
    pub verification_required: bool,
    pub checklist: Vec<GateChecklist>,
    pub children: Vec<GateTask>,
    pub blockers: Vec<GateBlocker>,
    pub dependencies: Vec<GateTask>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Predicate {
    Checklist,
    Evidence,
    Children,
    Blockers,
    Dependencies,
    Verification,
    CurrentState,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GateReason {
    ChecklistIncomplete {
        checklist_id: String,
        status: ChecklistStatus,
    },
    EvidenceMissing {
        checklist_id: String,
    },
    ChildIncomplete {
        task_key: String,
        status: Status,
    },
    BlockerActive {
        blocker_key: String,
    },
    /// C-29：前置已取消时 `cancelled=true`，出路是 edit 去掉依赖或 reopen 前置。
    DependencyIncomplete {
        task_key: String,
        status: Status,
        cancelled: bool,
    },
    VerificationRequired,
    CurrentStateInvalid {
        current_status: Status,
        required_status: [Status; 2],
        /// W-022 的 `"op -> TARGET"`，剔除 complete。
        legal_operations: Vec<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Truncation {
    pub predicate: Predicate,
    pub total: usize,
    pub included: usize,
    pub omitted: usize,
}

/// COMPLETION_GATE_FAILED 的 details（W-098）。`truncation` 只列被截断的谓词。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct GateOutcome {
    pub reasons: Vec<GateReason>,
    pub truncated: bool,
    pub reason_limit_per_predicate: usize,
    pub truncation: Vec<Truncation>,
}

impl GateOutcome {
    pub fn passed(&self) -> bool {
        self.reasons.is_empty()
    }
}

/// 完成门。
pub fn evaluate(input: &GateInput) -> GateOutcome {
    let mut out = GateOutcome {
        reasons: Vec::new(),
        truncated: false,
        reason_limit_per_predicate: REASON_LIMIT_PER_PREDICATE,
        truncation: Vec::new(),
    };

    // W-091：SKIPPED 视为已满足，DOING 不算。
    let checklist = input
        .checklist
        .iter()
        .filter(|c| !matches!(c.status, ChecklistStatus::Done | ChecklistStatus::Skipped))
        .map(|c| GateReason::ChecklistIncomplete {
            checklist_id: c.id.clone(),
            status: c.status,
        });
    push_limited(&mut out, Predicate::Checklist, checklist);

    // W-092：必证项只要没 SKIPPED，就得 DONE 并且有证据；TODO 的必证项同时命中上一条。
    let evidence = input
        .checklist
        .iter()
        .filter(|c| {
            c.evidence_required
                && c.status != ChecklistStatus::Skipped
                && (c.status != ChecklistStatus::Done || c.evidence_count == 0)
        })
        .map(|c| GateReason::EvidenceMissing {
            checklist_id: c.id.clone(),
        });
    push_limited(&mut out, Predicate::Evidence, evidence);

    // W-093：CANCELLED 的子项视为已满足。
    let children = input
        .children
        .iter()
        .filter(|c| !matches!(c.status, Status::Done | Status::Cancelled))
        .map(|c| GateReason::ChildIncomplete {
            task_key: c.key.clone(),
            status: c.status,
        });
    push_limited(&mut out, Predicate::Children, children);

    // W-094：只看 ACTIVE 的 blocker 行，不看 blocked_reason。
    let blockers = input
        .blockers
        .iter()
        .filter(|b| b.active)
        .map(|b| GateReason::BlockerActive {
            blocker_key: b.key.clone(),
        });
    push_limited(&mut out, Predicate::Blockers, blockers);

    // W-095：前置必须 DONE；CANCELLED 也不算就绪（D03）。
    let dependencies = input
        .dependencies
        .iter()
        .filter(|d| d.status != Status::Done)
        .map(|d| GateReason::DependencyIncomplete {
            task_key: d.key.clone(),
            status: d.status,
            cancelled: d.status == Status::Cancelled,
        });
    push_limited(&mut out, Predicate::Dependencies, dependencies);

    let status = input.state.status();
    // W-096
    if input.verification_required && status != Status::Verifying {
        out.reasons.push(GateReason::VerificationRequired);
    }
    // W-097：DONE 不命中（它在状态机层已被拒）。
    if !matches!(
        status,
        Status::InProgress | Status::Verifying | Status::Done
    ) {
        out.reasons.push(GateReason::CurrentStateInvalid {
            current_status: status,
            required_status: [Status::InProgress, Status::Verifying],
            legal_operations: legal_operations(input.state)
                .into_iter()
                .filter(|(op, _)| *op != Operation::Complete)
                .map(|(op, target)| format!("{op} -> {target}"))
                .collect(),
        });
    }
    out
}

fn push_limited(
    out: &mut GateOutcome,
    predicate: Predicate,
    hits: impl Iterator<Item = GateReason>,
) {
    let mut total = 0;
    for reason in hits {
        if total < REASON_LIMIT_PER_PREDICATE {
            out.reasons.push(reason);
        }
        total += 1;
    }
    if total > REASON_LIMIT_PER_PREDICATE {
        out.truncated = true;
        out.truncation.push(Truncation {
            predicate,
            total,
            included: REASON_LIMIT_PER_PREDICATE,
            omitted: total - REASON_LIMIT_PER_PREDICATE,
        });
    }
}

/// 检查项写入（checklist_single / checklist_batch / complete 带 checklist）的预检原因（W-053、W-054）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ChecklistProblem {
    VersionConflict {
        task_key: String,
        expected: i64,
        actual: i64,
        /// W-054：传进来的恰好是某个有效检查项的版本时给 `CHECKLIST_VERSION_PASSED`。
        #[serde(skip_serializing_if = "Option::is_none")]
        hint: Option<&'static str>,
    },
    NotFound {
        checklist_id: String,
    },
    TaskMismatch {
        checklist_id: String,
    },
    EvidenceRequired {
        checklist_id: String,
    },
}

/// checklist_batch 汇总之后用哪个错误码拒绝（00 C-10）：只有版本问题时报 VERSION_CONFLICT
/// （可重试）；只要还有别的问题，就报 COMPLETION_GATE_FAILED 并带全部原因。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BatchRejection {
    VersionConflict,
    GateFailed,
}

pub fn batch_rejection(problems: &[ChecklistProblem]) -> Option<BatchRejection> {
    if problems.is_empty() {
        None
    } else if problems
        .iter()
        .all(|p| matches!(p, ChecklistProblem::VersionConflict { .. }))
    {
        Some(BatchRejection::VersionConflict)
    } else {
        Some(BatchRejection::GateFailed)
    }
}

/// W-053 第 5 步 / W-054 第 3 步：DONE 的必证项，决议后的证据（W-055）不能为空。
pub fn evidence_required_violated(
    status: ChecklistStatus,
    evidence_required: bool,
    resolved_evidence_count: usize,
) -> bool {
    status == ChecklistStatus::Done && evidence_required && resolved_evidence_count == 0
}

/// W-055：不传证据保留原值；传 `[]` 清空；传非空整体替换。
pub fn resolved_evidence_count(existing: usize, provided: Option<usize>) -> usize {
    provided.unwrap_or(existing)
}
