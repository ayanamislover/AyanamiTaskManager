//! 证据与候选哈希（D13、D16、D17；W-010、W-011、W-059）。

use atm_domain::error::ProblemKind;
use atm_domain::evidence::{
    Evidence, EvidenceKind, EvidenceSite, diff_hashes, normalize_hashes, validate,
};
use serde_json::json;

fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
    items
        .iter()
        .map(|(n, v)| (n.to_string(), v.to_string()))
        .collect()
}

fn kinds(problems: &[atm_domain::error::Problem]) -> Vec<ProblemKind> {
    problems.iter().map(|p| p.problem).collect()
}

#[test]
fn w010_hashes_normalize_case_and_order() {
    let got = normalize_hashes(
        "candidate_hashes",
        pairs(&[(" Source ", "ABCDEF1"), ("build", "0123456789abcdef")]),
    );
    assert_eq!(
        got,
        Ok(pairs(&[
            ("build", "0123456789abcdef"),
            ("source", "abcdef1")
        ]))
    );
    // 请求 {"Source":"ABCDEF1"} 与提交 {"source":"abcdef1"} 规范化后逐字节相同。
    assert_eq!(
        normalize_hashes("h", pairs(&[("Source", "ABCDEF1")])),
        normalize_hashes("h", pairs(&[("source", "abcdef1")]))
    );
}

#[test]
fn w010_malformed_hashes_are_refused() {
    let err = |items: &[(&str, &str)]| kinds(&normalize_hashes("h", pairs(items)).unwrap_err());
    assert_eq!(err(&[("source", "abc")]), [ProblemKind::Pattern]);
    assert_eq!(err(&[("source", "abcdef")]), [ProblemKind::Pattern]);
    assert!(normalize_hashes("h", pairs(&[("source", "abcdef0")])).is_ok());
    assert_eq!(err(&[("source", "xyz1234")]), [ProblemKind::Pattern]);
    assert_eq!(
        err(&[("Git", "abcdef1"), ("git", "abcdef2")]),
        [ProblemKind::Duplicate]
    );
    assert_eq!(err(&[("1git", "abcdef1")]), [ProblemKind::Pattern]);
    assert_eq!(err(&[("", "abcdef1")]), [ProblemKind::Pattern]);
    assert_eq!(err(&[]), [ProblemKind::TooFew]);
    let long_name = "a".repeat(65);
    assert_eq!(err(&[(&long_name, "abcdef1")]), [ProblemKind::Pattern]);
    let ok_name = format!("a{}", "b".repeat(63));
    assert!(normalize_hashes("h", pairs(&[(&ok_name, &"f".repeat(128))])).is_ok());
    assert_eq!(err(&[("a", &"f".repeat(129))]), [ProblemKind::Pattern]);
    let many: Vec<(String, String)> = (0..21)
        .map(|n| (format!("h{n}"), "abcdef1".to_owned()))
        .collect();
    assert_eq!(
        kinds(&normalize_hashes("h", many).unwrap_err()),
        [ProblemKind::TooMany]
    );
}

#[test]
fn w059_hash_diff_lists_actionable_differences() {
    let bound = pairs(&[("build", "aaaaaaa"), ("source", "bbbbbbb")]);
    assert_eq!(diff_hashes(&bound, &bound), None);
    let submitted = pairs(&[("lint", "ccccccc"), ("source", "ddddddd")]);
    assert_eq!(
        serde_json::to_value(diff_hashes(&bound, &submitted)).unwrap(),
        json!({
            "missing": ["build"],
            "extra": ["lint"],
            "mismatch": [{"name": "source", "bound": "bbbbbbb", "submitted": "ddddddd"}],
        })
    );
}

#[test]
fn w011_evidence_shapes_and_limits() {
    let ok = validate(
        "evidence",
        EvidenceSite::Checklist,
        vec![
            Evidence::Text(" docs/report.md ".into()),
            Evidence::Item {
                kind: EvidenceKind::TestResult,
                value: "186 passed".into(),
                note: None,
            },
        ],
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(ok).unwrap(),
        json!(["docs/report.md", {"kind": "test_result", "value": "186 passed"}])
    );
    // Review 提交只能是对象，且至少 1 条。
    let e = validate(
        "evidence",
        EvidenceSite::ReviewSubmit,
        vec![Evidence::Text("looks good".into())],
    )
    .unwrap_err();
    assert_eq!(kinds(&e), [ProblemKind::Pattern]);
    let e = validate("evidence", EvidenceSite::ReviewSubmit, vec![]).unwrap_err();
    assert_eq!(kinds(&e), [ProblemKind::TooFew]);
    // 长度按 UTF-16 码元。
    let e = validate(
        "evidence",
        EvidenceSite::Checklist,
        vec![Evidence::Text("😀".repeat(1001))],
    )
    .unwrap_err();
    assert_eq!(e[0].problem, ProblemKind::TooLong);
    assert_eq!(e[0].over_by, Some(2));
    assert!(
        validate(
            "evidence",
            EvidenceSite::Checklist,
            vec![Evidence::Text("😀".repeat(1000))]
        )
        .is_ok()
    );
    let e = validate(
        "evidence",
        EvidenceSite::Checklist,
        vec![Evidence::Text(" \u{FEFF} ".into())],
    )
    .unwrap_err();
    assert_eq!(
        (e[0].path.as_str(), e[0].problem),
        ("evidence[0]", ProblemKind::Empty)
    );
    let note = Evidence::Item {
        kind: EvidenceKind::Url,
        value: "u".into(),
        note: Some("n".repeat(501)),
    };
    assert_eq!(
        kinds(&validate("e", EvidenceSite::Checklist, vec![note]).unwrap_err()),
        [ProblemKind::TooLong]
    );
    // 进度最多 20 条，检查项最多 100 条。
    let many = |n| {
        (0..n)
            .map(|i| Evidence::Text(format!("e{i}")))
            .collect::<Vec<_>>()
    };
    assert!(validate("e", EvidenceSite::Progress, many(20)).is_ok());
    assert_eq!(
        kinds(&validate("e", EvidenceSite::Progress, many(21)).unwrap_err()),
        [ProblemKind::TooMany]
    );
    assert!(validate("e", EvidenceSite::Checklist, many(100)).is_ok());
    assert_eq!(
        kinds(&validate("e", EvidenceSite::Checklist, many(101)).unwrap_err()),
        [ProblemKind::TooMany]
    );
    assert_eq!(EvidenceKind::parse("jira"), None);
}
