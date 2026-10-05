//! quick task 的验收（W2g2；04 L-013、L-015；03 C-12、C-13；10 R5、A3；C-L05）。

mod support;

use atm_domain::error::ErrorCode;
use atm_service::quick::{QuickCreateRequest, QuickPromoteRequest, QuickUpdateRequest};
use atm_service::write::Written;
use serde_json::{Value, json};
use support::*;

// ---------- 助手 ----------

fn new_quick(title: &str) -> QuickCreateRequest {
    QuickCreateRequest {
        title: title.into(),
        ..QuickCreateRequest::default()
    }
}

fn as_agent(title: &str, actor: &str) -> QuickCreateRequest {
    QuickCreateRequest {
        actor: Some(actor.into()),
        ..new_quick(title)
    }
}

impl World {
    fn quick(&self, title: &str) -> Value {
        let op = self.next_op();
        self.svc
            .quick_create(&user(), new_quick(title), &op)
            .unwrap()
            .result["quick"]
            .clone()
    }

    fn update(
        &self,
        key: &str,
        r: QuickUpdateRequest,
    ) -> Result<Written, atm_domain::error::DomainError> {
        let op = self.next_op();
        self.svc.quick_update(&user(), key, r, &op)
    }

    fn promote(
        &self,
        key: &str,
        version: i64,
        target: Option<&str>,
        op: &str,
    ) -> Result<Written, atm_domain::error::DomainError> {
        self.svc.quick_promote(
            &user(),
            key,
            QuickPromoteRequest {
                expected_version: version,
                target_project: target.map(str::to_owned),
                actor: None,
            },
            op,
        )
    }

    fn projects(&self) -> i64 {
        self.count("SELECT count(*) FROM projects")
    }

    fn items_from(&self, quick_id: &str) -> i64 {
        self.count(&format!(
            "SELECT count(*) FROM work_items WHERE source_quick_id = '{quick_id}'"
        ))
    }
}

fn update(version: i64) -> QuickUpdateRequest {
    QuickUpdateRequest {
        expected_version: version,
        ..QuickUpdateRequest::default()
    }
}

// ---------- L-013 ----------

/// L-013 ✓：创建 version 0 / OPEN；PATCH DONE → version 1、percent 100、completed_at；回执落在 GLOBAL，事件进全局流。
#[test]
fn l013_create_and_update_carry_versions() {
    let w = world("qk-l013");
    let r = w
        .svc
        .quick_create(
            &user(),
            QuickCreateRequest {
                title: "  买牛奶  ".into(),
                note: Some("两盒".into()),
                due_date: Some("2026-10-06".into()),
                source_cwd: Some("R:\\repo".into()),
                actor: Some("忽略".into()),
            },
            "q-1",
        )
        .unwrap();
    let q = &r.result["quick"];
    assert_eq!(q["key"], "Q-0001");
    assert_eq!(q["title"], "买牛奶");
    assert_eq!(q["status"], "OPEN");
    assert_eq!(q["version"], 0);
    assert_eq!(q["dueDate"], "2026-10-06");
    assert_eq!(q["sourceCwd"], "R:\\repo");
    assert_eq!(w.scalar("SELECT actor FROM quick_tasks"), "USER");
    assert_eq!(
        w.scalar(&format!(
            "SELECT scope_kind FROM idempotency_receipts WHERE receipt_id = {}",
            r.receipt_id
        )),
        "GLOBAL"
    );
    let replay = w.svc.quick_create(&user(), new_quick("买牛奶"), "q-1");
    assert_eq!(replay.unwrap_err().code, ErrorCode::IDEMPOTENCY_CONFLICT);
    let again = w
        .svc
        .quick_create(
            &user(),
            QuickCreateRequest {
                title: "买牛奶".into(),
                note: Some("两盒".into()),
                due_date: Some("2026-10-06".into()),
                source_cwd: Some("R:\\repo".into()),
                actor: None,
            },
            "q-1",
        )
        .unwrap();
    assert!(again.replayed);
    assert_eq!(w.count("SELECT count(*) FROM quick_tasks"), 1);
    assert_eq!(w.quick("第二条")["key"], "Q-0002");

    let done = w
        .update(
            "q-0001",
            QuickUpdateRequest {
                status: Some("done".into()),
                summary: Some(" 买到了 ".into()),
                ..update(0)
            },
        )
        .unwrap();
    let q = &done.result["quick"];
    assert_eq!(q["status"], "DONE");
    assert_eq!(q["version"], 1);
    assert_eq!(q["percent"], 100);
    assert_eq!(q["latestSummary"], "买到了");
    assert!(
        !w.scalar("SELECT completed_at FROM quick_tasks WHERE local_no = 1")
            .is_null()
    );
    assert_eq!(w.scalar("SELECT summary FROM quick_task_updates"), "买到了");
    let kinds: Vec<Value> = ["quick.created", "quick.updated"]
        .iter()
        .map(|k| {
            w.scalar(&format!(
                "SELECT count(*) FROM global_feed WHERE type = '{k}'"
            ))
        })
        .collect();
    assert_eq!(kinds, vec![json!(2), json!(1)]);
}

/// L-013 ✗：版本过期；没有可改字段时原样返回、不加版本；C-13 的 schema。
#[test]
fn l013_c13_update_refusals() {
    let w = world("qk-l013-x");
    w.quick("一");
    w.update(
        "Q-0001",
        QuickUpdateRequest {
            percent: Some(Some(30)),
            ..update(0)
        },
    )
    .unwrap();
    let e = w.refused(ErrorCode::VERSION_CONFLICT, || {
        w.update(
            "Q-0001",
            QuickUpdateRequest {
                percent: Some(Some(40)),
                ..update(0)
            },
        )
    });
    assert_eq!(e.details["actual"], 1);
    let same = w.update("Q-0001", update(1)).unwrap();
    assert_eq!(same.result["changed"], false);
    assert_eq!(same.result["quick"]["version"], 1);
    for (r, field) in [
        (
            QuickUpdateRequest {
                status: Some("PROMOTED".into()),
                ..update(1)
            },
            "status",
        ),
        (
            QuickUpdateRequest {
                percent: Some(Some(150)),
                ..update(1)
            },
            "percent",
        ),
        (
            QuickUpdateRequest {
                percent: Some(Some(-1)),
                ..update(1)
            },
            "percent",
        ),
        (
            QuickUpdateRequest {
                title: Some("  ".into()),
                ..update(1)
            },
            "title",
        ),
        (
            QuickUpdateRequest {
                title: Some("长".repeat(401)),
                ..update(1)
            },
            "title",
        ),
        (
            QuickUpdateRequest {
                note: Some("n".repeat(5001)),
                ..update(1)
            },
            "note",
        ),
        (
            QuickUpdateRequest {
                due_date: Some(Some("2026-13-01".into())),
                ..update(1)
            },
            "due_date",
        ),
        (
            QuickUpdateRequest {
                due_date: Some(Some("2026-1-01".into())),
                ..update(1)
            },
            "due_date",
        ),
    ] {
        let e = w.refused(ErrorCode::VALIDATION_ERROR, || w.update("Q-0001", r));
        assert_eq!(e.details["field"], field);
    }
    // 边界上的值可以写；due_date 与 percent 可以清空。
    let ok = w
        .update(
            "Q-0001",
            QuickUpdateRequest {
                percent: Some(Some(100)),
                title: Some("长".repeat(400)),
                note: Some("n".repeat(5000)),
                ..update(1)
            },
        )
        .unwrap();
    assert_eq!(ok.result["quick"]["version"], 2);
    let cleared = w
        .update(
            "Q-0001",
            QuickUpdateRequest {
                percent: Some(None),
                due_date: Some(None),
                ..update(2)
            },
        )
        .unwrap();
    assert!(cleared.result["quick"]["percent"].is_null());
    w.refused(ErrorCode::NOT_FOUND, || w.update("Q-0099", update(0)));
    w.refused(ErrorCode::VALIDATION_ERROR, || {
        w.svc.quick_create(&user(), new_quick(" "), "blank")
    });
    w.refused(ErrorCode::VALIDATION_ERROR, || {
        w.svc.quick_create(
            &user(),
            QuickCreateRequest {
                due_date: Some("明天".into()),
                ..new_quick("x")
            },
            "bad-date",
        )
    });
}

/// C-12：Agent 必须自报 actor，保留名（去空白、不分大小写）一律拒绝；自报的 actor 写进行和 ACTOR 命名空间。
#[test]
fn c12_agent_actor_is_normalized() {
    let w = world("qk-c12");
    for actor in [
        "USER",
        " user ",
        "User",
        "SYSTEM",
        "system",
        "PHONE:pixel",
        "phone:x",
        "  ",
    ] {
        let e = w.refused(ErrorCode::USER_AUTHORIZATION_REQUIRED, || {
            w.svc
                .quick_create(&agent(), as_agent("冒名", actor), "spoof")
        });
        assert_eq!(e.details["field"], "actor");
    }
    w.refused(ErrorCode::USER_AUTHORIZATION_REQUIRED, || {
        w.svc.quick_create(&agent(), new_quick("没报名"), "anon")
    });
    w.refused(ErrorCode::USER_AUTHORIZATION_REQUIRED, || {
        w.svc.quick_update(
            &agent(),
            "Q-0001",
            QuickUpdateRequest {
                actor: Some("USER".into()),
                ..update(0)
            },
            "u",
        )
    });
    let r = w
        .svc
        .quick_create(&agent(), as_agent("自己的", " claude "), "mine")
        .unwrap();
    assert_eq!(w.scalar("SELECT actor FROM quick_tasks"), "claude");
    assert_eq!(
        w.scalar(&format!(
            "SELECT ns_id FROM idempotency_receipts WHERE receipt_id = {}",
            r.receipt_id
        )),
        "AGENT:claude"
    );
    // 同一个 op_id，换一个 Agent：命名空间不同，是新写入。
    let other = w
        .svc
        .quick_create(&agent(), as_agent("自己的", "codex"), "mine")
        .unwrap();
    assert!(!other.replayed);
    // Agent 能改别人建的 quick（2.x 行为保留），actor 记的是自己。
    w.svc
        .quick_update(
            &agent(),
            "Q-0001",
            QuickUpdateRequest {
                summary: Some("看过".into()),
                actor: Some("codex".into()),
                ..update(0)
            },
            "touch",
        )
        .unwrap();
    assert_eq!(w.scalar("SELECT actor FROM quick_task_updates"), "codex");
}

// ---------- L-015 ----------

/// L-015 ✓：晋升到已有项目，工作项与 PROMOTED 标记在同一事务；重放返回同一个目标（R5 的双重绑定）。
#[test]
fn l015_promote_to_an_existing_project() {
    let w = world("qk-l015");
    let q = w.quick("修 bug");
    let id = q["id"].as_str().unwrap().to_owned();
    w.update(
        "Q-0001",
        QuickUpdateRequest {
            status: Some("IN_PROGRESS".into()),
            note: Some("细节".into()),
            ..update(0)
        },
    )
    .unwrap();
    let r = w.promote("Q-0001", 1, Some("atm"), "p-1").unwrap();
    let pq = &r.result["quick"];
    assert_eq!(pq["status"], "PROMOTED");
    assert_eq!(pq["promotedProjectId"], "PA");
    assert_eq!(pq["promotedWorkItemKey"], "ATM-T-0001");
    assert_eq!(pq["percent"], 100);
    assert_eq!(pq["promotionUndone"], false);
    assert_eq!(r.result["adopted"], false);
    assert_eq!(status(&w, "ATM-T-0001"), "IN_PROGRESS");
    assert_eq!(w.col("ATM-T-0001", "source_quick_id"), id.as_str());
    assert_eq!(w.col("ATM-T-0001", "id"), pq["promotedWorkItemId"]);
    assert_eq!(w.col("ATM-T-0001", "description"), "细节");
    assert_eq!(
        w.scalar(&format!(
            "SELECT scope_id FROM idempotency_receipts WHERE receipt_id = {}",
            r.receipt_id
        )),
        "PA"
    );
    assert_eq!(
        w.count("SELECT count(*) FROM global_feed WHERE type = 'quick.promoted'"),
        1
    );
    let replay = w.promote("Q-0001", 1, Some("ATM"), "p-1").unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.result, r.result);
    // 新的 op_id、同一目标：已晋升，原样返回，不查版本，不再建工作项。
    let again = w.promote("Q-0001", 0, Some("ATM"), "p-2").unwrap();
    assert_eq!(again.result["alreadyPromoted"], true);
    assert_eq!(w.items_from(&id), 1);
    // OPEN 的 quick 晋升出 READY。
    w.quick("二");
    w.promote("Q-0002", 0, Some("ATM"), "p-3").unwrap();
    assert_eq!(status(&w, "ATM-T-0002"), "READY");
}

/// L-015 ✗：版本冲突零写入；已晋升到 A 再请求 B 冲突；TRASHED 目标拒绝，ARCHIVED 允许。
#[test]
fn l015_promote_refusals() {
    let w = world("qk-l015-x");
    w.exec(&format!(
        "INSERT INTO scope_generations (gen, scope_kind, scope_id, reason, epoch, created_at) VALUES
           (3, 'PROJECT', 'PR', 'CREATED', 'ER', '{T0}'), (4, 'PROJECT', 'PT', 'CREATED', 'ET', '{T0}');
         UPDATE app_meta SET scope_gen_counter = 4;
         INSERT INTO projects (id, code, name, lifecycle, health, meta_version, scope_gen, epoch, created_at, updated_at) VALUES
           ('PR', 'ARC', '归档的', 'ARCHIVED', 'UNKNOWN', 0, 3, 'ER', '{T0}', '{T0}'),
           ('PT', 'TRS', '垃圾箱里的', 'TRASHED', 'UNKNOWN', 0, 4, 'ET', '{T0}', '{T0}');
         INSERT INTO counters (project_id, name, next_value) VALUES
           ('PR', 'work_item', 1), ('PR', 'record', 1), ('PR', 'objective', 1), ('PR', 'milestone', 1),
           ('PT', 'work_item', 1), ('PT', 'objective', 1), ('PT', 'milestone', 1);"
    ));
    w.quick("一");
    w.quick("二");
    w.refused(ErrorCode::VERSION_CONFLICT, || {
        w.promote("Q-0001", 3, Some("ATM"), "v")
    });
    let e = w.refused(ErrorCode::PROJECT_DB_UNAVAILABLE, || {
        w.promote("Q-0001", 0, Some("TRS"), "t")
    });
    assert_eq!(e.details["retryable"], false);
    w.refused(ErrorCode::PROJECT_NOT_FOUND, || {
        w.promote("Q-0001", 0, Some("NOPE"), "n")
    });
    w.refused(ErrorCode::NOT_FOUND, || {
        w.promote("Q-0099", 0, Some("ATM"), "q")
    });
    let arc = w.promote("Q-0001", 0, Some("ARC"), "a").unwrap();
    assert_eq!(arc.result["quick"]["promotedWorkItemKey"], "ARC-T-0001");
    assert_eq!(
        w.scalar("SELECT lifecycle FROM projects WHERE id = 'PR'"),
        "ARCHIVED"
    );
    let e = w.refused(ErrorCode::IDEMPOTENCY_CONFLICT, || {
        w.promote("Q-0001", 1, Some("ATM"), "b")
    });
    assert_eq!(e.details["promoted_project_id"], "PR");
    // 不带目标的请求对已晋升的 quick 原样返回，不建项目。
    let before = w.projects();
    let none = w.promote("Q-0001", 1, None, "c").unwrap();
    assert_eq!(none.result["alreadyPromoted"], true);
    assert_eq!(w.projects(), before);
    // Agent 也能晋升；自报 actor 进事件。
    w.svc
        .quick_promote(
            &agent(),
            "Q-0002",
            QuickPromoteRequest {
                expected_version: 0,
                target_project: Some("ATM".into()),
                actor: Some("claude".into()),
            },
            "ag",
        )
        .unwrap();
    assert_eq!(
        w.scalar("SELECT actor FROM global_feed WHERE type = 'quick.promoted' ORDER BY global_seq DESC LIMIT 1"),
        "claude"
    );
}

/// L-015 ✗（C-L05）：不带目标，重试三次只建一个项目；新项目带规划根，名字取 quick 标题。
#[test]
fn l015_untargeted_promote_creates_one_project() {
    let w = world("qk-l015-new");
    w.quick("周末搬家");
    let before = w.projects();
    let first = w.promote("Q-0001", 0, None, "new-1").unwrap();
    for _ in 0..3 {
        let again = w.promote("Q-0001", 0, None, "new-1").unwrap();
        assert!(again.replayed);
        assert_eq!(again.result, first.result);
    }
    assert_eq!(w.projects(), before + 1);
    let project = &first.result["project"];
    assert_eq!(project["name"], "周末搬家");
    let pid = project["id"].as_str().unwrap();
    assert_eq!(first.result["quick"]["promotedProjectId"], pid);
    let code = project["code"].as_str().unwrap();
    assert_eq!(
        first.result["quick"]["promotedWorkItemKey"],
        format!("{code}-T-0001")
    );
    assert_eq!(
        w.count(&format!(
            "SELECT count(*) FROM objectives WHERE project_id = '{pid}'"
        )),
        1
    );
    assert_eq!(
        w.scalar(&format!(
            "SELECT scope_id FROM idempotency_receipts WHERE receipt_id = {}",
            first.receipt_id
        )),
        pid
    );
    // 版本冲突：没有新项目，也没有新工作项。
    w.quick("二");
    w.refused(ErrorCode::VERSION_CONFLICT, || {
        w.promote("Q-0002", 7, None, "new-2")
    });
    // 同一 op_id、不同请求：冲突。
    w.refused(ErrorCode::IDEMPOTENCY_CONFLICT, || {
        w.promote("Q-0002", 0, None, "new-1")
    });
}

/// R5：目标项目里已有 source_quick_id 指向它的工作项时采用，不再新建；工作项被恢复撤销后视图标出来。
#[test]
fn r5_adopts_and_flags_undone_promotions() {
    let w = world("qk-r5");
    let q = w.quick("采用");
    let id = q["id"].as_str().unwrap().to_owned();
    let key = w.task("早就建好的");
    w.exec(&format!(
        "UPDATE work_items SET source_quick_id = '{id}' WHERE local_no = 1"
    ));
    let r = w.promote("Q-0001", 0, Some("ATM"), "adopt").unwrap();
    assert_eq!(r.result["adopted"], true);
    assert_eq!(r.result["quick"]["promotedWorkItemKey"], key);
    assert_eq!(w.items_from(&id), 1);
    w.exec("DELETE FROM work_items WHERE local_no = 1");
    let v = w.svc.quick_get(&user(), "Q-0001").unwrap();
    assert_eq!(v["promotionUndone"], true);
    assert!(w.svc.quick_get(&agent(), "q-0001").is_ok());
}
