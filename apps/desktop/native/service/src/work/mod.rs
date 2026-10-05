//! 工作项服务（W2c）：批量创建与十二种基础操作。
//!
//! 入口都经 [`Service::write`]（能力检查 → 入队世代 → 同事务的幂等查找 → 动作 → 回执）。
//! operation 名沿用 2.x（`work.create.batch`、`work.patch.batch`），转换来的旧回执才能按 kernel-v1 比对。

mod core;
mod create;
mod graph;
mod patch;

pub use create::{CreateItem, NewChecklist};
pub use patch::{EditFields, ExpectedFields, PatchItem};

use crate::fp::JsValue;
use crate::receipts::ReceiptScope;
use crate::write::{Family, FpInput, Service, SessionRef, WriteRequest, Written};
use atm_domain::capability::Capability;
use atm_domain::error::DomainError;
use atm_domain::keys;
use atm_domain::principal::Principal;
use atm_domain::text::js_trim;
use atm_domain::work::Operation;
use serde_json::{Map, Value, json};

/// 写一个项目时都要带的部分。
#[derive(Clone, Debug)]
pub struct Target {
    pub project_id: String,
    /// Agent 的 session（属于这个项目）。User 不带。
    pub session: Option<String>,
    pub op_id: String,
    /// 调用上下文里带着的世代（R4）。
    pub expected_generation: Option<i64>,
}

impl Target {
    pub fn new(
        project_id: impl Into<String>,
        session: Option<&str>,
        op_id: impl Into<String>,
    ) -> Self {
        Target {
            project_id: project_id.into(),
            session: session.map(str::to_owned),
            op_id: op_id.into(),
            expected_generation: None,
        }
    }

    fn request(
        &self,
        capability: Capability,
        operation: &'static str,
        fingerprint: FpInput,
    ) -> WriteRequest {
        WriteRequest {
            capability,
            operation,
            op_id: self.op_id.clone(),
            scope: ReceiptScope::project(self.project_id.clone()),
            session: self.session.as_ref().map(|s| SessionRef {
                project_id: self.project_id.clone(),
                session_id: s.clone(),
            }),
            actor: None,
            expected_generation: self.expected_generation,
            fingerprint,
        }
    }
}

pub const CREATE_OPERATION: &str = "work.create.batch";
pub const PATCH_OPERATION: &str = "work.patch.batch";

impl Service {
    /// 批量创建（W-070～W-080）。公开入口：只能建成 BACKLOG / READY，默认 READY。
    pub fn create_work_items(
        &self,
        principal: &Principal,
        target: &Target,
        items: Vec<CreateItem>,
    ) -> Result<Written, DomainError> {
        create::validate(&items, false)?;
        let fp_items = items.clone();
        let fingerprint: FpInput = Box::new(move |family, _| create_fp(family, &fp_items));
        self.write(
            principal,
            target.request(Capability::WorkCreate, CREATE_OPERATION, fingerprint),
            move |tx, ctx| {
                let mut w = core::Work::open(tx, ctx)?;
                create::run(&mut w, &items, None)
            },
        )
    }

    /// 基础操作批次（W-041）。
    pub fn patch_work_items(
        &self,
        principal: &Principal,
        target: &Target,
        items: Vec<PatchItem>,
    ) -> Result<Written, DomainError> {
        patch::validate(&items)?;
        let fp_items = items.clone();
        let fingerprint: FpInput = Box::new(move |family, _| patch_fp(family, &fp_items));
        self.write(
            principal,
            target.request(Capability::WorkPatch, PATCH_OPERATION, fingerprint),
            move |tx, ctx| {
                let mut w = core::Work::open(tx, ctx)?;
                patch::run(&mut w, &items)
            },
        )
    }
}

// ---------- 指纹 ----------
//
// canon-v2 的输入是服务层规范化之后的业务字段（02 C-02：只规范化一次）：字符串去首尾空白、key 转大写（C-15）、
// 缺省值补齐。控制字段（op_id、expected_generation）与定位字段（project、session）不进指纹（R11 A3）。
//
// kernel-v1 按 2.x 命令层的 normalizedInput 重建（02 §3.4 的 `work.create.batch` / `work.patch.batch` 行）：
// zod 解析后的 camelCase 对象，只含 2.x 会出现的键。3.0 新增的语义（省略 expected_version、省略 client_ref、
// 省略 status 时默认 READY）在 2.x 里没有对应的请求，返回 None（与该候选不是同一请求，A3 可比性检查）。

fn s(v: &str) -> Value {
    Value::String(v.to_owned())
}

fn trim(v: &str) -> Value {
    s(js_trim(v))
}

fn key(v: &str) -> Value {
    Value::String(keys::normalize(v))
}

fn opt<T>(map: &mut Map<String, Value>, name: &str, value: Option<T>, f: impl FnOnce(T) -> Value) {
    if let Some(v) = value {
        map.insert(name.to_owned(), f(v));
    }
}

fn nullable(v: Option<&String>, f: impl FnOnce(&str) -> Value) -> Value {
    v.map_or(Value::Null, |x| f(x))
}

fn list(items: &[String], f: impl Fn(&str) -> Value) -> Value {
    Value::Array(items.iter().map(|x| f(x)).collect())
}

fn create_fp(family: Family, items: &[CreateItem]) -> Option<JsValue> {
    let value = match family {
        Family::CanonV2 => Value::Array(
            items
                .iter()
                .enumerate()
                .map(|(i, it)| create_v2(i, it))
                .collect(),
        ),
        Family::KernelV1 => Value::Array(items.iter().map(create_v1).collect::<Option<Vec<_>>>()?),
        Family::KnowledgeV1 => return None,
    };
    Some(JsValue::from_json(&value))
}

fn create_v2(index: usize, it: &CreateItem) -> Value {
    let mut m = Map::new();
    m.insert(
        "client_ref".into(),
        it.client_ref
            .as_deref()
            .map_or_else(|| s(&(index + 1).to_string()), trim),
    );
    opt(&mut m, "objective_id", it.objective_id.as_deref(), trim);
    opt(&mut m, "milestone_id", it.milestone_id.as_ref(), |v| {
        nullable(v.as_ref(), trim)
    });
    opt(&mut m, "parent_key", it.parent_key.as_deref(), key);
    opt(&mut m, "parent_ref", it.parent_ref.as_deref(), trim);
    m.insert("depends_on".into(), list(&it.depends_on, key));
    m.insert("depends_on_refs".into(), list(&it.depends_on_refs, trim));
    opt(
        &mut m,
        "discovered_from",
        it.discovered_from.as_deref(),
        key,
    );
    opt(
        &mut m,
        "discovered_from_ref",
        it.discovered_from_ref.as_deref(),
        trim,
    );
    m.insert("title".into(), trim(&it.title));
    m.insert(
        "description".into(),
        s(it.description.as_deref().unwrap_or("")),
    );
    m.insert(
        "type".into(),
        s(&it
            .kind
            .as_deref()
            .map_or("TASK".into(), |k| js_trim(k).to_uppercase())),
    );
    m.insert(
        "priority".into(),
        s(&it
            .priority
            .as_deref()
            .map_or("NORMAL".into(), |k| js_trim(k).to_uppercase())),
    );
    m.insert(
        "status".into(),
        s(it.status.map_or("READY", |st| st.as_str())),
    );
    m.insert("acceptance".into(), list(&it.acceptance, trim));
    m.insert(
        "checklist".into(),
        Value::Array(
            it.checklist
                .iter()
                .map(|c| json!({ "title": js_trim(&c.title), "evidence_required": c.evidence_required, "weight": c.weight.unwrap_or(1.0) }))
                .collect(),
        ),
    );
    m.insert("weight".into(), json!(it.weight.unwrap_or(1.0)));
    opt(&mut m, "target_date", it.target_date.as_deref(), s);
    m.insert(
        "verification_required".into(),
        json!(it.verification_required),
    );
    opt(
        &mut m,
        "assignee_agent_id",
        it.assignee_agent_id.as_deref(),
        trim,
    );
    Value::Object(m)
}

/// 2.x `WorkItemCreateInputSchema` 解析后的形状。
fn create_v1(it: &CreateItem) -> Option<Value> {
    let client_ref = it.client_ref.as_deref()?;
    let status = it.status?;
    let mut m = Map::new();
    m.insert("clientRef".into(), trim(client_ref));
    opt(&mut m, "objectiveId", it.objective_id.as_deref(), trim);
    opt(&mut m, "milestoneId", it.milestone_id.as_ref(), |v| {
        nullable(v.as_ref(), s)
    });
    opt(&mut m, "parentKey", it.parent_key.as_deref(), s);
    opt(&mut m, "parentRef", it.parent_ref.as_deref(), s);
    m.insert("dependsOn".into(), list(&it.depends_on, s));
    m.insert("dependsOnRefs".into(), list(&it.depends_on_refs, s));
    opt(
        &mut m,
        "discoveredFrom",
        it.discovered_from.as_deref(),
        trim,
    );
    opt(
        &mut m,
        "discoveredFromRef",
        it.discovered_from_ref.as_deref(),
        trim,
    );
    m.insert("title".into(), trim(&it.title));
    m.insert(
        "description".into(),
        s(it.description.as_deref().unwrap_or("")),
    );
    m.insert("type".into(), s(it.kind.as_deref().unwrap_or("TASK")));
    m.insert(
        "priority".into(),
        s(it.priority.as_deref().unwrap_or("NORMAL")),
    );
    m.insert("status".into(), s(status.as_str()));
    m.insert("acceptance".into(), list(&it.acceptance, trim));
    m.insert(
        "checklist".into(),
        Value::Array(
            it.checklist
                .iter()
                .map(|c| json!({ "title": js_trim(&c.title), "evidenceRequired": c.evidence_required, "weight": c.weight.unwrap_or(1.0) }))
                .collect(),
        ),
    );
    m.insert("weight".into(), json!(it.weight.unwrap_or(1.0)));
    opt(&mut m, "targetDate", it.target_date.as_deref(), s);
    m.insert(
        "verificationRequired".into(),
        json!(it.verification_required),
    );
    opt(
        &mut m,
        "assigneeAgentId",
        it.assignee_agent_id.as_deref(),
        trim,
    );
    Some(Value::Object(m))
}

fn patch_fp(family: Family, items: &[PatchItem]) -> Option<JsValue> {
    let value = match family {
        Family::CanonV2 => Value::Array(items.iter().map(patch_v2).collect()),
        Family::KernelV1 => Value::Array(items.iter().map(patch_v1).collect::<Option<Vec<_>>>()?),
        Family::KnowledgeV1 => return None,
    };
    Some(JsValue::from_json(&value))
}

fn patch_v2(it: &PatchItem) -> Value {
    let mut m = Map::new();
    m.insert("task_key".into(), key(&it.task_key));
    m.insert("operation".into(), s(it.operation.as_str()));
    // 业务 CAS 是业务字段（R11 A3）：带不带、带多少都进指纹。
    opt(&mut m, "expected_version", it.expected_version, |v| {
        json!(v)
    });
    m.insert("takeover_stale".into(), json!(it.takeover_stale));
    opt(&mut m, "blocked_reason", it.blocked_reason.as_deref(), trim);
    opt(&mut m, "waiting_for", it.waiting_for.as_deref(), trim);
    opt(&mut m, "cancel_reason", it.cancel_reason.as_deref(), trim);
    opt(&mut m, "duplicate_of", it.duplicate_of.as_ref(), |v| {
        nullable(v.as_ref(), key)
    });
    opt(&mut m, "superseded_by", it.superseded_by.as_ref(), |v| {
        nullable(v.as_ref(), key)
    });
    edit_fields(&mut m, &it.edit, true);
    if let Some(x) = &it.expected_fields {
        let mut e = Map::new();
        opt(&mut e, "title", x.title.as_deref(), trim);
        opt(&mut e, "description", x.description.as_deref(), s);
        opt(&mut e, "acceptance", x.acceptance.as_deref(), |a| {
            list(a, trim)
        });
        opt(&mut e, "target_date", x.target_date.as_ref(), |v| {
            nullable(v.as_ref(), s)
        });
        opt(&mut e, "parent_key", x.parent_key.as_ref(), |v| {
            nullable(v.as_ref(), key)
        });
        m.insert("expected_fields".into(), Value::Object(e));
    }
    Value::Object(m)
}

fn edit_fields(m: &mut Map<String, Value>, e: &EditFields, v2: bool) {
    let name = |snake: &'static str, camel: &'static str| if v2 { snake } else { camel };
    opt(m, name("title", "title"), e.title.as_deref(), trim);
    opt(
        m,
        name("description", "description"),
        e.description.as_deref(),
        s,
    );
    opt(
        m,
        name("acceptance", "acceptance"),
        e.acceptance.as_deref(),
        |a| list(a, trim),
    );
    opt(
        m,
        name("assignee_agent_id", "assigneeAgentId"),
        e.assignee_agent_id.as_ref(),
        |v| nullable(v.as_ref(), s),
    );
    opt(
        m,
        name("target_date", "targetDate"),
        e.target_date.as_ref(),
        |v| nullable(v.as_ref(), s),
    );
    opt(
        m,
        name("parent_key", "parentKey"),
        e.parent_key.as_ref(),
        |v| nullable(v.as_ref(), if v2 { key } else { s }),
    );
    opt(
        m,
        name("depends_on", "dependsOn"),
        e.depends_on.as_deref(),
        |a| list(a, if v2 { key } else { trim }),
    );
    opt(
        m,
        name("discovered_from", "discoveredFrom"),
        e.discovered_from.as_ref(),
        |v| nullable(v.as_ref(), if v2 { key } else { trim }),
    );
}

/// 2.x `CoreWorkItemPatchSchemas` 解析后的形状。
fn patch_v1(it: &PatchItem) -> Option<Value> {
    let expected = it.expected_version?;
    let mut m = Map::new();
    m.insert("taskKey".into(), trim(&it.task_key));
    m.insert("expectedVersion".into(), json!(expected));
    m.insert("takeoverStale".into(), json!(it.takeover_stale));
    m.insert("operation".into(), s(it.operation.as_str()));
    match it.operation {
        Operation::Block => opt(&mut m, "blockedReason", it.blocked_reason.as_deref(), trim),
        Operation::WaitAgent | Operation::WaitUser => {
            opt(&mut m, "waitingFor", it.waiting_for.as_deref(), trim);
        }
        Operation::Cancel => {
            opt(&mut m, "cancelReason", it.cancel_reason.as_deref(), trim);
            opt(&mut m, "duplicateOf", it.duplicate_of.as_ref(), |v| {
                nullable(v.as_ref(), trim)
            });
            opt(&mut m, "supersededBy", it.superseded_by.as_ref(), |v| {
                nullable(v.as_ref(), trim)
            });
        }
        Operation::Edit => {
            edit_fields(&mut m, &it.edit, false);
            if let Some(x) = &it.expected_fields {
                let mut e = Map::new();
                opt(&mut e, "title", x.title.as_deref(), trim);
                opt(&mut e, "description", x.description.as_deref(), s);
                opt(&mut e, "acceptance", x.acceptance.as_deref(), |a| {
                    list(a, trim)
                });
                opt(&mut e, "targetDate", x.target_date.as_ref(), |v| {
                    nullable(v.as_ref(), s)
                });
                opt(&mut e, "parentKey", x.parent_key.as_ref(), |v| {
                    nullable(v.as_ref(), trim)
                });
                m.insert("expectedFields".into(), Value::Object(e));
            }
        }
        _ => {}
    }
    Some(Value::Object(m))
}
