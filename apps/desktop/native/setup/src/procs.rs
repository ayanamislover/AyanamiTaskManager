//! Processes by pid *and* creation time, so a recycled pid is never taken for the process
//! the journal recorded (§6 QUIESCE/SEAL, witness checks).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use atm_install_state::ProcessIdentity;
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

/// Processes whose image lies inside `dir` (case-insensitive, textual).
pub fn under(dir: &Path) -> Vec<Proc> {
    snapshot()
        .into_iter()
        .filter(|proc| {
            proc.image
                .as_ref()
                .is_some_and(|image| crate::fsx::is_within(image, dir))
        })
        .collect()
}

/// Start a detached process and pin its identity.
pub fn spawn(exe: &Path, args: &[&str]) -> std::io::Result<(std::process::Child, ProcessIdentity)> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    let child = Command::new(exe)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()?;
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
}
