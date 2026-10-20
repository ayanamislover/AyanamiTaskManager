//! 完成门（D05、D06；W-090～W-099；00 C-10、C-11、C-16、C-29）。

use atm_domain::gate::{
    BatchRejection, ChecklistProblem, ChecklistStatus, GateBlocker, GateChecklist, GateInput,
    GateReason, GateTask, batch_rejection, evaluate, evidence_required_violated,
    resolved_evidence_count,
};
use atm_domain::work::{Status, WorkState};
use serde_json::json;

fn input(status: Status) -> GateInput {
    GateInput {
        state: WorkState::from_status(status),
        verification_required: false,
        checklist: vec![],
        children: vec![],
        blockers: vec![],
        dependencies: vec![],
    }
}

fn item(
    id: &str,
    status: ChecklistStatus,
    evidence_required: bool,
    evidence_count: usize,
) -> GateChecklist {
    GateChecklist {
        id: id.into(),
        status,
        evidence_required,
        evidence_count,
    }
}

fn task(key: &str, status: Status) -> GateTask {
    GateTask {
        key: key.into(),
        status,
    }
}

fn codes(out: &atm_domain::gate::GateOutcome) -> Vec<String> {
    out.reasons
        .iter()
        .map(|r| {
            serde_json::to_value(r).unwrap()["code"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect()
}

#[test]
fn w090_all_seven_predicates_in_fixed_order() {
    let mut i = input(Status::Ready);
    i.verification_required = true;
    i.checklist = vec![item("C1", ChecklistStatus::Todo, true, 0)];
    i.children = vec![task("ATM-T-0002", Status::Blocked)];
    i.blockers = vec![GateBlocker {
        key: "ATM-B-0001".into(),
        active: true,
    }];
    i.dependencies = vec![task("ATM-T-0003", Status::Cancelled)];
    let out = evaluate(&i);
    assert_eq!(
        codes(&out),
        [
            "CHECKLIST_INCOMPLETE",
            "EVIDENCE_MISSING",
            "CHILD_INCOMPLETE",
            "BLOCKER_ACTIVE",
            "DEPENDENCY_INCOMPLETE",
            "VERIFICATION_REQUIRED",
            "CURRENT_STATE_INVALID",
        ]
    );
    assert!(!out.passed());
}

#[test]
fn w091_skipped_counts_doing_does_not() {
    let mut i = input(Status::InProgress);
    i.checklist = vec![
        item("A", ChecklistStatus::Done, false, 0),
        item("B", ChecklistStatus::Skipped, false, 0),
    ];
    assert!(evaluate(&i).passed());
    i.checklist
        .push(item("C", ChecklistStatus::Doing, false, 0));
    assert_eq!(
        evaluate(&i).reasons,
        [GateReason::ChecklistIncomplete {
            checklist_id: "C".into(),
            status: ChecklistStatus::Doing
        }]
    );
}

#[test]
fn w092_required_evidence() {
    let mut i = input(Status::InProgress);
    // SKIPPED 的必证项不要求证据；DONE 有证据通过。
    i.checklist = vec![
        item("A", ChecklistStatus::Skipped, true, 0),
        item("B", ChecklistStatus::Done, true, 2),
    ];
    assert!(evaluate(&i).passed());
    // DONE 但没有证据。
    i.checklist = vec![item("A", ChecklistStatus::Done, true, 0)];
    assert_eq!(
        evaluate(&i).reasons,
        [GateReason::EvidenceMissing {
            checklist_id: "A".into()
        }]
    );
    // TODO 的必证项同时命中两个谓词，同一个 id 出现两次。
    i.checklist = vec![item("A", ChecklistStatus::Todo, true, 0)];
    assert_eq!(
        codes(&evaluate(&i)),
        ["CHECKLIST_INCOMPLETE", "EVIDENCE_MISSING"]
    );
    // 不必证的 DONE 项没有证据也通过。
    i.checklist = vec![item("A", ChecklistStatus::Done, false, 0)];
    assert!(evaluate(&i).passed());
}

#[test]
fn w093_w095_children_may_be_cancelled_dependencies_may_not() {
    let mut i = input(Status::InProgress);
    i.children = vec![
        task("ATM-T-0002", Status::Done),
        task("ATM-T-0003", Status::Cancelled),
    ];
    i.dependencies = vec![task("ATM-T-0004", Status::Done)];
    assert!(evaluate(&i).passed());
    i.dependencies.push(task("ATM-T-0005", Status::Cancelled));
    i.dependencies.push(task("ATM-T-0006", Status::Verifying));
    let out = evaluate(&i);
    // C-11 给公开 key；C-29 标出已取消的前置。
    assert_eq!(
        serde_json::to_value(&out.reasons).unwrap(),
        json!([
            {"code": "DEPENDENCY_INCOMPLETE", "task_key": "ATM-T-0005", "status": "CANCELLED", "cancelled": true},
            {"code": "DEPENDENCY_INCOMPLETE", "task_key": "ATM-T-0006", "status": "VERIFYING", "cancelled": false},
        ])
    );
}

#[test]
fn w094_only_active_blocker_rows_count() {
    let mut i = input(Status::InProgress);
    i.blockers = vec![GateBlocker {
        key: "ATM-B-0001".into(),
        active: false,
    }];
    assert!(evaluate(&i).passed());
    i.blockers.push(GateBlocker {
        key: "ATM-B-0002".into(),
        active: true,
    });
    assert_eq!(
        evaluate(&i).reasons,
        [GateReason::BlockerActive {
            blocker_key: "ATM-B-0002".into()
        }]
    );
}

#[test]
fn w096_w099_verification_and_effective_state() {
    let mut i = input(Status::InProgress);
    i.verification_required = true;
    assert_eq!(evaluate(&i).reasons, [GateReason::VerificationRequired]);
    i.state = WorkState::from_status(Status::Verifying);
    assert!(evaluate(&i).passed());
    // WAITING_AGENT 上直接 complete：current_state 不过（verify_and_complete 先转 VERIFYING 再求值）。
    let waiting = input(Status::WaitingAgent);
    assert_eq!(codes(&evaluate(&waiting)), ["CURRENT_STATE_INVALID"]);
    assert!(evaluate(&input(Status::InProgress)).passed());
    assert!(evaluate(&input(Status::Done)).passed());
}

#[test]
fn w098_fifty_per_predicate_with_true_totals() {
    let mut i = input(Status::InProgress);
    i.checklist = (0..120)
        .map(|n| item(&format!("C{n:03}"), ChecklistStatus::Todo, false, 0))
        .collect();
    i.children = (0..50)
        .map(|n| task(&format!("ATM-T-{n:04}"), Status::Ready))
        .collect();
    let out = evaluate(&i);
    assert_eq!(out.reasons.len(), 100);
    assert!(out.truncated);
    assert_eq!(out.reason_limit_per_predicate, 50);
    assert_eq!(
        serde_json::to_value(&out.truncation).unwrap(),
        json!([{"predicate": "checklist", "total": 120, "included": 50, "omitted": 70}])
    );
    // 截断保留的是排在前面的 50 条。
    assert_eq!(
        out.reasons[49],
        GateReason::ChecklistIncomplete {
            checklist_id: "C049".into(),
            status: ChecklistStatus::Todo
        }
    );
    // 恰好 50 条不算截断。
    i.checklist.truncate(50);
    let out = evaluate(&i);
    assert!(!out.truncated);
    assert!(out.truncation.is_empty());
}

#[test]
fn c10_batch_version_only_is_a_version_conflict() {
    let version = ChecklistProblem::VersionConflict {
        task_key: "ATM-T-0001".into(),
        expected: 3,
        actual: 4,
        hint: None,
    };
    assert_eq!(batch_rejection(&[]), None);
    assert_eq!(
        batch_rejection(std::slice::from_ref(&version)),
        Some(BatchRejection::VersionConflict)
    );
    let mixed = [
        version,
        ChecklistProblem::NotFound {
            checklist_id: "X".into(),
        },
    ];
    assert_eq!(batch_rejection(&mixed), Some(BatchRejection::GateFailed));
    assert_eq!(
        batch_rejection(&[ChecklistProblem::EvidenceRequired {
            checklist_id: "A".into()
        }]),
        Some(BatchRejection::GateFailed)
    );
    assert_eq!(
        serde_json::to_value(&mixed[0]).unwrap(),
        json!({"code": "VERSION_CONFLICT", "task_key": "ATM-T-0001", "expected": 3, "actual": 4})
    );
}

#[test]
fn w053_w055_evidence_resolution() {
    // 不传保留，传 [] 清空，传非空替换。
    assert_eq!(resolved_evidence_count(2, None), 2);
    assert_eq!(resolved_evidence_count(2, Some(0)), 0);
    assert_eq!(resolved_evidence_count(0, Some(3)), 3);
    assert!(evidence_required_violated(ChecklistStatus::Done, true, 0));
    assert!(!evidence_required_violated(ChecklistStatus::Done, true, 1));
    assert!(!evidence_required_violated(ChecklistStatus::Todo, true, 0));
    assert!(!evidence_required_violated(ChecklistStatus::Done, false, 0));
}
