//! 会话进程（2.x `process.ts`、`process-identity.ts`、`launch.ts` 的 `spawnSession`），都直接调 Windows：
//!
//! - **拉起**：`CreateProcessW`，`CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP`、`SW_HIDE`：会话有自己的、没有窗口的
//!   控制台，它再起的控制台程序（`claude.cmd` 经 cmd 起的 node、git 等）都继承这个控制台、不弹窗。不用
//!   `DETACHED_PROCESS`：那样会话没有控制台，它的每个控制台子进程都会新开一个可见窗口（W8k）。能脱离宿主的作业就脱离，宿主退出后会话照常跑完。只继承三个句柄：stdin 管道的读端、
//!   两份日志（`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`），绝不把宿主别的管道带进一个常驻的子进程。
//! - **出生标识**：`win32:<FILETIME>`，即 `GetProcessTimes` 的创建时刻原值（100 ns 整数）。与 2.x 用 PowerShell 打印的
//!   `StartTime.ToFileTimeUtc()` 是同一个数，2.x 记下的标识照样能核对。
//! - **结束进程树**：`taskkill /PID <pid> /T /F`，退出码 128 是「进程不在」（文案随系统语言变，只认退出码；
//!   给人看的文案按 OEM 代码页解码）。按 PID 结束之前，调用方必须持有这个进程（本宿主起的 [`Child`]，或接管的会话
//!   经 [`Probe::hold`] 打开的 [`Held`]）：只要进程对象还有句柄，系统就不会把这个 PID 分给别的进程，核对身份与结束
//!   之间 PID 不会换主。

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::launch::LaunchCommand;

/// taskkill 找不到进程时的退出码。
pub const TASKKILL_NOT_FOUND_EXIT_CODE: i32 = 128;
const TASKKILL_TIMEOUT: Duration = Duration::from_secs(15);

/// 结束进程树的结果：系统接受了强制结束；进程本来就不在；没结束掉（`reason` 给人看）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KillResult {
    Killed,
    Gone,
    Failed(String),
}

/// 进程相关的系统调用都走这里，用例注入替身（不向真实 PID 动手、不真查系统）。
pub trait Probe: Send + Sync {
    /// PID 还在（`process.kill(pid, 0)`：进程在但无权查询也算在）。
    fn is_alive(&self, pid: u32) -> bool;
    /// 出生标识；进程不在、无权查询是 `None`。
    fn identity(&self, pid: u32) -> Option<String>;
    /// 结束进程树。调用方要持有这个进程（见模块说明），否则 PID 可能已经换了主。
    fn kill_tree(&self, pid: u32) -> KillResult;
    /// 打开这个 PID 并持有：返回值活着期间句柄不关，PID 不会被系统回收再分配。
    fn hold(&self, pid: u32) -> Hold<'_>;
}

/// [`Probe::hold`] 的结果。
pub enum Hold<'a> {
    /// 没有这个进程。
    Gone,
    /// 进程在，但打不开（无权查询）：身份无法确认。
    Denied,
    Held(Box<dyn Held + 'a>),
}

/// 持有着的进程：存活与出生标识都从同一个句柄读，读到的一定是这一个进程。
pub trait Held: Send {
    /// 还没退出。
    fn alive(&self) -> bool;
    /// 出生标识；读不到是 `None`。
    fn identity(&self) -> Option<String>;
}

/// 2.x `checkProcessIdentity` 的四种结论。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// PID 还活着，且出生标识与记录逐字相同。
    Same,
    /// PID 已经不在。
    Gone,
    /// PID 活着但出生标识不同：原进程已退出、PID 被复用。
    Different,
    /// PID 活着，但记录里没有标识或这次查不到：身份无法确认，不能接管也不能结束。
    Unknown,
}

/// 只凭 PID + 出生标识判断，精确相等，没有任何时间容差。不看日志（日志证明不了 PID 归属）。
pub fn check(probe: &dyn Probe, pid: u32, recorded: Option<&str>) -> Verdict {
    if !probe.is_alive(pid) {
        return Verdict::Gone;
    }
    let Some(recorded) = recorded.filter(|r| !r.is_empty()) else {
        return Verdict::Unknown;
    };
    match probe.identity(pid) {
        None if probe.is_alive(pid) => Verdict::Unknown,
        None => Verdict::Gone,
        Some(actual) if actual == recorded => Verdict::Same,
        Some(_) => Verdict::Different,
    }
}

/// [`check`] 的持有版：结论是 [`Verdict::Same`] 时连同持有着的进程一起交回，调用方在它活着期间结束进程树，
/// 核对与结束之间 PID 不会换主（只核对、不结束的地方用 [`check`] 就够了）。
pub fn check_held<'a>(
    probe: &'a dyn Probe,
    pid: u32,
    recorded: Option<&str>,
) -> (Verdict, Option<Box<dyn Held + 'a>>) {
    let held = match probe.hold(pid) {
        Hold::Gone => return (Verdict::Gone, None),
        Hold::Denied => return (Verdict::Unknown, None),
        Hold::Held(held) => held,
    };
    if !held.alive() {
        return (Verdict::Gone, None);
    }
    let Some(recorded) = recorded.filter(|r| !r.is_empty()) else {
        return (Verdict::Unknown, None);
    };
    match held.identity() {
        None if held.alive() => (Verdict::Unknown, None),
        None => (Verdict::Gone, None),
        Some(actual) if actual == recorded => (Verdict::Same, Some(held)),
        Some(_) => (Verdict::Different, None),
    }
}

/// 起一个会话需要的全部。
pub struct SpawnRequest<'a> {
    pub command: &'a LaunchCommand,
    pub cwd: &'a Path,
    pub env: &'a [(OsString, OsString)],
    pub stdout_log: &'a Path,
    pub stderr_log: &'a Path,
    /// 写进 stdin 后立刻关闭，会话读到 EOF 就开始工作。
    pub stdin: &'a [u8],
}

/// 起会话。只有本宿主起的会话才有句柄：句柄在，系统不会把这个 PID 分给别的进程。
pub trait Spawner: Send + Sync {
    fn spawn(&self, request: &SpawnRequest<'_>) -> std::io::Result<Box<dyn Child>>;
}

/// 本宿主起的会话进程。
pub trait Child: Send + Sync {
    fn pid(&self) -> u32;
    /// 起来时从自己的句柄读到的出生标识（句柄在，读到的一定是自己的进程）。
    fn identity(&self) -> Option<String>;
    /// 还没退出。
    fn running(&self) -> bool;
    /// 等它退出，至多 `timeout`；退出了返回退出码。
    fn wait(&self, timeout: Option<Duration>) -> Option<i64>;
    /// 让正在 [`Child::wait`] 的线程返回（派单器关闭时用：不结束进程，只是不再等它）。
    fn abandon(&self);
}

/// `%SystemRoot%\System32\<name>`。
pub fn system32(name: &str) -> PathBuf {
    let root = std::env::var_os("SystemRoot")
        .filter(|v| !v.is_empty())
        .map_or_else(|| PathBuf::from(r"C:\Windows"), PathBuf::from);
    root.join("System32").join(name)
}

fn clip(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    crate::outcome::truncate(&flat, 200)
}

/// 本机的真实实现。
#[derive(Clone, Copy, Debug, Default)]
pub struct Native;

#[cfg(windows)]
mod imp {
    use super::*;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::sync::atomic::{AtomicBool, Ordering};
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_ACCESS_DENIED, FILETIME, GetLastError, HANDLE, HANDLE_FLAG_INHERIT,
        SetHandleInformation, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::Globalization::{CP_OEMCP, MultiByteToWideChar};
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Storage::FileSystem::WriteFile;
    use windows_sys::Win32::System::Pipes::CreatePipe;
    use windows_sys::Win32::System::Threading::{
        CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW,
        CREATE_UNICODE_ENVIRONMENT, CreateEventW, CreateProcessW, DeleteProcThreadAttributeList,
        EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, GetProcessTimes, INFINITE,
        InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST, OpenProcess,
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROCESS_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION,
        STARTF_USESHOWWINDOW, STARTF_USESTDHANDLES, STARTUPINFOEXW, SetEvent,
        UpdateProcThreadAttribute, WaitForMultipleObjects,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

    const STILL_ACTIVE: u32 = 259;
    /// stdin 管道的缓冲：提示词一次写完、不会因为会话还没开始读而卡住。
    const STDIN_BUFFER: u32 = 64 * 1024;

    struct Owned(HANDLE);
    // SAFETY: 内核句柄可以跨线程使用。
    unsafe impl Send for Owned {}
    unsafe impl Sync for Owned {}
    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: 句柄归这个值所有，只关一次。
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    fn creation(handle: HANDLE) -> Option<u64> {
        let zero = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
        // SAFETY: 句柄有效，四个输出都是本地变量。
        let ok =
            unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) };
        let value = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
        (ok != 0 && value != 0).then_some(value)
    }

    fn exit_code(handle: HANDLE) -> Option<u32> {
        let mut code = 0u32;
        // SAFETY: 句柄有效。
        (unsafe { GetExitCodeProcess(handle, &mut code) } != 0).then_some(code)
    }

    pub(super) fn identity_of(handle: HANDLE) -> Option<String> {
        creation(handle).map(|ft| format!("win32:{ft}"))
    }

    /// 控制台程序（taskkill）的输出是 OEM 代码页，中文系统上按 UTF-8 解就成了乱码。
    pub(super) fn oem(bytes: &[u8]) -> String {
        let Ok(len) = i32::try_from(bytes.len()) else {
            return String::from_utf8_lossy(bytes).into_owned();
        };
        if len == 0 {
            return String::new();
        }
        // SAFETY: 输入切片有效；先问长度，再写进同样大小的缓冲。
        let need = unsafe {
            MultiByteToWideChar(CP_OEMCP, 0, bytes.as_ptr(), len, std::ptr::null_mut(), 0)
        };
        if need <= 0 {
            return String::from_utf8_lossy(bytes).into_owned();
        }
        let mut wide = vec![0u16; need as usize];
        // SAFETY: 缓冲大小就是上一步问到的长度。
        let wrote = unsafe {
            MultiByteToWideChar(CP_OEMCP, 0, bytes.as_ptr(), len, wide.as_mut_ptr(), need)
        };
        if wrote <= 0 {
            return String::from_utf8_lossy(bytes).into_owned();
        }
        String::from_utf16_lossy(&wide[..wrote as usize])
    }

    /// 跑一次 taskkill（没有窗口，至多 [`TASKKILL_TIMEOUT`]）：退出码（超时或被结束是 `None`）与给人看的文案
    /// （先 stderr 后 stdout）。`CREATE_NO_WINDOW` 下它拿到一个新的控制台，用系统的 OEM 代码页写，按它解码。
    pub(super) fn taskkill(args: &[&str]) -> std::io::Result<(Option<i32>, String)> {
        let mut child = std::process::Command::new(system32("taskkill.exe"))
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()?;
        let deadline = std::time::Instant::now() + TASKKILL_TIMEOUT;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
            }
        };
        let text = child
            .wait_with_output()
            .ok()
            .map(|o| {
                let err = oem(&o.stderr).trim().to_owned();
                if err.is_empty() {
                    oem(&o.stdout).trim().to_owned()
                } else {
                    err
                }
            })
            .unwrap_or_default();
        Ok((status.and_then(|s| s.code()), text))
    }

    /// 打开着的进程句柄：活着期间这个 PID 不会被回收。
    struct NativeHeld(Owned);

    impl Held for NativeHeld {
        fn alive(&self) -> bool {
            exit_code(self.0.0) == Some(STILL_ACTIVE)
        }
        fn identity(&self) -> Option<String> {
            if !self.alive() {
                return None;
            }
            identity_of(self.0.0)
        }
    }

    /// 只读地打开进程：没有这个 PID 是 `Err(false)`，有但无权打开是 `Err(true)`。
    fn open(pid: u32) -> Result<Owned, bool> {
        if pid == 0 {
            return Err(false);
        }
        // SAFETY: 只查询。
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            // SAFETY: 紧接在失败的调用之后。
            return Err(unsafe { GetLastError() } == ERROR_ACCESS_DENIED);
        }
        Ok(Owned(handle))
    }

    impl Probe for Native {
        fn is_alive(&self, pid: u32) -> bool {
            match open(pid) {
                Ok(handle) => exit_code(handle.0) == Some(STILL_ACTIVE),
                Err(denied) => denied,
            }
        }

        fn identity(&self, pid: u32) -> Option<String> {
            NativeHeld(open(pid).ok()?).identity()
        }

        fn hold(&self, pid: u32) -> Hold<'_> {
            match open(pid) {
                Ok(handle) => Hold::Held(Box::new(NativeHeld(handle))),
                Err(true) => Hold::Denied,
                Err(false) => Hold::Gone,
            }
        }

        fn kill_tree(&self, pid: u32) -> KillResult {
            // 没有这个 PID 就不起 taskkill：「不在」不靠它的退出码（受限的令牌下它对不存在的 PID 也可能答 1）。
            if let Err(false) = open(pid) {
                return KillResult::Gone;
            }
            let (status, text) = match taskkill(&["/PID", &pid.to_string(), "/T", "/F"]) {
                Ok(done) => done,
                Err(e) => return KillResult::Failed(clip(&format!("taskkill 没有正常运行：{e}"))),
            };
            match status {
                Some(0) => KillResult::Killed,
                Some(TASKKILL_NOT_FOUND_EXIT_CODE) => KillResult::Gone,
                Some(code) => KillResult::Failed(clip(&format!("taskkill 退出码 {code}：{text}"))),
                None => KillResult::Failed(clip(&format!("taskkill 没有正常运行：{text}"))),
            }
        }
    }

    pub(super) struct NativeChild {
        process: Owned,
        /// 关闭事件：[`Child::abandon`] 置位，正在等的线程立刻返回。
        abandon: Owned,
        abandoned: AtomicBool,
        pid: u32,
        identity: Option<String>,
    }

    impl Child for NativeChild {
        fn pid(&self) -> u32 {
            self.pid
        }
        fn identity(&self) -> Option<String> {
            self.identity.clone()
        }
        fn running(&self) -> bool {
            exit_code(self.process.0) == Some(STILL_ACTIVE)
        }
        fn wait(&self, timeout: Option<Duration>) -> Option<i64> {
            if self.abandoned.load(Ordering::SeqCst) {
                return None;
            }
            let ms = timeout.map_or(INFINITE, |t| {
                u32::try_from(t.as_millis()).unwrap_or(INFINITE - 1)
            });
            let handles = [self.process.0, self.abandon.0];
            // SAFETY: 两个句柄都有效，归 self 所有。
            let r = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, ms) };
            if r != WAIT_OBJECT_0 {
                return None;
            }
            exit_code(self.process.0).map(i64::from)
        }
        fn abandon(&self) {
            self.abandoned.store(true, Ordering::SeqCst);
            // SAFETY: 事件句柄有效。
            unsafe { SetEvent(self.abandon.0) };
        }
    }

    fn open_log(path: &Path) -> std::io::Result<std::fs::File> {
        std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(path)
    }

    fn env_block(env: &[(OsString, OsString)]) -> Vec<u16> {
        let mut block = Vec::new();
        for (k, v) in env {
            block.extend(k.encode_wide());
            block.push(u16::from(b'='));
            block.extend(v.encode_wide());
            block.push(0);
        }
        if block.is_empty() {
            block.push(0);
        }
        block.push(0);
        block
    }

    impl Spawner for Native {
        fn spawn(&self, request: &SpawnRequest<'_>) -> std::io::Result<Box<dyn Child>> {
            if let Some(dir) = request.stdout_log.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let stdout = open_log(request.stdout_log)?;
            let stderr = open_log(request.stderr_log)?;
            let (mut read, mut write): (HANDLE, HANDLE) =
                (std::ptr::null_mut(), std::ptr::null_mut());
            let sa = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: std::ptr::null_mut(),
                bInheritHandle: 0,
            };
            // SAFETY: 输出指针指向本地变量。
            if unsafe { CreatePipe(&mut read, &mut write, &sa, STDIN_BUFFER) } == 0 {
                return Err(std::io::Error::last_os_error());
            }
            let (read, write) = (Owned(read), Owned(write));
            let inherited = [
                read.0,
                stdout.as_raw_handle() as HANDLE,
                stderr.as_raw_handle() as HANDLE,
            ];
            for h in inherited {
                // SAFETY: 句柄有效；只给子进程用的这三个打开继承，并且只出现在下面的白名单里。
                if unsafe { SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) } == 0
                {
                    return Err(std::io::Error::last_os_error());
                }
            }
            let mut size = 0usize;
            // SAFETY: 第一次调用只取大小。
            unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size) };
            let mut buffer = vec![0u8; size];
            let list = buffer.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
            // SAFETY: 缓冲区大小来自上一次调用。
            if unsafe { InitializeProcThreadAttributeList(list, 1, 0, &mut size) } == 0 {
                return Err(std::io::Error::last_os_error());
            }
            struct List(LPPROC_THREAD_ATTRIBUTE_LIST);
            impl Drop for List {
                fn drop(&mut self) {
                    // SAFETY: 初始化成功过。
                    unsafe { DeleteProcThreadAttributeList(self.0) };
                }
            }
            let list = List(list);
            // SAFETY: `inherited` 活到 CreateProcessW 之后。
            if unsafe {
                UpdateProcThreadAttribute(
                    list.0,
                    0,
                    PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                    inherited.as_ptr().cast(),
                    std::mem::size_of_val(&inherited),
                    std::ptr::null_mut(),
                    std::ptr::null(),
                )
            } == 0
            {
                return Err(std::io::Error::last_os_error());
            }
            // SAFETY: 全零是 STARTUPINFOEXW 的合法初值。
            let mut si: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
            si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
            si.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
            si.StartupInfo.wShowWindow = SW_HIDE as u16;
            si.StartupInfo.hStdInput = inherited[0];
            si.StartupInfo.hStdOutput = inherited[1];
            si.StartupInfo.hStdError = inherited[2];
            si.lpAttributeList = list.0;
            let program = wide(request.command.program.as_os_str());
            let cwd = wide(request.cwd.as_os_str());
            let mut env = env_block(request.env);
            let base = EXTENDED_STARTUPINFO_PRESENT
                | CREATE_UNICODE_ENVIRONMENT
                | CREATE_NO_WINDOW
                | CREATE_NEW_PROCESS_GROUP;
            let mut create = |flags: u32| -> Result<PROCESS_INFORMATION, std::io::Error> {
                let mut line: Vec<u16> = std::ffi::OsStr::new(&request.command.command_line())
                    .encode_wide()
                    .chain(std::iter::once(0))
                    .collect();
                // SAFETY: 全零是 PROCESS_INFORMATION 的合法初值。
                let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
                // SAFETY: 字符串都以 0 结尾、活到调用之后；命令行缓冲可写。
                let ok = unsafe {
                    CreateProcessW(
                        program.as_ptr(),
                        line.as_mut_ptr(),
                        std::ptr::null(),
                        std::ptr::null(),
                        1,
                        flags,
                        env.as_mut_ptr().cast(),
                        cwd.as_ptr(),
                        &si.StartupInfo,
                        &mut pi,
                    )
                };
                if ok == 0 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(pi)
                }
            };
            // 宿主所在的作业不许脱离时（CreateProcess 报拒绝访问），就留在作业里起。
            let pi = match create(base | CREATE_BREAKAWAY_FROM_JOB) {
                Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => create(base)?,
                other => other?,
            };
            drop(Owned(pi.hThread));
            let process = Owned(pi.hProcess);
            // 父进程这一份读端与日志起完即关；会话进程有自己的一份。
            drop(read);
            drop(stdout);
            drop(stderr);
            let identity = identity_of(process.0);
            let mut written = 0u32;
            let mut rest = request.stdin;
            while !rest.is_empty() {
                let chunk = u32::try_from(rest.len()).unwrap_or(u32::MAX);
                // SAFETY: 写端有效，缓冲区在 `rest` 里。
                if unsafe {
                    WriteFile(
                        write.0,
                        rest.as_ptr(),
                        chunk,
                        &mut written,
                        std::ptr::null_mut(),
                    )
                } == 0
                    || written == 0
                {
                    break; // 会话已经退出（管道断了）：退出码与日志会说明原因。
                }
                rest = &rest[written as usize..];
            }
            drop(write);
            // SAFETY: 无名的手动复位事件。
            let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
            if event.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            Ok(Box::new(NativeChild {
                pid: pi.dwProcessId,
                process,
                abandon: Owned(event),
                abandoned: AtomicBool::new(false),
                identity,
            }))
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;

    impl Probe for Native {
        fn is_alive(&self, _pid: u32) -> bool {
            false
        }
        fn identity(&self, _pid: u32) -> Option<String> {
            None
        }
        fn kill_tree(&self, _pid: u32) -> KillResult {
            KillResult::Failed("只支持 Windows".into())
        }
        fn hold(&self, _pid: u32) -> Hold<'_> {
            Hold::Gone
        }
    }

    impl Spawner for Native {
        fn spawn(&self, _request: &SpawnRequest<'_>) -> std::io::Result<Box<dyn Child>> {
            Err(std::io::Error::other("只支持 Windows"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake {
        alive: bool,
        identity: Option<&'static str>,
    }
    impl Probe for Fake {
        fn is_alive(&self, _pid: u32) -> bool {
            self.alive
        }
        fn identity(&self, _pid: u32) -> Option<String> {
            self.identity.map(str::to_owned)
        }
        fn kill_tree(&self, _pid: u32) -> KillResult {
            KillResult::Gone
        }
        fn hold(&self, _pid: u32) -> Hold<'_> {
            if !self.alive {
                return Hold::Gone;
            }
            Hold::Held(Box::new(FakeHeld(self.identity)))
        }
    }

    struct FakeHeld(Option<&'static str>);
    impl Held for FakeHeld {
        fn alive(&self) -> bool {
            true
        }
        fn identity(&self) -> Option<String> {
            self.0.map(str::to_owned)
        }
    }

    #[test]
    fn identity_is_exact_or_unknown() {
        let same = Fake {
            alive: true,
            identity: Some("win32:134000000000000001"),
        };
        assert_eq!(
            check(&same, 7, Some("win32:134000000000000001")),
            Verdict::Same
        );
        // 只差 100 ns 也是另一个进程。
        assert_eq!(
            check(&same, 7, Some("win32:134000000000000000")),
            Verdict::Different
        );
        assert_eq!(check(&same, 7, None), Verdict::Unknown);
        assert_eq!(check(&same, 7, Some("")), Verdict::Unknown);
        let unreadable = Fake {
            alive: true,
            identity: None,
        };
        assert_eq!(check(&unreadable, 7, Some("win32:1")), Verdict::Unknown);
        let gone = Fake {
            alive: false,
            identity: None,
        };
        assert_eq!(check(&gone, 7, Some("win32:1")), Verdict::Gone);
    }

    /// taskkill 的文案是 OEM 代码页（中文系统 936）：按它解码，给人看的失败原因不是乱码。在 OEM 代码页就是
    /// UTF-8 的系统上，这条与按 UTF-8 解等价。
    #[cfg(windows)]
    #[test]
    fn taskkill_text_is_decoded_from_the_oem_code_page() {
        // 与结束进程树同一条路（没有窗口、新控制台）。`/?` 只打帮助；4 的倍数以外的 PID 不会分配，结束它只会报「找不到」。
        let (code, help) = imp::taskkill(&["/?"]).unwrap();
        assert_eq!(code, Some(0));
        assert!(help.contains("/PID"), "{help}");
        assert!(!help.contains(char::REPLACEMENT_CHARACTER), "{help}");
        let (code, missing) = imp::taskkill(&["/PID", "2147483645"]).unwrap();
        assert_eq!(code, Some(TASKKILL_NOT_FOUND_EXIT_CODE));
        assert!(missing.contains("2147483645"), "{missing}");
        assert!(!missing.contains(char::REPLACEMENT_CHARACTER), "{missing}");
        assert_eq!(imp::oem(b"ERROR: 128"), "ERROR: 128");
        assert_eq!(imp::oem(b""), "");
    }

    #[cfg(windows)]
    #[test]
    fn this_process_reads_the_same_filetime_twice_and_a_dead_pid_reads_nothing() {
        let me = std::process::id();
        let a = Native.identity(me).unwrap();
        let b = Native.identity(me).unwrap();
        assert_eq!(a, b);
        let digits = a.strip_prefix("win32:").unwrap();
        assert!(
            !digits.is_empty()
                && !digits.starts_with('0')
                && digits.bytes().all(|d| d.is_ascii_digit())
        );
        assert!(Native.is_alive(me));
        // 4 的倍数以外的 PID 在 Windows 上不会分配。
        assert!(!Native.is_alive(0x7fff_fffd));
        assert_eq!(Native.identity(0x7fff_fffd), None);
        assert_eq!(Native.kill_tree(0x7fff_fffd), KillResult::Gone);
    }

    /// 已经退出、句柄还在的进程（取消时持有着、它恰好自己结束了）：PID 打得开，taskkill 照样起，找不到进程退出
    /// 128，记为不在。只碰本用例自己起的 `cmd /c exit`。
    #[cfg(windows)]
    #[test]
    fn an_exited_process_that_is_still_held_is_gone_by_taskkill_128() {
        let mut child = std::process::Command::new(system32("cmd.exe"))
            .args(["/d", "/c", "exit 0"])
            .spawn()
            .unwrap();
        child.wait().unwrap();
        let pid = child.id();
        let Hold::Held(held) = Native.hold(pid) else {
            panic!("句柄还在，PID 应该打得开");
        };
        assert!(!held.alive());
        assert_eq!(Native.kill_tree(pid), KillResult::Gone);
        drop(held);
        drop(child);
    }
}
