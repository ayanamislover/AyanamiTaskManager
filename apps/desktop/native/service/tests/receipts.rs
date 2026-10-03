//! 回执查找的裁决表（10 R3′、R7‴；R11 A3 的调用索引）。

use atm_service::receipts::{
    CallKey, Candidate, ConflictReason, FixedLookup, LegacyProbe, NewReceipt, Ns, Rebuilt,
    ReceiptScope, Verdict, decide_call, find_call, find_fixed, insert,
};
use rusqlite::{Connection, params};
use std::collections::HashMap;
use std::path::PathBuf;

const T: &str = "2026-10-03T00:00:00.000Z";

fn cand(id: i64, valid: bool, json: &str) -> Candidate {
    Candidate {
        receipt_id: id,
        ns_kind: None,
        ns_id: None,
        legacy_key: None,
        operation: "session.begin".into(),
        fp_family: "canon-v2".into(),
        fingerprint: format!("fp-{id}"),
        receipt_json: json.into(),
        author_agent: None,
        author_session: None,
        actor_session_id: None,
        tombstoned_by_gen: (!valid).then_some(7),
        via_session: None,
        exact: false,
    }
}

const MATCH: Rebuilt = Rebuilt::Fingerprint(String::new());

/// `outcomes[id]`：这个候选重建出来的结果；`MATCH` 表示与候选自己的指纹相同。
fn judge(l: Option<Candidate>, n: Option<Candidate>, outcomes: &[(i64, Rebuilt)]) -> Verdict {
    let table: HashMap<i64, Rebuilt> = outcomes.iter().cloned().collect();
    decide_call(
        l,
        n,
        "session.begin",
        &|c: &Candidate| match &table[&c.receipt_id] {
            Rebuilt::Fingerprint(f) if f.is_empty() => Rebuilt::Fingerprint(c.fingerprint.clone()),
            other => other.clone(),
        },
    )
}

fn other() -> Rebuilt {
    Rebuilt::Fingerprint("different".into())
}

fn replayed(v: &Verdict) -> i64 {
    match v {
        Verdict::Replay(c) => c.receipt_id,
        other => panic!("expected a replay, got {other:?}"),
    }
}

fn conflict(v: &Verdict) -> &ConflictReason {
    match v {
        Verdict::Conflict { reason, .. } => reason,
        other => panic!("expected a conflict, got {other:?}"),
    }
}

#[test]
fn the_call_index_decides_by_whichever_candidate_matches() {
    // 没有候选：新写入。
    assert_eq!(judge(None, None, &[]), Verdict::New);
    // 只有一个候选，按它的状态。
    assert_eq!(
        replayed(&judge(Some(cand(1, true, "L")), None, &[(1, MATCH)])),
        1
    );
    assert_eq!(
        judge(None, Some(cand(2, false, "N")), &[(2, MATCH)]),
        Verdict::Undone { generation: 7 }
    );
    // 恰好一个匹配：另一个不影响结果（r9：N 不遮蔽 L；r10：后来出现的 L 不遮蔽 N）。
    assert_eq!(
        replayed(&judge(
            Some(cand(1, true, "L")),
            Some(cand(2, true, "N")),
            &[(1, MATCH), (2, other())]
        )),
        1
    );
    assert_eq!(
        replayed(&judge(
            Some(cand(1, true, "L")),
            Some(cand(2, true, "N")),
            &[(1, other()), (2, MATCH)]
        )),
        2
    );
    assert_eq!(
        judge(
            Some(cand(1, true, "L")),
            Some(cand(2, false, "N")),
            &[(1, other()), (2, MATCH)]
        ),
        Verdict::Undone { generation: 7 }
    );
    // 旧族表达不了这次请求：L 不匹配。
    assert_eq!(
        replayed(&judge(
            Some(cand(1, true, "L")),
            Some(cand(2, true, "N")),
            &[(1, Rebuilt::NotComparable), (2, MATCH)]
        )),
        2
    );
    // 一个都不匹配：普通冲突。
    assert_eq!(
        conflict(&judge(
            Some(cand(1, true, "L")),
            Some(cand(2, true, "N")),
            &[(1, other()), (2, other())]
        )),
        &ConflictReason::Mismatch
    );
    // 旧行无法复现：fail closed。
    assert_eq!(
        conflict(&judge(
            Some(cand(1, true, "L")),
            None,
            &[(1, Rebuilt::Unsupported("a_b".into()))]
        )),
        &ConflictReason::FpV1UnsupportedKey("a_b".into())
    );
}

/// 两个都匹配：R3′ 的状态表，原文相同不能绕过墓碑。
#[test]
fn when_both_match_the_state_table_decides() {
    let both = [(1, MATCH), (2, MATCH)];
    assert_eq!(
        judge(Some(cand(1, false, "X")), Some(cand(2, false, "X")), &both),
        Verdict::Undone { generation: 7 }
    );
    for (l, n) in [(true, false), (false, true)] {
        assert_eq!(
            conflict(&judge(Some(cand(1, l, "X")), Some(cand(2, n, "X")), &both)),
            &ConflictReason::AmbiguousLegacy,
            "{l} {n}"
        );
    }
    assert_eq!(
        replayed(&judge(
            Some(cand(5, true, "X")),
            Some(cand(3, true, "X")),
            &[(5, MATCH), (3, MATCH)]
        )),
        3
    );
    assert_eq!(
        conflict(&judge(
            Some(cand(1, true, "X")),
            Some(cand(2, true, "Y")),
            &both
        )),
        &ConflictReason::AmbiguousLegacy
    );
}

#[test]
fn a_different_operation_never_matches() {
    let mut n = cand(2, true, "N");
    n.operation = "project.create".into();
    assert_eq!(
        conflict(&judge(None, Some(n), &[(2, MATCH)])),
        &ConflictReason::Mismatch
    );
}

fn db(name: &str) -> Connection {
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("target")
        });
    let dir = target.join("service-tests").join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let c = atm_store::open(&dir.join("atm.sqlite")).unwrap();
    c.execute_batch(&format!(
        "INSERT INTO scope_generations (gen, scope_kind, scope_id, reason, epoch, created_at) VALUES
           (1, 'PROJECT', 'P', 'CREATED', 'E', '{T}'), (2, 'KNOWLEDGE', 'KDB', 'CREATED', 'E', '{T}');"
    ))
    .unwrap();
    c
}

fn call_receipt(
    c: &mut Connection,
    kind: &'static str,
    id: &str,
    operation: &str,
    op_id: &str,
    json: &str,
) -> rusqlite::Result<i64> {
    let tx = c.transaction()?;
    let key = CallKey {
        principal_kind: kind,
        principal_id: id.into(),
        operation: operation.into(),
    };
    let scope = ReceiptScope::global();
    let fp = format!("fp:{json}");
    let id = insert(
        &tx,
        &NewReceipt {
            scope: &scope,
            ns: None,
            call: Some(&key),
            op_id,
            operation,
            fingerprint: &fp,
            receipt_json: json,
            author_agent: None,
            author_session: None,
            actor_session_id: None,
            scope_generation: None,
            created_at: T,
        },
    )?;
    tx.commit()?;
    Ok(id)
}

/// 调用索引是四列原值的唯一索引：不拼接，含冒号也不会撞；AGENT 与 USER 互不相干。
#[test]
fn the_call_index_keeps_its_four_columns_apart() {
    let mut c = db("call-index");
    call_receipt(&mut c, "AGENT", "a:b", "session.begin", "c", "1").unwrap();
    call_receipt(&mut c, "AGENT", "a", "session.begin", "b:c", "2").unwrap();
    call_receipt(&mut c, "USER", "a:b", "session.begin", "c", "3").unwrap();
    call_receipt(&mut c, "AGENT", "a:b", "project.create", "c", "4").unwrap();
    assert!(
        call_receipt(&mut c, "AGENT", "a:b", "session.begin", "c", "5").is_err(),
        "the index is unique"
    );
    let tx = c.transaction().unwrap();
    let find = |kind: &'static str, id: &str, operation: &str, op_id: &str| {
        let key = CallKey {
            principal_kind: kind,
            principal_id: id.into(),
            operation: operation.into(),
        };
        find_call(&tx, &key, op_id, None, &|c: &Candidate| {
            Rebuilt::Fingerprint(c.fingerprint.clone())
        })
        .unwrap()
    };
    let json = |v: Verdict| match v {
        Verdict::Replay(c) => c.receipt_json,
        other => panic!("{other:?}"),
    };
    assert_eq!(json(find("AGENT", "a:b", "session.begin", "c")), "1");
    assert_eq!(json(find("AGENT", "a", "session.begin", "b:c")), "2");
    assert_eq!(json(find("USER", "a:b", "session.begin", "c")), "3");
    assert_eq!(json(find("AGENT", "a:b", "project.create", "c")), "4");
    assert_eq!(find("AGENT", "a", "session.begin", "c"), Verdict::New);
}

/// begin 的旧行候选：只看请求选中的那个项目里 `session-begin:<op_id>` 那一行。
#[test]
fn begin_sees_the_legacy_row_of_the_selected_project_only() {
    let mut c = db("call-index-legacy");
    c.execute(
        "INSERT INTO idempotency_receipts (scope_kind, scope_id, legacy_key, legacy_op_id, legacy_class, operation, fp_v, fp_family,
                                           fingerprint, receipt_json, scope_generation, created_at)
         VALUES ('PROJECT', 'P', 'session-begin:op', 'op', 'BEGIN', 'session.begin', 1, 'kernel-v1', 'old', '{\"old\":1}', 1, ?1)",
        [T],
    )
    .unwrap();
    let tx = c.transaction().unwrap();
    let key = CallKey {
        principal_kind: "AGENT",
        principal_id: "claude".into(),
        operation: "session.begin".into(),
    };
    let same = |c: &Candidate| Rebuilt::Fingerprint(c.fingerprint.clone());
    let p = ReceiptScope::project("P");
    match find_call(&tx, &key, "op", Some((&p, "session-begin:op")), &same).unwrap() {
        Verdict::Replay(c) => assert_eq!(c.receipt_json, "{\"old\":1}"),
        other => panic!("{other:?}"),
    }
    // 选择器指向别的项目：旧行不是候选。
    let q = ReceiptScope::project("Q");
    assert_eq!(
        find_call(&tx, &key, "op", Some((&q, "session-begin:op")), &same).unwrap(),
        Verdict::New
    );
}

/// R7‴ 的惰性类不参与查找：键相同也当作没有。
#[test]
fn inert_legacy_classes_are_not_candidates() {
    let mut c = db("inert");
    for (key, class) in [
        ("k-history", "PROMOTION_HISTORY"),
        ("k-unclassified", "LEGACY_UNCLASSIFIED"),
        ("k-user", "USER"),
    ] {
        c.execute(
            "INSERT INTO idempotency_receipts (scope_kind, scope_id, legacy_key, legacy_class, operation, fp_v, fp_family,
                                               fingerprint, receipt_json, scope_generation, created_at)
             VALUES ('KNOWLEDGE', 'KDB', ?1, ?2, '*', 1, 'knowledge-v1', 'f', '{}', 2, ?3)",
            params![key, class, T],
        )
        .unwrap();
    }
    let tx = c.transaction().unwrap();
    let scope = ReceiptScope::knowledge("KDB");
    let same = |c: &Candidate| Rebuilt::Fingerprint(c.fingerprint.clone());
    let look = |key: &str| {
        let lookup = FixedLookup {
            scope: &scope,
            op_id: key,
            operation: "knowledge.user_edit",
            own: Ns::actor("USER"),
            others: Vec::new(),
            legacy: vec![LegacyProbe {
                key: key.into(),
                session: None,
                own: true,
            }],
        };
        find_fixed(&tx, &lookup, &same).unwrap()
    };
    assert_eq!(look("k-history"), Verdict::New);
    assert_eq!(look("k-unclassified"), Verdict::New);
    assert!(
        matches!(look("k-user"), Verdict::Replay(_)),
        "positive control"
    );
}

/// 不同 scope 的回执永远不是候选。
#[test]
fn receipts_in_another_scope_are_never_candidates() {
    let mut c = db("cross-scope");
    c.execute(
        "INSERT INTO idempotency_receipts (scope_kind, scope_id, ns_kind, ns_id, op_id, operation, fp_v, fp_family,
                                           fingerprint, receipt_json, scope_generation, created_at)
         VALUES ('PROJECT', 'P', 'ACTOR', 'USER', 'x', 'record.create', 2, 'canon-v2', 'f', '{}', 1, ?1)",
        [T],
    )
    .unwrap();
    let tx = c.transaction().unwrap();
    let same = |c: &Candidate| Rebuilt::Fingerprint(c.fingerprint.clone());
    let look = |scope: ReceiptScope| {
        let lookup = FixedLookup {
            scope: &scope,
            op_id: "x",
            operation: "record.create",
            own: Ns::actor("USER"),
            others: Vec::new(),
            legacy: Vec::new(),
        };
        find_fixed(&tx, &lookup, &same).unwrap()
    };
    assert_eq!(look(ReceiptScope::project("Q")), Verdict::New);
    assert!(
        matches!(look(ReceiptScope::project("P")), Verdict::Replay(_)),
        "positive control"
    );
}
