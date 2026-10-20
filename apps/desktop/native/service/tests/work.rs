//! 工作项服务的验收（W2c；01 §1–3、§5，00 C-01～C-29 中的工作项条目，10 R1、R2、R11 P1-1、P1-5）。
//!
//! 每种操作至少一个成功例与一个拒绝例；拒绝一律按整库逐表逐行快照核对零变化。用例名带规则编号，
//! 追溯表见 `SERVICE-NOTES.md`。

use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::work::{Operation, Status};
use atm_service::fp::{self, JsValue};
use atm_service::work::{CreateItem, EditFields, ExpectedFields, NewChecklist, PatchItem, Target};
use atm_service::write::Written;
use rusqlite::params;
use serde_json::{Value, json};

mod support;

use support::*;

// ================= 创建 =================

/// 00 C-01（版本 1）、R11 P1-5（默认 READY）、R11 P1-4（client_ref 默认序号）、W-080（回执）。
#[test]
fn c01_p1_5_create_defaults_to_ready_at_version_one() {
    let w = world("create-defaults");
    let r = w
        .create_as(&agent(), Some("S1"), vec![item("第一条"), item("第二条")])
        .unwrap();
    let items = r.result["items"].as_array().unwrap();
    assert_eq!(items[0]["key"], "ATM-T-0001");
    assert_eq!(items[1]["key"], "ATM-T-0002");
    for v in items {
        assert_eq!(v["status"], "READY");
        assert_eq!(v["version"], 1);
        assert_eq!(
            v["milestoneId"], "M1",
            "default milestone of the objective (W-071)"
        );
    }
    assert_eq!(
        r.result["refs"],
        json!({ "1": "ATM-T-0001", "2": "ATM-T-0002" })
    );
    assert_eq!(r.result["planningRootProvisioned"], false);
    assert_eq!(w.events("ATM-T-0001"), ["work.created"]);
    assert!(r.result["sequence"].as_i64().unwrap() >= 2);
}

/// 00 C-17：公开入口只能建 BACKLOG / READY。
#[test]
fn c17_public_create_refuses_other_states() {
    let w = world("create-c17");
    let e = w.refused(ErrorCode::INVALID_ARGUMENT, || {
        w.create_as(
            &agent(),
            Some("S1"),
            vec![CreateItem {
                status: Some(Status::Done),
                ..item("直接完成")
            }],
        )
    });
    assert_eq!(e.details["allowed"], json!(["BACKLOG", "READY"]));
    let r = w
        .create_as(
            &agent(),
            Some("S1"),
            vec![CreateItem {
                status: Some(Status::Backlog),
                ..item("待整理")
            }],
        )
        .unwrap();
    assert_eq!(r.result["items"][0]["status"], "BACKLOG");
}

/// W-071：Agent 入口补建规划根；界面入口报 OBJECTIVE_REQUIRED，不留补建物。
#[test]
fn w071_planning_root_is_provisioned_for_agents_only() {
    let w = world("create-root");
    let target = |s: Option<&str>| Target::new("PE", s, w.next_op());
    let no_objective = || {
        vec![CreateItem {
            title: "x".into(),
            ..CreateItem::default()
        }]
    };
    let before = w.snapshot();
    let e = w
        .svc
        .create_work_items(&user(), &target(None), no_objective())
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::OBJECTIVE_REQUIRED);
    assert_eq!(w.snapshot(), before);
    // 第二条引用不存在的父：整批失败，也不留补建的 objective / milestone（D09）。
    let bad = vec![
        CreateItem {
            title: "a".into(),
            ..CreateItem::default()
        },
        CreateItem {
            title: "b".into(),
            parent_key: Some("EMP-T-0099".into()),
            ..CreateItem::default()
        },
    ];
    let e = w
        .svc
        .create_work_items(&agent(), &target(Some("EX")), bad)
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::WORK_ITEM_NOT_FOUND);
    assert_eq!(w.snapshot(), before);
    let r = w
        .svc
        .create_work_items(&agent(), &target(Some("EX")), no_objective())
        .unwrap();
    assert_eq!(r.result["planningRootProvisioned"], true);
    assert_eq!(
        r.result["items"][0]["key"], "EMP-T-0001",
        "numbers are not consumed by failed batches"
    );
    assert_eq!(
        w.count("SELECT count(*) FROM objectives WHERE project_id = 'PE'"),
        1
    );
    assert_eq!(
        w.scalar("SELECT title FROM objectives WHERE project_id = 'PE'"),
        "空项目（自动补建）"
    );
    assert_eq!(
        w.scalar("SELECT title FROM milestones WHERE project_id = 'PE'"),
        "执行"
    );
    // S-091：补建规划根也记事件。
    assert_eq!(
        w.scalar(
            "SELECT group_concat(type || '/' || aggregate_type, ' ') FROM
               (SELECT type, aggregate_type FROM events WHERE project_id = 'PE' ORDER BY seq)"
        ),
        "objective.created/OBJECTIVE milestone.created/MILESTONE work.created/WORK_ITEM"
    );
}

/// W-072 + 00 C-18。
#[test]
fn w072_c18_objective_and_milestone_are_checked() {
    let w = world("create-planning");
    let e = w.refused(ErrorCode::MILESTONE_OBJECTIVE_MISMATCH, || {
        w.create_as(
            &agent(),
            Some("S1"),
            vec![CreateItem {
                milestone_id: Some(Some("M2".into())),
                ..item("x")
            }],
        )
    });
    assert_eq!(e.details["actual_objective_id"], "OD");
    w.refused(ErrorCode::PLANNING_TARGET_CLOSED, || {
        w.create_as(
            &agent(),
            Some("S1"),
            vec![CreateItem {
                objective_id: Some("OD".into()),
                ..item("x")
            }],
        )
    });
    w.refused(ErrorCode::OBJECTIVE_NOT_FOUND, || {
        w.create_as(
            &agent(),
            Some("S1"),
            vec![CreateItem {
                objective_id: Some("NOPE".into()),
                ..item("x")
            }],
        )
    });
    let r = w
        .create_as(
            &agent(),
            Some("S1"),
            vec![CreateItem {
                milestone_id: Some(None),
                ..item("x")
            }],
        )
        .unwrap();
    assert_eq!(r.result["items"][0]["milestoneId"], Value::Null);
}

/// W-073～W-076：批内引用可以向前，结果与顺序无关；环与重复 client_ref 整批拒绝。
#[test]
fn w073_w076_batch_references_and_cycles() {
    let w = world("create-refs");
    let r = w
        .create_as(
            &agent(),
            Some("S1"),
            vec![
                CreateItem {
                    client_ref: Some("c".into()),
                    parent_ref: Some("p".into()),
                    depends_on_refs: vec!["a".into()],
                    ..item("子")
                },
                CreateItem {
                    client_ref: Some("p".into()),
                    ..item("父")
                },
                CreateItem {
                    client_ref: Some("a".into()),
                    ..item("前置")
                },
            ],
        )
        .unwrap();
    assert_eq!(r.result["items"][0]["parentKey"], "ATM-T-0002");
    assert_eq!(
        w.count("SELECT count(*) FROM work_item_relations WHERE relation_type = 'BLOCKS'"),
        1
    );
    w.refused(ErrorCode::DEPENDENCY_CYCLE, || {
        w.create_as(
            &agent(),
            Some("S1"),
            vec![
                CreateItem {
                    client_ref: Some("a".into()),
                    depends_on_refs: vec!["b".into()],
                    ..item("a")
                },
                CreateItem {
                    client_ref: Some("b".into()),
                    depends_on_refs: vec!["a".into()],
                    ..item("b")
                },
            ],
        )
    });
    w.refused(ErrorCode::HIERARCHY_CYCLE, || {
        w.create_as(
            &agent(),
            Some("S1"),
            vec![
                CreateItem {
                    client_ref: Some("a".into()),
                    parent_ref: Some("b".into()),
                    ..item("a")
                },
                CreateItem {
                    client_ref: Some("b".into()),
                    parent_ref: Some("a".into()),
                    ..item("b")
                },
            ],
        )
    });
    w.refused(ErrorCode::VALIDATION_ERROR, || {
        w.create_as(
            &agent(),
            Some("S1"),
            vec![
                CreateItem {
                    client_ref: Some("a".into()),
                    ..item("a")
                },
                CreateItem {
                    client_ref: Some("a".into()),
                    ..item("b")
                },
            ],
        )
    });
    w.refused(ErrorCode::PARENT_REF_NOT_FOUND, || {
        w.create_as(
            &agent(),
            Some("S1"),
            vec![CreateItem {
                parent_ref: Some("zz".into()),
                ..item("a")
            }],
        )
    });
    w.refused(ErrorCode::DEPENDENCY_REF_NOT_FOUND, || {
        w.create_as(
            &agent(),
            Some("S1"),
            vec![CreateItem {
                depends_on_refs: vec!["zz".into()],
                ..item("a")
            }],
        )
    });
    let e = w.refused(ErrorCode::VALIDATION_ERROR, || {
        w.create_as(
            &agent(),
            Some("S1"),
            vec![CreateItem {
                depends_on: vec!["ATM-T-0003".into(), "atm-t-3".into()],
                ..item("a")
            }],
        )
    });
    assert_eq!(e.details["issue"], "duplicate");
}

/// 00 C-01 + C-02：新任务都是 v1；已存在的父只在派生值确实变化时加一，整批只加一次（C-21）。
#[test]
fn c01_c02_create_versions() {
    let w = world("create-versions");
    let r = w
        .create_as(
            &agent(),
            Some("S1"),
            vec![
                CreateItem {
                    client_ref: Some("c".into()),
                    parent_ref: Some("p".into()),
                    ..item("C")
                },
                CreateItem {
                    client_ref: Some("p".into()),
                    parent_ref: Some("g".into()),
                    ..item("P")
                },
                CreateItem {
                    client_ref: Some("g".into()),
                    ..item("G")
                },
            ],
        )
        .unwrap();
    for v in r.result["items"].as_array().unwrap() {
        assert_eq!(v["version"], 1, "{v}");
    }
    let e = w.task("E");
    assert_eq!(w.version(&e), 1);
    w.create_as(
        &agent(),
        Some("S1"),
        vec![
            CreateItem {
                parent_key: Some(e.clone()),
                ..item("e1")
            },
            CreateItem {
                parent_key: Some(e.clone()),
                ..item("e2")
            },
        ],
    )
    .unwrap();
    assert_eq!(
        w.version(&e),
        2,
        "NONE → CHILDREN changed the derived value once"
    );
    w.create_as(
        &agent(),
        Some("S1"),
        vec![CreateItem {
            parent_key: Some(e.clone()),
            ..item("e3")
        }],
    )
    .unwrap();
    assert_eq!(
        w.version(&e),
        2,
        "CHILDREN 0 → CHILDREN 0: no version bump (C-02)"
    );
}

/// W-075：发现来源写入搜索文档。
#[test]
fn w075_discovered_from_is_searchable_but_not_blocking() {
    let w = world("create-discovered");
    let origin = w.task("来源任务");
    let r = w
        .create_as(
            &agent(),
            Some("S1"),
            vec![CreateItem {
                discovered_from: Some(origin.clone()),
                ..item("新发现")
            }],
        )
        .unwrap();
    let found = r.result["items"][0]["key"].as_str().unwrap().to_owned();
    assert_eq!(r.result["items"][0]["discoveredFrom"], origin.as_str());
    let body = w.scalar("SELECT body FROM search_docs WHERE entity_key = 'ATM-T-0001'");
    assert!(
        body.as_str()
            .unwrap()
            .contains("工作中发现 ATM-T-0002 新发现"),
        "{body}"
    );
    // W-005：不阻塞。
    w.s1(p(&found, Operation::Start)).unwrap();
    // 反例：引用自身、key 与 ref 同时给、ref 找不到。
    let one = |c: CreateItem| w.create_as(&agent(), Some("S1"), vec![c]);
    let e = w.refused(ErrorCode::VALIDATION_ERROR, || {
        one(CreateItem {
            client_ref: Some("n".into()),
            discovered_from_ref: Some("n".into()),
            ..item("自指")
        })
    });
    assert_eq!(e.details["issue"], "self_reference");
    w.refused(ErrorCode::VALIDATION_ERROR, || {
        one(CreateItem {
            discovered_from: Some(origin.clone()),
            discovered_from_ref: Some("x".into()),
            ..item("两个都给")
        })
    });
    w.refused(ErrorCode::DISCOVERED_FROM_REF_NOT_FOUND, || {
        one(CreateItem {
            discovered_from_ref: Some("nope".into()),
            ..item("找不到")
        })
    });
}

// ================= 基础操作 =================

/// W-023：claim 只占住，不开工。
#[test]
fn w023_claim_holds_without_starting() {
    let w = world("claim");
    let k = w.task("A");
    let r = w.s1(p(&k, Operation::Claim)).unwrap();
    assert_eq!(r.result["items"][0]["status"], "CLAIMED");
    assert_eq!(w.col(&k, "claimed_by_session_id"), "S1");
    assert_eq!(w.col(&k, "assignee_agent_id"), "claude");
    assert!(w.col(&k, "claim_lease_until").is_string());
    assert!(w.col(&k, "ever_claimed_at").is_string());
    assert_eq!(w.col(&k, "started_at"), Value::Null);
    assert_eq!(w.events(&k), ["work.created", "work.claimed"]);
    assert_eq!(w.session("S1", "work_state"), "WORKING");
    assert_eq!(w.session("S1", "current_work_item_id"), w.col(&k, "id"));
}

/// W-024 + 00 C-11、C-29：前置未完成时 claim / start 拒绝，列出全部未就绪前置；已取消的前置给出路。
#[test]
fn w024_c11_c29_dependencies_must_be_done() {
    let w = world("deps");
    let a = w.task("A");
    let b = w.task("B");
    let c = w
        .create_as(
            &agent(),
            Some("S1"),
            vec![CreateItem {
                depends_on: vec![a.clone(), b.clone()],
                ..item("C")
            }],
        )
        .unwrap()
        .result["items"][0]["key"]
        .as_str()
        .unwrap()
        .to_owned();
    let e = w.refused(ErrorCode::DEPENDENCY_NOT_READY, || {
        w.s1(p(&c, Operation::Claim))
    });
    assert_eq!(e.details["dependencies"].as_array().unwrap().len(), 2);
    assert_eq!(e.details["dependencies"][0]["task_key"], a.as_str());
    w.patch_as(&user(), None, vec![p(&b, Operation::Cancel).version(1)])
        .unwrap();
    let e = w.refused(ErrorCode::DEPENDENCY_NOT_READY, || {
        w.s1(p(&c, Operation::Start))
    });
    assert!(e.message.contains("已取消"), "{}", e.message);
    assert_eq!(e.details["dependencies"][1]["cancelled"], true);
    // 正例：去掉已取消的前置、完成 A 之后，C 可以 claim / start。
    w.s1(edit(
        &c,
        1,
        EditFields {
            depends_on: Some(vec![a.clone()]),
            ..EditFields::default()
        },
    ))
    .unwrap();
    w.patch_as(&agent(), Some("SX"), vec![p(&a, Operation::Complete)])
        .unwrap();
    w.s1(p(&c, Operation::Claim)).unwrap();
    w.s1(p(&c, Operation::Start)).unwrap();
    assert_eq!(status(&w, &c), "IN_PROGRESS");
}

/// W-025 + 10 R2：别人的有效领取挡住 claim / start；过期且带 takeover_stale 才能接管；同一 lineage 直接接手。
#[test]
fn w025_r2_claims_belong_to_the_lineage() {
    let w = world("acquire");
    let k = w.task("A");
    w.s1(p(&k, Operation::Claim)).unwrap();
    let e = w.refused(ErrorCode::TASK_ALREADY_CLAIMED, || {
        w.patch_as(
            &agent(),
            Some("SX"),
            vec![p(&k, Operation::Start).version(2)],
        )
    });
    assert_eq!(e.details["stale"], false);
    // 同一 lineage 的后继：不需要 takeover，也不需要版本（R11 P1-1）。
    w.patch_as(&agent(), Some("S2"), vec![p(&k, Operation::Start)])
        .unwrap();
    assert_eq!(w.col(&k, "claimed_by_session_id"), "S2");
    // 租约过期：不带 takeover 仍拒绝并提示；带上就接管。
    w.exec(&format!(
        "UPDATE work_items SET claim_lease_until = '{PAST}' WHERE local_no = 1"
    ));
    let e = w.refused(ErrorCode::TASK_ALREADY_CLAIMED, || {
        w.patch_as(
            &agent(),
            Some("SX"),
            vec![p(&k, Operation::Start).version(3)],
        )
    });
    assert_eq!(e.details["stale"], true);
    assert_eq!(e.details["next"]["takeover_stale"], true);
    let take = PatchItem {
        takeover_stale: true,
        ..p(&k, Operation::Start).version(3)
    };
    w.patch_as(&agent(), Some("SX"), vec![take]).unwrap();
    assert_eq!(w.col(&k, "claimed_by_session_id"), "SX");
    assert_eq!(w.col(&k, "assignee_agent_id"), "codex");
}

/// W-026：IN_PROGRESS 上的 claim 只给原 assignee 回来接手。
#[test]
fn w026_successor_reclaim() {
    let w = world("reclaim");
    let k = w.task("A");
    w.s1(p(&k, Operation::Start)).unwrap();
    // 模拟会话结束释放领取：IN_PROGRESS 保留、领取清空（会话规格）。
    w.exec("UPDATE work_items SET claimed_by_session_id = NULL, claim_lease_until = NULL WHERE local_no = 1");
    let e = w.refused(ErrorCode::INVALID_TRANSITION, || {
        w.patch_as(
            &agent(),
            Some("SX"),
            vec![p(&k, Operation::Claim).version(2)],
        )
    });
    assert!(
        !e.details["legal_operations"]
            .as_array()
            .unwrap()
            .contains(&json!("claim"))
    );
    w.patch_as(&agent(), Some("S2"), vec![p(&k, Operation::Claim)])
        .unwrap();
    assert_eq!(status(&w, &k), "IN_PROGRESS");
    assert_eq!(w.events(&k).last().unwrap(), "work.started");
}

/// W-027 + W-007：start 解除 ACTIVE 阻塞记录；started_at 只写一次。
#[test]
fn w027_start_resolves_blockers_and_keeps_started_at() {
    let w = world("start");
    let k = w.task("A");
    w.s1(p(&k, Operation::Start)).unwrap();
    let started = w.col(&k, "started_at");
    w.s1(block(&k, "等 CI")).unwrap();
    assert_eq!(
        w.count("SELECT count(*) FROM blockers WHERE status = 'ACTIVE'"),
        1,
        "C-28: block writes a blocker row"
    );
    w.s1(p(&k, Operation::Start)).unwrap();
    assert_eq!(
        w.count("SELECT count(*) FROM blockers WHERE status = 'ACTIVE'"),
        0
    );
    assert_eq!(w.col(&k, "blocked_reason"), Value::Null);
    assert_eq!(w.col(&k, "started_at"), started);
    w.s1(p(&k, Operation::Complete)).unwrap();
    let e = w.refused(ErrorCode::INVALID_TRANSITION, || {
        w.s1(p(&k, Operation::Start))
    });
    assert_eq!(e.details["current_status"], "DONE");
}

/// W-028 + 00 C-06、C-08：release 的归属与效果。
#[test]
fn w028_c06_c08_release() {
    let w = world("release");
    let k = w.task("A");
    w.s1(p(&k, Operation::Start)).unwrap();
    w.s1(block(&k, "卡住")).unwrap();
    w.refused(ErrorCode::CLAIM_OWNER_REQUIRED, || {
        w.patch_as(
            &agent(),
            Some("SX"),
            vec![p(&k, Operation::Release).version(3)],
        )
    });
    w.refused(ErrorCode::CLAIM_OWNER_REQUIRED, || {
        w.patch_as(&user(), None, vec![p(&k, Operation::Release).version(3)])
    });
    w.s1(p(&k, Operation::Release)).unwrap();
    assert_eq!(status(&w, &k), "READY");
    assert_eq!(w.col(&k, "claimed_by_session_id"), Value::Null);
    assert_eq!(w.col(&k, "assignee_agent_id"), Value::Null);
    assert_eq!(w.col(&k, "blocked_reason"), Value::Null, "C-06");
    assert_eq!(
        w.count("SELECT count(*) FROM blockers WHERE status = 'ACTIVE'"),
        0,
        "C-06"
    );
    assert_eq!(w.session("S1", "work_state"), "IDLE");
    // C-08：Agent 可以 release 无人领取的任务（IN_PROGRESS 但领取已清空）。
    let m = w.task("M");
    w.s1(p(&m, Operation::Start)).unwrap();
    w.exec("UPDATE work_items SET claimed_by_session_id = NULL, claim_lease_until = NULL WHERE local_no = 2");
    w.patch_as(
        &agent(),
        Some("SX"),
        vec![p(&m, Operation::Release).version(2)],
    )
    .unwrap();
    assert_eq!(status(&w, &m), "READY");
}

/// W-029：ready 不碰领取、不碰会话。
#[test]
fn w029_ready_has_no_side_effects() {
    let w = world("ready");
    let k = w
        .create_as(
            &agent(),
            Some("S1"),
            vec![CreateItem {
                status: Some(Status::Backlog),
                ..item("A")
            }],
        )
        .unwrap()
        .result["items"][0]["key"]
        .as_str()
        .unwrap()
        .to_owned();
    let session_version = w.session("S1", "version");
    w.s1(p(&k, Operation::Ready).version(1)).unwrap();
    assert_eq!(status(&w, &k), "READY");
    assert_eq!(w.col(&k, "claimed_by_session_id"), Value::Null);
    assert_eq!(w.session("S1", "version"), session_version);
    assert_eq!(w.events(&k).last().unwrap(), "work.readied");
    w.s1(p(&k, Operation::Claim)).unwrap();
    w.refused(ErrorCode::INVALID_TRANSITION, || {
        w.s1(p(&k, Operation::Ready))
    });
}

/// W-030 + 00 C-28：block 写原因并建阻塞记录；原因为空拒绝。
#[test]
fn w030_c28_block() {
    let w = world("block");
    let k = w.task("A");
    w.s1(p(&k, Operation::Start)).unwrap();
    w.refused(ErrorCode::BLOCKED_REASON_REQUIRED, || {
        w.s1(block(&k, "   "))
    });
    let r = w.s1(block(&k, "  等依赖库发版 ")).unwrap();
    assert_eq!(r.result["items"][0]["status"], "BLOCKED");
    assert_eq!(w.col(&k, "blocked_reason"), "等依赖库发版");
    assert_eq!(w.col(&k, "claimed_by_session_id"), "S1", "the claim stays");
    assert_eq!(w.scalar("SELECT title FROM blockers"), "等依赖库发版");
    assert_eq!(w.session("S1", "work_state"), "WAITING");
    // BLOCKED 上的 complete：完成门里有 ACTIVE blocker，并提示先 start（R11 P1-1 不自动补）。
    let e = w.refused(ErrorCode::COMPLETION_GATE_FAILED, || {
        w.s1(p(&k, Operation::Complete))
    });
    let codes: Vec<&str> = e.details["reasons"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["code"].as_str().unwrap())
        .collect();
    assert_eq!(codes, ["BLOCKER_ACTIVE", "CURRENT_STATE_INVALID"]);
    assert_eq!(e.details["reasons"][0]["blocker_key"], "ATM-B-0001");
    assert_eq!(e.details["next"]["operation"], "start");
}

/// W-031：等待保存 phase；从 BLOCKED 进入等待是重新归类，不发 work.started。
#[test]
fn w031_waiting_keeps_the_phase() {
    let w = world("wait");
    let k = w.task("A");
    w.s1(p(&k, Operation::Start)).unwrap();
    w.s1(p(&k, Operation::Verify)).unwrap();
    w.s1(wait(&k, Operation::WaitUser, "等用户看截图")).unwrap();
    assert_eq!(
        (status(&w, &k).as_str(), w.col(&k, "phase")),
        ("WAITING_USER", json!("VERIFYING"))
    );
    w.refused(ErrorCode::INVALID_TRANSITION, || {
        w.s1(wait(&k, Operation::WaitAgent, "换个等法"))
    });
    w.s1(p(&k, Operation::Reopen).version(w.version(&k)))
        .unwrap();
    assert_eq!(
        status(&w, &k),
        "VERIFYING",
        "W-034: reopen goes back to the phase before waiting"
    );
    w.s1(block(&k, "x")).unwrap();
    let starts_before = w.events(&k).iter().filter(|e| *e == "work.started").count();
    w.s1(wait(&k, Operation::WaitAgent, "等 codex")).unwrap();
    assert_eq!(w.col(&k, "phase"), "IN_PROGRESS");
    assert_eq!(w.col(&k, "blocked_reason"), Value::Null);
    assert_eq!(
        w.events(&k).iter().filter(|e| *e == "work.started").count(),
        starts_before
    );
    w.refused(ErrorCode::WAITING_FOR_REQUIRED, || {
        w.s1(wait(&k, Operation::WaitAgent, ""))
    });
}

/// W-032 + 00 C-03、C-24：complete 过门；终态清掉领取，来源写 NONE。
#[test]
fn w032_c03_c24_complete() {
    let w = world("complete");
    let r = w
        .create_as(
            &agent(),
            Some("S1"),
            vec![CreateItem {
                checklist: vec![NewChecklist {
                    title: "测试".into(),
                    ..NewChecklist::default()
                }],
                ..item("A")
            }],
        )
        .unwrap();
    let k = r.result["items"][0]["key"].as_str().unwrap().to_owned();
    w.s1(p(&k, Operation::Start)).unwrap();
    let e = w.refused(ErrorCode::COMPLETION_GATE_FAILED, || {
        w.s1(p(&k, Operation::Complete))
    });
    assert_eq!(e.details["reasons"][0]["code"], "CHECKLIST_INCOMPLETE");
    w.exec("UPDATE checklist_items SET status = 'DONE'");
    w.s1(p(&k, Operation::Complete)).unwrap();
    assert_eq!(status(&w, &k), "DONE");
    assert!(w.col(&k, "completed_at").is_string());
    assert_eq!(w.col(&k, "computed_progress"), json!(100.0));
    assert_eq!(w.col(&k, "progress_source"), "NONE");
    assert_eq!(w.col(&k, "claimed_by_session_id"), Value::Null, "C-03");
    assert_eq!(
        w.col(&k, "assignee_agent_id"),
        "claude",
        "C-03 keeps the assignee"
    );
    assert_eq!(w.session("S1", "work_state"), "IDLE");
}

/// W-095 + D03：开工后才加上的前置被取消，完成门照样拦下（CANCELLED 不算就绪）；前置 DONE 才放行。
#[test]
fn w095_d03_cancelled_dependencies_fail_the_completion_gate() {
    let w = world("gate-deps");
    let a = w.task("A");
    let b = w.task("B");
    let c = w.task("C");
    w.s1(p(&c, Operation::Start)).unwrap();
    let with_deps = |deps: Vec<String>| EditFields {
        depends_on: Some(deps),
        ..EditFields::default()
    };
    w.s1(edit(&c, w.version(&c), with_deps(vec![a.clone()])))
        .unwrap();
    w.patch_as(&user(), None, vec![p(&a, Operation::Cancel).version(1)])
        .unwrap();
    let e = w.refused(ErrorCode::COMPLETION_GATE_FAILED, || {
        w.s1(p(&c, Operation::Complete))
    });
    assert_eq!(e.details["reasons"][0]["code"], "DEPENDENCY_INCOMPLETE");
    assert_eq!(e.details["reasons"][0]["task_key"], a.as_str());
    assert_eq!(e.details["reasons"][0]["cancelled"], true);
    assert_eq!(status(&w, &c), "IN_PROGRESS");
    // 正对照：换成已完成的前置就能完成。
    w.patch_as(&user(), None, vec![p(&b, Operation::Complete).version(1)])
        .unwrap();
    w.s1(edit(&c, w.version(&c), with_deps(vec![b.clone()])))
        .unwrap();
    w.s1(p(&c, Operation::Complete)).unwrap();
    assert_eq!(status(&w, &c), "DONE");
}

/// R11 P1-1：complete 遇到 READY 时在同一事务里先 start，ACK 带 autoApplied。
#[test]
fn r11_p1_1_complete_auto_starts() {
    let w = world("auto-start");
    let k = w.task("A");
    let r = w.s1(p(&k, Operation::Complete)).unwrap();
    assert_eq!(
        r.result["autoApplied"],
        json!([{ "taskKey": k, "operations": ["start"] }])
    );
    assert_eq!(
        w.events(&k),
        ["work.created", "work.started", "work.completed"]
    );
    assert_eq!(r.result["items"][0]["version"], 3);
    // 依赖没就绪时报 start 的前置错误，不是笼统的完成门。
    let a = w.task("pre");
    let c = w
        .create_as(
            &agent(),
            Some("S1"),
            vec![CreateItem {
                depends_on: vec![a],
                ..item("C")
            }],
        )
        .unwrap()
        .result["items"][0]["key"]
        .as_str()
        .unwrap()
        .to_owned();
    w.refused(ErrorCode::DEPENDENCY_NOT_READY, || {
        w.s1(p(&c, Operation::Complete))
    });
}

/// W-033 + 00 C-03：cancel 的引用与自指。
#[test]
fn w033_cancel() {
    let w = world("cancel");
    let a = w.task("A");
    let b = w.task("B");
    let e = w.refused(ErrorCode::VALIDATION_ERROR, || {
        w.patch_as(
            &user(),
            None,
            vec![PatchItem {
                superseded_by: Some(Some(b.clone())),
                ..p(&b, Operation::Cancel).version(1)
            }],
        )
    });
    assert_eq!(e.details["issue"], "self_reference");
    w.refused(ErrorCode::WORK_ITEM_NOT_FOUND, || {
        w.patch_as(
            &user(),
            None,
            vec![PatchItem {
                duplicate_of: Some(Some("ATM-T-9999".into())),
                ..p(&b, Operation::Cancel).version(1)
            }],
        )
    });
    w.s1(p(&b, Operation::Start)).unwrap();
    let cancel = PatchItem {
        cancel_reason: Some(" 重复 ".into()),
        duplicate_of: Some(Some(a.to_lowercase())),
        ..p(&b, Operation::Cancel).version(2)
    };
    w.s1(cancel).unwrap();
    assert_eq!(status(&w, &b), "CANCELLED");
    assert_eq!(w.col(&b, "cancel_reason"), "重复");
    assert_eq!(w.col(&b, "duplicate_of_id"), w.col(&a, "id"));
    assert_eq!(w.col(&b, "claimed_by_session_id"), Value::Null);
    w.refused(ErrorCode::INVALID_TRANSITION, || {
        w.s1(p(&b, Operation::Cancel).version(3))
    });
}

/// W-034 + 00 C-04、C-05：reopen。
#[test]
fn w034_c04_c05_reopen() {
    let w = world("reopen");
    let k = w.task("A");
    w.s1(p(&k, Operation::Complete)).unwrap();
    w.s1(p(&k, Operation::Reopen).version(w.version(&k)))
        .unwrap();
    assert_eq!(status(&w, &k), "IN_PROGRESS");
    assert_eq!(w.col(&k, "completed_at"), Value::Null);
    assert_eq!(w.col(&k, "reported_progress"), Value::Null, "C-04");
    assert_eq!(
        w.col(&k, "computed_progress"),
        json!(0.0),
        "C-04 recomputes itself"
    );
    assert_eq!(
        w.version(&k),
        4,
        "the reopen itself is the only bump (C-21)"
    );
    w.refused(ErrorCode::INVALID_TRANSITION, || {
        w.s1(p(&k, Operation::Reopen).version(w.version(&k)))
    });
    let c = w.task("C");
    let cancel = PatchItem {
        cancel_reason: Some("不做了".into()),
        ..p(&c, Operation::Cancel).version(1)
    };
    w.s1(cancel).unwrap();
    w.s1(p(&c, Operation::Reopen).version(2)).unwrap();
    assert_eq!(status(&w, &c), "BACKLOG");
    assert_eq!(w.col(&c, "cancel_reason"), Value::Null, "C-05");
    let history = w.scalar(
        "SELECT payload_json FROM events WHERE type = 'work.reopened' ORDER BY seq DESC LIMIT 1",
    );
    assert!(
        history.as_str().unwrap().contains("不做了"),
        "C-05 keeps history in the event"
    );
}

/// W-035 + 00 C-13、C-14：edit 的字段、事件与搜索文档。
#[test]
fn w035_c13_c14_edit() {
    let w = world("edit");
    let k = w.task("旧标题");
    w.refused(ErrorCode::VALIDATION_ERROR, || {
        w.s1(edit(&k, 1, EditFields::default()))
    });
    w.s1(edit(
        &k,
        1,
        EditFields {
            title: Some("新标题".into()),
            description: Some("正文".into()),
            ..EditFields::default()
        },
    ))
    .unwrap();
    assert_eq!(
        w.scalar("SELECT title FROM search_docs WHERE entity_key = 'ATM-T-0001'"),
        "新标题"
    );
    let payload: Value = serde_json::from_str(
        w.scalar("SELECT payload_json FROM events WHERE type = 'work.updated'")
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(payload["title"], "新标题");
    assert_eq!(payload["previousTitle"], "旧标题");
    assert_eq!(payload["fields"], json!(["title", "description"]));
    // assignee 不影响领取（W-035）。
    w.s1(edit(
        &k,
        2,
        EditFields {
            assignee_agent_id: Some(Some("x".into())),
            ..EditFields::default()
        },
    ))
    .unwrap();
    assert_eq!(w.col(&k, "claimed_by_session_id"), Value::Null);
}

/// W-036 + W-006：改父，新旧父链都重算；挂到后代下拒绝。
#[test]
fn w036_w006_move() {
    let w = world("move");
    let p1 = w.task("P1");
    let p2 = w.task("P2");
    let t = w
        .create_as(
            &agent(),
            Some("S1"),
            vec![CreateItem {
                parent_key: Some(p1.clone()),
                ..item("T")
            }],
        )
        .unwrap()
        .result["items"][0]["key"]
        .as_str()
        .unwrap()
        .to_owned();
    w.s1(p(&t, Operation::Complete)).unwrap();
    assert_eq!(w.col(&p1, "computed_progress"), json!(99.0));
    let (v1, v2) = (w.version(&p1), w.version(&p2));
    w.s1(edit(
        &t,
        w.version(&t),
        EditFields {
            parent_key: Some(Some(p2.clone())),
            ..EditFields::default()
        },
    ))
    .unwrap();
    assert_eq!(w.col(&p1, "computed_progress"), json!(0.0));
    assert_eq!(w.col(&p2, "computed_progress"), json!(99.0));
    assert_eq!((w.version(&p1), w.version(&p2)), (v1 + 1, v2 + 1));
    assert_eq!(w.events(&t).last().unwrap(), "work.moved");
    let e = w.refused(ErrorCode::HIERARCHY_CYCLE, || {
        w.s1(edit(
            &p2,
            w.version(&p2),
            EditFields {
                parent_key: Some(Some(t.clone())),
                ..EditFields::default()
            },
        ))
    });
    assert_eq!(e.details["reason"], "PARENT_IS_DESCENDANT");
}

/// W-037 + W-004 + 00 C-15：关系整组替换，key 不区分大小写，环拒绝且原依赖不变。
#[test]
fn w037_relations() {
    let w = world("relations");
    let a = w.task("A");
    let b = w.task("B");
    let c = w.task("C");
    w.s1(edit(
        &b,
        1,
        EditFields {
            depends_on: Some(vec![a.to_lowercase()]),
            ..EditFields::default()
        },
    ))
    .unwrap();
    let e = w.refused(ErrorCode::DEPENDENCY_CYCLE, || {
        w.s1(edit(
            &a,
            1,
            EditFields {
                depends_on: Some(vec![b.clone()]),
                ..EditFields::default()
            },
        ))
    });
    assert_eq!(e.details["reason"], "REACHES_TASK");
    w.refused(ErrorCode::DEPENDENCY_CYCLE, || {
        w.s1(edit(
            &a,
            1,
            EditFields {
                depends_on: Some(vec![a.clone()]),
                ..EditFields::default()
            },
        ))
    });
    w.refused(ErrorCode::VALIDATION_ERROR, || {
        w.s1(edit(
            &c,
            1,
            EditFields {
                depends_on: Some(vec![a.clone(), a.to_lowercase()]),
                ..EditFields::default()
            },
        ))
    });
    w.s1(edit(
        &c,
        1,
        EditFields {
            discovered_from: Some(Some(a.clone())),
            ..EditFields::default()
        },
    ))
    .unwrap();
    w.refused(ErrorCode::VALIDATION_ERROR, || {
        w.s1(edit(
            &c,
            2,
            EditFields {
                discovered_from: Some(Some(c.clone())),
                ..EditFields::default()
            },
        ))
    });
    w.s1(edit(
        &c,
        2,
        EditFields {
            discovered_from: Some(None),
            ..EditFields::default()
        },
    ))
    .unwrap();
    assert_eq!(
        w.count("SELECT count(*) FROM work_item_relations WHERE relation_type = 'DISCOVERED_FROM'"),
        0
    );
    assert_eq!(w.events(&c).last().unwrap(), "work.relations_changed");
}

// ================= 版本与批次 =================

/// R11 P1-1：本 lineage 持有领取时版本可省；非 owner 必须带，缺了报 EXPECTED_VERSION_REQUIRED 并给出带版本的下一步。
#[test]
fn r11_version_is_optional_on_the_owner_path() {
    let w = world("version-optional");
    let k = w.task("A");
    w.s1(p(&k, Operation::Start)).unwrap();
    w.s1(p(&k, Operation::Verify)).unwrap();
    let e = w.refused(ErrorCode::EXPECTED_VERSION_REQUIRED, || {
        w.patch_as(&user(), None, vec![p(&k, Operation::Block)])
    });
    assert_eq!(e.details["next"]["expected_version"], 3);
    w.refused(ErrorCode::EXPECTED_VERSION_REQUIRED, || {
        w.s1(p(&k, Operation::Cancel))
    });
    w.refused(ErrorCode::EXPECTED_VERSION_REQUIRED, || {
        w.s1(edit_no_version(&k))
    });
}

fn edit_no_version(key: &str) -> PatchItem {
    PatchItem {
        edit: EditFields {
            title: Some("x".into()),
            ..EditFields::default()
        },
        ..p(key, Operation::Edit)
    }
}

/// W-041 + R11 P1-1 第 3 条：批内接力；任一条失败整批回滚。
#[test]
fn w041_batch_relay_and_rollback() {
    let w = world("batch");
    let k = w.task("A");
    let r = w
        .patch_as(
            &user(),
            None,
            vec![p(&k, Operation::Claim).version(1), p(&k, Operation::Start)],
        )
        .unwrap();
    assert_eq!(r.result["items"][1]["version"], 3);
    let k2 = w.task("B");
    let e = w.refused(ErrorCode::VERSION_CONFLICT, || {
        w.patch_as(
            &user(),
            None,
            vec![
                p(&k2, Operation::Claim).version(1),
                p(&k2, Operation::Start).version(1),
            ],
        )
    });
    assert_eq!(e.details["item_index"], 1);
    assert_eq!(e.details["key"], k2.as_str());
    assert_eq!(status(&w, &k2), "READY");
    // USER 的领取：assignee 是 USER，没有 session 与租约（W-044）。
    assert_eq!(w.col(&k, "assignee_agent_id"), "USER");
    assert_eq!(w.col(&k, "claimed_by_session_id"), Value::Null);
}

/// W-100 + W-104：两个持同一版本的写，一个成功、一个 VERSION_CONFLICT（带当前快照）。
#[test]
fn w100_concurrent_writers_one_wins() {
    let w = world("concurrent");
    let k = w.task("A");
    let results: Vec<Result<Written, DomainError>> = std::thread::scope(|s| {
        let hs: Vec<_> = ["甲", "乙"]
            .into_iter()
            .map(|title| {
                let k = k.clone();
                let w = &w;
                s.spawn(move || {
                    w.svc.patch_work_items(
                        &user(),
                        &Target::new("PA", None, format!("c-{title}")),
                        vec![edit(
                            &k,
                            1,
                            EditFields {
                                title: Some(title.into()),
                                ..EditFields::default()
                            },
                        )],
                    )
                })
            })
            .collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let ok = results.iter().filter(|r| r.is_ok()).count();
    assert_eq!(ok, 1);
    let e = results.into_iter().find_map(Result::err).unwrap();
    assert_eq!(e.code, ErrorCode::VERSION_CONFLICT);
    assert_eq!(e.details["current"]["version"], 2);
    assert!(!e.details["recent_changes"].as_array().unwrap().is_empty());
    assert!(e.code.retryable());
}

/// W-101：受限的字段级安全合并。
#[test]
fn w101_safe_merge() {
    let w = world("merge");
    let k = w.task("旧");
    w.patch_as(
        &user(),
        None,
        vec![edit(
            &k,
            1,
            EditFields {
                description: Some("B 改的".into()),
                ..EditFields::default()
            },
        )],
    )
    .unwrap();
    let merge = PatchItem {
        expected_fields: Some(ExpectedFields {
            title: Some("旧".into()),
            ..ExpectedFields::default()
        }),
        ..edit(
            &k,
            1,
            EditFields {
                title: Some("新".into()),
                ..EditFields::default()
            },
        )
    };
    let r = w.patch_as(&user(), None, vec![merge]).unwrap();
    assert_eq!(r.result["merges"][0]["fields"], json!(["title"]));
    assert_eq!(w.col(&k, "description"), "B 改的");
    assert_eq!(w.col(&k, "title"), "新");
    let stale = PatchItem {
        expected_fields: Some(ExpectedFields {
            title: Some("旧".into()),
            ..ExpectedFields::default()
        }),
        ..edit(
            &k,
            1,
            EditFields {
                title: Some("再改".into()),
                ..EditFields::default()
            },
        )
    };
    w.refused(ErrorCode::VERSION_CONFLICT, || {
        w.patch_as(&user(), None, vec![stale])
    });
    let bad = PatchItem {
        expected_fields: Some(ExpectedFields {
            title: Some("新".into()),
            ..ExpectedFields::default()
        }),
        ..edit(
            &k,
            3,
            EditFields {
                description: Some("x".into()),
                ..EditFields::default()
            },
        )
    };
    w.refused(ErrorCode::INVALID_ARGUMENT, || {
        w.patch_as(&user(), None, vec![bad])
    });
}

/// 10 R1：别人的有效领取挡住会修改任务的写入；User 不受限；过期的领取放行。
#[test]
fn r1_others_cannot_modify_a_claimed_task() {
    let w = world("r1");
    let k = w.task("A");
    w.s1(p(&k, Operation::Start)).unwrap();
    for item in [
        p(&k, Operation::Complete).version(2),
        block(&k, "x").version(2),
        edit(
            &k,
            2,
            EditFields {
                title: Some("x".into()),
                ..EditFields::default()
            },
        ),
    ] {
        let e = w.refused(ErrorCode::CLAIM_NOT_OWNED, || {
            w.patch_as(&agent(), Some("SX"), vec![item])
        });
        assert_eq!(e.details["claimed_by_session_id"], "S1");
        assert_eq!(e.details["next"]["operation"], "task_list");
    }
    // 后继属于同一 lineage：可以写，领取跟着转过去（R2）。
    w.patch_as(&agent(), Some("S2"), vec![p(&k, Operation::Verify)])
        .unwrap();
    assert_eq!(w.col(&k, "claimed_by_session_id"), "S2");
    w.patch_as(&user(), None, vec![block(&k, "用户叫停").version(3)])
        .unwrap();
    w.exec(&format!(
        "UPDATE work_items SET claim_lease_until = '{PAST}' WHERE local_no = 1"
    ));
    w.patch_as(
        &agent(),
        Some("SX"),
        vec![p(&k, Operation::Cancel).version(4)],
    )
    .unwrap();
}

/// 00 C-02：子项写入只在父的派生值确实变化时才推父版本。
#[test]
fn c02_parent_version_moves_only_when_progress_moves() {
    let w = world("c02");
    let parent = w.task("P");
    let child = w
        .create_as(
            &agent(),
            Some("S1"),
            vec![
                CreateItem {
                    parent_key: Some(parent.clone()),
                    ..item("C")
                },
                CreateItem {
                    parent_key: Some(parent.clone()),
                    ..item("D")
                },
            ],
        )
        .unwrap()
        .result["items"][0]["key"]
        .as_str()
        .unwrap()
        .to_owned();
    let v = w.version(&parent);
    w.s1(p(&child, Operation::Start)).unwrap();
    w.s1(block(&child, "x")).unwrap();
    assert_eq!(w.version(&parent), v, "progress unchanged: no bump");
    w.s1(p(&child, Operation::Start)).unwrap();
    w.s1(p(&child, Operation::Complete)).unwrap();
    assert_eq!(w.version(&parent), v + 1);
    assert_eq!(w.col(&parent, "computed_progress"), json!(50.0));
}

// ================= 幂等 =================

/// 重放不新增事件并返回原回执（W2c 验收）。
#[test]
fn replay_adds_nothing() {
    let w = world("replay");
    let k = w.task("A");
    let target = Target::new("PA", Some("S1"), "same-op");
    let first = w
        .svc
        .patch_work_items(&agent(), &target, vec![p(&k, Operation::Start)])
        .unwrap();
    let before = w.snapshot();
    let again = w
        .svc
        .patch_work_items(&agent(), &target, vec![p(&k, Operation::Start)])
        .unwrap();
    assert!(again.replayed);
    assert_eq!(again.result, first.result);
    assert_eq!(w.snapshot(), before);
    let e = w
        .svc
        .patch_work_items(&agent(), &target, vec![p(&k, Operation::Verify)])
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::IDEMPOTENCY_CONFLICT);
}

/// 转换来的 2.x 回执（kernel-v1）：同一个请求按 2.x 的 normalizedInput 重建后相同 → REPLAY。
/// 期望的 2.x 形状在这里独立手写，不经过服务的重建函数。
#[test]
fn a_converted_2x_patch_receipt_replays() {
    let w = world("v1-replay");
    let k = w.task("A");
    let legacy = JsValue::Array(vec![JsValue::object([
        ("taskKey", JsValue::str(k.as_str())),
        ("expectedVersion", JsValue::Number(1.0)),
        ("takeoverStale", JsValue::Bool(false)),
        ("operation", JsValue::str("block")),
        ("blockedReason", JsValue::str("等 CI")),
    ])]);
    let fingerprint = fp::kernel_v1(&legacy).unwrap();
    let fp2 = fingerprint.clone();
    w.svc
        .store()
        .write(move |tx| {
            tx.execute(
                "INSERT INTO idempotency_receipts (scope_kind, scope_id, ns_kind, ns_id, op_id, legacy_key, legacy_class,
                     actor_session_id, operation, fp_v, fp_family, fingerprint, receipt_json, scope_generation, created_at)
                 VALUES ('PROJECT', 'PA', 'SESSION', 'S1', 'old-op', 'S1:old-op', 'AGENT', 'S1', 'work.patch.batch', 1,
                         'kernel-v1', ?1, '{\"items\":[],\"sequence\":7}', 1, ?2)",
                params![fp2, T0],
            )
        })
        .map_err(|e| format!("{e:?}"))
        .unwrap();
    let before = w.snapshot();
    let item = PatchItem {
        blocked_reason: Some(" 等 CI ".into()),
        ..p(&k, Operation::Block).version(1)
    };
    let r = w
        .svc
        .patch_work_items(
            &agent(),
            &Target::new("PA", Some("S1"), "old-op"),
            vec![item],
        )
        .unwrap();
    assert!(r.replayed);
    assert_eq!(r.result["sequence"], 7);
    assert_eq!(w.snapshot(), before);
    // 3.0 的新语义（省略版本）在 2.x 里没有对应的请求：不是同一请求。
    let e = w
        .svc
        .patch_work_items(
            &agent(),
            &Target::new("PA", Some("S1"), "old-op"),
            vec![block(&k, "等 CI")],
        )
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::IDEMPOTENCY_CONFLICT);
}

/// 能力与会话（W2b 的流水线对工作项同样生效）。
#[test]
fn agents_need_a_session_and_users_cannot_impersonate_one() {
    let w = world("principals");
    let k = w.task("A");
    w.refused(ErrorCode::SESSION_REQUIRED, || {
        w.patch_as(&agent(), None, vec![p(&k, Operation::Start)])
    });
    w.refused(ErrorCode::INVALID_ARGUMENT, || {
        w.patch_as(&user(), Some("S1"), vec![p(&k, Operation::Start)])
    });
    w.refused(ErrorCode::WORK_ITEM_NOT_FOUND, || {
        w.s1(p("EMP-T-0001", Operation::Start))
    });
}

/// W-021：检查顺序。领取归属先于版本（本实现的取舍，见 SERVICE-NOTES）；版本先于状态机；依赖先于领取。
#[test]
fn w021_check_order() {
    let w = world("order");
    let k = w.task("A");
    w.s1(p(&k, Operation::Start)).unwrap();
    // 非领取者带着过期的版本：先告诉它领取问题，而不是让它补版本再被拒一次。
    w.refused(ErrorCode::CLAIM_NOT_OWNED, || {
        w.patch_as(
            &agent(),
            Some("SX"),
            vec![p(&k, Operation::Verify).version(1)],
        )
    });
    // DONE 的任务、版本过期：VERSION_CONFLICT，而不是 INVALID_TRANSITION。
    w.s1(p(&k, Operation::Complete)).unwrap();
    w.refused(ErrorCode::VERSION_CONFLICT, || {
        w.patch_as(&user(), None, vec![p(&k, Operation::Complete).version(1)])
    });
    // 前置未完成、任务被别人领取：DEPENDENCY_NOT_READY 先于 TASK_ALREADY_CLAIMED。
    let pre = w.task("pre");
    let c = w
        .create_as(
            &agent(),
            Some("S1"),
            vec![CreateItem {
                depends_on: vec![pre],
                ..item("C")
            }],
        )
        .unwrap()
        .result["items"][0]["key"]
        .as_str()
        .unwrap()
        .to_owned();
    w.exec("UPDATE work_items SET status = 'CLAIMED', phase = 'CLAIMED', claimed_by_session_id = 'S1', assignee_agent_id = 'claude', claim_lease_until = '2999-01-01T00:00:00.000Z' WHERE local_no = 3");
    w.refused(ErrorCode::DEPENDENCY_NOT_READY, || {
        w.patch_as(
            &agent(),
            Some("SX"),
            vec![p(&c, Operation::Start).version(1)],
        )
    });
}

/// W-038：会话效果；IDLE 只在会话当前指向这个任务时才清空。
#[test]
fn w038_session_effects() {
    let w = world("session-effects");
    let a = w.task("A");
    let b = w.task("B");
    w.s1(p(&b, Operation::Start)).unwrap();
    w.s1(p(&a, Operation::Start)).unwrap();
    assert_eq!(w.session("S1", "current_work_item_id"), w.col(&a, "id"));
    w.s1(p(&b, Operation::Complete)).unwrap();
    assert_eq!(
        w.session("S1", "current_work_item_id"),
        w.col(&a, "id"),
        "completing B leaves S1 on A"
    );
    assert_eq!(w.session("S1", "work_state"), "WORKING");
}

/// 00 C-09 / 10 R2：lineage 的写入续租，并把领取转到写入的 session。
#[test]
fn c09_r2_writes_renew_the_lease() {
    let w = world("lease");
    let k = w.task("A");
    w.s1(p(&k, Operation::Start)).unwrap();
    w.exec(&format!(
        "UPDATE work_items SET claim_lease_until = '{PAST}' WHERE local_no = 1"
    ));
    w.patch_as(&agent(), Some("S2"), vec![p(&k, Operation::Verify)])
        .unwrap();
    assert_eq!(w.col(&k, "claimed_by_session_id"), "S2");
    assert!(w.col(&k, "claim_lease_until").as_str().unwrap() > "2026-01-01");
}

/// verify 的成功例在 w031；这里是拒绝例。
#[test]
fn w020_verify_is_refused_on_closed_tasks() {
    let w = world("verify");
    let k = w.task("A");
    let r = w.s1(p(&k, Operation::Verify)).unwrap();
    assert_eq!(
        r.result["items"][0]["status"], "VERIFYING",
        "R11 P1-1: auto start then verify"
    );
    w.s1(p(&k, Operation::Complete)).unwrap();
    let e = w.refused(ErrorCode::INVALID_TRANSITION, || {
        w.patch_as(
            &user(),
            None,
            vec![p(&k, Operation::Verify).version(w.version(&k))],
        )
    });
    assert_eq!(e.details["legal_operations"], json!(["reopen", "edit"]));
}

// ================= 追溯补齐（W2h2：01 的规则与 00 §1 裁决） =================

/// W-005：discoveredFrom 只是溯源。来源还在 IN_PROGRESS，新任务照样 claim / start / complete；同时挂了 BLOCKS 的那条才被挡住。
#[test]
fn w005_discovered_from_never_blocks() {
    let w = world("discovered-free");
    let origin = w.task("来源");
    w.s1(p(&origin, Operation::Start)).unwrap();
    let r = w
        .create_as(
            &agent(),
            Some("SX"),
            vec![
                CreateItem {
                    discovered_from: Some(origin.clone()),
                    ..item("顺手发现")
                },
                CreateItem {
                    discovered_from: Some(origin.clone()),
                    depends_on: vec![origin.clone()],
                    ..item("要等来源")
                },
            ],
        )
        .unwrap();
    let key = |i: usize| r.result["items"][i]["key"].as_str().unwrap().to_owned();
    let (free, held) = (key(0), key(1));
    let sx = |item: PatchItem| w.patch_as(&agent(), Some("SX"), vec![item]);
    sx(p(&free, Operation::Claim)).unwrap();
    sx(p(&free, Operation::Start)).unwrap();
    sx(p(&free, Operation::Complete)).unwrap();
    assert_eq!(status(&w, &free), "DONE");
    assert_eq!(status(&w, &origin), "IN_PROGRESS");
    w.refused(ErrorCode::DEPENDENCY_NOT_READY, || {
        sx(p(&held, Operation::Claim))
    });
}

/// W-039：每条成功 patch 恰好一条事件；同批的事件共享 op_id、序号连续，带主体与 session；READY 上的同态 ready 也记一条。
#[test]
fn w039_one_event_per_patch_and_the_batch_shares_its_op_id() {
    let w = world("events");
    let k = w.task("A");
    let before = w.count("SELECT count(*) FROM events WHERE project_id = 'PA'");
    w.patch_as(
        &agent(),
        Some("S1"),
        vec![p(&k, Operation::Claim), p(&k, Operation::Start)],
    )
    .unwrap();
    assert_eq!(
        w.count("SELECT count(*) FROM events WHERE project_id = 'PA'"),
        before + 2
    );
    let last2 = "FROM (SELECT * FROM events WHERE project_id = 'PA' ORDER BY seq DESC LIMIT 2)";
    assert_eq!(w.count(&format!("SELECT count(DISTINCT op_id) {last2}")), 1);
    assert_eq!(w.count(&format!("SELECT max(seq) - min(seq) {last2}")), 1);
    assert_eq!(
        w.count(&format!(
            "SELECT count(*) {last2} WHERE actor_type = 'AGENT' AND actor_id = 'claude' AND session_id = 'S1'
               AND aggregate_type = 'WORK_ITEM' AND op_id IS NOT NULL"
        )),
        2
    );
    assert_eq!(w.events(&k)[1..], ["work.claimed", "work.started"]);
    let r = w.task("R");
    w.s1(p(&r, Operation::Ready).version(1)).unwrap();
    assert_eq!(w.events(&r), ["work.created", "work.readied"]);
    assert_eq!(w.version(&r), 2);
}

/// W-044：USER 可以释放别人已过期的领取；有效领取不行。
#[test]
fn w044_users_release_expired_claims_of_others() {
    let w = world("user-release");
    let k = w.task("A");
    w.s1(p(&k, Operation::Claim)).unwrap();
    w.refused(ErrorCode::CLAIM_OWNER_REQUIRED, || {
        w.patch_as(&user(), None, vec![p(&k, Operation::Release).version(2)])
    });
    w.exec(&format!(
        "UPDATE work_items SET claim_lease_until = '{PAST}' WHERE local_no = 1"
    ));
    w.patch_as(&user(), None, vec![p(&k, Operation::Release).version(2)])
        .unwrap();
    assert_eq!(status(&w, &k), "READY");
    assert_eq!(w.col(&k, "claimed_by_session_id"), Value::Null);
}

/// W-070：批次 1～50 条；clientRef 区分大小写，"a" 与 "A" 同批合法。
/// 条数越界服务层报 INVALID_ARGUMENT（与 MCP schema 拦下时同一个码；规格写的服务层兜底码是 VALIDATION_ERROR，见 SERVICE-NOTES）。
#[test]
fn w070_batch_size_and_case_sensitive_client_refs() {
    let w = world("batch-size");
    let r = w
        .create_as(
            &agent(),
            Some("S1"),
            vec![
                CreateItem {
                    client_ref: Some("a".into()),
                    ..item("小写")
                },
                CreateItem {
                    client_ref: Some("A".into()),
                    depends_on_refs: vec!["a".into()],
                    ..item("大写")
                },
            ],
        )
        .unwrap();
    assert_eq!(r.result["items"].as_array().unwrap().len(), 2);
    w.refused(ErrorCode::INVALID_ARGUMENT, || {
        w.create_as(&agent(), Some("S1"), Vec::new())
    });
    w.refused(ErrorCode::INVALID_ARGUMENT, || {
        w.create_as(
            &agent(),
            Some("S1"),
            (0..51).map(|i| item(&format!("第{i}条"))).collect(),
        )
    });
    w.create_as(
        &agent(),
        Some("S1"),
        (0..50).map(|i| item(&format!("第{i}条"))).collect(),
    )
    .unwrap();
}

/// W-077：检查项按初始形状插入（ACCEPTANCE、TODO、证据为空、版本 0）。
#[test]
fn w077_checklist_items_start_empty() {
    let w = world("create-checklist");
    w.create_as(
        &agent(),
        Some("S1"),
        vec![CreateItem {
            checklist: vec![NewChecklist {
                title: "测试".into(),
                ..NewChecklist::default()
            }],
            ..item("A")
        }],
    )
    .unwrap();
    assert_eq!(
        w.count(
            "SELECT count(*) FROM checklist_items WHERE kind = 'ACCEPTANCE' AND status = 'TODO'
               AND evidence_json = '[]' AND version = 0"
        ),
        1
    );
}

/// W-080：回执的 sequence 是最后一条 work.created 的序号；work.created 的 payload 带来源的 key。
#[test]
fn w080_create_receipt_and_created_payload() {
    let w = world("create-receipt");
    let origin = w.task("来源");
    let r = w
        .create_as(
            &agent(),
            Some("S1"),
            vec![
                CreateItem {
                    discovered_from: Some(origin.to_lowercase()),
                    ..item("甲")
                },
                item("乙"),
            ],
        )
        .unwrap();
    assert_eq!(r.result["items"][0]["key"], "ATM-T-0002");
    assert_eq!(r.result["items"][1]["key"], "ATM-T-0003");
    let last = w.scalar(
        "SELECT seq FROM events WHERE project_id = 'PA' AND type = 'work.created' ORDER BY seq DESC LIMIT 1",
    );
    assert_eq!(r.result["sequence"], last);
    let payload: Value = serde_json::from_str(
        w.scalar(
            "SELECT payload_json FROM events WHERE type = 'work.created' AND payload_json LIKE '%甲%'",
        )
        .as_str()
        .unwrap(),
    )
    .unwrap();
    assert_eq!(payload["key"], "ATM-T-0002");
    assert_eq!(payload["status"], "READY");
    assert_eq!(payload["discoveredFrom"], origin.as_str());
}

/// W-105 + W-113：完成子项推动父任务版本，旧版本 complete 父任务冲突，新版本成功；complete 写 reported=100。
#[test]
fn w105_w113_a_finished_child_stales_the_parent_version() {
    let w = world("stale-parent");
    let parent = w.task("P");
    let child = w
        .create_as(
            &agent(),
            Some("S1"),
            vec![CreateItem {
                parent_key: Some(parent.clone()),
                ..item("C")
            }],
        )
        .unwrap()
        .result["items"][0]["key"]
        .as_str()
        .unwrap()
        .to_owned();
    let held = w.version(&parent);
    w.s1(p(&child, Operation::Complete)).unwrap();
    assert_eq!(w.col(&child, "reported_progress"), json!(100.0));
    assert_eq!(w.col(&child, "computed_progress"), json!(100.0));
    assert_eq!(w.col(&parent, "computed_progress"), json!(99.0));
    assert_eq!(w.version(&parent), held + 1);
    w.refused(ErrorCode::VERSION_CONFLICT, || {
        w.patch_as(
            &user(),
            None,
            vec![p(&parent, Operation::Complete).version(held)],
        )
    });
    w.patch_as(
        &user(),
        None,
        vec![p(&parent, Operation::Complete).version(held + 1)],
    )
    .unwrap();
    assert_eq!(status(&w, &parent), "DONE");
}

/// 00 C-03：进入 DONE / CANCELLED 时清掉领取与租约，assignee 留作历史。
#[test]
fn c03_terminal_states_drop_the_claim_and_lease() {
    let w = world("c03");
    for (title, op) in [("完成", Operation::Complete), ("取消", Operation::Cancel)] {
        let k = w.task(title);
        w.s1(p(&k, Operation::Start)).unwrap();
        assert!(w.col(&k, "claim_lease_until").is_string());
        let item = PatchItem {
            cancel_reason: (op == Operation::Cancel).then(|| "不做了".into()),
            ..p(&k, op).version(2)
        };
        w.s1(item).unwrap();
        assert_eq!(w.col(&k, "claimed_by_session_id"), Value::Null, "{title}");
        assert_eq!(w.col(&k, "claim_lease_until"), Value::Null, "{title}");
        assert_eq!(w.col(&k, "assignee_agent_id"), "claude", "{title}");
    }
}

/// 00 C-05：从 CANCELLED 重开清掉 duplicate_of / superseded_by。
#[test]
fn c05_reopen_clears_duplicate_and_superseded() {
    let w = world("c05");
    let a = w.task("A");
    let b = w.task("B");
    let c = w.task("C");
    w.s1(PatchItem {
        duplicate_of: Some(Some(a.clone())),
        ..p(&b, Operation::Cancel).version(1)
    })
    .unwrap();
    w.s1(PatchItem {
        superseded_by: Some(Some(a.clone())),
        ..p(&c, Operation::Cancel).version(1)
    })
    .unwrap();
    assert!(w.col(&b, "duplicate_of_id").is_string());
    assert!(w.col(&c, "superseded_by_id").is_string());
    w.s1(p(&b, Operation::Reopen).version(2)).unwrap();
    w.s1(p(&c, Operation::Reopen).version(2)).unwrap();
    assert_eq!(w.col(&b, "duplicate_of_id"), Value::Null);
    assert_eq!(w.col(&c, "superseded_by_id"), Value::Null);
}

/// 00 C-07 / 10 R1：别人有效领取中的任务，wait_*、verify、cancel 都报 CLAIM_NOT_OWNED，details 写明领取者与未过期。
#[test]
fn c07_r1_every_state_write_respects_a_valid_claim() {
    let w = world("c07");
    let k = w.task("A");
    w.s1(p(&k, Operation::Start)).unwrap();
    for item in [
        wait(&k, Operation::WaitAgent, "等 codex").version(2),
        wait(&k, Operation::WaitUser, "等用户").version(2),
        p(&k, Operation::Verify).version(2),
        PatchItem {
            cancel_reason: Some("不做".into()),
            ..p(&k, Operation::Cancel).version(2)
        },
    ] {
        let e = w.refused(ErrorCode::CLAIM_NOT_OWNED, || {
            w.patch_as(&agent(), Some("SX"), vec![item])
        });
        assert_eq!(e.details["holder_agent_id"], "claude");
        assert_eq!(e.details["stale"], false);
        assert!(e.details["claim_lease_until"].is_string());
    }
    // 阳性对照：领取者自己可以。
    w.s1(wait(&k, Operation::WaitUser, "等用户")).unwrap();
    assert_eq!(status(&w, &k), "WAITING_USER");
}

/// 00 C-09 / 10 R2：失败的写与 REPLAY 不续租、不转移领取。
#[test]
fn c09_r2_failures_and_replays_do_not_renew() {
    let w = world("lease-no-renew");
    let k = w.task("A");
    let target = w.target(Some("S1"));
    w.svc
        .patch_work_items(&agent(), &target, vec![p(&k, Operation::Start)])
        .unwrap();
    w.exec(&format!(
        "UPDATE work_items SET claim_lease_until = '{PAST}' WHERE local_no = 1"
    ));
    // 同 lineage 的 S2 写失败（版本不对）：领取不动、租约不续。
    w.refused(ErrorCode::VERSION_CONFLICT, || {
        w.patch_as(
            &agent(),
            Some("S2"),
            vec![p(&k, Operation::Verify).version(1)],
        )
    });
    // S1 原样重放 start：REPLAY，不续租。
    let again = w
        .svc
        .patch_work_items(&agent(), &target, vec![p(&k, Operation::Start)])
        .unwrap();
    assert!(again.replayed);
    assert_eq!(w.col(&k, "claimed_by_session_id"), "S1");
    assert_eq!(w.col(&k, "claim_lease_until"), PAST);
}

/// 00 C-11：未就绪前置超过 50 条时只列 50 条、带 total 与 truncated；details 不外泄内部 id。
#[test]
fn c11_dependency_lists_are_capped_and_use_public_keys() {
    let w = world("c11-cap");
    let target = w.task("等很多前置");
    // 分 6 批建：一笔写 30 条在整套连跑、磁盘忙时会超过默认的 2 秒写预算（这条用例测的是上限，不是时序）。
    let deps: Vec<String> = (0..6)
        .flat_map(|b| {
            w.create_as(
                &agent(),
                Some("S1"),
                (0..10).map(|i| item(&format!("前置{b}-{i}"))).collect(),
            )
            .unwrap()
            .result["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v["key"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        })
        .collect();
    assert_eq!(deps.len(), 60);
    // 公开入口一次最多挂 50 条依赖，超过 50 的只会是存量数据：这里直接写关系行。
    w.exec(
        "INSERT INTO work_item_relations (project_id, source_id, target_id, relation_type, created_at)
           SELECT 'PA', s.id, t.id, 'BLOCKS', '2026-10-05T00:00:00.000Z'
             FROM work_items s, work_items t WHERE t.local_no = 1 AND s.local_no > 1",
    );
    let e = w.refused(ErrorCode::DEPENDENCY_NOT_READY, || {
        w.s1(p(&target, Operation::Claim))
    });
    assert_eq!(e.details["dependencies"].as_array().unwrap().len(), 50);
    assert_eq!(e.details["total"], 60);
    assert_eq!(e.details["truncated"], true);
    let internal = w.col(&deps[0], "id");
    assert!(
        !serde_json::to_string(&e.details)
            .unwrap()
            .contains(internal.as_str().unwrap())
    );
}

/// 00 C-14：edit 之后完整刷新搜索文档，「工作中发现」的来源说明保留。
#[test]
fn c14_edit_rebuilds_the_whole_search_document() {
    let w = world("c14");
    let origin = w.task("来源任务");
    let k = w
        .create_as(
            &agent(),
            Some("S1"),
            vec![CreateItem {
                discovered_from: Some(origin.clone()),
                description: Some("旧描述".into()),
                ..item("旧标题")
            }],
        )
        .unwrap()
        .result["items"][0]["key"]
        .as_str()
        .unwrap()
        .to_owned();
    w.s1(edit(
        &k,
        1,
        EditFields {
            title: Some("新标题".into()),
            description: Some("新描述".into()),
            ..EditFields::default()
        },
    ))
    .unwrap();
    let doc = |col: &str| {
        w.scalar(&format!(
            "SELECT {col} FROM search_docs WHERE entity_key = '{k}'"
        ))
        .as_str()
        .unwrap()
        .to_owned()
    };
    assert!(doc("title").contains("新标题"));
    let body = doc("body");
    assert!(
        body.contains("新描述") && !body.contains("旧描述"),
        "{body}"
    );
    assert!(body.contains(&format!("工作中发现于 {origin}")), "{body}");
}

/// 00 C-18：不能挂到终态的 objective 或 milestone 下；ACTIVE 的可以。
#[test]
fn c18_closed_planning_targets_are_refused() {
    let w = world("c18");
    w.exec(&format!(
        "INSERT INTO objectives (project_id, id, local_no, title, status, created_at, updated_at)
           VALUES ('PA', 'OC', 3, '取消的目标', 'CANCELLED', '{T0}', '{T0}');
         INSERT INTO milestones (project_id, id, local_no, objective_id, title, status, sort_key, created_at, updated_at) VALUES
           ('PA', 'MD', 3, 'O1', '完成的里程碑', 'DONE', 2000, '{T0}', '{T0}'),
           ('PA', 'MC', 4, 'O1', '取消的里程碑', 'CANCELLED', 3000, '{T0}', '{T0}');"
    ));
    let make = |objective: Option<&str>, milestone: Option<&str>| {
        w.create_as(
            &agent(),
            Some("S1"),
            vec![CreateItem {
                objective_id: objective.map(str::to_owned),
                milestone_id: milestone.map(|m| Some(m.to_owned())),
                ..item("x")
            }],
        )
    };
    w.refused(ErrorCode::PLANNING_TARGET_CLOSED, || make(Some("OC"), None));
    w.refused(ErrorCode::PLANNING_TARGET_CLOSED, || make(None, Some("MD")));
    w.refused(ErrorCode::PLANNING_TARGET_CLOSED, || make(None, Some("MC")));
    make(None, Some("M1")).unwrap();
}

/// W-102：expected_fields 的形状在服务层就检查（MCP schema 在 W4 是第二道）：非空、只用于 edit、
/// 与 assignee / depends_on / discovered_from 互斥——都 INVALID_ARGUMENT 且零写入。
#[test]
fn w102_expected_fields_shape_is_checked_in_the_service() {
    let w = world("w102");
    let k = w.task("旧");
    let with = |expected: ExpectedFields, fields: EditFields| PatchItem {
        expected_fields: Some(expected),
        ..edit(&k, 1, fields)
    };
    let title = || ExpectedFields {
        title: Some("旧".into()),
        ..ExpectedFields::default()
    };
    let retitle = || EditFields {
        title: Some("新".into()),
        ..EditFields::default()
    };
    let cases = vec![
        (
            "expected_fields",
            with(ExpectedFields::default(), retitle()),
        ),
        (
            "assignee_agent_id",
            with(
                title(),
                EditFields {
                    assignee_agent_id: Some(Some("claude".into())),
                    ..retitle()
                },
            ),
        ),
        (
            "depends_on",
            with(
                title(),
                EditFields {
                    depends_on: Some(Vec::new()),
                    ..retitle()
                },
            ),
        ),
        (
            "discovered_from",
            with(
                title(),
                EditFields {
                    discovered_from: Some(None),
                    ..retitle()
                },
            ),
        ),
        (
            "expected_fields",
            PatchItem {
                expected_fields: Some(title()),
                ..p(&k, Operation::Claim)
            },
        ),
    ];
    for (n, (field, item)) in cases.into_iter().enumerate() {
        let e = w.refused(ErrorCode::INVALID_ARGUMENT, || {
            w.patch_as(&user(), None, vec![item.clone()])
        });
        assert_eq!(e.details["field"], field, "{e:?}");
        // 空的 expected_fields 是因为「空」被拒，不是落到后面的「缺少比较值」。
        if n == 0 {
            assert!(e.message.contains("至少包含一个字段"), "{e:?}");
            assert!(e.details.get("missing").is_none(), "{e:?}");
        }
    }
}
