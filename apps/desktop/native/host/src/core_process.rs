//! Starts and talks to the core (Node) over its stdin/stdout (host-control protocol v1,
//! apps/desktop/src/host-protocol.ts). stdout carries only frames; stderr goes to a
//! bounded log file.

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};

use crate::paths::CoreCommand;

pub const PROTOCOL_VERSION: u64 = 1;
/// Same number as MAX_RESPONSE_BYTES in host-protocol.ts.
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const MAX_STDERR_LOG_BYTES: u64 = 1024 * 1024;
/// No console at all for the core: CREATE_NO_WINDOW still attaches a hidden conhost
/// (~6 MB private, measured); the core only talks over its stdio pipes.
const DETACHED_PROCESS: u32 = 0x0000_0008;
/// `core-main.ts` CORE_EXIT_REJECTED: the core refused this host. Never restart on it.
pub const CORE_EXIT_REJECTED: i32 = 64;

#[derive(Debug, Clone)]
pub enum CoreEvent {
    /// The whole ready frame: it carries the core's pid/startedAtMs/instanceId, which the
    /// SERVICE_HEALTHY witness needs.
    Ready(Value),
    /// Read-only install probe result (`hello.probe`).
    Probed(Value),
    Response {
        id: u64,
        frame: Value,
    },
    Tray(Value),
    Notify {
        title: String,
        body: String,
    },
    Fatal {
        code: String,
        message: String,
    },
    /// The core found a delivered update and the user asked to install it (update.rs).
    InstallUpdate {
        manifest: String,
    },
    Exited(Option<i32>),
}

#[derive(Debug, Clone, Copy)]
pub struct Launch {
    pub background: bool,
    pub agent_wake: bool,
    pub random_startup_delay: bool,
}

pub struct Core {
    pub pid: u32,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    child: Arc<Mutex<Child>>,
    marker: SessionMarker,
    stderr_tail: Arc<Mutex<Vec<u8>>>,
}

/// How to start one core: what the hello says and where its stderr goes.
pub struct Spawn<'a> {
    pub run_id: &'a str,
    pub version: &'a str,
    pub launch: Launch,
    /// `Some(txn)` asks for the read-only install probe instead of the service.
    pub probe_txn: Option<&'a str>,
    /// `<dataDir>\logs\core-stderr.log` normally. `None` for the probe, which must not
    /// write anything under the data root: stderr is only kept as a bounded tail.
    pub stderr_log: Option<PathBuf>,
}

const STDERR_TAIL_BYTES: usize = 4096;

/// What the session-end window needs from the running core: a way to ask it to write its
/// lifecycle marker, and to learn that it has. Cloned out so the window procedure does not
/// have to reach into the event loop, which is blocked while Windows waits on it.
#[derive(Clone)]
pub struct SessionMarker {
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    recorded: Arc<(Mutex<bool>, Condvar)>,
}

impl SessionMarker {
    /// Returns whether the core confirmed the marker within `timeout`.
    pub fn mark(&self, timeout: Duration) -> bool {
        write_frame(&self.stdin, &json!({ "t": "event", "name": "session-end" }));
        let (flag, signal) = &*self.recorded;
        let Ok(guard) = flag.lock() else {
            return false;
        };
        signal
            .wait_timeout_while(guard, timeout, |recorded| !*recorded)
            .map(|(recorded, _)| *recorded)
            .unwrap_or(false)
    }
}

fn write_frame(stdin: &Mutex<Option<ChildStdin>>, frame: &Value) {
    let Ok(mut guard) = stdin.lock() else {
        return;
    };
    if let Some(pipe) = guard.as_mut() {
        let mut line = frame.to_string();
        line.push('\n');
        if pipe
            .write_all(line.as_bytes())
            .and_then(|()| pipe.flush())
            .is_err()
        {
            *guard = None;
        }
    }
}

/// Variables that could inject code or debugging into Node or WebView2 children.
fn scrubbed(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    upper.starts_with("NODE_")
        || upper.starts_with("ELECTRON_")
        || upper.starts_with("WEBVIEW2_")
        || upper == "UV_THREADPOOL_SIZE"
}

pub fn scrub_environment(command: &mut Command) {
    for (key, _) in std::env::vars_os() {
        if let Some(key) = key.to_str().filter(|key| scrubbed(key)) {
            command.env_remove(key);
        }
    }
    // Test builds only. The packaged smoke isolates Agent configs under a synthetic home, but
    // WebView2 does not start under a synthetic USERPROFILE; so the host keeps the real profile
    // and Node children — whose os.homedir() decides where those configs live — get this one.
    #[cfg(feature = "smoke")]
    if let Some(home) = std::env::var_os("ATM_SMOKE_CORE_USERPROFILE") {
        command.env("USERPROFILE", &home).env("HOME", &home);
    }
}

fn append_bounded(path: &Path, bytes: &[u8]) {
    if let Ok(metadata) = fs::metadata(path)
        && metadata.len() + bytes.len() as u64 > MAX_STDERR_LOG_BYTES
    {
        let _ = fs::rename(path, path.with_extension("1.log"));
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(bytes);
    }
}

/// The core's reply to the session-end event; handled on the reader thread, never queued.
fn is_session_marked(frame: &Value) -> bool {
    frame.get("t").and_then(Value::as_str) == Some("marked")
        && frame.get("name").and_then(Value::as_str) == Some("session-end")
}

#[cfg(test)]
fn parse_frame(line: &[u8]) -> Option<CoreEvent> {
    parse_value(serde_json::from_slice(line).ok()?)
}

fn parse_value(frame: Value) -> Option<CoreEvent> {
    match frame.get("t")?.as_str()? {
        "ready" if frame.get("v")?.as_u64()? == PROTOCOL_VERSION => Some(CoreEvent::Ready(frame)),
        "probed" if frame.get("ok")?.is_boolean() => Some(CoreEvent::Probed(frame)),
        "res" => Some(CoreEvent::Response {
            id: frame.get("id")?.as_u64()?,
            frame,
        }),
        "tray" => Some(CoreEvent::Tray(frame.get("snapshot")?.clone())),
        "notify" => Some(CoreEvent::Notify {
            title: frame.get("title")?.as_str()?.chars().take(200).collect(),
            body: frame.get("body")?.as_str()?.chars().take(1000).collect(),
        }),
        "fatal" => Some(CoreEvent::Fatal {
            code: frame.get("code")?.as_str()?.chars().take(64).collect(),
            message: frame.get("message")?.as_str()?.chars().take(2000).collect(),
        }),
        "install-update" => Some(CoreEvent::InstallUpdate {
            manifest: frame
                .get("manifest")?
                .as_str()
                .filter(|path| path.len() <= 1024)?
                .to_owned(),
        }),
        _ => None,
    }
}

impl Core {
    pub fn spawn(
        command: &CoreCommand,
        data_dir: &Path,
        options: Spawn<'_>,
        on_event: impl Fn(CoreEvent) + Send + Sync + 'static,
    ) -> Result<Core, String> {
        let Spawn {
            run_id,
            version,
            launch,
            probe_txn,
            stderr_log,
        } = options;
        let mut process = Command::new(&command.exe);
        process
            .args(&command.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(DETACHED_PROCESS);
        scrub_environment(&mut process);
        for (key, value) in &command.env {
            process.env(key, value);
        }
        process.env("ATM_DATA_DIR", data_dir);
        let mut child = process
            .spawn()
            .map_err(|error| format!("CORE_SPAWN_FAILED: {error}"))?;
        let pid = child.id();
        let stdin = child.stdin.take().ok_or("CORE_STDIN_MISSING")?;
        let stdout = child.stdout.take().ok_or("CORE_STDOUT_MISSING")?;
        let mut stderr = child.stderr.take().ok_or("CORE_STDERR_MISSING")?;
        let on_event = Arc::new(on_event);
        let child = Arc::new(Mutex::new(child));

        if let Some(log) = &stderr_log
            && let Some(dir) = log.parent()
        {
            let _ = fs::create_dir_all(dir);
        }
        let stderr_tail = Arc::new(Mutex::new(Vec::new()));
        let tail = stderr_tail.clone();
        thread::Builder::new()
            .name("core-stderr".into())
            .spawn(move || {
                let mut buffer = [0u8; 8192];
                while let Ok(read) = stderr.read(&mut buffer) {
                    if read == 0 {
                        break;
                    }
                    if let Some(log) = &stderr_log {
                        append_bounded(log, &buffer[..read]);
                    }
                    if let Ok(mut tail) = tail.lock() {
                        tail.extend_from_slice(&buffer[..read]);
                        let excess = tail.len().saturating_sub(STDERR_TAIL_BYTES);
                        tail.drain(..excess);
                    }
                }
            })
            .map_err(|error| error.to_string())?;

        let recorded = Arc::new((Mutex::new(false), Condvar::new()));
        let reader_recorded = recorded.clone();
        let reader_events = on_event.clone();
        let reader_child = child.clone();
        thread::Builder::new()
            .name("core-stdout".into())
            .spawn(move || {
                let mut reader = BufReader::with_capacity(64 * 1024, stdout);
                let mut line = Vec::new();
                loop {
                    line.clear();
                    let read = (&mut reader)
                        .take(MAX_FRAME_BYTES as u64 + 1)
                        .read_until(b'\n', &mut line);
                    match read {
                        Ok(0) | Err(_) => break,
                        Ok(_) if line.len() > MAX_FRAME_BYTES => break,
                        Ok(_) => {
                            let Ok(frame) = serde_json::from_slice::<Value>(
                                line.strip_suffix(b"\n").unwrap_or(&line),
                            ) else {
                                continue;
                            };
                            if is_session_marked(&frame) {
                                let (flag, signal) = &*reader_recorded;
                                if let Ok(mut flag) = flag.lock() {
                                    *flag = true;
                                }
                                signal.notify_all();
                            } else if let Some(event) = parse_value(frame) {
                                reader_events(event);
                            }
                        }
                    }
                }
                // Poll instead of wait(): holding the lock across a blocking wait would stop
                // wait_or_kill from ever killing a core that closed stdout but hangs.
                let code = loop {
                    if let Ok(mut child) = reader_child.lock()
                        && let Ok(Some(status)) = child.try_wait()
                    {
                        break status.code();
                    }
                    thread::sleep(std::time::Duration::from_millis(50));
                };
                reader_events(CoreEvent::Exited(code));
            })
            .map_err(|error| error.to_string())?;

        let stdin = Arc::new(Mutex::new(Some(stdin)));
        let core = Core {
            pid,
            marker: SessionMarker {
                stdin: stdin.clone(),
                recorded,
            },
            stdin,
            child,
            stderr_tail,
        };
        let mut hello = json!({
            "t": "hello",
            "v": PROTOCOL_VERSION,
            "runId": run_id,
            "version": version,
            "launch": {
                "background": launch.background,
                "agentWake": launch.agent_wake,
                "randomStartupDelay": launch.random_startup_delay,
            },
        });
        if let Some(txn) = probe_txn {
            hello["probe"] = json!({ "txn": txn });
        }
        core.send(&hello);
        Ok(core)
    }

    fn send(&self, frame: &Value) {
        write_frame(&self.stdin, frame);
    }

    /// The last few KiB the core wrote to stderr (lossy UTF-8).
    pub fn stderr_tail(&self) -> String {
        self.stderr_tail
            .lock()
            .map(|tail| String::from_utf8_lossy(&tail).into_owned())
            .unwrap_or_default()
    }

    pub fn session_marker(&self) -> SessionMarker {
        self.marker.clone()
    }

    pub fn request(&self, id: u64, method: &str, args: Value) {
        self.send(&json!({ "t": "req", "id": id, "method": method, "args": args }));
    }

    pub fn event(&self, name: &str) {
        self.send(&json!({ "t": "event", "name": name }));
    }

    /// Ask for a graceful exit; closing stdin makes a stuck core notice too.
    pub fn shutdown(&self) {
        self.send(&json!({ "t": "shutdown" }));
        if let Ok(mut guard) = self.stdin.lock() {
            guard.take();
        }
    }

    /// Wait for the process to end, killing it after `grace`.
    pub fn wait_or_kill(&self, grace: std::time::Duration) {
        let deadline = std::time::Instant::now() + grace;
        loop {
            if let Ok(mut child) = self.child.lock() {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return;
                }
            }
            thread::sleep(std::time::Duration::from_millis(50));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_are_parsed_strictly() {
        assert!(matches!(
            parse_frame(br#"{"t":"ready","v":1,"runId":"r","version":"x"}"#),
            Some(CoreEvent::Ready(_))
        ));
        assert!(parse_frame(br#"{"t":"ready","v":2}"#).is_none());
        assert!(matches!(
            parse_frame(br#"{"t":"res","id":7,"ok":true,"value":null}"#),
            Some(CoreEvent::Response { id: 7, .. })
        ));
        assert!(parse_frame(br#"{"t":"res","id":-1}"#).is_none());
        assert!(parse_frame(b"not json").is_none());
        assert!(parse_frame(br#"{"t":"eval","code":"x"}"#).is_none());
        assert!(matches!(
            parse_frame(br#"{"t":"probed","ok":false,"code":"MIGRATION_FILE_MISSING"}"#),
            Some(CoreEvent::Probed(_))
        ));
        assert!(parse_frame(br#"{"t":"probed","ok":"yes"}"#).is_none());
    }

    #[test]
    fn injection_variables_are_scrubbed() {
        for key in [
            "NODE_OPTIONS",
            "node_options",
            "ELECTRON_RUN_AS_NODE",
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        ] {
            assert!(scrubbed(key), "{key}");
        }
        for key in ["ATM_DATA_DIR", "PATH", "LOCALAPPDATA"] {
            assert!(!scrubbed(key), "{key}");
        }
    }
}
