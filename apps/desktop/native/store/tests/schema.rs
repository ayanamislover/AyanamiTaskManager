//! schema v1 的结构性验收（W1a）：一致性、迁移登记、复合键隔离、延迟外键、调用索引、不可变修订。

use atm_store::{MIGRATIONS, StoreError, open, schema_version};
use rusqlite::{Connection, params};
use std::path::PathBuf;

/// 测试库放在 target 下（遵守 CARGO_TARGET_DIR），每个用例一个目录，开始前清空。
fn db_path(name: &str) -> PathBuf {
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("target")
        });
    let dir = target.join("store-tests").join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("atm.sqlite")
}

fn fresh(name: &str) -> Connection {
    open(&db_path(name)).unwrap()
}

const T: &str = "2026-10-03T00:00:00.000Z";

fn generation(c: &Connection, g: i64, kind: &str, scope: &str) {
    c.execute(
        "INSERT INTO scope_generations (gen, scope_kind, scope_id, reason, epoch, created_at) VALUES (?1, ?2, ?3, 'CREATED', ?4, ?5)",
        params![g, kind, scope, format!("E{g}"), T],
    )
    .unwrap();
}

/// 一个项目：projects 行、一个 objective（local_no 1）、一个 agent、一个 session。
fn project(c: &Connection, id: &str, code: &str, g: i64) {
    generation(c, g, "PROJECT", id);
    c.execute(
        "INSERT INTO projects (id, code, name, lifecycle, scope_gen, epoch, created_at, updated_at) VALUES (?1, ?2, ?1, 'ACTIVE', ?3, 'E', ?4, ?4)",
        params![id, code, g, T],
    )
    .unwrap();
    c.execute(
        "INSERT INTO objectives (project_id, id, local_no, title, status, created_at, updated_at) VALUES (?1, 'OBJ', 1, 'o', 'ACTIVE', ?2, ?2)",
        params![id, T],
    )
    .unwrap();
    c.execute(
        "INSERT INTO agents (project_id, id, display_name, client_kind, created_at, updated_at) VALUES (?1, 'claude', 'Claude', 'cli', ?2, ?2)",
        params![id, T],
    )
    .unwrap();
    c.execute(
        "INSERT INTO agent_sessions (project_id, id, agent_id, role, work_state, connection_state, started_at, updated_at)
         VALUES (?1, 'S1', 'claude', 'PRIMARY', 'IDLE', 'ONLINE', ?2, ?2)",
        params![id, T],
    )
    .unwrap();
}

fn work_item(c: &Connection, project: &str, id: &str, local_no: i64) -> rusqlite::Result<usize> {
    c.execute(
        "INSERT INTO work_items (project_id, id, local_no, objective_id, type, title, status, priority, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'OBJ', 'TASK', 't', 'BACKLOG', 'NORMAL', ?4, ?4)",
        params![project, id, local_no, T],
    )
}

fn event(c: &Connection, project: &str, seq: i64, id: &str) -> rusqlite::Result<usize> {
    c.execute(
        "INSERT INTO events (project_id, seq, id, type, actor_type, actor_id, aggregate_type, aggregate_id, payload_json, created_at)
         VALUES (?1, ?2, ?3, 'work.created', 'AGENT', 'claude', 'WORK_ITEM', 'W', '{}', ?4)",
        params![project, seq, id, T],
    )
}

fn is_constraint(r: rusqlite::Result<usize>) -> bool {
    matches!(r, Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::ConstraintViolation)
}

/// 违反的是哪一条约束：SQLite 的报错里带着约束文本或索引列。
fn violates(r: rusqlite::Result<usize>, needle: &str) -> bool {
    matches!(&r, Err(rusqlite::Error::SqliteFailure(e, Some(m)))
        if e.code == rusqlite::ErrorCode::ConstraintViolation && m.contains(needle))
}

fn integrity(c: &Connection) -> (String, usize) {
    let ok: String = c
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .unwrap();
    let fk = c
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .query_map([], |_| Ok(()))
        .unwrap()
        .count();
    (ok, fk)
}

#[test]
fn a_fresh_database_is_consistent_and_registered() {
    let c = fresh("fresh");
    assert_eq!(integrity(&c), ("ok".into(), 0));
    assert_eq!(schema_version(&c).unwrap(), Some(1));
    let journal: String = c
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    assert_eq!(journal.to_ascii_lowercase(), "wal");
    let fk: i64 = c
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .unwrap();
    assert_eq!(fk, 1);
    for table in [
        "app_meta",
        "scope_generations",
        "projects",
        "global_feed",
        "knowledge_entries",
        "work_items",
        "events",
        "idempotency_receipts",
        "search_docs",
        "search_fts",
        "knowledge_fts",
        "backups",
    ] {
        let n: i64 = c
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name = ?1",
                [table],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "{table}");
    }
    // 05 里被取代的表不应存在。
    for gone in [
        "project_idempotency",
        "global_idempotency",
        "idempotency_tombstones",
        "global_events",
    ] {
        let n: i64 = c
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name = ?1",
                [gone],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0, "{gone} should be superseded");
    }
}

#[test]
fn reopening_does_not_reapply_migrations() {
    let path = db_path("reopen");
    drop(open(&path).unwrap());
    let c = open(&path).unwrap();
    let n: i64 = c
        .query_row("SELECT count(*) FROM schema_migrations", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, MIGRATIONS.len() as i64);
}

#[test]
fn an_applied_migration_whose_text_changed_is_refused() {
    let path = db_path("tamper");
    let c = open(&path).unwrap();
    c.execute(
        "UPDATE schema_migrations SET sha256 = 'x' WHERE version = 1",
        [],
    )
    .unwrap();
    drop(c);
    assert!(matches!(open(&path), Err(StoreError::MigrationMismatch(_))));

    let path = db_path("newer");
    let c = open(&path).unwrap();
    c.execute(
        "INSERT INTO schema_migrations VALUES (99, 'future', 'y', ?1)",
        [T],
    )
    .unwrap();
    drop(c);
    assert!(matches!(open(&path), Err(StoreError::MigrationMismatch(_))));
}

#[test]
fn two_projects_may_share_local_numbers_seqs_and_ids() {
    let c = fresh("two-projects");
    project(&c, "P", "PAA", 1);
    project(&c, "Q", "QBB", 2);
    // 相同的本地 key、seq、agent id、session id 在两个项目里互不冲突。
    assert!(work_item(&c, "P", "W1", 1).is_ok());
    assert!(work_item(&c, "Q", "W1", 1).is_ok());
    assert!(event(&c, "P", 1, "EV1").is_ok());
    assert!(event(&c, "Q", 1, "EV1").is_ok());
    // 同一项目里仍然唯一。
    assert!(
        is_constraint(work_item(&c, "P", "W2", 1)),
        "duplicate local_no in P"
    );
    assert!(
        is_constraint(work_item(&c, "P", "W1", 2)),
        "duplicate id in P"
    );
    assert!(
        is_constraint(event(&c, "P", 1, "EV2")),
        "duplicate seq in P"
    );
    assert!(
        is_constraint(event(&c, "P", 2, "EV1")),
        "duplicate event id in P"
    );
    // 跨项目引用不成立：Q 的任务挂不到 P 的 objective 上（复合 FK）。
    c.execute("INSERT INTO objectives (project_id, id, local_no, title, status, created_at, updated_at) VALUES ('P', 'ONLY_P', 2, 'o', 'ACTIVE', ?1, ?1)", [T]).unwrap();
    c.execute_batch("BEGIN").unwrap();
    c.execute(
        "INSERT INTO work_items (project_id, id, local_no, objective_id, type, title, status, priority, created_at, updated_at)
         VALUES ('Q', 'W9', 9, 'ONLY_P', 'TASK', 't', 'BACKLOG', 'NORMAL', ?1, ?1)",
        [T],
    )
    .unwrap();
    assert!(
        c.execute_batch("COMMIT").is_err(),
        "cross-project FK must fail at commit"
    );
    c.execute_batch("ROLLBACK").unwrap();
    assert_eq!(integrity(&c), ("ok".into(), 0));
}

#[test]
fn composite_foreign_keys_are_checked_at_commit() {
    let c = fresh("deferred");
    project(&c, "P", "PAA", 1);
    // 先插子行、后插父行：同一个事务里允许（转换和按范围恢复依赖这一点）。
    c.execute_batch("BEGIN").unwrap();
    c.execute(
        "INSERT INTO work_items (project_id, id, local_no, parent_id, objective_id, type, title, status, priority, created_at, updated_at)
         VALUES ('P', 'CHILD', 2, 'PARENT', 'OBJ', 'TASK', 't', 'BACKLOG', 'NORMAL', ?1, ?1)",
        [T],
    )
    .unwrap();
    work_item(&c, "P", "PARENT", 1).unwrap();
    c.execute_batch("COMMIT").unwrap();
    // 父行始终不出现：提交失败。
    c.execute_batch("BEGIN").unwrap();
    c.execute(
        "INSERT INTO work_items (project_id, id, local_no, parent_id, objective_id, type, title, status, priority, created_at, updated_at)
         VALUES ('P', 'ORPHAN', 3, 'NOBODY', 'OBJ', 'TASK', 't', 'BACKLOG', 'NORMAL', ?1, ?1)",
        [T],
    )
    .unwrap();
    assert!(c.execute_batch("COMMIT").is_err());
    c.execute_batch("ROLLBACK").unwrap();
    // 引用不存在的 scope generation 的项目同样提交失败。
    c.execute_batch("BEGIN").unwrap();
    c.execute("INSERT INTO projects (id, code, name, lifecycle, scope_gen, epoch, created_at, updated_at) VALUES ('R', 'RCC', 'R', 'ACTIVE', 77, 'E', ?1, ?1)", [T]).unwrap();
    assert!(c.execute_batch("COMMIT").is_err());
    c.execute_batch("ROLLBACK").unwrap();
}

#[test]
fn only_three_project_lifecycles_are_persisted() {
    let c = fresh("lifecycle");
    generation(&c, 1, "PROJECT", "P");
    for (i, state) in ["RESTORING", "CREATING", "MIGRATION_FAILED"]
        .iter()
        .enumerate()
    {
        let r = c.execute(
            "INSERT INTO projects (id, code, name, lifecycle, scope_gen, epoch, created_at, updated_at) VALUES (?1, ?1, 'x', ?2, 1, 'E', ?3, ?3)",
            params![format!("X{i}"), state, T],
        );
        assert!(is_constraint(r), "{state}");
    }
    for (i, state) in ["ACTIVE", "ARCHIVED", "TRASHED"].iter().enumerate() {
        c.execute(
            "INSERT INTO projects (id, code, name, lifecycle, scope_gen, epoch, created_at, updated_at) VALUES (?1, ?1, 'x', ?2, 1, 'E', ?3, ?3)",
            params![format!("Y{i}"), state, T],
        )
        .unwrap();
    }
}

/// 一条回执；`call` 为 Some((kind, id, operation)) 时是调用索引行。
/// 项目、知识库回执记在世代 1 上；GLOBAL 回执没有世代。
fn receipt(
    c: &Connection,
    scope: (&str, &str),
    ns: Option<(&str, &str)>,
    op_id: Option<&str>,
    legacy_key: Option<&str>,
    call: Option<(&str, &str, &str)>,
) -> rusqlite::Result<usize> {
    c.execute(
        "INSERT INTO idempotency_receipts
           (scope_kind, scope_id, ns_kind, ns_id, op_id, legacy_key, operation, fp_v, fp_family, fingerprint,
            receipt_json, scope_generation, created_at, call_principal_kind, call_principal_id, call_operation)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'op', 2, 'canon-v2', 'fp', '{}',
                 CASE WHEN ?1 = 'GLOBAL' THEN NULL ELSE 1 END, ?7, ?8, ?9, ?10)",
        params![
            scope.0,
            scope.1,
            ns.map(|n| n.0),
            ns.map(|n| n.1),
            op_id,
            legacy_key,
            T,
            call.map(|x| x.0),
            call.map(|x| x.1),
            call.map(|x| x.2)
        ],
    )
}

#[test]
fn the_call_index_is_four_raw_columns_and_global() {
    let c = fresh("call-index");
    project(&c, "P", "PAA", 1);
    project(&c, "Q", "QBB", 2);
    let call = |scope: (&str, &str), kind: &str, id: &str, operation: &str, op_id: &str| {
        receipt(
            &c,
            scope,
            Some(("CALL", id)),
            Some(op_id),
            None,
            Some((kind, id, operation)),
        )
    };
    // 冒号不会造成歧义：(a:b, c) 与 (a, b:c) 是两个键。
    assert!(call(("PROJECT", "P"), "AGENT", "a:b", "begin", "c").is_ok());
    assert!(call(("PROJECT", "P"), "AGENT", "a", "begin", "b:c").is_ok());
    // 同一个四元组只能有一行，而且不论落在哪个 scope（唯一性不含 scope）。
    assert!(is_constraint(call(
        ("PROJECT", "Q"),
        "AGENT",
        "a:b",
        "begin",
        "c"
    )));
    assert!(violates(
        call(("GLOBAL", "GLOBAL"), "AGENT", "a:b", "begin", "c"),
        "UNIQUE constraint failed: idempotency_receipts.call_principal_kind"
    ));
    // operation 不同、kind 不同都是不同的键。
    assert!(call(("PROJECT", "Q"), "AGENT", "a:b", "project.create", "c").is_ok());
    assert!(call(("PROJECT", "Q"), "USER", "a:b", "begin", "c").is_ok());
    // CALL 行四列必须齐全；非 CALL 行不能带调用索引列；CALL 的 ns_id 必须等于 principal_id。
    assert!(is_constraint(receipt(
        &c,
        ("PROJECT", "P"),
        Some(("CALL", "z")),
        Some("x1"),
        None,
        None
    )));
    assert!(is_constraint(receipt(
        &c,
        ("PROJECT", "P"),
        Some(("SESSION", "S1")),
        Some("x2"),
        None,
        Some(("AGENT", "S1", "begin"))
    )));
    assert!(is_constraint(receipt(
        &c,
        ("PROJECT", "P"),
        Some(("CALL", "other")),
        Some("x3"),
        None,
        Some(("AGENT", "z", "begin"))
    )));
    // 普通命名空间行不能只带一半调用列（主体有、操作没有）：主体列只属于 CALL 行。
    let half = c.execute(
        "INSERT INTO idempotency_receipts
           (scope_kind, scope_id, ns_kind, ns_id, op_id, operation, fp_v, fp_family, fingerprint,
            receipt_json, scope_generation, created_at, call_principal_kind, call_principal_id)
         VALUES ('PROJECT', 'P', 'SESSION', 's9', 'h1', 'op', 2, 'canon-v2', 'fp', '{}', 1, ?1, 'AGENT', 's9')",
        params![T],
    );
    assert!(is_constraint(half));
    // 没有命名空间的旧行（只有 legacy_key）也不能带调用索引列：NULL 不能让这条约束失效。
    assert!(is_constraint(receipt(
        &c,
        ("PROJECT", "P"),
        None,
        None,
        Some("legacy-1"),
        Some(("AGENT", "z", "begin"))
    )));
    assert!(is_constraint(c.execute(
        "INSERT INTO idempotency_receipts (scope_kind, scope_id, ns_kind, ns_id, op_id, operation, fp_v, fp_family, fingerprint, receipt_json, scope_generation, call_principal_id, call_operation)
         VALUES ('PROJECT','P','CALL','z','x4','op',2,'canon-v2','fp','{}',1,'z','begin')",
        [],
    )));
}

/// P1-01：GLOBAL 回执（quick registry、begin 的 NONE 分支）不属于任何恢复范围，没有世代。
/// 空库里一个项目、一个知识库都没有时，它们也必须能落盘、能被重放找到。
#[test]
fn a_global_receipt_needs_no_scope_generation() {
    let c = fresh("global-receipt");
    // 空库：没有任何 scope_generations 行。
    assert_eq!(
        c.query_row("SELECT count(*) FROM scope_generations", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    // quick.create（USER 命名空间）与 begin 落在 quick / NONE 分支（调用索引行）。
    assert!(
        receipt(
            &c,
            ("GLOBAL", "GLOBAL"),
            Some(("ACTOR", "USER")),
            Some("q1"),
            None,
            None
        )
        .is_ok()
    );
    assert!(
        receipt(
            &c,
            ("GLOBAL", "GLOBAL"),
            Some(("CALL", "claude")),
            Some("auto:b1"),
            None,
            Some(("AGENT", "claude", "begin"))
        )
        .is_ok()
    );
    // 丢了响应后重放：同一调用键只能有一行，按四列原值找得到原来那条。
    assert!(violates(
        receipt(
            &c,
            ("GLOBAL", "GLOBAL"),
            Some(("CALL", "claude")),
            Some("auto:b1"),
            None,
            Some(("AGENT", "claude", "begin"))
        ),
        "UNIQUE constraint failed: idempotency_receipts.call_principal_kind"
    ));
    let found: i64 = c
        .query_row(
            "SELECT count(*) FROM idempotency_receipts
             WHERE call_principal_kind = 'AGENT' AND call_principal_id = 'claude' AND call_operation = 'begin'
               AND op_id = 'auto:b1' AND scope_kind = 'GLOBAL' AND scope_generation IS NULL AND state = 'VALID'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(found, 1);
    assert_eq!(integrity(&c), ("ok".to_string(), 0));

    let insert = |kind: &str, scope: &str, generation: Option<i64>, op: &str| {
        c.execute(
            "INSERT INTO idempotency_receipts (scope_kind, scope_id, ns_kind, ns_id, op_id, operation, fp_v, fp_family,
                                               fingerprint, receipt_json, scope_generation, created_at)
             VALUES (?1, ?2, 'ACTOR', 'USER', ?3, 'op', 2, 'canon-v2', 'fp', '{}', ?4, ?5)",
            params![kind, scope, op, generation, T],
        )
    };
    // GLOBAL 不能借一个项目的世代；项目、知识库回执不能没有世代。
    project(&c, "P", "PAA", 1);
    generation(&c, 2, "KNOWLEDGE", "KDB");
    assert!(violates(
        insert("GLOBAL", "GLOBAL", Some(1), "g-borrowed"),
        "CHECK constraint failed: (scope_kind = 'GLOBAL') = (scope_generation IS NULL)"
    ));
    assert!(violates(
        insert("PROJECT", "P", None, "p-none"),
        "CHECK constraint failed: (scope_kind = 'GLOBAL') = (scope_generation IS NULL)"
    ));
    assert!(violates(
        insert("KNOWLEDGE", "KDB", None, "k-none"),
        "CHECK constraint failed: (scope_kind = 'GLOBAL') = (scope_generation IS NULL)"
    ));
    assert!(insert("PROJECT", "P", Some(1), "p-ok").is_ok());
    // GLOBAL 的 scope_id 只能是字面量 GLOBAL。
    assert!(violates(
        insert("GLOBAL", "P", None, "g-scoped"),
        "CHECK constraint failed: scope_kind <> 'GLOBAL' OR scope_id = 'GLOBAL'"
    ));
    // 墓碑只由按范围恢复产生，GLOBAL 回执不会变成墓碑。
    assert!(violates(
        c.execute(
            "UPDATE idempotency_receipts SET state = 'TOMBSTONED', tombstoned_by_gen = 1, tombstoned_at = ?1
             WHERE scope_kind = 'GLOBAL' AND op_id = 'q1'",
            [T],
        ),
        "CHECK constraint failed: scope_kind <> 'GLOBAL' OR state = 'VALID'"
    ));
}

#[test]
fn ordinary_receipts_are_unique_per_scope_and_legacy_rows_need_a_key() {
    let c = fresh("receipts");
    project(&c, "P", "PAA", 1);
    project(&c, "Q", "QBB", 2);
    let ns = |scope: &str, op: &str| {
        receipt(
            &c,
            ("PROJECT", scope),
            Some(("SESSION", "S1")),
            Some(op),
            None,
            None,
        )
    };
    assert!(ns("P", "X").is_ok());
    assert!(ns("Q", "X").is_ok(), "same namespace key in another scope");
    assert!(
        is_constraint(ns("P", "X")),
        "same namespace key in the same scope"
    );
    // 转换来的知识行：没有 op_id 和命名空间，只有 legacy_key；同一 scope 内唯一。
    assert!(receipt(&c, ("KNOWLEDGE", "KB"), None, None, Some("agent:abc"), None).is_ok());
    assert!(is_constraint(receipt(
        &c,
        ("KNOWLEDGE", "KB"),
        None,
        None,
        Some("agent:abc"),
        None
    )));
    assert!(receipt(&c, ("PROJECT", "P"), None, None, Some("agent:abc"), None).is_ok());
    // 既没有 op_id 也没有 legacy_key 的行不合法；有 op_id 却没有命名空间也不合法。
    assert!(is_constraint(receipt(
        &c,
        ("PROJECT", "P"),
        None,
        None,
        None,
        None
    )));
    assert!(is_constraint(receipt(
        &c,
        ("PROJECT", "P"),
        None,
        Some("Y"),
        None,
        None
    )));
}

#[test]
fn a_tombstone_records_its_generation_and_time() {
    let c = fresh("tombstone");
    project(&c, "P", "PAA", 1);
    generation(&c, 2, "PROJECT", "P");
    receipt(
        &c,
        ("PROJECT", "P"),
        Some(("SESSION", "S1")),
        Some("X"),
        None,
        None,
    )
    .unwrap();
    let flip = |by: Option<i64>, at: Option<&str>| {
        c.execute("UPDATE idempotency_receipts SET state = 'TOMBSTONED', tombstoned_by_gen = ?1, tombstoned_at = ?2 WHERE op_id = 'X'", params![by, at])
    };
    assert!(is_constraint(flip(None, Some(T))));
    assert!(is_constraint(flip(Some(2), None)));
    assert!(flip(Some(2), Some(T)).is_ok());
    // 原行保留，调用索引等列不受影响；行数不变。
    let n: i64 = c
        .query_row("SELECT count(*) FROM idempotency_receipts", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(n, 1);
}

#[test]
fn knowledge_revisions_are_immutable_outside_a_restore() {
    let c = fresh("knowledge");
    generation(&c, 1, "KNOWLEDGE", "KB");
    c.execute_batch(
        "BEGIN;
         INSERT INTO knowledge_entries (id, slug, head_revision, version) VALUES ('K', 'k', 1, 1);
         INSERT INTO knowledge_revisions (entry_id, revision, revision_id, snapshot) VALUES ('K', 1, 'R1', '{}');
         COMMIT;",
    )
    .unwrap();
    assert!(
        c.execute("UPDATE knowledge_revisions SET snapshot = '{\"a\":1}'", [])
            .is_err()
    );
    assert!(c.execute("DELETE FROM knowledge_revisions", []).is_err());
    assert!(c.execute("INSERT INTO knowledge_revisions (entry_id, revision, revision_id, snapshot) VALUES ('K', 2, 'R2', 'not json')", []).is_err());
    // 恢复事务里，打开 restore_guard 之后才允许删除。
    c.execute_batch(
        "BEGIN;
         INSERT INTO restore_guard VALUES ('KNOWLEDGE');
         DELETE FROM knowledge_entries;
         DELETE FROM knowledge_revisions;
         DELETE FROM restore_guard;
         COMMIT;",
    )
    .unwrap();
    let n: i64 = c
        .query_row("SELECT count(*) FROM knowledge_revisions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0);
}

#[test]
fn search_docs_keep_the_fts_index_in_step() {
    let c = fresh("fts");
    project(&c, "P", "PAA", 1);
    c.execute("INSERT INTO search_docs (doc_id, project_id, entity_type, entity_id, entity_key, title, body, updated_at) VALUES (7, 'P', 'WORK_ITEM', 'W', 'PAA-T-0001', '写线程预算', 'queue', ?1)", [T]).unwrap();
    let hits = |q: &str| -> Vec<i64> {
        c.prepare("SELECT rowid FROM search_fts WHERE search_fts MATCH ?1")
            .unwrap()
            .query_map([q], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    };
    assert_eq!(hits("写线程"), vec![7]);
    c.execute(
        "UPDATE search_docs SET title = '读连接池' WHERE doc_id = 7",
        [],
    )
    .unwrap();
    assert!(hits("写线程").is_empty());
    assert_eq!(hits("读连接"), vec![7]);
    c.execute("DELETE FROM search_docs WHERE doc_id = 7", [])
        .unwrap();
    assert!(hits("读连接").is_empty());
}

#[test]
fn a_misspelled_identifier_is_an_error_not_a_string() {
    // SQLite 默认把找不到的 "标识符" 当成字符串字面量。关掉之后，写错列名必须报错。
    let c = fresh("dqs");
    let e = c
        .query_row("SELECT \"no_such_column\" FROM app_meta", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap_err();
    assert!(e.to_string().contains("no_such_column"), "{e}");
    assert!(
        c.execute(
            "INSERT INTO settings (key, value_json, updated_at) VALUES (\"k\", '1', 'T')",
            []
        )
        .is_err()
    );

    // 写线程与读连接也一样。
    let store =
        atm_store::Store::open(&db_path("dqs-store"), atm_store::Config::default()).unwrap();
    assert!(
        store
            .read(|tx| tx.query_row("SELECT \"nope\"", [], |r| r.get::<_, String>(0)))
            .is_err()
    );
    assert!(
        store
            .write(|tx| tx.query_row("SELECT \"nope\"", [], |r| r.get::<_, String>(0)))
            .is_err()
    );
}

/// 00 C-L15：projects 没有 archived_at（2.0 从没写过它；转换时原值放进 legacy_json）。
#[test]
fn c_l15_projects_have_no_archived_at() {
    let c = fresh("removed");
    let columns: Vec<String> = c
        .prepare("SELECT name FROM pragma_table_info('projects')")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert!(columns.contains(&"lifecycle".to_owned()));
    assert!(!columns.contains(&"archived_at".to_owned()));
}

/// 01 C-16 / C-25：work_items 的三列、labels 两张表、RELATES / DUPLICATES 都不建（store/NORMALIZATION.md N-02）。
/// 只作转换数据保留的 kind / blockers 状态仍在 CHECK 里（O-01、O-02）。
#[test]
fn c16_legacy_structures_are_not_built() {
    let c = fresh("c16");
    let columns: Vec<String> = c
        .prepare("SELECT name FROM pragma_table_info('work_items')")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert!(columns.contains(&"target_date".to_owned()));
    for gone in ["archived_at", "phase_inferred", "planned_start_date"] {
        assert!(!columns.iter().any(|c| c == gone), "{gone}");
    }
    let tables: i64 = c
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name IN ('labels', 'work_item_labels')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(tables, 0);
    let sql: String = c
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name = 'work_item_relations'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        sql.contains("relation_type IN ('BLOCKS','DISCOVERED_FROM')"),
        "{sql}"
    );
    // 00 C-16：检查项 kind 只有 ACCEPTANCE，blockers 没有 CANCELLED，progress_source 没有 STATUS。
    // 在事务里试写再回滚：遗留取值撞 CHECK，3.0 的取值写得进去。
    let attempt = |sql: &str| {
        c.execute_batch("BEGIN").unwrap();
        let r = c.execute_batch(sql).map_err(|e| e.to_string());
        c.execute_batch("ROLLBACK").unwrap();
        r
    };
    let row = |table: &str, value: &str| {
        match table {
        "checklist_items" => format!(
            "INSERT INTO checklist_items (project_id, id, work_item_id, title, kind, status, created_at, updated_at)
             VALUES ('PX', 'C', 'W', 't', '{value}', 'TODO', 't', 't')"
        ),
        "blockers" => format!(
            "INSERT INTO blockers (project_id, id, local_no, severity, title, status, actor, created_at, updated_at)
             VALUES ('PX', 'B', 1, 'LOW', 't', '{value}', 'USER', 't', 't')"
        ),
        _ => format!(
            "INSERT INTO work_items (project_id, id, local_no, objective_id, type, title, status, priority,
                                     progress_source, created_at, updated_at)
             VALUES ('PX', 'W', 1, 'O', 'TASK', 't', 'READY', 'NORMAL', '{value}', 't', 't')"
        ),
    }
    };
    for (table, legacy, current) in [
        (
            "checklist_items",
            &["OPTIONAL", "REQUIRED", "VERIFICATION"][..],
            "ACCEPTANCE",
        ),
        ("blockers", &["CANCELLED"][..], "RESOLVED"),
        ("work_items", &["STATUS"][..], "NONE"),
    ] {
        assert_eq!(attempt(&row(table, current)), Ok(()), "{table} {current}");
        for value in legacy {
            let e = attempt(&row(table, value)).unwrap_err();
            assert!(
                e.contains("CHECK constraint failed"),
                "{table} {value}: {e}"
            );
        }
    }
}
