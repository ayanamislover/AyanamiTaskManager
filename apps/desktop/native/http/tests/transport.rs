//! W4b 传输守卫（03 §1.1、§2.2；P-002；00 Q-02、C-18）：起真实的监听器，用原始 TCP 手写请求，
//! 每个头都由用例精确控制。

use atm_http::{Agent, AppState, Calls, MAX_BODY, Token, app, bind, read_json, reply, serve};
use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

const TOKEN: &str = "test-token-0123456789abcdef0123456789abcdef";

struct Server {
    port: u16,
    ran: Arc<AtomicUsize>,
    _rt: tokio::runtime::Runtime,
}

/// `/echo`：回显主体与解析后的 body。`/slow`：在阻塞池里睡 `ms` 毫秒，计数执行过几次。
fn start(calls: Calls) -> Server {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let ran = Arc::new(AtomicUsize::new(0));
    let counter = ran.clone();
    let port = rt.block_on(async move {
        let listener = bind().await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = AppState::new(
            &listener,
            Token::new(TOKEN).unwrap(),
            calls,
            || json!({"impl": "rust", "layout": "single"}),
        )
        .unwrap();
        let routes = Router::new()
            .route("/echo", routing::post(echo))
            .route("/slow", routing::post(slow))
            .layer(axum::Extension(counter));
        tokio::spawn(serve(
            listener,
            app(state, routes),
            std::future::pending::<()>(),
        ));
        port
    });
    Server { port, ran, _rt: rt }
}

async fn echo(Agent(principal): Agent, body: Body) -> Response {
    match read_json(body).await {
        Ok(v) => ok(json!({
            "kind": principal.kind().as_str(),
            "group": principal.client_group(),
            "body": v,
        })),
        Err(e) => reply(e),
    }
}

async fn slow(
    State(state): State<AppState>,
    axum::Extension(ran): axum::Extension<Arc<AtomicUsize>>,
    body: Body,
) -> Response {
    let ms = match read_json(body).await {
        Ok(v) => v["ms"].as_u64().unwrap_or(0),
        Err(e) => return reply(e),
    };
    match state
        .calls
        .run(move || {
            std::thread::sleep(Duration::from_millis(ms));
            ran.fetch_add(1, Ordering::SeqCst);
        })
        .await
    {
        Ok(()) => ok(json!({"ok": true})),
        Err(e) => reply(e),
    }
}

fn ok(v: Value) -> Response {
    (
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        v.to_string(),
    )
        .into_response()
}

/// 发一个原始请求，返回 (状态码, JSON body)。
fn raw(port: u16, request: &[u8]) -> (u16, Value) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
    s.write_all(request).unwrap();
    let mut out = Vec::new();
    let _ = s.read_to_end(&mut out);
    let text = String::from_utf8_lossy(&out).into_owned();
    let status = text
        .split(' ')
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let body = text.split("\r\n\r\n").nth(1).unwrap_or_default();
    (status, serde_json::from_str(body).unwrap_or(Value::Null))
}

/// 一个合规的 POST，`extra` 是追加或覆盖的头（`Name: value` 行）。`host`、`token` 为 `None` 时不带。
fn post_with(
    port: u16,
    path: &str,
    host: Option<&str>,
    token: Option<&str>,
    extra: &[&str],
    body: &[u8],
) -> (u16, Value) {
    let mut head = format!("POST {path} HTTP/1.1\r\nConnection: close\r\n");
    if let Some(h) = host {
        head += &format!("Host: {h}\r\n");
    }
    if let Some(t) = token {
        head += &format!("Authorization: Bearer {t}\r\n");
    }
    if !extra
        .iter()
        .any(|e| e.to_ascii_lowercase().starts_with("content-type"))
    {
        head += "Content-Type: application/json\r\n";
    }
    for e in extra {
        head += &format!("{e}\r\n");
    }
    head += &format!("Content-Length: {}\r\n\r\n", body.len());
    let mut req = head.into_bytes();
    req.extend_from_slice(body);
    raw(port, &req)
}

fn post(s: &Server, path: &str, extra: &[&str], body: &[u8]) -> (u16, Value) {
    let host = format!("127.0.0.1:{}", s.port);
    post_with(s.port, path, Some(&host), Some(TOKEN), extra, body)
}

fn code(v: &Value) -> &str {
    v["code"].as_str().unwrap_or("")
}

fn server() -> Server {
    start(Calls::new(4, Duration::from_secs(5)))
}

/// 合规的请求得到 Agent 主体（P-002：HTTP 永远不产生 User），`X-ATM-Client` 只作连接组。
#[test]
fn a_valid_request_is_an_agent() {
    let s = server();
    let (status, v) = post(&s, "/echo", &[], br#"{"x":1}"#);
    assert_eq!(status, 200, "{v}");
    assert_eq!(v["kind"], "AGENT");
    assert_eq!(v["group"], Value::Null);
    assert_eq!(v["body"], json!({"x": 1}));

    let (status, v) = post(
        &s,
        "/echo",
        &["X-ATM-Client: claude-code/2.1; pid=42; created=1790000000000"],
        b"{}",
    );
    assert_eq!(status, 200, "{v}");
    assert_eq!(v["kind"], "AGENT");
    assert_eq!(v["group"], "claude-code/2.1; pid=42; created=1790000000000");

    let long = format!("X-ATM-Client: {}", "a".repeat(257));
    for bad in ["X-ATM-Client: ", "X-ATM-Client: caf\u{e9}", long.as_str()] {
        let (status, v) = post(&s, "/echo", &[bad], b"{}");
        assert_eq!((status, code(&v)), (400, "INVALID_ARGUMENT"), "{bad}: {v}");
    }
}

/// 令牌：缺、错、前缀不对、长度不同都是 401，信封说明「没有执行」并给出出路。
#[test]
fn a_wrong_or_missing_token_is_unauthorized() {
    let s = server();
    let host = format!("127.0.0.1:{}", s.port);
    let wrong = format!("{}x", &TOKEN[..TOKEN.len() - 1]);
    for token in [None, Some(""), Some(wrong.as_str()), Some(&TOKEN[1..])] {
        let (status, v) = post_with(s.port, "/echo", Some(&host), token, &[], b"{}");
        assert_eq!((status, code(&v)), (401, "UNAUTHORIZED"), "{token:?}: {v}");
        assert_eq!(v["committed"], false);
        assert_eq!(v["fix"]["kind"], "ask_user");
    }
    let (status, v) = post_with(
        s.port,
        "/echo",
        Some(&host),
        None,
        &[&format!("Authorization: Basic {TOKEN}")],
        b"{}",
    );
    assert_eq!((status, code(&v)), (401, "UNAUTHORIZED"), "{v}");
    assert!(Token::new("short").is_err());
    assert!(Token::new(format!("{}\u{e9}", "a".repeat(40))).is_err());
}

/// Host 必须逐字节是 `127.0.0.1:<端口>`：别的名字（DNS rebinding）、别的端口、缺省都拒绝，令牌对也不行。
#[test]
fn the_host_must_be_this_loopback_listener() {
    let s = server();
    let other_port = format!("127.0.0.1:{}", s.port.wrapping_add(1));
    let localhost = format!("localhost:{}", s.port);
    let rebinding = format!("attacker.example:{}", s.port);
    for host in [
        None,
        Some(localhost.as_str()),
        Some(rebinding.as_str()),
        Some(other_port.as_str()),
        Some("127.0.0.1"),
    ] {
        let (status, v) = post_with(s.port, "/echo", host, Some(TOKEN), &[], b"{}");
        assert_eq!((status, code(&v)), (403, "FORBIDDEN"), "{host:?}: {v}");
    }
}

/// 浏览器来的请求一律拒绝：带 Origin（回环地址也算）或任何 Sec-Fetch-* 头，令牌对也不行。
#[test]
fn browser_requests_are_refused() {
    let s = server();
    let own = format!("Origin: http://127.0.0.1:{}", s.port);
    for extra in [
        own.as_str(),
        "Origin: http://localhost",
        "Origin: null",
        "Sec-Fetch-Site: same-origin",
        "Sec-Fetch-Mode: cors",
    ] {
        let (status, v) = post(&s, "/echo", &[extra], b"{}");
        assert_eq!((status, code(&v)), (403, "FORBIDDEN"), "{extra}: {v}");
        assert_eq!(v["committed"], false);
    }
}

/// 体积：声明超限的在鉴权之前就拒绝（不读 body）；不声明长度的分块传输读到上限就停。
#[test]
fn oversized_bodies_are_refused_before_parsing() {
    let s = server();
    let host = format!("127.0.0.1:{}", s.port);
    // 只发头，声明 10 MiB + 1：守卫看长度就拒绝，令牌也还没查。
    let head = format!(
        "POST /echo HTTP/1.1\r\nConnection: close\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
        MAX_BODY + 1
    );
    let (status, v) = raw(s.port, head.as_bytes());
    assert_eq!((status, code(&v)), (400, "INVALID_ARGUMENT"), "{v}");
    assert_eq!(v["details"]["problems"][0]["problem"], "too_long");
    assert_eq!(v["details"]["problems"][0]["over_by"], 1);

    // 分块：一块 MAX_BODY + 1 字节的合法 JSON 字符串。
    let payload = format!("\"{}\"", "a".repeat(MAX_BODY - 1));
    let mut req = format!(
        "POST /echo HTTP/1.1\r\nConnection: close\r\nHost: {host}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n",
        payload.len()
    )
    .into_bytes();
    req.extend_from_slice(payload.as_bytes());
    req.extend_from_slice(b"\r\n0\r\n\r\n");
    let (status, v) = raw(s.port, &req);
    assert_eq!((status, code(&v)), (400, "INVALID_ARGUMENT"), "{v}");
    assert_eq!(v["details"]["problems"][0]["problem"], "too_long");

    // 正好在上限以内的照常处理。
    let fits = format!("\"{}\"", "a".repeat(MAX_BODY - 2));
    let (status, v) = post(&s, "/echo", &[], fits.as_bytes());
    assert_eq!(status, 200, "{}", code(&v));
}

/// POST 只收 JSON；坏 JSON 与孤立代理字符（00 C-18）都是 INVALID_ARGUMENT。
#[test]
fn bodies_must_be_valid_json() {
    let s = server();
    for ct in [
        "Content-Type: text/plain",
        "Content-Type: application/jsonx",
    ] {
        let (status, v) = post(&s, "/echo", &[ct], b"{}");
        assert_eq!((status, code(&v)), (400, "INVALID_ARGUMENT"), "{ct}: {v}");
        assert_eq!(v["details"]["problems"][0]["path"], "header:content-type");
    }
    let (status, _) = post(
        &s,
        "/echo",
        &["Content-Type: application/json; charset=utf-8"],
        b"{}",
    );
    assert_eq!(status, 200);

    for (body, needle) in [
        (&br#"{"x":"\ud800"}"#[..], "surrogate"),
        (&br#"{"x":"\udc00z"}"#[..], "surrogate"),
        (&br#"{"x":"\ud800\u0041"}"#[..], "surrogate"),
        // 转义的反斜杠后面的 ud800 只是普通文本：坏的是 JSON 本身。
        (&br#"{"x":"\\ud800""#[..], "invalid JSON"),
        (&b"{\"x\":"[..], "invalid JSON"),
        (&b"\xff"[..], "invalid JSON"),
    ] {
        let (status, v) = post(&s, "/echo", &[], body);
        assert_eq!((status, code(&v)), (400, "INVALID_ARGUMENT"), "{v}");
        // 代理字符是精确的原因（serde_json 自己的报错原文里也可能有 surrogate 一词）；其余是解析器原文。
        let got = v["details"]["problems"][0]["got"].as_str().unwrap_or("");
        match needle {
            "surrogate" => assert_eq!(got, "a lone UTF-16 surrogate"),
            _ => assert!(got.starts_with("invalid JSON: "), "{got}"),
        }
    }
    // 成对的代理是正常字符。
    let (status, v) = post(&s, "/echo", &[], br#"{"x":"\ud83d\ude00"}"#);
    assert_eq!((status, v["body"]["x"].as_str()), (200, Some("\u{1f600}")));
}

/// 统一的 404 / 405，以及鉴权后的 /health。
#[test]
fn unknown_routes_and_methods_use_the_envelope() {
    let s = server();
    let (status, v) = post(&s, "/nope", &[], b"{}");
    assert_eq!((status, code(&v)), (404, "NOT_FOUND"), "{v}");
    let host = format!("127.0.0.1:{}", s.port);
    let get = |path: &str, token: &str| {
        raw(
            s.port,
            format!(
                "GET {path} HTTP/1.1\r\nConnection: close\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\n\r\n"
            )
            .as_bytes(),
        )
    };
    let (status, v) = get("/echo", TOKEN);
    assert_eq!((status, code(&v)), (405, "METHOD_NOT_ALLOWED"), "{v}");
    let (status, v) = get("/health", TOKEN);
    assert_eq!(
        (status, &v),
        (200, &json!({"impl": "rust", "layout": "single"}))
    );
    let (status, v) = get("/health", "wrong-token-wrong-token-wrong-token-xx");
    assert_eq!((status, code(&v)), (401, "UNAUTHORIZED"));
}

/// 阻塞池满：准入等不到就回 STORE_BUSY（503、可重试、committed:false），而且那次调用确实没有执行。
#[test]
fn a_full_pool_answers_store_busy_without_running() {
    let s = start(Calls::new(1, Duration::from_millis(200)));
    let port = s.port;
    let busy = std::thread::spawn(move || {
        let host = format!("127.0.0.1:{port}");
        post_with(
            port,
            "/slow",
            Some(&host),
            Some(TOKEN),
            &[],
            br#"{"ms":2000}"#,
        )
    });
    std::thread::sleep(Duration::from_millis(300));
    let (status, v) = post(&s, "/slow", &[], br#"{"ms":0}"#);
    assert_eq!((status, code(&v)), (503, "STORE_BUSY"), "{v}");
    assert_eq!(v["retryable"], true);
    assert_eq!(v["committed"], false);
    assert_eq!(v["fix"]["kind"], "wait");
    let (status, _) = busy.join().unwrap();
    assert_eq!(status, 200);
    assert_eq!(
        s.ran.load(Ordering::SeqCst),
        1,
        "the refused call must not run"
    );
    let (status, _) = post(&s, "/slow", &[], br#"{"ms":0}"#);
    assert_eq!(status, 200);
    assert_eq!(s.ran.load(Ordering::SeqCst), 2);
}

/// 只能绑回环 IPv4。
#[test]
fn the_listener_is_loopback_only() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let any = tokio::net::TcpListener::bind(("0.0.0.0", 0)).await.unwrap();
        let state = AppState::new(
            &any,
            Token::new(TOKEN).unwrap(),
            Calls::new(1, Duration::from_secs(1)),
            || json!({}),
        );
        assert!(state.is_err());
        let ours = bind().await.unwrap();
        assert!(ours.local_addr().unwrap().ip().is_loopback());
    });
}

/// P-002 / M-04 的静态守卫：atm-http 里不构造 User，也没有第二种凭证。
#[test]
fn the_http_crate_has_no_user_principal_or_second_token() {
    fn sources(dir: &std::path::Path, out: &mut String) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                sources(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push_str(&std::fs::read_to_string(&path).unwrap());
            }
        }
    }
    let mut src = String::new();
    sources(
        std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src")),
        &mut src,
    );
    assert!(
        src.contains("pub struct Agent"),
        "the scan found no sources"
    );
    for banned in [
        "trusted_ui",
        "UiSurface",
        "user_token",
        "userToken",
        "PrincipalKind::User",
    ] {
        assert!(!src.contains(banned), "atm-http mentions {banned}");
    }
    assert_eq!(src.matches("authenticated_agent(").count(), 1);
}
