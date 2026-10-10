//! 对 claude 命令行做的只读探测（2.x `claude-probe.ts`）：`--version`（按路径永久缓存）与 `auth status --json`
//! （缓存 5 分钟）。子进程环境同样剥离宿主会话的变量，否则在 Claude 会话里启动的 ATM 会探到宿主会话的登录态。

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde_json::Value;

use crate::launch::{child_env, launch_command};

/// 登录状态缓存多久。用户在终端里登录 / 登出后，最迟这么久状态页就会跟上；派单前另有强制重探。
pub const AUTH_CACHE_MS: i64 = 5 * 60_000;
pub const AUTH_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// `claude auth status` 的结论：`logged_in` 为 `None` 表示没探出来（超时、输出看不懂、命令不支持），不当作未登录。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AuthState {
    pub logged_in: Option<bool>,
    pub auth_method: Option<String>,
}

/// 一次探测的输出。
#[derive(Clone, Debug, Default)]
pub struct ProbeOutput {
    pub stdout: String,
    pub timed_out: bool,
    /// 没起来，或退出码不是 0（未登录时 `auth status` 退出码是 1，stdout 照样有效）。
    pub failed: bool,
}

/// 跑一次 claude 子命令，用例注入替身。
pub trait Runner: Send + Sync {
    fn run(
        &self,
        claude: &Path,
        args: &[String],
        env: &[(OsString, OsString)],
        timeout: Duration,
    ) -> ProbeOutput;
}

/// 解析 `claude auth status --json`（实测未登录时 `{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}`）。
pub fn parse_auth_status(stdout: &str) -> AuthState {
    let (Some(start), Some(end)) = (stdout.find('{'), stdout.rfind('}')) else {
        return AuthState::default();
    };
    if end <= start {
        return AuthState::default();
    }
    let Ok(Value::Object(o)) = serde_json::from_str::<Value>(&stdout[start..=end]) else {
        return AuthState::default();
    };
    let Some(logged_in) = o.get("loggedIn").and_then(Value::as_bool) else {
        return AuthState::default();
    };
    // 截到 64 个 UTF-16 码元（2.x `slice(0, 64)`）；方法名都是 ASCII。
    let method: String = o
        .get("authMethod")
        .and_then(Value::as_str)
        .map(|m| m.chars().take(64).collect())
        .unwrap_or_default();
    AuthState {
        logged_in: Some(logged_in),
        auth_method: (!method.is_empty()).then_some(method),
    }
}

/// 一次在途或已落定的登录探测。
struct AuthEntry {
    path: PathBuf,
    at: i64,
    state: Option<AuthState>,
}

pub struct ClaudeProbe {
    runner: Arc<dyn Runner>,
    base_env: Vec<(OsString, OsString)>,
    comspec: Option<PathBuf>,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    auth_timeout: Duration,
    version: Mutex<Option<(PathBuf, Option<String>)>>,
    auth: Mutex<Option<AuthEntry>>,
    auth_changed: Condvar,
}

impl ClaudeProbe {
    pub fn new(
        runner: Arc<dyn Runner>,
        base_env: Vec<(OsString, OsString)>,
        comspec: Option<PathBuf>,
        now: Arc<dyn Fn() -> i64 + Send + Sync>,
        auth_timeout: Duration,
    ) -> ClaudeProbe {
        ClaudeProbe {
            runner,
            base_env,
            comspec,
            now,
            auth_timeout,
            version: Mutex::new(None),
            auth: Mutex::new(None),
            auth_changed: Condvar::new(),
        }
    }

    fn run(&self, claude: &Path, args: &[&str], timeout: Duration) -> ProbeOutput {
        let args: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
        // 路径本身经不起 cmd.exe 转义时（含 % 之类）当作探测失败。
        if launch_command(claude, &args, self.comspec.as_deref()).is_err() {
            return ProbeOutput {
                failed: true,
                ..ProbeOutput::default()
            };
        }
        self.runner
            .run(claude, &args, &child_env(&self.base_env, "probe"), timeout)
    }

    /// `claude --version` 的第一行（截到 80 字）；同一路径只探一次。
    pub fn version(&self, claude: &Path) -> Option<String> {
        {
            let v = self.version.lock().unwrap_or_else(|e| e.into_inner());
            if let Some((path, value)) = v.as_ref()
                && path == claude
            {
                return value.clone();
            }
        }
        let out = self.run(claude, &["--version"], VERSION_PROBE_TIMEOUT);
        let value = (!out.failed)
            .then(|| {
                out.stdout
                    .trim()
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_owned()
            })
            .filter(|l| !l.is_empty())
            .map(|l| l.chars().take(80).collect::<String>());
        *self.version.lock().unwrap_or_else(|e| e.into_inner()) =
            Some((claude.to_path_buf(), value.clone()));
        value
    }

    /// 登录状态。第二个值是「用的是之前探好的结果」（而不是这次新探、或正在进行中的那次）：调用方据此决定
    /// 「缓存说未登录」时要不要强制重探。同一时刻只有一次探测在跑，别的调用等它的结果。
    pub fn auth(&self, claude: &Path, force: bool) -> (AuthState, bool) {
        let mut slot = self.auth.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            match slot.as_ref() {
                Some(e) if e.path == claude && e.state.is_none() && !force => {
                    // 正在探：等它落定（落定的不算缓存）。
                    slot = self
                        .auth_changed
                        .wait(slot)
                        .unwrap_or_else(|e| e.into_inner());
                    if let Some(e) = slot.as_ref()
                        && e.path == claude
                        && let Some(state) = &e.state
                    {
                        return (state.clone(), false);
                    }
                }
                Some(e)
                    if e.path == claude
                        && !force
                        && (self.now)() - e.at < AUTH_CACHE_MS
                        && e.state.is_some() =>
                {
                    return (e.state.clone().unwrap_or_default(), true);
                }
                _ => break,
            }
        }
        let at = (self.now)();
        *slot = Some(AuthEntry {
            path: claude.to_path_buf(),
            at,
            state: None,
        });
        drop(slot);
        let out = self.run(claude, &["auth", "status", "--json"], self.auth_timeout);
        let state = if out.timed_out {
            AuthState::default()
        } else {
            parse_auth_status(&out.stdout)
        };
        let mut slot = self.auth.lock().unwrap_or_else(|e| e.into_inner());
        // 期间被作废（invalidate）或换成了别的探测：结果照样给调用方，但不写回缓存。
        if let Some(e) = slot.as_mut()
            && e.path == claude
            && e.at == at
            && e.state.is_none()
        {
            e.state = Some(state.clone());
        }
        self.auth_changed.notify_all();
        (state, false)
    }

    /// 会话因为鉴权失败结束时调用：下次查状态重新探，而不是继续报「已登录」。
    pub fn invalidate_auth(&self) {
        let mut slot = self.auth.lock().unwrap_or_else(|e| e.into_inner());
        if slot.as_ref().is_some_and(|e| e.state.is_some()) {
            *slot = None;
        }
    }
}

/// 真的起进程：`.cmd` 经 `cmd.exe /d /s /c`，不弹窗；超时结束整棵进程树。
pub struct ProcessRunner {
    pub comspec: Option<PathBuf>,
    pub probe: Arc<dyn crate::process::Probe>,
}

impl Runner for ProcessRunner {
    fn run(
        &self,
        claude: &Path,
        args: &[String],
        env: &[(OsString, OsString)],
        timeout: Duration,
    ) -> ProbeOutput {
        let Ok(command) = launch_command(claude, args, self.comspec.as_deref()) else {
            return ProbeOutput {
                failed: true,
                ..ProbeOutput::default()
            };
        };
        let mut c = std::process::Command::new(&command.program);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            c.raw_arg(&command.raw_args)
                .creation_flags(CREATE_NO_WINDOW);
        }
        #[cfg(not(windows))]
        c.args(args);
        c.env_clear()
            .envs(env.iter().map(|(k, v)| (k, v)))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        let Ok(mut child) = c.spawn() else {
            return ProbeOutput {
                failed: true,
                ..ProbeOutput::default()
            };
        };
        // 读 stdout 放在另一个线程：npm 装法里真正的 claude 是 cmd.exe 的孙进程，超时只结束得了整棵树，
        // 万一还有谁握着管道，读线程自己留着，不拖住调用方。
        let pipe = child.stdout.take();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut text = Vec::new();
            if let Some(mut p) = pipe {
                let _ = std::io::Read::read_to_end(&mut p, &mut text);
            }
            let _ = tx.send(String::from_utf8_lossy(&text).into_owned());
        });
        let deadline = std::time::Instant::now() + timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break Some(s),
                Ok(None) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                _ => break None,
            }
        };
        let Some(status) = status else {
            let _ = self.probe.kill_tree(child.id());
            let _ = child.kill();
            let _ = child.wait();
            return ProbeOutput {
                stdout: rx
                    .recv_timeout(Duration::from_millis(200))
                    .unwrap_or_default(),
                timed_out: true,
                failed: true,
            };
        };
        ProbeOutput {
            stdout: rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default(),
            timed_out: false,
            failed: !status.success(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn auth_status_output_is_read_leniently() {
        assert_eq!(
            parse_auth_status("{\n  \"loggedIn\": true,\n  \"authMethod\": \"claude.ai\"\n}\n"),
            AuthState {
                logged_in: Some(true),
                auth_method: Some("claude.ai".into())
            }
        );
        assert_eq!(
            parse_auth_status(
                r#"warn: x {"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"} tail"#
            ),
            AuthState {
                logged_in: Some(false),
                auth_method: Some("none".into())
            }
        );
        for bad in ["", "not json", "{\"loggedIn\":\"yes\"}", "} {", "{broken"] {
            assert_eq!(parse_auth_status(bad), AuthState::default(), "{bad}");
        }
        assert_eq!(
            parse_auth_status(&format!(
                r#"{{"loggedIn":true,"authMethod":"{}"}}"#,
                "m".repeat(70)
            ))
            .auth_method
            .unwrap()
            .len(),
            64
        );
    }

    struct Scripted {
        calls: AtomicUsize,
        outputs: Mutex<Vec<ProbeOutput>>,
        delay: Duration,
        envs: Mutex<Vec<Vec<(OsString, OsString)>>>,
    }

    impl Runner for Scripted {
        fn run(
            &self,
            _c: &Path,
            _a: &[String],
            env: &[(OsString, OsString)],
            _t: Duration,
        ) -> ProbeOutput {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.envs.lock().unwrap().push(env.to_vec());
            std::thread::sleep(self.delay);
            let mut o = self.outputs.lock().unwrap();
            if o.len() > 1 {
                o.remove(0)
            } else {
                o[0].clone()
            }
        }
    }

    fn out(stdout: &str) -> ProbeOutput {
        ProbeOutput {
            stdout: stdout.into(),
            ..ProbeOutput::default()
        }
    }

    #[test]
    fn auth_is_cached_for_five_minutes_and_concurrent_calls_share_one_probe() {
        let runner = Arc::new(Scripted {
            calls: AtomicUsize::new(0),
            outputs: Mutex::new(vec![out(r#"{"loggedIn":true,"authMethod":"claude.ai"}"#)]),
            delay: Duration::from_millis(50),
            envs: Mutex::new(Vec::new()),
        });
        let clock = Arc::new(std::sync::atomic::AtomicI64::new(0));
        let c2 = clock.clone();
        let base = vec![
            (OsString::from("PATH"), OsString::from("p")),
            (OsString::from("CLAUDECODE"), OsString::from("1")),
        ];
        let probe = Arc::new(ClaudeProbe::new(
            runner.clone(),
            base,
            None,
            Arc::new(move || c2.load(Ordering::SeqCst)),
            AUTH_PROBE_TIMEOUT,
        ));
        let claude = Path::new(r"C:\x\claude.exe");
        let threads: Vec<_> = (0..3)
            .map(|_| {
                let p = probe.clone();
                std::thread::spawn(move || p.auth(Path::new(r"C:\x\claude.exe"), false))
            })
            .collect();
        for t in threads {
            let (state, cached) = t.join().unwrap();
            assert_eq!(state.logged_in, Some(true));
            assert!(!cached);
        }
        assert_eq!(runner.calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            probe.auth(claude, false),
            (probe.auth(claude, false).0, true)
        );
        clock.store(AUTH_CACHE_MS, Ordering::SeqCst);
        assert!(!probe.auth(claude, false).1);
        assert_eq!(runner.calls.load(Ordering::SeqCst), 2);
        assert!(!probe.auth(claude, true).1);
        probe.invalidate_auth();
        assert!(!probe.auth(claude, false).1);
        assert_eq!(runner.calls.load(Ordering::SeqCst), 4);
        // 探测子进程的环境同样剥离宿主会话变量。
        let env = &runner.envs.lock().unwrap()[0];
        assert!(env.iter().all(|(k, _)| k != "CLAUDECODE"));
        assert!(
            env.iter()
                .any(|(k, v)| k == "ATM_DISPATCH_RUN" && v == "probe")
        );
    }

    #[test]
    fn a_timed_out_probe_is_unknown_not_logged_out() {
        let runner = Arc::new(Scripted {
            calls: AtomicUsize::new(0),
            outputs: Mutex::new(vec![ProbeOutput {
                stdout: r#"{"loggedIn":false}"#.into(),
                timed_out: true,
                failed: true,
            }]),
            delay: Duration::ZERO,
            envs: Mutex::new(Vec::new()),
        });
        let probe = ClaudeProbe::new(runner, Vec::new(), None, Arc::new(|| 0), AUTH_PROBE_TIMEOUT);
        assert_eq!(probe.auth(Path::new("claude.exe"), false).0.logged_in, None);
        // 路径经不起 cmd.exe 转义：当作探测失败，不起进程。
        assert_eq!(probe.version(Path::new(r"C:\100%\claude.cmd")), None);
    }

    #[test]
    fn the_version_is_probed_once_per_path() {
        let runner = Arc::new(Scripted {
            calls: AtomicUsize::new(0),
            outputs: Mutex::new(vec![out("2.1.0 (Claude Code)\nextra\n")]),
            delay: Duration::ZERO,
            envs: Mutex::new(Vec::new()),
        });
        let probe = ClaudeProbe::new(
            runner.clone(),
            Vec::new(),
            None,
            Arc::new(|| 0),
            AUTH_PROBE_TIMEOUT,
        );
        assert_eq!(
            probe.version(Path::new("a.exe")).as_deref(),
            Some("2.1.0 (Claude Code)")
        );
        assert_eq!(
            probe.version(Path::new("a.exe")).as_deref(),
            Some("2.1.0 (Claude Code)")
        );
        assert_eq!(runner.calls.load(Ordering::SeqCst), 1);
        probe.version(Path::new("b.exe"));
        assert_eq!(runner.calls.load(Ordering::SeqCst), 2);
    }
}
