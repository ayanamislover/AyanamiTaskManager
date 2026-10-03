//! 2.x → 3.0 转换原型的验收（W1f）。
//!
//! 夹具用仓库里 2.x 自己的迁移 SQL（`migrations/{registry,knowledge,project}`）建库，schema 与 2.0 运行时一致；
//! 数据是合成的，含边界情况：两个项目重号、超大事件、损坏的 JSON 文本、各种形状的旧回执（R7‴ 的向量）、
//! 孤儿全局事件、没送达的投影。全程不碰真实数据根。

use atm_store::legacy::{
    ConvertError, ConvertOptions, LegacySources, Report, convert, verify_converted,
};
use atm_store::search::{Scope, match_docs, terms};
use rusqlite::{Connection, params};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const T: &str = "2026-09-01T00:00:00.000Z";
const T2: &str = "2026-09-02T00:00:00.000Z";
const OBJ_ULID: &str = "01J0000000000000000000000A";

fn dir(name: &str) -> PathBuf {
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("target")
        });
    let d = target.join("store-tests").join(name);
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

/// 按 2.x 的迁移文件建一个空库，并像 2.0 的迁移执行器那样登记 schema_migrations。
fn legacy(path: &Path, kind: &str) -> Connection {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../migrations")
        .join(kind);
    let mut files: Vec<PathBuf> = fs::read_dir(&root)
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
        let name = f.file_stem().unwrap().to_string_lossy().into_owned();
        let version: i64 = name[..4].parse().unwrap();
        c.execute_batch(&fs::read_to_string(&f).unwrap()).unwrap();
        c.execute(
            "INSERT INTO schema_migrations VALUES (?1, ?2, ?3, 'sha', 'APPLIED')",
            params![version, name, T],
        )
        .unwrap();
    }
    c
}

struct Fixture {
    dir: PathBuf,
    sources: LegacySources,
}

impl Fixture {
    fn target(&self) -> PathBuf {
        self.dir.join("out").join("atm.sqlite")
    }
    fn convert(&self) -> Result<Report, ConvertError> {
        fs::create_dir_all(self.dir.join("out")).unwrap();
        let _ = fs::remove_file(self.target());
        convert(
            &self.sources,
            &self.target(),
            &ConvertOptions {
                at: "2026-10-03T00:00:00.000Z",
                allow_real_data_root: false,
                real_data_root: None,
            },
        )
    }
    fn registry(&self) -> Connection {
        Connection::open(&self.sources.registry).unwrap()
    }
    fn project(&self, i: usize) -> Connection {
        Connection::open(&self.sources.projects[i]).unwrap()
    }
}

/// 一个 3 MB 的事件 payload。
fn huge_payload() -> String {
    format!("{{\"blob\":\"{}\"}}", "x".repeat(3 * 1024 * 1024))
}

fn fixture(name: &str) -> Fixture {
    let d = dir(name);
    let reg = d.join("registry.sqlite");
    let r = legacy(&reg, "registry");
    r.execute_batch(&format!(
        "INSERT INTO app_meta (singleton, current_sequence, data_version, created_at, updated_at) VALUES (1, 7, 1, '{T}', '{T}');
         INSERT INTO projects (id, code, name, description, db_path, lifecycle, coordination_mode, version, created_at, updated_at)
           VALUES ('P1', 'AAA', 'Alpha', 'first', 'C:/old/projects/P1/project.sqlite', 'ACTIVE', 'AUTO', 3, '{T}', '{T2}'),
                  ('P2', 'BBB', 'Bravo', '', NULL, 'ARCHIVED', 'SOLO', 5, '{T}', '{T2}');
         INSERT INTO project_paths (project_id, canonical_path, last_seen_at) VALUES ('P1', 'c:/work/alpha', '{T}');
         INSERT INTO quick_tasks (id, local_no, title, status, actor, promoted_project_id, promoted_work_item_key, created_at, updated_at)
           VALUES ('Q1', 1, 'promoted one', 'PROMOTED', 'USER', 'P1', 'AAA-T-0001', '{T}', '{T}'),
                  ('Q2', 2, 'still open', 'OPEN', 'USER', NULL, NULL, '{T}', '{T}'),
                  ('Q3', 3, 'half promoted', 'OPEN', 'USER', NULL, NULL, '{T}', '{T}'),
                  ('Q4', 4, 'dangling', 'PROMOTED', 'USER', 'P2', 'BBB-T-0099', '{T}', '{T}');
         INSERT INTO quick_task_updates (id, quick_task_id, summary, actor, created_at) VALUES ('U1', 'Q2', 'note', 'USER', '{T}');
         INSERT INTO saved_views (id, scope, name, created_at, updated_at) VALUES ('V1', 'GLOBAL', 'mine', '{T}', '{T}');
         INSERT INTO settings (key, value_json, updated_at) VALUES ('theme', '\"dark\"', '{T}');
         INSERT INTO import_history (source_sha256, project_id, result_json, imported_at) VALUES ('abc', 'P1', '{{}}', '{T}');
         INSERT INTO global_events (sequence, type, aggregate_id, actor, payload_json, created_at, dedupe_key) VALUES
           (1, 'project.created', 'P1', 'USER', '{{}}', '{T}', NULL),
           (2, 'work.created', 'W1', 'claude', '{{\"projectSequence\":1}}', '{T}', 'project:P1:event:E1'),
           (3, 'work.created', 'W1', 'claude', '{{}}', '{T}', 'project:P2:event:F1'),
           (4, 'work.updated', 'W9', 'claude', '{{}}', '{T}', 'project:P1:event:GONE'),
           (5, 'registry.project_changed', 'P2', 'SYSTEM', '{{}}', '{T}', 'project:P2:outbox:O9'),
           (7, 'backup.created', 'B1', 'SYSTEM', '{{\"kind\":\"DAILY\"}}', '{T2}', 'backup:B1');
         INSERT INTO backup_catalog (id, scope, project_id, path, sha256, size_bytes, reason, schema_version, created_at)
           VALUES ('B1', 'PROJECT', 'P1', 'C:/old/backups/b1.sqlite', 'ff', 10, 'DAILY', 18, '{T2}'),
                  ('B2', 'REGISTRY', NULL, 'C:/old/backups/r.sqlite', 'ee', 20, 'MANUAL', 8, '{T2}');
         INSERT INTO global_search_documents (project_id, entity_type, entity_key, title, project_sequence, updated_at)
           VALUES ('P1', 'WORK_ITEM', 'AAA-T-0001', 'derived', 1, '{T}');
         INSERT INTO project_summary_cache (project_id, lifecycle, updated_at) VALUES ('P1', 'ACTIVE', '{T}');"
    ))
    .unwrap();
    drop(r);

    let kpath = d.join("knowledge.sqlite");
    let k = legacy(&kpath, "knowledge");
    k.execute_batch(
        "INSERT INTO knowledge_meta (singleton, database_id, generation, sequence) VALUES (1, 'KDB', 'KG1', 4);
         INSERT INTO knowledge_entries (id, slug, head_revision, version, archived) VALUES ('K1', 'single-db', 2, 2, 0);
         INSERT INTO knowledge_revisions (entry_id, revision, revision_id, snapshot) VALUES
           ('K1', 1, 'K1-R1', '{\"title\":\"Old title\",\"aliases\":[],\"tags\":[],\"summary\":\"\",\"useWhen\":\"\",\"appliesTo\":[],\"bodyMarkdown\":\"one\"}'),
           ('K1', 2, 'K1-R2', '{\"title\":\"Single database\",\"aliases\":[\"one file\"],\"tags\":[\"store\"],\"summary\":\"s\",\"useWhen\":\"u\",\"appliesTo\":[\"atm\"],\"bodyMarkdown\":\"two\"}');
         INSERT INTO knowledge_operations (op_id, fingerprint, receipt) VALUES
           ('USER-op-1', 'fp1', '{\"format\":\"knowledge-receipt-v2\",\"id\":\"K1\"}'),
           ('agent:abc', 'fp2', '{\"id\":\"K1\",\"revision\":1}');"
    )
    .unwrap();
    drop(k);

    let mut projects = Vec::new();
    for (pid, code, meta_life) in [("P1", "AAA", "ACTIVE"), ("P2", "BBB", "ACTIVE")] {
        let path = d.join(format!("{pid}.sqlite"));
        let p = legacy(&path, "project");
        // 两个项目刻意用相同的本地编号、序号、agent id、session id 与事件之外的 id。
        p.execute_batch(&format!(
            "INSERT INTO project_meta (singleton, project_id, project_code, name, description, lifecycle, coordination_mode, health,
                                       current_sequence, schema_version, version, created_at, updated_at)
               VALUES (1, '{pid}', '{code}', 'meta name {pid}', '', '{meta_life}', 'AUTO', 'AT_RISK', 4, 18, 9, '{T}', '{T2}');
             INSERT INTO counters (name, next_value) VALUES ('work_item', 2), ('objective', 2);
             INSERT INTO objectives (id, local_no, title, status, created_at, updated_at) VALUES ('OBJ', 1, 'goal', 'ACTIVE', '{T}', '{T}');
             INSERT INTO agents (id, display_name, client_kind, created_at, updated_at) VALUES ('claude', 'Claude', 'cli', '{T}', '{T}');
             INSERT INTO agent_sessions (id, agent_id, role, work_state, connection_state, started_at, updated_at)
               VALUES ('S1', 'claude', 'PRIMARY', 'WORKING', 'ONLINE', '{T}', '{T}');
             INSERT INTO work_items (id, local_no, objective_id, type, title, status, priority, claimed_by_session_id, created_at, updated_at)
               VALUES ('W1', 1, 'OBJ', 'TASK', 'shared title words', 'IN_PROGRESS', 'NORMAL', 'S1', '{T}', '{T}');
             INSERT INTO handoffs (id, work_item_id, from_session_id, to_agent_id, summary, next_action, created_at)
               VALUES ('H1', 'W1', 'S1', 'claude', 'sum', 'next', '{T}');
             INSERT INTO search_documents (entity_type, entity_id, entity_key, title, body, updated_at)
               VALUES ('WORK_ITEM', 'W1', '{code}-T-0001', 'shared title words', 'body {pid}', '{T}');"
        ))
        .unwrap();
        let first_event = if pid == "P1" { "E1" } else { "F1" };
        p.execute(
            "INSERT INTO events (id, sequence, type, actor_type, actor_id, session_id, aggregate_type, aggregate_id, payload_json, created_at, op_id)
             VALUES (?1, 1, 'work.created', 'AGENT', 'claude', 'S1', 'WORK_ITEM', 'W1', '{}', ?2, 'op-a')",
            params![first_event, T],
        )
        .unwrap();
        p.execute(
            "INSERT INTO events (id, sequence, type, actor_type, actor_id, aggregate_type, aggregate_id, payload_json, created_at)
             VALUES (?1, 2, 'work.updated', 'AGENT', 'claude', 'WORK_ITEM', 'W1', ?2, ?3)",
            params![format!("{first_event}-big"), huge_payload(), T],
        )
        .unwrap();
        // 损坏的 JSON 文本：2.0 不校验 payload，原样保留。
        p.execute(
            "INSERT INTO events (id, sequence, type, actor_type, actor_id, aggregate_type, aggregate_id, payload_json, created_at)
             VALUES (?1, 4, 'work.updated', 'AGENT', 'claude', 'WORK_ITEM', 'W1', 'not json {', ?2)",
            params![format!("{first_event}-bad"), T2],
        )
        .unwrap();
        projects.push(path);
    }

    // P1 的 outbox：一条已送达；一条没送达、事件在、全局流里没有镜像（要补）；一条没送达、找不到事件。
    let p1 = Connection::open(&projects[0]).unwrap();
    p1.execute_batch(&format!(
        "INSERT INTO outbox (id, project_sequence, type, payload_json, created_at, delivered_at) VALUES
           ('O1', 1, 'registry.project_changed', '{{\"eventId\":\"E1\"}}', '{T}', '{T}'),
           ('O2', 4, 'registry.project_changed', '{{\"eventId\":\"E1-bad\"}}', '{T2}', NULL),
           ('O3', 4, 'registry.project_changed', '{{\"type\":\"x\"}}', '{T2}', NULL);"
    ))
    .unwrap();
    // R7‴ 的回执向量（期望类写在注释里，由用例直接断言，不由分类函数生成）。
    let receipts: &[(&str, &str, &str, Option<&str>)] = &[
        ("USER:u1", "work.create", "u1", None),         // USER（实时）
        ("USER:u2", "work.update", "u2", Some("USER")), // USER（0007 回填）
        ("SYSTEM:s1", "maintenance", "s1", None),       // SYSTEM_CONST
        ("planning-root:p1", "objective.create", "p1", None), // SYSTEM_CONST
        ("S1:a1", "work.update", "a1", Some("S1")),     // AGENT
        ("session-begin:b1", "session.recover-or-begin", "b1", None), // BEGIN
        ("codex:promote-Q1", "work.create.batch", "promote-Q1", None), // PROMOTION_HISTORY / MATCHED
        (
            "codex:objective-01J0000000000000000000000A",
            "objective.create",
            "objective-01J0000000000000000000000A",
            None,
        ), // 补建
        (
            "S1:promote-Q3",
            "work.create.batch",
            "promote-Q3",
            Some("S1"),
        ), // AGENT + PROMOTION_SHAPED_AGENT / UNMARKED
        (
            "review:agent-42:promote-Q1",
            "work.create.batch",
            "promote-Q1",
            None,
        ), // PROMOTION_HISTORY（含冒号的 actor）
        ("S1:promote-Q9", "work.create.batch", "promote-Q9", None), // PROMOTION_HISTORY / QUICK_MISSING（不是 AGENT）
        ("loneop", "work.update", "loneop", None), // 前缀为空 → LEGACY_UNCLASSIFIED
        ("mystery:m1", "work.update", "m1", None),
        // 补建形状，但同一前缀没有晋升行 → LEGACY_UNCLASSIFIED
        (
            "solo:objective-01J0000000000000000000000B",
            "objective.create",
            "objective-01J0000000000000000000000B",
            None,
        ),
        // 补建形状的前缀有晋升行，但后缀不是 ULID → LEGACY_UNCLASSIFIED
        (
            "codex:milestone-short",
            "milestone.create",
            "milestone-short",
            None,
        ), // 未知前缀 → LEGACY_UNCLASSIFIED
    ];
    for (key, op, op_id, actor) in receipts {
        p1.execute(
            "INSERT INTO idempotency_keys (key, operation, request_fingerprint, response_json, created_at, op_id, actor_session_id)
             VALUES (?1, ?2, 'fp', '{\"ok\":true}', ?3, ?4, ?5)",
            params![key, op, T, op_id, actor],
        )
        .unwrap();
    }
    assert!(receipts.iter().any(|r| r.0.contains(OBJ_ULID)));
    drop(p1);
    // P2：同一个 key 的 0007 回填形状（op_id 只取首冒号之后），与 P1 的实时形状各自分类。
    let p2 = Connection::open(&projects[1]).unwrap();
    p2.execute(
        "INSERT INTO idempotency_keys (key, operation, request_fingerprint, response_json, created_at, op_id, actor_session_id)
         VALUES ('review:agent-42:promote-Q1', 'work.create.batch', 'fp', '{}', ?1, 'agent-42:promote-Q1', 'review')",
        [T],
    )
    .unwrap();
    drop(p2);

    Fixture {
        dir: d,
        sources: LegacySources {
            registry: reg,
            knowledge: Some(kpath),
            projects,
        },
    }
}

fn q<T: rusqlite::types::FromSql>(c: &Connection, sql: &str) -> T {
    c.query_row(sql, [], |r| r.get(0)).unwrap()
}

#[test]
fn a_synthetic_2x_data_root_converts_and_every_family_matches() {
    let f = fixture("legacy-full");
    let report = f.convert().unwrap();
    assert!(report.failures().is_empty(), "{:?}", report.failures());
    assert!(
        report.families.len() >= 40,
        "only {} families checked",
        report.families.len()
    );
    let t = Connection::open(f.target()).unwrap();

    // 重号：两个项目的同号任务、同号事件、同名 session 都在。
    assert_eq!(
        q::<i64>(&t, "SELECT count(*) FROM work_items WHERE local_no = 1"),
        2
    );
    assert_eq!(q::<i64>(&t, "SELECT count(*) FROM events WHERE seq = 2"), 2);
    assert_eq!(
        q::<i64>(&t, "SELECT count(*) FROM agent_sessions WHERE id = 'S1'"),
        2
    );
    // 超大事件与损坏的 JSON 原样保留。
    assert_eq!(
        q::<i64>(
            &t,
            "SELECT length(payload_json) FROM events WHERE id = 'E1-big'"
        ),
        huge_payload().len() as i64
    );
    assert_eq!(
        q::<String>(&t, "SELECT payload_json FROM events WHERE id = 'F1-bad'"),
        "not json {"
    );

    // projects：registry 列为准，项目库那一份整行在 legacy_json 里（2.0 不同步这两份）。
    assert_eq!(
        q::<String>(&t, "SELECT lifecycle FROM projects WHERE id = 'P2'"),
        "ARCHIVED"
    );
    assert_eq!(
        q::<String>(
            &t,
            "SELECT legacy_json -> '$.projectMeta' ->> '$.lifecycle' FROM projects WHERE id = 'P2'"
        ),
        "ACTIVE"
    );
    assert_eq!(
        q::<String>(&t, "SELECT name FROM projects WHERE id = 'P1'"),
        "Alpha"
    );
    assert_eq!(
        q::<String>(
            &t,
            "SELECT health || '/' || meta_version || '/' || project_seq FROM projects WHERE id = 'P1'"
        ),
        "AT_RISK/9/4"
    );
    assert_eq!(
        q::<String>(
            &t,
            "SELECT legacy_json ->> '$.registryDbPath' FROM projects WHERE id = 'P1'"
        ),
        "C:/old/projects/P1/project.sqlite"
    );

    // 全局流（R6）：能匹配到事件的填上 event_id；孤儿留空；outbox 补投影追加到末尾。
    assert_eq!(
        q::<String>(
            &t,
            "SELECT project_id || '/' || event_id FROM global_feed WHERE global_seq = 2"
        ),
        "P1/E1"
    );
    assert_eq!(
        q::<String>(
            &t,
            "SELECT project_id || '/' || event_id FROM global_feed WHERE global_seq = 3"
        ),
        "P2/F1"
    );
    assert_eq!(
        q::<Option<String>>(&t, "SELECT event_id FROM global_feed WHERE global_seq = 4"),
        None
    );
    assert_eq!(
        q::<String>(
            &t,
            "SELECT project_id FROM global_feed WHERE global_seq = 5"
        ),
        "P2"
    );
    assert_eq!(
        q::<Option<String>>(
            &t,
            "SELECT project_id FROM global_feed WHERE global_seq = 7"
        ),
        None
    );
    assert_eq!(
        (
            report.global_orphans,
            report.outbox_replayed,
            report.outbox_without_event
        ),
        (1, 1, 1)
    );
    assert_eq!(
        q::<String>(&t, "SELECT event_id FROM global_feed WHERE global_seq = 8"),
        "E1-bad"
    );
    assert_eq!(
        q::<i64>(
            &t,
            "SELECT payload_json ->> '$.projectSequence' FROM global_feed WHERE global_seq = 8"
        ),
        4
    );
    assert_eq!(q::<i64>(&t, "SELECT global_seq FROM app_meta"), 8);

    // quick 的晋升目标（R5）：解析到实体 id；解析不到的计数。
    assert_eq!(
        q::<String>(
            &t,
            "SELECT promoted_work_item_id FROM quick_tasks WHERE id = 'Q1'"
        ),
        "W1"
    );
    assert_eq!(report.unresolved_promotions, 1);

    // 回执（R7‴）：分类计数与新键。
    let expected: BTreeMap<String, usize> = [
        ("AGENT", 2),
        ("BEGIN", 1),
        ("LEGACY_UNCLASSIFIED", 5),
        ("PROMOTION_HISTORY", 4),
        ("SYSTEM_CONST", 2),
        ("USER", 2),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect();
    assert_eq!(report.receipt_classes, expected);
    assert_eq!(report.promotion_shaped_agent, 1);
    let status: BTreeMap<String, usize> = [("MATCHED", 2), ("QUICK_MISSING", 1), ("UNMARKED", 1)]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
    assert_eq!(report.promotion_status, status);
    let key = |legacy: &str| -> String {
        t.query_row(
            "SELECT coalesce(ns_kind, '-') || '/' || coalesce(ns_id, '-') || '/' || coalesce(op_id, '-') || '/' || legacy_class || '/' || legacy_op_id
             FROM idempotency_receipts WHERE scope_id = 'P1' AND legacy_key = ?1",
            [legacy],
            |r| r.get(0),
        )
        .unwrap()
    };
    assert_eq!(key("USER:u2"), "ACTOR/USER/u2/USER/u2");
    assert_eq!(key("S1:a1"), "SESSION/S1/a1/AGENT/a1");
    assert_eq!(key("session-begin:b1"), "-/-/-/BEGIN/b1");
    assert_eq!(
        key("S1:promote-Q9"),
        "-/-/-/PROMOTION_HISTORY/promote-Q9",
        "a NULL actor is never an agent write"
    );
    assert_eq!(key("loneop"), "-/-/-/LEGACY_UNCLASSIFIED/loneop");
    let p2_backfill: String = t
        .query_row(
            "SELECT legacy_class || '/' || legacy_op_id FROM idempotency_receipts WHERE scope_id = 'P2' AND legacy_key = 'review:agent-42:promote-Q1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(p2_backfill, "LEGACY_UNCLASSIFIED/agent-42:promote-Q1");

    // 知识库：回执、FTS。
    assert_eq!(
        q::<String>(
            &t,
            "SELECT receipt_format FROM idempotency_receipts WHERE scope_kind = 'KNOWLEDGE' AND legacy_key = 'USER-op-1'"
        ),
        "knowledge-receipt-v2"
    );
    assert_eq!(
        q::<i64>(
            &t,
            "SELECT count(*) FROM knowledge_fts WHERE knowledge_fts MATCH '\"Single database\"'"
        ),
        1
    );
    // 搜索：两个项目的文档都能搜到。
    let hits = match_docs(
        &t,
        &terms("shared title").unwrap(),
        &Scope::Global {
            lifecycles: &["ACTIVE", "ARCHIVED"],
        },
        10,
    )
    .unwrap();
    assert_eq!(hits.len(), 2);
    // 舍弃的派生族。
    assert_eq!(
        report.dropped.get("registry.global_search_documents"),
        Some(&1)
    );
    assert_eq!(report.dropped.get("project.outbox"), Some(&3));
    assert_eq!(q::<String>(&t, "PRAGMA integrity_check"), "ok");
    assert_eq!(
        q::<i64>(&t, "SELECT count(*) FROM pragma_foreign_key_check"),
        0
    );

    // 复核一次：转换后的库对同一组源仍全部相等。
    assert!(
        verify_converted(&f.target(), &f.sources)
            .unwrap()
            .failures()
            .is_empty()
    );
}

#[test]
fn verify_notices_a_target_that_drifted_from_its_source() {
    let f = fixture("legacy-drift");
    f.convert().unwrap();
    let t = Connection::open(f.target()).unwrap();
    t.execute(
        "UPDATE events SET payload_json = 'not json {' || ' ' WHERE id = 'F1-bad'",
        [],
    )
    .unwrap();
    t.execute(
        "UPDATE idempotency_receipts SET receipt_json = '{}' WHERE legacy_key = 'USER:u1'",
        [],
    )
    .unwrap();
    // NULL 改成空串：摘要必须区分两者。
    t.execute(
        "UPDATE work_items SET blocked_reason = '' WHERE project_id = 'P1'",
        [],
    )
    .unwrap();
    drop(t);
    let failures = verify_converted(&f.target(), &f.sources)
        .unwrap()
        .failures();
    assert_eq!(
        failures,
        ["P1/work_items", "P1/idempotency_keys", "P2/events"]
    );
}

#[test]
fn receipts_that_contradict_themselves_fail_verify() {
    let f = fixture("legacy-contradictions");
    let p = f.project(0);
    p.execute_batch(&format!(
        "INSERT INTO idempotency_keys (key, operation, request_fingerprint, response_json, created_at, op_id, actor_session_id) VALUES
           ('S1:x1', 'work.update', 'fp', '{{}}', '{T}', 'other', NULL),
           ('S1:x2', 'work.update', 'fp', '{{}}', '{T}', 'x2', 'S2'),
           ('session-begin:x3', 'session.recover-or-begin', 'fp', '{{}}', '{T}', 'x3', 'session-begin'),
           ('S1:x4', 'session.recover-or-begin', 'fp', '{{}}', '{T}', 'x4', NULL);"
    ))
    .unwrap();
    drop(p);
    let Err(ConvertError::Verify(report)) = f.convert() else {
        panic!("contradictions must fail verify")
    };
    let v = &report.receipt_violations;
    assert_eq!(v.len(), 4, "{v:?}");
    assert!(v[0].contains("S1:x1") && v[0].contains("F1"));
    assert!(v[1].contains("S1:x2") && v[1].contains("F2"));
    assert!(v[2].contains("S1:x4") && v[2].contains("F3"));
    assert!(
        v[3].contains("session-begin:x3") && v[3].contains("F3"),
        "{}",
        v[3]
    );
    assert!(
        v.iter().all(|m| !m.contains("ok")),
        "violations never quote receipt text"
    );
}

#[test]
fn sources_in_states_the_prototype_does_not_handle_are_refused() {
    let check = |name: &str, tweak: &dyn Fn(&Fixture), expect: &dyn Fn(&ConvertError) -> bool| {
        let f = fixture(name);
        tweak(&f);
        let e = f.convert().unwrap_err();
        assert!(expect(&e), "{name}: {e}");
    };
    check(
        "legacy-unknown-table",
        &|f| {
            f.registry()
                .execute_batch("CREATE TABLE surprise (x)")
                .unwrap()
        },
        &|e| matches!(e, ConvertError::UnknownTable(_)),
    );
    check(
        "legacy-old-schema",
        &|f| {
            f.project(1)
                .execute("DELETE FROM schema_migrations WHERE version = 18", [])
                .unwrap();
        },
        &|e| matches!(e, ConvertError::UnsupportedSchema(_)),
    );
    check(
        "legacy-creating",
        &|f| {
            f.registry()
                .execute(
                    "UPDATE projects SET lifecycle = 'CREATING' WHERE id = 'P2'",
                    [],
                )
                .unwrap();
        },
        &|e| matches!(e, ConvertError::Unsupported(_)),
    );
    check(
        "legacy-code-mismatch",
        &|f| {
            f.project(1)
                .execute("UPDATE project_meta SET project_code = 'ZZZ'", [])
                .unwrap();
        },
        &|e| matches!(e, ConvertError::Mismatch(_)),
    );
    check(
        "legacy-project-settings",
        &|f| {
            f.project(0)
                .execute(
                    "INSERT INTO settings (key, value_json, updated_at) VALUES ('k', '1', 'T')",
                    [],
                )
                .unwrap();
        },
        &|e| matches!(e, ConvertError::Unsupported(_)),
    );
    check(
        "legacy-sequence-below",
        &|f| {
            f.project(0)
                .execute("UPDATE project_meta SET current_sequence = 2", [])
                .unwrap();
        },
        &|e| matches!(e, ConvertError::Mismatch(_)),
    );
    check(
        "legacy-global-sequence-below",
        &|f| {
            f.registry()
                .execute("UPDATE app_meta SET current_sequence = 3", [])
                .unwrap();
        },
        &|e| matches!(e, ConvertError::Mismatch(_)),
    );

    // 少给一个项目库。
    let mut f = fixture("legacy-missing-project");
    f.sources.projects.pop();
    assert!(matches!(f.convert(), Err(ConvertError::Mismatch(_))));
    // 目标已存在。
    let f = fixture("legacy-target-exists");
    fs::create_dir_all(f.dir.join("out")).unwrap();
    fs::write(f.target(), b"x").unwrap();
    let e = convert(
        &f.sources,
        &f.target(),
        &ConvertOptions {
            at: T,
            allow_real_data_root: false,
            real_data_root: None,
        },
    )
    .unwrap_err();
    assert!(matches!(e, ConvertError::TargetExists(_)));
}

#[test]
fn the_real_data_root_is_refused_unless_explicitly_allowed() {
    let f = fixture("legacy-real-root");
    // 把夹具所在目录当成「真实数据根」：转换必须拒绝读它。
    let target = f.dir.join("out").join("atm.sqlite");
    fs::create_dir_all(f.dir.join("out")).unwrap();
    let e = convert(
        &f.sources,
        &target,
        &ConvertOptions {
            at: T,
            allow_real_data_root: false,
            real_data_root: Some(&f.dir),
        },
    )
    .unwrap_err();
    assert!(matches!(e, ConvertError::RealDataRoot(_)), "{e}");
    assert!(!target.exists(), "nothing is written before the refusal");
    // 绕路写法也拒绝。
    let mut sneaky = f.sources.clone();
    sneaky.registry = f.dir.join("out").join("..").join("registry.sqlite");
    let e = convert(
        &sneaky,
        &target,
        &ConvertOptions {
            at: T,
            allow_real_data_root: false,
            real_data_root: Some(&f.dir),
        },
    )
    .unwrap_err();
    assert!(matches!(e, ConvertError::RealDataRoot(_)), "{e}");
    // 明确允许时照常转换。
    convert(
        &f.sources,
        &target,
        &ConvertOptions {
            at: T,
            allow_real_data_root: true,
            real_data_root: Some(&f.dir),
        },
    )
    .unwrap();
}
