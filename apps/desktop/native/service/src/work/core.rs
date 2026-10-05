//! 工作项服务的共用部分：任务行的读写、事件、会话效果、阻塞记录、进度重算、搜索文档、常用错误。
//!
//! 一次服务调用 = 一个写事务（01 术语）。[`Work`] 持有这个事务和写入者，所有写都经它；
//! 事务末尾调用 [`Work::finish`]，统一重算一次进度（00 C-21）并刷新搜索文档。

use crate::write::{Actor, WriteCtx, internal};
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::gate::ChecklistStatus;
use atm_domain::keys;
use atm_domain::ownership::{Claim, Requester};
use atm_domain::principal::PrincipalKind;
use atm_domain::progress::{self, ChecklistWeight, ChildProgress, Progress, ProgressSource};
use atm_domain::time::Timestamp;
use atm_domain::work::{Phase, Status, WaitingOn, WorkState};
use atm_store::events::{self as store_events, EventError, NewEvent};
use atm_store::search::{self, Doc};
use rusqlite::{OptionalExtension, Row, Transaction, params};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashSet};

pub(crate) fn db(e: rusqlite::Error) -> DomainError {
    internal(e)
}

pub(crate) fn event_error(e: EventError) -> DomainError {
    match e {
        EventError::CounterNotFound(name) => DomainError::new(
            ErrorCode::COUNTER_NOT_FOUND,
            format!("项目缺少编号计数器 {name}，数据可能已损坏"),
        )
        .detail("counter", name),
        EventError::ProjectNotFound(p) => project_not_found(&p),
        other => internal(other),
    }
}

pub(crate) fn project_not_found(project: &str) -> DomainError {
    DomainError::new(
        ErrorCode::PROJECT_NOT_FOUND,
        format!("项目 {project} 不存在"),
    )
    .detail("project", project)
}

pub(crate) fn validation(field: &str, message: impl Into<String>) -> DomainError {
    DomainError::new(ErrorCode::VALIDATION_ERROR, message).detail("field", field)
}

pub(crate) fn invalid_argument(field: &str, message: impl Into<String>) -> DomainError {
    DomainError::new(ErrorCode::INVALID_ARGUMENT, message).detail("field", field)
}

/// 给错误附上「下一步」：W4 的适配层把它翻译成 `fix.call`（11 §3）。服务层不知道工具名与参数名，
/// 只说明要做的操作与要带的值。
pub(crate) fn with_next(error: DomainError, next: Value) -> DomainError {
    error.detail("next", next)
}

pub(crate) fn source_str(source: ProgressSource) -> &'static str {
    match source {
        ProgressSource::Children => "CHILDREN",
        ProgressSource::Checklist => "CHECKLIST",
        ProgressSource::Reported => "REPORTED",
        ProgressSource::None => "NONE",
    }
}

fn parse_source(text: &str) -> Option<ProgressSource> {
    Some(match text {
        "CHILDREN" => ProgressSource::Children,
        "CHECKLIST" => ProgressSource::Checklist,
        "REPORTED" => ProgressSource::Reported,
        "NONE" => ProgressSource::None,
        _ => return None,
    })
}

pub(crate) fn checklist_status(text: &str) -> Option<ChecklistStatus> {
    Some(match text {
        "TODO" => ChecklistStatus::Todo,
        "DOING" => ChecklistStatus::Doing,
        "DONE" => ChecklistStatus::Done,
        "SKIPPED" => ChecklistStatus::Skipped,
        _ => return None,
    })
}

/// 一行工作项。只放服务要读写的列；C-16 删除的遗留列（phase_inferred、archived_at 等）写入时恒为默认值。
#[derive(Clone, Debug)]
pub(crate) struct Task {
    pub id: String,
    pub local_no: i64,
    pub parent_id: Option<String>,
    pub objective_id: String,
    pub milestone_id: Option<String>,
    pub kind: String,
    pub title: String,
    pub description: String,
    pub acceptance: Vec<String>,
    pub state: WorkState,
    pub priority: String,
    pub target_date: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub assignee: Option<String>,
    pub claimed_by: Option<String>,
    pub lease: Option<String>,
    pub reported_progress: Option<f64>,
    pub computed_progress: f64,
    pub progress_source: String,
    pub weight: f64,
    pub blocked_reason: Option<String>,
    pub waiting_for: Option<String>,
    pub verification_required: bool,
    pub version: i64,
    pub cancel_reason: Option<String>,
    pub duplicate_of_id: Option<String>,
    pub superseded_by_id: Option<String>,
    pub ever_claimed_at: Option<String>,
    pub last_started_at: Option<String>,
    pub last_session_closed_at: Option<String>,
    pub last_evidence_at: Option<String>,
    pub updated_at: String,
}

const TASK_COLUMNS: &str = "id, local_no, parent_id, objective_id, milestone_id, type, title, description, acceptance_json,
    phase, waiting_on, priority, target_date, started_at, completed_at, assignee_agent_id, claimed_by_session_id,
    claim_lease_until, reported_progress, computed_progress, progress_source, weight, blocked_reason, waiting_for,
    verification_required, version, cancel_reason, duplicate_of_id, superseded_by_id, ever_claimed_at, last_started_at,
    last_session_closed_at, last_evidence_at, updated_at";

fn task_row(r: &Row<'_>) -> rusqlite::Result<Result<Task, String>> {
    let phase: String = r.get(9)?;
    let waiting: Option<String> = r.get(10)?;
    let acceptance: String = r.get(8)?;
    let state = Phase::parse(&phase).and_then(|p| match waiting.as_deref() {
        None => WorkState::new(p, None),
        Some(w) => WaitingOn::parse(w).and_then(|w| WorkState::new(p, Some(w))),
    });
    let Some(state) = state else {
        return Ok(Err(format!("phase {phase} / waiting_on {waiting:?}")));
    };
    let Ok(acceptance) = serde_json::from_str::<Vec<String>>(&acceptance) else {
        return Ok(Err(format!("acceptance_json {acceptance}")));
    };
    Ok(Ok(Task {
        id: r.get(0)?,
        local_no: r.get(1)?,
        parent_id: r.get(2)?,
        objective_id: r.get(3)?,
        milestone_id: r.get(4)?,
        kind: r.get(5)?,
        title: r.get(6)?,
        description: r.get(7)?,
        acceptance,
        state,
        priority: r.get(11)?,
        target_date: r.get(12)?,
        started_at: r.get(13)?,
        completed_at: r.get(14)?,
        assignee: r.get(15)?,
        claimed_by: r.get(16)?,
        lease: r.get(17)?,
        reported_progress: r.get(18)?,
        computed_progress: r.get(19)?,
        progress_source: r.get(20)?,
        weight: r.get(21)?,
        blocked_reason: r.get(22)?,
        waiting_for: r.get(23)?,
        verification_required: r.get::<_, i64>(24)? != 0,
        version: r.get(25)?,
        cancel_reason: r.get(26)?,
        duplicate_of_id: r.get(27)?,
        superseded_by_id: r.get(28)?,
        ever_claimed_at: r.get(29)?,
        last_started_at: r.get(30)?,
        last_session_closed_at: r.get(31)?,
        last_evidence_at: r.get(32)?,
        updated_at: r.get(33)?,
    }))
}

impl Task {
    pub fn status(&self) -> Status {
        self.state.status()
    }

    pub fn claim(&self) -> Claim<'_> {
        Claim {
            session: self.claimed_by.as_deref(),
            lease_until: self.lease.as_deref().and_then(Timestamp::parse),
            assignee: self.assignee.as_deref(),
        }
    }

    /// 清掉领取（session 与租约）。assignee 保留作历史（00 C-03）。
    pub fn drop_claim(&mut self) {
        self.claimed_by = None;
        self.lease = None;
    }

    pub fn clear_waiting(&mut self) {
        self.waiting_for = None;
    }
}

/// W-038 的会话效果。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SessionEffect {
    Working,
    Waiting,
    Idle,
}

/// 一次写事务里的工作项服务。
pub(crate) struct Work<'a> {
    pub tx: &'a Transaction<'a>,
    pub ctx: &'a WriteCtx,
    pub project: String,
    pub code: String,
    pub now: Timestamp,
    pub now_iso: String,
    /// 最后一条事件的 project_seq。
    pub sequence: i64,
    /// 本事务直接写过的任务：它们的版本已经随那次写入变化，末尾重算派生值时不再额外加一。
    touched: HashSet<String>,
    /// 本事务新建的任务（00 C-01：版本固定为 1）。
    fresh: HashSet<String>,
    /// 需要重算进度的起点（W-114）；末尾连同全部祖先一起重算。
    recompute: BTreeSet<String>,
    /// 需要刷新搜索文档的任务。
    search: BTreeSet<String>,
    /// 本事务分配过的最后一个 id：同一毫秒内的 ULID 随机部分无序，这里保证单调，
    /// 检查项等按 (created_at, id) 排序时就是写入顺序。
    last_id: Option<String>,
}

impl<'a> Work<'a> {
    pub fn open(tx: &'a Transaction<'a>, ctx: &'a WriteCtx) -> Result<Self, DomainError> {
        let project = ctx.scope.id.clone();
        let row: Option<(String, String)> = tx
            .query_row(
                "SELECT code, lifecycle FROM projects WHERE id = ?1",
                [&project],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(db)?;
        let Some((code, lifecycle)) = row else {
            return Err(project_not_found(&project));
        };
        if lifecycle == "TRASHED" {
            return Err(DomainError::new(
                ErrorCode::PROJECT_DB_UNAVAILABLE,
                format!("项目 {code} 在垃圾箱里，恢复之后才能写入"),
            )
            .detail("project", code.as_str())
            .detail("lifecycle", "TRASHED"));
        }
        Ok(Work {
            tx,
            ctx,
            project,
            code,
            now: ctx.now,
            now_iso: ctx.now.to_string(),
            sequence: 0,
            touched: HashSet::new(),
            fresh: HashSet::new(),
            recompute: BTreeSet::new(),
            search: BTreeSet::new(),
            last_id: None,
        })
    }

    pub fn actor(&self) -> &Actor {
        &self.ctx.actor
    }

    pub fn key(&self, local_no: i64) -> String {
        keys::task_key(&self.code, local_no)
    }

    pub fn task_key(&self, task: &Task) -> String {
        self.key(task.local_no)
    }

    /// 写入者对某个领取的身份（R2：领取属于 lineage）。
    pub fn requester(&self, claim: &Claim<'_>) -> Requester<'_> {
        let actor = self.actor();
        match (actor.kind, actor.session.as_deref()) {
            (PrincipalKind::Agent, Some(session)) => Requester::Agent {
                agent_id: &actor.id,
                session,
                holder_in_lineage: claim.session.is_some_and(|s| actor.in_lineage(s)),
            },
            // 无 session 的 Agent 不可能持有领取，按「不在 lineage」处理；User、Phone、System 不受领取约束。
            (PrincipalKind::Agent, None) => Requester::Agent {
                agent_id: &actor.id,
                session: "",
                holder_in_lineage: false,
            },
            _ => Requester::User,
        }
    }

    // ---------- 任务 ----------

    /// W-001：按公开 key 找本项目的任务。找不到时报 WORK_ITEM_NOT_FOUND。
    pub fn load_by_key(&self, reference: &str) -> Result<Task, DomainError> {
        let found = match keys::parse_task_key(&self.code, reference) {
            Some(no) => self.load_where("local_no = ?2", no)?,
            None => None,
        };
        found.ok_or_else(|| self.not_found(reference))
    }

    pub fn load(&self, id: &str) -> Result<Task, DomainError> {
        self.load_where("id = ?2", id)?
            .ok_or_else(|| internal(format!("work item {id} vanished")))
    }

    fn load_where(
        &self,
        clause: &str,
        value: impl rusqlite::ToSql,
    ) -> Result<Option<Task>, DomainError> {
        let sql =
            format!("SELECT {TASK_COLUMNS} FROM work_items WHERE project_id = ?1 AND {clause}");
        match self
            .tx
            .query_row(&sql, params![self.project, value], task_row)
            .optional()
            .map_err(db)?
        {
            None => Ok(None),
            Some(Ok(t)) => Ok(Some(t)),
            Some(Err(bad)) => Err(internal(format!("corrupt work item row: {bad}"))),
        }
    }

    pub fn not_found(&self, reference: &str) -> DomainError {
        DomainError::new(
            ErrorCode::WORK_ITEM_NOT_FOUND,
            format!("项目 {} 里没有任务 {reference}", self.code),
        )
        .detail("entity", "WORK_ITEM")
        .detail("reference", reference)
    }

    /// 写回一行任务。调用方先改好字段（含 version），这里整体写回，并记为本事务写过的任务。
    pub fn save(&mut self, t: &Task) -> Result<(), DomainError> {
        let state = t.state;
        self.tx
            .execute(
                "UPDATE work_items SET parent_id = ?3, milestone_id = ?4, title = ?5, description = ?6, acceptance_json = ?7,
                   status = ?8, phase = ?9, waiting_on = ?10, phase_inferred = 0, target_date = ?11, started_at = ?12,
                   completed_at = ?13, assignee_agent_id = ?14, claimed_by_session_id = ?15, claim_lease_until = ?16,
                   reported_progress = ?17, computed_progress = ?18, progress_source = ?19, blocked_reason = ?20,
                   waiting_for = ?21, version = ?22, updated_at = ?23, cancel_reason = ?24, duplicate_of_id = ?25,
                   superseded_by_id = ?26, ever_claimed_at = ?27, last_started_at = ?28
                 WHERE project_id = ?1 AND id = ?2",
                params![
                    self.project,
                    t.id,
                    t.parent_id,
                    t.milestone_id,
                    t.title,
                    t.description,
                    serde_json::to_string(&t.acceptance).map_err(internal)?,
                    state.status().as_str(),
                    state.phase().as_str(),
                    state.waiting_on().map(WaitingOn::as_str),
                    t.target_date,
                    t.started_at,
                    t.completed_at,
                    t.assignee,
                    t.claimed_by,
                    t.lease,
                    t.reported_progress,
                    t.computed_progress,
                    t.progress_source,
                    t.blocked_reason,
                    t.waiting_for,
                    t.version,
                    self.now_iso,
                    t.cancel_reason,
                    t.duplicate_of_id,
                    t.superseded_by_id,
                    t.ever_claimed_at,
                    t.last_started_at,
                ],
            )
            .map_err(db)?;
        self.touched.insert(t.id.clone());
        Ok(())
    }

    pub fn mark_fresh(&mut self, id: &str) {
        self.fresh.insert(id.to_owned());
        self.touched.insert(id.to_owned());
    }

    pub fn recompute_from(&mut self, id: &str) {
        self.recompute.insert(id.to_owned());
    }

    pub fn refresh_search(&mut self, id: &str) {
        self.search.insert(id.to_owned());
    }

    // ---------- 事件 ----------

    pub fn emit(
        &mut self,
        kind: &str,
        aggregate_type: &str,
        aggregate_id: &str,
        payload: &Value,
    ) -> Result<i64, DomainError> {
        let actor = &self.ctx.actor;
        let payload = payload.to_string();
        let appended = store_events::append_event(
            self.tx,
            &NewEvent {
                project_id: &self.project,
                kind,
                actor_type: actor.event_type,
                actor_id: &actor.id,
                session_id: actor.session.as_deref(),
                aggregate_type,
                aggregate_id,
                correlation_id: None,
                op_id: Some(&self.ctx.op_id),
                payload_json: &payload,
                at: &self.now_iso,
            },
        )
        .map_err(event_error)?;
        self.sequence = appended.seq;
        Ok(appended.seq)
    }

    pub fn next_number(&self, counter: &str) -> Result<i64, DomainError> {
        store_events::next_number(self.tx, &self.project, counter).map_err(event_error)
    }

    pub fn ulid(&mut self) -> Result<String, DomainError> {
        let fresh = store_events::ulid(self.tx).map_err(db)?;
        let id = match self.last_id.take() {
            Some(last) if fresh <= last => {
                successor(&last).ok_or_else(|| internal("ulid overflow"))?
            }
            _ => fresh,
        };
        self.last_id = Some(id.clone());
        Ok(id)
    }

    // ---------- 会话、阻塞记录 ----------

    /// W-038：只对带 session 的写入者生效；IDLE 只在会话当前指向这个任务时才清空。
    pub fn session_effect(&self, task_id: &str, effect: SessionEffect) -> Result<(), DomainError> {
        let Some(session) = self.ctx.actor.session.as_deref() else {
            return Ok(());
        };
        let sql = match effect {
            SessionEffect::Working | SessionEffect::Waiting => {
                "UPDATE agent_sessions SET current_work_item_id = ?3, work_state = ?4, heartbeat_at = ?5, updated_at = ?5,
                   version = version + 1
                 WHERE project_id = ?1 AND id = ?2"
            }
            SessionEffect::Idle => {
                "UPDATE agent_sessions SET current_work_item_id = NULL, work_state = ?4, heartbeat_at = ?5, updated_at = ?5,
                   version = version + 1
                 WHERE project_id = ?1 AND id = ?2 AND current_work_item_id = ?3"
            }
        };
        let state = match effect {
            SessionEffect::Working => "WORKING",
            SessionEffect::Waiting => "WAITING",
            SessionEffect::Idle => "IDLE",
        };
        self.tx
            .execute(
                sql,
                params![self.project, session, task_id, state, self.now_iso],
            )
            .map_err(db)?;
        Ok(())
    }

    /// W-007：解除任务全部 ACTIVE 阻塞记录。
    pub fn resolve_blockers(&self, task_id: &str) -> Result<usize, DomainError> {
        self.tx
            .execute(
                "UPDATE blockers SET status = 'RESOLVED', resolved_at = ?3, updated_at = ?3, version = version + 1
                 WHERE project_id = ?1 AND work_item_id = ?2 AND status = 'ACTIVE'",
                params![self.project, task_id, self.now_iso],
            )
            .map_err(db)
    }

    /// 00 C-28：block 也建阻塞记录（与进度上报的 blocker 同形）。
    pub fn add_blocker(&mut self, task_id: &str, text: &str) -> Result<String, DomainError> {
        let no = self.next_number("blocker")?;
        let id = self.ulid()?;
        self.tx
            .execute(
                "INSERT INTO blockers (project_id, id, local_no, work_item_id, severity, title, detail, status, actor,
                                       version, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 'HIGH', ?5, ?5, 'ACTIVE', ?6, 0, ?7, ?7)",
                params![self.project, id, no, task_id, text, self.ctx.actor.id, self.now_iso],
            )
            .map_err(db)?;
        Ok(keys::blocker_key(&self.code, no))
    }

    // ---------- 事务末尾 ----------

    /// 统一重算一次进度（00 C-21），再刷新搜索文档。
    pub fn finish(&mut self) -> Result<(), DomainError> {
        self.recompute_all()?;
        let ids: Vec<String> = std::mem::take(&mut self.search).into_iter().collect();
        for id in ids {
            self.write_search(&id)?;
        }
        Ok(())
    }

    fn parent_of(&self, id: &str) -> Result<Option<String>, DomainError> {
        self.tx
            .query_row(
                "SELECT parent_id FROM work_items WHERE project_id = ?1 AND id = ?2",
                [&self.project, id],
                |r| r.get(0),
            )
            .optional()
            .map(Option::flatten)
            .map_err(db)
    }

    fn recompute_all(&mut self) -> Result<(), DomainError> {
        let mut set: HashSet<String> = std::mem::take(&mut self.recompute).into_iter().collect();
        let mut frontier: Vec<String> = set.iter().cloned().collect();
        while let Some(id) = frontier.pop() {
            if let Some(parent) = self.parent_of(&id)?
                && set.insert(parent.clone())
            {
                frontier.push(parent);
            }
        }
        // 子项先于父项：按深度从深到浅。
        let mut order = Vec::with_capacity(set.len());
        for id in set {
            let mut depth = 0usize;
            let mut cursor = self.parent_of(&id)?;
            while let Some(p) = cursor {
                depth += 1;
                if depth > 64 {
                    return Err(internal(format!("parent chain of {id} does not end")));
                }
                cursor = self.parent_of(&p)?;
            }
            order.push((depth, id));
        }
        order.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        for (_, id) in order {
            self.recompute_one(&id)?;
        }
        Ok(())
    }

    /// W-110 + 00 C-02：只有值或来源确实变了才写；没被本事务直接写过的任务，此时版本加一。
    fn recompute_one(&mut self, id: &str) -> Result<(), DomainError> {
        let (status, reported, computed, source): (String, Option<f64>, f64, String) = self
            .tx
            .query_row(
                "SELECT status, reported_progress, computed_progress, progress_source FROM work_items
                 WHERE project_id = ?1 AND id = ?2",
                [&self.project, id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .map_err(db)?;
        let status = Status::parse(&status).ok_or_else(|| internal(format!("status {status}")))?;
        let children = self
            .tx
            .prepare_cached(
                "SELECT status, computed_progress, weight FROM work_items WHERE project_id = ?1 AND parent_id = ?2",
            )
            .map_err(db)?
            .query_map([&self.project, id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?, r.get::<_, f64>(2)?))
            })
            .map_err(db)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db)?
            .into_iter()
            .map(|(s, p, w)| {
                Status::parse(&s)
                    .map(|status| ChildProgress { status, computed_progress: p, weight: w })
                    .ok_or_else(|| internal(format!("status {s}")))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let checklist = self
            .tx
            .prepare_cached(
                "SELECT status, weight FROM checklist_items WHERE project_id = ?1 AND work_item_id = ?2",
            )
            .map_err(db)?
            .query_map([&self.project, id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)))
            .map_err(db)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db)?
            .into_iter()
            .map(|(s, w)| {
                checklist_status(&s)
                    .map(|status| ChecklistWeight { status, weight: w })
                    .ok_or_else(|| internal(format!("checklist status {s}")))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let after = progress::compute(status, &children, &checklist, reported);
        let before = parse_source(&source).map(|source| Progress {
            value: computed,
            source,
        });
        let changed = before.is_none_or(|b| progress::recompute_bumps_version(b, after));
        if !changed {
            return Ok(());
        }
        let bump = !self.touched.contains(id) && !self.fresh.contains(id);
        self.tx
            .execute(
                "UPDATE work_items SET computed_progress = ?3, progress_source = ?4,
                   version = version + ?5, updated_at = CASE WHEN ?5 = 1 THEN ?6 ELSE updated_at END
                 WHERE project_id = ?1 AND id = ?2",
                params![
                    self.project,
                    id,
                    after.value,
                    source_str(after.source),
                    i64::from(bump),
                    self.now_iso
                ],
            )
            .map_err(db)?;
        Ok(())
    }

    /// 2.0 `refreshWorkItemSearchDocument`：标题、描述，加上「工作中发现（于）…」的关系文本（00 C-14）。
    fn write_search(&self, id: &str) -> Result<(), DomainError> {
        let Some((no, title, description)) = self
            .tx
            .query_row(
                "SELECT local_no, title, description FROM work_items WHERE project_id = ?1 AND id = ?2",
                [&self.project, id],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)),
            )
            .optional()
            .map_err(db)?
        else {
            return Ok(());
        };
        let relations: Vec<(String, i64, String, i64, String)> = self
            .tx
            .prepare_cached(
                "SELECT r.source_id, s.local_no, s.title, t.local_no, t.title
                 FROM work_item_relations r
                 JOIN work_items s ON s.project_id = r.project_id AND s.id = r.source_id
                 JOIN work_items t ON t.project_id = r.project_id AND t.id = r.target_id
                 WHERE r.project_id = ?1 AND r.relation_type = 'DISCOVERED_FROM' AND (r.source_id = ?2 OR r.target_id = ?2)
                 ORDER BY r.created_at, r.source_id, r.target_id",
            )
            .map_err(db)?
            .query_map([&self.project, id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .map_err(db)?
            .collect::<rusqlite::Result<_>>()
            .map_err(db)?;
        let mut parts = Vec::new();
        if !description.is_empty() {
            parts.push(description);
        }
        for (source, source_no, source_title, target_no, target_title) in relations {
            parts.push(if source == id {
                format!("工作中发现于 {} {target_title}", self.key(target_no))
            } else {
                format!("工作中发现 {} {source_title}", self.key(source_no))
            });
        }
        let key = self.key(no);
        search::upsert_doc(
            self.tx,
            &Doc {
                project_id: &self.project,
                entity_type: "WORK_ITEM",
                entity_id: id,
                entity_key: &key,
                title: &title,
                body: &parts.join("\n"),
                updated_at: &self.now_iso,
            },
        )
        .map_err(db)
    }

    // ---------- 读：视图与快照 ----------

    fn key_of(&self, id: Option<&str>) -> Result<Option<String>, DomainError> {
        let Some(id) = id else { return Ok(None) };
        let no: Option<i64> = self
            .tx
            .query_row(
                "SELECT local_no FROM work_items WHERE project_id = ?1 AND id = ?2",
                [&self.project, id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db)?;
        Ok(no.map(|n| self.key(n)))
    }

    /// 任务视图（与 2.x WorkItemView 同名的字段，供回执与 ACK 使用）。
    pub fn view(&self, id: &str) -> Result<Value, DomainError> {
        let t = self.load(id)?;
        let discovered: Option<String> = self
            .tx
            .query_row(
                "SELECT target_id FROM work_item_relations WHERE project_id = ?1 AND source_id = ?2 AND relation_type = 'DISCOVERED_FROM'",
                [&self.project, id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db)?;
        let state = t.state;
        Ok(json!({
            "id": t.id,
            "key": self.key(t.local_no),
            "localNo": t.local_no,
            "parentId": t.parent_id,
            "parentKey": self.key_of(t.parent_id.as_deref())?,
            "objectiveId": t.objective_id,
            "milestoneId": t.milestone_id,
            "type": t.kind,
            "title": t.title,
            "description": t.description,
            "acceptance": t.acceptance,
            "status": state.status().as_str(),
            "phase": state.phase().as_str(),
            "waitingOn": state.waiting_on().map(WaitingOn::as_str),
            "priority": t.priority,
            "assigneeAgentId": t.assignee,
            "claimedBySessionId": t.claimed_by,
            "claimLeaseUntil": t.lease,
            "progress": t.computed_progress,
            "reportedProgress": t.reported_progress,
            "progressSource": t.progress_source,
            "weight": t.weight,
            "blockedReason": t.blocked_reason,
            "waitingFor": t.waiting_for,
            "verificationRequired": t.verification_required,
            "cancelReason": t.cancel_reason,
            "duplicateOf": self.key_of(t.duplicate_of_id.as_deref())?,
            "supersededBy": self.key_of(t.superseded_by_id.as_deref())?,
            "targetDate": t.target_date,
            "discoveredFrom": self.key_of(discovered.as_deref())?,
            "everClaimedAt": t.ever_claimed_at,
            "lastStartedAt": t.last_started_at,
            "lastSessionClosedAt": t.last_session_closed_at,
            "lastEvidenceAt": t.last_evidence_at,
            "version": t.version,
            "updatedAt": t.updated_at,
        }))
    }

    /// W-104：VERSION_CONFLICT 带当前快照与最近变化（≤ 6 条）。
    pub fn version_conflict(&self, t: &Task, expected: i64) -> Result<DomainError, DomainError> {
        let key = self.task_key(t);
        let recent: Vec<Value> = self
            .tx
            .prepare_cached(
                "SELECT seq, type, payload_json, op_id, created_at FROM events
                 WHERE project_id = ?1 AND aggregate_id = ?2 ORDER BY seq DESC LIMIT 6",
            )
            .map_err(db)?
            .query_map([&self.project, &t.id], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })
            .map_err(db)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db)?
            .into_iter()
            .map(|(seq, kind, payload, op_id, at)| {
                let payload: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
                let summary = match payload.get("status").and_then(Value::as_str) {
                    Some(status) => format!("{kind} → {status}"),
                    None => kind.clone(),
                };
                json!({ "seq": seq, "type": kind, "key": payload.get("key"), "summary": summary, "op_id": op_id, "at": at })
            })
            .collect();
        let state = t.state;
        let current = json!({
            "key": key,
            "version": t.version,
            "status": state.status().as_str(),
            "phase": state.phase().as_str(),
            "title": t.title,
            "description": t.description,
            "assignee_agent_id": t.assignee,
            "claimed_by_session_id": t.claimed_by,
            "target_date": t.target_date,
            "parent_key": self.key_of(t.parent_id.as_deref())?,
            "cancel_reason": t.cancel_reason,
            "duplicate_of": self.key_of(t.duplicate_of_id.as_deref())?,
            "superseded_by": self.key_of(t.superseded_by_id.as_deref())?,
            "updated_at": t.updated_at,
        });
        Ok(DomainError::new(
            ErrorCode::VERSION_CONFLICT,
            format!(
                "任务 {key} 的版本已是 {}，请求基于 {expected}：先看 current 与 recent_changes，再决定是否重做",
                t.version
            ),
        )
        .detail("entity", "WORK_ITEM")
        .detail("key", key.as_str())
        .detail("task_key", key.as_str())
        .detail("expected", expected)
        .detail("actual", t.version)
        .detail("expected_version", expected)
        .detail("current_version", t.version)
        .detail("version_gap", t.version - expected)
        .detail("current", current)
        .detail("recent_changes", recent)
        .detail("changes_complete", false))
    }
}

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// Crockford base32 串按数值加一。
fn successor(id: &str) -> Option<String> {
    let mut bytes = id.as_bytes().to_vec();
    for b in bytes.iter_mut().rev() {
        let pos = CROCKFORD.iter().position(|c| c == b)?;
        if pos + 1 < CROCKFORD.len() {
            *b = CROCKFORD[pos + 1];
            return String::from_utf8(bytes).ok();
        }
        *b = CROCKFORD[0];
    }
    None
}
