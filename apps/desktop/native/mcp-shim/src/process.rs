//! Liveness of the daemon's recorded PID, and waking the desktop.

use std::path::{Path, PathBuf};

/// `process.kill(pid, 0)` with EPERM counted as alive, as in the old bridge.
///
/// libuv opens the process and reports ESRCH only for ERROR_INVALID_PARAMETER (no such
/// PID) or an exited process; access denied becomes EPERM, which the bridge treats as a
/// live process it merely cannot signal. Any other failure counts as not alive.
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
    // SAFETY: plain Win32 calls; the handle is closed on every path that opened it.
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

/// Where the desktop executable sits relative to this shim:
/// `<install>\resources\atm-mcp.exe` next to `<install>\AyanamiTaskManager.exe`.
/// Started through the data root's `current` junction, both paths stay on the junction,
/// so the woken desktop is always the currently installed version.
pub fn desktop_executable(shim: &Path) -> Option<PathBuf> {
    let install = shim.parent()?.parent()?;
    let desktop = install.join("AyanamiTaskManager.exe");
    desktop.is_file().then_some(desktop)
}

/// Start the desktop hidden, detached and without the Node-mode switch.
///
/// This is a plain detached launch, not Job isolation: a desktop woken by an Agent host
/// can still end with that host (see docs/troubleshooting.md). A spawn failure is
/// ignored; the caller keeps waiting and reports ATM_RUNTIME_UNAVAILABLE.
pub fn wake_desktop() {
    let Some(desktop) = std::env::current_exe()
        .ok()
        .as_deref()
        .and_then(desktop_executable)
    else {
        return;
    };
    let mut command = std::process::Command::new(desktop);
    command
        .args(["--background", "--agent-wake"])
        .env_remove("ELECTRON_RUN_AS_NODE")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    // Node's `windowsHide` additionally passes SW_HIDE in STARTUPINFO. That is not
    // reproduced (Rust's `show_window` is still unstable): for a GUI executable it only
    // overrides the first ShowWindow call, and a desktop started with --background never
    // shows a window by itself, so there is nothing for it to hide.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    // Dropping the Child neither waits for nor kills it.
    let _ = command.spawn();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_process_is_alive_and_an_absurd_pid_is_not() {
        assert!(pid_alive(std::process::id()));
        // PIDs are multiples of 4 on Windows; this one cannot exist.
        assert!(!pid_alive(0xFFFF_FFF1));
    }

    #[test]
    fn an_exited_process_is_not_alive() {
        let mut child = std::process::Command::new("cmd")
            .args(["/c", "exit", "0"])
            .spawn()
            .unwrap();
        let pid = child.id();
        child.wait().unwrap();
        // The handle is still held by `child`, so the PID cannot be reused yet.
        assert!(!pid_alive(pid));
    }

    /// Kept under the crate's own target directory, never %TEMP%, and removed even when
    /// an assertion fails.
    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn desktop_is_looked_up_one_level_above_resources() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("test-layout-{}", std::process::id()));
        let scratch = Scratch(root);
        let resources = scratch.0.join("resources");
        std::fs::create_dir_all(&resources).unwrap();
        let shim = resources.join("atm-mcp.exe");
        assert_eq!(desktop_executable(&shim), None);
        std::fs::write(scratch.0.join("AyanamiTaskManager.exe"), b"").unwrap();
        assert_eq!(
            desktop_executable(&shim),
            Some(scratch.0.join("AyanamiTaskManager.exe"))
        );
    }
}
