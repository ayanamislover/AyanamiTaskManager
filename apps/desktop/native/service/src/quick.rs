//! 临时任务（quick task；04 §4.1、L-013～L-015；03 C-11～C-13；10 R5）。
//!
//! quick registry 是全局实体，不随任何范围恢复回退（10 A3 的 NONE 分支）：create / update 的回执落在 GLOBAL。
//! 晋升是原子的（C-L05）：建项目（不带目标时）、规划根、工作项与 PROMOTED 标记在一个写事务里，失败就什么都
//! 没留下。带目标时落点固定（EXISTING），走写入流水线；不带目标时落点由服务端决定（CREATE），走调用索引。
//! 目标项目里已有 `source_quick_id` 指向它的工作项时直接采用，不再新建（R5）。

use crate::fp::{self, JsValue};
use crate::project::{db, dom_read_error, fixed_fp, idempotency_conflict, invalid, write_error};
use crate::receipts::{self, CallKey, Candidate, NewReceipt, Rebuilt, ReceiptScope, Verdict};
use crate::work::{CreateItem, core::Work, create};
use crate::write::{
    Actor, Author, Family, Rebind, Service, WriteCtx, WriteRequest, Written, internal,
};
use atm_domain::capability::{self, Capability};
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::keys;
use atm_domain::principal::{Principal, PrincipalKind};
use atm_domain::text::{js_trim, utf16_len};
use atm_domain::time::Timestamp;
use atm_domain::work::Status;
use atm_store::events as store_events;
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Map, Value, json};

pub const CREATE_OPERATION: &str = "quick.create";
pub const UPDATE_OPERATION: &str = "quick.update";
pub const PROMOTE_OPERATION: &str = "quick.promote";

const STATUSES: [&str; 5] = ["OPEN", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"];

fn quick_not_found(reference: &str) -> DomainError {
    DomainError::new(ErrorCode::NOT_FOUND, format!("临时任务不存在：{reference}"))
        .detail("entity", "QUICK_TASK")
        .detail("reference", reference)
}

/// 2.x `quickTaskFromRow`（camelCase），加上 R5 的晋升核对：目标工作项的 id 对不上（被按范围恢复撤销了）时
/// `promotionUndone:true`。
pub(crate) fn view(tx: &Transaction<'_>, id: &str) -> Result<Value, DomainError> {
    let mut v = tx
        .query_row(
            "SELECT id, local_no, title, note, status, due_date, percent, latest_summary, source_cwd, version, updated_at,
                    promoted_project_id, promoted_work_item_key, promoted_work_item_id
             FROM quick_tasks WHERE id = ?1",
            [id],
            |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "key": keys::quick_key(r.get(1)?),
                    "title": r.get::<_, String>(2)?,
                    "note": r.get::<_, String>(3)?,
                    "status": r.get::<_, String>(4)?,
                    "dueDate": r.get::<_, Option<String>>(5)?,
                    "percent": r.get::<_, Option<i64>>(6)?,
                    "latestSummary": r.get::<_, Option<String>>(7)?,
                    "sourceCwd": r.get::<_, Option<String>>(8)?,
                    "version": r.get::<_, i64>(9)?,
                    "updatedAt": r.get::<_, String>(10)?,
                    "promotedProjectId": r.get::<_, Option<String>>(11)?,
                    "promotedWorkItemKey": r.get::<_, Option<String>>(12)?,
                    "promotedWorkItemId": r.get::<_, Option<String>>(13)?,
                }))
            },
        )
        .optional()
        .map_err(db)?
        .ok_or_else(|| quick_not_found(id))?;
    if let (Some(project), Some(item)) = (
        v["promotedProjectId"].as_str().map(str::to_owned),
        v["promotedWorkItemId"].as_str().map(str::to_owned),
    ) {
        let alive: bool = tx
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM work_items WHERE project_id = ?1 AND id = ?2)",
                params![project, item],
                |r| r.get(0),
            )
            .map_err(db)?;
        v["promotionUndone"] = json!(!alive);
    }
    Ok(v)
}

/// 按 Q 键或 id 找到 quick（不区分大小写与首尾空白）。
fn resolve(tx: &Transaction<'_>, reference: &str) -> Result<String, DomainError> {
    let r = js_trim(reference);
    let upper = r.to_ascii_uppercase();
    let by_key = upper
        .strip_prefix("Q-")
        .filter(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|d| d.parse::<i64>().ok());
    let id: Option<String> = match by_key {
        Some(no) => tx
            .query_row(
                "SELECT id FROM quick_tasks WHERE local_no = ?1",
                [no],
                |r| r.get(0),
            )
            .optional()
            .map_err(db)?,
        None => tx
            .query_row("SELECT id FROM quick_tasks WHERE id = ?1", [r], |r| {
                r.get(0)
            })
            .optional()
            .map_err(db)?,
    };
    id.ok_or_else(|| quick_not_found(reference))
}

/// 新建一条 OPEN 的 quick task（version 0）。编号全局递增。
pub(crate) fn create_tx(
    tx: &Transaction<'_>,
    title: &str,
    note: &str,
    due_date: Option<&str>,
    source_cwd: Option<&str>,
    actor: &str,
    at: &str,
) -> Result<Value, DomainError> {
    let local_no: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(local_no), 0) + 1 FROM quick_tasks",
            [],
            |r| r.get(0),
        )
        .map_err(db)?;
    let id = store_events::ulid(tx).map_err(db)?;
    tx.execute(
        "INSERT INTO quick_tasks (id, local_no, title, note, status, due_date, source_cwd, actor, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'OPEN', ?5, ?6, ?7, 0, ?8, ?8)",
        params![id, local_no, title, note, due_date, source_cwd, actor, at],
    )
    .map_err(db)?;
    store_events::append_global(
        tx,
        "quick.created",
        &id,
        actor,
        &json!({ "localNo": local_no, "title": title }).to_string(),
        None,
        at,
    )
    .map_err(|e| internal(format!("{e:?}")))?;
    view(tx, &id)
}

/// quick 的 actor（03 C-12）：User 恒为 `USER`；Agent 必须自报，去空白、不分大小写地拒绝 `USER`、`SYSTEM`、
/// `PHONE:*` 这类保留名（不能伪装成用户或系统）。
fn quick_actor(principal: &Principal, actor: Option<&str>) -> Result<String, DomainError> {
    match principal.kind() {
        PrincipalKind::Agent => {
            let a = actor.map(js_trim).unwrap_or_default();
            let upper = a.to_uppercase();
            if a.is_empty() || upper == "USER" || upper == "SYSTEM" || upper.starts_with("PHONE:") {
                return Err(DomainError::new(
                    ErrorCode::USER_AUTHORIZATION_REQUIRED,
                    "Agent 写 quick task 要带自己的 actor（agent_id），不能用 USER / SYSTEM / PHONE:* 这类保留名",
                )
                .detail("field", "actor")
                .detail("got", a));
            }
            if utf16_len(a) > 128 {
                return Err(invalid("actor", "actor 最多 128 个字符"));
            }
            Ok(a.to_owned())
        }
        _ => Ok("USER".to_owned()),
    }
}

fn check_date(field: &str, value: &str) -> Result<(), DomainError> {
    // Timestamp::parse 按固定位置校验，日期部分只能恰好是 YYYY-MM-DD。
    let ok = Timestamp::parse(&format!("{value}T00:00:00.000Z")).is_some();
    if ok {
        Ok(())
    } else {
        Err(invalid(field, format!("{field} 必须是 YYYY-MM-DD 格式的日期")).detail("got", value))
    }
}

fn check_title(title: &str) -> Result<String, DomainError> {
    let t = js_trim(title);
    if t.is_empty() || utf16_len(t) > 400 {
        return Err(invalid(
            "title",
            "title 去掉首尾空白后必须是 1 至 400 个字符",
        ));
    }
    Ok(t.to_owned())
}

fn check_note(note: &str) -> Result<(), DomainError> {
    if utf16_len(note) > 5000 {
        return Err(invalid("note", "note 最多 5000 个字符"));
    }
    Ok(())
}

fn version_conflict(key: &Value, expected: i64, actual: i64) -> DomainError {
    DomainError::new(
        ErrorCode::VERSION_CONFLICT,
        "临时任务版本已变化：重新读取后再改",
    )
    .detail("entity", "QUICK_TASK")
    .detail("key", key.clone())
    .detail("expected", expected)
    .detail("actual", actual)
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct QuickCreateRequest {
    pub title: String,
    pub note: Option<String>,
    pub due_date: Option<String>,
    pub source_cwd: Option<String>,
    /// 只对 Agent 有意义（C-12）；User 恒为 USER。
    pub actor: Option<String>,
}

/// quick.update 的字段（03 C-13：带 schema）。外层 None 表示不改。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct QuickUpdateRequest {
    pub expected_version: i64,
    pub status: Option<String>,
    pub title: Option<String>,
    pub note: Option<String>,
    pub due_date: Option<Option<String>>,
    pub percent: Option<Option<i64>>,
    pub summary: Option<String>,
    pub actor: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct QuickPromoteRequest {
    pub expected_version: i64,
    /// 省略时新建一个项目（名字取 quick 的标题）。
    pub target_project: Option<String>,
    pub actor: Option<String>,
    /// Agent 带的 session：调用索引的 principal id 取它的 agent_id，没给 actor 时也作为事件 actor（A3）。
    pub session: Option<String>,
    /// 桥 resolve 时判定的目标（A3 的 expected_target）。
    pub expected_target: Option<crate::ops::Target>,
}

/// 晋升的事务体：采用或新建工作项，标记 PROMOTED（C-L05、R5）。
fn promote_tx(
    tx: &Transaction<'_>,
    ctx: &WriteCtx,
    quick_id: &str,
    expected_version: i64,
) -> Result<Value, DomainError> {
    let project = ctx.scope.id.clone();
    let current = view(tx, quick_id)?;
    if current["status"] == "PROMOTED" {
        // 已经晋升：同一个目标幂等返回，别的目标冲突（L-015）。
        return if current["promotedProjectId"] == project.as_str() {
            Ok(json!({ "quick": current, "adopted": false, "alreadyPromoted": true }))
        } else {
            Err(DomainError::new(
                ErrorCode::IDEMPOTENCY_CONFLICT,
                "这条临时任务已经晋升到另一个项目",
            )
            .detail("entity", "QUICK_TASK")
            .detail("key", current["key"].clone())
            .detail("promoted_project_id", current["promotedProjectId"].clone()))
        };
    }
    let actual = current["version"].as_i64().unwrap_or_default();
    if actual != expected_version {
        return Err(version_conflict(&current["key"], expected_version, actual));
    }
    let existing: Option<(String, i64)> = tx
        .query_row(
            "SELECT id, local_no FROM work_items WHERE project_id = ?1 AND source_quick_id = ?2",
            params![project, quick_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(db)?;
    let mut w = Work::open(tx, ctx)?;
    let (item_id, item_key, adopted) = match existing {
        Some((id, no)) => (id, keys::task_key(&w.code, no), true),
        None => {
            let status = if current["status"] == "IN_PROGRESS" {
                Status::InProgress
            } else {
                Status::Ready
            };
            let note = current["note"].as_str().unwrap_or_default();
            let created = create::run(
                &mut w,
                &[CreateItem {
                    client_ref: Some("quick-root".into()),
                    title: current["title"].as_str().unwrap_or_default().to_owned(),
                    description: (!note.is_empty()).then(|| note.to_owned()),
                    status: Some(status),
                    ..CreateItem::default()
                }],
                Some(&create::Internal {
                    source: "quick.promote",
                    source_quick_id: Some(quick_id.to_owned()),
                }),
            )?;
            let key = created["items"][0]["key"]
                .as_str()
                .ok_or_else(|| internal("promote: created item has no key"))?
                .to_owned();
            let no = keys::parse_task_key(&w.code, &key)
                .ok_or_else(|| internal("promote: unparseable key"))?;
            let id: String = tx
                .query_row(
                    "SELECT id FROM work_items WHERE project_id = ?1 AND local_no = ?2",
                    params![project, no],
                    |r| r.get(0),
                )
                .map_err(db)?;
            (id, key, false)
        }
    };
    let at = ctx.now.to_string();
    tx.execute(
        "UPDATE quick_tasks SET status = 'PROMOTED', promoted_project_id = ?2, promoted_work_item_key = ?3,
                promoted_work_item_id = ?4, percent = 100, version = version + 1, completed_at = ?5, updated_at = ?5
         WHERE id = ?1",
        params![quick_id, project, item_key, item_id, at],
    )
    .map_err(db)?;
    store_events::append_global(
        tx,
        "quick.promoted",
        quick_id,
        &ctx.actor.id,
        &json!({ "projectId": project, "workItemKey": item_key, "adopted": adopted }).to_string(),
        None,
        &at,
    )
    .map_err(|e| internal(format!("{e:?}")))?;
    Ok(json!({ "quick": view(tx, quick_id)?, "adopted": adopted, "alreadyPromoted": false }))
}

impl Service {
    /// quick.create（04 §4.1；03 A15、C-12）。回执落在 GLOBAL。
    pub fn quick_create(
        &self,
        principal: &Principal,
        r: QuickCreateRequest,
        op_id: &str,
    ) -> Result<Written, DomainError> {
        capability::require(principal, Capability::QuickCreate)?;
        let actor = quick_actor(principal, r.actor.as_deref())?;
        let title = check_title(&r.title)?;
        let note = r.note.clone().unwrap_or_default();
        check_note(&note)?;
        if let Some(d) = &r.due_date {
            check_date("due_date", d)?;
        }
        let cwd = r
            .source_cwd
            .as_deref()
            .map(js_trim)
            .filter(|c| !c.is_empty())
            .map(str::to_owned);
        let fp_value =
            json!({ "title": title, "note": note, "due_date": r.due_date, "source_cwd": cwd });
        self.write(
            principal,
            WriteRequest {
                capability: Capability::QuickCreate,
                operation: CREATE_OPERATION,
                op_id: op_id.to_owned(),
                scope: ReceiptScope::global(),
                session: None,
                actor: Some(actor.clone()),
                expected_generation: None,
                fingerprint: fixed_fp(fp_value),
                compat_v1: None,
                replay_guard: None,
                prepare: None,
                rebind: Rebind::Create,
            },
            move |tx, ctx| {
                let at = ctx.now.to_string();
                let quick = create_tx(
                    tx,
                    &title,
                    &note,
                    r.due_date.as_deref(),
                    cwd.as_deref(),
                    &actor,
                    &at,
                )?;
                Ok(json!({ "quick": quick }))
            },
        )
    }

    /// quick.update（04 L-013；03 C-13）：带版本；status 不能是 PROMOTED，percent 在 0～100；没有可改字段时原样返回。
    pub fn quick_update(
        &self,
        principal: &Principal,
        quick: &str,
        r: QuickUpdateRequest,
        op_id: &str,
    ) -> Result<Written, DomainError> {
        capability::require(principal, Capability::QuickUpdate)?;
        let actor = quick_actor(principal, r.actor.as_deref())?;
        let status = match r.status.as_deref().map(|s| js_trim(s).to_uppercase()) {
            Some(s) if !STATUSES.contains(&s.as_str()) => {
                return Err(
                    invalid("status", format!("status 只能是 {}", STATUSES.join(" / ")))
                        .detail("got", s.as_str()),
                );
            }
            other => other,
        };
        let title = match &r.title {
            Some(t) => Some(check_title(t)?),
            None => None,
        };
        if let Some(n) = &r.note {
            check_note(n)?;
        }
        if let Some(Some(d)) = &r.due_date {
            check_date("due_date", d)?;
        }
        if let Some(Some(p)) = r.percent
            && !(0..=100).contains(&p)
        {
            return Err(invalid("percent", "percent 必须在 0～100 之间").detail("got", p));
        }
        let summary = r.summary.as_deref().map(js_trim).map(str::to_owned);
        if summary.as_deref().is_some_and(|s| utf16_len(s) > 500) {
            return Err(invalid("summary", "summary 最多 500 个字符"));
        }
        let reference = js_trim(quick).to_owned();
        let fp_value = json!({
            "quick": reference.to_ascii_uppercase(),
            "expected_version": r.expected_version,
            "status": status,
            "title": title,
            "note": r.note,
            "due_date": r.due_date,
            "percent": r.percent,
            "summary": summary,
        });
        self.write(
            principal,
            WriteRequest {
                capability: Capability::QuickUpdate,
                operation: UPDATE_OPERATION,
                op_id: op_id.to_owned(),
                scope: ReceiptScope::global(),
                session: None,
                actor: Some(actor.clone()),
                expected_generation: None,
                fingerprint: fixed_fp(fp_value),
                compat_v1: None,
                replay_guard: None,
                prepare: None,
                rebind: Rebind::Create,
            },
            move |tx, ctx| {
                let id = resolve(tx, &reference)?;
                let current = view(tx, &id)?;
                let actual = current["version"].as_i64().unwrap_or_default();
                if actual != r.expected_version {
                    return Err(version_conflict(&current["key"], r.expected_version, actual));
                }
                let at = ctx.now.to_string();
                let mut sets: Vec<&str> = Vec::new();
                let mut values: Vec<rusqlite::types::Value> = Vec::new();
                use rusqlite::types::Value as Sql;
                let text = |v: Option<String>| v.map_or(Sql::Null, Sql::Text);
                if let Some(s) = &status {
                    sets.push("status = ?");
                    values.push(Sql::Text(s.clone()));
                }
                if let Some(t) = &title {
                    sets.push("title = ?");
                    values.push(Sql::Text(t.clone()));
                }
                if let Some(n) = &r.note {
                    sets.push("note = ?");
                    values.push(Sql::Text(n.clone()));
                }
                if let Some(d) = &r.due_date {
                    sets.push("due_date = ?");
                    values.push(text(d.clone()));
                }
                if let Some(p) = r.percent {
                    sets.push("percent = ?");
                    values.push(p.map_or(Sql::Null, Sql::Integer));
                }
                if let Some(s) = &summary {
                    sets.push("latest_summary = ?");
                    values.push(Sql::Text(s.clone()));
                }
                if sets.is_empty() {
                    return Ok(json!({ "quick": current, "changed": false }));
                }
                sets.push("version = version + 1");
                sets.push("updated_at = ?");
                values.push(Sql::Text(at.clone()));
                if status.as_deref() == Some("DONE") {
                    sets.push("completed_at = ?");
                    values.push(Sql::Text(at.clone()));
                    sets.push("percent = 100");
                }
                values.push(Sql::Text(id.clone()));
                tx.execute(
                    &format!("UPDATE quick_tasks SET {} WHERE id = ?", sets.join(", ")),
                    rusqlite::params_from_iter(values),
                )
                .map_err(db)?;
                if let Some(s) = summary.as_deref().filter(|s| !s.is_empty()) {
                    let update_id = store_events::ulid(tx).map_err(db)?;
                    tx.execute(
                        "INSERT INTO quick_task_updates (id, quick_task_id, summary, percent, actor, created_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                        params![update_id, id, s, r.percent.flatten(), actor, at],
                    )
                    .map_err(db)?;
                }
                let after = view(tx, &id)?;
                store_events::append_global(
                    tx,
                    "quick.updated",
                    &id,
                    &actor,
                    &json!({ "status": after["status"] }).to_string(),
                    None,
                    &at,
                )
                .map_err(|e| internal(format!("{e:?}")))?;
                Ok(json!({ "quick": after, "changed": true }))
            },
        )
    }

    /// quick.promote（04 L-015；C-L05；10 A3、R5）。
    pub fn quick_promote(
        &self,
        principal: &Principal,
        quick: &str,
        r: QuickPromoteRequest,
        op_id: &str,
    ) -> Result<Written, DomainError> {
        capability::require(principal, Capability::QuickPromote)?;
        let reference = js_trim(quick).to_owned();
        let session = r
            .session
            .clone()
            .filter(|_| principal.kind() == PrincipalKind::Agent);
        let (quick_id, session_agent): (String, Option<String>) = {
            let reference = reference.clone();
            self.store()
                .read(move |tx| {
                    let agent = session
                        .as_deref()
                        .map(|s| crate::project::session_agent(tx, s))
                        .transpose()?;
                    Ok((resolve(tx, &reference)?, agent))
                })
                .map_err(dom_read_error)?
        };
        let actor = quick_actor(principal, r.actor.as_deref().or(session_agent.as_deref()))?;
        // 调用索引的主体：session 的 agent_id → actor（A3 的 principal 映射）。
        let principal_id = session_agent.clone().unwrap_or_else(|| actor.clone());
        if let Some(target) = r.target_project.as_deref() {
            // EXISTING(P)：落点固定，走写入流水线（垃圾箱目标由流水线拒绝）。
            let project = self.project_scope(target)?;
            // EXISTING(P) 的落点固定：上下文里的目标必须就是 P，世代交给 R4 屏障比较。
            let expected_generation = match &r.expected_target {
                Some(t) => crate::ops::fixed(t, &ReceiptScope::project(project.clone()))?,
                None => None,
            };
            let fp_value = json!({ "quick": quick_id, "target": project, "expected_version": r.expected_version });
            let expected = r.expected_version;
            return self.write(
                principal,
                WriteRequest {
                    capability: Capability::QuickPromote,
                    operation: PROMOTE_OPERATION,
                    op_id: op_id.to_owned(),
                    scope: ReceiptScope::project(project),
                    session: None,
                    actor: Some(actor),
                    expected_generation,
                    fingerprint: fixed_fp(fp_value),
                    compat_v1: None,
                    replay_guard: None,
                    prepare: None,
                    rebind: Rebind::Create,
                },
                move |tx, ctx| promote_tx(tx, ctx, &quick_id, expected),
            );
        }
        // CREATE：建项目、规划根、工作项与标记在一个事务里；调用索引让重试不会多建项目。
        let kind = principal.kind();
        let (call_kind, event_type) = if kind == PrincipalKind::Agent {
            ("AGENT", "AGENT")
        } else {
            ("USER", "USER")
        };
        let op_id = op_id.to_owned();
        let expected = r.expected_version;
        let expected_target = r.expected_target.clone();
        let now = self.clock();
        self.store()
            .write(move |tx| {
                let call = CallKey {
                    principal_kind: call_kind,
                    principal_id: if call_kind == "AGENT" {
                        principal_id.clone()
                    } else {
                        "USER".to_owned()
                    },
                    operation: PROMOTE_OPERATION.to_owned(),
                };
                let input = JsValue::from_json(
                    &json!({ "quick": quick_id, "target": null, "expected_version": expected }),
                );
                let rebuild = |c: &Candidate| match Family::parse(&c.fp_family) {
                    Some(Family::CanonV2) => Rebuilt::Fingerprint(fp::canon_v2(&input)),
                    _ => Rebuilt::NotComparable,
                };
                match receipts::find_call(tx, &call, &op_id, None, &rebuild).map_err(db)? {
                    Verdict::New => {}
                    Verdict::Replay(c) => {
                        return Ok(Written {
                            result: serde_json::from_str(&c.receipt_json).map_err(internal)?,
                            replayed: true,
                            receipt_id: c.receipt_id,
                            rebound_to: None,
                        });
                    }
                    Verdict::Undone { generation } => {
                        return Err(DomainError::new(
                            ErrorCode::OPERATION_UNDONE_BY_RESTORE,
                            "这次晋升已被一次按范围恢复撤销：先读当前状态，再决定是否用新的 op_id 重做",
                        )
                        .detail("op_id", op_id.as_str())
                        .detail("restored_generation", generation));
                    }
                    Verdict::Conflict { .. } => {
                        return Err(idempotency_conflict(&op_id, PROMOTE_OPERATION));
                    }
                }
                let current = view(tx, &quick_id)?;
                // 目标核对（A3）：resolve 判定的是 CREATE；这期间别人已经把它晋升到某个项目，就不接到那个项目上。
                if let Some(t) = &expected_target {
                    let now_target = match current["promotedProjectId"].as_str() {
                        Some(pid) if current["status"] == "PROMOTED" => {
                            let scope = ReceiptScope::project(pid);
                            let generation = crate::write::generation(tx, &scope).map_err(db)?;
                            crate::ops::Target::Existing { scope, generation }
                        }
                        _ => crate::ops::Target::Create,
                    };
                    t.check(&now_target)?;
                }
                // 已经晋升过（不论晋升到哪里）：不带目标的重试原样返回，不再建项目（L-015）。
                let (result, scope, generation) = if current["status"] == "PROMOTED" {
                    (
                        json!({ "quick": current, "adopted": false, "alreadyPromoted": true }),
                        ReceiptScope::global(),
                        None,
                    )
                } else {
                    // 版本由 promote_tx 核对；冲突时整个事务回滚，新项目也不留下。
                    let title = current["title"].as_str().unwrap_or_default().to_owned();
                    let spec = crate::project::spec(&crate::project::CreateProjectRequest {
                        description: current["note"].as_str().map(str::to_owned),
                        creation_reason: Some(format!(
                            "Quick Task {} 晋升",
                            current["key"].as_str().unwrap_or_default()
                        )),
                        signals: Map::from_iter([("sourceQuickTask".to_owned(), json!(quick_id))]),
                        ..crate::project::CreateProjectRequest::new(title)
                    })?;
                    let at = now.to_string();
                    let created = crate::project::create_tx(tx, &spec, &actor, &at)?;
                    let ctx = WriteCtx {
                        scope: ReceiptScope::project(created.id.clone()),
                        generation: Some(created.generation),
                        author: Author::default(),
                        actor: Actor {
                            kind,
                            event_type,
                            id: actor.clone(),
                            session: None,
                            lineage: Vec::new(),
                        },
                        op_id: op_id.clone(),
                        now,
                    };
                    let mut result = promote_tx(tx, &ctx, &quick_id, expected)?;
                    result["project"] = created.view(None)["project"].clone();
                    (
                        result,
                        ReceiptScope::project(created.id.clone()),
                        Some(created.generation),
                    )
                };
                let receipt_id = receipts::insert(
                    tx,
                    &NewReceipt {
                        scope: &scope,
                        ns: None,
                        call: Some(&call),
                        op_id: &op_id,
                        operation: PROMOTE_OPERATION,
                        fingerprint: &fp::canon_v2(&input),
                        receipt_json: &result.to_string(),
                        author_agent: (call_kind == "AGENT").then_some(principal_id.as_str()),
                        author_session: None,
                        actor_session_id: None,
                        scope_generation: generation,
                        created_at: &now.to_string(),
                    },
                )
                .map_err(db)?;
                Ok(Written {
                    result,
                    replayed: false,
                    receipt_id,
                    rebound_to: None,
                })
            })
            .map_err(write_error)
    }

    /// 读一条 quick（任何主体都可读）。
    pub fn quick_get(&self, principal: &Principal, quick: &str) -> Result<Value, DomainError> {
        capability::require(principal, Capability::QuickRead)?;
        let reference = quick.to_owned();
        self.store()
            .read(move |tx| {
                let id = resolve(tx, &reference)?;
                view(tx, &id)
            })
            .map_err(dom_read_error)
    }
}
