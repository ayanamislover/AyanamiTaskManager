//! Windows ends a logon session by sending WM_QUERYENDSESSION / WM_ENDSESSION to top-level
//! windows, then terminates the process as soon as WM_ENDSESSION returns. The quit chain
//! never runs, so without a marker the next start reports a normal logoff as
//! previous.unclean (lifecycle-diagnostics.ts). The main window may not exist (background
//! start, window closed), hence a hidden top-level window of our own — message-only windows
//! do not receive these broadcasts. It lives on the event-loop thread, whose pump
//! dispatches to it.

use std::sync::Mutex;
use std::time::Duration;

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, RegisterClassW, WM_ENDSESSION, WM_QUERYENDSESSION, WNDCLASSW,
    WS_OVERLAPPED,
};

use crate::core_process::SessionMarker;

/// Well inside the ~5 s Windows allows before it offers to kill "an app preventing shutdown".
const MARK_TIMEOUT: Duration = Duration::from_millis(1500);

static CURRENT: Mutex<Option<SessionMarker>> = Mutex::new(None);
static DATA_DIR: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);

/// Called whenever the core is (re)started or has exited.
pub fn set_core(marker: Option<SessionMarker>) {
    if let Ok(mut current) = CURRENT.lock() {
        *current = marker;
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        // Never veto: ATM has nothing unsaved that would justify blocking a logoff.
        WM_QUERYENDSESSION => 1,
        WM_ENDSESSION => {
            if wparam != 0 {
                let marker = CURRENT.lock().ok().and_then(|current| current.clone());
                let confirmed = marker.is_some_and(|marker| marker.mark(MARK_TIMEOUT));
                if let Some(dir) = DATA_DIR.lock().ok().and_then(|dir| dir.clone()) {
                    crate::log(
                        &dir,
                        &format!("session end (core marker confirmed: {confirmed})"),
                    );
                }
            }
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

/// Creates the hidden window on the calling (event-loop) thread.
pub fn install(data_dir: &std::path::Path) {
    if let Ok(mut dir) = DATA_DIR.lock() {
        *dir = Some(data_dir.to_path_buf());
    }
    let class = wide("AyanamiTaskManager.SessionEnd");
    unsafe {
        let instance = GetModuleHandleW(std::ptr::null());
        let definition = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            hInstance: instance,
            lpszClassName: class.as_ptr(),
            ..std::mem::zeroed()
        };
        RegisterClassW(&definition);
        let hwnd = CreateWindowExW(
            0,
            class.as_ptr(),
            class.as_ptr(),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            instance,
            std::ptr::null(),
        );
        if hwnd.is_null() {
            crate::log(data_dir, "session-end window could not be created");
        }
    }
}
