//! 五种复合操作的验收（W2d；01 W-050～W-063，00 C-10、C-12、C-21、C-26、C-27，10 R1、R2，R11 P1-1 第 2、4 条）。
//!
//! 每个复合操作都核对：成功时的副作用与版本、失败时整库零变化（W-062）、同 op_id 的幂等重放（W-063）。
//! 用例名带规则编号，追溯表见 `SERVICE-NOTES.md`。

mod support;

use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::evidence::{Evidence, EvidenceKind};
use atm_domain::gate::ChecklistStatus;
use atm_domain::work::Operation;
use atm_service::fp::{self, JsValue};
use atm_service::work::{
    ChecklistBatch, ChecklistChange, ChecklistRef, ChecklistSingle, CompleteChecklist, CreateItem,
    NewChecklist, PatchItem, ReviewRequest, ReviewSubmit, Target, Verdict, VerifyAndComplete,
};
use atm_service::write::Written;
use rusqlite::params;
use serde_json::{Value, json};
use support::*;

// ---------- 助手 ----------

fn ev(kind: EvidenceKind, value: &str) -> Evidence {
    Evidence::Item {
        kind,
        value: value.into(),
        note: None,
    }
}

fn checklist(title: &str, required: bool) -> NewChecklist {
    NewChecklist {
        title: title.into(),
        evidence_required: required,
        weight: None,
    }
}

/// S1 建一个带检查项的任务，返回 key 与检查项 id（按创建顺序）。
fn task_with(w: &World, title: &str, items: &[(&str, bool)]) -> (String, Vec<String>) {
    let r = w
        .create_as(
            &agent(),
            Some("S1"),
            vec![CreateItem {
                checklist: items.iter().map(|(t, req)| checklist(t, *req)).collect(),
                ..item(title)
            }],
        )
        .unwrap();
    let key = r.result["items"][0]["key"].as_str().unwrap().to_owned();
    let ids = r.result["checklist"][&key]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    (key, ids)
}

fn single(
    task: Option<&str>,
    id: &str,
    v: Option<i64>,
    status: ChecklistStatus,
) -> ChecklistSingle {
    ChecklistSingle {
        task_key: task.map(str::to_owned),
        checklist_id: id.into(),
        expected_checklist_version: v,
        legacy_version_name: false,
        status,
        evidence: None,
    }
}

fn change(id: &str, status: ChecklistStatus, evidence: Option<Vec<Evidence>>) -> ChecklistChange {
    ChecklistChange {
        checklist_id: id.into(),
        status,
        evidence,
    }
}

fn vac(key: &str, v: Option<i64>) -> VerifyAndComplete {
    VerifyAndComplete {
        task_key: key.into(),
        expected_version: v,
    }
}

impl World {
    fn checklist_as(
        &self,
        session: Option<&str>,
        req: ChecklistSingle,
    ) -> Result<Written, DomainError> {
        let p = if session.is_some() { agent() } else { user() };
        self.svc.update_checklist(&p, &self.target(session), req)
    }

    fn batch_as(&self, session: Option<&str>, req: ChecklistBatch) -> Result<Written, DomainError> {
        let p = if session.is_some() { agent() } else { user() };
        self.svc
            .update_checklist_batch(&p, &self.target(session), req)
    }

    fn vac_as(
        &self,
        session: Option<&str>,
        req: VerifyAndComplete,
    ) -> Result<Written, DomainError> {
        let p = if session.is_some() { agent() } else { user() };
        self.svc.verify_and_complete(&p, &self.target(session), req)
    }

    fn checklist_col(&self, id: &str, column: &str) -> Value {
        self.scalar(&format!(
            "SELECT {column} FROM checklist_items WHERE project_id = 'PA' AND id = '{id}'"
        ))
    }

    /// 项目里 seq > after 的全部事件类型。
    fn events_after(&self, after: i64) -> Vec<String> {
        self.svc
            .store()
            .read(|tx| {
                tx.prepare(
                    "SELECT type FROM events WHERE project_id = 'PA' AND seq > ?1 ORDER BY seq",
                )?
                .query_map([after], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()
            })
            .unwrap()
    }

    fn last_seq(&self) -> i64 {
        self.count("SELECT COALESCE(MAX(seq), 0) FROM events WHERE project_id = 'PA'")
    }
}

// ================= verify_and_complete（W-052）=================

/// W-052 正例：IN_PROGRESS → DONE，两次转换、两条事件，版本 +2。
#[test]
fn w052_from_in_progress_two_transitions() {
    let w = world("vac-two");
    let k = w.task("A");
    w.s1(p(&k, Operation::Start)).unwrap();
    assert_eq!(w.version(&k), 2);
    let r = w.vac_as(Some("S1"), vac(&k, Some(2))).unwrap();
    assert_eq!(r.result["fromStatus"], "IN_PROGRESS");
    assert_eq!(r.result["status"], "DONE");
    assert_eq!(r.result["fromVersion"], 2);
    assert_eq!(r.result["taskVersion"], 4);
    assert_eq!(r.result["transitions"], json!(["VERIFYING", "DONE"]));
    assert_eq!(r.result["item"]["status"], "DONE");
    assert_eq!(
        w.events(&k),
        [
            "work.created",
            "work.started",
            "work.verification_requested",
            "work.completed"
        ]
    );
    let completed = w.scalar(
        "SELECT payload_json FROM events WHERE project_id = 'PA' AND type = 'work.completed'",
    );
    let payload: Value = serde_json::from_str(completed.as_str().unwrap()).unwrap();
    assert_eq!(payload["composite"], true);
    assert_eq!(payload["operation"], "verify_and_complete");
    assert!(payload["verificationSequence"].is_i64());
    assert_eq!(w.col(&k, "claimed_by_session_id"), Value::Null, "C-03");
    assert_eq!(w.session("S1", "work_state"), "IDLE");
}

/// W-052：从 VERIFYING 起步只做一次转换。
#[test]
fn w052_from_verifying_one_transition() {
    let w = world("vac-one");
    let k = w.task("A");
    w.s1(p(&k, Operation::Start)).unwrap();
    w.s1(p(&k, Operation::Verify)).unwrap();
    let r = w.vac_as(Some("S1"), vac(&k, Some(3))).unwrap();
    assert_eq!(r.result["transitions"], json!(["DONE"]));
    assert_eq!(r.result["taskVersion"], 4);
    assert_eq!(w.events(&k).last().unwrap(), "work.completed");
    assert_eq!(
        w.events(&k)
            .iter()
            .filter(|e| *e == "work.verification_requested")
            .count(),
        1
    );
}

/// W-052 反例 + W-062：门不过整事务回滚，不留 VERIFYING、事件、会话改动。
#[test]
fn w052_w062_gate_failure_commits_nothing() {
    let w = world("vac-gate");
    let (k, _) = task_with(&w, "A", &[("还没做", false)]);
    w.s1(p(&k, Operation::Start)).unwrap();
    let session_version = w.session("S1", "version");
    let e = w.refused(ErrorCode::COMPLETION_GATE_FAILED, || {
        w.vac_as(Some("S1"), vac(&k, Some(2)))
    });
    assert_eq!(e.details["reasons"][0]["code"], "CHECKLIST_INCOMPLETE");
    assert_eq!(w.col(&k, "status"), "IN_PROGRESS");
    assert_eq!(w.version(&k), 2);
    assert!(
        !w.events(&k)
            .contains(&"work.verification_requested".to_owned())
    );
    assert_eq!(w.session("S1", "version"), session_version);
}

/// W-052 反例：BLOCKED 上执行 → INVALID_TRANSITION(operation verify)，附「先 start」。
#[test]
fn w052_blocked_is_an_invalid_verify() {
    let w = world("vac-blocked");
    let k = w.task("A");
    w.s1(block(&k, "等 CI")).unwrap();
    let v = w.version(&k);
    let e = w.refused(ErrorCode::INVALID_TRANSITION, || {
        w.vac_as(Some("S1"), vac(&k, Some(v)))
    });
    assert_eq!(e.details["operation"], "verify");
    assert_eq!(e.details["next"]["operation"], "start");
}

/// R11 P1-1：READY 上自动补 start；owner 路径不用带版本。
#[test]
fn r11_verify_and_complete_auto_starts_without_a_version() {
    let w = world("vac-auto");
    let k = w.task("A");
    let r = w.vac_as(Some("S1"), vac(&k, None)).unwrap();
    assert_eq!(r.result["fromStatus"], "READY");
    assert_eq!(r.result["autoApplied"][0]["operations"], json!(["start"]));
    assert_eq!(r.result["transitions"], json!(["VERIFYING", "DONE"]));
    assert_eq!(r.result["taskVersion"], 4);
    assert_eq!(
        w.events(&k),
        [
            "work.created",
            "work.started",
            "work.verification_requested",
            "work.completed"
        ]
    );
    // User 不是 owner：要版本；版本不对是 VERSION_CONFLICT。
    let k2 = w.task("B");
    let e = w.refused(ErrorCode::EXPECTED_VERSION_REQUIRED, || {
        w.vac_as(None, vac(&k2, None))
    });
    assert_eq!(e.details["current_version"], 1);
    w.refused(ErrorCode::VERSION_CONFLICT, || {
        w.vac_as(None, vac(&k2, Some(9)))
    });
}

/// R1：他人持有有效领取时 verify_and_complete 被拒，整库零变化。
#[test]
fn r1_verify_and_complete_on_another_claim_is_refused() {
    let w = world("vac-r1");
    let k = w.task("A");
    w.s1(p(&k, Operation::Start)).unwrap();
    let e = w.refused(ErrorCode::CLAIM_NOT_OWNED, || {
        w.vac_as(Some("SX"), vac(&k, Some(2)))
    });
    assert_eq!(e.details["claimed_by_session_id"], "S1");
    // 同一 lineage 的后继可以（R2）。
    w.vac_as(Some("S2"), vac(&k, Some(2))).unwrap();
}

/// W-063：原样重试得到首次回执、不加事件；同 op_id 换目标 → IDEMPOTENCY_CONFLICT。
#[test]
fn w063_verify_and_complete_replays() {
    let w = world("vac-replay");
    let k = w.task("A");
    let k2 = w.task("B");
    let t = Target::new("PA", Some("S1"), "vac-op");
    let first = w
        .svc
        .verify_and_complete(&agent(), &t, vac(&k, None))
        .unwrap();
    let before = w.snapshot();
    let again = w
        .svc
        .verify_and_complete(&agent(), &t, vac(&k, None))
        .unwrap();
    assert!(again.replayed);
    assert_eq!(again.result, first.result);
    assert_eq!(w.snapshot(), before);
    w.refused(ErrorCode::IDEMPOTENCY_CONFLICT, || {
        w.svc.verify_and_complete(&agent(), &t, vac(&k2, None))
    });
}

// ================= checklist_single（W-053、W-055、W-056）=================

/// W-053 正例 + W-056：检查项 v0→v1，任务版本 +1，回执给出新的 taskVersion，可直接拿去 complete。
#[test]
fn w053_w056_single_bumps_the_task_version() {
    let w = world("cl-single");
    let (k, ids) = task_with(&w, "A", &[("跑测试", true)]);
    w.s1(p(&k, Operation::Start)).unwrap();
    let before_seq = w.last_seq();
    let r = w
        .checklist_as(
            Some("S1"),
            ChecklistSingle {
                evidence: Some(vec![ev(EvidenceKind::TestResult, " 186 passed ")]),
                ..single(Some(&k), &ids[0], Some(0), ChecklistStatus::Done)
            },
        )
        .unwrap();
    assert_eq!(r.result["checklist"]["version"], 1);
    assert_eq!(r.result["checklist"]["status"], "DONE");
    assert_eq!(
        r.result["checklist"]["evidence"],
        json!([{ "kind": "test_result", "value": "186 passed" }])
    );
    assert_eq!(r.result["taskVersion"], 3);
    assert_eq!(w.version(&k), 3);
    assert!(w.col(&k, "last_evidence_at").is_string());
    assert_eq!(w.events_after(before_seq), ["checklist.updated"]);
    let aggregate = w.scalar(&format!(
        "SELECT aggregate_type FROM events WHERE project_id = 'PA' AND seq = {}",
        before_seq + 1
    ));
    assert_eq!(aggregate, "CHECKLIST");
    // W-056：拿旧任务版本 complete 会冲突，拿回执里的 taskVersion 成功。
    w.refused(ErrorCode::VERSION_CONFLICT, || {
        w.s1(p(&k, Operation::Complete).version(2))
    });
    w.s1(p(&k, Operation::Complete).version(3)).unwrap();
}

/// W-051 / W-053 第 4 步：传了任务版本 → VERSION_CONFLICT 带 TASK_VERSION_PASSED。
#[test]
fn w053_task_version_passed_hint() {
    let w = world("cl-hint");
    let (k, ids) = task_with(&w, "A", &[("一项", false)]);
    w.s1(p(&k, Operation::Start)).unwrap();
    let e = w.refused(ErrorCode::VERSION_CONFLICT, || {
        w.checklist_as(
            Some("S1"),
            single(Some(&k), &ids[0], Some(2), ChecklistStatus::Done),
        )
    });
    assert_eq!(e.details["entity"], "CHECKLIST");
    assert_eq!(e.details["hint"], "TASK_VERSION_PASSED");
    assert_eq!(e.details["checklist_version"], 0);
    assert_eq!(e.details["next"]["expected_checklist_version"], 0);
}

/// W-053 第 2、3 步：不存在 → CHECKLIST_NOT_FOUND；属于别的任务 → CHECKLIST_TASK_MISMATCH（先于版本）。
#[test]
fn w053_ownership_is_checked_before_the_version() {
    let w = world("cl-mismatch");
    let (_, ids) = task_with(&w, "A", &[("一项", false)]);
    let other = w.task("B");
    let e = w.refused(ErrorCode::CHECKLIST_TASK_MISMATCH, || {
        w.checklist_as(
            None,
            single(Some(&other), &ids[0], Some(99), ChecklistStatus::Done),
        )
    });
    assert_eq!(e.details["expected_task"], other);
    assert_eq!(e.details["actual_task"], "ATM-T-0001");
    w.refused(ErrorCode::CHECKLIST_NOT_FOUND, || {
        w.checklist_as(None, single(None, "NOPE", Some(0), ChecklistStatus::Done))
    });
}

/// W-053 第 5 步 + W-055：必证项看决议后的证据；不传保留，`[]` 清空，非空替换。
#[test]
fn w055_evidence_retention_and_requirement() {
    let w = world("cl-evidence");
    let (k, ids) = task_with(&w, "A", &[("必证", true)]);
    let id = &ids[0];
    let e = w.refused(ErrorCode::COMPLETION_GATE_FAILED, || {
        w.checklist_as(None, single(Some(&k), id, Some(0), ChecklistStatus::Done))
    });
    assert_eq!(
        e.details["reasons"],
        json!([{ "checklist_id": id, "code": "EVIDENCE_REQUIRED" }])
    );
    // 先在 DOING 上放证据。
    w.checklist_as(
        None,
        ChecklistSingle {
            evidence: Some(vec![Evidence::Text("docs/report.md".into())]),
            ..single(Some(&k), id, Some(0), ChecklistStatus::Doing)
        },
    )
    .unwrap();
    // `[]` + DONE：决议后为空 → 拒绝。
    w.refused(ErrorCode::COMPLETION_GATE_FAILED, || {
        w.checklist_as(
            None,
            ChecklistSingle {
                evidence: Some(Vec::new()),
                ..single(Some(&k), id, Some(1), ChecklistStatus::Done)
            },
        )
    });
    // 不传：保留原证据，通过。
    w.checklist_as(None, single(Some(&k), id, Some(1), ChecklistStatus::Done))
        .unwrap();
    assert_eq!(w.checklist_col(id, "evidence_json"), "[\"docs/report.md\"]");
    // `[]` + TODO：清空。
    w.checklist_as(
        None,
        ChecklistSingle {
            evidence: Some(Vec::new()),
            ..single(Some(&k), id, Some(2), ChecklistStatus::Todo)
        },
    )
    .unwrap();
    assert_eq!(w.checklist_col(id, "evidence_json"), "[]");
}

/// 00 C-27：终态任务的检查项只读。
#[test]
fn c27_terminal_task_checklist_is_read_only() {
    let w = world("cl-terminal");
    let (k, ids) = task_with(&w, "A", &[("一项", false)]);
    w.checklist_as(
        None,
        single(Some(&k), &ids[0], Some(0), ChecklistStatus::Skipped),
    )
    .unwrap();
    w.s1(p(&k, Operation::Complete)).unwrap();
    let e = w.refused(ErrorCode::WORK_ITEM_TERMINAL, || {
        w.checklist_as(
            None,
            single(Some(&k), &ids[0], Some(1), ChecklistStatus::Done),
        )
    });
    assert_eq!(e.details["next"]["operation"], "reopen");
    w.refused(ErrorCode::WORK_ITEM_TERMINAL, || {
        w.batch_as(
            None,
            ChecklistBatch {
                task_key: k.clone(),
                expected_version: Some(w.version(&k)),
                items: vec![change(&ids[0], ChecklistStatus::Done, None)],
            },
        )
    });
}

/// 00 C-12：旧参数名照样接受，回执里给弃用提示。
#[test]
fn c12_the_old_parameter_name_is_accepted_with_a_hint() {
    let w = world("cl-c12");
    let (k, ids) = task_with(&w, "A", &[("一项", false)]);
    let r = w
        .checklist_as(
            None,
            ChecklistSingle {
                legacy_version_name: true,
                ..single(Some(&k), &ids[0], Some(0), ChecklistStatus::Done)
            },
        )
        .unwrap();
    assert_eq!(r.result["deprecations"][0]["field"], "expected_version");
    assert_eq!(
        r.result["deprecations"][0]["use"],
        "expected_checklist_version"
    );
}

/// R1 + R11 P1-1 第 2 条：他人领取中被拒；owner 路径不用版本；User 不受领取约束但要版本。
#[test]
fn r1_p1_1_checklist_ownership_and_optional_version() {
    let w = world("cl-r1");
    let (k, ids) = task_with(&w, "A", &[("一", false), ("二", false)]);
    w.s1(p(&k, Operation::Start)).unwrap();
    let e = w.refused(ErrorCode::CLAIM_NOT_OWNED, || {
        w.checklist_as(
            Some("SX"),
            single(Some(&k), &ids[0], Some(0), ChecklistStatus::Done),
        )
    });
    assert_eq!(e.details["claimed_by_session_id"], "S1");
    w.refused(ErrorCode::CLAIM_NOT_OWNED, || {
        w.batch_as(
            Some("SX"),
            ChecklistBatch {
                task_key: k.clone(),
                expected_version: Some(2),
                items: vec![change(&ids[0], ChecklistStatus::Done, None)],
            },
        )
    });
    // owner（S2 与 S1 同一 lineage）不带版本。
    w.checklist_as(
        Some("S2"),
        single(Some(&k), &ids[0], None, ChecklistStatus::Done),
    )
    .unwrap();
    assert_eq!(w.col(&k, "claimed_by_session_id"), "S2", "R2 transfer");
    // User：不受领取约束，但要版本。
    let e = w.refused(ErrorCode::EXPECTED_VERSION_REQUIRED, || {
        w.checklist_as(None, single(Some(&k), &ids[1], None, ChecklistStatus::Done))
    });
    assert_eq!(e.details["current_version"], 0);
    w.checklist_as(
        None,
        single(Some(&k), &ids[1], Some(0), ChecklistStatus::Done),
    )
    .unwrap();
}

/// W-012：atm_task / atm_record 引用改写成规范 key；找不到就拒绝，零写入。
#[test]
fn w012_evidence_references_are_normalized() {
    let w = world("cl-w012");
    let (k, ids) = task_with(&w, "A", &[("一", false), ("二", false)]);
    w.exec(&format!(
        "INSERT INTO records (project_id, id, local_no, kind, title, summary, importance, status, actor, created_at, updated_at)
         VALUES ('PA', 'REC7', 7, 'DECISION', '决定', '摘要', 'NORMAL', 'ACTIVE', 'claude', '{T0}', '{T0}')"
    ));
    let r = w
        .checklist_as(
            None,
            ChecklistSingle {
                evidence: Some(vec![
                    ev(EvidenceKind::AtmTask, " atm-t-1 "),
                    ev(EvidenceKind::AtmRecord, "ATM-D-0007"),
                    ev(EvidenceKind::File, "C:/不存在.txt"),
                ]),
                ..single(Some(&k), &ids[0], Some(0), ChecklistStatus::Done)
            },
        )
        .unwrap();
    assert_eq!(
        r.result["checklist"]["evidence"],
        json!([
            { "kind": "atm_task", "value": "ATM-T-0001" },
            { "kind": "atm_record", "value": "ATM-D-007" },
            { "kind": "file", "value": "C:/不存在.txt" },
        ])
    );
    w.refused(ErrorCode::RECORD_NOT_FOUND, || {
        w.checklist_as(
            None,
            ChecklistSingle {
                evidence: Some(vec![ev(EvidenceKind::AtmRecord, "ATM-R-007")]),
                ..single(Some(&k), &ids[1], Some(0), ChecklistStatus::Done)
            },
        )
    });
    w.refused(ErrorCode::WORK_ITEM_NOT_FOUND, || {
        w.checklist_as(
            None,
            ChecklistSingle {
                evidence: Some(vec![ev(EvidenceKind::AtmTask, "OTH-T-0001")]),
                ..single(Some(&k), &ids[1], Some(0), ChecklistStatus::Done)
            },
        )
    });
}

/// 02 §3.3 兼容请求：带 taskKey 的请求能重放不带 taskKey 的 2.x 旧回执，但重放前仍校验归属。
#[test]
fn w063_checklist_compat_replay_checks_ownership_first() {
    let w = world("cl-compat");
    let (k, ids) = task_with(&w, "A", &[("一", false)]);
    let other = w.task("B");
    let legacy = JsValue::object([
        ("checklistId", JsValue::str(ids[0].as_str())),
        ("expectedVersion", JsValue::Number(0.0)),
        ("status", JsValue::str("DONE")),
    ]);
    let fingerprint = fp::kernel_v1(&legacy).unwrap();
    w.svc
        .store()
        .write(move |tx| {
            tx.execute(
                "INSERT INTO idempotency_receipts (scope_kind, scope_id, ns_kind, ns_id, op_id, legacy_key, legacy_class,
                     actor_session_id, operation, fp_v, fp_family, fingerprint, receipt_json, scope_generation, created_at)
                 VALUES ('PROJECT', 'PA', 'SESSION', 'S1', 'cl-old', 'S1:cl-old', 'AGENT', 'S1', 'checklist.update', 1,
                         'kernel-v1', ?1, '{\"sequence\":9}', 1, ?2)",
                params![fingerprint, T0],
            )
        })
        .map_err(|e| format!("{e:?}"))
        .unwrap();
    let t = Target::new("PA", Some("S1"), "cl-old");
    // 给错任务：旧形状指纹对得上，但重放前的归属校验拦下来。
    w.refused(ErrorCode::CHECKLIST_TASK_MISMATCH, || {
        w.svc.update_checklist(
            &agent(),
            &t,
            single(Some(&other), &ids[0], Some(0), ChecklistStatus::Done),
        )
    });
    let before = w.snapshot();
    let r = w
        .svc
        .update_checklist(
            &agent(),
            &t,
            single(Some(&k), &ids[0], Some(0), ChecklistStatus::Done),
        )
        .unwrap();
    assert!(r.replayed);
    assert_eq!(r.result["sequence"], 9);
    assert_eq!(w.snapshot(), before);
    // 不同请求（状态不同）→ IDEMPOTENCY_CONFLICT。
    w.refused(ErrorCode::IDEMPOTENCY_CONFLICT, || {
        w.svc.update_checklist(
            &agent(),
            &t,
            single(Some(&k), &ids[0], Some(0), ChecklistStatus::Skipped),
        )
    });
}

// ================= checklist_batch（W-054）=================

/// W-054 正例：逐条 +1，任务只 +1，一条事件。不比较各检查项自己的版本（它们是 0，任务是 2）。
#[test]
fn w054_batch_bumps_the_task_once() {
    let w = world("cl-batch");
    let (k, ids) = task_with(&w, "A", &[("一", true), ("二", false), ("三", false)]);
    w.s1(p(&k, Operation::Start)).unwrap();
    let before_seq = w.last_seq();
    let r = w
        .batch_as(
            None,
            ChecklistBatch {
                task_key: k.to_lowercase(),
                expected_version: Some(2),
                items: vec![
                    change(
                        &ids[0],
                        ChecklistStatus::Done,
                        Some(vec![ev(EvidenceKind::GitSha, "abc1234")]),
                    ),
                    change(&ids[1], ChecklistStatus::Skipped, None),
                ],
            },
        )
        .unwrap();
    assert_eq!(r.result["taskKey"], k);
    assert_eq!(r.result["updatedCount"], 2);
    assert_eq!(r.result["taskVersion"], 3);
    assert_eq!(r.result["checklist"][0]["version"], 1);
    assert_eq!(r.result["checklist"][1]["version"], 1);
    assert_eq!(w.checklist_col(&ids[2], "version"), 0);
    assert_eq!(w.events_after(before_seq), ["checklist.batch_updated"]);
    assert!(w.col(&k, "last_evidence_at").is_string());
    // 进度：三项里一项 DONE、一项 SKIPPED（排除）→ 50。
    assert_eq!(r.result["taskProgress"], 50.0);
}

/// W-054 反例 + 00 C-10：版本过期 + 不存在 + 缺证据，一次给出三条原因，全部不写。
#[test]
fn w054_c10_all_reasons_at_once() {
    let w = world("cl-batch-reasons");
    let (k, ids) = task_with(&w, "A", &[("必证", true), ("二", false)]);
    let e = w.refused(ErrorCode::COMPLETION_GATE_FAILED, || {
        w.batch_as(
            None,
            ChecklistBatch {
                task_key: k.clone(),
                expected_version: Some(7),
                items: vec![
                    change("NOPE", ChecklistStatus::Done, None),
                    change(&ids[0], ChecklistStatus::Done, None),
                    change(&ids[1], ChecklistStatus::Done, None),
                ],
            },
        )
    });
    assert_eq!(
        e.details["reasons"],
        json!([
            { "code": "VERSION_CONFLICT", "task_key": k, "expected": 7, "actual": 1 },
            { "code": "NOT_FOUND", "checklist_id": "NOPE" },
            { "code": "EVIDENCE_REQUIRED", "checklist_id": ids[0] },
        ])
    );
    assert!(e.message.contains("全部未写入"));
}

/// 00 C-10：只有版本问题时是 VERSION_CONFLICT（可重试）；传了检查项版本时给 CHECKLIST_VERSION_PASSED。
#[test]
fn w054_c10_version_only_is_a_version_conflict() {
    let w = world("cl-batch-version");
    let (k, ids) = task_with(&w, "A", &[("一", false)]);
    w.s1(p(&k, Operation::Start)).unwrap();
    let e = w.refused(ErrorCode::VERSION_CONFLICT, || {
        w.batch_as(
            None,
            ChecklistBatch {
                task_key: k.clone(),
                expected_version: Some(0),
                items: vec![change(&ids[0], ChecklistStatus::Done, None)],
            },
        )
    });
    assert!(e.code.retryable());
    assert_eq!(e.details["reasons"][0]["hint"], "CHECKLIST_VERSION_PASSED");
    assert_eq!(e.details["hint"], "CHECKLIST_VERSION_PASSED");
    assert_eq!(e.details["current_version"], 2);
}

/// W-054 第 1 步：重复的检查项 id → VALIDATION_ERROR。
#[test]
fn w054_duplicate_ids_are_refused() {
    let w = world("cl-batch-dup");
    let (k, ids) = task_with(&w, "A", &[("一", false)]);
    let e = w.refused(ErrorCode::VALIDATION_ERROR, || {
        w.batch_as(
            None,
            ChecklistBatch {
                task_key: k.clone(),
                expected_version: Some(1),
                items: vec![
                    change(&ids[0], ChecklistStatus::Done, None),
                    change(&ids[0], ChecklistStatus::Skipped, None),
                ],
            },
        )
    });
    assert_eq!(e.details["issue"], "duplicate_checklist_id");
}

// ================= complete 一步写全（R11 P1-1 第 4 条）=================

/// 同一事务：自动 start → 检查项（序号 / 标题）→ 门 → 进度 note + 证据 → DONE。
#[test]
fn p1_1_4_complete_writes_checklist_note_and_evidence() {
    let w = world("complete-all");
    let (k, ids) = task_with(&w, "A", &[("跑测试", true), ("写文档", false)]);
    let r = w
        .s1(PatchItem {
            note: Some(" 全部完成 ".into()),
            evidence: Some(vec![ev(EvidenceKind::TestResult, "42 passed")]),
            checklist: Some(vec![
                CompleteChecklist {
                    item: ChecklistRef::Index(1),
                    status: ChecklistStatus::Done,
                    evidence: Some(vec![ev(EvidenceKind::TestResult, "42 passed")]),
                },
                CompleteChecklist {
                    item: ChecklistRef::Text(" 写文档 ".into()),
                    status: ChecklistStatus::Skipped,
                    evidence: None,
                },
            ]),
            ..p(&k, Operation::Complete)
        })
        .unwrap();
    assert_eq!(r.result["items"][0]["status"], "DONE");
    // create 1 → start 2 → 检查项 3 → complete 4。
    assert_eq!(r.result["items"][0]["version"], 4);
    assert_eq!(
        w.events(&k),
        [
            "work.created",
            "work.started",
            "checklist.batch_updated",
            "work.progressed",
            "work.completed"
        ]
    );
    assert_eq!(w.checklist_col(&ids[0], "status"), "DONE");
    assert_eq!(w.checklist_col(&ids[1], "status"), "SKIPPED");
    assert_eq!(
        w.scalar("SELECT summary FROM progress_updates WHERE project_id = 'PA'"),
        "全部完成"
    );
    assert_eq!(
        w.scalar("SELECT evidence_json FROM progress_updates WHERE project_id = 'PA'"),
        "[{\"kind\":\"test_result\",\"value\":\"42 passed\"}]"
    );
    assert!(w.col(&k, "last_evidence_at").is_string());
}

/// 失败整体回滚：引用不到的检查项、或写完检查项仍过不了门，连自动 start 都不留。
#[test]
fn p1_1_4_complete_checklist_failures_roll_back() {
    let w = world("complete-all-fail");
    let (k, _) = task_with(&w, "A", &[("一", false), ("二", false)]);
    let one = |item: ChecklistRef| CompleteChecklist {
        item,
        status: ChecklistStatus::Done,
        evidence: None,
    };
    let e = w.refused(ErrorCode::COMPLETION_GATE_FAILED, || {
        w.s1(PatchItem {
            checklist: Some(vec![one(ChecklistRef::Index(3))]),
            ..p(&k, Operation::Complete)
        })
    });
    assert_eq!(e.details["reasons"][0]["code"], "NOT_FOUND");
    assert_eq!(e.details["reasons"][0]["checklist_id"], "#3");
    let e = w.refused(ErrorCode::COMPLETION_GATE_FAILED, || {
        w.s1(PatchItem {
            checklist: Some(vec![one(ChecklistRef::Index(1))]),
            ..p(&k, Operation::Complete)
        })
    });
    assert_eq!(e.details["reasons"][0]["code"], "CHECKLIST_INCOMPLETE");
    assert_eq!(w.col(&k, "status"), "READY");
    // note 只能跟 complete。
    w.refused(ErrorCode::INVALID_ARGUMENT, || {
        w.s1(PatchItem {
            note: Some("x".into()),
            ..p(&k, Operation::Start)
        })
    });
}

// ================= review（W-057～W-061）=================

struct Review {
    parent: String,
    checklist: String,
    review: String,
}

/// S1 建被审任务 P（检查项 C）与它下面的 REVIEW 任务 R。
fn review_setup(w: &World) -> Review {
    let r = w
        .create_as(
            &agent(),
            Some("S1"),
            vec![
                CreateItem {
                    checklist: vec![checklist("独立评审", false)],
                    ..item("被审任务")
                },
                CreateItem {
                    parent_ref: Some("1".into()),
                    kind: Some("REVIEW".into()),
                    ..item("评审")
                },
            ],
        )
        .unwrap();
    let parent = r.result["items"][0]["key"].as_str().unwrap().to_owned();
    Review {
        checklist: r.result["checklist"][&parent][0]
            .as_str()
            .unwrap()
            .to_owned(),
        review: r.result["items"][1]["key"].as_str().unwrap().to_owned(),
        parent,
    }
}

fn hashes(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs
        .iter()
        .map(|(n, v)| ((*n).to_owned(), (*v).to_owned()))
        .collect()
}

impl World {
    fn request_as(
        &self,
        session: &str,
        s: &Review,
        rv: i64,
        cv: i64,
    ) -> Result<Written, DomainError> {
        self.svc.request_review(
            &agent(),
            &self.target(Some(session)),
            ReviewRequest {
                review_task_key: s.review.clone(),
                expected_review_task_version: Some(rv),
                parent_checklist_id: s.checklist.clone(),
                expected_parent_checklist_version: cv,
                candidate_hashes: hashes(&[("Source", " ABCDEF1 ")]),
            },
        )
    }

    fn submit_as(&self, session: &str, req: ReviewSubmit) -> Result<Written, DomainError> {
        self.svc
            .submit_review(&agent(), &self.target(Some(session)), req)
    }

    fn start_as(&self, session: &str, key: &str) {
        self.patch_as(&agent(), Some(session), vec![p(key, Operation::Start)])
            .unwrap();
    }
}

fn submission(s: &Review, version: i64, verdict: Verdict) -> ReviewSubmit {
    ReviewSubmit {
        request_key: "ATM-RR-0001".into(),
        review_task_key: Some(s.review.clone()),
        expected_review_task_version: Some(version),
        verdict,
        reviewed_hashes: hashes(&[("source", "abcdef1")]),
        evidence: vec![ev(EvidenceKind::TestResult, "评审通过")],
    }
}

/// W-057 正例：绑定检查项当前版本与规范化哈希，不改 Review 任务与检查项。
#[test]
fn w057_request_binds_without_touching_anything() {
    let w = world("rv-request");
    let s = review_setup(&w);
    assert_eq!(w.version(&s.review), 1);
    let r = w.request_as("S1", &s, 1, 0).unwrap();
    let req = &r.result["request"];
    assert_eq!(req["key"], "ATM-RR-0001");
    assert_eq!(req["reviewTaskKey"], s.review);
    assert_eq!(req["parentTaskKey"], s.parent);
    assert_eq!(req["parentChecklistVersion"], 0);
    assert_eq!(
        req["expectedCandidateHashes"],
        json!([{ "name": "source", "value": "abcdef1" }])
    );
    assert_eq!(req["submission"], Value::Null);
    assert_eq!(w.version(&s.review), 1);
    assert_eq!(w.checklist_col(&s.checklist, "version"), 0);
    assert_eq!(
        w.scalar("SELECT aggregate_type FROM events WHERE project_id = 'PA' AND type = 'review.requested'"),
        "REVIEW_REQUEST"
    );
}

/// W-057 反例：每一步都零写入、不消耗 review_request 计数器（快照包含 counters）。
#[test]
fn w057_request_refusals() {
    let w = world("rv-request-no");
    let s = review_setup(&w);
    let not_review = Review {
        review: s.parent.clone(),
        ..review_setup(&w)
    };
    w.refused(ErrorCode::REVIEW_TASK_INVALID, || {
        w.request_as("S1", &not_review, 1, 0)
    });
    w.refused(ErrorCode::VERSION_CONFLICT, || w.request_as("S1", &s, 5, 0));
    let e = w.refused(ErrorCode::VERSION_CONFLICT, || w.request_as("S1", &s, 1, 3));
    assert_eq!(e.details["entity"], "CHECKLIST");
    // R 的父不是 C 所在的任务。
    let other = review_setup(&w);
    let crossed = Review {
        checklist: other.checklist.clone(),
        ..Review {
            parent: s.parent.clone(),
            checklist: String::new(),
            review: s.review.clone(),
        }
    };
    w.refused(ErrorCode::REVIEW_BINDING_MISMATCH, || {
        w.request_as("S1", &crossed, 1, 0)
    });
    // 没有 session 的 Agent 在流水线就被拦下。
    w.refused(ErrorCode::SESSION_REQUIRED, || {
        w.svc.request_review(
            &agent(),
            &w.target(None),
            ReviewRequest {
                review_task_key: s.review.clone(),
                expected_review_task_version: Some(1),
                parent_checklist_id: s.checklist.clone(),
                expected_parent_checklist_version: 0,
                candidate_hashes: hashes(&[("source", "abcdef1")]),
            },
        )
    });
    // 哈希格式（W-010）。
    w.refused(ErrorCode::INVALID_ARGUMENT, || {
        w.svc.request_review(
            &agent(),
            &w.target(Some("S1")),
            ReviewRequest {
                review_task_key: s.review.clone(),
                expected_review_task_version: Some(1),
                parent_checklist_id: s.checklist.clone(),
                expected_parent_checklist_version: 0,
                candidate_hashes: hashes(&[("git", "abc"), ("Git", "abcdef1")]),
            },
        )
    });
    // 第二次发起 → CONFLICT；检查项已 SKIPPED → CHECKLIST_CLOSED。
    w.request_as("S1", &s, 1, 0).unwrap();
    w.refused(ErrorCode::REVIEW_REQUEST_CONFLICT, || {
        w.request_as("S1", &s, 1, 0)
    });
    let t = review_setup(&w);
    w.checklist_as(
        None,
        single(None, &t.checklist, Some(0), ChecklistStatus::Skipped),
    )
    .unwrap();
    w.refused(ErrorCode::REVIEW_CHECKLIST_CLOSED, || {
        w.request_as("S1", &t, 1, 1)
    });
    assert_eq!(
        w.count(
            "SELECT next_value FROM counters WHERE project_id = 'PA' AND name = 'review_request'"
        ),
        2
    );
}

/// W-058～W-060 APPROVED：VERIFICATION 记录、父检查项 DONE（证据 = 提交证据）、Review 任务 DONE、提交行，
/// 事件依次 record.created、checklist.updated、work.completed、review.submitted。父任务被 S1 领取着，
/// reviewer 照样能改它的检查项（R1 的唯一例外，阳性对照）。
#[test]
fn w060_approved_submission() {
    let w = world("rv-approved");
    let s = review_setup(&w);
    w.start_as("S1", &s.parent);
    w.request_as("S1", &s, 1, 0).unwrap();
    w.start_as("RV", &s.review);
    let parent_version = w.version(&s.parent);
    let before_seq = w.last_seq();
    let r = w
        .submit_as("RV", submission(&s, 2, Verdict::Approved))
        .unwrap();
    assert_eq!(
        w.events_after(before_seq),
        [
            "record.created",
            "checklist.updated",
            "work.completed",
            "review.submitted"
        ]
    );
    assert_eq!(r.result["requestKey"], "ATM-RR-0001");
    assert_eq!(r.result["submissionKey"], "ATM-RS-0001");
    assert_eq!(r.result["recordKey"], "ATM-R-001");
    assert_eq!(r.result["verdict"], "APPROVED");
    assert_eq!(
        r.result["reviewTask"],
        json!({ "key": s.review, "status": "DONE", "version": 3 })
    );
    assert_eq!(
        r.result["parentChecklist"],
        json!({ "id": s.checklist, "status": "DONE", "version": 1 })
    );
    assert_eq!(
        r.result["parentTask"]["status"], "IN_PROGRESS",
        "never auto-completed"
    );
    assert_eq!(r.result["parentTask"]["version"], parent_version + 1);
    assert_eq!(
        w.checklist_col(&s.checklist, "evidence_json"),
        "[{\"kind\":\"test_result\",\"value\":\"评审通过\"}]"
    );
    assert_eq!(
        w.col(&s.review, "claimed_by_session_id"),
        Value::Null,
        "C-03"
    );
    assert_eq!(w.col(&s.parent, "claimed_by_session_id"), "S1");
    let record: (Value, Value, Value) = (
        w.scalar("SELECT kind FROM records WHERE project_id = 'PA'"),
        w.scalar("SELECT scope FROM records WHERE project_id = 'PA'"),
        w.scalar("SELECT detail FROM records WHERE project_id = 'PA'"),
    );
    assert_eq!(record.0, "VERIFICATION");
    assert_eq!(record.1, "REVIEW_AUDIT");
    assert!(
        record
            .2
            .as_str()
            .unwrap()
            .starts_with("{\n  \"requestKey\": \"ATM-RR-0001\",\n  \"submissionKey\"")
    );
    assert_eq!(
        w.scalar("SELECT review_task_version || '/' || parent_checklist_version FROM review_submissions WHERE project_id = 'PA'"),
        "3/1"
    );
}

/// W-060 CHANGES_REQUESTED：父检查项不动，Review 任务照样完成，请求被消耗；再交 → ALREADY_SUBMITTED。
#[test]
fn w060_changes_requested_leaves_the_checklist() {
    let w = world("rv-changes");
    let s = review_setup(&w);
    w.request_as("S1", &s, 1, 0).unwrap();
    w.start_as("RV", &s.review);
    let r = w
        .submit_as("RV", submission(&s, 2, Verdict::ChangesRequested))
        .unwrap();
    assert_eq!(
        r.result["parentChecklist"],
        json!({ "id": s.checklist, "status": "TODO", "version": 0 })
    );
    assert_eq!(w.col(&s.review, "status"), "DONE");
    assert_ne!(w.col(&s.parent, "status"), "DONE");
    assert!(w.col(&s.parent, "last_evidence_at").is_string());
    w.refused(ErrorCode::REVIEW_ALREADY_SUBMITTED, || {
        w.submit_as("RV", submission(&s, 3, Verdict::Approved))
    });
}

/// W-058 + 00 C-26 + R2：提交者身份。
#[test]
fn w058_c26_submitter_identity() {
    let w = world("rv-identity");
    let s = review_setup(&w);
    w.request_as("S1", &s, 1, 0).unwrap();
    let e = w.refused(ErrorCode::REVIEWER_REQUIRED, || {
        w.submit_as("SX", submission(&s, 1, Verdict::Approved))
    });
    assert_eq!(e.details["reason"], "ROLE_NOT_REVIEWER");
    assert_eq!(e.details["recovery"]["begin_arguments"]["role"], "REVIEWER");
    let e = w.refused(ErrorCode::REVIEWER_REQUIRED, || {
        w.submit_as("RZ", submission(&s, 1, Verdict::Approved))
    });
    assert_eq!(e.details["reason"], "SESSION_IDENTITY_INVALID");
    let e = w.refused(ErrorCode::REVIEW_IDENTITY_MISMATCH, || {
        w.submit_as("RV", submission(&s, 1, Verdict::Approved))
    });
    assert_eq!(e.details["reason"], "REVIEW_TASK_UNCLAIMED");
    w.start_as("RC", &s.review);
    let e = w.refused(ErrorCode::REVIEW_IDENTITY_MISMATCH, || {
        w.submit_as("RV", submission(&s, 2, Verdict::Approved))
    });
    assert_eq!(e.details["reason"], "REVIEW_TASK_CLAIMED_BY_OTHER_SESSION");
    assert_eq!(e.details["claimed_by_session_id"], "RC");
    // C-26：claude 发起的请求，claude 的 REVIEWER 不能提交。
    let e = w.refused(ErrorCode::REVIEW_SELF_NOT_ALLOWED, || {
        w.submit_as("RC", submission(&s, 2, Verdict::Approved))
    });
    assert_eq!(e.details["agent_id"], "claude");
}

/// R2：领取属于 lineage，后继 REVIEWER session 可以直接提交。
#[test]
fn r2_a_reviewer_successor_may_submit() {
    let w = world("rv-successor");
    let s = review_setup(&w);
    w.request_as("S1", &s, 1, 0).unwrap();
    w.start_as("RV", &s.review);
    let r = w
        .submit_as("RV2", submission(&s, 2, Verdict::Approved))
        .unwrap();
    assert_eq!(r.result["reviewTask"]["status"], "DONE");
}

/// W-059 第 7 步：哈希与绑定不等 → CANDIDATE_HASH_MISMATCH，details 按规定顺序，零写入。
#[test]
fn w059_candidate_hash_mismatch() {
    let w = world("rv-hash");
    let s = review_setup(&w);
    w.request_as("S1", &s, 1, 0).unwrap();
    w.start_as("RV", &s.review);
    let e = w.refused(ErrorCode::CANDIDATE_HASH_MISMATCH, || {
        w.submit_as(
            "RV",
            ReviewSubmit {
                reviewed_hashes: hashes(&[("source", "1234567"), ("tests", "abcdef0")]),
                ..submission(&s, 2, Verdict::Approved)
            },
        )
    });
    let order: Vec<&str> = e.details.keys().map(String::as_str).collect();
    assert_eq!(
        order,
        [
            "request_key",
            "missing",
            "extra",
            "mismatch",
            "request",
            "request_lookup",
            "bound",
            "submitted",
            "expected",
            "actual"
        ]
    );
    assert_eq!(e.details["extra"], json!(["tests"]));
    assert_eq!(
        e.details["mismatch"],
        json!([{ "name": "source", "bound": "abcdef1", "submitted": "1234567" }])
    );
    assert_eq!(
        e.details["request_lookup"]["path"],
        "/api/v1/projects/ATM/reviews/requests/ATM-RR-0001"
    );
}

/// W-059 第 9 步（D16）：请求之后父检查项被改过（哪怕改回原状态）→ VERSION_CONFLICT(CHECKLIST)。
#[test]
fn w059_d16_the_checklist_moved_after_the_request() {
    let w = world("rv-d16");
    let s = review_setup(&w);
    w.request_as("S1", &s, 1, 0).unwrap();
    w.checklist_as(
        None,
        single(None, &s.checklist, Some(0), ChecklistStatus::Doing),
    )
    .unwrap();
    w.checklist_as(
        None,
        single(None, &s.checklist, Some(1), ChecklistStatus::Todo),
    )
    .unwrap();
    w.start_as("RV", &s.review);
    let e = w.refused(ErrorCode::VERSION_CONFLICT, || {
        w.submit_as("RV", submission(&s, 2, Verdict::Approved))
    });
    assert_eq!(e.details["entity"], "CHECKLIST");
    assert_eq!(e.details["expected"], 0);
    assert_eq!(e.details["actual"], 2);
}

/// W-059 第 10 步 + W-062：Review 任务只 CLAIMED → 门不过；record / submission 计数器都不前进。
#[test]
fn w059_w062_the_review_task_must_pass_its_gate() {
    let w = world("rv-gate");
    let s = review_setup(&w);
    w.request_as("S1", &s, 1, 0).unwrap();
    w.patch_as(&agent(), Some("RV"), vec![p(&s.review, Operation::Claim)])
        .unwrap();
    let e = w.refused(ErrorCode::COMPLETION_GATE_FAILED, || {
        w.submit_as("RV", submission(&s, 2, Verdict::Approved))
    });
    assert_eq!(e.details["reasons"][0]["code"], "CURRENT_STATE_INVALID");
    assert_eq!(
        w.count("SELECT next_value FROM counters WHERE project_id = 'PA' AND name = 'record'"),
        1
    );
}

/// W-063：提交成功后原样重试 → 同一回执，不新增事件。
#[test]
fn w063_review_submit_replays() {
    let w = world("rv-replay");
    let s = review_setup(&w);
    w.request_as("S1", &s, 1, 0).unwrap();
    w.start_as("RV", &s.review);
    let t = Target::new("PA", Some("RV"), "submit-op");
    let first = w
        .svc
        .submit_review(&agent(), &t, submission(&s, 2, Verdict::Approved))
        .unwrap();
    let before = w.snapshot();
    let again = w
        .svc
        .submit_review(&agent(), &t, submission(&s, 2, Verdict::Approved))
        .unwrap();
    assert!(again.replayed);
    assert_eq!(again.result, first.result);
    assert_eq!(w.snapshot(), before);
}
