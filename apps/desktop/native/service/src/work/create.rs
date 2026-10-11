//! 批量创建（01 §3 W-070～W-080；00 C-01、C-17、C-18；10 R11 P1-4 第 5 条、P1-5）。
//!
//! 先校验、后写入（W-077）：所有引用、规划目标、整图的环与层级都在第一次写之前查完；写入阶段若仍失败，
//! 整个事务回滚，编号不被消耗。

use super::core::{Work, db, invalid_argument, validation};
use super::graph;
use super::patch::{
    check_acceptance, check_date, dependency_cycle, hierarchy_error, parent_map, prereq_map,
};
use crate::write::internal;
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::principal::PrincipalKind;
use atm_domain::text::{js_trim, utf16_len};
use atm_domain::work::{Status, WaitingOn, WorkState, public_create_state};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct NewChecklist {
    pub title: String,
    pub evidence_required: bool,
    pub weight: Option<f64>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct CreateItem {
    /// 批内引用名；省略时取从 1 开始的序号（R11 P1-4 第 5 条）。
    pub client_ref: Option<String>,
    pub objective_id: Option<String>,
    /// 外层 None：没给；`Some(None)`：显式不挂 milestone。
    pub milestone_id: Option<Option<String>>,
    pub parent_key: Option<String>,
    pub parent_ref: Option<String>,
    pub depends_on: Vec<String>,
    pub depends_on_refs: Vec<String>,
    pub discovered_from: Option<String>,
    pub discovered_from_ref: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub kind: Option<String>,
    pub priority: Option<String>,
    /// 省略时 READY（R11 P1-5）。公开入口只接受 BACKLOG / READY（00 C-17）。
    pub status: Option<Status>,
    pub acceptance: Vec<String>,
    pub checklist: Vec<NewChecklist>,
    pub weight: Option<f64>,
    pub target_date: Option<String>,
    pub verification_required: bool,
    pub assignee_agent_id: Option<String>,
}

/// 服务内部的创建（quick 晋升、导入）：可以直接落到目标状态，并在事件里写明来源（00 C-17）。
#[derive(Clone, Debug, Default)]
pub(crate) struct Internal {
    pub source: &'static str,
    pub source_quick_id: Option<String>,
}

pub const MAX_BATCH: usize = 50;
const TYPES: [&str; 6] = ["EPIC", "TASK", "SUBTASK", "BUG", "RESEARCH", "REVIEW"];
const PRIORITIES: [&str; 4] = ["LOW", "NORMAL", "HIGH", "CRITICAL"];

fn upper_enum(
    field: &str,
    value: Option<&str>,
    default: &'static str,
    allowed: &[&str],
) -> Result<String, DomainError> {
    let Some(v) = value else {
        return Ok(default.to_owned());
    };
    // R11 P1-4：枚举不区分大小写。
    let upper = js_trim(v).to_uppercase();
    if allowed.contains(&upper.as_str()) {
        Ok(upper)
    } else {
        Err(
            invalid_argument(field, format!("{field} 只能是 {}", allowed.join(" / ")))
                .detail("got", v),
        )
    }
}

fn check_weight(field: &str, w: Option<f64>) -> Result<f64, DomainError> {
    let w = w.unwrap_or(1.0);
    if w.is_finite() && w > 0.0 && w <= 1000.0 {
        Ok(w)
    } else {
        Err(invalid_argument(field, format!("{field} 必须在 (0, 1000] 之间")).detail("got", w))
    }
}

/// 不碰存储的入参校验。
pub(crate) fn validate(items: &[CreateItem], internal_create: bool) -> Result<(), DomainError> {
    if items.is_empty() || items.len() > MAX_BATCH {
        return Err(
            invalid_argument("items", format!("items 必须是 1 至 {MAX_BATCH} 条"))
                .detail("actual", items.len()),
        );
    }
    for (index, item) in items.iter().enumerate() {
        validate_item(item, internal_create).map_err(|e| e.detail("item_index", index))?;
    }
    Ok(())
}

fn validate_item(item: &CreateItem, internal_create: bool) -> Result<(), DomainError> {
    let title = js_trim(&item.title);
    if title.is_empty() || utf16_len(title) > 400 {
        return Err(invalid_argument(
            "title",
            "title 去掉首尾空白后必须是 1 至 400 个字符",
        ));
    }
    if let Some(r) = &item.client_ref {
        let r = js_trim(r);
        if r.is_empty() || utf16_len(r) > 100 {
            return Err(invalid_argument(
                "client_ref",
                "client_ref 必须是 1 至 100 个字符",
            ));
        }
    }
    if item
        .description
        .as_deref()
        .is_some_and(|d| utf16_len(d) > 50_000)
    {
        return Err(invalid_argument(
            "description",
            "description 最多 50000 个字符",
        ));
    }
    check_acceptance(&item.acceptance)?;
    if item.checklist.len() > 100 {
        return Err(invalid_argument("checklist", "checklist 最多 100 项"));
    }
    for c in &item.checklist {
        let t = js_trim(&c.title);
        if t.is_empty() || utf16_len(t) > 400 {
            return Err(invalid_argument(
                "checklist.title",
                "检查项标题必须是 1 至 400 个字符",
            ));
        }
        check_weight("checklist.weight", c.weight)?;
    }
    check_weight("weight", item.weight)?;
    if let Some(d) = &item.target_date {
        check_date("target_date", d)?;
    }
    if item.depends_on.len() > 50 || item.depends_on_refs.len() > 50 {
        return Err(invalid_argument(
            "depends_on",
            "depends_on 与 depends_on_refs 各最多 50 项",
        ));
    }
    if item.parent_key.is_some() && item.parent_ref.is_some() {
        return Err(
            validation("parent_ref", "parent_key 与 parent_ref 只能给一个")
                .detail("issue", "mutually_exclusive"),
        );
    }
    if item.discovered_from.is_some() && item.discovered_from_ref.is_some() {
        return Err(validation(
            "discovered_from_ref",
            "discovered_from 与 discovered_from_ref 只能给一个",
        )
        .detail("issue", "mutually_exclusive"));
    }
    if let Some(a) = &item.assignee_agent_id {
        let a = js_trim(a);
        if a.is_empty() || utf16_len(a) > 128 {
            return Err(invalid_argument(
                "assignee_agent_id",
                "assignee_agent_id 必须是 1 至 128 个字符",
            ));
        }
    }
    upper_enum("type", item.kind.as_deref(), "TASK", &TYPES)?;
    upper_enum("priority", item.priority.as_deref(), "NORMAL", &PRIORITIES)?;
    if !internal_create && let Err(status) = public_create_state(item.status) {
        return Err(invalid_argument(
            "status",
            format!(
                "新建任务只能是 BACKLOG 或 READY（{} 要靠后续操作达到）",
                status.as_str()
            ),
        )
        .detail("allowed", json!(["BACKLOG", "READY"]))
        .detail("got", status.as_str()));
    }
    Ok(())
}

/// 校验完成、尚未写入的一条。
struct Planned {
    id: String,
    client_ref: String,
    objective_id: String,
    milestone_id: Option<String>,
    parent_id: Option<String>,
    deps: Vec<String>,
    discovered_from: Option<String>,
    state: WorkState,
}

/// 规划根（W-071）：需要时才建的 objective / milestone。
#[derive(Default)]
struct Root {
    objective: Option<(String, bool)>,
    milestone: Option<(String, bool)>,
}

pub(crate) fn run(
    w: &mut Work<'_>,
    items: &[CreateItem],
    internal_create: Option<&Internal>,
) -> Result<Value, DomainError> {
    // W-070：client_ref 批内精确唯一（区分大小写）。
    let refs: Vec<String> = items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            item.client_ref
                .as_deref()
                .map_or_else(|| (i + 1).to_string(), |r| js_trim(r).to_owned())
        })
        .collect();
    let mut seen = HashSet::new();
    for r in &refs {
        if !seen.insert(r.as_str()) {
            return Err(
                validation("client_ref", format!("client_ref {r} 在批内重复了"))
                    .detail("issue", "duplicate"),
            );
        }
    }

    // W-071：规划根只给 Agent 入口与服务内部的创建；User / System 缺 objective 直接报错。
    // 服务内部的创建（quick 晋升）也补建：目标项目可能是刚建的，还没有规划。
    // Phone 也补建：2.x 的手机建任务在项目没有 ACTIVE 目标时走 `ensurePlanningRoot`（新项目头一个任务多半
    // 就是从手机发来的，sync/commands.ts）。3.0 把补建放进建任务的同一个事务（2.x 是先补建、再建任务两步）。
    // 手机的目标也在这里挑（按创建顺序第一个 ACTIVE，与 2.x 和桌面「新建任务」同一规则），atm-sync 不传
    // objective_id：挑出来的目标不进请求，同一条命令重做时指纹不变，回放的是第一次的结果——不然第一次补建
    // 之后，重做时就成了「带着刚补建的目标」的另一个请求（IDEMPOTENCY_CONFLICT）。
    let provision = matches!(w.actor().kind, PrincipalKind::Agent | PrincipalKind::Phone)
        || internal_create.is_some();
    let need_root = items.iter().any(|i| i.objective_id.is_none());
    if need_root && !provision {
        let index = items
            .iter()
            .position(|i| i.objective_id.is_none())
            .unwrap_or(0);
        return Err(DomainError::new(
            ErrorCode::OBJECTIVE_REQUIRED,
            "这条任务没有指定 objective_id",
        )
        .detail("item_index", index)
        .detail("client_ref", refs[index].as_str()));
    }
    let mut root = Root::default();
    if need_root {
        let existing = if w.actor().kind == PrincipalKind::Phone {
            first_active_objective(w)?
        } else {
            latest_active_objective(w)?
        };
        root.objective = Some(match existing {
            Some(id) => (id, false),
            None => (w.ulid()?, true),
        });
    }

    // 先给每条分配内部 id，再解析引用（允许向前引用，W-073、W-074）。
    let mut ids = Vec::with_capacity(items.len());
    for _ in items {
        ids.push(w.ulid()?);
    }
    let by_ref: HashMap<&str, usize> = refs
        .iter()
        .enumerate()
        .map(|(i, r)| (r.as_str(), i))
        .collect();
    let mut planned = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let p = plan(
            w,
            item,
            index,
            &refs,
            &ids,
            &by_ref,
            &mut root,
            internal_create.is_some(),
        )
        .map_err(|e| {
            e.detail("item_index", index)
                .detail("client_ref", refs[index].as_str())
        })?;
        planned.push(p);
    }

    // W-076：整图校验，与批内顺序无关。
    let mut parents = parent_map(w)?;
    let mut prereqs = prereq_map(w)?;
    for p in &planned {
        if let Some(parent) = &p.parent_id {
            parents.insert(p.id.clone(), parent.clone());
        }
        if !p.deps.is_empty() {
            prereqs.insert(p.id.clone(), p.deps.clone());
        }
    }
    let label = |w: &Work<'_>, id: &str| -> Result<String, DomainError> {
        if let Some(i) = planned.iter().position(|p| p.id == id) {
            return Ok(format!("client_ref:{}", planned[i].client_ref));
        }
        Ok(w.task_key(&w.load(id)?))
    };
    for p in &planned {
        if let Some(parent) = &p.parent_id
            && let Err(g) = graph::parent_ok(&p.id, parent, &parents)
        {
            return Err(hierarchy_error(g, &label(w, &p.id)?, &label(w, parent)?));
        }
        for dep in &p.deps {
            if let Err(g) = graph::dependency_ok(&p.id, dep, &prereqs) {
                return Err(dependency_cycle(g, &label(w, &p.id)?, &label(w, dep)?));
            }
        }
    }

    // ---- 写入（W-077）----
    let mut provisioned = false;
    if let Some((id, true)) = &root.objective {
        let name: String =
            w.tx.query_row(
                "SELECT name FROM projects WHERE id = ?1",
                [&w.project],
                |r| r.get(0),
            )
            .map_err(db)?;
        let no = w.next_number("objective")?;
        let title = format!("{name}（自动补建）");
        w.tx.execute(
            "INSERT INTO objectives (project_id, id, local_no, title, status, version, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'ACTIVE', 0, ?5, ?5)",
            params![w.project, id, no, title, w.now_iso],
        )
        .map_err(db)?;
        w.emit(
            "objective.created",
            "OBJECTIVE",
            id,
            &json!({ "id": id, "localNo": no, "title": title, "planningRoot": true }),
        )?;
        provisioned = true;
    }
    if let (Some((oid, _)), Some((mid, true))) = (&root.objective, &root.milestone) {
        let no = w.next_number("milestone")?;
        let sort: i64 = w
            .tx
            .query_row(
                "SELECT COALESCE(MAX(sort_key), 0) + 1000 FROM milestones WHERE project_id = ?1 AND objective_id = ?2",
                [&w.project, oid],
                |r| r.get(0),
            )
            .map_err(db)?;
        w.tx.execute(
            "INSERT INTO milestones (project_id, id, local_no, objective_id, title, status, sort_key, version, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, '执行', 'ACTIVE', ?5, 0, ?6, ?6)",
            params![w.project, mid, no, oid, sort, w.now_iso],
        )
        .map_err(db)?;
        w.emit("milestone.created", "MILESTONE", mid, &json!({ "id": mid, "objectiveId": oid, "localNo": no, "title": "执行", "planningRoot": true }))?;
        provisioned = true;
    }

    let actor = w.actor().clone();
    let mut keys = Vec::with_capacity(items.len());
    let mut checklist_ids: Vec<(String, Vec<String>)> = Vec::new();
    for (item, p) in items.iter().zip(&planned) {
        let no = w.next_number("work_item")?;
        let key = w.key(no);
        let state = p.state;
        let completed_at = (state.status() == Status::Done).then(|| w.now_iso.clone());
        let acceptance: Vec<String> = item
            .acceptance
            .iter()
            .map(|a| js_trim(a).to_owned())
            .collect();
        w.tx.execute(
            "INSERT INTO work_items (project_id, id, local_no, objective_id, milestone_id, type, title, description,
                                     acceptance_json, status, phase, waiting_on, priority, sort_key,
                                     target_date, completed_at, assignee_agent_id, computed_progress, progress_source,
                                     weight, verification_required, version, created_by_agent_id, created_by_session_id,
                                     created_at, updated_at, source_quick_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, 0, 'NONE', ?18, ?19, 1,
                     ?20, ?21, ?22, ?22, ?23)",
            params![
                w.project,
                p.id,
                no,
                p.objective_id,
                p.milestone_id,
                upper_enum("type", item.kind.as_deref(), "TASK", &TYPES)?,
                js_trim(&item.title),
                item.description.clone().unwrap_or_default(),
                serde_json::to_string(&acceptance).map_err(internal)?,
                state.status().as_str(),
                state.phase().as_str(),
                state.waiting_on().map(WaitingOn::as_str),
                upper_enum("priority", item.priority.as_deref(), "NORMAL", &PRIORITIES)?,
                no * 1000,
                item.target_date,
                completed_at,
                item.assignee_agent_id.as_deref().map(js_trim),
                check_weight("weight", item.weight)?,
                i64::from(item.verification_required),
                actor.id,
                actor.session,
                w.now_iso,
                internal_create.and_then(|i| i.source_quick_id.clone()),
            ],
        )
        .map_err(db)?;
        let mut ids = Vec::with_capacity(item.checklist.len());
        for c in &item.checklist {
            let id = w.ulid()?;
            w.tx.execute(
                "INSERT INTO checklist_items (project_id, id, work_item_id, title, kind, status, weight, evidence_required,
                                              evidence_json, version, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 'ACCEPTANCE', 'TODO', ?5, ?6, '[]', 0, ?7, ?7)",
                params![
                    w.project,
                    id,
                    p.id,
                    js_trim(&c.title),
                    check_weight("checklist.weight", c.weight)?,
                    i64::from(c.evidence_required),
                    w.now_iso
                ],
            )
            .map_err(db)?;
            ids.push(id);
        }
        if !ids.is_empty() {
            checklist_ids.push((key.clone(), ids));
        }
        w.mark_fresh(&p.id);
        keys.push(key);
    }
    for p in &planned {
        if let Some(parent) = &p.parent_id {
            w.tx.execute(
                "UPDATE work_items SET parent_id = ?3 WHERE project_id = ?1 AND id = ?2",
                params![w.project, p.id, parent],
            )
            .map_err(db)?;
        }
    }
    for p in &planned {
        for dep in &p.deps {
            w.tx.execute(
                "INSERT INTO work_item_relations (project_id, source_id, target_id, relation_type, created_at)
                 VALUES (?1, ?2, ?3, 'BLOCKS', ?4)",
                params![w.project, dep, p.id, w.now_iso],
            )
            .map_err(db)?;
        }
    }
    for p in &planned {
        if let Some(origin) = &p.discovered_from {
            w.tx.execute(
                "INSERT INTO work_item_relations (project_id, source_id, target_id, relation_type, created_at)
                 VALUES (?1, ?2, ?3, 'DISCOVERED_FROM', ?4)",
                params![w.project, p.id, origin, w.now_iso],
            )
            .map_err(db)?;
            w.refresh_search(origin);
        }
    }
    for p in &planned {
        w.refresh_search(&p.id);
        w.recompute_from(&p.id);
    }
    // 事件按输入顺序（W-077）。
    for ((p, key), item) in planned.iter().zip(&keys).zip(items) {
        let mut payload = json!({ "key": key, "title": js_trim(&item.title), "status": p.state.status().as_str() });
        if let Some(origin) = &p.discovered_from {
            payload["discoveredFrom"] = json!(w.task_key(&w.load(origin)?));
        }
        if let Some(i) = internal_create {
            payload["source"] = json!(i.source);
        }
        w.emit("work.created", "WORK_ITEM", &p.id, &payload)?;
    }
    w.finish()?;

    // 2.0 的回执 items 是 hydrated 的任务（与界面列表同形，06 T-COMPAT）。
    let views = planned
        .iter()
        .map(|p| crate::ui::hydrated(w.tx, &w.project, &w.code, &p.id))
        .collect::<Result<Vec<_>, _>>()?;
    let refs_map: serde_json::Map<String, Value> = refs
        .iter()
        .zip(&keys)
        .map(|(r, k)| (r.clone(), json!(k)))
        .collect();
    let checklist_map: serde_json::Map<String, Value> = checklist_ids
        .into_iter()
        .map(|(k, ids)| (k, json!(ids)))
        .collect();
    Ok(json!({
        "items": views,
        "sequence": w.sequence,
        "planningRootProvisioned": provisioned,
        "refs": refs_map,
        "checklist": checklist_map,
    }))
}

/// 手机建任务的目标：按创建顺序第一个 ACTIVE（`ui_objectives` 的顺序）。
fn first_active_objective(w: &Work<'_>) -> Result<Option<String>, DomainError> {
    w.tx.query_row(
        "SELECT id FROM objectives WHERE project_id = ?1 AND status = 'ACTIVE' ORDER BY created_at, id LIMIT 1",
        [&w.project],
        |r| r.get(0),
    )
    .optional()
    .map_err(db)
}

fn latest_active_objective(w: &Work<'_>) -> Result<Option<String>, DomainError> {
    w.tx.query_row(
        "SELECT id FROM objectives WHERE project_id = ?1 AND status = 'ACTIVE' ORDER BY updated_at DESC, id DESC LIMIT 1",
        [&w.project],
        |r| r.get(0),
    )
    .optional()
    .map_err(db)
}

#[allow(clippy::too_many_arguments)]
fn plan(
    w: &mut Work<'_>,
    item: &CreateItem,
    index: usize,
    refs: &[String],
    ids: &[String],
    by_ref: &HashMap<&str, usize>,
    root: &mut Root,
    internal_create: bool,
) -> Result<Planned, DomainError> {
    // objective / milestone（W-072、00 C-18）。
    let (objective_id, milestone_id) = match &item.objective_id {
        Some(o) => {
            let o = js_trim(o).to_owned();
            let status: Option<String> =
                w.tx.query_row(
                    "SELECT status FROM objectives WHERE project_id = ?1 AND id = ?2",
                    [&w.project, &o],
                    |r| r.get(0),
                )
                .optional()
                .map_err(db)?;
            let Some(status) = status else {
                return Err(DomainError::new(
                    ErrorCode::OBJECTIVE_NOT_FOUND,
                    format!("objective {o} 不存在"),
                )
                .detail("objective_id", o.as_str()));
            };
            closed_target("objective", &o, &status)?;
            let milestone = match &item.milestone_id {
                Some(m) => m.clone(),
                // 没给 milestone：有规划根的入口取该 objective 下排序最前的 ACTIVE milestone。
                None if w.actor().kind == PrincipalKind::Agent => first_active_milestone(w, &o)?,
                None => None,
            };
            (o, milestone)
        }
        None => {
            let (oid, _) = root
                .objective
                .clone()
                .ok_or_else(|| internal("planning root missing"))?;
            let milestone = match &item.milestone_id {
                Some(m) => m.clone(),
                // 手机（2.x sync/commands.ts）：任务只带 objectiveId，不挂 milestone；项目原本没有目标时
                // `ensurePlanningRoot` 连「执行」这个 milestone 一起补建，只是任务不挂上去。
                None if w.actor().kind == PrincipalKind::Phone => {
                    if root.milestone.is_none()
                        && root.objective.as_ref().is_some_and(|(_, new)| *new)
                    {
                        root.milestone = Some((w.ulid()?, true));
                    }
                    None
                }
                None => {
                    if root.milestone.is_none() {
                        let found = if root.objective.as_ref().is_some_and(|(_, new)| *new) {
                            None
                        } else {
                            first_active_milestone(w, &oid)?
                        };
                        root.milestone = Some(match found {
                            Some(m) => (m, false),
                            None => (w.ulid()?, true),
                        });
                    }
                    root.milestone.as_ref().map(|(m, _)| m.clone())
                }
            };
            (oid, milestone)
        }
    };
    if let Some(m) = &milestone_id {
        let is_planned = root
            .milestone
            .as_ref()
            .is_some_and(|(id, new)| id == m && *new);
        if !is_planned {
            let row: Option<(String, String)> =
                w.tx.query_row(
                    "SELECT objective_id, status FROM milestones WHERE project_id = ?1 AND id = ?2",
                    [&w.project, m],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(db)?;
            let Some((actual, status)) = row else {
                return Err(DomainError::new(
                    ErrorCode::MILESTONE_NOT_FOUND,
                    format!("milestone {m} 不存在"),
                )
                .detail("milestone_id", m.as_str()));
            };
            if actual != objective_id {
                return Err(DomainError::new(
                    ErrorCode::MILESTONE_OBJECTIVE_MISMATCH,
                    format!("milestone {m} 不属于 objective {objective_id}"),
                )
                .detail("milestone_id", m.as_str())
                .detail("objective_id", objective_id.as_str())
                .detail("actual_objective_id", actual));
            }
            closed_target("milestone", m, &status)?;
        }
    }

    // 父（W-073）。
    let parent_id = match (&item.parent_key, &item.parent_ref) {
        (Some(k), _) => Some(
            w.load_by_key(k)
                .map_err(|e| e.detail("field", "parent_key"))?
                .id,
        ),
        (None, Some(r)) => match by_ref.get(js_trim(r)) {
            Some(&i) => Some(ids[i].clone()),
            None => {
                return Err(DomainError::new(
                    ErrorCode::PARENT_REF_NOT_FOUND,
                    format!("批内没有 client_ref {r}"),
                )
                .detail("parent_ref", r.as_str()));
            }
        },
        (None, None) => None,
    };

    // 依赖（W-074）：两种写法合并后按内部 id 判重。
    let mut deps: Vec<String> = Vec::new();
    for k in &item.depends_on {
        let id = w
            .load_by_key(k)
            .map_err(|e| e.detail("field", "depends_on"))?
            .id;
        if deps.contains(&id) {
            return Err(validation("depends_on", "依赖里同一个任务出现了两次")
                .detail("issue", "duplicate")
                .detail("reference", k.as_str()));
        }
        deps.push(id);
    }
    for r in &item.depends_on_refs {
        let Some(&i) = by_ref.get(js_trim(r)) else {
            return Err(DomainError::new(
                ErrorCode::DEPENDENCY_REF_NOT_FOUND,
                format!("批内没有 client_ref {r}"),
            )
            .detail("depends_on_ref", r.as_str()));
        };
        if deps.contains(&ids[i]) {
            return Err(validation("depends_on_refs", "依赖里同一个任务出现了两次")
                .detail("issue", "duplicate")
                .detail("reference", r.as_str()));
        }
        deps.push(ids[i].clone());
    }

    // 发现来源（W-075）。
    let discovered_from = match (&item.discovered_from, &item.discovered_from_ref) {
        (Some(k), _) => Some(
            w.load_by_key(k)
                .map_err(|e| e.detail("field", "discovered_from"))?
                .id,
        ),
        (None, Some(r)) => match by_ref.get(js_trim(r)) {
            Some(&i) if i == index => {
                return Err(
                    validation("discovered_from_ref", "discovered_from_ref 不能指向自己")
                        .detail("issue", "self_reference"),
                );
            }
            Some(&i) => Some(ids[i].clone()),
            None => {
                return Err(DomainError::new(
                    ErrorCode::DISCOVERED_FROM_REF_NOT_FOUND,
                    format!("批内没有 client_ref {r}"),
                )
                .detail("discovered_from_ref", r.as_str()));
            }
        },
        (None, None) => None,
    };

    // 初始状态（W-078、00 C-17、R11 P1-5）。
    let state = if internal_create {
        WorkState::from_status(item.status.unwrap_or(Status::Ready))
    } else {
        public_create_state(item.status)
            .map_err(|s| invalid_argument("status", format!("新建任务不能是 {}", s.as_str())))?
    };

    Ok(Planned {
        id: ids[index].clone(),
        client_ref: refs[index].clone(),
        objective_id,
        milestone_id,
        parent_id,
        deps,
        discovered_from,
        state,
    })
}

fn first_active_milestone(w: &Work<'_>, objective: &str) -> Result<Option<String>, DomainError> {
    w.tx.query_row(
        "SELECT id FROM milestones WHERE project_id = ?1 AND objective_id = ?2 AND status = 'ACTIVE'
         ORDER BY sort_key, id LIMIT 1",
        [&w.project, objective],
        |r| r.get(0),
    )
    .optional()
    .map_err(db)
}

/// 00 C-18：不能挂到终态的 objective / milestone 下。
pub(crate) fn closed_target(kind: &str, id: &str, status: &str) -> Result<(), DomainError> {
    if matches!(status, "DONE" | "CANCELLED") {
        return Err(DomainError::new(
            ErrorCode::PLANNING_TARGET_CLOSED,
            format!("{kind} {id} 已经是 {status}，不能再往下挂任务"),
        )
        .detail("entity", kind.to_uppercase())
        .detail("id", id)
        .detail("status", status));
    }
    Ok(())
}
