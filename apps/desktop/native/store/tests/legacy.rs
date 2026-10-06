//! 2.x → 3.0 转换原型的验收（W1f）。
//!
//! 夹具用仓库里 2.x 自己的迁移 SQL（`migrations/{registry,knowledge,project}`）建库，schema 与 2.0 运行时一致；
//! 数据是合成的，含边界情况：两个项目重号、超大事件、损坏的 JSON 文本、各种形状的旧回执（R7‴ 的向量）、
//! 孤儿全局事件、没送达的投影。全程不碰真实数据根。

use atm_store::jsjson;
use atm_store::legacy::{
    ConvertError, ConvertOptions, LegacySources, Normalization, Report, convert, verify_converted,
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
           (6, 'work.updated', 'W1', 'claude', '{{\"sourceEventId\":\"F1-big\"}}', '{T}', 'project:P2:outbox:O8'),
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
           ('agent:abc', 'fp2', '{\"id\":\"K1\",\"revision\":1}'),
           ('agent:list', 'fp3', '[1]');"
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

    // P1 的 outbox：一条已送达且有镜像；一条已送达但全局流里没有镜像（照样要补）；
    // 一条没送达、事件在、没有镜像（要补）；一条没送达、找不到事件。P2 没有 outbox，缺镜像的事件照样要补。
    let p1 = Connection::open(&projects[0]).unwrap();
    p1.execute_batch(&format!(
        "INSERT INTO outbox (id, project_sequence, type, payload_json, created_at, delivered_at) VALUES
           ('O1', 1, 'registry.project_changed', '{{\"eventId\":\"E1\"}}', '{T}', '{T}'),
           ('O4', 2, 'registry.project_changed', '{{\"eventId\":\"E1-big\"}}', '{T}', '{T}'),
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

    // 全局流（R6）：能匹配到事件的填上 event_id（dedupe_key，其次 sourceEventId）；孤儿留空；
    // 没有镜像的事件按差集补到末尾，不看 outbox。
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
        q::<String>(
            &t,
            "SELECT project_id || '/' || event_id FROM global_feed WHERE global_seq = 6"
        ),
        "P2/F1-big",
        "linked through sourceEventId"
    );
    assert_eq!(
        (
            report.global_orphans,
            report.mirrors_replayed,
            report.outbox_without_event
        ),
        (1, 3, 1)
    );
    // 每个项目的事件都恰好有一个镜像。
    assert_eq!(
        q::<i64>(
            &t,
            "SELECT count(*) FROM events e WHERE (SELECT count(*) FROM global_feed g
               WHERE g.project_id = e.project_id AND g.event_id = e.id) <> 1"
        ),
        0
    );
    assert_eq!(
        q::<String>(
            &t,
            "SELECT group_concat(project_id || '/' || event_id || '@' || (payload_json ->> '$.projectSequence'), ',')
             FROM (SELECT * FROM global_feed WHERE global_seq > 7 ORDER BY global_seq)"
        ),
        "P1/E1-big@2,P1/E1-bad@4,P2/F1-bad@4"
    );
    // 损坏的 payload 按 2.0 readJson 的回退当 {}，再补上项目字段。
    assert_eq!(
        q::<String>(
            &t,
            "SELECT payload_json FROM global_feed WHERE global_seq = 9"
        ),
        r#"{"projectId":"P1","projectCode":"AAA","projectName":"Alpha","projectSequence":4,"sourceEventId":"E1-bad","sourceProjectSequence":4,"sourceAggregateType":"WORK_ITEM","sourceAggregateId":"W1"}"#
    );
    assert_eq!(
        q::<String>(
            &t,
            "SELECT dedupe_key || ' ' || type || ' ' || actor FROM global_feed WHERE global_seq = 10"
        ),
        "project:P2:event:F1-bad work.updated claude"
    );
    assert_eq!(q::<i64>(&t, "SELECT global_seq FROM app_meta"), 10);
    assert_eq!(
        q::<i64>(
            &t,
            "SELECT converted_from ->> '$.mirrorsReplayed' FROM app_meta"
        ),
        3
    );

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
    // 回执原文是 JSON 但不是对象（2.x 的 CHECK 只保证 json_valid）：按旧格式记，原文逐字节保留。
    assert_eq!(
        q::<String>(
            &t,
            "SELECT receipt_format || '|' || receipt_json FROM idempotency_receipts WHERE scope_kind = 'KNOWLEDGE' AND legacy_key = 'agent:list'"
        ),
        "knowledge-entry-legacy|[1]"
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
    assert_eq!(report.dropped.get("project.outbox"), Some(&4));
    assert_eq!(q::<String>(&t, "PRAGMA integrity_check"), "ok");
    assert_eq!(
        q::<i64>(&t, "SELECT count(*) FROM pragma_foreign_key_check"),
        0
    );

    // 复核一次：转换后的库对同一组源仍全部相等。
    assert!(
        verify_converted(&f.target(), &f.sources, &report)
            .unwrap()
            .failures()
            .is_empty()
    );
}

#[test]
fn verify_notices_a_target_that_drifted_from_its_source() {
    let f = fixture("legacy-drift");
    let report = f.convert().unwrap();
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
    let failures = verify_converted(&f.target(), &f.sources, &report)
        .unwrap()
        .failures();
    assert_eq!(
        failures,
        ["P1/work_items", "P1/idempotency_keys", "P2/events"]
    );
}

#[test]
fn verify_rebuilds_the_global_feed_from_the_sources() {
    let f = fixture("legacy-feed-tamper");
    let report = f.convert().unwrap();
    let clean = f.dir.join("out").join("clean.sqlite");
    fs::copy(f.target(), &clean).unwrap();
    let cases: &[(&str, &str, &[&str])] = &[
        ("delete a replayed mirror", "DELETE FROM global_feed WHERE global_seq = 9", &["r/global_feed.replayed"]),
        (
            "duplicate a replayed mirror",
            "INSERT INTO global_feed (global_seq, type, aggregate_id, actor, payload_json, created_at, dedupe_key, project_id, event_id)
             SELECT 11, type, aggregate_id, actor, payload_json, created_at, NULL, project_id, event_id FROM global_feed WHERE global_seq = 10",
            &["r/global_feed.replayed"],
        ),
        ("mirror under the wrong project", "UPDATE global_feed SET project_id = 'P2' WHERE global_seq = 9", &["r/global_feed.replayed"]),
        ("mirror of the wrong event", "UPDATE global_feed SET event_id = 'E1' WHERE global_seq = 9", &["r/global_feed.replayed"]),
        (
            "mirror payload changed",
            "UPDATE global_feed SET payload_json = json_set(payload_json, '$.projectSequence', 5) WHERE global_seq = 10",
            &["r/global_feed.replayed"],
        ),
        (
            "replay count misreported",
            "UPDATE app_meta SET converted_from = json_set(converted_from, '$.mirrorsReplayed', 2)",
            &["r/app_meta.global_seq"],
        ),
        ("high water moved", "UPDATE app_meta SET global_seq = 11", &["r/app_meta.global_seq"]),
        ("old row unlinked", "UPDATE global_feed SET event_id = NULL WHERE global_seq = 6", &["r/global_feed.links"]),
        ("orphan given an event", "UPDATE global_feed SET event_id = 'E1' WHERE global_seq = 4", &["r/global_feed.links"]),
        ("non-project row claimed", "UPDATE global_feed SET project_id = 'P1' WHERE global_seq = 7", &["r/global_feed.links"]),
    ];
    for (name, tamper, expected) in cases {
        fs::copy(&clean, f.target()).unwrap();
        let t = Connection::open(f.target()).unwrap();
        t.execute_batch(tamper).unwrap();
        drop(t);
        let failures = verify_converted(&f.target(), &f.sources, &report)
            .unwrap()
            .failures();
        assert_eq!(&failures, expected, "{name}");
    }
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

fn data(name: &str) -> serde_json::Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("data")
        .join(name);
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn text(v: &serde_json::Value, key: &str) -> String {
    v[key].as_str().unwrap().to_string()
}

/// W1 peer r2 P1-r2-01、r3 P1-r3-01 / P1-r3-02：补投影的 payload 是 2.0 的
/// `JSON.stringify({ ...readJson(payload, {}), 项目字段 })`。期望由 node 跑 2.0 的 readJson、对象展开与
/// JSON.stringify 生成（`tests/data/spread-vectors.mjs`），不由本 crate 生成，要求逐字节一致。
/// 向量覆盖数组里的落单代理项和长小数、重复键、下标形状的键、SQLite 深度上限（1000）两侧和本 crate 的上限。
/// 全部向量作为 P1 的事件 `SV<i>`（序号 100 + i）插入，一次转换补出全部镜像；转换内含 VERIFY。
#[test]
fn replayed_mirrors_spread_payloads_like_2x() {
    let d = data("spread-vectors.json");
    assert_eq!(d["maxDepth"].as_u64(), Some(jsjson::MAX_DEPTH as u64));
    let vectors = d["vectors"].as_array().unwrap();
    let f = fixture("legacy-spread");
    let p = f.project(0);
    for v in vectors {
        p.execute(
            "INSERT INTO events (id, sequence, type, actor_type, actor_id, aggregate_type, aggregate_id, payload_json, created_at)
             VALUES (?1, ?2, 'work.updated', 'AGENT', 'claude', 'WORK_ITEM', 'W1', ?3, ?4)",
            params![
                text(v, "eventId"),
                v["sequence"].as_i64().unwrap(),
                text(v, "source"),
                T2
            ],
        )
        .unwrap();
    }
    let last = vectors.last().unwrap()["sequence"].as_i64().unwrap();
    p.execute("UPDATE project_meta SET current_sequence = ?1", [last])
        .unwrap();
    drop(p);
    let report = f.convert().unwrap();
    assert!(report.failures().is_empty(), "{:?}", report.failures());

    let t = Connection::open(f.target()).unwrap();
    let mut wrong = Vec::new();
    for v in vectors {
        let name = text(v, "name");
        let got: Vec<u8> = t
            .query_row(
                "SELECT CAST(payload_json AS BLOB) FROM global_feed WHERE project_id = 'P1' AND event_id = ?1",
                [text(v, "eventId")],
                |r| r.get(0),
            )
            .unwrap_or_else(|e| panic!("{name}: no mirror ({e})"));
        let got =
            String::from_utf8(got).unwrap_or_else(|e| panic!("{name}: mirror is not UTF-8 ({e})"));
        if got != text(v, "mirror") {
            wrong.push(format!("{name}: {got}"));
        }
    }
    assert!(
        wrong.is_empty(),
        "mirrors differ from node:\n{}",
        wrong.join("\n")
    );
}

/// 同一批向量直接对照 `jsjson`（单纯展开和完整镜像），不经过 SQLite。跑在 256 KiB 栈的线程上：
/// 解析和输出不递归，MAX_DEPTH 层也不依赖调用线程的栈大小（递归实现在默认 2 MiB 的测试线程上就溢出）。
#[test]
fn spread_and_stringify_match_node_without_sqlite() {
    let d = data("spread-vectors.json");
    std::thread::Builder::new()
        .stack_size(256 << 10)
        .spawn(move || {
            for v in d["vectors"].as_array().unwrap() {
                let (name, source) = (text(v, "name"), text(v, "source"));
                assert_eq!(
                    jsjson::spread_json(Some(&source)).unwrap_or_else(|_| panic!("{name}: too deep")),
                    text(v, "spread"),
                    "{name}"
                );
                let fields = format!(
                    "{{\"projectId\":\"P1\",\"projectCode\":\"AAA\",\"projectName\":\"Alpha\",\"projectSequence\":{seq},\
                     \"sourceEventId\":\"{id}\",\"sourceProjectSequence\":{seq},\"sourceAggregateType\":\"WORK_ITEM\",\
                     \"sourceAggregateId\":\"W1\"}}",
                    seq = v["sequence"],
                    id = text(v, "eventId")
                );
                assert_eq!(
                    jsjson::mirror_payload(Some(&source), &fields).unwrap(),
                    text(v, "mirror"),
                    "{name}"
                );
            }
            for v in d["refused"].as_array().unwrap() {
                assert_eq!(
                    jsjson::spread_json(Some(&text(v, "source"))).err(),
                    Some(jsjson::TooDeep),
                    "{}",
                    text(v, "name")
                );
            }
        })
        .unwrap()
        .join()
        .unwrap();
}

/// JS 的 `Number::toString`：node 生成的 5000 个数（特殊值、10 的幂、2^53 附近、随机位模式），
/// 格式化逐字节一致；解析 node 的文本得到同一个位模式（-0 输出为 0）。
#[test]
fn numbers_format_and_parse_like_v8() {
    let d = data("numbers.json");
    let numbers = d["numbers"].as_array().unwrap();
    assert!(numbers.len() >= 4000);
    for pair in numbers {
        let bits = u64::from_str_radix(pair[0].as_str().unwrap(), 16).unwrap();
        let expected = pair[1].as_str().unwrap();
        let x = f64::from_bits(bits);
        assert_eq!(jsjson::number_to_string(x), expected, "{bits:016x}");
        let y = jsjson::parse(expected)
            .ok()
            .flatten()
            .and_then(|doc| doc.as_number())
            .unwrap_or_else(|| panic!("{expected} does not parse as a number"));
        assert_eq!(y.to_bits(), if x == 0.0 { 0 } else { bits }, "{expected}");
    }
}

/// 嵌套超过 MAX_DEPTH 的合法 JSON：转换显式失败并写明事件，不把内容清空后通过 VERIFY。
#[test]
fn payloads_nested_beyond_the_supported_depth_are_refused() {
    let d = data("spread-vectors.json");
    for v in d["refused"].as_array().unwrap() {
        let f = fixture(&format!("legacy-too-deep-{}", text(v, "name")));
        f.project(0)
            .execute(
                "UPDATE events SET payload_json = ?1 WHERE id = 'E1-big'",
                [text(v, "source")],
            )
            .unwrap();
        let err = f
            .convert()
            .expect_err("a payload deeper than the supported depth converted");
        let msg = err.to_string();
        assert!(
            msg.contains("event P1/E1-big") && msg.contains("deeper than"),
            "{msg}"
        );
    }
}

/// 关联旧全局行用的 `sourceEventId`、outbox 的 `eventId` 按 JSON.parse 读：重复键取最后一个，
/// 转义的键名照样认；深度超限报错而不是当作没有。
#[test]
fn reading_a_payload_field_follows_json_parse() {
    use jsjson::{MAX_DEPTH, TooDeep, top_level_string as get};
    let k = "sourceEventId";
    assert_eq!(
        get(r#"{"sourceEventId":"A","sourceEventId":"B"}"#, k),
        Ok(Some("B".to_string()))
    );
    let escaped = format!("{{\"source{}u0045ventId\":\"A\"}}", '\\');
    assert_eq!(get(&escaped, k), Ok(Some("A".to_string())));
    assert_eq!(get(r#"{"sourceEventId":1}"#, k), Ok(None));
    assert_eq!(get("not json", k), Ok(None));
    let deep = format!(
        "{{\"sourceEventId\":\"A\",\"d\":{}{}}}",
        "[".repeat(MAX_DEPTH),
        "]".repeat(MAX_DEPTH)
    );
    assert_eq!(get(&deep, k), Err(TooDeep));
}

/// W1 peer r4 P2-09：关联旧全局行（`sourceEventId`）和统计 outbox（`eventId`）时遇到超限 payload，
/// 走真实的转换 SQL 失败，错误写明是源库里的哪一行（项目 + 全局序号与 dedupe_key，或项目 + outbox id）。
#[test]
fn field_reads_beyond_the_supported_depth_name_the_source_row() {
    let deep = |field: &str, value: &str| {
        format!(
            "{{\"{field}\":\"{value}\",\"d\":{}{}}}",
            "[".repeat(jsjson::MAX_DEPTH),
            "]".repeat(jsjson::MAX_DEPTH)
        )
    };
    let f = fixture("legacy-deep-global-row");
    f.registry()
        .execute(
            "UPDATE global_events SET payload_json = ?1 WHERE sequence = 6",
            [deep("sourceEventId", "F1-big")],
        )
        .unwrap();
    let msg = f
        .convert()
        .expect_err("a deep global row converted")
        .to_string();
    assert!(
        msg.contains("project P2 global row 6 (project:P2:outbox:O8): payload nests deeper than"),
        "{msg}"
    );

    let f = fixture("legacy-deep-outbox");
    f.project(0)
        .execute(
            "UPDATE outbox SET payload_json = ?1 WHERE id = 'O2'",
            [deep("eventId", "E1-bad")],
        )
        .unwrap();
    let msg = f
        .convert()
        .expect_err("a deep outbox row converted")
        .to_string();
    assert!(
        msg.contains("project P1 outbox O2: payload nests deeper than"),
        "{msg}"
    );
}

// ===== 规范化规则（10 R9′；store/NORMALIZATION.md）=====

/// P1 里放上每条规则的非默认值：终态任务的残留领取（N-01）、三列遗留值（N-02a～c）、标签与 RELATES /
/// DUPLICATES（N-02d～f）、四种 lineage 边（N-05）、只报告的遗留值（O-01～O-03）。
fn rules_fixture(name: &str) -> Fixture {
    let f = fixture(name);
    f.project(0)
        .execute_batch(&format!(
            "UPDATE counters SET next_value = 4 WHERE name = 'work_item';
             INSERT INTO work_items (id, local_no, objective_id, type, title, status, priority, assignee_agent_id,
                                     claimed_by_session_id, claim_lease_until, archived_at, phase_inferred,
                                     planned_start_date, progress_source, version, created_at, updated_at) VALUES
               ('W2', 2, 'OBJ', 'TASK', 'done but claimed', 'DONE', 'NORMAL', 'claude', 'S1', '{T2}', '{T2}', 1,
                '2026-09-10', 'STATUS', 7, '{T}', '{T}'),
               ('W3', 3, 'OBJ', 'TASK', 'cancelled, lease only', 'CANCELLED', 'NORMAL', NULL, NULL, '{T2}', NULL, 0,
                NULL, 'NONE', 2, '{T}', '{T}');
             INSERT INTO work_item_relations (source_id, target_id, relation_type, created_at) VALUES
               ('W1', 'W2', 'BLOCKS', '{T}'), ('W1', 'W3', 'RELATES', '{T}'), ('W2', 'W3', 'DUPLICATES', '{T}'),
               ('W3', 'W1', 'DISCOVERED_FROM', '{T}');
             INSERT INTO labels (id, name, color, created_at) VALUES ('L1', '紧急', '#f00', '{T}');
             INSERT INTO work_item_labels (work_item_id, label_id) VALUES ('W1', 'L1');
             INSERT INTO checklist_items (id, work_item_id, title, kind, status, created_at, updated_at) VALUES
               ('C1', 'W1', 'optional step', 'OPTIONAL', 'TODO', '{T}', '{T}'),
               ('C2', 'W1', 'acceptance', 'ACCEPTANCE', 'TODO', '{T}', '{T}'),
               ('C3', 'W1', 'verification', 'VERIFICATION', 'TODO', '{T}', '{T}');
             INSERT INTO counters (name, next_value) VALUES ('blocker', 2);
             INSERT INTO blockers (id, local_no, work_item_id, severity, title, status, actor, created_at, updated_at)
               VALUES ('B1', 1, 'W1', 'LOW', 'gone', 'CANCELLED', 'USER', '{T}', '{T}');
             INSERT INTO agents (id, display_name, client_kind, created_at, updated_at) VALUES ('codex', 'Codex', 'cli', '{T}', '{T}');
             INSERT INTO agent_sessions (id, agent_id, role, work_state, connection_state, started_at, updated_at, predecessor_session_id) VALUES
               ('S2', 'claude', 'PRIMARY', 'IDLE', 'OFFLINE', '{T2}', '{T2}', 'S1'),
               ('S3', 'codex', 'PRIMARY', 'IDLE', 'OFFLINE', '{T2}', '{T2}', 'S1'),
               ('S4', 'claude', 'REVIEWER', 'IDLE', 'OFFLINE', '{T2}', '{T2}', 'S1'),
               ('S5', 'claude', 'PRIMARY', 'IDLE', 'OFFLINE', '{T}', '{T}', 'S2'),
               ('S6', 'claude', 'SUBAGENT', 'IDLE', 'OFFLINE', '{T}', '{T}', 'S7'),
               ('S7', 'claude', 'SUBAGENT', 'IDLE', 'OFFLINE', '{T}', '{T}', 'S6');"
        ))
        .unwrap();
    f
}

fn rule<'a>(r: &'a Report, rule: &str, family: &str) -> &'a Normalization {
    r.normalizations
        .iter()
        .find(|n| n.rule == rule && n.family == family)
        .unwrap_or_else(|| panic!("no record {rule} {family}: {:?}", r.normalizations))
}

#[test]
fn n01_n02_rewrite_drop_and_attach_exactly_the_registered_values() {
    let f = rules_fixture("legacy-rules");
    let report = f.convert().unwrap();
    let t = Connection::open(f.target()).unwrap();

    // N-01：只有终态任务的领取两列变 NULL；assignee、version、updated_at 不动；进行中的 W1 原样。
    type Claim = (String, Option<String>, Option<String>, Option<String>, i64);
    let claims: Vec<Claim> = t
        .prepare(
            "SELECT id, claimed_by_session_id, claim_lease_until, assignee_agent_id, version FROM work_items
             WHERE project_id = 'P1' ORDER BY id",
        )
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        claims,
        [
            ("W1".into(), Some("S1".into()), None, None, 0),
            ("W2".into(), None, None, Some("claude".into()), 7),
            ("W3".into(), None, None, None, 2),
        ]
    );
    assert_eq!(rule(&report, "N-01@1", "P1/work_items").count, 2);
    assert_eq!(rule(&report, "N-01@1", "P2/work_items").count, 0);

    // N-02：目标不建这些列、表与关系类型；非默认值逐条进附件。
    let cols: Vec<String> = t
        .prepare("SELECT name FROM pragma_table_info('work_items')")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    for gone in ["archived_at", "phase_inferred", "planned_start_date"] {
        assert!(!cols.iter().any(|c| c == gone), "{gone}");
    }
    assert_eq!(
        q::<i64>(
            &t,
            "SELECT count(*) FROM sqlite_master WHERE name IN ('labels', 'work_item_labels')"
        ),
        0
    );
    assert_eq!(
        q::<String>(
            &t,
            "SELECT group_concat(relation_type, ',') FROM (SELECT relation_type FROM work_item_relations ORDER BY 1)"
        ),
        "BLOCKS,DISCOVERED_FROM"
    );
    for (r, family, n) in [
        ("N-02a@1", "P1/work_items.archived_at", 1),
        ("N-02b@1", "P1/work_items.phase_inferred", 1),
        ("N-02c@1", "P1/work_items.planned_start_date", 1),
        ("N-02d@1", "P1/labels", 1),
        ("N-02e@1", "P1/work_item_labels", 1),
        ("N-02f@1", "P1/work_item_relations", 2),
        ("N-02f@1", "P2/work_item_relations", 0),
    ] {
        assert_eq!(rule(&report, r, family).count, n, "{r} {family}");
    }
    assert_eq!(
        report.attachment["P1/work_items.archived_at"],
        [format!("{{\"id\":\"W2\",\"value\":\"{T2}\"}}")]
    );
    assert_eq!(
        report.attachment["P1/work_items.phase_inferred"],
        ["{\"id\":\"W2\",\"value\":1}"]
    );
    assert_eq!(
        report.attachment["P1/labels"],
        [format!(
            "{{\"id\":\"L1\",\"name\":\"紧急\",\"color\":\"#f00\",\"created_at\":\"{T}\"}}"
        )]
    );
    assert_eq!(report.attachment["P1/work_item_relations"].len(), 2);
    assert!(
        !report.attachment.contains_key("P2/labels"),
        "empty families have no attachment"
    );
    // 附件单独成文，报告的规则记录里只有计数与摘要。
    let jsonl = report.attachment_jsonl();
    assert_eq!(jsonl.lines().count(), 7);
    assert!(jsonl.lines().all(|l| l.starts_with("{\"family\":\"P1/")));
    assert!(!format!("{:?}", report.normalizations).contains("紧急"));

    // N-05：不改数据，按原因计数；同一时刻的环两条边都算 SAME_INSTANT。
    for (reason, ids) in [
        ("CROSS_AGENT", 1),
        ("CROSS_ROLE", 1),
        ("TIME_REVERSED", 1),
        ("SAME_INSTANT", 2),
    ] {
        assert_eq!(
            rule(&report, &format!("N-05@1:{reason}"), "P1/agent_sessions").count,
            ids,
            "{reason}"
        );
    }
    assert_eq!(
        q::<String>(
            &t,
            "SELECT predecessor_session_id FROM agent_sessions WHERE project_id = 'P1' AND id = 'S3'"
        ),
        "S1"
    );

    // 只报告的遗留值：原样转换并计数。
    assert_eq!(report.observations["O-01 P1/checklist_items"], 2);
    assert_eq!(report.observations["O-02 P1/blockers"], 1);
    assert_eq!(report.observations["O-03 P1/work_items"], 1);
    assert_eq!(
        q::<String>(
            &t,
            "SELECT kind FROM checklist_items WHERE project_id = 'P1' AND id = 'C1'"
        ),
        "OPTIONAL"
    );

    // 复核：对同一组源与这份报告，VERIFY 全部通过。
    let again = verify_converted(&f.target(), &f.sources, &report).unwrap();
    assert!(again.failures().is_empty(), "{:?}", again.failures());
}

/// N-04 的六种情况（NORMALIZATION.md 的表）：目标的 notification.* 行与受影响的键。
#[test]
fn n04_merges_notification_settings_like_2x_reads_them() {
    type Row = (String, String, i64, String);
    type Case<'a> = (&'a str, &'a [(&'a str, &'a str, i64)], &'a [Row], usize);
    let cases: &[Case] = &[
        ("neither", &[], &[], 0),
        (
            "mode only, valid",
            &[("notification.mode", "\"CRITICAL\"", 3)],
            &[(
                "notification.mode".into(),
                "\"CRITICAL\"".into(),
                3,
                T.into(),
            )],
            0,
        ),
        (
            "mode only, invalid",
            &[("notification.mode", "\"loud\"", 3)],
            &[("notification.mode".into(), "\"ALL\"".into(), 3, T.into())],
            1,
        ),
        (
            "enabled false only",
            &[("notification.enabled", "false", 4)],
            &[("notification.mode".into(), "\"OFF\"".into(), 4, T.into())],
            2,
        ),
        (
            "enabled as string",
            &[("notification.enabled", "\"false\"", 4)],
            &[("notification.mode".into(), "\"ALL\"".into(), 4, T.into())],
            2,
        ),
        (
            "enabled not json",
            &[("notification.enabled", "nope", 4)],
            &[("notification.mode".into(), "\"ALL\"".into(), 4, T.into())],
            2,
        ),
        (
            "both, mode valid",
            &[
                ("notification.enabled", "false", 4),
                ("notification.mode", "\"ALL\"", 6),
            ],
            &[("notification.mode".into(), "\"ALL\"".into(), 6, T.into())],
            1,
        ),
        (
            "both, mode invalid",
            &[
                ("notification.enabled", "false", 4),
                ("notification.mode", "7", 6),
            ],
            &[("notification.mode".into(), "\"OFF\"".into(), 6, T.into())],
            2,
        ),
    ];
    for (name, rows, expected, touched) in cases {
        let f = fixture("legacy-n04");
        let r = f.registry();
        for (key, value, version) in *rows {
            r.execute(
                "INSERT INTO settings (key, value_json, version, updated_at) VALUES (?1, ?2, ?3, ?4)",
                params![key, value, version, T],
            )
            .unwrap();
        }
        drop(r);
        let report = f.convert().unwrap_or_else(|e| panic!("{name}: {e}"));
        let t = Connection::open(f.target()).unwrap();
        let got: Vec<Row> = t
            .prepare("SELECT key, value_json, version, updated_at FROM settings WHERE key LIKE 'notification.%' ORDER BY key")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(&got, expected, "{name}");
        assert_eq!(
            rule(&report, "N-04@1", "r/settings").count,
            *touched as i64,
            "{name}"
        );
        assert_eq!(
            q::<String>(&t, "SELECT value_json FROM settings WHERE key = 'theme'"),
            "\"dark\""
        );
    }
}

/// VERIFY 独立重算：目标多改一个未登记的值、改错主键、报告记错计数或少一行附件，都失败。
#[test]
fn verify_rejects_changes_the_rules_do_not_explain() {
    let f = rules_fixture("legacy-rules-tamper");
    let report = f.convert().unwrap();
    let clean = f.dir.join("out").join("clean.sqlite");
    fs::copy(f.target(), &clean).unwrap();
    let target_cases: &[(&str, &str, &[&str])] = &[
        (
            "claim cleared on a task that is not terminal",
            "UPDATE work_items SET claimed_by_session_id = NULL WHERE project_id = 'P1' AND id = 'W1'",
            &["P1/work_items"],
        ),
        (
            "an unregistered column changed next to a registered one",
            "UPDATE work_items SET assignee_agent_id = NULL WHERE project_id = 'P1' AND id = 'W2'",
            &["P1/work_items"],
        ),
        (
            "a kept relation dropped",
            "DELETE FROM work_item_relations WHERE project_id = 'P1' AND relation_type = 'BLOCKS'",
            &["P1/work_item_relations"],
        ),
        (
            "notification mode rewritten",
            "INSERT INTO settings (key, value_json, version, updated_at) VALUES ('notification.mode', '\"OFF\"', 0, 'x')",
            &["r/settings"],
        ),
    ];
    for (name, tamper, expected) in target_cases {
        fs::copy(&clean, f.target()).unwrap();
        let t = Connection::open(f.target()).unwrap();
        t.execute_batch(tamper).unwrap();
        drop(t);
        let failures = verify_converted(&f.target(), &f.sources, &report)
            .unwrap()
            .failures();
        assert_eq!(&failures, expected, "{name}");
    }

    fs::copy(&clean, f.target()).unwrap();
    let mut miscounted = report.clone();
    miscounted
        .normalizations
        .iter_mut()
        .find(|n| n.rule == "N-01@1" && n.family == "P1/work_items")
        .unwrap()
        .count = 1;
    let failures = verify_converted(&f.target(), &f.sources, &miscounted)
        .unwrap()
        .failures();
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert!(
        failures[0].starts_with("N-01@1 P1/work_items: converted 1 "),
        "{failures:?}"
    );

    let mut wrong_keys = report.clone();
    let n = wrong_keys
        .normalizations
        .iter_mut()
        .find(|n| n.rule == "N-05@1:CROSS_AGENT")
        .unwrap();
    n.keys_digest = wrong_keys_digest(&n.keys_digest);
    let failures = verify_converted(&f.target(), &f.sources, &wrong_keys)
        .unwrap()
        .failures();
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert!(
        failures[0].starts_with("N-05@1:CROSS_AGENT P1/agent_sessions"),
        "{failures:?}"
    );

    let mut short = report.clone();
    short.attachment.remove("P1/labels");
    let failures = verify_converted(&f.target(), &f.sources, &short)
        .unwrap()
        .failures();
    assert_eq!(
        failures,
        ["attachment P1/labels: converted 0 rows, verify 1 rows"]
    );

    let mut unrecorded = report.clone();
    unrecorded.normalizations.retain(|n| n.rule != "N-04@1");
    let failures = verify_converted(&f.target(), &f.sources, &unrecorded)
        .unwrap()
        .failures();
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert!(
        failures[0].starts_with("N-04@1 r/settings: converted missing"),
        "{failures:?}"
    );
}

/// 摘要换一个同长度的值（模拟「计数相同但主键不同」）。
fn wrong_keys_digest(d: &str) -> String {
    let flipped = if d.starts_with('0') { '1' } else { '0' };
    format!("{flipped}{}", &d[1..])
}
