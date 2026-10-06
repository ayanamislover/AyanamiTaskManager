//! 规划与项目更新的验收（peer W2 r1 P1-05；03 U14–U17、A04–A05、§5.3；00 02 C-11、01 C-18）。

mod support;

use atm_domain::error::ErrorCode;
use atm_domain::work::Operation;
use atm_service::work::{CreateItem, MilestoneRequest, ObjectiveRequest, PublishRequest, Target};
use serde_json::{Value, json};
use support::*;

fn objective(title: &str) -> ObjectiveRequest {
    ObjectiveRequest {
        title: title.into(),
        description: "说明".into(),
        definition_of_done: vec![" 验收一 ".into()],
    }
}

fn milestone(objective_id: &str, title: &str) -> MilestoneRequest {
    MilestoneRequest {
        objective_id: objective_id.into(),
        title: title.into(),
        description: String::new(),
        target_date: Some("2026-12-31".into()),
    }
}

fn publish(summary: &str) -> PublishRequest {
    PublishRequest {
        summary: summary.into(),
        ..PublishRequest::default()
    }
}

fn last_event(w: &World, expr: &str) -> Value {
    w.scalar(&format!(
        "SELECT {expr} FROM events WHERE project_id = 'PA' ORDER BY seq DESC LIMIT 1"
    ))
}

// ================= work.plan =================

/// U16 / A04：User 与 Agent 都能建 objective。新的是 ACTIVE，原来 ACTIVE 的降为 PLANNED 并加 version；
/// 事件 actor 是写入者；同 op_id 同请求重放零写入，不同请求冲突。
#[test]
fn work_plan_objectives() {
    let w = world("pl-objective");
    let t = Target::new("PA", None, "obj-1");
    let r = w
        .svc
        .create_objective(&user(), &t, objective(" 新目标 "))
        .unwrap();
    let id = r.result["id"].as_str().unwrap().to_owned();
    assert_eq!(
        (
            r.result["title"].clone(),
            r.result["status"].clone(),
            r.result["localNo"].clone()
        ),
        (json!("新目标"), json!("ACTIVE"), json!(3))
    );
    assert_eq!(
        w.scalar(&format!(
            "SELECT definition_of_done_json FROM objectives WHERE id = '{id}'"
        )),
        "[\"验收一\"]"
    );
    assert_eq!(
        (
            w.scalar("SELECT status FROM objectives WHERE id = 'O1'"),
            w.count("SELECT version FROM objectives WHERE id = 'O1'")
        ),
        (json!("PLANNED"), 1)
    );
    assert_eq!(
        last_event(&w, "actor_type || ':' || actor_id || ':' || type"),
        "USER:USER:objective.created"
    );
    let before = w.snapshot();
    let again = w
        .svc
        .create_objective(&user(), &t, objective(" 新目标 "))
        .unwrap();
    assert!(again.replayed);
    assert_eq!(again.result, r.result);
    assert_eq!(w.snapshot(), before);
    w.refused(ErrorCode::IDEMPOTENCY_CONFLICT, || {
        w.svc.create_objective(&user(), &t, objective("别的目标"))
    });

    let a = w
        .svc
        .create_objective(&agent(), &w.target(Some("S1")), objective("Agent 的目标"))
        .unwrap();
    assert_eq!(a.result["localNo"], 4);
    assert_eq!(last_event(&w, "actor_id || ':' || session_id"), "claude:S1");
    assert_eq!(
        w.scalar(&format!("SELECT status FROM objectives WHERE id = '{id}'")),
        "PLANNED"
    );
}

/// A04 反例（00 02 C-11、03 §5.3）：Agent 没有 session、op_id 为空、参数不合法、目标不存在或已关闭、
/// 垃圾箱项目——都零写入，计数器不前进。
#[test]
fn work_plan_refusals_write_nothing() {
    let w = world("pl-objective-no");
    w.refused(ErrorCode::SESSION_REQUIRED, || {
        w.svc
            .create_objective(&agent(), &w.target(None), objective("x"))
    });
    w.refused(ErrorCode::INVALID_ARGUMENT, || {
        w.svc
            .create_objective(&agent(), &Target::new("PA", Some("S1"), ""), objective("x"))
    });
    for bad in [
        objective("  "),
        objective(&"长".repeat(401)),
        ObjectiveRequest {
            definition_of_done: vec!["".into()],
            ..objective("x")
        },
        ObjectiveRequest {
            definition_of_done: vec!["一".into(); 51],
            ..objective("x")
        },
        ObjectiveRequest {
            description: "长".repeat(20_001),
            ..objective("x")
        },
    ] {
        w.refused(ErrorCode::INVALID_ARGUMENT, || {
            w.svc
                .create_objective(&user(), &w.target(None), bad.clone())
        });
    }
    for bad in [
        milestone(" ", "x"),
        milestone("O1", ""),
        MilestoneRequest {
            target_date: Some("2026-13-01".into()),
            ..milestone("O1", "x")
        },
    ] {
        w.refused(ErrorCode::INVALID_ARGUMENT, || {
            w.svc
                .create_milestone(&user(), &w.target(None), bad.clone())
        });
    }
    w.refused(ErrorCode::OBJECTIVE_NOT_FOUND, || {
        w.svc
            .create_milestone(&user(), &w.target(None), milestone("NOPE", "x"))
    });
    // 01 C-18：不能挂到 DONE 的 objective 下。
    let e = w.refused(ErrorCode::PLANNING_TARGET_CLOSED, || {
        w.svc
            .create_milestone(&agent(), &w.target(Some("S1")), milestone("OD", "x"))
    });
    assert_eq!(e.details["status"], "DONE");
    // 垃圾箱项目（04 L-008）。
    w.exec("UPDATE projects SET lifecycle = 'TRASHED' WHERE id = 'PE'");
    w.refused(ErrorCode::PROJECT_DB_UNAVAILABLE, || {
        w.svc
            .create_objective(&user(), &Target::new("PE", None, "x"), objective("x"))
    });
}

/// U17 / A05：milestone 挂在 objective 下，排序键取项目内最大值 + 1000；建好后任务可以挂上去。
#[test]
fn work_plan_milestones() {
    let w = world("pl-milestone");
    let t = Target::new("PA", Some("S1"), "ms-1");
    let r = w
        .svc
        .create_milestone(&agent(), &t, milestone(" O1 ", " 第二阶段 "))
        .unwrap();
    let id = r.result["id"].as_str().unwrap().to_owned();
    assert_eq!(
        (
            r.result["objectiveId"].clone(),
            r.result["title"].clone(),
            r.result["localNo"].clone()
        ),
        (json!("O1"), json!("第二阶段"), json!(3))
    );
    assert_eq!(
        w.scalar(&format!(
            "SELECT sort_key || ':' || target_date FROM milestones WHERE id = '{id}'"
        )),
        "2000:2026-12-31"
    );
    let again = w
        .svc
        .create_milestone(&agent(), &t, milestone("O1", "第二阶段"))
        .unwrap();
    assert!(again.replayed);
    w.refused(ErrorCode::IDEMPOTENCY_CONFLICT, || {
        w.svc
            .create_milestone(&agent(), &t, milestone("O1", "第三阶段"))
    });
    let created = w
        .create_as(
            &agent(),
            Some("S1"),
            vec![CreateItem {
                objective_id: Some("O1".into()),
                milestone_id: Some(Some(id.clone())),
                ..item("挂到新里程碑")
            }],
        )
        .unwrap();
    let key = created.result["items"][0]["key"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(w.col(&key, "milestone_id"), json!(id));
}

// ================= project_update =================

/// U14 / U15 + 03 §5.3：草稿与发布只有 User；Agent 调用 403 且零写入。
#[test]
fn project_updates_are_user_only() {
    let w = world("pu-agent");
    w.refused(ErrorCode::USER_AUTHORIZATION_REQUIRED, || {
        w.svc.draft_project_update(&agent(), &w.target(Some("S1")))
    });
    w.refused(ErrorCode::USER_AUTHORIZATION_REQUIRED, || {
        w.svc
            .publish_project_update(&agent(), &w.target(Some("S1")), publish("周报"))
    });
}

/// U14：草稿按 2.x 汇总——上次发布之后完成的任务、当前阻塞 / 等待、排在前面的待办；health 取项目当前值。
/// U15：带草稿 id 发布时草稿行就地转为 PUBLISHED，序号区间沿用草稿，没给的列表取草稿里的；项目 health 跟着改。
#[test]
fn project_update_draft_then_publish() {
    let w = world("pu-draft");
    let done = w.task("做完的");
    w.s1(p(&done, Operation::Start)).unwrap();
    w.s1(p(&done, Operation::Complete)).unwrap();
    let blocked = w.task("卡住的");
    w.s1(block(&blocked, "等接口")).unwrap();
    w.task("下一个");
    let t = Target::new("PA", None, "draft-1");
    let d = w.svc.draft_project_update(&user(), &t).unwrap();
    let draft_id = d.result["id"].as_str().unwrap().to_owned();
    assert_eq!(d.result["status"], "DRAFT");
    assert_eq!(d.result["completed"], json!(["做完的"]));
    assert_eq!(d.result["risks"], json!(["等接口"]));
    assert_eq!(d.result["next"], json!(["下一个"]));
    assert_eq!(d.result["summary"], "完成 1 项；存在 1 项风险");
    assert_eq!(d.result["from_sequence"], 0);
    let to = d.result["to_sequence"].clone();
    assert_eq!(last_event(&w, "type"), "project.update.drafted");
    // 重放零写入。
    let before = w.snapshot();
    assert!(w.svc.draft_project_update(&user(), &t).unwrap().replayed);
    assert_eq!(w.snapshot(), before);

    let t = Target::new("PA", None, "publish-1");
    let r = w
        .svc
        .publish_project_update(
            &user(),
            &t,
            PublishRequest {
                draft_id: Some(draft_id.clone()),
                health: Some("at_risk".into()),
                next: Some(vec![" 改过的下一步 ".into()]),
                ..publish(" 本周小结 ")
            },
        )
        .unwrap();
    assert_eq!(r.result["id"], json!(draft_id));
    assert_eq!(r.result["status"], "PUBLISHED");
    assert_eq!(r.result["summary"], "本周小结");
    assert_eq!(r.result["health"], "AT_RISK");
    assert_eq!(r.result["completed"], json!(["做完的"]));
    assert_eq!(r.result["next"], json!(["改过的下一步"]));
    assert_eq!(r.result["to_sequence"], to);
    assert_eq!(r.result["unlinked"], true);
    assert_eq!(r.result["open_work_item_count"], 2);
    assert_eq!(w.count("SELECT count(*) FROM project_updates"), 1);
    assert_eq!(
        (
            w.scalar("SELECT health FROM projects WHERE id = 'PA'"),
            w.count("SELECT meta_version FROM projects WHERE id = 'PA'")
        ),
        (json!("AT_RISK"), 1)
    );
    assert_eq!(last_event(&w, "type"), "project.update.published");
    // 已发布的不再是草稿。
    w.refused(ErrorCode::PROJECT_UPDATE_DRAFT_NOT_FOUND, || {
        w.svc.publish_project_update(
            &user(),
            &w.target(None),
            PublishRequest {
                draft_id: Some(draft_id.clone()),
                ..publish("再发一次")
            },
        )
    });
    // 直接发布：新的一条，起点是上一次发布的终点。
    let direct = w
        .svc
        .publish_project_update(&user(), &w.target(None), publish("直接发"))
        .unwrap();
    assert_eq!(direct.result["from_sequence"], to);
    assert_eq!(direct.result["health"], "UNKNOWN");
    assert_eq!(direct.result["unlinked"], false);
}

/// U15 反例：参数不合法、草稿不存在、同 op_id 不同请求——都零写入；同请求重放拿回原结果。
#[test]
fn project_update_refusals_write_nothing() {
    let w = world("pu-no");
    for bad in [
        publish("  "),
        PublishRequest {
            health: Some("GREEN".into()),
            ..publish("x")
        },
        PublishRequest {
            risks: Some(vec!["".into()]),
            ..publish("x")
        },
        PublishRequest {
            next: Some(vec!["n".into(); 21]),
            ..publish("x")
        },
        publish(&"长".repeat(501)),
    ] {
        w.refused(ErrorCode::INVALID_ARGUMENT, || {
            w.svc
                .publish_project_update(&user(), &w.target(None), bad.clone())
        });
    }
    w.refused(ErrorCode::PROJECT_UPDATE_DRAFT_NOT_FOUND, || {
        w.svc.publish_project_update(
            &user(),
            &w.target(None),
            PublishRequest {
                draft_id: Some("NOPE".into()),
                ..publish("x")
            },
        )
    });
    let t = Target::new("PA", None, "pub");
    let first: Value = w
        .svc
        .publish_project_update(&user(), &t, publish("一"))
        .unwrap()
        .result;
    let before = w.snapshot();
    let again = w
        .svc
        .publish_project_update(&user(), &t, publish("一"))
        .unwrap();
    assert!(again.replayed);
    assert_eq!(again.result, first);
    assert_eq!(w.snapshot(), before);
    w.refused(ErrorCode::IDEMPOTENCY_CONFLICT, || {
        w.svc.publish_project_update(&user(), &t, publish("二"))
    });
}
