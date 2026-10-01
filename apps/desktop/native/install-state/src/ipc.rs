//! Single instance + the second-instance pipe (§4 table, §6 QUIT channel).
//!
//! The pipe accepts a fixed set of commands and nothing else: it never carries a path, a
//! script, an RPC or a credential into the running host.
//!
//! Lives in the shared crate because setup must reach the same pipe to QUIT a running
//! host: a second copy of the naming rule would drift, and setup could no longer stop it.

use std::path::Path;
use std::ptr::null_mut;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ALREADY_EXISTS, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, GENERIC_READ,
    GENERIC_WRITE, GetLastError, HANDLE, INVALID_HANDLE_VALUE, LocalFree,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, OPEN_EXISTING, PIPE_ACCESS_DUPLEX, ReadFile,
    WriteFile,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_MESSAGE,
    PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_MESSAGE, PIPE_WAIT, WaitNamedPipeW,
};
use windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows_sys::Win32::System::Threading::{CreateMutexW, GetCurrentProcessId};

fn wide(text: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    text.as_ref()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

const MAX_MESSAGE: usize = 1024;
/// Owner and SYSTEM only; no inherited ACEs.
const PIPE_SDDL: &str = "D:P(A;;GA;;;OW)(A;;GA;;;SY)";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Command {
    Show,
    Navigate {
        route: Route,
    },
    Wake,
    Quit,
    #[cfg(feature = "smoke")]
    SmokeQuit,
}

/// The only routes a second instance may ask for (tray items, deep links of the old app).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Route {
    Quick,
    Settings,
}

impl Route {
    pub fn as_str(self) -> &'static str {
        match self {
            Route::Quick => "quick",
            Route::Settings => "settings",
        }
    }
}

pub fn parse_command(bytes: &[u8]) -> Option<Command> {
    if bytes.len() > MAX_MESSAGE {
        return None;
    }
    serde_json::from_slice(bytes).ok()
}

/// FNV-1a of the lower-cased data root: two data roots are two independent instances.
pub fn scope(data_dir: &Path) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in data_dir.to_string_lossy().to_lowercase().bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn session_id() -> u32 {
    let mut session = 0;
    unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut session) };
    session
}

pub fn pipe_name(data_dir: &Path) -> String {
    let user = std::env::var("USERNAME").unwrap_or_default().to_lowercase();
    let user: String = user
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(32)
        .collect();
    format!(
        r"\\.\pipe\AyanamiTaskManager.Host.{user}.{}.{}",
        session_id(),
        scope(data_dir)
    )
}

pub struct Primary {
    _mutex: HANDLE,
}

fn primary_mutex_name(data_dir: &Path) -> Vec<u16> {
    wide(format!(
        r"Local\AyanamiTaskManager.Host.{}",
        scope(data_dir)
    ))
}

/// Whether a primary host for `data_dir` is alive — with or without a service lease: a
/// host waiting out `--random-startup-delay`, or between core restarts, holds the mutex
/// long before (or after) any lease. The mutex lives exactly as long as its holder.
pub fn primary_alive(data_dir: &Path) -> bool {
    use windows_sys::Win32::System::Threading::{OpenMutexW, SYNCHRONIZATION_SYNCHRONIZE};
    let name = primary_mutex_name(data_dir);
    unsafe {
        let mutex = OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, 0, name.as_ptr());
        if mutex.is_null() {
            return false;
        }
        CloseHandle(mutex);
        true
    }
}

/// The primary host's identity, published next to the lease (`runtime\host.json`) so a
/// setup can stop a host that has no lease yet — pid alone could be recycled.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRecord {
    pub pid: u32,
    pub started_at_ms: u64,
}

pub fn host_record_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("runtime").join("host.json")
}

pub fn read_host_record(data_dir: &Path) -> Option<HostRecord> {
    let bytes = std::fs::read(host_record_path(data_dir)).ok()?;
    if bytes.len() > 4096 {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

/// `Some` when this process is the primary instance for `data_dir`.
pub fn acquire(data_dir: &Path) -> Option<Primary> {
    let name = primary_mutex_name(data_dir);
    unsafe {
        let mutex = CreateMutexW(null_mut(), 1, name.as_ptr());
        if mutex.is_null() {
            return None;
        }
        if GetLastError() == ERROR_ALREADY_EXISTS {
            CloseHandle(mutex);
            return None;
        }
        Some(Primary { _mutex: mutex })
    }
}

struct Descriptor(PSECURITY_DESCRIPTOR);
impl Drop for Descriptor {
    fn drop(&mut self) {
        unsafe { LocalFree(self.0) };
    }
}

fn owner_only_descriptor() -> Option<Descriptor> {
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    let ok = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide(PIPE_SDDL).as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            null_mut(),
        )
    };
    (ok != 0).then_some(Descriptor(descriptor))
}

fn create_instance(name: &[u16], first: bool, descriptor: &Descriptor) -> Option<HANDLE> {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    let open_mode = PIPE_ACCESS_DUPLEX
        | if first {
            FILE_FLAG_FIRST_PIPE_INSTANCE
        } else {
            0
        };
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            open_mode,
            PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            MAX_MESSAGE as u32,
            MAX_MESSAGE as u32,
            0,
            &attributes,
        )
    };
    (handle != INVALID_HANDLE_VALUE).then_some(handle)
}

/// Serve second-instance commands on a background thread. If the first pipe instance
/// cannot be created (the name is already taken), serve nothing rather than join an
/// unknown server; second instances then only fail to deliver SHOW/WAKE.
pub fn serve(data_dir: &Path, deliver: impl Fn(Command) + Send + 'static) -> Result<(), String> {
    let name = wide(pipe_name(data_dir));
    let descriptor = owner_only_descriptor().ok_or("PIPE_SECURITY_DESCRIPTOR_FAILED")?;
    let first = create_instance(&name, true, &descriptor).ok_or("PIPE_NAME_TAKEN")?;
    let first = first as usize;
    drop(descriptor);
    thread::Builder::new()
        .name("second-instance".into())
        .spawn(move || {
            // Raw security descriptors are not Send; the serving thread builds its own.
            let Some(descriptor) = owner_only_descriptor() else {
                return;
            };
            let mut handle = first as HANDLE;
            loop {
                unsafe {
                    let connected = ConnectNamedPipe(handle, null_mut()) != 0
                        || GetLastError() == ERROR_PIPE_CONNECTED;
                    if connected {
                        let mut buffer = [0u8; MAX_MESSAGE + 1];
                        let mut read = 0u32;
                        if ReadFile(
                            handle,
                            buffer.as_mut_ptr(),
                            buffer.len() as u32,
                            &mut read,
                            null_mut(),
                        ) != 0
                        {
                            let reply: &[u8] = match parse_command(&buffer[..read as usize]) {
                                Some(command) => {
                                    deliver(command);
                                    b"ok"
                                }
                                None => b"rejected",
                            };
                            let mut written = 0u32;
                            WriteFile(
                                handle,
                                reply.as_ptr(),
                                reply.len() as u32,
                                &mut written,
                                null_mut(),
                            );
                        }
                        DisconnectNamedPipe(handle);
                    }
                    // Recycle the same instance; recreate only if it broke.
                    if !connected {
                        CloseHandle(handle);
                        match create_instance(&name, false, &descriptor) {
                            Some(next) => handle = next,
                            None => return,
                        }
                    }
                }
            }
        })
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Send one command to the primary instance. Waits up to `timeout` for the primary to
/// have its pipe up (it creates it right after taking the mutex).
pub fn send(data_dir: &Path, command: &Command, timeout: Duration) -> bool {
    let name = wide(pipe_name(data_dir));
    let payload = match serde_json::to_vec(command) {
        Ok(payload) if payload.len() <= MAX_MESSAGE => payload,
        _ => return false,
    };
    let deadline = Instant::now() + timeout;
    loop {
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                null_mut(),
                OPEN_EXISTING,
                0,
                null_mut(),
            )
        };
        if handle != INVALID_HANDLE_VALUE {
            let mut written = 0u32;
            let mut reply = [0u8; 16];
            let mut read = 0u32;
            let ok = unsafe {
                WriteFile(
                    handle,
                    payload.as_ptr(),
                    payload.len() as u32,
                    &mut written,
                    null_mut(),
                ) != 0
                    && ReadFile(
                        handle,
                        reply.as_mut_ptr(),
                        reply.len() as u32,
                        &mut read,
                        null_mut(),
                    ) != 0
            };
            unsafe { CloseHandle(handle) };
            return ok && &reply[..read as usize] == b"ok";
        }
        if Instant::now() >= deadline {
            return false;
        }
        unsafe {
            if GetLastError() == ERROR_PIPE_BUSY {
                WaitNamedPipeW(name.as_ptr(), 500);
            } else {
                thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_fixed_commands_and_routes_parse() {
        assert_eq!(parse_command(br#"{"cmd":"SHOW"}"#), Some(Command::Show));
        assert_eq!(parse_command(br#"{"cmd":"WAKE"}"#), Some(Command::Wake));
        assert_eq!(
            parse_command(br#"{"cmd":"NAVIGATE","route":"settings"}"#),
            Some(Command::Navigate {
                route: Route::Settings
            })
        );
        assert_eq!(
            parse_command(br#"{"cmd":"NAVIGATE","route":"C:\\evil"}"#),
            None
        );
        assert_eq!(parse_command(br#"{"cmd":"RUN","script":"x"}"#), None);
        assert_eq!(parse_command(&[b' '; MAX_MESSAGE + 1]), None);
    }

    #[test]
    fn scope_separates_data_roots_case_insensitively() {
        assert_eq!(
            scope(Path::new(r"C:\A\Data")),
            scope(Path::new(r"c:\a\data"))
        );
        assert_ne!(
            scope(Path::new(r"C:\A\Data")),
            scope(Path::new(r"C:\A\Other"))
        );
    }
}
