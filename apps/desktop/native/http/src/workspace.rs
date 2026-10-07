//! begin 在服务之外要做的文件系统与 git 工作（W4d；04 L-009、L-010、C-L03；2.x
//! `registry-workspace.ts` 的 `identifyProject`、`engineering-metrics/git-context.ts`）。
//!
//! - cwd → realpath（去掉 Windows 的 verbatim 前缀，与 2.x `realpathSync.native` 同形）→ `path_key`；
//! - `.ayanami-task/project.json` marker 里的 project_id；
//! - `git rev-parse --git-common-dir`（同一仓库的其他 worktree 归同一个项目）与 begin 的 git 上下文；
//! - 建项目之后在用户目录写 marker 与 git `info/exclude`（不能放进写事务，失败如实报告）。
//!
//! git 只以固定参数直接启动（不经 shell），有时限，并关掉 `core.fsmonitor`：仓库配置里的 fsmonitor
//! 钩子会被 `git status` 执行，Agent 给的 cwd 不可信（2.x 没有这道防护）。

use atm_service::session::{GitContext, ProjectSelector};
use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// 单个 git 命令的时限（2.x：1.5 s）。
const GIT_TIMEOUT: Duration = Duration::from_millis(1500);
/// git 输出的上限：超出的部分丢弃（工作区很大时 `status --porcelain` 可能很长，这里只关心有没有）。
const GIT_OUTPUT_MAX: usize = 64 * 1024;

/// 去掉 `\\?\` / `\\?\UNC\` 前缀，得到 2.x 那样的普通路径。
pub fn display_path(p: &Path) -> String {
    let s = p.display().to_string();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        s
    }
}

/// realpath；不存在时返回 None。
pub fn canonical(cwd: &str) -> Option<String> {
    std::fs::canonicalize(cwd).ok().map(|p| display_path(&p))
}

/// begin 的项目选择器：显式代码之外，按 cwd 算路径键、读 marker、问 git common dir。
/// cwd 不存在时只给 canonical_path（原样），由服务按「没有匹配」处理。
pub fn selector(code: Option<String>, cwd: Option<&str>) -> ProjectSelector {
    let mut s = ProjectSelector {
        code,
        ..ProjectSelector::default()
    };
    let Some(cwd) = cwd.map(str::trim).filter(|c| !c.is_empty()) else {
        return s;
    };
    let Some(real) = canonical(cwd) else {
        s.canonical_path = Some(cwd.to_owned());
        return s;
    };
    s.path_key = Some(atm_store::paths::path_key(&real));
    s.marker_project_id = marker(Path::new(&real));
    s.git_common_dir = git(Path::new(&real), &["rev-parse", "--git-common-dir"])
        .ok()
        .and_then(|out| absolute(Path::new(&real), &out));
    s.canonical_path = Some(real);
    s
}

/// `.ayanami-task/project.json` 里的 project_id（L-010）。读不出、不是 JSON、没有 id 都当没有 marker。
fn marker(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join(".ayanami-task").join("project.json")).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    v["project_id"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// git 输出的路径相对 cwd；规范化后返回（不存在就用拼接后的原样）。
fn absolute(cwd: &Path, out: &str) -> Option<String> {
    let t = out.trim();
    if t.is_empty() {
        return None;
    }
    let p = cwd.join(t);
    Some(std::fs::canonicalize(&p).map_or_else(|_| display_path(&p), |r| display_path(&r)))
}

/// git 失败的原因（与 2.x `GitContextError` 同名）。
#[derive(Debug, PartialEq, Eq)]
pub enum GitError {
    NotGit,
    Timeout,
    Failed,
}

/// 以固定参数跑一次 git，返回 stdout。没有 shell、没有输入、有时限；超时就结束这个子进程（它是我们起的）。
pub fn git(cwd: &Path, args: &[&str]) -> Result<String, GitError> {
    let mut cmd = Command::new("git");
    cmd.args(["-c", "core.fsmonitor=false", "-c", "core.quotepath=false"])
        .args(args)
        .current_dir(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|_| GitError::Failed)?;
    // 先把两路输出读走，免得子进程写满管道卡住。
    let mut stdout = child.stdout.take().ok_or(GitError::Failed)?;
    let mut stderr = child.stderr.take().ok_or(GitError::Failed)?;
    let out = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = (&mut stdout)
            .take(GIT_OUTPUT_MAX as u64)
            .read_to_end(&mut buf);
        let _ = std::io::copy(&mut stdout, &mut std::io::sink());
        buf
    });
    let err = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = (&mut stderr)
            .take(GIT_OUTPUT_MAX as u64)
            .read_to_end(&mut buf);
        let _ = std::io::copy(&mut stderr, &mut std::io::sink());
        buf
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < GIT_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(5))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(GitError::Timeout);
            }
        }
    };
    let out = String::from_utf8_lossy(&out.join().unwrap_or_default()).into_owned();
    let err = String::from_utf8_lossy(&err.join().unwrap_or_default()).into_owned();
    if status.success() {
        Ok(out)
    } else if format!("{err}\n{out}")
        .to_lowercase()
        .contains("not a git repository")
    {
        Err(GitError::NotGit)
    } else {
        Err(GitError::Failed)
    }
}

/// begin 的 git 上下文（2.x `inspectGitContext`）。
pub fn git_context(cwd: &str) -> GitContext {
    let unavailable = |error: &str| GitContext {
        available: false,
        branch: None,
        head: None,
        repo_root: None,
        worktree_root: None,
        common_dir: None,
        is_linked_worktree: None,
        detached: None,
        dirty: None,
        error: Some(error.to_owned()),
    };
    let Some(real) = canonical(cwd) else {
        return unavailable("WORKTREE_MISSING");
    };
    let dir = PathBuf::from(&real);
    let root = match git(&dir, &["rev-parse", "--show-toplevel"]) {
        Ok(out) => out,
        Err(GitError::NotGit) => return unavailable("NOT_GIT"),
        Err(GitError::Timeout) => return unavailable("COMMAND_TIMEOUT"),
        Err(GitError::Failed) => return unavailable("COMMAND_FAILED"),
    };
    let Some(worktree_root) = absolute(&dir, &root) else {
        return unavailable("COMMAND_FAILED");
    };
    let run = |args: &[&str]| git(&dir, args).ok();
    let git_dir = run(&["rev-parse", "--absolute-git-dir"]).and_then(|o| absolute(&dir, &o));
    let common_dir = run(&["rev-parse", "--git-common-dir"]).and_then(|o| absolute(&dir, &o));
    let head = run(&["rev-parse", "HEAD"])
        .map(|o| o.trim().to_owned())
        .filter(|s| !s.is_empty());
    let branch = run(&["branch", "--show-current"])
        .map(|o| o.trim().to_owned())
        .filter(|s| !s.is_empty());
    let dirty =
        run(&["status", "--porcelain", "--untracked-files=normal"]).map(|o| !o.trim().is_empty());
    let repo_root = run(&["worktree", "list", "--porcelain"])
        .and_then(|o| {
            o.lines()
                .find_map(|l| l.strip_prefix("worktree "))
                .and_then(|p| absolute(&dir, p))
        })
        .unwrap_or_else(|| worktree_root.clone());
    let is_linked_worktree = match (&git_dir, &common_dir) {
        (Some(g), Some(c)) => Some(g.to_lowercase() != c.to_lowercase()),
        _ => None,
    };
    GitContext {
        available: true,
        detached: head.as_ref().map(|_| branch.is_none()),
        branch,
        head,
        repo_root: Some(repo_root),
        worktree_root: Some(worktree_root),
        common_dir,
        is_linked_worktree,
        dirty,
        error: None,
    }
}

/// 建项目之后写 marker 与 git exclude（C-L03）。`marker` 是回执里的 `marker` 对象；返回是否写成。
pub fn write_marker(marker: &Value) -> bool {
    let (Some(dir), Some(file)) = (marker["directory"].as_str(), marker["file"].as_str()) else {
        return false;
    };
    let dir = Path::new(dir);
    let path = dir.join(file);
    let Some(parent) = path.parent() else {
        return false;
    };
    let text = match serde_json::to_string_pretty(&marker["content"]) {
        Ok(t) => t + "\n",
        Err(_) => return false,
    };
    if std::fs::create_dir_all(parent).is_err() || std::fs::write(&path, text).is_err() {
        return false;
    }
    // git exclude 只是锦上添花：不在仓库里、或写不进去，都不影响 marker 已经写成。
    if let Some(pattern) = marker["gitExclude"].as_str()
        && let Ok(out) = git(dir, &["rev-parse", "--git-path", "info/exclude"])
        && let Some(exclude) = absolute(dir, &out)
    {
        let exclude = PathBuf::from(exclude);
        let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
        if !existing.lines().any(|l| l.trim_end() == pattern) {
            let sep = if existing.is_empty() || existing.ends_with('\n') {
                ""
            } else {
                "\n"
            };
            if let Some(p) = exclude.parent() {
                let _ = std::fs::create_dir_all(p);
            }
            let _ = std::fs::write(&exclude, format!("{existing}{sep}{pattern}\n"));
        }
    }
    true
}
