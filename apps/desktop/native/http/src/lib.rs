//! Agent HTTP（方案 §1、§7；03 §1.1、§2.2；W4b 传输骨架）。
//!
//! 只监听 `127.0.0.1`，只产生 `Principal::Agent`（P-002：这里没有任何办法得到 User）。
//! 每个请求在读 body 之前依次过：Host → Origin / Sec-Fetch → 体积 → Bearer → content-type。
//! 任何一关不过都回统一信封（11 §3），`committed:false`——什么都还没执行。
//!
//! service 是同步的：处理器经 [`Calls::run`] 进有界的阻塞池；准入等不到就回 `STORE_BUSY`
//! （00 Q-02：保证没提交，同一调用稍后重试安全），受理之后一定执行完。

#![allow(
    clippy::result_large_err,
    reason = "Envelope 是本 crate 唯一的错误形状，只出现在拒绝路径上；装箱只会让每个调用点更啰嗦"
)]

pub mod agent;
pub mod fix;
pub mod mcp;
pub mod resolve;
pub mod rest;
pub mod schema;
pub mod tools;
pub mod workspace;
pub mod write;

use atm_domain::error::{Committed, DomainError, Envelope, ErrorCode, Fix, Problem, ProblemKind};
use atm_domain::principal::Principal;
use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::Semaphore;

/// 请求体上限（03 §1.1：与 2.0 相同，10 MiB）。超限在解析之前拒绝。
pub const MAX_BODY: usize = 10 * 1024 * 1024;

/// `X-ATM-Client`（10 R11 A4）：桥按客户端身份组成的连接组，只用来分组与判断客户端存活，不是凭据。
pub const CLIENT_HEADER: &str = "x-atm-client";
const CLIENT_MAX: usize = 256;

/// 唯一的 HTTP 凭证（03 C-01：2.0 的用户令牌与单令牌模式都取消了）。
#[derive(Clone)]
pub struct Token(Arc<str>);

impl Token {
    /// 每次启动随机生成（由运行时负责），至少 32 个可见 ASCII 字符。
    pub fn new(value: impl Into<String>) -> Result<Token, String> {
        let value = value.into();
        if value.len() < 32 || !value.bytes().all(|b| b.is_ascii_graphic()) {
            return Err("the token must be at least 32 visible ASCII characters".into());
        }
        Ok(Token(value.into()))
    }

    /// 常量时间比较：耗时只取决于长度，不取决于第几个字节不同。
    fn matches(&self, presented: &[u8]) -> bool {
        let expected = self.0.as_bytes();
        expected.len() == presented.len()
            && expected
                .iter()
                .zip(presented)
                .fold(0u8, |acc, (a, b)| acc | (a ^ b))
                == 0
    }
}

impl std::fmt::Debug for Token {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Token(..)")
    }
}

/// 有界的阻塞调用池：同步的 service 在这里执行。
#[derive(Clone)]
pub struct Calls {
    permits: Arc<Semaphore>,
    admit: Duration,
}

impl Calls {
    /// `parallel`：同时在执行的调用上限；`admit`：等准入的上限，超过就是 `STORE_BUSY`。
    pub fn new(parallel: usize, admit: Duration) -> Calls {
        Calls {
            permits: Arc::new(Semaphore::new(parallel.max(1))),
            admit,
        }
    }

    /// 准入之后在阻塞线程里执行 `f`。准入超时回 `STORE_BUSY`，`f` 没有执行。
    pub async fn run<T, F>(&self, f: F) -> Result<T, Envelope>
    where
        F: FnOnce() -> T + Send + 'static,
        T: Send + 'static,
    {
        let permit =
            match tokio::time::timeout(self.admit, self.permits.clone().acquire_owned()).await {
                Ok(Ok(permit)) => permit,
                _ => {
                    return Err(refuse(
                        DomainError::new(ErrorCode::STORE_BUSY, "服务正忙，这次调用没有执行")
                            .detail("committed", false),
                        Fix::Wait {
                            retry_after_ms: 1000,
                            call: None,
                        },
                    ));
                }
            };
        // 受理之后一定执行完（00 Q-02）：调用方断开也不取消。
        tokio::task::spawn_blocking(move || {
            let out = f();
            drop(permit);
            out
        })
        .await
        .map_err(|_| {
            refuse_unknown(DomainError::new(
                ErrorCode::INTERNAL_ERROR,
                "服务内部错误，这次调用的结果未知",
            ))
        })
    }
}

/// 一个监听器的全部状态。
#[derive(Clone)]
pub struct AppState {
    token: Token,
    /// `127.0.0.1:<端口>`：Host 头必须逐字节等于它（挡 DNS rebinding）。
    host: Arc<str>,
    pub calls: Calls,
    health: Arc<dyn Fn() -> Value + Send + Sync>,
}

impl AppState {
    pub fn new(
        listener: &TcpListener,
        token: Token,
        calls: Calls,
        health: impl Fn() -> Value + Send + Sync + 'static,
    ) -> std::io::Result<AppState> {
        let addr = listener.local_addr()?;
        if !addr.ip().is_loopback() || !addr.is_ipv4() {
            return Err(std::io::Error::other(format!(
                "the Agent HTTP listens on 127.0.0.1 only, not {addr}"
            )));
        }
        Ok(AppState {
            token,
            host: format!("127.0.0.1:{}", addr.port()).into(),
            calls,
            health: Arc::new(health),
        })
    }
}

/// 绑定 `127.0.0.1` 的随机端口。
pub async fn bind() -> std::io::Result<TcpListener> {
    TcpListener::bind(("127.0.0.1", 0)).await
}

/// 把业务路由包上传输守卫、`/health` 与统一的 404 / 405。
pub fn app(state: AppState, routes: Router<AppState>) -> Router {
    routes
        .route("/health", get(health))
        .fallback(not_found)
        .method_not_allowed_fallback(method_not_allowed)
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

/// 起服务，直到 `shutdown` 完成。
pub async fn serve(
    listener: TcpListener,
    app: Router,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await
}

async fn health(State(state): State<AppState>) -> Response {
    (StatusCode::OK, json((state.health)())).into_response()
}

pub(crate) async fn not_found() -> Response {
    reply(refuse(
        DomainError::new(ErrorCode::NOT_FOUND, "没有这个入口"),
        Fix::None,
    ))
}

async fn method_not_allowed() -> Response {
    reply(refuse(
        DomainError::new(ErrorCode::METHOD_NOT_ALLOWED, "这个入口不接受这种方法"),
        Fix::None,
    ))
}

/// 传输守卫：顺序就是检查顺序，全部在读 body 之前。
async fn guard(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let headers = request.headers();
    let host = headers.get(header::HOST).map(|v| v.as_bytes());
    if host != Some(state.host.as_bytes()) {
        return reply(refuse(
            DomainError::new(ErrorCode::FORBIDDEN, "Host 不是本服务的回环地址"),
            Fix::None,
        ));
    }
    // 浏览器发来的请求一律拒绝：Agent 客户端不带 Origin，也不带 Sec-Fetch-*（界面不走 HTTP）。
    if headers.contains_key(header::ORIGIN)
        || headers.keys().any(|k| k.as_str().starts_with("sec-fetch-"))
    {
        return reply(refuse(
            DomainError::new(ErrorCode::FORBIDDEN, "不接受来自浏览器页面的请求"),
            Fix::None,
        ));
    }
    if let Some(len) = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        && len > MAX_BODY as u64
    {
        return reply(too_large(len as usize - MAX_BODY));
    }
    // `GET /health` 不要令牌（W4i）：setup 核对 SERVICE_HEALTHY 时探它，而 setup 从不读、不留令牌。
    // 它只答运行状态（status、version、pid、实例 id、lease 序号），没有令牌，也没有业务内容；
    // Host、Origin 与 Sec-Fetch 的检查照旧在前面。
    let health = request.method() == Method::GET && request.uri().path() == "/health";
    let presented = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.as_bytes().strip_prefix(b"Bearer "))
        .unwrap_or_default();
    if !health && !state.token.matches(presented) {
        return reply(refuse(
            DomainError::new(ErrorCode::UNAUTHORIZED, "ATM 令牌不对或已失效"),
            Fix::AskUser {
                message: "ATM 已重启或令牌失效：请重启 Agent 客户端，让 atm-mcp 重新读取服务描述"
                    .into(),
            },
        ));
    }
    if request.method() == Method::POST {
        let json_type = headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(';').next())
            .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/json"));
        if !json_type {
            return reply(refuse(
                DomainError::invalid_argument(vec![
                    Problem::new("header:content-type", ProblemKind::Enum)
                        .allowed("application/json"),
                ]),
                Fix::None,
            ));
        }
    }
    next.run(request).await
}

/// `X-ATM-Client` 的规范值：可见 ASCII、不超过 256 字节；缺省是 `None`（直连的 CLI 等）。
fn client_group(headers: &HeaderMap) -> Result<Option<String>, Envelope> {
    let Some(value) = headers.get(CLIENT_HEADER) else {
        return Ok(None);
    };
    let text = value.to_str().unwrap_or_default().trim();
    if text.is_empty()
        || text.len() > CLIENT_MAX
        || !text.bytes().all(|b| b.is_ascii_graphic() || b == b' ')
    {
        return Err(refuse(
            DomainError::invalid_argument(vec![
                Problem::new("header:x-atm-client", ProblemKind::Pattern)
                    .allowed(format!("1..={CLIENT_MAX} visible ASCII characters")),
            ]),
            Fix::None,
        ));
    }
    Ok(Some(text.to_owned()))
}

/// 处理器拿到的主体：Bearer 已经通过（守卫在前），这里只构造 Agent。
pub struct Agent(pub Principal);

impl<S: Send + Sync> FromRequestParts<S> for Agent {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        let group = client_group(&parts.headers).map_err(reply)?;
        Ok(Agent(Principal::authenticated_agent(group)))
    }
}

/// 请求体：按上限读完（分块传输也封顶），再按 JSON 解析。孤立代理字符是 `INVALID_ARGUMENT`（00 C-18）。
pub async fn read_json(body: Body) -> Result<Value, Envelope> {
    let bytes: Bytes = axum::body::to_bytes(body, MAX_BODY)
        .await
        .map_err(|_| too_large(1))?;
    serde_json::from_slice(&bytes).map_err(|e| {
        let surrogate = has_lone_surrogate(&bytes);
        refuse(
            DomainError::invalid_argument(vec![Problem::new("$", ProblemKind::Pattern).got(
                if surrogate {
                    "a lone UTF-16 surrogate".to_owned()
                } else {
                    format!("invalid JSON: {e}")
                },
            )]),
            Fix::None,
        )
    })
}

/// JSON 文本里有没有不成对的 `\uD800`～`\uDFFF` 转义（00 C-18）。只在解析失败后调用，用来给出准确的原因。
/// 转义的反斜杠（`\\`）成对跳过，所以 `\\ud800` 不算。
fn has_lone_surrogate(bytes: &[u8]) -> bool {
    let unit = |i: usize| -> Option<u16> {
        let hex = bytes.get(i..i + 4)?;
        u16::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()
    };
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'\\' {
            i += 1;
            continue;
        }
        if bytes.get(i + 1) != Some(&b'u') {
            i += 2;
            continue;
        }
        let Some(u) = unit(i + 2) else {
            i += 2;
            continue;
        };
        match u {
            0xD800..=0xDBFF => {
                let low = (bytes.get(i + 6) == Some(&b'\\') && bytes.get(i + 7) == Some(&b'u'))
                    .then(|| unit(i + 8))
                    .flatten();
                if !matches!(low, Some(0xDC00..=0xDFFF)) {
                    return true;
                }
                i += 12;
            }
            0xDC00..=0xDFFF => return true,
            _ => i += 6,
        }
    }
    false
}

fn too_large(over_by: usize) -> Envelope {
    refuse(
        DomainError::invalid_argument(vec![
            Problem::new("$", ProblemKind::TooLong)
                .allowed(MAX_BODY)
                .over_by(over_by),
        ]),
        Fix::None,
    )
}

/// 还没执行就拒绝的信封。
pub fn refuse(error: DomainError, fix: Fix) -> Envelope {
    Envelope::new(error, Committed::No, None, fix)
}

fn refuse_unknown(error: DomainError) -> Envelope {
    Envelope::new(error, Committed::Unknown, None, Fix::None)
}

/// 信封 → 响应：HTTP 状态按错误码（01 §7）。
pub fn reply(envelope: Envelope) -> Response {
    let status = StatusCode::from_u16(envelope.code.http_status())
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let body = serde_json::to_value(&envelope).unwrap_or(Value::Null);
    (status, json(body)).into_response()
}

fn json(body: Value) -> Response {
    (
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::to_vec(&body).unwrap_or_default(),
    )
        .into_response()
}
