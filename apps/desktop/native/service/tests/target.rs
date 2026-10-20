//! W4f：resolve 的只读快照、带 expected_target 的目标核对（TARGET_CHANGED / SCOPE_RESTORED）、调用索引的
//! principal 映射（10 R11 A3）。

mod support;

use atm_domain::error::ErrorCode;
use atm_domain::principal::Principal;
use atm_service::backups::RestoreScope;
use atm_service::ops::Target;
use atm_service::project::{CreateProjectRequest, PathInfo};
use atm_service::quick::{QuickCreateRequest, QuickPromoteRequest};
use atm_service::receipts::ReceiptScope;
use atm_service::resolve::{ResolveRequest, Resolved};
use atm_service::session::{BeginRequest, ProjectSelector};
use atm_store::paths::path_key;
use serde_json::json;
use support::*;

fn existing(project: &str, generation: i64) -> Target {
    Target::Existing {
        scope: ReceiptScope::project(project),
        generation: Some(generation),
    }
}

fn by_code(code: &str) -> ProjectSelector {
    ProjectSelector {
        code: Some(code.into()),
        ..ProjectSelector::default()
    }
}

fn by_path(canonical: &str) -> ProjectSelector {
    ProjectSelector {
        path_key: Some(path_key(canonical)),
        canonical_path: Some(canonical.into()),
        ..ProjectSelector::default()
    }
}

fn op(operation: &str) -> ResolveRequest {
    ResolveRequest {
        operation: operation.into(),
        ..ResolveRequest::default()
    }
}

fn begin(selector: ProjectSelector, op_id: &str, expected: Option<Target>) -> BeginRequest {
    let cwd = selector.canonical_path.clone();
    BeginRequest {
        selector,
        cwd,
        op_id: Some(op_id.into()),
        expected_target: expected,
        ..BeginRequest::new("claude")
    }
}

fn generation(w: &World, code: &str) -> i64 {
    w.count(&format!(
        "SELECT scope_gen FROM projects WHERE code = '{code}'"
    ))
}

/// 按范围恢复项目（真实的备份与恢复，世代前进，scope_generations 记 RESTORED）。
fn restore(w: &World, code: &str) {
    let id = w.svc.create_manual_backup(&user()).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    w.svc
        .restore_scope(&user(), &id, RestoreScope::Project(code.into()))
        .unwrap();
}

fn trashed_project(w: &World) {
    w.exec(&format!(
        "INSERT INTO scope_generations (gen, scope_kind, scope_id, reason, epoch, created_at)
           VALUES (3, 'PROJECT', 'PT', 'CREATED', 'ET', '{T0}');
         UPDATE app_meta SET scope_gen_counter = 3;
         INSERT INTO projects (id, code, name, lifecycle, health, meta_version, scope_gen, epoch, created_at, updated_at)
           VALUES ('PT', 'TRS', '垃圾箱里的', 'TRASHED', 'UNKNOWN', 0, 3, 'ET', '{T0}', '{T0}');"
    ));
}

/// resolve 在一个只读快照里判定 session 与分支目标，整库零变化。
#[test]
fn resolve_is_read_only_and_names_the_branch() {
    let w = world("w4f-resolve");
    trashed_project(&w);
    w.exec("UPDATE agent_sessions SET client_identity = '7:9@claude-code', heartbeat_at = '2026-10-05T02:00:00.000Z' WHERE id = 'S2'");
    let before = w.snapshot();
    let a = agent();
    let resolve = |p: &Principal, r: ResolveRequest| w.svc.resolve(p, r);
    let ok = |p: &Principal, r: ResolveRequest| -> Resolved { resolve(p, r).unwrap() };

    // begin 的 ①–⑤（只读：④ 只判定「会创建」，不建项目）。
    let begin_of = |selector: ProjectSelector, mode: Option<&str>, allow: bool| ResolveRequest {
        selector,
        mode: mode.map(str::to_owned),
        allow_project_create: allow,
        ..op("session.recover-or-begin")
    };
    let r = ok(&a, begin_of(by_code("ATM"), Some("quick"), true));
    assert_eq!(
        (r.target, r.project.as_deref(), r.session),
        (existing("PA", 1), Some("ATM"), None)
    );
    assert_eq!(
        ok(&a, begin_of(by_code("TRS"), None, true)).target,
        Target::None
    );
    assert_eq!(
        ok(&a, begin_of(by_path(r"D:\New"), Some("quick"), true)).target,
        Target::None
    );
    assert_eq!(
        ok(&a, begin_of(by_path(r"D:\New"), None, true)).target,
        Target::Create
    );
    assert_eq!(
        ok(&a, begin_of(by_path(r"D:\New"), None, false)).target,
        Target::None
    );
    assert_eq!(
        resolve(&a, begin_of(by_code("NOPE"), None, true))
            .unwrap_err()
            .code,
        ErrorCode::PROJECT_NOT_FOUND
    );

    // 项目写入：显式 session 推出项目；与显式 project 不匹配时是同样的业务错误。
    let patch = |session: Option<&str>, project: Option<&str>| ResolveRequest {
        session: session.map(str::to_owned),
        project: project.map(str::to_owned),
        ..op("work.patch.batch")
    };
    let r = ok(&a, patch(Some("S1"), None));
    assert_eq!(
        (
            r.session.as_deref(),
            r.session_defaulted,
            r.project.as_deref(),
            r.target
        ),
        (Some("S1"), false, Some("ATM"), existing("PA", 1))
    );
    assert_eq!(
        resolve(&a, patch(Some("S1"), Some("EMP")))
            .unwrap_err()
            .code,
        ErrorCode::SESSION_NOT_FOUND
    );
    assert_eq!(
        resolve(&a, patch(Some("NO-SUCH"), None)).unwrap_err().code,
        ErrorCode::SESSION_NOT_FOUND
    );

    // 默认 session 只给白名单客户端；不需要 session 的 operation 不取默认值，也不报错。
    let grouped = Principal::authenticated_agent(Some("7:9@claude-code".into()));
    let r = ok(
        &grouped,
        ResolveRequest {
            single_conversation: true,
            ..patch(None, None)
        },
    );
    assert_eq!(
        (
            r.session.as_deref(),
            r.session_defaulted,
            r.project.as_deref()
        ),
        (Some("S2"), true, Some("ATM"))
    );
    let e = resolve(&grouped, patch(None, None)).unwrap_err();
    assert_eq!(e.code, ErrorCode::SESSION_REQUIRED, "{e:?}");
    assert_eq!(
        resolve(
            &a,
            ResolveRequest {
                single_conversation: true,
                ..patch(None, None)
            }
        )
        .unwrap_err()
        .code,
        ErrorCode::SESSION_REQUIRED
    );
    let r = ok(
        &grouped,
        ResolveRequest {
            single_conversation: true,
            ..op("quick.create")
        },
    );
    assert_eq!((r.session, r.target), (None, Target::None));
    let r = ok(
        &grouped,
        ResolveRequest {
            single_conversation: true,
            ..begin_of(by_code("ATM"), None, false)
        },
    );
    assert_eq!(r.session, None, "begin 不取默认 session");

    // 知识写入的目标是知识库（还没有身份时没有世代），不是作者所在的项目。
    let r = ok(
        &a,
        ResolveRequest {
            session: Some("S1".into()),
            ..op("knowledge.agent-save")
        },
    );
    assert_eq!(
        r.target,
        Target::Existing {
            scope: ReceiptScope::knowledge(""),
            generation: None
        }
    );
    assert_eq!(ok(&a, op("project.create")).target, Target::Create);
    assert_eq!(ok(&a, op("quick.promote")).target, Target::Create);
    assert_eq!(
        ok(
            &a,
            ResolveRequest {
                target_project: Some("EMP".into()),
                ..op("quick.promote")
            }
        )
        .target,
        existing("PE", 2)
    );
    assert_eq!(
        resolve(&a, op("no.such")).unwrap_err().code,
        ErrorCode::INVALID_ARGUMENT
    );
    assert_eq!(w.snapshot(), before, "resolve 写了东西");
}

/// begin 带 expected_target：已提交的同一调用照常 REPLAY；新写入按当前状态重新判定分支并对照。
#[test]
fn begin_checks_the_resolved_target() {
    let w = world("w4f-begin");
    let a = agent();
    let first = w
        .svc
        .begin(&a, begin(by_code("ATM"), "b1", Some(existing("PA", 1))))
        .unwrap();
    assert!(!first.replayed);
    restore(&w, "ATM");
    let g = generation(&w, "ATM");
    assert_ne!(g, 1);
    // 重放先于目标核对：已提交过的 b1 不会被 SCOPE_RESTORED 盖掉。
    let again = w
        .svc
        .begin(&a, begin(by_code("ATM"), "b1", Some(existing("PA", 1))))
        .unwrap();
    assert!(again.replayed);
    w.refused(ErrorCode::SCOPE_RESTORED, || {
        w.svc
            .begin(&a, begin(by_code("ATM"), "b2", Some(existing("PA", 1))))
    });
    let e = w.refused(ErrorCode::TARGET_CHANGED, || {
        w.svc
            .begin(&a, begin(by_code("ATM"), "b3", Some(existing("PE", 2))))
    });
    assert_eq!(e.details["current_target"]["scope"]["id"], json!("PA"));
    assert_eq!(e.details["expected_target"]["scope"]["id"], json!("PE"));
    w.refused(ErrorCode::TARGET_CHANGED, || {
        w.svc
            .begin(&a, begin(by_code("ATM"), "b4", Some(Target::None)))
    });
    // CREATE 的目标被别人建好：从没恢复过就接上去；恢复过就是 TARGET_CHANGED。
    w.refused(ErrorCode::TARGET_CHANGED, || {
        w.svc
            .begin(&a, begin(by_code("ATM"), "b5", Some(Target::Create)))
    });
    let adopted = w
        .svc
        .begin(&a, begin(by_code("EMP"), "b6", Some(Target::Create)))
        .unwrap();
    assert_eq!(adopted.result["project"]["code"], json!("EMP"));
    w.svc
        .begin(&a, begin(by_code("ATM"), "b7", Some(existing("PA", g))))
        .unwrap();

    // 没有匹配到项目的三个分支。
    let quick = |op_id: &str, expected| BeginRequest {
        mode: Some("quick".into()),
        allow_project_create: true,
        ..begin(by_path(r"D:\Fresh"), op_id, expected)
    };
    w.refused(ErrorCode::TARGET_CHANGED, || {
        w.svc.begin(&a, quick("q1", Some(Target::Create)))
    });
    let q = w.svc.begin(&a, quick("q2", Some(Target::None))).unwrap();
    assert_eq!(q.result["scope"], json!("quick"));
    let none = |op_id: &str, expected| begin(by_path(r"D:\Fresh"), op_id, expected);
    w.refused(ErrorCode::TARGET_CHANGED, || {
        w.svc.begin(&a, none("n1", Some(Target::Create)))
    });
    w.refused(ErrorCode::PROJECT_REQUIRED, || {
        w.svc.begin(&a, none("n2", Some(Target::None)))
    });
    let create = |op_id: &str, expected| BeginRequest {
        allow_project_create: true,
        ..begin(by_path(r"D:\Fresh"), op_id, expected)
    };
    w.refused(ErrorCode::TARGET_CHANGED, || {
        w.svc.begin(&a, create("c1", Some(Target::None)))
    });
    w.refused(ErrorCode::TARGET_CHANGED, || {
        w.svc.begin(&a, create("c2", Some(existing("PA", g))))
    });
    let made = w.svc.begin(&a, create("c3", Some(Target::Create))).unwrap();
    assert_eq!(made.result["projectCreated"], json!(true));
    // 阳性对照：不带 expected_target 的旧调用照 2.x 的规则执行。
    let plain = w
        .svc
        .begin(&a, begin(by_code("ATM"), "plain", None))
        .unwrap();
    assert!(!plain.replayed);
}

/// project.create 与 quick.promote 的目标核对；不接到别人建的项目上，也不写回执。
#[test]
fn create_and_promote_check_the_target() {
    let w = world("w4f-create");
    let a = agent();
    let mk = |code: &str, path: Option<&str>, op_id: &str, expected| CreateProjectRequest {
        code: Some(code.into()),
        path: path.map(|p| PathInfo {
            canonical_path: p.into(),
            git_common_dir: None,
        }),
        actor: Some("claude".into()),
        op_id: Some(op_id.into()),
        expected_target: expected,
        ..CreateProjectRequest::new(code)
    };
    w.svc
        .create_project(
            &a,
            mk("NEWP", Some(r"D:\Newp"), "pc1", Some(Target::Create)),
        )
        .unwrap();
    let e = w.refused(ErrorCode::TARGET_CHANGED, || {
        w.svc
            .create_project(&a, mk("NEWP", None, "pc2", Some(Target::Create)))
    });
    assert_eq!(e.details["current_target"]["kind"], json!("EXISTING"));
    w.refused(ErrorCode::TARGET_CHANGED, || {
        w.svc.create_project(
            &a,
            mk("OTHER", Some(r"D:\Newp"), "pc3", Some(Target::Create)),
        )
    });
    // 阳性对照：不带 expected_target 时是原来的业务错误。
    w.refused(ErrorCode::PROJECT_CODE_CONFLICT, || {
        w.svc.create_project(&a, mk("NEWP", None, "pc4", None))
    });

    let quick = |title: &str| -> String {
        let op = w.next_op();
        w.svc
            .quick_create(
                &user(),
                QuickCreateRequest {
                    title: title.into(),
                    ..QuickCreateRequest::default()
                },
                &op,
            )
            .unwrap()
            .result["quick"]["key"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let promote = |key: &str, target: Option<&str>, op_id: &str, expected| {
        w.svc.quick_promote(
            &a,
            key,
            QuickPromoteRequest {
                expected_version: 0,
                target_project: target.map(str::to_owned),
                actor: Some("claude".into()),
                expected_target: expected,
                ..QuickPromoteRequest::default()
            },
            op_id,
        )
    };
    let q1 = quick("晋升一");
    promote(&q1, None, "pr1", Some(Target::Create)).unwrap();
    // 别人已经把它晋升了：不接到那个项目上。
    w.refused(ErrorCode::TARGET_CHANGED, || {
        promote(&q1, None, "pr2", Some(Target::Create))
    });
    let q2 = quick("晋升二");
    w.refused(ErrorCode::TARGET_CHANGED, || {
        promote(&q2, Some("ATM"), "pr3", Some(existing("PE", 2)))
    });
    w.refused(ErrorCode::TARGET_CHANGED, || {
        promote(&q2, Some("ATM"), "pr4", Some(Target::Create))
    });
    w.refused(ErrorCode::SCOPE_RESTORED, || {
        promote(&q2, Some("ATM"), "pr5", Some(existing("PA", 99)))
    });
    let ok = promote(&q2, Some("ATM"), "pr6", Some(existing("PA", 1))).unwrap();
    assert_eq!(ok.result["quick"]["status"], json!("PROMOTED"));
}

/// 调用索引的 principal（A3 的映射表）：session 的 agent_id → actor → AGENT_ANON；User 恒为 USER。
#[test]
fn the_call_principal_follows_session_then_actor() {
    let w = world("w4f-principal");
    let a = agent();
    let principal_of = |op_id: &str| {
        w.scalar(&format!(
            "SELECT call_principal_id FROM idempotency_receipts WHERE op_id = '{op_id}'"
        ))
    };
    let mk = |name: &str, session: Option<&str>, actor: Option<&str>, op_id: &str| {
        CreateProjectRequest {
            session: session.map(str::to_owned),
            actor: actor.map(str::to_owned),
            op_id: Some(op_id.into()),
            ..CreateProjectRequest::new(name)
        }
    };
    w.svc
        .create_project(&a, mk("甲", Some("SX"), Some("someone"), "k1"))
        .unwrap();
    assert_eq!(principal_of("k1"), json!("codex"));
    w.svc
        .create_project(&a, mk("乙", None, Some("someone"), "k2"))
        .unwrap();
    assert_eq!(principal_of("k2"), json!("someone"));
    w.svc
        .create_project(&a, mk("丙", None, None, "k3"))
        .unwrap();
    assert_eq!(principal_of("k3"), json!("AGENT_ANON"));
    w.svc
        .create_project(&user(), mk("丁", None, Some("someone"), "k4"))
        .unwrap();
    assert_eq!(principal_of("k4"), json!("USER"));
    // 同一个 session 的同一个 op_id 是同一笔：换个 actor 重试照样 REPLAY。
    let again = w
        .svc
        .create_project(&a, mk("甲", Some("SX"), Some("other"), "k1"))
        .unwrap();
    assert!(again.replayed);
    w.refused(ErrorCode::SESSION_NOT_FOUND, || {
        w.svc
            .create_project(&a, mk("戊", Some("NO-SUCH"), None, "k5"))
    });

    // quick.promote：没给 actor 时用 session 的 agent 作事件 actor 与调用主体。
    let key = w
        .svc
        .quick_create(
            &user(),
            QuickCreateRequest {
                title: "带 session 的晋升".into(),
                ..QuickCreateRequest::default()
            },
            "qc",
        )
        .unwrap()
        .result["quick"]["key"]
        .as_str()
        .unwrap()
        .to_owned();
    w.svc
        .quick_promote(
            &a,
            &key,
            QuickPromoteRequest {
                expected_version: 0,
                session: Some("SX".into()),
                ..QuickPromoteRequest::default()
            },
            "qp",
        )
        .unwrap();
    assert_eq!(principal_of("qp"), json!("codex"));
}
