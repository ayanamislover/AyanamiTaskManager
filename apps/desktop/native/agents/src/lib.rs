//! ATM 3 的 Agent 接入（06 §4 #241–247、§5；03 P-016；W6d）：四种客户端的 MCP 配置、全局规则块、Skills、
//! memory profile 的事务化切换、Agent 文档的安装、桥进程观测，以及启动时的修复作业 `agents.repair`。
//!
//! 行为照 2.0（`packages/agent-config`、`apps/desktop/src/main-agent-integrations.ts` 等），写出的文件逐字节一致；
//! 3.0 的变化：
//! - 只写 `core` 与 `memory` 两个档位（10 R1 P2-1：actions 并入 core，`/mcp/actions` 只是别名）。修复器把残留的
//!   `-actions` 条目、无 profile 的旧单入口、`mcp-stdio.cjs` / `--mcp-stdio` 的旧启动方式统一改成
//!   `<L>\current\resources\atm-mcp.exe --profile <p>`；
//! - Skill 的备份不再放进 skills 根（2.0 放在里面，Agent 会把 `atm-plan.bak-…` 当成又一个 Skill 加载），
//!   改放在旁边的 `.atm-skill-backups\`，每个 Skill 只留最近几份；修复时把 2.0 留在 skills 根里的旧备份挪过去；
//! - 切换 memory profile 失败时按切换前的**原文**回滚（2.0 是按旧档位集用新启动方式重写）；
//! - 桥进程用原生进程枚举观测，不起 PowerShell / typeperf。
//!
//! 本 crate 不碰服务：设置的读写由调用方经 [`Settings`] 给出；不读写令牌以外的任何运行时状态，令牌只出现在
//! `getMcpConfigs` 给界面的那份 HTTP 配置里，不进日志。

pub mod bridges;
pub mod config;
pub mod docs;
pub mod env;
pub mod files;
pub mod integrations;
pub mod rules;
pub mod skills;
pub mod switch;

use serde_json::{Value, json};
use std::collections::BTreeMap;

/// 四种客户端。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Client {
    Codex,
    Claude,
    ClaudeCode,
    KimiCode,
}

impl Client {
    pub const ALL: [Client; 4] = [
        Client::Codex,
        Client::Claude,
        Client::ClaudeCode,
        Client::KimiCode,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Client::Codex => "CODEX",
            Client::Claude => "CLAUDE",
            Client::ClaudeCode => "CLAUDE_CODE",
            Client::KimiCode => "KIMI_CODE",
        }
    }

    pub fn parse(s: &str) -> Result<Client> {
        Client::ALL
            .into_iter()
            .find(|c| c.as_str() == s)
            .ok_or_else(|| {
                AgentError::new("MCP_CLIENT_UNSUPPORTED", format!("不支持的客户端：{s}"))
            })
    }
}

/// MCP 档位。`Actions` 只在读旧配置时出现（3.0 不再写）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Profile {
    Core,
    Memory,
    Actions,
}

impl Profile {
    pub fn as_str(self) -> &'static str {
        match self {
            Profile::Core => "core",
            Profile::Memory => "memory",
            Profile::Actions => "actions",
        }
    }

    pub fn server_name(self) -> &'static str {
        match self {
            Profile::Core => names::CORE,
            Profile::Memory => names::MEMORY,
            Profile::Actions => names::ACTIONS,
        }
    }
}

/// 受管的 MCP server 名（2.0 `MCP_SERVER_NAMES`）。
pub mod names {
    pub const LEGACY: &str = "ayanami-task-manager";
    pub const CORE: &str = "ayanami-task-manager-core";
    pub const MEMORY: &str = "ayanami-task-manager-memory";
    pub const ACTIONS: &str = "ayanami-task-manager-actions";
    pub const ALL: [&str; 4] = [LEGACY, CORE, MEMORY, ACTIONS];

    pub fn managed(name: &str) -> bool {
        ALL.contains(&name)
    }
}

/// 3.0 写的档位：memory 开着是 core + memory，关着只有 core。
pub fn enabled_profiles(memory: bool) -> Vec<Profile> {
    if memory {
        vec![Profile::Core, Profile::Memory]
    } else {
        vec![Profile::Core]
    }
}

/// 一个 MCP 启动方式。`env` 有序（写出时按 key 排序；3.0 的 shim 不需要环境变量，总是空）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Launch {
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

impl Launch {
    pub fn new(command: impl Into<String>) -> Launch {
        Launch {
            command: command.into(),
            args: Vec::new(),
            env: BTreeMap::new(),
        }
    }

    /// 2.0 `profileArgs`：去掉已有的 `--profile x`，末尾加 `--profile <p>`。
    pub fn for_profile(&self, profile: Profile) -> Launch {
        let mut args = self.args.clone();
        if let Some(i) = args.iter().position(|a| a == "--profile") {
            let end = (i + 2).min(args.len());
            args.drain(i..end);
        }
        args.push("--profile".into());
        args.push(profile.as_str().into());
        Launch {
            command: self.command.clone(),
            args,
            env: self.env.clone(),
        }
    }

    /// JSON 客户端写的形状：`{command, args, env}`。
    pub fn json(&self) -> Value {
        json!({
            "command": self.command,
            "args": self.args,
            "env": self.env,
        })
    }
}

/// 交给界面的错误：`message` 以错误码开头（设置页按错误码换成可照着处理的话，2.0 同）。
#[derive(Clone, Debug, PartialEq)]
pub struct AgentError {
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
}

impl AgentError {
    pub fn new(code: &str, message: impl Into<String>) -> AgentError {
        let message = message.into();
        AgentError {
            code: code.to_string(),
            message: if message.starts_with(code) {
                message
            } else {
                format!("{code}: {message}")
            },
            details: None,
        }
    }

    pub fn io(code: &str, e: impl std::fmt::Display) -> AgentError {
        AgentError::new(code, e.to_string())
    }

    pub fn with_details(mut self, details: Value) -> AgentError {
        self.details = Some(details);
        self
    }
}

impl std::fmt::Display for AgentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AgentError {}

impl From<atm_domain::error::DomainError> for AgentError {
    fn from(e: atm_domain::error::DomainError) -> Self {
        let code = e.code.to_string();
        AgentError {
            message: format!("{code}: {}", e.message),
            code,
            details: (!e.details.is_empty()).then(|| Value::Object(e.details)),
        }
    }
}

pub type Result<T> = std::result::Result<T, AgentError>;

/// memory profile 设置的读写（`mcp.memory-profile-enabled`）。由调用方经服务实现：读失败按开着处理（2.0 同），
/// 写只在全部客户端同步成功之后调用，用发起切换的那个主体（服务再查一次能力）。
pub trait Settings: Send + Sync {
    fn memory_profile_enabled(&self) -> bool;
    fn commit_memory_profile(
        &self,
        principal: &atm_domain::principal::Principal,
        enabled: bool,
    ) -> Result<()>;
}
