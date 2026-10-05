//! 服务层验收共用的夹具：一个两项目的库、两个 agent 的 session，以及整库快照与零写入断言。
#![allow(dead_code, unused_imports)]

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

pub const T0: &str = "2026-10-05T00:00:00.000Z";
pub const T1: &str = "2026-10-05T01:00:00.000Z";
pub const PAST: &str = "2000-01-01T00:00:00.000Z";

pub struct World {
    pub svc: Service,
    pub op: std::sync::atomic::AtomicU32,
}

pub fn world(name: &str) -> World {
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
                for (name, next) in [("work_item", 1), ("blocker", 1), ("objective", 3), ("milestone", 3), ("record", 1), ("review_request", 1), ("review_submission", 1)] {
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
            // REVIEWER session：RV → RV2 是 codex 的 lineage；RC 是 claude 的；RZ 已关闭（W-058）。
            for (id, agent, pred, state) in [
                ("RV", "codex", None, "ONLINE"),
                ("RV2", "codex", Some("RV"), "ONLINE"),
                ("RC", "claude", None, "ONLINE"),
                ("RZ", "codex", None, "CLOSED"),
            ] {
                tx.execute(
                    "INSERT INTO agent_sessions (project_id, id, agent_id, role, work_state, connection_state, started_at, updated_at, predecessor_session_id)
                     VALUES ('PA', ?1, ?2, 'REVIEWER', 'IDLE', ?3, ?4, ?4, ?5)",
                    params![id, agent, state, if pred.is_some() { T1 } else { T0 }, pred],
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

pub fn agent() -> Principal {
    Principal::authenticated_agent(None)
}

pub fn user() -> Principal {
    Principal::trusted_ui(UiSurface::Tray)
}

impl World {
    pub fn next_op(&self) -> String {
        let n = self.op.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        format!("op-{n}")
    }

    pub fn target(&self, session: Option<&str>) -> Target {
        Target::new("PA", session, self.next_op())
    }

    pub fn create_as(
        &self,
        p: &Principal,
        session: Option<&str>,
        items: Vec<CreateItem>,
    ) -> Result<Written, DomainError> {
        self.svc.create_work_items(p, &self.target(session), items)
    }

    /// S1 建任务，返回 key。
    pub fn task(&self, title: &str) -> String {
        let r = self
            .create_as(&agent(), Some("S1"), vec![item(title)])
            .unwrap();
        r.result["items"][0]["key"].as_str().unwrap().to_owned()
    }

    pub fn patch_as(
        &self,
        p: &Principal,
        session: Option<&str>,
        items: Vec<PatchItem>,
    ) -> Result<Written, DomainError> {
        self.svc.patch_work_items(p, &self.target(session), items)
    }

    /// S1 的单条 patch。
    pub fn s1(&self, item: PatchItem) -> Result<Written, DomainError> {
        self.patch_as(&agent(), Some("S1"), vec![item])
    }

    pub fn version(&self, key: &str) -> i64 {
        self.col(key, "version").as_i64().unwrap()
    }

    /// 任务行的一列。
    pub fn col(&self, key: &str, column: &str) -> Value {
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

    pub fn scalar(&self, sql: &str) -> Value {
        let v: Sql = self
            .svc
            .store()
            .read(|tx| tx.query_row(sql, [], |r| r.get(0)))
            .map_err(|e| format!("{e:?}"))
            .unwrap();
        sql_json(v)
    }

    pub fn count(&self, sql: &str) -> i64 {
        self.scalar(sql).as_i64().unwrap()
    }

    pub fn exec(&self, sql: &str) {
        let sql = sql.to_owned();
        self.svc
            .store()
            .write(move |tx| tx.execute_batch(&sql))
            .map_err(|e| format!("{e:?}"))
            .unwrap();
    }

    pub fn snapshot(&self) -> Vec<(String, Vec<String>)> {
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
    pub fn refused(
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

    pub fn events(&self, key: &str) -> Vec<String> {
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

    pub fn session(&self, id: &str, column: &str) -> Value {
        self.scalar(&format!(
            "SELECT {column} FROM agent_sessions WHERE project_id = 'PA' AND id = '{id}'"
        ))
    }
}

pub fn sql_json(v: Sql) -> Value {
    match v {
        Sql::Null => Value::Null,
        Sql::Integer(i) => json!(i),
        Sql::Real(f) => json!(f),
        Sql::Text(s) => json!(s),
        Sql::Blob(_) => json!("<blob>"),
    }
}

pub fn item(title: &str) -> CreateItem {
    CreateItem {
        objective_id: Some("O1".into()),
        title: title.into(),
        ..CreateItem::default()
    }
}

pub fn p(key: &str, op: Operation) -> PatchItem {
    PatchItem::new(key, op)
}

pub fn block(key: &str, reason: &str) -> PatchItem {
    PatchItem {
        blocked_reason: Some(reason.into()),
        ..p(key, Operation::Block)
    }
}

pub fn wait(key: &str, op: Operation, why: &str) -> PatchItem {
    PatchItem {
        waiting_for: Some(why.into()),
        ..p(key, op)
    }
}

pub fn edit(key: &str, v: i64, e: EditFields) -> PatchItem {
    PatchItem {
        edit: e,
        ..p(key, Operation::Edit).version(v)
    }
}

pub fn status(w: &World, key: &str) -> String {
    w.col(key, "status").as_str().unwrap().to_owned()
}
