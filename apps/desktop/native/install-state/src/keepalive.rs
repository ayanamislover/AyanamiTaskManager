//! 保活（方案 §5、peer r3 B1）：setup 给当前用户注册计划任务「AyanamiTaskManager 保活」，用户登录期间每 5 分钟跑一次
//! `<安装根>\AyanamiTaskManager.exe --ensure-running`（稳定的根启动器，不随版本目录变）。这里是 setup、根启动器与宿主
//! 共用的部分：任务定义、熔断、「用户主动退出」的标记，以及这一次要不要拉起的判定（纯函数，事实由调用方读）。
//!
//! 状态都在 3.x 的数据根 `N\runtime`，跨进程保存：
//! - `keepalive.json`：熔断。30 分钟内异常退出 3 次就不再自动拉起，直到用户自己启动一次（宿主复位并用通知说明）。
//! - `user-quit.json`：用户在托盘点了「完全退出」。只在那一次登录里有效（记登录会话的 LUID）：下次登录或用户自己
//!   启动就失效。setup 发的退出（升级时的 QUIESCE）、会话结束都不写它。
//!
//! 注册的结果在 `<安装根>\state\keepalive-task.json`：只有注册成功，`--doctor` 与文档才说「崩溃后会自动恢复」。

use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const TASK_NAME: &str = "AyanamiTaskManager 保活";
pub const ENSURE_RUNNING: &str = "--ensure-running";
/// 两次触发的间隔（ISO 8601 时长）：也是「崩溃到被拉起」的最长等待。
pub const INTERVAL: &str = "PT5M";
pub const BREAKER_WINDOW_MS: u64 = 30 * 60 * 1000;
pub const BREAKER_LIMIT: usize = 3;
/// `<安装根>\state\` 下：setup 注册（或删除）任务的结果。
pub const REGISTRATION_FILE: &str = "keepalive-task.json";
const BREAKER_FILE: &str = "keepalive.json";
const USER_QUIT_FILE: &str = "user-quit.json";
const MAX_BYTES: u64 = 64 * 1024;

fn runtime(n: &Path) -> PathBuf {
    n.join("runtime")
}

fn xml_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

/// Task Scheduler 2.0 的任务定义。
///
/// - 触发：登录时，加上从 `start`（UTC，`YYYY-MM-DDTHH:MM:SSZ`）起；两者都每 [`INTERVAL`] 重复、不设截止。
///   只有登录触发的话，装好之后要等到下次登录才开始保活。
/// - 只在 `user` 登录时以它的身份跑（InteractiveToken、最低权限）：单实例的互斥体与管道都在用户会话里。
/// - 同一时刻只跑一份；用电池也跑；1 分钟没退出就结束（根启动器只做判定和拉起，毫秒级）。
pub fn task_xml(launcher: &Path, user: Option<&str>, start: &str) -> String {
    let user_id = user
        .map(|user| format!("<UserId>{}</UserId>", xml_text(user)))
        .unwrap_or_default();
    let repetition = format!(
        "<Repetition><Interval>{INTERVAL}</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>"
    );
    format!(
        concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n",
            "<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">",
            "<RegistrationInfo><Description>{description}</Description></RegistrationInfo>",
            "<Triggers>",
            "<LogonTrigger><Enabled>true</Enabled>{user_id}{repetition}</LogonTrigger>",
            "<TimeTrigger><Enabled>true</Enabled><StartBoundary>{start}</StartBoundary>{repetition}</TimeTrigger>",
            "</Triggers>",
            "<Principals><Principal id=\"Author\">{user_id}",
            "<LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>",
            "<Settings>",
            "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
            "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
            "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
            "<AllowHardTerminate>true</AllowHardTerminate>",
            "<StartWhenAvailable>false</StartWhenAvailable>",
            "<RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
            "<IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>",
            "<AllowStartOnDemand>true</AllowStartOnDemand>",
            "<Enabled>true</Enabled><Hidden>false</Hidden>",
            "<RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun>",
            "<ExecutionTimeLimit>PT1M</ExecutionTimeLimit>",
            "<Priority>7</Priority>",
            "</Settings>",
            "<Actions Context=\"Author\"><Exec><Command>{command}</Command>",
            "<Arguments>{arguments}</Arguments></Exec></Actions>",
            "</Task>\n",
        ),
        description =
            xml_text("ATM 异常退出后自动重新打开（每 5 分钟看一次；你从托盘退出时不打开）。"),
        user_id = user_id,
        repetition = repetition,
        start = xml_text(start),
        command = xml_text(&launcher.display().to_string()),
        arguments = ENSURE_RUNNING,
    )
}

/// 这份任务定义是不是跑这个根启动器的：卸载、回滚只删自己的任务，同名的别的安装的任务留着。
pub fn runs_launcher(xml: &str, launcher: &Path) -> bool {
    xml.contains(&format!(
        "<Command>{}</Command>",
        xml_text(&launcher.display().to_string())
    ))
}

/// 一个打包进来的程序（`<安装根>\app-<v>\…\x.exe`）所在的安装根：往上三层内带 `app.json` 的那一层。
/// 开发构建、便携版没有：它们不注册任务，也就没有自动恢复。
pub fn install_root_of(exe: &Path) -> Option<PathBuf> {
    exe.ancestors()
        .skip(1)
        .take(3)
        .find(|dir| dir.join(crate::APP_POINTER).is_file())
        .map(Path::to_path_buf)
}

/// setup 注册（或删除）任务的结果。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
    /// 任务在、指向这个安装的根启动器：只有这时才有「崩溃后自动恢复」。
    pub registered: bool,
    pub at: String,
    /// 没注册的原因：注册失败的原文，或「当前版本不是 3.x」。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

pub fn read_registration(install_root: &Path) -> Option<Registration> {
    crate::read_json_limited(
        &install_root.join(crate::STATE_DIR).join(REGISTRATION_FILE),
        MAX_BYTES,
    )
    .ok()
    .flatten()
}

pub fn write_registration(install_root: &Path, registration: &Registration) -> io::Result<()> {
    let bytes = serde_json::to_vec(registration).map_err(io::Error::other)?;
    crate::durable::write_atomic(
        &install_root.join(crate::STATE_DIR).join(REGISTRATION_FILE),
        &bytes,
    )
}

/// 一次异常退出（宿主的 `lifecycle-state.json` 停在 `clean:false`，又不是会话结束）。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AbnormalExit {
    pub run_id: String,
    pub at_ms: u64,
}

/// 熔断（`N\runtime\keepalive.json`）。
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Breaker {
    /// 窗口内的异常退出，同一个 `runId` 只记一次。
    #[serde(default)]
    pub exits: Vec<AbnormalExit>,
    /// 熔断的时刻；用户自己启动一次才复位。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tripped_at_ms: Option<u64>,
}

impl Breaker {
    /// 记一次异常退出，丢掉窗口外的；够 [`BREAKER_LIMIT`] 次就熔断。同一个 `runId` 再报一次不算新的。
    pub fn record(&mut self, run_id: &str, now_ms: u64) {
        self.exits
            .retain(|exit| now_ms.saturating_sub(exit.at_ms) < BREAKER_WINDOW_MS);
        if !self.exits.iter().any(|exit| exit.run_id == run_id) {
            self.exits.push(AbnormalExit {
                run_id: run_id.to_owned(),
                at_ms: now_ms,
            });
        }
        if self.tripped_at_ms.is_none() && self.exits.len() >= BREAKER_LIMIT {
            self.tripped_at_ms = Some(now_ms);
        }
    }

    pub fn tripped(&self) -> bool {
        self.tripped_at_ms.is_some()
    }
}

/// 读不出来（坏了、太大）按没有算：最多再拉起 [`BREAKER_LIMIT`] 次就又熔断，不会无限重启。
pub fn read_breaker(n: &Path) -> Breaker {
    crate::read_json_limited(&runtime(n).join(BREAKER_FILE), MAX_BYTES)
        .ok()
        .flatten()
        .unwrap_or_default()
}

pub fn write_breaker(n: &Path, breaker: &Breaker) -> io::Result<()> {
    let bytes = serde_json::to_vec(breaker).map_err(io::Error::other)?;
    crate::durable::write_atomic(&runtime(n).join(BREAKER_FILE), &bytes)
}

/// 用户自己启动时（宿主）：复位熔断。返回复位前的状态，熔断过的要用通知告诉用户原因。
pub fn reset_breaker(n: &Path) -> Option<Breaker> {
    let previous = read_breaker(n);
    let path = runtime(n).join(BREAKER_FILE);
    match std::fs::remove_file(&path) {
        Ok(()) => previous.tripped().then_some(previous),
        Err(_) => None,
    }
}

/// 用户在托盘点了「完全退出」。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserQuit {
    /// 那一次登录会话（LUID，十六进制）。
    pub logon: String,
    pub at: String,
}

pub fn mark_user_quit(n: &Path, quit: &UserQuit) -> io::Result<()> {
    let bytes = serde_json::to_vec(quit).map_err(io::Error::other)?;
    crate::durable::write_atomic(&runtime(n).join(USER_QUIT_FILE), &bytes)
}

pub fn clear_user_quit(n: &Path) {
    let _ = std::fs::remove_file(runtime(n).join(USER_QUIT_FILE));
}

/// 标记还管不管这一次：同一次登录才管。不知道当前登录（读不出 LUID）时按管算——宁可不拉起，也不违背用户的退出。
/// 读不出标记本身（坏了）按没有算：那不是用户留下的意思。
pub fn user_quit_applies(n: &Path, logon: Option<&str>) -> bool {
    match crate::read_json_limited::<UserQuit>(&runtime(n).join(USER_QUIT_FILE), MAX_BYTES) {
        Ok(Some(quit)) => logon.is_none_or(|logon| logon == quit.logon),
        _ => false,
    }
}

/// 当前进程所在的登录会话（token 的 AuthenticationId），每次登录都不同。
#[cfg(windows)]
pub fn logon_id() -> Option<String> {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{
        GetTokenInformation, TOKEN_QUERY, TOKEN_STATISTICS, TokenStatistics,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    let mut token: HANDLE = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return None;
    }
    let mut stats: TOKEN_STATISTICS = unsafe { std::mem::zeroed() };
    let mut returned = 0u32;
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenStatistics,
            (&mut stats as *mut TOKEN_STATISTICS).cast(),
            std::mem::size_of::<TOKEN_STATISTICS>() as u32,
            &mut returned,
        )
    };
    unsafe { CloseHandle(token) };
    (ok != 0).then(|| {
        format!(
            "{:08x}{:08x}",
            stats.AuthenticationId.HighPart as u32, stats.AuthenticationId.LowPart
        )
    })
}

#[cfg(not(windows))]
pub fn logon_id() -> Option<String> {
    None
}

/// 宿主上一次是怎么结束的（`N\logs\lifecycle-state.json`）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LastExit {
    /// 没有记录，或干净退出（用户退出、setup 的 QUIT）。
    Clean,
    /// Windows 注销 / 关机结束了它：不是崩溃。
    SessionEnd,
    /// 异常：崩溃、看门狗、被杀。
    Abnormal { run_id: String },
}

pub fn last_exit(n: &Path) -> LastExit {
    let state = crate::read_json_limited::<serde_json::Value>(
        &n.join("logs").join("lifecycle-state.json"),
        MAX_BYTES,
    )
    .ok()
    .flatten();
    let Some(state) = state else {
        return LastExit::Clean;
    };
    if state.get("clean") != Some(&serde_json::Value::Bool(false)) {
        return LastExit::Clean;
    }
    if state.get("event").and_then(|e| e.as_str()) == Some("session-end") {
        return LastExit::SessionEnd;
    }
    match state.get("runId").and_then(|r| r.as_str()) {
        Some(run_id) => LastExit::Abnormal {
            run_id: run_id.to_owned(),
        },
        None => LastExit::Clean,
    }
}

/// `--ensure-running` 这一次怎么办。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    /// 安装事务没结束（屏障在）：不拉起，也不跑恢复、不弹窗——那是用户或 setup 的事。
    InstallBusy,
    /// 没装（没有指针），或装着的不是 3.x（2.x 不认这个入口；Electron 1.x）。
    NotOurs,
    /// 已经在跑。
    Running,
    /// 用户这次登录里主动退出过。
    UserQuit,
    /// 熔断了：等用户自己启动。
    Tripped,
    /// 拉起当前版本。
    Launch,
}

/// 判定所需的事实（调用方读，判定本身不碰文件）。
#[derive(Clone, Debug)]
pub struct Facts {
    pub install_busy: bool,
    /// `app.json.current` 是 3.x，且那个版本的宿主文件在。
    pub current_v3: bool,
    pub running: bool,
    pub user_quit: bool,
    pub last_exit: LastExit,
}

/// 判定；异常退出记进熔断（由调用方写回）。顺序：屏障 → 版本 → 在跑 → 用户退出 → 熔断。
pub fn decide(facts: &Facts, breaker: &mut Breaker, now_ms: u64) -> Decision {
    if facts.install_busy {
        return Decision::InstallBusy;
    }
    if !facts.current_v3 {
        return Decision::NotOurs;
    }
    if facts.running {
        return Decision::Running;
    }
    if facts.user_quit {
        return Decision::UserQuit;
    }
    if let LastExit::Abnormal { run_id } = &facts.last_exit {
        breaker.record(run_id, now_ms);
    }
    if breaker.tripped() {
        return Decision::Tripped;
    }
    Decision::Launch
}

const LOG_FILE: &str = "keepalive.log";
const LOG_BYTES: u64 = 64 * 1024;

/// `N\logs\keepalive.log`：拉起、熔断、用户退出、屏障在。正常的「在跑」不记（每 5 分钟一次，没有信息）。
/// 超过 64 KiB 换成 `keepalive.log.1`，最多两份。写不进去不影响判定。
pub fn log(n: &Path, now_ms: u64, line: &str) {
    use std::io::Write;
    let dir = n.join("logs");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(LOG_FILE);
    if std::fs::metadata(&path).is_ok_and(|meta| meta.len() > LOG_BYTES) {
        let _ = std::fs::rename(&path, dir.join(format!("{LOG_FILE}.1")));
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(
            file,
            "{} pid={} {line}",
            crate::startup::iso_utc(now_ms),
            std::process::id()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn dir(name: &str) -> PathBuf {
        let d = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("target")
            .join("install-state-tests")
            .join("keepalive")
            .join(name);
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("runtime")).unwrap();
        d
    }

    const T: u64 = 1_791_000_000_000;
    const MIN: u64 = 60_000;

    /// 任务定义：根启动器 + `--ensure-running`，登录触发与从安装时起的重复触发都在，每 5 分钟；只以当前用户的
    /// 交互身份、最低权限跑；同一时刻一份。路径与用户名里的 XML 特殊字符被转义。
    #[test]
    fn the_task_runs_the_root_launcher_every_five_minutes_as_the_user() {
        let xml = task_xml(
            Path::new(r"C:\Users\a&b\AppData\Local\AyanamiTaskManager\AyanamiTaskManager.exe"),
            Some(r"PC\a&b"),
            "2026-10-11T12:00:00Z",
        );
        assert!(xml.contains(
            r"<Command>C:\Users\a&amp;b\AppData\Local\AyanamiTaskManager\AyanamiTaskManager.exe</Command>"
        ));
        assert!(xml.contains("<Arguments>--ensure-running</Arguments>"));
        assert_eq!(xml.matches("<Interval>PT5M</Interval>").count(), 2);
        assert!(xml.contains("<LogonTrigger>") && xml.contains("<TimeTrigger>"));
        assert!(xml.contains("<StartBoundary>2026-10-11T12:00:00Z</StartBoundary>"));
        assert_eq!(xml.matches(r"<UserId>PC\a&amp;b</UserId>").count(), 2);
        assert!(xml.contains("<LogonType>InteractiveToken</LogonType>"));
        assert!(xml.contains("<RunLevel>LeastPrivilege</RunLevel>"));
        assert!(xml.contains("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"));
        assert!(!xml.contains("a&b"), "unescaped");
        assert!(runs_launcher(
            &xml,
            Path::new(r"C:\Users\a&b\AppData\Local\AyanamiTaskManager\AyanamiTaskManager.exe")
        ));
        assert!(!runs_launcher(
            &xml,
            Path::new(r"D:\Other\AyanamiTaskManager.exe")
        ));
        // 不知道用户名时不写 UserId（注册时按调用者）。
        assert!(!task_xml(Path::new("x"), None, "s").contains("<UserId>"));
    }

    /// 熔断：30 分钟内三次不同的异常退出才熔断；同一个 runId 报两次算一次；窗口外的不算。
    #[test]
    fn three_abnormal_exits_in_thirty_minutes_trip_the_breaker() {
        let mut b = Breaker::default();
        b.record("r1", T);
        b.record("r1", T + MIN);
        b.record("r2", T + 2 * MIN);
        assert!(!b.tripped(), "{b:?}");
        b.record("r3", T + 29 * MIN);
        assert!(b.tripped());
        assert_eq!(b.tripped_at_ms, Some(T + 29 * MIN));

        let mut slow = Breaker::default();
        slow.record("a", T);
        slow.record("b", T + 20 * MIN);
        slow.record("c", T + 31 * MIN);
        assert!(
            !slow.tripped(),
            "the first one fell out of the window: {slow:?}"
        );
        assert_eq!(slow.exits.len(), 2);
    }

    /// 熔断跨进程：写下去、另一个进程读回来一样；坏文件按没有算（最多再拉起三次）。复位只在熔断过时报给宿主。
    #[test]
    fn the_breaker_survives_the_process_and_is_reset_by_the_user() {
        let n = dir("breaker");
        let mut b = Breaker::default();
        for (i, id) in ["r1", "r2", "r3"].iter().enumerate() {
            b.record(id, T + i as u64);
        }
        write_breaker(&n, &b).unwrap();
        assert_eq!(read_breaker(&n), b);
        assert_eq!(reset_breaker(&n), Some(b));
        assert_eq!(read_breaker(&n), Breaker::default());
        assert_eq!(reset_breaker(&n), None, "nothing to reset");

        let mut once = Breaker::default();
        once.record("r1", T);
        write_breaker(&n, &once).unwrap();
        assert_eq!(
            reset_breaker(&n),
            None,
            "not tripped: nothing to tell the user"
        );

        fs::write(n.join("runtime").join("keepalive.json"), b"{nope").unwrap();
        assert_eq!(read_breaker(&n), Breaker::default());
    }

    /// 用户退出只管同一次登录；不知道当前登录时按管算；坏标记不算用户的意思。
    #[test]
    fn a_user_quit_holds_only_for_that_logon() {
        let n = dir("user-quit");
        assert!(!user_quit_applies(&n, Some("a")));
        mark_user_quit(
            &n,
            &UserQuit {
                logon: "a".into(),
                at: "x".into(),
            },
        )
        .unwrap();
        assert!(user_quit_applies(&n, Some("a")));
        assert!(!user_quit_applies(&n, Some("b")), "another logon");
        assert!(
            user_quit_applies(&n, None),
            "unknown logon: keep the user's quit"
        );
        clear_user_quit(&n);
        assert!(!user_quit_applies(&n, Some("a")));
        fs::write(n.join("runtime").join("user-quit.json"), b"{nope").unwrap();
        assert!(!user_quit_applies(&n, None));
    }

    #[test]
    fn the_logon_id_is_this_sessions_and_stable() {
        let id = logon_id().expect("the process token has statistics");
        assert_eq!(id.len(), 16);
        assert_eq!(logon_id().as_deref(), Some(id.as_str()));
    }

    /// 上一次怎么结束的：没记录、干净退出都不是崩溃；会话结束（注销、关机）不是崩溃；其余 `clean:false` 是。
    #[test]
    fn the_last_exit_is_read_from_the_hosts_lifecycle_state() {
        let n = dir("last-exit");
        assert_eq!(last_exit(&n), LastExit::Clean);
        let state = |body: &str| {
            fs::create_dir_all(n.join("logs")).unwrap();
            fs::write(n.join("logs").join("lifecycle-state.json"), body).unwrap();
        };
        state(r#"{"runId":"r1","event":"exit","clean":true}"#);
        assert_eq!(last_exit(&n), LastExit::Clean);
        state(r#"{"runId":"r1","event":"session-end","clean":false}"#);
        assert_eq!(last_exit(&n), LastExit::SessionEnd);
        state(r#"{"runId":"r1","event":"watchdog.stall","clean":false}"#);
        assert_eq!(
            last_exit(&n),
            LastExit::Abnormal {
                run_id: "r1".into()
            }
        );
    }

    fn facts() -> Facts {
        Facts {
            install_busy: false,
            current_v3: true,
            running: false,
            user_quit: false,
            last_exit: LastExit::Abnormal {
                run_id: "r1".into(),
            },
        }
    }

    /// 判定的先后：屏障 → 版本 → 在跑 → 用户退出 → 熔断 → 拉起。只有真要拉起前才把异常退出记进熔断。
    #[test]
    fn the_decision_honours_the_barrier_the_user_and_the_breaker_in_that_order() {
        let mut b = Breaker::default();
        let mut f = facts();
        f.install_busy = true;
        f.running = true;
        assert_eq!(decide(&f, &mut b, T), Decision::InstallBusy);
        f.install_busy = false;
        f.current_v3 = false;
        assert_eq!(decide(&f, &mut b, T), Decision::NotOurs);
        f.current_v3 = true;
        assert_eq!(decide(&f, &mut b, T), Decision::Running);
        f.running = false;
        f.user_quit = true;
        assert_eq!(decide(&f, &mut b, T), Decision::UserQuit);
        assert!(
            b.exits.is_empty(),
            "nothing recorded before a launch is decided"
        );

        f.user_quit = false;
        assert_eq!(decide(&f, &mut b, T), Decision::Launch);
        f.last_exit = LastExit::Abnormal {
            run_id: "r2".into(),
        };
        assert_eq!(decide(&f, &mut b, T + MIN), Decision::Launch);
        f.last_exit = LastExit::Abnormal {
            run_id: "r3".into(),
        };
        assert_eq!(decide(&f, &mut b, T + 2 * MIN), Decision::Tripped);
        // 熔断之后：干净退出也不拉起，直到用户自己启动（宿主复位）。
        f.last_exit = LastExit::Clean;
        assert_eq!(decide(&f, &mut b, T + 3 * MIN), Decision::Tripped);
        // 会话结束不算崩溃。
        let mut fresh = Breaker::default();
        f.last_exit = LastExit::SessionEnd;
        assert_eq!(decide(&f, &mut fresh, T), Decision::Launch);
        assert!(fresh.exits.is_empty());
    }

    #[test]
    fn the_log_keeps_two_bounded_files() {
        let n = dir("log");
        let line = "x".repeat(1000);
        for _ in 0..70 {
            log(&n, T, &line);
        }
        let logs = n.join("logs");
        assert!(logs.join("keepalive.log.1").is_file());
        assert!(fs::metadata(logs.join("keepalive.log")).unwrap().len() <= LOG_BYTES + 2048);
    }

    #[test]
    fn a_packaged_program_finds_its_install_root() {
        let root = dir("install-root");
        let exe = root.join("app-3.0.0").join("resources").join("atm.exe");
        assert_eq!(install_root_of(&exe), None, "no app.json: not installed");
        fs::write(root.join(crate::APP_POINTER), br#"{"current":"3.0.0"}"#).unwrap();
        assert_eq!(install_root_of(&exe), Some(root.clone()));
        assert_eq!(
            install_root_of(&root.join("app-3.0.0").join("AyanamiTaskManager.exe")),
            Some(root.clone())
        );
        assert_eq!(
            install_root_of(&root.join("a").join("b").join("c").join("d.exe")),
            None
        );
    }

    #[test]
    fn the_registration_is_read_back() {
        let root = dir("registration");
        assert_eq!(read_registration(&root), None);
        let r = Registration {
            registered: false,
            at: "x".into(),
            reason: Some("KEEPALIVE_REGISTER: denied".into()),
        };
        write_registration(&root, &r).unwrap();
        assert_eq!(read_registration(&root), Some(r));
    }
}
