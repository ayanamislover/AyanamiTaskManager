//! COMMIT (§6 step 11) and uninstall's inverse: the Uninstall key, shortcuts (plus the
//! "ATM 修复" entry), and the Run value — only if the user had it, keeping its arguments,
//! now pointing straight at the root launcher instead of through `current`.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use crate::env::{self, Env};
use crate::fsx;
use crate::registry::{self, RawValue};
use crate::shortcut::{self, Shortcut};
use crate::snapshot::Snapshot;

const DEFAULT_RUN_ARGS: &str = "--background --random-startup-delay";

fn quoted(path: &Path) -> String {
    format!("\"{}\"", path.display())
}

/// The arguments of a Run command line after its (possibly quoted) executable.
pub fn run_arguments(command: &str) -> String {
    let command = command.trim();
    let rest = if let Some(stripped) = command.strip_prefix('"') {
        stripped.split_once('"').map(|(_, rest)| rest).unwrap_or("")
    } else {
        command.split_once(' ').map(|(_, rest)| rest).unwrap_or("")
    };
    rest.trim().to_owned()
}

fn today() -> String {
    // Civil date from Unix days (Howard Hinnant's algorithm), local enough for InstallDate.
    let days = (crate::store::now_ms() / 86_400_000) as i64;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}{month:02}{day:02}")
}

fn uninstall_values(
    env: &Env,
    version: &str,
    previous: Option<&BTreeMap<String, RawValue>>,
) -> BTreeMap<String, RawValue> {
    let root = &env.install_root;
    let kib = (fsx::dir_size(&env.app_dir(version))
        + crate::snapshot::ROOT_FILES
            .iter()
            .map(|relative| fsx::dir_size(&root.join(relative)))
            .sum::<u64>())
        / 1024;
    let mut values = BTreeMap::new();
    let text = |value: String| RawValue::string(&value);
    values.insert("DisplayName".into(), text(env::DISPLAY_NAME.into()));
    values.insert("DisplayVersion".into(), text(version.into()));
    values.insert("Publisher".into(), text(env::PUBLISHER.into()));
    values.insert("InstallLocation".into(), text(root.display().to_string()));
    values.insert(
        "DisplayIcon".into(),
        text(format!("{},0", env.launcher().display())),
    );
    values.insert(
        "UninstallString".into(),
        text(format!("{} --uninstall", quoted(&env.setup()))),
    );
    values.insert(
        "QuietUninstallString".into(),
        text(format!("{} --uninstall --quiet", quoted(&env.setup()))),
    );
    values.insert("NoModify".into(), RawValue::dword(1));
    values.insert("NoRepair".into(), RawValue::dword(1));
    values.insert(
        "EstimatedSize".into(),
        RawValue::dword(kib.min(u64::from(u32::MAX)) as u32),
    );
    // Keep what the first install recorded.
    let kept = |name: &str| previous.and_then(|values| values.get(name)).cloned();
    values.insert(
        "InstallDate".into(),
        kept("InstallDate").unwrap_or_else(|| RawValue::string(&today())),
    );
    if let Some(language) = kept("Language") {
        values.insert("Language".into(), language);
    }
    values
}

fn app_shortcut(env: &Env, toast_clsid: Option<String>) -> Shortcut {
    Shortcut {
        target: env.launcher().display().to_string(),
        arguments: String::new(),
        working_dir: env.install_root.display().to_string(),
        icon_path: env.launcher().display().to_string(),
        icon_index: 0,
        description: env::DISPLAY_NAME.into(),
        app_user_model_id: Some(env::APP_USER_MODEL_ID.into()),
        toast_activator_clsid: toast_clsid,
    }
}

fn repair_shortcut(env: &Env) -> Shortcut {
    Shortcut {
        target: env.setup().display().to_string(),
        arguments: "--repair".into(),
        working_dir: env.install_root.display().to_string(),
        icon_path: env.launcher().display().to_string(),
        icon_index: 0,
        description: "修复 AyanamiTaskManager 的安装".into(),
        app_user_model_id: None,
        toast_activator_clsid: None,
    }
}

pub fn commit(
    env: &Env,
    version: &str,
    snapshot: &Snapshot,
    first_install: bool,
) -> Result<(), String> {
    registry::restore_key(
        &env.uninstall_key,
        &Some(uninstall_values(env, version, snapshot.uninstall.as_ref())),
    )?;
    let previous = |path: &Path| {
        snapshot
            .shortcuts
            .iter()
            .find(|entry| fsx::same_path(&entry.path, path))
            .and_then(|entry| entry.value.clone())
    };
    let start_menu = previous(&env.start_menu_shortcut());
    let desktop = previous(&env.desktop_shortcut());
    let toast = start_menu
        .as_ref()
        .or(desktop.as_ref())
        .and_then(|shortcut| shortcut.toast_activator_clsid.clone())
        .or_else(|| Some(env::TOAST_ACTIVATOR_CLSID.into()));
    shortcut::write(
        &env.start_menu_shortcut(),
        &app_shortcut(env, toast.clone()),
    )?;
    // The desktop shortcut is the user's choice: rewrite it if it was there, create it only
    // on a first install (as Squirrel did), never resurrect one the user deleted.
    if desktop.is_some() || first_install {
        shortcut::write(&env.desktop_shortcut(), &app_shortcut(env, toast))?;
    }
    shortcut::write(&env.repair_shortcut(), &repair_shortcut(env))?;
    if let Some(run) = &snapshot.run {
        let arguments = run
            .as_string()
            .map(|command| run_arguments(&command))
            .filter(|arguments| !arguments.is_empty())
            .unwrap_or_else(|| DEFAULT_RUN_ARGS.into());
        registry::write_value(
            &env.run_key,
            env::RUN_VALUE,
            &RawValue::string(&format!("{} {arguments}", quoted(&env.launcher()))),
        )?;
    }
    Ok(())
}

fn ours(env: &Env, target: &str) -> bool {
    let target = Path::new(target);
    fsx::is_within(target, &env.install_root) || fsx::is_within(target, &env.current_link())
}

/// Uninstall: remove only what points at this install (exact targets), keep the rest.
pub fn remove(env: &Env) -> Result<(), String> {
    registry::delete_key(&env.uninstall_key)?;
    if let Some(run) = registry::read_value(&env.run_key, env::RUN_VALUE)?
        && let Some(command) = run.as_string()
    {
        let exe = command.trim().trim_start_matches('"');
        let exe = exe.split('"').next().unwrap_or(exe);
        if ours(env, exe) {
            registry::delete_value(&env.run_key, env::RUN_VALUE)?;
        }
    }
    for path in crate::snapshot::shortcut_paths(env) {
        if let Some(value) = shortcut::read(&path)?
            && ours(env, &value.target)
        {
            fs::remove_file(&path).map_err(|error| error.to_string())?;
        }
    }
    let _ = fs::remove_dir(&env.start_menu_dir);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_arguments_survive_quoting_styles() {
        assert_eq!(
            run_arguments(
                r#""C:\x\current\AyanamiTaskManager.exe" --background --random-startup-delay"#
            ),
            "--background --random-startup-delay"
        );
        assert_eq!(run_arguments(r"C:\x\a.exe --background"), "--background");
        assert_eq!(run_arguments(r#""C:\x\a.exe""#), "");
    }

    #[test]
    fn install_date_is_a_plausible_calendar_date() {
        let date = today();
        assert_eq!(date.len(), 8);
        let year: u32 = date[..4].parse().unwrap();
        let month: u32 = date[4..6].parse().unwrap();
        let day: u32 = date[6..].parse().unwrap();
        assert!(year >= 2026 && (1..=12).contains(&month) && (1..=31).contains(&day));
    }
}
