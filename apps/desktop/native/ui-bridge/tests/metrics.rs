//! #18 工程指标（W5h2；C-08、P-014）：不带 `refresh` 只读已存的指标，带 `refresh=true` 才当场扫（「刷新统计」）。

mod support;

use serde_json::json;
use std::path::Path;
use std::process::Command;
use support::{error, world};

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.invalid",
            "-c",
            "core.autocrlf=false",
        ])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn rows(w: &support::World) -> i64 {
    w.svc
        .store()
        .read(|tx| {
            tx.query_row(
                "SELECT (SELECT count(*) FROM engineering_project_metrics) + (SELECT count(*) FROM engineering_work_item_metrics)",
                [],
                |r| r.get(0),
            )
        })
        .unwrap()
}

#[test]
fn engineering_metrics_are_read_without_scanning_and_refreshed_on_request() {
    let w = world("metrics-route");
    let repo = w.dir.join("repo");
    std::fs::create_dir_all(repo.join("src")).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("src/main.rs"), "fn main() {}\nfn other() {}\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "first"]);
    let created = w.ok(
        "POST",
        "/api/v1/projects",
        Some(json!({ "name": "统计", "code": "STAT", "sourcePath": repo.to_string_lossy(), "description": "", "coordinationMode": "SOLO" })),
        201,
    );
    assert_eq!(created["code"], "STAT", "{created}");
    let plain = w.project("没有目录", "BARE");

    // 还没统计过：读回 NO_DATA，什么都不写。
    let v = w.get("/api/v1/projects/STAT/engineering-metrics");
    assert_eq!(
        (v["available"].clone(), v["reason"].clone()),
        (json!(false), json!("NO_DATA")),
        "{v}"
    );
    assert_eq!(rows(&w), 0);
    let v = w.get(&format!(
        "/api/v1/projects/{plain}/engineering-metrics?refresh=true"
    ));
    assert_eq!(v["reason"], "NO_SOURCE_PATH");

    // 「刷新统计」：当场扫，回来的就是新数字；之后的读拿到同一份。
    let v = w.get("/api/v1/projects/STAT/engineering-metrics?refresh=true");
    assert_eq!(v["available"], true, "{v}");
    assert_eq!(v["project"]["sourceLoc"], 2);
    assert_eq!(rows(&w), 1);
    let read = w.get("/api/v1/projects/STAT/engineering-metrics");
    assert_eq!(read["project"], v["project"]);
    assert_eq!(rows(&w), 1, "a read writes nothing");
    let v = w.get("/api/v1/projects/STAT/engineering-metrics?refresh=0");
    assert_eq!(v["project"], read["project"]);
    assert_eq!(rows(&w), 1);
    error(
        &w.call(
            "GET",
            "/api/v1/projects/STAT/engineering-metrics?refresh=yes",
            None,
        ),
        400,
        "INVALID_ARGUMENT",
    );
}
