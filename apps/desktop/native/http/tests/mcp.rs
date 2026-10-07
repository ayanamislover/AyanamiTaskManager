//! W4c MCP 协议核心与读工具，经真实监听器与真实服务：initialize、通知、tools/list、tools/call、
//! 协议错误、参数校验信封、project 按 session 推出、对账视图、读时续租。

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

const TOKEN: &str = "test-token-0123456789abcdef0123456789abcdef";

struct World {
    port: u16,
    svc: Arc<Service>,
    project: String,
    project_id: String,
    session: String,
    task: String,
    _rt: tokio::runtime::Runtime,
}

fn test_dir(name: &str) -> PathBuf {
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
fn world(name: &str) -> World {
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
        _rt: rt,
    }
}

/// 原始 HTTP：返回 (状态码, body 文本)。
fn http(port: u16, method: &str, path: &str, body: &str) -> (u16, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
    let req = format!(
        "{method} {path} HTTP/1.1\r\nConnection: close\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {TOKEN}\r\n\
         Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\n\r\n{body}",
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

fn rpc(w: &World, profile: &str, method: &str, params: Value) -> Value {
    let body = json!({"jsonrpc": "2.0", "id": 7, "method": method, "params": params}).to_string();
    let (status, text) = http(w.port, "POST", &format!("/mcp/{profile}"), &body);
    assert_eq!(status, 200, "{text}");
    let v: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        (v["jsonrpc"].as_str(), v["id"].as_i64()),
        (Some("2.0"), Some(7)),
        "{v}"
    );
    v
}

fn call(w: &World, profile: &str, tool: &str, args: Value) -> Value {
    rpc(
        w,
        profile,
        "tools/call",
        json!({"name": tool, "arguments": args}),
    )["result"]
        .clone()
}

/// initialize：协议版本协商、能力、serverInfo、各 profile 的 instructions；通知 202；ping。
#[test]
fn initialize_negotiates_and_notifications_are_accepted() {
    let w = world("mcp-initialize");
    let r = rpc(
        &w,
        "core",
        "initialize",
        json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "claude-code", "version": "2"}}),
    );
    assert_eq!(r["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(r["result"]["capabilities"], json!({"tools": {}}));
    assert_eq!(r["result"]["serverInfo"]["name"], "ayanami-task-manager");
    assert!(
        r["result"]["instructions"]
            .as_str()
            .unwrap()
            .starts_with("MCP surface v6 · core")
    );
    let r = rpc(
        &w,
        "memory",
        "initialize",
        json!({"protocolVersion": "1999-01-01"}),
    );
    assert_eq!(r["result"]["protocolVersion"], "2025-11-25");
    assert!(
        r["result"]["instructions"]
            .as_str()
            .unwrap()
            .contains("memory")
    );
    let (status, body) = http(
        w.port,
        "POST",
        "/mcp/core",
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
    );
    assert_eq!((status, body.as_str()), (202, ""));
    assert_eq!(rpc(&w, "core", "ping", json!({}))["result"], json!({}));
}

/// tools/list 与快照同源；GET / DELETE 405；协议错误走 JSON-RPC error。
#[test]
fn listing_and_protocol_errors() {
    let w = world("mcp-protocol");
    for p in &PROFILES {
        let listed = rpc(&w, p.name, "tools/list", json!({}))["result"]["tools"].clone();
        assert_eq!(listed, Value::Array(p.tools_json()), "{}", p.name);
    }
    for method in ["GET", "DELETE"] {
        let (status, body) = http(w.port, method, "/mcp/core", "");
        assert_eq!(status, 405, "{body}");
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap()["code"],
            "METHOD_NOT_ALLOWED"
        );
    }
    let r = rpc(&w, "core", "resources/list", json!({}));
    assert_eq!(r["error"]["code"], -32601);
    let r = rpc(
        &w,
        "memory",
        "tools/call",
        json!({"name": "atm_task_patch", "arguments": {}}),
    );
    assert_eq!(
        r["error"]["code"], -32602,
        "task_patch is not on memory: {r}"
    );
    let (status, body) = http(
        w.port,
        "POST",
        "/mcp/core",
        r#"[{"jsonrpc":"2.0","id":1,"method":"ping"}]"#,
    );
    assert_eq!(status, 200);
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["error"]["code"],
        -32600
    );
    let (_, body) = http(
        w.port,
        "POST",
        "/mcp/core",
        r#"{"jsonrpc":"1.0","id":1,"method":"ping"}"#,
    );
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["error"]["code"],
        -32600
    );
    let (_, body) = http(w.port, "POST", "/mcp/core", r#"{"jsonrpc":"2.0","id":1,"#);
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["error"]["code"],
        -32700
    );
}

/// 读工具成功：别名改名，结果同时在 structuredContent 与 content 文本里。
#[test]
fn read_tools_answer_with_structured_content() {
    let w = world("mcp-read");
    let r = call(
        &w,
        "core",
        "atm_task_get",
        json!({"key": w.task, "project_code": w.project.to_lowercase()}),
    );
    assert_eq!(r["isError"], Value::Null, "{r}");
    assert_eq!(r["structuredContent"]["key"], w.task.as_str(), "{r}");
    let text: Value = serde_json::from_str(r["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(text, r["structuredContent"]);
    let r = call(
        &w,
        "core",
        "atm_task_list",
        json!({"project": w.project, "status": "open"}),
    );
    assert_eq!(
        r["structuredContent"]["items"][0]["key"],
        w.task.as_str(),
        "{r}"
    );
    let r = call(&w, "memory", "atm_search", json!({"query": w.task}));
    assert_eq!(r["isError"], Value::Null, "{r}");
    // 不发布的旧工具照常可调。
    let r = call(&w, "memory", "atm_delta", json!({"project": w.project}));
    assert_eq!(r["isError"], Value::Null, "{r}");
    // actions 上 core 工具照常可调（别名）。
    let r = call(
        &w,
        "actions",
        "atm_task_get",
        json!({"task_key": w.task, "project": w.project}),
    );
    assert_eq!(r["structuredContent"]["key"], w.task.as_str(), "{r}");
}

/// 参数错误是工具结果（isError）而不是协议错误：信封带 problems、committed:false，
/// 能自动更正时 fix.call 是更正后的完整调用，content 文本里也有 code 与 fix。
#[test]
fn invalid_arguments_come_back_as_an_envelope_with_a_fix() {
    let w = world("mcp-invalid");
    let r = call(
        &w,
        "core",
        "atm_task_get",
        json!({"taskkey": w.task, "project": w.project, "view": "ful"}),
    );
    assert_eq!(r["isError"], true, "{r}");
    let e = &r["structuredContent"];
    assert_eq!(
        (
            e["ok"].as_bool(),
            e["code"].as_str(),
            e["committed"].as_bool()
        ),
        (Some(false), Some("INVALID_ARGUMENT"), Some(false))
    );
    let problems: Vec<(&str, &str)> = e["details"]["problems"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            (
                p["path"].as_str().unwrap(),
                p["did_you_mean"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(problems, [("taskkey", "task_key"), ("view", "full")]);
    assert_eq!(e["fix"]["kind"], "call");
    assert_eq!(e["fix"]["call"]["name"], "atm_task_get");
    let fixed = e["fix"]["call"]["arguments"].clone();
    assert_eq!(
        fixed,
        json!({"task_key": w.task, "project": w.project, "view": "full"})
    );
    let text = r["content"][0]["text"].as_str().unwrap();
    assert!(
        text.starts_with("INVALID_ARGUMENT: ") && text.contains("\"kind\":\"call\""),
        "{text}"
    );
    // fix.call 原样执行一次就成功（U-3 的形状）。
    let again = call(&w, "core", "atm_task_get", fixed);
    assert_eq!(again["isError"], Value::Null, "{again}");
}

/// 省略 project 时按 session 推出；两者都没有是 SESSION_REQUIRED。
#[test]
fn the_project_follows_the_session() {
    let w = world("mcp-scope");
    let r = call(&w, "core", "atm_brief", json!({"session": w.session}));
    assert_eq!(r["isError"], Value::Null, "{r}");
    assert_eq!(r["structuredContent"]["project"], w.project.as_str(), "{r}");
    let r = call(&w, "core", "atm_brief", json!({}));
    assert_eq!(r["structuredContent"]["code"], "SESSION_REQUIRED", "{r}");
    let r = call(
        &w,
        "core",
        "atm_task_list",
        json!({"session": w.session, "mine": true}),
    );
    assert_eq!(r["isError"], Value::Null, "{r}");
    let r = call(
        &w,
        "core",
        "atm_brief",
        json!({"session": "01NOSUCHSESSION0000000000"}),
    );
    assert_eq!(r["structuredContent"]["code"], "SESSION_NOT_FOUND", "{r}");
}

/// view=reconcile 经 task_list 走对账视图。
#[test]
fn task_list_serves_the_reconcile_view() {
    let w = world("mcp-reconcile");
    let r = call(
        &w,
        "core",
        "atm_task_list",
        json!({"project": w.project, "view": "reconcile", "include_active": true}),
    );
    let v = &r["structuredContent"];
    assert_eq!(v["view"], "reconcile", "{r}");
    assert_eq!(v["items"][0]["task_key"], w.task.as_str());
    assert_eq!(v["counts"]["ACTIVE"], 1);
}

/// owner 的读也续租（R11 P3）：带自己 session 的读把过期前的租约推到 now+10 分钟；不带 session 的读不写。
#[test]
fn owner_reads_renew_the_lease() {
    let w = world("mcp-renew");
    let agent = Principal::authenticated_agent(None);
    w.svc
        .patch_work_items(
            &agent,
            &Target::new(&w.project_id, Some(&w.session), "start-1"),
            vec![atm_service::work::PatchItem::new(
                &w.task,
                atm_domain::work::Operation::Start,
            )],
        )
        .unwrap();
    let lease = |w: &World| -> String {
        let no: i64 = w.task.rsplit('-').next().unwrap().parse().unwrap();
        w.svc
            .store()
            .read(|tx| {
                tx.query_row(
                    "SELECT claim_lease_until FROM work_items WHERE local_no = ?1",
                    [no],
                    |r| r.get(0),
                )
            })
            .unwrap()
    };
    let old = "2000-01-01T00:00:00.000Z";
    w.svc
        .store()
        .write(move |tx| {
            tx.execute_batch(&format!(
                "UPDATE work_items SET claim_lease_until = '{old}'"
            ))
        })
        .unwrap();
    call(
        &w,
        "core",
        "atm_task_get",
        json!({"task_key": w.task, "project": w.project}),
    );
    assert_eq!(lease(&w), old, "a read without a session must not write");
    call(
        &w,
        "core",
        "atm_task_get",
        json!({"task_key": w.task, "project": w.project, "session": w.session}),
    );
    let renewed = lease(&w);
    assert!(renewed.as_str() > "2026-01-01", "{renewed}");
}
