//! Call signing for write tools (10 R11 A3): fill what the Agent left out, freeze the
//! result as the call's immutable retry context, and retry transport failures within one
//! 30 s budget.
//!
//! - **Complete explicit calls** (op_id plus, where the tool needs them, session and
//!   project) are forwarded untouched: no resolve, no generation.
//! - Anything else first goes through `POST /mcp/resolve`, which answers from one
//!   read-only snapshot with the effective session, project and branch target. The bridge
//!   fills only what is missing — never overwriting an explicit value — and adds an
//!   `auto:<ULID>` op id when there was none. The bridge never picks a session itself: a
//!   default session can only come from resolve, which only gives one to whitelisted
//!   clients (A1).
//! - Once a write was sent, nothing is resolved again. Refused connections, a restarting
//!   service and `STORE_BUSY` are retried with the same context until the budget runs out.
//! - Out of budget before any write could have arrived: `SERVICE_UNAVAILABLE`, `sent:false`.
//!   Out of budget after a write may have arrived: `RESULT_UNKNOWN`, `committed:"unknown"`,
//!   with the full context in `fix.call`, so a retry replays instead of acting twice.

use crate::descriptor::{self, Runtime, RuntimeError};
use crate::{http, json, process, ulid};
use serde_json::{Map, Value, json};
use std::time::{Duration, Instant};

/// From the moment the Agent's call arrives (A3: resolve and transport retries share it).
pub const BUDGET: Duration = Duration::from_secs(30);
const POLL: Duration = Duration::from_millis(100);
const BUSY_PAUSE: Duration = Duration::from_millis(250);

/// The write tools of surface v6. Everything else is a read and is forwarded as is.
pub const WRITE_TOOLS: &[&str] = &[
    "atm_begin",
    "atm_end",
    "atm_task_create",
    "atm_task_patch",
    "atm_progress_add",
    "atm_record",
    "atm_feedback",
    "atm_knowledge_save",
];

/// What the bridge needs to talk to the service.
pub struct Link<'a> {
    pub path: &'a str,
    /// `X-ATM-Client`, when an ancestor could be identified.
    pub client: Option<&'a str>,
}

fn has(args: &Map<String, Value>, names: &[&str]) -> bool {
    names.iter().any(|n| {
        args.get(*n)
            .and_then(Value::as_str)
            .is_some_and(|s| !json::js_trim(s).is_empty())
    })
}

/// All applicable fields are explicit (A3 「完整显式调用」): begin needs only op_id; the
/// knowledge write's target is the knowledge base, so it needs session and op_id; every
/// other write also names its project.
pub fn complete(tool: &str, args: &Map<String, Value>) -> bool {
    has(args, &["op_id"])
        && (tool == "atm_begin"
            || (has(args, &["session", "session_id"])
                && (tool == "atm_knowledge_save" || has(args, &["project", "project_code"]))))
}

enum Outcome {
    /// A reply line to hand back to the Agent.
    Reply(String),
    /// Retry within the budget.
    Again,
}

/// Waits until the budget runs out for a usable descriptor, waking the desktop once.
fn runtime(
    deadline: Instant,
    stale: Option<&Runtime>,
    woken: &mut bool,
) -> Result<Runtime, String> {
    loop {
        let attempt = descriptor::load().and_then(|current| {
            if stale.is_some_and(|old| old.instance_id == current.instance_id)
                || !process::pid_alive(current.pid)
            {
                return Err(RuntimeError::NotReady);
            }
            Ok(current)
        });
        match attempt {
            Ok(current) => return Ok(current),
            Err(RuntimeError::DescriptorInvalid) => {
                return Err("ATM_RUNTIME_DESCRIPTOR_INVALID".to_owned());
            }
            Err(RuntimeError::NotReady) => {
                if !*woken {
                    *woken = true;
                    process::wake_desktop();
                }
                if let Some(reason) = descriptor::source_conflict() {
                    return Err(format!("ATM_SOURCE_CONFLICT: {reason}"));
                }
                if Instant::now() >= deadline {
                    return Err("ATM_RUNTIME_UNAVAILABLE".to_owned());
                }
                std::thread::sleep(POLL);
            }
        }
    }
}

/// A tool error result carrying an envelope, as `tools/call` would return it.
pub fn tool_error(id: &str, envelope: &Value) -> String {
    let mut text = format!(
        "{}: {}",
        envelope["code"].as_str().unwrap_or_default(),
        envelope["message"].as_str().unwrap_or_default()
    );
    text.push_str("\nfix: ");
    text.push_str(&envelope["fix"].to_string());
    let result = json!({
        "content": [{"type": "text", "text": text}],
        "structuredContent": envelope,
        "isError": true,
    });
    format!(r#"{{"jsonrpc":"2.0","id":{id},"result":{result}}}"#)
}

fn envelope(code: &str, message: &str, committed: Value, fix: Value, details: Value) -> Value {
    json!({
        "ok": false,
        "code": code,
        "message": message,
        "retryable": true,
        "committed": committed,
        "fix": fix,
        "details": details,
    })
}

/// Signs and sends one `tools/call` of a write tool. Returns the reply line.
pub fn call(link: &Link<'_>, message: &Value) -> String {
    let started = Instant::now();
    let deadline = started + BUDGET;
    let id = json::request_id(message);
    let params = &message["params"];
    let tool = params["name"].as_str().unwrap_or_default().to_owned();
    let original: Map<String, Value> = params["arguments"].as_object().cloned().unwrap_or_default();
    let explicit_op = has(&original, &["op_id"]);
    let mut woken = false;

    // ---- the retry context
    let mut context = original.clone();
    if !complete(&tool, &original) {
        let body = json!({"tool": tool, "arguments": original}).to_string();
        let resolved = loop {
            let reason = match resolve(link, &body, deadline, &mut woken) {
                Ok(Resolve::Done(v)) => break v,
                Ok(Resolve::Refused(envelope)) => return tool_error(&id, &envelope),
                Ok(Resolve::Busy) if Instant::now() < deadline => {
                    std::thread::sleep(BUSY_PAUSE);
                    continue;
                }
                Ok(Resolve::Busy) => "STORE_BUSY".to_owned(),
                Err(reason) => reason,
            };
            // A3: nothing was sent; the original call, unchanged, is a fresh signing.
            return tool_error(
                &id,
                &envelope(
                    "SERVICE_UNAVAILABLE",
                    &unavailable_message(&reason),
                    if explicit_op {
                        json!("unknown")
                    } else {
                        json!(false)
                    },
                    json!({"kind": "call", "call": {"name": tool, "arguments": original},
                                   "why": "这次调用没有发出：服务可用之后原样重发"}),
                    json!({"sent": false, "reason": reason}),
                ),
            );
        };
        fill(&tool, &mut context, &resolved);
        if !explicit_op {
            match ulid::new() {
                Some(u) => {
                    context.insert("op_id".into(), json!(format!("auto:{u}")));
                }
                None => {
                    return tool_error(
                        &id,
                        &envelope(
                            "SERVICE_UNAVAILABLE",
                            "系统随机数不可用，没法签发 op_id：带上自己的 op_id 重试",
                            json!(false),
                            json!({"kind": "add_param", "tool": tool, "param": "op_id",
                                   "why": "带上自己的 op_id 重试"}),
                            json!({"sent": false}),
                        ),
                    );
                }
            }
        }
    }

    // ---- send with the frozen context
    let mut sent = message.clone();
    sent["params"]["arguments"] = Value::Object(context.clone());
    let body = sent.to_string();
    let mut maybe_delivered = false;
    let mut last_busy: Option<String> = None;
    let mut stale: Option<Runtime> = None;
    let mut reason = "ATM_RUNTIME_UNAVAILABLE".to_owned();
    loop {
        if Instant::now() >= deadline {
            break;
        }
        let current = match runtime(deadline, stale.as_ref(), &mut woken) {
            Ok(r) => r,
            Err(r) => {
                reason = r;
                break;
            }
        };
        match http::post(current.port, link.path, &current.token, &body, link.client) {
            Err(http::Error::Refused) => {
                // Provably never delivered: wait for a newly published instance.
                stale = Some(current);
            }
            Err(_) => {
                // The request may have reached the service; only a replay can tell.
                maybe_delivered = true;
                last_busy = None;
                stale = None;
                std::thread::sleep(POLL);
            }
            Ok(response) => match answer(&response) {
                Outcome::Reply(line) => return line,
                Outcome::Again => {
                    // STORE_BUSY: this attempt did not execute.
                    last_busy = Some(json::compact(&String::from_utf8_lossy(&response.body)));
                    std::thread::sleep(BUSY_PAUSE);
                }
            },
        }
    }
    let call = json!({"name": tool, "arguments": context});
    if maybe_delivered {
        return tool_error(
            &id,
            &envelope(
                "RESULT_UNKNOWN",
                "这次写入发出过，但没能确认结果：照 fix.call 原样重试（同一个 op_id 会重放，不会重复执行）",
                json!("unknown"),
                json!({"kind": "call", "call": call,
                       "why": "带着完整上下文原样重试：已经提交就重放，没有提交就执行一次"}),
                json!({"sent": true}),
            ),
        );
    }
    if let Some(line) = last_busy {
        // Every delivered attempt was refused for load: nothing executed.
        return line;
    }
    tool_error(
        &id,
        &envelope(
            "SERVICE_UNAVAILABLE",
            &unavailable_message(&reason),
            if explicit_op {
                json!("unknown")
            } else {
                json!(false)
            },
            json!({"kind": "call", "call": call, "why": "这次写入没有送达：服务可用之后原样重发"}),
            json!({"sent": false, "reason": reason}),
        ),
    )
}

fn unavailable_message(reason: &str) -> String {
    if let Some(r) = reason.strip_prefix("ATM_SOURCE_CONFLICT: ") {
        format!("ATM 正在等用户在窗口里选择数据来源（{r}）：请用户打开 ATM 窗口处理，之后原样重发")
    } else {
        format!("ATM 服务暂时不可用（{reason}）：稍后原样重发")
    }
}

/// The service's reply to the signed call: a STORE_BUSY tool error is retried; anything
/// else goes back to the Agent unchanged.
fn answer(response: &http::Response) -> Outcome {
    if response.status == 202 || response.status == 204 {
        return Outcome::Reply(String::new());
    }
    let text = String::from_utf8_lossy(&response.body);
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return Outcome::Reply(json::error_line(
            -32000,
            &format!(
                "invalid JSON response: {}",
                text.chars().take(200).collect::<String>()
            ),
            "null",
        ));
    };
    let content = &v["result"]["structuredContent"];
    if v["result"]["isError"] == json!(true) && content["code"] == json!("STORE_BUSY") {
        return Outcome::Again;
    }
    Outcome::Reply(json::compact(&text))
}

enum Resolve {
    Done(Value),
    /// A business error from the service (for example SESSION_REQUIRED): reported as is.
    Refused(Value),
    Busy,
}

/// One resolve attempt, waiting for the runtime within the deadline.
fn resolve(
    link: &Link<'_>,
    body: &str,
    deadline: Instant,
    woken: &mut bool,
) -> Result<Resolve, String> {
    let mut stale = None;
    loop {
        let current = runtime(deadline, stale.as_ref(), woken)?;
        match http::post(
            current.port,
            "/mcp/resolve",
            &current.token,
            body,
            link.client,
        ) {
            Err(http::Error::Refused) => stale = Some(current),
            // Resolve is read-only: any transport failure is simply tried again.
            Err(_) => {
                if Instant::now() >= deadline {
                    return Err("ATM_RUNTIME_UNAVAILABLE".to_owned());
                }
                std::thread::sleep(POLL);
            }
            Ok(response) => {
                let v: Value = serde_json::from_slice(&response.body)
                    .map_err(|_| "invalid resolve response".to_owned())?;
                return Ok(match response.status {
                    200 if v.get("expected_target").is_some() => Resolve::Done(v),
                    _ if matches!(
                        v["code"].as_str(),
                        Some("STORE_BUSY" | "SERVICE_UNAVAILABLE")
                    ) =>
                    {
                        Resolve::Busy
                    }
                    _ => Resolve::Refused(v),
                });
            }
        }
    }
}

/// Fills the context from resolve: only what is missing, never overwriting what the Agent
/// gave. begin's selectors (project, cwd) are the Agent's input and are never filled.
fn fill(tool: &str, context: &mut Map<String, Value>, resolved: &Value) {
    let begin = tool == "atm_begin";
    if !begin
        && !has(context, &["session", "session_id"])
        && let Some(s) = resolved["session"].as_str()
    {
        context.insert("session".into(), json!(s));
    }
    if !begin
        && !has(context, &["project", "project_code"])
        && let Some(p) = resolved["project"].as_str()
    {
        context.insert("project".into(), json!(p));
    }
    if !context.contains_key("expected_target") {
        context.insert(
            "expected_target".into(),
            resolved["expected_target"].clone(),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn only_fully_explicit_calls_skip_resolve() {
        assert!(complete("atm_begin", &args(json!({"op_id": "x"}))));
        assert!(!complete("atm_begin", &args(json!({"agent_id": "a"}))));
        assert!(complete(
            "atm_task_patch",
            &args(json!({"op_id": "x", "session": "S", "project": "P"}))
        ));
        assert!(complete(
            "atm_record",
            &args(json!({"op_id": "x", "session_id": "S", "project_code": "P"}))
        ));
        assert!(!complete(
            "atm_task_patch",
            &args(json!({"op_id": "x", "session": "S"}))
        ));
        assert!(!complete(
            "atm_task_patch",
            &args(json!({"op_id": " ", "session": "S", "project": "P"}))
        ));
        assert!(complete(
            "atm_knowledge_save",
            &args(json!({"op_id": "x", "session": "S"}))
        ));
    }

    #[test]
    fn filling_never_overwrites_and_never_fills_begin_selectors() {
        let resolved = json!({"session": "S1", "project": "ATM",
                              "expected_target": {"kind": "EXISTING", "scope": {"kind": "PROJECT", "id": "PA"}, "generation": 1}});
        let mut c = args(json!({"session_id": "S9"}));
        fill("atm_progress_add", &mut c, &resolved);
        assert_eq!(c.get("session"), None);
        assert_eq!(c["project"], json!("ATM"));
        assert_eq!(c["expected_target"]["kind"], json!("EXISTING"));
        let mut b = args(json!({"agent_id": "a"}));
        fill("atm_begin", &mut b, &resolved);
        assert!(!b.contains_key("session") && !b.contains_key("project"));
        let mut kept = args(json!({"expected_target": {"kind": "NONE"}}));
        fill("atm_record", &mut kept, &resolved);
        assert_eq!(kept["expected_target"], json!({"kind": "NONE"}));
    }
}
