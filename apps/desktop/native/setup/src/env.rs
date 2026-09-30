//! Where things are. One place, so a drill can move all of it into a sandbox at once.

use std::path::{Path, PathBuf};

/// Squirrel's identity for this app. Kept as-is: the Run value name, the AUMID on the
/// shortcuts and in the host (toasts), and the Uninstall key all carry it (§ plan v9).
pub const APP_USER_MODEL_ID: &str = "com.squirrel.AyanamiTaskManagerDesktop.AyanamiTaskManager";
pub const RUN_VALUE: &str = APP_USER_MODEL_ID;
pub const UNINSTALL_NAME: &str = "AyanamiTaskManagerDesktop";
pub const INSTALL_DIR_NAME: &str = "AyanamiTaskManagerDesktop";
pub const DISPLAY_NAME: &str = "AyanamiTaskManager";
pub const PUBLISHER: &str = "ayanami";
/// Start-menu folder Squirrel used (`Programs\ayanami\AyanamiTaskManager.lnk`).
pub const START_MENU_FOLDER: &str = "ayanami";
pub const SHORTCUT_NAME: &str = "AyanamiTaskManager.lnk";
pub const REPAIR_SHORTCUT_NAME: &str = "ATM 修复.lnk";

pub const LAUNCHER: &str = "AyanamiTaskManager.exe";
pub const SETUP: &str = "atm-setup.exe";
pub const SHIM: &str = "atm-mcp.exe";

#[derive(Debug, Clone)]
pub struct Env {
    pub install_root: PathBuf,
    pub data_dir: PathBuf,
    /// `...\Start Menu\Programs\ayanami`
    pub start_menu_dir: PathBuf,
    pub desktop_dir: PathBuf,
    /// HKCU-relative.
    pub uninstall_key: String,
    pub run_key: String,
    pub sandbox: bool,
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

impl Env {
    pub fn detect() -> Result<Env, String> {
        let data_dir = atm_install_state::data_dir()?;
        #[cfg(feature = "drill")]
        if let Some(sandbox) = env_path("ATM_SETUP_SANDBOX") {
            return Ok(Env::sandboxed(&sandbox, data_dir));
        }
        let local = env_path("LOCALAPPDATA").ok_or("LOCALAPPDATA_MISSING")?;
        let appdata = env_path("APPDATA").ok_or("APPDATA_MISSING")?;
        let profile = env_path("USERPROFILE").ok_or("USERPROFILE_MISSING")?;
        Ok(Env {
            install_root: local.join(INSTALL_DIR_NAME),
            data_dir,
            start_menu_dir: appdata
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs")
                .join(START_MENU_FOLDER),
            desktop_dir: profile.join("Desktop"),
            uninstall_key: format!(
                r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{UNINSTALL_NAME}"
            ),
            run_key: r"Software\Microsoft\Windows\CurrentVersion\Run".into(),
            sandbox: false,
        })
    }

    /// Everything under one directory and one private registry subtree, so a drill can
    /// install, migrate, roll back and uninstall without touching the real install.
    #[cfg(feature = "drill")]
    pub fn sandboxed(sandbox: &Path, data_dir: PathBuf) -> Env {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in sandbox.to_string_lossy().to_lowercase().bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0100_0000_01b3);
        }
        let registry = format!(r"Software\AyanamiTaskManagerDrill\{hash:016x}");
        Env {
            install_root: sandbox.join("install"),
            data_dir,
            start_menu_dir: sandbox.join("start-menu").join(START_MENU_FOLDER),
            desktop_dir: sandbox.join("desktop"),
            uninstall_key: format!(r"{registry}\Uninstall\{UNINSTALL_NAME}"),
            run_key: format!(r"{registry}\Run"),
            sandbox: true,
        }
    }

    pub fn state_dir(&self) -> PathBuf {
        self.install_root.join(atm_install_state::STATE_DIR)
    }
    pub fn txn_dir(&self, txn: &str) -> PathBuf {
        self.state_dir().join("txn").join(txn)
    }
    pub fn health_dir(&self) -> PathBuf {
        self.state_dir().join("health")
    }
    pub fn rollback_dir(&self) -> PathBuf {
        self.state_dir().join("rollback")
    }
    pub fn app_dir(&self, version: &str) -> PathBuf {
        atm_install_state::app_dir_for(&self.install_root, version)
    }
    pub fn launcher(&self) -> PathBuf {
        self.install_root.join(LAUNCHER)
    }
    pub fn setup(&self) -> PathBuf {
        self.install_root.join(SETUP)
    }
    /// `<dataDir>\current`: the junction every external entry goes through.
    pub fn current_link(&self) -> PathBuf {
        self.data_dir.join("current")
    }
    pub fn runtime_dir(&self) -> PathBuf {
        self.data_dir.join("runtime")
    }
    pub fn start_menu_shortcut(&self) -> PathBuf {
        self.start_menu_dir.join(SHORTCUT_NAME)
    }
    pub fn repair_shortcut(&self) -> PathBuf {
        self.start_menu_dir.join(REPAIR_SHORTCUT_NAME)
    }
    pub fn desktop_shortcut(&self) -> PathBuf {
        self.desktop_dir.join(SHORTCUT_NAME)
    }
}

/// Files the payload carries for the install root (§3): copied there at FENCE.
pub fn stable_sources(app_dir: &Path) -> [(PathBuf, &'static str); 3] {
    [
        (app_dir.join("launcher").join(LAUNCHER), LAUNCHER),
        (app_dir.join(SETUP), SETUP),
        (
            app_dir.join("resources").join(SHIM),
            r"resources\atm-mcp.exe",
        ),
    ]
}
