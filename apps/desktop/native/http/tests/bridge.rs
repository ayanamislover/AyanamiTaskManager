//! W4g：真实的 atm-mcp.exe 经一个可注入故障的代理连真实的 atm-http（10 R11 A1、A3、A4；09 L3）。
//!
//! 代理记下每个请求（路径、body、X-ATM-Client），并按排好的规则对下一个匹配的请求动手：丢掉响应、
//! 伪造 STORE_BUSY、或者在把响应交回桥之前执行一段代码（例如按范围恢复）。桥从测试自己的数据根
//! （`ATM3_DATA_DIR`）里的 daemon.json 找到代理。

mod support;

use atm_domain::principal::{Principal, UiSurface};
use atm_service::backups::RestoreScope;
use serde_json::{Value, json};
use std::collections::{BTreeSet, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use support::*;

// ---- 构建桥 -------------------------------------------------------------------------------------

fn shim_crate() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("mcp-shim")
}

/// 从工作树构建桥与唤醒替身（mcp-shim 是独立 crate、独立 lock）。构建失败是硬失败，不跳过。
fn shim() -> &'static (PathBuf, PathBuf) {
    static BUILT: OnceLock<(PathBuf, PathBuf)> = OnceLock::new();
    BUILT.get_or_init(|| {
        let dir = shim_crate();
        let status = Command::new("cargo")
            .args(["build", "--locked", "--bins", "--examples"])
            .current_dir(&dir)
            .env_remove("CARGO_TARGET_DIR")
            .status()
            .expect("cargo");
        assert!(status.success(), "building atm-mcp failed");
        let debug = dir.join("target").join("debug");
        let exe = debug.join("atm-mcp.exe");
        let wake = debug.join("examples").join("wake-recorder.exe");
        assert!(exe.is_file() && wake.is_file());
        (exe, wake)
    })
}

// ---- 故障注入代理 --------------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct Seen {
    path: String,
    body: Value,
    client: Option<String>,
}

enum Act {
    /// 照常转发，响应交回之前先执行这段代码。
    Then(Box<dyn FnOnce() + Send>),
    /// 转发给服务（写入照样执行），但把响应丢掉、直接断开连接。
    Drop,
    /// 不转发，回一个 STORE_BUSY 的工具错误。
    Busy,
    /// 照常转发（写入照样执行），响应头立即交回，body 改成分块、每 200 ms 一个字节地交回。
    Drip,
}

struct Rule {
    path: &'static str,
    act: Act,
}

#[derive(Default)]
struct Script {
    rules: VecDeque<Rule>,
    /// 这个路径上的请求一律丢掉响应（预算耗尽的用例）。
    always_drop: Option<&'static str>,
    seen: Vec<Seen>,
}

struct Proxy {
    port: u16,
    script: Arc<Mutex<Script>>,
}

impl Proxy {
    fn start(upstream: u16) -> Proxy {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let script = Arc::new(Mutex::new(Script::default()));
        let shared = script.clone();
        std::thread::spawn(move || {
            for conn in listener.incoming().flatten() {
                let shared = shared.clone();
                std::thread::spawn(move || serve(conn, upstream, &shared));
            }
        });
        Proxy { port, script }
    }

    fn then(&self, path: &'static str, act: Act) {
        self.script
            .lock()
            .unwrap()
            .rules
            .push_back(Rule { path, act });
    }

    fn seen(&self) -> Vec<Seen> {
        self.script.lock().unwrap().seen.clone()
    }

    fn count(&self, path: &str) -> usize {
        self.seen().iter().filter(|s| s.path == path).count()
    }

    fn writes(&self) -> Vec<Value> {
        self.seen()
            .into_iter()
            .filter(|s| s.path.starts_with("/mcp/") && s.path != "/mcp/resolve")
            .filter(|s| s.body["method"] == "tools/call")
            .map(|s| s.body)
            .collect()
    }
}

/// 读一个 HTTP/1.1 消息（head + Content-Length 的 body）。
fn read_message(r: &mut BufReader<&TcpStream>) -> Option<(String, Vec<u8>)> {
    let mut head = String::new();
    loop {
        let mut line = String::new();
        if r.read_line(&mut line).ok()? == 0 {
            return None;
        }
        head.push_str(&line);
        if line == "\r\n" {
            break;
        }
    }
    let length = head
        .lines()
        .find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.trim()
                .eq_ignore_ascii_case("content-length")
                .then(|| v.trim().parse::<usize>().ok())?
        })
        .unwrap_or(0);
    let mut body = vec![0; length];
    r.read_exact(&mut body).ok()?;
    Some((head, body))
}

fn header(head: &str, name: &str) -> Option<String> {
    head.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.trim()
            .eq_ignore_ascii_case(name)
            .then(|| v.trim().to_owned())
    })
}

fn serve(conn: TcpStream, upstream: u16, script: &Mutex<Script>) {
    let mut reader = BufReader::new(&conn);
    let Some((head, body)) = read_message(&mut reader) else {
        return;
    };
    let path = head.split(' ').nth(1).unwrap_or_default().to_owned();
    let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let act = {
        let mut s = script.lock().unwrap();
        s.seen.push(Seen {
            path: path.clone(),
            body: parsed.clone(),
            client: header(&head, "x-atm-client"),
        });
        let is_call = path == "/mcp/resolve" || parsed["method"] == "tools/call";
        let at = s.rules.iter().position(|r| {
            r.path == path || (r.path == "write" && is_call && path != "/mcp/resolve")
        });
        match at {
            Some(i) => s.rules.remove(i).map(|r| r.act),
            None if s.always_drop == Some("write") && is_call && path != "/mcp/resolve" => {
                Some(Act::Drop)
            }
            None => None,
        }
    };
    let mut out = &conn;
    if let Some(Act::Busy) = act {
        let reply = json!({"jsonrpc": "2.0", "id": parsed["id"], "result": {
            "content": [{"type": "text", "text": "STORE_BUSY"}],
            "structuredContent": {"ok": false, "code": "STORE_BUSY", "message": "busy", "retryable": true,
                                  "committed": false, "fix": {"kind": "wait", "retry_after_ms": 100, "call": null}},
            "isError": true}})
        .to_string();
        let _ = write!(
            out,
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{reply}",
            reply.len()
        );
        return;
    }
    let Ok(up) = TcpStream::connect(("127.0.0.1", upstream)) else {
        return;
    };
    // 服务只认指向自己端口的 Host：代理改写这一行，其余原样转发。
    let head: String = head
        .split_inclusive("\r\n")
        .map(|l| {
            if l.to_ascii_lowercase().starts_with("host:") {
                format!("host: 127.0.0.1:{upstream}\r\n")
            } else {
                l.to_owned()
            }
        })
        .collect();
    let mut w = &up;
    if w.write_all(head.as_bytes()).is_err() || w.write_all(&body).is_err() {
        return;
    }
    let mut ur = BufReader::new(&up);
    let Some((rhead, rbody)) = read_message(&mut ur) else {
        return;
    };
    match act {
        Some(Act::Drop) => {} // 写入已经执行，响应丢掉
        Some(Act::Then(f)) => {
            f();
            let _ = out.write_all(rhead.as_bytes());
            let _ = out.write_all(&rbody);
        }
        Some(Act::Drip) => {
            let head: String = rhead
                .split_inclusive("\r\n")
                .filter(|l| !l.to_ascii_lowercase().starts_with("content-length:"))
                .map(|l| {
                    if l == "\r\n" {
                        "transfer-encoding: chunked\r\n\r\n".to_owned()
                    } else {
                        l.to_owned()
                    }
                })
                .collect();
            if out.write_all(head.as_bytes()).is_err() {
                return;
            }
            for b in rbody {
                let mut chunk = b"1\r\n".to_vec();
                chunk.extend([b, b'\r', b'\n']);
                if out.write_all(&chunk).is_err() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            let _ = out.write_all(b"0\r\n\r\n");
        }
        _ => {
            let _ = out.write_all(rhead.as_bytes());
            let _ = out.write_all(&rbody);
        }
    }
}

// ---- 桥进程 ---------------------------------------------------------------------------------------

struct Bridge {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
    next_id: i64,
}

impl Drop for Bridge {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Bridge {
    fn spawn(cmd: Command) -> Bridge {
        let mut cmd = cmd;
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = cmd.spawn().expect("spawn atm-mcp");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, lines) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        Bridge {
            child,
            stdin,
            lines,
            next_id: 0,
        }
    }

    fn request(&mut self, method: &str, params: Value, wait: Duration) -> Value {
        self.next_id += 1;
        let line =
            json!({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params});
        writeln!(self.stdin, "{line}").unwrap();
        self.stdin.flush().unwrap();
        let reply = self.lines.recv_timeout(wait).expect("bridge reply");
        serde_json::from_str(&reply).unwrap()
    }

    fn initialize(&mut self, client: &str) -> Value {
        self.request(
            "initialize",
            json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": client, "version": "1"}}),
            Duration::from_secs(60),
        )
    }

    /// 一次工具调用的结果（成功或工具级错误都有 result）。协议层的错误没有 result，这里直接失败，
    /// 免得调用方把 null 当成功（R1-P2-01）；要测协议错误的用例用 `request`。
    fn call(&mut self, tool: &str, args: Value) -> Value {
        let reply = self.request(
            "tools/call",
            json!({"name": tool, "arguments": args}),
            Duration::from_secs(60),
        );
        assert!(
            reply["result"].is_object(),
            "{tool}：没有工具结果（协议层错误）：{reply}"
        );
        reply["result"].clone()
    }
}

// ---- 数据根与 daemon.json ---------------------------------------------------------------------------

struct Rig {
    w: World,
    proxy: Proxy,
    root: PathBuf,
}

fn rig(name: &str) -> Rig {
    let w = world(name);
    let proxy = Proxy::start(w.port);
    let root = w.dir.join("n");
    std::fs::create_dir_all(root.join("runtime")).unwrap();
    let rig = Rig { w, proxy, root };
    rig.publish();
    rig
}

impl Rig {
    fn publish(&self) {
        let descriptor = json!({
            "endpoint": format!("http://127.0.0.1:{}", self.proxy.port),
            "token": TOKEN,
            "pid": std::process::id(),
            "instanceId": "0123456789abcdef0123456789abcdef",
            "version": "3.0.0-test",
            "layout": "single",
            "generation": 1,
        });
        std::fs::write(
            self.root.join("runtime").join("daemon.json"),
            descriptor.to_string(),
        )
        .unwrap();
    }

    fn command(&self, exe: &Path) -> Command {
        self.command_on(exe, "core")
    }

    fn command_on(&self, exe: &Path, profile: &str) -> Command {
        let mut c = Command::new(exe);
        c.args(["--profile", profile])
            .env("ATM3_DATA_DIR", &self.root)
            .env_remove("ATM_DATA_DIR");
        c
    }

    fn bridge(&self) -> Bridge {
        Bridge::spawn(self.command(&shim().0))
    }

    fn bridge_on(&self, profile: &str) -> Bridge {
        Bridge::spawn(self.command_on(&shim().0, profile))
    }
}

fn user() -> Principal {
    Principal::trusted_ui(UiSurface::Tray)
}

/// 成功的工具结果。协议层的错误（工具不在这个 profile 上）没有 result，`Bridge::call` 给的是 null：
/// 只看 isError 会把它当成功（R1-P2-01），所以先断言结果在。要测协议错误的用例直接用 `request`。
fn ok(r: &Value) -> &Value {
    assert!(
        r.is_object() && r["structuredContent"].is_object() && r["isError"] != json!(true),
        "{r}"
    );
    &r["structuredContent"]
}

fn err(r: &Value) -> &Value {
    assert_eq!(r["isError"], json!(true), "{r}");
    &r["structuredContent"]
}

// ---- 用例 ------------------------------------------------------------------------------------------

/// 签发：缺字段的调用经一次 resolve 补齐，op_id 是 auto:<ULID>；完整显式调用不 resolve；显式 op_id 原样；
/// 连接组身份是测试进程（桥的第一个非包装祖先）加 clientInfo.name；白名单客户端拿到默认 session。
#[test]
fn the_bridge_signs_writes_and_names_its_client() {
    let r = rig("bridge-sign");
    let mut b = r.bridge();
    assert_eq!(
        b.initialize("claude-code")["result"]["serverInfo"]["name"],
        json!("ayanami-task-manager")
    );
    let begun = b.call(
        "atm_begin",
        json!({"agent_id": "claude-code", "project": r.w.project}),
    );
    let session = ok(&begun)["session"].as_str().unwrap().to_owned();
    assert_eq!(r.proxy.count("/mcp/resolve"), 1);
    let writes = r.proxy.writes();
    let args = &writes[0]["params"]["arguments"];
    assert!(
        args["op_id"].as_str().unwrap().starts_with("auto:"),
        "{args}"
    );
    assert_eq!(args["op_id"].as_str().unwrap().len(), 5 + 26);
    assert_eq!(args["expected_target"]["kind"], json!("EXISTING"));
    assert!(args.get("session").is_none(), "begin 不补 session：{args}");

    let me = format!("{}:", std::process::id());
    for s in r.proxy.seen().iter().filter(|s| s.path != "/health") {
        let client = s.client.as_deref().unwrap_or_default();
        assert!(
            client.starts_with(&me) && client.ends_with("@claude-code"),
            "{client}"
        );
    }
    let stored =
        r.w.svc
            .store()
            .read(|tx| {
                tx.query_row(
                    "SELECT client_identity FROM agent_sessions WHERE id = ?1",
                    [&session],
                    |row| row.get::<_, String>(0),
                )
            })
            .unwrap();
    assert_eq!(Some(stored.as_str()), r.proxy.seen()[0].client.as_deref());

    // 白名单：缺 session 的写入由 resolve 补上默认 session。
    let progressed = b.call(
        "atm_progress_add",
        json!({"task_key": r.w.task, "summary": "开工"}),
    );
    ok(&progressed);
    let last = r.proxy.writes().pop().unwrap();
    assert_eq!(last["params"]["arguments"]["session"], json!(session));
    assert_eq!(r.proxy.count("/mcp/resolve"), 2);

    // 完整显式调用不 resolve；显式 op_id 在补字段时原样保留。
    ok(&b.call(
        "atm_record",
        json!({"session": session, "project": r.w.project, "op_id": "mine-1", "kind": "FACT", "title": "t", "summary": "s"}),
    ));
    assert_eq!(r.proxy.count("/mcp/resolve"), 2);
    ok(&b.call(
        "atm_record",
        json!({"op_id": "mine-2", "kind": "FACT", "title": "t", "summary": "s"}),
    ));
    assert_eq!(r.proxy.count("/mcp/resolve"), 3);
    assert_eq!(
        r.proxy.writes().pop().unwrap()["params"]["arguments"]["op_id"],
        json!("mine-2")
    );
    // 只读工具原样转发。
    ok(&b.call(
        "atm_task_get",
        json!({"task_key": r.w.task, "project": r.w.project}),
    ));
    assert_eq!(r.proxy.count("/mcp/resolve"), 3);
}

/// 桥、resolve 与工具入口对参数是同一个读法（peer W4 r1 P1-02）：服务照收的显式 op_id（数字、大小写不同
/// 的键名）原样保留，同一个调用再发一次是重放；空白与 null 视同没给，由桥补 auto；无法解释的值在写入前
/// 拒绝；布尔字符串在 resolve 与正式调用里是同一个分支。
#[test]
fn the_bridge_reads_arguments_the_way_the_service_does() {
    let r = rig("bridge-normalize");
    let mut b = r.bridge();
    b.initialize("claude-code");
    let record = |extra: Value| {
        let mut a =
            json!({"kind": "FACT", "title": "same explicit operation", "summary": "one record"});
        a.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        a
    };
    let twice = |b: &mut Bridge, args: Value, op: &str| {
        let first = b.call("atm_record", args.clone());
        assert_eq!(ok(&first)["op_id"], json!(op), "{first}");
        assert_eq!(ok(&first)["replayed"], json!(false), "{first}");
        let second = b.call("atm_record", args);
        assert_eq!(ok(&second)["op_id"], json!(op), "{second}");
        assert_eq!(
            ok(&second)["replayed"],
            json!(true),
            "同一个显式操作又执行了一次：{second}"
        );
    };
    // 数字 op_id：完整显式调用（不经 resolve）与缺 project 的调用（经 resolve）都按 "42" 签发。
    twice(
        &mut b,
        record(json!({"project": r.w.project, "session": r.w.session, "op_id": 42})),
        "42",
    );
    twice(
        &mut b,
        record(json!({"session": r.w.session, "op_id": 43})),
        "43",
    );
    // 键名大小写不同、别名：服务认得，桥就不会再塞一个 op_id 或 session 进去。
    twice(
        &mut b,
        record(json!({"OP_ID": "case-1", "Session_Id": r.w.session})),
        "case-1",
    );
    let signed = r.proxy.writes().pop().unwrap();
    let keys: Vec<&String> = signed["params"]["arguments"]
        .as_object()
        .unwrap()
        .keys()
        .collect();
    assert!(
        !keys
            .iter()
            .any(|k| k.as_str() == "OP_ID" || k.as_str() == "Session_Id"),
        "签发的是规范化之后的参数：{signed}"
    );

    // 空白与 null 是没给：桥补 auto，服务不会拿空白当 op_id。
    for blank in [json!("  "), Value::Null] {
        let done = b.call(
            "atm_record",
            record(
                json!({"session": r.w.session, "op_id": blank, "title": format!("blank {blank}")}),
            ),
        );
        assert!(
            ok(&done)["op_id"].as_str().unwrap().starts_with("auto:"),
            "{done}"
        );
    }

    // 无法解释的显式值：写入前拒绝，什么都没发出。
    let before = r.proxy.writes().len();
    for bad in [json!(true), json!({"id": 1}), json!(["x"])] {
        let e = b.call(
            "atm_record",
            record(json!({"session": r.w.session, "op_id": bad})),
        );
        let e = err(&e);
        assert_eq!(e["code"], json!("INVALID_ARGUMENT"), "{e}");
        assert_eq!(e["problems"][0]["path"], json!("op_id"), "{e}");
    }
    assert_eq!(r.proxy.writes().len(), before, "拒绝的调用不该发出写请求");

    // 布尔字符串：resolve 与正式调用都判 CREATE。
    let fresh = r.w.dir.join("normalize-fresh");
    std::fs::create_dir_all(&fresh).unwrap();
    let begun = b.call(
        "atm_begin",
        json!({"agent_id": "peer", "cwd": fresh.to_str().unwrap(), "title": "new project",
               "allow_project_create": "true"}),
    );
    ok(&begun);
    let signed = r.proxy.writes().pop().unwrap();
    assert_eq!(
        signed["params"]["arguments"]["expected_target"],
        json!({"kind": "CREATE"}),
        "{signed}"
    );
}

/// 非白名单客户端缺 session：SESSION_REQUIRED（补 session 参数），写请求根本没有发出。
/// R11 A4：同一个 Agent 实例的几个 profile 是同一个连接组——core 上开的 session，memory 上缺 session 的写入（知识）
/// 照样补上它，两个桥发出的 `X-ATM-Client` 一字不差。另一个实例（同一个客户端名、另一个祖先进程）不是同一组：
/// 它缺 session 的写入拿不到这里的默认 session。
#[test]
fn r11_a4_profiles_of_one_instance_share_a_group_and_other_instances_do_not() {
    let r = rig("bridge-group");
    let mut core = r.bridge();
    let mut memory = r.bridge_on("memory");
    core.initialize("claude-code");
    memory.initialize("claude-code");
    let begun = core.call(
        "atm_begin",
        json!({"agent_id": "claude-code", "project": r.w.project}),
    );
    let session = ok(&begun)["session"].as_str().unwrap().to_owned();
    ok(&memory.call(
        "atm_knowledge_save",
        json!({"slug": "from-memory", "title": "从 memory 写", "summary": "缺 session", "body": "正文"}),
    ));
    let last = r.proxy.writes().pop().unwrap();
    assert_eq!(
        last["params"]["arguments"]["session"],
        json!(session),
        "{last}"
    );
    let groups: BTreeSet<String> = r
        .proxy
        .seen()
        .into_iter()
        .filter(|s| s.path != "/health")
        .filter_map(|s| s.client)
        .collect();
    assert_eq!(groups.len(), 1, "{groups:?}");

    let mine = groups.into_iter().next().unwrap();
    let other = "1:1@claude-code";
    assert_ne!(mine, other);
    let body =
        json!({"tool": "atm_progress_add", "arguments": {"task_key": r.w.task, "summary": "x"}})
            .to_string();
    let (status, text) = http_as(r.w.port, Some(other), "POST", "/mcp/resolve", &body);
    let e: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    assert_eq!(
        (status, &e["code"]),
        (422, &json!("SESSION_REQUIRED")),
        "{text}"
    );
    let (status, text) = http_as(r.w.port, Some(&mine), "POST", "/mcp/resolve", &body);
    assert_eq!(status, 200, "{text}");
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap()["session"],
        json!(session),
        "{text}"
    );
}

#[test]
fn non_whitelisted_clients_get_no_default_session() {
    let r = rig("bridge-desktop");
    let mut b = r.bridge();
    b.initialize("claude-ai");
    ok(&b.call(
        "atm_begin",
        json!({"agent_id": "claude-desktop", "project": r.w.project}),
    ));
    let before = r.proxy.writes().len();
    let e = b.call(
        "atm_progress_add",
        json!({"task_key": r.w.task, "summary": "x"}),
    );
    let e = err(&e);
    assert_eq!(e["code"], json!("SESSION_REQUIRED"), "{e}");
    assert_eq!(e["fix"]["param"], json!("session"));
    assert_eq!(r.proxy.writes().len(), before, "写请求不该发出");
}

/// 响应丢失与 STORE_BUSY：用同一份上下文重试（op_id 不换、不再 resolve），结果是一次副作用。
#[test]
fn lost_responses_and_busy_replies_retry_the_same_context() {
    let r = rig("bridge-retry");
    let mut b = r.bridge();
    b.initialize("claude-code");
    let begun = b.call(
        "atm_begin",
        json!({"agent_id": "claude-code", "project": r.w.project}),
    );
    let session = ok(&begun)["session"].as_str().unwrap().to_owned();
    let resolves = r.proxy.count("/mcp/resolve");
    let before = r.proxy.writes().len();
    r.proxy.then("write", Act::Drop);
    r.proxy.then("write", Act::Busy);
    let reply = b.call(
        "atm_record",
        json!({"session": session, "kind": "DECISION", "title": "一次", "summary": "只该写一次"}),
    );
    let ack = ok(&reply);
    assert_eq!(
        ack["replayed"],
        json!(true),
        "第一次已经执行，重试应当重放：{ack}"
    );
    let writes = r.proxy.writes();
    let sent = &writes[before..];
    assert_eq!(sent.len(), 3, "{sent:?}");
    assert!(
        sent.windows(2).all(|p| p[0]["params"] == p[1]["params"]),
        "重试换了上下文"
    );
    assert_eq!(
        r.proxy.count("/mcp/resolve"),
        resolves + 1,
        "写之后又 resolve 了"
    );
    let records =
        r.w.svc
            .store()
            .read(|tx| {
                tx.query_row(
                    "SELECT count(*) FROM records WHERE title = '一次'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
            })
            .unwrap();
    assert_eq!(records, 1);
}

/// resolve 之后、写入之前项目被恢复：SCOPE_RESTORED，零写入。
#[test]
fn a_restore_between_resolve_and_write_is_scope_restored() {
    let r = rig("bridge-restore");
    let mut b = r.bridge();
    b.initialize("claude-code");
    let begun = b.call(
        "atm_begin",
        json!({"agent_id": "claude-code", "project": r.w.project}),
    );
    let session = ok(&begun)["session"].as_str().unwrap().to_owned();
    let svc = r.w.svc.clone();
    let code = r.w.project.clone();
    r.proxy.then(
        "/mcp/resolve",
        Act::Then(Box::new(move || {
            let id = svc.create_manual_backup(&user()).unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned();
            svc.restore_scope(&user(), &id, RestoreScope::Project(code))
                .unwrap();
        })),
    );
    let reply = b.call(
        "atm_record",
        json!({"session": session, "kind": "FACT", "title": "恢复之后", "summary": "不该写入"}),
    );
    assert_eq!(err(&reply)["code"], json!("SCOPE_RESTORED"), "{reply}");
    let n =
        r.w.svc
            .store()
            .read(|tx| {
                tx.query_row(
                    "SELECT count(*) FROM records WHERE title = '恢复之后'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
            })
            .unwrap();
    assert_eq!(n, 0);
}

/// 预算耗尽：写发出过但一直没有响应 → RESULT_UNKNOWN，fix.call 带完整上下文；照它原样重试得到重放。
#[test]
fn an_unconfirmed_write_ends_in_result_unknown_with_its_context() {
    let r = rig("bridge-unknown");
    let mut b = r.bridge();
    b.initialize("claude-code");
    let begun = b.call(
        "atm_begin",
        json!({"agent_id": "claude-code", "project": r.w.project}),
    );
    let session = ok(&begun)["session"].as_str().unwrap().to_owned();
    r.proxy.script.lock().unwrap().always_drop = Some("write");
    let started = Instant::now();
    let reply = b.call(
        "atm_record",
        json!({"session": session, "kind": "FACT", "title": "悬而未决", "summary": "s"}),
    );
    let elapsed = started.elapsed();
    let e = err(&reply).clone();
    assert_eq!(
        (&e["code"], &e["committed"]),
        (&json!("RESULT_UNKNOWN"), &json!("unknown")),
        "{e}"
    );
    assert!(
        elapsed >= Duration::from_secs(29) && elapsed < Duration::from_secs(45),
        "{elapsed:?}"
    );
    let args = &e["fix"]["call"]["arguments"];
    assert!(args["op_id"].as_str().unwrap().starts_with("auto:"), "{e}");
    assert_eq!(args["project"], json!(r.w.project));
    assert_eq!(args["expected_target"]["kind"], json!("EXISTING"));
    r.proxy.script.lock().unwrap().always_drop = None;
    let again = b.call(e["fix"]["call"]["name"].as_str().unwrap(), args.clone());
    assert_eq!(ok(&again)["replayed"], json!(true), "{again}");
}

/// 30 秒总预算约束到每一次 IO（peer W4 r1 P1-03）：服务拿着写入的应答不放、或者一个字节一个字节地挤，
/// 桥都在预算到点时停下，报 RESULT_UNKNOWN（写入可能已经送达），带着冻结的上下文；照 fix.call 重试是重放。
#[test]
fn a_held_or_trickled_write_answer_ends_at_the_budget() {
    let r = rig("bridge-held-write");
    let mut b = r.bridge();
    b.initialize("claude-code");
    for (n, act) in [
        Act::Then(Box::new(|| std::thread::sleep(Duration::from_secs(40)))),
        Act::Drip,
    ]
    .into_iter()
    .enumerate()
    {
        r.proxy.then("write", act);
        let started = Instant::now();
        let reply = b.call(
            "atm_record",
            json!({"session": r.w.session, "kind": "FACT", "title": format!("held {n}"), "summary": "s"}),
        );
        let elapsed = started.elapsed();
        let e = err(&reply).clone();
        assert_eq!(
            (&e["code"], &e["committed"], &e["details"]["sent"]),
            (&json!("RESULT_UNKNOWN"), &json!("unknown"), &json!(true)),
            "{e}"
        );
        assert!(
            elapsed >= Duration::from_secs(29) && elapsed < Duration::from_secs(33),
            "第 {n} 种：{elapsed:?}"
        );
        let args = &e["fix"]["call"]["arguments"];
        assert!(args["op_id"].as_str().unwrap().starts_with("auto:"), "{e}");
        assert_eq!(args["expected_target"]["kind"], json!("EXISTING"), "{e}");
        let again = b.call("atm_record", args.clone());
        assert_eq!(ok(&again)["replayed"], json!(true), "{again}");
    }
}

/// resolve 的应答被拿着不放：桥在预算到点时停下，写请求从没发出 → SERVICE_UNAVAILABLE、sent:false。
#[test]
fn a_held_resolve_answer_ends_at_the_budget_with_nothing_sent() {
    let r = rig("bridge-held-resolve");
    let mut b = r.bridge();
    b.initialize("claude-code");
    r.proxy.then(
        "/mcp/resolve",
        Act::Then(Box::new(|| std::thread::sleep(Duration::from_secs(40)))),
    );
    let started = Instant::now();
    let reply = b.call(
        "atm_record",
        json!({"session": r.w.session, "kind": "FACT", "title": "held resolve", "summary": "s"}),
    );
    let elapsed = started.elapsed();
    let e = err(&reply);
    assert_eq!(
        (&e["code"], &e["committed"], &e["details"]["sent"]),
        (&json!("SERVICE_UNAVAILABLE"), &json!(false), &json!(false)),
        "{e}"
    );
    assert!(
        elapsed >= Duration::from_secs(29) && elapsed < Duration::from_secs(33),
        "{elapsed:?}"
    );
    assert!(r.proxy.writes().is_empty(), "写请求不该发出");
}

/// 没有服务（也没有可唤醒的桌面）：写请求从未发出 → SERVICE_UNAVAILABLE、sent:false，auto id 时
/// committed:false，fix.call 是原调用；显式 op_id 时 committed:"unknown"。
#[test]
fn no_service_means_service_unavailable_and_nothing_sent() {
    let r = rig("bridge-down");
    std::fs::remove_file(r.root.join("runtime").join("daemon.json")).unwrap();
    let mut b = r.bridge();
    let original = json!({"session": "S", "kind": "FACT", "title": "t", "summary": "s"});
    let started = Instant::now();
    let e = b.call("atm_record", original.clone());
    let e = err(&e);
    assert!(started.elapsed() >= Duration::from_secs(29));
    assert_eq!(
        (&e["code"], &e["committed"], &e["details"]["sent"]),
        (&json!("SERVICE_UNAVAILABLE"), &json!(false), &json!(false)),
        "{e}"
    );
    assert_eq!(e["fix"]["call"]["arguments"], original);
    assert!(r.proxy.seen().is_empty());
}

/// 一个装在假安装布局里的桥：`AyanamiTaskManager.exe` 是唤醒替身，每次被拉起往 wake.jsonl 追加一行。
fn installed_bridge(r: &Rig) -> (Bridge, PathBuf) {
    let (exe, wake) = shim();
    let install = r.w.dir.join("install");
    std::fs::create_dir_all(install.join("resources")).unwrap();
    let copied = install.join("resources").join("atm-mcp.exe");
    std::fs::copy(exe, &copied).unwrap();
    std::fs::copy(wake, install.join("AyanamiTaskManager.exe")).unwrap();
    let record = r.w.dir.join("wake.jsonl");
    let mut c = r.command(&copied);
    c.env("ATM_WAKE_RECORD", &record);
    (Bridge::spawn(c), record)
}

/// 等唤醒记录出现，再把服务描述发布回去（「被唤醒的桌面起来了」）。
fn publish_after_wake(r: &Rig, record: &Path) -> std::thread::JoinHandle<()> {
    let (root, record, port) = (r.root.clone(), record.to_owned(), r.proxy.port);
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !record.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        let descriptor = json!({
            "endpoint": format!("http://127.0.0.1:{port}"), "token": TOKEN, "pid": std::process::id(),
            "instanceId": "fedcba9876543210fedcba9876543210", "version": "3.0.0-test",
        });
        std::fs::write(
            root.join("runtime").join("daemon.json"),
            descriptor.to_string(),
        )
        .unwrap();
    })
}

fn wakes(record: &Path) -> Vec<Value> {
    std::fs::read_to_string(record)
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

/// 唤醒：起初没有 daemon.json，桥唤醒安装目录里的桌面（这里是唤醒替身），之后发现服务照常应答。
#[test]
fn a_missing_service_is_woken_and_then_used() {
    let r = rig("bridge-wake");
    std::fs::remove_file(r.root.join("runtime").join("daemon.json")).unwrap();
    let (mut b, record) = installed_bridge(&r);
    let publisher = publish_after_wake(&r, &record);
    let reply = b.initialize("claude-code");
    publisher.join().unwrap();
    assert_eq!(
        reply["result"]["serverInfo"]["name"],
        json!("ayanami-task-manager"),
        "{reply}"
    );
    let woke = wakes(&record);
    assert_eq!(woke.len(), 1);
    assert_eq!(woke[0]["args"], json!(["--background", "--agent-wake"]));
}

/// 服务在两次调用之间退出（daemon.json 没了）：写调用自己唤醒桌面，等新实例发布后照常写入。
#[test]
fn a_write_wakes_a_service_that_went_away() {
    let r = rig("bridge-rewake");
    let (mut b, record) = installed_bridge(&r);
    b.initialize("claude-code");
    let begun = b.call(
        "atm_begin",
        json!({"agent_id": "claude-code", "project": r.w.project}),
    );
    let session = ok(&begun)["session"].as_str().unwrap().to_owned();
    assert!(wakes(&record).is_empty());
    std::fs::remove_file(r.root.join("runtime").join("daemon.json")).unwrap();
    let publisher = publish_after_wake(&r, &record);
    let reply = b.call(
        "atm_record",
        json!({"session": session, "kind": "FACT", "title": "醒来之后", "summary": "s"}),
    );
    publisher.join().unwrap();
    ok(&reply);
    assert_eq!(wakes(&record).len(), 1);
}

/// 数据来源冲突：startup-state.json 说 SOURCE_CONFLICT 时立刻报告，不等超时。
#[test]
fn a_source_conflict_is_reported_at_once() {
    let r = rig("bridge-conflict");
    std::fs::remove_file(r.root.join("runtime").join("daemon.json")).unwrap();
    std::fs::write(
        r.root.join("runtime").join("startup-state.json"),
        r#"{"generation":"G1","reason":"2.x changed after conversion","since":"2026-10-07T00:00:00.000Z","state":"SOURCE_CONFLICT"}"#,
    )
    .unwrap();
    let mut b = r.bridge();
    let started = Instant::now();
    let reply = b.initialize("claude-code");
    assert!(started.elapsed() < Duration::from_secs(5));
    let message = reply["error"]["message"].as_str().unwrap();
    assert!(message.starts_with("ATM_SOURCE_CONFLICT"), "{message}");
    assert!(
        message.contains("2.x changed after conversion"),
        "{message}"
    );
    let e = b.call(
        "atm_record",
        json!({"kind": "FACT", "title": "t", "summary": "s"}),
    );
    assert_eq!(
        err(&e)["details"]["reason"]
            .as_str()
            .map(|s| s.starts_with("ATM_SOURCE_CONFLICT")),
        Some(true),
        "{e}"
    );
}

/// W8h：库读不出（`runtime/damaged.json`）时桥立刻报，不等满预算。读类请求是 JSON-RPC 错误，消息以
/// DATABASE_DAMAGED 开头；写类是专门的信封：code DATABASE_DAMAGED、不可重试、`fix` 是转告用户，没有发出。
#[test]
fn a_damaged_database_is_reported_at_once() {
    let r = rig("bridge-damaged");
    std::fs::remove_file(r.root.join("runtime").join("daemon.json")).unwrap();
    std::fs::write(
        r.root.join("runtime").join("damaged.json"),
        r#"{"generation":"G1","reason":"file is not a database","since":"2026-10-14T00:00:00.000Z","state":"DATABASE_DAMAGED"}"#,
    )
    .unwrap();
    let mut b = r.bridge();
    let started = Instant::now();
    let reply = b.initialize("claude-code");
    assert!(started.elapsed() < Duration::from_secs(5));
    let message = reply["error"]["message"].as_str().unwrap();
    assert!(message.starts_with("DATABASE_DAMAGED"), "{message}");
    assert!(message.contains("file is not a database"), "{message}");
    let started = Instant::now();
    let e = b.call(
        "atm_record",
        json!({"kind": "FACT", "title": "t", "summary": "s"}),
    );
    assert!(started.elapsed() < Duration::from_secs(5));
    let env = err(&e);
    assert_eq!(env["code"], "DATABASE_DAMAGED", "{e}");
    assert_eq!(env["retryable"], false, "{e}");
    assert_eq!(env["committed"], false, "{e}");
    assert_eq!(env["fix"]["kind"], "ask_user", "{e}");
    assert!(
        env["fix"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("file is not a database") && m.contains("恢复")),
        "{e}"
    );
    assert_eq!(env["details"]["sent"], false, "{e}");
    assert!(r.proxy.seen().is_empty());

    // 文件坏了也不是「再等等」。
    std::fs::write(r.root.join("runtime").join("damaged.json"), b"{not json").unwrap();
    let e = b.call(
        "atm_record",
        json!({"kind": "FACT", "title": "t2", "summary": "s"}),
    );
    assert_eq!(err(&e)["code"], "DATABASE_DAMAGED", "{e}");
}

/// 没有 --profile 的旧配置：退出码非零并提示重新安装，不转发到任何入口。
#[test]
fn a_missing_profile_is_refused() {
    let r = rig("bridge-profile");
    let out = Command::new(&shim().0)
        .env("ATM3_DATA_DIR", &r.root)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("MCP_PROFILE_REQUIRED"));
    assert!(r.proxy.seen().is_empty());
}

/// 经 `cmd /c` 拉起时，连接组身份仍是真正的客户端（cmd 是包装，被跳过）。
#[test]
fn shell_wrappers_are_skipped_in_the_client_identity() {
    let r = rig("bridge-wrapper");
    let mut c = Command::new("cmd");
    c.args(["/c"])
        .arg(&shim().0)
        .args(["--profile", "core"])
        .env("ATM3_DATA_DIR", &r.root)
        .env_remove("ATM_DATA_DIR");
    let mut b = Bridge::spawn(c);
    b.initialize("codex-mcp-client");
    let client = r.proxy.seen()[0].client.clone().unwrap();
    assert!(
        client.starts_with(&format!("{}:", std::process::id()))
            && client.ends_with("@codex-mcp-client"),
        "{client}"
    );
}

// ---- U-2 金标脚本（11 §5）-----------------------------------------------------------------------

/// Agent 替身（`mcp-shim/examples/agent-standin.rs`）：它拉起桥，桥认它做客户端。杀掉一个、再起一个，
/// 就是「Agent 崩溃后重启」——新替身是另一个进程，旧会话的客户端已经退出。
fn standin() -> PathBuf {
    shim();
    let exe = shim_crate()
        .join("target")
        .join("debug")
        .join("examples")
        .join("agent-standin.exe");
    assert!(exe.is_file());
    exe
}

/// 一个经替身连上的 Agent：只记它自己发出的 tools/call 次数，每次都必须成功。
struct Agent {
    b: Bridge,
    calls: usize,
}

impl Agent {
    fn start(r: &Rig, client: &str) -> Agent {
        let mut c = Command::new(standin());
        c.arg(&shim().0)
            .args(["--profile", "core"])
            .env("ATM3_DATA_DIR", &r.root)
            .env_remove("ATM_DATA_DIR");
        let mut b = Bridge::spawn(c);
        b.initialize(client);
        Agent { b, calls: 0 }
    }

    fn call(&mut self, tool: &str, args: Value) -> Value {
        self.calls += 1;
        let r = self.b.call(tool, args);
        // 协议层的错误（例如工具不在这个 profile 上）没有 result：只看 isError 会把它当成功。
        assert!(
            r.is_object() && r["structuredContent"].is_object() && r["isError"] != json!(true),
            "{tool}: {r}"
        );
        r["structuredContent"].clone()
    }

    /// 反例：这次调用必须被拒，返回错误码。不计入正常路径。
    fn refused(&mut self, tool: &str, args: Value) -> String {
        let r = self.b.call(tool, args);
        assert_eq!(r["isError"], json!(true), "{tool} 应当被拒：{r}");
        let code = r["structuredContent"]["code"].as_str().unwrap_or_default();
        assert!(!code.is_empty(), "{tool} 的拒绝没有错误码：{r}");
        code.to_owned()
    }

    /// 一个流程：`run` 里发出的调用数必须恰好是 11 §1「提案后」那一列。
    fn flow(&mut self, name: &str, proposed: usize, run: impl FnOnce(&mut Agent)) {
        let before = self.calls;
        run(self);
        assert_eq!(
            self.calls - before,
            proposed,
            "{name}: 11 §1 的提案后调用数是 {proposed}"
        );
    }
}

/// 旁路读任务状态：直接对服务调 atm_task_get，不经桥，不算进 Agent 的调用数。
fn status_of(r: &Rig, project: &str, key: &str) -> String {
    let got = call(
        &r.w,
        "core",
        "atm_task_get",
        json!({"project": project, "task_key": key}),
    );
    assert_ne!(got["isError"], json!(true), "{got}");
    got["structuredContent"]["status"]
        .as_str()
        .unwrap_or_else(|| panic!("{got}"))
        .to_owned()
}

/// U-2：不经 LLM，按 11 §1 每个流程的最少调用序列，经真实桥执行，参数只用「提案后必填」。全部成功，
/// 而且每个流程的调用数恰好是提案后那一列：任何一步要多补一次调用（先 ready、先 claim、带版本、
/// 再 begin、补 outcome……），这里的某一次调用就会失败。
///
/// 顺序：W2 新仓库开工 → W3 建 5 个任务（带依赖与 2 条检查项）→ W4 开工并带证据完成 → W5 进度与决策
/// → W6 等用户 → W9 结束 → W1 已有项目开工 → W7 压缩后继续 → W8 崩溃后重启，再写自己领取的任务。
#[test]
fn u2_golden_scripts_take_the_proposed_number_of_calls() {
    let r = rig("bridge-golden");
    let repo = r.w.dir.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let cwd = repo.display().to_string();
    let mut a = Agent::start(&r, "claude-code");
    let mut project = String::new();

    a.flow("W2 新仓库首次开工", 1, |a| {
        let begun = a.call(
            "atm_begin",
            json!({"agent_id": "claude-code", "cwd": cwd, "allow_project_create": true}),
        );
        assert!(begun["session"].is_string(), "{begun}");
        project = begun["project"]["code"]
            .as_str()
            .or(begun["project"].as_str())
            .unwrap_or_else(|| panic!("{begun}"))
            .to_owned();
    });
    let mut keys = Vec::new();
    a.flow("W3 建 5 个任务（带依赖）", 1, |a| {
        let created = a.call(
            "atm_task_create",
            json!({"items": [
                {"title": "A", "checklist": [{"title": "一"}, {"title": "二"}]},
                {"title": "B", "depends_on": ["1"]},
                {"title": "C", "depends_on": ["1"]},
                {"title": "D", "depends_on": ["2", "3"]},
                {"title": "E"}
            ]}),
        );
        // 回执的 refs 把批内序号（没写 client_ref 时）映射到 key（11 P2-4）。
        keys = (1..=5)
            .map(|i| created["refs"][i.to_string()].as_str().unwrap().to_owned())
            .collect();
    });
    assert_eq!(keys.len(), 5);
    a.flow(
        "W4 领任务 → 带证据完成（2 条检查项）",
        2,
        |a| {
            a.call(
                "atm_task_patch",
                json!({"task_key": keys[0], "operation": "start"}),
            );
            a.call(
            "atm_task_patch",
            json!({"task_key": keys[0], "operation": "complete", "evidence": ["cargo test 全绿"],
                   "checklist": [{"item": 1, "status": "DONE"}, {"item": 2, "status": "DONE"}]}),
        );
        },
    );
    assert_eq!(status_of(&r, &project, &keys[0]), "DONE");
    a.flow("W5 记进度 + 记决策", 2, |a| {
        a.call("atm_progress_add", json!({"summary": "A 做完了"}));
        a.call(
            "atm_record",
            json!({"kind": "DECISION", "title": "用金标脚本", "summary": "U-2 经真实桥"}),
        );
    });
    a.flow("W6 等用户", 1, |a| {
        a.call(
            "atm_task_patch",
            json!({"task_key": keys[1], "operation": "wait_user", "waiting_for": "请确认 B 的口径"}),
        );
    });
    assert_eq!(status_of(&r, &project, &keys[1]), "WAITING_USER");
    a.flow("W9 结束", 1, |a| {
        a.call("atm_end", json!({"summary": "今天到这里"}));
    });

    a.flow("W1 已有项目开工", 1, |a| {
        a.call("atm_begin", json!({"agent_id": "claude-code", "cwd": cwd}));
    });
    a.flow("W7 上下文压缩后继续", 1, |a| {
        let brief = a.call("atm_brief", json!({}));
        assert!(brief.is_object(), "{brief}");
    });
    // 开工一个任务，然后 Agent 崩溃：替身被杀，桥随 stdin 关闭退出。
    a.call(
        "atm_task_patch",
        json!({"task_key": keys[2], "operation": "start"}),
    );
    drop(a);

    let mut a = Agent::start(&r, "claude-code");
    a.flow("W8 崩溃后重启", 1, |a| {
        let begun = a.call("atm_begin", json!({"agent_id": "claude-code", "cwd": cwd}));
        // 客户端已经退出的旧 session 就地关闭并被接上（R11 P1-3），领取跟着过来。
        assert_eq!(begun["outcome"], json!("SUCCESSOR"), "{begun}");
        assert_eq!(begun["own"], json!([keys[2]]), "{begun}");
    });
    // 自己领取的任务照常写：领取随 auto resume 接过来，不报 CLAIM_NOT_OWNED。
    a.call(
        "atm_task_patch",
        json!({"task_key": keys[2], "operation": "complete", "evidence": ["重启后完成"]}),
    );
    assert_eq!(status_of(&r, &project, &keys[2]), "DONE");
}

// ---- U-6 安全规则零摩擦（11 §5，10 R11）-----------------------------------------------------------
//
// 正常路径上 Agent 只照 instructions 做，每一次调用都必须成功（于是 CLAIM_NOT_OWNED、VERSION_CONFLICT、
// IDEMPOTENCY_CONFLICT 一个都没有）；反例照常被拒。全部经真实桥，Agent 由替身进程扮演。

/// 新仓库开工、建一个任务并开工，返回 (项目代码, 任务 key)。
fn u6_open(a: &mut Agent, cwd: &str) -> (String, String) {
    let begun = a.call(
        "atm_begin",
        json!({"agent_id": "claude-code", "cwd": cwd, "allow_project_create": true}),
    );
    let project = begun["project"]["code"]
        .as_str()
        .or(begun["project"].as_str())
        .unwrap()
        .to_owned();
    let created = a.call("atm_task_create", json!({"items": [{"title": "实现"}]}));
    let task = created["refs"]["1"].as_str().unwrap().to_owned();
    a.call(
        "atm_task_patch",
        json!({"task_key": task, "operation": "start"}),
    );
    (project, task)
}

fn u6_repo(r: &Rig, name: &str) -> String {
    let repo = r.w.dir.join(name);
    std::fs::create_dir_all(&repo).unwrap();
    repo.display().to_string()
}

/// 单 Agent：开工、记进度、记决策、带证据完成、结束，一路零错误。
#[test]
fn u6_single_agent_has_no_friction() {
    let r = rig("bridge-u6-single");
    let cwd = u6_repo(&r, "repo");
    let mut a = Agent::start(&r, "claude-code");
    let (project, task) = u6_open(&mut a, &cwd);
    a.call(
        "atm_progress_add",
        json!({"task_key": task, "summary": "写了一半"}),
    );
    a.call(
        "atm_record",
        json!({"kind": "DECISION", "title": "选型", "summary": "用 Rust"}),
    );
    a.call(
        "atm_task_patch",
        json!({"task_key": task, "operation": "complete", "evidence": ["测试全绿"]}),
    );
    a.call("atm_end", json!({"summary": "完成"}));
    assert_eq!(status_of(&r, &project, &task), "DONE");
}

/// 上下文压缩：Agent 丢了 session 等一切上下文。照 instructions 调无参 brief 接着写自己的任务；
/// 压缩后误以为要重新 begin（10 §419）也一样：同一连接组接回同一个 PRIMARY，继续写自己领取的任务。
#[test]
fn u6_compaction_keeps_the_agent_on_its_own_task() {
    let r = rig("bridge-u6-compact");
    let cwd = u6_repo(&r, "repo");
    let mut a = Agent::start(&r, "claude-code");
    let (project, task) = u6_open(&mut a, &cwd);
    let brief = a.call("atm_brief", json!({}));
    assert_eq!(brief["own"], json!([task]), "{brief}");
    // 要项目的其他读同样不用带 session（U-1：W4 里 task_get 拿检查项 id）。
    let got = a.call("atm_task_get", json!({"task_key": task}));
    assert_eq!(got["key"], json!(task), "{got}");
    a.call(
        "atm_progress_add",
        json!({"task_key": task, "summary": "压缩后继续"}),
    );
    let again = a.call("atm_begin", json!({"agent_id": "claude-code", "cwd": cwd}));
    assert_eq!(again["own"], json!([task]), "{again}");
    a.call(
        "atm_task_patch",
        json!({"task_key": task, "operation": "complete", "evidence": ["压缩后完成"]}),
    );
    assert_eq!(status_of(&r, &project, &task), "DONE");
}

/// 崩溃重启：Agent 进程没了，新进程 begin 自动接上旧会话（客户端已退出就立即关闭，R11 P1-3），
/// 领取随之转过来，直接写自己的任务。
#[test]
fn u6_a_crashed_agent_picks_up_its_own_task() {
    let r = rig("bridge-u6-crash");
    let cwd = u6_repo(&r, "repo");
    let mut a = Agent::start(&r, "claude-code");
    let (project, task) = u6_open(&mut a, &cwd);
    drop(a);
    let mut a = Agent::start(&r, "claude-code");
    let begun = a.call("atm_begin", json!({"agent_id": "claude-code", "cwd": cwd}));
    assert_eq!(begun["outcome"], json!("SUCCESSOR"), "{begun}");
    a.call(
        "atm_task_patch",
        json!({"task_key": task, "operation": "complete", "evidence": ["重启后完成"]}),
    );
    assert_eq!(status_of(&r, &project, &task), "DONE");
}

/// 丢响应重试：写入执行了、响应丢了，桥用同一份上下文重试，结果是重放，不是 IDEMPOTENCY_CONFLICT；
/// 之后照常写。
#[test]
fn u6_a_lost_response_is_replayed_not_refused() {
    let r = rig("bridge-u6-lost");
    let cwd = u6_repo(&r, "repo");
    let mut a = Agent::start(&r, "claude-code");
    let (project, task) = u6_open(&mut a, &cwd);
    r.proxy.then("write", Act::Drop);
    let progressed = a.call(
        "atm_progress_add",
        json!({"task_key": task, "summary": "只该写一次"}),
    );
    assert_eq!(progressed["replayed"], json!(true), "{progressed}");
    a.call(
        "atm_task_patch",
        json!({"task_key": task, "operation": "complete", "evidence": ["完成"]}),
    );
    assert_eq!(status_of(&r, &project, &task), "DONE");
}

/// 子代理：同一个 Agent 进程（同一连接组）里开 SUBAGENT 会话，显式带 session 做自己的任务；它不顶替
/// PRIMARY，主代理照旧省略 session 写自己的任务。
#[test]
fn u6_a_subagent_does_not_displace_the_primary() {
    let r = rig("bridge-u6-sub");
    let cwd = u6_repo(&r, "repo");
    let mut a = Agent::start(&r, "claude-code");
    let (project, task) = u6_open(&mut a, &cwd);
    let primary = primary_session(&r);
    let sub = a.call(
        "atm_begin",
        json!({"agent_id": "claude-code", "cwd": cwd, "role": "SUBAGENT"}),
    );
    let sub_session = sub["session"].as_str().unwrap().to_owned();
    let created = a.call(
        "atm_task_create",
        json!({"session": sub_session, "items": [{"title": "子任务"}]}),
    );
    let side = created["refs"]["1"].as_str().unwrap().to_owned();
    a.call(
        "atm_task_patch",
        json!({"session": sub_session, "task_key": side, "operation": "complete", "evidence": ["子代理完成"]}),
    );
    // 主代理：不带 session，还是自己的 PRIMARY 会话。
    a.call(
        "atm_progress_add",
        json!({"task_key": task, "summary": "主代理继续"}),
    );
    // R11 A2：同一连接里不带 session 的写入记在主 session 名下，子代理的 begin 不顶替它。
    assert_eq!(progress_session(&r, "主代理继续"), primary);
    assert_ne!(primary, sub_session);
    // `resume:false` 的 SUBAGENT begin 也不顶替（A1 的独立不变量）。
    let fresh = a.call(
        "atm_begin",
        json!({"agent_id": "claude-code", "cwd": cwd, "role": "SUBAGENT", "resume": false}),
    );
    let fresh = fresh["session"].as_str().unwrap().to_owned();
    assert_ne!(fresh, primary);
    a.call(
        "atm_progress_add",
        json!({"task_key": task, "summary": "子代理开过之后"}),
    );
    assert_eq!(progress_session(&r, "子代理开过之后"), primary);
    a.call(
        "atm_task_patch",
        json!({"task_key": task, "operation": "complete", "evidence": ["主代理完成"]}),
    );
    assert_eq!(status_of(&r, &project, &side), "DONE");
    assert_eq!(status_of(&r, &project, &task), "DONE");
}

/// 这个连接组唯一的 ONLINE PRIMARY session。
fn primary_session(r: &Rig) -> String {
    r.w.svc
        .store()
        .read(|tx| {
            tx.query_row(
                "SELECT id FROM agent_sessions WHERE client_identity LIKE '%@claude-code'
                   AND role = 'PRIMARY' AND connection_state = 'ONLINE'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap()
}

/// 按摘要找到的那条任务进度记在哪个 session 名下。
fn progress_session(r: &Rig, summary: &str) -> String {
    r.w.svc
        .store()
        .read(|tx| {
            tx.query_row(
                "SELECT session_id FROM progress_updates WHERE summary = ?1",
                [summary],
                |row| row.get(0),
            )
        })
        .unwrap()
}

/// 静默编码 30 分钟：这段时间没有任何调用，心跳与领取租约都过了期。客户端进程还活着，扫描不关它的会话
/// （只按 120 分钟兜底），回来照常写自己的任务。
#[test]
fn u6_thirty_silent_minutes_cost_nothing() {
    let r = rig("bridge-u6-silent");
    let cwd = u6_repo(&r, "repo");
    let mut a = Agent::start(&r, "claude-code");
    let (project, task) = u6_open(&mut a, &cwd);
    let ago = {
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        atm_domain::time::Timestamp::from_millis(ms - 30 * 60_000).to_string()
    };
    r.w.svc
        .store()
        .write(move |tx| {
            tx.execute(
                "UPDATE agent_sessions SET heartbeat_at = ?1, updated_at = ?1 WHERE client_identity LIKE '%@claude-code' AND connection_state = 'ONLINE'",
                [&ago],
            )?;
            tx.execute(
                "UPDATE work_items SET claim_lease_until = ?1 WHERE claimed_by_session_id IS NOT NULL",
                [&ago],
            )
        })
        .unwrap();
    let swept =
        r.w.svc
            .sweep_sessions(
                &Principal::system_job(atm_domain::principal::JobId::StartupRecover),
                atm_service::session::SweepPolicy::default(),
                &atm_jobs::liveness::alive,
            )
            .unwrap();
    // 本 Agent 的会话（客户端还活着）不被关；夹具里另一个没有客户端身份的旧会话不在这次断言里。
    let ours: Vec<String> = r
        .w
        .svc
        .store()
        .read(|tx| {
            tx.prepare("SELECT id FROM agent_sessions WHERE client_identity LIKE '%@claude-code'")?
                .query_map([], |row| row.get(0))?
                .collect()
        })
        .unwrap();
    assert!(!ours.is_empty());
    assert!(
        swept.closed.iter().all(|(_, id, _)| !ours.contains(id)),
        "{:?}",
        swept.closed
    );
    a.call(
        "atm_task_patch",
        json!({"task_key": task, "operation": "complete", "evidence": ["30 分钟后完成"]}),
    );
    assert_eq!(status_of(&r, &project, &task), "DONE");
}

/// 反例照常被拒：别的 Agent 改不了我领取的任务；它改我的任务内容要带版本；我自己改任务内容
/// （edit）也要带版本。正常路径的放宽没有漏到这些地方。
#[test]
fn u6_the_rules_still_refuse_what_they_should() {
    let r = rig("bridge-u6-refuse");
    let cwd = u6_repo(&r, "repo");
    let mut mine = Agent::start(&r, "claude-code");
    let (project, task) = u6_open(&mut mine, &cwd);
    let mut other = Agent::start(&r, "codex-mcp-client");
    other.call(
        "atm_begin",
        json!({"agent_id": "codex", "project": project}),
    );
    assert_eq!(
        other.refused(
            "atm_task_patch",
            json!({"task_key": task, "operation": "complete", "evidence": ["抢着完成"]})
        ),
        "CLAIM_NOT_OWNED"
    );
    let cross = other.refused(
        "atm_task_patch",
        json!({"task_key": task, "operation": "edit", "title": "被改名"}),
    );
    assert!(
        matches!(
            cross.as_str(),
            "CLAIM_NOT_OWNED" | "EXPECTED_VERSION_REQUIRED"
        ),
        "{cross}"
    );
    assert_eq!(
        mine.refused(
            "atm_task_patch",
            json!({"task_key": task, "operation": "edit", "title": "改名"})
        ),
        "EXPECTED_VERSION_REQUIRED"
    );
    assert_eq!(status_of(&r, &project, &task), "IN_PROGRESS");
}
