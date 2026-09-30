//! PRECHECK: is an Evergreen WebView2 runtime installed, and new enough (§11 risk)?
//! Read from the EdgeUpdate client registration, per-machine or per-user.

use windows_sys::Win32::Foundation::ERROR_SUCCESS;
use windows_sys::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6432KEY, RegGetValueW,
};

const CLIENT: &str =
    r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn read(root: HKEY, flags: u32) -> Option<String> {
    let mut buffer = vec![0u16; 128];
    let mut size = (buffer.len() * 2) as u32;
    let status = unsafe {
        RegGetValueW(
            root,
            wide(CLIENT).as_ptr(),
            wide("pv").as_ptr(),
            RRF_RT_REG_SZ | flags,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }
    let end = buffer
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(buffer.len());
    let version = String::from_utf16_lossy(&buffer[..end]);
    // "0.0.0.0" is what an uninstalled registration leaves behind.
    (!version.is_empty() && version != "0.0.0.0").then_some(version)
}

pub fn installed_version() -> Option<String> {
    read(HKEY_LOCAL_MACHINE, RRF_SUBKEY_WOW6432KEY)
        .or_else(|| read(HKEY_LOCAL_MACHINE, 0))
        .or_else(|| read(HKEY_CURRENT_USER, 0))
}

pub fn check(minimum: &str) -> Result<String, String> {
    let installed = installed_version().ok_or("WEBVIEW2_RUNTIME_MISSING")?;
    if crate::package::compare_versions(&installed, minimum).is_lt() {
        return Err(format!("WEBVIEW2_RUNTIME_TOO_OLD: {installed} < {minimum}"));
    }
    Ok(installed)
}
