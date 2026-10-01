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

/// Every Squirrel/Electron entry in the root right now, whether or not Update.exe is
/// still there: SEAL requires this to be empty, and ISOLATE moves whatever it finds — the
/// updater can produce an `app-1.x.y` or a `.dead` after the snapshot was taken.
pub fn scan_items(root: &Path) -> Vec<String> {
    let mut items: Vec<String> = fsx::list_dir(root)
        .into_iter()
        .filter(|path| path.is_dir() && is_electron_dir(path))
        .filter_map(|path| Some(path.file_name()?.to_string_lossy().into_owned()))
        .collect();
    items.sort();
    for extra in ["Update.exe", "packages", ".dead"] {
        if root.join(extra).exists() {
            items.push(extra.into());
        }
    }
    items
}

/// `base` plus whatever `found` adds, in order; `None` when nothing is new.
pub fn with_new_items(base: &[String], found: Vec<String>) -> Option<Vec<String>> {
    let added: Vec<String> = found
        .into_iter()
        .filter(|item| !base.contains(item))
        .collect();
    if added.is_empty() {
        return None;
    }
    Some(base.iter().cloned().chain(added).collect())
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
/// Undo of [`move_items`] (`from`/`to` as in the forward call): each item moved with one
/// atomic rename, so an item still at its original place was never moved, and whatever has
/// its name at the far end is a leftover of an earlier cycle — not ours to bring back.
pub fn move_back(items: &[String], from: &Path, to: &Path) -> Result<(), String> {
    for item in items {
        let original = from.join(item);
        let moved = to.join(item);
        if original.exists() || std::fs::symlink_metadata(&original).is_ok() {
            continue;
        }
        if moved.exists() || std::fs::symlink_metadata(&moved).is_ok() {
            fsx::move_path(&moved, &original).map_err(|error| {
                format!("move {} → {}: {error}", moved.display(), original.display())
            })?;
        }
    }
    Ok(())
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("target")
            .join("setup-tests")
            .join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        std::path::absolute(dir).unwrap()
    }

    /// Round trip to Electron and forward again leaves `newstyle\app-2.0.0` behind; the next
    /// reverse migration fails before moving anything and undoes. The live directory must stay
    /// and the leftover must not be brought back over it.
    #[test]
    fn move_back_skips_items_that_never_moved_and_ignores_leftovers() {
        let dir = scratch("move-back");
        let (root, aside) = (dir.join("root"), dir.join("aside"));
        for path in [
            root.join("app-2.0.0"),
            aside.join("app-2.0.0"),
            aside.join("app-2.0.1"),
        ] {
            fs::create_dir_all(&path).unwrap();
        }
        fs::write(root.join("app-2.0.0").join("live"), b"").unwrap();
        fs::write(aside.join("app-2.0.0").join("stale"), b"").unwrap();
        let items = vec!["app-2.0.0".to_owned(), "app-2.0.1".to_owned()];
        assert!(
            move_items(&items, &root, &aside)
                .unwrap_err()
                .contains("already exists")
        );
        move_back(&items, &root, &aside).unwrap();
        assert!(root.join("app-2.0.0").join("live").is_file());
        assert!(aside.join("app-2.0.0").join("stale").is_file());
        // app-2.0.1 had been moved aside: it comes back.
        assert!(root.join("app-2.0.1").is_dir() && !aside.join("app-2.0.1").exists());
        // Resumed after finishing: nothing left to do, nothing disturbed.
        move_back(&items, &root, &aside).unwrap();
        assert!(root.join("app-2.0.0").join("live").is_file() && root.join("app-2.0.1").is_dir());
    }
}
