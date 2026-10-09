//! 规划与项目更新（03 U14–U17、A04–A05：`work.plan`、`project_update.draft` / `project_update.publish`；
//! 00 02 C-11、01 C-18）。
//!
//! - objective / milestone 的显式建立：User 与 Agent 都可以（Agent 要 session，C-11 要 op_id）。新建的
//!   objective 是 ACTIVE，同项目原来 ACTIVE 的 objective 降为 PLANNED（2.x `planning-commands.ts:58-63`）；
//!   milestone 不能挂到 DONE / CANCELLED 的 objective 下（C-18 同一规则），排序键取项目内最大值 + 1000。
//! - 项目更新的草稿与发布只有 User（Agent 走 `progress.add scope=project`）。草稿按 2.x 从事件与任务
//!   自动汇总；发布可以带草稿 id（草稿行就地转为 PUBLISHED），也可以直接发布。发布同时把项目的
//!   health 改成这次的值（2.x `project_meta.health`），Agent 的项目进度同样如此。
//!
//! operation 名沿用 2.x（`objective.create`、`milestone.create`、`project-update.draft`、
//! `project-update.publish`），转换来的旧回执按 kernel-v1 比对。

use super::Target;
use super::core::{Work, db, invalid_argument};
use super::create::closed_target;
use super::patch::check_date;
use crate::fp::JsValue;
use crate::memory::PROJECT_UPDATE_OPERATION;
use crate::read::views::{PROJECT_UPDATE_COLS, project_update_from_row};
use crate::write::{Family, FpInput, Service, Written};
use atm_domain::capability::Capability;
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::keys;
use atm_domain::principal::Principal;
use atm_domain::text::{js_trim, utf16_len};
use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value, json};

pub const OBJECTIVE_OPERATION: &str = "objective.create";
pub const MILESTONE_OPERATION: &str = "milestone.create";
pub const DRAFT_OPERATION: &str = "project-update.draft";

const HEALTH: [&str; 4] = ["ON_TRACK", "AT_RISK", "OFF_TRACK", "UNKNOWN"];

/// objective 的入参（2.x `CreateObjectiveInputSchema`）。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ObjectiveRequest {
    pub title: String,
    pub description: String,
    pub definition_of_done: Vec<String>,
}

/// milestone 的入参（2.x `CreateMilestoneInputSchema`）。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MilestoneRequest {
    pub objective_id: String,
    pub title: String,
    pub description: String,
    /// `YYYY-MM-DD`。
    pub target_date: Option<String>,
}

/// User 发布项目更新（2.x `POST /projects/:code/project-updates`）。`None` 的列表取草稿里的值（没有草稿就是空）。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PublishRequest {
    pub draft_id: Option<String>,
    /// 缺省 `UNKNOWN`。
    pub health: Option<String>,
    pub summary: String,
    pub completed: Option<Vec<String>>,
    pub risks: Option<Vec<String>>,
    pub next: Option<Vec<String>>,
}

fn title(field: &str, value: &str) -> Result<String, DomainError> {
    let t = js_trim(value);
    if t.is_empty() {
        return Err(invalid_argument(field, format!("{field} 不能为空")));
    }
    bounded(field, t, 400)?;
    Ok(t.to_owned())
}

fn bounded(field: &str, value: &str, max: usize) -> Result<(), DomainError> {
    if utf16_len(value) > max {
        return Err(
            invalid_argument(field, format!("{field} 最多 {max} 个字符")).detail("max", max),
        );
    }
    Ok(())
}

/// 文本列表：最多 `count` 条，每条去空白后非空、不超过 500 个字符。
fn text_list(field: &str, list: &[String], count: usize) -> Result<Vec<String>, DomainError> {
    if list.len() > count {
        return Err(
            invalid_argument(field, format!("{field} 最多 {count} 条")).detail("max", count)
        );
    }
    list.iter()
        .map(|s| {
            let t = js_trim(s);
            if t.is_empty() {
                return Err(invalid_argument(field, format!("{field} 的条目不能为空")));
            }
            bounded(field, t, 500)?;
            Ok(t.to_owned())
        })
        .collect()
}

pub(super) fn validate_objective(r: &ObjectiveRequest) -> Result<ObjectiveRequest, DomainError> {
    bounded("description", &r.description, 20_000)?;
    Ok(ObjectiveRequest {
        title: title("title", &r.title)?,
        description: r.description.clone(),
        definition_of_done: text_list("definition_of_done", &r.definition_of_done, 50)?,
    })
}

pub(super) fn validate_milestone(r: &MilestoneRequest) -> Result<MilestoneRequest, DomainError> {
    let objective_id = js_trim(&r.objective_id);
    if objective_id.is_empty() {
        return Err(invalid_argument("objective_id", "objective_id 不能为空"));
    }
    bounded("description", &r.description, 20_000)?;
    if let Some(d) = &r.target_date {
        check_date("target_date", d)?;
    }
    Ok(MilestoneRequest {
        objective_id: objective_id.to_owned(),
        title: title("title", &r.title)?,
        description: r.description.clone(),
        target_date: r.target_date.clone(),
    })
}

fn health(value: Option<&str>) -> Result<String, DomainError> {
    let h = value.map_or("UNKNOWN", js_trim).to_uppercase();
    if !HEALTH.contains(&h.as_str()) {
        return Err(
            invalid_argument("health", format!("health 只能是 {}", HEALTH.join(" / ")))
                .detail("allowed", HEALTH.to_vec()),
        );
    }
    Ok(h)
}

fn validate_publish(r: &PublishRequest) -> Result<(), DomainError> {
    health(r.health.as_deref())?;
    let summary = js_trim(&r.summary);
    if summary.is_empty() {
        return Err(invalid_argument("summary", "summary 不能为空"));
    }
    bounded("summary", summary, 500)?;
    for (field, list) in [
        ("completed", &r.completed),
        ("risks", &r.risks),
        ("next", &r.next),
    ] {
        if let Some(list) = list {
            text_list(field, list, 20)?;
        }
    }
    if let Some(id) = &r.draft_id
        && js_trim(id).is_empty()
    {
        return Err(invalid_argument("draft_id", "draft_id 不能为空"));
    }
    Ok(())
}

fn object(m: Map<String, Value>) -> Option<JsValue> {
    Some(JsValue::from_json(&Value::Object(m)))
}

/// 发布与 Agent 项目进度共用：项目的 health 改成这次发布的值（2.x `project_meta` 的 health 与 version）。
/// `updated_at` 不动：它是 2.x 注册表那一行的时间（项目列表按它排），2.x 的 health 在项目库里，改它从不碰注册表；
/// 合并时 `project_meta` 只取 health / version / current_sequence，它的 `updated_at` 舍弃了（05-data-mapping）。
pub(crate) fn set_project_health(w: &Work<'_>, health: &str) -> Result<(), DomainError> {
    w.tx.execute(
        "UPDATE projects SET health = ?2, meta_version = meta_version + 1 WHERE id = ?1",
        params![w.project, health],
    )
    .map_err(db)?;
    Ok(())
}

fn project_update_view(w: &Work<'_>, id: &str) -> Result<Value, DomainError> {
    w.tx.query_row(
        &format!(
            "SELECT {PROJECT_UPDATE_COLS} FROM project_updates WHERE project_id = ?1 AND id = ?2"
        ),
        [&w.project, id],
        project_update_from_row,
    )
    .map_err(db)
}

const PRIORITY_ORDER: &str =
    "CASE priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END";

fn strings(
    w: &Work<'_>,
    sql: &str,
    args: impl rusqlite::Params,
) -> Result<Vec<String>, DomainError> {
    w.tx.prepare(sql)
        .map_err(db)?
        .query_map(args, |r| r.get(0))
        .map_err(db)?
        .collect::<rusqlite::Result<_>>()
        .map_err(db)
}

pub(super) fn create_objective(
    w: &mut Work<'_>,
    r: &ObjectiveRequest,
) -> Result<Value, DomainError> {
    w.tx.execute(
        "UPDATE objectives SET status = 'PLANNED', version = version + 1, updated_at = ?2
         WHERE project_id = ?1 AND status = 'ACTIVE'",
        params![w.project, w.now_iso],
    )
    .map_err(db)?;
    let id = w.ulid()?;
    let no = w.next_number("objective")?;
    w.tx.execute(
        "INSERT INTO objectives (project_id, id, local_no, title, description, definition_of_done_json, status,
                                 weight, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'ACTIVE', 1, 0, ?7, ?7)",
        params![
            w.project,
            id,
            no,
            r.title,
            r.description,
            json!(r.definition_of_done).to_string(),
            w.now_iso
        ],
    )
    .map_err(db)?;
    w.emit(
        "objective.created",
        "OBJECTIVE",
        &id,
        &json!({ "id": id, "localNo": no, "title": r.title }),
    )?;
    Ok(json!({
        "id": id,
        "localNo": no,
        "title": r.title,
        "status": "ACTIVE",
        "version": 0,
        "sequence": w.sequence,
    }))
}

pub(super) fn create_milestone(
    w: &mut Work<'_>,
    r: &MilestoneRequest,
) -> Result<Value, DomainError> {
    let status: Option<String> =
        w.tx.query_row(
            "SELECT status FROM objectives WHERE project_id = ?1 AND id = ?2",
            [&w.project, &r.objective_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db)?;
    let Some(status) = status else {
        return Err(DomainError::new(
            ErrorCode::OBJECTIVE_NOT_FOUND,
            format!("objective {} 不存在", r.objective_id),
        )
        .detail("entity", "OBJECTIVE")
        .detail("objective_id", r.objective_id.as_str()));
    };
    closed_target("objective", &r.objective_id, &status)?;
    let sort: i64 =
        w.tx.query_row(
            "SELECT COALESCE(MAX(sort_key), 0) + 1000 FROM milestones WHERE project_id = ?1",
            [&w.project],
            |row| row.get(0),
        )
        .map_err(db)?;
    let id = w.ulid()?;
    let no = w.next_number("milestone")?;
    w.tx.execute(
        "INSERT INTO milestones (project_id, id, local_no, objective_id, title, description, target_date, status,
                                 weight, sort_key, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'ACTIVE', 1, ?8, 0, ?9, ?9)",
        params![
            w.project,
            id,
            no,
            r.objective_id,
            r.title,
            r.description,
            r.target_date,
            sort,
            w.now_iso
        ],
    )
    .map_err(db)?;
    w.emit(
        "milestone.created",
        "MILESTONE",
        &id,
        &json!({ "id": id, "objectiveId": r.objective_id, "localNo": no, "title": r.title }),
    )?;
    // 回执是 2.x `createMilestone` 的形状：不回 objectiveId（界面与 Agent 都不读）。
    Ok(json!({
        "id": id,
        "localNo": no,
        "title": r.title,
        "status": "ACTIVE",
        "version": 0,
        "sequence": w.sequence,
    }))
}

/// 2.x `draftProjectUpdate`：从上一次发布之后的完成事件、当前阻塞与等待、排在前面的待办自动汇总。
fn draft(w: &mut Work<'_>) -> Result<Value, DomainError> {
    let (health, to): (String, i64) =
        w.tx.query_row(
            "SELECT health, project_seq FROM projects WHERE id = ?1",
            [&w.project],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(db)?;
    let from: i64 =
        w.tx.query_row(
            "SELECT to_sequence FROM project_updates WHERE project_id = ?1 AND status = 'PUBLISHED'
             ORDER BY published_at DESC LIMIT 1",
            [&w.project],
            |r| r.get(0),
        )
        .optional()
        .map_err(db)?
        .unwrap_or(0);
    let completed = strings(
        w,
        "SELECT item.title FROM events event
         JOIN work_items item ON item.project_id = event.project_id AND item.id = event.aggregate_id
         WHERE event.project_id = ?1 AND event.seq > ?2 AND event.seq <= ?3 AND event.type = 'work.completed'
         ORDER BY event.seq DESC LIMIT 10",
        params![w.project, from, to],
    )?;
    let risks = strings(
        w,
        "SELECT COALESCE(blocked_reason, waiting_for, title) FROM work_items
         WHERE project_id = ?1 AND status IN ('BLOCKED', 'WAITING_USER', 'WAITING_AGENT')
         ORDER BY updated_at DESC LIMIT 10",
        [&w.project],
    )?;
    // 2.x：默认列表的前 5 条里，挑出 READY / CLAIMED / IN_PROGRESS 的。
    let next: Vec<String> =
        w.tx.prepare(&format!(
            "SELECT title, status FROM work_items WHERE project_id = ?1
             ORDER BY {PRIORITY_ORDER}, sort_key, created_at LIMIT 5"
        ))
        .map_err(db)?
        .query_map([&w.project], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(db)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db)?
        .into_iter()
        .filter(|(_, s)| matches!(s.as_str(), "READY" | "CLAIMED" | "IN_PROGRESS"))
        .map(|(t, _)| t)
        .collect();
    let summary = format!(
        "{}；{}",
        if completed.is_empty() {
            "暂无新增完成项".to_owned()
        } else {
            format!("完成 {} 项", completed.len())
        },
        if risks.is_empty() {
            "当前无阻塞风险".to_owned()
        } else {
            format!("存在 {} 项风险", risks.len())
        }
    );
    let id = w.ulid()?;
    let actor = w.actor().clone();
    w.tx.execute(
        "INSERT INTO project_updates (project_id, id, health, summary, completed_json, risks_json, next_json,
           from_sequence, to_sequence, status, actor, published_at, created_at, updated_at, op_id, session_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'DRAFT', ?10, NULL, ?11, ?11, ?12, ?13)",
        params![
            w.project,
            id,
            health,
            summary,
            json!(completed).to_string(),
            json!(risks).to_string(),
            json!(next).to_string(),
            from,
            to,
            actor.id,
            w.now_iso,
            w.ctx.op_id,
            actor.session,
        ],
    )
    .map_err(db)?;
    w.emit(
        "project.update.drafted",
        "PROJECT_UPDATE",
        &id,
        &json!({ "id": id, "fromSequence": from, "toSequence": to }),
    )?;
    let mut view = project_update_view(w, &id)?;
    view["sequence"] = json!(w.sequence);
    Ok(view)
}

struct Draft {
    id: String,
    completed: Value,
    risks: Value,
    next: Value,
    evidence: Value,
    from: i64,
    to: i64,
}

fn parse(text: String) -> Value {
    serde_json::from_str(&text).unwrap_or_else(|_| json!([]))
}

/// 2.x `publishProjectUpdate`（User 路径）：草稿就地发布，或新建一条 PUBLISHED。
fn publish(w: &mut Work<'_>, r: &PublishRequest) -> Result<Value, DomainError> {
    let draft = match r.draft_id.as_deref().map(js_trim) {
        Some(draft_id) => Some(
            w.tx.query_row(
                "SELECT id, completed_json, risks_json, next_json, evidence_json, from_sequence, to_sequence
                 FROM project_updates WHERE project_id = ?1 AND id = ?2 AND status = 'DRAFT'",
                [&w.project, draft_id],
                |row| {
                    Ok(Draft {
                        id: row.get(0)?,
                        completed: parse(row.get(1)?),
                        risks: parse(row.get(2)?),
                        next: parse(row.get(3)?),
                        evidence: parse(row.get(4)?),
                        from: row.get(5)?,
                        to: row.get(6)?,
                    })
                },
            )
            .optional()
            .map_err(db)?
            .ok_or_else(|| {
                DomainError::new(
                    ErrorCode::PROJECT_UPDATE_DRAFT_NOT_FOUND,
                    format!("项目更新草稿不存在：{draft_id}"),
                )
                .detail("entity", "PROJECT_UPDATE_DRAFT")
                .detail("reference", draft_id)
            })?,
        ),
        None => None,
    };
    let list = |given: &Option<Vec<String>>, saved: Option<&Value>| -> Value {
        match given {
            Some(l) => json!(l.iter().map(|s| js_trim(s)).collect::<Vec<_>>()),
            None => saved.cloned().unwrap_or_else(|| json!([])),
        }
    };
    let completed = list(&r.completed, draft.as_ref().map(|d| &d.completed));
    let risks = list(&r.risks, draft.as_ref().map(|d| &d.risks));
    let next = list(&r.next, draft.as_ref().map(|d| &d.next));
    let evidence = draft
        .as_ref()
        .map_or_else(|| json!([]), |d| d.evidence.clone());
    let from = match &draft {
        Some(d) => d.from,
        None => w
            .tx
            .query_row(
                "SELECT COALESCE(MAX(to_sequence), 0) FROM project_updates WHERE project_id = ?1 AND status = 'PUBLISHED'",
                [&w.project],
                |row| row.get(0),
            )
            .map_err(db)?,
    };
    let to = match &draft {
        Some(d) => d.to,
        None => {
            w.tx.query_row(
                "SELECT project_seq FROM projects WHERE id = ?1",
                [&w.project],
                |row| row.get(0),
            )
            .map_err(db)?
        }
    };
    let health = health(r.health.as_deref())?;
    let summary = js_trim(&r.summary).to_owned();
    let actor = w.actor().clone();
    let id = match &draft {
        Some(d) => {
            w.tx.execute(
                "UPDATE project_updates SET health = ?3, summary = ?4, completed_json = ?5, risks_json = ?6,
                   next_json = ?7, evidence_json = ?8, status = 'PUBLISHED', actor = ?9, published_at = ?10,
                   updated_at = ?10, op_id = ?11, session_id = ?12
                 WHERE project_id = ?1 AND id = ?2",
                params![
                    w.project,
                    d.id,
                    health,
                    summary,
                    completed.to_string(),
                    risks.to_string(),
                    next.to_string(),
                    evidence.to_string(),
                    actor.id,
                    w.now_iso,
                    w.ctx.op_id,
                    actor.session,
                ],
            )
            .map_err(db)?;
            d.id.clone()
        }
        None => {
            let id = w.ulid()?;
            w.tx.execute(
                "INSERT INTO project_updates (project_id, id, health, summary, completed_json, risks_json, next_json,
                   evidence_json, from_sequence, to_sequence, status, actor, published_at, created_at, updated_at,
                   op_id, session_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'PUBLISHED', ?11, ?12, ?12, ?12, ?13, ?14)",
                params![
                    w.project,
                    id,
                    health,
                    summary,
                    completed.to_string(),
                    risks.to_string(),
                    next.to_string(),
                    evidence.to_string(),
                    from,
                    to,
                    actor.id,
                    w.now_iso,
                    w.ctx.op_id,
                    actor.session,
                ],
            )
            .map_err(db)?;
            id
        }
    };
    set_project_health(w, &health)?;
    w.emit(
        "project.update.published",
        "PROJECT_UPDATE",
        &id,
        &json!({ "id": id, "health": health, "summary": summary, "fromSequence": from, "toSequence": to }),
    )?;
    // 2.x：还开着的任务（completed 只有文字，User 路径不排除任何任务），前 20 个的 key。
    let total: i64 = w
        .tx
        .query_row(
            "SELECT count(*) FROM work_items WHERE project_id = ?1 AND status NOT IN ('DONE', 'CANCELLED')",
            [&w.project],
            |row| row.get(0),
        )
        .map_err(db)?;
    let open: Vec<String> = w
        .tx
        .prepare(&format!(
            "SELECT local_no FROM work_items WHERE project_id = ?1 AND status NOT IN ('DONE', 'CANCELLED')
             ORDER BY {PRIORITY_ORDER}, sort_key, created_at, local_no LIMIT 20"
        ))
        .map_err(db)?
        .query_map([&w.project], |row| row.get::<_, i64>(0))
        .map_err(db)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db)?
        .into_iter()
        .map(|no| keys::task_key(&w.code, no))
        .collect();
    let mut view = project_update_view(w, &id)?;
    let has_completed = completed.as_array().is_some_and(|a| !a.is_empty());
    view["sequence"] = json!(w.sequence);
    view["unlinked"] = json!(has_completed && total > 0);
    view["open_work_item_count"] = json!(total);
    view["open_work_items_truncated"] = json!((open.len() as i64) < total);
    view["open_work_items"] = json!(open);
    Ok(view)
}

impl Service {
    /// 建 objective（`work.plan`；U16 / A04）。
    pub fn create_objective(
        &self,
        principal: &Principal,
        target: &Target,
        r: ObjectiveRequest,
    ) -> Result<Written, DomainError> {
        let r = validate_objective(&r)?;
        let fp = r.clone();
        let fingerprint: FpInput = Box::new(move |_, family, _| {
            let mut m = Map::new();
            m.insert("title".into(), json!(fp.title));
            m.insert("description".into(), json!(fp.description));
            m.insert("definitionOfDone".into(), json!(fp.definition_of_done));
            match family {
                Family::CanonV2 | Family::KernelV1 => object(m),
                Family::KnowledgeV1 => None,
            }
        });
        self.write(
            principal,
            target.request(Capability::WorkPlan, OBJECTIVE_OPERATION, fingerprint),
            move |tx, ctx| create_objective(&mut Work::open(tx, ctx)?, &r),
        )
    }

    /// 建 milestone（`work.plan`；U17 / A05）。
    pub fn create_milestone(
        &self,
        principal: &Principal,
        target: &Target,
        r: MilestoneRequest,
    ) -> Result<Written, DomainError> {
        let r = validate_milestone(&r)?;
        let fp = r.clone();
        let fingerprint: FpInput = Box::new(move |_, family, _| {
            let mut m = Map::new();
            m.insert("objectiveId".into(), json!(fp.objective_id));
            m.insert("title".into(), json!(fp.title));
            m.insert("description".into(), json!(fp.description));
            if let Some(d) = &fp.target_date {
                m.insert("targetDate".into(), json!(d));
            }
            match family {
                Family::CanonV2 | Family::KernelV1 => object(m),
                Family::KnowledgeV1 => None,
            }
        });
        self.write(
            principal,
            target.request(Capability::WorkPlan, MILESTONE_OPERATION, fingerprint),
            move |tx, ctx| create_milestone(&mut Work::open(tx, ctx)?, &r),
        )
    }

    /// 生成项目更新草稿（`project_update.draft`；U14，只有 User）。
    pub fn draft_project_update(
        &self,
        principal: &Principal,
        target: &Target,
    ) -> Result<Written, DomainError> {
        let fingerprint: FpInput = Box::new(|_, family, _| match family {
            Family::CanonV2 | Family::KernelV1 => object(Map::new()),
            Family::KnowledgeV1 => None,
        });
        self.write(
            principal,
            target.request(Capability::ProjectUpdateDraft, DRAFT_OPERATION, fingerprint),
            move |tx, ctx| draft(&mut Work::open(tx, ctx)?),
        )
    }

    /// 发布项目更新（`project_update.publish`；U15，只有 User）。
    pub fn publish_project_update(
        &self,
        principal: &Principal,
        target: &Target,
        r: PublishRequest,
    ) -> Result<Written, DomainError> {
        validate_publish(&r)?;
        let fp = r.clone();
        let fingerprint: FpInput = Box::new(move |_, family, _| {
            let mut m = Map::new();
            match family {
                // 2.x 的请求：health、summary 原样，其余只在给了时出现。
                Family::KernelV1 => {
                    m.insert(
                        "health".into(),
                        json!(fp.health.as_deref().unwrap_or("UNKNOWN")),
                    );
                    m.insert("summary".into(), json!(fp.summary));
                }
                Family::CanonV2 => {
                    m.insert("health".into(), json!(health(fp.health.as_deref()).ok()?));
                    m.insert("summary".into(), json!(js_trim(&fp.summary)));
                }
                Family::KnowledgeV1 => return None,
            }
            if let Some(d) = &fp.draft_id {
                m.insert("draftId".into(), json!(js_trim(d)));
            }
            for (k, v) in [
                ("completed", &fp.completed),
                ("risks", &fp.risks),
                ("next", &fp.next),
            ] {
                if let Some(v) = v {
                    m.insert(k.into(), json!(v));
                }
            }
            object(m)
        });
        self.write(
            principal,
            target.request(
                Capability::ProjectUpdatePublish,
                PROJECT_UPDATE_OPERATION,
                fingerprint,
            ),
            move |tx, ctx| publish(&mut Work::open(tx, ctx)?, &r),
        )
    }
}
