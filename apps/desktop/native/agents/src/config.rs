//! 四种客户端的 MCP 配置（2.0 `mcp-install.ts`、`mcp-inspection.ts`、`kimi-code-config.ts`）。
//!
//! 只动 ATM 自己的几个 server（[`crate::names`]），别的 server 与顶层键原样保留；内容没变就不写。
//! - Codex：`~/.codex/config.toml` 里的 `[mcp_servers."<name>"]` 段（连同 `.env` 之类的子表）按行替换。
//!   装了什么、谁是 ATM 的、节点是什么类型，按 TOML 解析器（`toml`，与 Codex 自己用的同一个）读出的结构判断；
//!   手写的逐行扫描只决定删哪几行、写法规不规范。写之前把结果再解析一遍核对（peer W6 r3 P2-01–03）；
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
    /// ATM 的 server 不是写成 `[mcp_servers.<名字>]` 段，而是行内表、点分键（peer W6 r2 P1-02）：算已接入、
    /// 算过期，修复时改写成段。
    pub noncanonical: bool,
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
            || self.noncanonical
    }

    /// 档位集合与启用的完全一致，且没有旧单入口（2.0 `installedProfileSetMatches`；actions 从不启用）。
    pub fn matches(&self, profiles: &[Profile]) -> bool {
        self.legacy.is_none()
            && !self.noncanonical
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
        if self.legacy.is_some() || self.noncanonical {
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

/// Codex `config.toml` 的一行在 TOML 里是什么（peer W6 r1 P1-03）。只做找段需要的那一点词法：表头的点分键、
/// 注释、单行与多行字符串、跨行的数组。多行字符串与数组里面以 `[`、`#` 开头的行都不是表头或注释。
#[derive(Debug, PartialEq, Eq)]
enum TomlLine {
    /// `[a.b]` 或 `[[a.b]]`：键按 TOML 解码（裸键、"基本"、'字面'）。是不是数组表由解析器判断。
    Header(Vec<String>),
    /// 空行或只有注释（不在字符串、数组里）。
    Comment,
    /// 一条键值语句的第一行，带它的点分键（相对当前表）；`None` 是多行值的后续行。
    Content(Option<Vec<String>>),
}

#[derive(Clone, Copy, Default)]
struct TomlScan {
    /// 正在多行字符串里：`"""` 或 `'''`。
    multiline: Option<char>,
    /// 跨行的数组 / 内联表还没闭合的层数。
    depth: usize,
}

/// 一个 TOML 键（基本串）从 `s` 开头读到闭合引号：返回解码后的值与剩余部分。
fn toml_basic_key(s: &str) -> Option<(String, &str)> {
    let mut out = String::new();
    let mut chars = s.char_indices();
    while let Some((i, c)) = chars.next() {
        match c {
            '"' => return Some((out, &s[i + 1..])),
            '\\' => {
                let (_, e) = chars.next()?;
                match e {
                    '"' => out.push('"'),
                    '\\' => out.push('\\'),
                    'b' => out.push('\u{8}'),
                    't' => out.push('\t'),
                    'n' => out.push('\n'),
                    'f' => out.push('\u{c}'),
                    'r' => out.push('\r'),
                    'u' | 'U' => {
                        let n = if e == 'u' { 4 } else { 8 };
                        let hex: String = (0..n)
                            .filter_map(|_| chars.next().map(|(_, h)| h))
                            .collect();
                        out.push(char::from_u32(u32::from_str_radix(&hex, 16).ok()?)?);
                    }
                    _ => return None,
                }
            }
            '\n' | '\r' => return None,
            c => out.push(c),
        }
    }
    None
}

/// 从 `rest` 开头读一个点分键（裸键、"基本"、'字面'，段间可有空白）：返回各段（解码后）与剩下的部分。
fn toml_keys(mut rest: &str) -> Option<(Vec<String>, &str)> {
    let mut keys = Vec::new();
    loop {
        rest = rest.trim_start_matches([' ', '\t']);
        let (key, after) = if let Some(r) = rest.strip_prefix('"') {
            toml_basic_key(r)?
        } else if let Some(r) = rest.strip_prefix('\'') {
            let end = r.find('\'')?;
            (r[..end].to_string(), &r[end + 1..])
        } else {
            let end = rest
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
                .unwrap_or(rest.len());
            if end == 0 {
                return None;
            }
            (rest[..end].to_string(), &rest[end..])
        };
        keys.push(key);
        rest = after.trim_start_matches([' ', '\t']);
        match rest.strip_prefix('.') {
            Some(r) => rest = r,
            None => return Some((keys, rest)),
        }
    }
}

/// 表头 `[`…`]` / `[[`…`]]` 的点分键；后面只许空白或注释。解析不了返回 None。
fn toml_header_keys(t: &str) -> Option<TomlLine> {
    let array = t.starts_with("[[");
    let (keys, rest) = toml_keys(&t[if array { 2 } else { 1 }..])?;
    let rest = rest.strip_prefix(if array { "]]" } else { "]" })?;
    let tail = rest.trim_start_matches([' ', '\t']);
    (tail.is_empty() || tail.starts_with('#')).then_some(TomlLine::Header(keys))
}

/// 键值语句 `a.b = …` 的点分键与 `=` 后面的部分。
fn toml_statement_keys(t: &str) -> Option<(Vec<String>, &str)> {
    let (keys, rest) = toml_keys(t)?;
    Some((keys, rest.strip_prefix('=')?))
}

/// 扫一行的值部分（不是表头时），更新多行字符串与数组的状态。单行字符串必须在本行闭合。
fn toml_scan_value(line: &str, s: &mut TomlScan) -> Option<()> {
    let b = line.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if let Some(q) = s.multiline {
            let close: &[u8] = if q == '"' { b"\"\"\"" } else { b"'''" };
            if q == '"' && b[i] == b'\\' {
                i += 2;
                continue;
            }
            if b[i..].starts_with(close) {
                i += 3;
                // `""""` 之类：闭合引号前面最多再带两个引号作内容。
                let mut extra = 0;
                while extra < 2 && i < b.len() && b[i] == close[0] {
                    i += 1;
                    extra += 1;
                }
                s.multiline = None;
                continue;
            }
            i += 1;
            continue;
        }
        match b[i] {
            b'#' => return Some(()),
            b'"' | b'\'' => {
                let q = b[i];
                if b[i..].starts_with(&[q, q, q]) {
                    s.multiline = Some(q as char);
                    i += 3;
                    continue;
                }
                i += 1;
                loop {
                    let c = *b.get(i)?;
                    i += 1;
                    if q == b'"' && c == b'\\' {
                        i += 1;
                    } else if c == q {
                        break;
                    }
                }
            }
            b'[' | b'{' => {
                s.depth += 1;
                i += 1;
            }
            b']' | b'}' => {
                s.depth = s.depth.checked_sub(1)?;
                i += 1;
            }
            _ => i += 1,
        }
    }
    Some(())
}

/// 整个文件逐行分类。行保留原样（含行尾）；不认得的写法返回 Err，调用方不猜删除范围。
fn toml_lines(content: &str) -> Result<Vec<(&str, TomlLine)>> {
    let invalid = |n: usize| {
        AgentError::new(
            "CODEX_CONFIG_INVALID_TOML",
            format!("Codex 的 config.toml 第 {n} 行无法识别；没有改动这个文件"),
        )
    };
    let mut out = Vec::new();
    let mut s = TomlScan::default();
    for (n, raw) in content.split_inclusive('\n').enumerate() {
        let line = raw.trim_end_matches(['\n', '\r']);
        let t = line.trim_start_matches([' ', '\t']);
        let kind = if s.multiline.is_none() && s.depth == 0 && t.starts_with('[') {
            toml_header_keys(t).ok_or_else(|| invalid(n + 1))?
        } else if s.multiline.is_none() && s.depth == 0 && (t.is_empty() || t.starts_with('#')) {
            TomlLine::Comment
        } else {
            let start = s.multiline.is_none() && s.depth == 0;
            let keys = if start {
                Some(toml_statement_keys(t).ok_or_else(|| invalid(n + 1))?.0)
            } else {
                None
            };
            toml_scan_value(line, &mut s).ok_or_else(|| invalid(n + 1))?;
            TomlLine::Content(keys)
        };
        out.push((raw, kind));
    }
    if s.multiline.is_some() || s.depth > 0 {
        return Err(invalid(out.len()));
    }
    Ok(out)
}

/// `[mcp_servers.<ATM 的名字>]` 及它的子表（`.env` 之类）。
fn managed_codex_section(keys: &[String]) -> bool {
    keys.len() >= 2 && keys[0] == "mcp_servers" && names::ALL.contains(&keys[1].as_str())
}

/// 去掉 ATM 自己的定义之后的配置。
struct WithoutOwn {
    text: String,
    /// 顶层 `mcp_servers = { … }`（整张表写成行内表）所在的行：行内表不能再往里加段，ATM 没法保真地加入
    /// 自己的条目；里面有 ATM 的条目时也删不掉。
    inline_servers: Option<usize>,
}

/// 去掉 ATM 自己的定义：`[mcp_servers.<名字>]` 段（含子表）里的键值行与空行，以及别处键路径落在
/// `mcp_servers.<名字>` 下面的语句（`[mcp_servers]` 下的行内表、点分键，顶层的点分键；连同它的多行值，
/// peer W6 r2 P1-02）。注释一律留着（ATM 从不写注释，注释都是用户的），用户的语句原样（行尾也原样）。
/// 文末的空白去掉，与 2.0 一样。
fn without_own_codex_sections(content: &str) -> Result<WithoutOwn> {
    let mut out = WithoutOwn {
        text: String::new(),
        inline_servers: None,
    };
    let mut table: Vec<String> = Vec::new();
    let mut skipping = false;
    let mut skip_statement = false;
    for (n, (raw, kind)) in toml_lines(content)?.into_iter().enumerate() {
        match kind {
            TomlLine::Header(keys) => {
                skipping = managed_codex_section(&keys);
                skip_statement = false;
                if !skipping {
                    out.text.push_str(raw);
                }
                table = keys;
            }
            TomlLine::Comment => {
                if !skipping || !raw.trim_matches([' ', '\t', '\r', '\n']).is_empty() {
                    out.text.push_str(raw);
                }
            }
            TomlLine::Content(Some(keys)) => {
                let full: Vec<String> = table.iter().chain(&keys).cloned().collect();
                if full == ["mcp_servers"] {
                    out.inline_servers.get_or_insert(n + 1);
                }
                skip_statement = skipping || managed_codex_section(&full);
                if !skip_statement {
                    out.text.push_str(raw);
                }
            }
            TomlLine::Content(None) => {
                if !skip_statement {
                    out.text.push_str(raw);
                }
            }
        }
    }
    out.text = js_trim_end(&out.text).to_string();
    Ok(out)
}

fn inline_servers_unsupported(line: usize) -> AgentError {
    AgentError::new(
        "CODEX_CONFIG_UNSUPPORTED",
        format!(
            "Codex 的 config.toml 第 {line} 行把整个 mcp_servers 写成了行内表，ATM 没法在不改写你的内容的前提下\
             加入或去掉自己的条目。请改成 [mcp_servers.<名字>] 段的写法后再试；没有改动这个文件"
        ),
    )
}

fn unsupported(why: &str) -> AgentError {
    AgentError::new(
        "CODEX_CONFIG_UNSUPPORTED",
        format!("Codex 的 config.toml {why}，ATM 没法保真地改写它；没有改动这个文件"),
    )
}

/// 按 TOML 解析整份配置（与 Codex 用同一个解析器）。
fn codex_doc(text: &str) -> Result<toml::Table> {
    text.parse::<toml::Table>().map_err(|e| {
        AgentError::new(
            "CODEX_CONFIG_INVALID_TOML",
            format!(
                "Codex 的 config.toml 不是合法的 TOML（{}）；没有改动这个文件",
                e.message()
            ),
        )
    })
}

/// 一个值里（`mcp_servers` 的表或数组）有没有 ATM 的条目：只看解码后的键，不看值和注释。
fn has_managed(v: &toml::Value) -> bool {
    match v {
        toml::Value::Table(t) => t.keys().any(|k| names::managed(k)),
        toml::Value::Array(a) => a.iter().any(has_managed),
        _ => false,
    }
}

/// 去掉 ATM 的条目之后的整份配置（用来核对用户的内容一个字都没变）。去掉之后空了的 `mcp_servers` 也去掉。
fn without_managed(doc: &toml::Table) -> toml::Table {
    let mut doc = doc.clone();
    if let Some(toml::Value::Table(servers)) = doc.get_mut("mcp_servers") {
        servers.retain(|k, _| !names::managed(k));
        if servers.is_empty() {
            doc.remove("mcp_servers");
        }
    }
    doc
}

/// ATM 写的一个 server 应当是什么样。
fn codex_entry(l: &Launch) -> toml::Value {
    let mut t = toml::Table::new();
    t.insert("command".into(), l.command.clone().into());
    t.insert(
        "args".into(),
        toml::Value::Array(l.args.iter().cloned().map(Into::into).collect()),
    );
    if !l.env.is_empty() {
        t.insert(
            "env".into(),
            toml::Value::Table(
                l.env
                    .iter()
                    .map(|(k, v)| (k.clone(), v.clone().into()))
                    .collect(),
            ),
        );
    }
    toml::Value::Table(t)
}

/// 改写之后再解析一遍：必须是合法 TOML，ATM 以外的内容与改写前完全相同，`mcp_servers` 是表，ATM 的条目
/// 正好是应当写入的那几个（卸载时一个都没有）。任何一条不成立都不写。
fn verify_codex(
    before: &toml::Table,
    content: &str,
    desired: &[(String, toml::Value)],
) -> Result<()> {
    let after = content
        .parse::<toml::Table>()
        .map_err(|_| unsupported("改写之后不再是合法的 TOML"))?;
    if toml::to_string(&without_managed(before)).ok()
        != toml::to_string(&without_managed(&after)).ok()
    {
        return Err(unsupported("改写之后 ATM 以外的内容变了"));
    }
    let ours: Vec<(String, toml::Value)> = match after.get("mcp_servers") {
        None => Vec::new(),
        Some(toml::Value::Table(servers)) => servers
            .iter()
            .filter(|(k, _)| names::managed(k))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        // 不是表：卸载、而且里面本来就没有 ATM 的条目时用不着动它。
        Some(v) if desired.is_empty() && !has_managed(v) => Vec::new(),
        Some(_) => return Err(unsupported("里的 mcp_servers 不是表")),
    };
    let mut ours = ours;
    ours.sort_by(|a, b| a.0.cmp(&b.0));
    let mut want = desired.to_vec();
    want.sort_by(|a, b| a.0.cmp(&b.0));
    if ours != want {
        return Err(unsupported("改写之后 ATM 的条目不是应当写入的样子"));
    }
    Ok(())
}

/// 读出现有的 config.toml，算出改写后的全文：`desired` 为 `Some` 是按这些档位安装，`None` 是卸载。ATM 改不了
/// 的写法报错（零写入）。返回（现有全文，改写后的全文）。
fn codex_plan(path: &Path, desired: Option<(&Launch, &[Profile])>) -> Result<(String, String)> {
    let existing = read_text(path)
        .map_err(|e| AgentError::io("AGENT_CONFIG_READ_FAILED", e))?
        .unwrap_or_default();
    let doc = codex_doc(&existing)?;
    let own = without_own_codex_sections(&existing)?;
    let servers = doc.get("mcp_servers");
    let ours_inside = servers.is_some_and(has_managed);
    // 安装要往里加段；卸载只在里面有 ATM 的条目时才需要动它。
    let needs_room = desired.is_some() || ours_inside;
    if let Some(v) = servers
        && !v.is_table()
        && needs_room
    {
        return Err(unsupported(
            "里的 mcp_servers 不是表（比如写成了 [[mcp_servers]] 数组表）",
        ));
    }
    if let Some(line) = own.inline_servers
        && needs_room
    {
        return Err(inline_servers_unsupported(line));
    }
    let eol = codex_eol(&existing);
    let (content, entries) = match desired {
        Some((launch, profiles)) => {
            let sections: Vec<String> = profiles
                .iter()
                .map(|p| codex_section(&launch.for_profile(*p), p.server_name(), eol))
                .collect();
            let content = format!(
                "{}{}{}{eol}",
                own.text,
                if own.text.is_empty() {
                    String::new()
                } else {
                    eol.repeat(2)
                },
                sections.join(&eol.repeat(2))
            );
            let entries = profiles
                .iter()
                .map(|p| {
                    (
                        p.server_name().to_string(),
                        codex_entry(&launch.for_profile(*p)),
                    )
                })
                .collect();
            (content, entries)
        }
        None if own.text.is_empty() => (String::new(), Vec::new()),
        None => (format!("{}{eol}", own.text), Vec::new()),
    };
    verify_codex(&doc, &content, &entries)?;
    Ok((existing, content))
}

/// `[mcp_servers."<名字>"]` 段。
fn codex_section(l: &Launch, name: &str, eol: &str) -> String {
    let mut lines = vec![
        format!("[mcp_servers.{}]", toml_string(name)),
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
    lines.join(eol)
}

/// 写动作之前先把要改的配置读一遍、算出结果（peer W6 r2 P2-02）：认不出的、ATM 改不了的，在动规则、Skill、
/// 任何配置之前就报错，整个操作零写入。Codex 照真正要写的档位算一遍并核对（与写入时同一个计划）。
/// Claude Code 经它的命令行改，由命令行自己校验。`profiles` 为 `None` 是卸载。
pub fn preflight(env: &AgentEnv, client: Client, profiles: Option<&[Profile]>) -> Result<()> {
    match client {
        Client::Codex => {
            codex_plan(&env.codex_config(), profiles.map(|p| (&env.launch, p))).map(|_| ())
        }
        Client::Claude => {
            for p in env.claude_desktop_configs() {
                read_object(&p, "CLAUDE_CONFIG_INVALID_JSON")?;
            }
            Ok(())
        }
        Client::KimiCode => {
            read_object(&env.kimi_config(), "KIMI_CODE_CONFIG_INVALID_JSON").map(|_| ())
        }
        Client::ClaudeCode => Ok(()),
    }
}

/// 原文用 CRLF 的，ATM 写的段也用 CRLF。
fn codex_eol(content: &str) -> &'static str {
    if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

fn toml_string(s: &str) -> String {
    js_json(&json!(s))
}

pub fn codex_install(path: &Path, launch: &Launch, profiles: &[Profile]) -> Result<Written> {
    let (existing, content) = codex_plan(path, Some((launch, profiles)))?;
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
    let (existing, content) = codex_plan(path, None)?;
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

/// 不是字符串的值：给一个与任何字符串都不相等的值，判为过期。
fn codex_text(v: &toml::Value) -> String {
    match v {
        toml::Value::String(s) => s.clone(),
        other => unparsed(other),
    }
}

fn unparsed(v: &toml::Value) -> String {
    format!("\0unparsed {v}")
}

pub fn codex_installed(path: &Path) -> Installed {
    let mut found = Installed::default();
    let Some(text) = read_text(path).ok().flatten() else {
        return found;
    };
    // 不是合法 TOML：当作什么都没登记。启动修复不碰它，显式安装时由写入那一步报 CODEX_CONFIG_INVALID_TOML。
    let Ok(doc) = text.parse::<toml::Table>() else {
        return found;
    };
    let Some(servers) = doc.get("mcp_servers") else {
        return found;
    };
    let toml::Value::Table(servers) = servers else {
        // `[[mcp_servers]]` 之类：里面有 ATM 的条目就算接入了、但写法不对。
        found.noncanonical = has_managed(servers);
        return found;
    };
    // 2.0 `codexProfileLaunches`：写了 command 的才算登记（空串也算），args / env 缺省为空。值按 TOML 解码，
    // 不是字符串的、类型不对的记成与任何期望都不等（peer W6 r3 P2-01）。段里别的键（用户加的超时之类）照 2.0 不看。
    for (name, v) in servers.iter().filter(|(k, _)| names::managed(k)) {
        let toml::Value::Table(s) = v else {
            // `[[mcp_servers."<名字>"]]` 数组表、`<名字> = "…"`（peer W6 r3 P2-03）。
            found.noncanonical = true;
            continue;
        };
        let Some(command) = s.get("command") else {
            continue;
        };
        let mut l = Launch::new(codex_text(command));
        l.args = match s.get("args") {
            None => Vec::new(),
            Some(toml::Value::Array(a)) => a.iter().map(codex_text).collect(),
            Some(other) => vec![unparsed(other)],
        };
        l.env = match s.get("env") {
            None => BTreeMap::new(),
            Some(toml::Value::Table(e)) => {
                e.iter().map(|(k, v)| (k.clone(), codex_text(v))).collect()
            }
            Some(other) => BTreeMap::from([(String::new(), unparsed(other))]),
        };
        found.set(name, l);
    }
    // 写法：ATM 的条目只能是 `[mcp_servers."<名字>"]` 段（含它的子表、段里的 `env.K`）。整张行内表、
    // `[mcp_servers]` 下的行内表或点分键、顶层点分键、数组表都算非规范（peer W6 r2 P1-02、r3 P2-03）。
    // 扫描认不出的写法同样算非规范：修复去改写时由写入那一步报错，不会悄悄当作规范。
    let ours = servers.keys().any(|k| names::managed(k));
    let Ok(lines) = toml_lines(&text) else {
        found.noncanonical |= ours;
        return found;
    };
    let mut table: Vec<String> = Vec::new();
    for (_, kind) in lines {
        let keys = match kind {
            TomlLine::Header(keys) => {
                table = keys;
                continue;
            }
            TomlLine::Content(Some(keys)) => keys,
            _ => continue,
        };
        let full: Vec<&str> = table.iter().chain(&keys).map(String::as_str).collect();
        let defines_ours = (full == ["mcp_servers"] && ours)
            || (full.len() >= 2 && full[0] == "mcp_servers" && names::managed(full[1]));
        if defines_ours && table.len() < 2 {
            found.noncanonical = true;
        }
    }
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

#[cfg(test)]
mod r3_tests {
    use super::*;

    fn doc(s: &str) -> toml::Table {
        s.parse().unwrap()
    }

    /// 改写之后的核对（peer W6 r3）：用户的内容少了、变了，ATM 的条目多了、少了、和应当写入的不同，结果不是合法
    /// TOML，`mcp_servers` 不是表，都拒绝；对的照常通过。手写扫描与解析器对不上的写法由它兜底。
    #[test]
    fn the_rewrite_is_checked_with_the_parser() {
        let before = doc("x = 1\n[mcp_servers.other]\ncommand = \"keep\"\n");
        let l = Launch::new("atm.exe");
        let want = vec![(names::CORE.to_string(), codex_entry(&l))];
        let good = "x = 1\n[mcp_servers.other]\ncommand = \"keep\"\n\n[mcp_servers.\"ayanami-task-manager-core\"]\ncommand = \"atm.exe\"\nargs = []\n";
        verify_codex(&before, good, &want).unwrap();
        verify_codex(
            &before,
            "x = 1\n[mcp_servers.other]\ncommand = \"keep\"\n",
            &[],
        )
        .unwrap();
        let cases: Vec<(String, &str)> = vec![
            (
                good.replace("[mcp_servers.other]\ncommand = \"keep\"\n", ""),
                "user server lost",
            ),
            (good.replace("x = 1", "x = 2"), "user value changed"),
            (good.replace("atm.exe", "old.exe"), "our entry differs"),
            (
                good.replace(
                    "args = []",
                    "args = []\n[mcp_servers.\"ayanami-task-manager-memory\"]\ncommand = \"m\"",
                ),
                "an extra entry",
            ),
            (
                "x = 1\n[mcp_servers.other]\ncommand = \"keep\"\n".to_string(),
                "our entry missing",
            ),
            (good.replace("args = []", "args = ["), "not TOML"),
        ];
        for (bad, why) in &cases {
            assert_eq!(
                verify_codex(&before, bad, &want).unwrap_err().code,
                "CODEX_CONFIG_UNSUPPORTED",
                "{why}"
            );
        }
        let array = doc("[[mcp_servers]]\nother = 1\n");
        assert!(verify_codex(&array, "[[mcp_servers]]\nother = 1\n", &[]).is_ok());
        assert!(verify_codex(&array, "[[mcp_servers]]\nother = 1\n", &want).is_err());
    }
}
