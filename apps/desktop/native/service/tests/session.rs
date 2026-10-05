//! Session 生命周期的验收（W2e；02 §2、S-001～S-022，00 02 C-06、C-07、C-08、C-14、C-17，03 C-04、P-006，
//! 10 R3、R4′、R11 A1、A3、P1-3）。拒绝一律按整库逐表逐行快照核对零变化。

mod support;

use atm_domain::error::ErrorCode;
use atm_domain::principal::{JobId, Principal};
use atm_domain::time::Timestamp;
use atm_domain::work::Operation;
use atm_service::fp::{self, JsValue};
use atm_service::memory::{ProgressRequest, RecordRequest};
use atm_service::session::{
    BeginRequest, EndRequest, GitContext, Outcome, ProjectSelector, Resume, SweepPolicy,
};
use atm_service::work::Target;
use atm_service::write::Written;
use serde_json::{Value, json};
use std::time::{SystemTime, UNIX_EPOCH};
use support::*;

// ---------- 助手 ----------

fn agent_in(group: &str) -> Principal {
    Principal::authenticated_agent(Some(group.to_owned()))
}

fn begin_req(agent: &str) -> BeginRequest {
    BeginRequest {
        selector: ProjectSelector {
            code: Some("ATM".into()),
            ..ProjectSelector::default()
        },
        cwd: Some("R:/repo".into()),
        ..BeginRequest::new(agent)
    }
}

fn sid(w: &Written) -> String {
    w.result["session"]["id"].as_str().unwrap().to_owned()
}

fn now_minus(minutes: i64) -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    Timestamp::from_millis(ms - minutes * 60_000).to_string()
}

fn end(outcome: Outcome, release: bool) -> EndRequest {
    EndRequest {
        outcome,
        summary: "收工".into(),
        next: vec!["接着做".into()],
        release_claims: release,
        retirement_reason: None,
        git: None,
    }
}

fn system() -> Principal {
    Principal::system_job(JobId::StartupRecover)
}

impl World {
    fn begin(&self, req: BeginRequest) -> Written {
        self.svc.begin(&agent(), req).unwrap()
    }

    fn end_as(
        &self,
        session: &str,
        req: EndRequest,
    ) -> Result<Written, atm_domain::error::DomainError> {
        self.svc
            .end_session(&agent(), &self.target(Some(session)), req)
    }

    fn record_as(
        &self,
        session: &str,
        title: &str,
    ) -> Result<Written, atm_domain::error::DomainError> {
        self.svc.create_record(
            &agent(),
            &self.target(Some(session)),
            RecordRequest::new("FACT", title, "摘要"),
        )
    }

    fn sessions(&self) -> i64 {
        self.count("SELECT count(*) FROM agent_sessions WHERE project_id = 'PA'")
    }

    /// 归档、垃圾箱两个项目（ARC、TRS）。
    fn more_projects(&self) {
        self.exec(&format!(
            "INSERT INTO scope_generations (gen, scope_kind, scope_id, reason, epoch, created_at) VALUES
               (3, 'PROJECT', 'PR', 'CREATED', 'ER', '{T0}'), (4, 'PROJECT', 'PT', 'CREATED', 'ET', '{T0}');
             UPDATE app_meta SET scope_gen_counter = 4;
             INSERT INTO projects (id, code, name, lifecycle, health, meta_version, scope_gen, epoch, created_at, updated_at) VALUES
               ('PR', 'ARC', '归档的', 'ARCHIVED', 'UNKNOWN', 0, 3, 'ER', '{T0}', '{T0}'),
               ('PT', 'TRS', '垃圾箱里的', 'TRASHED', 'UNKNOWN', 0, 4, 'ET', '{T0}', '{T0}');
             INSERT INTO counters (project_id, name, next_value) VALUES ('PR', 'work_item', 1), ('PR', 'record', 1), ('PR', 'blocker', 1);"
        ));
    }

    /// fixture 里的 session 心跳是 T0：扫描用例先把它们刷成现在，免得一起被扫掉。
    fn fresh_fixture(&self) {
        self.exec(&format!(
            "UPDATE agent_sessions SET heartbeat_at = '{}' WHERE connection_state = 'ONLINE'",
            now_minus(0)
        ));
    }

    fn session_col(&self, project: &str, id: &str, column: &str) -> Value {
        self.scalar(&format!(
            "SELECT {column} FROM agent_sessions WHERE project_id = '{project}' AND id = '{id}'"
        ))
    }
}

// ================= begin =================

/// S-001 + S-004：op_id trim 后 1–128；同 op_id 同请求重放同一 session、不加事件；改一个字段就冲突；
/// git 探测结果变化不算请求变化。
#[test]
fn s001_s004_atomic_begin() {
    let w = world("ss-begin-atomic");
    w.refused(ErrorCode::OPERATION_ID_INVALID, || {
        w.svc.begin(
            &agent(),
            BeginRequest {
                op_id: Some("   ".into()),
                ..begin_req("claude")
            },
        )
    });
    let req = BeginRequest {
        op_id: Some(" b1 ".into()),
        ..begin_req("claude")
    };
    let first = w.begin(req.clone());
    assert_eq!(first.result["outcome"], "CREATED");
    assert_eq!(
        w.scalar("SELECT op_id FROM idempotency_receipts WHERE call_operation = 'session.recover-or-begin'"),
        "b1"
    );
    let before = w.snapshot();
    let again = w.begin(BeginRequest {
        git: Some(GitContext {
            available: true,
            branch: Some("other".into()),
            ..GitContext::default()
        }),
        ..req.clone()
    });
    assert!(again.replayed);
    assert_eq!(sid(&again), sid(&first));
    assert_eq!(again.result["sessionState"], "ONLINE");
    assert_eq!(w.snapshot(), before);
    w.refused(ErrorCode::IDEMPOTENCY_CONFLICT, || {
        w.svc.begin(
            &agent(),
            BeginRequest {
                role: Some("REVIEWER".into()),
                ..req.clone()
            },
        )
    });
}

/// R11 A3：3.0 的 begin 按 (principal, operation, op_id) 唯一，不按项目划分。
#[test]
fn a3_begin_op_id_is_shared_across_projects() {
    let w = world("ss-begin-call");
    w.more_projects();
    w.begin(BeginRequest {
        op_id: Some("same".into()),
        ..begin_req("claude")
    });
    w.refused(ErrorCode::IDEMPOTENCY_CONFLICT, || {
        w.svc.begin(
            &agent(),
            BeginRequest {
                op_id: Some("same".into()),
                selector: ProjectSelector {
                    code: Some("ARC".into()),
                    ..ProjectSelector::default()
                },
                ..begin_req("claude")
            },
        )
    });
}

/// S-003 + 04 L-008：TRASHED 项目登记 / 累加恢复请求并报错（提交了请求，没有 session）；ARCHIVED 照常可写。
#[test]
fn s003_l008_trashed_and_archived_projects() {
    let w = world("ss-begin-trash");
    w.more_projects();
    let trashed = || {
        w.svc.begin(
            &agent(),
            BeginRequest {
                mode: Some("quick".into()),
                selector: ProjectSelector {
                    code: Some("trs".into()),
                    ..ProjectSelector::default()
                },
                ..begin_req("claude")
            },
        )
    };
    let e = trashed().unwrap_err();
    assert_eq!(e.code, ErrorCode::PROJECT_DB_UNAVAILABLE);
    assert_eq!(e.details["retryable"], false);
    assert_eq!(e.details["recovery"]["request_count"], 1);
    let e = trashed().unwrap_err();
    assert_eq!(e.details["recovery"]["request_count"], 2);
    assert_eq!(
        w.count("SELECT count(*) FROM agent_sessions WHERE project_id = 'PT'"),
        0
    );
    assert_eq!(w.count("SELECT count(*) FROM quick_tasks"), 0);
    assert_eq!(
        w.scalar("SELECT lifecycle FROM projects WHERE id = 'PT'"),
        "TRASHED"
    );
    let r = w.begin(BeginRequest {
        selector: ProjectSelector {
            code: Some("ARC".into()),
            ..ProjectSelector::default()
        },
        ..begin_req("claude")
    });
    assert_eq!(r.result["project"]["lifecycle"], "ARCHIVED");
    // 选择器里的项目不存在 → PROJECT_NOT_FOUND；什么都没认出来 → PROJECT_REQUIRED（带下一步）。
    w.refused(ErrorCode::PROJECT_NOT_FOUND, || {
        w.svc.begin(
            &agent(),
            BeginRequest {
                selector: ProjectSelector {
                    code: Some("NOPE".into()),
                    ..ProjectSelector::default()
                },
                ..begin_req("claude")
            },
        )
    });
    let e = w.refused(ErrorCode::PROJECT_REQUIRED, || {
        w.svc.begin(
            &agent(),
            BeginRequest {
                selector: ProjectSelector::default(),
                ..begin_req("claude")
            },
        )
    });
    assert_eq!(e.details["next"]["allow_project_create"], true);
}

/// 04 L-010：精确路径 → marker → git common dir。
#[test]
fn l010_project_is_found_by_path_marker_or_common_dir() {
    let w = world("ss-begin-locate");
    w.exec(&format!(
        "INSERT INTO project_paths (id, project_id, canonical_path, git_common_dir, is_primary, last_seen_at)
         VALUES ('PP1', 'PA', 'r:\\repo', 'r:\\repo\\.git', 1, '{T0}')"
    ));
    for selector in [
        ProjectSelector {
            path_key: Some("r:\\repo".into()),
            ..ProjectSelector::default()
        },
        ProjectSelector {
            marker_project_id: Some("PA".into()),
            ..ProjectSelector::default()
        },
        ProjectSelector {
            git_common_dir: Some("r:\\repo\\.git".into()),
            ..ProjectSelector::default()
        },
    ] {
        let r = w.begin(BeginRequest {
            selector,
            ..begin_req("claude")
        });
        assert_eq!(r.result["project"]["code"], "ATM");
    }
    let e = w.refused(ErrorCode::PROJECT_NOT_FOUND, || {
        w.svc.begin(
            &agent(),
            BeginRequest {
                selector: ProjectSelector {
                    marker_project_id: Some("GONE".into()),
                    ..ProjectSelector::default()
                },
                ..begin_req("claude")
            },
        )
    });
    assert_eq!(e.details["diagnostic"], "MARKER_PROJECT_MISSING");
}

/// S-006 + S-011：resume 接回同四元组唯一的未关闭 session；两条 → AMBIGUOUS。agents 每次都 upsert。
#[test]
fn s006_s011_resume_reattaches_the_open_session() {
    let w = world("ss-resume-open");
    let a = w.begin(BeginRequest {
        resume: Some(Resume::No),
        thread_id: Some("t1".into()),
        ..begin_req("codex")
    });
    let t2 = w.begin(BeginRequest {
        resume: Some(Resume::Yes),
        thread_id: Some("t2".into()),
        ..begin_req("codex")
    });
    assert_eq!(t2.result["outcome"], "CREATED");
    let r = w.begin(BeginRequest {
        resume: Some(Resume::Yes),
        thread_id: Some("t1".into()),
        display_name: Some("Codex 新名".into()),
        ..begin_req("codex")
    });
    assert_eq!(sid(&r), sid(&a));
    assert_eq!(r.result["outcome"], "RESUMED");
    assert_eq!(
        w.scalar("SELECT type FROM events WHERE project_id = 'PA' ORDER BY seq DESC LIMIT 1"),
        "agent.resumed"
    );
    // 接回不建新的 session，也就不 upsert agents；新建时才覆盖 display_name。
    w.begin(BeginRequest {
        resume: Some(Resume::No),
        thread_id: Some("t1".into()),
        display_name: Some("Codex 新名".into()),
        ..begin_req("codex")
    });
    assert_eq!(
        w.scalar("SELECT display_name FROM agents WHERE project_id = 'PA' AND id = 'codex'"),
        "Codex 新名"
    );
    let e = w.refused(ErrorCode::SESSION_SUCCESSOR_AMBIGUOUS, || {
        w.svc.begin(
            &agent(),
            BeginRequest {
                resume: Some(Resume::Yes),
                thread_id: Some("t1".into()),
                ..begin_req("codex")
            },
        )
    });
    assert_eq!(e.details["candidates"].as_array().unwrap().len(), 2);
}

/// S-007 + S-013 + S-016 + R4′：paused 留交接；resume 新建 session 接它并确认交接；只确认本线程的来源。
#[test]
fn s007_s013_s016_resume_through_a_pending_handoff() {
    let w = world("ss-resume-handoff");
    let a = sid(&w.begin(BeginRequest {
        resume: Some(Resume::No),
        thread_id: Some("A".into()),
        ..begin_req("codex")
    }));
    let b = sid(&w.begin(BeginRequest {
        resume: Some(Resume::No),
        thread_id: Some("B".into()),
        ..begin_req("codex")
    }));
    let k1 = w.task("一");
    let k2 = w.task("二");
    w.patch_as(&agent(), Some(&a), vec![p(&k1, Operation::Start)])
        .unwrap();
    w.patch_as(&agent(), Some(&b), vec![p(&k2, Operation::Start)])
        .unwrap();
    // S-013：paused + release_claims=false → 交接写入、领取保留。
    let r = w.end_as(&a, end(Outcome::Paused, false)).unwrap();
    assert_eq!(r.result["handoffs"], 1);
    assert_eq!(w.col(&k1, "claimed_by_session_id"), a.as_str());
    assert!(w.col(&k1, "last_session_closed_at").is_string());
    w.end_as(&b, end(Outcome::Paused, false)).unwrap();
    let n = w.begin(BeginRequest {
        resume: Some(Resume::Yes),
        thread_id: Some("A".into()),
        ..begin_req("codex")
    });
    assert_eq!(n.result["outcome"], "SUCCESSOR");
    assert_eq!(n.result["predecessorSessionId"], a.as_str());
    assert_eq!(n.result["acknowledgedHandoffs"], 1);
    let new = sid(&n);
    assert_eq!(
        w.scalar(&format!(
            "SELECT to_session_id FROM handoffs WHERE from_session_id = '{a}'"
        )),
        new.as_str()
    );
    // 线程 B 的交接不被确认。
    assert_eq!(
        w.scalar(&format!(
            "SELECT to_session_id FROM handoffs WHERE from_session_id = '{b}'"
        )),
        Value::Null
    );
    // R2：领取属于 lineage，新 session 直接写它（不需要 takeover），领取随之转移。
    w.patch_as(&agent(), Some(&new), vec![p(&k1, Operation::Verify)])
        .unwrap();
    assert_eq!(w.col(&k1, "claimed_by_session_id"), new.as_str());
}

/// S-007 反例：两个同四元组的待确认交接来源 → AMBIGUOUS(pending_handoff)，交接都不确认。
#[test]
fn s007_two_handoff_sources_are_ambiguous() {
    let w = world("ss-resume-two");
    for title in ["一", "二"] {
        let s = sid(&w.begin(BeginRequest {
            resume: Some(Resume::No),
            ..begin_req("codex")
        }));
        let k = w.task(title);
        w.patch_as(&agent(), Some(&s), vec![p(&k, Operation::Start)])
            .unwrap();
        w.end_as(&s, end(Outcome::Paused, false)).unwrap();
    }
    let e = w.refused(ErrorCode::SESSION_SUCCESSOR_AMBIGUOUS, || {
        w.svc.begin(
            &agent(),
            BeginRequest {
                resume: Some(Resume::Yes),
                ..begin_req("codex")
            },
        )
    });
    assert_eq!(e.details["pending_handoff"], true);
}

/// S-008、S-009、00 02 C-07、C-14 / R3：指名 predecessor 的判定表。
#[test]
fn s008_s009_c07_named_predecessor() {
    let w = world("ss-named");
    let open = sid(&w.begin(BeginRequest {
        resume: Some(Resume::No),
        thread_id: Some("t".into()),
        ..begin_req("codex")
    }));
    // ONLINE 且四元组全等 → 接回同一条。
    let r = w.begin(BeginRequest {
        resume: Some(Resume::Yes),
        thread_id: Some("t".into()),
        predecessor_session_id: Some(open.clone()),
        ..begin_req("codex")
    });
    assert_eq!(sid(&r), open);
    // 请求 role 不同 → IDENTITY_MISMATCH，原 session 不变。
    w.refused(ErrorCode::SESSION_SUCCESSOR_IDENTITY_MISMATCH, || {
        w.svc.begin(
            &agent(),
            BeginRequest {
                resume: Some(Resume::Yes),
                role: Some("REVIEWER".into()),
                thread_id: Some("t".into()),
                predecessor_session_id: Some(open.clone()),
                ..begin_req("codex")
            },
        )
    });
    w.refused(ErrorCode::SESSION_SUCCESSOR_AGENT_MISMATCH, || {
        w.svc.begin(
            &agent(),
            BeginRequest {
                resume: Some(Resume::Yes),
                predecessor_session_id: Some(open.clone()),
                ..begin_req("claude")
            },
        )
    });
    w.refused(ErrorCode::SESSION_NOT_FOUND, || {
        w.svc.begin(
            &agent(),
            BeginRequest {
                resume: Some(Resume::Yes),
                predecessor_session_id: Some("NOPE".into()),
                ..begin_req("codex")
            },
        )
    });
    // S-009：正常结束、没有交接 → SESSION_NOT_RETIRED。
    w.end_as(&open, end(Outcome::Completed, true)).unwrap();
    w.refused(ErrorCode::SESSION_NOT_RETIRED, || {
        w.svc.begin(
            &agent(),
            BeginRequest {
                resume: Some(Resume::Yes),
                predecessor_session_id: Some(open.clone()),
                ..begin_req("codex")
            },
        )
    });
    // C-07：retired 的 predecessor，只校验 agent 与 role；cwd 与线程可以不同。
    let retired = sid(&w.begin(BeginRequest {
        resume: Some(Resume::No),
        thread_id: Some("old".into()),
        ..begin_req("codex")
    }));
    w.end_as(&retired, end(Outcome::Retired, true)).unwrap();
    assert_eq!(
        w.session_col("PA", &retired, "retirement_reason"),
        "context rotation"
    );
    assert_eq!(
        w.session_col("PA", &retired, "close_reason"),
        "EXPLICIT_RETIRE"
    );
    w.refused(ErrorCode::SESSION_SUCCESSOR_IDENTITY_MISMATCH, || {
        w.svc.begin(
            &agent(),
            BeginRequest {
                resume: Some(Resume::Yes),
                role: Some("REVIEWER".into()),
                predecessor_session_id: Some(retired.clone()),
                ..begin_req("codex")
            },
        )
    });
    let n = w.begin(BeginRequest {
        resume: Some(Resume::Yes),
        cwd: Some("R:/elsewhere".into()),
        thread_id: Some("new".into()),
        predecessor_session_id: Some(retired.clone()),
        ..begin_req("codex")
    });
    assert_eq!(n.result["predecessorSessionId"], retired.as_str());
    // C-14 + R3：非 resume 指名 predecessor 也要同 agent、同 role。
    w.refused(ErrorCode::SESSION_SUCCESSOR_IDENTITY_MISMATCH, || {
        w.svc.begin(
            &agent(),
            BeginRequest {
                resume: Some(Resume::No),
                role: Some("SUBAGENT".into()),
                predecessor_session_id: Some(retired.clone()),
                ..begin_req("codex")
            },
        )
    });
}

/// S-010：不带 resume 的 begin 总是新建，不确认任何交接。
#[test]
fn s010_plain_begin_acknowledges_nothing() {
    let w = world("ss-plain");
    let a = sid(&w.begin(BeginRequest {
        resume: Some(Resume::No),
        ..begin_req("codex")
    }));
    let k = w.task("一");
    w.patch_as(&agent(), Some(&a), vec![p(&k, Operation::Start)])
        .unwrap();
    w.end_as(&a, end(Outcome::Paused, false)).unwrap();
    let r = w.begin(BeginRequest {
        resume: Some(Resume::No),
        ..begin_req("codex")
    });
    assert_eq!(r.result["outcome"], "CREATED");
    assert_eq!(
        w.count("SELECT count(*) FROM handoffs WHERE to_session_id IS NULL"),
        1
    );
}

/// R11 P1-3：resume 默认 auto，只接续客户端已退出 / 心跳超时 / 带交接关闭的 session；永远不接回 ONLINE；
/// 多个候选不阻塞，列出来。
#[test]
fn p1_3_auto_resume() {
    let w = world("ss-auto");
    w.fresh_fixture();
    let done = sid(&w.begin(BeginRequest {
        resume: Some(Resume::No),
        ..begin_req("codex")
    }));
    w.end_as(&done, end(Outcome::Completed, true)).unwrap();
    let first = w
        .svc
        .begin(&agent_in("pid:dead"), begin_req("codex"))
        .unwrap();
    // 正常结束、没有交接的 done 不是候选。
    assert_eq!(first.result["outcome"], "CREATED");
    let a = sid(&first);
    // 客户端还在：不接回它。
    let r = w.begin(begin_req("codex"));
    assert_eq!(r.result["outcome"], "CREATED");
    assert_eq!(r.result["predecessorSessionId"], Value::Null);
    let other = sid(&r);
    // 客户端退出 → 扫描关闭（CLIENT_EXITED）→ 下一次 begin 自动接上它。
    let alive = |id: &str| (id == "pid:dead").then_some(false);
    let report = w
        .svc
        .sweep_sessions(&system(), SweepPolicy::default(), &alive)
        .unwrap();
    assert_eq!(
        report.closed,
        vec![("PA".into(), a.clone(), "CLIENT_EXITED".into())]
    );
    let n = w.begin(begin_req("codex"));
    assert_eq!(n.result["outcome"], "SUCCESSOR");
    assert_eq!(n.result["predecessorSessionId"], a.as_str());
    // 已经被接续过的不再是候选；两个候选时新建并列出。
    for s in [&other, &sid(&n)] {
        w.exec(&format!(
            "UPDATE agent_sessions SET connection_state = 'CLOSED', close_reason = 'HEARTBEAT_TIMEOUT' WHERE id = '{s}'"
        ));
    }
    let m = w.begin(begin_req("codex"));
    assert_eq!(m.result["outcome"], "CREATED");
    assert_eq!(m.result["resumeCandidates"].as_array().unwrap().len(), 2);
    assert_eq!(
        m.result["resumeCandidates"][0]["next"]["predecessor_session_id"],
        m.result["resumeCandidates"][0]["sessionId"]
    );
}

/// R11 A1：白名单客户端的同一连接组再 begin → 同一个 PRIMARY（CURRENT）；resume:false 新建；
/// 非白名单不接回；REVIEWER 不替换 PRIMARY。
#[test]
fn a1_single_conversation_reattach() {
    let w = world("ss-a1");
    let p = agent_in("pid:1");
    let wl = BeginRequest {
        single_conversation: true,
        ..begin_req("claude")
    };
    let first = sid(&w.svc.begin(&p, wl.clone()).unwrap());
    let elsewhere = w.svc.begin(&agent_in("pid:2"), wl.clone()).unwrap();
    assert_eq!(elsewhere.result["outcome"], "CREATED");
    let again = w.svc.begin(&p, wl.clone()).unwrap();
    assert_eq!(again.result["outcome"], "CURRENT");
    assert_eq!(sid(&again), first);
    let reviewer = w
        .svc
        .begin(
            &p,
            BeginRequest {
                role: Some("REVIEWER".into()),
                ..wl.clone()
            },
        )
        .unwrap();
    assert_ne!(sid(&reviewer), first);
    let fresh = w
        .svc
        .begin(
            &p,
            BeginRequest {
                resume: Some(Resume::No),
                ..wl.clone()
            },
        )
        .unwrap();
    assert_ne!(sid(&fresh), first);
    // 同一连接组的非白名单客户端（同一进程里的第二个对话）、另一个连接组：都不拿到第一个对话的 session。
    for (principal, single) in [(agent_in("pid:1"), false), (agent_in("pid:3"), true)] {
        let r = w
            .svc
            .begin(
                &principal,
                BeginRequest {
                    single_conversation: single,
                    ..begin_req("claude")
                },
            )
            .unwrap();
        assert_eq!(r.result["outcome"], "CREATED");
    }
    let other = w
        .svc
        .begin(
            &agent_in("pid:2"),
            BeginRequest {
                single_conversation: false,
                ..begin_req("claude")
            },
        )
        .unwrap();
    assert_eq!(other.result["outcome"], "CREATED");
}

// ================= 超时扫描 =================

/// S-012 + 00 02 C-08 + R11 P1-3：只扫 ACTIVE；无身份按 5 分钟；客户端存活按 120 分钟兜底；不释放领取。
#[test]
fn s012_c08_p1_3_sweep() {
    let w = world("ss-sweep");
    w.more_projects();
    w.fresh_fixture();
    let stale = sid(&w.begin(begin_req("codex")));
    let fresh = sid(&w.begin(BeginRequest {
        resume: Some(Resume::No),
        ..begin_req("codex")
    }));
    let alive = sid(&w
        .svc
        .begin(&agent_in("pid:alive"), begin_req("claude"))
        .unwrap());
    let archived = sid(&w.begin(BeginRequest {
        selector: ProjectSelector {
            code: Some("ARC".into()),
            ..ProjectSelector::default()
        },
        ..begin_req("codex")
    }));
    let k = w.task("一");
    w.patch_as(&agent(), Some(&stale), vec![p(&k, Operation::Start)])
        .unwrap();
    w.exec(&format!(
        "UPDATE agent_sessions SET heartbeat_at = '{}' WHERE id IN ('{stale}', '{alive}', '{archived}');
         UPDATE agent_sessions SET heartbeat_at = '{}' WHERE id = '{fresh}';",
        now_minus(6),
        now_minus(4)
    ));
    let liveness = |id: &str| (id == "pid:alive").then_some(true);
    let report = w
        .svc
        .sweep_sessions(&system(), SweepPolicy::default(), &liveness)
        .unwrap();
    assert_eq!(
        report.closed,
        vec![("PA".into(), stale.clone(), "HEARTBEAT_TIMEOUT".into())]
    );
    assert_eq!(w.session_col("PA", &stale, "connection_state"), "CLOSED");
    assert_eq!(
        w.col(&k, "claimed_by_session_id"),
        stale.as_str(),
        "claim kept"
    );
    assert!(w.col(&k, "last_session_closed_at").is_string());
    assert_eq!(
        w.scalar("SELECT actor_type || ':' || type FROM events WHERE project_id = 'PA' ORDER BY seq DESC LIMIT 1"),
        "SYSTEM:agent.recovered_stale"
    );
    // 存活的客户端到 120 分钟才算超时。
    w.exec(&format!(
        "UPDATE agent_sessions SET heartbeat_at = '{}' WHERE id = '{alive}'",
        now_minus(121)
    ));
    let report = w
        .svc
        .sweep_sessions(&system(), SweepPolicy::default(), &liveness)
        .unwrap();
    assert_eq!(
        report.closed,
        vec![("PA".into(), alive, "HEARTBEAT_TIMEOUT".into())]
    );
    assert_eq!(w.session_col("PR", &archived, "connection_state"), "ONLINE");
    // 能力：Agent 不能跑扫描。
    w.refused(ErrorCode::PRINCIPAL_CAPABILITY_DENIED, || {
        w.svc
            .sweep_sessions(&agent(), SweepPolicy::default(), &liveness)
            .map(|_| unreachable!())
    });
}

// ================= end 与强制关闭 =================

/// S-014 + 00 02 C-06：只把 CLAIMED 变回 READY 并清 assignee；IN_PROGRESS 保留状态、清领取。
#[test]
fn s014_c06_end_releases_claims() {
    let w = world("ss-end-release");
    let s = sid(&w.begin(begin_req("codex")));
    let claimed = w.task("占住");
    let started = w.task("开工");
    w.patch_as(
        &agent(),
        Some(&s),
        vec![p(&claimed, Operation::Claim), p(&started, Operation::Start)],
    )
    .unwrap();
    let v = w.version(&claimed);
    let r = w.end_as(&s, end(Outcome::Completed, true)).unwrap();
    assert_eq!(r.result["handoffs"], 0);
    assert_eq!(
        r.result["releasedItems"],
        json!([{ "key": claimed, "version": v + 1 }, { "key": started, "version": w.version(&started) }])
    );
    assert_eq!(w.col(&claimed, "status"), "READY");
    assert_eq!(w.col(&claimed, "assignee_agent_id"), Value::Null);
    assert_eq!(w.col(&started, "status"), "IN_PROGRESS");
    assert_eq!(w.col(&started, "assignee_agent_id"), "codex");
    assert_eq!(w.col(&started, "claimed_by_session_id"), Value::Null);
    assert_eq!(w.session_col("PA", &s, "close_reason"), "EXPLICIT_END");
    assert_eq!(
        w.scalar("SELECT payload_json FROM events WHERE project_id = 'PA' AND type = 'agent.left'"),
        "{\"outcome\":\"completed\",\"summary\":\"收工\",\"next\":[\"接着做\"]}"
    );
}

/// S-018 + S-036：关闭的 session 不能写新请求（SESSION_CLOSED，零写入），但成功过的请求仍然 REPLAY。
#[test]
fn s018_s036_closed_sessions_replay_but_do_not_write() {
    let w = world("ss-closed");
    let s = sid(&w.begin(begin_req("codex")));
    let t = Target::new("PA", Some(&s), "rec-1");
    let req = RecordRequest::new("FACT", "事实", "摘要");
    let first = w.svc.create_record(&agent(), &t, req.clone()).unwrap();
    w.end_as(&s, end(Outcome::Completed, true)).unwrap();
    let again = w.svc.create_record(&agent(), &t, req).unwrap();
    assert!(again.replayed);
    assert_eq!(again.result, first.result);
    let e = w.refused(ErrorCode::SESSION_CLOSED, || w.record_as(&s, "新的"));
    assert_eq!(e.details["next"]["predecessor_session_id"], s.as_str());
}

/// S-019 + S-020：心跳超时后用旧 id 写入 → 同事务新建 successor（REBOUND）；再写一次接到同一个 successor；
/// 写入失败时 successor 不留下。
#[test]
fn s019_s020_rebind_on_heartbeat_timeout() {
    let w = world("ss-rebind");
    w.exec("UPDATE agent_sessions SET connection_state = 'CLOSED', close_reason = 'HEARTBEAT_TIMEOUT' WHERE id = 'S2'");
    let before = w.sessions();
    w.refused(ErrorCode::WORK_ITEM_NOT_FOUND, || {
        w.svc.add_progress(
            &agent(),
            &w.target(Some("S2")),
            ProgressRequest::task("ATM-T-0099", "做了一点"),
        )
    });
    assert_eq!(w.sessions(), before);
    let r = w.record_as("S2", "一").unwrap();
    let successor = r.rebound_to.clone().expect("rebound");
    assert_eq!(
        w.session_col("PA", &successor, "predecessor_session_id"),
        "S2"
    );
    assert_eq!(w.session_col("PA", &successor, "agent_id"), "claude");
    assert_eq!(
        w.scalar(&format!(
            "SELECT author_session FROM idempotency_receipts WHERE receipt_id = {}",
            r.receipt_id
        )),
        successor.as_str()
    );
    assert_eq!(
        w.scalar("SELECT source_session_id FROM records WHERE local_no = 1"),
        successor.as_str()
    );
    let retry = w
        .svc
        .create_record(
            &agent(),
            &Target::new(
                "PA",
                Some("S2"),
                format!("op-{}", w.op.load(std::sync::atomic::Ordering::SeqCst)),
            ),
            RecordRequest::new("FACT", "一", "摘要"),
        )
        .unwrap();
    assert!(retry.replayed);
    let again = w.record_as("S2", "二").unwrap();
    assert_eq!(again.rebound_to.as_deref(), Some(successor.as_str()));
    assert_eq!(w.sessions(), before + 1);
}

/// S-019 反例：两个在线 successor → AMBIGUOUS；successor 身份不同 → IDENTITY_MISMATCH。都零写入。
#[test]
fn s019_rebind_refusals() {
    let w = world("ss-rebind-no");
    w.exec(&format!(
        "UPDATE agent_sessions SET connection_state = 'CLOSED', close_reason = 'HEARTBEAT_TIMEOUT' WHERE id = 'S1';
         INSERT INTO agent_sessions (project_id, id, agent_id, role, work_state, connection_state, started_at, updated_at, predecessor_session_id)
           VALUES ('PA', 'S3', 'claude', 'PRIMARY', 'IDLE', 'ONLINE', '{T1}', '{T1}', 'S1');"
    ));
    // S2 与 S3 都是 S1 的在线 successor。
    w.refused(ErrorCode::SESSION_SUCCESSOR_AMBIGUOUS, || {
        w.record_as("S1", "x")
    });
    w.exec("UPDATE agent_sessions SET connection_state = 'CLOSED', close_reason = 'EXPLICIT_END' WHERE id = 'S3';
            UPDATE agent_sessions SET role = 'SUBAGENT' WHERE id = 'S2';");
    w.refused(ErrorCode::SESSION_SUCCESSOR_IDENTITY_MISMATCH, || {
        w.record_as("S1", "x")
    });
}

/// S-021：end 不建 successor；有唯一 successor 时结束的是 successor。
#[test]
fn s021_end_does_not_create_a_successor() {
    let w = world("ss-end-rebind");
    w.exec("UPDATE agent_sessions SET connection_state = 'CLOSED', close_reason = 'HEARTBEAT_TIMEOUT' WHERE id = 'SX'");
    let before = w.sessions();
    w.refused(ErrorCode::SESSION_CLOSED, || {
        w.end_as("SX", end(Outcome::Completed, true))
    });
    assert_eq!(w.sessions(), before);
    w.exec("UPDATE agent_sessions SET connection_state = 'CLOSED', close_reason = 'HEARTBEAT_TIMEOUT' WHERE id = 'S1'");
    let r = w.end_as("S1", end(Outcome::Completed, true)).unwrap();
    assert_eq!(r.rebound_to.as_deref(), Some("S2"));
    assert_eq!(w.session_col("PA", "S2", "connection_state"), "CLOSED");
}

/// S-017 + 03 §5.1：强制关闭只给 User；Agent 调用被拒，整库零变化。强制关闭覆盖 close_reason，之后不能 rebind。
#[test]
fn s017_force_close() {
    let w = world("ss-force");
    let k = w.task("占住");
    w.s1(p(&k, Operation::Claim)).unwrap();
    w.exec("UPDATE agent_sessions SET connection_state = 'CLOSED', close_reason = 'HEARTBEAT_TIMEOUT' WHERE id = 'S1'");
    w.refused(ErrorCode::USER_AUTHORIZATION_REQUIRED, || {
        w.svc
            .force_close_session(&agent(), &w.target(None), "S1", true)
    });
    let r = w
        .svc
        .force_close_session(&user(), &w.target(None), "S1", true)
        .unwrap();
    assert_eq!(r.result["released"], 1);
    assert_eq!(w.col(&k, "status"), "READY");
    assert_eq!(w.col(&k, "assignee_agent_id"), Value::Null);
    assert_eq!(w.session_col("PA", "S1", "close_reason"), "FORCE_CLOSE");
    assert_eq!(
        w.session_col("PA", "S1", "retirement_reason"),
        "closed by user"
    );
    assert_eq!(
        w.scalar(
            "SELECT actor_type FROM events WHERE project_id = 'PA' AND type = 'agent.force_closed'"
        ),
        "USER"
    );
    // S2 是 S1 的 successor，但 FORCE_CLOSE 不可 rebind：用 S1 写入 → SESSION_CLOSED。
    w.refused(ErrorCode::SESSION_CLOSED, || w.record_as("S1", "x"));
    w.refused(ErrorCode::SESSION_NOT_FOUND, || {
        w.svc
            .force_close_session(&user(), &w.target(None), "NOPE", true)
    });
}

/// 03 P-006：Agent 写入的 session 必须属于目标项目。
#[test]
fn p006_the_session_must_belong_to_the_project() {
    let w = world("ss-p006");
    let e = w.refused(ErrorCode::SESSION_NOT_FOUND, || w.record_as("EX", "x"));
    assert_eq!(e.details["session_id"], "EX");
    w.record_as("S1", "x").unwrap();
}

/// 00 02 C-08 + 10 R2：任何写入都刷新心跳，并给这个 session 持有的领取续租。
#[test]
fn c08_r2_writes_refresh_heartbeat_and_renew_leases() {
    let w = world("ss-heartbeat");
    let k = w.task("一");
    w.s1(p(&k, Operation::Claim)).unwrap();
    w.exec(&format!(
        "UPDATE work_items SET claim_lease_until = '{}' WHERE local_no = 1;
         UPDATE agent_sessions SET heartbeat_at = '{T0}' WHERE id = 'S1';",
        now_minus(1)
    ));
    let version = w.version(&k);
    w.record_as("S1", "写点别的").unwrap();
    let lease = w.col(&k, "claim_lease_until");
    assert!(lease.as_str().unwrap() > now_minus(-9).as_str(), "{lease}");
    assert_eq!(
        w.version(&k),
        version,
        "lease renewal is not a content change"
    );
    assert!(w.session_col("PA", "S1", "heartbeat_at").as_str().unwrap() > T0);
}

/// S-022：available 时取新值；无变化不写不发事件。界面入口只给 User。
#[test]
fn s022_git_context() {
    let w = world("ss-git");
    let git = GitContext {
        available: true,
        branch: Some("main".into()),
        head: Some("abc1234".into()),
        ..GitContext::default()
    };
    let v = w.session_col("PA", "S1", "version").as_i64().unwrap();
    let r = w
        .svc
        .refresh_git_context(&user(), "PA", "S1", git.clone())
        .unwrap();
    assert_eq!(r["updated"], true);
    assert_eq!(w.session_col("PA", "S1", "git_branch"), "main");
    assert_eq!(w.session_col("PA", "S1", "version"), v + 1);
    let before = w.snapshot();
    let r = w.svc.refresh_git_context(&user(), "PA", "S1", git).unwrap();
    assert_eq!(r["updated"], false);
    assert_eq!(w.snapshot(), before);
    // 不可用时保留旧值，只更新 available / error。
    w.svc
        .refresh_git_context(
            &user(),
            "PA",
            "S1",
            GitContext {
                available: false,
                error: Some("git not found".into()),
                ..GitContext::default()
            },
        )
        .unwrap();
    assert_eq!(w.session_col("PA", "S1", "git_branch"), "main");
    assert_eq!(w.session_col("PA", "S1", "git_error"), "git not found");
    w.refused(ErrorCode::USER_AUTHORIZATION_REQUIRED, || {
        w.svc
            .refresh_git_context(&agent(), "PA", "S1", GitContext::default())
            .map(|_| unreachable!())
    });
}

/// R11 A1 优先级 1 + A3：显式 session 接回（CURRENT）；要同 agent、同 role、未关闭；与 predecessor 互斥；进指纹。
#[test]
fn a1_explicit_session_reattach() {
    let w = world("ss-explicit");
    let s = sid(&w.begin(begin_req("codex")));
    let r = w.begin(BeginRequest {
        session: Some(s.clone()),
        cwd: Some("R:/elsewhere".into()),
        ..begin_req("codex")
    });
    assert_eq!(r.result["outcome"], "CURRENT");
    assert_eq!(sid(&r), s);
    for (code, req) in [
        (
            ErrorCode::INVALID_ARGUMENT,
            BeginRequest {
                session: Some(s.clone()),
                predecessor_session_id: Some(s.clone()),
                ..begin_req("codex")
            },
        ),
        (
            ErrorCode::SESSION_SUCCESSOR_AGENT_MISMATCH,
            BeginRequest {
                session: Some(s.clone()),
                ..begin_req("claude")
            },
        ),
        (
            ErrorCode::SESSION_SUCCESSOR_IDENTITY_MISMATCH,
            BeginRequest {
                session: Some(s.clone()),
                role: Some("REVIEWER".into()),
                ..begin_req("codex")
            },
        ),
        (
            ErrorCode::SESSION_NOT_FOUND,
            BeginRequest {
                session: Some("EX".into()),
                ..begin_req("codex")
            },
        ),
    ] {
        w.refused(code, || w.svc.begin(&agent(), req));
    }
    // 显式 session 是业务字段：同一个 op_id 换 session 就冲突。
    let op = BeginRequest {
        op_id: Some("x".into()),
        session: Some(s.clone()),
        ..begin_req("codex")
    };
    w.begin(op.clone());
    w.refused(ErrorCode::IDEMPOTENCY_CONFLICT, || {
        w.svc.begin(
            &agent(),
            BeginRequest {
                session: Some("SX".into()),
                ..op.clone()
            },
        )
    });
    w.end_as(&s, end(Outcome::Completed, true)).unwrap();
    let e = w.refused(ErrorCode::SESSION_CLOSED, || {
        w.svc.begin(
            &agent(),
            BeginRequest {
                session: Some(s.clone()),
                ..begin_req("codex")
            },
        )
    });
    assert_eq!(e.details["next"]["predecessor_session_id"], s.as_str());
}

/// R11 A3 的可比性：省略 resume 的 begin 与 2.x 旧行比较时按 2.x 缺省值 false 重建；显式 auto、显式 session 与旧行不可比。
#[test]
fn a3_omitted_resume_matches_a_2x_begin_receipt() {
    let w = world("ss-begin-v1");
    let legacy = JsValue::from_json(&json!({
        "projectCode": "ATM", "cwd": "R:/repo", "title": null, "mode": "auto", "agentId": "codex",
        "displayName": "codex", "clientKind": "generic", "parentSessionId": null, "threadId": null,
        "role": "PRIMARY", "gitBranch": null, "gitHead": null, "resume": false, "predecessorSessionId": null,
        "signals": {}, "allowProjectCreate": false, "creationReason": null,
    }));
    let fingerprint = fp::kernel_v1(&legacy).unwrap();
    w.svc
        .store()
        .write(move |tx| {
            tx.execute(
                "INSERT INTO idempotency_receipts (scope_kind, scope_id, ns_kind, ns_id, op_id, legacy_key, legacy_class,
                     operation, fp_v, fp_family, fingerprint, receipt_json, scope_generation, created_at)
                 VALUES ('PROJECT', 'PA', 'ACTOR', 'BEGIN', 'old', 'session-begin:old', 'BEGIN', 'session.recover-or-begin', 1,
                         'kernel-v1', ?1, '{\"id\":\"S1\",\"sequence\":3}', 1, ?2)",
                rusqlite::params![fingerprint, T0],
            )
        })
        .map_err(|e| format!("{e:?}"))
        .unwrap();
    let req = BeginRequest {
        op_id: Some("old".into()),
        ..begin_req("codex")
    };
    let before = w.snapshot();
    let r = w.begin(req.clone());
    assert!(r.replayed);
    assert_eq!(r.result["id"], "S1");
    assert_eq!(w.snapshot(), before);
    for other in [
        BeginRequest {
            resume: Some(Resume::Auto),
            ..req.clone()
        },
        BeginRequest {
            session: Some("SX".into()),
            ..req.clone()
        },
    ] {
        w.refused(ErrorCode::IDEMPOTENCY_CONFLICT, || {
            w.svc.begin(&agent(), other)
        });
    }
}
