//! Health metadata the host writes under `<installRoot>\state\health\` (§3 exception):
//! the SERVICE_HEALTHY witness of a `--txn-start`, the probe report, and UI_CONFIRMED after
//! the first renderer-ready of a version. Never a version selector.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::paths::Layout;

#[derive(Debug, Clone)]
pub struct Witness {
    pub install_root: PathBuf,
    pub txn: String,
}

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

pub fn pid_started_at_ms(pid: u32) -> Option<u64> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }
    let started = started_at_ms(handle);
    unsafe { CloseHandle(handle) };
    (started != 0).then_some(started)
}

/// SERVICE_HEALTHY (§6): host and core identities side by side. Setup cross-checks every
/// field against the processes it can see and against daemon.json; nothing here is trusted
/// on its own.
pub fn service_witness(
    witness: &Witness,
    version: &str,
    run_id: &str,
    ready: &Value,
    core_pid: u32,
) {
    // The core's own frame names its pid; it must be the child this host started.
    if ready.get("pid").and_then(Value::as_u64) != Some(u64::from(core_pid)) {
        return;
    }
    let body = json!({
        "txnId": witness.txn,
        "version": version,
        "host": {
            "pid": std::process::id(),
            "startedAtMs": process_started_at_ms(),
            "runId": run_id,
        },
        "core": {
            "pid": core_pid,
            "startedAtMs": pid_started_at_ms(core_pid),
            "instanceId": ready.get("instanceId").and_then(Value::as_str),
        },
    });
    let _ = write_atomically(
        &health_dir(&witness.install_root),
        &format!("service-{}.json", witness.txn),
        &body,
    );
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
