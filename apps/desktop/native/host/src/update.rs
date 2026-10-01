//! Installing a delivered update (de-electron §8 update bridge): the core finds the
//! package in `<dataDir>\updates` and asks; the host starts the stable installer.
//!
//! The host, not the core, starts it. The core runs on Node, whose children inherit every
//! inheritable handle — the core's own protocol pipes included. A setup holding the core's
//! stdout keeps the host from ever seeing the core exit during QUIESCE, while setup waits
//! for the host: both stall until the timeout. The host's pipe ends are not inheritable
//! and its std handles were made non-inheritable at start.
//!
//! The core is trusted to pick the version, not the paths: the installer is always this
//! install root's `atm-setup.exe`, and the manifest must be a plainly named file directly
//! in the data root's `updates` folder.

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const DETACHED_PROCESS: u32 = 0x0000_0008;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// `atm-<version>-win-x64.json`, the version as the packager writes it.
fn manifest_name_valid(name: &str) -> bool {
    let Some(version) = name
        .strip_prefix("atm-")
        .and_then(|rest| rest.strip_suffix("-win-x64.json"))
    else {
        return false;
    };
    let (core, pre) = match version.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (version, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty() && part.len() <= 9 && part.bytes().all(|b| b.is_ascii_digit())
        })
        && pre.is_none_or(|pre| {
            !pre.is_empty()
                && pre.len() <= 32
                && pre.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.')
        })
}

fn canonical(path: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok()
}

/// The installer to run and the manifest to give it, or why not.
pub fn resolve(
    app_dir: &Path,
    data_dir: &Path,
    manifest: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let install_root = app_dir.parent().ok_or("UPDATE_NOT_INSTALLED")?;
    if !install_root.join(atm_install_state::APP_POINTER).is_file() {
        return Err("UPDATE_NOT_INSTALLED: portable or development layout".into());
    }
    let setup = install_root.join("atm-setup.exe");
    if !setup.is_file() {
        return Err("UPDATE_RUNNER_MISSING".into());
    }
    let manifest = PathBuf::from(manifest);
    let name = manifest
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("UPDATE_MANIFEST_INVALID")?;
    if !manifest.is_absolute() || !manifest_name_valid(name) {
        return Err("UPDATE_MANIFEST_INVALID".into());
    }
    // Canonical forms on both sides: a junction or `..` cannot step out of the folder.
    let feed = canonical(&data_dir.join("updates")).ok_or("UPDATE_FEED_MISSING")?;
    let resolved = canonical(&manifest).ok_or("UPDATE_MANIFEST_MISSING")?;
    if resolved.parent() != Some(feed.as_path()) || !resolved.is_file() {
        return Err("UPDATE_MANIFEST_OUTSIDE_FEED".into());
    }
    Ok((setup, manifest))
}

/// Start `atm-setup --update <manifest> --quiet --show`, detached: it stops this host
/// (QUIESCE) and starts the new version with its window.
pub fn install(app_dir: &Path, data_dir: &Path, manifest: &str) -> Result<(), String> {
    let (setup, manifest) = resolve(app_dir, data_dir, manifest)?;
    Command::new(&setup)
        .arg("--update")
        .arg(&manifest)
        .args(["--quiet", "--show"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("UPDATE_START_FAILED: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("target")
            .join("host-tests")
            .join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        std::path::absolute(dir).unwrap()
    }

    #[test]
    fn manifest_names_are_exactly_what_the_packager_writes() {
        for good in [
            "atm-2.0.0-win-x64.json",
            "atm-10.20.30-win-x64.json",
            "atm-2.0.0-rc.1-win-x64.json",
        ] {
            assert!(manifest_name_valid(good), "{good}");
        }
        for bad in [
            "atm-2.0-win-x64.json",
            "atm-2.0.0-win-x64.zip",
            "atm-..-win-x64.json",
            "atm-2.0.0-a b-win-x64.json",
            "atm-2.0.0-win-x64.json:stream",
            "x-atm-2.0.0-win-x64.json",
        ] {
            assert!(!manifest_name_valid(bad), "{bad}");
        }
    }

    #[test]
    fn only_a_manifest_directly_in_the_feed_of_an_installed_layout() {
        let dir = scratch("update-resolve");
        let (root, data) = (dir.join("install"), dir.join("data"));
        let app = root.join("app-2.0.0");
        fs::create_dir_all(&app).unwrap();
        fs::create_dir_all(data.join("updates").join("nested")).unwrap();
        let manifest = data.join("updates").join("atm-2.0.1-win-x64.json");
        fs::write(&manifest, b"{}").unwrap();
        fs::write(data.join("atm-2.0.1-win-x64.json"), b"{}").unwrap();
        fs::write(
            data.join("updates")
                .join("nested")
                .join("atm-2.0.1-win-x64.json"),
            b"{}",
        )
        .unwrap();
        let text = |path: &Path| path.to_string_lossy().into_owned();

        // Not installed: no app.json, no installer.
        assert!(
            resolve(&app, &data, &text(&manifest))
                .unwrap_err()
                .starts_with("UPDATE_NOT_INSTALLED")
        );
        fs::write(root.join(atm_install_state::APP_POINTER), b"{}").unwrap();
        assert_eq!(
            resolve(&app, &data, &text(&manifest)).unwrap_err(),
            "UPDATE_RUNNER_MISSING"
        );
        fs::write(root.join("atm-setup.exe"), b"").unwrap();

        let (setup, chosen) = resolve(&app, &data, &text(&manifest)).unwrap();
        assert_eq!(setup, root.join("atm-setup.exe"));
        assert_eq!(chosen, manifest);
        for outside in [
            data.join("atm-2.0.1-win-x64.json"),
            data.join("updates")
                .join("nested")
                .join("atm-2.0.1-win-x64.json"),
            data.join("updates")
                .join("nested")
                .join("..")
                .join("..")
                .join("atm-2.0.1-win-x64.json"),
        ] {
            assert_eq!(
                resolve(&app, &data, &text(&outside)).unwrap_err(),
                "UPDATE_MANIFEST_OUTSIDE_FEED",
                "{}",
                outside.display()
            );
        }
        assert_eq!(
            resolve(&app, &data, "atm-2.0.1-win-x64.json").unwrap_err(),
            "UPDATE_MANIFEST_INVALID"
        );
        assert_eq!(
            resolve(
                &app,
                &data,
                &text(&data.join("updates").join("atm-9.9.9-win-x64.json"))
            )
            .unwrap_err(),
            "UPDATE_MANIFEST_MISSING"
        );
        fs::remove_dir_all(&dir).unwrap();
    }
}
