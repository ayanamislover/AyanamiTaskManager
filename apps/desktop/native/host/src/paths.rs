//! Where things are, derived from the host's own verified location (§3, §3.0).

use std::env;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct Layout {
    pub host_exe: PathBuf,
    pub app_dir: PathBuf,
    pub renderer_dir: PathBuf,
    pub data_dir: PathBuf,
    pub core: CoreCommand,
    pub cli: CoreCommand,
    pub mcp_stdio: CoreCommand,
    pub packaged: bool,
}

/// How to start a Node entry: executable, fixed leading arguments, extra environment.
#[derive(Debug, Clone)]
pub struct CoreCommand {
    pub exe: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// Same rule as `resolveDaemonDataDirectory` in apps/daemon/src/runtime-discovery.ts.
pub fn data_dir() -> Result<PathBuf, String> {
    for key in ["ATM_DATA_DIR", "AYANAMI_TASK_DATA_DIR"] {
        if let Some(value) = env::var_os(key).filter(|value| !value.is_empty()) {
            return std::path::absolute(PathBuf::from(value)).map_err(|error| error.to_string());
        }
    }
    let local = env::var_os("LOCALAPPDATA").ok_or("ATM_DATA_DIRECTORY_UNAVAILABLE")?;
    Ok(PathBuf::from(local).join("AyanamiTaskManager"))
}

fn node_entry(exe: &Path, script: PathBuf, env: Vec<(String, String)>) -> CoreCommand {
    CoreCommand {
        exe: exe.to_path_buf(),
        args: vec![script.to_string_lossy().into_owned()],
        env,
    }
}

pub fn resolve() -> Result<Layout, String> {
    let host_exe = env::current_exe().map_err(|error| error.to_string())?;
    // A junction (current → install root) must not decide which app dir we are in:
    // canonicalize resolves it, then strip the verbatim prefix for child processes.
    let host_exe = dunce(std::fs::canonicalize(&host_exe).unwrap_or(host_exe));
    let app_dir = host_exe.parent().ok_or("HOST_PATH_INVALID")?.to_path_buf();
    let data_dir = data_dir()?;
    let packaged_core = app_dir.join("runtime").join("core.mjs");
    if packaged_core.is_file() {
        let node = app_dir.join("runtime").join("atm-core.exe");
        return Ok(Layout {
            core: node_entry(&node, packaged_core, Vec::new()),
            cli: node_entry(&node, app_dir.join("runtime").join("cli.mjs"), Vec::new()),
            mcp_stdio: node_entry(
                &node,
                app_dir.join("resources").join("mcp-stdio.cjs"),
                Vec::new(),
            ),
            renderer_dir: app_dir.join("renderer"),
            host_exe,
            app_dir,
            data_dir,
            packaged: true,
        });
    }
    development_layout(host_exe, app_dir, data_dir)
}

/// Source checkout: only debug builds, only with an explicit repository root.
#[cfg(debug_assertions)]
fn development_layout(
    host_exe: PathBuf,
    app_dir: PathBuf,
    data_dir: PathBuf,
) -> Result<Layout, String> {
    let repo = env::var_os("ATM_DEV_REPOSITORY_ROOT")
        .map(PathBuf::from)
        .ok_or("LAYOUT_UNKNOWN: packaged runtime missing and ATM_DEV_REPOSITORY_ROOT not set")?;
    let node = which_node()?;
    let tsx = repo
        .join("node_modules")
        .join("tsx")
        .join("dist")
        .join("loader.mjs");
    let dev_env = vec![
        (
            "ATM_DEV_REPOSITORY_ROOT".to_owned(),
            repo.to_string_lossy().into_owned(),
        ),
        (
            "ATM_DEV_HOST_PATH".to_owned(),
            host_exe.to_string_lossy().into_owned(),
        ),
    ];
    let ts_entry = |script: &str| CoreCommand {
        exe: node.clone(),
        args: vec![
            "--import".into(),
            url_for(&tsx),
            repo.join("apps")
                .join("desktop")
                .join("src")
                .join(script)
                .to_string_lossy()
                .into_owned(),
        ],
        env: dev_env.clone(),
    };
    Ok(Layout {
        core: ts_entry("core-main.ts"),
        cli: ts_entry("cli-main.ts"),
        mcp_stdio: node_entry(
            &node,
            repo.join("apps")
                .join("desktop")
                .join("resources")
                .join("mcp-stdio.cjs"),
            Vec::new(),
        ),
        renderer_dir: repo
            .join("apps")
            .join("desktop")
            .join("dist")
            .join("renderer"),
        host_exe,
        app_dir,
        data_dir,
        packaged: false,
    })
}

#[cfg(not(debug_assertions))]
fn development_layout(_: PathBuf, _: PathBuf, _: PathBuf) -> Result<Layout, String> {
    Err("LAYOUT_UNKNOWN: packaged runtime missing".into())
}

#[cfg(debug_assertions)]
fn which_node() -> Result<PathBuf, String> {
    let path = env::var_os("PATH").ok_or("NODE_NOT_FOUND")?;
    env::split_paths(&path)
        .map(|dir| dir.join("node.exe"))
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| "NODE_NOT_FOUND".to_owned())
}

#[cfg(debug_assertions)]
fn url_for(path: &Path) -> String {
    format!("file:///{}", path.to_string_lossy().replace('\\', "/"))
}

/// `\\?\C:\x` → `C:\x` for paths handed to other processes.
pub fn dunce(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path,
    }
}
