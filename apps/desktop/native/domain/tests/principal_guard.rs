//! 主体构造的静态守卫（03 §2、P-001～P-003；M-03、M-04）。
//!
//! Rust 无法把函数的可见性限定到「某几个 crate」，所以扫描整个原生工作区：
//! 每个构造函数只允许出现在对应的入口 crate 里，以及各 crate 的 `tests/` 目录。
//! 入口 crate 按目录名认：`ui-bridge`、`e2e-adapter`（User）、`http`（Agent）、`sync`（Phone）、`jobs`（System）。
//! 新建这些 crate 时请沿用这些目录名，否则这里会变红。
//!
//! 例外只有两个，都是 crate 自己的后台作业，而且各自只认一种写法——换成任何别的作业仍然算越界：
//! - 同步连接器的后台循环是 System 作业 `sync.loop`（03 §2 的读快照、同步账本），由 `sync` 构造，只认
//!   `system_job(JobId::SyncLoop)`；
//! - 派单的跟踪作业是 `dispatch.track`（核对进程身份、定结局、写派单历史；不能起会话），由 `dispatch` 构造，只认
//!   `system_job(JobId::DispatchTrack)`。

use std::path::{Path, PathBuf};

const CONSTRUCTORS: [(&str, &[&str]); 4] = [
    ("trusted_ui(", &["ui-bridge", "e2e-adapter"]),
    ("authenticated_agent(", &["http"]),
    ("verified_phone(", &["sync"]),
    ("system_job(", &["jobs"]),
];

/// crate 目录 → 那里唯一允许的 System 主体。
const JOB_EXCEPTIONS: [(&str, &str); 2] = [
    ("sync", "system_job(JobId::SyncLoop)"),
    ("dispatch", "system_job(JobId::DispatchTrack)"),
];

/// 返回越界的 `(相对路径, 构造函数)`，以及被允许的出现次数。
fn scan(files: &[(String, String)]) -> (Vec<(String, &'static str)>, usize) {
    let mut violations = Vec::new();
    let mut allowed_hits = 0;
    for (rel, text) in files {
        let rel = rel.replace('\\', "/");
        if rel == "domain/src/principal.rs" {
            continue;
        }
        let crate_dir = rel.split('/').next().unwrap_or_default();
        let in_tests = rel.split('/').any(|part| part == "tests");
        for (ctor, owners) in CONSTRUCTORS {
            let hits = text.matches(ctor).count();
            if hits == 0 {
                continue;
            }
            let own_job_only = ctor == "system_job("
                && JOB_EXCEPTIONS
                    .iter()
                    .any(|(dir, only)| *dir == crate_dir && text.matches(only).count() == hits);
            if in_tests || owners.contains(&crate_dir) || own_job_only {
                allowed_hits += hits;
            } else {
                violations.push((rel.clone(), ctor));
            }
        }
    }
    (violations, allowed_hits)
}

fn workspace_sources() -> Vec<(String, String)> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let mut out = Vec::new();
    let mut stack: Vec<PathBuf> = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            if path.is_dir() {
                if !(name.starts_with("target") || name.starts_with('.') || name == "node_modules")
                {
                    stack.push(path);
                }
            } else if name.ends_with(".rs") {
                let rel = path
                    .strip_prefix(&root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                out.push((rel, std::fs::read_to_string(&path).unwrap()));
            }
        }
    }
    out
}

#[test]
fn principals_are_built_only_by_their_entry_crates() {
    let files = workspace_sources();
    assert!(
        files
            .iter()
            .any(|(p, _)| p.replace('\\', "/") == "domain/src/principal.rs"),
        "scan did not reach the domain crate"
    );
    let (violations, allowed_hits) = scan(&files);
    assert!(
        violations.is_empty(),
        "Principal constructed outside its entry crate: {violations:?}"
    );
    // 本 crate 的 tests/ 用到了构造函数：扫描确实看到了它们，没有空转。
    assert!(allowed_hits > 0);
}

/// 阳性对照：越界调用必须被认出来，入口 crate 与 tests/ 里的调用必须放行。
#[test]
fn the_scan_recognises_violations() {
    let f = |p: &str, t: &str| (p.to_owned(), t.to_owned());
    let (v, allowed) = scan(&[
        f(
            "http/src/routes.rs",
            "let p = Principal::trusted_ui(UiSurface::Tray);",
        ),
        f(
            "mcp-shim/src/main.rs",
            "Principal::authenticated_agent(None)",
        ),
        f(
            "service/src/lib.rs",
            "Principal::system_job(JobId::Maintenance)",
        ),
        f("host/src/bridge.rs", "Principal::verified_phone(a, b, c)"),
        f("ui-bridge/src/lib.rs", "Principal::trusted_ui(s)"),
        f("http/src/auth.rs", "Principal::authenticated_agent(group)"),
        f(
            "service/tests/flows.rs",
            "Principal::trusted_ui(s); Principal::system_job(j)",
        ),
        f(
            "sync/src/session.rs",
            "Principal::system_job(JobId::SyncLoop)",
        ),
        f(
            "sync/src/connector.rs",
            "Principal::system_job(JobId::SyncLoop); Principal::system_job(JobId::Maintenance)",
        ),
        f("http/src/jobs.rs", "Principal::system_job(JobId::SyncLoop)"),
        f(
            "dispatch/src/dispatcher.rs",
            "Principal::system_job(JobId::DispatchTrack)",
        ),
        f(
            "dispatch/src/port.rs",
            "Principal::system_job(JobId::SyncLoop)",
        ),
        f(
            "sync/src/commands.rs",
            "Principal::system_job(JobId::DispatchTrack)",
        ),
    ]);
    assert_eq!(
        v,
        [
            ("http/src/routes.rs".to_owned(), "trusted_ui("),
            ("mcp-shim/src/main.rs".to_owned(), "authenticated_agent("),
            ("service/src/lib.rs".to_owned(), "system_job("),
            ("host/src/bridge.rs".to_owned(), "verified_phone("),
            ("sync/src/connector.rs".to_owned(), "system_job("),
            ("http/src/jobs.rs".to_owned(), "system_job("),
            ("dispatch/src/port.rs".to_owned(), "system_job("),
            ("sync/src/commands.rs".to_owned(), "system_job("),
        ]
    );
    assert_eq!(allowed, 6);
}

/// P-001：主体不能从输入反序列化出来。
#[test]
fn principal_has_no_deserialize() {
    let src =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/principal.rs"))
            .unwrap();
    // 只看代码，不看注释（模块说明里就写着「不实现 Deserialize」）。
    let code: String = src
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join(
            "
",
        );
    assert!(
        !code.contains("Deserialize") && !code.contains("serde"),
        "Principal must not be deserializable (03 P-001)"
    );
    assert!(
        !src.contains("pub enum Inner") && !src.contains("pub struct Principal(pub"),
        "Principal internals must stay private"
    );
}
