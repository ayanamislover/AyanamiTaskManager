//! W5a：宿主与服务是同一个进程。
//!
//! - 静态守卫：GUI 路径（`app.rs`、`service.rs`）不引用 Node core 的监管（`core_process`、`Core::spawn`、
//!   `layout.core`、host-control 帧）。
//! - 真实进程：在合成的 LOCALAPPDATA 下后台启动开发版宿主。服务在宿主进程里开起来（`/health` 答的就是宿主的 pid），
//!   宿主没有任何子进程，旧根 `L` 一个文件也没写；QUIT 之后入口撤干净、进程退出码 0。
//! - 旧版没静止（`L\runtime\daemon.lock` 的持有者还活着）时不开任何入口，持有者走了之后再开。

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use atm_install_state::ipc;
use serde_json::Value;

const HOST: &str = env!("CARGO_BIN_EXE_AyanamiTaskManager");

fn source(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// GUI 路径里出现的 Node core 监管痕迹。
fn node_core_references(text: &str) -> Vec<&'static str> {
    const FORBIDDEN: [&str; 7] = [
        "core_process",
        "Core::spawn",
        "CoreEvent",
        "layout.core",
        "core-stderr",
        "host-control",
        "CORE_EXIT_REJECTED",
    ];
    FORBIDDEN
        .into_iter()
        .filter(|needle| text.contains(needle))
        .collect()
}

#[test]
fn the_gui_path_never_supervises_a_node_core() {
    for file in ["app.rs", "service.rs"] {
        let found = node_core_references(&source(file));
        assert!(found.is_empty(), "{file} still references {found:?}");
    }
    // 阳性对照：守卫认得出 W4 时的写法。
    let w4 = "use crate::core_process::{CORE_EXIT_REJECTED, Core, CoreEvent, Launch, Spawn};\n\
              match Core::spawn(&self.layout.core, &self.layout.data_dir, spawn) {}";
    assert_eq!(
        node_core_references(w4),
        [
            "core_process",
            "Core::spawn",
            "CoreEvent",
            "layout.core",
            "CORE_EXIT_REJECTED"
        ]
    );
}

struct Sandbox {
    root: PathBuf,
}

impl Sandbox {
    fn new(name: &str) -> Sandbox {
        let root = Path::new(env!("CARGO_TARGET_TMPDIR"))
            .join("host-single")
            .join(format!("{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("local")).unwrap();
        Sandbox { root }
    }
    fn local(&self) -> PathBuf {
        self.root.join("local")
    }
    /// 没有覆盖时宿主用的两个根，都在合成的 LOCALAPPDATA 里。
    fn legacy(&self) -> PathBuf {
        self.local().join("AyanamiTaskManager")
    }
    fn n(&self) -> PathBuf {
        self.local().join("AyanamiTaskManager3")
    }

    fn host_log(&self) -> String {
        std::fs::read_to_string(self.n().join("logs").join("host.log")).unwrap_or_default()
    }

    fn start(&self) -> Running {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..");
        let mut command = Command::new(HOST);
        command
            .arg("--background")
            .env("LOCALAPPDATA", self.local())
            .env("ATM_DEV_REPOSITORY_ROOT", repo)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        for key in ["ATM_DATA_DIR", "AYANAMI_TASK_DATA_DIR", "ATM3_DATA_DIR"] {
            command.env_remove(key);
        }
        Running(command.spawn().expect("start the host"))
    }
}

/// 用例失败（panic）时也结束自己拉起的宿主，不留给下一个用例或 cargo。
struct Running(Child);

impl Drop for Running {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn wait_for<T>(timeout: Duration, mut probe: impl FnMut() -> Option<T>) -> Option<T> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(value) = probe() {
            return Some(value);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn descriptor(n: &Path) -> Option<Value> {
    let bytes = std::fs::read(n.join("runtime").join("daemon.json")).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// 不要令牌的 `GET /health`。
fn health(port: u16) -> Option<Value> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    write!(
        stream,
        "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )
    .ok()?;
    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;
    let (head, body) = response.split_once("\r\n\r\n")?;
    head.starts_with("HTTP/1.1 200").then_some(())?;
    serde_json::from_str(body.trim()).ok()
}

fn port_of(descriptor: &Value) -> u16 {
    descriptor["endpoint"]
        .as_str()
        .and_then(|e| e.strip_prefix("http://127.0.0.1:"))
        .and_then(|p| p.parse().ok())
        .expect("daemon.json endpoint")
}

fn children_of(pid: u32) -> Vec<String> {
    atm_install_state::procs::snapshot()
        .into_iter()
        .filter(|p| p.parent == pid && p.pid != pid)
        .map(|p| format!("{} {:?}", p.pid, p.image))
        .collect()
}

fn quit_and_wait(sandbox: &Sandbox, Running(child): &mut Running) -> Option<i32> {
    assert!(
        ipc::send(
            &sandbox.legacy(),
            &ipc::Command::Quit,
            Duration::from_secs(5)
        ),
        "QUIT reaches the host over the pipe named after L"
    );
    let status = wait_for(Duration::from_secs(40), || child.try_wait().ok().flatten());
    status.and_then(|s| s.code())
}

fn files_under(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                out.push(path);
            }
        }
    }
    out
}

#[test]
fn the_service_runs_inside_the_host_process() {
    let sandbox = Sandbox::new("serve");
    let mut child = sandbox.start();
    let pid = child.0.id();
    let started = wait_for(Duration::from_secs(60), || descriptor(&sandbox.n()));
    let Some(started) = started else {
        panic!(
            "no daemon.json under N within 60 s:\n{}",
            sandbox.host_log()
        );
    };
    assert_eq!(
        started["pid"].as_u64(),
        Some(u64::from(pid)),
        "daemon.json names the host"
    );
    assert_eq!(started["layout"], "single");
    let answer = health(port_of(&started)).expect("/health answers");
    assert_eq!(
        answer["pid"].as_u64(),
        Some(u64::from(pid)),
        "the service is the host process"
    );
    assert_eq!(answer["instanceId"], started["instanceId"]);

    // 单进程：没有 Node core、没有 atm-core.exe，也没有别的子进程（后台启动不建 WebView2）。
    let children = children_of(pid);
    assert!(children.is_empty(), "the host has children: {children:?}");

    // host.json 与宿主日志在 N；旧根 L 一个文件也没写。
    let record = ipc::read_host_record(&sandbox.n()).expect("N\\runtime\\host.json");
    assert_eq!(record.pid, pid);
    assert!(sandbox.n().join("logs").join("host.log").is_file());
    assert!(
        files_under(&sandbox.legacy()).is_empty(),
        "the host wrote into L: {:?}",
        files_under(&sandbox.legacy())
    );

    let code = quit_and_wait(&sandbox, &mut child);
    assert_eq!(code, Some(0), "QUIT ends the host cleanly");
    assert!(
        descriptor(&sandbox.n()).is_none(),
        "daemon.json is withdrawn on quit"
    );
    assert!(
        health(port_of(&started)).is_none(),
        "the old port no longer answers"
    );
}

/// 宿主的依赖声明打开 e2e 特性的地方（`features = [... "e2e" ...]` 或 `[features]` 里转发 `/e2e`）。
fn e2e_features(manifest: &str) -> Vec<String> {
    manifest
        .lines()
        .map(str::trim)
        .filter(|l| !l.starts_with('#'))
        .filter(|l| l.contains("\"e2e\"") || l.contains("/e2e\""))
        .map(str::to_owned)
        .collect()
}

/// P-012：e2e 的界面来源（`User{E2eTest}`）只在测试构建里。成功例：这次构建里 `E2E_SURFACE` 是 false，宿主的
/// 编译期断言在、依赖声明没打开 e2e。反例：依赖声明打开 e2e 的写法守卫认得出（阳性对照）；真被打开时宿主编译
/// 不过（`main.rs` 的 `const _: () = assert!`）。最终候选二进制的符号与监听检查在 W8 打包时绑定哈希。
#[test]
fn p012_the_host_is_never_built_with_the_e2e_surface() {
    const { assert!(!atm_domain::principal::E2E_SURFACE) };
    let main = source("main.rs");
    assert!(
        main.contains("const _: () = assert!(\n    !atm_domain::principal::E2E_SURFACE"),
        "the compile-time guard is in main.rs"
    );
    let manifest =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml")).unwrap();
    let found = e2e_features(&manifest);
    assert!(found.is_empty(), "host/Cargo.toml enables e2e: {found:?}");
    assert_eq!(
        e2e_features(
            "atm-domain = { path = \"../domain\", features = [\"e2e\"] }\n\
             [features]\nui = [\"atm-ui-bridge/e2e\"]\n# \"e2e\" in a comment"
        )
        .len(),
        2
    );
}

/// `fn on_second_instance` 的函数体（到下一个同级方法为止）。
fn second_instance_body(app: &str) -> &str {
    let start = app
        .find("fn on_second_instance")
        .expect("app.rs has on_second_instance");
    let rest = &app[start..];
    let end = rest[1..].find("\n    fn ").map_or(rest.len(), |i| i + 1);
    &rest[..end]
}

/// 第二实例的命令走到用户主体、界面分发或数据写入的痕迹（03 P-009：只能控制窗口和生命周期）。
/// smoke 构建的看门狗命令会让写线程卡住，但不写数据，不在此列。
fn user_paths(text: &str) -> Vec<&'static str> {
    const FORBIDDEN: [&str; 8] = [
        "webview(",
        "tray()",
        "trusted_ui",
        "Principal",
        ".dispatch(",
        "dispatch_ui",
        "dispatch_agents",
        ".write(",
    ];
    FORBIDDEN
        .into_iter()
        .filter(|needle| text.contains(needle))
        .collect()
}

/// P-009：第二实例（同一用户的另一个进程）把 Show / Navigate / Wake / Quit 交给主实例就退出，不开第二份服务；
/// 主实例处理这些命令时不构造 User，也不碰数据。
#[test]
fn a_second_instance_hands_its_command_over_and_leaves() {
    let app = source("app.rs");
    let body = second_instance_body(&app);
    assert!(body.contains("Command::Quit"), "{body}");
    let found = user_paths(body);
    assert!(found.is_empty(), "on_second_instance reaches {found:?}");
    // 阳性对照：守卫认得出「第二实例的命令走界面分发」的写法。
    let wrong = "let principal = atm_ui_bridge::webview(self.generation, self.epoch);\n\
                 ui.dispatch(&principal, request);";
    assert_eq!(user_paths(wrong), ["webview(", ".dispatch("]);

    let sandbox = Sandbox::new("second");
    let mut first = sandbox.start();
    let pid = first.0.id();
    let Some(started) = wait_for(Duration::from_secs(60), || descriptor(&sandbox.n())) else {
        panic!(
            "no daemon.json under N within 60 s:\n{}",
            sandbox.host_log()
        );
    };
    // 第二个进程（`--background` 是 Agent 唤醒）：交出命令、退出码 0，主实例照常服务。
    let mut second = sandbox.start();
    let exited = wait_for(Duration::from_secs(20), || {
        second.0.try_wait().ok().flatten()
    });
    assert_eq!(
        exited.and_then(|s| s.code()),
        Some(0),
        "the second instance hands over and exits"
    );
    let now = descriptor(&sandbox.n()).expect("the first instance still serves");
    assert_eq!(
        now["instanceId"], started["instanceId"],
        "no second service"
    );
    assert_eq!(now["pid"].as_u64(), Some(u64::from(pid)));
    assert_eq!(
        health(port_of(&now)).and_then(|h| h["pid"].as_u64()),
        Some(u64::from(pid))
    );
    assert_eq!(
        ipc::read_host_record(&sandbox.n()).map(|r| r.pid),
        Some(pid),
        "host.json still names the first instance"
    );

    // 另一个进程发 QUIT：主实例干净退出。
    assert_eq!(quit_and_wait(&sandbox, &mut first), Some(0));
    assert!(descriptor(&sandbox.n()).is_none());
}

#[test]
fn no_entry_opens_while_the_legacy_service_holds_its_lease() {
    let sandbox = Sandbox::new("legacy");
    // 2.x 服务的 lease：持有者就是本测试进程（pid 与创建时间都对得上，2.x 的锁没有 layout 字段）。
    let me = atm_install_state::procs::find(std::process::id()).unwrap();
    let ticks = atm_install_state::procs::filetime_to_dotnet_ticks(me.created);
    let runtime = sandbox.legacy().join("runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let lock = runtime.join("daemon.lock");
    std::fs::write(
        &lock,
        format!(
            r#"{{"pid":{},"processIdentity":{{"createdAtTicks":"{ticks}"}}}}"#,
            me.pid
        ),
    )
    .unwrap();

    let mut child = sandbox.start();
    let waited = wait_for(Duration::from_secs(20), || {
        std::fs::read_to_string(sandbox.n().join("logs").join("host.log"))
            .ok()
            .filter(|log| log.contains("WAIT_LEGACY_QUIESCE"))
    });
    assert!(
        waited.is_some(),
        "the host reports that it waits for the 2.x service"
    );
    assert!(
        descriptor(&sandbox.n()).is_none(),
        "no entry while 2.x holds its lease"
    );
    assert!(
        !sandbox.n().join("runtime").join("daemon.lock").exists(),
        "no 3.x lease either"
    );

    // 2.x 退出（lease 放掉）：宿主下一次检查时开起来。这个旧根只有 lease、没有 registry，转换会按不支持的源拒绝，
    // 所以连旧根一起移走，走全新安装；真实 2.x 根的转换在 runtime 的 `tests/handoff.rs`。
    std::fs::remove_dir_all(sandbox.legacy()).unwrap();
    let started = wait_for(Duration::from_secs(60), || descriptor(&sandbox.n()));
    assert!(
        started.is_some(),
        "the service opens once the 2.x service is gone:\n{}",
        sandbox.host_log()
    );
    assert_eq!(quit_and_wait(&sandbox, &mut child), Some(0));
}
