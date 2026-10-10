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
    AttachmentsGuard, BackupError, BackupsRoot, Result, VerifiedBackup, attachments_lock,
    copy_tree, create_backup_locked, path_str, pin, side_reader, verify_backup,
};
use crate::events::{HighWater, NewEvent, append_event, append_global, ulid};
use crate::search::rebuild_knowledge_fts;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

/// 按项目恢复的工作数据表（都有 `project_id` 列）。`search_docs` 另行处理：它的 `doc_id` 是全局主键。
pub const PROJECT_TABLES: &[&str] = &[
    "counters",
    "objectives",
    "milestones",
    "work_items",
    "work_item_relations",
    "checklist_items",
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
    let mut serial = attachments_lock(store, "restore_project")?;
    // 上一次恢复没换完的附件先换完；换不完就拒绝，不覆盖它的暂存。
    finish_swaps_locked(store, &mut serial)?;
    // 撤回放不回来的备份目录先归位，选中的那份才校验得过（W2 peer r2 P1-02）。
    let mut backups = BackupsRoot::pin_for(store, opts.backups_root)?;
    crate::backup::sweep_withdrawn_locked(store, &mut backups);
    let vb = verify_backup(store, backup_id)?;
    require_project(store, &vb, project_id)?;
    pin(store, backup_id, opts.pin_until)?;
    let pre = create_backup_locked(store, &mut backups, &mut serial, "PRE_RESTORE", opts.at)?;

    // 附件：先暂存，事务里只写世代标记的「意图」，提交后换入。
    let staging = stage_attachments(&mut serial, &vb, project_id)?;

    let ctx = ProjectCtx {
        project_id: project_id.to_string(),
        backup_id: backup_id.to_string(),
        pre_id: pre.id.clone(),
        backup_global_seq: vb.global_seq,
        at: opts.at.to_string(),
        staging_marker: staging.marker.clone(),
    };
    let uri = readonly_uri(&vb.source_db())?;
    let db = store.path().to_path_buf();
    let outcome = run(store, opts.budget, move |conn| {
        conn.execute("ATTACH DATABASE ?1 AS bk", [uri])?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let out = restore_project_tx(&tx, &ctx)?;
        fault(&db, SwapStep::BeforeCommit)?;
        tx.commit()?;
        Ok(out)
    });
    if outcome.is_ok() {
        fault(store.path(), SwapStep::AfterCommit)?;
    }
    // 成功：标记里的世代已在库里，换入暂存。失败：事务回滚，世代不在库里，丢弃暂存；
    // 作业在写标记之前就失败时没有标记，暂存目录在这里直接删。
    // 库已提交而换入失败时返回 AttachmentsPending：调用方不能把它当作已回滚。
    let finished = finish_swaps_locked(store, &mut serial);
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
    let mut serial = attachments_lock(store, "restore_knowledge")?;
    finish_swaps_locked(store, &mut serial)?;
    // 撤回放不回来的备份目录先归位，选中的那份才校验得过（W2 peer r2 P1-02）。
    let mut backups = BackupsRoot::pin_for(store, opts.backups_root)?;
    crate::backup::sweep_withdrawn_locked(store, &mut backups);
    let vb = verify_backup(store, backup_id)?;
    let side = side_reader(&vb.source_db())?;
    let present: bool =
        side.query_row("SELECT EXISTS (SELECT 1 FROM knowledge_meta)", [], |r| {
            r.get(0)
        })?;
    drop(side);
    if !present {
        return Err(BackupError::ScopeMissing("knowledge".into()));
    }
    pin(store, backup_id, opts.pin_until)?;
    let pre = create_backup_locked(store, &mut backups, &mut serial, "PRE_RESTORE", opts.at)?;
    let ctx = KnowledgeCtx {
        backup_id: backup_id.to_string(),
        pre_id: pre.id.clone(),
        at: opts.at.to_string(),
    };
    let uri = readonly_uri(&vb.source_db())?;
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
    let side = side_reader(&vb.source_db())?;
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
///
/// `\\?\` 完整写法（钉住的真实位置，peer W6 r4 P2-01）换成 `/` 就不再是完整写法了：反斜杠原样转义成 `%5C`、
/// 不加 `//`，SQLite 解码后拿到的正是原来的路径。
pub(crate) fn readonly_uri(path: &Path) -> Result<String> {
    let text = path_str(path)?;
    if text.starts_with(r"\\?\") {
        let mut s = String::from("file:");
        for c in text.chars() {
            match c {
                '%' => s.push_str("%25"),
                '?' => s.push_str("%3F"),
                '#' => s.push_str("%23"),
                '\\' => s.push_str("%5C"),
                _ => s.push(c),
            }
        }
        s.push_str("?mode=ro");
        return Ok(s);
    }
    let raw = text.replace('\\', "/");
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
/// 建项目（04 L-001）也从这里取初始世代。
pub fn allocate_generation(tx: &Transaction<'_>) -> Result<(i64, String)> {
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

pub(crate) const STAGING_DIR: &str = ".restore-staging";
pub(crate) const OLD_DIR: &str = ".restore-old";

struct Staging {
    dir: PathBuf,
    marker: PathBuf,
}

/// 把备份里属于 `project_id` 的附件复制进暂存目录，并核对与 manifest 一致。
///
/// 附件根与 `.restore-staging` 钉住（不存在就排他新建）；这个项目的暂存目录排他新建、复制与核对期间一直钉着
/// （peer W6 r3 P1-01）。返回前放开：提交之后要把它改名换入。
fn stage_attachments(
    guard: &mut AttachmentsGuard,
    vb: &VerifiedBackup,
    project_id: &str,
) -> Result<Staging> {
    let staging_root = guard.ensure(&[STAGING_DIR])?;
    let staged = staging_root.join(project_id);
    // 上一次留下的：放在钉住的 `.restore-staging` 里；是链接的话 remove_dir_all 只删链接本身。
    if fs::symlink_metadata(&staged).is_ok() {
        fs::remove_dir_all(&staged)?;
    }
    // 备份里这个项目没有附件时也要有暂存目录：换入后，备份点之后新增的附件随之移走。
    let owned = guard.create_owned(&[STAGING_DIR], project_id)?;
    // 读的是校验时钉住的那份备份（peer W6 r4 P1-02 的同类通道）。
    let copied = match vb.source_artifacts() {
        Some(a) => copy_tree(&a.join(project_id), &staged)?,
        None => Vec::new(),
    };
    drop(owned);
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
/// 否则事务没有提交，丢弃暂存。每一步都可重复执行：在任何一步中断（出错或进程退出），
/// 再调用一次都会走到同一个终态。已提交的换入失败时返回 [`BackupError::AttachmentsPending`]。
/// 返回处理过的标记数。
pub fn finish_attachment_swaps(store: &Store) -> Result<usize> {
    let mut serial = attachments_lock(store, "finish_attachment_swaps")?;
    finish_swaps_locked(store, &mut serial)
}

/// 一次附件访问拿到的东西，只在回调里有效。
#[derive(Debug)]
pub struct ProjectAttachments<'a> {
    /// 这个项目的附件目录（真实位置，读写用它）。项目存在时它一定存在，回调期间一直钉着：改不了名、换不成链接。
    /// 它是 `\\?\` 完整写法。用 `Path::join` / `push` 往上拼没问题（Rust 遇到这种前缀会把 `/` 归一成 `\`），
    /// 但不要按字符串拼接：完整写法下系统不再把 `/` 当分隔符。
    /// 项目不存在时不建，也不该往里写。要写进库（附件行的 `local_path`）的路径照旧按
    /// [`crate::backup::artifacts_root`]`(store.path())` 拼，与库里别的附件行同一种写法。
    pub dir: &'a Path,
    /// 锁内读到的项目当前世代，项目不存在时为 None。持锁期间没有恢复能提交，所以整个访问里它不变。
    pub generation: Option<i64>,
}

/// 在附件协调锁里访问一个项目的附件目录（W1 peer r2 P1-r2-02）。附件的读写（W3）都要经过这里。
///
/// 先换完这个库没换完的附件，换不完就拒绝；`f` 执行的整段时间里持锁，备份、恢复、收尾都要等它结束，
/// 所以一次访问看到的要么是恢复前、要么是恢复后的完整一份，写入也不会和备份交错。
///
/// 项目目录与导出、备份同一条链接边界（peer W6 r3 P1-02）：已有的项目目录是链接就拒绝
/// （[`BackupError::LinkedPath`]）；没有就排他新建；回调期间从附件根到项目目录一直钉着。`project_id` 只能是
/// 一个普通的名字。
/// `f` 里不要调用 Store 的写入、读取、备份或恢复，也不要做和附件无关的长操作：锁是全进程的。
pub fn with_project_attachments<R>(
    store: &Store,
    project_id: &str,
    f: impl FnOnce(ProjectAttachments<'_>) -> std::io::Result<R>,
) -> Result<R> {
    if !single_name(project_id) {
        return Err(BackupError::NotFound(format!("project {project_id}")));
    }
    let mut serial = attachments_lock(store, "with_project_attachments")?;
    finish_swaps_locked(store, &mut serial)?;
    let id = project_id.to_string();
    let generation: Option<i64> = store.read(move |tx| {
        tx.query_row("SELECT scope_gen FROM projects WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .optional()
    })?;
    let dir = if generation.is_some() {
        serial.ensure(&[project_id])?
    } else {
        serial.artifacts().join(project_id)
    };
    f(ProjectAttachments {
        dir: &dir,
        generation,
    })
    .map_err(BackupError::Io)
}

fn single_name(name: &str) -> bool {
    let mut parts = Path::new(name).components();
    matches!(parts.next(), Some(std::path::Component::Normal(_))) && parts.next().is_none()
}

/// 恢复的各个步骤，供测试注入故障：在这一步返回错误（之后再调用一次收尾，等同于重启），
/// 或者在这一步让进程真的退出（W1 peer r4 P2-05）。
#[doc(hidden)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SwapStep {
    /// 世代标记已落盘、库事务还没提交。
    BeforeCommit,
    /// 库事务已提交、还没开始换入附件。
    AfterCommit,
    MoveLiveAside,
    MoveStagedIn,
    RemoveOld,
    RemoveMarker,
}

impl SwapStep {
    /// 换入本身的四步（提交之后，失败时返回 AttachmentsPending）。
    pub const ALL: [SwapStep; 4] = [
        SwapStep::MoveLiveAside,
        SwapStep::MoveStagedIn,
        SwapStep::RemoveOld,
        SwapStep::RemoveMarker,
    ];

    /// 进程可能退出的全部位置：提交前后，加上换入的四步。
    pub const EXIT_POINTS: [SwapStep; 6] = [
        SwapStep::BeforeCommit,
        SwapStep::AfterCommit,
        SwapStep::MoveLiveAside,
        SwapStep::MoveStagedIn,
        SwapStep::RemoveOld,
        SwapStep::RemoveMarker,
    ];
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FaultMode {
    Fail,
    Exit,
}

static SWAP_FAULTS: Mutex<Vec<(PathBuf, SwapStep, FaultMode)>> = Mutex::new(Vec::new());

/// 进程在注入点退出时的退出码，供父进程确认子进程确实走到了那一步。
#[doc(hidden)]
pub const SWAP_EXIT_CODE: i32 = 86;

/// 测试用：这个库下一次走到 `step` 时失败一次。
#[doc(hidden)]
pub fn inject_swap_fault(db_path: &Path, step: SwapStep) {
    SWAP_FAULTS.lock().unwrap_or_else(|e| e.into_inner()).push((
        db_path.to_path_buf(),
        step,
        FaultMode::Fail,
    ));
}

/// 测试用：这个库下一次走到 `step` 时，整个进程立刻退出（不跑析构、不刷缓冲），
/// 退出码 [`SWAP_EXIT_CODE`]。只在子进程里用。
#[doc(hidden)]
pub fn inject_swap_exit(db_path: &Path, step: SwapStep) {
    SWAP_FAULTS.lock().unwrap_or_else(|e| e.into_inner()).push((
        db_path.to_path_buf(),
        step,
        FaultMode::Exit,
    ));
}

/// 单元测试用：每走到一步先调一次，在两步之间安排「另一个进程」的动作（peer W6 r4 P1-03 的交错）。
#[cfg(test)]
type Interleave = Box<dyn FnMut(&Path, SwapStep) + Send>;
#[cfg(test)]
static INTERLEAVE: Mutex<Option<Interleave>> = Mutex::new(None);

fn fault(db_path: &Path, step: SwapStep) -> std::io::Result<()> {
    #[cfg(test)]
    if let Some(f) = INTERLEAVE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_mut()
    {
        f(db_path, step);
    }
    let mut faults = SWAP_FAULTS.lock().unwrap_or_else(|e| e.into_inner());
    match faults
        .iter()
        .position(|(p, s, _)| p == db_path && *s == step)
    {
        Some(i) => {
            let (_, _, mode) = faults.remove(i);
            if mode == FaultMode::Exit {
                std::process::exit(SWAP_EXIT_CODE);
            }
            Err(std::io::Error::other(format!("injected fault at {step:?}")))
        }
        None => Ok(()),
    }
}

/// 一个换入标记。
struct Marker {
    path: PathBuf,
    project: String,
    /// 标记里记的世代。
    wanted: Option<i64>,
    /// 库里这个项目当前的世代。
    current: Option<i64>,
}

impl Marker {
    /// 事务已提交（库里就是标记里的世代）：该换入，不是丢弃。
    fn committed(&self) -> Option<i64> {
        self.wanted.filter(|w| Some(*w) == self.current)
    }
}

/// `.restore-staging` 整条链都钉住了才读（peer W6 r4 P1-01）：取得守卫时不存在、之后才出现的照样核对，是链接
/// 就拒绝；不在就没有标记。返回暂存根的真实位置与其中的标记。
fn markers(store: &Store, guard: &mut AttachmentsGuard) -> Result<(PathBuf, Vec<Marker>)> {
    let Some(staging_root) = guard.existing(&[STAGING_DIR])? else {
        return Ok((PathBuf::new(), Vec::new()));
    };
    let mut paths: Vec<PathBuf> = fs::read_dir(&staging_root)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "gen"))
        .collect();
    paths.sort();
    let mut out = Vec::new();
    for marker in paths {
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
        out.push(Marker {
            path: marker,
            project,
            wanted,
            current,
        });
    }
    Ok((staging_root, out))
}

/// 有已提交、未换入的附件就拒绝（持锁的调用方用，例如 PRE_RESTORE 备份）。
pub(crate) fn refuse_pending_swaps(store: &Store, guard: &mut AttachmentsGuard) -> Result<()> {
    for m in markers(store, guard)?.1 {
        if let Some(g) = m.committed() {
            return Err(BackupError::AttachmentsPending {
                project: m.project,
                generation: g,
                cause: "an earlier restore has not finished swapping attachments".into(),
            });
        }
    }
    Ok(())
}

/// 读写都在 `guard` 钉住的真实位置（peer W6 r3 P1-01）。
pub(crate) fn finish_swaps_locked(store: &Store, guard: &mut AttachmentsGuard) -> Result<usize> {
    let db = store.path();
    let (staging_root, found) = markers(store, guard)?;
    let mut done = 0;
    for m in found {
        let staged = staging_root.join(&m.project);
        if let Some(g) = m.committed() {
            swap_in(db, guard, &staged, &m.path, &m.project, g).map_err(|e| {
                BackupError::AttachmentsPending {
                    project: m.project.clone(),
                    generation: g,
                    cause: e.to_string(),
                }
            })?;
        } else {
            if staged.exists() {
                fs::remove_dir_all(&staged)?;
            }
            fs::remove_file(&m.path)?;
        }
        done += 1;
    }
    Ok(done)
}

/// 已提交的换入：live → `.restore-old/<项目>-<世代>`，暂存 → live，删旧目录，删标记。
/// 中断在任何一步，重来一次都能走完：暂存还在就继续换入；旧目录还在就删；最后删标记。
///
/// 附件根、`.restore-staging` 由 `guard` 钉着；`.restore-old` 只经 `guard` 访问（要用时排他新建，已有的先核对，
/// peer W6 r4 P1-01）。暂存目录按句柄打开、核对、一直开着到按句柄改名生效（peer W6 r4 P1-03）：核对之后它既改不了名
/// 也换不成链接；打开时它已经是链接或别的东西，就不换入、留着标记（换进去的会是一个指向别处的附件目录）。
fn swap_in(
    db: &Path,
    guard: &mut AttachmentsGuard,
    staged: &Path,
    marker: &Path,
    project: &str,
    generation: i64,
) -> Result<()> {
    let live = guard.artifacts().join(project);
    let old_name = format!("{project}-{generation}");
    let name = std::ffi::OsStr::new(project);
    let linked = || BackupError::LinkedPath(staged.display().to_string());
    let opened = match guard.dir(&[STAGING_DIR]) {
        Some(parent) => match crate::pin::open_movable(parent, name) {
            Ok(m) => Some(m),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) if e.kind() == std::io::ErrorKind::InvalidData => return Err(linked()),
            Err(e) => return Err(e.into()),
        },
        None => None,
    };
    if let Some(stage) = opened {
        if fs::symlink_metadata(&live).is_ok() {
            let old = guard.ensure(&[OLD_DIR])?.join(&old_name);
            if fs::symlink_metadata(&old).is_ok() {
                // 上一次中断在「live 移走之后、暂存换入之前」，然后 live 又被重建过：旧的那份作废。
                fs::remove_dir_all(&old)?;
            }
            fault(db, SwapStep::MoveLiveAside)?;
            atm_install_state::durable::rename(&live, &old, false)?;
        }
        fault(db, SwapStep::MoveStagedIn)?;
        let root = guard.dir(&[]).ok_or_else(linked)?;
        stage.move_into(root, name)?;
    }
    if let Some(old_root) = guard.existing(&[OLD_DIR])? {
        let old = old_root.join(&old_name);
        if fs::symlink_metadata(&old).is_ok() {
            fault(db, SwapStep::RemoveOld)?;
            fs::remove_dir_all(&old)?;
        }
    }
    fault(db, SwapStep::RemoveMarker)?;
    fs::remove_file(marker)?;
    Ok(())
}

#[cfg(all(test, windows))]
mod late_swap {
    use super::*;
    use std::sync::Arc;

    fn base(name: &str) -> PathBuf {
        let d = std::env::var_os("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .unwrap()
                    .join("target")
            })
            .join("store-unit")
            .join(format!("restore-{name}"));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn junction(link: &Path, target: &Path) -> bool {
        std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success()
    }

    /// peer W6 r4 P1-03：暂存核对通过之后、换入之前，另一方想把它挪走、在原名上放一个指向外面的 junction。
    /// 核对用的句柄一直开着，挪不走、名字也占着；换入照常完成，live 是恢复出来的那份真实目录。
    #[test]
    fn the_checked_staging_cannot_be_replaced_before_it_moves_in() {
        let b = base("late-swap");
        fs::create_dir_all(b.join("N/artifacts/.restore-staging/PA")).unwrap();
        fs::create_dir_all(b.join("N/artifacts/PA")).unwrap();
        let store = Store::open(&b.join("N/atm.sqlite"), crate::Config::default()).unwrap();
        let mut guard = attachments_lock(&store, "late_swap").unwrap();
        let root = guard.artifacts();
        let staged = root.join(STAGING_DIR).join("PA");
        let marker = root.join(STAGING_DIR).join("PA.gen");
        fs::write(&marker, b"1").unwrap();
        fs::write(staged.join("a.txt"), b"restored").unwrap();
        fs::write(root.join("PA/a.txt"), b"live").unwrap();
        let outside = b.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("a.txt"), b"external").unwrap();

        let tried: Arc<Mutex<Vec<String>>> = Arc::default();
        let (seen, db) = (tried.clone(), store.path().to_path_buf());
        let (stage, kept, out) = (staged.clone(), b.join("kept"), outside.clone());
        *INTERLEAVE.lock().unwrap() = Some(Box::new(move |at, step| {
            if at != db || step != SwapStep::MoveStagedIn {
                return;
            }
            let moved = fs::rename(&stage, &kept);
            let linked = junction(&stage, &out);
            seen.lock()
                .unwrap()
                .push(format!("rename={} junction={linked}", moved.is_ok()));
        }));
        let result = swap_in(store.path(), &mut guard, &staged, &marker, "PA", 1);
        *INTERLEAVE.lock().unwrap() = None;

        assert_eq!(*tried.lock().unwrap(), ["rename=false junction=false"]);
        result.unwrap();
        let live = root.join("PA");
        let meta = fs::symlink_metadata(&live).unwrap();
        assert!(meta.is_dir() && !meta.file_type().is_symlink());
        assert_eq!(fs::read(live.join("a.txt")).unwrap(), b"restored");
        assert!(!marker.exists() && !staged.exists());
        assert_eq!(fs::read(outside.join("a.txt")).unwrap(), b"external");
    }

    /// peer W6 r4 P1-01 的 `.restore-old` 一路：取得守卫时它不存在，之后被建成指向外面的 junction（外面恰好有
    /// 同名的 `PA-1`）。不论是收尾删旧目录，还是把 live 挪进去，都拒绝，外面原样还在。
    #[test]
    fn a_restore_old_that_appears_as_a_link_is_neither_emptied_nor_used() {
        for staged_too in [false, true] {
            let b = base(&format!("late-old-{staged_too}"));
            fs::create_dir_all(b.join("N/artifacts/.restore-staging")).unwrap();
            fs::create_dir_all(b.join("N/artifacts/PA")).unwrap();
            let store = Store::open(&b.join("N/atm.sqlite"), crate::Config::default()).unwrap();
            let mut guard = attachments_lock(&store, "late_swap").unwrap();
            let root = guard.artifacts();
            let staged = root.join(STAGING_DIR).join("PA");
            if staged_too {
                fs::create_dir(&staged).unwrap();
            }
            let marker = root.join(STAGING_DIR).join("PA.gen");
            fs::write(&marker, b"1").unwrap();
            let outside = b.join("outside");
            fs::create_dir_all(outside.join("PA-1")).unwrap();
            fs::write(outside.join("PA-1/keep.txt"), b"external").unwrap();
            let old = root.join(OLD_DIR);
            assert!(junction(&old, &outside));
            let result = swap_in(store.path(), &mut guard, &staged, &marker, "PA", 1);
            assert!(
                matches!(result, Err(BackupError::LinkedPath(_))),
                "{staged_too}: {result:?}"
            );
            assert_eq!(
                fs::read(outside.join("PA-1/keep.txt")).unwrap(),
                b"external"
            );
            assert!(marker.is_file() && root.join("PA").is_dir());
            assert!(fs::read_dir(&outside).unwrap().count() == 1);
            drop(guard);
            fs::remove_dir(&old).unwrap();
        }
    }

    /// 打开之前暂存就已经被换成链接：不换入，标记留着（还是 Pending），live 与外面都不变。
    #[test]
    fn a_staging_that_is_already_a_link_stays_pending() {
        let b = base("linked-stage");
        fs::create_dir_all(b.join("N/artifacts/.restore-staging")).unwrap();
        fs::create_dir_all(b.join("N/artifacts/PA")).unwrap();
        let store = Store::open(&b.join("N/atm.sqlite"), crate::Config::default()).unwrap();
        let mut guard = attachments_lock(&store, "late_swap").unwrap();
        let root = guard.artifacts();
        let staged = root.join(STAGING_DIR).join("PA");
        let marker = root.join(STAGING_DIR).join("PA.gen");
        fs::write(&marker, b"1").unwrap();
        fs::write(root.join("PA/a.txt"), b"live").unwrap();
        let outside = b.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("a.txt"), b"external").unwrap();
        assert!(junction(&staged, &outside));
        let result = swap_in(store.path(), &mut guard, &staged, &marker, "PA", 1);
        assert!(
            matches!(result, Err(BackupError::LinkedPath(_))),
            "{result:?}"
        );
        assert!(marker.is_file());
        assert_eq!(fs::read(root.join("PA/a.txt")).unwrap(), b"live");
        assert_eq!(fs::read(outside.join("a.txt")).unwrap(), b"external");
        fs::remove_dir(&staged).unwrap();
    }
}
