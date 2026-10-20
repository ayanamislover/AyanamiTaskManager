//! 客户端配置在哪里（2.0 `agent-config/src/mcp-paths.ts`），与写进配置的启动方式（2.0 `mcp-launch.ts`）。
//!
//! 所有路径都从 [`AgentEnv`] 推出：常驻进程按本进程的环境构造（[`AgentEnv::from_process`]），用例给一个合成的家目录，
//! 不碰真实的 `~/.codex`、`~/.claude.json`。

use crate::Launch;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const SHIM: &str = "atm-mcp.exe";
pub const CLAUDE_DESKTOP_CONFIG: &str = "claude_desktop_config.json";

/// 跑 `claude` 命令行（Claude Code 的 user scope 只能由它代写）。失败时返回 stderr 或原因。
pub trait Cli: Send + Sync {
    fn run(&self, cli: &Path, args: &[String]) -> Result<(), String>;
}

/// 真的起进程。`.cmd` / `.bat`（npm 装的 shim）经 `cmd.exe /d /s /c` 跑。
pub struct ProcessCli;

impl Cli for ProcessCli {
    fn run(&self, cli: &Path, args: &[String]) -> Result<(), String> {
        let lower = cli.to_string_lossy().to_ascii_lowercase();
        let mut command = if lower.ends_with(".cmd") || lower.ends_with(".bat") {
            let mut line = quote(&cli.to_string_lossy());
            for a in args {
                line.push(' ');
                line.push_str(&quote(a));
            }
            let mut c = std::process::Command::new("cmd.exe");
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                c.arg("/d")
                    .arg("/s")
                    .arg("/c")
                    .raw_arg(format!("\"{line}\""));
            }
            #[cfg(not(windows))]
            c.arg("/c").arg(line);
            c
        } else {
            let mut c = std::process::Command::new(cli);
            c.args(args);
            c
        };
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let out = command
            .output()
            .map_err(|e| format!("CLAUDE_CODE_CLI_FAILED: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Err(format!(
                "CLAUDE_CODE_CLI_FAILED: {}",
                if stderr.is_empty() {
                    format!("exit {:?}", out.status.code())
                } else {
                    stderr
                }
            ))
        }
    }
}

/// Windows 命令行的一个参数（C 运行库的解析规则：反斜杠只在引号前要成对）。
fn quote(arg: &str) -> String {
    let mut out = String::from("\"");
    let mut slashes = 0;
    for c in arg.chars() {
        match c {
            '\\' => slashes += 1,
            '"' => {
                out.push_str(&"\\".repeat(slashes * 2 + 1));
                out.push('"');
                slashes = 0;
                continue;
            }
            _ => {}
        }
        if c != '\\' {
            out.push_str(&"\\".repeat(slashes));
            slashes = 0;
            out.push(c);
        }
    }
    out.push_str(&"\\".repeat(slashes * 2));
    out.push('"');
    out
}

#[derive(Clone)]
pub struct AgentEnv {
    /// 用户目录（`~`）。
    pub home: PathBuf,
    pub appdata: PathBuf,
    pub localappdata: PathBuf,
    /// 找 `claude` 用的 PATH。
    pub path: Option<OsString>,
    /// 2.x 根 `L`：Agent 文档与 Skills 的来源（00 §5 #6：留在 `L`，由运行中的版本维护），`current` 链接也在这里。
    pub legacy_root: PathBuf,
    /// 写进配置的启动方式（不带 `--profile`），见 [`launch_for`]。
    pub launch: Launch,
    pub cli: Arc<dyn Cli>,
}

/// 3.0 的启动方式：`<L>\current\resources\atm-mcp.exe`（安装事务维护的目录链接，路径不随版本变，客户端拿着
/// 多久以前的配置都能起来）；链接还没建（开发构建）时用正在运行的这份安装里的 shim。
/// 不再回落到宿主的 `--mcp-stdio`（3.0 没有 Node 桥）。
pub fn launch_for(legacy_root: &Path, installed_shim: &Path) -> Launch {
    let linked = legacy_root.join("current").join("resources").join(SHIM);
    let command = if linked.exists() {
        linked
    } else {
        installed_shim.to_path_buf()
    };
    Launch::new(command.to_string_lossy().into_owned())
}

impl AgentEnv {
    /// 按本进程的环境：`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`PATH`。
    pub fn from_process(legacy_root: &Path, installed_shim: &Path) -> AgentEnv {
        let var = |k: &str| {
            std::env::var_os(k)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        };
        let home = var("USERPROFILE")
            .or_else(|| var("HOME"))
            .unwrap_or_else(|| PathBuf::from("."));
        AgentEnv {
            appdata: var("APPDATA").unwrap_or_else(|| home.join("AppData").join("Roaming")),
            localappdata: var("LOCALAPPDATA").unwrap_or_else(|| home.join("AppData").join("Local")),
            path: std::env::var_os("PATH"),
            launch: launch_for(legacy_root, installed_shim),
            legacy_root: legacy_root.to_path_buf(),
            home,
            cli: Arc::new(ProcessCli),
        }
    }

    pub fn codex_config(&self) -> PathBuf {
        self.home.join(".codex").join("config.toml")
    }
    pub fn codex_rule(&self) -> PathBuf {
        self.home.join(".codex").join("AGENTS.md")
    }
    pub fn codex_skills(&self) -> PathBuf {
        self.home.join(".codex").join("skills")
    }
    pub fn claude_rule(&self) -> PathBuf {
        self.home.join(".claude").join("CLAUDE.md")
    }
    pub fn claude_skills(&self) -> PathBuf {
        self.home.join(".claude").join("skills")
    }
    pub fn claude_code_config(&self) -> PathBuf {
        self.home.join(".claude.json")
    }
    pub fn kimi_dir(&self) -> PathBuf {
        self.home.join(".kimi-code")
    }
    pub fn kimi_config(&self) -> PathBuf {
        self.kimi_dir().join("mcp.json")
    }
    pub fn kimi_rule(&self) -> PathBuf {
        self.kimi_dir().join("AGENTS.md")
    }
    pub fn kimi_skills(&self) -> PathBuf {
        self.kimi_dir().join("skills")
    }
    /// Skills 的来源：`<L>\skills`（Agent 文档安装维护）。
    pub fn skills_source(&self) -> PathBuf {
        self.legacy_root.join("skills")
    }

    /// Claude Desktop 的配置：经典安装与 MSIX 容器里父目录已存在的那些（MSIX 在前，按名字排序）；一个都没有时
    /// 回落到经典路径（2.0 `claudeDesktopConfigPaths`）。
    pub fn claude_desktop_configs(&self) -> Vec<PathBuf> {
        let classic = self.appdata.join("Claude").join(CLAUDE_DESKTOP_CONFIG);
        let packages = self.localappdata.join("Packages");
        let mut packaged: Vec<PathBuf> = std::fs::read_dir(&packages)
            .map(|it| {
                it.flatten()
                    .filter(|e| e.file_name().to_string_lossy().starts_with("Claude_"))
                    .map(|e| {
                        e.path()
                            .join("LocalCache")
                            .join("Roaming")
                            .join("Claude")
                            .join(CLAUDE_DESKTOP_CONFIG)
                    })
                    .collect()
            })
            .unwrap_or_default();
        packaged.sort();
        let live: Vec<PathBuf> = packaged
            .into_iter()
            .chain(std::iter::once(classic.clone()))
            .filter(|p| p.parent().is_some_and(Path::exists))
            .collect();
        if live.is_empty() { vec![classic] } else { live }
    }

    /// `claude` 命令行：`~/.local/bin/claude(.exe)`、`%APPDATA%\npm\claude(.cmd)`，再按 PATH 找；找不到是 `None`，
    /// 不会回落到直接改写 `~/.claude.json`。
    pub fn find_claude_cli(&self) -> Option<PathBuf> {
        let fixed = [
            self.home.join(".local").join("bin").join("claude.exe"),
            self.home.join(".local").join("bin").join("claude"),
            self.appdata.join("npm").join("claude.cmd"),
            self.appdata.join("npm").join("claude"),
        ];
        if let Some(found) = fixed.into_iter().find(|p| p.is_file()) {
            return Some(found);
        }
        let path = self.path.as_ref()?;
        for dir in std::env::split_paths(path) {
            for ext in [".exe", ".cmd", ".bat", ""] {
                let candidate = dir.join(format!("claude{ext}"));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments_are_quoted_for_the_c_runtime() {
        assert_eq!(quote("plain"), "\"plain\"");
        assert_eq!(quote(r#"{"a":"C:\x\"}"#), r#""{\"a\":\"C:\x\\\"}""#);
        assert_eq!(quote(r"C:\dir\"), r#""C:\dir\\""#);
    }
}
