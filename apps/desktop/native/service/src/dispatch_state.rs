//! Claude 派单的账本（05 §2.4、§7）：2.x 的 `dispatch/config.json`、`runs.json`、`requests.json` 拆成
//! `dispatch_config`、`dispatch_runs`、`dispatch_requests`，水位线在 `dispatch_meta`。日志不在库里（`dispatch\logs`）。
//!
//! 这里只管读写，不解释内容：格式校验、保留期、幂等在 atm-dispatch（2.x 的 agent-dispatch）。派单行与请求账本条目
//! 在同一个写事务里落盘，「条目在起进程之前落盘」由事务保证。
//!
//! 能力：读要 `dispatch.status`（User）、`dispatch.launch`（User / Phone）、`dispatch.configure`、`dispatch.cancel`
//! 或 `dispatch.track`（System）之一；写要后四者之一。Agent 一个都没有（P-017）。

use crate::project::{db, dom_read_error, write_error};
use crate::write::Service;
use atm_domain::capability::{self, Capability};
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::keys;
use atm_domain::principal::Principal;
use rusqlite::{OptionalExtension, Transaction, params};

#[derive(Clone, Debug, PartialEq)]
pub struct ConfigRow {
    pub enabled: bool,
    pub permission_mode: String,
    pub max_concurrent: i64,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// `OK`、`MISSING`、`CORRUPT_DEFAULTED`（转换时 2.x 的配置文件不存在或坏了）。
    pub source_state: String,
}

/// `dispatch_runs` 的一行。
#[derive(Clone, Debug, PartialEq)]
pub struct RunRow {
    pub run: String,
    pub project_code: String,
    pub task_key: String,
    pub title: String,
    pub task_id: Option<String>,
    pub origin: String,
    pub state: String,
    pub session_id: String,
    pub created_at: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub exit_code: Option<i64>,
    pub exit_code_set: bool,
    pub summary_json: Option<String>,
    pub error: Option<String>,
    pub cwd: String,
    pub requested_by: Option<String>,
    pub pid: Option<i64>,
    pub process_identity: Option<String>,
    pub request_id: Option<String>,
    pub log_root: String,
}

/// `dispatch_requests` 的一行。
#[derive(Clone, Debug, PartialEq)]
pub struct RequestRow {
    pub id: String,
    pub at: String,
    pub run_snapshot_json: Option<String>,
    pub rejected_code: Option<String>,
    pub rejected_message: Option<String>,
}

/// 一次落盘：同一个写事务。先删后写。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DispatchWrite {
    pub config: Option<ConfigRow>,
    /// `Some(None)` 清除水位线。
    pub lost_before: Option<Option<String>>,
    pub upsert_runs: Vec<RunRow>,
    pub delete_runs: Vec<String>,
    pub upsert_requests: Vec<RequestRow>,
    pub delete_requests: Vec<String>,
}

impl DispatchWrite {
    pub fn is_empty(&self) -> bool {
        self.config.is_none()
            && self.lost_before.is_none()
            && self.upsert_runs.is_empty()
            && self.delete_runs.is_empty()
            && self.upsert_requests.is_empty()
            && self.delete_requests.is_empty()
    }
}

/// 派单准入要看的任务（2.x `DispatchTask`，另带实体 id 给 R5 的双重绑定）。
#[derive(Clone, Debug, PartialEq)]
pub struct TargetTask {
    pub id: String,
    pub key: String,
    pub title: String,
    pub status: String,
    pub description: String,
    pub claimed_by_session_id: Option<String>,
    pub claim_lease_until: Option<String>,
}

/// 派单准入要看的项目（2.x `DispatchProject`）：只认 ACTIVE 的；路径主路径在前。
#[derive(Clone, Debug, PartialEq)]
pub struct Target {
    pub project_id: String,
    pub code: String,
    pub name: String,
    pub paths: Vec<String>,
    /// 按键找到的任务；不存在是 `None`。
    pub task: Option<TargetTask>,
}

const READERS: [Capability; 5] = [
    Capability::DispatchStatus,
    Capability::DispatchLaunch,
    Capability::DispatchConfigure,
    Capability::DispatchCancel,
    Capability::DispatchTrackRuns,
];
const WRITERS: [Capability; 4] = [
    Capability::DispatchLaunch,
    Capability::DispatchConfigure,
    Capability::DispatchCancel,
    Capability::DispatchTrackRuns,
];

fn require_any(principal: &Principal, any: &[Capability]) -> Result<(), DomainError> {
    let mut first = None;
    for c in any {
        match capability::require(principal, *c) {
            Ok(()) => return Ok(()),
            Err(e) => {
                first.get_or_insert(e);
            }
        }
    }
    Err(first.unwrap_or_else(|| DomainError::new(ErrorCode::INTERNAL_ERROR, "没有可检查的能力")))
}

fn load_config(tx: &Transaction<'_>) -> rusqlite::Result<Option<ConfigRow>> {
    tx.query_row(
        "SELECT enabled, permission_mode, max_concurrent, model, effort, source_state
         FROM dispatch_config WHERE singleton = 1",
        [],
        |r| {
            Ok(ConfigRow {
                enabled: r.get::<_, i64>(0)? != 0,
                permission_mode: r.get(1)?,
                max_concurrent: r.get(2)?,
                model: r.get(3)?,
                effort: r.get(4)?,
                source_state: r.get(5)?,
            })
        },
    )
    .optional()
}

fn load_runs(tx: &Transaction<'_>) -> rusqlite::Result<Vec<RunRow>> {
    let mut q = tx.prepare(
        "SELECT run, project_code, task_key, title, task_id, origin, state, session_id, created_at, started_at,
                ended_at, exit_code, exit_code_set, summary_json, error, cwd, requested_by, pid, process_identity,
                request_id, log_root
         FROM dispatch_runs ORDER BY created_at, run",
    )?;
    q.query_map([], |r| {
        Ok(RunRow {
            run: r.get(0)?,
            project_code: r.get(1)?,
            task_key: r.get(2)?,
            title: r.get(3)?,
            task_id: r.get(4)?,
            origin: r.get(5)?,
            state: r.get(6)?,
            session_id: r.get(7)?,
            created_at: r.get(8)?,
            started_at: r.get(9)?,
            ended_at: r.get(10)?,
            exit_code: r.get(11)?,
            exit_code_set: r.get::<_, i64>(12)? != 0,
            summary_json: r.get(13)?,
            error: r.get(14)?,
            cwd: r.get(15)?,
            requested_by: r.get(16)?,
            pid: r.get(17)?,
            process_identity: r.get(18)?,
            request_id: r.get(19)?,
            log_root: r.get(20)?,
        })
    })?
    .collect()
}

fn save(tx: &Transaction<'_>, w: &DispatchWrite, now: &str) -> rusqlite::Result<()> {
    if let Some(c) = &w.config {
        tx.execute(
            "INSERT INTO dispatch_config (singleton, enabled, permission_mode, max_concurrent, model, effort,
                                          source_state, updated_at)
             VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(singleton) DO UPDATE SET
               enabled = excluded.enabled, permission_mode = excluded.permission_mode,
               max_concurrent = excluded.max_concurrent, model = excluded.model, effort = excluded.effort,
               source_state = excluded.source_state, updated_at = excluded.updated_at",
            params![
                i64::from(c.enabled),
                c.permission_mode,
                c.max_concurrent,
                c.model,
                c.effort,
                c.source_state,
                now
            ],
        )?;
    }
    if let Some(lost) = &w.lost_before {
        tx.execute(
            "INSERT INTO dispatch_meta (singleton, lost_before) VALUES (1, ?1)
             ON CONFLICT(singleton) DO UPDATE SET lost_before = excluded.lost_before",
            [lost],
        )?;
    }
    for run in &w.delete_runs {
        tx.execute("DELETE FROM dispatch_runs WHERE run = ?1", [run])?;
    }
    for r in &w.upsert_runs {
        tx.execute(
            "INSERT INTO dispatch_runs (run, project_code, task_key, title, task_id, origin, state, session_id,
                                        created_at, started_at, ended_at, exit_code, exit_code_set, summary_json,
                                        error, cwd, requested_by, pid, process_identity, request_id, log_root)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
             ON CONFLICT(run) DO UPDATE SET
               project_code = excluded.project_code, task_key = excluded.task_key, title = excluded.title,
               task_id = excluded.task_id, origin = excluded.origin, state = excluded.state,
               session_id = excluded.session_id, created_at = excluded.created_at, started_at = excluded.started_at,
               ended_at = excluded.ended_at, exit_code = excluded.exit_code, exit_code_set = excluded.exit_code_set,
               summary_json = excluded.summary_json, error = excluded.error, cwd = excluded.cwd,
               requested_by = excluded.requested_by, pid = excluded.pid, process_identity = excluded.process_identity,
               request_id = excluded.request_id, log_root = excluded.log_root",
            params![
                r.run,
                r.project_code,
                r.task_key,
                r.title,
                r.task_id,
                r.origin,
                r.state,
                r.session_id,
                r.created_at,
                r.started_at,
                r.ended_at,
                r.exit_code,
                i64::from(r.exit_code_set),
                r.summary_json,
                r.error,
                r.cwd,
                r.requested_by,
                r.pid,
                r.process_identity,
                r.request_id,
                r.log_root
            ],
        )?;
    }
    for id in &w.delete_requests {
        tx.execute("DELETE FROM dispatch_requests WHERE id = ?1", [id])?;
    }
    for e in &w.upsert_requests {
        tx.execute(
            "INSERT INTO dispatch_requests (id, at, run_snapshot_json, rejected_code, rejected_message)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET at = excluded.at, run_snapshot_json = excluded.run_snapshot_json,
               rejected_code = excluded.rejected_code, rejected_message = excluded.rejected_message",
            params![e.id, e.at, e.run_snapshot_json, e.rejected_code, e.rejected_message],
        )?;
    }
    Ok(())
}

impl Service {
    /// 配置与派单历史（创建时间升序）。配置行不存在（新装）是 `None`，由调用方用默认值。
    pub fn dispatch_runs(
        &self,
        principal: &Principal,
    ) -> Result<(Option<ConfigRow>, Vec<RunRow>), DomainError> {
        require_any(principal, &READERS)?;
        self.store()
            .read(|tx| Ok((load_config(tx).map_err(db)?, load_runs(tx).map_err(db)?)))
            .map_err(dom_read_error)
    }

    /// 请求账本的全部条目与水位线。
    pub fn dispatch_requests(
        &self,
        principal: &Principal,
    ) -> Result<(Vec<RequestRow>, Option<String>), DomainError> {
        require_any(principal, &READERS)?;
        self.store()
            .read(|tx| {
                let lost: Option<String> = tx
                    .query_row("SELECT lost_before FROM dispatch_meta WHERE singleton = 1", [], |r| r.get(0))
                    .optional()
                    .map_err(db)?
                    .flatten();
                let mut q = tx
                    .prepare(
                        "SELECT id, at, run_snapshot_json, rejected_code, rejected_message FROM dispatch_requests
                         ORDER BY at, id",
                    )
                    .map_err(db)?;
                let rows = q
                    .query_map([], |r| {
                        Ok(RequestRow {
                            id: r.get(0)?,
                            at: r.get(1)?,
                            run_snapshot_json: r.get(2)?,
                            rejected_code: r.get(3)?,
                            rejected_message: r.get(4)?,
                        })
                    })
                    .map_err(db)?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(db)?;
                Ok((rows, lost))
            })
            .map_err(dom_read_error)
    }

    /// 一次落盘（同一个写事务）。
    pub fn dispatch_save(
        &self,
        principal: &Principal,
        write: &DispatchWrite,
    ) -> Result<(), DomainError> {
        require_any(principal, &WRITERS)?;
        let write = write.clone();
        let now = self.clock().to_string();
        self.store()
            .write(move |tx| save(tx, &write, &now).map_err(db))
            .map_err(write_error)
    }

    /// 派单准入（2.x `taskServiceDispatchHost`）：ACTIVE 项目的名字、路径（主路径在前）与按键找到的任务。
    /// 项目不存在或不是 ACTIVE 是 `None`。只给能起派单的主体（User、Phone）。
    pub fn dispatch_target(
        &self,
        principal: &Principal,
        project: &str,
        key: &str,
    ) -> Result<Option<Target>, DomainError> {
        capability::require(principal, Capability::DispatchLaunch)?;
        let (project, key) = (project.to_owned(), key.to_owned());
        self.store()
            .read(move |tx| {
                let row: Option<(String, String, String)> = tx
                    .query_row(
                        "SELECT id, code, name FROM projects WHERE code = ?1 AND lifecycle = 'ACTIVE'",
                        [&project],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )
                    .optional()
                    .map_err(db)?;
                let Some((project_id, code, name)) = row else {
                    return Ok(None);
                };
                let paths: Vec<String> = tx
                    .prepare(
                        "SELECT canonical_path FROM project_paths WHERE project_id = ?1
                         ORDER BY is_primary DESC, last_seen_at DESC, canonical_path",
                    )
                    .map_err(db)?
                    .query_map([&project_id], |r| r.get(0))
                    .map_err(db)?
                    .collect::<rusqlite::Result<_>>()
                    .map_err(db)?;
                let task = match keys::parse_task_key(&code, &key) {
                    None => None,
                    Some(local_no) => tx
                        .query_row(
                            "SELECT id, local_no, title, status, description, claimed_by_session_id, claim_lease_until
                             FROM work_items WHERE project_id = ?1 AND local_no = ?2",
                            params![project_id, local_no],
                            |r| {
                                Ok(TargetTask {
                                    id: r.get(0)?,
                                    key: keys::task_key(&code, r.get(1)?),
                                    title: r.get(2)?,
                                    status: r.get(3)?,
                                    description: r.get(4)?,
                                    claimed_by_session_id: r.get(5)?,
                                    claim_lease_until: r.get(6)?,
                                })
                            },
                        )
                        .optional()
                        .map_err(db)?,
                };
                Ok(Some(Target {
                    project_id,
                    code,
                    name,
                    paths,
                    task,
                }))
            })
            .map_err(dom_read_error)
    }

    /// R5：派单记下的 `(项目码, 任务实体 id)` 还在不在（被按范围恢复撤销了就不在）。与 `refs` 一一对应。
    pub fn dispatch_live_tasks(
        &self,
        principal: &Principal,
        refs: &[(String, String)],
    ) -> Result<Vec<bool>, DomainError> {
        require_any(principal, &READERS)?;
        if refs.is_empty() {
            return Ok(Vec::new());
        }
        let refs = refs.to_vec();
        self.store()
            .read(move |tx| {
                let mut q = tx
                    .prepare(
                        "SELECT EXISTS (SELECT 1 FROM work_items w JOIN projects p ON p.id = w.project_id
                                        WHERE p.code = ?1 AND w.id = ?2)",
                    )
                    .map_err(db)?;
                refs.iter()
                    .map(|(code, id)| q.query_row(params![code, id], |r| r.get::<_, bool>(0)).map_err(db))
                    .collect()
            })
            .map_err(dom_read_error)
    }
}
