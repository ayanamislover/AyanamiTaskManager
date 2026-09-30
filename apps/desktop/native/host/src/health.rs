//! Health metadata the host writes under `<installRoot>\state\health\` (§3 exception):
//! UI_CONFIRMED after the first renderer-ready of a version. Never a version selector.

use std::fs;
use std::path::Path;

use crate::paths::Layout;

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
    let dir = install_root
        .join(atm_install_state::STATE_DIR)
        .join("health");
    let file = dir.join(format!("ui-{version}.json"));
    if file.is_file() {
        return;
    }
    let _ = fs::create_dir_all(&dir);
    let body =
        serde_json::json!({ "version": version, "hostRunId": run_id, "pid": std::process::id() });
    let temporary = dir.join(format!("ui-{version}.json.{}.tmp", std::process::id()));
    if fs::write(&temporary, body.to_string()).is_ok() {
        let _ = fs::rename(&temporary, &file);
    }
    let _ = Path::new(&temporary);
}
