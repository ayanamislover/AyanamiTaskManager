//! Small Win32 helpers the renderer bridge needs locally: clipboard, Explorer, theme,
//! start-at-login. Everything here is synchronous and bounded.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::process::Command;
use std::ptr::null_mut;

use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, GlobalFree, HANDLE};
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
};
use windows_sys::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock};
use windows_sys::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_DWORD, REG_SZ, RRF_RT_REG_DWORD,
    RRF_RT_REG_SZ, RegCloseKey, RegDeleteValueW, RegGetValueW, RegOpenKeyExW, RegSetValueExW,
};

/// Same value name Electron wrote (it used the Squirrel AppUserModelId). Keeping it means an
/// upgraded install has exactly one Run entry and the user's choice carries over.
pub const AUTOSTART_VALUE: &str = "com.squirrel.AyanamiTaskManagerDesktop.AyanamiTaskManager";
/// Toast notifications are keyed by AppUserModelId; keeping Squirrel's keeps the user's
/// Windows notification settings for ATM.
pub const APP_USER_MODEL_ID: &str = AUTOSTART_VALUE;
pub const LOGIN_ARGS: &str = "--background --random-startup-delay";
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const PERSONALIZE_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";
const CF_UNICODETEXT: u32 = 13;
const MAX_CLIPBOARD_CHARS: usize = 1 << 20;

pub fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value
        .as_ref()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

pub fn set_clipboard_text(text: &str) -> bool {
    let units: Vec<u16> = text
        .encode_utf16()
        .take(MAX_CLIPBOARD_CHARS)
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        if OpenClipboard(null_mut()) == 0 {
            return false;
        }
        let ok = (|| {
            if EmptyClipboard() == 0 {
                return false;
            }
            let bytes = units.len() * 2;
            let memory = GlobalAlloc(GMEM_MOVEABLE, bytes);
            if memory.is_null() {
                return false;
            }
            let target = GlobalLock(memory) as *mut u16;
            if target.is_null() {
                GlobalFree(memory);
                return false;
            }
            std::ptr::copy_nonoverlapping(units.as_ptr(), target, units.len());
            GlobalUnlock(memory);
            // On success the clipboard owns the memory.
            if SetClipboardData(CF_UNICODETEXT, memory as HANDLE).is_null() {
                GlobalFree(memory);
                return false;
            }
            true
        })();
        CloseClipboard();
        ok
    }
}

/// `explorer /select,<path>` for an existing absolute path; anything else is ignored.
pub fn show_item_in_folder(path: &str) -> bool {
    use std::os::windows::process::CommandExt;
    let candidate = Path::new(path);
    if !candidate.is_absolute() || path.len() > 4096 || path.contains('"') || !candidate.exists() {
        return false;
    }
    let explorer = std::env::var_os("SystemRoot")
        .map(|root| Path::new(&root).join("explorer.exe"))
        .unwrap_or_else(|| "explorer.exe".into());
    Command::new(explorer)
        .raw_arg(format!("/select,\"{path}\""))
        .spawn()
        .is_ok()
}

struct Key(HKEY);
impl Drop for Key {
    fn drop(&mut self) {
        unsafe { RegCloseKey(self.0) };
    }
}

fn open_user_key(path: &str, access: u32) -> Option<Key> {
    let mut key: HKEY = null_mut();
    let status =
        unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, wide(path).as_ptr(), 0, access, &mut key) };
    (status == ERROR_SUCCESS).then_some(Key(key))
}

pub fn prefers_dark() -> bool {
    let mut value: u32 = 1;
    let mut size = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            wide(PERSONALIZE_KEY).as_ptr(),
            wide("AppsUseLightTheme").as_ptr(),
            RRF_RT_REG_DWORD,
            null_mut(),
            (&mut value as *mut u32).cast(),
            &mut size,
        )
    };
    let _ = REG_DWORD;
    status == ERROR_SUCCESS && value == 0
}

fn read_run_value() -> Option<String> {
    let mut size: u32 = 0;
    let name = wide(AUTOSTART_VALUE);
    let key = wide(RUN_KEY);
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            null_mut(),
            null_mut(),
            &mut size,
        )
    };
    if status != ERROR_SUCCESS || size == 0 || size > 64 * 1024 {
        return None;
    }
    let mut buffer = vec![0u16; (size as usize).div_ceil(2)];
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }
    let end = buffer
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..end]))
}

/// The Run command for `launcher`: quoted path plus the fixed login arguments.
pub fn autostart_command(launcher: &Path) -> String {
    format!("\"{}\" {LOGIN_ARGS}", launcher.display())
}

/// Enabled only when the value names this application's launcher with the login arguments.
pub fn autostart_enabled(launcher: &Path) -> bool {
    read_run_value().is_some_and(|value| value.eq_ignore_ascii_case(&autostart_command(launcher)))
}

pub fn set_autostart(launcher: &Path, enabled: bool) -> bool {
    let Some(key) = open_user_key(RUN_KEY, KEY_SET_VALUE | KEY_QUERY_VALUE) else {
        return false;
    };
    let name = wide(AUTOSTART_VALUE);
    let status = if enabled {
        let data = wide(autostart_command(launcher));
        unsafe {
            RegSetValueExW(
                key.0,
                name.as_ptr(),
                0,
                REG_SZ,
                data.as_ptr().cast(),
                (data.len() * 2) as u32,
            )
        }
    } else {
        match unsafe { RegDeleteValueW(key.0, name.as_ptr()) } {
            ERROR_FILE_NOT_FOUND => ERROR_SUCCESS,
            other => other,
        }
    };
    status == ERROR_SUCCESS && autostart_enabled(launcher) == enabled
}
