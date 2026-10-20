//! 派单历史的一条（2.x `run-store.ts` + `types.ts` 的 `DispatchRunRecord`）：对外视图 + 只供本机跟踪进程用的字段。
//! 库里是 `dispatch_runs` 的一行；历史与日志都只留最近 50 次，排队中与运行中的永远保留。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::outcome::Summary;

/// 历史与日志都只留最近这么多次。
pub const HISTORY_LIMIT: usize = 50;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Queued => "queued",
            State::Running => "running",
            State::Succeeded => "succeeded",
            State::Failed => "failed",
            State::Cancelled => "cancelled",
        }
    }

    pub fn parse(s: &str) -> Option<State> {
        Some(match s {
            "queued" => State::Queued,
            "running" => State::Running,
            "succeeded" => State::Succeeded,
            "failed" => State::Failed,
            "cancelled" => State::Cancelled,
            _ => return None,
        })
    }

    pub fn active(self) -> bool {
        matches!(self, State::Queued | State::Running)
    }
}

/// 2.x 的 `exitCode` 有三态：没有这个键、`null`（被信号结束）、整数。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExitCode {
    Unset,
    Null,
    Code(i64),
}

/// 库里的一行（服务层不解释内容）。`log_root`：`LEGACY` 是转换时还在跑的会话，日志留在 2.x 的数据根里。
pub use atm_service::dispatch_state::RunRow as RawRun;

#[derive(Clone, Debug, PartialEq)]
pub struct Record {
    pub run: String,
    pub project: String,
    pub key: String,
    pub title: String,
    /// R5：任务的实体 id（不可复用）。转换来的、解析不到的为空。
    pub task_id: Option<String>,
    pub mobile: bool,
    pub state: State,
    /// 固定并持久化的 Claude 会话 ID：事后可以 `claude -r <sessionId>` 接着对话。
    pub session_id: String,
    pub created_at: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub exit_code: ExitCode,
    pub summary: Option<Summary>,
    pub error: Option<String>,
    pub cwd: String,
    pub requested_by: Option<String>,
    pub pid: Option<u32>,
    /// 进程出生标识 `win32:<FILETIME>`；查不到就没有（身份未知，重启后不接管）。
    pub process_identity: Option<String>,
    /// 手机命令 ID：账本缺了这条时据此补回。
    pub request_id: Option<String>,
    pub legacy_logs: bool,
}

impl Record {
    /// 读库里的一行；不合法（状态、来源不认识，摘要坏了）是 `None`，由调用方丢弃并记日志。
    pub fn from_raw(r: &RawRun) -> Option<Record> {
        let summary = match &r.summary_json {
            None => None,
            Some(s) => Some(Summary::from_json(&serde_json::from_str(s).ok()?)?),
        };
        Some(Record {
            run: r.run.clone(),
            project: r.project_code.clone(),
            key: r.task_key.clone(),
            title: r.title.clone(),
            task_id: r.task_id.clone(),
            mobile: match r.origin.as_str() {
                "mobile" => true,
                "desktop" => false,
                _ => return None,
            },
            // 3.0 的表允许 interrupted，派单器自己从不写它（手机协议只有五种状态）。
            state: State::parse(&r.state)?,
            session_id: r.session_id.clone(),
            created_at: r.created_at.clone(),
            started_at: r.started_at.clone(),
            ended_at: r.ended_at.clone(),
            exit_code: match (r.exit_code_set, r.exit_code) {
                (false, _) => ExitCode::Unset,
                (true, None) => ExitCode::Null,
                (true, Some(c)) => ExitCode::Code(c),
            },
            summary,
            error: r.error.clone(),
            cwd: r.cwd.clone(),
            requested_by: r.requested_by.clone(),
            pid: r.pid.and_then(|p| u32::try_from(p).ok()).filter(|p| *p > 0),
            process_identity: r.process_identity.clone().filter(|s| !s.is_empty()),
            request_id: r.request_id.clone(),
            legacy_logs: r.log_root == "LEGACY",
        })
    }

    pub fn to_raw(&self) -> RawRun {
        RawRun {
            run: self.run.clone(),
            project_code: self.project.clone(),
            task_key: self.key.clone(),
            title: self.title.clone(),
            task_id: self.task_id.clone(),
            origin: if self.mobile { "mobile" } else { "desktop" }.into(),
            state: self.state.as_str().into(),
            session_id: self.session_id.clone(),
            created_at: self.created_at.clone(),
            started_at: self.started_at.clone(),
            ended_at: self.ended_at.clone(),
            exit_code: match self.exit_code {
                ExitCode::Code(c) => Some(c),
                _ => None,
            },
            exit_code_set: self.exit_code != ExitCode::Unset,
            summary_json: self.summary.as_ref().map(|s| s.to_json().to_string()),
            error: self.error.clone(),
            cwd: self.cwd.clone(),
            requested_by: self.requested_by.clone(),
            pid: self.pid.map(i64::from),
            process_identity: self.process_identity.clone(),
            request_id: self.request_id.clone(),
            log_root: if self.legacy_logs {
                "LEGACY"
            } else {
                "CURRENT"
            }
            .into(),
        }
    }

    /// 对外视图（2.x `toRunView`）：去掉 cwd / requestedBy / pid / processIdentity / requestId。
    /// 3.0 另带 `taskId`（R5 的双重绑定）。
    pub fn view(&self) -> Map<String, Value> {
        let mut v = Map::new();
        v.insert("run".into(), json!(self.run));
        v.insert("project".into(), json!(self.project));
        v.insert("key".into(), json!(self.key));
        v.insert("title".into(), json!(self.title));
        v.insert(
            "origin".into(),
            json!(if self.mobile { "mobile" } else { "desktop" }),
        );
        v.insert("state".into(), json!(self.state.as_str()));
        v.insert("sessionId".into(), json!(self.session_id));
        v.insert("createdAt".into(), json!(self.created_at));
        if let Some(s) = &self.started_at {
            v.insert("startedAt".into(), json!(s));
        }
        if let Some(s) = &self.ended_at {
            v.insert("endedAt".into(), json!(s));
        }
        match self.exit_code {
            ExitCode::Unset => {}
            ExitCode::Null => {
                v.insert("exitCode".into(), Value::Null);
            }
            ExitCode::Code(c) => {
                v.insert("exitCode".into(), json!(c));
            }
        }
        if let Some(s) = &self.summary {
            v.insert("summary".into(), s.to_json());
        }
        if let Some(e) = &self.error {
            v.insert("error".into(), json!(e));
        }
        if let Some(id) = &self.task_id {
            v.insert("taskId".into(), json!(id));
        }
        v
    }

    /// 账本里留的最小快照（2.x `snapshotOf`）：对外视图去掉摘要。
    pub fn snapshot(&self) -> Map<String, Value> {
        let mut v = self.view();
        v.remove("summary");
        v
    }

    /// 状态最近一次变化的时间（手机卡片上的 `at`）。
    pub fn at(&self) -> &str {
        self.ended_at
            .as_deref()
            .or(self.started_at.as_deref())
            .unwrap_or(&self.created_at)
    }
}

/// 历史只留最近 [`HISTORY_LIMIT`] 条；排队中与运行中的永远保留。`runs` 按创建时间升序，返回被裁掉的。
pub fn trim(runs: &mut Vec<Record>) -> Vec<Record> {
    if runs.len() <= HISTORY_LIMIT {
        return Vec::new();
    }
    let mut budget = HISTORY_LIMIT.saturating_sub(runs.iter().filter(|r| r.state.active()).count());
    let mut keep = vec![false; runs.len()];
    for i in (0..runs.len()).rev() {
        if runs[i].state.active() {
            keep[i] = true;
        } else if budget > 0 {
            keep[i] = true;
            budget -= 1;
        }
    }
    let mut dropped = Vec::new();
    let mut kept = Vec::new();
    for (r, k) in std::mem::take(runs).into_iter().zip(keep) {
        if k { kept.push(r) } else { dropped.push(r) }
    }
    *runs = kept;
    dropped
}

/// 日志文件名 `<run>.jsonl` / `<run>.stderr.log` 里的派单编号。
fn log_run(name: &str) -> Option<&str> {
    name.strip_suffix(".jsonl")
        .or_else(|| name.strip_suffix(".stderr.log"))
        .filter(|r| !r.is_empty())
}

pub fn stdout_log(dir: &Path, run: &str) -> PathBuf {
    dir.join(format!("{run}.jsonl"))
}

pub fn stderr_log(dir: &Path, run: &str) -> PathBuf {
    dir.join(format!("{run}.stderr.log"))
}

/// 删掉不属于保留历史的日志文件，日志目录因此也只留最近 50 次。只清本数据根的日志目录：2.x 数据根只读。
pub fn prune_logs(dir: &Path, keep: &HashSet<String>) -> Vec<(String, String)> {
    let mut failures = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return failures;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(run) = log_run(&name) else {
            continue;
        };
        if keep.contains(run) || !e.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        if let Err(err) = std::fs::remove_file(e.path()) {
            failures.push((name, err.to_string()));
        }
    }
    failures
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn record(run: &str, state: State) -> Record {
        Record {
            run: run.into(),
            project: "ATM".into(),
            key: "ATM-T-0001".into(),
            title: "t".into(),
            task_id: None,
            mobile: false,
            state,
            session_id: "s".into(),
            created_at: "2026-10-10T00:00:00.000Z".into(),
            started_at: None,
            ended_at: None,
            exit_code: ExitCode::Unset,
            summary: None,
            error: None,
            cwd: "C:\\p".into(),
            requested_by: None,
            pid: None,
            process_identity: None,
            request_id: None,
            legacy_logs: false,
        }
    }

    #[test]
    fn a_row_round_trips_and_the_view_hides_local_fields() {
        let mut r = record("r1", State::Failed);
        r.exit_code = ExitCode::Null;
        r.pid = Some(42);
        r.process_identity = Some("win32:1".into());
        r.request_id = Some("req".into());
        r.requested_by = Some("Pixel".into());
        r.task_id = Some("01TASK".into());
        r.summary = Some(Summary {
            num_turns: Some(2.into()),
            duration_ms: None,
            total_cost_usd: None,
            result: "x".into(),
        });
        let raw = r.to_raw();
        assert!(raw.exit_code_set && raw.exit_code.is_none());
        assert_eq!(Record::from_raw(&raw).unwrap(), r);
        let v = r.view();
        for hidden in ["cwd", "requestedBy", "pid", "processIdentity", "requestId"] {
            assert!(!v.contains_key(hidden), "{hidden}");
        }
        assert_eq!(v["exitCode"], Value::Null);
        assert_eq!(v["taskId"], "01TASK");
        assert!(r.snapshot().get("summary").is_none());
        let mut bad = raw.clone();
        bad.state = "interrupted".into();
        assert_eq!(Record::from_raw(&bad), None);
        let mut bad = raw;
        bad.summary_json = Some("{}".into());
        assert_eq!(Record::from_raw(&bad), None);
    }

    #[test]
    fn history_keeps_the_latest_fifty_and_every_active_run() {
        let mut runs: Vec<Record> = (0..60)
            .map(|i| {
                record(
                    &format!("r{i:02}"),
                    if i == 3 {
                        State::Running
                    } else {
                        State::Succeeded
                    },
                )
            })
            .collect();
        let dropped = trim(&mut runs);
        assert_eq!(runs.len(), 50);
        assert_eq!(dropped.len(), 10);
        assert!(runs.iter().any(|r| r.run == "r03"));
        assert_eq!(runs[1].run, "r11");
        assert_eq!(runs.last().unwrap().run, "r59");
    }
}
