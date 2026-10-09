//! Windows ends a logon session by sending WM_QUERYENDSESSION / WM_ENDSESSION to top-level
//! windows, then terminates the process as soon as WM_ENDSESSION returns. The quit chain
//! never runs. The main window may not exist (background start, window closed), hence a
//! hidden top-level window of our own — message-only windows do not receive these
//! broadcasts. It lives on the event-loop thread, whose pump dispatches to it.
//!
//! W5a logs the session end only; the lifecycle marker that keeps a normal logoff from being
//! reported as previous.unclean comes with the lifecycle diagnostics (W5g).

use std::sync::Mutex;

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, RegisterClassW, WM_ENDSESSION, WM_QUERYENDSESSION, WNDCLASSW,
    WS_OVERLAPPED,
};

static LOG_ROOT: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);

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
            if wparam != 0
                && let Some(dir) = LOG_ROOT.lock().ok().and_then(|dir| dir.clone())
            {
                crate::log(&dir, "session end");
            }
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

/// Creates the hidden window on the calling (event-loop) thread.
pub fn install(log_root: &std::path::Path) {
    if let Ok(mut dir) = LOG_ROOT.lock() {
        *dir = Some(log_root.to_path_buf());
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
            crate::log(log_root, "session-end window could not be created");
        }
    }
}
