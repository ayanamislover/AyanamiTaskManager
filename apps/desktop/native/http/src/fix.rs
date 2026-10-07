//! 统一错误信封的出路（W4e；11 §3、§5 U-3 / U-4；R11 A3 的 `add_param`）。
//!
//! 每个错误码在 [`GENERATORS`] 里登记一个生成器。生成器读服务写在 `details` 里的线索
//! （`next`、`current_version`、`candidates`、`did_you_mean`、`reasons`……）和原调用的参数，给出：
//! - `call`：能原样执行的下一步（同一调用补上或换掉参数，或一步前置操作）；
//! - `reread`：先读，读的调用写好了；
//! - `ask_user`：只有用户能做的事，带转告文案；
//! - `wait`：稍后重试，带同一调用；
//! - `add_param`：缺一个只有调用方知道的值（例如 session），补上再调；
//! - `none`：只给 INTERNAL_ERROR 与 Agent 碰不到的码。
//!
//! 生成的调用一律过对应工具的 schema 校验；过不了就退回按目录默认种类给出的出路，并在 details 里记
//! `fix_degraded`（U-4 的动态检查以它为红）。任务相关的错误另附 `state`：当前版本、状态、领取者、
//! 是不是自己、合法操作。

use crate::schema::Tool;
use crate::tools;
use crate::write::client_name;
use atm_domain::error::{Committed, DomainError, Envelope, ErrorCode, Fix, FixKind, ToolCall};
use atm_domain::principal::Principal;
use atm_domain::work::{Phase, WaitingOn, WorkState, legal_operations};
use atm_service::read::{TaskGetRequest, TaskView};
use atm_service::write::Service;
use serde_json::{Map, Value, json};

/// 生成出路时能用的上下文：出错的那次调用。
pub struct Ctx<'a> {
    pub svc: &'a Service,
    pub principal: &'a Principal,
    pub tool: &'static Tool,
    /// 校验、规范化之后的参数。
    pub args: &'a Map<String, Value>,
}

/// 一个生成器：给不出（或线索不够）时返回 None，由目录默认种类兜底。
pub type Gen = fn(&DomainError, &Ctx<'_>, Option<&Value>) -> Option<Fix>;

/// 带出路与状态的信封。
pub fn envelope(e: DomainError, committed: Committed, ctx: &Ctx<'_>) -> Envelope {
    let state = state(&e, ctx);
    let generated = generator(e.code).and_then(|g| g(&e, ctx, state.as_ref()));
    let (fix, degraded) = match generated {
        Some(fix) if valid(&fix) => (fix, false),
        Some(_) => (fallback(&e, ctx), true),
        None => (fallback(&e, ctx), false),
    };
    // 兜底本身也要过 schema；过不了只能什么都不给，并如实标出来。
    let (fix, degraded) = if valid(&fix) {
        (fix, degraded)
    } else {
        (Fix::None, true)
    };
    let mut e = e;
    if degraded {
        e = e.detail("fix_degraded", true);
    }
    Envelope::new(e, committed, state, fix)
}

/// 登记的生成器。
pub fn generator(code: ErrorCode) -> Option<Gen> {
    GENERATORS.iter().find(|(c, _)| *c == code).map(|(_, g)| *g)
}

/// fix 里的调用能不能通过对应工具的 schema（不需要任何更正）。没有调用的出路恒为真。
pub fn valid(fix: &Fix) -> bool {
    match fix {
        Fix::AddParam { tool, .. } => tools::find(tool).is_some(),
        _ => fix.call().is_none_or(call_is_valid),
    }
}

/// U-4 的动态检查（对一个已经序列化的信封）：有 `committed` 与 `fix.kind`；`none` 只给 INTERNAL_ERROR；
/// 没有退回兜底；fix 里的调用能通过对应工具的 schema。
pub fn check(envelope: &Value) -> Result<(), String> {
    let code = envelope["code"].as_str().unwrap_or_default();
    if !matches!(&envelope["committed"], Value::Bool(_)) && envelope["committed"] != "unknown" {
        return Err(format!("{code}: committed 缺失或不合法"));
    }
    let fix = &envelope["fix"];
    let kind = fix["kind"].as_str().unwrap_or_default();
    if !matches!(
        kind,
        "call" | "reread" | "ask_user" | "wait" | "add_param" | "none"
    ) {
        return Err(format!("{code}: fix.kind {kind:?}"));
    }
    if kind == "none" && code != "INTERNAL_ERROR" {
        return Err(format!("{code}: fix 是 none"));
    }
    if envelope["details"]["fix_degraded"] == true {
        return Err(format!("{code}: 生成的 fix 没通过 schema，退回了兜底"));
    }
    if kind == "add_param" && fix["param"].as_str().is_none_or(str::is_empty) {
        return Err(format!("{code}: add_param 没有 param"));
    }
    if let Some(call) = fix.get("call").filter(|c| !c.is_null()) {
        let name = call["name"].as_str().unwrap_or_default();
        let tool = tools::find(name).ok_or_else(|| format!("{code}: 没有工具 {name}"))?;
        tool.validate(&call["arguments"])
            .map_err(|r| format!("{code}: fix.call 过不了 {name} 的 schema：{:?}", r.problems))?;
    } else if matches!(kind, "call" | "reread") {
        return Err(format!("{code}: {kind} 没有 call"));
    }
    Ok(())
}

pub fn call_is_valid(call: &ToolCall) -> bool {
    tools::find(&call.name).is_some_and(|t| t.validate(&call.arguments).is_ok())
}

// ---- 上下文的取值 -----------------------------------------------------------------------------

impl Ctx<'_> {
    fn str(&self, k: &str) -> Option<String> {
        self.args.get(k).and_then(Value::as_str).map(str::to_owned)
    }

    fn session(&self) -> Option<String> {
        self.str("session")
    }

    /// 项目代码：显式给的，否则按 session 推出（推不出就没有）。
    fn project(&self) -> Option<String> {
        self.str("project").or_else(|| {
            let s = self.session()?;
            self.svc
                .session_scope(self.principal, &s)
                .ok()
                .map(|x| x.project)
        })
    }

    /// begin 要的 agent_id：begin 自己的参数、session 的 agent、连接组身份里的客户端名。
    fn agent_id(&self) -> Option<String> {
        self.str("agent_id")
            .or_else(|| {
                let s = self.session()?;
                self.svc
                    .session_scope(self.principal, &s)
                    .ok()
                    .map(|x| x.agent_id)
            })
            .or_else(|| {
                self.principal
                    .client_group()
                    .and_then(client_name)
                    .map(str::to_owned)
            })
    }

    /// 出错的任务：details 里点名的，否则单条调用的 task_key。
    fn task_key(&self, e: &DomainError) -> Option<String> {
        e.details
            .get("task_key")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| self.str("task_key"))
    }

    fn is(&self, name: &str) -> bool {
        self.tool.name == name
    }
}

/// 一个工具调用：补上调用方的 project 与 session（工具有这两个参数、调用里又没写时）。
fn call(ctx: &Ctx<'_>, name: &str, mut args: Map<String, Value>) -> ToolCall {
    if let Some(tool) = tools::find(name) {
        let has = |f: &str| tool.fields.iter().any(|x| x.name == f);
        if has("session")
            && !args.contains_key("session")
            && let Some(s) = ctx.session()
        {
            args.insert("session".into(), json!(s));
        }
        if has("project")
            && !args.contains_key("project")
            && name != "atm_begin"
            && let Some(p) = ctx.project()
        {
            args.insert("project".into(), json!(p));
        }
    }
    ToolCall {
        name: name.to_owned(),
        arguments: Value::Object(args),
    }
}

fn obj(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

/// 原调用，`f` 改过参数之后。
fn original(ctx: &Ctx<'_>, f: impl FnOnce(&mut Map<String, Value>)) -> ToolCall {
    let mut args = ctx.args.clone();
    f(&mut args);
    call(ctx, ctx.tool.name, args)
}

fn is_patch_operation(op: &str) -> bool {
    tools::OPERATIONS.contains(&op) || matches!(op, "checklist_single" | "checklist_batch")
}

/// task_patch 的一条：原调用里同一任务、同一操作的那条（单条顶层或 items 里），合并 `extra`；
/// 原调用里没有就单独一条。`op` 为 None 时沿用原调用里这个任务的操作。
fn patch(
    ctx: &Ctx<'_>,
    task_key: &str,
    op: Option<&str>,
    extra: &Map<String, Value>,
) -> Option<ToolCall> {
    // checklist 与旧名 checklist_single / checklist_batch 是同一个操作（11 §4 的合称）。
    let family = |o: &str| {
        if matches!(o, "checklist_single" | "checklist_batch") {
            "checklist".to_owned()
        } else {
            o.to_owned()
        }
    };
    let same = |m: &Map<String, Value>| {
        m.get("task_key").and_then(Value::as_str) == Some(task_key)
            && op.is_none_or(|op| {
                m.get("operation").and_then(Value::as_str).map(family) == Some(family(op))
            })
    };
    let merge = |m: &mut Map<String, Value>| {
        for (k, v) in extra {
            m.insert(k.clone(), v.clone());
        }
        // 换上检查项版本时，旧的逐条版本作废（否则还是那个过期值）。
        if extra.contains_key("expected_checklist_version")
            && let Some(Value::Array(list)) = m.get_mut("checklist")
        {
            for c in list.iter_mut().filter_map(Value::as_object_mut) {
                c.remove("expected_checklist_version");
            }
        }
    };
    if ctx.is("atm_task_patch") {
        let mut args = ctx.args.clone();
        if let Some(Value::Array(items)) = args.get_mut("items") {
            if let Some(m) = items
                .iter_mut()
                .filter_map(Value::as_object_mut)
                .find(|m| same(m))
            {
                merge(m);
                return Some(call(ctx, "atm_task_patch", args));
            }
        } else if same(&args) {
            merge(&mut args);
            return Some(call(ctx, "atm_task_patch", args));
        }
    }
    let op = op?;
    // 原调用里没有这条检查项改动：只有版本没有改动的 checklist 调用不能编（会把状态当成 TODO）。
    if family(op) == "checklist"
        && !extra.contains_key("checklist")
        && !extra.contains_key("status")
    {
        return None;
    }
    let mut args = Map::new();
    args.insert("task_key".into(), json!(task_key));
    args.insert("operation".into(), json!(op));
    merge(&mut args);
    Some(call(ctx, "atm_task_patch", args))
}

/// 服务写的 `details.next` → 工具调用。
fn next_call(e: &DomainError, ctx: &Ctx<'_>) -> Option<ToolCall> {
    let next = e.details.get("next")?.as_object()?;
    let mut rest = next.clone();
    let op = rest
        .remove("operation")
        .and_then(|v| v.as_str().map(str::to_owned));
    match op.as_deref() {
        Some("begin") => begin(ctx, rest),
        Some("task_list") => Some(call(ctx, "atm_task_list", rest)),
        Some("brief") => Some(call(ctx, "atm_brief", rest)),
        Some(op) if is_patch_operation(op) => {
            let key = rest
                .remove("task_key")
                .and_then(|v| v.as_str().map(str::to_owned))
                .or_else(|| ctx.task_key(e))?;
            patch(ctx, &key, Some(op), &rest)
        }
        // 没写 operation：沿用原调用里这个任务的操作（例如领取过期时加 takeover_stale 重发）。
        None => {
            let key = rest
                .remove("task_key")
                .and_then(|v| v.as_str().map(str::to_owned))
                .or_else(|| ctx.task_key(e))?;
            patch(ctx, &key, None, &rest)
        }
        Some(_) => None,
    }
}

/// begin：原调用就是 begin 时以它为底（cwd、role 等不丢），否则带上 agent_id 与项目。
/// 推不出 agent_id（begin 的必填项）时给不出，交给兜底。
fn begin(ctx: &Ctx<'_>, extra: Map<String, Value>) -> Option<ToolCall> {
    let mut args = if ctx.is("atm_begin") {
        ctx.args.clone()
    } else {
        let mut m = Map::new();
        if let Some(p) = ctx.project() {
            m.insert("project".into(), json!(p));
        }
        m
    };
    // 接回与新建后继互斥（A1）；建议的那一个说了算。
    if extra.contains_key("predecessor_session_id") {
        args.remove("session");
    }
    if extra.contains_key("session") {
        args.remove("predecessor_session_id");
    }
    for (k, v) in extra {
        args.insert(k, v);
    }
    if !args.contains_key("agent_id") {
        args.insert("agent_id".into(), json!(ctx.agent_id()?));
    }
    Some(ToolCall {
        name: "atm_begin".into(),
        arguments: Value::Object(args),
    })
}

// ---- state -----------------------------------------------------------------------------------

/// 这些码的出路要看任务现在的样子（11 §3 的 `state`）。
const TASK_STATE: &[ErrorCode] = &[
    ErrorCode::VERSION_CONFLICT,
    ErrorCode::EXPECTED_VERSION_REQUIRED,
    ErrorCode::INVALID_TRANSITION,
    ErrorCode::COMPLETION_GATE_FAILED,
    ErrorCode::CLAIM_NOT_OWNED,
    ErrorCode::TASK_ALREADY_CLAIMED,
    ErrorCode::CLAIM_OWNER_REQUIRED,
    ErrorCode::WORK_ITEM_TERMINAL,
    ErrorCode::DEPENDENCY_NOT_READY,
];

fn state(e: &DomainError, ctx: &Ctx<'_>) -> Option<Value> {
    if !TASK_STATE.contains(&e.code) {
        return None;
    }
    // 检查项与知识的版本冲突不是任务状态。
    if e.details.get("entity").and_then(Value::as_str) == Some("CHECKLIST") {
        return None;
    }
    let key = ctx.task_key(e)?;
    let project = ctx.project()?;
    let mut r = TaskGetRequest::new(key.clone());
    r.view = TaskView::Context;
    let t = ctx.svc.task_get(ctx.principal, &project, &r).ok()?;
    let phase = t["phase"].as_str().and_then(Phase::parse);
    let waiting = t["waiting_on"].as_str().and_then(WaitingOn::parse);
    let legal: Vec<Value> = match e.details.get("legal_operations") {
        Some(Value::Array(list)) => list.clone(),
        _ => phase
            .and_then(|p| WorkState::new(p, waiting))
            .map(|s| {
                legal_operations(s)
                    .into_iter()
                    .map(|(op, _)| json!(op.as_str()))
                    .collect()
            })
            .unwrap_or_default(),
    };
    let holder = t["claimed_by_session_id"].as_str();
    let claimed_by = holder.map(|s| {
        json!({
            "session": s,
            "lease_until": t["claim_lease_until"],
            "mine": ctx.session().as_deref() == Some(s),
        })
    });
    Some(json!({
        "task_key": key,
        "version": t["version"],
        "status": t["status"],
        "waiting_on": t["waiting_on"],
        "claimed_by": claimed_by,
        "legal_operations": legal,
    }))
}

fn mine(state: Option<&Value>) -> bool {
    state.and_then(|s| s["claimed_by"]["mine"].as_bool()) == Some(true)
}

// ---- 兜底 ------------------------------------------------------------------------------------

/// 读一下现状：任务相关就是 task_get，否则 brief；两者都需要项目，没有项目就让调用方补 session。
fn reread(e: &DomainError, ctx: &Ctx<'_>) -> Fix {
    let why = "先读现状，再决定下一步".to_owned();
    match (ctx.task_key(e), ctx.project()) {
        (Some(key), Some(_)) => Fix::Reread {
            call: call(
                ctx,
                "atm_task_get",
                obj(json!({"task_key": key, "view": "full"})),
            ),
            why,
        },
        (_, Some(_)) => Fix::Reread {
            call: call(ctx, "atm_brief", Map::new()),
            why,
        },
        _ => add_param(
            ctx,
            "session",
            "带上 atm_begin 返回的 session；还没开会话就先 atm_begin",
        ),
    }
}

fn add_param(ctx: &Ctx<'_>, param: &str, why: &str) -> Fix {
    Fix::AddParam {
        tool: ctx.tool.name.to_owned(),
        param: param.to_owned(),
        why: why.to_owned(),
    }
}

fn ask_user(e: &DomainError) -> Fix {
    Fix::AskUser {
        message: e.message.clone(),
    }
}

/// 生成器给不出时按目录的默认种类兜底。
fn fallback(e: &DomainError, ctx: &Ctx<'_>) -> Fix {
    match e.code.fix_kind() {
        FixKind::AskUser => ask_user(e),
        FixKind::Wait => Fix::Wait {
            retry_after_ms: 1000,
            call: Some(original(ctx, |_| {})),
        },
        FixKind::AddParam => add_param(
            ctx,
            e.details
                .get("field")
                .and_then(Value::as_str)
                .unwrap_or("session"),
            &e.message,
        ),
        FixKind::None if e.code == ErrorCode::INTERNAL_ERROR => Fix::None,
        FixKind::None => ask_user(e),
        FixKind::Call | FixKind::Reread => reread(e, ctx),
    }
}

// ---- 生成器 ----------------------------------------------------------------------------------

fn g_next(e: &DomainError, ctx: &Ctx<'_>, _: Option<&Value>) -> Option<Fix> {
    next_call(e, ctx).map(|call| Fix::Call {
        call,
        why: "按服务给的下一步执行".into(),
    })
}

fn g_internal(_: &DomainError, _: &Ctx<'_>, _: Option<&Value>) -> Option<Fix> {
    Some(Fix::None)
}

fn g_ask_user(e: &DomainError, _: &Ctx<'_>, _: Option<&Value>) -> Option<Fix> {
    Some(ask_user(e))
}

fn g_reread(e: &DomainError, ctx: &Ctx<'_>, _: Option<&Value>) -> Option<Fix> {
    Some(reread(e, ctx))
}

fn g_wait(_: &DomainError, ctx: &Ctx<'_>, _: Option<&Value>) -> Option<Fix> {
    Some(Fix::Wait {
        retry_after_ms: 1000,
        call: Some(original(ctx, |_| {})),
    })
}

/// 参数错误（服务层报的）：缺的、写错的那个参数。
fn g_invalid_argument(e: &DomainError, ctx: &Ctx<'_>, _: Option<&Value>) -> Option<Fix> {
    let path = e
        .details
        .get("problems")
        .and_then(|p| p[0]["path"].as_str())
        .or_else(|| e.details.get("field").and_then(Value::as_str))?;
    Some(add_param(ctx, path, &e.message))
}

fn g_validation(e: &DomainError, ctx: &Ctx<'_>, s: Option<&Value>) -> Option<Fix> {
    g_next(e, ctx, s).or_else(|| g_invalid_argument(e, ctx, s))
}

/// 版本冲突：任务上换成当前版本重发（自己领着的直接省掉版本）；改内容的 edit / cancel / reopen 先读，
/// 不能拿新版本盲写；检查项走服务给的 next；知识先按 id 取编辑版。
fn g_version_conflict(e: &DomainError, ctx: &Ctx<'_>, state: Option<&Value>) -> Option<Fix> {
    if let Some(fix) = g_next(e, ctx, state) {
        return Some(fix);
    }
    if ctx.is("atm_knowledge_save") {
        let id = ctx.str("id")?;
        return Some(Fix::Reread {
            call: call(
                ctx,
                "atm_knowledge_get",
                obj(json!({"id": id, "for_edit": true})),
            ),
            why: "知识已被改过：取最新的编辑版，合并后再带新的 expected_revision_id 保存".into(),
        });
    }
    let key = ctx.task_key(e)?;
    if !ctx.is("atm_task_patch") {
        return None;
    }
    let mut args = ctx.args.clone();
    let flat = !matches!(args.get("items"), Some(Value::Array(_)));
    let items: Vec<&mut Map<String, Value>> = if flat {
        vec![&mut args]
    } else {
        match args.get_mut("items") {
            Some(Value::Array(list)) => list.iter_mut().filter_map(Value::as_object_mut).collect(),
            _ => Vec::new(),
        }
    };
    let mut same: Vec<&mut Map<String, Value>> = items
        .into_iter()
        .filter(|m| m.get("task_key").and_then(Value::as_str) == Some(key.as_str()))
        .collect();
    let content = same.iter().any(|m| {
        matches!(
            m.get("operation").and_then(Value::as_str),
            Some("edit" | "cancel" | "reopen")
        )
    });
    if same.is_empty() || content {
        return Some(reread(e, ctx));
    }
    // 库里的当前版本（批内冲突时事务已回滚，details 里的是批内接力后的值，不能用）。
    let current = state.map(|s| s["version"].clone())?;
    let owner = mine(state);
    for (i, m) in same.iter_mut().enumerate() {
        if i == 0 && !owner {
            m.insert("expected_version".into(), current.clone());
        } else {
            // 自己领着的不需要版本；同一任务第二次出现起由前一条接力（R11 P1-1）。
            m.remove("expected_version");
        }
    }
    let why = if owner {
        "你持有该任务，可以不带 expected_version；同一任务的后续条目由前一条接力"
    } else {
        "换上当前版本重发；同一任务的后续条目由前一条接力，不写版本"
    };
    Some(Fix::Call {
        call: call(ctx, "atm_task_patch", args),
        why: why.into(),
    })
}

/// 原调用里这个任务的 operation。
fn op_of(ctx: &Ctx<'_>, key: &str) -> Option<String> {
    if !ctx.is("atm_task_patch") {
        return None;
    }
    let pick = |m: &Map<String, Value>| {
        (m.get("task_key").and_then(Value::as_str) == Some(key))
            .then(|| {
                m.get("operation")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .flatten()
    };
    match ctx.args.get("items") {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_object).find_map(pick),
        _ => pick(ctx.args),
    }
}

fn item_mut<'a>(args: &'a mut Value, key: &str) -> Option<&'a mut Map<String, Value>> {
    let m = args.as_object_mut()?;
    if m.contains_key("items") {
        return m
            .get_mut("items")?
            .as_array_mut()?
            .iter_mut()
            .filter_map(Value::as_object_mut)
            .find(|x| x.get("task_key").and_then(Value::as_str) == Some(key));
    }
    Some(m)
}

/// 完成门：缺「先 start」就给 start；只差检查项没勾时，给预填了检查项 id 的同一个 complete；其余先读全貌。
fn g_gate(e: &DomainError, ctx: &Ctx<'_>, state: Option<&Value>) -> Option<Fix> {
    if let Some(fix) = g_next(e, ctx, state) {
        return Some(fix);
    }
    let reasons = e.details.get("reasons")?.as_array()?;
    let all_items =
        !reasons.is_empty() && reasons.iter().all(|r| r["code"] == "CHECKLIST_INCOMPLETE");
    let key = ctx.task_key(e)?;
    if all_items && op_of(ctx, &key).as_deref() == Some("complete") {
        let checklist: Vec<Value> = reasons
            .iter()
            .map(|r| json!({"item": r["checklist_id"], "status": "DONE"}))
            .collect();
        let extra = obj(json!({"checklist": checklist}));
        return patch(ctx, &key, Some("complete"), &extra).map(|call| Fix::Call {
            call,
            why: "这些检查项还没勾：确认都做完了，就随 complete 一起勾上".into(),
        });
    }
    Some(reread(e, ctx))
}

/// 没有会话：补上 begin 返回的 session（A3）。
fn g_session_required(_: &DomainError, ctx: &Ctx<'_>, _: Option<&Value>) -> Option<Fix> {
    Some(add_param(
        ctx,
        "session",
        "带上 atm_begin 返回的 session；还没开会话就先 atm_begin",
    ))
}

/// session 不存在：知道是哪个 Agent 就重新 begin（resume:auto 会接上能接的）；不知道就换一个有效的 session。
fn g_session_not_found(_: &DomainError, ctx: &Ctx<'_>, _: Option<&Value>) -> Option<Fix> {
    let Some(mut c) = begin(ctx, Map::new()) else {
        return Some(add_param(
            ctx,
            "session",
            "这个 session 不存在：换成 atm_begin 返回的 session",
        ));
    };
    if let Some(m) = c.arguments.as_object_mut() {
        m.remove("session");
    }
    Some(Fix::Call {
        call: c,
        why: "这个 session 不存在：重新 atm_begin，用返回的 session".into(),
    })
}

/// 后继不唯一：候选里挑一个，按服务说的参数（session 或 predecessor_session_id）带上。
fn g_ambiguous(e: &DomainError, ctx: &Ctx<'_>, _: Option<&Value>) -> Option<Fix> {
    let first = e.details.get("candidates")?.as_array()?.first()?;
    let id = first
        .as_str()
        .or_else(|| first["session"].as_str())
        .or_else(|| first["id"].as_str())?;
    let fix_call = match e.details.get("resolution").and_then(Value::as_str) {
        Some("predecessor_session_id") => begin(
            ctx,
            obj(json!({"predecessor_session_id": id, "resume": true})),
        )?,
        _ => original(ctx, |m| {
            m.insert("session".into(), json!(id));
        }),
    };
    Some(Fix::Call {
        call: fix_call,
        why: "有多个候选：用 candidates 里的第一个，不对就换另一个".into(),
    })
}

fn g_identity_mismatch(_: &DomainError, ctx: &Ctx<'_>, _: Option<&Value>) -> Option<Fix> {
    let mut c = begin(ctx, obj(json!({"resume": false})))?;
    if let Some(m) = c.arguments.as_object_mut() {
        m.remove("session");
        m.remove("predecessor_session_id");
    }
    Some(Fix::Call {
        call: c,
        why: "身份对不上：开一个新的会话".into(),
    })
}

/// 项目代码打错：用最像的那个；begin 找不到项目：允许建项目。
fn g_project_not_found(e: &DomainError, ctx: &Ctx<'_>, _: Option<&Value>) -> Option<Fix> {
    if let Some(code) = e
        .details
        .get("did_you_mean")
        .and_then(|d| d.as_array().and_then(|a| a.first()).or(Some(d)))
        .and_then(Value::as_str)
    {
        return Some(Fix::Call {
            call: original(ctx, |m| {
                m.insert("project".into(), json!(code));
            }),
            why: format!("没有这个项目，最像的是 {code}"),
        });
    }
    Some(add_param(ctx, "project", &e.message))
}

fn g_project_required(e: &DomainError, ctx: &Ctx<'_>, s: Option<&Value>) -> Option<Fix> {
    g_next(e, ctx, s).or_else(|| {
        let first = e.details.get("candidates")?.as_array()?.first()?.as_str()?;
        Some(Fix::Call {
            call: original(ctx, |m| {
                m.insert("project".into(), json!(first));
            }),
            why: "session 同时出现在多个项目里：显式带上 project（candidates 里挑）".into(),
        })
    })
}

/// 领取过期需要接管：release 带 takeover_stale 与当前版本。
fn g_claim_owner(e: &DomainError, ctx: &Ctx<'_>, state: Option<&Value>) -> Option<Fix> {
    let mut c = next_call(e, ctx)?;
    let key = ctx.task_key(e)?;
    if c.name == "atm_task_patch"
        && let (Some(m), Some(v)) = (
            item_mut(&mut c.arguments, &key),
            state.map(|s| s["version"].clone()),
        )
    {
        m.insert("expected_version".into(), v);
    }
    Some(Fix::Call {
        call: c,
        why: "领取已过期：先接管释放，再领取".into(),
    })
}

fn g_idempotency(e: &DomainError, ctx: &Ctx<'_>, _: Option<&Value>) -> Option<Fix> {
    let op_id = ctx.str("op_id")?;
    let project = ctx.project()?;
    let _ = e;
    Some(Fix::Reread {
        call: call(
            ctx,
            "atm_search",
            obj(json!({"project": project, "op_id": op_id})),
        ),
        why: "这个 op_id 已经用在别的内容上：先回查它做了什么；确认是一笔新操作才换 op_id".into(),
    })
}

fn g_too_large(_: &DomainError, ctx: &Ctx<'_>, _: Option<&Value>) -> Option<Fix> {
    let max = ctx.tool.fields.iter().find_map(|f| match (f.name, f.ty) {
        ("max_chars", crate::schema::Ty::Int { max, .. }) => Some(max),
        _ => None,
    })?;
    let now = ctx.args.get("max_chars").and_then(Value::as_i64);
    if now.is_some_and(|n| n >= max) {
        return None;
    }
    Some(Fix::Call {
        call: original(ctx, |m| {
            m.insert("max_chars".into(), json!(max));
            m.remove("cursor");
        }),
        why: "放大 max_chars 再读".into(),
    })
}

fn g_dependency(_: &DomainError, ctx: &Ctx<'_>, _: Option<&Value>) -> Option<Fix> {
    Some(Fix::Call {
        call: call(ctx, "atm_task_list", obj(json!({"ready_only": true}))),
        why: "前置任务还没完成：先做就绪的任务".into(),
    })
}

fn g_work_item_not_found(e: &DomainError, ctx: &Ctx<'_>, _: Option<&Value>) -> Option<Fix> {
    let key = ctx.task_key(e)?;
    ctx.project()?;
    Some(Fix::Reread {
        call: call(ctx, "atm_task_list", obj(json!({"query": key}))),
        why: "没有这个任务：按关键字找一下".into(),
    })
}

fn g_record_not_found(_: &DomainError, ctx: &Ctx<'_>, _: Option<&Value>) -> Option<Fix> {
    let project = ctx.project()?;
    Some(Fix::Reread {
        call: call(
            ctx,
            "atm_search",
            obj(json!({"project": project, "list": "records"})),
        ),
        why: "没有这条记录：列出现有记录".into(),
    })
}

fn g_blocked_reason(_: &DomainError, ctx: &Ctx<'_>, _: Option<&Value>) -> Option<Fix> {
    Some(add_param(ctx, "blocked_reason", "block 要写清阻塞原因"))
}

fn g_waiting_for(_: &DomainError, ctx: &Ctx<'_>, _: Option<&Value>) -> Option<Fix> {
    Some(add_param(ctx, "waiting_for", "wait_* 要写清在等什么"))
}

fn g_project_param(e: &DomainError, ctx: &Ctx<'_>, _: Option<&Value>) -> Option<Fix> {
    Some(add_param(ctx, "project", &e.message))
}

fn g_drop_cursor(_: &DomainError, ctx: &Ctx<'_>, _: Option<&Value>) -> Option<Fix> {
    ctx.args.get("cursor")?;
    Some(Fix::Call {
        call: original(ctx, |m| {
            m.remove("cursor");
        }),
        why: "游标失效：不带 cursor 从头读".into(),
    })
}

fn g_drop_op_id(_: &DomainError, ctx: &Ctx<'_>, _: Option<&Value>) -> Option<Fix> {
    Some(Fix::Call {
        call: original(ctx, |m| {
            m.remove("op_id");
        }),
        why: "op_id 不合法：省略它，由 ATM 签发".into(),
    })
}

fn g_slug_conflict(e: &DomainError, ctx: &Ctx<'_>, _: Option<&Value>) -> Option<Fix> {
    let id = e.details.get("holder_id")?.as_str()?;
    Some(Fix::Reread {
        call: call(
            ctx,
            "atm_knowledge_get",
            obj(json!({"id": id, "for_edit": true})),
        ),
        why: "这个 slug 已经有条目：取它的编辑版，按更新（带 id 与 expected_revision_id）保存"
            .into(),
    })
}

fn g_restored(e: &DomainError, ctx: &Ctx<'_>, _: Option<&Value>) -> Option<Fix> {
    Some(match reread(e, ctx) {
        Fix::Reread { call, .. } => Fix::Reread {
            call,
            why: "数据被恢复到较早的版本：先读现状，不要盲目重做".into(),
        },
        other => other,
    })
}

fn g_target_changed(_: &DomainError, ctx: &Ctx<'_>, _: Option<&Value>) -> Option<Fix> {
    Some(Fix::Call {
        call: original(ctx, |m| {
            m.remove("expected_scope_generation");
        }),
        why: "写入目标变了：不带旧的目标重新发起".into(),
    })
}

fn g_retry_same(_: &DomainError, ctx: &Ctx<'_>, _: Option<&Value>) -> Option<Fix> {
    ctx.args.get("op_id")?;
    Some(Fix::Call {
        call: original(ctx, |_| {}),
        why: "结果未知：用同一个 op_id 原样重试，已经写入的会按重放返回".into(),
    })
}

/// 码 → 生成器。U-4：`ErrorCode::ALL` 里每个码都要有一项（静态检查）。
pub static GENERATORS: &[(ErrorCode, Gen)] = {
    use ErrorCode as C;
    &[
        // 参数与形状
        (C::INVALID_ARGUMENT, g_invalid_argument),
        (C::VALIDATION_ERROR, g_validation),
        (C::BLOCKED_REASON_REQUIRED, g_blocked_reason),
        (C::WAITING_FOR_REQUIRED, g_waiting_for),
        (C::INVALID_PROJECT_CODE, g_project_param),
        (C::INVALID_WORK_ITEM_KEY, g_work_item_not_found),
        (C::INVALID_CURSOR, g_drop_cursor),
        (C::CONTINUATION_CONFLICT, g_drop_cursor),
        (C::OPERATION_ID_INVALID, g_drop_op_id),
        (C::RESULT_TOO_LARGE, g_too_large),
        // 版本与状态
        (C::VERSION_CONFLICT, g_version_conflict),
        (C::EXPECTED_VERSION_REQUIRED, g_next),
        (C::INVALID_TRANSITION, g_next),
        (C::COMPLETION_GATE_FAILED, g_gate),
        (C::WORK_ITEM_TERMINAL, g_next),
        (C::DEPENDENCY_NOT_READY, g_dependency),
        (C::DEPENDENCY_CYCLE, g_reread),
        (C::HIERARCHY_CYCLE, g_reread),
        (C::HIERARCHY_DEPTH, g_reread),
        (C::PLANNING_TARGET_CLOSED, g_reread),
        (C::IMMUTABLE_RECORD, g_record_not_found),
        // 领取
        (C::CLAIM_NOT_OWNED, g_next),
        (C::TASK_ALREADY_CLAIMED, g_next),
        (C::CLAIM_OWNER_REQUIRED, g_claim_owner),
        // 找不到
        (C::WORK_ITEM_NOT_FOUND, g_work_item_not_found),
        (C::DEPENDENCY_REF_NOT_FOUND, g_reread),
        (C::PARENT_REF_NOT_FOUND, g_reread),
        (C::DISCOVERED_FROM_REF_NOT_FOUND, g_reread),
        (C::MILESTONE_NOT_FOUND, g_reread),
        (C::MILESTONE_OBJECTIVE_MISMATCH, g_reread),
        (C::OBJECTIVE_NOT_FOUND, g_reread),
        (C::OBJECTIVE_REQUIRED, g_reread),
        (C::RECORD_NOT_FOUND, g_record_not_found),
        (C::PROGRESS_NOT_FOUND, g_reread),
        (C::OPERATION_NOT_FOUND, g_reread),
        (C::NOT_FOUND, g_reread),
        (C::CHECKLIST_NOT_FOUND, g_reread),
        (C::CHECKLIST_TASK_MISMATCH, g_reread),
        // 检查项与评审
        (C::CANDIDATE_HASH_MISMATCH, g_reread),
        (C::REVIEWER_REQUIRED, g_next),
        (C::REVIEWER_SESSION_REQUIRED, g_next),
        (C::REVIEW_IDENTITY_MISMATCH, g_next),
        (C::REVIEW_TASK_INVALID, g_reread),
        (C::REVIEW_TASK_CLOSED, g_reread),
        (C::REVIEW_ALREADY_SUBMITTED, g_reread),
        (C::REVIEW_BINDING_MISMATCH, g_reread),
        (C::REVIEW_CHECKLIST_CLOSED, g_reread),
        (C::REVIEW_REQUEST_CONFLICT, g_reread),
        (C::REVIEW_REQUEST_NOT_FOUND, g_reread),
        (C::REVIEW_REQUEST_REQUIRES_SESSION, g_session_required),
        (C::REVIEW_SELF_NOT_ALLOWED, g_ask_user),
        // 会话
        (C::SESSION_REQUIRED, g_session_required),
        (C::SESSION_NOT_FOUND, g_session_not_found),
        (C::SESSION_CLOSED, g_next),
        (C::SESSION_NOT_RETIRED, g_next),
        (C::SESSION_SUCCESSOR_AMBIGUOUS, g_ambiguous),
        (C::SESSION_SUCCESSOR_AGENT_MISMATCH, g_identity_mismatch),
        (C::SESSION_SUCCESSOR_IDENTITY_MISMATCH, g_identity_mismatch),
        // 项目
        (C::PROJECT_NOT_FOUND, g_project_not_found),
        (C::PROJECT_REQUIRED, g_project_required),
        (C::PROJECT_ALREADY_EXISTS, g_reread),
        (C::PROJECT_CODE_CONFLICT, g_project_param),
        (C::PROJECT_CODE_EXHAUSTED, g_ask_user),
        (C::PROJECT_PATH_CONFLICT, g_ask_user),
        (C::PROJECT_LIFECYCLE_CONFLICT, g_reread),
        (C::PROJECT_DB_UNAVAILABLE, g_ask_user),
        (C::PROJECT_DB_QUICK_CHECK_FAILED, g_ask_user),
        (C::PROJECT_META_MISSING, g_ask_user),
        (C::PROJECT_RESTORE_REQUEST_DECIDED, g_reread),
        (C::PROJECT_RESTORE_REQUEST_NOT_FOUND, g_reread),
        (C::PROJECT_UPDATE_DRAFT_NOT_FOUND, g_reread),
        (C::PROJECT_UPDATE_NOT_FOUND, g_reread),
        (C::ATOMIC_BEGIN_REQUIRES_EXISTING_PROJECT, g_reread),
        // 幂等、恢复、目标
        (C::IDEMPOTENCY_CONFLICT, g_idempotency),
        (C::OPERATION_UNDONE_BY_RESTORE, g_restored),
        (C::SCOPE_RESTORED, g_restored),
        (C::TARGET_CHANGED, g_target_changed),
        (C::RESULT_UNKNOWN, g_retry_same),
        // 忙与不可用
        (C::STORE_BUSY, g_wait),
        (C::SERVICE_UNAVAILABLE, g_wait),
        (C::INVALID_RESPONSE, g_wait),
        (C::KNOWLEDGE_UNAVAILABLE, g_wait),
        // 知识
        (C::KNOWLEDGE_SLUG_CONFLICT, g_slug_conflict),
        // 只有用户能做的
        (C::USER_AUTHORIZATION_REQUIRED, g_ask_user),
        (C::PRINCIPAL_CAPABILITY_DENIED, g_ask_user),
        (C::FORBIDDEN, g_ask_user),
        (C::UNAUTHORIZED, g_ask_user),
        (C::METHOD_NOT_ALLOWED, g_ask_user),
        (C::MCP_CLIENT_UNSUPPORTED, g_ask_user),
        (C::COMMAND_EXPIRED, g_ask_user),
        (C::IMPORT_OBJECTIVE_MISSING, g_ask_user),
        (C::IMPORT_SOURCE_CHANGED, g_ask_user),
        (C::SAVED_VIEW_NAME_REQUIRED, g_ask_user),
        (C::SETTING_KEY_INVALID, g_ask_user),
        (C::NOTIFICATION_MODE_INVALID, g_ask_user),
        (C::COUNTER_NOT_FOUND, g_ask_user),
        (C::BACKUP_FILE_MISSING, g_ask_user),
        (C::BACKUP_HASH_MISMATCH, g_ask_user),
        (C::BACKUP_INTEGRITY_FAILED, g_ask_user),
        (C::BACKUP_MANIFEST_MISMATCH, g_ask_user),
        (C::BACKUP_MANIFEST_MISSING, g_ask_user),
        (C::BACKUP_NOT_FOUND, g_ask_user),
        (C::BACKUP_PROJECT_IDENTITY_MISMATCH, g_ask_user),
        (C::BACKUP_RESTORE_SCOPE_UNSUPPORTED, g_ask_user),
        (C::AGENT_DOCS_MISSING, g_ask_user),
        (C::AGENT_GUIDE_MISSING, g_ask_user),
        (C::AGENT_RULE_MODIFIED_REQUIRES_REPAIR, g_ask_user),
        (C::AGENT_RULE_NEEDS_EXPLICIT_UPDATE, g_ask_user),
        (C::AGENT_SKILLS_MISSING, g_ask_user),
        (C::AGENT_SKILL_MISSING, g_ask_user),
        (C::AGENT_SKILL_MODIFIED_REQUIRES_REPAIR, g_ask_user),
        // ATM 自身的问题（Agent 只能转告用户）
        (C::DUPLICATE_TOOL_DEFINITION, g_ask_user),
        (C::EXTERNAL_NAME_MISSING, g_ask_user),
        (C::INVALID_TOOL_DESCRIPTION, g_ask_user),
        (C::MIGRATION_FILE_MISSING, g_ask_user),
        (C::MIGRATION_GAP, g_ask_user),
        (C::MIGRATION_HASH_MISMATCH, g_ask_user),
        (C::MIGRATION_HASH_ORIGIN, g_ask_user),
        (C::MIGRATION_HISTORY_GAP, g_ask_user),
        (C::MIGRATION_NAME_MISMATCH, g_ask_user),
        (C::MIGRATION_PLAN_EMPTY, g_ask_user),
        (C::SQLITE_FTS5_TRIGRAM_REQUIRED, g_ask_user),
        (C::SQLITE_VERSION_UNSAFE, g_ask_user),
        (C::INTERNAL_ERROR, g_internal),
    ]
};
