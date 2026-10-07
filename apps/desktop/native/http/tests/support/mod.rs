//! http 端到端用例的共用夹具：新库 + 真实服务 + 真实监听器，原始 HTTP 发 JSON-RPC。
#![allow(dead_code)]

use atm_domain::principal::Principal;
use atm_http::agent::Surface;
use atm_http::mcp::routes;
use atm_http::tools::PROFILES;
use atm_http::{AppState, Calls, Token, app, bind, serve};
use atm_service::session::BeginRequest;
use atm_service::work::{CreateItem, Target};
use atm_service::write::Service;
use atm_store::{Config, Store};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

pub const TOKEN: &str = "test-token-0123456789abcdef0123456789abcdef";

pub struct World {
    pub port: u16,
    pub svc: Arc<Service>,
    pub project: String,
    pub project_id: String,
    pub session: String,
    pub task: String,
    pub dir: PathBuf,
    pub _rt: tokio::runtime::Runtime,
}

pub fn test_dir(name: &str) -> PathBuf {
    std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("target")
        })
        .join("http-tests")
        .join(name)
}

/// 一个新库：建项目与 session（begin），建一个任务。
pub fn world(name: &str) -> World {
    let dir = test_dir(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let store = Store::open(&dir.join("atm.sqlite"), Config::default()).unwrap();
    store
        .write(move |tx| {
            tx.execute_batch(
                "INSERT INTO app_meta (singleton, schema_version, data_root_id, generation, instance_epoch, created_at, updated_at)
                 VALUES (1, 1, 'ROOT', 'G', 'EPOCH', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z')",
            )
        })
        .unwrap();
    let svc = Arc::new(Service::new(store).with_backups_root(dir.join("backups")));
    let agent = Principal::authenticated_agent(None);
    let mut begin = BeginRequest::new("claude-code");
    begin.title = Some("演示".into());
    begin.mode = Some("project".into());
    begin.allow_project_create = true;
    begin.op_id = Some("begin-1".into());
    let begun = svc.begin(&agent, begin).unwrap();
    let project = begun.result["project"]["code"].as_str().unwrap().to_owned();
    let session = begun.result["session"]["id"].as_str().unwrap().to_owned();
    let project_id = svc.project_id(&agent, &project).unwrap();
    let item = CreateItem {
        title: "第一个任务".into(),
        acceptance: vec!["写完 `docs/a.md`".into()],
        ..CreateItem::default()
    };
    let created = svc
        .create_work_items(
            &agent,
            &Target::new(&project_id, Some(&session), "create-1"),
            vec![item],
        )
        .unwrap();
    let task = created.result["items"][0]["key"]
        .as_str()
        .unwrap()
        .to_owned();

    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let surface = Surface::new(svc.clone());
    let port = rt.block_on(async move {
        let listener = bind().await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = AppState::new(
            &listener,
            Token::new(TOKEN).unwrap(),
            Calls::new(4, Duration::from_secs(5)),
            || json!({}),
        )
        .unwrap();
        tokio::spawn(serve(
            listener,
            app(state, routes(&PROFILES, surface.handler())),
            std::future::pending::<()>(),
        ));
        port
    });
    World {
        port,
        svc,
        project,
        project_id,
        session,
        task,
        dir,
        _rt: rt,
    }
}

/// 原始 HTTP：返回 (状态码, body 文本)。
pub fn http(port: u16, method: &str, path: &str, body: &str) -> (u16, String) {
    http_as(port, None, method, path, body)
}

/// 带 `X-ATM-Client`（A4 的连接组身份）的原始 HTTP。
pub fn http_as(
    port: u16,
    client: Option<&str>,
    method: &str,
    path: &str,
    body: &str,
) -> (u16, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
    let client = client.map_or_else(String::new, |c| format!("X-ATM-Client: {c}\r\n"));
    let req = format!(
        "{method} {path} HTTP/1.1\r\nConnection: close\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {TOKEN}\r\n\
         Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\n{client}Content-Length: {}\r\n\r\n{body}",
        body.len()
    );
    s.write_all(req.as_bytes()).unwrap();
    let mut out = Vec::new();
    let _ = s.read_to_end(&mut out);
    let text = String::from_utf8_lossy(&out).into_owned();
    let status = text
        .split(' ')
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    (
        status,
        text.split("\r\n\r\n").nth(1).unwrap_or_default().to_owned(),
    )
}

pub fn rpc(w: &World, profile: &str, method: &str, params: Value) -> Value {
    rpc_as(w, None, profile, method, params)
}

pub fn rpc_as(
    w: &World,
    client: Option<&str>,
    profile: &str,
    method: &str,
    params: Value,
) -> Value {
    let body = json!({"jsonrpc": "2.0", "id": 7, "method": method, "params": params}).to_string();
    let (status, text) = http_as(w.port, client, "POST", &format!("/mcp/{profile}"), &body);
    assert_eq!(status, 200, "{text}");
    let v: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        (v["jsonrpc"].as_str(), v["id"].as_i64()),
        (Some("2.0"), Some(7)),
        "{v}"
    );
    v
}

pub fn call(w: &World, profile: &str, tool: &str, args: Value) -> Value {
    call_as(w, None, profile, tool, args)
}

/// 以某个连接组的身份调用工具。
pub fn call_as(w: &World, client: Option<&str>, profile: &str, tool: &str, args: Value) -> Value {
    rpc_as(
        w,
        client,
        profile,
        "tools/call",
        json!({"name": tool, "arguments": args}),
    )["result"]
        .clone()
}
