//! AyanamiTaskManager 3 MCP stdio bridge (surface v6).
//!
//! Reads one JSON-RPC message per line from stdin, POSTs it to the profile endpoint of the
//! service found through `runtime/daemon.json` under the 3.0 data root, and writes the reply
//! back as one line. On top of plain forwarding (10 R11):
//! - `--profile core|memory|actions` is required. 3.0 has no legacy all-tools endpoint; a
//!   configuration without a profile is stale and must be reinstalled.
//! - Every request carries `X-ATM-Client: <pid>:<created>@<clientInfo.name>` (A4), so the
//!   service can group the profiles of one Agent instance and see whether it still runs.
//! - `tools/call` of a write tool is signed (A3, [`sign`]): missing session / project /
//!   op_id are filled from `POST /mcp/resolve`, and transport failures are retried with
//!   the same context within 30 s, ending in `RESULT_UNKNOWN` when the outcome stays open.
//! - When the host waits for the user to choose a data source (`startup-state.json`,
//!   07 §7), requests fail at once with that reason instead of waiting out a timeout.
//!
//! Framing details kept from the 2.x bridge: a bare CR also ends a line, blank lines are
//! skipped, a numeric request id is echoed verbatim, response bodies above 64 MiB are
//! refused, and a non-JSON body is reported as `invalid JSON response: …`.

mod descriptor;
mod http;
mod identity;
mod json;
mod process;
mod sign;
mod ulid;

use descriptor::{Runtime, RuntimeError};
use serde_json::Value;
use std::io::{self, BufRead, Write};
use std::time::{Duration, Instant};

const WAIT_FOR_RUNTIME: Duration = Duration::from_secs(45);
const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Per-process state: the profile route and the client identity once `initialize` named it.
struct Bridge {
    path: &'static str,
    client_name: Option<String>,
    client: Option<String>,
}

impl Bridge {
    fn header(&mut self) -> Option<&str> {
        if self.client.is_none() {
            self.client = identity::header(self.client_name.as_deref());
        }
        self.client.as_deref()
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let path = match mcp_path(&args) {
        Ok(path) => path,
        Err(message) => {
            eprintln!("Error: {message}");
            std::process::exit(1);
        }
    };
    let mut bridge = Bridge {
        path,
        client_name: None,
        client: None,
    };
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let stdout = io::stdout();
    let mut output = stdout.lock();
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        match input.read_until(b'\n', &mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if buffer.last() == Some(&b'\n') {
            buffer.pop();
        }
        let chunk = String::from_utf8_lossy(&buffer);
        // A bare CR also ends a line, and "\r\n" leaves an empty piece that the blank-line
        // check below drops.
        for line in chunk.split('\r') {
            if json::js_trim(line).is_empty() {
                continue;
            }
            if handle(line, &mut bridge, &mut output).is_err() {
                // The client closed our stdout; nobody is left to answer.
                return;
            }
        }
    }
}

/// 3.0 requires an explicit static profile (06 #97: the legacy all-tools endpoint is gone).
fn mcp_path(args: &[String]) -> Result<&'static str, String> {
    let Some(index) = args.iter().position(|arg| arg == "--profile") else {
        return Err(
            "MCP_PROFILE_REQUIRED: atm-mcp.exe needs --profile core, memory or actions; \
             this MCP configuration predates ATM 3, reinstall it from the ATM window"
                .to_owned(),
        );
    };
    match args.get(index + 1).map(String::as_str) {
        Some("core") => Ok("/mcp/core"),
        Some("memory") => Ok("/mcp/memory"),
        Some("actions") => Ok("/mcp/actions"),
        _ => Err("MCP_PROFILE_INVALID: expected core, memory or actions".to_owned()),
    }
}

fn handle(line: &str, bridge: &mut Bridge, output: &mut impl Write) -> io::Result<()> {
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        return emit(output, json::PARSE_ERROR_LINE);
    };
    if message["method"] == "initialize"
        && let Some(name) = message["params"]["clientInfo"]["name"].as_str()
    {
        bridge.client_name = Some(name.to_owned());
        bridge.client = None;
    }
    let write_call = message["method"] == "tools/call"
        && message["params"]["name"]
            .as_str()
            .is_some_and(|tool| sign::WRITE_TOOLS.contains(&tool))
        && message.get("id").is_some_and(|id| !id.is_null());
    if write_call {
        let client = bridge.header().map(str::to_owned);
        let link = sign::Link {
            path: bridge.path,
            client: client.as_deref(),
        };
        let reply = sign::call(&link, &message);
        return if reply.is_empty() {
            Ok(())
        } else {
            emit(output, &reply)
        };
    }
    let path = bridge.path;
    let client = bridge.header().map(str::to_owned);
    match exchange(line, path, client.as_deref()) {
        Ok(replies) => {
            for reply in replies {
                emit(output, &reply)?;
            }
            Ok(())
        }
        Err(error) => emit(
            output,
            &json::error_line(-32000, &error, &json::request_id(&message)),
        ),
    }
}

fn emit(output: &mut impl Write, line: &str) -> io::Result<()> {
    output.write_all(line.as_bytes())?;
    output.write_all(b"\n")?;
    output.flush()
}

/// Re-reads the descriptor for every request, so a long-lived bridge follows a service
/// restart instead of holding on to a stale endpoint and token.
fn exchange(body: &str, path: &str, client: Option<&str>) -> Result<Vec<String>, String> {
    let current = wait_for_runtime(None)?;
    let response = match http::post(current.port, path, &current.token, body, client) {
        Ok(response) => response,
        // Nothing listens on the recorded endpoint: the descriptor outlived its service
        // even if its PID looks alive (it may have been reused). Only a refusal proves
        // the request was never delivered, so only a refusal is retried, exactly once.
        Err(http::Error::Refused) => {
            let next = wait_for_runtime(Some(&current))?;
            http::post(next.port, path, &next.token, body, client).map_err(transport_message)?
        }
        Err(error) => return Err(transport_message(error)),
    };
    if response.status == 202 || response.status == 204 {
        return Ok(Vec::new());
    }
    let text = String::from_utf8_lossy(&response.body);
    let event_stream = response
        .content_type
        .as_deref()
        .is_some_and(|value| value.contains("text/event-stream"));
    if event_stream {
        return Ok(text
            .split('\n')
            .map(|entry| entry.strip_suffix('\r').unwrap_or(entry))
            .filter_map(|entry| entry.strip_prefix("data:"))
            .map(json::js_trim)
            .filter(|data| !data.is_empty())
            .map(str::to_owned)
            .collect());
    }
    if json::js_trim(&text).is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str::<Value>(&text)
        .map_err(|error| format!("invalid JSON response: {error}"))?;
    Ok(vec![json::compact(&text)])
}

fn transport_message(error: http::Error) -> String {
    match error {
        http::Error::Refused | http::Error::Request => "fetch failed".to_owned(),
        http::Error::Body => "terminated".to_owned(),
    }
}

/// Waits for a usable service, waking the desktop once if there is none.
///
/// `stale` is an instance the caller already saw refuse connections. Its PID may now
/// belong to an unrelated process, so only a newly published instance counts.
fn wait_for_runtime(stale: Option<&Runtime>) -> Result<Runtime, String> {
    let deadline = Instant::now() + WAIT_FOR_RUNTIME;
    let mut wake_requested = false;
    loop {
        let attempt = descriptor::load().and_then(|current| {
            if stale.is_some_and(|old| old.instance_id == current.instance_id) {
                return Err(RuntimeError::NotReady);
            }
            // A forced termination leaves the descriptor behind; its mere presence is
            // not a live service, or the next Agent could never wake ATM.
            if !process::pid_alive(current.pid) {
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
                if !wake_requested {
                    wake_requested = true;
                    process::wake_desktop();
                }
                // 07 §7: the host serves nothing until the user picks a data source.
                if let Some(reason) = descriptor::source_conflict() {
                    return Err(format!(
                        "ATM_SOURCE_CONFLICT: ATM 需要用户在窗口里选择数据来源（{reason}）"
                    ));
                }
                if Instant::now() >= deadline {
                    return Err("ATM_RUNTIME_UNAVAILABLE".to_owned());
                }
                std::thread::sleep(POLL_INTERVAL);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| (*v).to_owned()).collect()
    }

    #[test]
    fn profile_is_required_and_selects_a_static_route() {
        let missing = mcp_path(&args(&[])).unwrap_err();
        assert!(missing.starts_with("MCP_PROFILE_REQUIRED"), "{missing}");
        assert_eq!(mcp_path(&args(&["--profile", "core"])), Ok("/mcp/core"));
        assert_eq!(
            mcp_path(&args(&["x", "--profile", "actions"])),
            Ok("/mcp/actions")
        );
        assert!(mcp_path(&args(&["--profile", "merged"])).is_err());
        assert!(mcp_path(&args(&["--profile"])).is_err());
    }
}
