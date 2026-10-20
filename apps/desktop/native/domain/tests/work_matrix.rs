//! 01 §2.2 操作 × 状态矩阵逐格验收（D01、D02；W-002、W-020、W-022、W-026、W-034、W-097）。
//!
//! 期望值是从规格表照抄的字符串，不经过被测代码的任何表：
//! `=` 同态放行；`门` 状态机放行但完成门的 current_state 谓词必然拒绝；`✗` INVALID_TRANSITION；
//! `phase` 回到等待之前的 phase；`=*` 只在 successor reclaim 时放行（否则 ✗）。

use atm_domain::gate::{GateInput, GateReason, evaluate};
use atm_domain::work::{
    InvalidTransition, Operation, Phase, Status, WaitingOn, WorkState, legal_operations, resolve,
};

const STATUSES: [&str; 10] = [
    "BACKLOG",
    "READY",
    "CLAIMED",
    "IN_PROGRESS",
    "BLOCKED",
    "WAITING_AGENT",
    "WAITING_USER",
    "VERIFYING",
    "DONE",
    "CANCELLED",
];

const MATRIX: [(&str, [&str; 10]); 12] = [
    (
        "claim",
        [
            "CLAIMED", "CLAIMED", "=", "=*", "✗", "✗", "✗", "✗", "✗", "✗",
        ],
    ),
    (
        "start",
        [
            "IN_PROGRESS",
            "IN_PROGRESS",
            "IN_PROGRESS",
            "=",
            "IN_PROGRESS",
            "IN_PROGRESS",
            "IN_PROGRESS",
            "IN_PROGRESS",
            "✗",
            "✗",
        ],
    ),
    (
        "release",
        [
            "✗", "✗", "READY", "READY", "READY", "READY", "READY", "READY", "✗", "✗",
        ],
    ),
    (
        "ready",
        ["READY", "=", "✗", "✗", "✗", "✗", "✗", "✗", "✗", "✗"],
    ),
    (
        "block",
        [
            "✗", "✗", "BLOCKED", "BLOCKED", "=", "BLOCKED", "BLOCKED", "BLOCKED", "✗", "✗",
        ],
    ),
    (
        "wait_agent",
        [
            "✗",
            "✗",
            "✗",
            "WAITING_AGENT",
            "WAITING_AGENT",
            "=",
            "✗",
            "WAITING_AGENT",
            "✗",
            "✗",
        ],
    ),
    (
        "wait_user",
        [
            "✗",
            "✗",
            "✗",
            "WAITING_USER",
            "WAITING_USER",
            "✗",
            "=",
            "WAITING_USER",
            "✗",
            "✗",
        ],
    ),
    (
        "verify",
        [
            "✗",
            "✗",
            "✗",
            "VERIFYING",
            "✗",
            "VERIFYING",
            "VERIFYING",
            "=",
            "✗",
            "✗",
        ],
    ),
    (
        "complete",
        ["门", "门", "门", "DONE", "门", "门", "门", "DONE", "✗", "✗"],
    ),
    (
        "cancel",
        [
            "CANCELLED",
            "CANCELLED",
            "CANCELLED",
            "CANCELLED",
            "CANCELLED",
            "CANCELLED",
            "CANCELLED",
            "CANCELLED",
            "✗",
            "✗",
        ],
    ),
    (
        "reopen",
        [
            "✗",
            "✗",
            "✗",
            "✗",
            "IN_PROGRESS",
            "phase",
            "phase",
            "IN_PROGRESS",
            "IN_PROGRESS",
            "BACKLOG",
        ],
    ),
    ("edit", ["=", "=", "=", "=", "=", "=", "=", "=", "=", "="]),
];

/// 每个状态的全部合法 `(phase, waiting_on)` 形态：WAITING_* 各有 IN_PROGRESS / VERIFYING 两种 phase。
fn shapes(status: Status) -> Vec<WorkState> {
    match status {
        Status::WaitingAgent | Status::WaitingUser => {
            let on = if status == Status::WaitingAgent {
                WaitingOn::Agent
            } else {
                WaitingOn::User
            };
            vec![
                WorkState::new(Phase::InProgress, Some(on)).unwrap(),
                WorkState::new(Phase::Verifying, Some(on)).unwrap(),
            ]
        }
        s => vec![WorkState::from_status(s)],
    }
}

fn current_state_rejected(state: WorkState) -> bool {
    let input = GateInput {
        state,
        verification_required: false,
        checklist: vec![],
        children: vec![],
        blockers: vec![],
        dependencies: vec![],
    };
    let out = evaluate(&input);
    out.reasons.len() == 1 && matches!(out.reasons[0], GateReason::CurrentStateInvalid { .. })
}

#[test]
fn every_cell_of_the_operation_state_matrix() {
    let mut cells = 0;
    for (op_name, row) in MATRIX {
        let op = Operation::parse(op_name).unwrap();
        for (status_name, cell) in STATUSES.iter().zip(row) {
            let status = Status::parse(status_name).unwrap();
            for from in shapes(status) {
                for successor in [false, true] {
                    cells += 1;
                    let got = resolve(op, from, successor);
                    let at = format!(
                        "{op_name} on {status_name} (phase {}, successor {successor})",
                        from.phase()
                    );
                    match cell {
                        "✗" => assert!(
                            got.is_err(),
                            "{at}: expected INVALID_TRANSITION, got {got:?}"
                        ),
                        "=*" if !successor => assert!(
                            got.is_err(),
                            "{at}: claim on IN_PROGRESS needs successor reclaim"
                        ),
                        "=" | "=*" => assert_eq!(got, Ok(from), "{at}: homomorphic"),
                        "门" => {
                            assert_eq!(got.map(WorkState::status), Ok(Status::Done), "{at}");
                            assert!(
                                current_state_rejected(from),
                                "{at}: completion gate must refuse current state"
                            );
                        }
                        "phase" => {
                            let to = got.unwrap_or_else(|e| panic!("{at}: {e:?}"));
                            assert_eq!(
                                to,
                                WorkState::plain(from.phase()),
                                "{at}: reopen returns to the phase before waiting"
                            );
                        }
                        target => {
                            let to = got.unwrap_or_else(|e| panic!("{at}: {e:?}"));
                            assert_eq!(to.status().as_str(), target, "{at}");
                        }
                    }
                }
            }
        }
    }
    assert_eq!(cells, 12 * 12 * 2);
}

#[test]
fn w002_waiting_keeps_the_phase_it_came_from() {
    let ip = WorkState::from_status(Status::InProgress);
    let ver = WorkState::from_status(Status::Verifying);
    let blocked = WorkState::from_status(Status::Blocked);
    let wait_agent = resolve(Operation::WaitAgent, ip, false).unwrap();
    assert_eq!(
        (
            wait_agent.status(),
            wait_agent.phase(),
            wait_agent.waiting_on()
        ),
        (
            Status::WaitingAgent,
            Phase::InProgress,
            Some(WaitingOn::Agent)
        )
    );
    let wait_user = resolve(Operation::WaitUser, ver, false).unwrap();
    assert_eq!(
        (
            wait_user.status(),
            wait_user.phase(),
            wait_user.waiting_on()
        ),
        (Status::WaitingUser, Phase::Verifying, Some(WaitingOn::User))
    );
    // W-031：从 BLOCKED 进入等待，phase 改为 IN_PROGRESS。
    assert_eq!(
        resolve(Operation::WaitUser, blocked, false)
            .unwrap()
            .phase(),
        Phase::InProgress
    );
    // 同类同态：phase 不变。
    assert_eq!(
        resolve(Operation::WaitUser, wait_user, false),
        Ok(wait_user)
    );
    // D02：VERIFYING 上等待再 reopen 回到 VERIFYING，而不是 IN_PROGRESS。
    assert_eq!(
        resolve(Operation::Reopen, wait_user, false)
            .unwrap()
            .status(),
        Status::Verifying
    );
    // D02：CANCELLED 重开回 BACKLOG，不能统一成 READY。
    assert_eq!(
        resolve(
            Operation::Reopen,
            WorkState::from_status(Status::Cancelled),
            false
        )
        .unwrap()
        .status(),
        Status::Backlog
    );
}

#[test]
fn w020_invalid_transition_carries_legal_operations() {
    let done = WorkState::from_status(Status::Done);
    assert_eq!(
        resolve(Operation::Complete, done, false),
        Err(InvalidTransition {
            operation: Operation::Complete,
            current: Status::Done,
            requested: Status::Done,
            legal_operations: vec![Operation::Reopen, Operation::Edit],
        })
    );
    // 等待类型不能直接互换。
    let wa = WorkState::from_status(Status::WaitingAgent);
    assert!(resolve(Operation::WaitUser, wa, false).is_err());
    assert!(
        resolve(
            Operation::Verify,
            WorkState::from_status(Status::Claimed),
            false
        )
        .is_err()
    );
}

#[test]
fn w022_legal_operations_follow_table_order() {
    let names = |s: Status| -> Vec<String> {
        legal_operations(WorkState::from_status(s))
            .into_iter()
            .map(|(op, _)| op.to_string())
            .collect()
    };
    assert_eq!(
        names(Status::InProgress),
        [
            "start",
            "release",
            "block",
            "wait_agent",
            "wait_user",
            "verify",
            "complete",
            "cancel",
            "edit"
        ]
    );
    // READY 列出 complete：legal_operations 不看完成门（W-022）。
    assert_eq!(
        names(Status::Ready),
        ["claim", "start", "ready", "complete", "cancel", "edit"]
    );
    assert_eq!(names(Status::Done), ["reopen", "edit"]);
    assert_eq!(names(Status::Cancelled), ["reopen", "edit"]);
    // 每个列出的操作都确实被状态机放行（successor reclaim 不计入）。
    for &s in Status::ALL {
        for from in shapes(s) {
            for (op, target) in legal_operations(from) {
                assert_eq!(
                    resolve(op, from, false).map(WorkState::status),
                    Ok(target),
                    "{op} on {s}"
                );
            }
        }
    }
}

#[test]
fn w097_current_state_lists_prerequisites_without_complete() {
    let out = evaluate(&GateInput {
        state: WorkState::from_status(Status::Claimed),
        verification_required: false,
        checklist: vec![],
        children: vec![],
        blockers: vec![],
        dependencies: vec![],
    });
    let GateReason::CurrentStateInvalid {
        legal_operations,
        required_status,
        ..
    } = &out.reasons[0]
    else {
        panic!("{out:?}");
    };
    assert_eq!(required_status, &[Status::InProgress, Status::Verifying]);
    assert!(legal_operations.contains(&"start -> IN_PROGRESS".to_owned()));
    assert!(!legal_operations.iter().any(|l| l.starts_with("complete")));
    // READY 的 CURRENT_STATE_INVALID 里不能出现 complete -> DONE（W-022 反例）。
    let ready = evaluate(&GateInput {
        state: WorkState::from_status(Status::Ready),
        verification_required: false,
        checklist: vec![],
        children: vec![],
        blockers: vec![],
        dependencies: vec![],
    });
    let GateReason::CurrentStateInvalid {
        legal_operations, ..
    } = &ready.reasons[0]
    else {
        panic!()
    };
    assert!(!legal_operations.contains(&"complete -> DONE".to_owned()));
}

/// W-002 反例（属性测试）：12 种操作 × 全部起始形态（含 successor 两种），结果的 (status, phase, waiting_on)
/// 一定落在规格的合法组合表里；表照规格抄成字符串，不经过被测代码。非法形态本身也构造不出来。
#[test]
fn w002_every_result_is_a_legal_combination() {
    let legal = |status: &str, phase: &str, on: Option<&str>| -> bool {
        match (status, on) {
            ("WAITING_AGENT", Some("AGENT")) | ("WAITING_USER", Some("USER")) => {
                matches!(phase, "IN_PROGRESS" | "VERIFYING")
            }
            (s, None) => {
                s == phase
                    && [
                        "BACKLOG",
                        "READY",
                        "CLAIMED",
                        "IN_PROGRESS",
                        "BLOCKED",
                        "VERIFYING",
                        "DONE",
                        "CANCELLED",
                    ]
                    .contains(&s)
            }
            _ => false,
        }
    };
    let mut checked = 0;
    for &op in Operation::ALL {
        for &status in Status::ALL {
            for from in shapes(status) {
                for successor in [false, true] {
                    if let Ok(to) = resolve(op, from, successor) {
                        checked += 1;
                        let on = to.waiting_on().map(|w| w.as_str());
                        assert!(
                            legal(to.status().as_str(), to.phase().as_str(), on),
                            "{op:?} on {from:?} gave {to:?}"
                        );
                    }
                }
            }
        }
    }
    assert!(checked > 100, "{checked}");
    // 规格点名的三种非法组合构造不出来。
    assert!(WorkState::new(Phase::Blocked, Some(WaitingOn::User)).is_none());
    assert!(WorkState::new(Phase::Blocked, Some(WaitingOn::Agent)).is_none());
    assert!(!legal("READY", "IN_PROGRESS", None));
}
