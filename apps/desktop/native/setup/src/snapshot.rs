//! SNAPSHOT (§6 step 5): everything a failed transaction must put back, collected before
//! FENCE touches anything. `snapshotComplete` is set only after this file is on disk; an
//! incomplete snapshot is never used for a restore.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use atm_install_state::AppPointer;
use serde::{Deserialize, Serialize};

use crate::env::{self, Env};
use crate::fsx::{self, LinkState};
use crate::legacy::Legacy;
use crate::registry::{self, RawValue};
use crate::shortcut::{self, Shortcut};

/// Stable files in the install root (§3), relative.
pub const ROOT_FILES: [&str; 3] = [env::LAUNCHER, env::SETUP, r"resources\atm-mcp.exe"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootFile {
    pub relative: String,
    /// A copy was saved under `state\txn\<id>\root\`; `false` = the file did not exist.
    pub saved: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutSnapshot {
    pub path: PathBuf,
    pub value: Option<Shortcut>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "target")]
pub enum LinkSnapshot {
    Missing,
    Link(PathBuf),
    Occupied,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub txn: String,
    pub pointer: Option<AppPointer>,
    pub root_files: Vec<RootFile>,
    pub current_link: LinkSnapshot,
    pub uninstall: Option<BTreeMap<String, RawValue>>,
    pub run: Option<RawValue>,
    pub shortcuts: Vec<ShortcutSnapshot>,
    pub legacy: Option<Legacy>,
}

fn path(env: &Env, txn: &str) -> PathBuf {
    env.txn_dir(txn).join("snapshot.json")
}

fn saved_root(env: &Env, txn: &str) -> PathBuf {
    env.txn_dir(txn).join("root")
}

pub fn shortcut_paths(env: &Env) -> Vec<PathBuf> {
    vec![
        env.start_menu_shortcut(),
        env.desktop_shortcut(),
        env.repair_shortcut(),
    ]
}

pub fn take(
    env: &Env,
    txn: &str,
    pointer: Option<AppPointer>,
    legacy: Option<Legacy>,
) -> Result<Snapshot, String> {
    let saved = saved_root(env, txn);
    let mut root_files = Vec::new();
    for relative in ROOT_FILES {
        let source = env.install_root.join(relative);
        let exists = source.is_file();
        if exists {
            let target = saved.join(relative);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::copy(&source, &target).map_err(|error| format!("save {relative}: {error}"))?;
        }
        root_files.push(RootFile {
            relative: relative.into(),
            saved: exists,
        });
    }
    let current_link = match fsx::link_state(&env.current_link()) {
        LinkState::Missing => LinkSnapshot::Missing,
        LinkState::Link(target) => LinkSnapshot::Link(target),
        LinkState::Occupied => LinkSnapshot::Occupied,
    };
    let mut shortcuts = Vec::new();
    for shortcut_path in shortcut_paths(env) {
        shortcuts.push(ShortcutSnapshot {
            value: shortcut::read(&shortcut_path)?,
            path: shortcut_path,
        });
    }
    let snapshot = Snapshot {
        txn: txn.into(),
        pointer,
        root_files,
        current_link,
        uninstall: registry::read_key(&env.uninstall_key)?,
        run: registry::read_value(&env.run_key, env::RUN_VALUE)?,
        shortcuts,
        legacy,
    };
    fsx::write_json_atomic(&path(env, txn), &snapshot).map_err(|error| error.to_string())?;
    Ok(snapshot)
}

pub fn load(env: &Env, txn: &str) -> Result<Snapshot, String> {
    fsx::read_json_limited(&path(env, txn), 16 * 1024 * 1024)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "SNAPSHOT_MISSING".into())
}

/// Stable root files back to what they were (a file that did not exist is removed).
pub fn restore_root_files(env: &Env, snapshot: &Snapshot) -> Result<(), String> {
    let saved = saved_root(env, &snapshot.txn);
    for file in &snapshot.root_files {
        let target = env.install_root.join(&file.relative);
        if file.saved {
            fsx::replace_file(&target, &saved.join(&file.relative))
                .map_err(|error| format!("restore {}: {error}", file.relative))?;
        } else if target.is_file() {
            // A running new launcher/shim cannot be deleted, but it can be renamed aside.
            let aside = target.with_file_name(format!(
                "{}.old",
                target.file_name().unwrap_or_default().to_string_lossy()
            ));
            let _ = fs::remove_file(&aside);
            fsx::move_path(&target, &aside)
                .map_err(|error| format!("remove {}: {error}", file.relative))?;
        }
    }
    Ok(())
}

pub fn restore_current_link(env: &Env, snapshot: &Snapshot) -> Result<(), String> {
    let link = env.current_link();
    match &snapshot.current_link {
        LinkSnapshot::Link(target) => {
            fsx::retarget_junction(&link, target).map_err(|error| error.to_string())
        }
        LinkSnapshot::Missing => match fsx::link_state(&link) {
            LinkState::Link(_) => fs::remove_dir(&link).map_err(|error| error.to_string()),
            _ => Ok(()),
        },
        // It was a real directory and we never replaced it.
        LinkSnapshot::Occupied => Ok(()),
    }
}

pub fn restore_registrations(env: &Env, snapshot: &Snapshot) -> Result<(), String> {
    registry::restore_key(&env.uninstall_key, &snapshot.uninstall)?;
    match &snapshot.run {
        Some(value) => registry::write_value(&env.run_key, env::RUN_VALUE, value)?,
        None => registry::delete_value(&env.run_key, env::RUN_VALUE)?,
    }
    for entry in &snapshot.shortcuts {
        match &entry.value {
            Some(value) => shortcut::write(&entry.path, value)?,
            None => {
                if entry.path.is_file() {
                    fs::remove_file(&entry.path).map_err(|error| error.to_string())?;
                }
            }
        }
    }
    Ok(())
}

pub fn saved_root_file(env: &Env, txn: &str, relative: &str) -> PathBuf {
    saved_root(env, txn).join(relative)
}
