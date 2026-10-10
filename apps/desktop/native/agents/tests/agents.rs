//! Agent 接入（W6d；06 §4 #241–247、§5；03 P-016）。全部在合成的家目录里跑：不读写真实的 `~/.codex`、
//! `~/.claude.json`，Claude Code 的命令行换成一个只改合成 `~/.claude.json` 的假实现。
//!
//! - 修复：2.x 的各种旧入口（无 profile 的单入口、`-actions`、钉着 `app-<版本>` 的宿主、`mcp-stdio.cjs`、`.env` 子表、
//!   Kimi 缺 transport）在四种客户端里都改成 `<L>\current\resources\atm-mcp.exe --profile <p>`；别的 server 与键原样；
//!   改过的文件旁边留 `.bak-`，内容是改之前的字节；第二次什么也不改（不多一份备份、不多一次命令行调用）。
//! - 负例：没接入 ATM 的客户端一个字节都不动；不在产品数据根上（[`Gate`] 关）修复不运行，切换只记设置。
//! - 安装 / 卸载：规则块、Skills、MCP 一起；Claude 与 Claude Code 共用规则与 Skills，卸一个不连带另一个。
//! - 切换 memory profile：任一处失败按原文回滚、设置不提交；回滚也失败报 PARTIAL。
//! - Skills 的备份在 skills 根旁边，2.0 留在根里的挪出去。
//! - 规则块与 2.0 逐字节相同（哈希由 2.0 源码算出）。
//! - Agent 文档：三件一起换，上次中断留下的备份先放回。
//! - 能力：Agent 一律拒绝；修复只给 `System(agents.repair)`，文档只给 `System(agents.docs)`。

use atm_agents::env::{AgentEnv, Cli};
use atm_agents::integrations::{Agents, Gate};
use atm_agents::{AgentError, Launch, Settings, docs, rules, skills};
use atm_domain::principal::{JobId, Principal, UiSurface};
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const CORE: &str = "ayanami-task-manager-core";
const MEMORY: &str = "ayanami-task-manager-memory";
const ACTIONS: &str = "ayanami-task-manager-actions";
const LEGACY: &str = "ayanami-task-manager";

fn dir(name: &str) -> PathBuf {
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("target")
        });
    let d = target.join("agents-tests").join(name);
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

/// 假的 `claude` 命令行：照 `mcp remove` / `mcp add-json` 改合成的 `~/.claude.json`；`fail` 里的调用序号失败。
struct FakeCli {
    config: PathBuf,
    calls: Mutex<Vec<Vec<String>>>,
    fail: Mutex<Vec<usize>>,
}

impl Cli for FakeCli {
    fn run(&self, _cli: &Path, args: &[String]) -> Result<(), String> {
        let n = {
            let mut calls = self.calls.lock().unwrap();
            calls.push(args.to_vec());
            calls.len() - 1
        };
        if self.fail.lock().unwrap().contains(&n) {
            return Err(format!("CLAUDE_CODE_CLI_FAILED: injected failure #{n}"));
        }
        let mut v: Value = fs::read_to_string(&self.config)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_else(|| json!({}));
        if v.get("mcpServers").is_none() {
            v["mcpServers"] = json!({});
        }
        let servers = v["mcpServers"].as_object_mut().unwrap();
        match args[1].as_str() {
            "remove" => {
                servers.remove(&args[2]);
            }
            "add-json" => {
                servers.insert(args[2].clone(), serde_json::from_str(&args[3]).unwrap());
            }
            other => panic!("unexpected claude call {other}"),
        }
        fs::write(&self.config, serde_json::to_string_pretty(&v).unwrap()).unwrap();
        Ok(())
    }
}

struct FakeSettings {
    memory: Mutex<bool>,
    fail: Mutex<bool>,
    commits: Mutex<Vec<bool>>,
}

impl Settings for FakeSettings {
    fn memory_profile_enabled(&self) -> bool {
        *self.memory.lock().unwrap()
    }
    fn commit_memory_profile(&self, p: &Principal, enabled: bool) -> Result<(), AgentError> {
        atm_domain::capability::require(
            p,
            atm_domain::capability::Capability::AgentsProfileSwitch,
        )?;
        if *self.fail.lock().unwrap() {
            return Err(AgentError::new("SETTING_WRITE_FAILED", "injected"));
        }
        *self.memory.lock().unwrap() = enabled;
        self.commits.lock().unwrap().push(enabled);
        Ok(())
    }
}

struct World {
    root: PathBuf,
    home: PathBuf,
    l: PathBuf,
    shim: String,
    cli: Arc<FakeCli>,
    settings: Arc<FakeSettings>,
    agents: Agents,
}

impl World {
    fn new(name: &str, gate: bool) -> World {
        let root = dir(name);
        let home = root.join("home");
        let l = home
            .join("AppData")
            .join("Local")
            .join("AyanamiTaskManager");
        let shim = l.join("current").join("resources").join("atm-mcp.exe");
        fs::create_dir_all(shim.parent().unwrap()).unwrap();
        fs::write(&shim, b"MZ").unwrap();
        // Skills 的来源：`<L>\skills`。
        for name in skills::SKILL_NAMES {
            let d = l.join("skills").join(name);
            fs::create_dir_all(&d).unwrap();
            fs::write(
                d.join("SKILL.md"),
                format!("---\nname: {name}\natm-integration-version: 1\n---\n\n{name} body\n"),
            )
            .unwrap();
        }
        fs::create_dir_all(l.join("skills").join("_shared")).unwrap();
        fs::write(
            l.join("skills").join("_shared").join("playbooks.md"),
            "shared\n",
        )
        .unwrap();
        let cli = Arc::new(FakeCli {
            config: home.join(".claude.json"),
            calls: Mutex::new(Vec::new()),
            fail: Mutex::new(Vec::new()),
        });
        let settings = Arc::new(FakeSettings {
            memory: Mutex::new(true),
            fail: Mutex::new(false),
            commits: Mutex::new(Vec::new()),
        });
        let env = AgentEnv {
            appdata: home.join("AppData").join("Roaming"),
            localappdata: home.join("AppData").join("Local"),
            path: None,
            legacy_root: l.clone(),
            launch: atm_agents::env::launch_for(&l, Path::new(r"C:\unused\atm-mcp.exe")),
            cli: cli.clone(),
            home: home.clone(),
        };
        let agents = Agents::new(
            env,
            settings.clone(),
            Gate {
                manage_configs: gate,
            },
            Vec::new(),
        );
        World {
            root,
            home,
            l,
            shim: shim.to_string_lossy().into_owned(),
            cli,
            settings,
            agents,
        }
    }

    /// 让 `claude` 命令行「装着」。
    fn with_claude_cli(&self) {
        let bin = self.home.join(".local").join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join("claude.exe"), b"MZ").unwrap();
    }

    fn path(&self, rel: &str) -> PathBuf {
        rel.split('/').fold(self.home.clone(), |p, s| p.join(s))
    }

    fn write(&self, rel: &str, content: &str) -> PathBuf {
        let p = self.path(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, content).unwrap();
        p
    }

    fn read(&self, rel: &str) -> String {
        fs::read_to_string(self.path(rel)).unwrap()
    }

    fn calls(&self) -> usize {
        self.cli.calls.lock().unwrap().len()
    }

    fn expected(&self, profile: &str) -> Value {
        json!({"command": self.shim, "args": ["--profile", profile], "env": {}})
    }
}

impl Drop for World {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}

fn user() -> Principal {
    Principal::trusted_ui(UiSurface::WebView {
        generation: 1,
        epoch: 1,
    })
}

fn agent() -> Principal {
    Principal::authenticated_agent(None)
}

fn repair_job() -> Principal {
    Principal::system_job(JobId::AgentsRepair)
}

/// `path` 旁边的 `.bak-` 备份，按名字排序。
fn backups(path: &Path) -> Vec<PathBuf> {
    let prefix = format!("{}.bak-", path.file_name().unwrap().to_string_lossy());
    let mut out: Vec<PathBuf> = fs::read_dir(path.parent().unwrap())
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix))
        .map(|e| e.path())
        .collect();
    out.sort();
    out
}

fn json_of(p: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(p).unwrap()).unwrap()
}

/// 每个 2.x 旧入口的样子（宿主钉着 app-版本、Node 桥、actions、无 profile）。
const CODEX_2X: &str = r#"model = "gpt"

[mcp_servers.other]
command = "other.exe"
args = []

[mcp_servers.ayanami-task-manager]
command = "C:\\L\\app-2.4.0\\AyanamiTaskManager.exe"
args = ["--mcp-stdio"]

[mcp_servers."ayanami-task-manager-actions"]
command = "node"
args = ["C:\\L\\mcp-stdio.cjs", "--profile", "actions"]

[mcp_servers."ayanami-task-manager-actions".env]
ATM_DATA_DIR = "C:\\L"

[profiles.fast]
model = "mini"
"#;

fn seed_2x(w: &World) -> Vec<(PathBuf, String)> {
    let codex = w.write(".codex/config.toml", CODEX_2X);
    let old = |p: &str| json!({"command": r"C:\L\current\AyanamiTaskManager.exe", "args": ["--mcp-stdio", "--profile", p], "env": {}});
    let classic = w.write(
        "AppData/Roaming/Claude/claude_desktop_config.json",
        &serde_json::to_string_pretty(&json!({
            "theme": "dark",
            "mcpServers": {"keep": {"command": "k.exe", "args": []}, CORE: old("core")},
            "tail": 1
        }))
        .unwrap(),
    );
    let msix = w.write(
        "AppData/Local/Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming/Claude/claude_desktop_config.json",
        &serde_json::to_string_pretty(&json!({
            "mcpServers": {CORE: old("core"), MEMORY: old("memory"), ACTIONS: old("actions")}
        }))
        .unwrap(),
    );
    let mut kimi_core = w.expected("core");
    kimi_core.as_object_mut().unwrap().remove("transport");
    let kimi = w.write(
        ".kimi-code/mcp.json",
        &serde_json::to_string_pretty(&json!({"mcpServers": {CORE: kimi_core, MEMORY: {"transport": "stdio", "command": w.shim, "args": ["--profile", "memory"], "env": {}}}})).unwrap(),
    );
    w.write(
        ".claude.json",
        &serde_json::to_string_pretty(&json!({"numStartups": 3, "mcpServers": {LEGACY: {"command": "node", "args": [r"C:\L\mcp-stdio.cjs"]}}})).unwrap(),
    );
    w.with_claude_cli();
    [codex, classic, msix, kimi]
        .into_iter()
        .map(|p| {
            let t = fs::read_to_string(&p).unwrap();
            (p, t)
        })
        .collect()
}

#[test]
fn repair_rewrites_every_2x_entry_into_the_3_0_form_and_is_idempotent() {
    let w = World::new("repair", true);
    let originals = seed_2x(&w);
    let done = w.agents.repair(&repair_job()).unwrap();
    assert!(done.ran);
    assert_eq!(done.failures, vec![], "{done:?}");
    assert_eq!(done.configs.len(), 4, "{done:?}");

    // Codex：只剩 core + memory 两段，别的段与顶层键原样，旧段的子表也没了。
    let codex = w.read(".codex/config.toml");
    let s = w.shim.replace('\\', "\\\\");
    assert_eq!(
        codex,
        format!(
            "model = \"gpt\"\n\n[mcp_servers.other]\ncommand = \"other.exe\"\nargs = []\n\n[profiles.fast]\nmodel = \"mini\"\n\n\
             [mcp_servers.\"{CORE}\"]\ncommand = \"{s}\"\nargs = [\"--profile\", \"core\"]\n\n\
             [mcp_servers.\"{MEMORY}\"]\ncommand = \"{s}\"\nargs = [\"--profile\", \"memory\"]\n"
        )
    );
    // Claude Desktop 两份配置都修了，别的 server 与键留在原位。
    let classic = json_of(&originals[1].0);
    assert_eq!(
        classic,
        json!({"theme": "dark", "mcpServers": {"keep": {"command": "k.exe", "args": []}, CORE: w.expected("core"), MEMORY: w.expected("memory")}, "tail": 1})
    );
    let keys: Vec<&String> = classic.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["theme", "mcpServers", "tail"]);
    assert_eq!(
        json_of(&originals[2].0)["mcpServers"],
        json!({CORE: w.expected("core"), MEMORY: w.expected("memory")})
    );
    // Kimi：transport 补上，且排在第一个键。
    let kimi = json_of(&originals[3].0);
    let mut k = w.expected("core");
    let mut with_transport = serde_json::Map::new();
    with_transport.insert("transport".into(), json!("stdio"));
    with_transport.extend(k.as_object_mut().unwrap().clone());
    assert_eq!(kimi["mcpServers"][CORE], Value::Object(with_transport));
    assert_eq!(
        kimi["mcpServers"][CORE]
            .as_object()
            .unwrap()
            .keys()
            .next()
            .unwrap(),
        "transport"
    );
    // Claude Code：旧单入口删掉、两个档位经命令行登记。
    let cc = json_of(&w.path(".claude.json"));
    assert_eq!(cc["numStartups"], 3);
    assert_eq!(
        cc["mcpServers"],
        json!({CORE: w.expected("core"), MEMORY: w.expected("memory")})
    );
    let calls = w.cli.calls.lock().unwrap().clone();
    assert_eq!(calls[0], ["mcp", "remove", LEGACY, "--scope", "user"]);
    assert_eq!(calls.len(), 3);

    // 每个改过的文件旁边恰好一份备份，内容是改之前的字节。
    for (p, before) in &originals {
        let b = backups(p);
        assert_eq!(b.len(), 1, "{}", p.display());
        assert_eq!(&fs::read_to_string(&b[0]).unwrap(), before);
    }
    // 修过之后报告是「已安装」，没有 repairError。
    let report = w.agents.integrations(&user()).unwrap();
    for r in report.as_array().unwrap() {
        assert_eq!(r["mcpInstalled"], true, "{r}");
        assert_eq!(r["repairError"], Value::Null);
    }

    // 第二次：什么也不改。
    let snapshot: Vec<String> = originals
        .iter()
        .map(|(p, _)| fs::read_to_string(p).unwrap())
        .collect();
    let again = w.agents.repair(&repair_job()).unwrap();
    assert!(
        again.configs.is_empty() && again.failures.is_empty(),
        "{again:?}"
    );
    for ((p, _), s) in originals.iter().zip(&snapshot) {
        assert_eq!(&fs::read_to_string(p).unwrap(), s);
        assert_eq!(backups(p).len(), 1);
    }
    assert_eq!(w.calls(), 3);
}

#[test]
fn repair_leaves_clients_that_never_used_atm_alone() {
    let w = World::new("untouched", true);
    let codex = w.write(
        ".codex/config.toml",
        "model = \"gpt\"\n\n[mcp_servers.other]\ncommand = \"o\"\n",
    );
    let kimi = w.write(
        ".kimi-code/mcp.json",
        "{\"mcpServers\":{\"x\":{\"command\":\"x\"}}}",
    );
    let cc = w.write(".claude.json", "{\"mcpServers\":{}}");
    w.with_claude_cli();
    let done = w.agents.repair(&repair_job()).unwrap();
    assert!(
        done.ran && done.configs.is_empty() && done.skills.is_empty(),
        "{done:?}"
    );
    assert_eq!(
        fs::read_to_string(&codex).unwrap(),
        "model = \"gpt\"\n\n[mcp_servers.other]\ncommand = \"o\"\n"
    );
    assert_eq!(
        fs::read_to_string(&kimi).unwrap(),
        "{\"mcpServers\":{\"x\":{\"command\":\"x\"}}}"
    );
    assert_eq!(fs::read_to_string(&cc).unwrap(), "{\"mcpServers\":{}}");
    // 没有的配置不替用户建出来。
    assert!(
        !w.path("AppData/Roaming/Claude/claude_desktop_config.json")
            .exists()
    );
    assert!(!w.path(".codex/skills").exists() && !w.path(".claude/skills").exists());
    assert_eq!(w.calls(), 0);
    assert!(backups(&codex).is_empty() && backups(&kimi).is_empty());
}

#[test]
fn nothing_runs_outside_the_product_data_root() {
    let w = World::new("gated", false);
    let originals = seed_2x(&w);
    let done = w.agents.repair(&repair_job()).unwrap();
    assert!(!done.ran && done.configs.is_empty());
    // 切换只记设置，不碰任何客户端。
    let report = w.agents.set_memory_profile(&user(), false).unwrap();
    assert_eq!(report["status"], "APPLIED");
    assert_eq!(report["clients"], json!([]));
    assert_eq!(*w.settings.commits.lock().unwrap(), [false]);
    for (p, before) in &originals {
        assert_eq!(&fs::read_to_string(p).unwrap(), before);
        assert!(backups(p).is_empty());
    }
    assert_eq!(w.calls(), 0);
}

#[test]
fn install_and_uninstall_keep_backups_other_servers_and_the_shared_claude_assets() {
    let w = World::new("manage", true);
    w.with_claude_cli();
    fs::create_dir_all(w.path(".kimi-code")).unwrap();
    let codex = w.write(
        ".codex/config.toml",
        "[mcp_servers.other]\ncommand = \"o\"\n",
    );
    let rule = w.write(".codex/AGENTS.md", "# mine\n");
    for c in ["CODEX", "CLAUDE", "CLAUDE_CODE", "KIMI_CODE"] {
        let out = w.agents.manage(&user(), c, "INSTALL").unwrap();
        let r = &out["report"];
        assert_eq!(r["mcpInstalled"], true, "{c}: {r}");
        assert_eq!(r["rule"]["state"], "INSTALLED", "{c}");
        assert_eq!(r["skills"]["state"], "INSTALLED", "{c}");
    }
    assert_eq!(
        w.read(".codex/AGENTS.md"),
        format!("# mine\n\n{}\n", rules::render())
    );
    assert_eq!(fs::read_to_string(&backups(&rule)[0]).unwrap(), "# mine\n");
    assert!(
        w.read(".codex/config.toml")
            .starts_with("[mcp_servers.other]\ncommand = \"o\"\n\n")
    );
    assert_eq!(
        fs::read_to_string(&backups(&codex)[0]).unwrap(),
        "[mcp_servers.other]\ncommand = \"o\"\n"
    );
    assert_eq!(
        json_of(&w.path(".kimi-code/mcp.json"))["mcpServers"][MEMORY]["transport"],
        "stdio"
    );
    assert!(w.path(".claude/skills/atm-knowledge/SKILL.md").is_file());

    // 卸 Claude Desktop：Claude Code 还接着，共用的规则与 Skills 留下。
    let out = w.agents.manage(&user(), "CLAUDE", "UNINSTALL").unwrap();
    assert_eq!(out["report"]["mcpInstalled"], false);
    assert_eq!(out["report"]["rule"]["state"], "INSTALLED");
    assert!(w.path(".claude/skills/atm-plan").is_dir());
    // 再卸 Claude Code：这回一起带走，Skill 的备份在 skills 根旁边。
    let out = w
        .agents
        .manage(&user(), "CLAUDE_CODE", "UNINSTALL")
        .unwrap();
    assert_eq!(out["report"]["rule"]["state"], "NOT_INSTALLED");
    assert_eq!(out["report"]["skills"]["state"], "NOT_INSTALLED");
    let root: Vec<String> = fs::read_dir(w.path(".claude/skills"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(root.is_empty(), "{root:?}");
    let moved = fs::read_dir(w.path(".claude/.atm-skill-backups"))
        .unwrap()
        .count();
    assert_eq!(moved, 4);
    // 卸 Codex：另一个 server 留下，ATM 的没了，留有备份。
    w.agents.manage(&user(), "CODEX", "UNINSTALL").unwrap();
    assert_eq!(
        w.read(".codex/config.toml"),
        "[mcp_servers.other]\ncommand = \"o\"\n"
    );
    assert_eq!(w.read(".codex/AGENTS.md"), "# mine\n");
    assert!(backups(&codex).len() >= 2);
    // PREVIEW 不写。
    let before = w.read(".codex/AGENTS.md");
    let preview = w.agents.manage(&user(), "CODEX", "PREVIEW").unwrap();
    assert_eq!(preview["preview"]["current"], before);
    assert_eq!(w.read(".codex/AGENTS.md"), before);
}

#[test]
fn a_modified_rule_or_skill_needs_an_explicit_repair() {
    let w = World::new("modified", true);
    w.agents.manage(&user(), "CODEX", "INSTALL").unwrap();
    let rule = w.read(".codex/AGENTS.md").replace("WorkItem", "Work Item");
    w.write(".codex/AGENTS.md", &rule);
    let e = w.agents.manage(&user(), "CODEX", "UPDATE").unwrap_err();
    assert_eq!(e.code, "AGENT_RULE_MODIFIED_REQUIRES_REPAIR");
    w.agents.manage(&user(), "CODEX", "REPAIR").unwrap();
    assert!(
        w.read(".codex/AGENTS.md")
            .ends_with(&format!("{}\n", rules::render()))
    );

    w.write(
        ".codex/skills/atm-plan/SKILL.md",
        "---\natm-integration-version: 1\n---\nmine\n",
    );
    let e = w.agents.manage(&user(), "CODEX", "INSTALL").unwrap_err();
    assert_eq!(e.code, "AGENT_SKILL_MODIFIED_REQUIRES_REPAIR");
    // 修复作业也不碰用户改过的 Skill。
    w.agents.repair(&repair_job()).unwrap();
    assert!(
        w.read(".codex/skills/atm-plan/SKILL.md")
            .ends_with("mine\n")
    );
}

#[test]
fn a_failed_profile_switch_puts_every_original_byte_back() {
    let w = World::new("switch", true);
    let originals = seed_2x(&w);
    let cc_before = json_of(&w.path(".claude.json"));
    // Claude Code 在最后：前面的文件都改过了，它的 add-json（第 2 次调用）失败。
    w.cli.fail.lock().unwrap().push(1);
    let e = w.agents.set_memory_profile(&user(), false).unwrap_err();
    assert_eq!(e.code, "MCP_PROFILE_SWITCH_FAILED", "{e:?}");
    let report = &e.details.as_ref().unwrap()["report"];
    assert_eq!(report["status"], "FAILED");
    let statuses: Vec<(&str, &str)> = report["clients"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["client"].as_str().unwrap(), c["status"].as_str().unwrap()))
        .collect();
    assert_eq!(
        statuses,
        [
            ("CODEX", "ROLLED_BACK"),
            ("CLAUDE", "ROLLED_BACK"),
            ("CLAUDE", "ROLLED_BACK"),
            ("CLAUDE_CODE", "FAILED"),
            ("KIMI_CODE", "SKIPPED")
        ]
    );
    assert_eq!(report["clients"][3]["rollbackStatus"], "ROLLED_BACK");
    for (p, before) in &originals {
        assert_eq!(&fs::read_to_string(p).unwrap(), before, "{}", p.display());
    }
    assert_eq!(json_of(&w.path(".claude.json")), cc_before);
    assert!(w.settings.commits.lock().unwrap().is_empty());

    // Claude Code 自己的回滚失败、但切换按原文重新登记成功：一切都放回了，仍是 FAILED。
    let n = w.calls();
    *w.cli.fail.lock().unwrap() = vec![n + 1, n + 2];
    let e = w.agents.set_memory_profile(&user(), false).unwrap_err();
    assert_eq!(e.code, "MCP_PROFILE_SWITCH_FAILED", "{e:?}");
    assert_eq!(json_of(&w.path(".claude.json")), cc_before);

    // 按原文重新登记也失败：PARTIAL（remove 成功、add-json 失败、两层回滚的 add-json 都失败）。
    let n = w.calls();
    *w.cli.fail.lock().unwrap() = vec![n + 1, n + 2, n + 3];
    let e = w.agents.set_memory_profile(&user(), false).unwrap_err();
    assert_eq!(e.code, "MCP_PROFILE_SWITCH_PARTIAL", "{e:?}");
    assert!(e.message.starts_with("MCP_PROFILE_SWITCH_PARTIAL: "));
    assert_eq!(
        e.details.as_ref().unwrap()["report"]["clients"][3]["rollbackStatus"],
        "ROLLBACK_FAILED"
    );
    for (p, before) in &originals {
        assert_eq!(&fs::read_to_string(p).unwrap(), before);
    }
    w.cli.fail.lock().unwrap().clear();
    fs::write(
        w.path(".claude.json"),
        serde_json::to_string_pretty(&cc_before).unwrap(),
    )
    .unwrap();

    // 设置提交失败：同样全部放回。
    *w.settings.fail.lock().unwrap() = true;
    let e = w.agents.set_memory_profile(&user(), false).unwrap_err();
    assert_eq!(e.code, "MCP_PROFILE_SWITCH_FAILED");
    for (p, before) in &originals {
        assert_eq!(&fs::read_to_string(p).unwrap(), before);
    }
    *w.settings.fail.lock().unwrap() = false;

    // 成功：只剩 core，设置记下。
    let report = w.agents.set_memory_profile(&user(), false).unwrap();
    assert_eq!(report["status"], "APPLIED");
    assert_eq!(report["restartRequired"], true);
    assert_eq!(*w.settings.commits.lock().unwrap(), [false]);
    assert_eq!(
        json_of(&originals[2].0)["mcpServers"],
        json!({CORE: w.expected("core")})
    );
    assert!(!w.read(".codex/config.toml").contains(MEMORY));
    assert_eq!(
        json_of(&w.path(".claude.json"))["mcpServers"],
        json!({CORE: w.expected("core")})
    );
}

#[test]
fn skill_backups_live_beside_the_skills_root() {
    let w = World::new("skills", true);
    let root = w.path(".codex/skills");
    for n in [
        "atm-plan.bak-2026-01-01T00-00-00-000Z-aaaaaa",
        "_shared.bak-2026-01-01T00-00-00-000Z-bbbbbb",
        ".atm-task.tmp-12-abcdef01",
        "my-skill.bak-1",
    ] {
        fs::create_dir_all(root.join(n)).unwrap();
        fs::write(root.join(n).join("SKILL.md"), "old").unwrap();
    }
    assert_eq!(skills::migrate_legacy_backups(&root).unwrap(), 3);
    let left: Vec<String> = fs::read_dir(&root)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(left, ["my-skill.bak-1"]);
    let side = w.path(".codex/.atm-skill-backups");
    assert!(
        side.join("atm-plan.bak-2026-01-01T00-00-00-000Z-aaaaaa")
            .join("SKILL.md")
            .is_file()
    );
    assert!(!side.join(".atm-task.tmp-12-abcdef01").exists());
    assert_eq!(skills::migrate_legacy_backups(&root).unwrap(), 0);

    // 反复安装：每个 Skill 只留最近 5 份。
    let source = w.l.join("skills");
    for _ in 0..7 {
        skills::install(&source, &root, None).unwrap();
    }
    let plan = fs::read_dir(&side)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("atm-plan.bak-"))
        .count();
    assert_eq!(plan, 5);
    let mut left: Vec<String> = fs::read_dir(&root)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    left.sort();
    assert_eq!(
        left,
        [
            ".atm-skills.json",
            "_shared",
            "atm-knowledge",
            "atm-plan",
            "atm-task",
            "my-skill.bak-1"
        ]
    );

    // 无人值守的补齐：缺的补、没改过的旧版本更新、改过的留着。
    fs::remove_dir_all(root.join("atm-knowledge")).unwrap();
    // atm-task 是用户改的（基线对不上）；atm-plan 仍是 ATM 写进去的样子，只是安装包里出了新版本。
    fs::write(
        root.join("atm-task").join("SKILL.md"),
        "---\natm-integration-version: 0\n---\n",
    )
    .unwrap();
    fs::write(
        source.join("atm-plan").join("SKILL.md"),
        "---\natm-integration-version: 2\n---\nnew\n",
    )
    .unwrap();
    let names = skills::to_repair(&source, &root);
    assert_eq!(names, ["atm-plan", "atm-knowledge"]);
}

#[test]
fn the_rule_block_is_byte_identical_to_2x() {
    use sha2::{Digest, Sha256};
    let hex = |b: &[u8]| {
        Sha256::digest(b)
            .iter()
            .map(|x| format!("{x:02x}"))
            .collect::<String>()
    };
    // 由 2.0 `packages/agent-config/src/agent-rules.ts` 的源码算出。
    let block = rules::render();
    assert!(block.contains("<!-- ATM-INTEGRATION-HASH: 61d1aa426a33a950bea76c8b108362bb6161359e7bfc417414bed955c493fe9a -->"));
    assert_eq!(
        hex(block.as_bytes()),
        "068e90a3a57055e6de340f651cbdb88c38a427c2ec72210b9ce8e624324d6d39"
    );
    assert_eq!(
        hex(rules::AGENT_RULE_SNIPPET.as_bytes()),
        "daf85f5bf43c7530116d5b35e5631608ceea1298e60efda9af8885b2df1fce12"
    );
}

#[test]
fn mcp_configs_name_the_shim_and_the_profiles() {
    let w = World::new("configs", true);
    let v = w
        .agents
        .mcp_configs(&user(), "http://127.0.0.1:4/", "t0k")
        .unwrap();
    let http: Value = serde_json::from_str(v["streamableHttp"].as_str().unwrap()).unwrap();
    assert_eq!(
        http["mcpServers"][MEMORY]["url"],
        "http://127.0.0.1:4/mcp/memory"
    );
    assert_eq!(
        http["mcpServers"][CORE]["headers"]["Authorization"],
        "Bearer t0k"
    );
    let stdio: Value = serde_json::from_str(v["stdio"].as_str().unwrap()).unwrap();
    assert_eq!(
        stdio,
        json!({"mcpServers": {CORE: w.expected("core"), MEMORY: w.expected("memory")}})
    );
    assert!(!v["stdio"].as_str().unwrap().contains(ACTIONS));
    assert!(!v["stdio"].as_str().unwrap().contains("t0k"));
    *w.settings.memory.lock().unwrap() = false;
    let v = w
        .agents
        .mcp_configs(&user(), "http://127.0.0.1:4", "t")
        .unwrap();
    assert!(!v["generic"].as_str().unwrap().contains(MEMORY));
    let _ = Launch::new("");
}

#[test]
fn agents_and_jobs_get_only_their_own_capabilities() {
    let w = World::new("caps", true);
    let code = |r: Result<Value, AgentError>| r.unwrap_err().code;
    assert_eq!(
        code(w.agents.integrations(&agent())),
        "USER_AUTHORIZATION_REQUIRED"
    );
    assert_eq!(
        code(w.agents.install_mcp(&agent(), "CODEX")),
        "USER_AUTHORIZATION_REQUIRED"
    );
    assert_eq!(
        code(w.agents.manage(&agent(), "CODEX", "INSTALL")),
        "USER_AUTHORIZATION_REQUIRED"
    );
    assert_eq!(
        code(w.agents.set_memory_profile(&agent(), false)),
        "USER_AUTHORIZATION_REQUIRED"
    );
    assert_eq!(
        code(w.agents.mcp_configs(&agent(), "http://x", "t")),
        "USER_AUTHORIZATION_REQUIRED"
    );
    assert_eq!(
        w.agents.repair(&agent()).unwrap_err().code,
        "USER_AUTHORIZATION_REQUIRED"
    );
    assert_eq!(
        code(w.agents.install_mcp(&repair_job(), "CODEX")),
        "PRINCIPAL_CAPABILITY_DENIED"
    );
    assert_eq!(
        code(w.agents.set_memory_profile(&repair_job(), false)),
        "PRINCIPAL_CAPABILITY_DENIED"
    );
    let docs_job = Principal::system_job(JobId::AgentsDocs);
    assert_eq!(
        w.agents.repair(&docs_job).unwrap_err().code,
        "PRINCIPAL_CAPABILITY_DENIED"
    );
    assert_eq!(
        w.agents.install_docs(&user(), &w.root).unwrap_err().code,
        "PRINCIPAL_CAPABILITY_DENIED"
    );
    assert_eq!(
        w.agents
            .install_docs(&repair_job(), &w.root)
            .unwrap_err()
            .code,
        "PRINCIPAL_CAPABILITY_DENIED"
    );
    assert_eq!(
        code(w.agents.install_mcp(&user(), "CURSOR")),
        "MCP_CLIENT_UNSUPPORTED"
    );
    assert_eq!(
        code(w.agents.manage(&user(), "CODEX", "DELETE")),
        "AGENT_RULE_ACTION_UNSUPPORTED"
    );
    assert!(w.agents.repair(&repair_job()).is_ok());
    assert!(!w.path(".codex").exists());
}

fn bundle(root: &Path, guide: &str, doc: &str) {
    fs::create_dir_all(root.join("docs").join("sub")).unwrap();
    fs::write(root.join(docs::GUIDE), guide).unwrap();
    fs::write(root.join("docs").join("sub").join("a.md"), doc).unwrap();
    let s = root.join("integrations").join("skills").join("atm-plan");
    fs::create_dir_all(&s).unwrap();
    fs::write(s.join("SKILL.md"), "plan").unwrap();
}

fn artifacts(l: &Path) -> Vec<String> {
    fs::read_dir(l)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains(".staging-") || n.contains(".backup-"))
        .collect()
}

#[test]
fn agent_docs_are_replaced_together_and_an_interrupted_rollback_is_finished_first() {
    let w = World::new("docs", true);
    let job = Principal::system_job(JobId::AgentsDocs);
    let bundled = w.root.join("bundled");
    bundle(&bundled, "guide v3\n", "doc v3\n");
    fs::create_dir_all(w.l.join("docs")).unwrap();
    fs::write(w.l.join("docs").join("stale.md"), "old").unwrap();
    fs::write(w.l.join(docs::GUIDE), "guide v2\n").unwrap();
    assert_eq!(
        w.agents.install_docs(&job, &bundled).unwrap(),
        docs::Outcome::Installed
    );
    assert_eq!(
        fs::read_to_string(w.l.join(docs::GUIDE)).unwrap(),
        "guide v3\n"
    );
    assert!(!w.l.join("docs").join("stale.md").exists());
    assert_eq!(
        docs::installed_manifest(&w.l).unwrap(),
        docs::bundled_manifest(&bundled).unwrap()
    );
    assert!(artifacts(&w.l).is_empty(), "{:?}", artifacts(&w.l));
    assert_eq!(
        w.agents.install_docs(&job, &bundled).unwrap(),
        docs::Outcome::Current
    );

    // 上次回滚没做完：留着 `.backup-`。先放回去，再照常换新。
    fs::create_dir_all(w.l.join("docs.backup-0123456789abcdef")).unwrap();
    fs::write(
        w.l.join("docs.backup-0123456789abcdef").join("x.md"),
        "interrupted",
    )
    .unwrap();
    fs::create_dir_all(w.l.join("skills.staging-fedcba9876543210")).unwrap();
    // 不是 ATM 的名字，不碰。
    fs::create_dir_all(w.l.join("docs.backup-NOTHEX")).unwrap();
    bundle(&bundled, "guide v4\n", "doc v4\n");
    assert_eq!(
        w.agents.install_docs(&job, &bundled).unwrap(),
        docs::Outcome::Installed
    );
    assert_eq!(artifacts(&w.l), ["docs.backup-NOTHEX"]);
    assert_eq!(
        fs::read_to_string(w.l.join("docs").join("sub").join("a.md")).unwrap(),
        "doc v4\n"
    );

    // 安装包缺一件：拒绝，`L` 不变。
    let broken = w.root.join("broken");
    bundle(&broken, "g", "d");
    fs::remove_dir_all(broken.join("docs")).unwrap();
    let e = w.agents.install_docs(&job, &broken).unwrap_err();
    assert_eq!(e.code, "AGENT_DOCS_MISSING");
    assert_eq!(
        fs::read_to_string(w.l.join(docs::GUIDE)).unwrap(),
        "guide v4\n"
    );
}
