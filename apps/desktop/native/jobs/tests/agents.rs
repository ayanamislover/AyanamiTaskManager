//! Agent 接入的启动作业（W6d / W6e）：先装文档、再修复，两个作业各用自己的 System 主体；在合成的家目录里跑。

use atm_agents::env::{AgentEnv, Cli};
use atm_agents::integrations::{Agents, Gate};
use atm_agents::{AgentError, Settings};
use atm_domain::principal::Principal;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

struct NoCli;
impl Cli for NoCli {
    fn run(&self, _: &Path, _: &[String]) -> Result<(), String> {
        panic!("the startup jobs must not run the claude CLI here")
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
    let d = target.join("jobs-agents-tests").join(name);
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn the_docs_job_runs_before_the_repair_job() {
    let root = dir("startup");
    let home = root.join("home");
    let l = home
        .join("AppData")
        .join("Local")
        .join("AyanamiTaskManager");
    let bundled = root.join("bundled");
    fs::create_dir_all(bundled.join("docs")).unwrap();
    fs::write(bundled.join("ATM_AGENT_GUIDE.md"), "guide").unwrap();
    fs::write(bundled.join("docs").join("a.md"), "doc").unwrap();
    for name in ["atm-plan", "atm-task", "atm-knowledge"] {
        let d = bundled.join("integrations").join("skills").join(name);
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("SKILL.md"), "---\natm-integration-version: 1\n---\n").unwrap();
    }
    fs::create_dir_all(bundled.join("integrations").join("skills").join("_shared")).unwrap();
    // Codex 已经接着 ATM（旧写法）：修复要用到刚装好的 `L\skills`。
    fs::create_dir_all(home.join(".codex")).unwrap();
    fs::write(
        home.join(".codex").join("config.toml"),
        "[mcp_servers.ayanami-task-manager]\ncommand = \"old.exe\"\nargs = []\n",
    )
    .unwrap();
    let env = AgentEnv {
        appdata: home.join("AppData").join("Roaming"),
        localappdata: home.join("AppData").join("Local"),
        path: None,
        legacy_root: l.clone(),
        launch: atm_agents::env::launch_for(&l, Path::new(r"C:\x\atm-mcp.exe")),
        cli: Arc::new(NoCli),
        home: home.clone(),
    };
    let agents = Agents::new(
        env,
        Arc::new(On),
        Gate {
            manage_configs: true,
        },
        Vec::new(),
    );
    let lines = atm_jobs::agents::run(&agents, Some(&bundled));
    assert_eq!(lines.len(), 2, "{lines:?}");
    assert_eq!(lines[0], "agents.docs: Installed");
    assert!(lines[1].starts_with("agents.repair: "), "{lines:?}");
    assert!(lines[1].contains("\"configs\":[\"CODEX\"]"), "{lines:?}");
    assert!(
        home.join(".codex")
            .join("skills")
            .join("atm-plan")
            .join("SKILL.md")
            .is_file()
    );
    // 没有安装包（开发构建）：只修复。
    let lines = atm_jobs::agents::run(&agents, None);
    assert_eq!(lines.len(), 1, "{lines:?}");
    let _ = fs::remove_dir_all(&root);
}
