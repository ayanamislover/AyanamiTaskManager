//! `AyanamiTaskManager.exe --process-identity <pid>`: a process's birth time and image path,
//! read-only, for the core and the daemon.
//!
//! They used to start `powershell.exe` for this — about 190 ms per query on an idle machine,
//! two of them on every cold start, one gating the core's handshake (ATM-T-0523). This binary
//! sits in the same version directory as the core bundle, so it is exactly as trusted as the
//! code asking.
//!
//! Output, one value per line: creation time in .NET ticks (UTC; what PowerShell's
//! `StartTime.ToUniversalTime().Ticks` reports, so lock files written by older versions still
//! compare equal), creation time in Unix milliseconds, and the full image path. Exit code 1 when
//! the process cannot be opened (gone, access denied) or the argument is not a pid.

use std::io::Write;

/// FILETIME counts 100 ns from 1601-01-01; .NET ticks count 100 ns from 0001-01-01.
const FILETIME_TO_DOTNET_TICKS: u64 = 504_911_232_000_000_000;
/// 1601-01-01 to 1970-01-01 in milliseconds.
const FILETIME_EPOCH_TO_UNIX_MS: u64 = 11_644_473_600_000;

pub const FLAG: &str = "--process-identity";

/// The three output lines for a creation FILETIME and image path.
pub fn render(created: u64, image: &str) -> String {
    format!(
        "{}\n{}\n{}\n",
        created + FILETIME_TO_DOTNET_TICKS,
        (created / 10_000).saturating_sub(FILETIME_EPOCH_TO_UNIX_MS),
        image
    )
}

pub fn run(argument: Option<&str>) -> i32 {
    let Some(pid) = argument
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|pid| *pid > 0)
    else {
        return 1;
    };
    let Some((created, image)) = query(pid) else {
        return 1;
    };
    let mut stdout = std::io::stdout();
    if stdout
        .write_all(render(created, &image).as_bytes())
        .is_err()
        || stdout.flush().is_err()
    {
        return 1;
    }
    0
}

fn query(pid: u32) -> Option<(u64, String)> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
    };
    // SAFETY: a query-only handle, closed below on every path.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }
    let zero = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
    // SAFETY: valid handle and out-pointers to locals.
    let timed =
        unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) } != 0;
    let mut buffer = vec![0u16; 32_768];
    let mut size = buffer.len() as u32;
    // SAFETY: the buffer holds `size` UTF-16 units; the call writes at most that many.
    let named =
        unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size) } != 0;
    // SAFETY: opened above, not used after this.
    unsafe { CloseHandle(handle) };
    if !timed || !named {
        return None;
    }
    let created = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
    Some((created, String::from_utf16_lossy(&buffer[..size as usize])))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticks_and_milliseconds_match_what_powershell_reports() {
        // 2026-10-01T00:00:00Z: FILETIME 134352864000000000, .NET ticks 639264096000000000
        // (= Unix ms × 10000 + 621355968000000000, PowerShell's DateTime.Ticks).
        let created = 134_352_864_000_000_000;
        assert_eq!(
            render(created, r"C:\x\AyanamiTaskManager.exe"),
            "639264096000000000\n1790812800000\nC:\\x\\AyanamiTaskManager.exe\n"
        );
    }

    #[test]
    fn reads_its_own_process_and_refuses_what_is_not_a_pid() {
        let (created, image) = query(std::process::id()).expect("own process");
        assert!(created > 0);
        assert!(image.to_lowercase().ends_with(".exe"), "{image}");
        assert_eq!(run(None), 1);
        assert_eq!(run(Some("0")), 1);
        assert_eq!(run(Some("not-a-pid")), 1);
    }
}
