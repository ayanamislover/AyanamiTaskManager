//! 界面的项目读（06 #2、#11、#12、#28、#29、#36，以及写入回执里的项目）。

use crate::project::dom_read_error;
use crate::read::{db, present, views};
use crate::write::Service;
use atm_domain::capability::{self, Capability};
use atm_domain::error::DomainError;
use atm_domain::principal::Principal;
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Map, Value, json};

/// 2.0 `SYSTEM_EVENT_SQL`：总览「最近变化」的系统事件判定（与界面 `isSystemTimelineEvent` 一致）。
const SYSTEM_EVENT_SQL: &str =
    "(COALESCE(actor, 'SYSTEM') = 'SYSTEM' OR substr(type, 1, 7) = 'backup.'
      OR type IN ('project.creating', 'agent.git_context.updated', 'database.recovered'))";
const VISIBLE_EVENT_SQL: &str =
    "type <> 'project.summary.updated' AND undone_by_restore_gen IS NULL";

/// 一个项目的 2.0 `RegistryProjectView`。`databasePath` 在单库里是库文件本身。
fn registered(
    tx: &Transaction<'_>,
    database: &str,
    r: &rusqlite::Row<'_>,
) -> rusqlite::Result<Value> {
    let id: String = r.get(0)?;
    let paths: Vec<String> = tx
        .prepare_cached(
            "SELECT canonical_path FROM project_paths WHERE project_id = ?1
             ORDER BY is_primary DESC, last_seen_at DESC",
        )?
        .query_map([&id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(json!({
        "id": id,
        "code": r.get::<_, String>(1)?,
        "name": r.get::<_, String>(2)?,
        "description": r.get::<_, String>(3)?,
        "databasePath": database,
        "lifecycle": r.get::<_, String>(4)?,
        "coordinationMode": r.get::<_, String>(5)?,
        "sourcePaths": paths,
        "version": r.get::<_, i64>(6)?,
    }))
}

const PROJECT_COLS: &str = "id, code, name, description, lifecycle, coordination_mode, version";

fn restore_request(r: &rusqlite::Row<'_>, at: usize) -> rusqlite::Result<Value> {
    Ok(match r.get::<_, Option<String>>(at)? {
        None => Value::Null,
        Some(id) => json!({
            "id": id,
            "projectId": r.get::<_, String>(at + 1)?,
            "requestedBy": r.get::<_, String>(at + 2)?,
            "sourceCwd": r.get::<_, Option<String>>(at + 3)?,
            "status": r.get::<_, String>(at + 4)?,
            "requestCount": r.get::<_, i64>(at + 5)?,
            "createdAt": r.get::<_, String>(at + 6)?,
            "updatedAt": r.get::<_, String>(at + 7)?,
            "decidedAt": r.get::<_, Option<String>>(at + 8)?,
            "decidedBy": r.get::<_, Option<String>>(at + 9)?,
        }),
    })
}

const REQUEST_COLS: &str =
    "r.id, r.project_id, r.requested_by, r.source_cwd, r.status, r.request_count,
    r.created_at, r.updated_at, r.decided_at, r.decided_by";

impl Service {
    fn database_path(&self) -> String {
        self.store().path().to_string_lossy().into_owned()
    }

    /// `GET /projects`（#11 的界面形状）：不含 TRASHED，最近更新的在前；路径主路径在前。
    pub fn ui_projects(&self, principal: &Principal) -> Result<Value, DomainError> {
        capability::require(principal, Capability::ProjectRead)?;
        let database = self.database_path();
        self.store()
            .read(|tx| -> Result<Value, DomainError> {
                let rows: Vec<Value> = tx
                    .prepare(&format!(
                        "SELECT {PROJECT_COLS} FROM projects WHERE lifecycle <> 'TRASHED' ORDER BY updated_at DESC"
                    ))
                    .map_err(db)?
                    .query_map([], |r| registered(tx, &database, r))
                    .map_err(db)?
                    .collect::<rusqlite::Result<_>>()
                    .map_err(db)?;
                Ok(Value::Array(rows))
            })
            .map_err(dom_read_error)
    }

    /// 一个项目的界面形状（写入回执、`GET /projects/:code`）。按代码或 id 找，不看生命周期。
    pub fn ui_project(&self, principal: &Principal, project: &str) -> Result<Value, DomainError> {
        capability::require(principal, Capability::ProjectRead)?;
        let database = self.database_path();
        let code = atm_domain::keys::normalize(project);
        let id = project.trim().to_owned();
        self.store()
            .read(|tx| -> Result<Value, DomainError> {
                tx.query_row(
                    &format!("SELECT {PROJECT_COLS} FROM projects WHERE code = ?1 OR id = ?2"),
                    params![code, id],
                    |r| registered(tx, &database, r),
                )
                .optional()
                .map_err(db)?
                .ok_or_else(|| crate::work::core::project_not_found(project.trim()))
            })
            .map_err(dom_read_error)
    }

    /// `GET /trash/projects`（#12）：TRASHED 项目连同挂着的恢复请求（PENDING 的那一条）。
    pub fn ui_trash(&self, principal: &Principal) -> Result<Value, DomainError> {
        capability::require(principal, Capability::ProjectRead)?;
        let database = self.database_path();
        self.store()
            .read(|tx| -> Result<Value, DomainError> {
                let rows: Vec<Value> = tx
                    .prepare(&format!(
                        "SELECT p.id, p.code, p.name, p.description, p.lifecycle, p.coordination_mode, p.version,
                                {REQUEST_COLS}
                         FROM projects p
                         LEFT JOIN project_restore_requests r ON r.project_id = p.id AND r.status = 'PENDING'
                         WHERE p.lifecycle = 'TRASHED' ORDER BY p.updated_at DESC"
                    ))
                    .map_err(db)?
                    .query_map([], |r| {
                        let mut v = registered(tx, &database, r)?;
                        v["restoreRequest"] = restore_request(r, 7)?;
                        Ok(v)
                    })
                    .map_err(db)?
                    .collect::<rusqlite::Result<_>>()
                    .map_err(db)?;
                Ok(Value::Array(rows))
            })
            .map_err(dom_read_error)
    }

    /// 恢复请求的界面形状（批准 / 驳回的回执）。
    pub fn ui_restore_request(
        &self,
        principal: &Principal,
        id: &str,
    ) -> Result<Value, DomainError> {
        capability::require(principal, Capability::ProjectRead)?;
        self.store()
            .read(|tx| -> Result<Value, DomainError> {
                tx.query_row(
                    &format!(
                        "SELECT {REQUEST_COLS} FROM project_restore_requests r WHERE r.id = ?1"
                    ),
                    [id],
                    |r| restore_request(r, 0),
                )
                .optional()
                .map(|v| v.unwrap_or(Value::Null))
                .map_err(db)
            })
            .map_err(dom_read_error)
    }

    /// `GET /projects/:code/objectives`（#28）：2.0 是 `SELECT *` 的原始行（snake_case），按创建时间。
    pub fn ui_objectives(
        &self,
        principal: &Principal,
        project: &str,
    ) -> Result<Value, DomainError> {
        self.read_project(principal, Capability::WorkRead, project, |cx| {
            let rows: Vec<Value> = cx
                .tx
                .prepare(
                    "SELECT id, local_no, title, description, definition_of_done_json, status, weight,
                            version, created_at, updated_at
                     FROM objectives WHERE project_id = ?1 ORDER BY created_at",
                )
                .map_err(db)?
                .query_map([&cx.p.id], |r| {
                    Ok(json!({
                        "id": r.get::<_, String>(0)?,
                        "local_no": r.get::<_, i64>(1)?,
                        "title": r.get::<_, String>(2)?,
                        "description": r.get::<_, String>(3)?,
                        "definition_of_done_json": r.get::<_, String>(4)?,
                        "status": r.get::<_, String>(5)?,
                        "weight": r.get::<_, f64>(6)?,
                        "version": r.get::<_, i64>(7)?,
                        "created_at": r.get::<_, String>(8)?,
                        "updated_at": r.get::<_, String>(9)?,
                    }))
                })
                .map_err(db)?
                .collect::<rusqlite::Result<_>>()
                .map_err(db)?;
            Ok(Value::Array(rows))
        })
    }

    /// `GET /projects/:code/milestones`（#29）：原始行，`objective` 给了就只要它下面的；按 sort_key、创建时间。
    pub fn ui_milestones(
        &self,
        principal: &Principal,
        project: &str,
        objective: Option<&str>,
    ) -> Result<Value, DomainError> {
        self.read_project(principal, Capability::WorkRead, project, |cx| {
            let rows: Vec<Value> = cx
                .tx
                .prepare(
                    "SELECT id, local_no, objective_id, title, description, planned_start_date, target_date,
                            status, weight, sort_key, version, created_at, updated_at
                     FROM milestones WHERE project_id = ?1 AND (?2 IS NULL OR objective_id = ?2)
                     ORDER BY sort_key, created_at",
                )
                .map_err(db)?
                .query_map(params![cx.p.id, objective], |r| {
                    Ok(json!({
                        "id": r.get::<_, String>(0)?,
                        "local_no": r.get::<_, i64>(1)?,
                        "objective_id": r.get::<_, String>(2)?,
                        "title": r.get::<_, String>(3)?,
                        "description": r.get::<_, String>(4)?,
                        "planned_start_date": r.get::<_, Option<String>>(5)?,
                        "target_date": r.get::<_, Option<String>>(6)?,
                        "status": r.get::<_, String>(7)?,
                        "weight": r.get::<_, f64>(8)?,
                        "sort_key": r.get::<_, i64>(9)?,
                        "version": r.get::<_, i64>(10)?,
                        "created_at": r.get::<_, String>(11)?,
                        "updated_at": r.get::<_, String>(12)?,
                    }))
                })
                .map_err(db)?
                .collect::<rusqlite::Result<_>>()
                .map_err(db)?;
            Ok(Value::Array(rows))
        })
    }

    /// `GET /projects/:code/project-updates`（#36）：最近创建的在前，1–100 条（默认 50）。
    pub fn ui_project_updates(
        &self,
        principal: &Principal,
        project: &str,
        limit: Option<usize>,
    ) -> Result<Value, DomainError> {
        self.read_project(principal, Capability::ProjectRead, project, |cx| {
            let limit = limit.unwrap_or(50).clamp(1, 100) as i64;
            let rows: Vec<Value> = cx
                .tx
                .prepare(&format!(
                    "SELECT {} FROM project_updates WHERE project_id = ?1 ORDER BY created_at DESC LIMIT ?2",
                    views::PROJECT_UPDATE_COLS
                ))
                .map_err(db)?
                .query_map(params![cx.p.id, limit], views::project_update_from_row)
                .map_err(db)?
                .collect::<rusqlite::Result<_>>()
                .map_err(db)?;
            Ok(super::camel(Value::Array(rows), 1))
        })
    }

    /// `GET /overview`（#2）：未进垃圾箱的项目各自的摘要、quick 计数、最近变化（业务 40 条 + 系统 20 条）、
    /// 最近一次备份的结果。2.0 的摘要来自投影缓存；单库里直接算（2.0 `summaryProjection`）。
    /// 投影健康（`projectionSummary` 等）在单库里没有意义，随投影健康面板一起删掉（00 §6）。
    pub fn ui_overview(&self, principal: &Principal) -> Result<Value, DomainError> {
        capability::require(principal, Capability::ProjectRead)?;
        let now = self.clock().to_string();
        self.store()
            .read(|tx| -> Result<Value, DomainError> {
                let projects: Vec<(String, String, String, String, i64, String, String)> = tx
                    .prepare(
                        "SELECT id, code, name, lifecycle, project_seq, health, updated_at
                         FROM projects WHERE lifecycle <> 'TRASHED'",
                    )
                    .map_err(db)?
                    .query_map([], |r| {
                        Ok((
                            r.get(0)?,
                            r.get(1)?,
                            r.get(2)?,
                            r.get(3)?,
                            r.get(4)?,
                            r.get(5)?,
                            r.get(6)?,
                        ))
                    })
                    .map_err(db)?
                    .collect::<rusqlite::Result<_>>()
                    .map_err(db)?;
                let mut rows = Vec::with_capacity(projects.len());
                for (id, code, name, lifecycle, seq, health, updated) in projects {
                    rows.push(summary(tx, &now, &id, &code, &name, &lifecycle, seq, &health, &updated)?);
                }
                // 2.0：按最近活动倒序（没有活动的按项目更新时间）。
                rows.sort_by(|a, b| {
                    b["last_activity_at"]
                        .as_str()
                        .cmp(&a["last_activity_at"].as_str())
                });
                let quick = tx
                    .query_row(
                        "SELECT COUNT(*),
                                COALESCE(SUM(CASE WHEN status IN ('OPEN','IN_PROGRESS','BLOCKED') THEN 1 ELSE 0 END), 0),
                                COALESCE(SUM(CASE WHEN status = 'BLOCKED' THEN 1 ELSE 0 END), 0)
                         FROM quick_tasks",
                        [],
                        |r| {
                            Ok(json!({
                                "total": r.get::<_, i64>(0)?,
                                "open": r.get::<_, i64>(1)?,
                                "blocked": r.get::<_, i64>(2)?,
                            }))
                        },
                    )
                    .map_err(db)?;
                let sequence: i64 = tx
                    .query_row("SELECT global_seq FROM app_meta WHERE singleton = 1", [], |r| {
                        r.get(0)
                    })
                    .map_err(db)?;
                let mut recent = feed_rows(
                    tx,
                    &format!("{VISIBLE_EVENT_SQL} AND NOT {SYSTEM_EVENT_SQL} ORDER BY global_seq DESC LIMIT 40"),
                )?;
                recent.extend(feed_rows(
                    tx,
                    &format!("{VISIBLE_EVENT_SQL} AND {SYSTEM_EVENT_SQL} ORDER BY global_seq DESC LIMIT 20"),
                )?);
                recent.sort_by(|a, b| b["sequence"].as_i64().cmp(&a["sequence"].as_i64()));
                let last_backup = feed_rows(
                    tx,
                    "type IN ('backup.created', 'backup.failed') AND undone_by_restore_gen IS NULL
                     ORDER BY global_seq DESC LIMIT 1",
                )?
                .pop()
                .unwrap_or(Value::Null);
                Ok(json!({
                    "sequence": sequence,
                    "projects": rows,
                    "quick": quick,
                    "recentEvents": recent,
                    "lastBackup": last_backup,
                }))
            })
            .map_err(dom_read_error)
    }
}

/// 2.0 `summaryProjection` 加上项目本身的几列（overview 的一行，snake_case 是那里的契约）。
#[allow(clippy::too_many_arguments)]
fn summary(
    tx: &Transaction<'_>,
    now: &str,
    id: &str,
    code: &str,
    name: &str,
    lifecycle: &str,
    seq: i64,
    health: &str,
    updated: &str,
) -> Result<Value, DomainError> {
    let weights: Vec<(f64, f64)> = tx
        .prepare_cached(
            "SELECT computed_progress, weight FROM work_items
             WHERE project_id = ?1 AND parent_id IS NULL AND status <> 'CANCELLED'",
        )
        .map_err(db)?
        .query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(db)?
        .collect::<rusqlite::Result<_>>()
        .map_err(db)?;
    let total: f64 = weights.iter().map(|(_, w)| w).sum();
    let progress = if total == 0.0 {
        0.0
    } else {
        (weights.iter().map(|(p, w)| p * w).sum::<f64>() / total * 10.0).round() / 10.0
    };
    let mut v = tx
        .query_row(
            "SELECT
               COALESCE(SUM(CASE WHEN status IN ('CLAIMED','IN_PROGRESS','VERIFYING') THEN 1 ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN status = 'READY' THEN 1 ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN status = 'BLOCKED' THEN 1 ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN status = 'WAITING_USER' THEN 1 ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN status = 'WAITING_AGENT' THEN 1 ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN claimed_by_session_id IS NOT NULL AND claim_lease_until IS NOT NULL
                 AND claim_lease_until < ?2 AND status NOT IN ('DONE','CANCELLED') THEN 1 ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN target_date IS NOT NULL AND target_date < date('now')
                 AND status NOT IN ('DONE','CANCELLED') THEN 1 ELSE 0 END), 0),
               MAX(updated_at),
               MIN(CASE WHEN status NOT IN ('DONE','CANCELLED') THEN target_date END)
             FROM work_items WHERE project_id = ?1",
            params![id, now],
            |r| {
                Ok(json!({
                    "active_count": r.get::<_, i64>(0)?,
                    "ready_count": r.get::<_, i64>(1)?,
                    "blocked_count": r.get::<_, i64>(2)?,
                    "waiting_user_count": r.get::<_, i64>(3)?,
                    "waiting_agent_count": r.get::<_, i64>(4)?,
                    "stale_claim_count": r.get::<_, i64>(5)?,
                    "overdue_count": r.get::<_, i64>(6)?,
                    "last_activity_at": r.get::<_, Option<String>>(7)?,
                    "next_target_date": r.get::<_, Option<String>>(8)?,
                }))
            },
        )
        .map_err(db)?;
    let objective: Option<(String, String)> = tx
        .query_row(
            "SELECT id, title FROM objectives WHERE project_id = ?1 AND status = 'ACTIVE'
             ORDER BY updated_at DESC LIMIT 1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(db)?;
    let milestone: Option<String> = tx
        .query_row(
            "SELECT title FROM milestones WHERE project_id = ?1 AND status = 'ACTIVE'
               AND (?2 IS NULL OR objective_id = ?2) ORDER BY sort_key LIMIT 1",
            params![id, objective.as_ref().map(|o| &o.0)],
            |r| r.get(0),
        )
        .optional()
        .map_err(db)?;
    let agents: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM agent_sessions WHERE project_id = ?1 AND connection_state = 'ONLINE'",
            [id],
            |r| r.get(0),
        )
        .map_err(db)?;
    let last_update: Option<String> = tx
        .query_row(
            "SELECT published_at FROM project_updates WHERE project_id = ?1 AND status = 'PUBLISHED'
             ORDER BY published_at DESC LIMIT 1",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(db)?;
    if v["last_activity_at"].is_null() {
        v["last_activity_at"] = json!(updated);
    }
    let head = json!({
        "id": id,
        "code": code,
        "name": name,
        "lifecycle": lifecycle,
        "project_sequence": seq,
        "progress": progress,
        "progress_source": if weights.is_empty() { "NONE" } else { "CHILDREN" },
        "health": health,
        "current_objective": objective.map(|o| o.1),
        "current_milestone": milestone,
        "active_agent_count": agents,
        "last_project_update_at": last_update,
    });
    let mut out: Map<String, Value> = head.as_object().cloned().unwrap_or_default();
    if let Value::Object(counts) = v {
        out.extend(counts);
    }
    Ok(Value::Object(out))
}

/// 全局流的行 → 2.0 `#presentGlobalRow`（`presentEvent` 加 seq / sequence / at / payload_json / projectCode / projectName）。
fn feed_rows(tx: &Transaction<'_>, tail: &str) -> Result<Vec<Value>, DomainError> {
    let sql = format!(
        "SELECT f.global_seq, f.type, f.aggregate_id, f.actor, f.payload_json, f.created_at, p.id, p.code, p.name
         FROM (SELECT * FROM global_feed WHERE {tail}) f
         LEFT JOIN projects p ON p.id = f.project_id"
    );
    tx.prepare(&sql)
        .map_err(db)?
        .query_map([], |r| {
            let seq: i64 = r.get(0)?;
            let kind: String = r.get(1)?;
            let aggregate: String = r.get(2)?;
            let actor: String = r.get(3)?;
            let payload_json: String = r.get(4)?;
            let at: String = r.get(5)?;
            let project = match r.get::<_, Option<String>>(6)? {
                Some(id) => json!({ "id": id, "code": r.get::<_, String>(7)?, "name": r.get::<_, String>(8)? }),
                None => Value::Null,
            };
            let payload = match serde_json::from_str::<Value>(&payload_json) {
                Ok(Value::Object(m)) => m,
                _ => Map::new(),
            };
            let shown = present::present(&kind, Some(&aggregate), Some(&actor), &payload);
            Ok(json!({
                "type": kind,
                "key": shown.key,
                "summary": shown.detail,
                "actor": shown.actor,
                "title": shown.title,
                "detail": shown.detail,
                "project": project,
                "seq": seq,
                "sequence": seq,
                "at": at,
                "payload_json": payload_json,
                "projectCode": project.get("code").cloned().unwrap_or(Value::Null),
                "projectName": project.get("name").cloned().unwrap_or(Value::Null),
            }))
        })
        .map_err(db)?
        .collect::<rusqlite::Result<_>>()
        .map_err(db)
}
