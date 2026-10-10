//! MCP 桥观测（06 getMcpBridges「替」、W6f）：真实进程上的原生枚举，按 3.0 的 `atm-mcp.exe` 分类。
//!
//! 用例把自己的测试程序复制成 `codex.exe` 与 `<L>\current\resources\atm-mcp.exe`，由前者拉起后者（一个 Agent
//! 客户端拉起的桥）；再由用例自己直接拉起一份同路径的副本（父进程不是 Agent 客户端，不算）。两个副本都只跑
//! 下面的 `bridge_helper`：等停止文件出现就退出。观测本身不起任何进程（静态守卫）。

use atm_agents::env::{AgentEnv, Cli};
use atm_agents::integrations::{Agents, Gate};
use atm_agents::{AgentError, Settings};
use atm_domain::principal::{Principal, UiSurface};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

const ROLE: &str = "ATM_BRIDGE_TEST_ROLE";
const STOP: &str = "ATM_BRIDGE_TEST_STOP";
const SHIM: &str = "ATM_BRIDGE_TEST_SHIM";
const HELPER: [&str; 4] = ["bridge_helper", "--exact", "--ignored", "--test-threads=1"];

struct NoCli;
impl Cli for NoCli {
    fn run(&self, _: &Path, _: &[String]) -> Result<(), String> {
        panic!("observing bridges must not run a CLI")
    }
}

struct On;
impl Settings for On {
    fn memory_profile_enabled(&self) -> bool {
        true
    }
    fn commit_memory_profile(&self, _: &Principal, _: bool) -> Result<(), AgentError> {
        unreachable!()
    }
}

fn dir(name: &str) -> PathBuf {
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target"));
    let d = target.join("agents-bridge-tests").join(name);
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

/// 观测代码里起进程的痕迹（2.0 起 PowerShell 与 typeperf 采样）。
fn spawning(text: &str) -> Vec<&'static str> {
    const FORBIDDEN: [&str; 5] = [
        "Command::new",
        "std::process",
        "powershell",
        "typeperf",
        "wmic",
    ];
    FORBIDDEN
        .into_iter()
        .filter(|needle| {
            text.to_ascii_lowercase()
                .contains(&needle.to_ascii_lowercase())
        })
        .collect()
}

/// 两个副本都跑这一个：`owner`（名为 codex.exe）先拉起桥，再一起等停止文件。直接 `cargo test` 时什么也不做。
#[test]
#[ignore = "helper: run under a copied name by the bridge test"]
fn bridge_helper() {
    let Ok(role) = std::env::var(ROLE) else {
        return;
    };
    let stop = PathBuf::from(std::env::var_os(STOP).expect("stop file"));
    let mut bridge = (role == "owner").then(|| {
        Command::new(std::env::var_os(SHIM).expect("shim path"))
            .args(HELPER)
            .env(ROLE, "bridge")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("start the bridge copy")
    });
    let deadline = Instant::now() + Duration::from_secs(60);
    while !stop.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    if let Some(b) = bridge.as_mut() {
        let _ = b.wait();
    }
}

fn helper(exe: &Path, role: &str, stop: &Path, shim: &Path) -> std::process::Child {
    Command::new(exe)
        .args(HELPER)
        .env(ROLE, role)
        .env(STOP, stop)
        .env(SHIM, shim)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap_or_else(|e| panic!("start {}: {e}", exe.display()))
}

#[test]
fn bridges_are_found_natively_by_the_atm_mcp_image_and_their_owner() {
    let source =
        fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/bridges.rs")).unwrap();
    // 注释里会提到 2.0 怎么做的；只看代码行。
    let code: String = source
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        code.contains("CreateToolhelp32Snapshot"),
        "the scan sees the code"
    );
    let found = spawning(&code);
    assert!(found.is_empty(), "bridges.rs starts processes: {found:?}");
    // 阳性对照：2.0 的采样写法会被认出来。
    assert_eq!(
        spawning("let out = std::process::Command::new(\"powershell.exe\");"),
        ["Command::new", "std::process", "powershell"]
    );

    let root = dir("observe");
    let l = root.join("L");
    let shim = l.join("current").join("resources").join("atm-mcp.exe");
    fs::create_dir_all(shim.parent().unwrap()).unwrap();
    let me = std::env::current_exe().unwrap();
    fs::copy(&me, &shim).unwrap();
    let codex = root.join("codex.exe");
    fs::copy(&me, &codex).unwrap();
    let stop = root.join("stop");

    let home = root.join("home");
    let env = AgentEnv {
        appdata: home.join("AppData").join("Roaming"),
        localappdata: home.join("AppData").join("Local"),
        path: None,
        legacy_root: l.clone(),
        // `L\current\resources\atm-mcp.exe` 在：桥命令就是它（3.0 的映像），不是 2.x 的 atm-core。
        launch: atm_agents::env::launch_for(&l, Path::new(r"C:\nowhere\atm-mcp.exe")),
        cli: Arc::new(NoCli),
        home,
    };
    assert_eq!(Path::new(&env.launch.command), shim.as_path());
    let agents = Agents::new(
        env,
        Arc::new(On),
        Gate {
            manage_configs: false,
        },
        Vec::new(),
    );
    let user = Principal::trusted_ui(UiSurface::WebView {
        generation: 1,
        epoch: 1,
    });

    let mut owner = helper(&codex, "owner", &stop, &shim);
    // 同一路径的副本，但父进程是这个用例（不是 Agent 客户端）：不算。
    let mut stray = helper(&shim, "bridge", &stop, &shim);
    let deadline = Instant::now() + Duration::from_secs(30);
    let observed: Option<Value> = loop {
        let v = agents.bridges(&user).unwrap();
        if v["bridges"].as_array().is_some_and(|b| !b.is_empty()) {
            break Some(v);
        }
        if Instant::now() >= deadline {
            break None;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    // 先确认那份不算的副本确实在跑（否则「不算」是空转）。
    let snapshot = atm_agents::bridges::snapshot();
    let stray_seen = snapshot.iter().any(|p| {
        p.pid == stray.id()
            && p.path
                .as_deref()
                .is_some_and(|path| path.eq_ignore_ascii_case(&shim.to_string_lossy()))
    });
    fs::write(&stop, "").unwrap();
    let _ = owner.wait();
    let _ = stray.wait();

    let v = observed.expect("the bridge started by codex.exe is observed");
    assert!(stray_seen, "the stray copy was running under the same path");
    let bridges = v["bridges"].as_array().unwrap();
    assert_eq!(bridges.len(), 1, "{v}");
    let b = &bridges[0];
    assert_eq!(b["ownerPid"], owner.id(), "{v}");
    assert_eq!(b["ownerName"], "codex", "{v}");
    assert!(
        b["pid"]
            .as_u64()
            .is_some_and(|p| p != u64::from(stray.id())),
        "{v}"
    );
    assert!(b["privateBytes"].as_u64().is_some_and(|n| n > 0), "{v}");
    assert!(
        b["startedAt"].as_str().is_some_and(|s| s.starts_with("20")),
        "{v}"
    );
    assert_eq!(v["totalPrivateBytes"], b["privateBytes"]);
    assert_eq!(v["metric"], "PRIVATE_BYTES");
    let _ = fs::remove_dir_all(&root);
}
