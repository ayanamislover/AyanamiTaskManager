//! 找到正在运行的服务（06 §6）：
//!
//! 1. `ATM_ENDPOINT` + `ATM_TOKEN` 覆盖，只允许 `http://127.0.0.1[:端口]`；只给一个算错。
//! 2. 否则读 3.0 根 `N`（`ATM3_DATA_DIR`，否则 `%LOCALAPPDATA%\AyanamiTaskManager3`）的 `runtime\daemon.json`，
//!    用 `GET /api/v1/system/status` 在 750 ms 内探活。2.x 根一概不看：3.0 的 CLI 连 2.x 服务会说错话。
//! 3. 连不上时：只有 atm.exe 在安装布局里（`<安装目录>\resources\atm.exe`，旁边一级有 `AyanamiTaskManager.exe`）
//!    才用 `--background --agent-wake` 拉起桌面端，轮询 45 s。开发构建与随便拷走的 atm.exe 不拉起任何东西，
//!    直接报留下的状态。先拉起、再看等不来的状态（与 atm-mcp 一致）：
//!    - `runtime\startup-state.json` 说在等用户选数据来源（07 §7）：立刻报，拉起的宿主会把选择窗口带出来；
//!    - `runtime\damaged.json` 说库读不出（W8h）：只认还在跑的宿主写的（它在文件里记下自己的 pid 与启动
//!      时间，W8 r9 P2-01b）。上一次运行留下的不算——库可能已在 ATM 外换回好的，宿主起来会删掉它
//!      （W8 r8 P2-01）；等到宿主重写它才报，等满还在也报。拉起失败（W8 r9 P2-01a）同没有桌面端，立刻报。
//!
//! 令牌只用在请求头里，从不打印、不写日志。

use crate::http;
use atm_store::conversion::{DamagedState, Layout, StartupState, read_damaged, read_startup_state};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const PROBE_TIMEOUT: Duration = Duration::from_millis(750);
const WAKE_WAIT: Duration = Duration::from_secs(45);
const POLL_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub port: u16,
    pub token: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Unavailable {
    /// `ATM_ENDPOINT`、`ATM_TOKEN` 只给了一个。
    OverrideIncomplete,
    /// 覆盖的 endpoint 不是回环 http，或令牌不合法。
    OverrideInvalid,
    /// 找不到 3.0 数据根（没有 `ATM3_DATA_DIR` 也没有 `LOCALAPPDATA`）。
    NoDataRoot,
    /// daemon.json 在，但校验不过。
    DescriptorInvalid,
    /// 宿主在等用户选择数据来源。
    SourceConflict(StartupState),
    /// 已发布的库读不出（W8h）：要用户先从备份恢复，等多久都不会好。
    Damaged(DamagedState),
    /// 没有在跑的服务（拉起过也没等到）。
    NotRunning { woke: bool },
}

impl Unavailable {
    pub fn code(&self) -> &'static str {
        match self {
            Unavailable::OverrideIncomplete => "ATM_RUNTIME_OVERRIDE_INCOMPLETE",
            Unavailable::OverrideInvalid => "ATM_RUNTIME_ENDPOINT_INVALID",
            Unavailable::DescriptorInvalid => "ATM_RUNTIME_DESCRIPTOR_INVALID",
            Unavailable::SourceConflict(_) => "ATM_SOURCE_CONFLICT",
            Unavailable::Damaged(_) => "ATM_DATABASE_DAMAGED",
            Unavailable::NoDataRoot | Unavailable::NotRunning { .. } => "ATM_RUNTIME_UNAVAILABLE",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Unavailable::OverrideIncomplete => {
                "ATM_ENDPOINT 与 ATM_TOKEN 必须同时设置（或都不设置）".into()
            }
            Unavailable::OverrideInvalid => {
                "ATM_ENDPOINT 只能是 http://127.0.0.1:<端口>，ATM_TOKEN 不能为空或含控制字符".into()
            }
            Unavailable::NoDataRoot => {
                "找不到 ATM 数据目录：没有 LOCALAPPDATA；请设置 ATM3_DATA_DIR".into()
            }
            Unavailable::DescriptorInvalid => {
                "服务描述 runtime\\daemon.json 无效：请在托盘退出 ATM 后重新打开".into()
            }
            Unavailable::SourceConflict(s) => format!(
                "ATM 需要用户在窗口里选择数据来源（{}）：请打开 ATM 窗口处理后再试",
                s.reason
            ),
            Unavailable::Damaged(s) => format!(
                "ATM 的数据库读不出（{}）：请从托盘完全退出 ATM，运行 atm recover --offline 从备份恢复后再试",
                s.reason
            ),
            Unavailable::NotRunning { woke: true } => {
                "AyanamiTaskManager 服务未运行：已尝试在后台启动，45 秒内没有就绪；请打开 ATM 桌面端".into()
            }
            Unavailable::NotRunning { woke: false } => {
                "AyanamiTaskManager 服务未运行：请先启动 ATM 桌面端".into()
            }
        }
    }
}

/// 3.0 数据根 `N`，与宿主、setup 同一个解析（空的覆盖值当作没设）。
pub fn data_root() -> Option<PathBuf> {
    atm_install_state::startup::v3_root().ok()
}

pub fn startup_state(root: &Path) -> Option<StartupState> {
    read_startup_state(&Layout::new(root))
}

pub fn damaged(root: &Path) -> Option<DamagedState> {
    read_damaged(&Layout::new(root))
}

/// 等不来的两种状态：等用户选数据来源，或等用户从备份恢复。
fn awaiting_user(root: &Path) -> Option<Unavailable> {
    startup_state(root)
        .map(Unavailable::SourceConflict)
        .or_else(|| damaged(root).map(Unavailable::Damaged))
}

/// 损坏状态是还在跑的宿主写的：文件里记的写入者（pid 与启动时间）就是现在活着的那个进程。
/// 宿主每次判定库读不出都会重写它；不看文件时间（时钟可能回拨、文件时间可能被复制带过来）。
fn damaged_by_the_running_host(root: &Path) -> Option<DamagedState> {
    let state = damaged(root)?;
    let writer = state.writer?;
    let host = atm_install_state::procs::find(writer.pid)?;
    (host.started_at_ms() == writer.started_at_ms).then_some(state)
}

pub fn discover() -> Result<Target, Unavailable> {
    let endpoint = std::env::var("ATM_ENDPOINT").ok().filter(|v| !v.is_empty());
    let token = std::env::var("ATM_TOKEN").ok().filter(|v| !v.is_empty());
    match (endpoint, token) {
        (Some(endpoint), Some(token)) => {
            return match parse_endpoint(&endpoint) {
                Endpoint::Loopback(port) if valid_token(&token) => Ok(Target { port, token }),
                _ => Err(Unavailable::OverrideInvalid),
            };
        }
        (Some(_), None) | (None, Some(_)) => return Err(Unavailable::OverrideIncomplete),
        (None, None) => {}
    }
    let root = data_root().ok_or(Unavailable::NoDataRoot)?;
    let desktop = std::env::current_exe()
        .ok()
        .as_deref()
        .and_then(desktop_executable);
    connect(&root, desktop.as_deref(), &mut wake, WAKE_WAIT)
}

/// 探活；不在跑就拉起 `desktop`（没有、或拉不起来，就直接报留下的状态），再轮询到 `wait`。见模块说明第 3 条。
fn connect(
    root: &Path,
    desktop: Option<&Path>,
    wake: &mut dyn FnMut(&Path) -> bool,
    wait: Duration,
) -> Result<Target, Unavailable> {
    if let Some(target) = live(root)? {
        return Ok(target);
    }
    if !desktop.is_some_and(wake) {
        return Err(awaiting_user(root).unwrap_or(Unavailable::NotRunning { woke: false }));
    }
    let deadline = Instant::now() + wait;
    loop {
        if let Some(state) = startup_state(root) {
            return Err(Unavailable::SourceConflict(state));
        }
        if let Some(state) = damaged_by_the_running_host(root) {
            return Err(Unavailable::Damaged(state));
        }
        if Instant::now() >= deadline {
            return Err(damaged(root)
                .map(Unavailable::Damaged)
                .unwrap_or(Unavailable::NotRunning { woke: true }));
        }
        std::thread::sleep(POLL_INTERVAL);
        if let Some(target) = live(root)? {
            return Ok(target);
        }
    }
}

/// daemon.json 指向的服务探活通过就返回它；没有描述、或探不通，返回 None；描述无效是错误。
fn live(root: &Path) -> Result<Option<Target>, Unavailable> {
    let Some(descriptor) = read_descriptor(root)? else {
        return Ok(None);
    };
    let target = Target {
        port: descriptor.port,
        token: descriptor.token,
    };
    Ok(probe(&target).then_some(target))
}

fn probe(target: &Target) -> bool {
    http::request(
        target.port,
        "GET",
        "/api/v1/system/status",
        &target.token,
        None,
        PROBE_TIMEOUT,
    )
    .is_ok_and(|r| r.status == 200)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Descriptor {
    pub port: u16,
    pub token: String,
    pub pid: u32,
}

/// `N\runtime\daemon.json`。不存在是 `Ok(None)`；读不出、不是 JSON、字段不合格是 [`Unavailable::DescriptorInvalid`]。
pub fn read_descriptor(root: &Path) -> Result<Option<Descriptor>, Unavailable> {
    let path = root.join("runtime").join("daemon.json");
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(Unavailable::DescriptorInvalid),
    };
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| Unavailable::DescriptorInvalid)?;
    parse_descriptor(&value)
        .map(Some)
        .ok_or(Unavailable::DescriptorInvalid)
}

/// 与 atm-mcp 桥同一套校验（`descriptor.rs::parse`）：回环 endpoint、令牌 1–512 个 UTF-16 单元且没有控制字符、
/// 安全正整数 pid、32 位小写十六进制实例 id、非空 version；3.x 加的 layout / generation 出现时也核对。
pub fn parse_descriptor(value: &Value) -> Option<Descriptor> {
    let map = value.as_object()?;
    let port = match parse_endpoint(map.get("endpoint")?.as_str()?) {
        Endpoint::Loopback(port) => port,
        _ => return None,
    };
    let token = map.get("token")?.as_str()?;
    if !valid_token(token) {
        return None;
    }
    let pid = u32::try_from(safe_positive_integer(map.get("pid")?)?).ok()?;
    let instance_ok = map
        .get("instanceId")
        .and_then(Value::as_str)
        .is_some_and(|id| {
            id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        });
    let version_ok = map
        .get("version")
        .and_then(Value::as_str)
        .is_some_and(|v| !v.is_empty());
    let layout_ok = map
        .get("layout")
        .is_none_or(|v| v.as_str() == Some("single"));
    let generation_ok = map
        .get("generation")
        .is_none_or(|v| safe_positive_integer(v).is_some());
    (instance_ok && version_ok && layout_ok && generation_ok).then(|| Descriptor {
        port,
        token: token.to_owned(),
        pid,
    })
}

fn valid_token(token: &str) -> bool {
    !token.is_empty() && token.encode_utf16().count() <= 512 && !token.chars().any(char::is_control)
}

/// `Number.isSafeInteger(x) && x > 0`。
fn safe_positive_integer(value: &Value) -> Option<u64> {
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    let number = value.as_f64()?;
    (number.fract() == 0.0 && number > 0.0 && number <= MAX_SAFE).then_some(number as u64)
}

#[derive(Debug, PartialEq, Eq)]
pub enum Endpoint {
    Loopback(u16),
    Rejected,
}

/// 只认服务发布的那个形状：`http://127.0.0.1:<端口>`，可带一个结尾斜杠。比 WHATWG URL 解析窄
/// （那会把 `127.1`、`0x7f.0.0.1` 也规范化成回环）：这里决定令牌往哪儿发。
pub fn parse_endpoint(raw: &str) -> Endpoint {
    let text = raw.trim_matches(|c: char| c <= ' ');
    let Some(rest) = text
        .get(..7)
        .filter(|s| s.eq_ignore_ascii_case("http://"))
        .map(|_| &text[7..])
    else {
        return Endpoint::Rejected;
    };
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    let (host, port) = match rest.rsplit_once(':') {
        Some((host, digits))
            if !digits.is_empty()
                && digits.len() <= 5
                && digits.bytes().all(|b| b.is_ascii_digit()) =>
        {
            match digits.parse::<u32>() {
                Ok(p) if p <= 65_535 => (host, p as u16),
                _ => return Endpoint::Rejected,
            }
        }
        Some(_) => return Endpoint::Rejected,
        None => (rest, 80),
    };
    if host != "127.0.0.1" {
        return Endpoint::Rejected;
    }
    Endpoint::Loopback(port)
}

/// `process.kill(pid, 0)` 的口径：拒绝访问也算活着。
#[cfg(windows)]
pub fn pid_alive(pid: u32) -> bool {
    use std::ffi::c_void;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const ERROR_ACCESS_DENIED: u32 = 5;
    const STILL_ACTIVE: u32 = 259;
    const WAIT_OBJECT_0: u32 = 0;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn GetExitCodeProcess(handle: *mut c_void, code: *mut u32) -> i32;
        fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn GetLastError() -> u32;
    }
    // SAFETY: 普通的 Win32 调用；打开过的句柄在每条路径上都关掉。
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return GetLastError() == ERROR_ACCESS_DENIED;
        }
        let mut code = 0;
        let running = GetExitCodeProcess(handle, &mut code) != 0
            && code == STILL_ACTIVE
            && WaitForSingleObject(handle, 0) != WAIT_OBJECT_0;
        CloseHandle(handle);
        running
    }
}

#[cfg(not(windows))]
pub fn pid_alive(pid: u32) -> bool {
    Path::new("/proc").join(pid.to_string()).exists()
}

/// `<安装目录>\resources\atm.exe` 旁边一级的 `<安装目录>\AyanamiTaskManager.exe`（与 atm-mcp 同一个位置关系）。
pub fn desktop_executable(cli: &Path) -> Option<PathBuf> {
    let resources = cli.parent()?;
    if !resources
        .file_name()
        .is_some_and(|n| n.eq_ignore_ascii_case("resources"))
    {
        return None;
    }
    let desktop = resources.parent()?.join("AyanamiTaskManager.exe");
    desktop.is_file().then_some(desktop)
}

/// 隐藏地拉起桌面端（不带窗口、自成进程组），返回拉起了没有。
fn wake(desktop: &Path) -> bool {
    let mut command = std::process::Command::new(desktop);
    command
        .args(["--background", "--agent-wake"])
        .env_remove("ELECTRON_RUN_AS_NODE")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // 不用 DETACHED_PROCESS：分离的控制台程序再起控制台子进程会弹窗（W8k）。
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }
    command.spawn().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn descriptor() -> Value {
        json!({
            "endpoint": "http://127.0.0.1:60092",
            "token": "t0ken",
            "pid": 4242,
            "instanceId": "0123456789abcdef0123456789abcdef",
            "version": "3.0.0",
            "layout": "single",
            "generation": 2
        })
    }

    fn with(key: &str, value: Value) -> Value {
        let mut d = descriptor();
        d[key] = value;
        d
    }

    #[test]
    fn the_descriptor_is_validated_like_the_bridge() {
        assert_eq!(
            parse_descriptor(&descriptor()),
            Some(Descriptor {
                port: 60092,
                token: "t0ken".into(),
                pid: 4242
            })
        );
        for (key, value) in [
            ("endpoint", json!("https://127.0.0.1:1")),
            ("endpoint", json!("http://localhost:1")),
            ("endpoint", json!("http://127.0.0.1:1/mcp")),
            ("token", json!("")),
            ("token", json!("a\r\nInjected: 1")),
            ("token", json!("x".repeat(513))),
            ("pid", json!(0)),
            ("pid", json!(1.5)),
            ("instanceId", json!("0123")),
            ("version", json!("")),
            ("layout", json!("host-and-core")),
            ("generation", json!("1")),
        ] {
            assert_eq!(
                parse_descriptor(&with(key, value.clone())),
                None,
                "{key}={value}"
            );
        }
    }

    #[test]
    fn endpoints_only_point_at_loopback_http() {
        use Endpoint::*;
        assert_eq!(parse_endpoint("http://127.0.0.1:1"), Loopback(1));
        assert_eq!(parse_endpoint("HTTP://127.0.0.1:1/"), Loopback(1));
        assert_eq!(parse_endpoint("http://127.0.0.1"), Loopback(80));
        for rejected in [
            "https://127.0.0.1:1",
            "http://localhost:1",
            "http://127.0.0.2:1",
            "http://user:pw@127.0.0.1:1",
            "http://127.0.0.1:1/x",
            "http://127.0.0.1:1?q",
            "http://127.1:1",
            "http://127.0.0.1:99999",
            "http://127.0.0.1:",
            "127.0.0.1:1",
            "",
        ] {
            assert_eq!(parse_endpoint(rejected), Rejected, "{rejected}");
        }
    }

    #[test]
    fn only_the_installed_layout_wakes_the_desktop() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("target")
            .join(format!("cli-layout-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("resources")).unwrap();
        std::fs::write(root.join("AyanamiTaskManager.exe"), b"").unwrap();
        let installed = root.join("resources").join("atm.exe");
        assert_eq!(
            desktop_executable(&installed),
            Some(root.join("AyanamiTaskManager.exe"))
        );
        // 开发构建（target\debug\atm.exe）或拷到别处的 atm.exe：上一级就算有 AyanamiTaskManager.exe，
        // 所在目录不是 resources 也不拉起。
        std::fs::create_dir_all(root.join("debug")).unwrap();
        assert_eq!(
            desktop_executable(&root.join("debug").join("atm.exe")),
            None
        );
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(desktop_executable(&installed), None);
    }

    fn scratch_root(name: &str) -> PathBuf {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("target")
            .join(format!("cli-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("runtime")).unwrap();
        root
    }

    fn leave_damaged(root: &Path, reason: &str, writer: Option<atm_store::conversion::Writer>) {
        atm_store::conversion::enter_damaged(
            &Layout::new(root),
            "G",
            reason,
            "2026-10-14T00:00:00.000Z",
            writer,
        )
        .unwrap();
    }

    /// 这个测试进程扮演「在跑的宿主」。
    fn this_process() -> atm_store::conversion::Writer {
        atm_store::conversion::Writer {
            pid: std::process::id(),
            started_at_ms: atm_install_state::procs::find(std::process::id())
                .unwrap()
                .started_at_ms(),
        }
    }

    /// W8 r8 P2-01：宿主没在跑、留着上一次的损坏状态时，先拉起宿主；那份旧状态不当真，
    /// 宿主起来删掉它（库在 ATM 外换回了好的）就不报损坏。等满了它还在，才照旧报出来。
    /// W8 r9 P2-01a：拉不起来（桌面端在、但启动失败）同没有桌面端，立刻报。
    #[test]
    fn a_leftover_damaged_state_wakes_the_host_first() {
        let root = scratch_root("leftover-damaged");
        let desktop = root.join("AyanamiTaskManager.exe");
        leave_damaged(&root, "old", None);

        // 宿主起来、删掉了旧状态：没有损坏可报，只是这里没有服务可连。
        let mut woke = 0;
        let got = connect(
            &root,
            Some(&desktop),
            &mut |d| {
                assert_eq!(d, desktop);
                woke += 1;
                std::fs::remove_file(root.join("runtime").join("damaged.json")).unwrap();
                true
            },
            Duration::from_millis(300),
        );
        assert_eq!(woke, 1);
        assert_eq!(got, Err(Unavailable::NotRunning { woke: true }));

        // 宿主一直没起来：旧状态等满才报，不是一看到就报。
        leave_damaged(&root, "old", None);
        let started = Instant::now();
        let mut woke = 0;
        let got = connect(
            &root,
            Some(&desktop),
            &mut |_| {
                woke += 1;
                true
            },
            Duration::from_millis(300),
        );
        assert_eq!(woke, 1);
        assert!(started.elapsed() >= Duration::from_millis(300));
        assert!(matches!(got, Err(Unavailable::Damaged(s)) if s.reason == "old"));

        // 拉不起宿主：开发构建没有桌面端，或者桌面端在、启动失败。留下的状态就是全部答案，立刻报。
        for desktop in [None, Some(desktop.as_path())] {
            let started = Instant::now();
            let got = connect(&root, desktop, &mut |_| false, Duration::from_secs(5));
            assert!(started.elapsed() < Duration::from_secs(2), "{desktop:?}");
            assert!(matches!(got, Err(Unavailable::Damaged(_))), "{desktop:?}");
        }
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// W8 r9 P2-01b：还在跑的宿主写的（文件里的写入者就是活着的那个进程）当真、立刻报；写入者不在了、
    /// 或者没记写入者，都当作上一次留下的，等。文件时间不算数：时间在将来也不当真。
    #[test]
    fn only_a_damaged_state_written_by_the_running_host_is_reported_at_once() {
        let root = scratch_root("host-damaged");
        let desktop = root.join("AyanamiTaskManager.exe");
        let me = this_process();
        leave_damaged(&root, "fresh", Some(me));
        let started = Instant::now();
        let got = connect(&root, Some(&desktop), &mut |_| true, Duration::from_secs(5));
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(matches!(got, Err(Unavailable::Damaged(s)) if s.reason == "fresh"));

        let waits = |writer| {
            leave_damaged(&root, "stale", writer);
            let started = Instant::now();
            let got = connect(
                &root,
                Some(&desktop),
                &mut |_| true,
                Duration::from_millis(300),
            );
            assert!(matches!(got, Err(Unavailable::Damaged(_))));
            started.elapsed() >= Duration::from_millis(300)
        };
        // 同一个 pid、启动时间不同：是复用了这个 pid 的另一个进程。
        let reused = atm_store::conversion::Writer {
            started_at_ms: me.started_at_ms - 1,
            ..me
        };
        assert!(waits(Some(reused)));
        assert!(waits(None));
        // 没记写入者、文件时间在将来：照样等。
        leave_damaged(&root, "stale", None);
        std::fs::File::options()
            .write(true)
            .open(root.join("runtime").join("damaged.json"))
            .unwrap()
            .set_modified(std::time::SystemTime::now() + Duration::from_secs(3_600))
            .unwrap();
        let started = Instant::now();
        let _ = connect(
            &root,
            Some(&desktop),
            &mut |_| true,
            Duration::from_millis(300),
        );
        assert!(started.elapsed() >= Duration::from_millis(300));

        // W8 r10 P2-01c：主体坏了、writer 却有效：是坏文件，同样等，等满报「损坏状态本身坏了」（与桥一致）。
        let writer = serde_json::json!({ "pid": me.pid, "startedAtMs": me.started_at_ms });
        for body in [
            serde_json::json!({ "writer": writer }),
            serde_json::json!({ "state": "OTHER", "since": "s", "generation": "G", "reason": "r", "writer": writer }),
            serde_json::json!({ "state": "DATABASE_DAMAGED", "since": "s", "generation": "G", "reason": 7, "writer": writer }),
        ] {
            std::fs::write(root.join("runtime").join("damaged.json"), body.to_string()).unwrap();
            let started = Instant::now();
            let got = connect(
                &root,
                Some(&desktop),
                &mut |_| true,
                Duration::from_millis(300),
            );
            assert!(started.elapsed() >= Duration::from_millis(300), "{body}");
            assert!(
                matches!(&got, Err(Unavailable::Damaged(s)) if s.reason == "the damaged state is corrupt"),
                "{body}: {got:?}"
            );
        }
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn this_process_is_alive_and_an_absurd_pid_is_not() {
        assert!(pid_alive(std::process::id()));
        assert!(!pid_alive(0xFFFF_FFF1));
    }
}
