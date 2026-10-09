//! 进程的 lifecycle 诊断（W5g；06 T-LIFE，方案 §5；2.0 `lifecycle-diagnostics.ts`）。
//!
//! 单进程之后只有一份：`<N>\logs\lifecycle.ndjson`（256 KiB × 3 轮换）与 `lifecycle-state.json`
//! （最后一条记录的 runId、事件与是否干净退出）。下次启动读这份状态：上次不是干净的 `exit`，就记
//! `previous.unclean`；最后一条是 `session-end`（Windows 注销 / 关机在退出链跑完之前结束进程），记
//! `previous.session-end`——那是有解释的结束，不算异常。之后的任何一条记录（心跳一分钟内就会有）
//! 都会覆盖标记，所以取消关机之后再被杀照样算异常。
//!
//! 只记白名单里的标量：错误只留类型名与消息的指纹，不留消息与栈（可能含库内容、令牌、用户路径）。
//! 写不进去不影响 ATM 本身。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde_json::{Map, Value, json};

const LOG_BYTES: u64 = 256 * 1024;
const LOG_FILES: usize = 3;
const MAX_STATE_BYTES: u64 = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    Startup,
    PreviousUnclean,
    PreviousSessionEnd,
    /// 入口开放（服务在服务）。
    Ready,
    /// 数据源冲突：入口没开，等用户选源。
    Conflict,
    Heartbeat,
    WindowShown,
    WindowClosed,
    Exception,
    BootstrapFailed,
    SessionEnd,
    ShutdownBegin,
    ShutdownComplete,
    Exit,
    /// 看门狗判定挂住，随即 abort（方案 §5）。
    WatchdogStall,
}

impl Event {
    pub fn as_str(self) -> &'static str {
        match self {
            Event::Startup => "startup",
            Event::PreviousUnclean => "previous.unclean",
            Event::PreviousSessionEnd => "previous.session-end",
            Event::Ready => "ready",
            Event::Conflict => "conflict",
            Event::Heartbeat => "heartbeat",
            Event::WindowShown => "window.shown",
            Event::WindowClosed => "window.closed",
            Event::Exception => "exception",
            Event::BootstrapFailed => "bootstrap.failed",
            Event::SessionEnd => "session-end",
            Event::ShutdownBegin => "shutdown.begin",
            Event::ShutdownComplete => "shutdown.complete",
            Event::Exit => "exit",
            Event::WatchdogStall => "watchdog.stall",
        }
    }
}

/// 可以进记录的键与它们的类型。别的键一律丢掉，不在这里展开任意载荷。
const BOOLEAN_KEYS: [&str; 3] = ["background", "agentWake", "clean"];
const NUMBER_KEYS: [&str; 6] = [
    "exitCode",
    "rss",
    "generation",
    "stalledMs",
    "previousPid",
    "uptimeMs",
];
const STRING_KEYS: [&str; 8] = [
    "reason",
    "origin",
    "errorName",
    "errorFingerprint",
    "previousRunId",
    "previousEvent",
    "previousAt",
    "instanceId",
];

fn plain_string(value: &str) -> bool {
    (1..=80).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'+' | b'-'))
}

/// 白名单过滤：键不在名单里、类型不对、字符串不是简单的标识，都丢掉。
pub fn allowed(detail: &[(&str, Value)]) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, value) in detail {
        let keep = match value {
            Value::Bool(_) => BOOLEAN_KEYS.contains(key),
            Value::Number(n) => NUMBER_KEYS.contains(key) && n.as_f64().is_some_and(f64::is_finite),
            Value::String(s) => STRING_KEYS.contains(key) && plain_string(s),
            _ => false,
        };
        if keep {
            out.insert((*key).to_owned(), value.clone());
        }
    }
    out
}

/// 错误的类型名与消息指纹（sha256 前 16 个十六进制字符），不留消息本身。
pub fn error_detail(name: &str, message: &str) -> Vec<(&'static str, Value)> {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(message.as_bytes());
    let fingerprint: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    let name = if name.bytes().all(|b| b.is_ascii_alphabetic()) && (1..=40).contains(&name.len()) {
        name
    } else {
        "Error"
    };
    vec![
        ("errorName", json!(name)),
        ("errorFingerprint", json!(fingerprint)),
    ]
}

struct Inner {
    dir: PathBuf,
    run_id: String,
    version: String,
    started: std::time::Instant,
    active: bool,
    finished: bool,
}

pub struct Lifecycle {
    inner: Mutex<Inner>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn random_run_id() -> String {
    // 时间、进程号与一个栈地址拼起来再散列：只要求同一台机器上的各次运行互不相同。
    use sha2::{Digest, Sha256};
    let probe = 0u8;
    let seed = format!(
        "{}:{}:{:p}:{:?}",
        now_ms(),
        std::process::id(),
        &probe,
        std::thread::current().id()
    );
    Sha256::digest(seed.as_bytes())
        .iter()
        .take(16)
        .map(|b| format!("{b:02x}"))
        .collect()
}

impl Lifecycle {
    /// `dir` 是 `<N>\logs`。
    pub fn new(dir: PathBuf, version: &str) -> Lifecycle {
        Lifecycle {
            inner: Mutex::new(Inner {
                dir,
                run_id: random_run_id(),
                version: version.chars().take(40).collect(),
                started: std::time::Instant::now(),
                active: false,
                finished: false,
            }),
        }
    }

    #[cfg(test)]
    pub fn run_id(&self) -> String {
        self.lock().run_id.clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 读上次的状态，记 `previous.*`（如果需要），再记 `startup`。只做一次。
    pub fn start(&self, background: bool, agent_wake: bool) {
        let previous = {
            let mut inner = self.lock();
            if inner.active {
                return;
            }
            inner.active = true;
            atm_install_state::read_json_limited::<Value>(
                &inner.dir.join("lifecycle-state.json"),
                MAX_STATE_BYTES,
            )
            .ok()
            .flatten()
        };
        if let Some(previous) = previous
            && previous.get("clean") == Some(&Value::Bool(false))
            && let Some(run_id) = previous.get("runId").and_then(Value::as_str)
        {
            let event = previous.get("event").and_then(Value::as_str);
            let mut detail: Vec<(&str, Value)> = vec![("previousRunId", json!(run_id))];
            if let Some(pid) = previous.get("pid").and_then(Value::as_u64) {
                detail.push(("previousPid", json!(pid)));
            }
            if let Some(event) = event {
                detail.push(("previousEvent", json!(event)));
            }
            if let Some(at) = previous.get("at").and_then(Value::as_str) {
                detail.push(("previousAt", json!(at)));
            }
            let kind = if event == Some(Event::SessionEnd.as_str()) {
                Event::PreviousSessionEnd
            } else {
                Event::PreviousUnclean
            };
            self.record(kind, &detail);
        }
        self.record(
            Event::Startup,
            &[
                ("background", json!(background)),
                ("agentWake", json!(agent_wake)),
            ],
        );
    }

    pub fn record(&self, event: Event, detail: &[(&str, Value)]) {
        let inner = self.lock();
        if !inner.active || inner.finished {
            return;
        }
        let at = atm_install_state::startup::iso_utc(now_ms());
        let mut line = Map::new();
        line.insert("at".into(), json!(at));
        line.insert("event".into(), json!(event.as_str()));
        line.insert("runId".into(), json!(inner.run_id));
        line.insert("pid".into(), json!(std::process::id()));
        line.insert("version".into(), json!(inner.version));
        line.extend(allowed(detail));
        let clean = event == Event::Exit && detail.contains(&("clean", Value::Bool(true)));
        let state = json!({
            "runId": inner.run_id,
            "pid": std::process::id(),
            "event": event.as_str(),
            "at": at,
            "clean": clean,
        });
        // 写不进去不能成为 ATM 退出的新理由。
        let _ = write(&inner.dir, &Value::Object(line), &state);
    }

    /// 干净或不干净的退出。之后不再记录。
    pub fn finish(&self, exit_code: i32, clean: bool) {
        let uptime = self.lock().started.elapsed().as_millis() as u64;
        self.record(
            Event::Exit,
            &[
                ("exitCode", json!(exit_code)),
                ("clean", json!(clean)),
                ("uptimeMs", json!(uptime)),
            ],
        );
        self.lock().finished = true;
    }
}

fn write(dir: &Path, line: &Value, state: &Value) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let text = format!("{line}\n");
    rotate(
        dir,
        "lifecycle",
        "ndjson",
        text.len() as u64,
        LOG_BYTES,
        LOG_FILES,
    );
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("lifecycle.ndjson"))?
        .write_all(text.as_bytes())?;
    atm_install_state::durable::write_atomic(
        &dir.join("lifecycle-state.json"),
        state.to_string().as_bytes(),
    )
}

/// `<stem>.<ext>` 加上 `incoming` 字节会超过 `max`：依次挪成 `<stem>.1.<ext>` … `<stem>.<files-1>.<ext>`，
/// 最老的一份丢掉。`files` 是连当前文件在内的份数。
pub fn rotate(dir: &Path, stem: &str, ext: &str, incoming: u64, max: u64, files: usize) {
    let current = dir.join(format!("{stem}.{ext}"));
    let Ok(meta) = std::fs::metadata(&current) else {
        return;
    };
    if meta.len() + incoming <= max {
        return;
    }
    if files <= 1 {
        let _ = std::fs::remove_file(&current);
        return;
    }
    for index in (1..files).rev() {
        let target = dir.join(format!("{stem}.{index}.{ext}"));
        let source = if index == 1 {
            current.clone()
        } else {
            dir.join(format!("{stem}.{}.{ext}", index - 1))
        };
        let _ = std::fs::remove_file(&target);
        if source.exists() {
            let _ = std::fs::rename(&source, &target);
        }
    }
}

/// 宿主日志（`host.log`）一行的脱敏：令牌（Authorization / Bearer / token= 一类）换成占位，
/// 换行压成空格，最长 1000 字。路径照留：宿主日志要能定位安装与数据根的问题。
pub fn redact_line(line: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut hide_next = false;
    for token in line.split_whitespace() {
        if hide_next {
            out.push("<redacted>".into());
            hide_next = false;
            continue;
        }
        let lower = token.to_ascii_lowercase();
        if lower == "bearer" || lower == "authorization:" {
            out.push(token.to_owned());
            hide_next = true;
            continue;
        }
        let mut redacted = None;
        for key in ["token=", "token:", "key=", "secret=", "password="] {
            if let Some(at) = lower.find(key) {
                let before = lower[..at].chars().last();
                if at == 0 || matches!(before, Some('?' | '&' | '_' | '-' | '"')) {
                    redacted = Some(format!("{}<redacted>", &token[..at + key.len()]));
                    break;
                }
            }
        }
        out.push(redacted.unwrap_or_else(|| token.to_owned()));
    }
    let joined = out.join(" ");
    if joined.chars().count() <= 1000 {
        joined
    } else {
        joined
            .chars()
            .take(999)
            .chain(std::iter::once('…'))
            .collect()
    }
}

static GLOBAL: OnceLock<Lifecycle> = OnceLock::new();

/// 进程里唯一的一份（panic 钩子、会话结束的窗口过程、看门狗线程都要用）。
pub fn install(dir: PathBuf, version: &str) -> &'static Lifecycle {
    GLOBAL.get_or_init(|| Lifecycle::new(dir, version))
}

pub fn global() -> Option<&'static Lifecycle> {
    GLOBAL.get()
}

/// panic 之后进程按 `panic = "abort"` 退出：先记一条 exception（只有位置与指纹），让下次启动知道原因。
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(lifecycle) = global() {
            let message = info
                .payload()
                .downcast_ref::<&str>()
                .map(|s| (*s).to_owned())
                .or_else(|| info.payload().downcast_ref::<String>().cloned())
                .unwrap_or_default();
            let mut detail = error_detail("Panic", &message);
            detail.push(("origin", json!("panic")));
            lifecycle.record(Event::Exception, &detail);
        }
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("target")
            .join("host-tests")
            .join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::path::absolute(dir).unwrap()
    }

    fn lines(dir: &Path) -> Vec<Value> {
        std::fs::read_to_string(dir.join("lifecycle.ndjson"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    fn events(dir: &Path) -> Vec<String> {
        lines(dir)
            .iter()
            .map(|l| l["event"].as_str().unwrap().to_owned())
            .collect()
    }

    #[test]
    fn a_clean_exit_is_not_reported_on_the_next_start() {
        let dir = scratch("lifecycle-clean");
        let first = Lifecycle::new(dir.clone(), "3.0.0");
        first.start(false, false);
        first.record(Event::Ready, &[("generation", json!(4))]);
        first.record(Event::ShutdownBegin, &[]);
        first.finish(0, true);
        // 结束之后不再记录。
        first.record(Event::Heartbeat, &[]);
        let second = Lifecycle::new(dir.clone(), "3.0.0");
        second.start(true, false);
        assert_eq!(
            events(&dir),
            ["startup", "ready", "shutdown.begin", "exit", "startup"]
        );
        let all = lines(&dir);
        assert_eq!(all[1]["generation"], 4);
        assert_eq!(all[3]["clean"], true);
        assert_eq!(all[4]["background"], true);
        assert_ne!(all[0]["runId"], all[4]["runId"]);
    }

    #[test]
    fn a_killed_run_is_reported_unclean_and_a_session_end_is_not() {
        let dir = scratch("lifecycle-unclean");
        let killed = Lifecycle::new(dir.clone(), "3.0.0");
        killed.start(false, false);
        killed.record(Event::Heartbeat, &[("rss", json!(1024))]);
        // 进程被杀：没有 exit。
        let next = Lifecycle::new(dir.clone(), "3.0.0");
        next.start(false, true);
        let all = lines(&dir);
        let reported = &all[2];
        assert_eq!(reported["event"], "previous.unclean");
        assert_eq!(reported["previousRunId"], json!(killed.run_id()));
        assert_eq!(reported["previousEvent"], "heartbeat");
        assert_eq!(reported["previousPid"], std::process::id());

        // 注销 / 关机：最后一条是 session-end，下次报 previous.session-end。
        next.record(Event::SessionEnd, &[]);
        let after = Lifecycle::new(dir.clone(), "3.0.0");
        after.start(false, false);
        assert_eq!(events(&dir).last().unwrap(), "startup");
        assert_eq!(events(&dir)[events(&dir).len() - 2], "previous.session-end");

        // 取消关机之后又被杀：session-end 已被之后的记录覆盖，照样算异常。
        after.record(Event::SessionEnd, &[]);
        after.record(Event::Heartbeat, &[]);
        let last = Lifecycle::new(dir.clone(), "3.0.0");
        last.start(false, false);
        let all = events(&dir);
        assert_eq!(all[all.len() - 2], "previous.unclean");
    }

    #[test]
    fn only_allowlisted_scalars_are_recorded() {
        let kept = allowed(&[
            ("reason", json!("writer")),
            ("reason2", json!("x")),
            ("origin", json!("C:\\Users\\me")),
            ("errorName", json!("has space")),
            ("rss", json!(12)),
            ("rss", json!("12")),
            ("clean", json!("yes")),
            ("background", json!(true)),
            ("unknownFlag", json!(true)),
            ("unknownCount", json!(3)),
            ("generation", json!({ "nested": 1 })),
        ]);
        assert_eq!(
            Value::Object(kept),
            json!({ "reason": "writer", "rss": 12, "background": true })
        );
        let error = error_detail("Panic", "token=s3cr3t at C:\\Users\\me");
        assert_eq!(error[0], ("errorName", json!("Panic")));
        let fingerprint = error[1].1.as_str().unwrap();
        assert_eq!(fingerprint.len(), 16);
        assert!(!fingerprint.contains("s3cr3t"));
        assert_eq!(error_detail("bad name!", "x")[0].1, "Error");
    }

    #[test]
    fn the_log_rotates_and_keeps_three_files() {
        let dir = scratch("lifecycle-rotate");
        let lifecycle = Lifecycle::new(dir.clone(), "3.0.0");
        lifecycle.start(false, false);
        for _ in 0..4000 {
            lifecycle.record(Event::Heartbeat, &[("rss", json!(123_456_789))]);
        }
        for name in [
            "lifecycle.ndjson",
            "lifecycle.1.ndjson",
            "lifecycle.2.ndjson",
        ] {
            let size = std::fs::metadata(dir.join(name)).unwrap().len();
            assert!(size > 0 && size <= LOG_BYTES, "{name}: {size}");
        }
        assert!(!dir.join("lifecycle.3.ndjson").exists());
    }

    #[test]
    fn host_log_lines_lose_their_secrets() {
        assert_eq!(
            redact_line("GET /x Authorization: Bearer abc\nnext"),
            "GET /x Authorization: <redacted> abc next"
        );
        assert_eq!(redact_line("got bearer xyz ok"), "got bearer <redacted> ok");
        assert_eq!(
            redact_line("url ?token=abc&x user_key=k monkey=fine"),
            "url ?token=<redacted> user_key=<redacted> monkey=fine"
        );
        assert_eq!(
            redact_line("open C:\\data\\atm.sqlite: denied"),
            "open C:\\data\\atm.sqlite: denied"
        );
        let long = redact_line(&"x ".repeat(800));
        assert_eq!(long.chars().count(), 1000);
    }
}
