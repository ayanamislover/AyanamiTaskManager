//! `state\setup.log` (bounded, one rotation) plus stderr when a console is attached, and
//! the few user-facing prompts. Never logs tokens: nothing here ever sees one.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use windows_sys::Win32::UI::WindowsAndMessaging::{
    IDOK, MB_ICONINFORMATION, MB_ICONWARNING, MB_OK, MB_OKCANCEL, MB_SETFOREGROUND, MessageBoxW,
};

const MAX_LOG_BYTES: u64 = 1024 * 1024;

static LOG: Mutex<Option<PathBuf>> = Mutex::new(None);
static QUIET: Mutex<bool> = Mutex::new(false);

pub fn init(state_dir: &Path, quiet: bool) {
    let _ = fs::create_dir_all(state_dir);
    if let Ok(mut log) = LOG.lock() {
        *log = Some(state_dir.join("setup.log"));
    }
    if let Ok(mut flag) = QUIET.lock() {
        *flag = quiet;
    }
}

pub fn quiet() -> bool {
    QUIET.lock().map(|flag| *flag).unwrap_or(true)
}

pub fn line(text: &str) {
    eprintln!("{text}");
    let Some(path) = LOG.lock().ok().and_then(|log| log.clone()) else {
        return;
    };
    if fs::metadata(&path).is_ok_and(|metadata| metadata.len() > MAX_LOG_BYTES) {
        let _ = fs::rename(&path, path.with_extension("1.log"));
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(
            file,
            "{} pid={} {text}",
            crate::store::now_ms(),
            std::process::id()
        );
    }
}

#[macro_export]
macro_rules! say {
    ($($arg:tt)*) => { $crate::log::line(&format!($($arg)*)) };
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn inform(text: &str) {
    line(text);
    if quiet() {
        return;
    }
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            wide(text).as_ptr(),
            wide("AyanamiTaskManager 安装").as_ptr(),
            MB_OK | MB_ICONINFORMATION | MB_SETFOREGROUND,
        )
    };
}

pub fn warn(text: &str) {
    line(text);
    if quiet() {
        return;
    }
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            wide(text).as_ptr(),
            wide("AyanamiTaskManager 安装").as_ptr(),
            MB_OK | MB_ICONWARNING | MB_SETFOREGROUND,
        )
    };
}

/// OK/Cancel; quiet mode answers Cancel (nothing is decided for an absent user).
pub fn confirm(text: &str) -> bool {
    line(text);
    if quiet() {
        return false;
    }
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            wide(text).as_ptr(),
            wide("AyanamiTaskManager 安装").as_ptr(),
            MB_OKCANCEL | MB_ICONINFORMATION | MB_SETFOREGROUND,
        ) == IDOK
    }
}
