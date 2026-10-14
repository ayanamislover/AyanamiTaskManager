//! Processes by pid *and* creation time, so a recycled pid is never taken for the process
//! the journal recorded (§6 QUIESCE/SEAL, witness checks).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use crate::ProcessIdentity;
use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_TERMINATE, QueryFullProcessImageNameW, TerminateProcess,
};

const STILL_ACTIVE: u32 = 259;
/// FILETIME (100 ns since 1601) → .NET ticks (100 ns since 0001), the unit the daemon lock
/// records as `createdAtTicks`.
const FILETIME_TO_DOTNET_TICKS: u64 = 504_911_232_000_000_000;

#[derive(Debug, Clone)]
pub struct Proc {
    pub pid: u32,
    pub parent: u32,
    pub image: Option<PathBuf>,
    /// FILETIME of creation.
    pub created: u64,
}

impl Proc {
    pub fn started_at_ms(&self) -> u64 {
        filetime_to_unix_ms(self.created)
    }
    pub fn identity(&self) -> ProcessIdentity {
        ProcessIdentity {
            pid: self.pid,
            started_at_ms: self.started_at_ms(),
            image: self
                .image
                .as_ref()
                .map(|image| image.to_string_lossy().into_owned())
                .unwrap_or_default(),
        }
    }
}

pub fn filetime_to_unix_ms(filetime: u64) -> u64 {
    (filetime / 10_000).saturating_sub(11_644_473_600_000)
}

pub fn filetime_to_dotnet_ticks(filetime: u64) -> u64 {
    filetime + FILETIME_TO_DOTNET_TICKS
}

struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

fn open(pid: u32, access: u32) -> Option<Handle> {
    let handle = unsafe { OpenProcess(access, 0, pid) };
    (!handle.is_null()).then_some(Handle(handle))
}

fn creation(handle: &Handle) -> Option<u64> {
    let zero = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
    let ok =
        unsafe { GetProcessTimes(handle.0, &mut created, &mut exited, &mut kernel, &mut user) };
    (ok != 0).then(|| (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
}

fn running(handle: &Handle) -> bool {
    let mut code = 0u32;
    unsafe { GetExitCodeProcess(handle.0, &mut code) != 0 && code == STILL_ACTIVE }
}

fn image(handle: &Handle) -> Option<PathBuf> {
    let mut buffer = vec![0u16; 1024];
    let mut size = buffer.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(handle.0, 0, buffer.as_mut_ptr(), &mut size) };
    (ok != 0).then(|| PathBuf::from(String::from_utf16_lossy(&buffer[..size as usize])))
}

/// Every process this user can query, with image and creation time where available.
pub fn snapshot() -> Vec<Proc> {
    let mut result = Vec::new();
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snap == INVALID_HANDLE_VALUE {
        return result;
    }
    let snap = Handle(snap);
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut ok = unsafe { Process32FirstW(snap.0, &mut entry) } != 0;
    while ok {
        let pid = entry.th32ProcessID;
        if pid != 0 {
            let (image_path, created) = match open(pid, PROCESS_QUERY_LIMITED_INFORMATION) {
                Some(handle) => (image(&handle), creation(&handle).unwrap_or(0)),
                None => (None, 0),
            };
            result.push(Proc {
                pid,
                parent: entry.th32ParentProcessID,
                image: image_path,
                created,
            });
        }
        ok = unsafe { Process32NextW(snap.0, &mut entry) } != 0;
    }
    result
}

/// The process with this pid, if it is still the one that was born at `started_at_ms`.
pub fn find(pid: u32) -> Option<Proc> {
    let handle = open(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
    if !running(&handle) {
        return None;
    }
    Some(Proc {
        pid,
        parent: 0,
        image: image(&handle),
        created: creation(&handle)?,
    })
}

pub fn alive(identity: &ProcessIdentity) -> bool {
    find(identity.pid).is_some_and(|proc| proc.started_at_ms() == identity.started_at_ms)
}

/// Terminate only if the pid still belongs to the recorded process.
pub fn terminate(identity: &ProcessIdentity) -> bool {
    let Some(handle) = open(
        identity.pid,
        PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
    ) else {
        return !alive(identity);
    };
    if creation(&handle).map(filetime_to_unix_ms) != Some(identity.started_at_ms) {
        return true;
    }
    unsafe { TerminateProcess(handle.0, 1) != 0 }
}

pub fn wait_all_gone(identities: &[ProcessIdentity], timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if identities.iter().all(|identity| !alive(identity)) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// Start a detached process and pin its identity.
///
/// The process leaves setup's job when the job allows it. Setup may run inside one that
/// ends everything with it — an Agent's terminal, or an update started by a host the Agent
/// woke — and the ATM it starts must outlive that. A job that forbids breakaway makes
/// CreateProcess fail with access denied; then the process starts inside it, as before.
/// A refusal either way is waited out for a while ([`start_retrying`]).
pub fn spawn(exe: &Path, args: &[&str]) -> std::io::Result<(std::process::Child, ProcessIdentity)> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let start = |flags: u32| {
        Command::new(exe)
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(flags)
            .spawn()
    };
    let flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
    let child = start_retrying(
        exe,
        &mut |breakaway| {
            start(if breakaway {
                flags | CREATE_BREAKAWAY_FROM_JOB
            } else {
                flags
            })
        },
        &mut std::thread::sleep,
    )?;
    let pid = child.id();
    let started_at_ms = find(pid).map(|proc| proc.started_at_ms()).unwrap_or(0);
    Ok((
        child,
        ProcessIdentity {
            pid,
            started_at_ms,
            image: exe.to_string_lossy().into_owned(),
        },
    ))
}

/// One start of `exe` through `start(breakaway)`, retrying refusals. A refusal with breakaway is
/// tried again at once without it (a job that forbids breakaway refuses with access denied).
/// When both are refused (5, 32, 33), the start is retried with backoff for up to
/// [`crate::durable::RETRY_BUDGET`]: an exe the installer has just written is often still held by
/// an antivirus scan, and CreateProcess refuses it the same way (W8 gate, release chain 12: the
/// health probe of a freshly staged `app-2.0.0` failed with os error 5 two milliseconds after
/// STAGE). Any other error, or a refusal that outlasts the budget, names the exe.
pub fn start_retrying<T>(
    exe: &Path,
    start: &mut dyn FnMut(bool) -> std::io::Result<T>,
    sleep: &mut dyn FnMut(Duration),
) -> std::io::Result<T> {
    let refused = |e: &std::io::Error| matches!(e.raw_os_error(), Some(5 | 32 | 33));
    let mut delay = Duration::from_millis(10);
    let mut waited = Duration::ZERO;
    loop {
        let error = match start(true) {
            Ok(started) => return Ok(started),
            Err(e) if refused(&e) => match start(false) {
                Ok(started) => return Ok(started),
                Err(e) => e,
            },
            Err(e) => e,
        };
        if !refused(&error) || waited >= crate::durable::RETRY_BUDGET {
            return Err(std::io::Error::new(
                error.kind(),
                format!("start {}: {error}", exe.display()),
            ));
        }
        sleep(delay);
        waited += delay;
        delay = (delay * 2).min(Duration::from_millis(500));
    }
}

pub fn parent_of(pid: u32) -> Option<u32> {
    snapshot()
        .into_iter()
        .find(|proc| proc.pid == pid)
        .map(|proc| proc.parent)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_process_is_found_with_a_stable_identity() {
        let me = find(std::process::id()).unwrap();
        let identity = me.identity();
        assert!(alive(&identity));
        let recycled = ProcessIdentity {
            started_at_ms: identity.started_at_ms + 1,
            ..identity.clone()
        };
        assert!(!alive(&recycled));
        assert!(snapshot().iter().any(|proc| proc.pid == std::process::id()));
    }

    fn os(code: i32) -> std::io::Error {
        std::io::Error::from_raw_os_error(code)
    }

    /// An exe still held by an antivirus scan: both starts are refused a few times, then it
    /// starts. Each round tries breakaway first, then without; the waits back off.
    #[test]
    fn a_start_refused_for_a_while_is_retried_until_it_starts() {
        let mut tries = Vec::new();
        let mut slept = Vec::new();
        let mut left = 4;
        let got = start_retrying(
            Path::new(r"C:\i\app-2.0.0\AyanamiTaskManager.exe"),
            &mut |breakaway| {
                tries.push(breakaway);
                if left == 0 {
                    return Ok(breakaway);
                }
                left -= 1;
                Err(os(if left % 2 == 0 { 5 } else { 32 }))
            },
            &mut |d| slept.push(d),
        );
        assert!(got.unwrap(), "the last start was with breakaway");
        assert_eq!(tries, [true, false, true, false, true]);
        assert_eq!(
            slept,
            [Duration::from_millis(10), Duration::from_millis(20)]
        );
    }

    /// A job that forbids breakaway: the start without it goes through at once, no wait.
    #[test]
    fn a_job_that_forbids_breakaway_starts_inside_it_at_once() {
        let mut tries = Vec::new();
        let mut slept = Vec::new();
        let got = start_retrying(
            Path::new("x.exe"),
            &mut |breakaway| {
                tries.push(breakaway);
                if breakaway { Err(os(5)) } else { Ok(()) }
            },
            &mut |d| slept.push(d),
        );
        assert!(got.is_ok());
        assert_eq!(tries, [true, false]);
        assert!(slept.is_empty());
    }

    /// Anything but a refusal fails at once; a refusal that outlasts the budget fails after it.
    /// Both errors name the exe.
    #[test]
    fn other_errors_fail_at_once_and_a_lasting_refusal_after_the_budget() {
        let exe = Path::new(r"C:\i\app-2.0.0\AyanamiTaskManager.exe");
        let mut slept = Vec::new();
        let missing =
            start_retrying::<()>(exe, &mut |_| Err(os(2)), &mut |d| slept.push(d)).unwrap_err();
        assert!(slept.is_empty());
        assert_eq!(missing.kind(), std::io::ErrorKind::NotFound);
        assert!(
            missing
                .to_string()
                .starts_with(r"start C:\i\app-2.0.0\AyanamiTaskManager.exe: "),
            "{missing}"
        );

        let mut tries = 0;
        let denied = start_retrying::<()>(
            exe,
            &mut |_| {
                tries += 1;
                Err(os(5))
            },
            &mut |d| slept.push(d),
        )
        .unwrap_err();
        let waited: Duration = slept.iter().sum();
        assert!(waited >= crate::durable::RETRY_BUDGET, "{waited:?}");
        assert!(
            waited < crate::durable::RETRY_BUDGET + Duration::from_secs(1),
            "{waited:?}"
        );
        assert_eq!(tries, 2 * (slept.len() + 1));
        assert_eq!(denied.kind(), std::io::ErrorKind::PermissionDenied);
        assert!(
            denied.to_string().contains("AyanamiTaskManager.exe: "),
            "{denied}"
        );
    }
}
