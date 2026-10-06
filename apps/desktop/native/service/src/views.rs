//! 保存视图（04 §4.2、L-016）：增删改只限 User，带版本；回执落在 GLOBAL（视图是全局实体，不随范围恢复回退）。

use crate::project::{db, dom_read_error, fixed_fp, invalid};
use crate::receipts::ReceiptScope;
use crate::write::{Rebind, Service, WriteRequest, Written};
use atm_domain::capability::{self, Capability};
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::principal::Principal;
use atm_domain::text::js_trim;
use atm_store::events as store_events;
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Value, json};

pub const CREATE_OPERATION: &str = "saved_view.create";
pub const UPDATE_OPERATION: &str = "saved_view.update";
pub const DELETE_OPERATION: &str = "saved_view.delete";

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SavedViewCreate {
    /// `GLOBAL` 或 `PROJECT`（精确匹配）。
    pub scope: String,
    pub project: Option<String>,
    pub name: String,
    /// 任意对象；省略为 `{}`。
    pub query: Option<Value>,
    pub sort: Option<Value>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SavedViewUpdate {
    /// 必须给（L-016）；缺了报 VALIDATION_ERROR。
    pub expected_version: Option<i64>,
    pub name: Option<String>,
    pub query: Option<Value>,
    pub sort: Option<Value>,
}

fn not_found(id: &str) -> DomainError {
    DomainError::new(ErrorCode::NOT_FOUND, format!("保存视图不存在：{id}"))
        .detail("entity", "SAVED_VIEW")
        .detail("reference", id)
}

fn name_required() -> DomainError {
    DomainError::new(ErrorCode::SAVED_VIEW_NAME_REQUIRED, "保存视图名称不能为空")
}

fn object(field: &str, value: Option<&Value>) -> Result<Option<Value>, DomainError> {
    match value {
        None => Ok(None),
        Some(v) if v.is_object() => Ok(Some(v.clone())),
        Some(_) => Err(invalid(field, format!("{field} 必须是对象"))),
    }
}

fn expected(v: Option<i64>) -> Result<i64, DomainError> {
    v.ok_or_else(|| invalid("expected_version", "改或删保存视图要带 expected_version"))
}

/// 2.x `listSavedViews` 的形状（camelCase，带 projectCode）。
fn view(tx: &Transaction<'_>, id: &str) -> Result<Option<Value>, DomainError> {
    tx.query_row(
        "SELECT v.id, v.scope, v.project_id, p.code, v.name, v.query_json, v.sort_json, v.version, v.created_at, v.updated_at
         FROM saved_views v LEFT JOIN projects p ON p.id = v.project_id WHERE v.id = ?1",
        [id],
        |r| {
            let parse = |s: String| serde_json::from_str::<Value>(&s).unwrap_or_else(|_| json!({}));
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "scope": r.get::<_, String>(1)?,
                "projectId": r.get::<_, Option<String>>(2)?,
                "projectCode": r.get::<_, Option<String>>(3)?,
                "name": r.get::<_, String>(4)?,
                "query": parse(r.get(5)?),
                "sort": parse(r.get(6)?),
                "version": r.get::<_, i64>(7)?,
                "createdAt": r.get::<_, String>(8)?,
                "updatedAt": r.get::<_, String>(9)?,
            }))
        },
    )
    .optional()
    .map_err(db)
}

fn current(tx: &Transaction<'_>, id: &str, expected: i64) -> Result<Value, DomainError> {
    let v = view(tx, id)?.ok_or_else(|| not_found(id))?;
    let actual = v["version"].as_i64().unwrap_or_default();
    if actual != expected {
        return Err(DomainError::new(
            ErrorCode::VERSION_CONFLICT,
            "保存视图版本已变化：重新读取后再改",
        )
        .detail("entity", "SAVED_VIEW")
        .detail("key", id)
        .detail("expected", expected)
        .detail("actual", actual));
    }
    Ok(v)
}

fn request(
    capability: Capability,
    operation: &'static str,
    op_id: &str,
    fp: Value,
) -> WriteRequest {
    WriteRequest {
        capability,
        operation,
        op_id: op_id.to_owned(),
        scope: ReceiptScope::global(),
        session: None,
        actor: None,
        expected_generation: None,
        fingerprint: fixed_fp(fp),
        compat_v1: None,
        replay_guard: None,
        prepare: None,
        rebind: Rebind::Create,
    }
}

impl Service {
    pub fn create_saved_view(
        &self,
        principal: &Principal,
        r: SavedViewCreate,
        op_id: &str,
    ) -> Result<Written, DomainError> {
        capability::require(principal, Capability::SavedViewManage)?;
        if r.scope != "GLOBAL" && r.scope != "PROJECT" {
            return Err(
                invalid("scope", "scope 只能是 GLOBAL 或 PROJECT").detail("got", r.scope.as_str())
            );
        }
        let project = if r.scope == "PROJECT" {
            match r.project.as_deref().map(js_trim).filter(|p| !p.is_empty()) {
                Some(p) => Some(self.project_scope(p)?),
                None => {
                    return Err(DomainError::new(
                        ErrorCode::PROJECT_REQUIRED,
                        "PROJECT 范围的保存视图要带 project",
                    )
                    .detail("field", "project"));
                }
            }
        } else {
            None
        };
        let name = js_trim(&r.name).to_owned();
        if name.is_empty() {
            return Err(name_required());
        }
        let query = object("query", r.query.as_ref())?.unwrap_or_else(|| json!({}));
        let sort = object("sort", r.sort.as_ref())?.unwrap_or_else(|| json!({}));
        let fp = json!({ "scope": r.scope, "project": project, "name": name, "query": query, "sort": sort });
        let scope = r.scope;
        self.write(
            principal,
            request(Capability::SavedViewManage, CREATE_OPERATION, op_id, fp),
            move |tx, ctx| {
                let id = store_events::ulid(tx).map_err(db)?;
                let at = ctx.now.to_string();
                tx.execute(
                    "INSERT INTO saved_views (id, scope, project_id, name, query_json, sort_json, version, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?7)",
                    params![id, scope, project, name, query.to_string(), sort.to_string(), at],
                )
                .map_err(db)?;
                event(tx, "saved_view.created", &id, &project, &at)?;
                Ok(json!({ "view": view(tx, &id)? }))
            },
        )
    }

    pub fn update_saved_view(
        &self,
        principal: &Principal,
        id: &str,
        r: SavedViewUpdate,
        op_id: &str,
    ) -> Result<Written, DomainError> {
        capability::require(principal, Capability::SavedViewManage)?;
        let expected = expected(r.expected_version)?;
        let name = match r.name.as_deref().map(js_trim) {
            Some("") => return Err(name_required()),
            other => other.map(str::to_owned),
        };
        let query = object("query", r.query.as_ref())?;
        let sort = object("sort", r.sort.as_ref())?;
        let id = js_trim(id).to_owned();
        let fp = json!({ "id": id, "expected_version": expected, "name": name, "query": query, "sort": sort });
        self.write(
            principal,
            request(Capability::SavedViewManage, UPDATE_OPERATION, op_id, fp),
            move |tx, ctx| {
                let cur = current(tx, &id, expected)?;
                let at = ctx.now.to_string();
                tx.execute(
                    "UPDATE saved_views SET name = ?2, query_json = ?3, sort_json = ?4, version = version + 1, updated_at = ?5
                     WHERE id = ?1",
                    params![
                        id,
                        name.unwrap_or_else(|| cur["name"].as_str().unwrap_or_default().to_owned()),
                        query.unwrap_or_else(|| cur["query"].clone()).to_string(),
                        sort.unwrap_or_else(|| cur["sort"].clone()).to_string(),
                        at
                    ],
                )
                .map_err(db)?;
                let project = cur["projectId"].as_str().map(str::to_owned);
                event(tx, "saved_view.updated", &id, &project, &at)?;
                Ok(json!({ "view": view(tx, &id)? }))
            },
        )
    }

    pub fn delete_saved_view(
        &self,
        principal: &Principal,
        id: &str,
        expected_version: Option<i64>,
        op_id: &str,
    ) -> Result<Written, DomainError> {
        capability::require(principal, Capability::SavedViewManage)?;
        let expected = expected(expected_version)?;
        let id = js_trim(id).to_owned();
        let fp = json!({ "id": id, "expected_version": expected });
        self.write(
            principal,
            request(Capability::SavedViewManage, DELETE_OPERATION, op_id, fp),
            move |tx, ctx| {
                let cur = current(tx, &id, expected)?;
                tx.execute("DELETE FROM saved_views WHERE id = ?1", [&id])
                    .map_err(db)?;
                let project = cur["projectId"].as_str().map(str::to_owned);
                event(
                    tx,
                    "saved_view.deleted",
                    &id,
                    &project,
                    &ctx.now.to_string(),
                )?;
                Ok(json!({ "ok": 1, "id": id }))
            },
        )
    }

    /// 列出保存视图（User；带 project 时只列这个项目的）。按更新时间倒序。
    pub fn list_saved_views(
        &self,
        principal: &Principal,
        project: Option<&str>,
    ) -> Result<Value, DomainError> {
        capability::require(principal, Capability::SavedViewRead)?;
        let project = match project {
            Some(p) => Some(self.project_scope(p)?),
            None => None,
        };
        self.store()
            .read(move |tx| {
                let ids: Vec<String> = {
                    let mut st = tx
                        .prepare(
                            "SELECT id FROM saved_views WHERE ?1 IS NULL OR project_id = ?1
                             ORDER BY updated_at DESC, id DESC",
                        )
                        .map_err(db)?;
                    st.query_map([&project], |r| r.get(0))
                        .map_err(db)?
                        .collect::<Result<_, _>>()
                        .map_err(db)?
                };
                let views = ids
                    .iter()
                    .map(|id| view(tx, id).map(Option::unwrap_or_default))
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(json!({ "views": views }))
            })
            .map_err(dom_read_error)
    }
}

fn event(
    tx: &Transaction<'_>,
    kind: &str,
    id: &str,
    project: &Option<String>,
    at: &str,
) -> Result<(), DomainError> {
    store_events::append_global(
        tx,
        kind,
        id,
        "USER",
        &json!({ "projectId": project }).to_string(),
        None,
        at,
    )
    .map(|_| ())
    .map_err(|e| crate::write::internal(format!("{e:?}")))
}
