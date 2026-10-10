//! 界面的任务读（06 #60–#63、#68 的界面形状）：2.0 `TaskReadModel` 的 `WorkItemView`（camelCase）。
//!
//! 与 2.0 的差别只在单库：每条 SQL 都带 `project_id`；`archived_at` 在 3.0 已删（04 C-L15），不再过滤；
//! `phaseInferred` 恒为 false（3.0 的 phase 总是显式的，status 由它推出）。

use super::cursor_page;
use crate::read::cursor::{self, int_of, str_of};
use crate::read::views::{self, TaskView};
use crate::read::{Ctx, db};
use crate::write::Service;
use atm_domain::capability::Capability;
use atm_domain::error::DomainError;
use atm_domain::keys;
use atm_domain::principal::Principal;
use rusqlite::{Row, params_from_iter};
use serde_json::{Map, Value, json};

const UI_TASKS: &str = "uw1";
const UI_CLOSED: &str = "uc1";

const CLOSED_SQL: &str = "status IN ('DONE', 'CANCELLED')";
const FINISHED_AT_SQL: &str = "COALESCE(completed_at, updated_at)";
const PRIORITY_RANK: &str =
    "CASE priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END";
const STRIP_ACTIVE: &str = "('BACKLOG', 'CLAIMED', 'IN_PROGRESS', 'VERIFYING', 'WAITING_AGENT')";
const STRIP_WAITING: &str = "('WAITING_USER', 'BLOCKED')";

/// 2.0 `hydratedWorkItemSql`：选中的行连同子任务 / 清单分母、当前阻塞、发现关系一起取。
/// `where_sql` 里的 `?1` 是项目 id。
fn hydrated_sql(where_sql: &str, tail: &str, order: &str) -> String {
    format!(
        "WITH selected AS (
           SELECT work_items.* FROM work_items WHERE work_items.project_id = ?1 AND {where_sql} {tail}
         ), child_summary AS (
           SELECT child.parent_id AS work_item_id,
                  COALESCE(SUM(CASE WHEN child.status = 'DONE' THEN child.weight ELSE 0 END), 0) AS done_weight,
                  COALESCE(SUM(child.weight), 0) AS total_weight,
                  COALESCE(SUM(CASE WHEN child.status = 'DONE' THEN 1 ELSE 0 END), 0) AS done_stages,
                  COUNT(*) AS total_stages
           FROM work_items child JOIN selected ON selected.id = child.parent_id
           WHERE child.project_id = ?1 AND child.status <> 'CANCELLED'
           GROUP BY child.parent_id
         ), checklist_summary AS (
           SELECT c.work_item_id,
                  COALESCE(SUM(CASE WHEN c.status = 'DONE' THEN c.weight ELSE 0 END), 0) AS done_weight,
                  COALESCE(SUM(c.weight), 0) AS total_weight,
                  COALESCE(SUM(CASE WHEN c.status = 'DONE' THEN 1 ELSE 0 END), 0) AS done_stages,
                  COUNT(*) AS total_stages
           FROM checklist_items c JOIN selected ON selected.id = c.work_item_id
           WHERE c.project_id = ?1 AND c.status <> 'SKIPPED'
           GROUP BY c.work_item_id
         ), blocker_ranked AS (
           SELECT b.work_item_id,
                  COALESCE(NULLIF(b.detail, ''), NULLIF(b.waiting_for, ''), b.title) AS reason,
                  row_number() OVER (PARTITION BY b.work_item_id ORDER BY b.created_at DESC) AS blocker_rank
           FROM blockers b JOIN selected ON selected.id = b.work_item_id
           WHERE b.project_id = ?1 AND b.status = 'ACTIVE'
         ), discovered_from_ranked AS (
           SELECT r.source_id AS work_item_id, t.local_no,
                  row_number() OVER (PARTITION BY r.source_id ORDER BY r.created_at, t.local_no) AS relation_rank
           FROM work_item_relations r JOIN selected ON selected.id = r.source_id
           JOIN work_items t ON t.project_id = r.project_id AND t.id = r.target_id
           WHERE r.project_id = ?1 AND r.relation_type = 'DISCOVERED_FROM'
         ), discovered_counts AS (
           SELECT r.target_id AS work_item_id, COUNT(*) AS discovered_count
           FROM work_item_relations r JOIN selected ON selected.id = r.target_id
           WHERE r.project_id = ?1 AND r.relation_type = 'DISCOVERED_FROM'
           GROUP BY r.target_id
         )
         SELECT selected.*,
                parent.local_no AS parent_local_no,
                duplicate.local_no AS duplicate_of_local_no,
                superseded.local_no AS superseded_by_local_no,
                discovered_from.local_no AS discovered_from_local_no,
                COALESCE(discovered_counts.discovered_count, 0) AS discovered_count,
                COALESCE(child_summary.done_weight, 0) AS child_done_weight,
                COALESCE(child_summary.total_weight, 0) AS child_total_weight,
                COALESCE(child_summary.done_stages, 0) AS child_done_stages,
                COALESCE(child_summary.total_stages, 0) AS child_total_stages,
                COALESCE(checklist_summary.done_weight, 0) AS checklist_done_weight,
                COALESCE(checklist_summary.total_weight, 0) AS checklist_total_weight,
                COALESCE(checklist_summary.done_stages, 0) AS checklist_done_stages,
                COALESCE(checklist_summary.total_stages, 0) AS checklist_total_stages,
                blocker.reason AS active_blocker_reason
         FROM selected
         LEFT JOIN work_items parent ON parent.project_id = ?1 AND parent.id = selected.parent_id
         LEFT JOIN work_items duplicate ON duplicate.project_id = ?1 AND duplicate.id = selected.duplicate_of_id
         LEFT JOIN work_items superseded ON superseded.project_id = ?1 AND superseded.id = selected.superseded_by_id
         LEFT JOIN child_summary ON child_summary.work_item_id = selected.id
         LEFT JOIN checklist_summary ON checklist_summary.work_item_id = selected.id
         LEFT JOIN blocker_ranked blocker ON blocker.work_item_id = selected.id AND blocker.blocker_rank = 1
         LEFT JOIN discovered_from_ranked discovered_from
           ON discovered_from.work_item_id = selected.id AND discovered_from.relation_rank = 1
         LEFT JOIN discovered_counts ON discovered_counts.work_item_id = selected.id
         {order}"
    )
}

/// 一行 hydrated 结果 → 2.0 `WorkItemView`。
fn work_item(code: &str, r: &Row<'_>) -> rusqlite::Result<Value> {
    let key = |no: Option<i64>| no.map(|n| keys::task_key(code, n));
    let status: String = r.get("status")?;
    // 有子任务就以子任务为分母，否则以清单为分母（2.0 `progressBreakdownFromHydratedRow`）。
    let child_stages: i64 = r.get("child_total_stages")?;
    let prefix = if child_stages > 0 {
        "child"
    } else {
        "checklist"
    };
    let blocked_reason: Option<String> = r.get("blocked_reason")?;
    let active_blocker: Option<String> = r.get("active_blocker_reason")?;
    let reported: Option<f64> = r.get("reported_progress")?;
    let computed: f64 = r.get("computed_progress")?;
    let progress_source: String = r.get("progress_source")?;
    let breakdown = json!({
        "computed": computed,
        "reported": reported,
        "source": progress_source,
        "doneWeight": r.get::<_, f64>(format!("{prefix}_done_weight").as_str())?,
        "totalWeight": r.get::<_, f64>(format!("{prefix}_total_weight").as_str())?,
        "doneStages": r.get::<_, i64>(format!("{prefix}_done_stages").as_str())?,
        "totalStages": r.get::<_, i64>(format!("{prefix}_total_stages").as_str())?,
        "blocker": blocked_reason.clone().or(active_blocker),
    });
    let acceptance = views::parse_json(r.get("acceptance_json")?, json!([]));
    Ok(json!({
        "id": r.get::<_, String>("id")?,
        "key": keys::task_key(code, r.get("local_no")?),
        "localNo": r.get::<_, i64>("local_no")?,
        "parentId": r.get::<_, Option<String>>("parent_id")?,
        "parentKey": key(r.get("parent_local_no")?),
        "objectiveId": r.get::<_, String>("objective_id")?,
        "milestoneId": r.get::<_, Option<String>>("milestone_id")?,
        "type": r.get::<_, String>("type")?,
        "title": r.get::<_, String>("title")?,
        "description": r.get::<_, String>("description")?,
        "acceptance": acceptance,
        "status": status,
        "phase": r.get::<_, String>("phase")?,
        "waitingOn": r.get::<_, Option<String>>("waiting_on")?,
        "phaseInferred": false,
        "priority": r.get::<_, String>("priority")?,
        "assigneeAgentId": r.get::<_, Option<String>>("assignee_agent_id")?,
        "claimedBySessionId": r.get::<_, Option<String>>("claimed_by_session_id")?,
        "claimLeaseUntil": r.get::<_, Option<String>>("claim_lease_until")?,
        "progress": computed,
        "reportedProgress": reported,
        "progressSource": progress_source,
        "progressBreakdown": breakdown,
        "weight": r.get::<_, f64>("weight")?,
        "blockedReason": blocked_reason,
        "waitingFor": r.get::<_, Option<String>>("waiting_for")?,
        "cancelReason": r.get::<_, Option<String>>("cancel_reason")?,
        "duplicateOf": key(r.get("duplicate_of_local_no")?),
        "supersededBy": key(r.get("superseded_by_local_no")?),
        "targetDate": r.get::<_, Option<String>>("target_date")?,
        "discoveredFrom": key(r.get("discovered_from_local_no")?),
        "discoveredCount": r.get::<_, i64>("discovered_count")?,
        "everClaimedAt": r.get::<_, Option<String>>("ever_claimed_at")?,
        "lastStartedAt": r.get::<_, Option<String>>("last_started_at")?,
        "lastSessionClosedAt": r.get::<_, Option<String>>("last_session_closed_at")?,
        "lastEvidenceAt": r.get::<_, Option<String>>("last_evidence_at")?,
        "version": r.get::<_, i64>("version")?,
        "updatedAt": r.get::<_, String>("updated_at")?,
    }))
}

/// 写事务里取一条 hydrated 任务：2.0 `createWorkItems` / `patchWorkItems` 回执的 `items` 就是这个形状
/// （界面写回执，06 T-COMPAT），与列表同一条 SQL、同一个映射。
pub(crate) fn hydrated(
    tx: &rusqlite::Connection,
    project_id: &str,
    code: &str,
    id: &str,
) -> Result<Value, DomainError> {
    let sql = hydrated_sql("work_items.id = ?2", "", "");
    tx.query_row(&sql, rusqlite::params![project_id, id], |r| {
        work_item(code, r)
    })
    .map_err(db)
}

/// 界面任务列表的筛选（`GET /projects/:code/ui/work-items` 的 query）。
#[derive(Clone, Debug, Default)]
pub struct WorkItemFilter {
    pub status: Option<String>,
    pub assignee: Option<String>,
    pub milestone: Option<String>,
    pub query: Option<String>,
    pub ready: bool,
    pub closed: Option<bool>,
    pub limit: Option<usize>,
    pub cursor: Option<String>,
}

impl WorkItemFilter {
    /// 游标绑定的选择：换了筛选条件，旧游标作废。
    fn selection(&self) -> String {
        json!([
            self.status,
            self.assignee,
            self.milestone,
            self.query,
            self.ready,
            self.closed
        ])
        .to_string()
    }
}

fn like_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('%');
    for c in text.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

fn page(
    cx: &Ctx<'_>,
    where_sql: &str,
    params: &[Value],
    tail: &str,
    order: &str,
) -> Result<Vec<Value>, DomainError> {
    let sql = hydrated_sql(where_sql, tail, order);
    let mut all: Vec<rusqlite::types::Value> = vec![cx.p.id.clone().into()];
    for p in params {
        all.push(match p {
            Value::String(s) => s.clone().into(),
            Value::Number(n) if n.is_i64() => n.as_i64().unwrap_or_default().into(),
            Value::Number(n) => n.as_f64().unwrap_or_default().into(),
            Value::Bool(b) => i64::from(*b).into(),
            _ => rusqlite::types::Value::Null,
        });
    }
    let code = cx.p.code.clone();
    cx.tx
        .prepare(&sql)
        .map_err(db)?
        .query_map(params_from_iter(all), |r| work_item(&code, r))
        .map_err(db)?
        .collect::<rusqlite::Result<_>>()
        .map_err(db)
}

impl Service {
    /// `GET /projects/:code/ui/work-items`（#60）：2.0 `listWorkItemPage`，优先级 → sort_key → 创建时间 → 编号。
    pub fn ui_work_items(
        &self,
        principal: &Principal,
        project: &str,
        f: &WorkItemFilter,
    ) -> Result<Value, DomainError> {
        self.read_project(principal, Capability::WorkRead, project, |cx| {
            let selection = f.selection();
            let mut clauses = vec!["1 = 1".to_owned()];
            let mut params: Vec<Value> = Vec::new();
            // `?N` 按参数的位置编号（`?1` 是项目 id）；同一个参数在一条子句里可以出现多次。
            let bind = |clauses: &mut Vec<String>, params: &mut Vec<Value>, sql: &str, v: Value| {
                clauses.push(sql.replace('?', &format!("?{}", params.len() + 2)));
                params.push(v);
            };
            if let Some(s) = &f.status {
                bind(&mut clauses, &mut params, "status = ?", json!(s));
            }
            match f.closed {
                Some(true) => clauses.push(CLOSED_SQL.to_owned()),
                Some(false) => clauses.push(format!("NOT {CLOSED_SQL}")),
                None => {}
            }
            if let Some(a) = &f.assignee {
                bind(&mut clauses, &mut params, "assignee_agent_id = ?", json!(a));
            }
            if let Some(m) = &f.milestone {
                bind(&mut clauses, &mut params, "milestone_id = ?", json!(m));
            }
            if let Some(q) = &f.query {
                bind(
                    &mut clauses,
                    &mut params,
                    "(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')",
                    json!(like_escape(q)),
                );
            }
            if f.ready {
                clauses.push(
                    "status = 'READY' AND NOT EXISTS (
                       SELECT 1 FROM work_item_relations relation
                       JOIN work_items dependency ON dependency.project_id = relation.project_id
                         AND dependency.id = relation.source_id
                       WHERE relation.project_id = work_items.project_id AND relation.target_id = work_items.id
                         AND relation.relation_type = 'BLOCKS' AND dependency.status <> 'DONE')"
                        .to_owned(),
                );
            }
            if let Some(token) = &f.cursor {
                let last = cursor::open(&cx.key, UI_TASKS, &cx.p, token)?;
                if str_of(&last, "s")? != selection {
                    return Err(cursor::invalid("INVALID_OR_TAMPERED"));
                }
                let (rank, sort, created, no) = (
                    int_of(&last, "r")?,
                    int_of(&last, "k")?,
                    str_of(&last, "c")?.to_owned(),
                    int_of(&last, "n")?,
                );
                let n = params.len() + 2;
                clauses.push(format!(
                    "({PRIORITY_RANK}, sort_key, created_at, local_no) > (?{}, ?{}, ?{}, ?{})",
                    n,
                    n + 1,
                    n + 2,
                    n + 3
                ));
                params.extend([json!(rank), json!(sort), json!(created), json!(no)]);
            }
            let limit = f.limit.unwrap_or(20).clamp(1, 100);
            let items = page(
                cx,
                &clauses.join(" AND "),
                &params,
                &format!("ORDER BY {PRIORITY_RANK}, sort_key, created_at, local_no LIMIT {}", limit + 1),
                "ORDER BY CASE selected.priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END,
                          selected.sort_key, selected.created_at, selected.local_no",
            )?;
            let next = |last: &Value| -> Result<String, DomainError> {
                let (no, rank) = last_keys(cx, last)?;
                let mut m = Map::new();
                m.insert("s".into(), json!(selection));
                m.insert("r".into(), json!(rank.0));
                m.insert("k".into(), json!(rank.1));
                m.insert("c".into(), json!(rank.2));
                m.insert("n".into(), json!(no));
                Ok(cursor::seal(&cx.key, UI_TASKS, &cx.p, m))
            };
            cursor_page(items, limit, next)
        })
    }

    /// `GET /projects/:code/ui/work-items/closed`（#62）：已结束的任务按结束时间倒序，带总数。
    pub fn ui_closed_work_items(
        &self,
        principal: &Principal,
        project: &str,
        limit: Option<usize>,
        cursor_token: Option<&str>,
    ) -> Result<Value, DomainError> {
        self.read_project(principal, Capability::WorkRead, project, |cx| {
            let mut clauses = vec![CLOSED_SQL.to_owned()];
            let mut params = Vec::new();
            if let Some(token) = cursor_token {
                let last = cursor::open(&cx.key, UI_CLOSED, &cx.p, token)?;
                clauses.push(format!(
                    "({FINISHED_AT_SQL} < ?2 OR ({FINISHED_AT_SQL} = ?2 AND local_no < ?3))"
                ));
                params.extend([json!(str_of(&last, "f")?), json!(int_of(&last, "n")?)]);
            }
            let limit = limit.unwrap_or(5).clamp(1, 100);
            let items = page(
                cx,
                &clauses.join(" AND "),
                &params,
                &format!("ORDER BY {FINISHED_AT_SQL} DESC, local_no DESC LIMIT {}", limit + 1),
                "ORDER BY COALESCE(selected.completed_at, selected.updated_at) DESC, selected.local_no DESC",
            )?;
            let total: i64 = cx
                .tx
                .query_row(
                    &format!("SELECT COUNT(*) FROM work_items WHERE project_id = ?1 AND {CLOSED_SQL}"),
                    [&cx.p.id],
                    |r| r.get(0),
                )
                .map_err(db)?;
            let next = |last: &Value| -> Result<String, DomainError> {
                let (no, finished): (i64, String) = cx
                    .tx
                    .query_row(
                        &format!(
                            "SELECT local_no, {FINISHED_AT_SQL} FROM work_items WHERE project_id = ?1 AND id = ?2"
                        ),
                        [&cx.p.id, &last["id"].as_str().unwrap_or_default().to_owned()],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .map_err(db)?;
                let mut m = Map::new();
                m.insert("f".into(), json!(finished));
                m.insert("n".into(), json!(no));
                Ok(cursor::seal(&cx.key, UI_CLOSED, &cx.p, m))
            };
            let mut out = cursor_page(items, limit, next)?;
            out["total"] = json!(total);
            Ok(out)
        })
    }

    /// `GET /projects/:code/ui/progress-strip`（#61）：`since` 是本次服务启动的时间（2.0 用 daemon 的 startedAt）。
    pub fn ui_progress_strip(
        &self,
        principal: &Principal,
        project: &str,
        since: &str,
    ) -> Result<Value, DomainError> {
        self.read_project(principal, Capability::WorkRead, project, |cx| {
            cx.tx
                .query_row(
                    &format!(
                        "SELECT COALESCE(SUM(CASE WHEN status = 'DONE' AND completed_at >= ?2 THEN 1 ELSE 0 END), 0),
                                COALESCE(SUM(CASE WHEN status IN {STRIP_ACTIVE} THEN 1 ELSE 0 END), 0),
                                COALESCE(SUM(CASE WHEN status IN {STRIP_WAITING} THEN 1 ELSE 0 END), 0),
                                COALESCE(SUM(CASE WHEN status = 'READY' THEN 1 ELSE 0 END), 0)
                         FROM work_items WHERE project_id = ?1"
                    ),
                    [&cx.p.id, &since.to_owned()],
                    |r| {
                        Ok(json!({
                            "since": since,
                            "done": r.get::<_, i64>(0)?,
                            "active": r.get::<_, i64>(1)?,
                            "waiting": r.get::<_, i64>(2)?,
                            "ready": r.get::<_, i64>(3)?,
                        }))
                    },
                )
                .map_err(db)
        })
    }

    /// 某任务最近 `n`（1～10）条进度，新的在前（2.0 `recentTaskProgress`，手机快照的 `recent` 用）。
    /// 形状与 Agent 读的进度相同（snake_case）。
    pub fn ui_recent_progress(
        &self,
        principal: &Principal,
        project: &str,
        task: &str,
        n: i64,
    ) -> Result<Vec<Value>, DomainError> {
        self.read_project(principal, Capability::WorkRead, project, |cx| {
            let row = views::task_by_key(cx, task)?;
            views::recent_progress(cx, &row.id, n.clamp(1, 10))
        })
    }

    /// `GET /projects/:code/ui/work-items/:taskKey`（#63）：`WorkItemView` 加清单、依赖、发现关系与执行中的 session（原始行，snake_case）。
    pub fn ui_work_item(
        &self,
        principal: &Principal,
        project: &str,
        task: &str,
    ) -> Result<Value, DomainError> {
        self.read_project(principal, Capability::WorkRead, project, |cx| {
            let row = views::task_by_key(cx, task)?;
            let mut items = page(cx, "work_items.id = ?2", &[json!(row.id)], "", "")?;
            let mut v = items.pop().ok_or_else(|| views::not_found(cx, task))?;
            let code = cx.p.code.clone();
            let keys_of = |sql: &str| -> Result<Vec<String>, DomainError> {
                cx.tx
                    .prepare(sql)
                    .map_err(db)?
                    .query_map([&cx.p.id, &row.id], |r| r.get::<_, i64>(0))
                    .map_err(db)?
                    .map(|n| n.map(|n| keys::task_key(&code, n)))
                    .collect::<rusqlite::Result<_>>()
                    .map_err(db)
            };
            let dependencies = keys_of(
                "SELECT s.local_no FROM work_item_relations r JOIN work_items s ON s.project_id = r.project_id AND s.id = r.source_id
                 WHERE r.project_id = ?1 AND r.target_id = ?2 AND r.relation_type = 'BLOCKS' ORDER BY r.created_at, s.local_no",
            )?;
            let discovered = keys_of(
                "SELECT s.local_no FROM work_item_relations r JOIN work_items s ON s.project_id = r.project_id AND s.id = r.source_id
                 WHERE r.project_id = ?1 AND r.target_id = ?2 AND r.relation_type = 'DISCOVERED_FROM' ORDER BY r.created_at, s.local_no",
            )?;
            let execution = match &row.claimed_by {
                None => Value::Null,
                Some(session) => cx
                    .tx
                    .query_row(
                        "SELECT s.id, s.agent_id, a.display_name, s.role, s.connection_state, s.work_state, s.cwd,
                                s.git_branch, s.git_head, s.git_repo_root, s.worktree_root, s.git_is_linked_worktree,
                                s.git_detached, s.git_dirty, s.git_available, s.git_error
                         FROM agent_sessions s JOIN agents a ON a.project_id = s.project_id AND a.id = s.agent_id
                         WHERE s.project_id = ?1 AND s.id = ?2",
                        [&cx.p.id, session],
                        |r| {
                            Ok(json!({
                                "id": r.get::<_, String>(0)?,
                                "agent_id": r.get::<_, String>(1)?,
                                "display_name": r.get::<_, String>(2)?,
                                "role": r.get::<_, String>(3)?,
                                "connection_state": r.get::<_, String>(4)?,
                                "work_state": r.get::<_, String>(5)?,
                                "cwd": r.get::<_, Option<String>>(6)?,
                                "git_branch": r.get::<_, Option<String>>(7)?,
                                "git_head": r.get::<_, Option<String>>(8)?,
                                "git_repo_root": r.get::<_, Option<String>>(9)?,
                                "worktree_root": r.get::<_, Option<String>>(10)?,
                                "git_is_linked_worktree": r.get::<_, Option<i64>>(11)?,
                                "git_detached": r.get::<_, Option<i64>>(12)?,
                                "git_dirty": r.get::<_, Option<i64>>(13)?,
                                "git_available": r.get::<_, i64>(14)?,
                                "git_error": r.get::<_, Option<String>>(15)?,
                            }))
                        },
                    )
                    .map(Some)
                    .or_else(|e| match e {
                        rusqlite::Error::QueryReturnedNoRows => Ok(None),
                        e => Err(db(e)),
                    })?
                    .unwrap_or(Value::Null),
            };
            views::extend(
                &mut v,
                json!({
                    "checklist": views::checklist_items(cx, &row.id)?,
                    "dependencies": dependencies,
                    "discovered": discovered,
                    "executionSession": execution,
                }),
            );
            Ok(v)
        })
    }

    /// `GET /projects/:code/work-items/:taskKey?view=full` 的界面形状（#68）：2.0 `projectTaskView`，不裁剪。
    pub fn ui_task_full(
        &self,
        principal: &Principal,
        project: &str,
        task: &str,
    ) -> Result<Value, DomainError> {
        self.read_project(principal, Capability::WorkRead, project, |cx| {
            let row = views::task_by_key(cx, task)?;
            views::task_view(cx, &row, TaskView::Full)
        })
    }
}

/// 列表游标要的排序键：(local_no, (优先级序, sort_key, created_at))。
fn last_keys(cx: &Ctx<'_>, item: &Value) -> Result<(i64, (i64, i64, String)), DomainError> {
    cx.tx
        .query_row(
            &format!(
                "SELECT local_no, {PRIORITY_RANK}, sort_key, created_at FROM work_items WHERE project_id = ?1 AND id = ?2"
            ),
            [&cx.p.id, &item["id"].as_str().unwrap_or_default().to_owned()],
            |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?, r.get(3)?))),
        )
        .map_err(db)
}
