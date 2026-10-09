//! `POST /mcp/resolve`（10 R11 A3）：桥签发缺字段的写调用之前，在同一个只读快照里拿到最终生效的 session
//! 与分支目标，写进这次调用的不可变重试上下文（`session`、`project`、`expected_target`）。
//!
//! 请求体是桥手里的原调用：`{"tool": "...", "arguments": {...}}`。参数先过工具的 schema（与 `tools/call`
//! 同一个校验器），应答里的 `arguments` 就是规范化之后的参数，桥在它上面补字段、签发。operation 由工具与
//! 规范化后的参数推出（与 `tools/call` 的映射一致）；只读工具不写任何东西，不需要 resolve。错误与
//! `tools/call` 同一个信封，fix 指向原工具（例如缺 session 时补 session 参数，或先 atm_begin）。

use crate::agent::{Args, Surface};
use crate::{Agent, AppState, read_json, reply, workspace, write};
use atm_domain::error::{Committed, DomainError, Envelope, ErrorCode};
use atm_service::resolve::ResolveRequest;
use atm_service::{knowledge, memory, session, work};
use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use serde_json::{Map, Value, json};
use std::sync::Arc;

/// 写工具（加上它的参数）落到哪个 operation。只读工具是 None。
pub(crate) fn operation_of(tool: &str, a: &Args<'_>) -> Option<&'static str> {
    Some(match tool {
        "atm_begin" => session::BEGIN_OPERATION,
        "atm_end" => session::END_OPERATION,
        "atm_task_create" => work::CREATE_OPERATION,
        "atm_task_patch" => {
            let op = a.str("operation").or_else(|| {
                a.get("items")
                    .and_then(Value::as_array)
                    .and_then(|items| items.first())
                    .and_then(|i| i.get("operation"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
            match op.as_deref() {
                Some("verify_and_complete") => work::VERIFY_AND_COMPLETE_OPERATION,
                Some("review_request") => work::REVIEW_REQUEST_OPERATION,
                Some("review_submit") => work::REVIEW_SUBMIT_OPERATION,
                Some("checklist" | "checklist_single") => work::CHECKLIST_OPERATION,
                Some("checklist_batch") => work::CHECKLIST_BATCH_OPERATION,
                _ => work::PATCH_OPERATION,
            }
        }
        // 与 tools/call 的推断相同：scope 省略时有 task_key 就是任务进度。
        "atm_progress_add" => match a.str("scope").as_deref() {
            Some("task") => memory::PROGRESS_OPERATION,
            Some(_) => memory::PROJECT_UPDATE_OPERATION,
            None if a.has("task_key") => memory::PROGRESS_OPERATION,
            None => memory::PROJECT_UPDATE_OPERATION,
        },
        "atm_record" | "atm_feedback" => memory::RECORD_OPERATION,
        "atm_knowledge_save" => knowledge::AGENT_SAVE_OPERATION,
        _ => return None,
    })
}

/// 参数的别名（桥转来的是 Agent 的原调用，没有经过 schema 规范化）。
fn first(a: &Map<String, Value>, names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|n| a.get(*n).and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

impl Surface {
    /// `/mcp/resolve` 的路由。
    pub fn resolve_routes(self: &Arc<Surface>) -> Router<AppState> {
        let me = self.clone();
        Router::new().route(
            "/mcp/resolve",
            post(
                move |State(state): State<AppState>, agent: Agent, body: Body| {
                    let me = me.clone();
                    async move { me.resolve_http(state, agent, body).await }
                },
            ),
        )
    }

    async fn resolve_http(
        self: Arc<Surface>,
        state: AppState,
        agent: Agent,
        body: Body,
    ) -> Response {
        let message = match read_json(body).await {
            Ok(v) => v,
            Err(e) => return reply(e),
        };
        match state
            .calls
            .run(move || self.resolve_call(&agent, &message))
            .await
        {
            Ok(Ok(v)) => (
                [(axum::http::header::CONTENT_TYPE, "application/json")],
                v.to_string(),
            )
                .into_response(),
            Ok(Err(e)) | Err(e) => reply(e),
        }
    }

    fn resolve_call(&self, agent: &Agent, message: &Value) -> Result<Value, Envelope> {
        let p = &agent.0;
        let refuse =
            |e: DomainError| Envelope::new(e, Committed::No, None, atm_domain::error::Fix::None);
        let name = message
            .get("tool")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Some(tool) = crate::tools::find(name) else {
            return Err(refuse(
                DomainError::new(ErrorCode::INVALID_ARGUMENT, format!("没有工具 {name:?}"))
                    .detail("field", "tool"),
            ));
        };
        // 与 tools/call 同一个校验器、同一份规范化结果（规范名、数字当文本、空白身份字段视同省略、
        // 布尔字符串）：resolve 判定的就是正式调用会看到的参数，桥签发的也是它（peer W4 r1 P1-02）。
        // 无法解释的值在这里就拒绝，与 tools/call 同一个信封，什么都没写。
        let checked = tool
            .validate(message.get("arguments").unwrap_or(&Value::Null))
            .map_err(|rejected| crate::mcp::invalid_argument(tool, rejected))?;
        let args = &checked.args;
        let a = Args(args);
        let Some(operation) = operation_of(tool.name, &a) else {
            return Err(refuse(
                DomainError::new(
                    ErrorCode::INVALID_ARGUMENT,
                    format!("{} 是只读工具，不需要 resolve：直接调用", tool.name),
                )
                .detail("field", "tool"),
            ));
        };
        let project = first(args, &["project", "project_code"]);
        let cwd = first(args, &["cwd"]);
        let is_begin = operation == session::BEGIN_OPERATION;
        let r = ResolveRequest {
            operation: operation.to_owned(),
            // begin 的 session 是「接回这个 session」，不是写入的作者，不参与 session 判定。
            session: if is_begin {
                None
            } else {
                first(args, &["session", "session_id"])
            },
            project: if is_begin { None } else { project.clone() },
            selector: if is_begin {
                workspace::selector(project, cwd.as_deref())
            } else {
                Default::default()
            },
            mode: first(args, &["mode"]),
            allow_project_create: a.bool("allow_project_create"),
            target_project: None,
            single_conversation: write::single_conversation(p.client_group()),
        };
        match self.svc.resolve(p, r) {
            Ok(resolved) => {
                let mut out = resolved.to_json();
                out["operation"] = json!(operation);
                out["tool"] = json!(tool.name);
                out["arguments"] = Value::Object(args.clone());
                Ok(out)
            }
            Err(e) => Err(self.envelope(p, tool, args, e, Committed::No)),
        }
    }
}
