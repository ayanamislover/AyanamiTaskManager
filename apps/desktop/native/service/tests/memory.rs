//! 进度、记录与反馈的验收（W2e；02 §1.5–1.8、§5，S-080～S-086，00 02 C-02、C-13、C-23，10 R1、R2，R11 P2-1）。
//! 拒绝一律按整库逐表逐行快照核对零变化。

mod support;

use atm_domain::error::ErrorCode;
use atm_domain::evidence::{Evidence, EvidenceKind};
use atm_domain::work::Operation;
use atm_service::fp::{self, JsValue};
use atm_service::memory::{
    Completed, FeedbackRequest, ProgressRequest, ProgressScope, RecordRequest, SUMMARY_MAX, bucket,
};
use atm_service::work::Target;
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

fn project(summary: &str) -> ProgressRequest {
    ProgressRequest {
        scope: ProgressScope::Project,
        task_key: None,
        ..ProgressRequest::task("", summary)
    }
}

impl World {
    fn progress(
        &self,
        session: &str,
        req: ProgressRequest,
    ) -> Result<Written, atm_domain::error::DomainError> {
        self.svc
            .add_progress(&agent(), &self.target(Some(session)), req)
    }

    fn record(&self, req: RecordRequest) -> Result<Written, atm_domain::error::DomainError> {
        self.svc
            .create_record(&agent(), &self.target(Some("S1")), req)
    }

    /// S1 建任务并开工。
    fn started(&self, title: &str) -> String {
        let k = self.task(title);
        self.s1(p(&k, Operation::Start)).unwrap();
        k
    }

    fn progress_rows(&self) -> i64 {
        self.count("SELECT count(*) FROM progress_updates WHERE project_id = 'PA'")
    }

    fn last_event(&self) -> String {
        self.scalar("SELECT type FROM events WHERE project_id = 'PA' ORDER BY seq DESC LIMIT 1")
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn record_col(&self, no: i64, column: &str) -> Value {
        self.scalar(&format!(
            "SELECT {column} FROM records WHERE project_id = 'PA' AND local_no = {no}"
        ))
    }
}

// ================= 任务进度 =================

/// S-080：桶 = JS `Math.round(clamp(p)/10)*10`。
#[test]
fn s080_bucket() {
    for (p, b) in [
        (0.0, 0),
        (4.9, 0),
        (5.0, 10),
        (44.9, 40),
        (45.0, 50),
        (95.0, 100),
        (100.0, 100),
        (-3.0, 0),
        (120.0, 100),
    ] {
        assert_eq!(bucket(p), b, "{p}");
    }
}

/// S-080 + S-083 + 00 02 C-02 / C-23：写一条进度、版本 +1、事件、搜索文档；不带 percent 时保留 reported_progress。
#[test]
fn s080_s083_c23_task_progress() {
    let w = world("mm-progress");
    let k = w.started("一");
    let v = w.version(&k);
    let r = w
        .progress(
            "S1",
            ProgressRequest {
                percent: Some(44.0),
                completed: vec![Completed::Text("写完了".into())],
                next: vec![" 下一步 ".into()],
                ..ProgressRequest::task(k.to_lowercase(), " 做了一半 ")
            },
        )
        .unwrap();
    assert_eq!(r.result["taskKey"], k.as_str());
    assert_eq!(r.result["noop"], false);
    assert_eq!(r.result["taskVersion"], v + 1);
    assert_eq!(w.version(&k), v + 1);
    assert_eq!(w.col(&k, "reported_progress"), 40.0);
    assert_eq!(w.last_event(), "work.progressed");
    assert_eq!(
        w.scalar("SELECT summary || '|' || progress_bucket || '|' || percent || '|' || next_json FROM progress_updates"),
        "做了一半|40|44.0|[\"下一步\"]"
    );
    assert_eq!(
        w.count("SELECT count(*) FROM search_docs WHERE entity_type = 'PROGRESS'"),
        1
    );
    // C-23：不带 percent → reported_progress 不变。
    w.progress("S1", ProgressRequest::task(&k, "又做了一点"))
        .unwrap();
    assert_eq!(w.col(&k, "reported_progress"), 40.0);
    assert_eq!(w.version(&k), v + 2);
}

/// S-081 + 00 02 C-13：同桶、同摘要、无证据、无 blocker → noop（不写行、不推版本）；纯空白的 blocker 视为没有。
#[test]
fn s081_c13_duplicate_progress_is_a_noop() {
    let w = world("mm-noop");
    let k = w.started("一");
    let req = ProgressRequest {
        percent: Some(31.0),
        ..ProgressRequest::task(&k, "进展")
    };
    let first = w.progress("S1", req.clone()).unwrap();
    let (rows, v) = (w.progress_rows(), w.version(&k));
    for blocker in [None, Some("   ".to_owned())] {
        let r = w
            .progress(
                "S1",
                ProgressRequest {
                    percent: Some(28.0),
                    blocker,
                    ..req.clone()
                },
            )
            .unwrap();
        assert_eq!(r.result["noop"], true);
        assert_eq!(r.result["progressId"], first.result["progressId"]);
    }
    assert_eq!((w.progress_rows(), w.version(&k)), (rows, v));
    assert_eq!(w.col(&k, "status"), "IN_PROGRESS");
    for other in [
        ProgressRequest {
            percent: Some(55.0),
            ..req.clone()
        },
        ProgressRequest {
            summary: "另一件事".into(),
            percent: Some(55.0),
            ..req.clone()
        },
    ] {
        assert_eq!(w.progress("S1", other).unwrap().result["noop"], false);
    }
    // 与上一条同桶同摘要，但带证据就不算重复。
    let r = w
        .progress(
            "S1",
            ProgressRequest {
                summary: "另一件事".into(),
                percent: Some(55.0),
                evidence: vec![ev(EvidenceKind::TestResult, "12 passed")],
                ..req.clone()
            },
        )
        .unwrap();
    assert_eq!(r.result["noop"], false);
    assert!(w.col(&k, "last_evidence_at").is_string());
}

/// S-082：blocker → BLOCKED、写阻塞记录、`work.blocked`；终态任务带 blocker 是非法迁移，零写入。
#[test]
fn s082_blocker_blocks_the_task() {
    let w = world("mm-blocker");
    let k = w.started("一");
    let r = w
        .progress(
            "S1",
            ProgressRequest {
                blocker: Some(" 等上游 ".into()),
                ..ProgressRequest::task(&k, "卡住了")
            },
        )
        .unwrap();
    assert_eq!(r.result["state"]["status"], "BLOCKED");
    assert_eq!(w.col(&k, "blocked_reason"), "等上游");
    assert_eq!(
        w.scalar("SELECT title || '|' || status FROM blockers WHERE project_id = 'PA'"),
        "等上游|ACTIVE"
    );
    assert_eq!(w.last_event(), "work.blocked");
    let done = w.started("二");
    w.s1(p(&done, Operation::Complete)).unwrap();
    let e = w.refused(ErrorCode::INVALID_TRANSITION, || {
        w.progress(
            "S1",
            ProgressRequest {
                blocker: Some("x".into()),
                ..ProgressRequest::task(&done, "卡住了")
            },
        )
    });
    assert_eq!(e.details["reason"], "progress blocker");
}

/// 10 R1 + R2：进度受领取归属约束；同 lineage 的 successor 可以写并接过领取。
#[test]
fn r1_r2_progress_respects_the_claim() {
    let w = world("mm-claim");
    let k = w.started("一");
    w.refused(ErrorCode::CLAIM_NOT_OWNED, || {
        w.progress("SX", ProgressRequest::task(&k, "别人的"))
    });
    // R1 点名的两条：带 blocker、带 percent 的进度同样受领取约束。
    w.refused(ErrorCode::CLAIM_NOT_OWNED, || {
        w.progress(
            "SX",
            ProgressRequest {
                blocker: Some("别人的阻塞".into()),
                ..ProgressRequest::task(&k, "卡住了")
            },
        )
    });
    w.refused(ErrorCode::CLAIM_NOT_OWNED, || {
        w.progress(
            "SX",
            ProgressRequest {
                percent: Some(60.0),
                ..ProgressRequest::task(&k, "做了一半")
            },
        )
    });
    w.progress("S2", ProgressRequest::task(&k, "接着做"))
        .unwrap();
    assert_eq!(w.col(&k, "claimed_by_session_id"), "S2");
    w.refused(ErrorCode::WORK_ITEM_NOT_FOUND, || {
        w.progress("S1", ProgressRequest::task("ATM-T-0099", "没有这个"))
    });
}

/// 02 §5.1：参数校验，全部零写入。
#[test]
fn progress_arguments_are_validated_with_zero_writes() {
    let w = world("mm-validate");
    let k = w.started("一");
    for (code, req) in [
        (
            ErrorCode::INVALID_ARGUMENT,
            ProgressRequest::task(&k, "   "),
        ),
        (
            ErrorCode::INVALID_ARGUMENT,
            ProgressRequest {
                percent: Some(101.0),
                ..ProgressRequest::task(&k, "x")
            },
        ),
        (
            ErrorCode::INVALID_ARGUMENT,
            ProgressRequest {
                health: Some("ON_TRACK".into()),
                ..ProgressRequest::task(&k, "x")
            },
        ),
        (
            ErrorCode::INVALID_ARGUMENT,
            ProgressRequest {
                percent: Some(10.0),
                ..project("x")
            },
        ),
        (
            ErrorCode::INVALID_ARGUMENT,
            ProgressRequest {
                health: Some("GREAT".into()),
                ..project("x")
            },
        ),
        (
            ErrorCode::VALIDATION_ERROR,
            ProgressRequest {
                task_key: None,
                ..ProgressRequest::task(&k, "x")
            },
        ),
        (
            ErrorCode::INVALID_ARGUMENT,
            ProgressRequest {
                completed: vec![Completed::Item {
                    text: " ".into(),
                    work_item_key: None,
                }],
                ..ProgressRequest::task(&k, "x")
            },
        ),
        (
            ErrorCode::INVALID_ARGUMENT,
            ProgressRequest {
                next: vec!["n".into(); 21],
                ..ProgressRequest::task(&k, "x")
            },
        ),
    ] {
        w.refused(code, || w.progress("S1", req));
    }
}

/// S-085 + S-086：项目进度直接发布；completed 里的任务 key 校验并规范化；health 默认 UNKNOWN、带 blocker 为 AT_RISK；
/// from / to 序列号接续上一次发布。
#[test]
fn s085_project_progress() {
    let w = world("mm-project");
    let k = w.task("一");
    w.refused(ErrorCode::WORK_ITEM_NOT_FOUND, || {
        w.progress(
            "S1",
            ProgressRequest {
                completed: vec![Completed::Item {
                    text: "x".into(),
                    work_item_key: Some("ATM-T-0099".into()),
                }],
                ..project("周报")
            },
        )
    });
    let first = w
        .progress(
            "S1",
            ProgressRequest {
                completed: vec![Completed::Item {
                    text: " 做完一 ".into(),
                    work_item_key: Some(k.to_lowercase()),
                }],
                ..project("周报")
            },
        )
        .unwrap();
    assert_eq!(first.result["health"], "UNKNOWN");
    assert_eq!(first.result["fromSequence"], 0);
    assert_eq!(w.last_event(), "project.update.published");
    assert_eq!(
        w.scalar("SELECT completed_json FROM project_updates"),
        json!([{ "text": "做完一", "workItemKey": k }]).to_string()
    );
    let second = w
        .progress(
            "S1",
            ProgressRequest {
                blocker: Some("人手不够".into()),
                ..project("周报")
            },
        )
        .unwrap();
    assert_eq!(second.result["health"], "AT_RISK");
    assert_eq!(second.result["fromSequence"], first.result["toSequence"]);
    assert_eq!(
        w.scalar("SELECT risks_json FROM project_updates WHERE health = 'AT_RISK'"),
        "[\"人手不够\"]"
    );
    let third = w
        .progress(
            "S1",
            ProgressRequest {
                health: Some(" on_track ".into()),
                ..project("周报")
            },
        )
        .unwrap();
    assert_eq!(third.result["health"], "ON_TRACK");
}

/// S-031、S-032 + 02 §3.3：同 op_id 同请求重放；不同请求冲突；2.x kernel-v1 的旧回执也能重放。
#[test]
fn s031_s032_progress_idempotency_and_v1_receipts() {
    let w = world("mm-idem");
    let k = w.started("一");
    let t = Target::new("PA", Some("S1"), "pg-1");
    let req = ProgressRequest {
        percent: Some(50.0),
        ..ProgressRequest::task(&k, "一半")
    };
    let first = w.svc.add_progress(&agent(), &t, req.clone()).unwrap();
    let before = w.snapshot();
    let again = w.svc.add_progress(&agent(), &t, req.clone()).unwrap();
    assert!(again.replayed);
    assert_eq!(again.result, first.result);
    assert_eq!(w.snapshot(), before);
    w.refused(ErrorCode::IDEMPOTENCY_CONFLICT, || {
        w.svc.add_progress(
            &agent(),
            &t,
            ProgressRequest {
                percent: Some(60.0),
                ..req.clone()
            },
        )
    });
    // 2.x 的回执：kernel-v1 形状（taskKey、summary、completed、next、evidence、percent）。
    let legacy = JsValue::from_json(&json!({
        "taskKey": k, "summary": "旧的", "completed": [], "next": [], "evidence": [], "percent": 20.0,
    }));
    let fingerprint = fp::kernel_v1(&legacy).unwrap();
    w.svc
        .store()
        .write(move |tx| {
            tx.execute(
                "INSERT INTO idempotency_receipts (scope_kind, scope_id, ns_kind, ns_id, op_id, legacy_key, legacy_class,
                     actor_session_id, operation, fp_v, fp_family, fingerprint, receipt_json, scope_generation, created_at)
                 VALUES ('PROJECT', 'PA', 'SESSION', 'S1', 'pg-old', 'S1:pg-old', 'AGENT', 'S1', 'work.progress', 1,
                         'kernel-v1', ?1, '{\"sequence\":7}', 1, ?2)",
                params![fingerprint, T0],
            )
        })
        .map_err(|e| format!("{e:?}"))
        .unwrap();
    let old = Target::new("PA", Some("S1"), "pg-old");
    let r = w
        .svc
        .add_progress(
            &agent(),
            &old,
            ProgressRequest {
                percent: Some(20.0),
                ..ProgressRequest::task(&k, "旧的")
            },
        )
        .unwrap();
    assert!(r.replayed);
    assert_eq!(r.result["sequence"], 7);
}

// ================= 记录 =================

/// 02 §1.6：六种 kind（大小写不敏感）；DECISION 用 D、其他用 R；importance 默认 NORMAL；记录事件与搜索文档。
#[test]
fn records_kinds_keys_and_defaults() {
    let w = world("mm-record");
    let d = w
        .record(RecordRequest::new(" decision ", "选 Rust", "单进程"))
        .unwrap();
    assert_eq!(d.result["record"]["key"], "ATM-D-001");
    assert_eq!(d.result["record"]["importance"], "NORMAL");
    assert_eq!(d.result["record"]["scope"], "PROJECT");
    let f = w
        .record(RecordRequest::new("FACT", "事实", "摘要"))
        .unwrap();
    assert_eq!(f.result["record"]["key"], "ATM-R-002");
    assert_eq!(w.last_event(), "record.created");
    assert_eq!(
        w.count("SELECT count(*) FROM search_docs WHERE entity_type = 'RECORD'"),
        2
    );
    let e = w.refused(ErrorCode::INVALID_ARGUMENT, || {
        w.record(RecordRequest::new("REVIEW_AUDIT", "x", "y"))
    });
    assert_eq!(e.details["allowed"].as_array().unwrap().len(), 6);
    w.refused(ErrorCode::INVALID_ARGUMENT, || {
        w.record(RecordRequest {
            importance: Some("URGENT".into()),
            ..RecordRequest::new("FACT", "x", "y")
        })
    });
    w.refused(ErrorCode::INVALID_ARGUMENT, || {
        w.record(RecordRequest::new("FACT", " ", "y"))
    });
    w.refused(ErrorCode::WORK_ITEM_NOT_FOUND, || {
        w.record(RecordRequest {
            work_item_key: Some("ATM-T-0099".into()),
            ..RecordRequest::new("FACT", "x", "y")
        })
    });
    let k = w.task("一");
    let linked = w
        .record(RecordRequest {
            work_item_key: Some(k.to_lowercase()),
            ..RecordRequest::new("RISK", "风险", "y")
        })
        .unwrap();
    assert_eq!(linked.result["record"]["workItemKey"], k.as_str());
}

/// 02 §1.6：supersedes 把旧记录标成 SUPERSEDED（版本 +1）；REVIEW_AUDIT 不可替代；不存在 → RECORD_NOT_FOUND。
#[test]
fn records_supersede_marks_the_old_one() {
    let w = world("mm-supersede");
    w.record(RecordRequest::new("DECISION", "旧决定", "a"))
        .unwrap();
    let r = w
        .record(RecordRequest {
            supersedes: Some("atm-d-001".into()),
            ..RecordRequest::new("DECISION", "新决定", "b")
        })
        .unwrap();
    assert_eq!(r.result["record"]["key"], "ATM-D-002");
    assert_eq!(w.record_col(1, "status"), "SUPERSEDED");
    assert_eq!(w.record_col(1, "version"), 1);
    assert_eq!(w.record_col(2, "supersedes_id"), w.record_col(1, "id"));
    w.exec(&format!(
        "INSERT INTO records (project_id, id, local_no, kind, title, summary, detail, importance, status, scope, actor, version,
           created_at, updated_at, source_type)
         VALUES ('PA', 'RA', 9, 'VERIFICATION', '审计', 's', '', 'NORMAL', 'ACTIVE', 'REVIEW_AUDIT', 'codex', 0, '{T0}', '{T0}', 'AGENT')"
    ));
    w.refused(ErrorCode::IMMUTABLE_RECORD, || {
        w.record(RecordRequest {
            supersedes: Some("ATM-R-009".into()),
            ..RecordRequest::new("FACT", "x", "y")
        })
    });
    for missing in ["ATM-R-077", "OTH-R-001", "nonsense"] {
        w.refused(ErrorCode::RECORD_NOT_FOUND, || {
            w.record(RecordRequest {
                supersedes: Some(missing.into()),
                ..RecordRequest::new("FACT", "x", "y")
            })
        });
    }
}

/// 02 §1.6：relatedRecords 列出同 topic 或同 subject_key 的其他 ACTIVE 记录（不含自己、不含已替代的）。
#[test]
fn records_list_related_records() {
    let w = world("mm-related");
    let topic = |t: &str, title: &str| RecordRequest {
        topic: Some(t.into()),
        ..RecordRequest::new("FACT", title, "s")
    };
    w.record(topic("构建", "一")).unwrap();
    w.record(topic("发布", "二")).unwrap();
    w.record(RecordRequest {
        subject_key: Some("core".into()),
        ..topic("构建", "三")
    })
    .unwrap();
    let r = w
        .record(RecordRequest {
            subject_key: Some("core".into()),
            supersedes: Some("ATM-R-001".into()),
            ..topic(" 构建 ", "四")
        })
        .unwrap();
    assert_eq!(r.result["record"]["relatedRecords"], json!(["ATM-R-003"]));
    assert_eq!(r.result["record"]["topic"], "构建");
    // 空白的 topic 视为没有。
    let r = w.record(topic("  ", "五")).unwrap();
    assert_eq!(r.result["record"]["topic"], Value::Null);
    assert_eq!(r.result["record"]["relatedRecords"], json!([]));
}

/// R11 P2-1：summary 超过 300 个 code point 截断（末尾 …），全文移到 detail 的开头，结果带 summaryTruncated。
#[test]
fn p2_1_long_summaries_are_truncated() {
    let w = world("mm-truncate");
    let long: String = "长".repeat(SUMMARY_MAX + 5);
    let r = w
        .record(RecordRequest {
            detail: "细节".into(),
            ..RecordRequest::new("FACT", "长摘要", &long)
        })
        .unwrap();
    assert_eq!(r.result["summaryTruncated"], true);
    let summary = r.result["record"]["summary"].as_str().unwrap();
    assert_eq!(summary.chars().count(), SUMMARY_MAX);
    assert!(summary.ends_with('…'));
    assert_eq!(w.record_col(1, "detail"), format!("{long}\n\n细节"));
    let exact = w
        .record(RecordRequest::new(
            "FACT",
            "刚好",
            &"字".repeat(SUMMARY_MAX),
        ))
        .unwrap();
    assert!(exact.result.get("summaryTruncated").is_none());
}

/// 02 §1.6：同 op_id 同请求重放；换内容冲突。
#[test]
fn s031_record_idempotency() {
    let w = world("mm-record-idem");
    let t = Target::new("PA", Some("S1"), "rc-1");
    let req = RecordRequest::new("FACT", "事实", "摘要");
    let first = w.svc.create_record(&agent(), &t, req.clone()).unwrap();
    let again = w.svc.create_record(&agent(), &t, req.clone()).unwrap();
    assert!(again.replayed);
    assert_eq!(again.result, first.result);
    assert_eq!(w.count("SELECT count(*) FROM records"), 1);
    w.refused(ErrorCode::IDEMPOTENCY_CONFLICT, || {
        w.svc.create_record(
            &agent(),
            &t,
            RecordRequest::new("FACT", "事实", "另一个摘要"),
        )
    });
}

// ================= 反馈 =================

/// 02 §1.8：反馈是固定形状的 RISK 记录（scope ATM_FEEDBACK、topic atm-agent-feedback），只存本机。
#[test]
fn feedback_is_a_fixed_shape_local_risk_record() {
    let w = world("mm-feedback");
    let k = w.task("一");
    let fb = FeedbackRequest {
        summary: " patch 报错看不懂 ".into(),
        detail: Some("INVALID_TRANSITION 没给下一步".into()),
        tool: Some("atm_task_patch".into()),
        severity: Some("high".into()),
        task_key: Some(k.clone()),
    };
    let r = w
        .svc
        .feedback(&agent(), &w.target(Some("S1")), fb.clone())
        .unwrap();
    let rec = &r.result["record"];
    assert_eq!(rec["kind"], "RISK");
    assert_eq!(rec["scope"], "ATM_FEEDBACK");
    assert_eq!(rec["topic"], "atm-agent-feedback");
    assert_eq!(rec["importance"], "HIGH");
    assert_eq!(rec["title"], "ATM Agent 反馈：patch 报错看不懂");
    assert_eq!(rec["workItemKey"], k.as_str());
    let detail = w.record_col(1, "detail");
    let detail = detail.as_str().unwrap();
    assert!(detail.starts_with("本条反馈仅保存在本机 ATM 项目数据库"));
    assert!(detail.contains("涉及工具：atm_task_patch"));
    assert!(detail.ends_with("INVALID_TRANSITION 没给下一步"));
    w.refused(ErrorCode::INVALID_ARGUMENT, || {
        w.svc.feedback(
            &agent(),
            &w.target(Some("S1")),
            FeedbackRequest {
                summary: "  ".into(),
                ..fb.clone()
            },
        )
    });
    let bare = w
        .svc
        .feedback(
            &agent(),
            &w.target(Some("S1")),
            FeedbackRequest {
                summary: "x".into(),
                detail: None,
                tool: None,
                severity: None,
                task_key: None,
            },
        )
        .unwrap();
    assert_eq!(bare.result["record"]["importance"], "NORMAL");
    assert!(
        w.record_col(2, "detail")
            .as_str()
            .unwrap()
            .ends_with("未提供详细说明。")
    );
}

/// 03 §5：用户也能写记录（无 session）；Agent 写记录必须带 session 由管线保证（W2b 已验）。
#[test]
fn users_write_records_without_a_session() {
    let w = world("mm-user");
    let r = w
        .svc
        .create_record(
            &user(),
            &w.target(None),
            RecordRequest::new("LESSON", "教训", "s"),
        )
        .unwrap();
    assert_eq!(r.result["record"]["key"], "ATM-R-001");
    assert_eq!(w.record_col(1, "source_type"), "USER");
}

// ================= 追溯补齐（W2h2） =================

/// S-039：noop 也是成功回执；同一 op 重试拿回同一个 noop 回执，整库不变。
#[test]
fn s039_a_noop_receipt_replays_as_a_noop() {
    let w = world("mm-s039");
    let k = w.started("一");
    w.progress("S1", ProgressRequest::task(&k, "进展")).unwrap();
    let t = Target::new("PA", Some("S1"), "noop-1");
    let first = w
        .svc
        .add_progress(&agent(), &t, ProgressRequest::task(&k, "进展"))
        .unwrap();
    assert_eq!(first.result["noop"], true);
    assert!(!first.replayed);
    let before = w.snapshot();
    let again = w
        .svc
        .add_progress(&agent(), &t, ProgressRequest::task(&k, "进展"))
        .unwrap();
    assert!(again.replayed);
    assert_eq!(again.result, first.result);
    assert_eq!(w.snapshot(), before);
}

/// S-043：两道闸门的规范化一致：project 进度里写小写 key 成功后，原样重试和换成大写写法都是 REPLAY；换内容冲突。
#[test]
fn s043_normalized_keys_replay() {
    let w = world("mm-s043");
    let k = w.task("一");
    let t = Target::new("PA", Some("S1"), "pp-1");
    let with_key = |key: String, text: &str| ProgressRequest {
        completed: vec![Completed::Item {
            text: text.into(),
            work_item_key: Some(key),
        }],
        ..project("周报")
    };
    let first = w
        .svc
        .add_progress(&agent(), &t, with_key(k.to_lowercase(), "做完一"))
        .unwrap();
    assert!(!first.replayed);
    for key in [k.to_lowercase(), k.clone()] {
        let again = w
            .svc
            .add_progress(&agent(), &t, with_key(key, "做完一"))
            .unwrap();
        assert!(again.replayed);
    }
    w.refused(ErrorCode::IDEMPOTENCY_CONFLICT, || {
        w.svc
            .add_progress(&agent(), &t, with_key(k.clone(), "做完二"))
    });
}

/// S-085：project 进度不去重：同样内容发两次就是两条 PUBLISHED（task 进度的 noop 见 s081）。
#[test]
fn s085_project_updates_are_never_deduplicated() {
    let w = world("mm-s085");
    w.progress("S1", project("周报")).unwrap();
    let r = w.progress("S1", project("周报")).unwrap();
    assert!(
        r.result.get("noop").is_none_or(|n| n != true),
        "{}",
        r.result
    );
    assert_eq!(
        w.count("SELECT count(*) FROM project_updates WHERE status = 'PUBLISHED'"),
        2
    );
}
