//! 四种客户端的 MCP 配置（2.0 `mcp-install.ts`、`mcp-inspection.ts`、`kimi-code-config.ts`）。
//!
//! 只动 ATM 自己的几个 server（[`crate::names`]），别的 server 与顶层键原样保留；内容没变就不写。
//! - Codex：`~/.codex/config.toml` 里的 `[mcp_servers."<name>"]` 段（连同 `.env` 之类的子表）按行替换；
//! - Claude Desktop：每份 `claude_desktop_config.json` 的 `mcpServers`；
//! - Kimi Code：`~/.kimi-code/mcp.json` 的 `mcpServers`，每个 server 要写明 `transport: "stdio"`；
//! - Claude Code：`~/.claude.json` 只读，写入经 `claude mcp remove / add-json --scope user`，失败按逆序回滚。

use crate::env::AgentEnv;
use crate::files::{js_json, js_json_pretty, read_text, write_if_changed};
use crate::{AgentError, Client, Launch, Profile, Result, names};
use atm_domain::text::is_js_whitespace;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// 一份配置里登记着的受管 server。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Installed {
    pub legacy: Option<Launch>,
    pub core: Option<Launch>,
    pub memory: Option<Launch>,
    pub actions: Option<Launch>,
}

impl Installed {
    fn set(&mut self, name: &str, launch: Launch) {
        match name {
            names::LEGACY => self.legacy = Some(launch),
            names::CORE => self.core = Some(launch),
            names::MEMORY => self.memory = Some(launch),
            names::ACTIONS => self.actions = Some(launch),
            _ => {}
        }
    }

    pub fn get(&self, p: Profile) -> Option<&Launch> {
        match p {
            Profile::Core => self.core.as_ref(),
            Profile::Memory => self.memory.as_ref(),
            Profile::Actions => self.actions.as_ref(),
        }
    }

    /// 还留着任意一个 ATM 的 server（旧单入口也算）。
    pub fn any(&self) -> bool {
        self.legacy.is_some()
            || self.core.is_some()
            || self.memory.is_some()
            || self.actions.is_some()
    }

    /// 档位集合与启用的完全一致，且没有旧单入口（2.0 `installedProfileSetMatches`；actions 从不启用）。
    pub fn matches(&self, profiles: &[Profile]) -> bool {
        self.legacy.is_none()
            && [Profile::Core, Profile::Memory, Profile::Actions]
                .iter()
                .all(|p| self.get(*p).is_some() == profiles.contains(p))
    }

    /// 已登记的与应当写入的不一致（2.0 `mcpProfileLaunchesStale`）。一个都没装就是用户没装，不算过期：
    /// 修复不能借机替用户装上。
    pub fn stale(&self, launch: &Launch, profiles: &[Profile]) -> bool {
        if !self.any() {
            return false;
        }
        if self.legacy.is_some() {
            return true;
        }
        for p in [Profile::Core, Profile::Memory, Profile::Actions] {
            let entry = self.get(p);
            if !profiles.contains(&p) {
                if entry.is_some() {
                    return true;
                }
                continue;
            }
            match entry {
                None => return true,
                Some(e) if *e != launch.for_profile(p) => return true,
                Some(_) => {}
            }
        }
        false
    }
}

/// 一次安装或卸载的结果（2.0 `InstallResult`）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Written {
    pub client: Client,
    pub path: PathBuf,
    pub backup: Option<PathBuf>,
}

impl Written {
    pub fn view(&self) -> Value {
        json!({
            "client": self.client.as_str(),
            "path": self.path.to_string_lossy(),
            "backupPath": self.backup.as_ref().map(|b| b.to_string_lossy().into_owned()),
        })
    }
}

fn js_string_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(_) => js_json(v),
        Value::Array(a) => a.iter().map(js_string_of).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `env` 全是字符串时是那张表，否则不算（2.0 `stringRecord`）。
fn string_record(v: Option<&Value>) -> Option<BTreeMap<String, String>> {
    let m = v?.as_object()?;
    m.iter()
        .map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_owned())))
        .collect()
}

fn launch_of(server: &Value) -> Option<Launch> {
    let command = server.get("command")?.as_str()?.to_owned();
    let args = server
        .get("args")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(js_string_of).collect())
        .unwrap_or_default();
    Some(Launch {
        command,
        args,
        env: string_record(server.get("env")).unwrap_or_default(),
    })
}

/// 读一个 JSON 对象；不存在是 `None`，不是合法的 JSON 对象时报 `invalid`。
fn read_object(path: &Path, invalid: &str) -> Result<Option<Map<String, Value>>> {
    let Some(text) = read_text(path).map_err(|e| AgentError::io("AGENT_CONFIG_READ_FAILED", e))?
    else {
        return Ok(None);
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(m)) => Ok(Some(m)),
        _ => Err(AgentError::new(
            invalid,
            format!("{} 不是合法的 JSON 对象", path.display()),
        )),
    }
}

/// 读配置里的 `mcpServers`（读不了或不是 JSON 时是空的：检查不报错，2.0 `readJsonMcpServers`）。
pub fn json_servers(path: &Path) -> Map<String, Value> {
    read_text(path)
        .ok()
        .flatten()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("mcpServers").and_then(Value::as_object).cloned())
        .map(|m| m.into_iter().filter(|(_, v)| v.is_object()).collect())
        .unwrap_or_default()
}

pub fn json_installed(path: &Path) -> Installed {
    let mut found = Installed::default();
    for (name, server) in json_servers(path) {
        if let Some(l) = launch_of(&server) {
            found.set(&name, l);
        }
    }
    found
}

fn managed_entries(launch: &Launch, profiles: &[Profile], transport: bool) -> Vec<(String, Value)> {
    profiles
        .iter()
        .map(|p| {
            let l = launch.for_profile(*p);
            let mut v = Map::new();
            if transport {
                v.insert("transport".into(), json!("stdio"));
            }
            v.insert("command".into(), json!(l.command));
            v.insert("args".into(), json!(l.args));
            v.insert("env".into(), json!(l.env));
            (p.server_name().to_owned(), Value::Object(v))
        })
        .collect()
}

/// JSON 客户端（Claude Desktop、Kimi Code）的写入：ATM 的 server 换成 `entries`（空就是卸载），别的照旧。
fn write_json_servers(
    path: &Path,
    invalid: &str,
    entries: Vec<(String, Value)>,
    create: bool,
) -> Result<Option<PathBuf>> {
    let existing = read_object(path, invalid)?;
    if existing.is_none() && !create {
        return Ok(None);
    }
    let mut config = existing.unwrap_or_default();
    let current = config
        .get("mcpServers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut servers: Map<String, Value> = current
        .into_iter()
        .filter(|(name, _)| !names::managed(name))
        .collect();
    for (name, v) in entries {
        servers.insert(name, v);
    }
    // `{...existing, mcpServers}`：已有的键留在原位，没有就加在末尾。
    config.insert("mcpServers".into(), Value::Object(servers));
    write_if_changed(path, &js_json_pretty(&Value::Object(config)))
        .map_err(|e| AgentError::io("AGENT_CONFIG_WRITE_FAILED", e))
}

pub fn claude_install(path: &Path, launch: &Launch, profiles: &[Profile]) -> Result<Written> {
    let backup = write_json_servers(
        path,
        "CLAUDE_CONFIG_INVALID_JSON",
        managed_entries(launch, profiles, false),
        true,
    )?;
    Ok(Written {
        client: Client::Claude,
        path: path.into(),
        backup,
    })
}

pub fn claude_uninstall(path: &Path) -> Result<Written> {
    let backup = write_json_servers(path, "CLAUDE_CONFIG_INVALID_JSON", Vec::new(), false)?;
    Ok(Written {
        client: Client::Claude,
        path: path.into(),
        backup,
    })
}

pub fn kimi_install(path: &Path, launch: &Launch, profiles: &[Profile]) -> Result<Written> {
    let backup = write_json_servers(
        path,
        "KIMI_CODE_CONFIG_INVALID_JSON",
        managed_entries(launch, profiles, true),
        true,
    )?;
    Ok(Written {
        client: Client::KimiCode,
        path: path.into(),
        backup,
    })
}

pub fn kimi_uninstall(path: &Path) -> Result<Written> {
    let backup = write_json_servers(path, "KIMI_CODE_CONFIG_INVALID_JSON", Vec::new(), false)?;
    Ok(Written {
        client: Client::KimiCode,
        path: path.into(),
        backup,
    })
}

/// Kimi 的受管 server 缺了或写错 `transport`：Kimi 起不来它，而 command / args / env 看着全对。
pub fn kimi_transport_mismatch(path: &Path) -> bool {
    json_servers(path)
        .iter()
        .any(|(name, s)| names::managed(name) && s.get("transport") != Some(&json!("stdio")))
}

// ---------- Codex ----------

fn js_trim_end(s: &str) -> &str {
    s.trim_end_matches(is_js_whitespace)
}

fn toml_header(line: &str) -> Option<&str> {
    let t = atm_domain::text::js_trim(line);
    let inner = t.strip_prefix('[')?.strip_suffix(']')?;
    (!inner.is_empty() && !inner.contains(']')).then_some(inner)
}

fn managed_codex_section(header: &str) -> bool {
    names::ALL.iter().any(|name| {
        [
            format!("mcp_servers.{name}"),
            format!("mcp_servers.\"{name}\""),
        ]
        .iter()
        .any(|root| header == root || header.starts_with(&format!("{root}.")))
    })
}

fn without_own_codex_sections(content: &str) -> String {
    let mut out = Vec::new();
    let mut skipping = false;
    for line in content.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(h) = toml_header(line) {
            skipping = managed_codex_section(h);
            if skipping {
                continue;
            }
        }
        if !skipping {
            out.push(line);
        }
    }
    js_trim_end(&out.join("\n")).to_string()
}

fn toml_string(s: &str) -> String {
    js_json(&json!(s))
}

pub fn codex_install(path: &Path, launch: &Launch, profiles: &[Profile]) -> Result<Written> {
    let existing = read_text(path)
        .map_err(|e| AgentError::io("AGENT_CONFIG_READ_FAILED", e))?
        .unwrap_or_default();
    let base = without_own_codex_sections(&existing);
    let sections: Vec<String> = profiles
        .iter()
        .map(|p| {
            let l = launch.for_profile(*p);
            let mut lines = vec![
                format!("[mcp_servers.{}]", toml_string(p.server_name())),
                format!("command = {}", toml_string(&l.command)),
                format!(
                    "args = [{}]",
                    l.args
                        .iter()
                        .map(|a| toml_string(a))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            ];
            if !l.env.is_empty() {
                lines.push(format!(
                    "env = {{ {} }}",
                    l.env
                        .iter()
                        .map(|(k, v)| format!("{} = {}", toml_string(k), toml_string(v)))
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            lines.join("\n")
        })
        .collect();
    let content = format!(
        "{base}{}{}\n",
        if base.is_empty() { "" } else { "\n\n" },
        sections.join("\n\n")
    );
    let backup = if existing == content {
        None
    } else {
        write_if_changed(path, &content)
            .map_err(|e| AgentError::io("AGENT_CONFIG_WRITE_FAILED", e))?
    };
    Ok(Written {
        client: Client::Codex,
        path: path.into(),
        backup,
    })
}

pub fn codex_uninstall(path: &Path) -> Result<Written> {
    let existing = read_text(path)
        .map_err(|e| AgentError::io("AGENT_CONFIG_READ_FAILED", e))?
        .unwrap_or_default();
    let next = without_own_codex_sections(&existing);
    let content = if next.is_empty() {
        String::new()
    } else {
        format!("{next}\n")
    };
    let backup = if existing == content {
        None
    } else {
        crate::files::replace_with_backup(path, content.as_bytes())
            .map_err(|e| AgentError::io("AGENT_CONFIG_WRITE_FAILED", e))?
    };
    Ok(Written {
        client: Client::Codex,
        path: path.into(),
        backup,
    })
}

/// `{ "k" = "v", ... }`，只认字符串值（2.0 `tomlInlineStringTable`）。
fn toml_inline_strings(v: &str) -> Option<BTreeMap<String, String>> {
    let t = atm_domain::text::js_trim(v);
    let inner = atm_domain::text::js_trim(t.strip_prefix('{')?.strip_suffix('}')?);
    let mut out = BTreeMap::new();
    let mut rest = inner;
    loop {
        rest = rest.trim_start_matches(|c: char| c == ',' || is_js_whitespace(c));
        if rest.is_empty() {
            return Some(out);
        }
        let (k, after) = json_string_prefix(rest)?;
        let after = after.trim_start().strip_prefix('=')?.trim_start();
        let (val, after) = json_string_prefix(after)?;
        out.insert(k, val);
        rest = after;
    }
}

/// 开头的一个 JSON 字符串字面量与剩下的部分。
fn json_string_prefix(s: &str) -> Option<(String, &str)> {
    if !s.starts_with('"') {
        return None;
    }
    let bytes = s.as_bytes();
    let mut i = 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'"' => {
                let lit = &s[..=i];
                return serde_json::from_str::<String>(lit)
                    .ok()
                    .map(|v| (v, &s[i + 1..]));
            }
            _ => i += 1,
        }
    }
    None
}

pub fn codex_installed(path: &Path) -> Installed {
    let mut found = Installed::default();
    let Some(text) = read_text(path).ok().flatten() else {
        return found;
    };
    // 2.0 `codexProfileLaunches`：写了 command 的段才算登记（空串也算），args / env 缺省为空。
    let mut active: Option<String> = None;
    let mut command: Option<String> = None;
    let mut cur = Launch::new("");
    let flush = |found: &mut Installed,
                 active: &Option<String>,
                 command: &mut Option<String>,
                 cur: &mut Launch| {
        if let (Some(name), Some(c)) = (active, command.take()) {
            cur.command = c;
            found.set(name, std::mem::replace(cur, Launch::new("")));
        }
        *cur = Launch::new("");
    };
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(h) = toml_header(line) {
            flush(&mut found, &active, &mut command, &mut cur);
            let name = h.strip_prefix("mcp_servers.").map(|n| {
                n.strip_prefix('"')
                    .and_then(|q| q.strip_suffix('"'))
                    .filter(|q| !q.contains('"'))
                    .unwrap_or(n)
                    .to_string()
            });
            active = name.filter(|n| names::managed(n));
            continue;
        }
        if active.is_none() {
            continue;
        }
        let t = atm_domain::text::js_trim(line);
        let value = |key: &str| -> Option<&str> {
            let rest = t.strip_prefix(key)?;
            let rest = rest
                .trim_start_matches(is_js_whitespace)
                .strip_prefix('=')?;
            Some(rest.trim_start_matches(is_js_whitespace))
        };
        if let Some(v) = value("command").filter(|v| v.starts_with('"') && v.ends_with('"')) {
            if let Ok(c) = serde_json::from_str::<String>(v) {
                command = Some(c);
            }
        } else if let Some(v) = value("args").filter(|v| v.starts_with('[') && v.ends_with(']')) {
            if let Ok(Value::Array(a)) = serde_json::from_str::<Value>(v) {
                cur.args = a.iter().map(js_string_of).collect();
            }
        } else if let Some(v) = value("env").filter(|v| v.starts_with('{') && v.ends_with('}')) {
            cur.env = toml_inline_strings(v).unwrap_or_default();
        }
    }
    flush(&mut found, &active, &mut command, &mut cur);
    found
}

// ---------- Claude Code ----------

/// `~/.claude.json` 里的受管 server（原样）。
pub fn claude_code_managed(path: &Path) -> Map<String, Value> {
    json_servers(path)
        .into_iter()
        .filter(|(n, _)| names::managed(n))
        .collect()
}

fn same_launch(current: Option<&Value>, desired: &Launch) -> bool {
    current.and_then(launch_of).as_ref() == Some(desired)
}

fn cli_or_missing(env: &AgentEnv) -> Result<PathBuf> {
    env.find_claude_cli()
        .ok_or_else(|| AgentError::new("CLAUDE_CODE_CLI_NOT_FOUND", "没有找到 claude 命令行"))
}

fn run(env: &AgentEnv, cli: &Path, args: &[&str]) -> Result<()> {
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    env.cli.run(cli, &args).map_err(|e| {
        let code = e
            .split(':')
            .next()
            .unwrap_or("CLAUDE_CODE_CLI_FAILED")
            .to_string();
        AgentError::new(
            if code.chars().all(|c| c.is_ascii_uppercase() || c == '_') {
                &code
            } else {
                "CLAUDE_CODE_CLI_FAILED"
            },
            e,
        )
    })
}

/// 把 Claude Code 的受管 server 换成 `desired`（可为空 = 卸载）。中途失败：已加的逆序删掉、删掉的加回去；
/// 回滚也失败报 `CLAUDE_CODE_INSTALL_AND_ROLLBACK_FAILED`。
pub fn claude_code_replace(env: &AgentEnv, desired: &[(String, Value)]) -> Result<Written> {
    let path = env.claude_code_config();
    let previous = claude_code_managed(&path);
    let unchanged = names::ALL
        .iter()
        .all(|n| desired.iter().any(|(d, _)| d == n) || !previous.contains_key(*n))
        && desired
            .iter()
            .all(|(n, v)| launch_of(v).is_some_and(|l| same_launch(previous.get(n), &l)));
    if unchanged {
        return Ok(Written {
            client: Client::ClaudeCode,
            path,
            backup: None,
        });
    }
    let cli = cli_or_missing(env)?;
    let mut removed: Vec<(String, Value)> = Vec::new();
    let mut added: Vec<String> = Vec::new();
    let attempt = (|| -> Result<()> {
        for n in names::ALL {
            if let Some(cfg) = previous.get(n) {
                run(env, &cli, &["mcp", "remove", n, "--scope", "user"])?;
                removed.push((n.to_string(), cfg.clone()));
            }
        }
        for (n, cfg) in desired {
            run(
                env,
                &cli,
                &["mcp", "add-json", n, &js_json(cfg), "--scope", "user"],
            )?;
            added.push(n.clone());
        }
        Ok(())
    })();
    if let Err(e) = attempt {
        let rollback = (|| -> Result<()> {
            for n in added.iter().rev() {
                run(env, &cli, &["mcp", "remove", n, "--scope", "user"])?;
            }
            for (n, cfg) in &removed {
                run(
                    env,
                    &cli,
                    &["mcp", "add-json", n, &js_json(cfg), "--scope", "user"],
                )?;
            }
            Ok(())
        })();
        return Err(match rollback {
            Ok(()) => e,
            Err(r) => AgentError::new(
                "CLAUDE_CODE_INSTALL_AND_ROLLBACK_FAILED",
                format!("{}; rollback: {}", e.message, r.message),
            ),
        });
    }
    Ok(Written {
        client: Client::ClaudeCode,
        path,
        backup: None,
    })
}

/// Claude Code 要写的条目：`{command, args, env}`（`claude mcp add-json` 的形状）。
pub fn claude_code_entries(launch: &Launch, profiles: &[Profile]) -> Vec<(String, Value)> {
    profiles
        .iter()
        .map(|p| (p.server_name().to_string(), launch.for_profile(*p).json()))
        .collect()
}

pub fn claude_code_install(
    env: &AgentEnv,
    launch: &Launch,
    profiles: &[Profile],
) -> Result<Written> {
    claude_code_replace(env, &claude_code_entries(launch, profiles))
}

pub fn claude_code_uninstall(env: &AgentEnv) -> Result<Written> {
    let path = env.claude_code_config();
    let installed = claude_code_managed(&path);
    if installed.is_empty() {
        return Ok(Written {
            client: Client::ClaudeCode,
            path,
            backup: None,
        });
    }
    let cli = cli_or_missing(env)?;
    for n in names::ALL {
        if installed.contains_key(n) {
            run(env, &cli, &["mcp", "remove", n, "--scope", "user"])?;
        }
    }
    Ok(Written {
        client: Client::ClaudeCode,
        path,
        backup: None,
    })
}

// ---------- 按客户端 ----------

/// 一个客户端的全部配置位置上登记着的（Claude Desktop 有几份配置就有几份）。
pub fn installed_sets(env: &AgentEnv, client: Client) -> Vec<(PathBuf, Installed)> {
    match client {
        Client::Codex => vec![(env.codex_config(), codex_installed(&env.codex_config()))],
        Client::Claude => env
            .claude_desktop_configs()
            .into_iter()
            .map(|p| {
                let i = json_installed(&p);
                (p, i)
            })
            .collect(),
        Client::ClaudeCode => {
            vec![(
                env.claude_code_config(),
                json_installed(&env.claude_code_config()),
            )]
        }
        Client::KimiCode => vec![(env.kimi_config(), json_installed(&env.kimi_config()))],
    }
}

/// 还留着任意一个 ATM 的 server（卸载共用规则前问的是这个，判据故意比 [`installed`] 宽）。
pub fn present(env: &AgentEnv, client: Client) -> bool {
    installed_sets(env, client).iter().any(|(_, i)| i.any())
}

/// 配得完全正确（界面的「已安装」）。Claude Desktop 任一份对就算；Claude Code 只看名字集合（2.0 同）；
/// Kimi 还要 transport 对。
pub fn installed(env: &AgentEnv, client: Client, profiles: &[Profile]) -> bool {
    match client {
        Client::Claude => installed_sets(env, client)
            .iter()
            .any(|(_, i)| i.matches(profiles)),
        Client::ClaudeCode => {
            let servers = json_servers(&env.claude_code_config());
            names::ALL
                .iter()
                .all(|n| servers.contains_key(*n) == profiles.iter().any(|p| p.server_name() == *n))
        }
        Client::KimiCode => {
            json_installed(&env.kimi_config()).matches(profiles)
                && !kimi_transport_mismatch(&env.kimi_config())
        }
        Client::Codex => codex_installed(&env.codex_config()).matches(profiles),
    }
}

/// 过期：任一位置登记着的与应当写入的不一致（Kimi 还看 transport）。
pub fn stale(env: &AgentEnv, client: Client, profiles: &[Profile]) -> bool {
    let sets = installed_sets(env, client);
    let any_stale = sets.iter().any(|(_, i)| i.stale(&env.launch, profiles));
    match client {
        Client::KimiCode => any_stale || kimi_transport_mismatch(&env.kimi_config()),
        _ => any_stale,
    }
}

/// 按启用的档位写这个客户端（Claude Desktop 写每一份，返回第一份的结果）。
pub fn install(env: &AgentEnv, client: Client, profiles: &[Profile]) -> Result<Written> {
    match client {
        Client::Codex => codex_install(&env.codex_config(), &env.launch, profiles),
        Client::Claude => {
            let mut first = None;
            for p in env.claude_desktop_configs() {
                let w = claude_install(&p, &env.launch, profiles)?;
                first.get_or_insert(w);
            }
            Ok(first.expect("at least the classic path"))
        }
        Client::ClaudeCode => claude_code_install(env, &env.launch, profiles),
        Client::KimiCode => kimi_install(&env.kimi_config(), &env.launch, profiles),
    }
}

pub fn uninstall(env: &AgentEnv, client: Client) -> Result<Written> {
    match client {
        Client::Codex => codex_uninstall(&env.codex_config()),
        Client::Claude => {
            let results: Vec<Written> = env
                .claude_desktop_configs()
                .iter()
                .map(|p| claude_uninstall(p))
                .collect::<Result<_>>()?;
            Ok(results
                .iter()
                .find(|w| w.backup.is_some())
                .cloned()
                .unwrap_or_else(|| results[0].clone()))
        }
        Client::ClaudeCode => claude_code_uninstall(env),
        Client::KimiCode => kimi_uninstall(&env.kimi_config()),
    }
}
