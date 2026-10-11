//! Where things are, derived from the host's own verified location (§3, §3.0).

use std::env;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct Layout {
    pub host_exe: PathBuf,
    pub app_dir: PathBuf,
    pub renderer_dir: PathBuf,
    /// 2.x 数据根 `L`：3.0 宿主只用它的路径给单实例互斥与管道起名、给安装探测读（只读），不写它（W5a）。
    pub data_dir: PathBuf,
    /// 3.x 根 `N`：服务、宿主日志、`host.json`、WebView2 数据都在这里。
    pub v3_root: PathBuf,
    /// `--cli` / `--doctor` 转交的 atm.exe（W6a）：安装布局在 `resources\atm.exe`，开发构建与宿主同目录。
    pub cli: Entry,
    /// 旧配置里的 `--mcp-stdio` 转交的原生 shim（W6d）：与 atm.exe 同一处。
    pub mcp_stdio: Entry,
    pub packaged: bool,
}

/// How to start a headless entry: executable, fixed leading arguments, extra environment.
#[derive(Debug, Clone)]
pub struct Entry {
    pub exe: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

pub use atm_install_state::data_dir;

/// The file that makes a version directory an installed 3.0 layout (scripts/app-layout.ts): atm.exe, which
/// every package carries and a `cargo build` output does not have under `resources\`.
pub const PACKAGED_MARKER: [&str; 2] = ["resources", "atm.exe"];

fn bundled(app_dir: &Path, packaged: bool, name: &str) -> Entry {
    let exe = if packaged {
        app_dir.join("resources").join(name)
    } else {
        app_dir.join(name)
    };
    Entry {
        exe,
        args: Vec::new(),
        env: Vec::new(),
    }
}

/// atm.exe 在哪：安装布局 `<app>\resources\atm.exe`（与 atm-mcp.exe 同一处），开发构建 `cargo build` 放在宿主旁边。
pub fn cli_entry(app_dir: &Path, packaged: bool) -> Entry {
    bundled(app_dir, packaged, "atm.exe")
}

/// atm-mcp.exe 在哪：安装布局 `<app>\resources\atm-mcp.exe`，开发构建放在宿主旁边（W6d：不再有 Node 桥）。
pub fn mcp_entry(app_dir: &Path, packaged: bool) -> Entry {
    bundled(app_dir, packaged, "atm-mcp.exe")
}

pub fn is_packaged(app_dir: &Path) -> bool {
    app_dir
        .join(PACKAGED_MARKER[0])
        .join(PACKAGED_MARKER[1])
        .is_file()
}

pub fn resolve() -> Result<Layout, String> {
    let host_exe = env::current_exe().map_err(|error| error.to_string())?;
    // A junction (current → install root) must not decide which app dir we are in:
    // canonicalize resolves it, then strip the verbatim prefix for child processes.
    let host_exe = dunce(std::fs::canonicalize(&host_exe).unwrap_or(host_exe));
    let app_dir = host_exe.parent().ok_or("HOST_PATH_INVALID")?.to_path_buf();
    let data_dir = data_dir()?;
    let v3_root = atm_install_state::startup::v3_root()?;
    if is_packaged(&app_dir) {
        return Ok(Layout {
            cli: cli_entry(&app_dir, true),
            mcp_stdio: mcp_entry(&app_dir, true),
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

/// Source checkout: only debug builds, only with an explicit repository root (the renderer comes from
/// its `apps\desktop\dist\renderer`; atm.exe and atm-mcp.exe sit next to the host in `target\`).
#[cfg(debug_assertions)]
fn development_layout(
    host_exe: PathBuf,
    app_dir: PathBuf,
    data_dir: PathBuf,
    v3_root: PathBuf,
) -> Result<Layout, String> {
    let repo = env::var_os("ATM_DEV_REPOSITORY_ROOT")
        .map(PathBuf::from)
        .ok_or("LAYOUT_UNKNOWN: not a packaged layout and ATM_DEV_REPOSITORY_ROOT not set")?;
    Ok(Layout {
        cli: cli_entry(&app_dir, false),
        mcp_stdio: mcp_entry(&app_dir, false),
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
    Err("LAYOUT_UNKNOWN: not a packaged layout".into())
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
        assert_eq!(
            mcp_entry(app, true).exe,
            app.join("resources").join("atm-mcp.exe")
        );
    }

    /// 安装布局只认 `resources\atm.exe`：2.x 的版本目录（`runtime\core.mjs`、没有 atm.exe）不是，`cargo build`
    /// 的输出目录（atm.exe 在宿主旁边）也不是。
    #[test]
    fn a_packaged_layout_is_recognised_by_atm_exe_under_resources() {
        let root = env::var_os("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../target"))
            .join("host-unit")
            .join("layout");
        let _ = std::fs::remove_dir_all(&root);
        let v3 = root.join("app-3.0.0");
        std::fs::create_dir_all(v3.join("resources")).unwrap();
        std::fs::write(v3.join("resources").join("atm.exe"), b"").unwrap();
        assert!(is_packaged(&v3));
        let v2 = root.join("app-2.0.0");
        std::fs::create_dir_all(v2.join("runtime")).unwrap();
        std::fs::write(v2.join("runtime").join("core.mjs"), b"").unwrap();
        assert!(!is_packaged(&v2));
        let dev = root.join("debug");
        std::fs::create_dir_all(&dev).unwrap();
        std::fs::write(dev.join("atm.exe"), b"").unwrap();
        assert!(!is_packaged(&dev));
    }
}
