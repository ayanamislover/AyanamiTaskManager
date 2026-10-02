//! `--health-probe --txn <id>` (de-electron §6 step 4): can this staged version run on this
//! machine and this data? Setup runs it while the old version keeps serving, so it is
//! read-only end to end: no window, tray, pipe or lease, no service, and nothing written
//! under the data root — not even logs. The only output is the report in
//! `<installRoot>\state\health\probe-<txn>.json` and the exit code.

use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::core_process::{Core, CoreEvent, Launch, Spawn};
use crate::paths::Layout;

const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const EXIT_GRACE: Duration = Duration::from_secs(5);
pub const EXIT_PROBE_FAILED: i32 = 4;

/// The installed Evergreen runtime's version, or why there is none. Asks the loader only;
/// creating an environment would need a user data folder, i.e. a write.
fn webview2_version() -> Result<String, String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::GetAvailableCoreWebView2BrowserVersionString;
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::core::{PCWSTR, PWSTR};
    let mut version = PWSTR::null();
    unsafe { GetAvailableCoreWebView2BrowserVersionString(PCWSTR::null(), &mut version) }
        .map_err(|error| format!("WEBVIEW2_QUERY_FAILED: {error}"))?;
    if version.is_null() {
        return Err("WEBVIEW2_RUNTIME_MISSING".into());
    }
    let text = unsafe { version.to_string() }.unwrap_or_default();
    unsafe { CoTaskMemFree(Some(version.0 as *const _)) };
    Ok(text)
}

/// Runs the core in probe mode and waits for its `probed` frame and its exit.
fn probe_core(layout: &Layout, version: &str, txn: &str) -> (Option<Value>, Option<i32>, String) {
    let (sender, receiver) = mpsc::channel();
    let run_id = format!("probe-{txn}");
    let core = match Core::spawn(
        &layout.core,
        &layout.data_dir,
        Spawn {
            run_id: &run_id,
            version,
            launch: Launch {
                background: true,
                agent_wake: false,
                random_startup_delay: false,
            },
            probe_txn: Some(txn),
            stderr_log: None,
        },
        move |event| {
            let _ = sender.send(event);
        },
    ) {
        Ok(core) => core,
        Err(error) => return (None, None, error),
    };
    let mut probed = None;
    let mut exit = None;
    let deadline = Instant::now() + PROBE_TIMEOUT;
    while exit.is_none() {
        let Some(left) = deadline.checked_duration_since(Instant::now()) else {
            break;
        };
        match receiver.recv_timeout(left) {
            Ok(CoreEvent::Probed(frame)) => {
                probed = Some(frame);
                // Closing stdin is the protocol's "done": the core exits 0.
                core.shutdown();
            }
            Ok(CoreEvent::Exited(code)) => exit = Some(code),
            Ok(_) => {}
            Err(_) => break,
        }
    }
    // "The probe process has exited and released its handles" gates the next step.
    core.shutdown();
    core.wait_or_kill(EXIT_GRACE);
    let code = exit.flatten();
    (probed, code, core.stderr_tail())
}

pub fn run(layout: &Layout, install_root: &Path, version: &str, txn: &str) -> i32 {
    let webview = webview2_version();
    let (probed, core_exit, stderr) = probe_core(layout, version, txn);
    let core_ok = probed
        .as_ref()
        .and_then(|frame| frame.get("ok"))
        .and_then(Value::as_bool)
        == Some(true)
        && core_exit == Some(0);
    let ok = webview.is_ok() && core_ok;
    let field = |name: &str| probed.as_ref().and_then(|frame| frame.get(name)).cloned();
    let code = match (&webview, &probed) {
        (Err(error), _) => json!(error.split(':').next().unwrap_or("WEBVIEW2_QUERY_FAILED")),
        (Ok(_), None) => json!("CORE_PROBE_NO_RESULT"),
        (Ok(_), Some(_)) if !core_ok => field("code").unwrap_or(json!("CORE_PROBE_EXIT")),
        _ => Value::Null,
    };
    let report = json!({
        "txnId": txn,
        "version": version,
        "ok": ok,
        "code": code,
        "scope": field("scope"),
        "databases": field("databases"),
        "webview2": webview.as_ref().ok(),
        "coreExit": core_exit,
        // Only on failure, bounded; it goes to the install root, never the data root.
        "stderr": (!ok).then(|| stderr.chars().take(2000).collect::<String>()),
    });
    match crate::health::probe_report(install_root, txn, &report) {
        Ok(()) if ok => 0,
        _ => EXIT_PROBE_FAILED,
    }
}
