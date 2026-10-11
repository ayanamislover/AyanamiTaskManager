//! `--health-probe --txn <id>` (de-electron §6 step 4; 3.0: 方案 §6 PROBE): can this staged version run on
//! this machine and this data? Setup runs it while the old version keeps serving, so it is read-only end to
//! end: no window, tray, pipe or lease, no service, no conversion, and nothing written under either data root —
//! not even logs. The data check runs in this process (`atm_store::probe`, W8a: there is no Node core to
//! ask). The only output is the report in `<installRoot>\state\health\probe-<txn>.json` and the exit code.

use std::path::Path;

use serde_json::{Value, json};

use crate::paths::Layout;

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

/// The report setup reads: `ok` and `code` decide; the rest is for the person reading the install log.
fn report(
    txn: &str,
    version: &str,
    webview: &Result<String, String>,
    data: &Result<atm_store::probe::Report, atm_store::probe::Failure>,
) -> Value {
    let code = match (webview, data) {
        (Err(error), _) => json!(error.split(':').next().unwrap_or("WEBVIEW2_QUERY_FAILED")),
        (Ok(_), Err(failure)) => json!(failure.code),
        (Ok(_), Ok(_)) => Value::Null,
    };
    let databases = data.as_ref().ok().map(|r| {
        r.databases
            .iter()
            .map(|d| json!({ "scope": d.scope, "version": d.version }))
            .collect::<Vec<_>>()
    });
    json!({
        "txnId": txn,
        "version": version,
        "ok": webview.is_ok() && data.is_ok(),
        "code": code,
        "startup": data.as_ref().ok().map(|r| r.startup),
        "scope": data.as_ref().err().map(|f| f.scope),
        "databases": databases,
        "webview2": webview.as_ref().ok(),
        // Only on failure, bounded; it goes to the install root, never the data root.
        "detail": data.as_ref().err().map(|f| f.detail.chars().take(2000).collect::<String>()),
    })
}

pub fn run(layout: &Layout, install_root: &Path, version: &str, txn: &str) -> i32 {
    let webview = webview2_version();
    let data = atm_store::probe::run(
        &layout.v3_root,
        &layout.data_dir,
        Some(atm_runtime::secrets::check),
    );
    let report = report(txn, version, &webview, &data);
    let ok = report["ok"] == Value::Bool(true);
    match crate::health::probe_report(install_root, txn, &report) {
        Ok(()) if ok => 0,
        _ => EXIT_PROBE_FAILED,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use atm_store::probe::{Checked, Failure, Report};

    /// setup 只看 `ok` 与 `code`：两者都过才是 ok；WebView2 缺失优先报，数据的错误码原样给出、带上哪一处。
    #[test]
    fn the_report_is_ok_only_when_webview2_and_the_data_both_pass() {
        let good = Ok(Report {
            startup: "PUBLISHED",
            databases: vec![Checked {
                scope: "v3",
                version: Some(7),
            }],
        });
        let bad: Result<Report, Failure> = Err(Failure {
            code: "V3_SCHEMA_UNKNOWN",
            scope: "v3",
            detail: "database has migration 99".into(),
        });
        let webview = Ok("140.0".to_owned());
        let missing = Err("WEBVIEW2_RUNTIME_MISSING".to_owned());

        let r = report("T", "3.0.0", &webview, &good);
        assert_eq!(
            (r["ok"].clone(), r["code"].clone()),
            (json!(true), Value::Null)
        );
        assert_eq!(r["startup"], "PUBLISHED");
        assert_eq!(r["databases"], json!([{ "scope": "v3", "version": 7 }]));
        assert_eq!(r["detail"], Value::Null);

        let r = report("T", "3.0.0", &webview, &bad);
        assert_eq!(
            (r["ok"].clone(), r["code"].clone(), r["scope"].clone()),
            (json!(false), json!("V3_SCHEMA_UNKNOWN"), json!("v3"))
        );
        assert_eq!(r["detail"], "database has migration 99");

        for data in [&good, &bad] {
            let r = report("T", "3.0.0", &missing, data);
            assert_eq!(
                (r["ok"].clone(), r["code"].clone()),
                (json!(false), json!("WEBVIEW2_RUNTIME_MISSING"))
            );
        }
    }
}
