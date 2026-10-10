//! U-1（11 §5）冷启动 Agent 的被测服务：合成数据根上的真实 atm-http。按流程预置数据，发布 daemon.json 给
//! 真实的 atm-mcp.exe；`<root>/stop` 出现后把任务、记录、会话与项目导出到 `<root>/state.json`，撤下
//! daemon.json 退出。只用于沙箱：数据根、仓库目录都在 `<root>` 下，token 只写进 daemon.json。
//!
//! 用法：`u1-server <root> <W1..W9|A4> <agent_id> <client_name>`。`client_name` 是被测 CLI 的
//! `clientInfo.name`（W8 用它伪造一个已经退出的前任客户端）。

use atm_http::agent::Surface;
use atm_http::mcp::routes;
use atm_http::tools::PROFILES;
use atm_http::{AppState, Calls, Token, app, bind, serve};
use atm_service::write::Service;
use atm_store::{Config, Store};
use serde_json::{Value, json};
use std::hash::{BuildHasher, Hasher};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 预置数据用的连接组：不在单对话白名单里，所以每次都显式带 session。
const SETUP: &str = "1:1@u1-setup";

/// 每个 profile 上见过的连接组身份（`X-ATM-Client`，R11 A4）与带着它的 JSON-RPC 方法：真实客户端拉起的
/// core 与 memory 两个桥是不是同一组，没有客户端名的是哪些请求。
static SEEN: std::sync::Mutex<std::collections::BTreeSet<(String, String, String)>> =
    std::sync::Mutex::new(std::collections::BTreeSet::new());

async fn record_client(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let Some(profile) = req.uri().path().strip_prefix("/mcp/").map(str::to_owned) else {
        return next.run(req).await;
    };
    let client = req
        .headers()
        .get("x-atm-client")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let (parts, body) = req.into_parts();
    let bytes = axum::body::to_bytes(body, 4 * 1024 * 1024)
        .await
        .unwrap_or_default();
    let method = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|v| v["method"].as_str().map(str::to_owned))
        .unwrap_or_else(|| parts.method.to_string());
    SEEN.lock().unwrap().insert((profile, client, method));
    next.run(axum::extract::Request::from_parts(
        parts,
        axum::body::Body::from(bytes),
    ))
    .await
}

struct Rpc {
    port: u16,
    token: String,
}

impl Rpc {
    fn call(&self, client: &str, tool: &str, args: Value) -> Value {
        let body = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                          "params": {"name": tool, "arguments": args}})
        .to_string();
        // atm_search 在 memory profile 上；其余预置与导出用到的工具都在 core。
        let profile = if tool == "atm_search" {
            "memory"
        } else {
            "core"
        };
        let mut s = TcpStream::connect(("127.0.0.1", self.port)).expect("connect");
        s.set_read_timeout(Some(Duration::from_secs(60))).unwrap();
        let req = format!(
            "POST /mcp/{profile} HTTP/1.1\r\nConnection: close\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\n\
             Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\nX-ATM-Client: {client}\r\n\
             Content-Length: {}\r\n\r\n{body}",
            self.port,
            self.token,
            body.len()
        );
        s.write_all(req.as_bytes()).unwrap();
        let mut out = Vec::new();
        let _ = s.read_to_end(&mut out);
        let text = String::from_utf8_lossy(&out).into_owned();
        let v: Value = serde_json::from_str(text.split("\r\n\r\n").nth(1).unwrap_or("{}"))
            .unwrap_or(Value::Null);
        let result = v["result"].clone();
        assert!(
            result.is_object() && result["isError"] != json!(true),
            "预置 {tool} 失败：{v}"
        );
        result["structuredContent"].clone()
    }
}

fn random_hex(len: usize) -> String {
    let mut out = String::new();
    while out.len() < len {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        );
        h.write_u32(std::process::id());
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out.truncate(len);
    out
}

fn session_of(begun: &Value) -> String {
    begun["session"]
        .as_str()
        .or(begun["session"]["id"].as_str())
        .expect("begin 回执里没有 session")
        .to_owned()
}

fn project_of(begun: &Value) -> String {
    begun["project"]["code"]
        .as_str()
        .or(begun["project"].as_str())
        .expect("begin 回执里没有 project")
        .to_owned()
}

/// 按流程预置。W2 什么都不建（新仓库）；其余流程先有一个绑定到仓库的项目和两个任务。
fn setup(rpc: &Rpc, flow: &str, agent: &str, client: &str, repo: &Path) -> Value {
    if flow == "W2" {
        return json!({});
    }
    let cwd = repo.display().to_string();
    let begun = rpc.call(
        SETUP,
        "atm_begin",
        json!({"agent_id": "u1-setup", "cwd": cwd, "allow_project_create": true}),
    );
    let (session, project) = (session_of(&begun), project_of(&begun));
    let mut login = json!({"title": "实现登录接口", "acceptance": ["登录接口返回 token"]});
    if flow == "W4" {
        login["checklist"] = json!([{"title": "接口实现"}, {"title": "单元测试"}]);
    }
    let created = rpc.call(
        SETUP,
        "atm_task_create",
        json!({"session": session, "items": [login, {"title": "写部署文档"}]}),
    );
    let login_key = created["refs"]["1"].as_str().unwrap().to_owned();
    rpc.call(
        SETUP,
        "atm_end",
        json!({"session": session, "summary": "预置完成"}),
    );
    if flow == "W8" {
        // 上一个 Agent 进程（同 agent_id、cwd、角色）开工、领了任务、做到一半就没了：它的客户端身份
        // 指向一个早已退出的进程。
        let dead = format!("999999:1@{client}");
        let begun = rpc.call(
            &dead,
            "atm_begin",
            json!({"agent_id": agent, "cwd": cwd, "project": project}),
        );
        let s = session_of(&begun);
        rpc.call(
            &dead,
            "atm_task_patch",
            json!({"session": s, "task_key": login_key, "operation": "start"}),
        );
        rpc.call(
            &dead,
            "atm_progress_add",
            json!({"session": s, "task_key": login_key, "summary": "接口写了一半"}),
        );
    }
    json!({"project": project, "login": login_key})
}

fn dump(svc: &Service, rpc: &Rpc, setup: &Value) -> Value {
    let sessions: Vec<Value> = svc
        .store()
        .read(|tx| {
            let mut stmt = tx.prepare(
                "SELECT id, agent_id, role, connection_state, close_reason, predecessor_session_id, client_identity, cwd
                   FROM agent_sessions ORDER BY started_at, id",
            )?;
            stmt.query_map([], |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?, "agent_id": r.get::<_, String>(1)?, "role": r.get::<_, String>(2)?,
                    "connection_state": r.get::<_, String>(3)?, "close_reason": r.get::<_, Option<String>>(4)?,
                    "predecessor": r.get::<_, Option<String>>(5)?, "client": r.get::<_, Option<String>>(6)?,
                    "cwd": r.get::<_, Option<String>>(7)?,
                }))
            })?
            .collect()
        })
        .expect("read sessions");
    let projects: Vec<Value> = svc
        .store()
        .read(|tx| {
            let mut stmt = tx.prepare("SELECT code, name FROM projects ORDER BY code")?;
            stmt.query_map([], |r| {
                Ok(json!({"code": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?}))
            })?
            .collect()
        })
        .expect("read projects");
    let clients: Vec<Value> = SEEN
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, c, _)| c != SETUP)
        .map(|(profile, client, method)| json!({"profile": profile, "client": client, "method": method}))
        .collect();
    let mut out =
        json!({"setup": setup, "sessions": sessions, "projects": projects, "clients": clients});
    // 每个项目的任务（含检查项、证据、最近进度）与记录：经同一个服务的读接口取，口径与 Agent 看到的一致。
    let mut detail = Vec::new();
    for p in &projects {
        let code = p["code"].as_str().unwrap();
        let list = rpc.call(
            SETUP,
            "atm_task_list",
            json!({"project": code, "status": "all", "limit": 100}),
        );
        let keys: Vec<String> = list["items"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|i| i["key"].as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        let tasks: Vec<Value> = keys
            .iter()
            .map(|k| {
                rpc.call(
                    SETUP,
                    "atm_task_get",
                    json!({"project": code, "task_key": k, "view": "full", "last_progress": 10}),
                )
            })
            .collect();
        let records = rpc.call(
            SETUP,
            "atm_search",
            json!({"project": code, "list": "records", "limit": 30}),
        );
        detail.push(json!({"code": code, "tasks": tasks, "records": records}));
    }
    out["detail"] = Value::Array(detail);
    out
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let [_, root, flow, agent, client] = args.as_slice() else {
        eprintln!("用法：u1-server <root> <W1..W9|A4> <agent_id> <client_name>");
        std::process::exit(2);
    };
    let root = PathBuf::from(root);
    let repo = root.join("repo");
    std::fs::create_dir_all(root.join("runtime")).unwrap();
    std::fs::create_dir_all(&repo).unwrap();
    let store = Store::open(&root.join("atm.sqlite"), Config::default()).unwrap();
    store
        .write(|tx| {
            tx.execute_batch(
                "INSERT INTO app_meta (singleton, schema_version, data_root_id, generation, instance_epoch, created_at, updated_at)
                 VALUES (1, 1, 'ROOT', 'G', 'EPOCH', '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z')",
            )
        })
        .unwrap();
    let svc = Arc::new(
        Service::new(store)
            .with_backups_root(root.join("backups"))
            .with_exchange(atm_service::exchange::ExchangeConfig {
                exports: root.join("exports"),
                legacy_exports: None,
                app_version: "3.0.0-u1".into(),
            })
            .with_liveness(Arc::new(atm_jobs::liveness::alive)),
    );
    let token = random_hex(64);
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let surface = Surface::new(svc.clone());
    let tok = token.clone();
    let port = rt.block_on(async move {
        let listener = bind().await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = AppState::new(
            &listener,
            Token::new(&tok).unwrap(),
            Calls::new(4, Duration::from_secs(30)),
            || json!({}),
        )
        .unwrap();
        tokio::spawn(serve(
            listener,
            app(
                state,
                routes(&PROFILES, surface.handler())
                    .merge(surface.resolve_routes())
                    .merge(surface.rest_routes(
                        surface.handler(),
                        Arc::new(
                            || json!({"version": "3.0.0-u1", "conversion": {"phase": "PUBLISHED"}}),
                        ),
                    )),
            )
            .layer(axum::middleware::from_fn(record_client)),
            std::future::pending::<()>(),
        ));
        port
    });
    let rpc = Rpc { port, token };
    let prepared = setup(&rpc, flow, agent, client, &repo);
    let descriptor = json!({
        "endpoint": format!("http://127.0.0.1:{port}"),
        "token": rpc.token,
        "pid": std::process::id(),
        "instanceId": random_hex(32),
        "version": "3.0.0-u1",
        "layout": "single",
        "generation": 1,
    });
    let daemon = root.join("runtime").join("daemon.json");
    std::fs::write(&daemon, descriptor.to_string()).unwrap();
    std::fs::write(root.join("ready"), "").unwrap();

    let stop = root.join("stop");
    let started = Instant::now();
    while !stop.exists() && started.elapsed() < Duration::from_secs(20 * 60) {
        std::thread::sleep(Duration::from_millis(200));
    }
    let _ = std::fs::remove_file(&daemon);
    let state = dump(&svc, &rpc, &prepared);
    std::fs::write(
        root.join("state.json"),
        serde_json::to_string_pretty(&state).unwrap(),
    )
    .unwrap();
}
