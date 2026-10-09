//! 扫描对着真实的 git 仓库验（2.x `packages/engineering-metrics` 的口径）：两个带日期的提交、未跟踪的新文件、
//! 删除、依赖清单、被排除的目录与二进制文件。

use atm_domain::time::Timestamp;
use atm_metrics::{EMPTY_TREE, git_head, run_git, scan_project, scan_work_item};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Command;

const DAY: i64 = 86_400_000;

fn now() -> Timestamp {
    Timestamp::parse("2027-03-01T12:00:00.000Z").unwrap()
}

fn root() -> PathBuf {
    std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("target")
        })
        .join("metrics-tests")
}

fn repo(name: &str) -> PathBuf {
    let dir = root().join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"], None);
    dir
}

fn git(dir: &Path, args: &[&str], date: Option<Timestamp>) {
    let mut cmd = Command::new("git");
    cmd.args([
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "-c",
        "core.autocrlf=false",
    ])
    .args(args)
    .current_dir(dir);
    if let Some(d) = date {
        let text = d.to_string();
        cmd.env("GIT_AUTHOR_DATE", &text)
            .env("GIT_COMMITTER_DATE", &text);
    }
    let out = cmd.output().unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn write(dir: &Path, path: &str, content: &str) {
    let p = dir.join(path);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, content).unwrap();
}

fn commit(dir: &Path, message: &str, date: Timestamp) {
    git(dir, &["add", "-A"], None);
    git(dir, &["commit", "-q", "-m", message], Some(date));
}

fn rev(dir: &Path, spec: &str) -> String {
    run_git(dir, &["rev-parse", spec]).unwrap()
}

/// 40 天前、10 天前、3 天前各一个提交，工作区再加一个未跟踪的新文件。
fn history(name: &str) -> PathBuf {
    let dir = repo(name);
    write(&dir, "src/old.rs", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
    write(&dir, "src/gone.rs", "a\nb\n");
    write(&dir, "package.json", r#"{"dependencies":{"left-pad":"1"}}"#);
    write(&dir, "README.md", "readme\n");
    commit(
        &dir,
        "first",
        Timestamp::from_millis(now().millis() - 40 * DAY),
    );
    write(&dir, "src/a.rs", "fn a() {}\nfn b() {}\nfn c() {}");
    commit(
        &dir,
        "second",
        Timestamp::from_millis(now().millis() - 10 * DAY),
    );
    write(&dir, "tests/b.rs", "#[test]\nfn t() {}\n");
    write(
        &dir,
        "package.json",
        r#"{"dependencies":{"left-pad":"1","serde":"1"},"devDependencies":{"vitest":"1"}}"#,
    );
    write(&dir, "node_modules/x/index.js", "ignored\nignored\n");
    write(&dir, "pnpm-lock.yaml", "lock\n");
    std::fs::remove_file(dir.join("src/gone.rs")).unwrap();
    commit(
        &dir,
        "third",
        Timestamp::from_millis(now().millis() - 3 * DAY),
    );
    write(&dir, "src/new.ts", "1\n2\n3\n4\n");
    std::fs::write(dir.join("src/blob.rs"), [b'x', 0, b'y', b'\n']).unwrap();
    dir
}

#[test]
fn project_metrics_follow_the_2_0_rules() {
    let dir = history("project");
    let m = scan_project(&dir, now(), None).unwrap();
    // old 10 + a 3 + new 4（未跟踪的照算）；blob 是二进制不算；node_modules、锁文件不算。
    assert_eq!(m["sourceLoc"], 17, "{m}");
    assert_eq!(m["testLoc"], 2);
    // 参与统计的文件：README、package.json、old、a、b、new、blob。
    assert_eq!(m["fileCount"], 7, "{m}");
    assert_eq!(m["dependencyCount"], 3);
    // 7 天前的基线是第二个提交：b +2、gone −2；30 天前的是第一个：再加 a +3（未跟踪的不在 diff 里）。
    assert_eq!(m["netLoc7d"], 0, "{m}");
    assert_eq!(m["netLoc30d"], 3);
    assert_eq!(
        m["largestFiles"],
        json!([
            { "path": "src/old.rs", "loc": 10 },
            { "path": "src/new.ts", "loc": 4 },
            { "path": "src/a.rs", "loc": 3 },
            { "path": "tests/b.rs", "loc": 2 },
        ])
    );
    // 30 天内是后两个提交：a、b、gone 三个代码文件（old 在 40 天前，不算）。
    assert_eq!(
        m["highChurnFiles"],
        json!([
            { "path": "src/a.rs", "added": 3, "deleted": 0, "churn": 3 },
            { "path": "src/gone.rs", "added": 0, "deleted": 2, "churn": 2 },
            { "path": "tests/b.rs", "added": 2, "deleted": 0, "churn": 2 },
        ])
    );
    assert_eq!(m["head"], rev(&dir, "HEAD"));
    assert_eq!(m["capturedAt"], now().to_string());
    // 列表按 topN 截断（夹到 1～20）。
    let top = scan_project(&dir, now(), Some(0)).unwrap();
    assert_eq!(top["largestFiles"].as_array().unwrap().len(), 1);
    assert_eq!(top["highChurnFiles"].as_array().unwrap().len(), 1);
}

#[test]
fn work_item_changes_are_measured_from_the_baseline() {
    let dir = history("work-item");
    let baseline = rev(&dir, "HEAD~2");
    let m = scan_work_item(&dir, &baseline, now()).unwrap();
    let expect: Value = json!({
        "baseline": baseline,
        "head": rev(&dir, "HEAD"),
        // package.json 改了；a、b、node_modules 里那个不算（被排除）、锁文件不算、new 与 blob 是新文件；gone 删了。
        "filesChanged": 1,
        "filesCreated": 4,
        "filesDeleted": 1,
        // 代码：a +3、b +2、new +4（未跟踪按全文算），gone −2。
        "linesAdded": 9,
        "linesDeleted": 2,
        "netLines": 7,
        "sourceLinesAdded": 7,
        "testLinesAdded": 2,
        "dependenciesAdded": ["serde", "vitest"],
        "capturedAt": now().to_string(),
    });
    assert_eq!(m, expect);
    // 从 HEAD 起：只剩未跟踪的新文件。
    let head = rev(&dir, "HEAD");
    let m = scan_work_item(&dir, &head, now()).unwrap();
    assert_eq!(
        (m["filesCreated"].clone(), m["linesAdded"].clone()),
        (json!(2), json!(4))
    );
    assert_eq!(m["dependenciesAdded"], json!([]));
}

#[test]
fn a_repository_without_commits_uses_the_empty_tree() {
    let dir = repo("empty");
    write(&dir, "src/a.rs", "1\n2\n");
    write(&dir, "tests/t.rs", "1\n");
    assert_eq!(git_head(&dir).unwrap(), EMPTY_TREE);
    let m = scan_project(&dir, now(), None).unwrap();
    assert_eq!(m["head"], EMPTY_TREE);
    assert_eq!(
        (m["netLoc7d"].clone(), m["netLoc30d"].clone()),
        (json!(3), json!(3))
    );
    assert_eq!(m["highChurnFiles"], json!([]));
    let w = scan_work_item(&dir, EMPTY_TREE, now()).unwrap();
    assert_eq!(
        (w["filesCreated"].clone(), w["linesAdded"].clone()),
        (json!(2), json!(3))
    );
}

#[test]
fn history_younger_than_the_window_counts_from_the_empty_tree() {
    let dir = repo("young");
    write(&dir, "src/a.rs", "1\n2\n");
    commit(
        &dir,
        "only",
        Timestamp::from_millis(now().millis() - 3 * DAY),
    );
    let m = scan_project(&dir, now(), None).unwrap();
    // 窗口开始之前没有提交：基线是空树，整个文件都是这段时间加的。
    assert_eq!(
        (m["netLoc7d"].clone(), m["netLoc30d"].clone()),
        (json!(2), json!(2)),
        "{m}"
    );
}

#[test]
fn a_directory_that_is_not_a_repository_fails_with_the_command() {
    // 测试目录在工作树里面，git 会往上找到外层仓库：放一个指向不存在目录的 `.git` 文件挡住。
    let dir = root().join("not-git");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(".git"), "gitdir: does-not-exist\n").unwrap();
    let e = scan_project(&dir, now(), None).unwrap_err();
    assert!(
        e.starts_with("GIT_METRICS_FAILED: git rev-parse --is-inside-work-tree"),
        "{e}"
    );
    // 目录不存在：git 根本起不来（退出码 null）；与 2.x 一样报的是第二条命令。
    let e = git_head(&root().join("missing-dir")).unwrap_err();
    assert!(
        e.starts_with("GIT_METRICS_FAILED: git rev-parse --is-inside-work-tree (null)"),
        "{e}"
    );
}
