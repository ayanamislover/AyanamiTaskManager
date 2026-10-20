//! NS-5（子进程）与 NS-7（Agent 配置）：atm-sync 根本没有这两条通道，集成用例只能验「拒绝后没变化」，
//! 验不出「通道不存在」。所以由这里看着源码与依赖：出现即红。

use std::path::Path;

/// 开子进程或碰 Agent 配置的写法（`std::process::id()` 只取进程号，不算）。
const FORBIDDEN: &[&str] = &[
    "process::Command",
    "process::Child",
    "process::Stdio",
    "process::{",
    "std::process;",
    "std::process as",
    "Command::new",
    "CreateProcess",
    "ShellExecute",
    "WinExec",
    ".codex",
    ".claude",
    "mcp_servers",
    "atm_agents",
];

fn hits(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for (n, line) in text.lines().enumerate() {
        for f in FORBIDDEN {
            if line.contains(f) {
                out.push(format!("{}: {f}", n + 1));
            }
        }
    }
    out
}

fn sources(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            sources(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

#[test]
fn the_sync_crate_has_no_subprocess_or_agent_config_channel() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    sources(&root.join("src"), &mut files);
    assert!(files.len() >= 15, "{files:?}");
    let mut found = Vec::new();
    for f in &files {
        for h in hits(&std::fs::read_to_string(f).unwrap()) {
            found.push(format!("{}:{h}", f.display()));
        }
    }
    assert!(found.is_empty(), "{found:#?}");
    // 依赖里也没有 atm-agents。
    let manifest = std::fs::read_to_string(root.join("Cargo.toml")).unwrap();
    assert!(
        !manifest.contains("atm-agents"),
        "atm-sync 不依赖 atm-agents"
    );
}

/// 阳性对照：每一种写法都认得出来。
#[test]
fn the_guard_recognises_every_forbidden_form() {
    for f in FORBIDDEN {
        assert_eq!(
            hits(&format!("let x = 1;\n    {f}(\"node\");\n")),
            [format!("2: {f}")],
            "{f}"
        );
    }
    assert_eq!(
        hits("let x = std::process::Command::new(\"node\");").len(),
        2
    );
    assert_eq!(hits("use std::process::{Command, Stdio};").len(), 1);
    assert_eq!(hits("use std::process as p;").len(), 1);
    assert!(hits("temporary.push(format!(\".{}.tmp\", std::process::id()));").is_empty());
    assert!(hits("let dir = home.join(\".codex\").join(\"config.toml\");").len() == 1);
}
