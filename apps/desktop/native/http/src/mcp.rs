//! MCP 协议核心（W4c）：无状态 Streamable HTTP，只回 JSON。
//!
//! - 每个 profile 一个入口 `POST /mcp/<profile>`；`GET` / `DELETE` 回 405（不开 SSE 流，也没有会话可删）。
//! - 方法：`initialize`、`ping`、`tools/list`、`tools/call`；通知（没有 `id`）一律 202、空 body。
//! - 工具错误不是协议错误：`tools/call` 照常回 `result`，`isError:true`，`structuredContent` 是统一信封，
//!   `content` 文本里也放 code、message 与 fix（很多客户端只显示 content，11 §3）。
//! - 协议错误（坏 JSON-RPC、未知方法、未知工具）回 JSON-RPC `error`。

use crate::schema::{Checked, Tool};
use crate::{Agent, AppState, read_json};
use atm_domain::error::{Committed, DomainError, Envelope, Fix, ToolCall};
use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;

/// 对外面版本（R11：v6）。
pub const SURFACE_VERSION: &str = "v6";

/// 支持的 MCP 协议版本，新的在前。客户端要的版本在表里就照用，否则回最新的。
pub const PROTOCOL_VERSIONS: &[&str] = &[
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
];

/// 一个 profile：发布哪些工具、还接受哪些不发布的工具。
pub struct Profile {
    pub name: &'static str,
    pub instructions: &'static str,
    pub tools: &'static [&'static Tool],
    /// tools/list 里不出现、tools/call 照常可用（R11 P3：并入别的工具后保留的旧名；actions 别名下的 core 工具）。
    pub hidden: &'static [&'static Tool],
    /// `tools` 数组 JSON 的字节上限（与 2.0 的 schema-budget 同口径：不含外壳与 JSON-RPC 信封）。
    pub budget: usize,
}

impl Profile {
    pub fn find(&self, name: &str) -> Option<&'static Tool> {
        self.tools
            .iter()
            .chain(self.hidden)
            .copied()
            .find(|t| t.name == name)
    }

    /// 发布的工具数组。每项带 annotations 与 `_meta`（`surface_version`、`schema_hash`：inputSchema
    /// JSON 的 SHA-256 前 16 位十六进制，与 2.0 同形）。
    pub fn tools_json(&self) -> Vec<Value> {
        self.tools
            .iter()
            .map(|t| {
                let schema = t.input_schema();
                let hash = hex(&Sha256::digest(
                    serde_json::to_vec(&schema).unwrap_or_default(),
                ));
                json!({
                    "name": t.name,
                    "description": t.description(),
                    "inputSchema": schema,
                    "annotations": {"readOnlyHint": t.read_only, "destructiveHint": t.destructive},
                    "_meta": {"surface_version": SURFACE_VERSION, "schema_hash": &hash[..16]},
                })
            })
            .collect()
    }

    /// 发布的工具数组的字节数（预算口径）。
    pub fn bytes(&self) -> usize {
        serde_json::to_vec(&self.tools_json())
            .map(|v| v.len())
            .unwrap_or(usize::MAX)
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 执行一次已经校验过的工具调用。同步执行，在 [`crate::Calls`] 的阻塞池里跑。
pub type Handler =
    Arc<dyn Fn(&Agent, &'static Tool, Checked) -> Result<Value, Envelope> + Send + Sync>;

/// MCP 路由：每个 profile 一个入口。
pub fn routes(profiles: &'static [Profile], handler: Handler) -> Router<AppState> {
    let mut router = Router::new();
    for profile in profiles {
        let handler = handler.clone();
        router = router.route(
            &format!("/mcp/{}", profile.name),
            post(move |state: State<AppState>, agent: Agent, body: Body| {
                rpc(state, agent, body, profile, handler.clone())
            }),
        );
    }
    router
}

async fn rpc(
    State(state): State<AppState>,
    agent: Agent,
    body: Body,
    profile: &'static Profile,
    handler: Handler,
) -> Response {
    let message = match read_json(body).await {
        Ok(v) => v,
        Err(e) => {
            return rpc_error(
                Value::Null,
                -32700,
                &e.message,
                Some(serde_json::to_value(&e).unwrap_or_default()),
            );
        }
    };
    let Value::Object(message) = message else {
        // 2025-06-18 去掉了批量请求；数组与其他形状都是无效请求。
        return rpc_error(
            Value::Null,
            -32600,
            "expected one JSON-RPC request object",
            None,
        );
    };
    let id = message.get("id").cloned();
    let method = message.get("method").and_then(Value::as_str);
    if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") || method.is_none() {
        // 客户端对我们请求的应答（有 id、没有 method）也到这里：我们从不发请求，按无效处理。
        return rpc_error(
            id.unwrap_or(Value::Null),
            -32600,
            "not a JSON-RPC 2.0 request",
            None,
        );
    }
    let method = method.unwrap_or_default();
    let Some(id) = id else {
        // 通知：确认收到，不回内容（Streamable HTTP：202 Accepted）。
        return StatusCode::ACCEPTED.into_response();
    };
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str);
            let version = asked
                .filter(|v| PROTOCOL_VERSIONS.contains(v))
                .unwrap_or(PROTOCOL_VERSIONS[0]);
            rpc_result(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "ayanami-task-manager", "version": env!("CARGO_PKG_VERSION")},
                    "instructions": profile.instructions,
                }),
            )
        }
        "ping" => rpc_result(id, json!({})),
        "tools/list" => rpc_result(id, json!({"tools": profile.tools_json()})),
        "tools/call" => {
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let Some(tool) = profile.find(name) else {
                let known: Vec<&str> = profile.tools.iter().map(|t| t.name).collect();
                return rpc_error(
                    id,
                    -32602,
                    &format!("unknown tool {name:?} on the {} profile", profile.name),
                    Some(json!({"tools": known})),
                );
            };
            let args = params.get("arguments").cloned().unwrap_or(Value::Null);
            let outcome = match tool.validate(&args) {
                Ok(checked) => {
                    let handler = handler.clone();
                    let again = ToolCall {
                        name: tool.name.to_owned(),
                        arguments: Value::Object(checked.args.clone()),
                    };
                    match state
                        .calls
                        .run(move || handler(&agent, tool, checked))
                        .await
                    {
                        Ok(r) => r,
                        // 没排上队：一行都没执行，稍后原样再调（11 §3：wait 带同一调用）。
                        Err(mut busy) => {
                            if let Fix::Wait { call, .. } = &mut busy.fix {
                                *call = Some(again);
                            }
                            Err(busy)
                        }
                    }
                }
                Err(rejected) => Err(invalid_argument(tool, rejected)),
            };
            rpc_result(id, tool_result(outcome))
        }
        _ => rpc_error(
            id,
            -32601,
            &format!("method {method:?} is not supported"),
            None,
        ),
    }
}

/// 参数校验失败的信封：能自动更正时 `fix.call` 是更正后的完整调用（11 §3）；否则 `add_param`
/// 指向第一个要补或要改的参数（problems 按路径排好序，缺的必填项与写错的值都在里面）。
pub fn invalid_argument(tool: &Tool, rejected: crate::schema::Rejected) -> Envelope {
    let fix = match rejected.corrected {
        Some(args) => Fix::Call {
            call: ToolCall {
                name: tool.name.to_owned(),
                arguments: Value::Object(args),
            },
            why: "按 problems 更正后的同一调用（did_you_mean 已代入，不起作用的参数已去掉）"
                .to_owned(),
        },
        None => {
            let first = rejected
                .problems
                .iter()
                .find(|p| p.problem == atm_domain::error::ProblemKind::Missing)
                .or(rejected.problems.first());
            Fix::AddParam {
                tool: tool.name.to_owned(),
                param: first.map_or_else(String::new, |p| p.path.clone()),
                why: "按 problems 补上或改正这个参数，再调同一个工具".to_owned(),
            }
        }
    };
    Envelope::new(
        DomainError::invalid_argument(rejected.problems),
        Committed::No,
        None,
        fix,
    )
}

/// `tools/call` 的结果：成功是 `structuredContent` + 文本；失败是 `isError` + 信封。
pub fn tool_result(outcome: Result<Value, Envelope>) -> Value {
    match outcome {
        Ok(value) => json!({
            "content": [{"type": "text", "text": value.to_string()}],
            "structuredContent": value,
        }),
        Err(envelope) => {
            let value = serde_json::to_value(&envelope).unwrap_or_default();
            let mut text = format!("{}: {}", envelope.code.as_str(), envelope.message);
            if let Ok(fix) = serde_json::to_string(&envelope.fix) {
                text.push_str("\nfix: ");
                text.push_str(&fix);
            }
            if let Some(problems) = &envelope.problems {
                text.push_str("\nproblems: ");
                text.push_str(&problems.to_string());
            }
            json!({
                "content": [{"type": "text", "text": text}],
                "structuredContent": value,
                "isError": true,
            })
        }
    }
}

fn rpc_result(id: Value, result: Value) -> Response {
    json_response(json!({"jsonrpc": "2.0", "id": id, "result": result}))
}

fn rpc_error(id: Value, code: i64, message: &str, data: Option<Value>) -> Response {
    let mut error = Map::new();
    error.insert("code".into(), json!(code));
    error.insert("message".into(), json!(message));
    if let Some(d) = data {
        error.insert("data".into(), d);
    }
    json_response(json!({"jsonrpc": "2.0", "id": id, "error": error}))
}

fn json_response(body: Value) -> Response {
    (
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        body.to_string(),
    )
        .into_response()
}
