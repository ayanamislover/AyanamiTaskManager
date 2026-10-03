//! 错误目录（01 §7；00 §7；10 R1～R4、R11；11 §3）。
//!
//! 2.x 部分的对照是仓库里 2.x 的 `packages/errors/src/index.ts` 本身：逐条解析
//! `CODE: policy(http[, true])`，要求 ATM 3 目录里每个 2.x 码都在、HTTP 状态与可重试一致。

use atm_domain::error::{
    Committed, DomainError, Envelope, ErrorCode, Fix, FixKind, Problem, ProblemKind, ToolCall,
};
use serde_json::json;
use std::path::Path;

fn legacy_policies() -> Vec<(String, u16, bool)> {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../packages/errors/src/index.ts");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let body = text
        .split("ERROR_POLICIES = Object.freeze({")
        .nth(1)
        .expect("ERROR_POLICIES");
    let body = body.split("} as const);").next().unwrap();
    let mut out = Vec::new();
    for line in body.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let (code, rest) = line
            .split_once(": policy(")
            .unwrap_or_else(|| panic!("unparsed line {line:?}"));
        let args = rest.trim_end_matches("),");
        let mut parts = args.split(',').map(str::trim);
        let http: u16 = parts.next().unwrap().parse().unwrap();
        let retryable = parts.next() == Some("true");
        out.push((code.to_owned(), http, retryable));
    }
    out
}

#[test]
fn every_2x_code_keeps_its_http_status_and_retryability() {
    let legacy = legacy_policies();
    assert_eq!(
        legacy.len(),
        108,
        "2.x catalog size changed; re-check the mapping"
    );
    for (code, http, retryable) in legacy {
        let c = ErrorCode::parse(&code)
            .unwrap_or_else(|| panic!("{code} missing from the ATM 3 catalog"));
        assert_eq!(
            (c.http_status(), c.retryable()),
            (http, retryable),
            "{code}"
        );
    }
}

#[test]
fn v6_codes_are_in_the_catalog() {
    for (code, http, retryable) in [
        ("CLAIM_NOT_OWNED", 409, false),
        ("PLANNING_TARGET_CLOSED", 409, false),
        ("REVIEW_SELF_NOT_ALLOWED", 409, false),
        ("WORK_ITEM_TERMINAL", 409, false),
        ("STORE_BUSY", 503, true),
        ("SERVICE_UNAVAILABLE", 503, true),
        ("KNOWLEDGE_SLUG_CONFLICT", 409, false),
        ("OPERATION_UNDONE_BY_RESTORE", 409, false),
        ("SCOPE_RESTORED", 409, false),
        ("TARGET_CHANGED", 409, false),
        ("EXPECTED_VERSION_REQUIRED", 422, false),
        ("PRINCIPAL_CAPABILITY_DENIED", 403, false),
    ] {
        let c = ErrorCode::parse(code).unwrap_or_else(|| panic!("{code}"));
        assert_eq!(
            (c.http_status(), c.retryable()),
            (http, retryable),
            "{code}"
        );
    }
    // 00 §2 Q-01 / 04 C-L12：不新增 CURSOR_EXPIRED；05 的 OPERATION_REVOKED_BY_RESTORE 已由 00 改名。
    assert_eq!(ErrorCode::parse("CURSOR_EXPIRED"), None);
    assert_eq!(ErrorCode::parse("OPERATION_REVOKED_BY_RESTORE"), None);
    assert_eq!(ErrorCode::parse("IDEMPOTENCY_LEGACY_UNVERIFIABLE"), None);
}

#[test]
fn codes_are_unique_and_round_trip() {
    let mut names: Vec<&str> = ErrorCode::ALL.iter().map(|c| c.as_str()).collect();
    for &c in ErrorCode::ALL {
        assert_eq!(ErrorCode::parse(c.as_str()), Some(c));
    }
    let n = names.len();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), n);
}

/// 11 §3 的出路表。
#[test]
fn fix_kinds_follow_the_ergonomics_table() {
    use FixKind::*;
    for (code, kind) in [
        ("INVALID_ARGUMENT", Call),
        ("VERSION_CONFLICT", Call),
        ("EXPECTED_VERSION_REQUIRED", Call),
        ("INVALID_TRANSITION", Call),
        ("COMPLETION_GATE_FAILED", Call),
        ("CLAIM_NOT_OWNED", Call),
        ("SESSION_REQUIRED", Call),
        ("SESSION_CLOSED", Call),
        ("SESSION_SUCCESSOR_AMBIGUOUS", Call),
        ("PROJECT_REQUIRED", Call),
        ("PROJECT_NOT_FOUND", Call),
        ("IDEMPOTENCY_CONFLICT", Reread),
        ("OPERATION_UNDONE_BY_RESTORE", Reread),
        ("SCOPE_RESTORED", Reread),
        ("STORE_BUSY", Wait),
        ("SERVICE_UNAVAILABLE", Wait),
        ("RESULT_TOO_LARGE", Call),
        ("USER_AUTHORIZATION_REQUIRED", AskUser),
        ("DEPENDENCY_NOT_READY", Call),
        ("INTERNAL_ERROR", None),
    ] {
        assert_eq!(ErrorCode::parse(code).unwrap().fix_kind(), kind, "{code}");
    }
    // 可重试的 Agent 可见码都必须给出能执行的出路（Wait 或 Call），只有 INTERNAL_ERROR 例外。
    for &c in ErrorCode::ALL {
        if c.retryable() && c.fix_kind() == None {
            assert!(
                matches!(
                    c.as_str(),
                    "INTERNAL_ERROR"
                        | "AGENT_DOCS_MISSING"
                        | "AGENT_GUIDE_MISSING"
                        | "AGENT_SKILLS_MISSING"
                        | "AGENT_SKILL_MISSING"
                ),
                "{c}"
            );
        }
    }
}

#[test]
fn envelope_shape_matches_the_ergonomics_draft() {
    let error = DomainError::new(
        ErrorCode::VERSION_CONFLICT,
        "任务 ATM-T-0042 已是 v9，你给的是 v7",
    )
    .detail("expected", 7)
    .detail("actual", 9);
    let fix = Fix::Call {
        call: ToolCall {
            name: "atm_task_patch".into(),
            arguments: json!({"task_key": "ATM-T-0042", "operation": "complete"}),
        },
        why: "你持有该任务，可省略 expected_version".into(),
    };
    let envelope = Envelope::new(
        error,
        Committed::No,
        Some(json!({"task_key": "ATM-T-0042", "version": 9})),
        fix,
    );
    assert_eq!(
        serde_json::to_value(&envelope).unwrap(),
        json!({
            "ok": false,
            "code": "VERSION_CONFLICT",
            "message": "任务 ATM-T-0042 已是 v9，你给的是 v7",
            "retryable": true,
            "committed": false,
            "state": {"task_key": "ATM-T-0042", "version": 9},
            "fix": {
                "kind": "call",
                "call": {"name": "atm_task_patch", "arguments": {"task_key": "ATM-T-0042", "operation": "complete"}},
                "why": "你持有该任务，可省略 expected_version",
            },
            "details": {"expected": 7, "actual": 9},
        })
    );
    assert_eq!(
        serde_json::to_value(Committed::Unknown).unwrap(),
        json!("unknown")
    );
    assert_eq!(serde_json::to_value(Committed::Yes).unwrap(), json!(true));
    assert_eq!(
        serde_json::to_value(Fix::Wait {
            retry_after_ms: 500,
            call: Option::None
        })
        .unwrap(),
        json!({"kind": "wait", "retry_after_ms": 500, "call": null})
    );
}

#[test]
fn invalid_argument_carries_problems() {
    let e = DomainError::invalid_argument(vec![
        Problem::new("items[0].operaton", ProblemKind::Unknown).got("complete"),
    ]);
    assert_eq!(e.code, ErrorCode::INVALID_ARGUMENT);
    assert_eq!(
        serde_json::Value::Object(e.details),
        json!({"problems": [{"path": "items[0].operaton", "problem": "unknown", "got": "complete"}]})
    );
}
