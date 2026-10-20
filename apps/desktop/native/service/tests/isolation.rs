//! 测试的可写路径不能落进源码树（peer W2 r1 P2-02）。
//!
//! 调用方用外置的 `CARGO_TARGET_DIR` 隔离测试时，测试写的文件必须跟着它走。凡由 `CARGO_MANIFEST_DIR`
//! 拼出来的路径，只能是两种之一：
//! - `CARGO_TARGET_DIR` 没设时的兜底（前 4 行里读了 `CARGO_TARGET_DIR`）；
//! - 只读的源码树数据：绑定到变量时，后 12 行里没有对这个变量的写文件调用；内联在表达式里时，
//!   整条语句里没有写文件调用。
//!
//! 扫 domain / store / service 三个 crate 的全部测试源码；阳性对照是把 W2 r1 发现的那段原样喂给检查器。

use std::fs;
use std::path::{Path, PathBuf};

const WRITES: [&str; 10] = [
    "fs::write(",
    "create_dir",
    "File::create",
    "OpenOptions",
    "remove_file",
    "remove_dir",
    "fs::rename(",
    "fs::copy(",
    "Store::open(",
    "Connection::open(",
];

/// 违规的 `CARGO_MANIFEST_DIR`：(行号, 那一行)。`seen` 记下检查过的出现次数。
fn violations(text: &str, seen: &mut usize) -> Vec<(usize, String)> {
    let lines: Vec<&str> = text.lines().collect();
    let mut out = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let code = line.split("//").next().unwrap_or_default();
        if !code.contains("CARGO_MANIFEST_DIR") || code.contains("const WRITES") {
            continue;
        }
        *seen += 1;
        let before = &lines[i.saturating_sub(4)..i];
        if before.iter().any(|l| l.contains("CARGO_TARGET_DIR")) {
            continue;
        }
        // 绑定到变量时，只看后 12 行里对这个变量的写；没有绑定（内联在表达式里）时看到语句结束。
        let bound = code
            .trim_start()
            .strip_prefix("let ")
            .map(|rest| {
                rest.trim_start_matches("mut ")
                    .split(|c: char| !(c.is_alphanumeric() || c == '_'))
                    .next()
                    .unwrap_or_default()
                    .to_owned()
            })
            .filter(|n| !n.is_empty());
        let end = match &bound {
            Some(_) => (i + 13).min(lines.len()),
            None => lines[i..]
                .iter()
                .position(|l| l.contains(';'))
                .map_or(lines.len(), |p| i + p + 1),
        };
        let writes = |l: &&str| {
            let c = l.split("//").next().unwrap_or_default();
            WRITES.iter().any(|w| c.contains(w)) && bound.as_ref().is_none_or(|n| mentions(c, n))
        };
        if lines[i..end].iter().any(writes) {
            out.push((i + 1, line.trim().to_owned()));
        }
    }
    out
}

/// `code` 里以完整标识符出现的 `name`。
fn mentions(code: &str, name: &str) -> bool {
    code.match_indices(name).any(|(at, _)| {
        let ident = |c: char| c.is_alphanumeric() || c == '_';
        let before = code[..at].chars().next_back().is_none_or(|c| !ident(c));
        let after = code[at + name.len()..]
            .chars()
            .next()
            .is_none_or(|c| !ident(c));
        before && after
    })
}

fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            sources(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn test_outputs_follow_cargo_target_dir() {
    let native = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut files = Vec::new();
    for krate in ["domain", "store", "service"] {
        sources(&native.join(krate).join("tests"), &mut files);
    }
    assert!(files.len() >= 30, "只找到 {} 个测试源文件", files.len());
    let mut seen = 0;
    let mut bad = Vec::new();
    for f in &files {
        if f.ends_with("isolation.rs") {
            continue;
        }
        for (line, text) in violations(&fs::read_to_string(f).unwrap(), &mut seen) {
            bad.push(format!("{}:{line}: {text}", f.display()));
        }
    }
    // 检查器真的看到了这些出现（兜底与只读两类都有），不是空转。
    assert!(seen >= 15, "只看到 {seen} 处 CARGO_MANIFEST_DIR");
    assert!(bad.is_empty(), "测试往源码树里写文件：\n{}", bad.join("\n"));
}

/// 阳性对照：W2 r1 时 `tests/project.rs` 的写法必须被认出来；兜底写法与只读写法不算。
#[test]
fn the_checker_catches_the_original_leak() {
    let leak = r#"
    let blocker = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("target")
        .join("service-tests")
        .join("pj-backup-root-is-a-file");
    std::fs::create_dir_all(blocker.parent().unwrap()).unwrap();
    std::fs::write(&blocker, b"not a directory").unwrap();
"#;
    let fallback = r#"
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("target")
        });
    std::fs::create_dir_all(&dir).unwrap();
"#;
    let read = r#"
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/fp-vectors.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
"#;
    let inline = r#"
    std::fs::write(Path::new(env!("CARGO_MANIFEST_DIR")).join("out.txt"), b"x").unwrap();
"#;
    let mut seen = 0;
    assert_eq!(violations(leak, &mut seen).len(), 1);
    assert_eq!(violations(inline, &mut seen).len(), 1);
    assert!(violations(fallback, &mut seen).is_empty());
    assert!(violations(read, &mut seen).is_empty());
    assert_eq!(seen, 4);
}
