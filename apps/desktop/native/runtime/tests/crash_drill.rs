//! W7e 崩溃演练（core-rust-plan「W0-S 演练」的 W7 部分：同步、ACK、通知与队列）。真的拉起开发用的无头二进制
//! （`atm-runtime --drill-mobile`：中继走 WinHttp，claude 是用例的假程序），没有窗口、没有 MCP 调用，在派单的会话
//! 正跑着、手机命令已经处理完但回执还没写出去的那一刻强行结束它（TerminateProcess），再原样启动：
//!
//! - 同步自己恢复上线，把崩溃期间手机发的命令接着处理掉；
//! - 崩溃前写好的回执原样还在，那条命令不再处理一遍；
//! - 写到一半的那条命令重做一次：任务不重复建、会话不重新拉起（命令 ID 作请求 ID 的持久幂等），回执补上；
//! - 留下的会话被新实例接管，跑完照常判定成功；
//! - 托盘与通知的观察器照样起来。
//!
//! 中继是用例进程里的内存中继，前面挂一个只听 127.0.0.1 的最小 HTTP 转发（端口取自真实的 bind，不猜）。
//! 子进程的 stderr 写到用例目录里的文件。

mod support;

#[path = "../../sync/tests/support/mod.rs"]
mod relay;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use atm_domain::principal::{Principal, UiSurface};
use atm_runtime::dispatch::process::{Native, Probe as _};
use atm_runtime::sync::transport::{HttpRequest, Transport as _};
use atm_runtime::{Background, Started};
use relay::MemoryRelay;
use relay::world::{Phone, phone_for};
use serde_json::{Value, json};
use support::*;

const DRILL_CLAUDE: &str = env!("CARGO_BIN_EXE_atm-drill-claude");
const RUNTIME: &str = env!("CARGO_BIN_EXE_atm-runtime");

fn user() -> Principal {
    Principal::trusted_ui(UiSurface::WebView {
        generation: 1,
        epoch: 1,
    })
}

fn wait_long(mut check: impl FnMut() -> bool, secs: u64, what: &str) {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < deadline {
        if check() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("等待超时：{what}");
}

fn ack_within(phone: &Phone, id: &str, secs: u64) -> Value {
    let mut ack = None;
    wait_long(
        || {
            ack = phone.store.read_ack(id).unwrap();
            ack.is_some()
        },
        secs,
        &format!("回执 {id}"),
    );
    ack.unwrap()
}

/// 127.0.0.1 上的最小 HTTP/1.1 转发：一条连接上顺序处理多个请求，交给内存中继。`hold` 为真时，写回执的 PUT
/// 不转发、一直挂着（像写到一半断了），`held` 记被挂住的次数。
struct Front {
    url: String,
    hold: Arc<AtomicBool>,
    held: Arc<AtomicUsize>,
}

fn front(relay: &MemoryRelay) -> Front {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let (hold, held) = (
        Arc::new(AtomicBool::new(false)),
        Arc::new(AtomicUsize::new(0)),
    );
    let (relay, h, n) = (relay.clone(), hold.clone(), held.clone());
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let (relay, h, n) = (relay.clone(), h.clone(), n.clone());
            std::thread::spawn(move || serve(stream, &relay, &h, &n));
        }
    });
    Front { url, hold, held }
}

fn serve(mut out: TcpStream, relay: &MemoryRelay, hold: &AtomicBool, held: &AtomicUsize) {
    let mut input = BufReader::new(out.try_clone().unwrap());
    loop {
        let mut line = String::new();
        if input.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let mut parts = line.split_whitespace();
        let method = match parts.next() {
            Some("GET") => "GET",
            Some("PUT") => "PUT",
            Some("POST") => "POST",
            Some("DELETE") => "DELETE",
            _ => return,
        };
        let target = parts.next().unwrap_or("/").to_owned();
        let (mut headers, mut length) = (Vec::new(), 0usize);
        loop {
            let mut h = String::new();
            if input.read_line(&mut h).unwrap_or(0) == 0 {
                return;
            }
            let h = h.trim_end();
            if h.is_empty() {
                break;
            }
            let Some((name, value)) = h.split_once(':') else {
                continue;
            };
            let value = value.trim().to_owned();
            if name.eq_ignore_ascii_case("content-length") {
                length = value.parse().unwrap_or(0);
            } else if name.eq_ignore_ascii_case("authorization") {
                headers.push(("Authorization", value));
            } else if name.eq_ignore_ascii_case("content-type") {
                headers.push(("Content-Type", value));
            }
        }
        let mut body = vec![0; length];
        if input.read_exact(&mut body).is_err() {
            return;
        }
        // 文档键在路径里是转义过的（`atm1%2F<空间>%2Fack%2F<命令>`）。
        let ack = target.to_ascii_lowercase().contains("%2fack%2f");
        if method == "PUT" && ack && hold.load(Ordering::SeqCst) {
            held.fetch_add(1, Ordering::SeqCst);
            while hold.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(20));
            }
            return;
        }
        let request = HttpRequest {
            method,
            url: format!("http://127.0.0.1{target}"),
            headers,
            body: (length > 0).then_some(body),
            timeout: Duration::from_secs(120),
        };
        let Ok(reply) = relay.send(&request, &[]) else {
            return;
        };
        let mut head = format!(
            "HTTP/1.1 {} R\r\nContent-Length: {}\r\n",
            reply.status,
            reply.body.len()
        );
        for (name, value) in &reply.headers {
            if !name.eq_ignore_ascii_case("content-length") {
                head.push_str(&format!("{name}: {value}\r\n"));
            }
        }
        head.push_str("\r\n");
        if out.write_all(head.as_bytes()).is_err() || out.write_all(&reply.body).is_err() {
            return;
        }
    }
}

/// 拉起的子进程：结束前（包括断言失败时）一定被结束。
struct Child(std::process::Child);

impl Child {
    fn kill(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

impl Drop for Child {
    fn drop(&mut self) {
        self.kill();
    }
}

/// 用例里拉起的假 claude：断言失败时也不留着。
struct Reap(Vec<u32>);

impl Drop for Reap {
    fn drop(&mut self) {
        for pid in &self.0 {
            if Native.is_alive(*pid) {
                let _ = Native.kill_tree(*pid);
            }
        }
    }
}

fn launch(n: &Path, l: &Path, claude: &Path, log: &Path) -> Child {
    let err = std::fs::File::create(log).unwrap();
    Child(
        Command::new(RUNTIME)
            .args(["--n".as_ref(), n.as_os_str()])
            .args(["--legacy".as_ref(), l.as_os_str()])
            .arg("--drill-mobile")
            .env("ATM_DRILL_CLAUDE", claude)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(err)
            .spawn()
            .unwrap(),
    )
}

fn in_process(o: &atm_runtime::Options) -> atm_runtime::Serving {
    let s = match atm_runtime::start(o).unwrap() {
        Started::Serving(s) => s,
        Started::Conflict(c) => panic!("conflict: {}", c.state.reason),
    };
    assert_eq!(
        s.background(Duration::from_secs(120)),
        Some(Background::Unchanged)
    );
    s
}

fn mobile(relay: &MemoryRelay, claude: &Path) -> atm_runtime::entries::Mobile {
    let claude = claude.to_path_buf();
    atm_runtime::entries::Mobile {
        resolve_claude: Arc::new(move || Some(claude.clone())),
        transport: Arc::new(MemoryRelay(relay.0.clone())),
        log: Arc::new(atm_runtime::sync::host::NoLog),
        base_env: std::env::vars_os().collect(),
        comspec: std::env::var_os("ComSpec").map(PathBuf::from),
        device_name: Some("演练电脑".into()),
        feature_wait: atm_runtime::dispatch::mobile::FEATURE_WAIT,
        track_every: Duration::from_millis(200),
    }
}

/// 界面任务列表里标题是 `title` 的条数。
fn count_titled(v: &Value, title: &str) -> usize {
    match v {
        Value::Object(m) => {
            usize::from(m.get("title").and_then(Value::as_str) == Some(title))
                + m.values().map(|x| count_titled(x, title)).sum::<usize>()
        }
        Value::Array(a) => a.iter().map(|x| count_titled(x, title)).sum(),
        _ => 0,
    }
}

fn dumps(work: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(work)
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("fake-claude-dump-") && n.ends_with(".json"))
        })
        .collect()
}

fn dump_of(path: &Path) -> Value {
    let mut v = Value::Null;
    wait_long(
        || {
            v = std::fs::read_to_string(path)
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or(Value::Null);
            !v.is_null()
        },
        10,
        "dump 写完",
    );
    v
}

#[test]
fn a_hard_crash_mid_dispatch_and_mid_ack_recovers_sync_acks_and_the_queue() {
    let d = dir("crash-drill");
    let (n, l) = (d.join("N"), legacy_root(&d));
    let work = d.join("work");
    std::fs::create_dir_all(&work).unwrap();
    // 每个用例一份假 claude 的副本：没结束干净的会话只锁住它，锁不住 cargo 要重写的那个 exe。
    let claude = d.join(format!("claude-{}.exe", std::process::id()));
    std::fs::copy(DRILL_CLAUDE, &claude).unwrap();
    let relay = MemoryRelay::new(true);
    let front = front(&relay);
    let events = Events::default();
    let mut o = options(&n, &l, &events);
    o.mobile = Some(mobile(&relay, &claude));

    // ── 0. 用户在电脑上配好：一个有工作目录的项目、开派单、开同步并配对。然后正常退出。
    let pairing = {
        let s = in_process(&o);
        let (svc, _) = s.service().unwrap();
        svc.create_project(
            &user(),
            atm_service::project::CreateProjectRequest {
                code: Some("MOB".into()),
                path: Some(atm_service::project::PathInfo {
                    canonical_path: work.to_string_lossy().into_owned(),
                    git_common_dir: None,
                }),
                ..atm_service::project::CreateProjectRequest::new("Mobile")
            },
        )
        .unwrap();
        drop(svc);
        let features = s.mobile().unwrap();
        features
            .dispatch()
            .unwrap()
            .update_config(&user(), &json!({ "enabled": true }))
            .unwrap();
        let sync = features.sync().unwrap();
        sync.update_config(
            &user(),
            &json!({ "enabled": true, "relayUrl": front.url, "token": relay::TOKEN }),
        )
        .unwrap();
        let pairing = sync.create_pairing(&user()).unwrap()["pairingCode"]
            .as_str()
            .unwrap()
            .to_owned();
        s.stop(&|_| {});
        pairing
    };
    let phone = phone_for(&relay, &pairing);
    std::fs::write(
        work.join("fake-claude.json"),
        json!({ "mode": "slow", "delayMs": 8000 }).to_string(),
    )
    .unwrap();

    // ── 1. 无头进程起来（没有窗口、没有 MCP）：同步自己上线，处理手机命令。
    let mut first = launch(&n, &l, &claude, &d.join("first.log"));
    let early = phone.send(json!({
        "type": "task.create",
        "body": { "project": "MOB", "title": "崩溃前已回执" },
    }));
    let early_ack = ack_within(&phone, &early, 60);
    assert_eq!(early_ack["ok"], true, "{early_ack}");

    // 下一条：建任务并派单。处理完、会话起来了，回执写到一半——此刻强行结束。
    front.hold.store(true, Ordering::SeqCst);
    let mid = phone.send(json!({
        "type": "task.create",
        "body": { "project": "MOB", "title": "崩溃时在派单", "dispatch": true },
    }));
    wait_long(|| front.held.load(Ordering::SeqCst) > 0, 60, "回执写到一半");
    wait_long(|| !dumps(&work).is_empty(), 30, "派单的会话起来");
    let session = dump_of(&dumps(&work)[0]);
    let pid = session["pid"].as_u64().unwrap() as u32;
    let _reap = Reap(vec![pid]);
    first.kill();
    front.hold.store(false, Ordering::SeqCst);
    assert!(Native.is_alive(pid), "宿主崩溃不带走会话");
    assert!(
        phone.store.read_ack(&mid).unwrap().is_none(),
        "回执确实没写出去"
    );

    // 崩溃期间手机又发了一条。
    let late = phone.send(json!({
        "type": "task.create",
        "body": { "project": "MOB", "title": "崩溃期间发的" },
    }));

    // ── 2. 原样再启动：同步自己恢复，两条都补上回执；会话被接管，没有再拉起。
    let second_log = d.join("second.log");
    let mut second = launch(&n, &l, &claude, &second_log);
    let mid_ack = ack_within(&phone, &mid, 60);
    assert_eq!(mid_ack["ok"], true, "{mid_ack}");
    let run = mid_ack["result"]["dispatch"]["run"]
        .as_str()
        .unwrap_or_else(|| panic!("{mid_ack}"))
        .to_owned();
    assert!(
        dumps(&work)[0]
            .to_string_lossy()
            .ends_with(&format!("fake-claude-dump-{run}.json")),
        "回执里的会话就是崩溃前起的那个：{mid_ack}"
    );
    let late_ack = ack_within(&phone, &late, 60);
    assert_eq!(late_ack["ok"], true, "{late_ack}");
    // 会话跑完，跟踪器（每 TRACK_INTERVAL 一轮）判定它。
    wait_long(|| !Native.is_alive(pid), 30, "会话结束");
    std::thread::sleep(atm_runtime::dispatch::dispatcher::TRACK_INTERVAL * 2);
    second.kill();
    let second_err = std::fs::read_to_string(&second_log).unwrap();
    assert!(
        second_err.contains("atm-runtime: tray "),
        "重启后托盘与通知的观察器起来了：{second_err}"
    );
    assert_eq!(dumps(&work).len(), 1, "会话只拉起过一次");

    // ── 3. 检查库：每条命令恰好生效一次，派单判定成功；崩溃前的回执原样还在。
    let s = in_process(&o);
    let (svc, _) = s.service().unwrap();
    let items = svc
        .ui_work_items(&user(), "MOB", &atm_service::ui::WorkItemFilter::default())
        .unwrap();
    for title in ["崩溃前已回执", "崩溃时在派单", "崩溃期间发的"] {
        assert_eq!(count_titled(&items, title), 1, "{title}：{items}");
    }
    drop(svc);
    let dispatch = s.mobile().unwrap().dispatch().unwrap();
    let runs = dispatch.list_runs();
    assert_eq!(runs.len(), 1, "{runs:?}");
    assert_eq!(runs[0]["run"], run.as_str());
    assert_eq!(runs[0]["state"], "succeeded", "{runs:?}");
    assert_eq!(phone.store.read_ack(&early).unwrap(), Some(early_ack));
    assert_eq!(dumps(&work).len(), 1, "会话只拉起过一次");
    s.stop(&|_| {});
}
