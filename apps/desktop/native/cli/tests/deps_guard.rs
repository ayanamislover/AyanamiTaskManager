//! A6（03 §2.5）的静态守卫：atm.exe 不链接 Agent HTTP、ui-bridge，也不链接服务层与调度器——
//! 在线命令只是 Agent REST 的客户端，离线命令只读文件，都不构造 Principal。
//!
//! 沿 `cli/Cargo.toml` 的 path 依赖往下走（只看会进二进制的 `[dependencies]`、`[target.*.dependencies]`、
//! `[build-dependencies]`，不看 `[dev-dependencies]`：黑盒用例要起真实服务），走到禁用的 crate 就变红。
//! 注册表里的 crate 不可能依赖工作区里的 crate，所以只需要走 path 依赖。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

const FORBIDDEN: [&str; 6] = [
    "atm-http",
    "atm-ui-bridge",
    "atm-service",
    "atm-jobs",
    "atm-runtime",
    "atm-e2e-adapter",
];

/// 一个 Cargo.toml 里会进二进制的 path 依赖：(包名, 目录)。
fn path_deps(manifest: &str, dir: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    let mut linked = false;
    for raw in manifest.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            let header = line.trim_matches(|c| c == '[' || c == ']').trim();
            linked = header == "dependencies"
                || header == "build-dependencies"
                || (header.starts_with("target.") && header.ends_with(".dependencies"));
            continue;
        }
        if !linked || line.starts_with('#') {
            continue;
        }
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        let Some(at) = value.find("path") else {
            continue;
        };
        let rest = &value[at + 4..];
        let Some(start) = rest.find('"') else {
            continue;
        };
        let Some(len) = rest[start + 1..].find('"') else {
            continue;
        };
        let rel = &rest[start + 1..start + 1 + len];
        let name = name.trim().trim_matches('"');
        // `foo = { package = "atm-bar", path = … }` 的真名在 package 里。
        let package = value
            .find("package")
            .and_then(|p| {
                let r = &value[p..];
                let s = r.find('"')?;
                let l = r[s + 1..].find('"')?;
                Some(r[s + 1..s + 1 + l].to_owned())
            })
            .unwrap_or_else(|| name.to_owned());
        out.push((package, dir.join(rel)));
    }
    out
}

fn reachable(manifest_dir: &Path) -> BTreeSet<String> {
    let mut seen = BTreeSet::new();
    let mut stack = vec![manifest_dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let text = std::fs::read_to_string(dir.join("Cargo.toml")).unwrap();
        for (name, child) in path_deps(&text, &dir) {
            if seen.insert(name) {
                stack.push(child);
            }
        }
    }
    seen
}

#[test]
fn atm_exe_links_no_http_bridge_or_service() {
    let here = Path::new(env!("CARGO_MANIFEST_DIR"));
    let deps = reachable(here);
    // 走到了真正的依赖（空集合说明解析空转，守卫没有意义）。
    for expected in ["atm-domain", "atm-store", "atm-install-state"] {
        assert!(deps.contains(expected), "{expected} not reached: {deps:?}");
    }
    let bad: Vec<&&str> = FORBIDDEN.iter().filter(|f| deps.contains(**f)).collect();
    assert!(bad.is_empty(), "atm.exe would link {bad:?} (A6)");
}

/// 阳性对照：同一个解析器对着服务层和宿主一定能走到禁用的 crate；加一条 dev 依赖不算链接。
#[test]
fn the_walker_finds_forbidden_crates_where_they_are() {
    let native = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    assert!(reachable(&native.join("http")).contains("atm-service"));
    assert!(reachable(&native.join("runtime")).contains("atm-http"));
    let sample = "[dependencies]\natm-domain = { path = \"../domain\" }\n\
                  [target.'cfg(windows)'.dependencies]\nx = { package = \"atm-http\", path = \"../http\" }\n\
                  [dev-dependencies]\natm-service = { path = \"../service\" }\n";
    let names: Vec<String> = path_deps(sample, native)
        .into_iter()
        .map(|(n, _)| n)
        .collect();
    assert_eq!(names, ["atm-domain", "atm-http"]);
}
