//! Health metadata the host writes under `<installRoot>\state\health\` (§3 exception):
//! the probe report and UI_CONFIRMED after the first renderer-ready of a version. Never a
//! version selector. The SERVICE_HEALTHY witness of a `--txn-start` is the runtime's own
//! (`atm_runtime::entries`): host and service are one process since W5a.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::paths::Layout;

fn health_dir(install_root: &Path) -> PathBuf {
    install_root
        .join(atm_install_state::STATE_DIR)
        .join("health")
}

/// Temporary file + rename: setup never reads a half-written witness.
pub fn write_atomically(dir: &Path, name: &str, body: &Value) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let temporary = dir.join(format!("{name}.{}.tmp", std::process::id()));
    fs::write(&temporary, body.to_string())?;
    fs::rename(&temporary, dir.join(name)).inspect_err(|_| {
        let _ = fs::remove_file(&temporary);
    })
}

/// A process's creation time in Unix milliseconds, exactly as setup reads it back for the
/// pid (GetProcessTimes on both sides; Node's own uptime arithmetic is only approximate).
fn started_at_ms(process: windows_sys::Win32::Foundation::HANDLE) -> u64 {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::GetProcessTimes;
    let zero = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
    let ok = unsafe { GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) };
    if ok == 0 {
        return 0;
    }
    let ticks = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
    // FILETIME counts 100 ns since 1601-01-01.
    (ticks / 10_000).saturating_sub(11_644_473_600_000)
}

pub fn process_started_at_ms() -> u64 {
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    started_at_ms(unsafe { GetCurrentProcess() })
}

/// The read-only probe's report for setup (§6 step 4).
pub fn probe_report(install_root: &Path, txn: &str, body: &Value) -> std::io::Result<()> {
    write_atomically(
        &health_dir(install_root),
        &format!("probe-{txn}.json"),
        body,
    )
}

pub fn ui_confirmed(layout: &Layout, version: &str, run_id: &str) {
    if !layout.packaged {
        return;
    }
    let Some(install_root) = layout.app_dir.parent() else {
        return;
    };
    if !install_root.join(atm_install_state::APP_POINTER).is_file() {
        return;
    }
    let dir = health_dir(install_root);
    let name = format!("ui-{version}.json");
    if dir.join(&name).is_file() {
        return;
    }
    let body = json!({ "version": version, "hostRunId": run_id, "pid": std::process::id() });
    let _ = write_atomically(&dir, &name, &body);
}
