//! 派单器的静态守卫。每条守卫先扫真实源码（必须没有违例），再扫一份故意写错的对照（必须查出来），
//! 免得扫描写错了永远是绿的。
//!
//! - 每个收身份的公开入口第一句就核对能力（P-017：先拒，后做任何事）；
//! - 拉起许可只在 `enqueue_new` 里发，`enqueue_new` 只由 `enqueue` 调（跟踪作业发不出许可，也就起不了会话）；
//! - 只有 `process.rs` / `probe.rs` 起进程；
//! - 派单器从不写 `interrupted`（手机协议只有五种状态）。

use std::path::PathBuf;

fn src(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// 去掉 `#[cfg(test)]` 之后的单元测试模块（守卫只管生产代码）。
fn production(text: &str) -> &str {
    text.split("#[cfg(test)]\nmod tests").next().unwrap_or(text)
}

/// `fn name` 的函数体（从签名后的第一个 `{` 到与它配对的 `}`）。
fn body<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    let at = text.find(&format!("fn {name}("))?;
    let open = at + text[at..].find('{')?;
    let mut depth = 0usize;
    for (i, c) in text[open..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&text[open + 1..open + i]);
                }
            }
            _ => {}
        }
    }
    None
}

/// 签名里收 `principal: &Principal` 的公开方法，第一句不是 `capability::require(principal, Capability::Dispatch…)` 的。
fn unchecked_entries(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut entries = 0;
    for (at, _) in text.match_indices("    pub fn ") {
        let rest = &text[at + 11..];
        let name: String = rest
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        let Some(open) = rest.find('{') else { continue };
        if !rest[..open].contains("principal: &Principal") {
            continue;
        }
        entries += 1;
        let first = rest[open + 1..]
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty() && !l.starts_with("//"))
            .unwrap_or("");
        if !first.starts_with("capability::require(principal, Capability::Dispatch") {
            out.push(format!("{name}: {first}"));
        }
    }
    if entries == 0 {
        out.push("一个收身份的入口都没找到".into());
    }
    out
}

#[test]
fn every_entry_that_takes_a_principal_checks_its_capability_first() {
    let real = src("dispatcher.rs");
    assert_eq!(unchecked_entries(production(&real)), Vec::<String>::new());
    for name in ["status", "update_config", "enqueue", "cancel"] {
        assert!(
            body(&real, name).is_some(),
            "入口 {name} 不见了：守卫要跟着改"
        );
    }
    let control = "impl D {\n    pub fn enqueue(\n        &self,\n        principal: &Principal,\n    ) -> R {\n        let i = &self.inner;\n        capability::require(principal, Capability::DispatchLaunch)?;\n    }\n}\n";
    assert_eq!(unchecked_entries(control).len(), 1);
    let wrong_cap = "    pub fn cancel(&self, principal: &Principal) -> R {\n        capability::require(principal, Capability::WorkPatch)?;\n    }\n";
    assert_eq!(unchecked_entries(wrong_cap).len(), 1);
}

/// 发许可（`grants.insert`）的位置不在 `enqueue_new` 里，或 `enqueue_new` 有 `enqueue` 以外的调用者。
fn stray_grants(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let inserts = text.matches("grants.insert(").count();
    let inside = body(text, "enqueue_new").map_or(0, |b| b.matches("grants.insert(").count());
    if inserts != 1 || inside != 1 {
        out.push(format!(
            "grants.insert 共 {inserts} 处，enqueue_new 里 {inside} 处"
        ));
    }
    let calls = text.matches(".enqueue_new(").count();
    let from_enqueue = body(text, "enqueue").map_or(0, |b| b.matches(".enqueue_new(").count());
    if calls == 0 || calls != from_enqueue {
        out.push(format!(
            "enqueue_new 共 {calls} 处调用，enqueue 里 {from_enqueue} 处"
        ));
    }
    out
}

#[test]
fn launch_grants_come_only_from_an_enqueue_that_passed_the_capability_check() {
    let real = src("dispatcher.rs");
    assert_eq!(stray_grants(production(&real)), Vec::<String>::new());
    let tracker_mints = "fn enqueue(&self) {\n    i.enqueue_new(p);\n}\nfn enqueue_new(&self) {\n    s.grants.insert(run, p);\n}\nfn reconcile(&self) {\n    s.grants.insert(run, tracker());\n}\n";
    assert_eq!(stray_grants(tracker_mints).len(), 1);
    let side_door = "fn enqueue(&self) {\n    i.enqueue_new(p);\n}\nfn enqueue_new(&self) {\n    s.grants.insert(run, p);\n}\nfn track_loop(&self) {\n    i.enqueue_new(tracker());\n}\n";
    assert_eq!(stray_grants(side_door).len(), 1);
}

const SPAWNS: [&str; 3] = ["CreateProcessW(", "Command::new(", "process::Command"];

/// 起进程的调用出现在 `allowed` 以外的源文件里。
fn spawns_outside(files: &[(&str, String)], allowed: &[&str]) -> Vec<String> {
    files
        .iter()
        .filter(|(name, _)| !allowed.contains(name))
        .flat_map(|(name, text)| {
            SPAWNS
                .iter()
                .filter(|s| production(text).contains(*s))
                .map(move |s| format!("{name}: {s}"))
        })
        .collect()
}

#[test]
fn only_the_process_and_probe_modules_start_processes() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let files: Vec<(&str, String)> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "rs"))
        .map(|p| {
            let name: &'static str = Box::leak(
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
                    .into_boxed_str(),
            );
            (name, std::fs::read_to_string(&p).unwrap())
        })
        .collect();
    assert!(files.len() >= 10, "src 下的文件没读全：{}", files.len());
    assert_eq!(
        spawns_outside(&files, &["process.rs", "probe.rs"]),
        Vec::<String>::new()
    );
    let mut control = files.clone();
    control.push((
        "dispatcher.rs",
        "let c = std::process::Command::new(claude);".into(),
    ));
    assert_eq!(
        spawns_outside(&control, &["process.rs", "probe.rs"]).len(),
        2
    );
}

/// 生产代码里写出 `interrupted` 的地方（注释除外）。
fn writes_interrupted(text: &str) -> Vec<String> {
    production(text)
        .lines()
        .filter(|l| !l.trim_start().starts_with("//") && l.contains("interrupted"))
        .map(str::to_owned)
        .collect()
}

#[test]
fn the_dispatcher_never_writes_the_interrupted_state() {
    for name in ["record.rs", "dispatcher.rs", "ledger.rs", "port.rs"] {
        assert_eq!(
            writes_interrupted(&src(name)),
            Vec::<String>::new(),
            "{name}"
        );
    }
    assert_eq!(
        writes_interrupted("// 允许 interrupted\nState::Interrupted => \"interrupted\",\n").len(),
        1
    );
}
