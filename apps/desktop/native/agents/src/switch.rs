//! 切换 memory profile（2.0 `mcp-profile-switch.ts`）：一个小事务，全部客户端同步成功后才提交设置。
//!
//! 只改已经接入 ATM 的位置（还留着任意一个受管 server）；没接入的不替用户装上。某处失败或提交失败，
//! 已改过的逆序回滚。3.0 的回滚按切换前的**原文**放回（文件按字节，Claude Code 按原来那几个条目重新登记），
//! 而不是按旧档位集重写：旧的条目若本来就是另一种启动方式，回滚后仍是那样，不会被顺手改掉。回滚也失败时报
//! `PARTIAL`，界面据此提示有配置没能放回。

use crate::config::{self, claude_code_entries, claude_code_managed, claude_code_replace};
use crate::env::AgentEnv;
use crate::files::{read_text, replace_with_backup};
use crate::{AgentError, Client, Result, Settings, enabled_profiles};
use serde_json::{Value, json};
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Skipped,
    Updated,
    Failed,
    RolledBack,
    RollbackFailed,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Skipped => "SKIPPED",
            Status::Updated => "UPDATED",
            Status::Failed => "FAILED",
            Status::RolledBack => "ROLLED_BACK",
            Status::RollbackFailed => "ROLLBACK_FAILED",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Synced {
    pub client: Client,
    pub target: String,
    pub status: Status,
    pub error: Option<String>,
    pub rollback_status: Option<Status>,
    pub rollback_error: Option<String>,
}

impl Synced {
    fn view(&self) -> Value {
        let mut v = json!({
            "client": self.client.as_str(),
            "target": self.target,
            "status": self.status.as_str(),
        });
        let m = v.as_object_mut().expect("object");
        if let Some(e) = &self.error {
            m.insert("error".into(), json!(e));
        }
        if let Some(s) = self.rollback_status {
            m.insert("rollbackStatus".into(), json!(s.as_str()));
        }
        if let Some(e) = &self.rollback_error {
            m.insert("rollbackError".into(), json!(e));
        }
        v
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Report {
    pub enabled: bool,
    /// `APPLIED` / `FAILED` / `PARTIAL`。
    pub status: &'static str,
    pub clients: Vec<Synced>,
}

impl Report {
    pub fn view(&self) -> Value {
        json!({
            "enabled": self.enabled,
            "status": self.status,
            "restartRequired": true,
            "clients": self.clients.iter().map(Synced::view).collect::<Vec<_>>(),
        })
    }
}

/// 一个要同步的位置与它切换前的样子。
enum Snapshot {
    /// 文件原来的字节（`None` 是原来没有）。
    File(PathBuf, Option<String>),
    /// Claude Code 原来登记的受管条目。
    ClaudeCode(Vec<(String, Value)>),
}

struct Target {
    client: Client,
    label: String,
    present: bool,
    snapshot: Snapshot,
}

fn targets(env: &AgentEnv) -> Vec<Target> {
    let file = |client, label: String, path: PathBuf, present| Target {
        client,
        label,
        present,
        snapshot: Snapshot::File(path.clone(), read_text(&path).ok().flatten()),
    };
    let mut out = vec![file(
        Client::Codex,
        "Codex".into(),
        env.codex_config(),
        config::codex_installed(&env.codex_config()).any(),
    )];
    for p in env.claude_desktop_configs() {
        let present = config::json_installed(&p).any();
        out.push(file(
            Client::Claude,
            format!("Claude Desktop ({})", p.display()),
            p,
            present,
        ));
    }
    let cc = claude_code_managed(&env.claude_code_config());
    out.push(Target {
        client: Client::ClaudeCode,
        label: "Claude Code".into(),
        present: !cc.is_empty(),
        snapshot: Snapshot::ClaudeCode(cc.into_iter().collect()),
    });
    out.push(file(
        Client::KimiCode,
        "Kimi Code".into(),
        env.kimi_config(),
        config::json_installed(&env.kimi_config()).any(),
    ));
    out
}

fn apply(env: &AgentEnv, t: &Target, memory: bool) -> Result<()> {
    let profiles = enabled_profiles(memory);
    match (&t.snapshot, t.client) {
        (Snapshot::File(p, _), Client::Codex) => {
            config::codex_install(p, &env.launch, &profiles).map(drop)
        }
        (Snapshot::File(p, _), Client::Claude) => {
            config::claude_install(p, &env.launch, &profiles).map(drop)
        }
        (Snapshot::File(p, _), Client::KimiCode) => {
            config::kimi_install(p, &env.launch, &profiles).map(drop)
        }
        (Snapshot::ClaudeCode(_), _) => {
            claude_code_replace(env, &claude_code_entries(&env.launch, &profiles)).map(drop)
        }
        (Snapshot::File(..), Client::ClaudeCode) => unreachable!("Claude Code 只走命令行"),
    }
}

fn restore(env: &AgentEnv, t: &Target) -> Result<()> {
    match &t.snapshot {
        Snapshot::File(path, original) => {
            let now = read_text(path).map_err(|e| AgentError::io("AGENT_CONFIG_READ_FAILED", e))?;
            if now == *original {
                return Ok(());
            }
            match original {
                Some(text) => replace_with_backup(path, text.as_bytes()).map(drop),
                // 原来没有这个文件：留一份备份后删掉（切换只改已接入的，正常走不到这里）。
                None => std::fs::rename(path, crate::files::backup_name(path)),
            }
            .map_err(|e| AgentError::io("AGENT_CONFIG_WRITE_FAILED", e))
        }
        Snapshot::ClaudeCode(entries) => claude_code_replace(env, entries).map(drop),
    }
}

/// 失败时的错误带着整份报告（`details.report`）；`message` 以 `MCP_PROFILE_SWITCH_FAILED` / `_PARTIAL` 开头。
pub fn run(
    env: &AgentEnv,
    settings: &dyn Settings,
    principal: &atm_domain::principal::Principal,
    enabled: bool,
    sync_clients: bool,
) -> Result<Report> {
    let list = if sync_clients {
        targets(env)
    } else {
        Vec::new()
    };
    let mut results: Vec<Synced> = list
        .iter()
        .map(|t| Synced {
            client: t.client,
            target: t.label.clone(),
            status: Status::Skipped,
            error: None,
            rollback_status: None,
            rollback_error: None,
        })
        .collect();
    let mut applied: Vec<usize> = Vec::new();

    let rollback = |results: &mut Vec<Synced>, order: &[usize]| -> bool {
        let mut partial = false;
        let mut seen = Vec::new();
        for &i in order {
            if seen.contains(&i) {
                continue;
            }
            seen.push(i);
            let failed_here = results[i].status == Status::Failed;
            match restore(env, &list[i]) {
                Ok(()) => {
                    if failed_here {
                        results[i].rollback_status = Some(Status::RolledBack);
                    } else {
                        results[i].status = Status::RolledBack;
                        results[i].error = None;
                    }
                }
                Err(e) => {
                    partial = true;
                    if failed_here {
                        results[i].rollback_status = Some(Status::RollbackFailed);
                        results[i].rollback_error = Some(e.message);
                    } else {
                        results[i].status = Status::RollbackFailed;
                        results[i].error = Some(e.message);
                    }
                }
            }
        }
        partial
    };

    let fail = |results: Vec<Synced>, partial: bool, cause: &AgentError| -> AgentError {
        let report = Report {
            enabled,
            status: if partial { "PARTIAL" } else { "FAILED" },
            clients: results,
        };
        let code = if partial {
            "MCP_PROFILE_SWITCH_PARTIAL"
        } else {
            "MCP_PROFILE_SWITCH_FAILED"
        };
        let detail = report
            .clients
            .iter()
            .filter(|c| matches!(c.status, Status::Failed | Status::RollbackFailed))
            .map(|c| {
                format!(
                    "{}={}{}",
                    c.target,
                    c.status.as_str(),
                    c.error
                        .as_ref()
                        .map(|e| format!("({e})"))
                        .unwrap_or_default()
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        AgentError::new(
            code,
            format!(
                "{code}: {}{}",
                cause.message,
                if detail.is_empty() {
                    String::new()
                } else {
                    format!("; {detail}")
                }
            ),
        )
        .with_details(json!({ "report": report.view() }))
    };

    for (i, t) in list.iter().enumerate() {
        if !t.present {
            continue;
        }
        match apply(env, t, enabled) {
            Ok(()) => {
                applied.push(i);
                results[i].status = Status::Updated;
            }
            Err(e) => {
                results[i].status = Status::Failed;
                results[i].error = Some(e.message.clone());
                let mut order = vec![i];
                order.extend(applied.iter().rev());
                let partial = rollback(&mut results, &order);
                return Err(fail(results, partial, &e));
            }
        }
    }
    if let Err(e) = settings.commit_memory_profile(principal, enabled) {
        let order: Vec<usize> = applied.iter().rev().copied().collect();
        let partial = rollback(&mut results, &order);
        return Err(fail(results, partial, &e));
    }
    Ok(Report {
        enabled,
        status: "APPLIED",
        clients: results,
    })
}
