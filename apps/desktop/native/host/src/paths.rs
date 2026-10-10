//! Where things are, derived from the host's own verified location (§3, §3.0).

use std::env;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct Layout {
    pub host_exe: PathBuf,
    pub app_dir: PathBuf,
    pub renderer_dir: PathBuf,
    /// 2.x 数据根 `L`：3.0 宿主只用它的路径给单实例互斥与管道起名，不写它（W5a）。
    /// Node 入口（`--mcp-stdio`、安装探测）在 W6 换掉之前仍用它。
    pub data_dir: PathBuf,
    /// 3.x 根 `N`：服务、宿主日志、`host.json`、WebView2 数据都在这里。
    pub v3_root: PathBuf,
    pub core: CoreCommand,
    /// `--cli` / `--doctor` 转交的 atm.exe（W6a）：安装布局在 `resources\atm.exe`，开发构建与宿主同目录。
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

pub use atm_install_state::data_dir;

/// Node flags for the core only. After the window closes the core gives back what the UI used
/// (core-main.ts, WINDOW_CLOSED_RELEASE_MS); a full GC is part of that, and Node exposes one
/// only with this flag. CLI and the MCP bridge do not get it.
const CORE_NODE_FLAGS: [&str; 1] = ["--expose-gc"];

fn with_core_flags(mut command: CoreCommand) -> CoreCommand {
    command
        .args
        .splice(0..0, CORE_NODE_FLAGS.iter().map(|flag| (*flag).to_owned()));
    command
}

fn node_entry(exe: &Path, script: PathBuf, env: Vec<(String, String)>) -> CoreCommand {
    CoreCommand {
        exe: exe.to_path_buf(),
        args: vec![script.to_string_lossy().into_owned()],
        env,
    }
}

/// atm.exe 在哪：安装布局 `<app>\resources\atm.exe`（与 atm-mcp.exe 同一处），开发构建 `cargo build` 放在宿主旁边。
pub fn cli_entry(app_dir: &Path, packaged: bool) -> CoreCommand {
    let exe = if packaged {
        app_dir.join("resources").join("atm.exe")
    } else {
        app_dir.join("atm.exe")
    };
    CoreCommand {
        exe,
        args: Vec::new(),
        env: Vec::new(),
    }
}

pub fn resolve() -> Result<Layout, String> {
    let host_exe = env::current_exe().map_err(|error| error.to_string())?;
    // A junction (current → install root) must not decide which app dir we are in:
    // canonicalize resolves it, then strip the verbatim prefix for child processes.
    let host_exe = dunce(std::fs::canonicalize(&host_exe).unwrap_or(host_exe));
    let app_dir = host_exe.parent().ok_or("HOST_PATH_INVALID")?.to_path_buf();
    let data_dir = data_dir()?;
    let v3_root = atm_install_state::startup::v3_root()?;
    let packaged_core = app_dir.join("runtime").join("core.mjs");
    if packaged_core.is_file() {
        let node = app_dir.join("runtime").join("atm-core.exe");
        return Ok(Layout {
            core: with_core_flags(node_entry(&node, packaged_core, Vec::new())),
            cli: cli_entry(&app_dir, true),
            mcp_stdio: node_entry(
                &node,
                app_dir.join("resources").join("mcp-stdio.cjs"),
                Vec::new(),
            ),
            renderer_dir: app_dir.join("renderer"),
            host_exe,
            app_dir,
            data_dir,
            v3_root,
            packaged: true,
        });
    }
    development_layout(host_exe, app_dir, data_dir, v3_root)
}

/// Source checkout: only debug builds, only with an explicit repository root.
#[cfg(debug_assertions)]
fn development_layout(
    host_exe: PathBuf,
    app_dir: PathBuf,
    data_dir: PathBuf,
    v3_root: PathBuf,
) -> Result<Layout, String> {
    let repo = env::var_os("ATM_DEV_REPOSITORY_ROOT")
        .map(PathBuf::from)
        .ok_or("LAYOUT_UNKNOWN: packaged runtime missing and ATM_DEV_REPOSITORY_ROOT not set")?;
    // 窗口与服务不要 Node（W5a）；只有仍是 Node 的无头入口要它，找不到时它们启动失败、报出这个名字。
    let node = which_node().unwrap_or_else(|_| PathBuf::from("node.exe"));
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
        core: with_core_flags(ts_entry("core-main.ts")),
        cli: cli_entry(&app_dir, false),
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
        v3_root,
        packaged: false,
    })
}

#[cfg(not(debug_assertions))]
fn development_layout(_: PathBuf, _: PathBuf, _: PathBuf, _: PathBuf) -> Result<Layout, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// `--cli` / `--doctor` 不再起 Node：安装布局交给 `resources\atm.exe`（atm-mcp.exe 的旁边），
    /// 开发构建交给与宿主同目录的 atm.exe；不带任何固定参数与额外环境。
    #[test]
    fn the_cli_is_atm_exe_next_to_the_bridge() {
        let app = Path::new(r"C:\ATM\app-3.0.0");
        let packaged = cli_entry(app, true);
        assert_eq!(packaged.exe, app.join("resources").join("atm.exe"));
        assert!(packaged.args.is_empty() && packaged.env.is_empty());
        assert_eq!(cli_entry(app, false).exe, app.join("atm.exe"));
    }

    #[test]
    fn only_the_core_command_gets_node_flags_and_they_come_before_the_script() {
        let entry = || {
            node_entry(
                Path::new("atm-core.exe"),
                PathBuf::from("core.mjs"),
                Vec::new(),
            )
        };
        assert_eq!(with_core_flags(entry()).args, ["--expose-gc", "core.mjs"]);
        assert_eq!(entry().args, ["core.mjs"]);
    }
}
