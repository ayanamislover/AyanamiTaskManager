//! 按范围恢复（W1e；05 §2.7–2.8，10 R4 / R4′ / R5 / R6，W0-S 报告 §4 P2-07）。
//!
//! 一次恢复是写线程上的一个独占作业：先 ATTACH 备份库（只读），再在一个 IMMEDIATE 事务里完成全部改动，
//! 任何一步失败整体回滚。范围是一个项目，或知识库。
//!
//! 项目范围：
//! - 工作数据（任务、记录、事件、handoff、计数器、搜索文档等，见 [`PROJECT_TABLES`]）换成备份里的样子；
//! - agents / agent_sessions 属于身份与审计，不回退（R4）；session 的工作指针按 R4′ 核对，悬空就清掉并记事件；
//! - 回执不删不插：备份里有的行，状态以备份为准；备份点之后的 VALID 行原地变墓碑；已是墓碑的保留原世代（P2-07）；
//! - 全局流不删：备份里有的行，撤销标记以备份为准；备份点之后的行标上本次世代（R6）；
//! - 序号与编号取 `max(恢复前, 备份)`（R5，见 [`HighWater`]）；分配新的 scope generation 与 epoch；
//! - `import_history` 换成备份里的样子（05 §2.8：否则再次导入会被「已导入」短路）；
//! - 附件：提交前把备份里的文件放进暂存目录并写下世代标记，提交后换入（[`finish_attachment_swaps`]）。
//!
//! 只接受同一时间线的备份：data_root_id、instance_epoch 相同，且备份里这个范围的回执原样存在于当前库。
//! 回执从不删除、receipt_id 不复用，所以在同一时间线上这总是成立；不成立说明备份来自整库恢复之前，拒绝。

use crate::Store;
use crate::backup::{
    BackupError, Result, VerifiedBackup, artifacts_root, copy_tree, create_backup, path_str, pin,
    side_reader, verify_backup,
};
use crate::events::{HighWater, NewEvent, append_event, append_global, ulid};
use crate::search::rebuild_knowledge_fts;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

/// 恢复与附件收尾串行执行：暂存目录按项目命名，并发的恢复会互相踩到。
static RESTORE_LOCK: Mutex<()> = Mutex::new(());

fn restore_lock() -> std::sync::MutexGuard<'static, ()> {
    RESTORE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// 按项目恢复的工作数据表（都有 `project_id` 列）。`search_docs` 另行处理：它的 `doc_id` 是全局主键。
pub const PROJECT_TABLES: &[&str] = &[
    "counters",
    "objectives",
    "milestones",
    "work_items",
    "work_item_relations",
    "checklist_items",
    "labels",
    "work_item_labels",
    "progress_updates",
    "project_updates",
    "blockers",
    "records",
    "artifacts",
    "handoffs",
    "events",
    "review_requests",
    "review_submissions",
    "engineering_project_metrics",
    "engineering_work_item_metrics",
];

/// 有 `project_id` 列、但不按上面的方式整表替换的表，以及各自的处理方式。新加带 `project_id` 的表必须登记到两处之一。
pub const PROJECT_TABLES_HANDLED_ELSEWHERE: &[(&str, &str)] = &[
    (
        "search_docs",
        "replaced without doc_id; triggers keep search_fts in step",
    ),
    ("agents", "identity, kept (R4)"),
    (
        "agent_sessions",
        "identity, kept; work pointers checked (R4')",
    ),
    ("import_history", "replaced from the backup (05 2.8)"),
    ("global_feed", "kept; undo marks per R6"),
    ("project_paths", "kept (registry)"),
    ("saved_views", "kept (user preference)"),
    ("project_restore_requests", "kept (lifecycle requests)"),
    ("legacy_backups", "kept (2.x backup catalog)"),
];

const SEARCH_DOC_COLUMNS: &str =
    "project_id, entity_type, entity_id, entity_key, title, body, updated_at";

#[derive(Clone, Debug)]
pub struct RestoreOptions<'a> {
    /// 备份根目录：PRE_RESTORE 备份写在这里。
    pub backups_root: &'a Path,
    /// 本次恢复的时间（ISO 串），写进世代、事件与墓碑。
    pub at: &'a str,
    /// 选中的备份固定到这个时间（A4）。
    pub pin_until: &'a str,
    /// 恢复事务的时长预算。
    pub budget: Duration,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RestoreOutcome {
    pub generation: i64,
    pub epoch: String,
    pub pre_restore_backup_id: String,
    /// 恢复前的序号高水位（项目：project_seq；知识库：sequence）。
    pub seq_before: i64,
    /// 恢复后续号的起点。
    pub seq_after: i64,
    /// 本次变成墓碑的回执数。
    pub tombstoned: usize,
    /// 本次从墓碑恢复为有效的回执数（备份里它们是有效的）。
    pub revived: usize,
    /// 工作指针被清掉的 session。
    pub pointers_cleared: Vec<String>,
    /// 删掉的导入记录数。
    pub imports_removed: usize,
}

/// 把项目 `project_id` 恢复到备份 `backup_id` 时的样子。
pub fn restore_project(
    store: &Store,
    backup_id: &str,
    project_id: &str,
    opts: &RestoreOptions<'_>,
) -> Result<RestoreOutcome> {
    let _serial = restore_lock();
    let vb = verify_backup(store, backup_id)?;
    require_project(store, &vb, project_id)?;
    pin(store, backup_id, opts.pin_until)?;
    let pre = create_backup(store, opts.backups_root, "PRE_RESTORE", opts.at)?;

    // 附件：先暂存，事务里只写世代标记的「意图」，提交后换入。
    let staging = stage_attachments(store.path(), &vb, project_id)?;

    let ctx = ProjectCtx {
        project_id: project_id.to_string(),
        backup_id: backup_id.to_string(),
        pre_id: pre.id.clone(),
        backup_global_seq: vb.global_seq,
        at: opts.at.to_string(),
        staging_marker: staging.marker.clone(),
    };
    let uri = readonly_uri(&vb.db)?;
    let outcome = run(store, opts.budget, move |conn| {
        conn.execute("ATTACH DATABASE ?1 AS bk", [uri])?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let out = restore_project_tx(&tx, &ctx)?;
        tx.commit()?;
        Ok(out)
    });
    // 成功：标记里的世代已在库里，换入暂存。失败：事务回滚，世代不在库里，丢弃暂存；
    // 作业在写标记之前就失败时没有标记，暂存目录在这里直接删。
    let finished = finish_swaps_locked(store);
    if outcome.is_err() && !staging.marker.exists() && staging.dir.exists() {
        let _ = fs::remove_dir_all(&staging.dir);
    }
    let out = outcome?;
    finished?;
    Ok(out)
}

/// 把知识库恢复到备份 `backup_id` 时的样子。
pub fn restore_knowledge(
    store: &Store,
    backup_id: &str,
    opts: &RestoreOptions<'_>,
) -> Result<RestoreOutcome> {
    let _serial = restore_lock();
    let vb = verify_backup(store, backup_id)?;
    let side = side_reader(&vb.db)?;
    let present: bool =
        side.query_row("SELECT EXISTS (SELECT 1 FROM knowledge_meta)", [], |r| {
            r.get(0)
        })?;
    drop(side);
    if !present {
        return Err(BackupError::ScopeMissing("knowledge".into()));
    }
    pin(store, backup_id, opts.pin_until)?;
    let pre = create_backup(store, opts.backups_root, "PRE_RESTORE", opts.at)?;
    let ctx = KnowledgeCtx {
        backup_id: backup_id.to_string(),
        pre_id: pre.id.clone(),
        at: opts.at.to_string(),
    };
    let uri = readonly_uri(&vb.db)?;
    run(store, opts.budget, move |conn| {
        conn.execute("ATTACH DATABASE ?1 AS bk", [uri])?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let out = restore_knowledge_tx(&tx, &ctx)?;
        tx.commit()?;
        Ok(out)
    })
}

fn run<F>(store: &Store, budget: Duration, f: F) -> Result<RestoreOutcome>
where
    F: FnOnce(&mut Connection) -> Result<RestoreOutcome> + Send + 'static,
{
    match store.submit_exclusive(budget, f)?.wait() {
        Ok(out) => Ok(out),
        Err(crate::WriteError::Rejected(e)) => Err(e),
        Err(other) => Err(other.into()),
    }
}

fn require_project(store: &Store, vb: &VerifiedBackup, project_id: &str) -> Result<()> {
    let side = side_reader(&vb.db)?;
    let in_backup: bool = side.query_row(
        "SELECT EXISTS (SELECT 1 FROM projects WHERE id = ?1)",
        [project_id],
        |r| r.get(0),
    )?;
    drop(side);
    let id = project_id.to_string();
    let current: bool = store.read(move |tx| {
        tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM projects WHERE id = ?1)",
            [id],
            |r| r.get(0),
        )
    })?;
    if !in_backup || !current {
        return Err(BackupError::ScopeMissing(format!("project {project_id}")));
    }
    Ok(())
}

/// `file:` URI，只读打开。路径里的 `%`、`?`、`#` 要转义，反斜杠换成 `/`。
fn readonly_uri(path: &Path) -> Result<String> {
    let raw = path_str(path)?.replace('\\', "/");
    let mut s = String::from("file:");
    if raw.starts_with('/') {
        s.push_str("//");
    } else {
        s.push_str("///");
    }
    for c in raw.chars() {
        match c {
            '%' => s.push_str("%25"),
            '?' => s.push_str("%3F"),
            '#' => s.push_str("%23"),
            _ => s.push(c),
        }
    }
    s.push_str("?mode=ro");
    Ok(s)
}

struct ProjectCtx {
    project_id: String,
    backup_id: String,
    pre_id: String,
    backup_global_seq: i64,
    at: String,
    staging_marker: PathBuf,
}

fn restore_project_tx(tx: &Transaction<'_>, c: &ProjectCtx) -> Result<RestoreOutcome> {
    let a = c.project_id.as_str();
    tx.execute(
        "INSERT INTO restore_guard (scope_kind) VALUES ('PROJECT')",
        [],
    )?;
    let before = HighWater::capture(tx, a).map_err(event_err)?;
    let (generation, epoch) = allocate_generation(tx)?;
    // 世代标记先落盘：库里出现这个世代，说明事务提交了，附件应当换入。
    fs::write(&c.staging_marker, generation.to_string())?;

    // 1. 工作数据整表替换。
    for t in PROJECT_TABLES {
        tx.execute(&format!("DELETE FROM main.{t} WHERE project_id = ?1"), [a])?;
        tx.execute(
            &format!("INSERT INTO main.{t} SELECT * FROM bk.{t} WHERE project_id = ?1"),
            [a],
        )?;
    }
    tx.execute("DELETE FROM main.search_docs WHERE project_id = ?1", [a])?;
    tx.execute(
        &format!(
            "INSERT INTO main.search_docs ({SEARCH_DOC_COLUMNS}) SELECT {SEARCH_DOC_COLUMNS} FROM bk.search_docs WHERE project_id = ?1"
        ),
        [a],
    )?;

    // 2. 回执。
    let (tombstoned, revived) = settle_receipts(tx, "PROJECT", a, generation, &c.at)?;

    // 3. 项目行：health / meta_version 取备份；身份与 lifecycle 保持当前；version + 1；新世代。
    tx.execute(
        "UPDATE main.projects SET health = b.health, meta_version = b.meta_version, version = main.projects.version + 1,
                scope_gen = ?2, epoch = ?3, updated_at = ?4
         FROM bk.projects AS b WHERE b.id = main.projects.id AND main.projects.id = ?1",
        params![a, generation, epoch, c.at],
    )?;
    let seq_after = before.reapply(tx).map_err(event_err)?;
    tx.execute(
        "INSERT INTO scope_generations (gen, scope_kind, scope_id, reason, backup_id, pre_restore_backup_id,
                                        seq_before, seq_after, epoch, created_at)
         VALUES (?1, 'PROJECT', ?2, 'RESTORED', ?3, ?4, ?5, ?6, ?7, ?8)",
        params![generation, a, c.backup_id, c.pre_id, before.project_seq, seq_after, epoch, c.at],
    )?;

    // 4. 全局流：先打撤销标记，再追加本次恢复自己的事件（否则它们也会被标成已撤销）。
    tx.execute(
        "UPDATE main.global_feed SET undone_by_restore_gen = b.undone_by_restore_gen
         FROM bk.global_feed AS b WHERE b.global_seq = main.global_feed.global_seq AND main.global_feed.project_id = ?1",
        [a],
    )?;
    tx.execute(
        "UPDATE main.global_feed SET undone_by_restore_gen = ?2
         WHERE project_id = ?1 AND global_seq > ?3 AND undone_by_restore_gen IS NULL",
        params![a, generation, c.backup_global_seq],
    )?;

    // 5. 导入记录。
    let imports_removed = tx.execute(
        "DELETE FROM main.import_history WHERE project_id = ?1
           AND source_sha256 NOT IN (SELECT source_sha256 FROM bk.import_history WHERE project_id = ?1)",
        [a],
    )?;
    tx.execute("DELETE FROM main.import_history WHERE project_id = ?1", [a])?;
    tx.execute(
        "INSERT INTO main.import_history SELECT * FROM bk.import_history WHERE project_id = ?1",
        [a],
    )?;

    // 6. session 的工作指针（R4′）。
    let pointers_cleared = clear_dangling_pointers(tx, a, generation, &c.at)?;

    // 7. 本次恢复的事件。
    let payload: String = tx.query_row(
        "SELECT json_object('gen', ?1, 'backupId', ?2, 'preRestoreBackupId', ?3, 'seqBefore', ?4, 'importsRemoved', ?5)",
        params![generation, c.backup_id, c.pre_id, before.project_seq, imports_removed as i64],
        |r| r.get(0),
    )?;
    append_event(
        tx,
        &NewEvent {
            project_id: a,
            kind: "project.restored",
            actor_type: "USER",
            actor_id: "USER",
            session_id: None,
            aggregate_type: "PROJECT",
            aggregate_id: a,
            correlation_id: None,
            op_id: None,
            payload_json: &payload,
            at: &c.at,
        },
    )
    .map_err(event_err)?;
    let global: String = tx.query_row(
        "SELECT json_object('scope', 'PROJECT', 'projectId', ?1, 'gen', ?2)",
        params![a, generation],
        |r| r.get(0),
    )?;
    append_global(
        tx,
        "backup.restored",
        &c.backup_id,
        "USER",
        &global,
        None,
        &c.at,
    )
    .map_err(event_err)?;

    tx.execute("DELETE FROM restore_guard WHERE scope_kind = 'PROJECT'", [])?;
    Ok(RestoreOutcome {
        generation,
        epoch,
        pre_restore_backup_id: c.pre_id.clone(),
        seq_before: before.project_seq,
        seq_after,
        tombstoned,
        revived,
        pointers_cleared,
        imports_removed,
    })
}

struct KnowledgeCtx {
    backup_id: String,
    pre_id: String,
    at: String,
}

fn restore_knowledge_tx(tx: &Transaction<'_>, c: &KnowledgeCtx) -> Result<RestoreOutcome> {
    let (database_id, seq_before): (String, i64) = tx
        .query_row(
            "SELECT database_id, sequence FROM main.knowledge_meta",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| BackupError::ScopeMissing("knowledge (current)".into()))?;
    let backup_seq: i64 =
        tx.query_row("SELECT sequence FROM bk.knowledge_meta", [], |r| r.get(0))?;
    tx.execute(
        "INSERT INTO restore_guard (scope_kind) VALUES ('KNOWLEDGE')",
        [],
    )?;
    let (generation, epoch) = allocate_generation(tx)?;

    tx.execute("DELETE FROM main.knowledge_entries", [])?;
    tx.execute("DELETE FROM main.knowledge_revisions", [])?;
    tx.execute(
        "INSERT INTO main.knowledge_revisions SELECT * FROM bk.knowledge_revisions",
        [],
    )?;
    tx.execute(
        "INSERT INTO main.knowledge_entries SELECT * FROM bk.knowledge_entries",
        [],
    )?;

    let (tombstoned, revived) = settle_receipts(tx, "KNOWLEDGE", &database_id, generation, &c.at)?;

    // 05 §2.7 第 7 步：知识库推进 sequence、换 generation。
    let seq_after = seq_before.max(backup_seq) + 1;
    let new_generation = ulid(tx)?;
    tx.execute(
        "UPDATE main.knowledge_meta SET sequence = ?1, generation = ?2, scope_gen = ?3",
        params![seq_after, new_generation, generation],
    )?;
    tx.execute(
        "INSERT INTO scope_generations (gen, scope_kind, scope_id, reason, backup_id, pre_restore_backup_id,
                                        seq_before, seq_after, epoch, created_at)
         VALUES (?1, 'KNOWLEDGE', ?2, 'RESTORED', ?3, ?4, ?5, ?6, ?7, ?8)",
        params![generation, database_id, c.backup_id, c.pre_id, seq_before, seq_after, epoch, c.at],
    )?;
    rebuild_knowledge_fts(tx)?;
    let global: String = tx.query_row(
        "SELECT json_object('scope', 'KNOWLEDGE', 'gen', ?1)",
        [generation],
        |r| r.get(0),
    )?;
    append_global(
        tx,
        "backup.restored",
        &c.backup_id,
        "USER",
        &global,
        None,
        &c.at,
    )
    .map_err(event_err)?;
    tx.execute(
        "DELETE FROM restore_guard WHERE scope_kind = 'KNOWLEDGE'",
        [],
    )?;
    Ok(RestoreOutcome {
        generation,
        epoch,
        pre_restore_backup_id: c.pre_id.clone(),
        seq_before,
        seq_after,
        tombstoned,
        revived,
        pointers_cleared: Vec::new(),
        imports_removed: 0,
    })
}

/// 新的 scope generation：全局单调，永不复用。计数器落后于已有世代时（数据异常）也不会撞号。
fn allocate_generation(tx: &Transaction<'_>) -> Result<(i64, String)> {
    let generation: i64 = tx
        .query_row(
            "UPDATE app_meta SET scope_gen_counter =
               max(scope_gen_counter, coalesce((SELECT max(gen) FROM scope_generations), 0)) + 1
             RETURNING scope_gen_counter",
            [],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| BackupError::Corrupt("app_meta is missing".into()))?;
    Ok((generation, ulid(tx)?))
}

/// 回执的原地处理（P2-07）。返回 (新墓碑数, 复活数)。
fn settle_receipts(
    tx: &Transaction<'_>,
    kind: &str,
    scope: &str,
    generation: i64,
    at: &str,
) -> Result<(usize, usize)> {
    // 同一时间线：备份里的每一行都原样在当前库里，只有状态列可能不同。
    let foreign: i64 = tx.query_row(
        "SELECT count(*) FROM bk.idempotency_receipts AS b
         LEFT JOIN main.idempotency_receipts AS c ON c.receipt_id = b.receipt_id
         WHERE b.scope_kind = ?1 AND b.scope_id = ?2 AND (
               c.receipt_id IS NULL
            OR c.scope_kind IS NOT b.scope_kind OR c.scope_id IS NOT b.scope_id
            OR c.ns_kind IS NOT b.ns_kind OR c.ns_id IS NOT b.ns_id OR c.op_id IS NOT b.op_id
            OR c.legacy_key IS NOT b.legacy_key OR c.operation IS NOT b.operation
            OR c.fp_v IS NOT b.fp_v OR c.fingerprint IS NOT b.fingerprint OR c.receipt_json IS NOT b.receipt_json
            OR c.call_principal_kind IS NOT b.call_principal_kind OR c.call_principal_id IS NOT b.call_principal_id
            OR c.call_operation IS NOT b.call_operation)",
        [kind, scope],
        |r| r.get(0),
    )?;
    if foreign > 0 {
        return Err(BackupError::TimelineMismatch(format!(
            "{foreign} receipt(s) in the backup do not match"
        )));
    }
    let revived: i64 = tx.query_row(
        "SELECT count(*) FROM main.idempotency_receipts AS c JOIN bk.idempotency_receipts AS b ON b.receipt_id = c.receipt_id
         WHERE c.scope_kind = ?1 AND c.scope_id = ?2 AND c.state = 'TOMBSTONED' AND b.state = 'VALID'",
        [kind, scope],
        |r| r.get(0),
    )?;
    // 备份里有的行：状态以备份为准（包括备份之前就形成的墓碑）。
    tx.execute(
        "UPDATE main.idempotency_receipts
         SET state = b.state, tombstoned_by_gen = b.tombstoned_by_gen, tombstoned_at = b.tombstoned_at
         FROM bk.idempotency_receipts AS b
         WHERE b.receipt_id = main.idempotency_receipts.receipt_id
           AND main.idempotency_receipts.scope_kind = ?1 AND main.idempotency_receipts.scope_id = ?2",
        [kind, scope],
    )?;
    // 备份点之后的行：有效的变墓碑；已是墓碑的保留原世代。
    let tombstoned = tx.execute(
        "UPDATE main.idempotency_receipts SET state = 'TOMBSTONED', tombstoned_by_gen = ?3, tombstoned_at = ?4
         WHERE scope_kind = ?1 AND scope_id = ?2 AND state = 'VALID'
           AND receipt_id NOT IN (SELECT receipt_id FROM bk.idempotency_receipts WHERE scope_kind = ?1 AND scope_id = ?2)",
        params![kind, scope, generation, at],
    )?;
    Ok((tombstoned, revived as usize))
}

/// R4′：工作指针指向的任务不存在，或任务的领取不属于这个 session 的 lineage，就清掉并记事件。
fn clear_dangling_pointers(
    tx: &Transaction<'_>,
    project: &str,
    generation: i64,
    at: &str,
) -> Result<Vec<String>> {
    struct S {
        agent: String,
        role: String,
        predecessor: Option<String>,
        started: String,
        current: Option<String>,
    }
    let sessions: HashMap<String, S> = {
        let mut st = tx.prepare(
            "SELECT id, agent_id, role, predecessor_session_id, started_at, current_work_item_id
             FROM agent_sessions WHERE project_id = ?1",
        )?;
        st.query_map([project], |r| {
            Ok((
                r.get::<_, String>(0)?,
                S {
                    agent: r.get(1)?,
                    role: r.get(2)?,
                    predecessor: r.get(3)?,
                    started: r.get(4)?,
                    current: r.get(5)?,
                },
            ))
        })?
        .collect::<rusqlite::Result<_>>()?
    };
    // lineage（R3）：只沿 predecessor 边，同 agent、同 role，后继不早于前序。
    let mut parent: HashMap<&str, &str> =
        sessions.keys().map(|k| (k.as_str(), k.as_str())).collect();
    fn find<'a>(p: &mut HashMap<&'a str, &'a str>, mut x: &'a str) -> &'a str {
        while p[x] != x {
            let up = p[p[x]];
            p.insert(x, up);
            x = up;
        }
        x
    }
    for (id, s) in &sessions {
        if let Some(pred) = s.predecessor.as_deref()
            && let Some((pid, p)) = sessions.get_key_value(pred)
            && p.agent == s.agent
            && p.role == s.role
            && s.started >= p.started
        {
            let (ra, rb) = (find(&mut parent, id), find(&mut parent, pid));
            parent.insert(ra, rb);
        }
    }
    let mut cleared = Vec::new();
    let mut ids: Vec<&String> = sessions.keys().collect();
    ids.sort();
    for id in ids {
        let Some(work) = sessions[id].current.as_deref() else {
            continue;
        };
        let claim: Option<Option<String>> = tx
            .query_row(
                "SELECT claimed_by_session_id FROM work_items WHERE project_id = ?1 AND id = ?2",
                [project, work],
                |r| r.get(0),
            )
            .optional()?;
        let keep = match claim {
            Some(Some(holder)) => match sessions.get_key_value(&holder) {
                Some((holder, _)) => find(&mut parent, holder) == find(&mut parent, id),
                None => false,
            },
            _ => false,
        };
        if keep {
            continue;
        }
        tx.execute(
            "UPDATE agent_sessions SET current_work_item_id = NULL, work_state = 'IDLE', version = version + 1, updated_at = ?3
             WHERE project_id = ?1 AND id = ?2",
            params![project, id, at],
        )?;
        let payload: String = tx.query_row(
            "SELECT json_object('restoreGeneration', ?1, 'workItemId', ?2)",
            params![generation, work],
            |r| r.get(0),
        )?;
        append_event(
            tx,
            &NewEvent {
                project_id: project,
                kind: "session.work_pointer_cleared",
                actor_type: "SYSTEM",
                actor_id: "SYSTEM",
                session_id: Some(id),
                aggregate_type: "SESSION",
                aggregate_id: id,
                correlation_id: None,
                op_id: None,
                payload_json: &payload,
                at,
            },
        )
        .map_err(event_err)?;
        cleared.push(id.clone());
    }
    Ok(cleared)
}

fn event_err(e: crate::events::EventError) -> BackupError {
    match e {
        crate::events::EventError::Sqlite(e) => BackupError::Sqlite(e),
        other => BackupError::Corrupt(other.to_string()),
    }
}

/// 范围的当前 scope generation（R4 屏障）。
#[derive(Clone, Copy, Debug)]
pub enum ScopeRef<'a> {
    Project(&'a str),
    Knowledge,
}

pub fn current_generation(
    tx: &Transaction<'_>,
    scope: ScopeRef<'_>,
) -> rusqlite::Result<Option<i64>> {
    match scope {
        ScopeRef::Project(id) => tx
            .query_row("SELECT scope_gen FROM projects WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .optional(),
        ScopeRef::Knowledge => tx
            .query_row("SELECT scope_gen FROM knowledge_meta", [], |r| r.get(0))
            .optional(),
    }
}

/// 入队时记下的世代与执行时不一致：期间发生过恢复（SCOPE_RESTORED，409，不可重试，零写入）。
#[derive(Debug, PartialEq, Eq)]
pub struct ScopeRestored {
    pub expected: i64,
    pub current: Option<i64>,
}

/// 写作业执行前复核世代（R4 屏障）。外层 `Err` 是 SQLite 错误，内层 `Err` 是 SCOPE_RESTORED。
pub fn ensure_generation(
    tx: &Transaction<'_>,
    scope: ScopeRef<'_>,
    expected: i64,
) -> rusqlite::Result<std::result::Result<(), ScopeRestored>> {
    let current = current_generation(tx, scope)?;
    Ok(if current == Some(expected) {
        Ok(())
    } else {
        Err(ScopeRestored { expected, current })
    })
}

// ===== 附件的暂存与换入 =====

const STAGING_DIR: &str = ".restore-staging";
const OLD_DIR: &str = ".restore-old";

struct Staging {
    dir: PathBuf,
    marker: PathBuf,
}

/// 把备份里属于 `project_id` 的附件复制进暂存目录，并核对与 manifest 一致。
fn stage_attachments(db_path: &Path, vb: &VerifiedBackup, project_id: &str) -> Result<Staging> {
    let root = artifacts_root(db_path);
    let staging_root = root.join(STAGING_DIR);
    let staged = staging_root.join(project_id);
    if staged.exists() {
        fs::remove_dir_all(&staged)?;
    }
    // 备份里这个项目没有附件时也要有暂存目录：换入后，备份点之后新增的附件随之移走。
    fs::create_dir_all(&staged)?;
    let source = vb.artifacts_dir().join(project_id);
    let copied = copy_tree(&source, &staged)?;
    let prefix = format!("{project_id}/");
    let expected: Vec<_> = vb
        .attachments
        .iter()
        .filter(|f| f.path.starts_with(&prefix))
        .map(|f| crate::backup::FileEntry {
            path: f.path[prefix.len()..].to_string(),
            ..f.clone()
        })
        .collect();
    if copied != expected {
        return Err(BackupError::Corrupt(format!(
            "attachments of {project_id} differ from the manifest"
        )));
    }
    Ok(Staging {
        dir: staged,
        marker: staging_root.join(format!("{project_id}.gen")),
    })
}

/// 完成或丢弃附件换入。恢复结束时调用，服务启动时也要调用一次（上次可能在提交后、换入前退出）。
///
/// 每个 `<项目>.gen` 标记记着一次恢复的世代：库里该项目的 scope_gen 等于它，说明事务已提交，换入暂存；
/// 否则事务没有提交，丢弃暂存。每一步都可重复执行。返回处理过的标记数。
pub fn finish_attachment_swaps(store: &Store) -> Result<usize> {
    let _serial = restore_lock();
    finish_swaps_locked(store)
}

fn finish_swaps_locked(store: &Store) -> Result<usize> {
    let root = artifacts_root(store.path());
    let staging_root = root.join(STAGING_DIR);
    if !staging_root.exists() {
        return Ok(0);
    }
    let mut done = 0;
    let mut markers: Vec<PathBuf> = fs::read_dir(&staging_root)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "gen"))
        .collect();
    markers.sort();
    for marker in markers {
        let project = marker
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let wanted: Option<i64> = fs::read_to_string(&marker)
            .ok()
            .and_then(|s| s.trim().parse().ok());
        let id = project.clone();
        let current: Option<i64> = store.read(move |tx| {
            tx.query_row("SELECT scope_gen FROM projects WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .optional()
        })?;
        let staged = staging_root.join(&project);
        let live = root.join(&project);
        if wanted.is_some() && wanted == current {
            if staged.exists() {
                let old = root
                    .join(OLD_DIR)
                    .join(format!("{project}-{}", wanted.unwrap_or_default()));
                if live.exists() {
                    if old.exists() {
                        fs::remove_dir_all(&old)?;
                    }
                    fs::create_dir_all(root.join(OLD_DIR))?;
                    fs::rename(&live, &old)?;
                }
                fs::rename(&staged, &live)?;
                if old.exists() {
                    fs::remove_dir_all(&old)?;
                }
            }
        } else if staged.exists() {
            fs::remove_dir_all(&staged)?;
        }
        fs::remove_file(&marker)?;
        done += 1;
    }
    Ok(done)
}
