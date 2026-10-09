//! 工程指标的扫描（W5h2；2.x `packages/engineering-metrics`：git-command、scan-context、index）。
//!
//! 只读：跑固定参数的 git（没有 shell、没有输入、有时限）、读工作区里的文本文件，算出 2.x 同形状的
//! camelCase 载荷。不碰库、不知道主体——什么时候扫、扫完写到哪里由 `atm-service` 决定，git 永远不在
//! 写事务里跑（03 `metrics.capture`，方案 §10）。
//!
//! 同一次扫描里 `ls-files`、`rev-parse HEAD`、依赖清单各只求一次（2.x 的 `ScanContext`）。

use atm_domain::time::Timestamp;
use serde_json::{Value, json};
use std::cell::OnceCell;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// git 的空树：仓库还没有首个 commit 时的 HEAD 与 baseline。
pub const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/// 每条 git 命令的时限（2.x `METRICS_TIMEOUT_MS`）。
pub const GIT_TIMEOUT: Duration = Duration::from_secs(30);
/// 每条 git 命令最多收多少输出（2.x `maxBuffer`）。
const OUTPUT_MAX: usize = 32 * 1024 * 1024;
const DAY_MS: i64 = 86_400_000;

const CODE_EXTENSIONS: [&str; 29] = [
    ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html", ".java", ".js", ".jsx",
    ".kt", ".kts", ".lua", ".mjs", ".php", ".ps1", ".py", ".rb", ".rs", ".scss", ".sh", ".sql",
    ".svelte", ".swift", ".ts", ".tsx", ".vue",
];
const EXCLUDED_SEGMENTS: [&str; 13] = [
    ".git",
    ".next",
    ".nuxt",
    ".output",
    ".turbo",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "output",
    "release",
    "target",
    "vendor",
];
const LOCK_FILES: [&str; 8] = [
    "bun.lock",
    "bun.lockb",
    "composer.lock",
    "package-lock.json",
    "pnpm-lock.yaml",
    "poetry.lock",
    "uv.lock",
    "yarn.lock",
];
const TEST_SEGMENTS: [&str; 5] = ["test", "tests", "__tests__", "spec", "specs"];
const DEPENDENCY_KEYS: [&str; 4] = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
];

/// 反斜杠换成斜杠，去掉开头的 `./`。
pub fn normalize_path(path: &str) -> String {
    let p = path.replace('\\', "/");
    p.strip_prefix("./").map(str::to_owned).unwrap_or(p)
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or_default()
}

fn extension(path: &str) -> String {
    let normalized = normalize_path(path);
    let name = file_name(&normalized);
    name.rfind('.')
        .map_or_else(String::new, |i| name[i..].to_lowercase())
}

/// 参与统计：不是锁文件，也不在构建产物、依赖、输出一类目录里。
pub fn included(path: &str) -> bool {
    let normalized = normalize_path(path);
    if normalized.is_empty() || LOCK_FILES.contains(&file_name(&normalized)) {
        return false;
    }
    !normalized
        .split('/')
        .any(|segment| EXCLUDED_SEGMENTS.contains(&segment))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CodeKind {
    Source,
    Test,
}

/// `name` 形如 `test.x`、`spec.x`、`a.test.x`、`a.spec.x`（2.x `/(?:^|\.)(?:test|spec)\.[^.]+$/`）。
fn test_file_name(name: &str) -> bool {
    let Some(dot) = name.rfind('.') else {
        return false;
    };
    if dot + 1 == name.len() {
        return false;
    }
    let rest = &name[..dot];
    ["test", "spec"]
        .iter()
        .any(|w| rest == *w || rest.ends_with(&format!(".{w}")))
}

/// 代码文件是源码还是测试；不是代码（扩展名不在表里、`.d.ts`、被排除的目录）是 None。
pub fn code_kind(path: &str) -> Option<CodeKind> {
    let normalized = normalize_path(path).to_lowercase();
    if !included(&normalized)
        || !CODE_EXTENSIONS.contains(&extension(&normalized).as_str())
        || normalized.ends_with(".d.ts")
    {
        return None;
    }
    let test = normalized
        .split('/')
        .any(|segment| TEST_SEGMENTS.contains(&segment))
        || test_file_name(file_name(&normalized));
    Some(if test {
        CodeKind::Test
    } else {
        CodeKind::Source
    })
}

/// 行数：最后一个换行之后没有内容就不多算一行；空文件 0 行。
pub fn line_count(content: &[u8]) -> i64 {
    if content.is_empty() {
        return 0;
    }
    let newlines = content.iter().filter(|b| **b == b'\n').count() as i64;
    if content.ends_with(b"\n") {
        newlines
    } else {
        newlines + 1
    }
}

/// package.json 里四类依赖的名字；不是 JSON 或不是对象就是空。
pub fn dependency_names(content: &str) -> Vec<String> {
    let Ok(parsed) = serde_json::from_str::<Value>(content) else {
        return Vec::new();
    };
    DEPENDENCY_KEYS
        .iter()
        .filter_map(|k| parsed.get(*k).and_then(Value::as_object))
        .flat_map(|o| o.keys().cloned())
        .collect()
}

fn iso(ms: i64) -> String {
    Timestamp::from_millis(ms).to_string()
}

/// 以固定参数跑一次 git，返回去掉首尾空白的 stdout；失败的说明带上命令与 stderr（2.x `runGit`）。
pub fn run_git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let fail = |status: &str, reason: &str| {
        format!(
            "GIT_METRICS_FAILED: git {} ({status}) {}",
            args.join(" "),
            reason.trim()
        )
        .trim()
        .to_owned()
    };
    let mut cmd = Command::new("git");
    cmd.args(["-c", "core.fsmonitor=false", "-c", "core.quotepath=false"])
        .args(args)
        .current_dir(dir)
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
    let mut child = cmd.spawn().map_err(|e| fail("null", &e.to_string()))?;
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = (&mut pipe).take(OUTPUT_MAX as u64).read_to_end(&mut buf);
                let _ = std::io::copy(&mut pipe, &mut std::io::sink());
            }
            buf
        })
    };
    let out = drain(
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let err = drain(
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < GIT_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(5))
            }
            _ => {
                // 超时：结束这个子进程（它是我们起的）。
                let _ = child.kill();
                let _ = child.wait();
                return Err(fail("null", "timed out"));
            }
        }
    };
    let out = String::from_utf8_lossy(&out.join().unwrap_or_default()).into_owned();
    let err = String::from_utf8_lossy(&err.join().unwrap_or_default()).into_owned();
    if status.success() {
        Ok(out.trim().to_owned())
    } else {
        let code = status.code().map_or("null".to_owned(), |c| c.to_string());
        Err(fail(&code, &err))
    }
}

/// 一次扫描的共享上下文：同一次扫描里不会变的结果各算一次。
struct Scan<'a> {
    dir: &'a Path,
    files: OnceCell<Vec<String>>,
    tracked: OnceCell<HashSet<String>>,
    head: OnceCell<String>,
    dependencies: OnceCell<HashSet<String>>,
}

impl<'a> Scan<'a> {
    fn new(dir: &'a Path) -> Self {
        Scan {
            dir,
            files: OnceCell::new(),
            tracked: OnceCell::new(),
            head: OnceCell::new(),
            dependencies: OnceCell::new(),
        }
    }

    fn run(&self, args: &[&str]) -> Result<String, String> {
        run_git(self.dir, args)
    }

    /// 当前 HEAD；仓库还没有首个 commit 时是空树。
    fn head(&self) -> Result<String, String> {
        if let Some(h) = self.head.get() {
            return Ok(h.clone());
        }
        let head = match self.run(&["rev-parse", "HEAD"]) {
            Ok(h) => h,
            Err(e) => {
                if self.run(&["rev-parse", "--is-inside-work-tree"])? == "true" {
                    EMPTY_TREE.to_owned()
                } else {
                    return Err(e);
                }
            }
        };
        Ok(self.head.get_or_init(|| head).clone())
    }

    /// 工作区里参与统计的文件（已跟踪 + 未忽略的新文件）。
    fn files(&self) -> Result<&Vec<String>, String> {
        if self.files.get().is_none() {
            let out = self.run(&[
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
            ])?;
            let files = out
                .split('\0')
                .map(normalize_path)
                .filter(|p| !p.is_empty() && included(p))
                .collect();
            let _ = self.files.set(files);
        }
        Ok(self.files.get().expect("set above"))
    }

    /// 已跟踪路径，用来区分「新建」和「修改」。
    fn tracked(&self) -> Result<&HashSet<String>, String> {
        if self.tracked.get().is_none() {
            let out = self.run(&["ls-files", "--cached", "-z"])?;
            let _ = self
                .tracked
                .set(out.split('\0').map(normalize_path).collect());
        }
        Ok(self.tracked.get().expect("set above"))
    }

    /// 工作区当前的依赖名集合。
    fn dependencies(&self) -> Result<&HashSet<String>, String> {
        if self.dependencies.get().is_none() {
            let mut set = HashSet::new();
            for path in self.files()?.iter().filter(|p| p.ends_with("package.json")) {
                if let Some(content) = self.read_text(path) {
                    set.extend(dependency_names(&String::from_utf8_lossy(&content)));
                }
            }
            let _ = self.dependencies.set(set);
        }
        Ok(self.dependencies.get().expect("set above"))
    }

    /// 读工作区里的文本文件；越界、不存在或二进制（含 NUL）是 None。
    fn read_text(&self, relative: &str) -> Option<Vec<u8>> {
        let mut path = PathBuf::from(self.dir);
        for part in normalize_path(relative).split('/') {
            let piece = Path::new(part);
            if piece
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
            {
                return None;
            }
            path.push(piece);
        }
        let content = std::fs::read(path).ok()?;
        (!content.contains(&0)).then_some(content)
    }

    fn loc(&self, path: &str) -> Option<i64> {
        self.read_text(path).map(|c| line_count(&c))
    }

    /// `git diff --numstat <baseline>`：工作区相对 baseline 的增删（二进制、被排除的不算）。
    fn numstat(&self, baseline: &str) -> Result<Vec<(String, i64, i64)>, String> {
        let out = self.run(&["diff", "--numstat", "--no-renames", baseline, "--"])?;
        Ok(out
            .lines()
            .filter(|l| !l.is_empty())
            .filter_map(|line| {
                let mut parts = line.split('\t');
                let (added, deleted) = (parts.next()?, parts.next()?);
                let path = normalize_path(&parts.collect::<Vec<_>>().join("\t"));
                if path.is_empty() || added == "-" || deleted == "-" || !included(&path) {
                    return None;
                }
                Some((path, added.parse().ok()?, deleted.parse().ok()?))
            })
            .collect())
    }

    fn baseline_before(&self, cutoff_ms: i64) -> Result<String, String> {
        if self.head()? == EMPTY_TREE {
            return Ok(EMPTY_TREE.to_owned());
        }
        let before = format!("--before={}", iso(cutoff_ms));
        let rev = self.run(&["rev-list", "-1", &before, "HEAD"])?;
        Ok(if rev.is_empty() {
            EMPTY_TREE.to_owned()
        } else {
            rev
        })
    }

    fn net_code_lines(&self, cutoff_ms: i64) -> Result<i64, String> {
        let changes = self.numstat(&self.baseline_before(cutoff_ms)?)?;
        Ok(changes
            .iter()
            .filter(|(p, _, _)| code_kind(p).is_some())
            .map(|(_, a, d)| a - d)
            .sum())
    }

    fn baseline_dependencies(&self, baseline: &str) -> Result<HashSet<String>, String> {
        let listing = self.run(&["ls-tree", "-r", "--name-only", baseline])?;
        let mut set = HashSet::new();
        for path in listing
            .lines()
            .filter(|p| p.ends_with("package.json") && included(p))
        {
            let spec = format!("{baseline}:{}", normalize_path(path));
            if let Ok(content) = self.run(&["show", &spec]) {
                set.extend(dependency_names(&content));
            }
        }
        Ok(set)
    }
}

/// 当前 HEAD（任务基线）；仓库还没有首个 commit 时是空树。
pub fn git_head(dir: &Path) -> Result<String, String> {
    Scan::new(dir).head()
}

/// 项目指标（2.x `scanProjectMetrics`）。`top_n` 夹到 1～20，缺省 8。
pub fn scan_project(dir: &Path, now: Timestamp, top_n: Option<usize>) -> Result<Value, String> {
    let scan = Scan::new(dir);
    let top_n = top_n.unwrap_or(8).clamp(1, 20);
    let head = scan.head()?;
    let paths = scan.files()?.clone();
    let mut loc_files: Vec<(String, CodeKind, i64)> = paths
        .iter()
        .filter_map(|p| {
            let kind = code_kind(p)?;
            Some((p.clone(), kind, scan.loc(p)?))
        })
        .collect();
    let sum = |k: CodeKind| -> i64 {
        loc_files
            .iter()
            .filter(|(_, kind, _)| *kind == k)
            .map(|(_, _, l)| l)
            .sum()
    };
    let (source_loc, test_loc) = (sum(CodeKind::Source), sum(CodeKind::Test));
    let empty = head == EMPTY_TREE;
    let log = if empty {
        String::new()
    } else {
        let since = format!("--since={}", iso(now.millis() - 30 * DAY_MS));
        scan.run(&["log", &since, "--numstat", "--format=", "--no-renames"])?
    };
    let dependency_count = scan.dependencies()?.len();
    let (net7, net30) = if empty {
        (source_loc + test_loc, source_loc + test_loc)
    } else {
        (
            scan.net_code_lines(now.millis() - 7 * DAY_MS)?,
            scan.net_code_lines(now.millis() - 30 * DAY_MS)?,
        )
    };

    let mut churn: HashMap<String, (i64, i64)> = HashMap::new();
    for line in log.lines().filter(|l| !l.is_empty()) {
        let mut parts = line.split('\t');
        let (Some(added), Some(deleted)) = (parts.next(), parts.next()) else {
            continue;
        };
        let path = normalize_path(&parts.collect::<Vec<_>>().join("\t"));
        if code_kind(&path).is_none() || added == "-" || deleted == "-" {
            continue;
        }
        let (Ok(a), Ok(d)) = (added.parse::<i64>(), deleted.parse::<i64>()) else {
            continue;
        };
        let entry = churn.entry(path).or_default();
        entry.0 += a;
        entry.1 += d;
    }

    loc_files.sort_by(|l, r| r.2.cmp(&l.2).then_with(|| l.0.cmp(&r.0)));
    let largest: Vec<Value> = loc_files
        .iter()
        .take(top_n)
        .map(|(path, _, loc)| json!({ "path": path, "loc": loc }))
        .collect();
    let mut churn: Vec<(String, i64, i64)> =
        churn.into_iter().map(|(p, (a, d))| (p, a, d)).collect();
    churn.sort_by(|l, r| (r.1 + r.2).cmp(&(l.1 + l.2)).then_with(|| l.0.cmp(&r.0)));
    let high_churn: Vec<Value> = churn
        .iter()
        .take(top_n)
        .map(|(path, a, d)| json!({ "path": path, "added": a, "deleted": d, "churn": a + d }))
        .collect();

    Ok(json!({
        "sourceLoc": source_loc,
        "testLoc": test_loc,
        "fileCount": paths.len(),
        "dependencyCount": dependency_count,
        "netLoc7d": net7,
        "netLoc30d": net30,
        "largestFiles": largest,
        "highChurnFiles": high_churn,
        "head": head,
        "capturedAt": now.to_string(),
    }))
}

/// 任务从 baseline 起的工程变更（2.x `scanWorkItemChanges`）：工作区（含未跟踪的新文件）相对 baseline。
pub fn scan_work_item(dir: &Path, baseline: &str, now: Timestamp) -> Result<Value, String> {
    let scan = Scan::new(dir);
    let tracked_changes = scan.numstat(baseline)?;
    let tracked = scan.tracked()?.clone();
    let paths = scan.files()?.clone();
    let untracked: Vec<(String, i64)> = paths
        .iter()
        .filter(|p| !tracked.contains(*p) && code_kind(p).is_some())
        .filter_map(|p| Some((p.clone(), scan.loc(p)?)))
        .collect();
    let status_output = scan.run(&["diff", "--name-status", "--no-renames", baseline, "--"])?;
    let baseline_dependencies = scan.baseline_dependencies(baseline)?;
    let head = scan.head()?;

    let mut unique: BTreeMap<String, String> = BTreeMap::new();
    for line in status_output.lines().filter(|l| !l.is_empty()) {
        let mut parts = line.split('\t');
        let status = parts.next().unwrap_or_default();
        let path = normalize_path(&parts.collect::<Vec<_>>().join("\t"));
        if !status.is_empty() && !path.is_empty() && included(&path) {
            unique.insert(path, status.to_owned());
        }
    }
    for path in paths.iter().filter(|p| !tracked.contains(*p)) {
        unique.insert(path.clone(), "A".to_owned());
    }
    let code_changes: Vec<(String, i64, i64)> = tracked_changes
        .into_iter()
        .filter(|(p, _, _)| code_kind(p).is_some())
        .chain(untracked.into_iter().map(|(p, a)| (p, a, 0)))
        .collect();
    let added: i64 = code_changes.iter().map(|c| c.1).sum();
    let deleted: i64 = code_changes.iter().map(|c| c.2).sum();
    let added_of = |k: CodeKind| -> i64 {
        code_changes
            .iter()
            .filter(|c| code_kind(&c.0) == Some(k))
            .map(|c| c.1)
            .sum()
    };
    let count = |prefixes: &[char]| -> usize {
        unique.values().filter(|s| s.starts_with(prefixes)).count()
    };
    let mut dependencies_added: Vec<String> = scan
        .dependencies()?
        .iter()
        .filter(|d| !baseline_dependencies.contains(*d))
        .cloned()
        .collect();
    dependencies_added.sort();
    Ok(json!({
        "baseline": baseline,
        "head": head,
        "filesChanged": count(&['M', 'T']),
        "filesCreated": count(&['A']),
        "filesDeleted": count(&['D']),
        "linesAdded": added,
        "linesDeleted": deleted,
        "netLines": added - deleted,
        "sourceLinesAdded": added_of(CodeKind::Source),
        "testLinesAdded": added_of(CodeKind::Test),
        "dependenciesAdded": dependencies_added,
        "capturedAt": now.to_string(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_classified_like_2_0() {
        assert_eq!(normalize_path(".\\src\\a.ts"), "src/a.ts");
        assert!(!included("pnpm-lock.yaml"));
        assert!(!included("apps/web/node_modules/x/index.js"));
        assert!(!included("output/report.ts"));
        assert!(included("src/output.ts"));
        assert_eq!(code_kind("src/main.rs"), Some(CodeKind::Source));
        assert_eq!(code_kind("src/App.TSX"), Some(CodeKind::Source));
        assert_eq!(code_kind("src/a.test.ts"), Some(CodeKind::Test));
        assert_eq!(code_kind("src/spec.js"), Some(CodeKind::Test));
        assert_eq!(code_kind("src/Tests/a.py"), Some(CodeKind::Test));
        assert_eq!(code_kind("src/latest.ts"), Some(CodeKind::Source));
        assert_eq!(code_kind("src/a.testing.ts"), Some(CodeKind::Source));
        assert_eq!(code_kind("types/index.d.ts"), None);
        assert_eq!(code_kind("README.md"), None);
        assert_eq!(code_kind("Build/a.ts"), None);
        assert_eq!(code_kind("Makefile"), None);
    }

    #[test]
    fn lines_and_dependencies_are_counted_like_2_0() {
        assert_eq!(line_count(b""), 0);
        assert_eq!(line_count(b"a"), 1);
        assert_eq!(line_count(b"a\n"), 1);
        assert_eq!(line_count(b"a\r\nb\r\n"), 2);
        assert_eq!(line_count(b"a\n\nb"), 3);
        let mut names = dependency_names(
            r#"{"dependencies":{"a":"1"},"devDependencies":{"b":"1"},"peerDependencies":{"c":"1"},"optionalDependencies":{"d":"1"},"scripts":{"e":"x"}}"#,
        );
        names.sort();
        assert_eq!(names, ["a", "b", "c", "d"]);
        assert!(dependency_names("not json").is_empty());
        assert!(dependency_names(r#"{"dependencies":"x"}"#).is_empty());
    }
}
