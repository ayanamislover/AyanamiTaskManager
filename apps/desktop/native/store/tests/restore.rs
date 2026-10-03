//! 整库备份与按范围恢复的验收（W1e）。
//!
//! 时间线照 05 M-06 / 10 R4 / P2-07：备份 → 继续写 → 恢复，检查工作数据回退、序号与编号不回退、
//! 身份不回退、回执原地变墓碑、全局流打撤销标记、其他范围不受影响、失败时什么都不变。

use atm_store::backup::{BackupError, artifacts_root, create_backup, verify_backup};
use atm_store::events::{NewEvent, append_event, next_number};
use atm_store::restore::{
    PROJECT_TABLES, PROJECT_TABLES_HANDLED_ELSEWHERE, RestoreOptions, ScopeRef, ScopeRestored,
    SwapStep, current_generation, ensure_generation, finish_attachment_swaps, inject_swap_fault,
    project_attachments, restore_knowledge, restore_project,
};
use atm_store::search::{
    Doc, Scope, check_fts, match_docs, rebuild_knowledge_fts, terms, upsert_doc,
};
use atm_store::{Config, Store};
use rusqlite::{OptionalExtension, Transaction, params};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

const T0: &str = "2026-10-03T00:00:00.000Z";
const T1: &str = "2026-10-03T01:00:00.000Z";
const T2: &str = "2026-10-03T02:00:00.000Z";
const T3: &str = "2026-10-03T03:00:00.000Z";

struct World {
    store: Store,
    backups: PathBuf,
}

fn world(name: &str) -> World {
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("target")
        });
    let dir = target.join("store-tests").join(name);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let store = Store::open(
        &dir.join("atm.sqlite"),
        Config {
            write_budget: Duration::from_secs(30),
            ..Config::default()
        },
    )
    .unwrap();
    store
        .write(|tx| {
            tx.execute_batch(&format!(
                "INSERT INTO app_meta (singleton, schema_version, data_root_id, generation, instance_epoch, scope_gen_counter, created_at, updated_at)
                   VALUES (1, 1, 'ROOT', 'G', 'EPOCH-1', 3, '{T0}', '{T0}');
                 INSERT INTO scope_generations (gen, scope_kind, scope_id, reason, epoch, created_at) VALUES
                   (1, 'PROJECT', 'PA', 'CREATED', 'EA', '{T0}'),
                   (2, 'PROJECT', 'PB', 'CREATED', 'EB', '{T0}'),
                   (3, 'KNOWLEDGE', 'KDB', 'CREATED', 'EK', '{T0}');
                 INSERT INTO knowledge_meta (singleton, database_id, generation, sequence, scope_gen) VALUES (1, 'KDB', 'KG0', 0, 3);"
            ))?;
            for (id, g, e) in [("PA", 1, "EA"), ("PB", 2, "EB")] {
                tx.execute(
                    "INSERT INTO projects (id, code, name, lifecycle, health, meta_version, scope_gen, epoch, created_at, updated_at)
                     VALUES (?1, ?1, ?1, 'ACTIVE', 'ON_TRACK', 0, ?2, ?3, ?4, ?4)",
                    params![id, g, e, T0],
                )?;
                tx.execute(
                    "INSERT INTO objectives (project_id, id, local_no, title, status, created_at, updated_at) VALUES (?1, 'OBJ', 1, 'o', 'ACTIVE', ?2, ?2)",
                    params![id, T0],
                )?;
                tx.execute("INSERT INTO counters (project_id, name, next_value) VALUES (?1, 'work_item', 1)", [id])?;
                tx.execute(
                    "INSERT INTO agents (project_id, id, display_name, client_kind, created_at, updated_at) VALUES (?1, 'claude', 'Claude', 'cli', ?2, ?2)",
                    params![id, T0],
                )?;
            }
            session(tx, "PA", "S0", None, T0)?;
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    World {
        store,
        backups: dir.join("backups"),
    }
}

fn session(
    tx: &Transaction<'_>,
    project: &str,
    id: &str,
    predecessor: Option<&str>,
    at: &str,
) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO agent_sessions (project_id, id, agent_id, role, work_state, connection_state, started_at, updated_at, predecessor_session_id)
         VALUES (?1, ?2, 'claude', 'PRIMARY', 'IDLE', 'ONLINE', ?3, ?3, ?4)",
        params![project, id, at, predecessor],
    )
    .map(|_| ())
}

/// 一次典型的项目写入：取编号、建任务、记事件（带全局镜像）、写搜索文档、写回执。
/// 返回任务 id。`claim` 给出时由该 session 领取，并把它的工作指针指向这个任务。
fn task(w: &World, project: &str, word: &str, op: &str, claim: Option<&str>, at: &str) -> String {
    let (project, word, op, claim, at) = (
        project.to_string(),
        word.to_string(),
        op.to_string(),
        claim.map(str::to_string),
        at.to_string(),
    );
    w.store
        .write(move |tx| {
            let no = next_number(tx, &project, "work_item").unwrap();
            let id = format!("{project}-W{no}");
            tx.execute(
                "INSERT INTO work_items (project_id, id, local_no, objective_id, type, title, status, priority, claimed_by_session_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 'OBJ', 'TASK', ?4, 'BACKLOG', 'NORMAL', ?5, ?6, ?6)",
                params![project, id, no, word, claim, at],
            )?;
            if let Some(s) = &claim {
                tx.execute(
                    "UPDATE agent_sessions SET current_work_item_id = ?3, work_state = 'WORKING' WHERE project_id = ?1 AND id = ?2",
                    params![project, s, id],
                )?;
            }
            append_event(
                tx,
                &NewEvent {
                    project_id: &project,
                    kind: "work.created",
                    actor_type: "AGENT",
                    actor_id: "claude",
                    session_id: claim.as_deref(),
                    aggregate_type: "WORK_ITEM",
                    aggregate_id: &id,
                    correlation_id: None,
                    op_id: Some(&op),
                    payload_json: "{}",
                    at: &at,
                },
            )
            .unwrap();
            let key = format!("{project}-T-{no:04}");
            upsert_doc(
                tx,
                &Doc { project_id: &project, entity_type: "WORK_ITEM", entity_id: &id, entity_key: &key, title: &word, body: "", updated_at: &at },
            )?;
            receipt(tx, "PROJECT", &project, ("SESSION", "S0"), &op, None, at.as_str())?;
            Ok::<_, rusqlite::Error>(id)
        })
        .unwrap()
}

fn receipt(
    tx: &Transaction<'_>,
    kind: &str,
    scope: &str,
    ns: (&str, &str),
    op: &str,
    call: Option<(&str, &str, &str)>,
    at: &str,
) -> rusqlite::Result<()> {
    // GLOBAL 回执没有世代（P1-01）。
    let g: Option<i64> = if kind == "GLOBAL" {
        None
    } else {
        tx.query_row("SELECT max(gen) FROM scope_generations", [], |r| r.get(0))?
    };
    tx.execute(
        "INSERT INTO idempotency_receipts (scope_kind, scope_id, ns_kind, ns_id, op_id, operation, fp_v, fp_family, fingerprint,
                                           receipt_json, scope_generation, created_at, call_principal_kind, call_principal_id, call_operation)
         VALUES (?1, ?2, ?3, ?4, ?5, 'op', 2, 'canon-v2', 'fp', '{}', ?6, ?7, ?8, ?9, ?10)",
        params![kind, scope, ns.0, ns.1, op, g, at, call.map(|c| c.0), call.map(|c| c.1), call.map(|c| c.2)],
    )
    .map(|_| ())
}

fn call(w: &World, project: &str, principal: &str, op: &str) {
    let (project, principal, op) = (project.to_string(), principal.to_string(), op.to_string());
    w.store
        .write(move |tx| {
            receipt(
                tx,
                "PROJECT",
                &project,
                ("CALL", &principal),
                &op,
                Some(("AGENT", &principal, "begin")),
                T0,
            )
        })
        .unwrap();
}

fn q<T: rusqlite::types::FromSql + Send + 'static>(
    w: &World,
    sql: &str,
    p: Vec<String>,
) -> Option<T> {
    let sql = sql.to_string();
    w.store
        .read(move |tx| {
            tx.query_row(&sql, rusqlite::params_from_iter(p), |r| r.get(0))
                .optional()
        })
        .unwrap()
}

fn i(w: &World, sql: &str, p: &[&str]) -> i64 {
    q::<i64>(w, sql, p.iter().map(|s| s.to_string()).collect()).unwrap_or(-1)
}

fn s(w: &World, sql: &str, p: &[&str]) -> Option<String> {
    q::<Option<String>>(w, sql, p.iter().map(|s| s.to_string()).collect()).flatten()
}

fn receipt_state(w: &World, op: &str) -> (String, Option<i64>) {
    let op = op.to_string();
    w.store
        .read(move |tx| {
            tx.query_row(
                "SELECT state, tombstoned_by_gen FROM idempotency_receipts WHERE op_id = ?1",
                [op],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap()
}

fn opts(w: &World) -> RestoreOptions<'_> {
    RestoreOptions {
        backups_root: &w.backups,
        at: T3,
        pin_until: "2026-10-04T00:00:00.000Z",
        budget: Duration::from_secs(60),
    }
}

fn backup(w: &World) -> String {
    create_backup(&w.store, &w.backups, "MANUAL", T1)
        .unwrap()
        .id
}

fn search(w: &World, word: &str, project: &'static str) -> usize {
    let t = terms(word).unwrap();
    w.store
        .read(move |tx| match_docs(tx, &t, &Scope::Project(project), 50))
        .unwrap()
        .len()
}

fn attachment(w: &World, project: &str, name: &str, body: &str) {
    let dir = artifacts_root(w.store.path()).join(project);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(name), body).unwrap();
}

fn files(dir: &Path) -> Vec<(String, String)> {
    let mut out: Vec<_> = fs::read_dir(dir)
        .map(|it| {
            it.filter_map(|e| e.ok())
                .map(|e| {
                    (
                        e.file_name().to_string_lossy().into_owned(),
                        fs::read_to_string(e.path()).unwrap_or_default(),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

fn pairs(v: &[(&str, &str)]) -> Vec<(String, String)> {
    v.iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect()
}

/// 备份里登记的附件路径，以及其中一个文件的内容。
fn backed_up(w: &World, id: &str, file: &str) -> (Vec<String>, String) {
    let vb = verify_backup(&w.store, id).unwrap();
    let paths = vb.attachments.iter().map(|f| f.path.clone()).collect();
    let body = fs::read_to_string(vb.artifacts_dir().join(file)).unwrap();
    (paths, body)
}

fn healthy(w: &World) {
    w.store
        .write(|tx| {
            let ok: String = tx.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
            assert_eq!(ok, "ok");
            let fk: i64 =
                tx.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
                    r.get(0)
                })?;
            assert_eq!(fk, 0, "dangling references after restore");
            let guard: i64 =
                tx.query_row("SELECT count(*) FROM restore_guard", [], |r| r.get(0))?;
            assert_eq!(guard, 0);
            let attached: i64 = tx.query_row(
                "SELECT count(*) FROM pragma_database_list WHERE name = 'bk'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(attached, 0, "the backup must be detached");
            check_fts(tx)?;
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
}

#[test]
fn a_project_restore_rewinds_work_but_not_numbers_identity_or_other_scopes() {
    let w = world("restore-timeline");
    let w1 = task(&w, "PA", "alpha", "op-1", Some("S0"), T0);
    task(&w, "PB", "bravo", "op-pb-1", None, T0);
    call(&w, "PA", "S0", "begin-1");
    attachment(&w, "PA", "a.txt", "v1");
    let b = backup(&w);
    let global_at_backup = i(&w, "SELECT global_seq FROM app_meta", &[]);
    let pa_seq_at_backup = i(&w, "SELECT project_seq FROM projects WHERE id = 'PA'", &[]);

    // 备份之后：新 session S1 接替 S0，建任务并开工；PB 继续写；附件改动；一次导入。
    w.store
        .write(|tx| session(tx, "PA", "S1", Some("S0"), T2))
        .unwrap();
    let w2 = task(&w, "PA", "beta", "op-2", Some("S1"), T2);
    task(&w, "PB", "charlie", "op-pb-2", None, T2);
    call(&w, "PA", "S1", "begin-2");
    // 备份之后的 GLOBAL 回执（quick.create、begin 的 NONE 分支）：不属于 PA，恢复 PA 不碰它们。
    w.store
        .write(|tx| {
            receipt(
                tx,
                "GLOBAL",
                "GLOBAL",
                ("ACTOR", "USER"),
                "quick-1",
                None,
                T2,
            )?;
            receipt(
                tx,
                "GLOBAL",
                "GLOBAL",
                ("CALL", "S1"),
                "begin-global",
                Some(("AGENT", "S1", "begin")),
                T2,
            )
        })
        .unwrap();
    attachment(&w, "PA", "a.txt", "v2");
    attachment(&w, "PA", "b.txt", "new");
    w.store
        .write(|tx| {
            tx.execute("INSERT INTO import_history (source_sha256, project_id, result_json, imported_at) VALUES ('sha-x', 'PA', '{}', ?1)", [T2])
        })
        .unwrap();
    // lineage（R3）：S2 是 S0 的同 role 后继，指向 S0 领取的 W1，保留；
    // R1 跨 role、S3 比前序还早开始，都不算 lineage，指向 W1 要清掉。
    w.store
        .write(|tx| {
            session(tx, "PA", "S2", Some("S0"), T2)?;
            session(tx, "PA", "S3", Some("S0"), "2026-10-02T00:00:00.000Z")?;
            tx.execute(
                "INSERT INTO agent_sessions (project_id, id, agent_id, role, work_state, connection_state, started_at, updated_at, predecessor_session_id)
                 VALUES ('PA', 'R1', 'claude', 'REVIEWER', 'IDLE', 'ONLINE', ?1, ?1, 'S0')",
                [T2],
            )?;
            tx.execute(
                "UPDATE agent_sessions SET current_work_item_id = 'PA-W1', work_state = 'WORKING' WHERE id IN ('S2', 'S3', 'R1')",
                [],
            )?;
            tx.execute("UPDATE projects SET health = 'AT_RISK' WHERE id = 'PA'", [])
        })
        .unwrap();
    let pa_seq_before = i(&w, "SELECT project_seq FROM projects WHERE id = 'PA'", &[]);
    let pb_before = (
        i(&w, "SELECT project_seq FROM projects WHERE id = 'PB'", &[]),
        i(&w, "SELECT scope_gen FROM projects WHERE id = 'PB'", &[]),
    );
    let receipts_before = i(&w, "SELECT count(*) FROM idempotency_receipts", &[]);
    let epoch_before = s(&w, "SELECT epoch FROM projects WHERE id = 'PA'", &[]);

    let out = restore_project(&w.store, &b, "PA", &opts(&w)).unwrap();
    assert_eq!(
        out.generation, 4,
        "a new generation above every existing one"
    );
    assert_eq!(
        (out.seq_before, out.seq_after),
        (pa_seq_before, pa_seq_before)
    );
    assert_eq!(
        (out.tombstoned, out.revived, out.imports_removed),
        (2, 0, 1)
    );
    assert_eq!(out.pointers_cleared, ["R1", "S1", "S3"]);

    // 工作数据回到备份时的样子。
    assert_eq!(
        i(
            &w,
            "SELECT count(*) FROM work_items WHERE project_id = 'PA'",
            &[]
        ),
        1
    );
    assert_eq!(
        s(&w, "SELECT id FROM work_items WHERE project_id = 'PA'", &[]).as_deref(),
        Some(w1.as_str())
    );
    assert_eq!(
        (search(&w, "alpha", "PA"), search(&w, "beta", "PA")),
        (1, 0)
    );
    assert_eq!(
        i(
            &w,
            "SELECT max(seq) FROM events WHERE project_id = 'PA' AND type = 'work.created'",
            &[]
        ),
        pa_seq_at_backup
    );

    assert_eq!(
        s(&w, "SELECT health FROM projects WHERE id = 'PA'", &[]).as_deref(),
        Some("ON_TRACK"),
        "project meta comes from the backup"
    );
    assert_eq!(
        s(
            &w,
            "SELECT current_work_item_id FROM agent_sessions WHERE id = 'S2'",
            &[]
        )
        .as_deref(),
        Some("PA-W1"),
        "a same-role successor of the claimant keeps its pointer"
    );

    // 序号与编号不回退（R5）：下一个任务号是 3，不是 2。
    assert!(
        i(&w, "SELECT project_seq FROM projects WHERE id = 'PA'", &[]) > pa_seq_before,
        "restore events come after"
    );
    let next = w
        .store
        .write(|tx| next_number(tx, "PA", "work_item"))
        .unwrap();
    assert_eq!(next, 3);

    // 世代与 epoch。
    assert_eq!(
        i(&w, "SELECT scope_gen FROM projects WHERE id = 'PA'", &[]),
        4
    );
    assert_ne!(
        s(&w, "SELECT epoch FROM projects WHERE id = 'PA'", &[]),
        epoch_before
    );
    assert_eq!(
        s(
            &w,
            "SELECT reason || ':' || backup_id || ':' || seq_before FROM scope_generations WHERE gen = 4",
            &[]
        ),
        Some(format!("RESTORED:{b}:{pa_seq_before}"))
    );
    assert_eq!(
        i(&w, "SELECT version FROM projects WHERE id = 'PA'", &[]),
        1
    );

    // 回执：备份里的有效，之后的原地变墓碑；行数不变，调用索引四列原样（P2-07）。
    assert_eq!(receipt_state(&w, "op-1"), ("VALID".into(), None));
    assert_eq!(receipt_state(&w, "op-2"), ("TOMBSTONED".into(), Some(4)));
    assert_eq!(receipt_state(&w, "begin-1"), ("VALID".into(), None));
    assert_eq!(receipt_state(&w, "begin-2"), ("TOMBSTONED".into(), Some(4)));
    assert_eq!(receipt_state(&w, "quick-1"), ("VALID".into(), None));
    assert_eq!(receipt_state(&w, "begin-global"), ("VALID".into(), None));
    assert_eq!(
        i(
            &w,
            "SELECT count(*) FROM idempotency_receipts WHERE scope_kind = 'GLOBAL' AND scope_generation IS NULL",
            &[]
        ),
        2
    );
    assert_eq!(
        i(&w, "SELECT count(*) FROM idempotency_receipts", &[]),
        receipts_before
    );
    assert_eq!(
        s(&w, "SELECT call_principal_kind || call_principal_id || call_operation FROM idempotency_receipts WHERE op_id = 'begin-2'", &[]).as_deref(),
        Some("AGENTS1begin")
    );

    // 其他项目不受影响。
    assert_eq!(receipt_state(&w, "op-pb-2"), ("VALID".into(), None));
    assert_eq!(
        (
            i(&w, "SELECT project_seq FROM projects WHERE id = 'PB'", &[]),
            i(&w, "SELECT scope_gen FROM projects WHERE id = 'PB'", &[])
        ),
        pb_before
    );
    assert_eq!(
        i(
            &w,
            "SELECT count(*) FROM work_items WHERE project_id = 'PB'",
            &[]
        ),
        2
    );

    // 全局流：PA 在备份点之后的行标上本次世代，之前的和 PB 的不动；本次恢复自己的事件不算撤销。
    let g = global_at_backup.to_string();
    assert!(
        i(
            &w,
            "SELECT count(*) FROM global_feed WHERE project_id = 'PA' AND global_seq > ?1 AND type = 'work.created'",
            &[&g]
        ) >= 1
    );
    assert_eq!(
        i(
            &w,
            "SELECT count(*) FROM global_feed WHERE project_id = 'PA' AND global_seq > ?1 AND type = 'work.created' AND undone_by_restore_gen IS NOT 4",
            &[&g]
        ),
        0
    );
    assert_eq!(
        i(
            &w,
            "SELECT count(*) FROM global_feed WHERE global_seq <= ?1 AND undone_by_restore_gen IS NOT NULL",
            &[&g]
        ),
        0
    );
    assert_eq!(
        i(
            &w,
            "SELECT count(*) FROM global_feed WHERE project_id = 'PB' AND undone_by_restore_gen IS NOT NULL",
            &[]
        ),
        0
    );
    assert_eq!(
        i(
            &w,
            "SELECT count(*) FROM global_feed WHERE type = 'project.restored' AND undone_by_restore_gen IS NULL",
            &[]
        ),
        1
    );
    assert_eq!(
        i(
            &w,
            "SELECT count(*) FROM global_feed WHERE type = 'backup.restored' AND aggregate_id = ?1",
            &[&b]
        ),
        1
    );

    // 身份不回退：S1 还在；它的工作指针指向被撤销的任务，已清掉并记事件；S0 的指针不动（R4′）。
    assert_eq!(
        i(
            &w,
            "SELECT count(*) FROM agent_sessions WHERE project_id = 'PA'",
            &[]
        ),
        5,
        "sessions created after the backup are kept"
    );
    assert_eq!(
        s(
            &w,
            "SELECT current_work_item_id FROM agent_sessions WHERE id = 'S1'",
            &[]
        ),
        None
    );
    assert_eq!(
        s(
            &w,
            "SELECT work_state FROM agent_sessions WHERE id = 'S1'",
            &[]
        )
        .as_deref(),
        Some("IDLE")
    );
    assert_eq!(
        s(
            &w,
            "SELECT current_work_item_id FROM agent_sessions WHERE id = 'S0'",
            &[]
        ),
        Some(w1.clone())
    );
    assert_eq!(
        s(
            &w,
            "SELECT payload_json ->> '$.workItemId' FROM events WHERE type = 'session.work_pointer_cleared' AND session_id = 'S1'",
            &[]
        ),
        Some(w2.clone())
    );

    // 导入记录、附件回到备份时的样子。
    assert_eq!(i(&w, "SELECT count(*) FROM import_history", &[]), 0);
    assert_eq!(
        files(&artifacts_root(w.store.path()).join("PA")),
        [("a.txt".to_string(), "v1".to_string())]
    );

    // PRE_RESTORE 已登记且可用；选中的备份已固定。
    assert_eq!(
        s(
            &w,
            "SELECT kind FROM backups WHERE id = ?1",
            &[&out.pre_restore_backup_id]
        )
        .as_deref(),
        Some("PRE_RESTORE")
    );
    verify_backup(&w.store, &out.pre_restore_backup_id).unwrap();
    assert!(s(&w, "SELECT pinned_until FROM backups WHERE id = ?1", &[&b]).is_some());
    healthy(&w);
}

#[test]
fn consecutive_restores_keep_earlier_tombstones_and_revive_what_the_backup_holds() {
    let w = world("restore-twice");
    task(&w, "PA", "one", "op-1", None, T0);
    let b1 = backup(&w);
    task(&w, "PA", "two", "op-2", None, T1);
    let b2 = backup(&w);
    task(&w, "PA", "three", "op-3", None, T2);
    attachment(&w, "PA", "late.txt", "after b2");

    let first = restore_project(&w.store, &b1, "PA", &opts(&w)).unwrap();
    assert_eq!(first.tombstoned, 2);
    let at_first = s(
        &w,
        "SELECT tombstoned_at FROM idempotency_receipts WHERE op_id = 'op-2'",
        &[],
    );

    assert_eq!(mark(&w, "PA-W2"), Some(first.generation));
    let again = restore_project(&w.store, &b1, "PA", &opts(&w)).unwrap();
    assert_eq!(
        (mark(&w, "PA-W2"), mark(&w, "PA-W3")),
        (Some(first.generation), Some(first.generation)),
        "restoring the same backup again keeps the first marks"
    );
    assert!(again.generation > first.generation);
    assert_ne!(again.epoch, first.epoch);
    assert_eq!((again.tombstoned, again.revived), (0, 0));
    assert_eq!(
        receipt_state(&w, "op-2"),
        ("TOMBSTONED".into(), Some(first.generation)),
        "an earlier tombstone keeps its generation"
    );
    assert_eq!(
        s(
            &w,
            "SELECT tombstoned_at FROM idempotency_receipts WHERE op_id = 'op-2'",
            &[]
        ),
        at_first
    );

    // b2 里 op-2 是有效的：恢复到 b2 让它重新生效；op-3 仍是第一次恢复留下的墓碑。
    let third = restore_project(&w.store, &b2, "PA", &opts(&w)).unwrap();
    assert_eq!((third.tombstoned, third.revived), (0, 1));
    assert_eq!(receipt_state(&w, "op-2"), ("VALID".into(), None));
    assert_eq!(
        receipt_state(&w, "op-3"),
        ("TOMBSTONED".into(), Some(first.generation))
    );
    assert_eq!(
        mark(&w, "PA-W3"),
        Some(first.generation),
        "an earlier undo mark keeps its generation"
    );
    assert!(
        files(&artifacts_root(w.store.path()).join("PA")).is_empty(),
        "files added after the backup are moved out"
    );
    assert_eq!((search(&w, "two", "PA"), search(&w, "three", "PA")), (1, 0));
    // op-2 的事件又在项目流里了，它的全局镜像也不再标为撤销。
    assert_eq!(
        i(
            &w,
            "SELECT count(*) FROM global_feed g JOIN events e ON e.id = g.event_id WHERE e.op_id = 'op-2' AND g.undone_by_restore_gen IS NULL",
            &[]
        ),
        1
    );
    assert_eq!(
        i(&w, "SELECT count(*) FROM idempotency_receipts", &[]),
        3,
        "restores never insert or delete receipts"
    );
    let gens: Vec<i64> = vec![first.generation, again.generation, third.generation];
    assert!(gens.windows(2).all(|p| p[0] < p[1]));
    healthy(&w);
}

/// 失败前后的状态指纹：各表行数、几个高水位、附件与暂存目录。
/// (各表行数, 高水位, PA 的附件, PA 的暂存目录是否存在)
type Fingerprint = (Vec<(String, i64)>, Vec<i64>, Vec<(String, String)>, bool);

fn fingerprint(w: &World) -> Fingerprint {
    let counts = w
        .store
        .read(|tx| {
            let names: Vec<String> = tx
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%fts%' ORDER BY name")?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            names
                .into_iter()
                .map(|n| Ok((n.clone(), tx.query_row(&format!("SELECT count(*) FROM {n}"), [], |r| r.get(0))?)))
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap();
    let marks = vec![
        i(w, "SELECT scope_gen_counter FROM app_meta", &[]),
        i(w, "SELECT global_seq FROM app_meta", &[]),
        i(w, "SELECT project_seq FROM projects WHERE id = 'PA'", &[]),
        i(w, "SELECT scope_gen FROM projects WHERE id = 'PA'", &[]),
        i(
            w,
            "SELECT count(*) FROM idempotency_receipts WHERE state = 'TOMBSTONED'",
            &[],
        ),
        i(
            w,
            "SELECT count(*) FROM global_feed WHERE undone_by_restore_gen IS NOT NULL",
            &[],
        ),
    ];
    let root = artifacts_root(w.store.path());
    (
        counts,
        marks,
        files(&root.join("PA")),
        root.join(".restore-staging").join("PA").exists(),
    )
}

#[test]
fn a_failed_restore_changes_nothing() {
    let w = world("restore-fails");
    task(&w, "PA", "one", "op-1", None, T0);
    attachment(&w, "PA", "a.txt", "v1");
    let b = backup(&w);
    task(&w, "PA", "two", "op-2", None, T1);
    attachment(&w, "PA", "a.txt", "v2");

    // 失败方式一：时长预算耗尽，事务中途被中断。
    let before = fingerprint(&w);
    let short = RestoreOptions {
        budget: Duration::ZERO,
        ..opts(&w)
    };
    let e = restore_project(&w.store, &b, "PA", &short).unwrap_err();
    assert!(
        matches!(e, BackupError::Sqlite(_) | BackupError::Write(_)),
        "{e:?}"
    );
    let mut after = fingerprint(&w);
    // PRE_RESTORE 备份在事务之外，已经做了、也登记了：这是预期的，不算恢复的改动。
    let backups_row = after.0.iter_mut().find(|(n, _)| n == "backups").unwrap();
    backups_row.1 -= 1;
    assert_eq!(after, before);

    // 失败方式二：备份里的回执在当前库对不上（时间线不同），在搬完工作数据之后才发现。
    w.store
        .write(|tx| {
            tx.execute(
                "UPDATE idempotency_receipts SET receipt_json = '{\"x\":1}' WHERE op_id = 'op-1'",
                [],
            )
        })
        .unwrap();
    let before = fingerprint(&w);
    let e = restore_project(&w.store, &b, "PA", &opts(&w)).unwrap_err();
    assert!(matches!(e, BackupError::TimelineMismatch(_)), "{e:?}");
    let mut after = fingerprint(&w);
    after.0.iter_mut().find(|(n, _)| n == "backups").unwrap().1 -= 1;
    assert_eq!(after, before);
    healthy(&w);
}

#[test]
fn a_knowledge_restore_rewinds_entries_and_tombstones_later_receipts() {
    let w = world("restore-knowledge");
    let rev = |entry: &str, n: i64, title: &str| {
        let (entry, title) = (entry.to_string(), title.to_string());
        w.store
            .write(move |tx| {
                tx.execute(
                    "INSERT INTO knowledge_revisions (entry_id, revision, revision_id, snapshot) VALUES (?1, ?2, ?3, json_object('title', ?4, 'bodyMarkdown', ''))",
                    params![entry, n, format!("{entry}-R{n}"), title],
                )?;
                tx.execute(
                    "INSERT INTO knowledge_entries (id, slug, head_revision, version) VALUES (?1, ?1, ?2, ?2)
                     ON CONFLICT (id) DO UPDATE SET head_revision = excluded.head_revision, version = excluded.version",
                    params![entry, n],
                )?;
                tx.execute("UPDATE knowledge_meta SET sequence = sequence + 1", [])?;
                receipt(tx, "KNOWLEDGE", "KDB", ("ACTOR", "USER"), &format!("k-{entry}-{n}"), None, T0)?;
                rebuild_knowledge_fts(tx)
            })
            .unwrap();
    };
    rev("K1", 1, "first title");
    let b = backup(&w);
    rev("K1", 2, "second title");
    rev("K2", 1, "other entry");
    let pa_gen = i(&w, "SELECT scope_gen FROM projects WHERE id = 'PA'", &[]);

    let out = restore_knowledge(&w.store, &b, &opts(&w)).unwrap();
    assert_eq!((out.seq_before, out.seq_after, out.tombstoned), (3, 4, 2));
    assert_eq!(
        i(
            &w,
            "SELECT head_revision FROM knowledge_entries WHERE id = 'K1'",
            &[]
        ),
        1
    );
    assert_eq!(i(&w, "SELECT count(*) FROM knowledge_entries", &[]), 1);
    assert_eq!(i(&w, "SELECT count(*) FROM knowledge_revisions", &[]), 1);
    assert_eq!(receipt_state(&w, "k-K1-1"), ("VALID".into(), None));
    assert_eq!(
        receipt_state(&w, "k-K1-2"),
        ("TOMBSTONED".into(), Some(out.generation))
    );
    assert_eq!(
        receipt_state(&w, "k-K2-1"),
        ("TOMBSTONED".into(), Some(out.generation))
    );
    assert_eq!(
        i(&w, "SELECT scope_gen FROM knowledge_meta", &[]),
        out.generation
    );
    assert_ne!(
        s(&w, "SELECT generation FROM knowledge_meta", &[]).as_deref(),
        Some("KG0")
    );
    assert_eq!(
        i(
            &w,
            "SELECT count(*) FROM knowledge_fts WHERE knowledge_fts MATCH '\"first title\"'",
            &[]
        ),
        1,
        "the index follows the restored head"
    );
    assert_eq!(
        i(
            &w,
            "SELECT count(*) FROM knowledge_fts WHERE knowledge_fts MATCH '\"second title\"'",
            &[]
        ),
        0
    );
    assert_eq!(
        i(&w, "SELECT scope_gen FROM projects WHERE id = 'PA'", &[]),
        pa_gen,
        "projects are a different scope"
    );
    healthy(&w);
}

#[test]
fn backups_are_verified_before_use() {
    let w = world("restore-verify");
    task(&w, "PA", "one", "op-1", None, T0);
    attachment(&w, "PA", "a.txt", "v1");
    let fresh = |w: &World| create_backup(&w.store, &w.backups, "MANUAL", T1).unwrap();

    assert!(matches!(
        verify_backup(&w.store, "NOPE"),
        Err(BackupError::NotFound(_))
    ));
    verify_backup(&w.store, &fresh(&w).id).unwrap();

    let b = fresh(&w);
    // 大小不变、库也不坏：改写文件头的 application_id（偏移 68），只有哈希能发现。
    let db = b.dir.join("atm.sqlite");
    let mut bytes = fs::read(&db).unwrap();
    bytes[68] ^= 0x5a;
    fs::write(&db, &bytes).unwrap();
    assert!(
        matches!(verify_backup(&w.store, &b.id), Err(BackupError::Corrupt(_))),
        "database file changed"
    );

    let b = fresh(&w);
    let m = b.dir.join("manifest.json");
    let text = fs::read_to_string(&m)
        .unwrap()
        .replace(&b.sha256, &"0".repeat(64));
    fs::write(&m, text).unwrap();
    assert!(
        matches!(verify_backup(&w.store, &b.id), Err(BackupError::Corrupt(_))),
        "manifest changed"
    );

    let b = fresh(&w);
    fs::write(b.dir.join("artifacts").join("PA").join("a.txt"), "tampered").unwrap();
    assert!(
        matches!(verify_backup(&w.store, &b.id), Err(BackupError::Corrupt(_))),
        "attachment changed"
    );

    // 只改 manifest 里的附件摘要（目录里的仍是对的）。
    let b = fresh(&w);
    let m = b.dir.join("manifest.json");
    let text = fs::read_to_string(&m)
        .unwrap()
        .replace(&b.attachments_sha256, &"1".repeat(64));
    fs::write(&m, text).unwrap();
    assert!(
        matches!(verify_backup(&w.store, &b.id), Err(BackupError::Corrupt(_))),
        "manifest attachment digest changed"
    );

    // 只改目录行里的附件摘要（manifest 与文件都对）。
    let b = fresh(&w);
    let id = b.id.clone();
    w.store
        .write(move |tx| {
            tx.execute(
                "UPDATE backups SET attachments_manifest_sha256 = 'bad' WHERE id = ?1",
                [id],
            )
        })
        .unwrap();
    assert!(
        matches!(verify_backup(&w.store, &b.id), Err(BackupError::Corrupt(_))),
        "catalog attachment digest changed"
    );

    let b = fresh(&w);
    w.store
        .write(|tx| tx.execute("UPDATE app_meta SET instance_epoch = 'EPOCH-2'", []))
        .unwrap();
    assert!(
        matches!(
            verify_backup(&w.store, &b.id),
            Err(BackupError::TimelineMismatch(_))
        ),
        "after a whole restore"
    );
    w.store
        .write(|tx| tx.execute("UPDATE app_meta SET instance_epoch = 'EPOCH-1'", []))
        .unwrap();

    let b = fresh(&w);
    w.store
        .write(|tx| {
            tx.execute(
                "INSERT INTO schema_migrations VALUES (99, 'x', 'y', 'z')",
                [],
            )
        })
        .unwrap();
    assert!(matches!(
        verify_backup(&w.store, &b.id),
        Err(BackupError::SchemaMismatch)
    ));
    w.store
        .write(|tx| tx.execute("DELETE FROM schema_migrations WHERE version = 99", []))
        .unwrap();

    // 备份之后才建的项目不在备份里。
    let b = fresh(&w);
    w.store
        .write(|tx| {
            tx.execute("INSERT INTO scope_generations (gen, scope_kind, scope_id, reason, epoch, created_at) VALUES (10, 'PROJECT', 'PC', 'CREATED', 'EC', ?1)", [T2])?;
            tx.execute("INSERT INTO projects (id, code, name, lifecycle, scope_gen, epoch, created_at, updated_at) VALUES ('PC', 'PC', 'PC', 'ACTIVE', 10, 'EC', ?1, ?1)", [T2])
        })
        .unwrap();
    assert!(matches!(
        restore_project(&w.store, &b.id, "PC", &opts(&w)),
        Err(BackupError::ScopeMissing(_))
    ));
}

#[test]
fn a_write_queued_before_a_restore_is_refused_after_it() {
    let w = world("restore-barrier");
    task(&w, "PA", "one", "op-1", None, T0);
    let b = backup(&w);
    let pa = w
        .store
        .read(|tx| current_generation(tx, ScopeRef::Project("PA")))
        .unwrap()
        .unwrap();
    let pb = w
        .store
        .read(|tx| current_generation(tx, ScopeRef::Project("PB")))
        .unwrap()
        .unwrap();
    let k = w
        .store
        .read(|tx| current_generation(tx, ScopeRef::Knowledge))
        .unwrap()
        .unwrap();
    restore_project(&w.store, &b, "PA", &opts(&w)).unwrap();

    let (stale, other, knowledge) = w
        .store
        .write(move |tx| {
            Ok::<_, rusqlite::Error>((
                ensure_generation(tx, ScopeRef::Project("PA"), pa)?,
                ensure_generation(tx, ScopeRef::Project("PB"), pb)?,
                ensure_generation(tx, ScopeRef::Knowledge, k)?,
            ))
        })
        .unwrap();
    assert_eq!(
        stale,
        Err(ScopeRestored {
            expected: pa,
            current: Some(4)
        })
    );
    assert_eq!(
        (other, knowledge),
        (Ok(()), Ok(())),
        "other scopes keep their generation"
    );
}

/// 任务 `work` 的 work.created 全局镜像上的撤销标记。
fn mark(w: &World, work: &str) -> Option<i64> {
    q::<Option<i64>>(
        w,
        "SELECT undone_by_restore_gen FROM global_feed WHERE type = 'work.created' AND aggregate_id = ?1",
        vec![work.to_string()],
    )
    .flatten()
}

#[test]
fn a_lagging_generation_counter_cannot_reuse_a_generation() {
    let w = world("restore-counter");
    task(&w, "PA", "one", "op-1", None, T0);
    let b = backup(&w);
    w.store
        .write(|tx| tx.execute("UPDATE app_meta SET scope_gen_counter = 1", []))
        .unwrap();
    let out = restore_project(&w.store, &b, "PA", &opts(&w)).unwrap();
    assert_eq!(out.generation, 4, "generations 2 and 3 are taken");
    healthy(&w);
}

#[test]
fn a_backup_with_damaged_pages_is_refused_even_when_its_hash_was_recorded() {
    use sha2::{Digest, Sha256};
    let w = world("restore-damaged");
    for n in 0..40 {
        task(&w, "PA", &format!("word{n}"), &format!("op-{n}"), None, T0);
    }
    let b = create_backup(&w.store, &w.backups, "MANUAL", T1).unwrap();
    // 备份写出来时就已损坏：页面被改，但目录与 manifest 记下的正是损坏后的哈希。
    let db = b.dir.join("atm.sqlite");
    let mut bytes = fs::read(&db).unwrap();
    let page = 4096;
    for byte in &mut bytes[page * 2..page * 6] {
        *byte = 0xA5;
    }
    fs::write(&db, &bytes).unwrap();
    let sha: String = Sha256::digest(&bytes)
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect();
    let manifest = b.dir.join("manifest.json");
    let text = fs::read_to_string(&manifest)
        .unwrap()
        .replace(&b.sha256, &sha);
    fs::write(&manifest, text).unwrap();
    let (id, new_sha) = (b.id.clone(), sha.clone());
    w.store
        .write(move |tx| {
            tx.execute(
                "UPDATE backups SET sha256 = ?2 WHERE id = ?1",
                [id, new_sha],
            )
        })
        .unwrap();
    let e = verify_backup(&w.store, &b.id).unwrap_err();
    assert!(
        matches!(&e, BackupError::Corrupt(m) if m.starts_with("quick_check")),
        "{e:?}"
    );
}

#[test]
fn every_table_with_a_project_column_is_accounted_for() {
    let w = world("restore-coverage");
    let tables: Vec<String> = w
        .store
        .read(|tx| {
            tx.prepare(
                "SELECT m.name FROM sqlite_master m JOIN pragma_table_info(m.name) c
                 WHERE m.type = 'table' AND c.name = 'project_id' ORDER BY m.name",
            )?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()
        })
        .unwrap();
    let listed: Vec<&str> = PROJECT_TABLES
        .iter()
        .copied()
        .chain(PROJECT_TABLES_HANDLED_ELSEWHERE.iter().map(|(t, _)| *t))
        .collect();
    for t in &tables {
        assert!(
            listed.contains(&t.as_str()),
            "{t} has project_id but no restore decision"
        );
    }
    for t in &listed {
        assert!(
            tables.iter().any(|x| x == t),
            "{t} is listed but has no project_id column"
        );
    }
    assert_eq!(listed.len(), tables.len(), "no table is listed twice");
}

#[test]
fn an_attachment_swap_interrupted_after_commit_is_finished_on_the_next_start() {
    let w = world("restore-swap");
    let root = artifacts_root(w.store.path());
    attachment(&w, "PA", "a.txt", "live");
    let generation = i(&w, "SELECT scope_gen FROM projects WHERE id = 'PA'", &[]);
    // 模拟：恢复已提交（库里的世代就是标记里的），换入之前进程退出。
    let staging = root.join(".restore-staging");
    fs::create_dir_all(staging.join("PA")).unwrap();
    fs::write(staging.join("PA").join("a.txt"), "restored").unwrap();
    fs::write(staging.join("PA.gen"), generation.to_string()).unwrap();
    // 另一份标记的世代不在库里：那次恢复回滚了，暂存要丢弃。
    fs::create_dir_all(staging.join("PB")).unwrap();
    fs::write(staging.join("PB").join("x.txt"), "never").unwrap();
    fs::write(staging.join("PB.gen"), "999").unwrap();
    attachment(&w, "PB", "x.txt", "keep");

    assert_eq!(finish_attachment_swaps(&w.store).unwrap(), 2);
    assert_eq!(
        files(&root.join("PA")),
        [("a.txt".to_string(), "restored".to_string())]
    );
    assert_eq!(
        files(&root.join("PB")),
        [("x.txt".to_string(), "keep".to_string())]
    );
    assert!(
        fs::read_dir(&staging).unwrap().next().is_none(),
        "staging is empty afterwards"
    );
    assert_eq!(
        finish_attachment_swaps(&w.store).unwrap(),
        0,
        "running it again does nothing"
    );
}

/// P1-05：库已提交、附件换入失败，而且故障一直在。收尾完成之前，备份、再次恢复、读附件都拒绝，
/// 不会认证一份「恢复后的库 + 恢复前的附件」；故障排除后，备份先把换入做完，再备份完整的目标状态。
#[test]
fn a_restore_whose_attachments_did_not_swap_blocks_backups_until_finished() {
    let w = world("restore-swap-blocked");
    let root = artifacts_root(w.store.path());
    task(&w, "PA", "alpha", "op-1", None, T0);
    attachment(&w, "PA", "a.txt", "v1");
    let b = backup(&w);
    task(&w, "PA", "late", "op-2", None, T2);
    attachment(&w, "PA", "a.txt", "v2");
    attachment(&w, "PA", "b.txt", "new");
    // 与 .restore-old 同名的普通文件：换入时建不了旧目录，失败一直持续。
    fs::write(root.join(".restore-old"), "blocker").unwrap();

    let generation = match restore_project(&w.store, &b, "PA", &opts(&w)) {
        Err(BackupError::AttachmentsPending {
            project,
            generation,
            ..
        }) => {
            assert_eq!(project, "PA");
            generation
        }
        other => panic!("expected AttachmentsPending, got {other:?}"),
    };
    // 库已经回到备份点；附件还是恢复前的。
    assert_eq!(
        i(&w, "SELECT scope_gen FROM projects WHERE id = 'PA'", &[]),
        generation
    );
    assert_eq!(
        i(
            &w,
            "SELECT count(*) FROM work_items WHERE project_id = 'PA' AND title = 'late'",
            &[]
        ),
        0
    );
    assert_eq!(
        files(&root.join("PA")),
        pairs(&[("a.txt", "v2"), ("b.txt", "new")])
    );

    let backups = i(&w, "SELECT count(*) FROM backups", &[]);
    assert!(matches!(
        create_backup(&w.store, &w.backups, "MANUAL", T3),
        Err(BackupError::AttachmentsPending { .. })
    ));
    assert!(matches!(
        restore_project(&w.store, &b, "PA", &opts(&w)),
        Err(BackupError::AttachmentsPending { .. })
    ));
    assert!(matches!(
        project_attachments(&w.store, "PA"),
        Err(BackupError::AttachmentsPending { .. })
    ));
    assert_eq!(i(&w, "SELECT count(*) FROM backups", &[]), backups);
    // 再次恢复没有覆盖未完成的暂存。
    assert_eq!(
        files(&root.join(".restore-staging").join("PA")),
        pairs(&[("a.txt", "v1")])
    );

    fs::remove_file(root.join(".restore-old")).unwrap();
    let after = create_backup(&w.store, &w.backups, "MANUAL", T3).unwrap();
    assert_eq!(files(&root.join("PA")), pairs(&[("a.txt", "v1")]));
    assert_eq!(
        backed_up(&w, &after.id, "PA/a.txt"),
        (vec!["PA/a.txt".to_string()], "v1".to_string())
    );
    assert!(!root.join(".restore-staging").join("PA.gen").exists());
    assert_eq!(
        project_attachments(&w.store, "PA").unwrap(),
        root.join("PA")
    );
}

/// P1-05：换入的每一步之后中断（出错，或进程在这一步退出），下一次收尾都走到同一个终态，
/// 不留暂存、旧目录和标记；之后的备份里只有目标状态的附件，没有恢复用的内部目录。
#[test]
fn a_swap_interrupted_at_any_step_finishes_on_the_next_call() {
    for step in SwapStep::ALL {
        let w = world(&format!("restore-swap-step-{step:?}"));
        let root = artifacts_root(w.store.path());
        attachment(&w, "PA", "a.txt", "v1");
        let b = backup(&w);
        attachment(&w, "PA", "a.txt", "v2");
        attachment(&w, "PA", "b.txt", "new");
        inject_swap_fault(w.store.path(), step);
        let err = restore_project(&w.store, &b, "PA", &opts(&w)).unwrap_err();
        assert!(
            matches!(err, BackupError::AttachmentsPending { .. }),
            "{step:?}: {err:?}"
        );
        // 不做任何修补，直接再收尾一次（等同重启后的那次调用）。
        assert_eq!(finish_attachment_swaps(&w.store).unwrap(), 1, "{step:?}");
        assert_eq!(
            files(&root.join("PA")),
            pairs(&[("a.txt", "v1")]),
            "{step:?}"
        );
        assert!(
            !root.join(".restore-staging").join("PA.gen").exists(),
            "{step:?}"
        );
        assert!(
            !root.join(".restore-staging").join("PA").exists(),
            "{step:?}"
        );
        assert!(
            fs::read_dir(root.join(".restore-old"))
                .map(|d| d.count() == 0)
                .unwrap_or(true),
            "{step:?}: old attachments left behind"
        );
        let after = create_backup(&w.store, &w.backups, "MANUAL", T3).unwrap();
        assert_eq!(
            backed_up(&w, &after.id, "PA/a.txt"),
            (vec!["PA/a.txt".to_string()], "v1".to_string()),
            "{step:?}"
        );
    }
}

/// 恢复用的内部目录（暂存、旧版本）不属于任何项目，不进备份。
#[test]
fn restore_internals_are_not_backed_up() {
    let w = world("restore-internals");
    let root = artifacts_root(w.store.path());
    attachment(&w, "PA", "a.txt", "v1");
    fs::create_dir_all(root.join(".restore-old").join("PA-9")).unwrap();
    fs::write(root.join(".restore-old").join("PA-9").join("x.txt"), "old").unwrap();
    fs::create_dir_all(root.join(".restore-staging").join("PB")).unwrap();
    fs::write(
        root.join(".restore-staging").join("PB").join("y.txt"),
        "staged",
    )
    .unwrap();
    let id = backup(&w);
    assert_eq!(
        backed_up(&w, &id, "PA/a.txt"),
        (vec!["PA/a.txt".to_string()], "v1".to_string())
    );
}
