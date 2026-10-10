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

/// 假的 `claude` 命令行：照 `mcp remove` / `mcp add-json` 改合成的 `~/.claude.json`；接下来 `fail_adds` 次 add-json 失败。
struct FakeCli {
    config: PathBuf,
    calls: Mutex<Vec<Vec<String>>>,
    fail_adds: Mutex<usize>,
}

impl Cli for FakeCli {
    fn run(&self, _cli: &Path, args: &[String]) -> Result<(), String> {
        let n = {
            let mut calls = self.calls.lock().unwrap();
            calls.push(args.to_vec());
            calls.len() - 1
        };
        if args[1] == "add-json" {
            let mut left = self.fail_adds.lock().unwrap();
            if *left > 0 {
                *left -= 1;
                return Err(format!("CLAUDE_CODE_CLI_FAILED: injected failure #{n}"));
            }
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
            fail_adds: Mutex::new(0),
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

/// Codex 的 2.x 配置：core 与 memory 已经是 3.0 的写法，只多一个带 `.env` 子表的 `-actions` 段。
/// 每份配置只靠一种「过期」成立：单拿掉哪一条判据，就有一个客户端漏修（Claude Desktop 一次写全部
/// 配置文件，所以两种「多出来的条目」分在 Codex 与 Claude Desktop 两个客户端上）。
fn codex_2x(w: &World) -> String {
    let s = w.shim.replace('\\', "\\\\");
    format!(
        "model = \"gpt\"\n\n[mcp_servers.other]\ncommand = \"other.exe\"\nargs = []\n\n\
         [mcp_servers.\"{CORE}\"]\ncommand = \"{s}\"\nargs = [\"--profile\", \"core\"]\n\n\
         [mcp_servers.\"{MEMORY}\"]\ncommand = \"{s}\"\nargs = [\"--profile\", \"memory\"]\n\n\
         [mcp_servers.\"{ACTIONS}\"]\ncommand = \"node\"\nargs = [\"C:\\\\L\\\\mcp-stdio.cjs\", \"--profile\", \"actions\"]\n\n\
         [mcp_servers.\"{ACTIONS}\".env]\nATM_DATA_DIR = \"C:\\\\L\"\n\n\
         [profiles.fast]\nmodel = \"mini\"\n"
    )
}

fn seed_2x(w: &World) -> Vec<(PathBuf, String)> {
    let codex = w.write(".codex/config.toml", &codex_2x(w));
    let old = |p: &str| json!({"command": r"C:\L\current\AyanamiTaskManager.exe", "args": ["--mcp-stdio", "--profile", p], "env": {}});
    let classic = w.write(
        "AppData/Roaming/Claude/claude_desktop_config.json",
        &serde_json::to_string_pretty(&json!({
            "theme": "dark",
            // core + memory 都对，只多一个旧单入口。
            "mcpServers": {"keep": {"command": "k.exe", "args": []}, CORE: w.expected("core"), MEMORY: w.expected("memory"), LEGACY: old("core")},
            "tail": 1
        }))
        .unwrap(),
    );
    let msix = w.write(
        "AppData/Local/Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming/Claude/claude_desktop_config.json",
        &serde_json::to_string_pretty(&json!({
            // 同上：core + memory 都对，只多一个旧单入口。
            "mcpServers": {CORE: w.expected("core"), MEMORY: w.expected("memory"), LEGACY: old("memory")}
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
        &serde_json::to_string_pretty(&json!({"numStartups": 3, "mcpServers": {CORE: {"command": r"C:\L\app-2.4.0\AyanamiTaskManager.exe", "args": ["--mcp-stdio", "--profile", "core"]}, MEMORY: w.expected("memory")}})).unwrap(),
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
    let verbs: Vec<(&str, &str)> = calls
        .iter()
        .map(|c| (c[1].as_str(), c[2].as_str()))
        .collect();
    assert_eq!(
        verbs,
        [
            ("remove", CORE),
            ("remove", MEMORY),
            ("add-json", CORE),
            ("add-json", MEMORY)
        ]
    );

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
    assert_eq!(w.calls(), 4);
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
    // Claude Code 在最后：前面的文件都改过了，它的第一次 add-json 失败（自己的回滚成功）。
    *w.cli.fail_adds.lock().unwrap() = 1;
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
    *w.cli.fail_adds.lock().unwrap() = 2;
    let e = w.agents.set_memory_profile(&user(), false).unwrap_err();
    assert_eq!(e.code, "MCP_PROFILE_SWITCH_FAILED", "{e:?}");
    assert_eq!(json_of(&w.path(".claude.json")), cc_before);

    // 按原文重新登记也失败：PARTIAL（remove 成功、add-json 失败、两层回滚的 add-json 都失败）。
    *w.cli.fail_adds.lock().unwrap() = 3;
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
    *w.cli.fail_adds.lock().unwrap() = 0;
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
    // P-016 的主体 × 动作矩阵：manage 的写动作只给 User；System（启动修复、文档作业）与 Agent 一律拒绝、零写入，
    // 包括给没接入的客户端 INSTALL、给 User 装好的 UNINSTALL（peer W6 r1 P1-05）。
    let m = World::new("caps-manage", true);
    let docs = Principal::system_job(JobId::AgentsDocs);
    for p in [agent(), repair_job(), docs.clone()] {
        for action in ["INSTALL", "UPDATE", "REPAIR", "UNINSTALL", "PREVIEW"] {
            let r = m.agents.manage(&p, "CODEX", action);
            assert!(r.is_err(), "{p:?} {action} was accepted");
            assert!(
                !m.path(".codex/config.toml").exists() && !m.path(".codex/AGENTS.md").exists(),
                "{p:?} {action} wrote"
            );
        }
    }
    // 启动修复持有 `agents.manage`（给 `Agents::repair` 用）：挡它的是 User 判断本身，不是别的能力。
    assert_eq!(
        m.agents
            .manage(&repair_job(), "CODEX", "INSTALL")
            .unwrap_err()
            .code,
        "USER_AUTHORIZATION_REQUIRED"
    );
    m.agents.manage(&user(), "CODEX", "INSTALL").unwrap();
    let installed = fs::read(m.path(".codex/config.toml")).unwrap();
    let rules = fs::read(m.path(".codex/AGENTS.md")).unwrap();
    for p in [agent(), repair_job(), docs] {
        for action in ["UNINSTALL", "INSTALL", "REPAIR"] {
            assert!(
                m.agents.manage(&p, "CODEX", action).is_err(),
                "{p:?} {action}"
            );
        }
    }
    assert_eq!(fs::read(m.path(".codex/config.toml")).unwrap(), installed);
    assert_eq!(fs::read(m.path(".codex/AGENTS.md")).unwrap(), rules);
    // User 的 PREVIEW 只读；启动修复照常（成功例）。
    m.agents.manage(&user(), "CODEX", "PREVIEW").unwrap();
    assert_eq!(fs::read(m.path(".codex/config.toml")).unwrap(), installed);
    assert!(m.agents.repair(&repair_job()).unwrap().ran);

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
    fs::create_dir_all(w.l.join("docs.backup-0123abcd")).unwrap();
    fs::write(w.l.join("docs.backup-0123abcd").join("x.md"), "not ours").unwrap();
    bundle(&bundled, "guide v4\n", "doc v4\n");
    assert_eq!(
        w.agents.install_docs(&job, &bundled).unwrap(),
        docs::Outcome::Installed
    );
    let mut left = artifacts(&w.l);
    left.sort();
    assert_eq!(left, ["docs.backup-0123abcd", "docs.backup-NOTHEX"]);
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

/// `L` 下所有文件（相对路径 → 字节）。
fn tree(root: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
    fn walk(base: &Path, dir: &Path, out: &mut std::collections::BTreeMap<String, Vec<u8>>) {
        for e in fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            let rel = p
                .strip_prefix(base)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if p.is_dir() {
                out.insert(format!("{rel}/"), Vec::new());
                walk(base, &p, out);
            } else {
                out.insert(rel, fs::read(&p).unwrap());
            }
        }
    }
    let mut out = std::collections::BTreeMap::new();
    walk(root, root, &mut out);
    out
}

/// W6e：换到一半换不下去（`docs` 里有一个被独占打开的文件，整个目录改不了名）：已经挪走的按逆序放回，
/// 暂存删掉，`L` 逐字节回到换之前；`L` 里不归 ATM 管的文件从头到尾不碰。放开之后再装一次就成。
#[cfg(windows)]
#[test]
fn a_docs_swap_that_cannot_finish_puts_everything_back() {
    use std::os::windows::fs::OpenOptionsExt;
    let w = World::new("docs-rollback", true);
    let job = Principal::system_job(JobId::AgentsDocs);
    let bundled = w.root.join("bundled");
    bundle(&bundled, "guide v3\n", "doc v3\n");
    fs::create_dir_all(w.l.join("docs")).unwrap();
    fs::write(w.l.join("docs").join("held.md"), "old doc").unwrap();
    fs::write(w.l.join(docs::GUIDE), "guide v2\n").unwrap();
    fs::write(w.l.join("my-notes.md"), "用户自己的").unwrap();
    fs::create_dir_all(w.l.join("data")).unwrap();
    fs::write(w.l.join("data").join("atm.sqlite"), "2.x data").unwrap();
    let before = tree(&w.l);
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(w.l.join("docs").join("held.md"))
        .unwrap();
    let e = w.agents.install_docs(&job, &bundled).unwrap_err();
    drop(held);
    assert_eq!(e.code, "AGENT_DOCUMENTATION_RENAME_FAILED", "{e:?}");
    // 指南已经挪进了备份名：回滚把它放回，暂存三件都删掉，没有一步失败。
    assert!(e.message.contains("[rollback attempted="), "{}", e.message);
    assert!(e.message.contains(",failed=0]"), "{}", e.message);
    assert!(e.message.contains("succeeded=4"), "{}", e.message);
    assert_eq!(tree(&w.l), before);

    assert_eq!(
        w.agents.install_docs(&job, &bundled).unwrap(),
        docs::Outcome::Installed
    );
    let after = tree(&w.l);
    assert_eq!(after["my-notes.md"], "用户自己的".as_bytes());
    assert_eq!(after["data/atm.sqlite"], b"2.x data");
    assert!(!after.contains_key("docs/held.md"));
    assert_eq!(after[docs::GUIDE], b"guide v3\n");
    assert!(artifacts(&w.l).is_empty());
}

/// W6e：Agent 读的路径与 ATM 装文档的位置是同一处。规则块、Agent 最短规则与安装包里的 Skills 都指向
/// `%LOCALAPPDATA%\AyanamiTaskManager\ATM_AGENT_GUIDE.md`，文档装进的 `L` 就是 `<LOCALAPPDATA>\AyanamiTaskManager`
/// （00 决定 #6）；仓库里的 Skills 也只指这一处。
#[test]
fn every_pointer_to_the_guide_names_where_the_docs_are_installed() {
    let guide = r"%LOCALAPPDATA%\AyanamiTaskManager\ATM_AGENT_GUIDE.md";
    assert!(rules::render().contains(guide));
    assert!(rules::AGENT_RULE_SNIPPET.contains(guide));
    let w = World::new("guide-path", true);
    assert_eq!(
        w.agents.env.legacy_root,
        w.agents.env.localappdata.join("AyanamiTaskManager")
    );
    let skills = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../integrations/skills");
    let mut pointed = 0;
    for name in skills::SKILL_NAMES {
        let text = fs::read_to_string(skills.join(name).join("SKILL.md")).unwrap();
        for line in text.lines().filter(|l| l.contains("ATM_AGENT_GUIDE.md")) {
            assert!(line.contains(guide), "{name}: {line}");
            pointed += 1;
        }
    }
    assert!(pointed >= 2, "{pointed}");
}

/// peer W6 r1 P1-03：Codex 的 config.toml 里用户写的合法 TOML 在安装、修复、卸载之后原样留着，再做一遍不变。
/// 表头带注释、带空白和引号的点分键、数组表、多行字符串里像表头的行、受管段后面的用户注释、CRLF 都在内。
#[test]
fn codex_user_toml_survives_install_repair_and_uninstall() {
    let user_blocks = [
        "[mcp_servers.other] # user server\ncommand = \"other.exe\"\nargs = [\"keep-me\"]\n",
        "[ mcp_servers . \"two words\" ]\ncommand = 'two.exe'\n",
        "[[profiles]]\nname = \"a\"\n",
        "[notes]\ntext = \"\"\"\n[mcp_servers.ayanami-task-manager-core]\n# not a comment\n\"\"\"\nafter = 1\n",
        "[lists]\nnested = [\n  [\"[x]\"],\n  [\"y\"],\n]\n",
    ];
    let own = "[mcp_servers.ayanami-task-manager-core]\ncommand = \"old.exe\"\nargs = []\n\
               [mcp_servers.ayanami-task-manager-core.env]\nK = \"v\"\n";
    for crlf in [false, true] {
        let w = World::new(
            if crlf {
                "codex-toml-crlf"
            } else {
                "codex-toml"
            },
            true,
        );
        let fix = |s: &str| {
            if crlf {
                s.replace('\n', "\r\n")
            } else {
                s.to_owned()
            }
        };
        // 受管段夹在用户段中间，后面跟一行用户的注释。
        let original = fix(&format!(
            "{}\n{own}\n# my other server below\n{}\n{}\n{}\n{}",
            user_blocks[0], user_blocks[1], user_blocks[2], user_blocks[3], user_blocks[4]
        ));
        w.write(".codex/config.toml", &original);
        let keeps = |text: &str| {
            for b in user_blocks {
                assert!(text.contains(&fix(b)), "lost {b:?} in:\n{text}");
            }
            assert!(text.contains(&fix("# my other server below\n")), "{text}");
        };
        let done = w.agents.repair(&repair_job()).unwrap();
        assert!(
            done.configs.contains(&atm_agents::Client::Codex),
            "{done:?}"
        );
        let repaired = w.read(".codex/config.toml");
        keeps(&repaired);
        assert!(!repaired.contains("old.exe") && repaired.contains(&w.shim.replace('\\', "\\\\")));
        assert_eq!(repaired.contains("\r\n"), crlf);
        assert!(
            !crlf || !repaired.replace("\r\n", "").contains('\n'),
            "mixed line endings"
        );
        // 再修一次、再装一次：字节不变。
        w.agents.repair(&repair_job()).unwrap();
        w.agents.manage(&user(), "CODEX", "INSTALL").unwrap();
        assert_eq!(w.read(".codex/config.toml"), repaired);
        // 卸载：ATM 的段没了，用户的全在；再卸一次不变。
        w.agents.manage(&user(), "CODEX", "UNINSTALL").unwrap();
        let removed = w.read(".codex/config.toml");
        keeps(&removed);
        // 剩下的那一处是用户多行字符串里的假表头。
        assert_eq!(
            removed
                .matches("[mcp_servers.ayanami-task-manager-core]")
                .count(),
            1
        );
        assert!(
            !removed.contains("old.exe")
                && !removed.contains("[mcp_servers.ayanami-task-manager-core.env]")
        );
        assert!(!removed.contains(&w.shim.replace('\\', "\\\\")));
        w.agents.manage(&user(), "CODEX", "UNINSTALL").unwrap();
        assert_eq!(w.read(".codex/config.toml"), removed);
    }

    // 认不出的文件：不猜删除范围。安装报错、零写入；启动修复不碰。
    for (name, broken) in [
        (
            "header",
            "[mcp_servers.ayanami-task-manager-core\ncommand = \"old.exe\"\n",
        ),
        (
            "string",
            "[mcp_servers.ayanami-task-manager-core]\ncommand = \"old.exe\"\n[x]\ns = \"\"\"\nnever closed\n",
        ),
        (
            "array",
            "[x]\na = [\n  1,\n[mcp_servers.ayanami-task-manager-core]\n",
        ),
    ] {
        let w = World::new(&format!("codex-toml-bad-{name}"), true);
        w.write(".codex/config.toml", broken);
        let e = w.agents.manage(&user(), "CODEX", "INSTALL").unwrap_err();
        assert_eq!(e.code, "CODEX_CONFIG_INVALID_TOML", "{name}: {}", e.message);
        assert_eq!(w.read(".codex/config.toml"), broken, "{name}");
        let done = w.agents.repair(&repair_job()).unwrap();
        assert!(!done.configs.contains(&atm_agents::Client::Codex), "{name}");
        assert_eq!(w.read(".codex/config.toml"), broken, "{name}");
        assert!(backups(&w.path(".codex/config.toml")).is_empty(), "{name}");
    }
}

/// peer W6 r1 P2-01：显式「修复」与启动修复用同一个判据：档位名字齐全、启动方式不对（旧版本的 command、错的 args、
/// Kimi 缺 transport）的也改成应当写入的；只碰受管条目。开发布局（启动修复不放行）下也一样。
#[test]
fn an_explicit_repair_rewrites_a_stale_launch_with_the_right_profile_names() {
    let w = World::new("explicit-repair", false);
    w.with_claude_cli();
    let shim_json = serde_json::to_string(&w.shim).unwrap();
    for (client, rel) in [
        ("CODEX", ".codex/config.toml"),
        (
            "CLAUDE",
            "AppData/Roaming/Claude/claude_desktop_config.json",
        ),
        ("KIMI_CODE", ".kimi-code/mcp.json"),
        ("CLAUDE_CODE", ".claude.json"),
    ] {
        w.agents.manage(&user(), client, "INSTALL").unwrap();
        let good = w.read(rel);
        assert!(good.contains(&shim_json), "{client}: {good}");
        let stale = good
            .replace(&shim_json, "\"C:\\\\L\\\\app-2.4.0\\\\old-version.exe\"")
            .replace("\"transport\": \"stdio\"", "\"transport\": \"http\"");
        w.write(rel, &stale);
        assert!(
            w.agents.repair(&repair_job()).unwrap().configs.is_empty(),
            "gate is off"
        );
        assert_eq!(w.read(rel), stale);
        w.agents.manage(&user(), client, "REPAIR").unwrap();
        let fixed = w.read(rel);
        assert!(!fixed.contains("old-version.exe"), "{client}: {fixed}");
        assert!(fixed.contains(&shim_json), "{client}: {fixed}");
        if client == "KIMI_CODE" {
            assert!(!fixed.contains("\"http\""), "{fixed}");
        }
    }
    // 只碰受管条目：Codex 里用户自己的 server 原样。
    let w = World::new("explicit-repair-other", false);
    w.agents.manage(&user(), "CODEX", "INSTALL").unwrap();
    let other = "[mcp_servers.mine]\ncommand = \"old-version.exe\"\n";
    let text = w
        .read(".codex/config.toml")
        .replace(&shim_json, "\"old-version.exe\"");
    w.write(".codex/config.toml", &format!("{other}\n{text}"));
    w.agents.manage(&user(), "CODEX", "REPAIR").unwrap();
    let fixed = w.read(".codex/config.toml");
    assert!(fixed.starts_with(other), "{fixed}");
    assert_eq!(fixed.matches("old-version.exe").count(), 1, "{fixed}");
}

/// 用独立的解析器（toml crate）读 Codex 配置：必须是合法 TOML。
fn codex_toml(w: &World) -> toml::Table {
    let text = w.read(".codex/config.toml");
    toml::from_str(&text).unwrap_or_else(|e| panic!("not valid TOML: {e}\n{text}"))
}

fn codex_server<'a>(table: &'a toml::Table, name: &str) -> Option<&'a toml::Value> {
    table.get("mcp_servers")?.get(name)
}

/// peer W6 r2 P1-02：ATM 的 server 写成 `[mcp_servers]` 下的行内表、点分键（裸键、带引号的键、跨行的值），
/// 或顶层的点分键，都是合法 TOML。启动修复、安装把它们换成 ATM 的段，不重复定义；卸载去掉它们；用户的
/// server 原样；每一步之后独立解析都合法，再做一遍字节不变。
#[test]
fn codex_inline_and_dotted_definitions_are_replaced_not_duplicated() {
    let cases = [
        (
            "inline",
            "[mcp_servers]\nayanami-task-manager-core = { command = \"old.exe\", args = [] }\nother = { command = \"keep.exe\" }\n",
        ),
        (
            "quoted inline",
            "[mcp_servers]\n\"ayanami-task-manager-core\" = { command = \"old.exe\" }\nother = { command = \"keep.exe\" }\n",
        ),
        (
            "dotted",
            "[mcp_servers]\nayanami-task-manager-core.command = \"old.exe\"\nayanami-task-manager-core.args = [\n  \"a\",\n  \"b\",\n]\nother.command = \"keep.exe\"\n",
        ),
        (
            "top-level dotted",
            "mcp_servers.ayanami-task-manager-core.command = \"old.exe\"\nmcp_servers.other.command = \"keep.exe\"\n",
        ),
        (
            "memory inline next to a core section",
            "[mcp_servers]\nayanami-task-manager-memory = { command = \"old.exe\" }\nother = { command = \"keep.exe\" }\n\n[mcp_servers.ayanami-task-manager-core]\ncommand = \"old.exe\"\n",
        ),
    ];
    for (i, (name, original)) in cases.into_iter().enumerate() {
        let w = World::new(&format!("codex-inline-{i}"), true);
        w.write(".codex/config.toml", original);
        toml::from_str::<toml::Table>(original)
            .unwrap_or_else(|e| panic!("{name}: the fixture is not TOML: {e}"));
        // 启动修复认得出这是 ATM 的（过期的）定义。
        let done = w.agents.repair(&repair_job()).unwrap();
        assert!(
            done.configs.contains(&atm_agents::Client::Codex),
            "{name}: {done:?}"
        );
        let repaired = codex_toml(&w);
        assert_eq!(
            codex_server(&repaired, "other")
                .and_then(|s| s.get("command"))
                .and_then(|c| c.as_str()),
            Some("keep.exe"),
            "{name}"
        );
        assert_eq!(
            codex_server(&repaired, CORE)
                .and_then(|s| s.get("command"))
                .and_then(|c| c.as_str()),
            Some(w.shim.as_str()),
            "{name}"
        );
        let text = w.read(".codex/config.toml");
        assert!(!text.contains("old.exe"), "{name}: {text}");
        // 再修、再装：不变。
        assert!(
            w.agents.repair(&repair_job()).unwrap().configs.is_empty(),
            "{name}"
        );
        w.agents.manage(&user(), "CODEX", "INSTALL").unwrap();
        assert_eq!(w.read(".codex/config.toml"), text, "{name}");
        // 卸载：ATM 的都没了，用户的还在。
        w.agents.manage(&user(), "CODEX", "UNINSTALL").unwrap();
        let removed = codex_toml(&w);
        for n in atm_agents::names::ALL {
            assert!(codex_server(&removed, n).is_none(), "{name}: {n} left");
        }
        assert!(codex_server(&removed, "other").is_some(), "{name}");
    }

    // 规范的段全对，旁边还留着一条非规范的 ATM 定义（`[mcp_servers]` 下手写的 -actions）：只有这一条也算过期，
    // 启动修复把它去掉，用户的 server 原样。
    let w = World::new("codex-inline-leftover", true);
    w.agents.manage(&user(), "CODEX", "INSTALL").unwrap();
    let good = w.read(".codex/config.toml");
    assert!(
        w.agents.repair(&repair_job()).unwrap().configs.is_empty(),
        "the sections alone are current"
    );
    w.write(
        ".codex/config.toml",
        &format!("{good}\n[mcp_servers]\nayanami-task-manager-actions = {{ command = \"old.exe\" }}\nother = {{ command = \"keep.exe\" }}\n"),
    );
    codex_toml(&w);
    let done = w.agents.repair(&repair_job()).unwrap();
    assert!(
        done.configs.contains(&atm_agents::Client::Codex),
        "{done:?}"
    );
    let fixed = codex_toml(&w);
    assert!(codex_server(&fixed, "ayanami-task-manager-actions").is_none());
    assert_eq!(
        codex_server(&fixed, "other")
            .and_then(|s| s.get("command"))
            .and_then(|c| c.as_str()),
        Some("keep.exe")
    );
    assert!(!w.read(".codex/config.toml").contains("old.exe"));

    // 用户自己装的状态（还没修过）直接卸载，也去得掉。
    let w = World::new("codex-inline-uninstall", false);
    w.write(".codex/config.toml", cases[2].1);
    w.agents.manage(&user(), "CODEX", "UNINSTALL").unwrap();
    let removed = codex_toml(&w);
    assert!(codex_server(&removed, CORE).is_none());
    assert_eq!(
        codex_server(&removed, "other")
            .and_then(|s| s.get("command"))
            .and_then(|c| c.as_str()),
        Some("keep.exe")
    );
}

/// 顶层 `mcp_servers = { … }`：行内表不能再往里加段，ATM 加不进自己的条目。安装在动任何文件之前拒绝；
/// 卸载只在行内表里有 ATM 的条目时拒绝（没有的话无事可做）；启动修复不碰它。整个家目录逐字节不变。
#[test]
fn a_whole_inline_mcp_servers_table_is_refused_before_any_write() {
    let w = World::new("codex-inline-whole", true);
    let mine = "mcp_servers = { other = { command = \"keep.exe\" } }\n";
    w.write(".codex/config.toml", mine);
    let before = tree(&w.home);
    let e = w.agents.manage(&user(), "CODEX", "INSTALL").unwrap_err();
    assert_eq!(e.code, "CODEX_CONFIG_UNSUPPORTED", "{}", e.message);
    assert_eq!(tree(&w.home), before, "install wrote something");
    assert!(w.agents.repair(&repair_job()).unwrap().configs.is_empty());
    assert_eq!(tree(&w.home), before, "repair wrote something");
    w.agents.manage(&user(), "CODEX", "UNINSTALL").unwrap();
    assert_eq!(w.read(".codex/config.toml"), mine);

    let w = World::new("codex-inline-whole-ours", true);
    w.write(
        ".codex/config.toml",
        "mcp_servers = { ayanami-task-manager-core = { command = \"old.exe\" }, other = { command = \"keep.exe\" } }\n",
    );
    let before = tree(&w.home);
    for action in ["INSTALL", "UNINSTALL", "REPAIR", "UPDATE"] {
        let e = w.agents.manage(&user(), "CODEX", action).unwrap_err();
        assert_eq!(
            e.code, "CODEX_CONFIG_UNSUPPORTED",
            "{action}: {}",
            e.message
        );
        assert_eq!(tree(&w.home), before, "{action} wrote something");
    }
    // 启动修复：认得出是 ATM 的，但改不了配置；记下原因，配置一个字节不动。（修复的各步互相独立：这个客户端
    // 接着 ATM，缺的 Skill 照常补上，与配置能不能改无关。）
    let config = w.read(".codex/config.toml");
    let done = w.agents.repair(&repair_job()).unwrap();
    assert!(
        done.failures
            .iter()
            .any(|(c, _)| *c == atm_agents::Client::Codex),
        "{done:?}"
    );
    assert!(
        !done.configs.contains(&atm_agents::Client::Codex),
        "{done:?}"
    );
    assert_eq!(
        w.read(".codex/config.toml"),
        config,
        "repair rewrote the config"
    );
}

/// peer W6 r2 P2-01：档位名字、command、args 都对，只有 env 不对（`.env` 子表或段里的 `env.K`）：显式修复与
/// 启动修复都算过期，改回应当写入的；用户自己 server 的 env 子表原样。
#[test]
fn a_codex_env_difference_alone_is_stale() {
    for (i, extra) in [
        "\n[mcp_servers.ayanami-task-manager-core.env]\nATM_DATA_DIR = \"old-root\"\n",
        "env.ATM_DATA_DIR = \"old-root\"\n",
    ]
    .into_iter()
    .enumerate()
    {
        let mine = "\n[mcp_servers.other]\ncommand = \"keep.exe\"\n\n[mcp_servers.other.env]\nATM_DATA_DIR = \"user-root\"\n";
        for gate in [false, true] {
            let w = World::new(&format!("codex-env-{i}-{gate}"), gate);
            w.agents.manage(&user(), "CODEX", "INSTALL").unwrap();
            let good = w.read(".codex/config.toml");
            // 子表写成单独的段接在后面；`env.K` 插在 core 段表头的下一行。
            let stale = if extra.starts_with('\n') {
                format!("{good}{extra}{mine}")
            } else {
                let header = "[mcp_servers.\"ayanami-task-manager-core\"]\n";
                let at = good.find(header).unwrap() + header.len();
                format!("{}{extra}{}{mine}", &good[..at], &good[at..])
            };
            w.write(".codex/config.toml", &stale);
            let parsed = codex_toml(&w);
            assert_eq!(
                codex_server(&parsed, CORE)
                    .and_then(|s| s.get("env"))
                    .and_then(|e| e.get("ATM_DATA_DIR"))
                    .and_then(|v| v.as_str()),
                Some("old-root"),
                "the fixture puts env into ATM's core server"
            );
            if gate {
                let done = w.agents.repair(&repair_job()).unwrap();
                assert!(
                    done.configs.contains(&atm_agents::Client::Codex),
                    "{done:?}"
                );
            } else {
                assert!(w.agents.repair(&repair_job()).unwrap().configs.is_empty());
                w.agents.manage(&user(), "CODEX", "REPAIR").unwrap();
            }
            let fixed = w.read(".codex/config.toml");
            assert!(!fixed.contains("old-root"), "{fixed}");
            let parsed = codex_toml(&w);
            assert_eq!(
                codex_server(&parsed, "other")
                    .and_then(|s| s.get("env"))
                    .and_then(|e| e.get("ATM_DATA_DIR"))
                    .and_then(|v| v.as_str()),
                Some("user-root")
            );
        }
    }
}

/// peer W6 r2 P2-02：认不出的 config.toml。安装、更新、修复、卸载都在动规则文件、Skill、任何配置之前报错：
/// 整个家目录逐字节不变（原来只比较 config.toml 自己，规则文件已经被改了）。
#[test]
fn an_unreadable_codex_config_means_no_write_anywhere() {
    let broken = "[mcp_servers.ayanami-task-manager-core\ncommand = \"old.exe\"\n";
    // 没接入过：安装。
    let w = World::new("codex-bad-fresh", false);
    w.write(".codex/config.toml", broken);
    let before = tree(&w.home);
    for action in ["INSTALL", "UPDATE", "REPAIR", "UNINSTALL"] {
        let e = w.agents.manage(&user(), "CODEX", action).unwrap_err();
        assert_eq!(
            e.code, "CODEX_CONFIG_INVALID_TOML",
            "{action}: {}",
            e.message
        );
        assert_eq!(tree(&w.home), before, "{action} wrote something");
    }
    // 接入过（规则块、Skill 都在），之后配置坏了：卸载不能拆一半。
    let w = World::new("codex-bad-installed", false);
    w.agents.manage(&user(), "CODEX", "INSTALL").unwrap();
    w.write(".codex/config.toml", broken);
    let before = tree(&w.home);
    for action in ["UNINSTALL", "REPAIR", "INSTALL"] {
        let e = w.agents.manage(&user(), "CODEX", action).unwrap_err();
        assert_eq!(
            e.code, "CODEX_CONFIG_INVALID_TOML",
            "{action}: {}",
            e.message
        );
        assert_eq!(tree(&w.home), before, "{action} wrote something");
    }
    // 坏的 JSON 客户端配置也一样。
    let w = World::new("kimi-bad", false);
    w.write(".kimi-code/mcp.json", "{ not json");
    let before = tree(&w.home);
    let e = w
        .agents
        .manage(&user(), "KIMI_CODE", "INSTALL")
        .unwrap_err();
    assert_eq!(e.code, "KIMI_CODE_CONFIG_INVALID_JSON", "{}", e.message);
    assert_eq!(tree(&w.home), before);
}
