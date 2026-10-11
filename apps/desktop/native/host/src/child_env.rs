//! What the host's children inherit, and whether the data root is the product's own. The children are
//! atm.exe and atm-mcp.exe (headless.rs) and WebView2; there is no Node child any more (W8a).

use std::path::Path;
use std::process::Command;

/// Variables that could inject code or debugging into a child: Node (the 2.x helpers a user may still
/// have on PATH), Electron and WebView2 switches, and the product-root marker below.
fn scrubbed(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    upper.starts_with("NODE_")
        || upper.starts_with("ELECTRON_")
        || upper.starts_with("WEBVIEW2_")
        || upper == "UV_THREADPOOL_SIZE"
        || upper == PRODUCT_DATA_ROOT
}

/// 2.x set this for its Node core once the host had established the product's default data root. 3.0
/// sets it for no one; an inherited value is still scrubbed, never trusted.
const PRODUCT_DATA_ROOT: &str = "ATM_PRODUCT_DATA_ROOT";

fn same_path(left: &Path, right: &Path) -> bool {
    let normal = |path: &Path| {
        path.to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .to_lowercase()
    };
    normal(left) == normal(right)
}

/// No ATM_DATA_DIR / AYANAMI_TASK_DATA_DIR override reached the host, and LOCALAPPDATA is
/// the real Local AppData known folder — so `data_dir` is `<Local AppData>\AyanamiTaskManager`
/// because it is the product root, not because a sandbox redirected LOCALAPPDATA.
pub(crate) fn product_default_data_root(data_dir: &Path) -> bool {
    let overridden = ["ATM_DATA_DIR", "AYANAMI_TASK_DATA_DIR"]
        .iter()
        .any(|key| std::env::var_os(key).is_some_and(|value| !value.is_empty()));
    if overridden {
        return false;
    }
    let (Some(local), Some(known)) = (
        std::env::var_os("LOCALAPPDATA"),
        crate::win::known_local_app_data(),
    ) else {
        return false;
    };
    same_path(Path::new(&local), &known) && same_path(data_dir, &known.join("AyanamiTaskManager"))
}

pub fn scrub_environment(command: &mut Command) {
    for (key, _) in std::env::vars_os() {
        if let Some(key) = key.to_str().filter(|key| scrubbed(key)) {
            command.env_remove(key);
        }
    }
    // Test builds only. The packaged smoke isolates Agent configs under a synthetic home, but
    // WebView2 does not start under a synthetic USERPROFILE; so the host keeps the real profile
    // and its headless children — atm.exe reads Agent configs from the home — get this one.
    #[cfg(feature = "smoke")]
    if let Some(home) = std::env::var_os("ATM_SMOKE_CORE_USERPROFILE") {
        command.env("USERPROFILE", &home).env("HOME", &home);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn product_data_root_marker_is_never_inherited_and_paths_compare_like_windows() {
        assert!(scrubbed("ATM_PRODUCT_DATA_ROOT"));
        assert!(scrubbed("atm_product_data_root"));
        assert!(same_path(
            Path::new(r"C:\Users\U\AppData\Local\AyanamiTaskManager\"),
            Path::new(r"c:\users\u\appdata\local\ayanamitaskmanager"),
        ));
        assert!(!same_path(
            Path::new(r"C:\Users\U\AppData\Local\AyanamiTaskManager"),
            Path::new(r"C:\sandbox\Local\AyanamiTaskManager"),
        ));
    }

    #[test]
    fn injection_variables_are_scrubbed() {
        for key in [
            "NODE_OPTIONS",
            "node_options",
            "ELECTRON_RUN_AS_NODE",
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        ] {
            assert!(scrubbed(key), "{key}");
        }
        for key in ["ATM_DATA_DIR", "PATH", "LOCALAPPDATA"] {
            assert!(!scrubbed(key), "{key}");
        }
    }
}
