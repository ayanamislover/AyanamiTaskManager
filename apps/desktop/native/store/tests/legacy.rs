//! 2.x → 3.0 转换原型的验收（W1f）。
//!
//! 夹具用仓库里 2.x 自己的迁移 SQL（`migrations/{registry,knowledge,project}`）建库，schema 与 2.0 运行时一致；
//! 数据是合成的，含边界情况：两个项目重号、超大事件、损坏的 JSON 文本、各种形状的旧回执（R7‴ 的向量）、
//! 孤儿全局事件、没送达的投影。全程不碰真实数据根。

use atm_store::jsjson;
use atm_store::legacy::{
    ConvertError, ConvertOptions, Decision, FAMILIES, FTS_SHADOWS, Home, LegacySources, MIGRATIONS,
    Normalization, Report, business_digest, convert, verify_converted,
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
    legacy_upto(path, kind, i64::MAX)
}

/// 只跑到第 `upto` 个迁移的 2.x 库（停在旧版本的项目库，ARCHIVED / TRASHED 常见）。
/// 登记的内容与 2.0 `migration-runner.ts` 写的一致：完整文件名、文件内容的 sha256、`APPLIED`。
/// 迁移在仓库根的 `migrations/` 里读，sha256 在这里另算，不用转换器嵌入的那一份。
fn legacy_upto(path: &Path, kind: &str, upto: i64) -> Connection {
    use sha2::Digest;
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
        let name = f.file_name().unwrap().to_string_lossy().into_owned();
        let version: i64 = name[..4].parse().unwrap();
        if version > upto {
            break;
        }
        let sql = fs::read(&f).unwrap();
        let sha: String = sha2::Sha256::digest(&sql)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        c.execute_batch(std::str::from_utf8(&sql).unwrap()).unwrap();
        c.execute(
            "INSERT INTO schema_migrations VALUES (?1, ?2, ?3, ?4, 'APPLIED')",
            params![version, name, T, sha],
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
        self.convert_with(None)
    }
    /// 每次从空的 `out` 开始：上一次复制出去的附件、密文、日志不留到这一次。
    fn convert_with(
        &self,
        secrets_check: Option<fn(&[u8]) -> bool>,
    ) -> Result<Report, ConvertError> {
        self.convert_accepting(secrets_check, &[])
    }
    fn convert_accepting(
        &self,
        secrets_check: Option<fn(&[u8]) -> bool>,
        accept_unconvertible: &[&str],
    ) -> Result<Report, ConvertError> {
        let _ = fs::remove_dir_all(self.dir.join("out"));
        fs::create_dir_all(self.dir.join("out")).unwrap();
        convert(
            &self.sources,
            &self.target(),
            &ConvertOptions {
                at: "2026-10-03T00:00:00.000Z",
                allow_real_data_root: false,
                real_data_root: None,
                generation: None,
                secrets_check,
                accept_unconvertible,
                origin_root: None,
                progress: None,
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
    fixture_with(name, i64::MAX)
}

/// 同 [`fixture`]，P2 的库只迁移到 `p2_upto`（夹具里 P2 用到的列在 0008 之后都有）。
fn fixture_with(name: &str, p2_upto: i64) -> Fixture {
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
           ('agent:list', 'fp3', '[1]');
         -- 2.0 发布时写的索引行（knowledge-repository.ts:231-247）：head revision 的内容，列表字段用换行连接。
         INSERT INTO knowledge_fts (entry_id, metadata, title, aliases, tags, summary, use_when, applies_to, body) VALUES
           ('K1', '{\"id\":\"K1\"}', 'Single database', 'one file', 'store', 's', 'u', 'atm', 'two');"
    )
    .unwrap();
    drop(k);

    let mut projects = Vec::new();
    for (pid, code, meta_life) in [("P1", "AAA", "ACTIVE"), ("P2", "BBB", "ACTIVE")] {
        let path = d.join(format!("{pid}.sqlite"));
        let p = legacy_upto(
            &path,
            "project",
            if pid == "P2" { p2_upto } else { i64::MAX },
        );
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
             INSERT INTO work_items (id, local_no, objective_id, type, title, status, phase, priority, claimed_by_session_id, created_at, updated_at)
               VALUES ('W1', 1, 'OBJ', 'TASK', 'shared title words', 'IN_PROGRESS', 'IN_PROGRESS', 'NORMAL', 'S1', '{T}', '{T}');
             INSERT INTO handoffs (id, work_item_id, from_session_id, to_agent_id, summary, next_action, created_at)
               VALUES ('H1', 'W1', 'S1', 'claude', 'sum', 'next', '{T}');
             INSERT INTO search_documents (entity_type, entity_id, entity_key, title, body, updated_at)
               VALUES ('WORK_ITEM', 'W1', '{code}-T-0001', 'shared title words', 'body {pid}', '{T}'),
                      ('RECORD', 'R1', '{code}-R-001', '单库迁移说明', '旧库里的{pid}记录', '{T}');
             -- 2.0 的索引与文档同时写（work-item-maintenance.ts:112-116）。
             INSERT INTO search_documents_fts (entity_type, entity_id, entity_key, title, body)
               SELECT entity_type, entity_id, entity_key, title, body FROM search_documents;"
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
            root: None,
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
        report.checks.len() >= 40,
        "only {} checks ran",
        report.checks.len()
    );
    assert!(report.uncovered().is_empty(), "{:?}", report.uncovered());
    // 覆盖：拿掉一个族的全部检查，它就成了缺口，计入失败；舍弃的族与尚未实现的族不要求检查。
    for (family, scope, spec) in [
        ("k/knowledge_fts", "k", "knowledge_fts"),
        ("P2/handoffs", "P2", "handoffs"),
        ("r/backup_catalog", "r", "backup_catalog"),
    ] {
        let mut stripped = report.clone();
        stripped
            .checks
            .retain(|c| !(c.scope == scope && c.spec == spec));
        assert_eq!(
            stripped.failures(),
            [format!("{family}: no check ran")],
            "{family}"
        );
    }
    let mut stripped = report.clone();
    stripped.checks.retain(|c| c.spec != "schema_migrations");
    assert!(stripped.failures().is_empty(), "{:?}", stripped.failures());
    assert!(
        !Report::default().failures().is_empty(),
        "an unverified report is not clean"
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
    // 舍弃的派生族：源摘要照样算，供报告与 business_digest。
    assert_eq!(
        report.source("r/global_search_documents").map(|s| s.rows),
        Some(1)
    );
    assert_eq!(report.source("P1/outbox").map(|s| s.rows), Some(4));
    assert_eq!(report.source("P2/outbox").map(|s| s.rows), Some(0));
    // 搜索按 2.0 与 3.0 各查一遍，命中集合相同；短词（两个汉字）也在探针里。
    let queries = report
        .checks
        .iter()
        .find(|c| c.family == "P1/search_documents.queries")
        .unwrap();
    assert!(queries.ok() && queries.source_rows >= 6, "{queries:?}");
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
    // 旧版本的库会在副本上补迁移（W3b3），比转换器新的才拒绝。
    check(
        "legacy-newer-schema",
        &|f| {
            f.project(1)
                .execute(
                    "INSERT INTO schema_migrations VALUES (19, '0019_future.sql', 'x', 'ab', 'APPLIED')",
                    [],
                )
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
            generation: None,
            secrets_check: None,
            accept_unconvertible: &[],
            origin_root: None,
            progress: None,
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
            generation: None,
            secrets_check: None,
            accept_unconvertible: &[],
            origin_root: None,
            progress: None,
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
            generation: None,
            secrets_check: None,
            accept_unconvertible: &[],
            origin_root: None,
            progress: None,
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
            generation: None,
            secrets_check: None,
            accept_unconvertible: &[],
            origin_root: None,
            progress: None,
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
             UPDATE work_items SET phase = status WHERE id IN ('W2', 'W3');
             INSERT INTO work_item_relations (source_id, target_id, relation_type, created_at) VALUES
               ('W1', 'W2', 'BLOCKS', '{T}'), ('W1', 'W3', 'RELATES', '{T}'), ('W2', 'W3', 'DUPLICATES', '{T}'),
               ('W3', 'W1', 'DISCOVERED_FROM', '{T}');
             INSERT INTO labels (id, name, color, created_at) VALUES ('L1', '紧急', '#f00', '{T}');
             INSERT INTO work_item_labels (work_item_id, label_id) VALUES ('W1', 'L1');
             INSERT INTO checklist_items (id, work_item_id, title, kind, status, created_at, updated_at) VALUES
               ('C1', 'W1', 'optional step', 'OPTIONAL', 'TODO', '{T}', '{T}'),
               ('C2', 'W1', 'acceptance', 'ACCEPTANCE', 'TODO', '{T}', '{T}'),
               ('C3', 'W1', 'verification', 'VERIFICATION', 'TODO', '{T}', '{T}'),
               ('C4', 'W1', 'optional, evidence required', 'OPTIONAL', 'DOING', '{T}', '{T}'),
               ('C5', 'W1', 'optional, done', 'OPTIONAL', 'DONE', '{T}', '{T}');
             UPDATE checklist_items SET evidence_required = 1 WHERE id = 'C4';
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
    assert_eq!(jsonl.lines().count(), 13);
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

    // N-02g～i（00 C-16）：遗留取值不入新库，改写后与 2.0 完成门结论相同，原值进附件。
    let checklist: Vec<(String, String, String)> = t
        .prepare("SELECT id, kind, status FROM checklist_items WHERE project_id = 'P1' ORDER BY id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let expected: Vec<(String, String, String)> = [
        ("C1", "ACCEPTANCE", "SKIPPED"), // OPTIONAL、不必证、未完成：2.0 完成门不看它
        ("C2", "ACCEPTANCE", "TODO"),
        ("C3", "ACCEPTANCE", "TODO"),  // VERIFICATION：2.0 完成门看它
        ("C4", "ACCEPTANCE", "DOING"), // OPTIONAL 但必证：2.0 的证据谓词照样拦它
        ("C5", "ACCEPTANCE", "DONE"),
    ]
    .map(|(a, b, c)| (a.into(), b.into(), c.into()))
    .to_vec();
    assert_eq!(checklist, expected);
    assert_eq!(
        report.attachment["P1/checklist_items.kind"],
        [
            "{\"id\":\"C1\",\"value\":\"OPTIONAL\",\"status\":\"TODO\"}",
            "{\"id\":\"C3\",\"value\":\"VERIFICATION\",\"status\":\"TODO\"}",
            "{\"id\":\"C4\",\"value\":\"OPTIONAL\",\"status\":\"DOING\"}",
            "{\"id\":\"C5\",\"value\":\"OPTIONAL\",\"status\":\"DONE\"}",
        ]
    );
    assert_eq!(
        q::<String>(
            &t,
            "SELECT status FROM blockers WHERE project_id = 'P1' AND id = 'B1'"
        ),
        "RESOLVED"
    );
    assert_eq!(
        report.attachment["P1/blockers.status"],
        ["{\"id\":\"B1\",\"value\":\"CANCELLED\"}"]
    );
    assert_eq!(
        q::<String>(
            &t,
            "SELECT progress_source FROM work_items WHERE project_id = 'P1' AND id = 'W2'"
        ),
        "NONE"
    );
    for (r, family, n) in [
        ("N-02g@1", "P1/checklist_items.kind", 4),
        ("N-02h@1", "P1/blockers.status", 1),
        ("N-02i@1", "P1/work_items.progress_source", 1),
        ("N-02g@1", "P2/checklist_items.kind", 0),
    ] {
        assert_eq!(rule(&report, r, family).count, n, "{r} {family}");
    }

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
        // W3a peer r1 P1-02：整段文本按 JSON.parse 判定。原始 NUL 之后的垃圾让它不合法；字符串里的 \u0000 转义合法。
        (
            "enabled false + raw NUL",
            &[("notification.enabled", "false\0trailing", 4)],
            &[("notification.mode".into(), "\"ALL\"".into(), 4, T.into())],
            2,
        ),
        (
            "mode ALL + raw NUL",
            &[("notification.mode", "\"ALL\"\0", 3)],
            &[("notification.mode".into(), "\"ALL\"".into(), 3, T.into())],
            1,
        ),
        (
            "mode OFF + raw NUL, enabled false",
            &[
                ("notification.enabled", "false", 4),
                ("notification.mode", "\"OFF\"\0x", 6),
            ],
            &[("notification.mode".into(), "\"OFF\"".into(), 6, T.into())],
            2,
        ),
        (
            "mode with escaped NUL",
            &[("notification.mode", "\"OFF\\u0000\"", 3)],
            &[("notification.mode".into(), "\"ALL\"".into(), 3, T.into())],
            1,
        ),
        (
            "enabled is a string with escaped NUL",
            &[("notification.enabled", "\"\\u0000\"", 4)],
            &[("notification.mode".into(), "\"ALL\"".into(), 4, T.into())],
            2,
        ),
        (
            "mode spelled with escapes",
            &[("notification.mode", "\"OF\\u0046\"", 3)],
            &[(
                "notification.mode".into(),
                "\"OF\\u0046\"".into(),
                3,
                T.into(),
            )],
            0,
        ),
        (
            "mode with whitespace",
            &[("notification.mode", " \"CRITICAL\" ", 3)],
            &[(
                "notification.mode".into(),
                " \"CRITICAL\" ".into(),
                3,
                T.into(),
            )],
            0,
        ),
        (
            "mode lower case",
            &[("notification.mode", "\"off\"", 3)],
            &[("notification.mode".into(), "\"ALL\"".into(), 3, T.into())],
            1,
        ),
        (
            "enabled false with whitespace",
            &[("notification.enabled", "\n false \t", 4)],
            &[("notification.mode".into(), "\"OFF\"".into(), 4, T.into())],
            2,
        ),
        (
            "enabled 0",
            &[("notification.enabled", "0", 4)],
            &[("notification.mode".into(), "\"ALL\"".into(), 4, T.into())],
            2,
        ),
        (
            "enabled null",
            &[("notification.enabled", "null", 4)],
            &[("notification.mode".into(), "\"ALL\"".into(), 4, T.into())],
            2,
        ),
        (
            "enabled false with trailing comma",
            &[("notification.enabled", "false,", 4)],
            &[("notification.mode".into(), "\"ALL\"".into(), 4, T.into())],
            2,
        ),
        (
            "both, mode valid, enabled true",
            &[
                ("notification.enabled", "true", 4),
                ("notification.mode", "\"OFF\"", 6),
            ],
            &[("notification.mode".into(), "\"OFF\"".into(), 6, T.into())],
            1,
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

/// W3a peer r1 P1-03：lineage 边两端的 started_at 必须是规范的 UTC 毫秒时间，否则显式失败并点名 session；
/// 不参与 predecessor 边的 session 不受约束。
#[test]
fn n05_lineage_times_outside_the_domain_fail_explicitly() {
    for (name, session, at) in [
        ("not a time", "S2", "not-a-time"),
        ("same instant, other spelling", "S2", "2026-09-02T00:00:00Z"),
        ("impossible date", "S1", "2026-02-30T00:00:00.000Z"),
        ("lower-case z", "S5", "2026-09-01T00:00:00.000z"),
    ] {
        let f = rules_fixture("legacy-n05-time");
        f.project(0)
            .execute(
                "UPDATE agent_sessions SET started_at = ?2 WHERE id = ?1",
                params![session, at],
            )
            .unwrap();
        match f.convert() {
            Err(ConvertError::Unsupported(m)) => {
                assert!(
                    m.contains(&format!("agent_sessions {session}.started_at")),
                    "{name}: {m}"
                )
            }
            other => panic!("{name}: {other:?}"),
        }
    }
    // 不参与边的 session：时间不规范也照样转换。
    let f = rules_fixture("legacy-n05-time-loose");
    f.project(0)
        .execute_batch(&format!(
            "INSERT INTO agent_sessions (id, agent_id, role, work_state, connection_state, started_at, updated_at)
             VALUES ('LONE', 'claude', 'OBSERVER', 'IDLE', 'OFFLINE', 'whenever', '{T}')"
        ))
        .unwrap();
    f.convert().unwrap();
}

/// W3a peer r1 P2-01、P2-02：报告里每个（规则，族）恰好一条、摘要是 64 位十六进制；违反时给出可定位的失败，不 panic。
#[test]
fn verify_rejects_malformed_rule_records() {
    let f = rules_fixture("legacy-rules-records");
    let report = f.convert().unwrap();
    let target = f.target();
    let check = |r: &Report| verify_converted(&target, &f.sources, r).unwrap().failures();
    let at = report
        .normalizations
        .iter()
        .position(|n| n.rule == "N-01@1" && n.family == "P1/work_items")
        .unwrap();

    let mut wrong_first = report.clone();
    let mut bad = wrong_first.normalizations[at].clone();
    bad.count = 999;
    wrong_first.normalizations.insert(at, bad);
    let mut wrong_last = report.clone();
    let mut bad = wrong_last.normalizations[at].clone();
    bad.count = 999;
    wrong_last.normalizations.push(bad);
    let mut identical = report.clone();
    let same = identical.normalizations[at].clone();
    identical.normalizations.push(same);
    for (name, r) in [
        ("first wrong", wrong_first),
        ("last wrong", wrong_last),
        ("identical", identical),
    ] {
        let failures = check(&r);
        assert!(
            failures.contains(&"N-01@1 P1/work_items: duplicate record".to_string()),
            "{name}: {failures:?}"
        );
    }

    for digest in [
        "",
        "x",
        "é".repeat(12).as_str(),
        &"Z".repeat(64),
        &"A".repeat(64),
    ] {
        let mut r = report.clone();
        r.normalizations[at].keys_digest = digest.to_string();
        let failures = std::panic::catch_unwind(|| check(&r))
            .unwrap_or_else(|_| panic!("panicked on {digest:?}"));
        assert!(
            failures.contains(&"N-01@1 P1/work_items: malformed keys_digest".to_string()),
            "{digest:?}: {failures:?}"
        );
    }
}

/// W3b1：族表与 05 §5.2 一一对应（编号、族、决定、是否纳入 business_digest），
/// 并且 2.x 三类库的每一张表（含 FTS 影子表）恰好被一个族认领。期望值按 05 逐行手抄，不从族表生成。
#[test]
fn the_family_table_matches_05_and_claims_every_2x_table() {
    use Decision::*;
    let expected: &[(&str, Home, &str, Decision, bool)] = &[
        ("R1", Home::Registry, "projects", Converted, true),
        ("R2", Home::Registry, "project_paths", Converted, true),
        ("R3", Home::Registry, "quick_tasks", Converted, true),
        ("R4", Home::Registry, "quick_task_updates", Converted, true),
        ("R5", Home::Registry, "saved_views", Converted, true),
        ("R6", Home::Registry, "settings", Converted, true),
        ("R7", Home::Registry, "import_history", Converted, true),
        (
            "R8",
            Home::Registry,
            "project_restore_requests",
            Converted,
            true,
        ),
        ("R9", Home::Registry, "global_events", Converted, true),
        ("R10", Home::Registry, "app_meta", Converted, true),
        ("R11", Home::Registry, "backup_catalog", Referenced, true),
        ("R12", Home::Registry, "schema_migrations", Dropped, true),
        (
            "X1",
            Home::Registry,
            "project_summary_cache",
            Dropped,
            false,
        ),
        (
            "X1",
            Home::Registry,
            "global_search_documents",
            Dropped,
            false,
        ),
        (
            "X1",
            Home::Registry,
            "project_projection_state",
            Dropped,
            false,
        ),
        ("K1", Home::Knowledge, "knowledge_meta", Converted, true),
        ("K2", Home::Knowledge, "knowledge_entries", Converted, true),
        (
            "K3",
            Home::Knowledge,
            "knowledge_revisions",
            Converted,
            true,
        ),
        (
            "K4",
            Home::Knowledge,
            "knowledge_operations",
            Converted,
            true,
        ),
        ("K5", Home::Knowledge, "schema_migrations", Dropped, true),
        ("X1", Home::Knowledge, "knowledge_fts", Rebuilt, false),
        ("P1", Home::Project, "project_meta", Converted, true),
        ("P2", Home::Project, "counters", Converted, true),
        ("P3", Home::Project, "objectives", Converted, true),
        ("P3", Home::Project, "milestones", Converted, true),
        ("P3", Home::Project, "work_items", Converted, true),
        ("P3", Home::Project, "work_item_relations", Converted, true),
        ("P3", Home::Project, "checklist_items", Converted, true),
        ("P3", Home::Project, "labels", Dropped, true),
        ("P3", Home::Project, "work_item_labels", Dropped, true),
        ("P3", Home::Project, "progress_updates", Converted, true),
        ("P3", Home::Project, "project_updates", Converted, true),
        ("P3", Home::Project, "blockers", Converted, true),
        ("P3", Home::Project, "records", Converted, true),
        ("P3", Home::Project, "artifacts", Converted, true),
        ("P3", Home::Project, "review_requests", Converted, true),
        ("P3", Home::Project, "review_submissions", Converted, true),
        ("P4", Home::Project, "agents", Converted, true),
        ("P4", Home::Project, "agent_sessions", Converted, true),
        ("P4", Home::Project, "handoffs", Converted, true),
        ("P5", Home::Project, "events", Converted, true),
        ("P6", Home::Project, "idempotency_keys", Converted, true),
        (
            "P7",
            Home::Project,
            "engineering_project_metrics",
            Converted,
            true,
        ),
        (
            "P7",
            Home::Project,
            "engineering_work_item_metrics",
            Converted,
            true,
        ),
        ("P8", Home::Project, "settings", Dropped, true),
        ("P9", Home::Project, "schema_migrations", Dropped, true),
        ("X1", Home::Project, "outbox", Dropped, false),
        ("X1", Home::Project, "search_documents", Rebuilt, false),
        ("P10", Home::ProjectDir, "manifest.json", Dropped, true),
        ("P11", Home::ProjectDir, "artifacts.files", Converted, true),
        ("F1", Home::Root, "sync.config", Converted, true),
        ("F2", Home::Root, "sync.secrets", Converted, true),
        ("F3", Home::Root, "dispatch.config", Converted, true),
        ("F4", Home::Root, "dispatch.runs", Converted, true),
        ("F5", Home::Root, "dispatch.requests", Converted, true),
        ("F6", Home::Root, "dispatch.logs.final", Converted, true),
        ("F7", Home::Root, "dispatch.logs.running", Referenced, false),
        ("X2", Home::Root, "runtime", Dropped, false),
        ("X3", Home::Root, "logs", Dropped, false),
        ("X4", Home::Root, "install-copies", Dropped, false),
        ("X5", Home::Root, "setup", Dropped, false),
        ("X6", Home::Root, "webview", Dropped, false),
        ("X7", Home::Root, "backups", Referenced, false),
        ("X8", Home::Root, "exports", Referenced, false),
        ("X9", Home::Root, "diagnostic-copies", Dropped, false),
        ("X10", Home::Root, "sync.plain-secrets", Dropped, false),
        ("X11", Home::Root, "trash", Dropped, false),
        ("X12", Home::Root, "in-flight", Dropped, false),
    ];
    let actual: Vec<(&str, Home, &str, Decision, bool)> = FAMILIES
        .iter()
        .map(|f| (f.code, f.home, f.name, f.decision, f.business_digest))
        .collect();
    assert_eq!(actual, expected);
    for f in FAMILIES {
        let is_db = matches!(f.home, Home::Registry | Home::Knowledge | Home::Project);
        // 全部族都已实现（W3b6 之后没有 pending）。
        assert!(f.pending.is_none(), "{} {}", f.code, f.name);
        assert!(is_db || f.home == Home::Root || f.home == Home::ProjectDir);
        assert_eq!(
            f.drop_reason.is_some(),
            f.decision == Decision::Dropped,
            "{} {}",
            f.code,
            f.name
        );
        assert_eq!(
            f.target.is_empty(),
            f.decision == Decision::Dropped,
            "{} {}",
            f.code,
            f.name
        );
    }

    let d = dir("legacy-family-table");
    for (kind, home) in [
        ("registry", Home::Registry),
        ("knowledge", Home::Knowledge),
        ("project", Home::Project),
    ] {
        let c = legacy(&d.join(format!("{kind}.sqlite")), kind);
        let names: Vec<String> = c
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let claims = |name: &str| {
            FAMILIES
                .iter()
                .filter(|f| f.home == home)
                .filter(|f| {
                    f.sources.iter().any(|s| {
                        *s == name
                            || (s.ends_with("_fts")
                                && FTS_SHADOWS.iter().any(|x| format!("{s}{x}") == name))
                    })
                })
                .count()
        };
        for n in &names {
            assert_eq!(claims(n), 1, "{kind}: {n}");
        }
        for f in FAMILIES.iter().filter(|f| f.home == home) {
            for s in f.sources {
                assert!(
                    names.iter().any(|n| n == s),
                    "{kind}: {s} is registered but not built by 2.x"
                );
            }
        }
    }
}

/// W3b1：report.json 是 05 §3.4 的形状——每个族实例一条，DB 族带源摘要，检查带结果、错误数与定位；
/// 不含正文。尚未实现的族列在 pending 里。
#[test]
fn report_json_lists_every_family_without_bodies() {
    let f = fixture("legacy-report-json");
    let report = f.convert().unwrap();
    let json: serde_json::Value = serde_json::from_str(&report.report_json()).unwrap();
    assert_eq!(json["format"], "atm-conversion-report");
    assert_eq!(json["knowledge"], "PRESENT");
    let families = json["families"].as_array().unwrap();
    let per_project = FAMILIES
        .iter()
        .filter(|f| matches!(f.home, Home::Project | Home::ProjectDir))
        .count();
    assert_eq!(families.len(), FAMILIES.len() + per_project, "two projects");
    let get = |name: &str| {
        families
            .iter()
            .find(|x| x["family"] == name)
            .unwrap_or_else(|| panic!("no family {name}"))
    };
    let wi = get("P1/work_items");
    assert_eq!(wi["code"], "P3");
    assert_eq!(wi["decision"], "CONVERTED");
    assert_eq!(wi["source"]["path_class"], "projects/<id>/project.sqlite");
    assert_eq!(wi["source"]["rows"], 1);
    assert_eq!(wi["source"]["digest"].as_str().unwrap().len(), 64);
    assert_eq!(wi["target"]["table"], "work_items");
    assert_eq!(wi["target"]["rows"], 1);
    let check = &wi["checks"][0];
    assert_eq!(
        (
            check["name"].as_str(),
            check["result"].as_str(),
            check["errors"].as_i64()
        ),
        (Some("P1/work_items"), Some("PASS"), Some(0))
    );
    assert!(check["first_failure_locator"].is_null());
    let search = get("P2/search_documents");
    assert_eq!(search["decision"], "REBUILT");
    let names: Vec<&str> = search["checks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        ["P2/search_documents", "P2/search_documents.queries"]
    );
    let outbox = get("P1/outbox");
    assert_eq!(outbox["decision"], "DROPPED");
    assert_eq!(outbox["source"]["rows"], 4);
    assert!(outbox["target"]["table"].is_null() && outbox["checks"].as_array().unwrap().is_empty());
    let sync = get("root/sync.config");
    assert_eq!(sync["pending"], "needs the data root");
    assert!(sync["source"]["files"].is_null());
    assert!(
        report
            .pending()
            .contains(&"P1/artifacts.files: needs the data root".to_string()),
        "{:?}",
        report.pending()
    );
    assert!(
        report
            .pending()
            .contains(&"root/in-flight: needs the data root".to_string())
    );
    // N-05 等带原因的规则：规则号与原因分开写。
    let r = rules_fixture("legacy-report-json-rules").convert().unwrap();
    let json: serde_json::Value = serde_json::from_str(&r.report_json()).unwrap();
    let n05 = json["normalizations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["reason"] == "SAME_INSTANT")
        .unwrap();
    assert_eq!(
        (n05["rule"].as_str(), n05["family"].as_str()),
        (Some("N-05@1"), Some("P1/agent_sessions"))
    );
    // 不含正文：标题、正文、事件 payload、标签名都不出现。
    let text = report.report_json() + &r.report_json();
    for body in [
        "shared title words",
        "单库迁移说明",
        "xxxxxxxx",
        "Single database",
        "紧急",
        "not json {",
    ] {
        assert!(!text.contains(body), "{body}");
    }
}

/// M-04（05 §6）：在转换好的目标上改一行、删一行、多一行、翻一个 REAL 位，只有对应的族变红，
/// 报告给出不一致的行数与第一处不一致的主键。
#[test]
fn m04_tampering_one_row_turns_exactly_its_family_red() {
    let f = fixture("legacy-m04");
    let report = f.convert().unwrap();
    let clean = f.dir.join("out").join("clean.sqlite");
    fs::copy(f.target(), &clean).unwrap();
    let flip = |table: &'static str, col: &'static str, pid: &'static str, id: &'static str| {
        move |t: &Connection| {
            let v: f64 = t
                .query_row(
                    &format!("SELECT {col} FROM {table} WHERE project_id = ?1 AND id = ?2"),
                    params![pid, id],
                    |r| r.get(0),
                )
                .unwrap();
            let bent = f64::from_bits(v.to_bits() ^ 1);
            assert_ne!(v, bent);
            t.execute(
                &format!("UPDATE {table} SET {col} = ?3 WHERE project_id = ?1 AND id = ?2"),
                params![pid, id, bent],
            )
            .unwrap();
        }
    };
    let sql = |s: &'static str| move |t: &Connection| t.execute_batch(s).unwrap();
    type Tamper = Box<dyn Fn(&Connection)>;
    let cases: Vec<(&str, Tamper, &[&str], &str)> = vec![
        (
            "change a row",
            Box::new(sql(
                "UPDATE quick_tasks SET title = 'changed' WHERE id = 'Q2'",
            )),
            &["r/quick_tasks"],
            "r/quick_tasks(\"Q2\")",
        ),
        (
            "delete a row",
            Box::new(sql(
                "DELETE FROM handoffs WHERE project_id = 'P1' AND id = 'H1'",
            )),
            &["P1/handoffs"],
            "P1/handoffs(\"H1\")",
        ),
        (
            "an extra row",
            Box::new(sql(
                "INSERT INTO saved_views (id, scope, name, created_at, updated_at) VALUES ('V2', 'GLOBAL', 'extra', 'x', 'x')",
            )),
            &["r/saved_views"],
            "r/saved_views(\"V2\")",
        ),
        (
            "flip a REAL bit",
            Box::new(flip("objectives", "weight", "P2", "OBJ")),
            &["P2/objectives"],
            "P2/objectives(\"OBJ\")",
        ),
        (
            "flip a REAL bit in computed progress",
            Box::new(flip("work_items", "computed_progress", "P1", "W1")),
            &["P1/work_items"],
            "P1/work_items(\"W1\")",
        ),
        (
            "delete an event",
            Box::new(sql(
                "DELETE FROM events WHERE project_id = 'P2' AND seq = 4",
            )),
            &["P2/events"],
            "P2/events(4)",
        ),
        (
            "knowledge index drifted",
            Box::new(sql(
                "UPDATE knowledge_fts SET body = 'three' WHERE entry_id = 'K1'",
            )),
            &["k/knowledge_fts"],
            "k/knowledge_fts(\"K1\")",
        ),
        (
            "search document lost its words",
            Box::new(sql(
                "UPDATE search_docs SET title = 'x', body = 'y' WHERE project_id = 'P1' AND entity_type = 'RECORD'",
            )),
            &["P1/search_documents", "P1/search_documents.queries"],
            "P1/search_documents(\"RECORD\",\"R1\")",
        ),
        (
            "high water moved",
            Box::new(sql("UPDATE app_meta SET global_seq = global_seq + 1")),
            &["r/app_meta.global_seq"],
            "r/app_meta.global_seq",
        ),
    ];
    for (name, tamper, expected, locator) in cases {
        fs::copy(&clean, f.target()).unwrap();
        let t = Connection::open(f.target()).unwrap();
        tamper(&t);
        drop(t);
        let again = verify_converted(&f.target(), &f.sources, &report).unwrap();
        assert_eq!(again.failures(), expected, "{name}");
        let bad = again
            .checks
            .iter()
            .find(|c| c.family == expected[0])
            .unwrap();
        assert_eq!(
            (bad.errors, bad.first_failure_locator.as_deref()),
            (1, Some(locator)),
            "{name}"
        );
    }
    // 搜索的探针：定位只写实体类型与探针种类。
    fs::copy(&clean, f.target()).unwrap();
    Connection::open(f.target())
        .unwrap()
        .execute_batch(
            "UPDATE search_docs SET body = 'y' WHERE project_id = 'P1' AND entity_type = 'RECORD'",
        )
        .unwrap();
    let again = verify_converted(&f.target(), &f.sources, &report).unwrap();
    let probe = again
        .checks
        .iter()
        .find(|c| c.family == "P1/search_documents.queries")
        .unwrap();
    assert_eq!(
        (probe.errors, probe.first_failure_locator.as_deref()),
        (1, Some("P1/search_documents.queries(RECORD.body)"))
    );
}

/// W3a peer r2 P2-R2-01：VERIFY 的 N-05 时间域检查独立于转换侧，不靠 strftime 往返；
/// 源与目标一致、报告也没改、边分类不变时，24:00 照样报时间域失败。规范的边界时间照常通过。
#[test]
fn verify_checks_the_lineage_time_domain_on_its_own() {
    let f = rules_fixture("legacy-n05-verify-domain");
    let report = f.convert().unwrap();
    let odd = "2026-09-02T24:00:00.000Z";
    f.project(0)
        .execute(
            "UPDATE agent_sessions SET started_at = ?1 WHERE id = 'S2'",
            [odd],
        )
        .unwrap();
    Connection::open(f.target())
        .unwrap()
        .execute(
            "UPDATE agent_sessions SET started_at = ?1 WHERE project_id = 'P1' AND id = 'S2'",
            [odd],
        )
        .unwrap();
    let failures = verify_converted(&f.target(), &f.sources, &report)
        .unwrap()
        .failures();
    // 源在转换之后被改过，来源证明也会报（W3b3）。
    assert_eq!(
        failures,
        [
            "r/app_meta.sources",
            "P1/agent_sessions: 1 lineage endpoints outside the N-05 time domain"
        ]
    );
    for ok in [
        "2026-09-02T23:59:59.999Z",
        "2024-02-29T12:00:00.000Z",
        "2026-09-02T00:00:00.000Z",
    ] {
        let f = rules_fixture("legacy-n05-verify-domain-ok");
        f.project(0)
            .execute(
                "UPDATE agent_sessions SET started_at = ?1 WHERE id = 'S2'",
                [ok],
            )
            .unwrap();
        let report = f.convert().unwrap_or_else(|e| panic!("{ok}: {e}"));
        assert!(report.failures().is_empty(), "{ok}");
    }
}

/// W3b2：在规则夹具上补齐其余 DB 族，使 05 §1 的每张表都有行（项目 settings 按规定为空）。
/// review 三类（APPROVED / CHANGES_REQUESTED / 未提交）、records 的 supersedes 链、合法的等待中任务、
/// 父 session、handoff 检查点、附件行、两张工程指标表、恢复申请、投影状态，以及一个 TRASHED 项目。
fn rich_fixture(name: &str) -> Fixture {
    let mut f = rules_fixture(name);
    f.project(0)
        .execute_batch(&format!(
            "UPDATE counters SET next_value = 7 WHERE name = 'work_item';
             INSERT INTO counters (name, next_value) VALUES ('milestone', 2), ('record', 5);
             UPDATE counters SET next_value = 4 WHERE name = 'review_request';
             UPDATE counters SET next_value = 3 WHERE name = 'review_submission';
             INSERT INTO milestones (id, local_no, objective_id, title, status, weight, created_at, updated_at)
               VALUES ('M1', 1, 'OBJ', 'first cut', 'ACTIVE', 2.5, '{T}', '{T}');
             INSERT INTO work_items (id, local_no, objective_id, milestone_id, type, title, status, phase, waiting_on,
                                     waiting_for, priority, created_at, updated_at) VALUES
               ('W4', 4, 'OBJ', 'M1', 'REVIEW', 'review acceptance', 'DONE', 'DONE', NULL, NULL, 'NORMAL', '{T}', '{T}'),
               ('W5', 5, 'OBJ', NULL, 'REVIEW', 'review verification', 'DONE', 'DONE', NULL, NULL, 'NORMAL', '{T}', '{T}'),
               ('W6', 6, 'OBJ', NULL, 'REVIEW', 'review optional', 'WAITING_USER', 'CLAIMED', 'USER', 'a reply',
                'NORMAL', '{T}', '{T}');
             INSERT INTO checklist_items (id, work_item_id, title, kind, status, created_at, updated_at)
               VALUES ('C6', 'W2', 'done step', 'ACCEPTANCE', 'DONE', '{T}', '{T}');
             INSERT INTO records (id, local_no, kind, title, summary, importance, status, supersedes_id, actor, created_at, updated_at)
               VALUES ('D1', 1, 'VERIFICATION', 'approved', 's', 'NORMAL', 'ACTIVE', NULL, 'codex', '{T}', '{T}'),
                      ('D2', 2, 'VERIFICATION', 'changes', 's', 'NORMAL', 'ACTIVE', NULL, 'codex', '{T}', '{T}'),
                      ('D4', 4, 'DECISION', 'old call', 's', 'HIGH', 'SUPERSEDED', NULL, 'USER', '{T}', '{T}'),
                      ('D3', 3, 'DECISION', 'new call', 's', 'HIGH', 'ACTIVE', 'D4', 'USER', '{T}', '{T}');
             INSERT INTO review_requests (id, local_no, review_work_item_id, parent_work_item_id, parent_checklist_id,
                                          parent_checklist_version, expected_candidate_hashes_json, created_by_agent_id,
                                          created_by_session_id, created_at, op_id) VALUES
               ('RR1', 1, 'W4', 'W1', 'C2', 0, '[]', 'claude', 'S1', '{T}', 'rr1'),
               ('RR2', 2, 'W5', 'W1', 'C3', 0, '[]', 'claude', 'S1', '{T}', 'rr2'),
               ('RR3', 3, 'W6', 'W1', 'C4', 0, '[]', 'claude', 'S1', '{T}', 'rr3');
             INSERT INTO review_submissions (id, local_no, request_id, verdict, reviewed_hashes_json, evidence_json, record_id,
                                             reviewer_agent_id, reviewer_session_id, review_task_version,
                                             parent_checklist_version, created_at, op_id) VALUES
               ('RS1', 1, 'RR1', 'APPROVED', '[]', '[]', 'D1', 'codex', 'S3', 1, 0, '{T}', 'rs1'),
               ('RS2', 2, 'RR2', 'CHANGES_REQUESTED', '[]', '[]', 'D2', 'codex', 'S3', 1, 0, '{T}', 'rs2');
             INSERT INTO progress_updates (id, work_item_id, percent, progress_bucket, summary, summary_hash, actor, created_at)
               VALUES ('PU1', 'W1', 37.5, 30, 'halfway-ish', 'h', 'claude', '{T}');
             INSERT INTO project_updates (id, health, summary, from_sequence, to_sequence, status, actor, published_at,
                                          created_at, updated_at)
               VALUES ('PJ1', 'ON_TRACK', 'weekly', 1, 4, 'PUBLISHED', 'USER', '{T}', '{T}', '{T}');
             INSERT INTO artifacts (id, work_item_id, kind, name, local_path, sha256, size_bytes, actor, created_at)
               VALUES ('A1', 'W1', 'FILE', 'notes.txt', 'C:/old/projects/P1/artifacts/notes.txt', 'ab', 3, 'USER', '{T}');
             INSERT INTO engineering_project_metrics (id, git_head, captured_at, payload_json)
               VALUES ('EM1', 'abc123', '{T}', '{{}}');
             INSERT INTO engineering_work_item_metrics (work_item_id, baseline_ref, baseline_captured_at, payload_json,
                                                        captured_at, updated_at)
               VALUES ('W1', 'abc123', '{T}', NULL, NULL, '{T}');
             UPDATE agent_sessions SET parent_session_id = 'S1' WHERE id = 'S4';
             UPDATE handoffs SET checkpoint_sequence = 2 WHERE id = 'H1';"
        ))
        .unwrap();
    // TRASHED 项目：库在，内容最少。
    let p3 = f.dir.join("P3.sqlite");
    let c = legacy(&p3, "project");
    c.execute_batch(&format!(
        "INSERT INTO project_meta (singleton, project_id, project_code, name, description, lifecycle, coordination_mode, health,
                                   current_sequence, schema_version, version, created_at, updated_at)
           VALUES (1, 'P3', 'CCC', 'Charlie', '', 'TRASHED', 'AUTO', 'UNKNOWN', 0, 18, 1, '{T}', '{T}');"
    ))
    .unwrap();
    drop(c);
    f.sources.projects.push(p3);
    f.registry()
        .execute_batch(&format!(
            "INSERT INTO projects (id, code, name, description, lifecycle, coordination_mode, version, created_at, updated_at)
               VALUES ('P3', 'CCC', 'Charlie', '', 'TRASHED', 'AUTO', 2, '{T}', '{T2}');
             INSERT INTO project_restore_requests (id, project_id, requested_by, source_cwd, status, request_count,
                                                   created_at, updated_at)
               VALUES ('RQ1', 'P3', 'claude', 'c:/work/charlie', 'PENDING', 3, '{T}', '{T2}');
             INSERT INTO project_projection_state (project_id, source_sequence, projected_sequence, status, updated_at)
               VALUES ('P1', 4, 4, 'APPLIED', '{T}'), ('P2', 4, 2, 'DEFERRED', '{T}');"
        ))
        .unwrap();
    f
}

fn home_of(scope: &str) -> Home {
    match scope {
        "r" => Home::Registry,
        "k" => Home::Knowledge,
        _ => Home::Project,
    }
}

/// W3b2：每个 DB 族在夹具里都有行（项目 settings 除外，它必须为空），逐族比对全部相等，
/// 业务图校验没有违例，信息项只有夹具刻意留下的那一条。
#[test]
fn every_db_family_has_rows_in_the_rich_fixture_and_matches() {
    let f = rich_fixture("legacy-rich");
    let report = f.convert().unwrap_or_else(|e| panic!("{e}"));
    assert!(report.failures().is_empty(), "{:?}", report.failures());
    assert!(report.graph_violations.is_empty());
    for spec in FAMILIES
        .iter()
        .filter(|f| matches!(f.home, Home::Registry | Home::Knowledge | Home::Project))
    {
        let rows: i64 = report
            .sources
            .iter()
            .filter(|s| s.spec == spec.name && spec.home == home_of(&s.scope))
            .map(|s| s.rows)
            .sum();
        if spec.home == Home::Project && spec.name == "settings" {
            assert_eq!(rows, 0, "project settings must be empty");
        } else {
            assert!(
                rows > 0,
                "{} {} has no rows in the fixture",
                spec.code,
                spec.name
            );
        }
    }
    // 基础夹具里的 Q1 晋升到 W1，但 W1 没有 source_quick_id：信息项，不停。
    assert_eq!(
        report.notes,
        ["r/quick_tasks: 1 promoted tasks not marked with source_quick_id, first Q1"]
    );
    let t = Connection::open(f.target()).unwrap();
    assert_eq!(
        q::<String>(&t, "SELECT lifecycle FROM projects WHERE id = 'P3'"),
        "TRASHED"
    );
}

/// W3b2：05 §3.3 的停级校验。每一类违例都让转换失败，并点名项目、表与主键；阳性对照是上面的富夹具。
#[test]
fn business_graph_violations_stop_the_conversion() {
    let cases: &[(&str, &str, &str)] = &[
        (
            "review task is not a review",
            "UPDATE work_items SET type = 'TASK' WHERE id = 'W4'",
            "P1/review_requests.review_work_item: 1 rows, first RR1",
        ),
        (
            "parent checklist belongs to another task",
            "UPDATE review_requests SET parent_checklist_id = 'C6' WHERE id = 'RR2'",
            "P1/review_requests.parent_checklist: 1 rows, first RR2",
        ),
        (
            "handoff checkpoint beyond the project sequence",
            "UPDATE handoffs SET checkpoint_sequence = 99 WHERE id = 'H1'",
            "P1/handoffs.checkpoint_sequence: 1 rows, first H1",
        ),
        (
            "parent sessions form a cycle",
            "UPDATE agent_sessions SET parent_session_id = 'S4' WHERE id = 'S1'",
            "P1/agent_sessions.parent_session_id: 2 rows, first S1",
        ),
        (
            "supersedes chain forms a cycle",
            "UPDATE records SET supersedes_id = 'D3' WHERE id = 'D4'",
            "P1/records.supersedes_id: 2 rows, first D3",
        ),
        (
            "counter below its highest number",
            "UPDATE counters SET next_value = 4 WHERE name = 'record'",
            "P1/counters.record: next_value 4 is not above records local_no 4",
        ),
        (
            "counter missing",
            "DELETE FROM counters WHERE name = 'review_submission'",
            "P1/counters.review_submission: next_value missing is not above review_submissions local_no 2",
        ),
        (
            "receipt names a sequence beyond the project",
            r#"INSERT INTO idempotency_keys (key, operation, request_fingerprint, response_json, created_at, op_id, actor_session_id)
               VALUES ('USER:late', 'work.update', 'fp', '{"event":{"sequence":9}}', '2026-09-01T00:00:00.000Z', 'late', 'USER')"#,
            "P1/idempotency_keys.sequence: 1 rows, first USER:late",
        ),
        (
            "status disagrees with phase",
            "UPDATE work_items SET phase = 'READY' WHERE id = 'W1'",
            "P1/work_items.status: 1 rows, first W1",
        ),
        (
            "waiting on the wrong party",
            "UPDATE work_items SET waiting_on = 'AGENT' WHERE id = 'W6'",
            "P1/work_items.status: 1 rows, first W6",
        ),
        (
            "waiting after the task ended",
            "UPDATE work_items SET phase = 'DONE' WHERE id = 'W6'",
            "P1/work_items.status: 1 rows, first W6",
        ),
    ];
    for (name, tamper, expected) in cases {
        let f = rich_fixture("legacy-graph");
        f.project(0).execute_batch(tamper).unwrap();
        match f.convert() {
            Err(ConvertError::Verify(r)) => {
                assert_eq!(r.graph_violations, [expected.to_string()], "{name}");
                assert_eq!(r.failures(), [expected.to_string()], "{name}");
            }
            other => panic!("{name}: {other:?}"),
        }
    }
}

/// W3b2：源副本先过 quick_check 与 foreign_key_check，违例在动目标之前就停，并点名位置。
#[test]
fn a_damaged_source_copy_is_refused_before_conversion() {
    // 悬空引用：2.x 不开外键时写得进去。
    let f = rich_fixture("legacy-source-fk");
    f.project(0)
        .execute_batch(
            "PRAGMA foreign_keys = OFF;
             INSERT INTO handoffs (id, work_item_id, from_session_id, to_agent_id, summary, next_action, created_at)
             VALUES ('H9', 'GONE', 'S1', 'claude', 's', 'n', '2026-09-01T00:00:00.000Z');",
        )
        .unwrap();
    match f.convert() {
        Err(ConvertError::Mismatch(m)) => {
            assert!(
                m.contains("source foreign_key_check: handoffs rowid"),
                "{m}"
            );
            assert!(m.contains("-> work_items"), "{m}");
        }
        other => panic!("{other:?}"),
    }
    assert!(
        !f.target().exists(),
        "nothing is written for a refused source"
    );

    // 页损坏：把 objectives 根页的页类型字节改坏。
    let f = rich_fixture("legacy-source-corrupt");
    let path = f.sources.projects[1].clone();
    let (root, page): (i64, i64) = {
        let c = Connection::open(&path).unwrap();
        (
            q(
                &c,
                "SELECT rootpage FROM sqlite_master WHERE name = 'objectives'",
            ),
            q(&c, "PRAGMA page_size"),
        )
    };
    let mut bytes = fs::read(&path).unwrap();
    bytes[((root - 1) * page) as usize] = 0x07;
    fs::write(&path, bytes).unwrap();
    match f.convert() {
        Err(ConvertError::Mismatch(m)) => assert!(m.contains("source quick_check"), "{m}"),
        other => panic!("{other:?}"),
    }

    // quick_check 能读完、但报出问题（这里是文件头的空闲页计数不对）：同样停，并带上它的诊断。
    let f = rich_fixture("legacy-source-freelist");
    let path = f.sources.projects[0].clone();
    let mut bytes = fs::read(&path).unwrap();
    bytes[36..40].copy_from_slice(&5u32.to_be_bytes());
    fs::write(&path, bytes).unwrap();
    match f.convert() {
        Err(ConvertError::Mismatch(m)) => {
            assert!(
                m.contains("source quick_check: *** in database main ***"),
                "{m}"
            );
            assert!(m.contains("Freelist"), "{m}");
        }
        other => panic!("{other:?}"),
    }
}

/// W3b2：信息项不停，只进报告：0015 投影重算不一致、SUPERSEDED 没有 ACTIVE 的替代、知识修订号不连续。
#[test]
fn informational_findings_are_reported_without_stopping() {
    let f = rich_fixture("legacy-notes");
    f.project(0)
        .execute_batch(
            "UPDATE work_items SET ever_claimed_at = '2026-01-01T00:00:00.000Z' WHERE id = 'W5';
             UPDATE records SET status = 'RETRACTED' WHERE id = 'D3';",
        )
        .unwrap();
    Connection::open(f.sources.knowledge.as_ref().unwrap())
        .unwrap()
        .execute_batch(
            "DROP TRIGGER knowledge_revisions_no_delete;
             DELETE FROM knowledge_revisions WHERE entry_id = 'K1' AND revision = 1;",
        )
        .unwrap();
    let report = f.convert().unwrap_or_else(|e| panic!("{e}"));
    assert!(report.failures().is_empty(), "{:?}", report.failures());
    assert_eq!(
        report.notes,
        [
            "k/knowledge_revisions: revisions not contiguous for 1 entries, first K1",
            "P1/work_items: 0015 projection differs on 1 rows, first W5",
            "P1/records: 1 SUPERSEDED without an ACTIVE successor, first D4",
            "r/quick_tasks: 1 promoted tasks not marked with source_quick_id, first Q1",
        ]
    );
    let json: serde_json::Value = serde_json::from_str(&report.report_json()).unwrap();
    assert_eq!(json["notes"].as_array().unwrap().len(), 4);
    assert!(json["graph_violations"].as_array().unwrap().is_empty());
}

/// 目录里每个文件的（名字，内容 sha256），用来证明转换不写源目录。
fn listing(dir: &Path) -> Vec<(String, String)> {
    use sha2::Digest;
    let mut out: Vec<(String, String)> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.is_file())
        .map(|p| {
            let sha = sha2::Sha256::digest(fs::read(&p).unwrap())
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            (p.file_name().unwrap().to_string_lossy().into_owned(), sha)
        })
        .collect();
    out.sort();
    out
}

fn sha_of(path: &Path) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(fs::read(path).unwrap())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// W3b3：转换器嵌入的 2.x 迁移与仓库里的文件逐字节相同，固定的 sha256 也对得上；计划恰好覆盖三类库的全部文件。
#[test]
fn embedded_migrations_are_pinned_and_match_the_repository() {
    use sha2::Digest;
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../migrations");
    let mut seen = Vec::new();
    for (kind, home) in [
        ("registry", Home::Registry),
        ("knowledge", Home::Knowledge),
        ("project", Home::Project),
    ] {
        let mut files: Vec<String> = fs::read_dir(root.join(kind))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        files.sort();
        let plan: Vec<_> = MIGRATIONS.iter().filter(|m| m.home == home).collect();
        assert_eq!(
            plan.iter().map(|m| m.name.to_string()).collect::<Vec<_>>(),
            files,
            "{kind}"
        );
        for (i, m) in plan.iter().enumerate() {
            assert_eq!(m.version, i as i64 + 1, "{kind} {}", m.name);
            assert_eq!(
                m.sql,
                fs::read_to_string(root.join(kind).join(m.name)).unwrap()
            );
            let sha: String = sha2::Sha256::digest(m.sql.as_bytes())
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            assert_eq!(sha, m.sha256, "{kind} {}", m.name);
            seen.push((kind, m.version, !m.historical.is_empty()));
        }
    }
    assert_eq!(
        seen.iter()
            .filter(|s| s.2)
            .map(|s| (s.0, s.1))
            .collect::<Vec<_>>(),
        [("project", 15)],
        "only 0015 has a historical hash"
    );
}

/// W3b3：停在旧版本的项目库在工作副本上按 2.0 runner 补迁移后转换；来源证明进报告与 converted_from；
/// 源目录一个字节都不变，成功后工作副本删掉。
#[test]
fn an_old_schema_is_upgraded_on_a_working_copy_with_provenance() {
    let f = fixture_with("legacy-upgrade", 9);
    let before = listing(&f.dir);
    let p2_sha = sha_of(&f.sources.projects[1]);
    let report = f.convert().unwrap_or_else(|e| panic!("{e}"));
    assert!(report.failures().is_empty(), "{:?}", report.failures());
    assert_eq!(listing(&f.dir), before, "the source directory is untouched");
    assert!(!f.dir.join("out").join("legacy-work").exists());

    let p2 = report
        .provenance
        .iter()
        .find(|p| p.role == "project:P2")
        .unwrap();
    assert_eq!(p2.sha256, p2_sha);
    assert_eq!(p2.wal_sha256, None);
    assert_eq!(p2.migrations.len(), 9);
    assert_eq!(p2.migrations[8].1, "0009_structured_cancel.sql");
    assert_eq!(p2.upgraded, (10..=18).collect::<Vec<i64>>());
    let p1 = report
        .provenance
        .iter()
        .find(|p| p.role == "project:P1")
        .unwrap();
    assert!(p1.upgraded.is_empty() && p1.migrations.len() == 18);
    assert_eq!(
        report
            .provenance
            .iter()
            .map(|p| p.role.as_str())
            .collect::<Vec<_>>(),
        ["registry", "knowledge", "project:P1", "project:P2"]
    );

    let t = Connection::open(f.target()).unwrap();
    assert_eq!(
        q::<String>(
            &t,
            "SELECT converted_from ->> '$.converterVersion' FROM app_meta"
        ),
        "atm-store-legacy/1"
    );
    assert_eq!(
        q::<String>(
            &t,
            "SELECT json_group_array(value) FROM app_meta, json_each(converted_from, '$.sources[3].upgraded')"
        ),
        "[10,11,12,13,14,15,16,17,18]"
    );
    assert_eq!(
        q::<String>(
            &t,
            "SELECT converted_from -> '$.sources[3].sha256' FROM app_meta"
        ),
        format!("\"{p2_sha}\"")
    );
    // 补跑出来的结构照常转换：0010 补的两个计数器进了目标。
    assert_eq!(
        q::<i64>(
            &t,
            "SELECT count(*) FROM counters WHERE project_id = 'P2' AND name IN ('review_request', 'review_submission')"
        ),
        2
    );
    // 独立 VERIFY 重新做一遍副本，结论相同。
    let again = verify_converted(&f.target(), &f.sources, &report).unwrap();
    assert!(again.failures().is_empty(), "{:?}", again.failures());
    assert_eq!(again.provenance, report.provenance);
    assert!(!f.dir.join("out").join("legacy-verify").exists());
}

/// W3b3：来源证明按 2.0 `assertAppliedMigrations` 的规则核对：名字与 hash 都要认得（0015 另认历史 hash），
/// 来源只能是两种之一，历史不能断档，比转换器新的版本拒绝。
#[test]
fn migration_provenance_is_checked_like_2x() {
    let accepted: &[(&str, &str)] = &[
        (
            "0015 applied from the original file",
            "UPDATE schema_migrations SET content_sha256 = '046381e8fdfef46a32e0babe85aa49ac0ac2168eb324aaf34d3ce714ad331205' WHERE version = 15",
        ),
        (
            "legacy baseline",
            "UPDATE schema_migrations SET hash_origin = 'LEGACY_BASELINE_UNVERIFIED' WHERE version = 1",
        ),
    ];
    for (name, tweak) in accepted {
        let f = fixture("legacy-provenance-ok");
        f.project(0).execute_batch(tweak).unwrap();
        let report = f.convert().unwrap_or_else(|e| panic!("{name}: {e}"));
        assert!(report.failures().is_empty(), "{name}");
    }
    let refused: &[(&str, &str, &str)] = &[
        (
            "unknown hash",
            "UPDATE schema_migrations SET content_sha256 = 'ff' WHERE version = 3",
            "migration 3 recorded as 0003_engineering_metrics.sql with sha256 ff",
        ),
        (
            "historical hash on another migration",
            "UPDATE schema_migrations SET content_sha256 = '046381e8fdfef46a32e0babe85aa49ac0ac2168eb324aaf34d3ce714ad331205' WHERE version = 14",
            "migration 14 recorded as",
        ),
        (
            "renamed migration",
            "UPDATE schema_migrations SET name = '0004_other.sql' WHERE version = 4",
            "migration 4 recorded as 0004_other.sql",
        ),
        (
            "history gap",
            "DELETE FROM schema_migrations WHERE version = 5",
            "migration history skips 5",
        ),
        (
            "newer than the converter",
            "INSERT INTO schema_migrations VALUES (19, '0019_next.sql', 'x', 'ab', 'APPLIED')",
            "migration 19 0019_next.sql is not one this converter knows",
        ),
        (
            "no migration table",
            "DROP TABLE schema_migrations",
            "no schema_migrations",
        ),
        (
            // 2.x 的 CHECK 拦着这种值；表被改过（没有 CHECK）时转换器自己也要拦。
            "unknown hash origin",
            "CREATE TABLE sm AS SELECT * FROM schema_migrations; DROP TABLE schema_migrations;
             ALTER TABLE sm RENAME TO schema_migrations;
             UPDATE schema_migrations SET hash_origin = 'GUESSED' WHERE version = 2",
            "migration 2 has hash_origin GUESSED",
        ),
    ];
    for (name, tweak, expected) in refused {
        let f = fixture("legacy-provenance-bad");
        f.project(0).execute_batch(tweak).unwrap();
        match f.convert() {
            Err(ConvertError::UnsupportedSchema(m)) => assert!(m.contains(expected), "{name}: {m}"),
            other => panic!("{name}: {other:?}"),
        }
        assert!(!f.target().exists(), "{name}: nothing is written");
    }
}

/// W3b3：源旁边有没合并的 WAL 时，WAL 只在工作副本里恢复（07 IMPORT）：转换读到 WAL 里的修改，
/// 源目录的 db、-wal、-shm 一个字节都不变。
#[test]
fn an_unmerged_wal_is_recovered_in_the_working_copy_only() {
    let f = fixture("legacy-wal");
    let p2 = f.sources.projects[1].clone();
    let writer = Connection::open(&p2).unwrap();
    writer
        .query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))
        .unwrap();
    writer
        .execute_batch(
            "PRAGMA wal_autocheckpoint = 0;
             UPDATE objectives SET title = 'only in the wal' WHERE id = 'OBJ';",
        )
        .unwrap();
    let wal = PathBuf::from(format!("{}-wal", p2.display()));
    assert!(fs::metadata(&wal).unwrap().len() > 0);
    let before = listing(&f.dir);
    let report = f.convert().unwrap_or_else(|e| panic!("{e}"));
    assert!(report.failures().is_empty(), "{:?}", report.failures());
    assert_eq!(listing(&f.dir), before, "db, -wal and -shm are untouched");
    let p = report
        .provenance
        .iter()
        .find(|p| p.role == "project:P2")
        .unwrap();
    assert_eq!(p.wal_sha256.as_deref(), Some(sha_of(&wal).as_str()));
    let t = Connection::open(f.target()).unwrap();
    assert_eq!(
        q::<String>(&t, "SELECT title FROM objectives WHERE project_id = 'P2'"),
        "only in the wal"
    );
    drop(writer);
}

const KB: &str = "01J00000000000000000000KB1";
const KO: &str = "01J00000000000000000000KZ1";
const KR: &str = "01J00000000000000000000KR1";

fn put(path: &Path, bytes: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

/// W3b4：按 2.0 的布局摆一个完整的数据根（05 §1.1）：三类库、manifest、附件、各种备份文件、
/// R / X 类目录、sync / dispatch 文件。库的内容来自富夹具。
fn root_fixture(name: &str) -> (Fixture, PathBuf) {
    let base = rich_fixture(name);
    let root = base.dir.join("root");
    let _ = fs::remove_dir_all(&root);
    let copy = |from: &Path, to: PathBuf| {
        fs::create_dir_all(to.parent().unwrap()).unwrap();
        fs::copy(from, to).unwrap();
    };
    copy(
        &base.sources.registry,
        root.join("registry/registry.sqlite"),
    );
    copy(
        base.sources.knowledge.as_ref().unwrap(),
        root.join("knowledge/knowledge.sqlite"),
    );
    for (i, (pid, code, name)) in [
        ("P1", "AAA", "Alpha"),
        ("P2", "BBB", "Bravo"),
        ("P3", "CCC", "Charlie"),
    ]
    .iter()
    .enumerate()
    {
        let dir = root.join("projects").join(pid);
        copy(&base.sources.projects[i], dir.join("project.sqlite"));
        // 2.0 的写法：JSON.stringify(…, null, 2) 加换行（registry-workspace.ts:711-715）。
        put(
            &dir.join("manifest.json"),
            format!(
                "{{\n  \"schema_version\": 1,\n  \"project_id\": \"{pid}\",\n  \"project_code\": \"{code}\",\n  \"name\": \"{name}\"\n}}\n"
            )
            .as_bytes(),
        );
    }
    let p1 = root.join("projects/P1");
    put(&p1.join("artifacts/notes.txt"), b"abc");
    put(&p1.join("artifacts/sub/deep/blob.bin"), &[0u8, 1, 2, 255]);
    put(
        &p1.join("backups/pre-migration-v14-2026-09-01T00-00-00-000Z.sqlite"),
        b"old p1",
    );
    put(
        &p1.join("backups/AAA-daily-2026-09-02T00-00-00-000Z-01J0000000000000000000BK01.sqlite"),
        b"daily",
    );
    put(
        &root.join("backups/registry/pre-migration-v7-2026-08-01T00-00-00-000Z.sqlite"),
        b"old registry",
    );
    put(
        &root.join(format!("backups/knowledge/before-restore-{KB}.sqlite")),
        b"before",
    );
    put(
        &root.join(format!("backups/knowledge/orphan-{KO}-restore-{KR}.sqlite")),
        b"orphan",
    );
    put(&root.join("backups/knowledge/notes.txt"), b"not a backup");
    put(&root.join("exports/AAA-2026.aytproj"), b"zip");
    put(&root.join("runtime/daemon.lock"), b"1234");
    put(&root.join("logs/host.log"), b"log line\n");
    put(
        &root.join("webview/Default/Local Storage/leveldb/000003.log"),
        b"theme",
    );
    put(&root.join("ATM_AGENT_GUIDE.md"), b"# guide");
    put(&root.join("docs/a.md"), b"a");
    put(&root.join("skills/atm/SKILL.md"), b"s");
    put(&root.join("mcp-stdio.cjs"), b"//");
    put(&root.join("docs.staging-1/a.md"), b"a");
    put(&root.join("updates/ATM-3.0.0.exe"), b"exe");
    put(&root.join("migration-manifest.json"), b"{}");
    fs::create_dir_all(root.join("trash")).unwrap();
    put(&root.join("sync/config.json"), b"{\"v\":1}");
    put(&root.join("sync/config.corrupt.json"), b"{");
    put(&root.join("sync/secrets.json"), b"{}");
    put(&root.join("dispatch/config.json"), b"{}");
    put(&root.join("dispatch/logs/r1.jsonl"), b"{}\n");
    put(&root.join("dispatch/requests.corrupt.json"), b"[");

    // 附件行：A1 指向附件目录里的真实文件，A2 指向附件目录里不存在的文件，A3 指向别处。
    let notes = p1.join("artifacts").join("notes.txt");
    Connection::open(p1.join("project.sqlite"))
        .unwrap()
        .execute_batch(&format!(
            "UPDATE artifacts SET local_path = '{}', sha256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
             WHERE id = 'A1';
             INSERT INTO artifacts (id, work_item_id, kind, name, local_path, actor, created_at) VALUES
               ('A2', 'W1', 'FILE', 'gone.txt', '{}', 'USER', '{T}'),
               ('A3', 'W1', 'FILE', 'elsewhere.txt', 'D:/somewhere/else.txt', 'USER', '{T}');",
            notes.display(),
            p1.join("artifacts").join("gone.txt").display()
        ))
        .unwrap();
    let sources = LegacySources::from_root(&root).unwrap();
    (
        Fixture {
            dir: base.dir.clone(),
            sources,
        },
        root,
    )
}

/// 目录树里每个文件的（相对路径，sha256）。
fn tree(dir: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in fs::read_dir(&d).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                stack.push(p);
            } else {
                out.push((
                    p.strip_prefix(dir)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/"),
                    sha_of(&p),
                ));
            }
        }
    }
    out.sort();
    out
}

/// W3b4：按数据根转换。附件逐文件复制、local_path 改写、目录表之外的备份文件登记、R / X 类计数；
/// generation 由调用方给出；数据根一个字节都不变。只剩进行中的事务（W3b6）pending。
#[test]
fn a_data_root_converts_with_its_files() {
    let (f, root) = root_fixture("legacy-root");
    let before = tree(&root);
    fs::create_dir_all(f.dir.join("out")).unwrap();
    let report = convert(
        &f.sources,
        &f.target(),
        &ConvertOptions {
            at: "2026-10-03T00:00:00.000Z",
            allow_real_data_root: false,
            real_data_root: None,
            generation: Some("GEN-FROM-THE-STATE-MACHINE"),
            secrets_check: None,
            accept_unconvertible: &[],
            origin_root: None,
            progress: None,
        },
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert!(report.failures().is_empty(), "{:?}", report.failures());
    assert_eq!(tree(&root), before, "the data root is untouched");
    assert!(report.pending().is_empty(), "{:?}", report.pending());
    let t = Connection::open(f.target()).unwrap();
    assert_eq!(
        q::<String>(&t, "SELECT generation FROM app_meta"),
        "GEN-FROM-THE-STATE-MACHINE"
    );

    // 附件：两个文件按相对路径复制，A1 改写成新根的相对路径，原值留在 legacy 列。
    let out = f.dir.join("out").join("artifacts").join("P1");
    assert_eq!(fs::read(out.join("notes.txt")).unwrap(), b"abc");
    assert_eq!(
        fs::read(out.join("sub/deep/blob.bin")).unwrap(),
        [0u8, 1, 2, 255]
    );
    assert_eq!(
        q::<String>(
            &t,
            "SELECT local_path FROM artifacts WHERE project_id = 'P1' AND id = 'A1'"
        ),
        "data/artifacts/P1/notes.txt"
    );
    assert_eq!(
        q::<String>(
            &t,
            "SELECT legacy_local_path FROM artifacts WHERE project_id = 'P1' AND id = 'A1'"
        ),
        root.join("projects/P1")
            .join("artifacts")
            .join("notes.txt")
            .display()
            .to_string()
    );
    assert_eq!(
        q::<String>(
            &t,
            "SELECT local_path FROM artifacts WHERE project_id = 'P1' AND id = 'A3'"
        ),
        "D:/somewhere/else.txt"
    );
    let files = report
        .checks
        .iter()
        .find(|c| c.family == "P1/artifacts.files")
        .unwrap();
    assert!(files.ok() && files.source_rows == 2, "{files:?}");
    assert!(
        report
            .checks
            .iter()
            .any(|c| c.family == "P3/manifest.json" && c.ok())
    );

    // 备份：目录表之外的四个 2.0 备份文件登记进 legacy_backups；不认识的文件不登记。
    assert_eq!(
        q::<String>(
            &t,
            "SELECT group_concat(source || ' ' || scope || ' ' || coalesce(project_id, '-') || ' ' || coalesce(schema_version, '-'), '; ')
             FROM (SELECT * FROM legacy_backups WHERE source <> 'CATALOG' ORDER BY id)"
        ),
        "KNOWLEDGE_BEFORE_RESTORE KNOWLEDGE - -; KNOWLEDGE_ORPHAN KNOWLEDGE - -; \
         PRE_MIGRATION_FILE REGISTRY - 7; PRE_MIGRATION_FILE PROJECT P1 14"
    );
    assert_eq!(
        q::<String>(
            &t,
            "SELECT sha256 FROM legacy_backups WHERE source = 'KNOWLEDGE_BEFORE_RESTORE'"
        ),
        sha_of(&root.join(format!("backups/knowledge/before-restore-{KB}.sqlite")))
    );

    // 信息项：附件行指向不存在的源文件、指向附件目录之外；目录表里的两个备份在磁盘上找不到。
    for note in [
        "P1/artifacts: A2 points to a missing source file",
        "P1/artifacts: A3 points outside the project's artifacts directory; local_path kept",
        "r/legacy_backups: 2 missing, first B1",
    ] {
        assert!(
            report.notes.contains(&note.to_string()),
            "{note}: {:?}",
            report.notes
        );
    }

    // R / X 类：只登记数量。
    let count = |family: &str| {
        let s = report.source(family).unwrap();
        (s.rows, s.bytes, s.digest.is_empty())
    };
    assert_eq!(count("root/runtime"), (1, Some(4), true));
    assert_eq!(count("root/install-copies"), (5, Some(12), true));
    // updates/ATM-3.0.0.exe 与数据根搬迁留下的 migration-manifest.json（W3i 在真实数据根上发现）。
    assert_eq!(count("root/setup"), (2, Some(5), true));
    // config.corrupt.json、requests.corrupt.json，加上历史里没有的 run 的日志 r1.jsonl。
    assert_eq!(count("root/diagnostic-copies"), (3, Some(5), true));
    assert_eq!(count("root/trash"), (0, Some(0), true));
    assert_eq!(count("root/backups").0, 6);
    let json: serde_json::Value = serde_json::from_str(&report.report_json()).unwrap();
    let webview = json["families"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["family"] == "root/webview")
        .unwrap();
    assert_eq!(
        (
            &webview["source"]["files"],
            &webview["source"]["bytes"],
            &webview["source"]["digest"]
        ),
        (
            &serde_json::json!(1),
            &serde_json::json!(5),
            &serde_json::Value::Null
        )
    );

    // 独立 VERIFY 结论相同；不留工作副本。
    let again = verify_converted(&f.target(), &f.sources, &report).unwrap();
    assert!(again.failures().is_empty(), "{:?}", again.failures());
    assert!(!f.dir.join("out").join("legacy-verify").exists());
    // 覆盖：拿掉附件集合的检查就成了缺口。
    let mut stripped = report.clone();
    stripped.checks.retain(|c| c.spec != "artifacts.files");
    assert!(
        stripped
            .failures()
            .contains(&"P1/artifacts.files: no check ran".to_string())
    );
}

/// W3b4：数据根里不该有的东西在动目标之前就停：未登记的顶层条目、非空的 trash、进行中的事务残留、
/// 项目目录与 registry、sync、dispatch 目录里未登记的文件。
#[test]
fn data_root_entries_that_do_not_belong_stop_the_conversion() {
    let cases: &[(&str, &str, &str)] = &[
        (
            "a stray top-level file",
            "notes.txt",
            "unregistered entry in the data root: notes.txt",
        ),
        (
            "trash is not empty",
            "trash/old.sqlite",
            "trash is not empty (1 files)",
        ),
        (
            "a knowledge restore journal that is not JSON",
            "knowledge/restore.json",
            "knowledge/restore.json is damaged",
        ),
        (
            "a stray knowledge file",
            "knowledge/notes.txt",
            "unregistered entry knowledge/notes.txt",
        ),
        (
            "an unknown hidden project directory",
            "projects/.hidden/project.sqlite",
            "unregistered entry projects/.hidden/project.sqlite",
        ),
        (
            "a rollback file nested deeper",
            "projects/P1/artifacts2/project.sqlite.restore-old-X",
            "unregistered entry projects/P1/artifacts2/project.sqlite.restore-old-X",
        ),
        (
            "a stray project file",
            "projects/P1/readme.txt",
            "unregistered entry projects/P1/readme.txt",
        ),
        (
            "a stray registry file",
            "registry/copy.sqlite",
            "unregistered entry registry/copy.sqlite",
        ),
        (
            "a stray sync file",
            "sync/other.json",
            "unregistered entry sync/other.json",
        ),
        (
            "a stray dispatch file",
            "dispatch/queue.json",
            "unregistered entry dispatch/queue.json",
        ),
    ];
    for (name, extra, expected) in cases {
        let (f, root) = root_fixture("legacy-root-refused");
        put(&root.join(extra), b"x");
        // 恢复日志在取源时就要读（决定知识库的现库），损坏的在 from_root 就停。
        let outcome = LegacySources::from_root(&root).and_then(|sources| {
            Fixture {
                sources,
                dir: f.dir.clone(),
            }
            .convert()
        });
        match outcome {
            Err(ConvertError::Unsupported(m)) => assert!(m.contains(expected), "{name}: {m}"),
            other => panic!("{name}: {other:?}"),
        }
        assert!(!f.target().exists(), "{name}: nothing is written");
    }
}

/// W3b4：文件族的 VERIFY。目标附件改一个字节、少一个文件，附件集合变红并给出路径；
/// 附件行指向的目标文件不在是停级违例；manifest 的身份字段与 registry 不一致时转换停，名字不同只记信息项。
#[test]
fn file_families_are_verified() {
    let (f, _) = root_fixture("legacy-root-files");
    let report = f.convert().unwrap_or_else(|e| panic!("{e}"));
    let out = f.dir.join("out").join("artifacts").join("P1");
    fs::write(out.join("sub/deep/blob.bin"), [0u8, 1, 2, 254]).unwrap();
    let again = verify_converted(&f.target(), &f.sources, &report).unwrap();
    assert_eq!(again.failures(), ["P1/artifacts.files"]);
    let bad = again
        .checks
        .iter()
        .find(|c| c.family == "P1/artifacts.files")
        .unwrap();
    assert_eq!(
        (bad.errors, bad.first_failure_locator.as_deref()),
        (2, Some("P1/artifacts.files(\"sub/deep/blob.bin\")"))
    );
    // A1 的行带 sha256：目标文件变了，集合变红之外再记一条信息项。
    fs::write(out.join("notes.txt"), b"abd").unwrap();
    let again = verify_converted(&f.target(), &f.sources, &report).unwrap();
    assert!(
        again
            .notes
            .contains(&"P1/artifacts: A1 size or sha256 differs from its row".to_string()),
        "{:?}",
        again.notes
    );
    fs::remove_file(out.join("notes.txt")).unwrap();
    let again = verify_converted(&f.target(), &f.sources, &report).unwrap();
    assert_eq!(
        again.failures(),
        [
            "P1/artifacts.files",
            "P1/artifacts: A1 points to a file missing from the target"
        ]
    );

    // 登记过的备份文件在转换之后变了：只记信息项（X 类）。
    let (f, root) = root_fixture("legacy-root-backup-drift");
    let report = f.convert().unwrap_or_else(|e| panic!("{e}"));
    fs::write(
        root.join(format!("backups/knowledge/before-restore-{KB}.sqlite")),
        b"changed",
    )
    .unwrap();
    let again = verify_converted(&f.target(), &f.sources, &report).unwrap();
    assert!(again.failures().is_empty(), "{:?}", again.failures());
    assert!(
        again.notes.contains(&format!(
            "r/legacy_backups: 1 sha256 differs, first KNOWLEDGE_BEFORE_RESTORE:backups/knowledge/before-restore-{KB}.sqlite"
        )),
        "{:?}",
        again.notes
    );

    let (f, root) = root_fixture("legacy-root-manifest");
    let manifest = root.join("projects/P2/manifest.json");
    let text = fs::read_to_string(&manifest).unwrap();
    fs::write(
        &manifest,
        text.replace("\"BBB\"", "\"XXX\"")
            .replace("Bravo", "Renamed"),
    )
    .unwrap();
    match f.convert() {
        Err(ConvertError::Verify(r)) => {
            assert_eq!(r.failures(), ["P2/manifest.json"]);
            assert!(r.notes.contains(
                &"P2/manifest.json: name differs from the registry (2.0 does not rewrite it on rename)".to_string()
            ));
        }
        other => panic!("{other:?}"),
    }
    fs::write(&manifest, text.replace("Bravo", "Renamed")).unwrap();
    let report = f.convert().unwrap_or_else(|e| panic!("{e}"));
    assert!(report.failures().is_empty(), "{:?}", report.failures());
    fs::remove_file(&manifest).unwrap();
    match f.convert() {
        Err(ConvertError::Verify(r)) => assert_eq!(r.failures(), ["P2/manifest.json"]),
        other => panic!("{other:?}"),
    }
}

// ---------------------------------------------------------------- W3b5：sync / dispatch 文件

const AT: &str = "2026-10-03T00:00:00.000Z";
const C1: &str = "m-0123456789ab.0000000000001deadbeef";
const C2: &str = "m-0123456789ab.0000000000002deadbeef";
const C3: &str = "pc-0123456789ab.0000000000003deadbeef";
const R1: &str = "m-0123456789ab.0000000000005deadbeef";

/// 测试里的 DPAPI 自检：认得出夹具的密文就算解得开。
fn secrets_ok(bytes: &[u8]) -> bool {
    bytes.starts_with(b"{\"relay-token\"")
}

fn secrets_bad(_: &[u8]) -> bool {
    false
}

const SYNC_CONFIG: &str = r#"{
  "v": 1,
  "enabled": true,
  "relayUrl": "https://relay.example",
  "appId": "atm",
  "deviceId": "pc-0123456789ab",
  "deviceName": "书房电脑书房电脑书房电脑书房电脑书房电脑书房电脑",
  "spaceId": "0123456789abcdef01234567",
  "cursor": "c-9",
  "published": {
    "AAA": {
      "h": "h1",
      "d": "d1",
      "head": {
        "updatedAt": "2026-09-30T00:00:00.000Z",
        "code": "AAA",
        "name": "Alpha",
        "h": "0123456789abcdef0123",
        "d": "dig",
        "counts": { "active": 1, "ready": 0, "inProgress": 1, "blocked": 0, "waitingUser": 0, "doneRecent": 2 },
        "extra": "dropped by zod"
      }
    }
  },
  "headDigest": "hd",
  "processed": ["m-0123456789ab.0000000000002deadbeef", "m-0123456789ab.0000000000001deadbeef", "pc-0123456789ab.0000000000003deadbeef"],
  "lastSyncAt": "2026-09-30T00:00:00.000Z",
  "lastAckSweepAt": null,
  "legacyField": "dropped by zod"
}
"#;

const DISPATCH_CONFIG: &str = r#"{"enabled":true,"permissionMode":"acceptEdits","maxConcurrent":2,"model":"claude-opus-5-5","effort":"high"}"#;

/// run-ok 成功并有摘要；run-killed 被信号结束（exitCode null），来自手机，带 requestId；
/// run-live 运行中；run-wait 排队中（没有 exitCode 键）；run-inf 的摘要里有 1e400（JSON.parse 得 Infinity，
/// zod 4 拒绝非有限数），最后一条缺字段，这两条丢弃。
const RUNS: &str = r#"{
  "v": 1,
  "requestsSince": "2026-09-20T00:00:00.000Z",
  "runs": [
    {"run":"run-ok","project":"AAA","key":"AAA-T-0001","title":"t1","origin":"desktop","state":"succeeded",
     "sessionId":"s1","createdAt":"2026-09-21T00:00:00.000Z","startedAt":"2026-09-21T00:00:01.000Z",
     "endedAt":"2026-09-21T00:10:00.000Z","exitCode":0,
     "summary":{"numTurns":3,"durationMs":1234.5,"totalCostUsd":0.0123,"result":"done"},
     "cwd":"C:/work","processCreatedAt":"2026-09-21T00:00:00.000Z"},
    {"run":"run-killed","project":"AAA","key":"AAA-T-0001","title":"t2","origin":"mobile","state":"failed",
     "sessionId":"s2","createdAt":"2026-09-22T00:00:00.000Z","exitCode":null,"error":"killed","cwd":"C:/work",
     "requestedBy":"phone","requestId":"m-0123456789ab.0000000000005deadbeef"},
    {"run":"run-live","project":"AAA","key":"AAA-T-9999","title":"t3","origin":"desktop","state":"running",
     "sessionId":"s3","createdAt":"2026-09-23T00:00:00.000Z","cwd":"C:/work","pid":4321,"processIdentity":"4321@133"},
    {"run":"run-wait","project":"ZZZ","key":"ZZZ-T-0001","title":"t4","origin":"desktop","state":"queued",
     "sessionId":"s4","createdAt":"2026-09-24T00:00:00.000Z","cwd":"C:/work"},
    {"run":"run-inf","project":"AAA","key":"AAA-T-0001","title":"t5","origin":"desktop","state":"failed",
     "sessionId":"s5","createdAt":"2026-09-25T00:00:00.000Z","cwd":"C:/work",
     "summary":{"numTurns":1,"durationMs":1e400,"totalCostUsd":null,"result":""}},
    {"run":"bad","project":"AAA"}
  ]
}
"#;

/// 一条快照、一条拒绝、一条不合法（id 不合字符集）→ 丢失；文件里的水位线比 `at` 早。
const REQUESTS: &str = r#"{
  "v": 1,
  "lostBefore": "2026-09-01T00:00:00.000Z",
  "requests": [
    {"id":"R0","at":"2026-09-25T00:00:00.000Z","run":{"run":"run-gone","project":"AAA","key":"AAA-T-0001",
     "title":"t0","origin":"mobile","state":"succeeded","sessionId":"s0","createdAt":"2026-09-25T00:00:00.000Z",
     "exitCode":0,"cwd":"dropped by zod"}},
    {"id":"R-rej","at":"2026-09-26T00:00:00.000Z","rejected":{"code":"DISPATCH_TASK_NOT_READY","message":"not ready"}},
    {"id":"bad id!","at":"2026-09-27T00:00:00.000Z","rejected":{"code":"DISPATCH_DISABLED","message":"x"}}
  ]
}
"#;

/// W3 peer r1 P2-01：VERIFY 由源独立推出派生列，逐行核对。附件的 `local_path`（本项目附件目录里的改写成新根的相对路径，
/// 目录外的原样）与 `project_paths.path_key`（运行时查询用的同一个函数）。目标里哪一列改错，只有对应的那一族失败。
#[test]
fn verify_checks_the_derived_paths() {
    let (f, _root) = root_fixture("w4a-p201");
    fs::create_dir_all(f.dir.join("out")).unwrap();
    let report = convert(
        &f.sources,
        &f.target(),
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
    let checked: Vec<&str> = report
        .checks
        .iter()
        .map(|c| c.family.as_str())
        .filter(|f| f.ends_with(".local_path") || f.ends_with(".path_key"))
        .collect();
    assert_eq!(
        checked,
        [
            "r/project_paths.path_key",
            "P1/artifacts.local_path",
            "P2/artifacts.local_path",
            "P3/artifacts.local_path"
        ]
    );
    let clean = f.dir.join("out").join("clean.sqlite");
    fs::copy(f.target(), &clean).unwrap();
    let cases: &[(&str, &str, &str)] = &[
        (
            "an attachment inside the directory left unrewritten",
            "UPDATE artifacts SET local_path = legacy_local_path WHERE project_id = 'P1' AND id = 'A1'",
            "P1/artifacts.local_path",
        ),
        (
            "an attachment rewritten to another file",
            "UPDATE artifacts SET local_path = 'data/artifacts/P1/gone.txt' WHERE project_id = 'P1' AND id = 'A1'",
            "P1/artifacts.local_path",
        ),
        (
            "a missing attachment left unrewritten",
            "UPDATE artifacts SET local_path = legacy_local_path WHERE project_id = 'P1' AND id = 'A2'",
            "P1/artifacts.local_path",
        ),
        (
            "an attachment outside the directory rewritten",
            "UPDATE artifacts SET local_path = 'data/artifacts/P1/else.txt' WHERE project_id = 'P1' AND id = 'A3'",
            "P1/artifacts.local_path",
        ),
        (
            "a path key that keeps the case",
            "UPDATE project_paths SET path_key = canonical_path || '/'",
            "r/project_paths.path_key",
        ),
    ];
    for (name, tamper, expected) in cases {
        fs::copy(&clean, f.target()).unwrap();
        let t = Connection::open(f.target()).unwrap();
        assert_eq!(t.execute(tamper, []).unwrap(), 1, "{name}");
        drop(t);
        let failures = verify_converted(&f.target(), &f.sources, &report)
            .unwrap()
            .failures();
        assert_eq!(failures, [*expected], "{name}");
    }
}

/// W3b5：在数据根夹具上换上完整的 sync / dispatch 文件。
fn json_fixture(name: &str) -> (Fixture, PathBuf) {
    let (f, root) = root_fixture(name);
    put(&root.join("sync/config.json"), SYNC_CONFIG.as_bytes());
    put(
        &root.join("sync/secrets.dpapi.json"),
        b"{\"relay-token\":\"AQAAANCMnd8BFdERjHoAwE\"}",
    );
    put(
        &root.join("dispatch/config.json"),
        DISPATCH_CONFIG.as_bytes(),
    );
    put(&root.join("dispatch/runs.json"), RUNS.as_bytes());
    put(&root.join("dispatch/requests.json"), REQUESTS.as_bytes());
    put(
        &root.join("dispatch/logs/run-ok.jsonl"),
        b"{\"type\":\"result\"}\n",
    );
    put(&root.join("dispatch/logs/run-ok.stderr.log"), b"");
    put(
        &root.join("dispatch/logs/run-live.jsonl"),
        b"{\"type\":\"init\"}\n",
    );
    put(&root.join("dispatch/logs/ghost.stderr.log"), b"gone");
    (f, root)
}

fn notes_contain(report: &Report, note: &str) {
    assert!(
        report.notes.iter().any(|n| n == note),
        "{note}: {:?}",
        report.notes
    );
}

/// W3b5：sync / dispatch 文件按 2.0 的读盘语义转换。zod 丢掉的键不进库；exitCode 的三态保留；
/// 坏的 run 丢弃并记 damaged；账本有坏条目 → 水位线落到 `at`，带 requestId 的历史补回；
/// 密文逐字节复制，非运行中的日志复制，运行中的留在旧根（LEGACY），历史外的日志记 X9；数据根一个字节都不变。
#[test]
fn sync_and_dispatch_files_convert_like_2x_reads_them() {
    let (f, root) = json_fixture("legacy-json-files");
    let before = tree(&root);
    let report = f
        .convert_with(Some(secrets_ok))
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(report.failures().is_empty(), "{:?}", report.failures());
    assert_eq!(tree(&root), before, "the data root is untouched");
    assert!(report.pending().is_empty(), "{:?}", report.pending());
    for note in [
        "dispatch/runs.json: invalid runs were dropped; history starts from what could be read",
        "dispatch/requests.json: the ledger has an invalid entry; lost_before set to 2026-10-03T00:00:00.000Z",
        "dispatch/requests.json: 1 requests restored from the run history",
        "dispatch_runs: 2 runs point to a task that does not resolve; task_id left NULL",
        "dispatch/logs: 2 files belong to runs that are not in the history; 2.0 deletes them on its next save, not copied",
    ] {
        notes_contain(&report, note);
    }
    for check in [
        "r/sync.config",
        "r/sync.secrets",
        "r/dispatch.config",
        "r/dispatch.runs",
        "r/dispatch.requests",
        "r/dispatch.logs",
    ] {
        let c = report.checks.iter().find(|c| c.family == check);
        assert!(c.is_some_and(|c| c.ok()), "{check}: {c:?}");
    }
    let rows = |family: &str| report.source(family).unwrap().rows;
    assert_eq!(
        [
            rows("root/sync.config"),
            rows("root/sync.secrets"),
            rows("root/dispatch.config"),
            rows("root/dispatch.runs"),
            rows("root/dispatch.requests"),
            rows("root/dispatch.logs.running"),
        ],
        [1, 1, 1, 4, 2, 1]
    );

    let t = Connection::open(f.target()).unwrap();
    let row = |sql: &str| -> Vec<String> {
        t.query_row(sql, [], |r| {
            (0..r.as_ref().column_count())
                .map(|i| {
                    r.get::<_, rusqlite::types::Value>(i).map(|v| match v {
                        rusqlite::types::Value::Null => "NULL".to_string(),
                        rusqlite::types::Value::Integer(n) => n.to_string(),
                        rusqlite::types::Value::Real(x) => x.to_string(),
                        rusqlite::types::Value::Text(s) => s,
                        rusqlite::types::Value::Blob(_) => "BLOB".to_string(),
                    })
                })
                .collect()
        })
        .unwrap()
    };
    assert_eq!(
        row("SELECT v, enabled, relay_url, app_id, device_id, device_name, space_id, cursor, head_digest,
                    last_sync_at, last_ack_sweep_at, updated_at FROM sync_state"),
        [
            "1",
            "1",
            "https://relay.example",
            "atm",
            "pc-0123456789ab",
            "书房电脑书房电脑书房电脑书房电脑书房电脑书房电脑",
            "0123456789abcdef01234567",
            "c-9",
            "hd",
            "2026-09-30T00:00:00.000Z",
            "NULL",
            AT
        ]
    );
    assert_eq!(
        q::<String>(
            &t,
            "SELECT group_concat(command_id, ' ') FROM (SELECT command_id FROM sync_processed ORDER BY ord)"
        ),
        format!("{C2} {C1} {C3}")
    );
    // head 按 JCS 存：键排序，zod 丢掉的键不在。
    assert_eq!(
        row("SELECT project_code, h, d, head_json FROM sync_published"),
        [
            "AAA",
            "h1",
            "d1",
            r#"{"code":"AAA","counts":{"active":1,"blocked":0,"doneRecent":2,"inProgress":1,"ready":0,"waitingUser":0},"d":"dig","h":"0123456789abcdef0123","name":"Alpha","updatedAt":"2026-09-30T00:00:00.000Z"}"#
        ]
    );
    assert_eq!(
        row(
            "SELECT enabled, permission_mode, max_concurrent, model, effort, source_state, updated_at FROM dispatch_config"
        ),
        ["1", "acceptEdits", "2", "claude-opus-5-5", "high", "OK", AT]
    );
    assert_eq!(
        row("SELECT requests_since, lost_before, runs_damaged_at_conversion FROM dispatch_meta"),
        ["2026-09-20T00:00:00.000Z", AT, "1"]
    );
    let run = |id: &str| {
        row(&format!(
            "SELECT state, exit_code, exit_code_set, summary_json, pid, process_identity, request_id, log_root,
                    ifnull(task_id, 'NULL') FROM dispatch_runs WHERE run = '{id}'"
        ))
    };
    assert_eq!(
        run("run-ok"),
        [
            "succeeded",
            "0",
            "1",
            r#"{"durationMs":1234.5,"numTurns":3,"result":"done","totalCostUsd":0.0123}"#,
            "NULL",
            "NULL",
            "NULL",
            "CURRENT",
            "W1"
        ]
    );
    assert_eq!(
        run("run-killed"),
        [
            "failed", "NULL", "1", "NULL", "NULL", "NULL", R1, "CURRENT", "W1"
        ]
    );
    assert_eq!(
        run("run-live"),
        [
            "running", "NULL", "0", "NULL", "4321", "4321@133", "NULL", "LEGACY", "NULL"
        ]
    );
    assert_eq!(
        run("run-wait"),
        [
            "queued", "NULL", "0", "NULL", "NULL", "NULL", "NULL", "CURRENT", "NULL"
        ]
    );
    assert_eq!(q::<i64>(&t, "SELECT count(*) FROM dispatch_runs"), 4);
    let request = |id: &str| {
        row(&format!(
            "SELECT at, ifnull(run_snapshot_json, 'NULL'), ifnull(rejected_code, 'NULL'), ifnull(rejected_message, 'NULL')
             FROM dispatch_requests WHERE id = '{id}'"
        ))
    };
    assert_eq!(
        request("R0"),
        [
            "2026-09-25T00:00:00.000Z",
            r#"{"createdAt":"2026-09-25T00:00:00.000Z","exitCode":0,"key":"AAA-T-0001","origin":"mobile","project":"AAA","run":"run-gone","sessionId":"s0","state":"succeeded","title":"t0"}"#,
            "NULL",
            "NULL"
        ]
    );
    assert_eq!(
        request("R-rej"),
        [
            "2026-09-26T00:00:00.000Z",
            "NULL",
            "DISPATCH_TASK_NOT_READY",
            "not ready"
        ]
    );
    // 补回的条目：snapshotOf(toRunView(record))，exitCode: null 照留，本机字段去掉。
    assert_eq!(
        request(R1),
        [
            "2026-09-22T00:00:00.000Z",
            r#"{"createdAt":"2026-09-22T00:00:00.000Z","error":"killed","exitCode":null,"key":"AAA-T-0001","origin":"mobile","project":"AAA","run":"run-killed","sessionId":"s2","state":"failed","title":"t2"}"#,
            "NULL",
            "NULL"
        ]
    );
    assert_eq!(q::<i64>(&t, "SELECT count(*) FROM dispatch_requests"), 3);

    let out = f.dir.join("out");
    assert_eq!(
        fs::read(out.join("sync/secrets.dpapi.json")).unwrap(),
        fs::read(root.join("sync/secrets.dpapi.json")).unwrap()
    );
    assert_eq!(
        listing(&out.join("dispatch/logs"))
            .into_iter()
            .map(|(n, _)| n)
            .collect::<Vec<_>>(),
        ["run-ok.jsonl", "run-ok.stderr.log"]
    );
}

/// W3b5：2.0 的回退照做。坏的或缺的 sync 配置 → 不写 sync_state（3.0 首启从默认值开始，与 2.0 一样）；
/// 派单配置多一个键（strict）或是坏 JSON（含 BOM）→ 默认值、CORRUPT_DEFAULTED，缺失 → MISSING；
/// 账本缺失时按历史判断是不是丢了；文件里比 `at` 晚的水位线保留。
#[test]
fn damaged_sync_and_dispatch_files_fall_back_like_2x() {
    let write = |rel: &'static str, text: &'static str| {
        move |root: &Path| put(&root.join(rel), text.as_bytes())
    };
    let remove = |rel: &'static str| move |root: &Path| fs::remove_file(root.join(rel)).unwrap();
    let corrupt_sync = write("sync/config.json", "{");
    let bom_sync: &dyn Fn(&Path) = &|root: &Path| {
        put(
            &root.join("sync/config.json"),
            format!("\u{feff}{SYNC_CONFIG}").as_bytes(),
        )
    };
    let missing_sync = remove("sync/config.json");
    let strict_dispatch = write(
        "dispatch/config.json",
        r#"{"enabled":true,"permissionMode":"auto","maxConcurrent":1,"model":null,"effort":null,"extra":1}"#,
    );
    let four = write(
        "dispatch/config.json",
        r#"{"enabled":true,"permissionMode":"auto","maxConcurrent":4,"model":null,"effort":null}"#,
    );
    let missing_dispatch = remove("dispatch/config.json");
    let corrupt_runs = write("dispatch/runs.json", "not json");
    let missing_ledger = remove("dispatch/requests.json");
    let history = |runs: &'static str| {
        move |root: &Path| {
            put(&root.join("dispatch/runs.json"), runs.as_bytes());
            fs::remove_file(root.join("dispatch/requests.json")).unwrap();
        }
    };
    let clean_history: &dyn Fn(&Path) = &|root: &Path| {
        put(
            &root.join("dispatch/runs.json"),
            br#"{"v":1,"runs":[{"run":"run-ok","project":"AAA","key":"AAA-T-0001","title":"t","origin":"desktop","state":"succeeded","sessionId":"s","createdAt":"2026-09-21T00:00:00.000Z","cwd":"C:/w"}]}"#,
        );
        fs::remove_file(root.join("dispatch/requests.json")).unwrap();
        fs::remove_file(root.join("dispatch/logs/run-live.jsonl")).unwrap();
    };
    let later_mark = write(
        "dispatch/requests.json",
        r#"{"v":1,"lostBefore":"2026-12-01T00:00:00.000Z","requests":[{"id":"bad id!","at":"x","rejected":{"code":"DISPATCH_DISABLED","message":"x"}}]}"#,
    );
    let fractional = write(
        "dispatch/config.json",
        r#"{"enabled":true,"permissionMode":"auto","maxConcurrent":1.5,"model":null,"effort":null}"#,
    );
    let bad_published = write(
        "sync/config.json",
        r#"{"v":1,"enabled":false,"relayUrl":null,"appId":"atm","deviceId":"pc-0123456789ab","deviceName":"d",
            "spaceId":null,"cursor":null,"published":{"aaa":{"h":"h","d":"d","head":{"code":"AAA","name":"",
            "h":"0123456789abcdef0123","d":"x","counts":{"active":0,"ready":0,"inProgress":0,"blocked":0,
            "waitingUser":0,"doneRecent":0},"updatedAt":"u"}}},"headDigest":null,"processed":[],
            "lastSyncAt":null,"lastAckSweepAt":null}"#,
    );
    // 账本缺失时「用过手机派单」的四种迹象，各自单独出现。
    let mobile_only = history(
        r#"{"v":1,"runs":[{"run":"run-m","project":"AAA","key":"AAA-T-0001","title":"t","origin":"mobile","state":"succeeded","sessionId":"s","createdAt":"2026-09-21T00:00:00.000Z","cwd":"C:/w"}]}"#,
    );
    let request_only = history(
        r#"{"v":1,"runs":[{"run":"run-r","project":"AAA","key":"AAA-T-0001","title":"t","origin":"desktop","state":"succeeded","sessionId":"s","createdAt":"2026-09-21T00:00:00.000Z","cwd":"C:/w","requestId":"RQ-1"}]}"#,
    );
    let since_only = history(
        r#"{"v":1,"requestsSince":"2026-09-20T00:00:00.000Z","runs":[{"run":"run-d","project":"AAA","key":"AAA-T-0001","title":"t","origin":"desktop","state":"succeeded","sessionId":"s","createdAt":"2026-09-21T00:00:00.000Z","cwd":"C:/w"}]}"#,
    );
    let damaged_only = history(
        r#"{"v":1,"runs":[{"run":"run-d","project":"AAA","key":"AAA-T-0001","title":"t","origin":"desktop","state":"succeeded","sessionId":"s","createdAt":"2026-09-21T00:00:00.000Z","cwd":"C:/w"},{"run":"x"}]}"#,
    );
    let recorded = write(
        "dispatch/requests.json",
        r#"{"v":1,"requests":[{"id":"m-0123456789ab.0000000000005deadbeef","at":"2026-09-22T00:00:00.000Z","rejected":{"code":"DISPATCH_DISABLED","message":"off"}}]}"#,
    );
    let two_runs: &dyn Fn(&Path) = &|root: &Path| {
        put(
            &root.join("dispatch/runs.json"),
            br#"{"v":1,"runs":[
              {"run":"r-new","project":"AAA","key":"AAA-T-0001","title":"t","origin":"mobile","state":"failed","sessionId":"s","createdAt":"2026-09-22T00:00:00.000Z","cwd":"","requestId":"RQ"},
              {"run":"r-old","project":"AAA","key":"AAA-T-0001","title":"t","origin":"mobile","state":"failed","sessionId":"s","createdAt":"2026-09-21T00:00:00.000Z","cwd":"","requestId":"RQ"}]}"#,
        );
        put(
            &root.join("dispatch/requests.json"),
            br#"{"v":1,"requests":[]}"#,
        );
    };
    let quiet_mark = write(
        "dispatch/requests.json",
        r#"{"v":1,"lostBefore":"2026-09-01T00:00:00.000Z","requests":[]}"#,
    );
    // (名字, 改动, 查询, 期望, 信息项)
    type Case<'a> = (
        &'a str,
        &'a dyn Fn(&Path),
        &'a str,
        &'a str,
        Option<&'a str>,
    );
    let cases: Vec<Case> = vec![
        (
            "corrupt sync config",
            &corrupt_sync,
            "SELECT count(*) FROM sync_state",
            "0",
            Some("sync/config.json is corrupt or invalid; like 2.0 the converted store starts unpaired from defaults"),
        ),
        ("a BOM makes JSON.parse fail", bom_sync, "SELECT count(*) FROM sync_state", "0", None),
        ("missing sync config", &missing_sync, "SELECT count(*) || '/' || (SELECT count(*) FROM sync_processed) FROM sync_state", "0/0", None),
        (
            "strict dispatch config",
            &strict_dispatch,
            "SELECT enabled || permission_mode || max_concurrent || ifnull(model, '-') || source_state FROM dispatch_config",
            "0auto1-CORRUPT_DEFAULTED",
            Some("dispatch/config.json is corrupt or invalid; defaults are used (2.0 does not rewrite it)"),
        ),
        ("maxConcurrent out of range", &four, "SELECT source_state FROM dispatch_config", "CORRUPT_DEFAULTED", None),
        ("missing dispatch config", &missing_dispatch, "SELECT enabled || source_state FROM dispatch_config", "0MISSING", None),
        (
            "corrupt run history",
            &corrupt_runs,
            "SELECT (SELECT count(*) FROM dispatch_runs) || ifnull(requests_since, '-') || runs_damaged_at_conversion
                    || (SELECT count(*) FROM dispatch_requests) FROM dispatch_meta",
            "0-12",
            Some("dispatch/runs.json: the file is corrupt; history starts from what could be read"),
        ),
        (
            "missing ledger after phone dispatch",
            &missing_ledger,
            "SELECT lost_before || '/' || (SELECT group_concat(id) FROM dispatch_requests) FROM dispatch_meta",
            "2026-10-03T00:00:00.000Z/m-0123456789ab.0000000000005deadbeef",
            Some("dispatch/requests.json: the ledger is missing although phone dispatch was used (or the history is damaged); lost_before set to 2026-10-03T00:00:00.000Z"),
        ),
        (
            "missing ledger on a desktop-only history",
            clean_history,
            "SELECT ifnull(lost_before, '-') || runs_damaged_at_conversion || (SELECT count(*) FROM dispatch_requests) FROM dispatch_meta",
            "-00",
            None,
        ),
        ("a later mark survives a loss", &later_mark, "SELECT lost_before FROM dispatch_meta", "2026-12-01T00:00:00.000Z", None),
        ("a mark without a loss is kept", &quiet_mark, "SELECT lost_before FROM dispatch_meta", "2026-09-01T00:00:00.000Z", None),
        ("a fractional concurrency", &fractional, "SELECT source_state FROM dispatch_config", "CORRUPT_DEFAULTED", None),
        ("a published key that is not a project code", &bad_published, "SELECT count(*) FROM sync_state", "0", None),
        ("a mobile run without a request id", &mobile_only, "SELECT ifnull(lost_before, '-') FROM dispatch_meta", AT, None),
        ("a desktop run with a request id", &request_only, "SELECT lost_before || '/' || (SELECT group_concat(id) FROM dispatch_requests) FROM dispatch_meta", "2026-10-03T00:00:00.000Z/RQ-1", None),
        ("only the requestsSince mark", &since_only, "SELECT ifnull(lost_before, '-') FROM dispatch_meta", AT, None),
        ("only a damaged history", &damaged_only, "SELECT ifnull(lost_before, '-') FROM dispatch_meta", AT, None),
        ("a recorded request is not overwritten by the history", &recorded, "SELECT rejected_code FROM dispatch_requests WHERE id = 'm-0123456789ab.0000000000005deadbeef'", "DISPATCH_DISABLED", None),
        ("the latest of two runs answers a request", two_runs, "SELECT json_extract(run_snapshot_json, '$.run') FROM dispatch_requests WHERE id = 'RQ'", "r-new", None),
    ];
    for (name, edit, sql, expected, note) in cases {
        let (f, root) = json_fixture("legacy-json-fallback");
        edit(&root);
        let report = f
            .convert_with(Some(secrets_ok))
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        assert!(
            report.failures().is_empty(),
            "{name}: {:?}",
            report.failures()
        );
        let t = Connection::open(f.target()).unwrap();
        let got: String = q(&t, &format!("SELECT CAST(({sql}) AS TEXT)"));
        assert_eq!(got, expected, "{name}");
        if let Some(note) = note {
            notes_contain(&report, note);
        }
    }
}

/// W3b5：超出接受域的停下，不猜：没有宿主的 DPAPI 自检、自检失败、文件在却读不出来、水位线不是 toISOString 的形状、
/// run / 请求 / 已处理命令重复、日志目录里的陌生文件、JS 字符串里落单的代理项。目标一个字节都不写。
#[test]
fn sync_and_dispatch_files_outside_the_domain_stop_the_conversion() {
    type SecretsCheck = Option<fn(&[u8]) -> bool>;
    let cases: Vec<(&str, &str, &str, SecretsCheck, &str)> = vec![
        (
            "no host self-check",
            "",
            "",
            None,
            "needs the host's DPAPI self-check",
        ),
        (
            "the secrets do not decrypt",
            "",
            "",
            Some(secrets_bad),
            "does not decrypt for this Windows account; phone pairing must be redone",
        ),
        (
            "a mark Date.parse would have to guess",
            "dispatch/requests.json",
            r#"{"v":1,"lostBefore":"2026-09-01","requests":[]}"#,
            Some(secrets_ok),
            "lostBefore \"2026-09-01\" is not in toISOString form",
        ),
        (
            "a run listed twice",
            "dispatch/runs.json",
            r#"{"v":1,"runs":[
              {"run":"x","project":"A","key":"A-T-0001","title":"","origin":"desktop","state":"failed","sessionId":"s","createdAt":"c","cwd":""},
              {"run":"x","project":"A","key":"A-T-0001","title":"","origin":"desktop","state":"failed","sessionId":"s","createdAt":"c","cwd":""}]}"#,
            Some(secrets_ok),
            "dispatch/runs.json lists run \"x\" twice",
        ),
        (
            "a request listed twice",
            "dispatch/requests.json",
            r#"{"v":1,"requests":[{"id":"R","at":"a","rejected":{"code":"DISPATCH_DISABLED","message":""}},
                                  {"id":"R","at":"b","rejected":{"code":"DISPATCH_DISABLED","message":""}}]}"#,
            Some(secrets_ok),
            "dispatch/requests.json lists request \"R\" twice",
        ),
        (
            "a processed command listed twice",
            "sync/config.json",
            r#"{"v":1,"enabled":false,"relayUrl":null,"appId":"atm","deviceId":"pc-0123456789ab","deviceName":"d",
                "spaceId":null,"cursor":null,"published":{},"headDigest":null,
                "processed":["m-0123456789ab.0000000000001deadbeef","m-0123456789ab.0000000000001deadbeef"],
                "lastSyncAt":null,"lastAckSweepAt":null}"#,
            Some(secrets_ok),
            "sync/config.json lists processed command",
        ),
        (
            "a stray file in the log directory",
            "dispatch/logs/notes.txt",
            "x",
            Some(secrets_ok),
            "unregistered entry dispatch/logs/notes.txt",
        ),
        (
            "a log in a subdirectory",
            "dispatch/logs/old/run-ok.jsonl",
            "x",
            Some(secrets_ok),
            "unregistered entry dispatch/logs/old/run-ok.jsonl",
        ),
        (
            "a file that exists but cannot be read",
            "dispatch/runs.json/",
            "",
            Some(secrets_ok),
            "dispatch/runs.json cannot be read",
        ),
        (
            "a lone surrogate",
            "dispatch/config.json",
            r#"{"enabled":true,"permissionMode":"auto","maxConcurrent":1,"model":"\ud800","effort":null}"#,
            Some(secrets_ok),
            "dispatch/config.json: a JSON string holds a lone surrogate",
        ),
    ];
    for (name, rel, text, check, expected) in cases {
        let (f, root) = json_fixture("legacy-json-refused");
        if rel.ends_with('/') {
            // 同名的目录：文件「在」，但读不出来（2.0 readJsonFile 的 unreadable）。
            fs::remove_file(root.join(rel.trim_end_matches('/'))).unwrap();
            fs::create_dir_all(root.join(rel)).unwrap();
        } else if !rel.is_empty() {
            put(&root.join(rel), text.as_bytes());
        }
        match f.convert_with(check) {
            Err(ConvertError::Unsupported(m)) => assert!(m.contains(expected), "{name}: {m}"),
            other => panic!("{name}: {other:?}"),
        }
        assert!(!f.target().exists(), "{name}: nothing is written");
    }
}

/// W3b5：VERIFY 把目标表反投影回 2.0 的形状比 JCS。改一个值、删一行、动一个三态位、动复制出去的文件，
/// 只有对应的族变红并给出第一处不同；log_root 与 task_id 这两个 3.0 自己的列另有图检查。
#[test]
fn sync_and_dispatch_tampering_turns_exactly_its_family_red() {
    let (f, _) = json_fixture("legacy-json-tamper");
    let report = f.convert_with(Some(secrets_ok)).unwrap();
    let clean = f.dir.join("clean.sqlite");
    fs::copy(f.target(), &clean).unwrap();
    let out = f.dir.join("out");
    // (名字, 改目标库的 SQL, 改复制出去的文件, 期望的失败, 第一处不同)；文件集合改一个文件是两处不同（两边各少一条）。
    let cases: Vec<(&str, &str, &str, &[&str], &str)> = vec![
        (
            "a device renamed",
            "UPDATE sync_state SET device_name = 'x'",
            "",
            &["r/sync.config"],
            "r/sync.config",
        ),
        (
            "a processed command lost",
            "DELETE FROM sync_processed WHERE ord = 1",
            "",
            &["r/sync.config"],
            "r/sync.config",
        ),
        (
            "processed reordered",
            "UPDATE sync_processed SET ord = 10 - ord",
            "",
            &["r/sync.config"],
            "r/sync.config",
        ),
        (
            "a head changed",
            "UPDATE sync_published SET head_json = json_set(head_json, '$.name', 'B')",
            "",
            &["r/sync.config"],
            "r/sync.config",
        ),
        (
            "concurrency raised",
            "UPDATE dispatch_config SET max_concurrent = 3",
            "",
            &["r/dispatch.config"],
            "r/dispatch.config",
        ),
        (
            "a source state lies",
            "UPDATE dispatch_config SET source_state = 'MISSING'",
            "",
            &["r/dispatch.config"],
            "r/dispatch.config",
        ),
        (
            "exitCode null became absent",
            "UPDATE dispatch_runs SET exit_code_set = 0 WHERE run = 'run-killed'",
            "",
            &["r/dispatch.runs"],
            "r/dispatch.runs(\"run-killed\")",
        ),
        (
            "a summary lost a field",
            "UPDATE dispatch_runs SET summary_json = '{\"result\":\"done\"}' WHERE run = 'run-ok'",
            "",
            &["r/dispatch.runs"],
            "r/dispatch.runs(\"run-ok\")",
        ),
        (
            "an extra run",
            "INSERT INTO dispatch_runs (run, project_code, task_key, title, origin, state, session_id, created_at, cwd, log_root) VALUES ('run-x', 'AAA', 'AAA-T-0001', '', 'desktop', 'failed', 's', 'c', '', 'CURRENT')",
            "",
            &["r/dispatch.runs"],
            "r/dispatch.runs(\"run-x\")",
        ),
        (
            "damage forgotten",
            "UPDATE dispatch_meta SET runs_damaged_at_conversion = 0",
            "",
            &["r/dispatch.runs"],
            "r/dispatch.runs",
        ),
        (
            "a backfilled request lost",
            "DELETE FROM dispatch_requests WHERE id = 'm-0123456789ab.0000000000005deadbeef'",
            "",
            &["r/dispatch.requests"],
            "r/dispatch.requests(\"m-0123456789ab.0000000000005deadbeef\")",
        ),
        (
            "a rejection reworded",
            "UPDATE dispatch_requests SET rejected_message = 'x' WHERE id = 'R-rej'",
            "",
            &["r/dispatch.requests"],
            "r/dispatch.requests(\"R-rej\")",
        ),
        (
            "the mark cleared",
            "UPDATE dispatch_meta SET lost_before = NULL",
            "",
            &["r/dispatch.requests"],
            "r/dispatch.requests",
        ),
        (
            "secrets rewritten",
            "",
            "sync/secrets.dpapi.json",
            &["r/sync.secrets"],
            "r/sync.secrets",
        ),
        (
            "a log changed",
            "",
            "dispatch/logs/run-ok.jsonl",
            &["r/dispatch.logs"],
            "r/dispatch.logs(\"run-ok.jsonl\")",
        ),
        (
            "a running log moved to the new root",
            "UPDATE dispatch_runs SET log_root = 'CURRENT' WHERE run = 'run-live'",
            "",
            &["dispatch_runs: 1 runs have the wrong log_root"],
            "",
        ),
        (
            "a task id that does not match the key",
            "UPDATE dispatch_runs SET task_id = 'W2' WHERE run = 'run-ok'",
            "",
            &["dispatch_runs: run-ok task_id does not match its task_key"],
            "",
        ),
    ];
    for (name, sql, file, expected, locator) in cases {
        fs::copy(&clean, f.target()).unwrap();
        let t = Connection::open(f.target()).unwrap();
        t.execute_batch(sql).unwrap();
        drop(t);
        let saved = (!file.is_empty()).then(|| {
            let bytes = fs::read(out.join(file)).unwrap();
            fs::write(out.join(file), b"tampered").unwrap();
            bytes
        });
        let again = verify_converted(&f.target(), &f.sources, &report).unwrap();
        assert_eq!(again.failures(), expected, "{name}");
        if !locator.is_empty() {
            let bad = again
                .checks
                .iter()
                .find(|c| c.family == expected[0])
                .unwrap();
            let errors = if file.starts_with("dispatch/logs") {
                2
            } else {
                1
            };
            assert_eq!(
                (bad.errors, bad.first_failure_locator.as_deref()),
                (errors, Some(locator)),
                "{name}"
            );
        }
        if let Some(bytes) = saved {
            fs::write(out.join(file), bytes).unwrap();
        }
    }
}

/// W3b5：值树与 JCS。键按 UTF-16 码元排序（不是按 UTF-8 字节），数字按 JS 输出，重复键后者覆盖，
/// 落单的代理项与过深的嵌套显式拒绝。
#[test]
fn jcs_sorts_by_utf16_and_prints_numbers_like_js() {
    let v = jsjson::parse_value(
        r#"{"b":1,"a":[1e21,0.1,-0,1.50],"😀":true,"ｚ":null,"a":{"y":"\u0007","x":"é"}}"#,
    )
    .unwrap()
    .unwrap();
    // U+FF5A（ｚ）的 UTF-16 码元 0xFF5A 大于 😀 的高代理 0xD83D；按 UTF-8 字节排则相反。
    assert_eq!(
        jsjson::jcs(&v),
        "{\"a\":{\"x\":\"é\",\"y\":\"\\u0007\"},\"b\":1,\"😀\":true,\"ｚ\":null}"
    );
    let n = jsjson::parse_value("[1e21,0.1,-0,1.50,100,1e-7]")
        .unwrap()
        .unwrap();
    assert_eq!(jsjson::jcs(&n), "[1e+21,0.1,0,1.5,100,1e-7]");
    assert_eq!(
        jsjson::parse_value(r#"["\ud800"]"#),
        Err(jsjson::ValueError::LoneSurrogate)
    );
    assert_eq!(
        jsjson::parse_value(&"[".repeat(jsjson::MAX_DEPTH + 1)),
        Err(jsjson::ValueError::TooDeep)
    );
    assert_eq!(jsjson::parse_value("\u{feff}{}"), Ok(None));
}

/// W3b5：给了数据根时，转换的文件族（F1–F6）没跑检查也算覆盖缺口；F7 只登记、X 类不转换，不算。
#[test]
fn root_file_families_without_a_check_are_coverage_gaps() {
    let report = Report {
        root: true,
        ..Report::default()
    };
    let gaps: Vec<String> = report
        .uncovered()
        .into_iter()
        .filter(|g| g.starts_with("root/"))
        .collect();
    assert_eq!(
        gaps,
        [
            "root/sync.config: no check ran",
            "root/sync.secrets: no check ran",
            "root/dispatch.config: no check ran",
            "root/dispatch.runs: no check ran",
            "root/dispatch.requests: no check ran",
            "root/dispatch.logs.final: no check ran",
        ]
    );
}

// ---------------------------------------------------------------- W3b6：进行中文件事务的落定

const KJ: &str = "01J00000000000000000000KJ1";
const KC: &str = "01J00000000000000000000KC1";
const RA: &str = "01J0000000000000000000RBKA";
const RB: &str = "01J0000000000000000000RBKB";
const RC: &str = "01J0000000000000000000RBKC";

/// 一个刚建好的 2.x 项目库：与 2.0 createProject 写的一样（project_meta + 五个计数器），可以只迁移到 `upto`。
fn empty_project(path: &Path, pid: &str, code: &str, upto: i64, objective: Option<&str>) {
    let _ = fs::remove_file(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let p = legacy_upto(path, "project", upto);
    let schema: i64 = p
        .query_row("SELECT max(version) FROM schema_migrations", [], |r| {
            r.get(0)
        })
        .unwrap();
    p.execute_batch(&format!(
        "INSERT INTO project_meta (singleton, project_id, project_code, name, description, lifecycle, coordination_mode, health,
                                   current_sequence, schema_version, version, created_at, updated_at)
           VALUES (1, '{pid}', '{code}', 'meta {pid}', '', 'ACTIVE', 'AUTO', 'UNKNOWN', 0, {schema}, 0, '{T}', '{T}');
         INSERT INTO counters (name, next_value) VALUES ('objective', 1), ('milestone', 1), ('work_item', 1), ('blocker', 1), ('record', 1);"
    ))
    .unwrap();
    if let Some(title) = objective {
        p.execute_batch(&format!(
            "UPDATE counters SET next_value = 2 WHERE name = 'objective';
             INSERT INTO objectives (id, local_no, title, status, created_at, updated_at) VALUES ('OBJ', 1, '{title}', 'ACTIVE', '{T}', '{T}');"
        ))
        .unwrap();
    }
}

fn register(root: &Path, rows: &[(&str, &str, &str)]) {
    let r = Connection::open(root.join("registry/registry.sqlite")).unwrap();
    for (id, code, life) in rows {
        r.execute(
            "INSERT INTO projects (id, code, name, description, db_path, lifecycle, coordination_mode, version, created_at, updated_at)
             VALUES (?1, ?2, ?3, '', NULL, ?4, 'AUTO', 0, ?5, ?5)",
            params![id, code, format!("name {id}"), life, T],
        )
        .unwrap();
    }
}

fn manifest(root: &Path, pid: &str, code: &str) {
    put(
        &root.join(format!("projects/{pid}/manifest.json")),
        format!("{{\n  \"schema_version\": 1,\n  \"project_id\": \"{pid}\",\n  \"project_code\": \"{code}\",\n  \"name\": \"name {pid}\"\n}}\n").as_bytes(),
    );
}

/// W3b6：数据根里摆上 2.0 启动恢复要处理的每一种残留。
/// - P4 CREATING，库已改名到位但 manifest 还没写；P5 CREATING，库还在 `.creating-P5`；
/// - P6 RESTORING：现库坏了，两个回滚件里名字靠后的坏、靠前的好；还有 `.restore-*` 暂存目录；
/// - P7 MIGRATION_FAILED：库停在旧版本；P1 ACTIVE 却留着一个回滚件；
/// - 知识库恢复日志没提交，before-restore 在；候选件和另一个孤儿候选件也在。
fn settle_fixture(name: &str) -> (Fixture, PathBuf) {
    let (_, root) = json_fixture(name);
    register(
        &root,
        &[
            ("P4", "DDD", "CREATING"),
            ("P5", "EEE", "CREATING"),
            ("P6", "FFF", "RESTORING"),
            ("P7", "GGG", "MIGRATION_FAILED"),
            ("P8", "HHH", "CREATING"),
            ("P9", "III", "RESTORING"),
        ],
    );
    empty_project(
        &root.join("projects/P4/project.sqlite"),
        "P4",
        "DDD",
        i64::MAX,
        None,
    );
    empty_project(
        &root.join("projects/.creating-P5/project.sqlite"),
        "P5",
        "EEE",
        i64::MAX,
        None,
    );
    put(&root.join("projects/P6/project.sqlite"), b"not a database");
    empty_project(
        &root.join(format!("projects/P6/project.sqlite.restore-old-{RA}")),
        "P6",
        "FFF",
        i64::MAX,
        Some("older rollback"),
    );
    empty_project(
        &root.join(format!("projects/P6/project.sqlite.restore-old-{RB}")),
        "P6",
        "FFF",
        i64::MAX,
        Some("rolled back"),
    );
    put(
        &root.join(format!("projects/P6/project.sqlite.restore-old-{RC}")),
        b"torn",
    );
    put(
        &root.join(format!("projects/.restore-{RB}/project.sqlite")),
        b"candidate",
    );
    manifest(&root, "P6", "FFF");
    empty_project(
        &root.join("projects/P7/project.sqlite"),
        "P7",
        "GGG",
        10,
        Some("old schema"),
    );
    manifest(&root, "P7", "GGG");
    // P8：CREATING，库改名到位了但是坏的 → TRASHED，坏库不转换。P9：RESTORING，第一次改名之前就断了。
    put(
        &root.join("projects/P8/project.sqlite"),
        b"torn while creating",
    );
    manifest(&root, "P8", "HHH");
    empty_project(
        &root.join("projects/P9/project.sqlite"),
        "P9",
        "III",
        i64::MAX,
        Some("never restored"),
    );
    manifest(&root, "P9", "III");
    // 进行中的目录里的备份不是项目备份，不登记。
    put(
        &root.join(
            "projects/.creating-P5/backups/pre-migration-v14-2026-09-01T00-00-00-000Z.sqlite",
        ),
        b"creating backup",
    );
    put(
        &root.join(format!("projects/P1/project.sqlite.restore-old-{RA}")),
        b"stale",
    );

    // 知识库：未提交的恢复。before-restore 是一个真正的知识库，内容与现库不同。
    let before = root.join(format!("backups/knowledge/before-restore-{KJ}.sqlite"));
    let k = legacy(&before, "knowledge");
    k.execute_batch(
        "INSERT INTO knowledge_meta (singleton, database_id, generation, sequence) VALUES (1, 'KDB', 'KG0', 1);
         INSERT INTO knowledge_entries (id, slug, head_revision, version, archived) VALUES ('K9', 'before', 1, 1, 0);
         INSERT INTO knowledge_revisions (entry_id, revision, revision_id, snapshot) VALUES
           ('K9', 1, 'K9-R1', '{\"title\":\"Before restore\",\"aliases\":[],\"tags\":[],\"summary\":\"\",\"useWhen\":\"\",\"appliesTo\":[],\"bodyMarkdown\":\"b\"}');
         INSERT INTO knowledge_fts (entry_id, metadata, title, aliases, tags, summary, use_when, applies_to, body) VALUES
           ('K9', '{\"id\":\"K9\"}', 'Before restore', '', '', '', '', '', 'b');",
    )
    .unwrap();
    drop(k);
    put(
        &root.join("knowledge/restore.json"),
        format!("{{\"id\":\"{KJ}\",\"committed\":false}}").as_bytes(),
    );
    put(
        &root.join(format!("knowledge/restore-{KJ}.sqlite")),
        b"candidate",
    );
    put(
        &root.join(format!("knowledge/restore-{KC}.sqlite")),
        b"orphan candidate",
    );
    put(
        &root.join(format!("knowledge/.restore-{KJ}/knowledge.sqlite")),
        b"staging",
    );
    // 备份目录里没提交完的件：2.0 启动时清掉，这里只计入 X7，不登记（05 §4.1）。
    put(
        &root.join("backups/registry/pre-migration-v7-2026-08-02T00-00-00-000Z.sqlite.pending"),
        b"p",
    );
    put(&root.join("backups/knowledge/x.sqlite.tmp"), b"t");
    put(
        &root.join("projects/P1/backups/y.sqlite.delete-pending"),
        b"d",
    );
    let f = Fixture {
        dir: root.parent().unwrap().to_path_buf(),
        sources: LegacySources::from_root(&root).unwrap(),
    };
    (f, root)
}

/// W3b6：在工作副本上照做 2.0 的启动恢复。CREATING 有健康的库 → ACTIVE（manifest 缺失只记信息项），
/// 没有 → TRASHED 且无数据；RESTORING 取最新的健康回滚件；MIGRATION_FAILED 补迁移后 ACTIVE 并追加全局事件；
/// 知识库未提交的恢复以 before-restore 为现库，孤儿候选件登记成备份。数据根一个字节都不变，独立 VERIFY 重做一遍结果相同。
#[test]
fn in_flight_transactions_are_settled_like_2x_startup() {
    let (f, root) = settle_fixture("legacy-settle");
    let before = tree(&root);
    let report = f
        .convert_with(Some(secrets_ok))
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(report.failures().is_empty(), "{:?}", report.failures());
    assert_eq!(tree(&root), before, "the data root is untouched");
    assert!(report.pending().is_empty(), "{:?}", report.pending());
    let settled: Vec<String> = report
        .settlements
        .iter()
        .map(|s| format!("{}: {} -> {}", s.scope, s.was, s.now))
        .collect();
    assert_eq!(
        settled,
        [
            "k: RESTORING -> ROLLED_BACK",
            "P4: CREATING -> ACTIVE",
            "P5: CREATING -> TRASHED",
            "P6: RESTORING -> ACTIVE",
            "P8: CREATING -> TRASHED",
            "P9: RESTORING -> ACTIVE",
            "P7: MIGRATION_FAILED -> ACTIVE",
        ]
    );
    notes_contain(
        &report,
        "P4/manifest.json: missing; the creation was interrupted after the rename (2.0 writes it afterwards)",
    );

    let t = Connection::open(f.target()).unwrap();
    assert_eq!(
        q::<String>(
            &t,
            "SELECT group_concat(id || ':' || lifecycle, ' ') FROM (SELECT id, lifecycle FROM projects WHERE id >= 'P4' ORDER BY id)"
        ),
        "P4:ACTIVE P5:TRASHED P6:ACTIVE P7:ACTIVE P8:TRASHED P9:ACTIVE"
    );
    // P5 只有 registry 那一行，没有项目数据。
    assert_eq!(
        q::<i64>(
            &t,
            "SELECT (SELECT count(*) FROM objectives WHERE project_id = 'P5') + (SELECT count(*) FROM counters WHERE project_id = 'P5')"
        ),
        0
    );
    assert_eq!(
        q::<String>(&t, "SELECT title FROM objectives WHERE project_id = 'P6'"),
        "rolled back"
    );
    assert_eq!(
        q::<String>(&t, "SELECT title FROM objectives WHERE project_id = 'P7'"),
        "old schema"
    );
    assert_eq!(
        q::<String>(
            &t,
            "SELECT payload_json || ' ' || actor || ' ' || created_at FROM global_feed WHERE type = 'project.migration_recovered' AND aggregate_id = 'P7'"
        ),
        "{\"code\":\"GGG\"} SYSTEM 2026-10-03T00:00:00.000Z"
    );
    assert_eq!(
        q::<String>(&t, "SELECT group_concat(id, ' ') FROM knowledge_entries"),
        "K9"
    );
    let backups: Vec<String> = t
        .prepare("SELECT id FROM legacy_backups ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert!(
        backups.contains(&format!("KNOWLEDGE_ORPHAN:knowledge/restore-{KC}.sqlite")),
        "{backups:?}"
    );
    assert!(!backups.iter().any(|b| b.contains(KJ)), "{backups:?}");
    assert!(
        !backups.iter().any(|b| b.contains(".creating")),
        "{backups:?}"
    );
    assert_eq!(
        q::<String>(&t, "SELECT title FROM objectives WHERE project_id = 'P9'"),
        "never restored"
    );
    assert!(
        !backups
            .iter()
            .any(|b| b.ends_with(".pending") || b.ends_with(".tmp")),
        "{backups:?}"
    );
    assert!(!f.dir.join("out/artifacts/P5").exists());
    // 残留件都记在 X12，不复制。
    // .creating-P5 下两个、P6 三个回滚件、.restore-RB 一个、P1 的陈旧回滚件、知识库的日志、候选件、孤儿与暂存目录。
    assert_eq!(report.source("root/in-flight").unwrap().rows, 11);

    let again = verify_converted(&f.target(), &f.sources, &report).unwrap();
    assert!(again.failures().is_empty(), "{:?}", again.failures());
    assert_eq!(again.settlements, report.settlements);
}

/// W3b6：2.0 自己也恢复不了的残留让转换整体失败并点名，不悄悄跳过；没给数据根时不落定。
#[test]
fn in_flight_transactions_2x_cannot_recover_stop_the_conversion() {
    type Edit = Box<dyn Fn(&Path)>;
    let cases: Vec<(&str, Edit, &str)> = vec![
        (
            "a torn knowledge journal",
            Box::new(|root: &Path| put(&root.join("knowledge/restore.json"), b"{")),
            "knowledge/restore.json is damaged",
        ),
        (
            "a journal id that is not a ULID",
            Box::new(|root: &Path| {
                put(
                    &root.join("knowledge/restore.json"),
                    b"{\"id\":\"../x\",\"committed\":false}",
                )
            }),
            "knowledge/restore.json is damaged",
        ),
        (
            "a journal whose committed is not a boolean",
            Box::new(|root: &Path| {
                put(
                    &root.join("knowledge/restore.json"),
                    format!("{{\"id\":\"{KJ}\",\"committed\":\"no\"}}").as_bytes(),
                )
            }),
            "knowledge/restore.json is damaged",
        ),
        (
            "a failed migration without a database",
            Box::new(|root: &Path| {
                fs::remove_file(root.join("projects/P7/project.sqlite")).unwrap()
            }),
            "project GGG (P7) is MIGRATION_FAILED and 2.0's retry would not recover it: its database is missing",
        ),
        (
            "a failed migration of another project",
            Box::new(|root: &Path| {
                empty_project(
                    &root.join("projects/P7/project.sqlite"),
                    "P7",
                    "XXX",
                    10,
                    None,
                )
            }),
            "project GGG (P7) is MIGRATION_FAILED and 2.0's retry would not recover it: project_meta does not match the registry",
        ),
        (
            "a failed migration with an empty database",
            Box::new(|root: &Path| put(&root.join("projects/P7/project.sqlite"), b"")),
            "project GGG (P7) is MIGRATION_FAILED and 2.0's retry would not recover it: its database is empty",
        ),
        (
            "a restore with no healthy database at all",
            Box::new(|root: &Path| {
                for r in [RA, RB] {
                    fs::remove_file(
                        root.join(format!("projects/P6/project.sqlite.restore-old-{r}")),
                    )
                    .unwrap()
                }
            }),
            "project FFF (P6) is MIGRATION_FAILED and 2.0's retry would not recover it",
        ),
        (
            "a rollback with a WAL 2.0 would leave behind",
            Box::new(|root: &Path| {
                put(
                    &root.join(format!("projects/P6/project.sqlite.restore-old-{RB}-wal")),
                    b"wal",
                )
            }),
            "has a WAL that 2.0's recovery would leave behind",
        ),
    ];
    for (name, edit, expected) in cases {
        let (f, root) = settle_fixture("legacy-settle-refused");
        edit(&root);
        // 改动之后重新按数据根取源，与真实流程一样。
        let outcome = LegacySources::from_root(&root).and_then(|sources| {
            Fixture {
                sources,
                dir: f.dir.clone(),
            }
            .convert_with(Some(secrets_ok))
        });
        match outcome {
            Err(ConvertError::Unsupported(m)) => assert!(m.contains(expected), "{name}: {m}"),
            other => panic!("{name}: {other:?}"),
        }
        assert!(!f.target().exists(), "{name}: nothing is written");
    }

    // 没给数据根：看不到回滚件和日志，进行中的生命周期照旧拒绝。
    let (f, root) = settle_fixture("legacy-settle-no-root");
    let sources = LegacySources {
        root: None,
        projects: f
            .sources
            .projects
            .iter()
            .filter(|p| {
                ["P1", "P2", "P3"]
                    .iter()
                    .any(|id| p.starts_with(root.join("projects").join(id)))
            })
            .cloned()
            .collect(),
        ..f.sources.clone()
    };
    let f = Fixture { sources, ..f };
    match f.convert() {
        Err(ConvertError::Unsupported(m)) => {
            assert!(m.contains("in-flight lifecycles need the data root"), "{m}")
        }
        other => panic!("{other:?}"),
    }
}

/// W3b6：2.0 也救不回来的项目，只有用户点名（`accept_unconvertible`）才舍弃：进回收站、没有数据，
/// 原库登记成 `UNCONVERTIBLE_PROJECT`，不追加恢复事件。不点名照旧停；点名的码对不上任何 MIGRATION_FAILED 项目也停。
#[test]
fn an_unconvertible_project_is_dropped_only_when_the_user_names_it() {
    let (f, root) = settle_fixture("legacy-settle-accept");
    let p7 = root.join("projects/P7/project.sqlite");
    empty_project(&p7, "P7", "XXX", 10, None);
    let f = Fixture {
        sources: LegacySources::from_root(&root).unwrap(),
        ..f
    };
    match f.convert_with(Some(secrets_ok)) {
        Err(ConvertError::Unsupported(m)) => {
            assert!(m.contains("project GGG (P7) is MIGRATION_FAILED"), "{m}")
        }
        other => panic!("{other:?}"),
    }
    match f.convert_accepting(Some(secrets_ok), &["GGG", "ZZZ"]) {
        Err(ConvertError::Unsupported(m)) => assert!(
            m.contains("--accept-unconvertible ZZZ: no project with that code is MIGRATION_FAILED"),
            "{m}"
        ),
        other => panic!("{other:?}"),
    }
    assert!(!f.target().exists());

    let report = f
        .convert_accepting(Some(secrets_ok), &["GGG"])
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(report.failures().is_empty(), "{:?}", report.failures());
    assert!(
        report
            .settlements
            .iter()
            .any(|s| s.scope == "P7" && s.was == "MIGRATION_FAILED" && s.now == "TRASHED"),
        "{:?}",
        report.settlements
    );
    let t = Connection::open(f.target()).unwrap();
    assert_eq!(
        q::<String>(&t, "SELECT lifecycle FROM projects WHERE id = 'P7'"),
        "TRASHED"
    );
    assert_eq!(
        q::<i64>(
            &t,
            "SELECT (SELECT count(*) FROM objectives WHERE project_id = 'P7')
                  + (SELECT count(*) FROM global_feed WHERE type = 'project.migration_recovered')"
        ),
        0
    );
    assert_eq!(
        q::<String>(
            &t,
            "SELECT source || ' ' || scope || ' ' || project_id || ' ' || sha256 || ' ' || importable
             FROM legacy_backups WHERE id = 'UNCONVERTIBLE_PROJECT:projects/P7/project.sqlite'"
        ),
        format!("UNCONVERTIBLE_PROJECT PROJECT P7 {} AS_PROJECT", sha_of(&p7))
    );
    let again = verify_converted(&f.target(), &f.sources, &report).unwrap();
    assert!(again.failures().is_empty(), "{:?}", again.failures());
    assert_eq!(again.settlements, report.settlements);
}

/// W3b6：已提交的知识恢复以现库为准，before-restore 照常登记成备份，候选件丢弃。
#[test]
fn a_committed_knowledge_restore_keeps_the_live_database() {
    let (f, root) = settle_fixture("legacy-settle-committed");
    put(
        &root.join("knowledge/restore.json"),
        format!("{{\"id\":\"{KJ}\",\"committed\":true}}").as_bytes(),
    );
    let f = Fixture {
        sources: LegacySources::from_root(&root).unwrap(),
        ..f
    };
    let report = f
        .convert_with(Some(secrets_ok))
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(report.failures().is_empty(), "{:?}", report.failures());
    assert_eq!(
        (
            report.settlements[0].scope.as_str(),
            report.settlements[0].now.as_str()
        ),
        ("k", "COMMITTED")
    );
    let t = Connection::open(f.target()).unwrap();
    assert_eq!(
        q::<String>(&t, "SELECT group_concat(id, ' ') FROM knowledge_entries"),
        "K1"
    );
    assert_eq!(
        q::<i64>(
            &t,
            &format!(
                "SELECT count(*) FROM legacy_backups
                 WHERE id = 'KNOWLEDGE_BEFORE_RESTORE:backups/knowledge/before-restore-{KJ}.sqlite'"
            )
        ),
        1
    );
}

// ---------------------------------------------------------------- W3c：business_digest 与报告

fn digest_of(f: &Fixture, root: &Path) -> BTreeMap<String, String> {
    let sources = LegacySources::from_root(root).unwrap();
    business_digest(
        &sources,
        &f.dir.join("scratch"),
        &ConvertOptions {
            at: "2026-10-03T00:00:00.000Z",
            allow_real_data_root: false,
            real_data_root: None,
            generation: None,
            secrets_check: Some(secrets_ok),
            accept_unconvertible: &[],
            origin_root: None,
            progress: None,
        },
    )
    .unwrap_or_else(|e| panic!("{e}"))
}

fn changed(a: &BTreeMap<String, String>, b: &BTreeMap<String, String>) -> Vec<String> {
    a.keys()
        .chain(b.keys().filter(|k| !a.contains_key(*k)))
        .filter(|k| a.get(*k) != b.get(*k))
        .cloned()
        .collect()
}

/// W3c（05 §5.1、07 §6）：业务摘要只看业务内容。VACUUM、换成 WAL 并留着没合并的 -wal / -shm、
/// 只动空白的 JSON、R / X 类文件的变化都不改摘要；改一行、改一个配置值、改附件的一个字节，恰好对应的族变。
/// 摘要覆盖族表里纳入的每个族实例，scratch 用完就删。
#[test]
fn business_digest_ignores_storage_and_follows_business_changes() {
    let (f, root) = json_fixture("legacy-business-digest");
    let base = digest_of(&f, &root);
    assert!(
        !f.dir.join("scratch/business-digest").exists(),
        "scratch is cleaned up"
    );
    for family in [
        "r/projects",
        "k/knowledge_entries",
        "P1/work_items",
        "P1/artifacts.files",
        "P1/manifest.json",
        "root/sync.config",
        "root/sync.secrets",
        "root/dispatch.runs",
        "root/dispatch.requests",
        "root/dispatch.logs.final",
    ] {
        assert!(base.contains_key(family), "{family}: {:?}", base.keys());
    }
    for excluded in [
        "root/logs",
        "root/backups",
        "root/dispatch.logs.running",
        "P1/search_documents",
    ] {
        assert!(!base.contains_key(excluded), "{excluded}");
    }
    // 与转换 VERIFY 记下的是同一份。
    let report = f.convert_with(Some(secrets_ok)).unwrap();
    assert_eq!(report.business_digest(), base);

    // 存储层面的变化：VACUUM 两个库；P1 换成 WAL，建一张表再删掉（页写进 WAL、内容不变），连接不关（-wal / -shm 留在盘上）。
    for db in ["registry/registry.sqlite", "projects/P2/project.sqlite"] {
        Connection::open(root.join(db))
            .unwrap()
            .execute_batch("VACUUM")
            .unwrap();
    }
    let p1 = Connection::open(root.join("projects/P1/project.sqlite")).unwrap();
    p1.execute_batch(
        "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
         CREATE TABLE scratch_pages (a); DROP TABLE scratch_pages;",
    )
    .unwrap();
    std::mem::forget(p1);
    assert!(root.join("projects/P1/project.sqlite-wal").exists());
    let config = fs::read_to_string(root.join("dispatch/config.json")).unwrap();
    put(
        &root.join("dispatch/config.json"),
        format!("  {config}\n").as_bytes(),
    );
    put(&root.join("logs/host.log"), b"another line\n");
    assert_eq!(changed(&base, &digest_of(&f, &root)), Vec::<String>::new());

    // 业务变化：每一处恰好让对应的族变。
    Connection::open(root.join("projects/P2/project.sqlite"))
        .unwrap()
        .execute_batch("UPDATE objectives SET title = 'renamed' WHERE id = 'OBJ'")
        .unwrap();
    put(
        &root.join("dispatch/config.json"),
        DISPATCH_CONFIG
            .replace("\"maxConcurrent\":2", "\"maxConcurrent\":3")
            .as_bytes(),
    );
    put(&root.join("projects/P1/artifacts/notes.txt"), b"abd");
    assert_eq!(
        changed(&base, &digest_of(&f, &root)),
        [
            "P1/artifacts.files",
            "P2/objectives",
            "root/dispatch.config"
        ]
    );
}

/// W3c（05 §3.4、07 §3）：report.json 只有表名、主键、计数与摘要。密文、配置里的地址、正文、超大 payload 都不出现；
/// 正文只在单独存放的附件里。
#[test]
fn the_report_carries_no_credentials_or_bodies() {
    let (f, _) = json_fixture("legacy-report-secrets");
    let report = f.convert_with(Some(secrets_ok)).unwrap();
    let json = report.report_json();
    for leak in [
        "AQAAANCMnd8BFdERjHoAwE",
        "relay.example",
        "旧库里的",
        "shared title words",
        "xxxxxxxxxxxxxxxx",
        "书房电脑",
    ] {
        assert!(!json.contains(leak), "{leak} leaked into report.json");
        assert!(
            !report.notes.iter().any(|n| n.contains(leak)),
            "{leak} leaked into a note"
        );
    }
}

// ---------------------------------------------------------------- W3d：转换状态机

/// W3d（07 §1–§5）：SNAPSHOT → IMPORT / VERIFY → PUBLISHING → PUBLISHED，启动判定 S1–S6，封存与隔离。
mod w3d {
    use super::*;
    use atm_store::conversion::{
        self as cv, AdmitError, Authority, AuthorityState, Layout, Manifest, ManifestState, Phase,
        Quiesce, RunOptions, Seal, SealStep, Startup, Step,
    };

    pub(super) const G1: &str = "01J000000000000000000GEN01";
    pub(super) const G2: &str = "01J000000000000000000GEN02";

    pub(super) fn layout(f: &Fixture, name: &str) -> Layout {
        let n = f.dir.join(name);
        let _ = fs::remove_dir_all(&n);
        Layout::new(n)
    }

    pub(super) fn run(
        layout: &Layout,
        root: &Path,
        g: &str,
        stop: Option<Step>,
    ) -> cv::Result<Manifest> {
        let mut hook = |s: Step| Some(s) != stop;
        cv::run(
            layout,
            RunOptions {
                at: AT,
                generation: g,
                legacy_root: root,
                allow_real_data_root: false,
                real_data_root: None,
                secrets_check: Some(secrets_ok),
                accept_unconvertible: &[],
                hook: &mut hook,
                progress: None,
            },
        )
    }

    fn generation_of(db: &Path) -> String {
        q(
            &Connection::open(db).unwrap(),
            "SELECT generation FROM app_meta",
        )
    }

    pub(super) fn manifest(layout: &Layout) -> Manifest {
        match cv::read_manifest(layout) {
            ManifestState::Present(m) => m,
            other => panic!("{other:?}"),
        }
    }

    /// 快照只装业务文件：备份、R / X 类、运行中的日志都不进；在快照上转换的结果与直接在数据根上转换一致，
    /// 登记的路径仍指向数据根；发布后 `M`、`A`、发布物齐全，源副本删掉，数据根一个字节都不变。
    #[test]
    fn a_snapshot_conversion_publishes_and_leaves_the_2x_root_untouched() {
        let (f, root) = json_fixture("w3d-publish");
        let before = tree(&root);
        let n = layout(&f, "n");
        let admission = cv::admit(&n, || Quiesce::Quiet).unwrap();
        assert_eq!(cv::decide(&n, true), Startup::FirstConversion);
        assert_eq!(cv::decide(&n, false), Startup::FreshInstall);

        let files = atm_store::legacy::snapshot_files(&root, AT).unwrap();
        for kept in [
            "registry/registry.sqlite",
            "knowledge/knowledge.sqlite",
            "projects/P1/project.sqlite",
            "projects/P1/manifest.json",
            "projects/P1/artifacts/notes.txt",
            "sync/config.json",
            "sync/secrets.dpapi.json",
            "dispatch/runs.json",
            "dispatch/logs/run-ok.jsonl",
            "dispatch/logs/ghost.stderr.log",
            &format!("backups/knowledge/before-restore-{KB}.sqlite"),
        ] {
            assert_eq!(
                files.contains(&kept.to_string()),
                !kept.starts_with("backups/"),
                "{kept}: {files:?}"
            );
        }
        for f in &files {
            assert!(
                !f.contains("/backups/")
                    && !f.starts_with("backups/")
                    && !f.starts_with("exports/")
                    && !f.starts_with("logs/")
                    && !f.starts_with("runtime/")
                    && f != "sync/secrets.json"
                    && f != "sync/config.corrupt.json"
                    && f != "dispatch/logs/run-live.jsonl",
                "{f} must not be in the snapshot"
            );
        }

        let m = run(&n, &root, G1, None).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(m.phase, Phase::Published);
        assert_eq!(m.generation, G1);
        assert_eq!(
            m.source_root.as_deref(),
            Some(root.to_string_lossy().as_ref())
        );
        assert_eq!(
            m.source_files
                .iter()
                .map(|f| f.rel.clone())
                .collect::<Vec<_>>(),
            files
        );
        assert_eq!(manifest(&n), m);
        assert_eq!(generation_of(&n.database()), G1);
        assert!(n.data().join("artifacts/P1/notes.txt").is_file());
        assert!(n.data().join("dispatch/logs/run-ok.jsonl").is_file());
        assert!(!n.data().join("dispatch/logs/run-live.jsonl").exists());
        match cv::read_authority(&n) {
            AuthorityState::Present(a) => {
                assert_eq!((a.authority.as_str(), a.by.as_str()), ("v3", "publish"));
                assert_eq!(a.generation.as_deref(), Some(G1));
            }
            other => panic!("{other:?}"),
        }
        let staging = n.staging(G1);
        assert!(
            !staging.join("src").exists(),
            "the source copy is removed after PUBLISHED"
        );
        assert_eq!(Some(sha_of(&staging.join("report.json"))), m.verify_digest);
        assert_eq!(cv::decide(&n, true), Startup::Published(m.clone()));
        assert_eq!(tree(&root), before, "the 2.x data root changed");

        // 直接在数据根上转换：报告一致（R / X 类计数、运行中日志的数量、登记路径都按数据根算）。
        let direct = f
            .convert_with(Some(secrets_ok))
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(direct.business_digest(), m.business_digest);
        assert_eq!(
            fs::read_to_string(staging.join("report.json")).unwrap(),
            direct.report_json()
        );
        assert_eq!(
            fs::read_to_string(staging.join("attachment.jsonl")).unwrap(),
            direct.attachment_jsonl()
        );
        let published = Connection::open(n.database()).unwrap();
        let reference = Connection::open(f.target()).unwrap();
        for sql in [
            "SELECT group_concat(id || '=' || local_path, ';') FROM (SELECT * FROM artifacts ORDER BY project_id, id)",
            "SELECT group_concat(legacy_path || '=' || source, ';') FROM (SELECT * FROM legacy_backups ORDER BY legacy_path)",
            "SELECT group_concat(run || '=' || log_root, ';') FROM (SELECT * FROM dispatch_runs ORDER BY run)",
        ] {
            let got: Option<String> = q(&published, sql);
            assert_eq!(got, q::<Option<String>>(&reference, sql), "{sql}");
        }
        drop(admission);
    }

    /// 每个阶段被杀之后：SNAPSHOT / IMPORT / VERIFY 与改名之前按 S3 丢弃重来，改名之后按 S4 补完；
    /// 最后都落到同一份业务内容，数据根不变。
    #[test]
    fn every_interruption_resumes_to_the_same_publication() {
        let (f, root) = json_fixture("w3d-resume");
        let before = tree(&root);
        let reference = run(&layout(&f, "n-ref"), &root, G1, None)
            .unwrap()
            .business_digest;
        for (i, step) in [
            Step::SnapshotCopied,
            Step::Importing,
            Step::Verified,
            Step::BeforeRename,
            Step::Renamed,
        ]
        .into_iter()
        .enumerate()
        {
            let n = layout(&f, &format!("n-{i}"));
            match run(&n, &root, G1, Some(step)) {
                Err(cv::Error::Interrupted(_)) => {}
                other => panic!("{step:?}: {other:?}"),
            }
            let m = match cv::decide(&n, true) {
                Startup::Restart { generation } if step != Step::Renamed => {
                    assert_eq!(generation, G1);
                    assert!(!n.data().exists(), "{step:?}: nothing may be published yet");
                    cv::discard_attempt(&n, &generation)
                        .unwrap_or_else(|e| panic!("{step:?}: {e:?}"));
                    assert!(!n.staging(G1).exists());
                    assert_eq!(cv::decide(&n, true), Startup::FirstConversion);
                    run(&n, &root, G2, None).unwrap_or_else(|e| panic!("{step:?}: {e:?}"))
                }
                Startup::FinishPublishing { generation } if step == Step::Renamed => {
                    assert_eq!(generation, G1);
                    assert_eq!(cv::read_authority(&n), AuthorityState::Missing);
                    cv::finish_publishing(&n, AT).unwrap_or_else(|e| panic!("{step:?}: {e:?}"))
                }
                other => panic!("{step:?}: {other:?}"),
            };
            assert_eq!(m.business_digest, reference, "{step:?}");
            assert_eq!(
                cv::decide(&n, true),
                Startup::Published(m.clone()),
                "{step:?}"
            );
            assert_eq!(generation_of(&n.database()), m.generation);
            assert!(
                matches!(cv::read_authority(&n), AuthorityState::Present(a) if a.generation.as_deref() == Some(m.generation.as_str()))
            );
        }
        assert_eq!(tree(&root), before);
    }

    /// SNAPSHOT 期间源变了（改了内容、多了文件）：这次尝试记 FAILED 与原因，不发布；下次按 S3 重来。
    #[test]
    fn a_source_that_changes_during_snapshot_fails_the_attempt() {
        let (f, root) = json_fixture("w3d-unquiet");
        // 源里的文件改了、源里多了文件、复制出来的副本与源不一致。
        for (i, (in_copy, rel)) in [
            (false, "projects/P1/artifacts/notes.txt"),
            (false, "projects/P1/artifacts/new.txt"),
            (true, "projects/P1/manifest.json"),
        ]
        .into_iter()
        .enumerate()
        {
            let n = layout(&f, &format!("n-{i}"));
            let change = if in_copy {
                n.staging(G1).join("src").join(rel)
            } else {
                root.join(rel)
            };
            let mut hook = |s: Step| {
                if s == Step::SnapshotCopied {
                    fs::write(&change, b"changed while copying").unwrap();
                }
                true
            };
            let r = cv::run(
                &n,
                RunOptions {
                    at: AT,
                    generation: G1,
                    legacy_root: &root,
                    allow_real_data_root: false,
                    real_data_root: None,
                    secrets_check: Some(secrets_ok),
                    accept_unconvertible: &[],
                    hook: &mut hook,
                    progress: None,
                },
            );
            assert!(matches!(r, Err(cv::Error::SourceNotQuiet(_))), "{r:?}");
            let m = manifest(&n);
            assert_eq!(m.phase, Phase::Failed);
            assert!(
                m.failure.as_deref().is_some_and(|w| w.contains("SNAPSHOT")),
                "{:?}",
                m.failure
            );
            assert!(!n.data().exists());
            assert_eq!(
                cv::decide(&n, true),
                Startup::Restart {
                    generation: G1.into()
                }
            );
        }
    }

    /// SNAPSHOT 之后数据根再变也不影响这一次：转换读的是快照，不是数据根。
    #[test]
    fn the_conversion_reads_the_snapshot_not_the_live_root() {
        let (f, root) = json_fixture("w3d-late");
        let n = layout(&f, "n");
        let notes = root.join("projects/P1/artifacts/notes.txt");
        let mut hook = |s: Step| {
            if s == Step::Importing {
                fs::write(&notes, b"written after the snapshot").unwrap();
            }
            true
        };
        let m = cv::run(
            &n,
            RunOptions {
                at: AT,
                generation: G1,
                legacy_root: &root,
                allow_real_data_root: false,
                real_data_root: None,
                secrets_check: Some(secrets_ok),
                accept_unconvertible: &[],
                hook: &mut hook,
                progress: None,
            },
        )
        .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(m.phase, Phase::Published);
        assert_eq!(
            fs::read(n.data().join("artifacts/P1/notes.txt")).unwrap(),
            b"abc"
        );
    }

    /// 发布物不可信时整体隔离：`M` 缺失或损坏（S5）、generation 对不上、PUBLISHING 时文件被动过、
    /// 还没到 PUBLISHING 就有发布物。发布之后服务写进来的新附件不算（S6 只认 generation）。
    #[test]
    fn untrusted_publications_are_quarantined() {
        let (f, root) = json_fixture("w3d-untrusted");
        let n = layout(&f, "n");
        let m = run(&n, &root, G1, None).unwrap();
        let rewrite = |change: &dyn Fn(&mut Manifest)| {
            let mut x = m.clone();
            change(&mut x);
            cv::write_manifest(&n, &x).unwrap();
        };
        let quarantined = |why: &str| match cv::decide(&n, true) {
            Startup::Quarantine { reason } => assert!(reason.contains(why), "{reason}"),
            other => panic!("{why}: {other:?}"),
        };

        // 服务往发布物里写了东西：照常 S6。
        put(&n.data().join("artifacts/P1/written-by-3.0.txt"), b"new");
        assert_eq!(cv::decide(&n, true), Startup::Published(m.clone()));
        fs::remove_file(n.data().join("artifacts/P1/written-by-3.0.txt")).unwrap();

        rewrite(&|x| x.generation = "SOMETHING-ELSE".into());
        quarantined("the manifest says SOMETHING-ELSE");
        rewrite(&|x| x.phase = Phase::Verify);
        quarantined("is VERIFY");
        rewrite(&|x| x.phase = Phase::Publishing);
        assert_eq!(
            cv::decide(&n, true),
            Startup::FinishPublishing {
                generation: G1.into()
            }
        );
        // 库旁边冒出别的程序的临时文件（实测见过 `ATM.SQLITE-SHM.tmp`）：不属于发布物，不影响 S4。
        put(&n.data().join("ATM.SQLITE-SHM.tmp"), b"someone else's");
        assert_eq!(
            cv::decide(&n, true),
            Startup::FinishPublishing {
                generation: G1.into()
            }
        );
        fs::remove_file(n.data().join("ATM.SQLITE-SHM.tmp")).unwrap();
        put(&n.data().join("artifacts/P1/notes.txt"), b"tampered");
        quarantined("do not match the manifest");
        cv::write_manifest(&n, &m).unwrap();

        fs::write(n.manifest(), b"{\"schema\":1,").unwrap();
        quarantined("the manifest is corrupt");
        fs::remove_file(n.manifest()).unwrap();
        quarantined("the manifest is missing");

        // S5：整体移走，字节不变；之后按 S2 继续。
        let data = tree(&n.data());
        let target = cv::seal(&n, Seal::Quarantine, AT).unwrap();
        assert_eq!(target.parent().unwrap(), n.root.join("quarantine"));
        assert_eq!(tree(&target.join("data")), data);
        assert!(target.join("authority.json").is_file());
        assert!(!n.data().exists() && !n.manifest().exists() && !n.authority().exists());
        assert_eq!(cv::decide(&n, true), Startup::FirstConversion);
        assert_eq!(cv::decide(&n, false), Startup::FreshInstall);
    }

    /// 封存被杀在任何一步，再调用都按记下的种类与目标续做；目标名撞了换名，目标里已有的东西不覆盖。
    #[test]
    fn sealing_resumes_after_a_kill_and_never_overwrites() {
        let (f, root) = json_fixture("w3d-seal");
        let n = layout(&f, "n");
        run(&n, &root, G1, None).unwrap();
        let data = tree(&n.data());
        let taken = n
            .root
            .join("superseded")
            .join(format!("{G1}-2026-10-03T00-00-00-000Z"));
        put(&taken.join("keep.txt"), b"older");

        match cv::seal_with(&n, Seal::Superseded, AT, &mut |s| s != SealStep::Intended) {
            Err(cv::Error::Interrupted(_)) => {}
            other => panic!("{other:?}"),
        }
        assert_eq!(cv::decide(&n, true), Startup::ResumeSeal);
        let target = n
            .root
            .join("superseded")
            .join(format!("{G1}-2026-10-03T00-00-00-000Z-2"));
        assert!(target.is_dir(), "a taken name gets a suffix");
        put(&target.join("data/already-here.txt"), b"keep me");
        match cv::seal_with(&n, Seal::Quarantine, AT, &mut |s| s != SealStep::Moved) {
            Err(cv::Error::Interrupted(_)) => {}
            other => panic!("{other:?}"),
        }
        assert!(!n.data().exists());
        assert_eq!(cv::decide(&n, true), Startup::ResumeSeal);
        // 续做时种类以意图文件为准（这里传的 Quarantine 不算数）。
        assert_eq!(cv::seal(&n, Seal::Quarantine, AT).unwrap(), target);

        assert_eq!(fs::read(taken.join("keep.txt")).unwrap(), b"older");
        assert_eq!(
            fs::read(target.join("data/already-here.txt")).unwrap(),
            b"keep me"
        );
        assert_eq!(tree(&target.join("data-2")), data);
        let copied =
            Manifest::parse(&fs::read_to_string(target.join("conversion.json")).unwrap()).unwrap();
        assert_eq!(copied.generation, G1);
        assert!(target.join("authority.json").is_file());
        assert!(!n.manifest().exists() && !n.authority().exists());
        assert!(!n.runtime().join("seal.json").exists());
        assert!(!n.root.join("quarantine").exists());
        assert_eq!(cv::decide(&n, true), Startup::FirstConversion);
    }

    /// S1：没有旧根时建空库并直接发布；之后每次启动都是 S6，服务能照常打开。
    #[test]
    fn a_fresh_install_publishes_an_empty_store() {
        let n = Layout::new(dir("w3d-fresh").join("n"));
        assert_eq!(cv::decide(&n, false), Startup::FreshInstall);
        let m = cv::fresh_install(&n, G1, AT).unwrap();
        assert_eq!((m.phase, m.source_root.clone()), (Phase::Published, None));
        assert!(m.source_files.is_empty() && m.business_digest.is_empty());
        assert_eq!(cv::decide(&n, false), Startup::Published(m.clone()));
        assert!(matches!(cv::read_authority(&n), AuthorityState::Present(a)
            if a.authority == "v3" && a.generation.as_deref() == Some(G1)));
        assert!(!n.staging(G1).exists());
        let c = atm_store::open(&n.database()).unwrap();
        assert_eq!(q::<String>(&c, "SELECT generation FROM app_meta"), G1);
        assert_eq!(
            q::<Option<String>>(&c, "SELECT converted_from FROM app_meta"),
            None
        );
        assert_eq!(q::<i64>(&c, "SELECT count(*) FROM projects"), 0);
    }

    /// 准入：同一个新根只有一个实例拿得到；旧版没静止就等，不转换。
    #[test]
    fn admission_is_exclusive_and_waits_for_a_quiet_2x() {
        let (f, _root) = json_fixture("w3d-admit");
        let n = layout(&f, "n");
        let first = cv::admit(&n, || Quiesce::Quiet).unwrap();
        assert!(matches!(
            cv::admit(&n, || Quiesce::Quiet),
            Err(AdmitError::AlreadyRunning)
        ));
        drop(first);
        match cv::admit(&n, || Quiesce::Wait("2.x daemon pid 42".into())) {
            Err(AdmitError::WaitLegacyQuiesce(why)) => assert_eq!(why, "2.x daemon pid 42"),
            other => panic!("{other:?}"),
        }
        assert!(
            cv::admit(&n, || Quiesce::Quiet).is_ok(),
            "waiting releases the lease"
        );
    }

    /// `M` 与 `A` 读写往返；形状不对一律是损坏，不猜缺省值。
    #[test]
    fn manifests_and_authority_round_trip_and_reject_damage() {
        let m = Manifest {
            converter_version: "atm-store-legacy/1".into(),
            source_root: Some("D:\\data\\AyanamiTaskManager".into()),
            source_files: vec![cv::SourceFile {
                rel: "registry/registry.sqlite".into(),
                size: 4096,
                mtime_ms: 1_790_000_000_000,
                sha256: "ab".repeat(32),
            }],
            business_digest: [("db:registry/projects".to_string(), "cd".repeat(32))].into(),
            accepted_unconvertible: vec!["P9".into()],
            generation: G1.into(),
            phase: Phase::Verify,
            verify_digest: Some("ef".repeat(32)),
            publication_digest: None,
            started_at: AT.into(),
            published_at: None,
            failure: None,
        };
        assert_eq!(Manifest::parse(&m.to_json()), Some(m.clone()));
        let json = m.to_json();
        for bad in [
            json.replace("\"VERIFY\"", "\"DONE\""),
            json.replace("\"schema\":1", "\"schema\":2"),
            json.replace("\"generation\"", "\"gen\""),
            json.replace("4096", "4096.5"),
            json.replace("[\"P9\"]", "[9]"),
            json[..json.len() - 1].to_string(),
            String::new(),
        ] {
            assert_eq!(Manifest::parse(&bad), None, "{bad}");
        }
        let a = Authority {
            authority: "v3".into(),
            by: "publish".into(),
            txn: None,
            at: AT.into(),
            generation: Some(G1.into()),
            accepted_source_digest: Some([("r/projects".to_string(), "ab".to_string())].into()),
        };
        assert_eq!(Authority::parse(&a.to_json()), Some(a.clone()));
        assert_eq!(
            Authority::parse(&a.to_json().replace("\"v3\"", "\"v4\"")),
            None
        );
        assert_eq!(
            Authority::parse(&a.to_json().replace("\"by\"", "\"who\"")),
            None
        );
    }
}

// ---------------------------------------------------------------- W3e：权威判定与数据源冲突

/// W3e（07 §6–§7）：对 2.x 重算 business_digest' 比较、权威判定表、数据源冲突状态与用户的两个选择。
mod w3e {
    use super::w3d::{G1, G2, layout, manifest, run};
    use super::*;
    use atm_store::conversion::{
        self as cv, Authority, AuthorityState, CompareOptions, Comparison, Layout, Startup, Verdict,
    };

    fn opts(root: &Path) -> CompareOptions<'_> {
        CompareOptions {
            legacy_root: root,
            allow_real_data_root: false,
            real_data_root: None,
            secrets_check: Some(secrets_ok),
        }
    }

    fn authority(n: &Layout) -> Authority {
        match cv::read_authority(n) {
            AuthorityState::Present(a) => a,
            other => panic!("{other:?}"),
        }
    }

    /// 按当前的 `M` 与 `A` 取基准，比较一次。
    fn compare(n: &Layout, root: &Path) -> Comparison {
        let m = manifest(n);
        let a = match cv::read_authority(n) {
            AuthorityState::Present(a) => Some(a),
            _ => None,
        };
        cv::compare(n, &m, cv::baseline(&m, a.as_ref()), &opts(root))
    }

    fn judge(n: &Layout, root: &Path, cmp: &Comparison) -> Verdict {
        cv::judge(&cv::read_authority(n), &manifest(n), root, cmp)
    }

    /// 2.x 在回滚之后写了业务数据。
    fn write_in_2x(root: &Path, description: &str) {
        Connection::open(root.join("registry/registry.sqlite"))
            .unwrap()
            .execute(
                "UPDATE projects SET description = ?1 WHERE id = 'P1'",
                [description],
            )
            .unwrap();
    }

    fn changed(cmp: &Comparison) -> (BTreeMap<String, String>, Vec<String>) {
        match cmp {
            Comparison::Changed { digest, families } => (digest.clone(), families.clone()),
            other => panic!("expected a change: {other:?}"),
        }
    }

    /// 比较只看业务内容：VACUUM、R / X 类文件不算变；改一行业务数据恰好那一族变；未登记的文件说不清；
    /// 数据根整个不在了单独报。比较只读 `L`，不碰发布物，用完的快照删掉。
    #[test]
    fn compare_tells_unchanged_changed_unknown_and_gone_apart() {
        let (f, root) = json_fixture("w3e-compare");
        let n = layout(&f, "n");
        let m = run(&n, &root, G1, None).unwrap();
        let published = tree(&n.data());

        assert_eq!(
            compare(&n, &root),
            Comparison::Unchanged(m.business_digest.clone())
        );
        Connection::open(root.join("registry/registry.sqlite"))
            .unwrap()
            .execute_batch("VACUUM;")
            .unwrap();
        put(&root.join("logs/another.log"), b"more log");
        assert_eq!(
            compare(&n, &root),
            Comparison::Unchanged(m.business_digest.clone())
        );

        let before = tree(&root);
        write_in_2x(&root, "edited in 2.x");
        let (digest, families) = changed(&compare(&n, &root));
        assert_eq!(families, vec!["r/projects".to_string()], "{families:?}");
        assert_ne!(
            digest.get("r/projects"),
            m.business_digest.get("r/projects")
        );
        assert_ne!(tree(&root), before);
        let after = tree(&root);
        // 每次比较完立刻看：下一次比较开头会先清一遍，留到最后看就看不出来。
        assert!(
            !n.runtime().join("compare").exists(),
            "the comparison snapshot is left behind"
        );

        put(&root.join("unexpected.txt"), b"?");
        match compare(&n, &root) {
            Comparison::Unknown(why) => assert!(why.contains("unexpected.txt"), "{why}"),
            other => panic!("{other:?}"),
        }
        fs::remove_file(root.join("unexpected.txt")).unwrap();
        assert_eq!(compare(&n, &root.join("not-there")), Comparison::LegacyGone);

        assert_eq!(tree(&root), after, "comparing wrote into the 2.x root");
        assert_eq!(
            tree(&n.data()),
            published,
            "comparing touched the publication"
        );
    }

    /// 转换时用户点名舍弃了不可转换的项目：清单记下名单，重算比较时照样传，同一个源比出来是「不变」。
    #[test]
    fn a_conversion_that_dropped_a_project_compares_unchanged() {
        let (f, root) = settle_fixture("w3e-accepted");
        empty_project(
            &root.join("projects/P7/project.sqlite"),
            "P7",
            "XXX",
            10,
            None,
        );
        let n = layout(&f, "n");
        let m = cv::run(
            &n,
            cv::RunOptions {
                at: AT,
                generation: G1,
                legacy_root: &root,
                allow_real_data_root: false,
                real_data_root: None,
                secrets_check: Some(secrets_ok),
                accept_unconvertible: &["GGG"],
                hook: &mut |_| true,
                progress: None,
            },
        )
        .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(m.accepted_unconvertible, vec!["GGG".to_string()]);
        assert_eq!(manifest(&n), m);
        assert_eq!(
            compare(&n, &root),
            Comparison::Unchanged(m.business_digest.clone())
        );
    }

    /// 07 §6 判定表的每一格，加上 B3 的四种「对不上」，以及阻塞比较的条件。
    #[test]
    fn the_authority_table_has_a_case_for_every_cell() {
        let (f, root) = json_fixture("w3e-table");
        let n = layout(&f, "n");
        let m = run(&n, &root, G1, None).unwrap();
        let v3 = authority(&n);
        let legacy = cv::rollback_authority(Some(&v3), &m, "txn-1", AT);
        let unchanged = Comparison::Unchanged(m.business_digest.clone());
        let changed = Comparison::Changed {
            digest: BTreeMap::new(),
            families: vec!["r/projects".into()],
        };
        let unknown = Comparison::Unknown("data root: unregistered entry x".into());
        let present = |a: &Authority| AuthorityState::Present(a.clone());
        let verdict = |a: &AuthorityState, cmp: &Comparison| cv::judge(a, &m, &root, cmp);
        let conflict = |v: Verdict, why: &str| match v {
            Verdict::Conflict(reason) => assert!(reason.contains(why), "{reason}"),
            other => panic!("{why}: {other:?}"),
        };

        assert_eq!(verdict(&present(&v3), &unchanged), Verdict::Serve);
        assert_eq!(
            verdict(&present(&v3), &Comparison::LegacyGone),
            Verdict::Serve
        );
        conflict(verdict(&present(&v3), &changed), "r/projects");
        // UNKNOWN 没有可接受的东西：不管之前接受过什么，v3 遇到 UNKNOWN 一律冲突（W3 peer r1 P1-01）。
        conflict(verdict(&present(&v3), &unknown), "unregistered entry x");

        assert_eq!(
            verdict(&present(&legacy), &unchanged),
            Verdict::ResumeAfterRollback
        );
        assert_eq!(verdict(&present(&legacy), &changed), Verdict::Reconvert);
        conflict(verdict(&present(&legacy), &unknown), "unregistered entry x");
        conflict(verdict(&present(&legacy), &Comparison::LegacyGone), "gone");

        // B3：不猜，一律冲突——即便比较结果是不变。
        conflict(verdict(&AuthorityState::Missing, &unchanged), "missing");
        conflict(verdict(&AuthorityState::Corrupt, &unchanged), "corrupt");
        let other_generation = Authority {
            generation: Some(G2.into()),
            ..v3.clone()
        };
        conflict(verdict(&present(&other_generation), &unchanged), G2);
        conflict(
            cv::judge(&present(&v3), &m, &root.join("elsewhere"), &unchanged),
            "was converted from",
        );
        let shouting = PathBuf::from(root.to_string_lossy().to_uppercase().replace('\\', "/"));
        assert_eq!(
            cv::judge(&present(&v3), &m, &shouting, &unchanged),
            Verdict::Serve
        );

        assert!(!cv::must_compare_before_serving(&present(&v3), &m));
        assert!(cv::must_compare_before_serving(&present(&legacy), &m));
        assert!(cv::must_compare_before_serving(
            &AuthorityState::Missing,
            &m
        ));
        assert!(cv::must_compare_before_serving(
            &AuthorityState::Corrupt,
            &m
        ));
        assert!(cv::must_compare_before_serving(
            &present(&other_generation),
            &m
        ));
    }

    /// 回滚到 2.x（setup 写 `A=legacy`）之后再升级：没在 2.x 写过就无损接回 3.0；写过就以 2.x 为准，
    /// 封存当前 generation、重新转换，新库里是 2.x 写过的内容。
    #[test]
    fn after_a_rollback_3_0_resumes_or_reconverts() {
        let (f, root) = json_fixture("w3e-rollback");
        let n = layout(&f, "n");
        let m = run(&n, &root, G1, None).unwrap();
        cv::write_authority(
            &n,
            &cv::rollback_authority(Some(&authority(&n)), &m, "txn-1", AT),
        )
        .unwrap();
        assert!(cv::must_compare_before_serving(&cv::read_authority(&n), &m));
        let cmp = compare(&n, &root);
        assert_eq!(judge(&n, &root, &cmp), Verdict::ResumeAfterRollback);
        let a = cv::resume_after_rollback(&n, &authority(&n), T2).unwrap();
        assert_eq!(
            (a.authority.as_str(), a.by.as_str()),
            ("v3", "resume-after-rollback")
        );
        assert_eq!(authority(&n), a);
        assert_eq!(judge(&n, &root, &compare(&n, &root)), Verdict::Serve);
        assert_eq!(cv::decide(&n, true), Startup::Published(m.clone()));

        cv::write_authority(&n, &cv::rollback_authority(Some(&a), &m, "txn-2", AT)).unwrap();
        write_in_2x(&root, "written while 2.x was back");
        let cmp = compare(&n, &root);
        let (digest, _) = changed(&cmp);
        assert_eq!(judge(&n, &root, &cmp), Verdict::Reconvert);
        let sealed = cv::choose_legacy(&n, T2).unwrap();
        assert_eq!(sealed.parent().unwrap(), n.root.join("superseded"));
        assert!(sealed.join("data/atm.sqlite").is_file());
        assert_eq!(cv::decide(&n, true), Startup::FirstConversion);
        let m2 = run(&n, &root, G2, None).unwrap();
        assert_eq!(m2.business_digest, digest);
        let c = Connection::open(n.database()).unwrap();
        assert_eq!(
            q::<String>(&c, "SELECT description FROM projects WHERE id = 'P1'"),
            "written while 2.x was back"
        );
    }

    /// 数据源冲突：启动状态写进 runtime（不含凭据），decide 不再放行这个 generation，发布物与 2.x 都不被写；
    /// 状态坏了也不放行；选「从 2.x 重新转换」后封存、重转，新 generation 正常启动。
    #[test]
    fn a_source_conflict_holds_back_the_service_and_writes_nothing() {
        let (f, root) = json_fixture("w3e-conflict");
        let n = layout(&f, "n");
        let m = run(&n, &root, G1, None).unwrap();
        let published = tree(&n.data());
        write_in_2x(&root, "edited in 2.x");
        let source = tree(&root);

        let cmp = compare(&n, &root);
        let Verdict::Conflict(reason) = judge(&n, &root, &cmp) else {
            panic!("expected a conflict")
        };
        let state = cv::enter_conflict(&n, &m, &reason, AT).unwrap();
        assert_eq!(
            (
                state.state.as_str(),
                state.since.as_str(),
                state.generation.as_str()
            ),
            ("SOURCE_CONFLICT", AT, G1)
        );
        assert_eq!(cv::decide(&n, true), Startup::SourceConflict(state.clone()));
        let text = fs::read_to_string(n.runtime().join("startup-state.json")).unwrap();
        assert!(
            text.contains("SOURCE_CONFLICT") && text.contains("r/projects"),
            "{text}"
        );
        assert!(
            !text.contains("AQAAANCMnd8") && !text.contains("relay-token"),
            "{text}"
        );
        // 再次进入（下一次启动又比出冲突）：since 不变。
        assert_eq!(cv::enter_conflict(&n, &m, &reason, T2).unwrap().since, AT);

        fs::write(n.runtime().join("startup-state.json"), b"{").unwrap();
        match cv::decide(&n, true) {
            Startup::SourceConflict(s) => assert!(s.reason.contains("corrupt"), "{s:?}"),
            other => panic!("a corrupt startup state must not let the service start: {other:?}"),
        }
        assert_eq!(
            tree(&n.data()),
            published,
            "the conflict wrote business data"
        );
        assert_eq!(tree(&root), source, "the conflict wrote into the 2.x root");

        cv::choose_legacy(&n, T2).unwrap();
        assert_eq!(cv::decide(&n, true), Startup::FirstConversion);
        let m2 = run(&n, &root, G2, None).unwrap();
        assert_eq!(cv::decide(&n, true), Startup::Published(m2));
        assert!(cv::read_startup_state(&n).is_none());
    }

    /// 选「沿用 3.0」：`A=v3 by user-choice` 绑定这次算出的摘要，冲突解除；之后 2.x 不动就照常启动
    /// （回滚再接回也一样），2.x 再写就再次识别出来。UNKNOWN 时绑定原因，原因变了照样冲突。
    #[test]
    fn accepting_3_0_binds_the_digest_and_later_2x_writes_are_seen_again() {
        let (f, root) = json_fixture("w3e-accept");
        let n = layout(&f, "n");
        let m = run(&n, &root, G1, None).unwrap();
        write_in_2x(&root, "first 2.x write");
        let cmp = compare(&n, &root);
        let (digest, _) = changed(&cmp);
        let Verdict::Conflict(reason) = judge(&n, &root, &cmp) else {
            panic!("expected a conflict")
        };
        cv::enter_conflict(&n, &m, &reason, AT).unwrap();
        let a = cv::choose_v3(&n, &m, &cmp, T2).unwrap();
        assert_eq!((a.authority.as_str(), a.by.as_str()), ("v3", "user-choice"));
        assert_eq!(a.accepted_source_digest.as_ref(), Some(&digest));
        assert_eq!(authority(&n), a);
        assert_eq!(cv::decide(&n, true), Startup::Published(m.clone()));
        assert_eq!(compare(&n, &root), Comparison::Unchanged(digest.clone()));
        assert_eq!(judge(&n, &root, &compare(&n, &root)), Verdict::Serve);

        // 回滚写的 A=legacy 带着接受的摘要，没动过 2.x 就无损接回。
        cv::write_authority(&n, &cv::rollback_authority(Some(&a), &m, "txn-1", T2)).unwrap();
        assert_eq!(
            judge(&n, &root, &compare(&n, &root)),
            Verdict::ResumeAfterRollback
        );
        let resumed = cv::resume_after_rollback(&n, &authority(&n), T2).unwrap();
        assert_eq!(resumed.accepted_source_digest.as_ref(), Some(&digest));

        write_in_2x(&root, "second 2.x write");
        let (_, families) = changed(&compare(&n, &root));
        assert_eq!(families, vec!["r/projects".to_string()]);
        assert!(matches!(
            judge(&n, &root, &compare(&n, &root)),
            Verdict::Conflict(_)
        ));

        // UNKNOWN：选「沿用 3.0」只放行这一次，沿用同一 generation 下接受过的摘要；同一个原因下次照样冲突。
        put(&root.join("unexpected.txt"), b"?");
        let unknown = compare(&n, &root);
        let Comparison::Unknown(why) = &unknown else {
            panic!("{unknown:?}")
        };
        cv::enter_conflict(&n, &m, why, T2).unwrap();
        let a = cv::choose_v3(&n, &m, &unknown, T2).unwrap();
        assert_eq!(a.accepted_source_digest.as_ref(), Some(&digest));
        assert_eq!(cv::read_startup_state(&n), None);
        let again = compare(&n, &root);
        assert_eq!(again, unknown);
        assert!(matches!(judge(&n, &root, &again), Verdict::Conflict(_)));
    }
}

// ---------------------------------------------------------------- W3f：与 setup 的启动交接

/// W3f（07 §8）：转换写的进度与 setup 的等待判定、setup 写的回滚记录与存储层的判定，两边对着验。
mod w3f {
    use super::w3d::{G1, G2, layout};
    use super::*;
    use atm_install_state::ProcessIdentity;
    use atm_install_state::startup::{
        self as handover, Counter, ProgressWatch, RollbackAuthority, StartupProgress, WaitPolicy,
        WaitVerdict,
    };
    use atm_store::conversion::{self as cv, AuthorityState, Layout, Phase, RunOptions};
    use std::cell::RefCell;
    use std::time::{Duration, Instant};

    /// 转换按阶段报进度，宿主写成 `startup-progress.json`；setup 的等待接受它、看得到它一直在动，
    /// 但到 PUBLISHED 也只是「还在等」，不当健康证明。
    #[test]
    fn conversion_progress_reaches_setup_but_is_not_health() {
        let (f, root) = json_fixture("w3f-progress");
        let n = layout(&f, "n");
        let me = ProcessIdentity {
            pid: std::process::id(),
            started_at_ms: 1_790_000_000_000,
            image: String::new(),
        };
        let t0 = Instant::now();
        let watch = RefCell::new(ProgressWatch::new("T1", &me, WaitPolicy::default(), t0));
        let seen = RefCell::new(Vec::<(String, usize, usize)>::new());
        let report = |phase: &str, done: usize, total: usize| {
            let p = StartupProgress {
                txn: "T1".into(),
                pid: me.pid,
                process_created_at: me.started_at_ms,
                generation: Some(G1.into()),
                phase: phase.into(),
                progress: Counter {
                    done: done as u64,
                    total: total as u64,
                },
                updated_at: 0,
            };
            handover::write_progress(&n.root, &p).unwrap();
            // setup 那边：读文件、判定。每条都是一分钟后读到的，一直在动就一直在等。
            let read = handover::read_progress(&n.root).unwrap();
            let k = seen.borrow().len() as u32 + 1;
            let verdict = watch.borrow_mut().observe(
                t0 + Duration::from_secs(60) * k,
                false,
                true,
                Some(&read),
            );
            assert_eq!(verdict, WaitVerdict::Waiting, "{phase} {done}/{total}");
            seen.borrow_mut().push((phase.to_string(), done, total));
        };
        let m = cv::run(
            &n,
            RunOptions {
                at: AT,
                generation: G1,
                legacy_root: &root,
                allow_real_data_root: false,
                real_data_root: None,
                secrets_check: Some(secrets_ok),
                accept_unconvertible: &[],
                hook: &mut |_| true,
                progress: Some(&report),
            },
        )
        .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(m.phase, Phase::Published);
        let seen = seen.into_inner();
        let phases: Vec<&str> = seen.iter().map(|(p, _, _)| p.as_str()).collect::<Vec<_>>();
        let mut order = phases.clone();
        order.dedup();
        assert_eq!(
            order,
            ["SNAPSHOT", "IMPORT", "VERIFY", "PUBLISHING", "PUBLISHED"],
            "{seen:?}"
        );
        // SNAPSHOT 按文件报到 F0 的个数；IMPORT / VERIFY 按项目报到 3。
        assert!(seen.contains(&(
            "SNAPSHOT".into(),
            m.source_files.len(),
            m.source_files.len()
        )));
        assert!(seen.contains(&("IMPORT".into(), 3, 3)) && seen.contains(&("VERIFY".into(), 3, 3)));
        // 报到 PUBLISHED 了，没有见证仍然只是在等；10 min 不动就判卡住。
        let last = handover::read_progress(&n.root).unwrap();
        assert_eq!(last.phase, "PUBLISHED");
        let after = t0 + Duration::from_secs(60) * (seen.len() as u32 + 11);
        assert!(matches!(
            watch.borrow_mut().observe(after, false, true, Some(&last)),
            WaitVerdict::Stuck(_)
        ));
    }

    fn authority(n: &Layout) -> cv::Authority {
        match cv::read_authority(n) {
            AuthorityState::Present(a) => a,
            other => panic!("{other:?}"),
        }
    }

    /// setup 写的 `A=legacy` 与存储层 `rollback_authority` 逐字段一致，并且判定照常：
    /// 选过「沿用 3.0」后回滚、没动过 2.x，接回时无损。发布前回滚不写 `A`。
    #[test]
    fn setups_rollback_record_is_the_one_the_store_expects() {
        let (f, root) = json_fixture("w3f-rollback");
        let n = layout(&f, "n");

        // 发布之前回滚：不写 A。
        let mut stop = |s: cv::Step| s != cv::Step::Verified;
        let interrupted = cv::run(
            &n,
            RunOptions {
                at: AT,
                generation: G1,
                legacy_root: &root,
                allow_real_data_root: false,
                real_data_root: None,
                secrets_check: Some(secrets_ok),
                accept_unconvertible: &[],
                hook: &mut stop,
                progress: None,
            },
        );
        assert!(interrupted.is_err());
        assert!(matches!(
            handover::settle_for_rollback(&n.root, "T0", 0),
            Ok(RollbackAuthority::NotWritten(ref why)) if why.contains("VERIFY")
        ));
        assert_eq!(cv::read_authority(&n), AuthorityState::Missing);
        cv::discard_attempt(&n, G1).unwrap();

        let m = super::w3d::run(&n, &root, G2, None).unwrap();
        // 用户选过「沿用 3.0」（绑定了一份摘要）。
        let cmp = cv::Comparison::Unchanged(m.business_digest.clone());
        let chosen = cv::choose_v3(&n, &m, &cmp, AT).unwrap();

        // 新进程还拿着准入：拒绝。
        let admission = cv::admit(&n, || cv::Quiesce::Quiet).unwrap();
        assert!(handover::settle_for_rollback(&n.root, "T1", 0).is_err());
        drop(admission);

        let at_ms = 1_790_000_000_004;
        assert_eq!(
            handover::settle_for_rollback(&n.root, "T1", at_ms).unwrap(),
            RollbackAuthority::Written {
                generation: G2.into()
            }
        );
        let written = authority(&n);
        let expected = cv::rollback_authority(Some(&chosen), &m, "T1", &handover::iso_utc(at_ms));
        assert_eq!(written, expected);
        assert_eq!(
            written.accepted_source_digest,
            chosen.accepted_source_digest
        );
        // 别的 generation 下接受的摘要不沿用（两边同一条规则）。
        let elsewhere = cv::Authority {
            generation: Some(G1.into()),
            ..chosen.clone()
        };
        assert_eq!(
            cv::rollback_authority(Some(&elsewhere), &m, "T1", AT).accepted_source_digest,
            None
        );

        // 回滚后没动过 2.x：阻塞比较判不变 → 无损接回。
        assert!(cv::must_compare_before_serving(&cv::read_authority(&n), &m));
        let base = cv::baseline(&m, Some(&written)).clone();
        let again = cv::compare(
            &n,
            &m,
            &base,
            &cv::CompareOptions {
                legacy_root: &root,
                allow_real_data_root: false,
                real_data_root: None,
                secrets_check: Some(secrets_ok),
            },
        );
        assert_eq!(
            cv::judge(&cv::read_authority(&n), &m, &root, &again),
            cv::Verdict::ResumeAfterRollback
        );
    }
}

// ---------------------------------------------------------------- W3g：dry-run

/// W3g（07 §9）：dry-run 在指定目录里做 SNAPSHOT → VERIFY、写出报告；不写 `L`，不写 `N`。
mod w3g {
    use super::w3d::layout;
    use super::*;
    use atm_store::conversion::{self as cv, DryRun, DryRunOptions, Quiesce};

    fn dry(
        root: &Path,
        out: &Path,
        n: &Path,
        quiesce: &mut dyn FnMut() -> Quiesce,
        after_copy: &mut dyn FnMut(),
    ) -> cv::Result<DryRun> {
        cv::dry_run(DryRunOptions {
            at: AT,
            source: root,
            out,
            v3_root: Some(n),
            allow_real_data_root: false,
            real_data_root: None,
            secrets_check: Some(secrets_ok),
            accept_unconvertible: &[],
            keep_data: false,
            quiesce,
            after_copy,
        })
    }

    fn files(dir: &Path) -> Vec<String> {
        tree(dir).into_iter().map(|(rel, _)| rel).collect()
    }

    /// 报告与直接转换逐字节一致；输出目录里只留报告与附件；`L` 一个字节都不变，`N` 没有被创建。
    #[test]
    fn a_dry_run_reports_without_touching_either_root() {
        let (f, root) = json_fixture("w3g-dry");
        let before = tree(&root);
        let n = layout(&f, "n");
        let out = f.dir.join("dry");
        let outcome = dry(&root, &out, &n.root, &mut || Quiesce::Quiet, &mut || {}).unwrap();
        let direct = f
            .convert_with(Some(secrets_ok))
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(
            outcome,
            DryRun::Verified {
                business_digest: direct.business_digest(),
                pending: Vec::new(),
            }
        );
        assert_eq!(
            fs::read_to_string(out.join("report.json")).unwrap(),
            direct.report_json()
        );
        assert_eq!(files(&out), ["attachment.jsonl", "report.json"]);
        assert_eq!(tree(&root), before, "the dry run wrote into the 2.x root");
        assert!(!n.root.exists(), "the dry run created the 3.0 root");
    }

    /// 源没静止：旧版在跑就什么都不做（输出目录都不建）；SNAPSHOT 期间源在变就只报告，不出报告。
    #[test]
    fn a_busy_or_changing_source_is_only_reported() {
        let (f, root) = json_fixture("w3g-busy");
        let n = layout(&f, "n");
        let out = f.dir.join("dry");
        let busy = dry(
            &root,
            &out,
            &n.root,
            &mut || Quiesce::Wait("2.x daemon pid 42".into()),
            &mut || panic!("nothing may be copied while 2.x runs"),
        )
        .unwrap();
        assert_eq!(busy, DryRun::SourceBusy("2.x daemon pid 42".into()));
        assert!(!out.exists());

        let notes = root.join("projects/P1/artifacts/notes.txt");
        let changing = dry(&root, &out, &n.root, &mut || Quiesce::Quiet, &mut || {
            fs::write(&notes, b"written while copying").unwrap()
        })
        .unwrap();
        match changing {
            DryRun::SourceNotQuiet(why) => assert!(why.contains("notes.txt"), "{why}"),
            other => panic!("{other:?}"),
        }
        assert!(files(&out).is_empty(), "{:?}", files(&out));
        assert!(!n.root.exists());
    }

    /// 输出目录放在 `L` 或 `N` 里、或者不是空的，都在动手之前拒绝。
    #[test]
    fn the_output_must_be_empty_and_outside_both_roots() {
        let (f, root) = json_fixture("w3g-out");
        let before = tree(&root);
        let n = layout(&f, "n");
        fs::create_dir_all(&n.root).unwrap();
        let used = f.dir.join("used");
        put(&used.join("mine.txt"), b"keep");
        let shouting = PathBuf::from(root.join("dry").to_string_lossy().to_uppercase());
        for (out, why) in [
            (root.join("dry"), "overlaps the 2.x data root"),
            (shouting, "overlaps the 2.x data root"),
            (n.root.join("dry"), "overlaps the 3.0 data root"),
            (used.clone(), "not empty"),
        ] {
            match dry(&root, &out, &n.root, &mut || Quiesce::Quiet, &mut || {}) {
                Err(cv::Error::Refused(reason)) => assert!(reason.contains(why), "{reason}"),
                other => panic!("{}: {other:?}", out.display()),
            }
        }
        assert_eq!(tree(&root), before);
        assert!(files(&n.root).is_empty());
        assert_eq!(files(&used), ["mine.txt"]);
    }
}

// ---------------------------------------------------------------- W3h：07 §10 故障注入矩阵 F1–F29

/// W3h：07 §10 每一项一个用例。每项都断言：选中的分支正确、没被选中的一边完整，
/// 并且 `L` 的业务对象集合（05 的 business_digest 对象族）没有被转换器改动——
/// 用例自己模拟的 2.x 写入除外，断言的是「模拟写入之后」的那份摘要。
mod fault_matrix {
    use super::w3d::{G1, G2, layout, manifest, run};
    use super::*;
    use atm_install_state::ProcessIdentity;
    use atm_install_state::startup::{
        self as handover, Counter, ProgressWatch, RollbackAuthority, StartupProgress, WaitPolicy,
        WaitVerdict,
    };
    use atm_store::conversion::{
        self as cv, AuthorityState, Comparison, Layout, Phase, Quiesce, RunOptions, Seal, SealStep,
        Startup, Step, Verdict,
    };
    use std::time::{Duration, Instant};

    /// `L` 的业务对象集合：按转换的同一流程算 business_digest（只读 `L`，算完删掉 scratch）。
    fn business(f: &Fixture, root: &Path) -> BTreeMap<String, String> {
        let scratch = f.dir.join("business-scratch");
        let digest = atm_store::legacy::business_digest(
            &LegacySources::from_root(root).unwrap(),
            &scratch,
            &ConvertOptions {
                at: AT,
                allow_real_data_root: false,
                real_data_root: None,
                generation: None,
                secrets_check: Some(secrets_ok),
                accept_unconvertible: &[],
                origin_root: None,
                progress: None,
            },
        )
        .unwrap_or_else(|e| panic!("{e}"));
        let _ = fs::remove_dir_all(&scratch);
        digest
    }

    fn run_with(
        n: &Layout,
        root: &Path,
        g: &str,
        hook: &mut dyn FnMut(Step) -> bool,
        progress: Option<cv::ProgressFn<'_>>,
    ) -> cv::Result<cv::Manifest> {
        cv::run(
            n,
            RunOptions {
                at: AT,
                generation: g,
                legacy_root: root,
                allow_real_data_root: false,
                real_data_root: None,
                secrets_check: Some(secrets_ok),
                accept_unconvertible: &[],
                hook,
                progress,
            },
        )
    }

    fn authority(n: &Layout) -> cv::Authority {
        match cv::read_authority(n) {
            AuthorityState::Present(a) => a,
            other => panic!("{other:?}"),
        }
    }

    fn compare(n: &Layout, root: &Path) -> Comparison {
        let m = manifest(n);
        let a = match cv::read_authority(n) {
            AuthorityState::Present(a) => Some(a),
            _ => None,
        };
        cv::compare(
            n,
            &m,
            cv::baseline(&m, a.as_ref()),
            &cv::CompareOptions {
                legacy_root: root,
                allow_real_data_root: false,
                real_data_root: None,
                secrets_check: Some(secrets_ok),
            },
        )
    }

    fn judge(n: &Layout, root: &Path) -> Verdict {
        let cmp = compare(n, root);
        cv::judge(&cv::read_authority(n), &manifest(n), root, &cmp)
    }

    /// setup 的回滚事务（07 §8）：新进程已退出，按持久阶段写 `A=legacy`。
    fn setup_rolls_back(n: &Layout) {
        assert!(matches!(
            handover::settle_for_rollback(&n.root, "TXN-ROLLBACK", 1_790_000_000_000),
            Ok(RollbackAuthority::Written { .. })
        ));
        assert_eq!(authority(n).authority, "legacy");
    }

    fn sql(path: &Path, batch: &str) {
        Connection::open(path)
            .unwrap()
            .execute_batch(batch)
            .unwrap();
    }

    /// 以 2.x 为准的完整一轮：判定 Reconvert → 封存当前 generation（封存物与封存前逐字节相同）→ S2 重转；
    /// 新发布物的业务摘要就是 `L` 现在的摘要。返回新的清单。
    fn reconvert(f: &Fixture, n: &Layout, root: &Path) -> cv::Manifest {
        assert_eq!(judge(n, root), Verdict::Reconvert);
        let published = tree(&n.data());
        let sealed = cv::choose_legacy(n, T2).unwrap();
        assert_eq!(sealed.parent().unwrap(), n.root.join("superseded"));
        assert_eq!(
            tree(&sealed.join("data")),
            published,
            "the superseded 3.0 side is not intact"
        );
        assert!(
            sealed.join("conversion.json").is_file() && sealed.join("authority.json").is_file()
        );
        assert_eq!(cv::decide(n, true), Startup::FirstConversion);
        let m = run(n, root, G2, None).unwrap();
        assert_eq!(m.business_digest, business(f, root));
        assert_eq!(cv::decide(n, true), Startup::Published(m.clone()));
        m
    }

    fn conflict(v: Verdict) -> String {
        match v {
            Verdict::Conflict(why) => why,
            other => panic!("expected a source conflict: {other:?}"),
        }
    }

    /// 转换跑起来之前的准备：发布一次。返回 (夹具, L, N, 清单, L 的业务摘要)。
    fn published(
        name: &str,
    ) -> (
        Fixture,
        PathBuf,
        Layout,
        cv::Manifest,
        BTreeMap<String, String>,
    ) {
        let (f, root) = json_fixture(name);
        let before = business(&f, &root);
        let n = layout(&f, "n");
        let m = run(&n, &root, G1, None).unwrap();
        assert_eq!(m.business_digest, before);
        (f, root, n, m, before)
    }

    // ---------------- F1–F9：转换本身

    /// F1：SNAPSHOT 中途源文件变化或新增 → FAILED，回到等待静止（下次按 S3 重来），不发布。
    #[test]
    fn f01_a_source_changing_during_snapshot_fails() {
        let (f, root) = json_fixture("f01");
        let before = tree(&root);
        let business_before = business(&f, &root);
        for (i, rel) in [
            "projects/P1/artifacts/notes.txt",
            "projects/P1/artifacts/new.txt",
        ]
        .iter()
        .enumerate()
        {
            let n = layout(&f, &format!("n-{i}"));
            let path = root.join(rel);
            let original = fs::read(&path).ok();
            let r = run_with(
                &n,
                &root,
                G1,
                &mut |s| {
                    if s == Step::SnapshotCopied {
                        fs::write(&path, b"2.x wrote this while copying").unwrap();
                    }
                    true
                },
                None,
            );
            assert!(matches!(r, Err(cv::Error::SourceNotQuiet(_))), "{r:?}");
            assert_eq!(manifest(&n).phase, Phase::Failed);
            assert!(!n.data().exists());
            assert_eq!(
                cv::decide(&n, true),
                Startup::Restart {
                    generation: G1.into()
                }
            );
            match original {
                Some(bytes) => fs::write(&path, bytes).unwrap(),
                None => fs::remove_file(&path).unwrap(),
            }
        }
        assert_eq!(tree(&root), before);
        assert_eq!(business(&f, &root), business_before);
    }

    /// F2：复制中断（进程被杀）→ S3 重来，换新 generation 后正常发布。
    #[test]
    fn f02_a_killed_copy_restarts() {
        let (f, root) = json_fixture("f02");
        let before = tree(&root);
        let n = layout(&f, "n");
        assert!(matches!(
            run_with(&n, &root, G1, &mut |s| s != Step::SnapshotCopied, None),
            Err(cv::Error::Interrupted(_))
        ));
        assert_eq!(
            cv::decide(&n, true),
            Startup::Restart {
                generation: G1.into()
            }
        );
        cv::discard_attempt(&n, G1).unwrap();
        // 丢弃之后是一次干净的首次转换，不再看到被杀那一代的 M。
        assert_eq!(cv::decide(&n, true), Startup::FirstConversion);
        let m = run(&n, &root, G2, None).unwrap();
        assert_eq!(cv::decide(&n, true), Startup::Published(m));
        assert_eq!(tree(&root), before);
    }

    /// F3：IMPORT 中途被杀 → S3 重来，没有残留的发布物。
    #[test]
    fn f03_a_killed_import_leaves_no_publication() {
        let (f, root) = json_fixture("f03");
        let before = tree(&root);
        let n = layout(&f, "n");
        assert!(run_with(&n, &root, G1, &mut |s| s != Step::Importing, None).is_err());
        assert!(!n.data().exists(), "a killed IMPORT left a publication");
        assert_eq!(
            cv::decide(&n, true),
            Startup::Restart {
                generation: G1.into()
            }
        );
        cv::discard_attempt(&n, G1).unwrap();
        run(&n, &root, G2, None).unwrap();
        assert_eq!(tree(&root), before);
    }

    /// F4：VERIFY 发现差异 → FAILED，报告指出是哪些对象，不发布。
    #[test]
    fn f04_a_verify_difference_fails_and_names_the_objects() {
        let (f, root) = json_fixture("f04");
        sql(
            &root.join("projects/P1/project.sqlite"),
            &format!(
                "INSERT INTO idempotency_keys (key, operation, request_fingerprint, response_json, created_at, op_id, actor_session_id)
                 VALUES ('S1:x1', 'work.update', 'fp', '{{}}', '{T}', 'other', NULL);"
            ),
        );
        let before = tree(&root);
        let n = layout(&f, "n");
        assert!(matches!(
            run_with(&n, &root, G1, &mut |_| true, None),
            Err(cv::Error::Convert(ConvertError::Verify(_)))
        ));
        let m = manifest(&n);
        assert_eq!(m.phase, Phase::Failed);
        assert!(
            m.failure.as_deref().is_some_and(|w| w.contains("verify")),
            "{:?}",
            m.failure
        );
        let report = fs::read_to_string(n.staging(G1).join("report.json")).unwrap();
        assert!(
            report.contains("S1:x1"),
            "the report does not name the object: {report}"
        );
        assert!(!n.data().exists());
        assert_eq!(tree(&root), before);
    }

    /// F5：改名已成功、`M` 还没写 PUBLISHED 就被杀 → S4，身份一致 → 补写 PUBLISHED。
    #[test]
    fn f05_killed_after_the_rename_finishes_publishing() {
        let (f, root) = json_fixture("f05");
        let before = tree(&root);
        let n = layout(&f, "n");
        assert!(run_with(&n, &root, G1, &mut |s| s != Step::Renamed, None).is_err());
        assert_eq!(
            cv::decide(&n, true),
            Startup::FinishPublishing {
                generation: G1.into()
            }
        );
        let m = cv::finish_publishing(&n, AT).unwrap();
        assert_eq!(cv::decide(&n, true), Startup::Published(m));
        assert_eq!(authority(&n).by, "publish");
        assert_eq!(tree(&root), before);
    }

    /// F6：`M` 丢失或损坏、发布物还在 → S5：发布物整体隔离（原样、不打开），然后重新转换。
    #[test]
    fn f06_a_lost_manifest_quarantines_the_publication() {
        let (f, root, n, _, before) = published("f06");
        for damage in [None, Some(&b"{\"schema\":1"[..])] {
            match damage {
                None => fs::remove_file(n.manifest()).unwrap(),
                Some(bytes) => fs::write(n.manifest(), bytes).unwrap(),
            }
            let data = tree(&n.data());
            assert!(matches!(cv::decide(&n, true), Startup::Quarantine { .. }));
            let target = cv::seal(&n, Seal::Quarantine, AT).unwrap();
            assert_eq!(
                tree(&target.join("data")),
                data,
                "the quarantined publication changed"
            );
            assert_eq!(cv::decide(&n, true), Startup::FirstConversion);
            let m = run(&n, &root, G2, None).unwrap();
            assert_eq!(cv::decide(&n, true), Startup::Published(m));
        }
        assert_eq!(business(&f, &root), before);
    }

    /// F7：两个新实例同时启动 → 只有一个拿得到准入。
    #[test]
    fn f07_two_instances_get_one_admission() {
        let (f, root) = json_fixture("f07");
        let before = tree(&root);
        let n = layout(&f, "n");
        let first = cv::admit(&n, || Quiesce::Quiet).unwrap();
        assert!(matches!(
            cv::admit(&n, || Quiesce::Quiet),
            Err(cv::AdmitError::AlreadyRunning)
        ));
        run(&n, &root, G1, None).unwrap();
        drop(first);
        assert_eq!(tree(&root), before);
    }

    /// F8：磁盘满（写不进 staging）→ FAILED 并写明原因；旧版照常可用（`L` 不变），下次按 S3 重来。
    #[test]
    fn f08_a_full_disk_fails_the_attempt() {
        let (f, root) = json_fixture("f08");
        let before = tree(&root);
        let n = layout(&f, "n");
        let blocker = n.staging(G1).join("data");
        let r = run_with(
            &n,
            &root,
            G1,
            &mut |s| {
                if s == Step::Importing {
                    fs::write(&blocker, b"the disk is full").unwrap();
                }
                true
            },
            None,
        );
        assert!(r.is_err(), "{r:?}");
        let m = manifest(&n);
        assert_eq!(m.phase, Phase::Failed);
        assert!(m.failure.is_some());
        assert!(!n.data().exists());
        assert_eq!(
            cv::decide(&n, true),
            Startup::Restart {
                generation: G1.into()
            }
        );
        assert_eq!(tree(&root), before);
    }

    /// F9：某个项目库损坏 → FAILED，原因指出是哪个项目，不跳过。
    #[test]
    fn f09_a_damaged_project_database_fails_and_is_named() {
        let (f, root) = json_fixture("f09");
        fs::write(root.join("projects/P2/project.sqlite"), vec![0x5au8; 8192]).unwrap();
        let before = tree(&root);
        let n = layout(&f, "n");
        assert!(run_with(&n, &root, G1, &mut |_| true, None).is_err());
        let m = manifest(&n);
        assert_eq!(m.phase, Phase::Failed);
        let why = m.failure.unwrap_or_default();
        assert!(
            why.contains("P2"),
            "the failure does not name the project: {why}"
        );
        assert!(
            !n.data().exists(),
            "a damaged project was skipped and published"
        );
        assert_eq!(tree(&root), before);
    }

    // ---------------- F10–F14、F19–F29：权威判定

    /// F10：`A=v3`，源只做了 checkpoint 或 SHM 重建（VACUUM、切 WAL 后留着 `-wal` / `-shm`）→ 正常启动，不重转。
    #[test]
    fn f10_storage_only_changes_keep_serving() {
        let (f, root, n, m, before) = published("f10");
        sql(&root.join("registry/registry.sqlite"), "VACUUM;");
        let keep = Connection::open(root.join("projects/P1/project.sqlite")).unwrap();
        keep.execute_batch("PRAGMA journal_mode = WAL; PRAGMA wal_checkpoint(TRUNCATE);")
            .unwrap();
        assert!(!cv::must_compare_before_serving(
            &cv::read_authority(&n),
            &m
        ));
        assert_eq!(
            compare(&n, &root),
            Comparison::Unchanged(m.business_digest.clone())
        );
        assert_eq!(judge(&n, &root), Verdict::Serve);
        assert_eq!(cv::decide(&n, true), Startup::Published(m));
        drop(keep);
        assert_eq!(business(&f, &root), before);
    }

    /// F11：回滚后（`A=legacy`）只改了 sync / dispatch 的 JSON → 以 2.x 为准，封存后重转。
    #[test]
    fn f11_rolled_back_json_changes_reconvert() {
        let (f, root, n, _, _) = published("f11");
        setup_rolls_back(&n);
        let config = fs::read_to_string(root.join("sync/config.json")).unwrap();
        fs::write(
            root.join("sync/config.json"),
            config.replace("\"cursor\": \"c-9\"", "\"cursor\": \"c-12\""),
        )
        .unwrap();
        let after = business(&f, &root);
        reconvert(&f, &n, &root);
        assert_eq!(business(&f, &root), after);
    }

    /// F12：回滚后新增了业务数据 → 以 2.x 为准，封存后重转，封存物完整。
    #[test]
    fn f12_rolled_back_new_data_reconverts() {
        let (f, root, n, _, _) = published("f12");
        setup_rolls_back(&n);
        sql(
            &root.join("registry/registry.sqlite"),
            &format!(
                "INSERT INTO project_restore_requests (id, project_id, requested_by, source_cwd, status, request_count, created_at, updated_at)
                 VALUES ('RR-NEW', 'P1', 'agent', 'C:/work', 'PENDING', 1, '{T2}', '{T2}');"
            ),
        );
        let after = business(&f, &root);
        let m = reconvert(&f, &n, &root);
        let c = Connection::open(n.database()).unwrap();
        assert_eq!(
            q::<i64>(
                &c,
                "SELECT count(*) FROM project_restore_requests WHERE id = 'RR-NEW'"
            ),
            1
        );
        assert_eq!(m.business_digest, after);
    }

    /// F13：`A=v3`，旧根却有业务变化 → SOURCE_CONFLICT；两种选择各验一次。
    #[test]
    fn f13_a_v3_change_conflicts_and_both_choices_work() {
        let (f, root) = json_fixture("f13");
        let keep = layout(&f, "n-keep");
        let back = layout(&f, "n-back");
        let m_keep = run(&keep, &root, G1, None).unwrap();
        let m_back = run(&back, &root, G1, None).unwrap();
        sql(
            &root.join("registry/registry.sqlite"),
            "UPDATE projects SET description = 'written in 2.x' WHERE id = 'P1';",
        );
        let after = business(&f, &root);

        // 沿用 3.0：绑定摘要，3.0 那边原样。
        let cmp = compare(&keep, &root);
        let why = conflict(cv::judge(&cv::read_authority(&keep), &m_keep, &root, &cmp));
        cv::enter_conflict(&keep, &m_keep, &why, AT).unwrap();
        assert!(matches!(
            cv::decide(&keep, true),
            Startup::SourceConflict(_)
        ));
        let data = tree(&keep.data());
        cv::choose_v3(&keep, &m_keep, &cmp, T2).unwrap();
        assert_eq!(cv::decide(&keep, true), Startup::Published(m_keep));
        assert_eq!(tree(&keep.data()), data);

        // 从 2.x 重转：3.0 那边封存完整。
        let cmp = compare(&back, &root);
        let why = conflict(cv::judge(&cv::read_authority(&back), &m_back, &root, &cmp));
        cv::enter_conflict(&back, &m_back, &why, AT).unwrap();
        let data = tree(&back.data());
        let sealed = cv::choose_legacy(&back, T2).unwrap();
        assert_eq!(tree(&sealed.join("data")), data);
        let m = run(&back, &root, G2, None).unwrap();
        assert_eq!(m.business_digest, after);
        assert_eq!(business(&f, &root), after);
    }

    /// F14：封存途中被杀 → 重入后完成，不覆盖已有内容。
    #[test]
    fn f14_a_killed_seal_resumes_without_overwriting() {
        let (f, root, n, _, before) = published("f14");
        let data = tree(&n.data());
        let taken = n
            .root
            .join("superseded")
            .join(format!("{G1}-2026-10-03T00-00-00-000Z"));
        put(&taken.join("keep.txt"), b"older");
        assert!(cv::seal_with(&n, Seal::Superseded, AT, &mut |s| s != SealStep::Moved).is_err());
        assert_eq!(cv::decide(&n, true), Startup::ResumeSeal);
        let target = cv::seal(&n, Seal::Superseded, AT).unwrap();
        assert_ne!(target, taken);
        assert_eq!(fs::read(taken.join("keep.txt")).unwrap(), b"older");
        assert_eq!(tree(&target.join("data")), data);
        assert_eq!(cv::decide(&n, true), Startup::FirstConversion);
        assert_eq!(business(&f, &root), before);
    }

    // ---------------- F15–F18：setup 的等待（真实的转换进度喂给 setup 的判定）

    fn me() -> ProcessIdentity {
        ProcessIdentity {
            pid: std::process::id(),
            started_at_ms: 1_790_000_000_000,
            image: String::new(),
        }
    }

    /// 转换把进度写成文件（宿主的做法），返回每次写完时 setup 读到的那一份。
    fn converting(
        n: &Layout,
        root: &Path,
        txn: &str,
        stop: Option<Step>,
    ) -> (cv::Result<cv::Manifest>, Vec<StartupProgress>) {
        let seen = std::cell::RefCell::new(Vec::new());
        let me = me();
        let write = |phase: &str, done: usize, total: usize| {
            let p = StartupProgress {
                txn: txn.into(),
                pid: me.pid,
                process_created_at: me.started_at_ms,
                generation: Some(G1.into()),
                phase: phase.into(),
                progress: Counter {
                    done: done as u64,
                    total: total as u64,
                },
                updated_at: 0,
            };
            handover::write_progress(&n.root, &p).unwrap();
            seen.borrow_mut()
                .push(handover::read_progress(&n.root).unwrap());
        };
        let r = run_with(n, root, G1, &mut |s| Some(s) != stop, Some(&write));
        (r, seen.into_inner())
    }

    /// F15：setup 等待超过 60 s，转换仍有进展 → 继续等，见证成立后成功。
    #[test]
    fn f15_a_long_conversion_with_progress_succeeds() {
        let (f, root) = json_fixture("f15");
        let before = tree(&root);
        let n = layout(&f, "n");
        let (r, seen) = converting(&n, &root, "T15", None);
        r.unwrap();
        let t0 = Instant::now();
        let mut watch = ProgressWatch::new("T15", &me(), WaitPolicy::default(), t0);
        for (i, p) in seen.iter().enumerate() {
            let now = t0 + Duration::from_secs(90) * (i as u32 + 1);
            assert_eq!(
                watch.observe(now, false, true, Some(p)),
                WaitVerdict::Waiting,
                "{p:?}"
            );
        }
        let later = t0 + Duration::from_secs(90) * (seen.len() as u32 + 1);
        assert_eq!(
            watch.observe(later, true, true, seen.last()),
            WaitVerdict::Healthy
        );
        assert_eq!(tree(&root), before);
    }

    /// F16：进度停止 10 min → setup 判为卡住；确认进程退出（放掉准入）后回滚，没发布就不写 `A`，
    /// 下次再升级按 S3 重来。
    #[test]
    fn f16_a_stalled_conversion_is_rolled_back() {
        let (f, root) = json_fixture("f16");
        let before = tree(&root);
        let n = layout(&f, "n");
        let admission = cv::admit(&n, || Quiesce::Quiet).unwrap();
        let (r, seen) = converting(&n, &root, "T16", Some(Step::Verified));
        assert!(r.is_err());
        let t0 = Instant::now();
        let mut watch = ProgressWatch::new("T16", &me(), WaitPolicy::default(), t0);
        let last = seen.last().unwrap();
        assert_eq!(
            watch.observe(t0 + Duration::from_secs(30), false, true, Some(last)),
            WaitVerdict::Waiting
        );
        assert!(matches!(
            watch.observe(t0 + Duration::from_secs(30 + 600), false, true, Some(last)),
            WaitVerdict::Stuck(_)
        ));
        assert!(
            handover::settle_for_rollback(&n.root, "T16", 0).is_err(),
            "the stuck process still holds N"
        );
        drop(admission);
        assert!(matches!(
            handover::settle_for_rollback(&n.root, "T16", 0),
            Ok(RollbackAuthority::NotWritten(_))
        ));
        assert_eq!(cv::read_authority(&n), AuthorityState::Missing);
        assert_eq!(
            cv::decide(&n, true),
            Startup::Restart {
                generation: G1.into()
            }
        );
        assert_eq!(tree(&root), before);
    }

    /// F17：转换进程死亡 → setup 回滚到 2.x；再次升级时走 S3。
    #[test]
    fn f17_a_dead_conversion_rolls_back_and_restarts_later() {
        let (f, root) = json_fixture("f17");
        let before = tree(&root);
        let n = layout(&f, "n");
        let (r, seen) = converting(&n, &root, "T17", Some(Step::Importing));
        assert!(r.is_err());
        let t0 = Instant::now();
        let mut watch = ProgressWatch::new("T17", &me(), WaitPolicy::default(), t0);
        assert_eq!(
            watch.observe(t0, false, false, seen.last()),
            WaitVerdict::Dead
        );
        assert!(matches!(
            handover::settle_for_rollback(&n.root, "T17", 0),
            Ok(RollbackAuthority::NotWritten(_))
        ));
        assert_eq!(
            cv::decide(&n, true),
            Startup::Restart {
                generation: G1.into()
            }
        );
        cv::discard_attempt(&n, G1).unwrap();
        run(&n, &root, G2, None).unwrap();
        assert_eq!(tree(&root), before);
    }

    /// F18：setup 重启后接管等待 → 接受同一 txn、同一进程的进度，拒绝旧进度。
    #[test]
    fn f18_a_restarted_setup_takes_over_with_the_same_txn_only() {
        let (f, root) = json_fixture("f18");
        let before = tree(&root);
        let n = layout(&f, "n");
        let (r, seen) = converting(&n, &root, "T18", None);
        r.unwrap();
        let t0 = Instant::now();
        let mut taken_over = ProgressWatch::new("T18", &me(), WaitPolicy::default(), t0);
        let mut stale_txn = ProgressWatch::new("T-OLD", &me(), WaitPolicy::default(), t0);
        let mut stale_process = ProgressWatch::new(
            "T18",
            &ProcessIdentity {
                started_at_ms: 1,
                ..me()
            },
            WaitPolicy::default(),
            t0,
        );
        for p in &seen {
            assert!(taken_over.accepts(p) && !stale_txn.accepts(p) && !stale_process.accepts(p));
        }
        let later = t0 + Duration::from_secs(61);
        assert_eq!(
            taken_over.observe(t0 + Duration::from_secs(1), false, true, seen.last()),
            WaitVerdict::Waiting
        );
        assert_eq!(
            taken_over.observe(later, false, true, seen.last()),
            WaitVerdict::Waiting
        );
        assert!(matches!(
            stale_txn.observe(later, false, true, seen.last()),
            WaitVerdict::TimedOut(_)
        ));
        assert!(matches!(
            stale_process.observe(later, false, true, seen.last()),
            WaitVerdict::TimedOut(_)
        ));
        assert_eq!(tree(&root), before);
    }

    /// F19：回滚后只改了派单配置（关闭派单）→ 判「变了」→ 以 2.x 为准，派单保持关闭。
    #[test]
    fn f19_a_rolled_back_dispatch_switch_reconverts_and_stays_off() {
        let (f, root, n, _, _) = published("f19");
        setup_rolls_back(&n);
        let config = fs::read_to_string(root.join("dispatch/config.json")).unwrap();
        fs::write(
            root.join("dispatch/config.json"),
            config.replace("\"enabled\":true", "\"enabled\":false"),
        )
        .unwrap();
        let after = business(&f, &root);
        reconvert(&f, &n, &root);
        let c = Connection::open(n.database()).unwrap();
        assert_eq!(q::<i64>(&c, "SELECT enabled FROM dispatch_config"), 0);
        assert_eq!(business(&f, &root), after);
    }

    /// F20：回滚后对已有的恢复申请续写（request_count 增加）→ 判「变了」。
    #[test]
    fn f20_a_repeated_restore_request_is_a_change() {
        let (f, root) = json_fixture("f20");
        sql(
            &root.join("registry/registry.sqlite"),
            &format!(
                "INSERT INTO project_restore_requests (id, project_id, requested_by, source_cwd, status, request_count, created_at, updated_at)
                 VALUES ('RR-1', 'P1', 'agent', 'C:/work', 'PENDING', 1, '{T}', '{T}');"
            ),
        );
        let n = layout(&f, "n");
        run(&n, &root, G1, None).unwrap();
        setup_rolls_back(&n);
        sql(
            &root.join("registry/registry.sqlite"),
            "UPDATE project_restore_requests SET request_count = request_count + 1;",
        );
        let after = business(&f, &root);
        match compare(&n, &root) {
            Comparison::Changed { families, .. } => assert_eq!(families.len(), 1, "{families:?}"),
            other => panic!("{other:?}"),
        }
        reconvert(&f, &n, &root);
        assert_eq!(business(&f, &root), after);
    }

    /// F21：回滚后只改了 sync 设置（deviceName / enabled）→ 判「变了」。
    #[test]
    fn f21_rolled_back_sync_settings_are_a_change() {
        let (f, root, n, _, _) = published("f21");
        setup_rolls_back(&n);
        let config = fs::read_to_string(root.join("sync/config.json")).unwrap();
        fs::write(
            root.join("sync/config.json"),
            config
                .replace("书房电脑", "客厅电脑")
                .replace("\"enabled\": true", "\"enabled\": false"),
        )
        .unwrap();
        let after = business(&f, &root);
        assert!(matches!(compare(&n, &root), Comparison::Changed { .. }));
        reconvert(&f, &n, &root);
        assert_eq!(business(&f, &root), after);
    }

    /// F22：回滚后只有工程指标历史变化 → 05 决定保留，所以判「变了」。
    #[test]
    fn f22_rolled_back_metrics_history_is_a_change() {
        let (f, root, n, _, _) = published("f22");
        setup_rolls_back(&n);
        sql(
            &root.join("projects/P1/project.sqlite"),
            &format!(
                "INSERT INTO engineering_project_metrics (id, git_head, captured_at, payload_json) VALUES ('M-NEW', 'abc123', '{T2}', '{{}}');"
            ),
        );
        let after = business(&f, &root);
        assert!(matches!(compare(&n, &root), Comparison::Changed { .. }));
        reconvert(&f, &n, &root);
        assert_eq!(business(&f, &root), after);
    }

    /// F23：旧根出现 05 没登记的文件或表 → UNKNOWN → 冲突（`A=v3` 与 `A=legacy` 都是）。
    #[test]
    fn f23_unregistered_files_or_tables_are_unknown() {
        let (f, root, n, _, before) = published("f23");
        let tree_before = tree(&root);
        put(&root.join("unexpected.txt"), b"?");
        conflict(judge(&n, &root));
        fs::remove_file(root.join("unexpected.txt")).unwrap();
        put(&root.join("trash/left-over.txt"), b"?");
        conflict(judge(&n, &root));
        fs::remove_file(root.join("trash/left-over.txt")).unwrap();
        let registry = root.join("registry/registry.sqlite");
        let original = fs::read(&registry).unwrap();
        sql(&registry, "CREATE TABLE extra_table (id TEXT);");
        assert!(matches!(compare(&n, &root), Comparison::Unknown(_)));
        setup_rolls_back(&n);
        conflict(judge(&n, &root));
        fs::write(&registry, original).unwrap();
        assert_eq!(tree(&root), tree_before);
        assert_eq!(business(&f, &root), before);
    }

    /// F24：已发布但 `A` 没落盘；`A` 损坏或与 generation 不符 → 按冲突处理，不猜。
    #[test]
    fn f24_a_missing_or_mismatched_authority_is_a_conflict() {
        let (f, root, n, _, before) = published("f24");
        let a = authority(&n);
        fs::remove_file(n.authority()).unwrap();
        assert!(conflict(judge(&n, &root)).contains("missing"));
        fs::write(n.authority(), b"{\"authority\":").unwrap();
        assert!(conflict(judge(&n, &root)).contains("corrupt"));
        cv::write_authority(
            &n,
            &cv::Authority {
                generation: Some(G2.into()),
                ..a
            },
        )
        .unwrap();
        assert!(conflict(judge(&n, &root)).contains(G2));
        assert_eq!(business(&f, &root), before);
    }

    /// F25：选了「沿用 3.0」之后 2.x 又有新写入 → 识别出来，再次进入冲突。
    #[test]
    fn f25_new_2x_writes_after_keeping_3_0_conflict_again() {
        let (f, root, n, m, _) = published("f25");
        sql(
            &root.join("registry/registry.sqlite"),
            "UPDATE projects SET description = 'first' WHERE id = 'P1';",
        );
        let cmp = compare(&n, &root);
        cv::choose_v3(&n, &m, &cmp, T2).unwrap();
        assert_eq!(judge(&n, &root), Verdict::Serve);
        sql(
            &root.join("registry/registry.sqlite"),
            "UPDATE projects SET description = 'second' WHERE id = 'P1';",
        );
        let after = business(&f, &root);
        conflict(judge(&n, &root));
        assert_eq!(business(&f, &root), after);
    }

    /// 把一个文件改成同样大小的别的内容，并把 mtime 改回原样：文件集合、size、mtime 全都相同。
    fn same_shape_edit(path: &Path, from: &str, to: &str) {
        assert_eq!(from.len(), to.len());
        let mtime = fs::metadata(path).unwrap().modified().unwrap();
        let text = fs::read_to_string(path).unwrap();
        assert!(text.contains(from));
        fs::write(path, text.replace(from, to)).unwrap();
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(mtime)
            .unwrap();
        assert_eq!(fs::metadata(path).unwrap().modified().unwrap(), mtime);
    }

    /// F26：旧根文件集合、size、mtime 全都相同，但业务内容不同（`A=legacy`）→ 阻塞比较判「变了」→ 以 2.x 为准。
    #[test]
    fn f26_same_metadata_different_content_reconverts_under_legacy() {
        let (f, root, n, _, _) = published("f26");
        setup_rolls_back(&n);
        let listing = |r: &Path| -> Vec<(String, u64)> {
            tree(r)
                .into_iter()
                .map(|(rel, _)| {
                    let len = fs::metadata(r.join(&rel)).unwrap().len();
                    (rel, len)
                })
                .collect()
        };
        let shape = listing(&root);
        same_shape_edit(&root.join("sync/config.json"), "\"c-9\"", "\"c-8\"");
        assert_eq!(listing(&root), shape);
        let after = business(&f, &root);
        assert!(cv::must_compare_before_serving(
            &cv::read_authority(&n),
            &manifest(&n)
        ));
        reconvert(&f, &n, &root);
        assert_eq!(business(&f, &root), after);
    }

    /// F27：同上，`A=v3` → 后台比较判「变了」→ 进入冲突；发现之前写进 3.0 的数据都在。
    #[test]
    fn f27_same_metadata_different_content_conflicts_under_v3() {
        let (f, root, n, m, _) = published("f27");
        // 服务已经在跑，写了 3.0 自己的数据。
        sql(
            &n.database(),
            "UPDATE projects SET description = 'written by 3.0' WHERE id = 'P1';",
        );
        same_shape_edit(&root.join("sync/config.json"), "\"c-9\"", "\"c-7\"");
        let after = business(&f, &root);
        let why = conflict(judge(&n, &root));
        cv::enter_conflict(&n, &m, &why, AT).unwrap();
        assert!(matches!(cv::decide(&n, true), Startup::SourceConflict(_)));
        let c = Connection::open(n.database()).unwrap();
        assert_eq!(
            q::<String>(&c, "SELECT description FROM projects WHERE id = 'P1'"),
            "written by 3.0"
        );
        assert_eq!(business(&f, &root), after);
    }

    /// F28：摘要读不出来（源文件被独占）→ UNKNOWN → 冲突，不会因为元数据相同而放行。
    #[test]
    fn f28_an_unreadable_source_is_unknown() {
        use std::os::windows::fs::OpenOptionsExt;
        let (f, root, n, _, before) = published("f28");
        let tree_before = tree(&root);
        let held = fs::File::options()
            .read(true)
            .share_mode(0)
            .open(root.join("registry/registry.sqlite"))
            .unwrap();
        assert!(matches!(compare(&n, &root), Comparison::Unknown(_)));
        conflict(judge(&n, &root));
        drop(held);
        assert_eq!(tree(&root), tree_before);
        assert_eq!(business(&f, &root), before);
    }

    /// F29：选了「沿用 3.0」之后没有新写入 → 不会再次冲突（以被接受的摘要为基线）。
    #[test]
    fn f29_no_new_writes_after_keeping_3_0_keep_serving() {
        let (f, root, n, m, _) = published("f29");
        sql(
            &root.join("registry/registry.sqlite"),
            "UPDATE projects SET description = 'once' WHERE id = 'P1';",
        );
        let after = business(&f, &root);
        let cmp = compare(&n, &root);
        conflict(cv::judge(&cv::read_authority(&n), &m, &root, &cmp));
        cv::choose_v3(&n, &m, &cmp, T2).unwrap();
        for _ in 0..2 {
            assert_eq!(judge(&n, &root), Verdict::Serve);
            assert_eq!(cv::decide(&n, true), Startup::Published(m.clone()));
        }
        assert_eq!(business(&f, &root), after);
    }
}

// ---------------------------------------------------------------- W3 peer r1：P1-01～P1-05 的正式用例

/// W3 整体评审第一轮（`output/peer-atm3-w3-r1.md`）的五条 P1：评审的反例，加上同类的其他通道。
mod w3_peer_r1 {
    use super::w3d::{G1, G2, layout, manifest, run};
    use super::*;
    use atm_store::conversion::{
        self as cv, CompareOptions, Comparison, DryRun, DryRunOptions, Layout, Manifest,
        ManifestState, Quiesce, RunOptions, Seal, SealStep, Startup, Step, Verdict,
    };
    use std::os::windows::fs::OpenOptionsExt;

    fn opts(root: &Path) -> CompareOptions<'_> {
        CompareOptions {
            legacy_root: root,
            allow_real_data_root: false,
            real_data_root: None,
            secrets_check: Some(secrets_ok),
        }
    }

    fn judge(n: &Layout, m: &Manifest, root: &Path, cmp: &Comparison) -> Verdict {
        cv::judge(&cv::read_authority(n), m, root, cmp)
    }

    fn write_registry(root: &Path, description: &str) {
        Connection::open(root.join("registry/registry.sqlite"))
            .unwrap()
            .execute(
                "UPDATE projects SET description = ?1 WHERE id = 'P1'",
                [description],
            )
            .unwrap();
    }

    /// P1-01：UNKNOWN 下选「沿用 3.0」只放行当次。什么都没动、或者未登记的文件原样留着而业务表变了，
    /// 下一次比较的错误文本都和上次相同，照样冲突；去掉未登记的文件后，业务表的变化照常识别。
    #[test]
    fn an_unknown_choice_does_not_hide_later_2x_writes() {
        let (f, root) = json_fixture("w3r1-unknown");
        let n = layout(&f, "n");
        let m = run(&n, &root, G1, None).unwrap();
        put(&root.join("unexpected.txt"), b"unchanged unknown file");
        let cmp = cv::compare(&n, &m, &m.business_digest, &opts(&root));
        assert!(matches!(&cmp, Comparison::Unknown(_)), "{cmp:?}");
        let a = cv::choose_v3(&n, &m, &cmp, AT).unwrap();
        assert_eq!(a.accepted_source_digest, None);
        let again = || cv::compare(&n, &m, cv::baseline(&m, Some(&a)), &opts(&root));

        let same = again();
        assert_eq!(same, cmp);
        assert!(matches!(judge(&n, &m, &root, &same), Verdict::Conflict(_)));

        write_registry(&root, "written after the choice");
        let next = again();
        assert_eq!(next, cmp, "the same error text");
        assert!(matches!(judge(&n, &m, &root, &next), Verdict::Conflict(_)));

        fs::remove_file(root.join("unexpected.txt")).unwrap();
        match again() {
            Comparison::Changed { families, .. } => assert_eq!(families, ["r/projects"]),
            other => panic!("{other:?}"),
        }
    }

    /// P1-01 的另一条通道：读不了的源文件一直占着（同一个原因），其间业务表变了，照样冲突。
    #[test]
    fn an_unknown_choice_on_an_unreadable_source_does_not_hide_later_writes() {
        let (f, root) = json_fixture("w3r1-unreadable");
        let n = layout(&f, "n");
        let m = run(&n, &root, G1, None).unwrap();
        let held = fs::File::options()
            .read(true)
            .share_mode(0)
            .open(root.join("projects/P1/artifacts/notes.txt"))
            .unwrap();
        let cmp = cv::compare(&n, &m, &m.business_digest, &opts(&root));
        assert!(matches!(&cmp, Comparison::Unknown(_)), "{cmp:?}");
        let a = cv::choose_v3(&n, &m, &cmp, AT).unwrap();
        write_registry(&root, "written while the file was held");
        let next = cv::compare(&n, &m, cv::baseline(&m, Some(&a)), &opts(&root));
        assert_eq!(next, cmp);
        assert!(matches!(judge(&n, &m, &root, &next), Verdict::Conflict(_)));
        drop(held);
    }

    fn seal_intent(n: &Layout) -> PathBuf {
        n.root.join("runtime").join("seal.json")
    }

    fn sealed_target(n: &Layout) -> PathBuf {
        fs::read_dir(n.root.join("superseded"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path()
    }

    /// 封存到一半的现场：`N`、原件 `M` 与 `A` 的字节、封存前的发布物。
    struct HalfSealed(Layout, Vec<u8>, Vec<u8>, Vec<(String, String)>);

    /// 发布一次，读出原件 `M`、`A` 与发布物，再封存到「发布物已移走」处停下。
    fn sealed_up_to_moved(name: &str) -> HalfSealed {
        let (f, root) = json_fixture(name);
        let n = layout(&f, "n");
        run(&n, &root, G1, None).unwrap();
        let (m0, a0) = (
            fs::read(n.manifest()).unwrap(),
            fs::read(n.authority()).unwrap(),
        );
        let data = tree(&n.data());
        assert!(cv::seal_with(&n, Seal::Superseded, AT, &mut |s| s != SealStep::Moved).is_err());
        HalfSealed(n, m0, a0, data)
    }

    /// P1-02：封存目录里留着 `M`、`A` 写了一半的副本（早先的复制被打断）。重入时按原件重写，两份都逐字节完整，
    /// 之后才删原件和意图文件。
    #[test]
    fn a_resumed_seal_repairs_partial_copies() {
        let HalfSealed(n, m0, a0, data) = sealed_up_to_moved("w3r1-seal-partial");
        let target = sealed_target(&n);
        fs::write(target.join("conversion.json"), &m0[..13]).unwrap();
        fs::write(target.join("authority.json"), &a0[..9]).unwrap();
        assert_eq!(cv::decide(&n, true), Startup::ResumeSeal);
        let sealed = cv::seal(&n, Seal::Superseded, AT).unwrap();
        assert_eq!(sealed, target);
        assert_eq!(tree(&sealed.join("data")), data);
        assert_eq!(fs::read(sealed.join("conversion.json")).unwrap(), m0);
        assert_eq!(fs::read(sealed.join("authority.json")).unwrap(), a0);
        assert!(!n.manifest().exists() && !n.authority().exists());
        assert!(!seal_intent(&n).exists());
    }

    /// P1-02：`M` 的副本写好、`A` 的还没写时被杀。原件都还在；重入补齐 `A`。
    #[test]
    fn a_seal_killed_between_the_two_copies_completes() {
        let HalfSealed(n, m0, a0, _) = sealed_up_to_moved("w3r1-seal-between");
        assert!(
            cv::seal_with(&n, Seal::Superseded, AT, &mut |s| s
                != SealStep::ManifestCopied)
            .is_err()
        );
        let target = sealed_target(&n);
        assert_eq!(fs::read(target.join("conversion.json")).unwrap(), m0);
        assert!(!target.join("authority.json").exists());
        assert_eq!(fs::read(n.manifest()).unwrap(), m0);
        assert_eq!(fs::read(n.authority()).unwrap(), a0);
        let sealed = cv::seal(&n, Seal::Superseded, AT).unwrap();
        assert_eq!(fs::read(sealed.join("authority.json")).unwrap(), a0);
        assert!(!n.manifest().exists() && !n.authority().exists());
        assert!(!seal_intent(&n).exists());
    }

    /// P1-02：目标里是另一份完整内容（不是原件的前缀）就拒绝，不覆盖；副本落不下（这里是读不了目标）也一样。
    /// 两种情况原件与意图文件都留着，下次启动还是续做封存。
    #[test]
    fn a_seal_keeps_the_originals_when_a_copy_cannot_be_completed() {
        let HalfSealed(n, m0, a0, _) = sealed_up_to_moved("w3r1-seal-refuse");
        let target = sealed_target(&n);
        let other = br#"{"another":"complete manifest"}"#;
        fs::write(target.join("conversion.json"), other).unwrap();
        match cv::seal(&n, Seal::Superseded, AT) {
            Err(cv::Error::Refused(why)) => assert!(why.contains("different content"), "{why}"),
            other => panic!("{other:?}"),
        }
        assert_eq!(fs::read(target.join("conversion.json")).unwrap(), other);
        assert_eq!(fs::read(n.manifest()).unwrap(), m0);
        assert_eq!(fs::read(n.authority()).unwrap(), a0);
        assert_eq!(cv::decide(&n, true), Startup::ResumeSeal);

        fs::remove_file(target.join("conversion.json")).unwrap();
        fs::create_dir_all(target.join("authority.json")).unwrap();
        assert!(cv::seal(&n, Seal::Superseded, AT).is_err());
        assert_eq!(fs::read(target.join("conversion.json")).unwrap(), m0);
        assert_eq!(fs::read(n.manifest()).unwrap(), m0);
        assert_eq!(fs::read(n.authority()).unwrap(), a0);
        assert!(seal_intent(&n).exists());

        fs::remove_dir(target.join("authority.json")).unwrap();
        let sealed = cv::seal(&n, Seal::Superseded, AT).unwrap();
        assert_eq!(fs::read(sealed.join("authority.json")).unwrap(), a0);
        assert!(!seal_intent(&n).exists());
    }

    fn junction(alias: &Path, target: &Path) {
        let _ = fs::remove_dir(alias);
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(alias)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
    }

    fn dry(root: &Path, out: &Path, n: &Path) -> cv::Result<DryRun> {
        cv::dry_run(DryRunOptions {
            at: AT,
            source: root,
            out,
            v3_root: Some(n),
            allow_real_data_root: false,
            real_data_root: None,
            secrets_check: Some(secrets_ok),
            accept_unconvertible: &[],
            keep_data: false,
            quiesce: &mut || Quiesce::Quiet,
            after_copy: &mut || {},
        })
    }

    /// P1-03：dry-run 按真实位置判断输出目录与 `L`、`N` 的关系（两个方向）：经 junction 别名进入 `N` 或 `L`、
    /// 输出目录是尚不存在的 `N` 的祖先，都在动手之前拒绝，两个根一个字节都不变。阳性对照：放在两根之外照常成功。
    #[test]
    fn dry_run_checks_the_output_by_its_real_location() {
        let (f, root) = json_fixture("w3r1-dry-alias");
        let n = f.dir.join("n");
        put(&n.join("keep.txt"), b"3.0");
        let (before_l, before_n) = (tree(&root), tree(&n));
        let (to_n, to_l) = (f.dir.join("alias-n"), f.dir.join("alias-l"));
        junction(&to_n, &n);
        junction(&to_l, &root);
        let future = f.dir.join("future");
        for (out, v3, why) in [
            (
                to_n.join("dry-result"),
                n.clone(),
                "overlaps the 3.0 data root",
            ),
            (to_n.clone(), n.clone(), "overlaps the 3.0 data root"),
            (
                to_l.join("dry-result"),
                n.clone(),
                "overlaps the 2.x data root",
            ),
            (
                future.clone(),
                future.join("n"),
                "overlaps the 3.0 data root",
            ),
            // 还不存在的部分不经 canonicalize，大小写不同也是同一个目录。
            (
                f.dir.join("FUTURE").join("N").join("dry"),
                future.join("n"),
                "overlaps the 3.0 data root",
            ),
        ] {
            match dry(&root, &out, &v3) {
                Err(cv::Error::Refused(reason)) => assert!(reason.contains(why), "{reason}"),
                other => panic!("{}: {other:?}", out.display()),
            }
        }
        assert_eq!(tree(&root), before_l);
        assert_eq!(tree(&n), before_n);
        assert!(!future.exists());

        let fine = dry(&root, &f.dir.join("elsewhere"), &n).unwrap();
        assert!(matches!(fine, DryRun::Verified { .. }), "{fine:?}");
        assert!(f.dir.join("elsewhere/report.json").is_file());
        assert_eq!(tree(&n), before_n);
        fs::remove_dir(&to_n).unwrap();
        fs::remove_dir(&to_l).unwrap();
    }

    /// P1-04：S4 只认「读得出的实际摘要」等于「M 里合法的摘要」。M 的摘要为 null、缺字段、形状不对，
    /// PUBLISHED 却没有摘要，都是损坏的 M；摘要合法而发布文件读不出来也不算相等。这些都隔离，不进 FinishPublishing。
    #[test]
    fn s4_fails_closed_without_a_readable_matching_digest() {
        let (f, root) = json_fixture("w3r1-s4");
        let n = layout(&f, "n");
        assert!(run(&n, &root, G1, Some(Step::Renamed)).is_err());
        let good = fs::read_to_string(n.manifest()).unwrap();
        let digest = manifest(&n).publication_digest.unwrap();
        let quoted = format!("\"{digest}\"");
        for bad in [
            good.replace(&quoted, "null"),
            good.replace(&format!(",\"publication_digest\":{quoted}"), ""),
            good.replace(&digest, &digest.to_uppercase()),
            good.replace(&digest, &digest[..63]),
            good.replace(&quoted, "null")
                .replace("\"PUBLISHING\"", "\"PUBLISHED\""),
        ] {
            assert_ne!(bad, good);
            fs::write(n.manifest(), &bad).unwrap();
            assert_eq!(cv::read_manifest(&n), ManifestState::Corrupt, "{bad}");
            assert!(
                matches!(cv::decide(&n, true), Startup::Quarantine { .. }),
                "{bad}"
            );
        }
        fs::write(n.manifest(), &good).unwrap();
        let finish = Startup::FinishPublishing {
            generation: G1.into(),
        };
        assert_eq!(cv::decide(&n, true), finish);
        let held = fs::File::options()
            .read(true)
            .share_mode(0)
            .open(n.data().join("artifacts/P1/notes.txt"))
            .unwrap();
        assert!(matches!(cv::decide(&n, true), Startup::Quarantine { .. }));
        drop(held);
        assert_eq!(cv::decide(&n, true), finish);
    }

    fn run_dropping(n: &Layout, root: &Path, g: &str) -> cv::Result<Manifest> {
        cv::run(
            n,
            RunOptions {
                at: AT,
                generation: g,
                legacy_root: root,
                allow_real_data_root: false,
                real_data_root: None,
                secrets_check: Some(secrets_ok),
                accept_unconvertible: &["GGG"],
                hook: &mut |_| true,
                progress: None,
            },
        )
    }

    /// P1-05：舍弃许可绑定当时的项目目录内容（族 `dropped/<id>`）。原坏库不动，比较稳定；还没修好但内容动了是「变了」；
    /// 修好了（重试能恢复）比较得 UNKNOWN，拿舍弃许可转换被拒绝，不带许可转换恢复出修好后的数据。
    #[test]
    fn a_drop_permission_is_bound_to_the_dropped_content() {
        let (f, root) = settle_fixture("w3r1-dropped");
        let path = root.join("projects/P7/project.sqlite");
        empty_project(&path, "P7", "XXX", 10, Some("unconvertible old data"));
        let n = layout(&f, "n");
        let m = run_dropping(&n, &root, G1).unwrap();
        assert!(m.business_digest.contains_key("dropped/P7"), "{m:?}");
        let compare = || cv::compare(&n, &m, &m.business_digest, &opts(&root));
        assert!(matches!(compare(), Comparison::Unchanged(_)));

        Connection::open(&path)
            .unwrap()
            .execute(
                "UPDATE objectives SET title = 'edited, still unconvertible'",
                [],
            )
            .unwrap();
        match compare() {
            Comparison::Changed { families, .. } => assert_eq!(families, ["dropped/P7"]),
            other => panic!("{other:?}"),
        }

        Connection::open(&path)
            .unwrap()
            .execute("UPDATE project_meta SET project_code = 'GGG'", [])
            .unwrap();
        match compare() {
            Comparison::Unknown(why) => assert!(why.contains("can be recovered"), "{why}"),
            other => panic!("{other:?}"),
        }
        let again = layout(&f, "again");
        match run_dropping(&again, &root, G1) {
            Err(e) => assert!(e.to_string().contains("can be recovered"), "{e}"),
            Ok(m) => panic!("{m:?}"),
        }
        cv::discard_attempt(&again, G1).unwrap();
        run(&again, &root, G2, None).unwrap();
        assert_eq!(
            q::<String>(
                &Connection::open(again.database()).unwrap(),
                "SELECT title FROM objectives WHERE project_id = 'P7'"
            ),
            "edited, still unconvertible"
        );
    }

    /// W3 peer r2 P2-06：舍弃许可绑定的是库的内容，不是存储。转换时库开着 WAL、写入还在 WAL 里；
    /// 之后 checkpoint、关库、SHM 重建、VACUUM、ANALYZE、改回 DELETE 日志都是「没变」。
    /// 反过来：只在 WAL 里的业务写入、附件变化都是「变了」；把业务内容改回去又是「没变」。
    #[test]
    fn a_dropped_database_is_compared_by_content_not_storage() {
        let (f, root) = settle_fixture("w3-p206-storage");
        let path = root.join("projects/P7/project.sqlite");
        empty_project(&path, "P7", "XXX", 10, Some("unconvertible old data"));
        let c = Connection::open(&path).unwrap();
        c.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
             UPDATE objectives SET title = 'written into the WAL';",
        )
        .unwrap();
        assert!(
            fs::metadata(path.with_extension("sqlite-wal"))
                .unwrap()
                .len()
                > 0
        );
        let n = layout(&f, "n");
        let m = run_dropping(&n, &root, G1).unwrap();
        let compare = || cv::compare(&n, &m, &m.business_digest, &opts(&root));
        let unchanged = |step: &str| {
            let r = compare();
            assert!(matches!(r, Comparison::Unchanged(_)), "{step}: {r:?}");
        };
        let changed = |step: &str| match compare() {
            Comparison::Changed { families, .. } => assert_eq!(families, ["dropped/P7"], "{step}"),
            other => panic!("{step}: {other:?}"),
        };
        unchanged("baseline");
        c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
        unchanged("checkpoint");
        drop(c);
        assert!(!path.with_extension("sqlite-wal").exists());
        unchanged("close");
        Connection::open(&path)
            .unwrap()
            .execute_batch("SELECT count(*) FROM objectives;")
            .unwrap();
        unchanged("shm rebuilt");
        Connection::open(&path)
            .unwrap()
            .execute_batch("VACUUM;")
            .unwrap();
        unchanged("vacuum");
        Connection::open(&path)
            .unwrap()
            .execute_batch("ANALYZE; PRAGMA optimize;")
            .unwrap();
        unchanged("analyze");
        Connection::open(&path)
            .unwrap()
            .execute_batch("PRAGMA journal_mode = DELETE;")
            .unwrap();
        unchanged("journal mode");

        let c = Connection::open(&path).unwrap();
        c.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
             UPDATE objectives SET title = 'only in the WAL';",
        )
        .unwrap();
        changed("a write still in the WAL");
        c.execute_batch("UPDATE objectives SET title = 'written into the WAL';")
            .unwrap();
        unchanged("written back");
        drop(c);
        put(&root.join("projects/P7/artifacts/new.txt"), b"attachment");
        changed("an attachment");
    }

    /// W3 peer r2 P2-06：打不开的库绑定原始字节（库与非空的 -wal）：任何字节变化都是「变了」，
    /// 只有 -shm（WAL 的索引）不算。
    #[test]
    fn an_unreadable_dropped_database_is_bound_to_its_bytes() {
        let (f, root) = settle_fixture("w3-p206-raw");
        let path = root.join("projects/P7/project.sqlite");
        let mut bytes = b"SQLite format 3\0".to_vec();
        bytes.extend([0xA5u8; 200]);
        put(&path, &bytes);
        let n = layout(&f, "n");
        let m = run_dropping(&n, &root, G1).unwrap();
        let compare = || cv::compare(&n, &m, &m.business_digest, &opts(&root));
        assert!(matches!(compare(), Comparison::Unchanged(_)));
        put(&path.with_extension("sqlite-shm"), b"index");
        assert!(matches!(compare(), Comparison::Unchanged(_)));
        put(&path.with_extension("sqlite-wal"), b"frames");
        match compare() {
            Comparison::Changed { families, .. } => assert_eq!(families, ["dropped/P7"]),
            other => panic!("{other:?}"),
        }
        fs::remove_file(path.with_extension("sqlite-wal")).unwrap();
        assert!(matches!(compare(), Comparison::Unchanged(_)));
        bytes[100] ^= 1;
        put(&path, &bytes);
        match compare() {
            Comparison::Changed { families, .. } => assert_eq!(families, ["dropped/P7"]),
            other => panic!("{other:?}"),
        }
    }
}

/// W3 r2（peer 反例并入正式套件）：dry-run 期间把目录换成指向 `L` 或 `N` 的 junction。
mod w3_peer_r2 {
    use super::*;
    use atm_store::conversion::{self as cv, DryRun, DryRunOptions, Quiesce};

    fn junction(alias: &Path, target: &Path) {
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(alias)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "mklink /J {}", alias.display());
    }

    /// 目录集合（相对路径；链接本身记成 `-> link`，不进入）。
    fn dirs(dir: &Path) -> Vec<String> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in fs::read_dir(&d).unwrap() {
                let e = e.unwrap();
                let p = e.path();
                let rel = p
                    .strip_prefix(dir)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                let kind = e.file_type().unwrap();
                if kind.is_symlink() {
                    out.push(format!("{rel} -> link"));
                } else if kind.is_dir() {
                    out.push(rel);
                    stack.push(p);
                }
            }
        }
        out.sort();
        out
    }

    /// 内容（每个文件的 sha256）与目录集合。
    fn state(dir: &Path) -> (Vec<(String, String)>, Vec<String>) {
        let mut files = tree(dir);
        files.sort();
        (files, dirs(dir))
    }

    fn dry(
        root: &Path,
        out: &Path,
        n: &Path,
        quiesce: &mut dyn FnMut() -> Quiesce,
        after_copy: &mut dyn FnMut(),
    ) -> cv::Result<DryRun> {
        cv::dry_run(DryRunOptions {
            at: AT,
            source: root,
            out,
            v3_root: Some(n),
            allow_real_data_root: false,
            real_data_root: None,
            secrets_check: Some(secrets_ok),
            accept_unconvertible: &[],
            keep_data: false,
            quiesce,
            after_copy,
        })
    }

    /// 一个夹具：`L`（json 数据根）与一个有内容的 `N`（含 `data/`），两个根各自的初始状态。
    fn roots(name: &str) -> (Fixture, PathBuf, PathBuf) {
        let (f, root) = json_fixture(name);
        let n = f.dir.join("protected-n");
        put(&n.join("keep.txt"), b"existing N");
        put(
            &n.join("data/existing-business.txt"),
            b"existing published business data",
        );
        (f, root, n)
    }

    /// 反例一及其变体：静止判定（quiesce）里把输出目录的父目录、更上层的缺失祖先、输出目录自己换成指向
    /// `N` 或 `L` 的 junction，或者在空的输出目录里放进指向它们的 junction。dry-run 按钉住时的真实位置
    /// 再查一次，一律拒绝；两个根的内容与目录集合都不变，也没有在里面建出任何目录。
    #[test]
    fn a_swap_before_pinning_is_refused() {
        let (f, root, n) = roots("w3r2-swap-before");
        let before = (state(&root), state(&n));
        for (label, target, why) in [
            ("n", n.clone(), "overlaps the 3.0 data root"),
            ("l", root.clone(), "overlaps the 2.x data root"),
        ] {
            // 父目录存在、输出目录不存在：父目录被换。
            let parent = f.dir.join(format!("out-parent-{label}"));
            fs::create_dir(&parent).unwrap();
            let parked = f.dir.join(format!("parked-parent-{label}"));
            let result = dry(
                &root,
                &parent.join("dry-result"),
                &n,
                &mut || {
                    fs::rename(&parent, &parked).unwrap();
                    junction(&parent, &target);
                    Quiesce::Quiet
                },
                &mut || {},
            );
            let created = target.join("dry-result").exists();
            fs::remove_dir(&parent).unwrap();
            assert!(
                matches!(&result, Err(cv::Error::Refused(r)) if r.contains(why)),
                "{label} parent: {result:?}"
            );
            assert!(!created, "{label}: created a directory inside the root");

            // 好几层都不存在：最上面那一层被放成 junction。
            let gone = f.dir.join(format!("gone-{label}"));
            let result = dry(
                &root,
                &gone.join("deep").join("dry"),
                &n,
                &mut || {
                    junction(&gone, &target);
                    Quiesce::Quiet
                },
                &mut || {},
            );
            let created = target.join("deep").exists();
            fs::remove_dir(&gone).unwrap();
            assert!(
                matches!(&result, Err(cv::Error::Refused(r)) if r.contains(why)),
                "{label} missing ancestor: {result:?}"
            );
            assert!(!created, "{label}: created a directory inside the root");

            // 输出目录已存在且是空的：它自己被换。
            let out = f.dir.join(format!("empty-out-{label}"));
            fs::create_dir(&out).unwrap();
            let parked = f.dir.join(format!("parked-out-{label}"));
            let result = dry(
                &root,
                &out,
                &n,
                &mut || {
                    fs::rename(&out, &parked).unwrap();
                    junction(&out, &target);
                    Quiesce::Quiet
                },
                &mut || {},
            );
            fs::remove_dir(&out).unwrap();
            assert!(
                matches!(&result, Err(cv::Error::Refused(r)) if r.contains(why)),
                "{label} out itself: {result:?}"
            );

            // 空的输出目录里被放进一个指向根的 `src`。
            fs::rename(&parked, &out).unwrap();
            let result = dry(
                &root,
                &out,
                &n,
                &mut || {
                    junction(&out.join("src"), &target);
                    Quiesce::Quiet
                },
                &mut || {},
            );
            fs::remove_dir(out.join("src")).unwrap();
            assert!(
                matches!(&result, Err(cv::Error::Refused(r)) if r.contains("is not empty")),
                "{label} planted src: {result:?}"
            );
            assert_eq!((state(&root), state(&n)), before, "{label}");
        }
        // 阳性对照：没人动手时照常成功。
        let out = f.dir.join("out-parent-n").join("dry-result");
        let fine = dry(&root, &out, &n, &mut || Quiesce::Quiet, &mut || {}).unwrap();
        assert!(matches!(fine, DryRun::Verified { .. }), "{fine:?}");
        assert!(out.join("report.json").is_file());
        assert_eq!((state(&root), state(&n)), before);
    }

    /// 反例二及其变体：复制之后（after_copy）把输出目录的父目录、输出目录自己、`src` 与 `src` 下的目录改名，
    /// 再在原处放上指向 `N` 或 `L` 的 junction。钉住的目录改不了名，所以一个都换不成；dry-run 照常完成，
    /// 报告写在原来的输出目录里，清理只删本次建的 `src` 与 `data`，两个根的内容与目录集合都不变。
    #[test]
    fn pinned_directories_cannot_be_swapped_mid_run() {
        let (f, root, n) = roots("w3r2-swap-mid");
        let before = (state(&root), state(&n));
        for (label, target) in [("n", n.clone()), ("l", root.clone())] {
            let parent = f.dir.join(format!("outer-{label}"));
            let out = parent.join("dry");
            let victims = [
                parent.clone(),
                out.clone(),
                out.join("src"),
                out.join("src").join("dispatch"),
                out.join("src").join("dispatch").join("logs"),
            ];
            let mut swapped = Vec::new();
            let result = dry(&root, &out, &n, &mut || Quiesce::Quiet, &mut || {
                for (i, victim) in victims.iter().enumerate() {
                    assert!(victim.is_dir(), "{} should exist by now", victim.display());
                    let parked = f.dir.join(format!("parked-{label}-{i}"));
                    if fs::rename(victim, &parked).is_ok() {
                        junction(victim, &target);
                        swapped.push(victim.clone());
                    }
                }
            });
            for victim in &swapped {
                let _ = fs::remove_dir(victim);
            }
            assert!(swapped.is_empty(), "{label}: swapped {swapped:?}");
            assert!(
                matches!(result, Ok(DryRun::Verified { .. })),
                "{label}: {result:?}"
            );
            assert!(out.join("report.json").is_file());
            assert!(!out.join("src").exists() && !out.join("data").exists());
            assert_eq!((state(&root), state(&n)), before, "{label}");
        }
    }

    /// `data` 的名字在建之前被占成指向根的 junction：排他新建失败，不经它写入；`src` 照样清掉，
    /// junction 只是留着（不是本次建的），根不变。
    #[test]
    fn a_planted_data_name_fails_closed() {
        let (f, root, n) = roots("w3r2-planted-data");
        let before = (state(&root), state(&n));
        for (label, target) in [("n", n.clone()), ("l", root.clone())] {
            let out = f.dir.join(format!("out-{label}"));
            let result = dry(&root, &out, &n, &mut || Quiesce::Quiet, &mut || {
                junction(&out.join("data"), &target)
            });
            let report = out.join("report.json").exists();
            let src = out.join("src").exists();
            fs::remove_dir(out.join("data")).unwrap();
            assert!(
                matches!(&result, Err(cv::Error::Io(e)) if e.kind() == std::io::ErrorKind::AlreadyExists),
                "{label}: {result:?}"
            );
            assert!(!report && !src, "{label}: report {report}, src {src}");
            assert_eq!((state(&root), state(&n)), before, "{label}");
        }
    }

    /// 报告的临时文件名被占成指向 `N` 里文件的硬链接：排他新建失败，不经硬链接写进 `N`。
    #[test]
    fn a_planted_report_name_fails_closed() {
        let (f, root, n) = roots("w3r2-planted-report");
        let before = (state(&root), state(&n));
        let out = f.dir.join("out");
        let temporary = out.join(format!("report.json.{}.tmp", std::process::id()));
        let result = dry(&root, &out, &n, &mut || Quiesce::Quiet, &mut || {
            fs::hard_link(n.join("keep.txt"), &temporary).unwrap()
        });
        fs::remove_file(&temporary).unwrap();
        assert!(
            matches!(&result, Err(cv::Error::Io(e)) if e.kind() == std::io::ErrorKind::AlreadyExists),
            "{result:?}"
        );
        assert!(!out.join("report.json").exists());
        assert!(!out.join("src").exists() && !out.join("data").exists());
        assert_eq!((state(&root), state(&n)), before);
    }

    /// W3 r4 P2-R4-01：一份副本被别的程序一直开着（不共享删除），清理退避重试之后把它与它的祖先原样留下，
    /// `left` 写出的是那个文件；放开之后照常能删。
    #[test]
    fn a_busy_copy_is_left_and_named() {
        use std::os::windows::fs::OpenOptionsExt;
        let (f, root, n) = roots("w3r4-busy");
        let out = f.dir.join("out");
        let copy = out.join("src").join("dispatch").join("config.json");
        let mut holder: Option<fs::File> = None;
        let result = dry(&root, &out, &n, &mut || Quiesce::Quiet, &mut || {
            holder = Some(
                fs::OpenOptions::new()
                    .read(true)
                    .share_mode(1)
                    .open(&copy)
                    .unwrap(),
            );
        });
        let Err(cv::Error::CleanupIncomplete { left, outcome }) = &result else {
            panic!("{result:?}");
        };
        assert!(outcome.contains("Verified"), "{outcome}");
        assert_eq!(left.len(), 1, "{left:?}");
        assert!(left[0].contains("config.json"), "{left:?}");
        assert!(copy.is_file() && out.join("src").is_dir());
        drop(holder);
        fs::remove_dir_all(out.join("src")).unwrap();
    }

    /// W3 r4 P2-R4-01：杀毒、索引这类短暂占用不算「留下」。副本在清理开始之后还被开着约 300 毫秒，
    /// 清理退避重试，照常删掉，结果是 Verified。
    #[test]
    fn a_briefly_busy_copy_is_still_removed() {
        use std::os::windows::fs::OpenOptionsExt;
        let (f, root, n) = roots("w3r4-brief");
        let out = f.dir.join("out");
        let copy = out.join("src").join("dispatch").join("config.json");
        let last_report = out.join("attachment.jsonl");
        let mut holder: Option<std::thread::JoinHandle<()>> = None;
        let result = dry(&root, &out, &n, &mut || Quiesce::Quiet, &mut || {
            let file = fs::OpenOptions::new()
                .read(true)
                .share_mode(1)
                .open(&copy)
                .unwrap();
            let last_report = last_report.clone();
            holder = Some(std::thread::spawn(move || {
                // 报告写完之后立刻就是清理：再开着它 300 毫秒。
                while !last_report.exists() {
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
                std::thread::sleep(std::time::Duration::from_millis(300));
                drop(file);
            }));
        });
        holder.unwrap().join().unwrap();
        assert!(matches!(result, Ok(DryRun::Verified { .. })), "{result:?}");
        assert!(!out.join("src").exists());
    }

    /// W3 r3 P1-R3-01：清理只删本次建的东西。`src` 里被放进的 junction（指向 L、N）、挪进来的一个已有目录、
    /// 被换掉的副本文件都原样留下，结果是 `CleanupIncomplete`（不是成功）；L 与 N 不变。成功、源未静止、
    /// 副本被换三条路都一样。
    #[test]
    fn cleanup_leaves_what_it_did_not_create() {
        let (f, root, n) = roots("w3r3-cleanup");
        let before_n = state(&n);
        for (label, noisy, swap) in [
            ("quiet", false, false),
            ("noisy", true, false),
            ("swapped", false, true),
        ] {
            let out = f.dir.join(format!("out-{label}"));
            let incoming = f.dir.join(format!("incoming-{label}"));
            put(&incoming.join("business.txt"), b"pre-existing content");
            let dispatch = root.join("dispatch/config.json");
            let original = fs::read(&dispatch).unwrap();
            let before_l = state(&root);
            let src = out.join("src");
            let result = dry(&root, &out, &n, &mut || Quiesce::Quiet, &mut || {
                junction(&src.join("planted-n"), &n);
                junction(&src.join("dispatch").join("planted-l"), &root);
                fs::rename(&incoming, src.join("dispatch").join("moved-in")).unwrap();
                if swap {
                    let copy = src.join("dispatch").join("config.json");
                    fs::remove_file(&copy).unwrap();
                    fs::write(&copy, b"theirs").unwrap();
                }
                if noisy {
                    fs::write(&dispatch, b"{}").unwrap();
                }
            });
            if noisy {
                fs::write(&dispatch, &original).unwrap();
            }
            let Err(cv::Error::CleanupIncomplete { left, outcome }) = &result else {
                panic!("{label}: {result:?}");
            };
            assert!(!left.is_empty(), "{label}");
            let expected = if noisy || swap {
                "SourceNotQuiet"
            } else {
                "Verified"
            };
            assert!(outcome.contains(expected), "{label}: {outcome}");
            assert_eq!(
                fs::read(src.join("dispatch/moved-in/business.txt")).unwrap(),
                b"pre-existing content",
                "{label}"
            );
            if swap {
                assert_eq!(
                    fs::read(src.join("dispatch/config.json")).unwrap(),
                    b"theirs"
                );
            } else {
                assert!(
                    !src.join("dispatch/config.json").exists(),
                    "{label}: our copy is removed"
                );
            }
            for link in [src.join("planted-n"), src.join("dispatch/planted-l")] {
                assert!(
                    fs::symlink_metadata(&link)
                        .unwrap()
                        .file_type()
                        .is_symlink(),
                    "{label}"
                );
                fs::remove_dir(&link).unwrap();
            }
            assert_eq!(state(&root), before_l, "{label}");
            assert_eq!(state(&n), before_n, "{label}");
        }
    }
}

/// W3 peer r2 P2-07：演练对 `L` 原样走正式的 dry-run、完整转换、启动判定与比较；任何一步不是正式意义上的通过就停下。
mod w3_gate_rehearse {
    use super::w3d::{G1, layout, run};
    use super::*;
    use atm_store::conversion::{self as cv, Comparison, RehearseOptions, RehearseStop};

    fn rehearse(
        root: &Path,
        work: &Path,
        before: &mut dyn FnMut(&str),
    ) -> Result<cv::Rehearsal, RehearseStop> {
        cv::rehearse(RehearseOptions {
            at: AT,
            source: root,
            work,
            generation: G1,
            allow_real_data_root: false,
            real_data_root: None,
            secrets_check: Some(secrets_ok),
            before,
        })
    }

    /// peer 的反例：知识库恢复没提交、回滚前的库在 `backups\knowledge\` 里。演练与正式转换得到同一份业务结果，
    /// 附件路径同样映射进 `data\artifacts\`（演练不另做副本，原路径身份保留）。
    #[test]
    fn a_rehearsal_converts_the_root_as_it_is() {
        let (f, root) = json_fixture("w3-p207-formal");
        let previous = root.join(format!("backups/knowledge/before-restore-{KJ}.sqlite"));
        fs::copy(root.join("knowledge/knowledge.sqlite"), &previous).unwrap();
        Connection::open(&previous)
            .unwrap()
            .execute(
                "UPDATE knowledge_entries SET slug = 'pre-restore-business'",
                [],
            )
            .unwrap();
        put(
            &root.join("knowledge/restore.json"),
            format!("{{\"id\":\"{KJ}\",\"committed\":false}}").as_bytes(),
        );
        let formal = layout(&f, "formal-n");
        run(&formal, &root, G1, None).unwrap();
        let read = |db: &Path| {
            let c = Connection::open(db).unwrap();
            (
                q::<String>(&c, "SELECT slug FROM knowledge_entries WHERE id = 'K1'"),
                q::<String>(
                    &c,
                    "SELECT local_path FROM artifacts WHERE project_id = 'P1' AND id = 'A1'",
                ),
            )
        };
        let expected = read(&formal.database());
        assert_eq!(expected.0, "pre-restore-business");

        let work = f.dir.join("rehearse");
        let mut steps = Vec::new();
        let r = rehearse(&root, &work, &mut |s| steps.push(s.to_string())).unwrap();
        assert_eq!(steps, ["dry-run", "run", "compare"]);
        assert!(
            r.files
                .contains(&format!("backups/knowledge/before-restore-{KJ}.sqlite"))
        );
        assert_eq!(r.dry_run_digest, r.manifest.business_digest);
        assert_eq!(read(&r.layout.database()), expected);
    }

    /// 每一种停下都是失败：未登记的条目在枚举时拒绝（一步都不做）；dry-run 与完整转换之间 `L` 变了是 Moved；
    /// 转换之后、比较之前变了是 Compare。
    #[test]
    fn a_rehearsal_stops_at_the_first_failure() {
        let (f, root) = json_fixture("w3-p207-stops");
        let knowledge = root.join("knowledge/knowledge.sqlite");
        let edit = |slug: &str| {
            Connection::open(&knowledge)
                .unwrap()
                .execute(
                    "UPDATE knowledge_entries SET slug = ?1 WHERE id = 'K1'",
                    [slug],
                )
                .unwrap();
        };

        let stray = root.join("projects/P1/project.sqlite.pre-T-1.bak");
        put(&stray, b"a hand-made backup");
        let mut steps = Vec::new();
        let work = f.dir.join("refused");
        match rehearse(&root, &work, &mut |s| steps.push(s.to_string())) {
            Err(RehearseStop::Refused(e)) => assert!(e.to_string().contains("pre-T-1.bak"), "{e}"),
            other => panic!("{other:?}"),
        }
        assert!(steps.is_empty() && !work.exists());
        fs::remove_file(&stray).unwrap();

        let work = f.dir.join("moved");
        let r = rehearse(&root, &work, &mut |s| {
            if s == "run" {
                edit("moved between the snapshots");
            }
        });
        match r {
            Err(RehearseStop::Moved(families)) => {
                assert!(
                    families.iter().any(|f| f.contains("knowledge")),
                    "{families:?}"
                )
            }
            other => panic!("{other:?}"),
        }

        let work = f.dir.join("changed");
        let r = rehearse(&root, &work, &mut |s| {
            if s == "compare" {
                edit("moved after the conversion");
            }
        });
        match r {
            Err(RehearseStop::Compare(c)) => match *c {
                Comparison::Changed { families, .. } => assert!(
                    families.iter().any(|f| f.contains("knowledge")),
                    "{families:?}"
                ),
                other => panic!("{other:?}"),
            },
            other => panic!("{other:?}"),
        }
    }

    /// dry-run 不通过就停，不做完整转换：2.0 救不回来、用户也没点名舍弃的项目。
    #[test]
    fn a_rehearsal_stops_when_the_dry_run_does_not_verify() {
        let (f, root) = settle_fixture("w3-p207-dry");
        let p7 = root.join("projects/P7/project.sqlite");
        empty_project(&p7, "P7", "XXX", 10, Some("unconvertible old data"));
        let mut steps = Vec::new();
        let work = f.dir.join("rehearse");
        match rehearse(&root, &work, &mut |s| steps.push(s.to_string())) {
            Err(RehearseStop::DryRun(why)) => assert!(why.contains("GGG"), "{why}"),
            other => panic!("{other:?}"),
        }
        assert_eq!(steps, ["dry-run"]);
        assert!(!work.join("n").exists());
    }
}
