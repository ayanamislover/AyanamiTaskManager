//! 全局规则块（2.0 `agent-config/src/agent-rules.ts`）：在 `AGENTS.md` / `CLAUDE.md` 里维护一段带标记、版本与哈希的
//! ATM 说明，块外的内容原样保留。写出的字节与 2.0 相同，2.0 装进去的块在 3.0 里仍是「已安装」。

use crate::files::{read_text, replace_with_backup};
use crate::{AgentError, Result};
use atm_domain::text::is_js_whitespace;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const INTEGRATION_VERSION: u32 = 1;

pub const AGENT_RULE_SNIPPET: &str = "执行项目前先访问 ATM 工具，并阅读 %LOCALAPPDATA%\\AyanamiTaskManager\\ATM_AGENT_GUIDE.md；后续所有任务执行均依赖 ATM。受管开发任务开始实现前必须按可交付结果和可验证验收拆分成可独立验收的工作项。";

const BEGIN: &str = "<!-- AYANAMI_TASK_MANAGER:BEGIN -->";
const END: &str = "<!-- AYANAMI_TASK_MANAGER:END -->";
const PAYLOAD: &str = "## AyanamiTaskManager

- ATM 是受管开发项目的计划、任务状态、长期记录和 Session 交接事实源。
- 复杂任务形成执行计划后，必须把可独立交付/验证的主要步骤同步为 ATM WorkItem，不能只登记最高层目标。
- 实际执行优先领取 READY 的叶子 WorkItem；Objective / Milestone / EPIC 用于表达目标和范围。
- 开工使用一次 `atm_begin` 并直接使用其 brief；不要紧接 `atm_brief`。
- 仅在有意义状态变化时写 progress；长期决策/事实/风险写 record。
- 上下文恢复优先 ATM brief / delta，不重新扫描整个项目历史。
- 完整规则见 `%LOCALAPPDATA%\\AyanamiTaskManager\\ATM_AGENT_GUIDE.md`。";

/// 规则块、Skill 与整个接入的状态（2.0 `AgentIntegrationState`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    NotInstalled,
    Installed,
    NeedsUpdate,
    Modified,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::NotInstalled => "NOT_INSTALLED",
            State::Installed => "INSTALLED",
            State::NeedsUpdate => "NEEDS_UPDATE",
            State::Modified => "MODIFIED",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Preview,
    Install,
    Update,
    Repair,
    Uninstall,
}

impl Action {
    pub fn parse(s: &str) -> Result<Action> {
        Ok(match s {
            "PREVIEW" => Action::Preview,
            "INSTALL" => Action::Install,
            "UPDATE" => Action::Update,
            "REPAIR" => Action::Repair,
            "UNINSTALL" => Action::Uninstall,
            other => {
                return Err(AgentError::new(
                    "AGENT_RULE_ACTION_UNSUPPORTED",
                    format!("不支持的操作：{other}"),
                ));
            }
        })
    }
}

fn hash(version: u32, payload: &str) -> String {
    crate::files::hex(&Sha256::digest(format!("{version}\n{payload}").as_bytes()))
}

pub fn render() -> String {
    format!(
        "{BEGIN}\n<!-- ATM-INTEGRATION-VERSION: {INTEGRATION_VERSION} -->\n<!-- ATM-INTEGRATION-HASH: {} -->\n\n{PAYLOAD}\n{END}",
        hash(INTEGRATION_VERSION, PAYLOAD)
    )
}

/// 块所在的字节区间。只有结束标记、或结束标记在开始之前，都按「从开始（或文件头）到文件尾」算（2.0 同）。
fn range(content: &str) -> Option<(usize, usize)> {
    let start = content.find(BEGIN);
    let from = start.unwrap_or(0);
    let end = content[from..].find(END).map(|i| i + from);
    match (start, end) {
        (None, None) => None,
        (Some(s), Some(e)) => Some((s, e + END.len())),
        (s, _) => Some((s.unwrap_or(0), content.len())),
    }
}

fn without(content: &str) -> String {
    let Some((s, e)) = range(content) else {
        return content.to_string();
    };
    let before = content[..s].trim_end_matches(is_js_whitespace);
    let after = content[e..].trim_start_matches(is_js_whitespace);
    let remaining = [before, after]
        .into_iter()
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    if remaining.is_empty() {
        String::new()
    } else {
        format!("{remaining}\n")
    }
}

fn with(content: &str) -> String {
    let base = without(content);
    let base = base.trim_end_matches(is_js_whitespace);
    format!(
        "{base}{}{}\n",
        if base.is_empty() { "" } else { "\n\n" },
        render()
    )
}

fn marker_value<'a>(block: &'a str, prefix: &str) -> Option<(&'a str, usize)> {
    let at = block.find(prefix)?;
    let rest = &block[at + prefix.len()..];
    let close = rest.find(" -->")?;
    Some((&rest[..close], at + prefix.len() + close + " -->".len()))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Inspection {
    pub state: State,
    pub path: PathBuf,
    pub version: Option<u32>,
}

pub fn inspect(path: &Path) -> Inspection {
    let content = read_text(path).ok().flatten().unwrap_or_default();
    inspect_content(path, &content)
}

fn inspect_content(path: &Path, content: &str) -> Inspection {
    let done = |state, version| Inspection {
        state,
        path: path.into(),
        version,
    };
    let Some((s, e)) = range(content) else {
        return done(State::NotInstalled, None);
    };
    let block = &content[s..e];
    let version = marker_value(block, "<!-- ATM-INTEGRATION-VERSION: ")
        .filter(|(v, _)| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|(v, _)| v.parse::<u32>().ok());
    let hash_marker = marker_value(block, "<!-- ATM-INTEGRATION-HASH: ").filter(|(h, _)| {
        h.len() == 64 && h.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    });
    let (Some(v), Some((h, payload_start))) = (version, hash_marker) else {
        return done(State::Modified, version);
    };
    let payload_end = block.rfind(END).unwrap_or(block.len()).max(payload_start);
    let payload = atm_domain::text::js_trim(&block[payload_start..payload_end]);
    if h != hash(v, payload) {
        return done(State::Modified, Some(v));
    }
    if v != INTEGRATION_VERSION {
        return done(State::NeedsUpdate, Some(v));
    }
    done(
        if block == render() {
            State::Installed
        } else {
            State::Modified
        },
        Some(v),
    )
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Managed {
    pub state: State,
    pub path: PathBuf,
    pub version: Option<u32>,
    pub backup: Option<PathBuf>,
    pub current: String,
    pub proposed: String,
}

/// 2.0 `manageAgentRule`：用户改过的块只有 REPAIR / UNINSTALL 能动；装着旧版本时 INSTALL 要求显式 UPDATE。
pub fn manage(path: &Path, action: Action) -> Result<Managed> {
    let current = read_text(path)
        .map_err(|e| AgentError::io("AGENT_RULE_READ_FAILED", e))?
        .unwrap_or_default();
    let inspected = inspect_content(path, &current);
    let proposed = if action == Action::Uninstall {
        without(&current)
    } else {
        with(&current)
    };
    let result = |i: Inspection, backup, proposed| Managed {
        state: i.state,
        path: i.path,
        version: i.version,
        backup,
        current: current.clone(),
        proposed,
    };
    if action == Action::Preview {
        return Ok(result(inspected, None, proposed));
    }
    if inspected.state == State::Modified && !matches!(action, Action::Repair | Action::Uninstall) {
        return Err(AgentError::new(
            "AGENT_RULE_MODIFIED_REQUIRES_REPAIR",
            "规则块被改过，需要修复",
        ));
    }
    if action == Action::Update && inspected.state == State::Installed {
        let same = current.clone();
        return Ok(result(inspected, None, same));
    }
    if action == Action::Install && inspected.state == State::NeedsUpdate {
        return Err(AgentError::new(
            "AGENT_RULE_NEEDS_EXPLICIT_UPDATE",
            "规则块是旧版本，需要更新",
        ));
    }
    if current == proposed {
        return Ok(result(inspected, None, proposed));
    }
    let backup = replace_with_backup(path, proposed.as_bytes())
        .map_err(|e| AgentError::io("AGENT_RULE_WRITE_FAILED", e))?;
    Ok(result(inspect(path), backup, proposed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_block_and_its_hash_match_2x() {
        // 2.0 renderManagedAgentRule() 的哈希（node -e 算出的固定值，见 tests/agents.rs 的字节对照）。
        let r = render();
        assert!(r.starts_with(BEGIN) && r.ends_with(END));
        assert_eq!(hash(1, PAYLOAD).len(), 64);
        let p = Path::new("x");
        assert_eq!(
            inspect_content(p, &format!("a\n\n{r}\n")).state,
            State::Installed
        );
        assert_eq!(
            inspect_content(p, &r.replace("WorkItem", "Work")).state,
            State::Modified
        );
        assert_eq!(inspect_content(p, "").state, State::NotInstalled);
        assert_eq!(with("keep\n"), format!("keep\n\n{r}\n"));
        assert_eq!(without(&format!("keep\n\n{r}\n\ntail")), "keep\n\ntail\n");
        assert_eq!(without(&format!("{r}\n")), "");
    }
}
