//! atm.exe 黑盒用例的共用夹具：新库 + 真实服务 + 真实 Agent HTTP（与 http/tests/support 同一套搭法），
//! 数据根 `N` 是用例自己的目录，`runtime\daemon.json` 指向这个监听器；atm.exe 作为子进程经它发现服务。
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
use std::path::{Path, PathBuf};
use std::process::Command;
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
    /// 数据根 `N`。
    pub root: PathBuf,
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
        .join("cli-tests")
        .join(name)
}

/// 一个新库：建项目与 session（begin），建一个任务，起监听器，写 daemon.json。
pub fn world(name: &str) -> World {
    let root = test_dir(name);
    let _ = std::fs::remove_dir_all(&root);
    let data = root.join("data");
    std::fs::create_dir_all(&data).unwrap();
    let store = Store::open(&data.join("atm.sqlite"), Config::default()).unwrap();
    store
        .write(move |tx| {
            tx.execute_batch(
                "INSERT INTO app_meta (singleton, schema_version, data_root_id, generation, instance_epoch, created_at, updated_at)
                 VALUES (1, 1, 'ROOT', 'G', 'EPOCH', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z')",
            )
        })
        .unwrap();
    let svc = Arc::new(
        Service::new(store)
            .with_backups_root(root.join("backups"))
            .with_liveness(Arc::new(atm_jobs::liveness::alive)),
    );
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
            app(
                state,
                routes(&PROFILES, surface.handler())
                    .merge(surface.resolve_routes())
                    .merge(surface.rest_routes(
                        surface.handler(),
                        Arc::new(|| json!({"version": "3.0.0-test", "conversion": {"phase": "PUBLISHED"}})),
                    )),
            ),
            std::future::pending::<()>(),
        ));
        port
    });
    write_descriptor(&root, port, TOKEN);
    World {
        port,
        svc,
        project,
        project_id,
        session,
        task,
        root,
        _rt: rt,
    }
}

/// 只有库、没有服务的数据根：`data\atm.sqlite` 建好后关掉（没有 `-wal`），供本地拒绝与离线命令用。
pub fn bare_root(name: &str) -> PathBuf {
    let root = test_dir(name);
    let _ = std::fs::remove_dir_all(&root);
    let data = root.join("data");
    std::fs::create_dir_all(&data).unwrap();
    {
        let store = Store::open(&data.join("atm.sqlite"), Config::default()).unwrap();
        store
            .write(move |tx| {
                tx.execute_batch(
                    "INSERT INTO app_meta (singleton, schema_version, data_root_id, generation, instance_epoch, created_at, updated_at)
                     VALUES (1, 1, 'ROOT', 'G', 'EPOCH', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z')",
                )
            })
            .unwrap();
    }
    root
}

/// 只数连接的假服务：每个连接回一个 `200 {}`。P-010 的「收到 0 个请求」靠它判定。
pub struct Mock {
    pub port: u16,
    pub hits: Arc<std::sync::atomic::AtomicUsize>,
}

impl Mock {
    pub fn start() -> Mock {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = hits.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                // 读完整个请求（头 + Content-Length 的 body）再回：只读一次就关，客户端还在写 body 时会被重置。
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut request = Vec::new();
                let mut buf = [0u8; 4096];
                loop {
                    let head_end = request.windows(4).position(|w| w == b"\r\n\r\n");
                    if let Some(end) = head_end {
                        let head = String::from_utf8_lossy(&request[..end]).to_ascii_lowercase();
                        let length = head
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:"))
                            .and_then(|v| v.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                    match stream.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => request.extend_from_slice(&buf[..n]),
                    }
                }
                let _ = stream.write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}",
                );
            }
        });
        Mock { port, hits }
    }

    pub fn hits(&self) -> usize {
        self.hits.load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// 数据根下每个文件的相对路径与内容（比对「零副作用」用）。
pub fn tree(root: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
    let mut out = std::collections::BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                stack.push(path);
            } else {
                let rel = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                // 被别的进程锁住的文件（服务的准入锁）读不了：记一个占位值，名字照样比对。
                let bytes = std::fs::read(&path).unwrap_or_else(|_| b"<locked>".to_vec());
                out.insert(rel, bytes);
            }
        }
    }
    out
}

/// 等 [`tree`] 稳定下来再返回：连续两次一样、没有读不了的文件（最多 5 s，之后照样返回最后一次）。
/// 只用在没有服务锁着文件的根上，拍「之前」的快照。
pub fn settled_tree(root: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let mut last = tree(root);
    loop {
        std::thread::sleep(std::time::Duration::from_millis(50));
        let now = tree(root);
        let locked = now.values().any(|v| v.as_slice() == b"<locked>");
        if (now == last && !locked) || std::time::Instant::now() >= deadline {
            return now;
        }
        last = now;
    }
}

/// 两棵 [`tree`] 不同的地方：多出、少了、内容变了的文件，各自的字节数或 `<locked>`。
pub fn tree_diff(
    before: &std::collections::BTreeMap<String, Vec<u8>>,
    after: &std::collections::BTreeMap<String, Vec<u8>>,
) -> String {
    let show = |v: Option<&Vec<u8>>| match v {
        None => "absent".to_owned(),
        Some(b) if b.as_slice() == b"<locked>" => "<locked>".to_owned(),
        Some(b) => format!("{} bytes", b.len()),
    };
    let keys: std::collections::BTreeSet<_> = before.keys().chain(after.keys()).collect();
    keys.into_iter()
        .filter(|k| before.get(*k) != after.get(*k))
        .map(|k| format!("{k}: {} -> {}", show(before.get(k)), show(after.get(k))))
        .collect::<Vec<_>>()
        .join("; ")
}

/// 与宿主发布的同一个形状（`runtime\daemon.json`）。
pub fn write_descriptor(root: &Path, port: u16, token: &str) {
    let runtime = root.join("runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    std::fs::write(
        runtime.join("daemon.json"),
        json!({
            "endpoint": format!("http://127.0.0.1:{port}"),
            "token": token,
            "pid": std::process::id(),
            "instanceId": "0123456789abcdef0123456789abcdef",
            "version": "3.0.0-test",
            "layout": "single",
            "generation": 1,
        })
        .to_string(),
    )
    .unwrap();
}

pub struct Run {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl Run {
    pub fn json(&self) -> Value {
        serde_json::from_str(self.stdout.trim()).unwrap_or_else(|e| {
            panic!(
                "stdout is not JSON ({e}): {}\nstderr: {}",
                self.stdout, self.stderr
            )
        })
    }
}

/// 以数据根 `root` 跑一次 atm.exe：合成的 LOCALAPPDATA，清掉覆盖与 2.x 根的环境变量，工作目录在根里。
pub fn atm_in(root: &Path, args: &[&str]) -> Run {
    atm_with(root, args, &[])
}

pub fn atm_with(root: &Path, args: &[&str], env: &[(&str, &str)]) -> Run {
    atm_full(Path::new(env!("CARGO_BIN_EXE_atm")), root, args, env, None)
}

/// 任意位置的 atm.exe（例如拷进合成的安装布局），可选地从 stdin 喂一段输入（不喂就是立即 EOF）。
pub fn atm_full(
    exe: &Path,
    root: &Path,
    args: &[&str],
    env: &[(&str, &str)],
    input: Option<&str>,
) -> Run {
    use std::io::Write;
    use std::process::Stdio;
    let mut command = Command::new(exe);
    command
        .args(args)
        .current_dir(root)
        .env("ATM3_DATA_DIR", root)
        .env("LOCALAPPDATA", root.join("localappdata"))
        .env_remove("ATM_ENDPOINT")
        .env_remove("ATM_TOKEN")
        .env_remove("ATM_DATA_DIR")
        .env_remove("AYANAMI_TASK_DATA_DIR")
        .env_remove("ATM_TEST_MODE")
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in env {
        command.env(key, value);
    }
    let mut child = command.spawn().expect("run atm.exe");
    if let Some(input) = input {
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(input.as_bytes()).unwrap();
    }
    let output = child.wait_with_output().expect("wait for atm.exe");
    Run {
        code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    }
}

impl World {
    pub fn atm(&self, args: &[&str]) -> Run {
        atm_in(&self.root, args)
    }

    /// `--json` 跑，要求退出码 0，返回 stdout 的 JSON。
    pub fn ok(&self, args: &[&str]) -> Value {
        let mut all = vec!["--json"];
        all.extend_from_slice(args);
        let run = self.atm(&all);
        assert_eq!(
            run.code, 0,
            "{args:?}\nstdout: {}\nstderr: {}",
            run.stdout, run.stderr
        );
        run.json()
    }

    pub fn agent(&self) -> Principal {
        Principal::authenticated_agent(None)
    }
}
