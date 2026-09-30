//! The Squirrel/Electron 1.x layout under the same install root, and what a migration
//! moves aside (§6 ISOLATE) or a reverse migration puts back.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::fsx;
use crate::package::compare_versions;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Legacy {
    /// Highest Electron version present (`1.2.2`).
    pub version: String,
    /// Names under the install root that ISOLATE moves into `state\rollback\legacy\`:
    /// every Electron `app-*`, `Update.exe`, `packages`, a stale `.dead`.
    pub items: Vec<String>,
}

pub const LEGACY_PREFIX: &str = "legacy:";

pub fn is_electron_dir(dir: &Path) -> bool {
    dir.join("resources").join("app.asar").is_file()
}

pub fn is_new_style_dir(dir: &Path) -> bool {
    dir.join("runtime").join("core.mjs").is_file()
}

fn version_of(dir: &Path) -> Option<String> {
    atm_install_state::app_dir_version(dir)
}

/// A Squirrel install is present when Update.exe sits in the root next to at least one
/// Electron version directory.
pub fn detect(root: &Path) -> Option<Legacy> {
    if !root.join("Update.exe").is_file() {
        return None;
    }
    let mut electron: Vec<(String, String)> = fsx::list_dir(root)
        .into_iter()
        .filter(|path| path.is_dir() && is_electron_dir(path))
        .filter_map(|path| {
            let name = path.file_name()?.to_string_lossy().into_owned();
            Some((version_of(&path)?, name))
        })
        .collect();
    if electron.is_empty() {
        return None;
    }
    electron.sort_by(|left, right| compare_versions(&left.0, &right.0));
    let version = electron.last()?.0.clone();
    let mut items: Vec<String> = electron.into_iter().map(|(_, name)| name).collect();
    for extra in ["Update.exe", "packages", ".dead"] {
        if root.join(extra).exists() {
            items.push(extra.into());
        }
    }
    Some(Legacy { version, items })
}

pub fn legacy_pointer(version: &str) -> String {
    format!("{LEGACY_PREFIX}{version}")
}

pub fn parse_legacy_pointer(current: &str) -> Option<&str> {
    current.strip_prefix(LEGACY_PREFIX)
}

pub fn isolated_dir(rollback: &Path) -> PathBuf {
    rollback.join("legacy")
}

/// Where the original Squirrel stub is kept after FENCE replaces it with the launcher.
pub fn saved_stub(rollback: &Path) -> PathBuf {
    rollback.join("legacy-stub").join(crate::env::LAUNCHER)
}

pub fn migration_record(rollback: &Path) -> PathBuf {
    rollback.join("migration.json")
}

pub fn newstyle_dir(rollback: &Path) -> PathBuf {
    rollback.join("newstyle")
}

/// Move each item from `from` to `to` if it is still at `from`; idempotent, so a resumed
/// step picks up where a dead setup stopped.
pub fn move_items(items: &[String], from: &Path, to: &Path) -> Result<(), String> {
    for item in items {
        let source = from.join(item);
        let target = to.join(item);
        if source.exists() || std::fs::symlink_metadata(&source).is_ok() {
            if target.exists() {
                return Err(format!("{} already exists", target.display()));
            }
            fsx::move_path(&source, &target).map_err(|error| {
                format!("move {} → {}: {error}", source.display(), target.display())
            })?;
        }
    }
    Ok(())
}
