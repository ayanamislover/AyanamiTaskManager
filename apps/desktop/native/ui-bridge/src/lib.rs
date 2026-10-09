//! ui-bridge（W5，03 §2.1、06 §2、10 R8）：界面 API 的进程内分发，以及 User 主体的唯一构造点。
//!
//! - React 界面照旧发 REST 形状的请求（`runtimeRequest({path, method, body})`）；这里按常量路由表
//!   （[`routes::UI_ROUTES`]）分发到服务，回给界面 2.0 TS daemon 的原样形状（06 T-COMPAT）。
//! - 请求在解析之前先核对：目标必须是 `/api/v1/` 下的相对路径（绝对 URL、`//`、`..`、编码的分隔符都拒绝），
//!   body 不超过 2 MiB，方法与路径都在表里（10 R8）。
//! - 错误是 2.0 的信封 `{error: {code, message, retryable, details?}, request_id}`：界面的客户端只认这个形状。
//! - User 主体只在这里（WebView、托盘）与 e2e 适配器里构造（P-003，`domain/tests/principal_guard.rs`）。
//!   WebView 的 `(generation, epoch)` 写进主体，投递应答时宿主再核对一次（03 U4、P-013）。

mod handlers;
mod input;
pub mod routes;

use atm_domain::error::{DomainError, Envelope, ErrorCode};
use atm_domain::principal::{Principal, UiSurface};
use atm_http::agent::Surface;
use atm_service::write::Service;
use serde_json::{Map, Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

pub use routes::{UI_ROUTES, UiRoute};

/// body 的上限（03 U7：先于解析检查）。
pub const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
/// 目标（路径加 query）的上限，与 2.0 宿主的 `runtime-request.ts` 一致。
pub const MAX_TARGET_BYTES: usize = 4096;

/// 运行时补进 `/system/status` 的部分（版本、启动时间、转换状态）。服务层不知道这些。
pub type RuntimeStatus = Arc<dyn Fn() -> Value + Send + Sync>;

/// 一次界面请求。`target` 是路径加 query（`/api/v1/projects?x=1`），不是 URL。
#[derive(Clone, Copy, Debug)]
pub struct Request<'a> {
    pub method: &'a str,
    pub target: &'a str,
    pub body: Option<&'a [u8]>,
}

/// 应答：HTTP 状态与 JSON body。
#[derive(Clone, Debug, PartialEq)]
pub struct Reply {
    pub status: u16,
    pub body: Value,
}

impl Reply {
    fn ok(body: Value) -> Reply {
        Reply { status: 200, body }
    }
    fn created(body: Value) -> Reply {
        Reply { status: 201, body }
    }
}

/// 界面 API。宿主（WebView 的 `runtimeRequest`、托盘）与 e2e 适配器共用这一个分发。
pub struct Ui {
    pub(crate) svc: Arc<Service>,
    pub(crate) surface: Arc<Surface>,
    pub(crate) runtime: RuntimeStatus,
    /// 本次服务启动的时间：进度条（#61）的 `since`（2.0 用 daemon 的 startedAt）。
    pub(crate) started_at: String,
}

static REQUESTS: AtomicU64 = AtomicU64::new(0);

fn request_id() -> String {
    let n = REQUESTS.fetch_add(1, Ordering::Relaxed) + 1;
    format!("ui-{}-{n}", std::process::id())
}

/// 2.0 的错误信封。
pub(crate) fn error_reply(
    status: u16,
    code: &str,
    message: &str,
    retryable: bool,
    details: Option<Value>,
) -> Reply {
    let mut error = Map::new();
    error.insert("code".into(), json!(code));
    error.insert("message".into(), json!(message));
    error.insert("retryable".into(), json!(retryable));
    if let Some(d) = details.filter(|d| d.as_object().is_some_and(|m| !m.is_empty())) {
        error.insert("details".into(), d);
    }
    Reply {
        status,
        body: json!({ "error": error, "request_id": request_id() }),
    }
}

/// 服务的错误 → 2.0 信封（状态码按错误码）。
pub(crate) fn domain_reply(e: DomainError) -> Reply {
    let status = e.code.http_status();
    let retryable = e.code.retryable();
    let details = if e.details.is_empty() {
        None
    } else {
        Some(Value::Object(e.details))
    };
    error_reply(status, e.code.as_str(), &e.message, retryable, details)
}

/// Agent 工具处理器的信封（共用 schema 的写）→ 2.0 信封。`problems` 放进 details（2.0 的 INVALID_ARGUMENT 也是这样）。
pub(crate) fn envelope_reply(e: Envelope) -> Reply {
    let mut details = e.details;
    if let Some(problems) = e.problems {
        details.insert("issues".into(), problems);
    }
    if e.committed != atm_domain::error::Committed::No {
        details.insert("committed".into(), json!(e.committed));
    }
    error_reply(
        e.code.http_status(),
        e.code.as_str(),
        &e.message,
        e.retryable,
        Some(Value::Object(details)),
    )
}

fn not_found() -> Reply {
    error_reply(404, "NOT_FOUND", "没有这个界面接口", false, None)
}

/// 目标的形状检查（10 R8）。通过时给出已解码的路径段与原样的 query。
fn parse_target(target: &str) -> Result<(Vec<String>, Option<&str>), Reply> {
    let bad = |why: &str| {
        Err(error_reply(
            400,
            ErrorCode::INVALID_ARGUMENT.as_str(),
            &format!("界面请求的目标不合格：{why}"),
            false,
            None,
        ))
    };
    if target.len() > MAX_TARGET_BYTES {
        return bad("太长");
    }
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (target, None),
    };
    if path.contains('#') || query.is_some_and(|q| q.contains('#')) {
        return bad("带了片段");
    }
    // 只认相对路径：`http://…`、`//host/…`、`\…` 都不是。
    let Some(rest) = path.strip_prefix("/api/v1/") else {
        return bad("只接受 /api/v1/ 下的路径");
    };
    let mut segments = Vec::new();
    for raw in std::iter::once("api")
        .chain(std::iter::once("v1"))
        .chain(rest.split('/'))
    {
        if raw.is_empty() {
            return bad("路径里有空段");
        }
        let Some(decoded) = input::percent_decode(raw, false) else {
            return bad("路径里的编码不合格");
        };
        if decoded.contains(['/', '\\'])
            || decoded == "."
            || decoded == ".."
            || decoded.contains('\0')
        {
            return bad("路径段不能是 .、.. 或含分隔符");
        }
        segments.push(decoded);
    }
    Ok((segments, query))
}

impl Ui {
    pub fn new(svc: Arc<Service>, runtime: RuntimeStatus, started_at: impl Into<String>) -> Ui {
        Ui {
            surface: Surface::new(svc.clone()),
            svc,
            runtime,
            started_at: started_at.into(),
        }
    }

    /// 分发一次界面请求。主体由调用方给：宿主的 [`webview`]、[`tray`]，或 e2e 适配器。
    pub fn dispatch(&self, principal: &Principal, req: Request<'_>) -> Reply {
        if principal.kind() != atm_domain::principal::PrincipalKind::User {
            return error_reply(
                403,
                "USER_AUTHORIZATION_REQUIRED",
                "界面接口只给桌面端用户",
                false,
                None,
            );
        }
        if req.body.is_some_and(|b| b.len() > MAX_BODY_BYTES) {
            return error_reply(
                413,
                ErrorCode::INVALID_ARGUMENT.as_str(),
                "请求体超过 2 MiB",
                false,
                None,
            );
        }
        let method = req.method.to_ascii_uppercase();
        if !matches!(method.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE") {
            return error_reply(405, "METHOD_NOT_ALLOWED", "不支持的方法", false, None);
        }
        let (segments, query) = match parse_target(req.target) {
            Ok(t) => t,
            Err(reply) => return reply,
        };
        let (route, params) = match routes::find(&method, &segments) {
            routes::Matched::Route(route, params) => (route, params),
            routes::Matched::WrongMethod => {
                return error_reply(
                    405,
                    "METHOD_NOT_ALLOWED",
                    "这个接口不接受这个方法",
                    false,
                    None,
                );
            }
            routes::Matched::NotFound => return not_found(),
        };
        let input = match input::Input::parse(params, query, req.body, route.method) {
            Ok(i) => i,
            Err(reply) => return reply,
        };
        handlers::handle(self, principal, route, &input)
    }
}

/// WebView 里可信顶层文档发来的请求：宿主核对完来源、框架、方法白名单与大小之后才调（03 U1–U9）。
pub fn webview(generation: u64, epoch: u64) -> Principal {
    Principal::trusted_ui(UiSurface::WebView { generation, epoch })
}

/// 托盘菜单（03 §2.4：只有白名单里的动作）。
pub fn tray() -> Principal {
    Principal::trusted_ui(UiSurface::Tray)
}
