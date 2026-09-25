//! AyanamiTaskManager MCP stdio bridge.
//!
//! A native replacement for `resources/mcp-stdio.cjs`, which runs the whole 215 MB
//! Electron binary as Node for what is only a line-by-line forwarder: every Agent
//! session starts three of them. All business logic stays in the desktop's daemon;
//! this process reads one JSON-RPC message per line from stdin, POSTs it to the
//! endpoint in `runtime/daemon.json` and writes the reply back as one line.
//!
//! Behaviour is kept identical to the JavaScript bridge wherever a client or the
//! daemon could observe it; the shared stdio contract suite runs against both.
//! Known, deliberate differences:
//! - The endpoint must be exactly `http://127.0.0.1[:port][/]`; WHATWG spellings of
//!   loopback such as `127.1` are refused, and a token with control characters is
//!   treated as an invalid descriptor instead of failing later in `fetch`.
//! - A numeric request id is echoed verbatim in error responses (`1.0` stays `1.0`).
//! - JSON nested deeper than 128 levels, or containing lone surrogate escapes, is a
//!   parse error here.
//! - A spawn failure while waking the desktop is ignored rather than crashing, and the
//!   desktop is not started with SW_HIDE (see `process::wake_desktop`).
//! - A non-JSON, non-SSE response body is reported as `invalid JSON response: …`
//!   instead of V8's SyntaxError text.
//! - Response bodies above 64 MiB are refused.

mod descriptor;
mod http;
mod json;
mod process;

use descriptor::{Runtime, RuntimeError};
use serde_json::Value;
use std::io::{self, BufRead, Write};
use std::time::{Duration, Instant};

const WAIT_FOR_RUNTIME: Duration = Duration::from_secs(45);
const POLL_INTERVAL: Duration = Duration::from_millis(100);

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let path = match mcp_path(&args) {
        Ok(path) => path,
        Err(message) => {
            eprintln!("Error: {message}");
            std::process::exit(1);
        }
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
        // Node's readline also ends a line at a bare CR, and "\r\n" leaves an empty
        // piece that the blank-line check below drops.
        for line in chunk.split('\r') {
            if json::js_trim(line).is_empty() {
                continue;
            }
            if handle(line, path, &mut output).is_err() {
                // The client closed our stdout; nobody is left to answer.
                return;
            }
        }
    }
}

/// New configurations always pass an explicit static profile. Without one the request
/// goes to the full legacy surface, which only pre-profile clients still hold in memory.
fn mcp_path(args: &[String]) -> Result<&'static str, String> {
    let Some(index) = args.iter().position(|arg| arg == "--profile") else {
        return Ok("/mcp");
    };
    match args.get(index + 1).map(String::as_str) {
        Some("core") => Ok("/mcp/core"),
        Some("memory") => Ok("/mcp/memory"),
        Some("actions") => Ok("/mcp/actions"),
        _ => Err("MCP_PROFILE_INVALID: expected core, memory or actions".to_owned()),
    }
}

fn handle(line: &str, path: &str, output: &mut impl Write) -> io::Result<()> {
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        return emit(output, json::PARSE_ERROR_LINE);
    };
    match exchange(line, path) {
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

/// Re-reads the descriptor for every request, so a long-lived bridge follows a daemon
/// restart instead of holding on to a stale endpoint and token.
fn exchange(body: &str, path: &str) -> Result<Vec<String>, String> {
    let current = wait_for_runtime(None)?;
    let response = match http::post(current.port, path, &current.token, body) {
        Ok(response) => response,
        // Nothing listens on the recorded endpoint: the descriptor outlived its daemon
        // even if its PID looks alive (it may have been reused). Only a refusal proves
        // the request was never delivered, so only a refusal is retried, exactly once.
        Err(http::Error::Refused) => {
            let next = wait_for_runtime(Some(&current))?;
            http::post(next.port, path, &next.token, body).map_err(transport_message)?
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

/// Waits for a usable daemon, waking the desktop once if there is none.
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
    fn profile_selects_a_static_route_and_rejects_anything_else() {
        assert_eq!(mcp_path(&args(&[])), Ok("/mcp"));
        assert_eq!(mcp_path(&args(&["--profile", "core"])), Ok("/mcp/core"));
        assert_eq!(
            mcp_path(&args(&["x", "--profile", "actions"])),
            Ok("/mcp/actions")
        );
        assert!(mcp_path(&args(&["--profile", "merged"])).is_err());
        assert!(mcp_path(&args(&["--profile"])).is_err());
    }
}
