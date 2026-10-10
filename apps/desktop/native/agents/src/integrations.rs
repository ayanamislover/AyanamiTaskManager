//! 设置页「Agent 接入」背后的七个桥方法（2.0 `main-agent-integrations.ts`），以及两个系统作业：
//! `agents.repair`（启动时修旧配置、补缺的 Skill；03 P-016：只修，不替用户装）与 `agents.docs`（Agent 文档）。
//!
//! 每个入口先查能力（06 §4 #241–247）：读是 `agents.read`，写各有各的能力，全是 USER_ONLY；修复只给
//! `System(agents.repair)`。返回的 JSON 与 2.0 同形，界面不用改。
//!
//! 「能不能动用户的 Agent 配置」由调用方给出（[`Gate`]）：只有打包版跑在产品默认数据根上（或专门的烟测）才修复、
//! 才在切换 memory profile 时同步客户端；开发构建与隔离数据根下修复不运行，切换只记设置（2.0 同）。
//! 用户在设置页点的安装 / 修复 / 卸载不受它限制：那是用户自己的操作。

use crate::config::{self, Written};
use crate::env::AgentEnv;
use crate::rules::{self, Action, State};
use crate::switch::{self, Report};
use crate::{AgentError, Client, Profile, Result, Settings, docs, enabled_profiles, skills};
use atm_domain::capability::{Capability, require};
use atm_domain::principal::Principal;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Gate {
    /// 修复作业与切换时的客户端同步可以运行。
    pub manage_configs: bool,
}

pub struct Agents {
    pub env: AgentEnv,
    settings: Arc<dyn Settings>,
    gate: Gate,
    /// 启动修复失败的客户端与原因（报告里的 `repairError`；用户再操作成功后清掉）。
    failures: Mutex<BTreeMap<Client, String>>,
    /// 要观测的桥命令：3.0 的 shim，再加仍握着旧配置的 2.x 入口。
    bridge_commands: Vec<String>,
}

/// 一次修复作业做了什么。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Repaired {
    pub ran: bool,
    pub configs: Vec<Client>,
    pub failures: Vec<(Client, String)>,
    pub skills: Vec<(Client, Vec<String>)>,
    pub skill_backups_moved: usize,
}

impl Repaired {
    pub fn view(&self) -> Value {
        json!({
            "ran": self.ran,
            "configs": self.configs.iter().map(|c| c.as_str()).collect::<Vec<_>>(),
            "failures": self.failures.iter().map(|(c, m)| json!({"client": c.as_str(), "message": m})).collect::<Vec<_>>(),
            "skills": self.skills.iter().map(|(c, n)| json!({"client": c.as_str(), "names": n})).collect::<Vec<_>>(),
            "skillBackupsMoved": self.skill_backups_moved,
        })
    }
}

fn check(p: &Principal, c: Capability) -> Result<()> {
    require(p, c).map_err(AgentError::from)
}

impl Agents {
    pub fn new(
        env: AgentEnv,
        settings: Arc<dyn Settings>,
        gate: Gate,
        extra_bridges: Vec<String>,
    ) -> Agents {
        let mut bridge_commands = vec![env.launch.command.clone()];
        bridge_commands.extend(extra_bridges);
        Agents {
            env,
            settings,
            gate,
            failures: Mutex::new(BTreeMap::new()),
            bridge_commands,
        }
    }

    fn profiles(&self) -> Vec<Profile> {
        enabled_profiles(self.settings.memory_profile_enabled())
    }

    fn rule_path(&self, c: Client) -> PathBuf {
        match c {
            Client::Codex => self.env.codex_rule(),
            Client::KimiCode => self.env.kimi_rule(),
            Client::Claude | Client::ClaudeCode => self.env.claude_rule(),
        }
    }

    fn skills_path(&self, c: Client) -> PathBuf {
        match c {
            Client::Codex => self.env.codex_skills(),
            Client::KimiCode => self.env.kimi_skills(),
            Client::Claude | Client::ClaudeCode => self.env.claude_skills(),
        }
    }

    /// 客户端本体在不在：Claude Code 看命令行，Kimi Code 看 `~/.kimi-code`。
    fn available(&self, c: Client) -> bool {
        match c {
            Client::ClaudeCode => self.env.find_claude_cli().is_some(),
            Client::KimiCode => self.env.kimi_dir().is_dir(),
            Client::Codex | Client::Claude => true,
        }
    }

    fn clear_failure(&self, c: Client) {
        self.failures
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&c);
    }

    fn report(&self, c: Client) -> Value {
        let rule = rules::inspect(&self.rule_path(c));
        json!({
            "client": c.as_str(),
            "mcpInstalled": config::installed(&self.env, c, &self.profiles()),
            "repairError": self.failures.lock().unwrap_or_else(|e| e.into_inner()).get(&c),
            "sharesRuleAndSkillsWith": (c == Client::ClaudeCode).then_some("CLAUDE"),
            "cliAvailable": self.available(c),
            "rule": rule_view(&rule),
            "skills": skills::inspect(&self.env.skills_source(), &self.skills_path(c)).view(),
        })
    }

    /// `getMcpConfigs`：给用户复制的三份配置与规则片段。令牌只出现在这里的 HTTP 配置里。
    pub fn mcp_configs(&self, p: &Principal, endpoint: &str, token: &str) -> Result<Value> {
        check(p, Capability::AgentsRead)?;
        let profiles = self.profiles();
        let base = endpoint.strip_suffix('/').unwrap_or(endpoint);
        let mut http = Map::new();
        let mut stdio = Map::new();
        for profile in &profiles {
            http.insert(
                profile.server_name().into(),
                json!({
                    "type": "streamable-http",
                    "url": format!("{base}/mcp/{}", profile.as_str()),
                    "headers": {"Authorization": format!("Bearer {token}")},
                }),
            );
            stdio.insert(
                profile.server_name().into(),
                self.env.launch.for_profile(*profile).json(),
            );
        }
        let wrap =
            |m: Map<String, Value>| crate::files::js_json_pretty(&json!({ "mcpServers": m }));
        Ok(json!({
            "streamableHttp": wrap(http),
            "stdio": wrap(stdio.clone()),
            "generic": wrap(stdio),
            "agentRule": rules::AGENT_RULE_SNIPPET,
        }))
    }

    pub fn bridges(&self, p: &Principal) -> Result<Value> {
        check(p, Capability::AgentsRead)?;
        Ok(crate::bridges::observe(&self.bridge_commands))
    }

    pub fn memory_profile(&self, p: &Principal) -> Result<bool> {
        check(p, Capability::AgentsRead)?;
        Ok(self.settings.memory_profile_enabled())
    }

    pub fn set_memory_profile(&self, p: &Principal, enabled: bool) -> Result<Value> {
        check(p, Capability::AgentsProfileSwitch)?;
        let report: Report = switch::run(
            &self.env,
            self.settings.as_ref(),
            p,
            enabled,
            self.gate.manage_configs,
        )?;
        for c in &report.clients {
            if c.status == switch::Status::Updated {
                self.clear_failure(c.client);
            }
        }
        Ok(report.view())
    }

    pub fn install_mcp(&self, p: &Principal, client: &str) -> Result<Value> {
        check(p, Capability::AgentsInstallMcp)?;
        let c = Client::parse(client)?;
        let w: Written = config::install(&self.env, c, &self.profiles())?;
        self.clear_failure(c);
        Ok(w.view())
    }

    pub fn integrations(&self, p: &Principal) -> Result<Value> {
        check(p, Capability::AgentsRead)?;
        Ok(Value::Array(
            Client::ALL.iter().map(|c| self.report(*c)).collect(),
        ))
    }

    /// `manageAgentIntegration`：规则块、Skills 与 MCP 一起装、修、卸。Claude 与 Claude Code 共用规则和 Skills，
    /// 卸其中一个时另一个还接着 ATM，就只卸 MCP。
    ///
    /// PREVIEW 属于 `agents.read`；写动作只给 User（03 §4.3、P-016）：System 的 `agents.repair` 持有
    /// `agents.manage`，但只能走 [`Agents::repair`]（只修已接入的），不能借这里给没接入的客户端装或卸——挡它的是
    /// 下面的 User 判断，不是 `agents.read`。
    pub fn manage(&self, p: &Principal, client: &str, action: &str) -> Result<Value> {
        let action = Action::parse(action)?;
        if action == Action::Preview {
            check(p, Capability::AgentsRead)?;
        } else {
            check(p, Capability::AgentsManage)?;
            if p.kind() != atm_domain::principal::PrincipalKind::User {
                return Err(AgentError::new(
                    "USER_AUTHORIZATION_REQUIRED",
                    "安装、更新、修复、卸载 Agent 接入只能由用户在 ATM 桌面端操作",
                ));
            }
        }
        let c = Client::parse(client)?;
        let skills_root = self.skills_path(c);
        let source = self.env.skills_source();
        let skill_state = skills::inspect(&source, &skills_root).state;
        if !matches!(action, Action::Preview | Action::Uninstall | Action::Repair)
            && skill_state == State::Modified
        {
            return Err(AgentError::new(
                "AGENT_SKILL_MODIFIED_REQUIRES_REPAIR",
                "Skill 被改过，需要修复",
            ));
        }
        let sibling = match c {
            Client::Claude => Some(Client::ClaudeCode),
            Client::ClaudeCode => Some(Client::Claude),
            _ => None,
        };
        let sibling_present = sibling.is_some_and(|s| config::present(&self.env, s));
        let remove_shared = action == Action::Uninstall && !sibling_present;
        let rule_action = if action == Action::Uninstall && !remove_shared {
            Action::Preview
        } else {
            action
        };
        // 先把要改的配置读一遍、算出结果：认不出的、改不了的在动规则与 Skill 之前就拒绝（peer W6 r2 P2-02）。
        if action != Action::Preview {
            config::preflight(&self.env, c, action == Action::Uninstall)?;
        }
        let rule = rules::manage(&self.rule_path(c), rule_action)?;
        if action == Action::Preview {
            return Ok(json!({ "report": self.report(c), "preview": managed_view(&rule) }));
        }
        if action == Action::Uninstall {
            config::uninstall(&self.env, c)?;
            if remove_shared {
                skills::uninstall(&skills_root)?;
            }
        } else {
            let profiles = self.profiles();
            // 档位名字齐了还不够：启动方式（command / args / env，Kimi 的 transport）与应当写入的不一致也要写
            // （peer W6 r1 P2-01，与启动修复同一个判据）。
            if !config::installed(&self.env, c, &profiles) || config::stale(&self.env, c, &profiles)
            {
                config::install(&self.env, c, &profiles)?;
            }
            if skill_state != State::Installed {
                skills::migrate_legacy_backups(&skills_root)?;
                skills::install(&source, &skills_root, None)?;
            }
        }
        self.clear_failure(c);
        Ok(json!({ "report": self.report(c), "preview": Value::Null }))
    }

    /// `agents.repair`：已经接入的客户端里，旧配置（2.x 的单入口、`-actions` 条目、钉着旧版本或旧桥的启动方式）
    /// 改成 3.0 的形式；缺的 Skill 补上，2.0 留在 skills 根里的备份挪出去。没接入的一个都不动，用户改过的
    /// Skill 不碰。任一客户端出错不影响别的，原因记在报告的 `repairError` 里。幂等：第二次什么也不改。
    pub fn repair(&self, p: &Principal) -> Result<Repaired> {
        check(p, Capability::AgentsManage)?;
        let mut out = Repaired::default();
        if !self.gate.manage_configs {
            return Ok(out);
        }
        out.ran = true;
        let profiles = self.profiles();
        for c in Client::ALL {
            // Claude Code 的 user scope 只能经命令行改；找不到命令行就无从修起。
            if c == Client::ClaudeCode && self.env.find_claude_cli().is_none() {
                continue;
            }
            if !config::stale(&self.env, c, &profiles) {
                continue;
            }
            match config::install(&self.env, c, &profiles) {
                Ok(_) => {
                    self.clear_failure(c);
                    out.configs.push(c);
                }
                Err(e) => {
                    self.failures
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert(c, e.message.clone());
                    out.failures.push((c, e.message));
                }
            }
        }
        let source = self.env.skills_source();
        for c in [Client::Codex, Client::Claude, Client::KimiCode] {
            let root = self.skills_path(c);
            let shared_present =
                c == Client::Claude && config::present(&self.env, Client::ClaudeCode);
            if !(config::present(&self.env, c) || shared_present) {
                continue;
            }
            let step = (|| -> Result<Vec<String>> {
                out.skill_backups_moved += skills::migrate_legacy_backups(&root)?;
                let names = skills::to_repair(&source, &root);
                if !names.is_empty() {
                    skills::install(&source, &root, Some(&names))?;
                }
                Ok(names)
            })();
            match step {
                Ok(names) if !names.is_empty() => out.skills.push((c, names)),
                Ok(_) => {}
                Err(e) => out.failures.push((c, e.message)),
            }
        }
        Ok(out)
    }

    /// `agents.docs`：把安装包里的 Agent 文档装进 `L`。
    pub fn install_docs(&self, p: &Principal, bundled: &Path) -> Result<docs::Outcome> {
        check(p, Capability::AgentsDocsInstall)?;
        docs::install(bundled, &self.env.legacy_root)
    }
}

fn rule_view(i: &rules::Inspection) -> Value {
    json!({
        "state": i.state.as_str(),
        "path": i.path.to_string_lossy(),
        "version": i.version,
    })
}

fn managed_view(m: &rules::Managed) -> Value {
    json!({
        "state": m.state.as_str(),
        "path": m.path.to_string_lossy(),
        "version": m.version,
        "backupPath": m.backup.as_ref().map(|b| b.to_string_lossy().into_owned()),
        "current": m.current,
        "proposed": m.proposed,
    })
}
