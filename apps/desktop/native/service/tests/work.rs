//! 工作项服务的验收（W2c；01 §1–3、§5，00 C-01～C-29 中的工作项条目，10 R1、R2、R11 P1-1、P1-5）。
//!
//! 每种操作至少一个成功例与一个拒绝例；拒绝一律按整库逐表逐行快照核对零变化。用例名带规则编号，
//! 追溯表见 `SERVICE-NOTES.md`。

use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::principal::{Principal, UiSurface};
use atm_domain::work::{Operation, Status};
use atm_service::fp::{self, JsValue};
use atm_service::work::{CreateItem, EditFields, ExpectedFields, NewChecklist, PatchItem, Target};
use atm_service::write::{Service, Written};
use atm_store::{Config, Store};
use rusqlite::params;
use rusqlite::types::Value as Sql;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::time::Duration;

const T0: &str = "2026-10-05T00:00:00.000Z";
const T1: &str = "2026-10-05T01:00:00.000Z";
const PAST: &str = "2000-01-01T00:00:00.000Z";

struct World {
    svc: Service,
    op: std::sync::atomic::AtomicU32,
}

fn world(name: &str) -> World {
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
    let store = Store::open(
        &dir.join("atm.sqlite"),
        Config {
            idle_checkpoint: Duration::from_secs(3600),
            ..Config::default()
        },
    )
    .unwrap();
    store
        .write(|tx| {
            tx.execute_batch(&format!(
                "INSERT INTO app_meta (singleton, schema_version, data_root_id, generation, instance_epoch, scope_gen_counter, created_at, updated_at)
                   VALUES (1, 1, 'ROOT', 'G', 'EPOCH-1', 2, '{T0}', '{T0}');
                 INSERT INTO scope_generations (gen, scope_kind, scope_id, reason, epoch, created_at) VALUES
                   (1, 'PROJECT', 'PA', 'CREATED', 'EA', '{T0}'), (2, 'PROJECT', 'PE', 'CREATED', 'EE', '{T0}');
                 INSERT INTO projects (id, code, name, lifecycle, health, meta_version, scope_gen, epoch, created_at, updated_at)
                   VALUES ('PA', 'ATM', '任务管理', 'ACTIVE', 'ON_TRACK', 0, 1, 'EA', '{T0}', '{T0}'),
                          ('PE', 'EMP', '空项目', 'ACTIVE', 'ON_TRACK', 0, 2, 'EE', '{T0}', '{T0}');
                 INSERT INTO objectives (project_id, id, local_no, title, status, created_at, updated_at) VALUES
                   ('PA', 'O1', 1, '主目标', 'ACTIVE', '{T0}', '{T0}'),
                   ('PA', 'OD', 2, '已完成的目标', 'DONE', '{T0}', '{T0}');
                 INSERT INTO milestones (project_id, id, local_no, objective_id, title, status, sort_key, created_at, updated_at) VALUES
                   ('PA', 'M1', 1, 'O1', '里程碑', 'ACTIVE', 1000, '{T0}', '{T0}'),
                   ('PA', 'M2', 2, 'OD', '旧里程碑', 'ACTIVE', 1000, '{T0}', '{T0}');"
            ))?;
            for project in ["PA", "PE"] {
                for (name, next) in [("work_item", 1), ("blocker", 1), ("objective", 3), ("milestone", 3), ("record", 1)] {
                    tx.execute(
                        "INSERT INTO counters (project_id, name, next_value) VALUES (?1, ?2, ?3)",
                        params![project, name, next],
                    )?;
                }
                for agent in ["claude", "codex"] {
                    tx.execute(
                        "INSERT INTO agents (project_id, id, display_name, client_kind, created_at, updated_at) VALUES (?1, ?2, ?2, 'cli', ?3, ?3)",
                        params![project, agent, T0],
                    )?;
                }
            }
            // S1 → S2 是同一个 lineage（R2）；SX 是另一个 agent；EX 在空项目。
            for (project, id, agent, pred, at) in [
                ("PA", "S1", "claude", None, T0),
                ("PA", "S2", "claude", Some("S1"), T1),
                ("PA", "SX", "codex", None, T0),
                ("PE", "EX", "claude", None, T0),
            ] {
                tx.execute(
                    "INSERT INTO agent_sessions (project_id, id, agent_id, role, work_state, connection_state, started_at, updated_at, predecessor_session_id)
                     VALUES (?1, ?2, ?3, 'PRIMARY', 'IDLE', 'ONLINE', ?4, ?4, ?5)",
                    params![project, id, agent, at, pred],
                )?;
            }
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    World {
        svc: Service::new(store),
        op: std::sync::atomic::AtomicU32::new(0),
    }
}

fn agent() -> Principal {
    Principal::authenticated_agent(None)
}

fn user() -> Principal {
    Principal::trusted_ui(UiSurface::Tray)
}

impl World {
    fn next_op(&self) -> String {
        let n = self.op.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        format!("op-{n}")
    }

    fn target(&self, session: Option<&str>) -> Target {
        Target::new("PA", session, self.next_op())
    }

    fn create_as(
        &self,
        p: &Principal,
        session: Option<&str>,
        items: Vec<CreateItem>,
    ) -> Result<Written, DomainError> {
        self.svc.create_work_items(p, &self.target(session), items)
    }

    /// S1 建任务，返回 key。
    fn task(&self, title: &str) -> String {
        let r = self
            .create_as(&agent(), Some("S1"), vec![item(title)])
            .unwrap();
        r.result["items"][0]["key"].as_str().unwrap().to_owned()
    }

    fn patch_as(
        &self,
        p: &Principal,
        session: Option<&str>,
        items: Vec<PatchItem>,
    ) -> Result<Written, DomainError> {
        self.svc.patch_work_items(p, &self.target(session), items)
    }

    /// S1 的单条 patch。
    fn s1(&self, item: PatchItem) -> Result<Written, DomainError> {
        self.patch_as(&agent(), Some("S1"), vec![item])
    }

    fn version(&self, key: &str) -> i64 {
        self.col(key, "version").as_i64().unwrap()
    }

    /// 任务行的一列。
    fn col(&self, key: &str, column: &str) -> Value {
        let no: i64 = key.rsplit('-').next().unwrap().parse().unwrap();
        let sql =
            format!("SELECT {column} FROM work_items WHERE project_id = 'PA' AND local_no = ?1");
        let v: Sql = self
            .svc
            .store()
            .read(|tx| tx.query_row(&sql, [no], |r| r.get(0)))
            .map_err(|e| format!("{e:?}"))
            .unwrap();
        sql_json(v)
    }

    fn scalar(&self, sql: &str) -> Value {
        let v: Sql = self
            .svc
            .store()
            .read(|tx| tx.query_row(sql, [], |r| r.get(0)))
            .map_err(|e| format!("{e:?}"))
            .unwrap();
        sql_json(v)
    }

    fn count(&self, sql: &str) -> i64 {
        self.scalar(sql).as_i64().unwrap()
    }

    fn exec(&self, sql: &str) {
        let sql = sql.to_owned();
        self.svc
            .store()
            .write(move |tx| tx.execute_batch(&sql))
            .map_err(|e| format!("{e:?}"))
            .unwrap();
    }

    fn snapshot(&self) -> Vec<(String, Vec<String>)> {
        self.svc
            .store()
            .read(|tx| {
                let names: Vec<String> = tx
                    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")?
                    .query_map([], |r| r.get(0))?
                    .collect::<rusqlite::Result<_>>()?;
                let mut out = Vec::new();
                for name in names {
                    let mut stmt = tx.prepare(&format!("SELECT * FROM \"{name}\""))?;
                    let cols = stmt.column_count();
                    let rows = stmt
                        .query_map([], |r| {
                            (0..cols)
                                .map(|i| r.get::<_, Sql>(i).map(|v| format!("{v:?}")))
                                .collect::<rusqlite::Result<Vec<_>>>()
                                .map(|v| v.join("|"))
                        })?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    out.push((name, rows));
                }
                Ok::<_, rusqlite::Error>(out)
            })
            .unwrap()
    }

    /// 执行一次应当被拒绝的调用，断言错误码与整库零变化，返回错误。
    fn refused(
        &self,
        code: ErrorCode,
        call: impl FnOnce() -> Result<Written, DomainError>,
    ) -> DomainError {
        let before = self.snapshot();
        let e = match call() {
            Ok(w) => panic!("expected {code}, got {:?}", w.result),
            Err(e) => e,
        };
        assert_eq!(e.code, code, "{e:?}");
        let after = self.snapshot();
        for ((name, a), (_, b)) in before.iter().zip(&after) {
            assert_eq!(a, b, "table {name} changed on a refused {code}");
        }
        e
    }

    fn events(&self, key: &str) -> Vec<String> {
        let no: i64 = key.rsplit('-').next().unwrap().parse().unwrap();
        self.svc
            .store()
            .read(|tx| {
                tx.prepare(
                    "SELECT e.type FROM events e JOIN work_items w ON w.project_id = e.project_id AND w.id = e.aggregate_id
                     WHERE e.project_id = 'PA' AND w.local_no = ?1 ORDER BY e.seq",
                )?
                .query_map([no], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()
            })
            .unwrap()
    }

    fn session(&self, id: &str, column: &str) -> Value {
        self.scalar(&format!(
            "SELECT {column} FROM agent_sessions WHERE project_id = 'PA' AND id = '{id}'"
        ))
    }
}

fn sql_json(v: Sql) -> Value {
    match v {
        Sql::Null => Value::Null,
        Sql::Integer(i) => json!(i),
        Sql::Real(f) => json!(f),
        Sql::Text(s) => json!(s),
        Sql::Blob(_) => json!("<blob>"),
    }
}

fn item(title: &str) -> CreateItem {
    CreateItem {
        objective_id: Some("O1".into()),
        title: title.into(),
        ..CreateItem::default()
    }
}

fn p(key: &str, op: Operation) -> PatchItem {
    PatchItem::new(key, op)
}

fn block(key: &str, reason: &str) -> PatchItem {
    PatchItem {
        blocked_reason: Some(reason.into()),
        ..p(key, Operation::Block)
    }
}

fn wait(key: &str, op: Operation, why: &str) -> PatchItem {
    PatchItem {
        waiting_for: Some(why.into()),
        ..p(key, op)
    }
}

fn edit(key: &str, v: i64, e: EditFields) -> PatchItem {
    PatchItem {
        edit: e,
        ..p(key, Operation::Edit).version(v)
    }
}

fn status(w: &World, key: &str) -> String {
    w.col(key, "status").as_str().unwrap().to_owned()
}

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
