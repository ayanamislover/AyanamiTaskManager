//! W3c 幂等重放模拟（07 §3 VERIFY「幂等重放模拟」）：一个 2.x 项目库里的旧回执经转换器落进 3.0 的库，
//! 服务按同一个 session 与 op_id 重发同一个请求，必须 REPLAY 出保存的结果；请求不同则冲突；新的 op_id 照常写入。
//! 旧回执的指纹按 2.x 的 kernel-v1 算法从真实请求算出，不是手写的常量。

mod support;

use atm_domain::error::ErrorCode;
use atm_service::fp::{self, JsValue};
use atm_service::memory::ProgressRequest;
use atm_service::work::Target;
use atm_service::write::Service;
use atm_store::legacy::{ConvertOptions, LegacySources, convert};
use atm_store::{Config, Store};
use rusqlite::{Connection, params};
use serde_json::json;
use std::path::{Path, PathBuf};
use support::{agent, test_root};

const T: &str = "2026-09-01T00:00:00.000Z";

/// 按仓库里 2.x 的迁移文件建一个库，并像 2.0 的迁移执行器那样登记 schema_migrations。
fn legacy(path: &Path, kind: &str) -> Connection {
    use sha2::Digest;
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../migrations")
        .join(kind);
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    files.sort();
    let c = Connection::open(path).unwrap();
    c.execute_batch(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL,
           content_sha256 TEXT NOT NULL, hash_origin TEXT NOT NULL CHECK(hash_origin IN ('APPLIED','LEGACY_BASELINE_UNVERIFIED')))",
    )
    .unwrap();
    for f in files {
        let name = f.file_name().unwrap().to_string_lossy().into_owned();
        let sql = std::fs::read(&f).unwrap();
        let sha: String = sha2::Sha256::digest(&sql)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        c.execute_batch(std::str::from_utf8(&sql).unwrap()).unwrap();
        c.execute(
            "INSERT INTO schema_migrations VALUES (?1, ?2, ?3, ?4, 'APPLIED')",
            params![name[..4].parse::<i64>().unwrap(), name, T, sha],
        )
        .unwrap();
    }
    c
}

/// 2.x 的 `work.progress` 请求在 kernel-v1 里的形状（progress-commands.ts 的 normalizedInput）。
fn v1_progress(key: &str, summary: &str, percent: f64) -> String {
    fp::kernel_v1(&JsValue::from_json(&json!({
        "taskKey": key, "summary": summary, "completed": [], "next": [], "evidence": [], "percent": percent,
    })))
    .unwrap()
}

#[test]
fn converted_2x_receipts_replay_through_the_service() {
    let dir = test_root().join("legacy-replay");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let project = dir.join("P1.sqlite");

    let r = legacy(&dir.join("registry.sqlite"), "registry");
    r.execute(
        "INSERT INTO app_meta (singleton, current_sequence, data_version, created_at, updated_at) VALUES (1, 0, 1, ?1, ?1)",
        [T],
    )
    .unwrap();
    r.execute(
        "INSERT INTO projects (id, code, name, description, db_path, lifecycle, coordination_mode, version, created_at, updated_at)
         VALUES ('P1', 'AAA', 'Alpha', '', ?1, 'ACTIVE', 'AUTO', 0, ?2, ?2)",
        params![project.to_string_lossy(), T],
    )
    .unwrap();
    drop(r);

    let p = legacy(&project, "project");
    let schema: i64 = p
        .query_row("SELECT max(version) FROM schema_migrations", [], |r| {
            r.get(0)
        })
        .unwrap();
    p.execute_batch(&format!(
        "INSERT INTO project_meta (singleton, project_id, project_code, name, description, lifecycle, coordination_mode, health,
                                   current_sequence, schema_version, version, created_at, updated_at)
           VALUES (1, 'P1', 'AAA', 'Alpha', '', 'ACTIVE', 'AUTO', 'UNKNOWN', 7, {schema}, 0, '{T}', '{T}');
         INSERT INTO counters (name, next_value) VALUES ('objective', 2), ('milestone', 1), ('work_item', 2), ('blocker', 1), ('record', 1);
         INSERT INTO objectives (id, local_no, title, status, created_at, updated_at) VALUES ('OBJ', 1, 'goal', 'ACTIVE', '{T}', '{T}');
         INSERT INTO agents (id, display_name, client_kind, created_at, updated_at) VALUES ('claude', 'Claude', 'cli', '{T}', '{T}');
         INSERT INTO agent_sessions (id, agent_id, role, work_state, connection_state, started_at, updated_at)
           VALUES ('S1', 'claude', 'PRIMARY', 'WORKING', 'ONLINE', '{T}', '{T}');
         INSERT INTO work_items (id, local_no, objective_id, type, title, status, phase, priority, claimed_by_session_id, created_at, updated_at)
           VALUES ('W1', 1, 'OBJ', 'TASK', 'task one', 'IN_PROGRESS', 'IN_PROGRESS', 'NORMAL', 'S1', '{T}', '{T}');"
    ))
    .unwrap();
    // 2.x 的 Agent 回执：key = `<session>:<op_id>`，指纹 = kernel-v1(normalizedInput)。
    p.execute(
        "INSERT INTO idempotency_keys (key, operation, request_fingerprint, response_json, created_at, op_id, actor_session_id)
         VALUES ('S1:pg-old', 'work.progress', ?1, '{\"sequence\":7}', ?2, 'pg-old', 'S1')",
        params![v1_progress("AAA-T-0001", "旧的", 20.0), T],
    )
    .unwrap();
    drop(p);

    let target = dir.join("out").join("atm.sqlite");
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    let report = convert(
        &LegacySources {
            registry: dir.join("registry.sqlite"),
            knowledge: None,
            projects: vec![project],
            root: None,
        },
        &target,
        &ConvertOptions {
            at: "2026-10-03T00:00:00.000Z",
            allow_real_data_root: false,
            real_data_root: None,
            generation: None,
            secrets_check: None,
            accept_unconvertible: &[],
            origin_root: None,
            progress: None,
        },
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert!(report.failures().is_empty(), "{:?}", report.failures());

    let svc = Service::new(Store::open(&target, Config::default()).unwrap());
    let old = Target::new("P1", Some("S1"), "pg-old");
    let request = |summary: &str, percent: f64| ProgressRequest {
        percent: Some(percent),
        ..ProgressRequest::task("AAA-T-0001", summary)
    };
    // 同一个请求：REPLAY 出 2.x 保存的结果，不写任何东西。
    let replay = svc
        .add_progress(&agent(), &old, request("旧的", 20.0))
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.result["sequence"], 7);
    // 同一个 op_id、不同的请求：冲突。
    let e = svc
        .add_progress(&agent(), &old, request("改过的", 20.0))
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::IDEMPOTENCY_CONFLICT, "{e:?}");
    // 新的 op_id：照常写入，序号接着 2.x 的往后排。
    let fresh = svc
        .add_progress(
            &agent(),
            &Target::new("P1", Some("S1"), "pg-new"),
            request("新的", 30.0),
        )
        .unwrap();
    assert!(!fresh.replayed);
    assert_eq!(fresh.result["sequence"], 8);
}
