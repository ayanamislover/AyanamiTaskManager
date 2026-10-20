//! C-L03（04）：界面建项目也在提交之后写 marker 与 git exclude（与 Agent 入口同一个函数）。
//! 写不成不影响项目建成；回执保持 2.0 的形状（没有 `marker_written`）。

mod support;

use serde_json::{Value, json};
use std::path::Path;
use support::world;

/// 各自一个仓库：测试目录本身在外层仓库里，不 init 的话两个目录按 git common dir 会认成同一个项目。
fn repo(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    let out = std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(out.status.success());
}

fn projects_with_code(w: &support::World, code: &str) -> i64 {
    w.svc
        .store()
        .read(|tx| {
            tx.query_row(
                "SELECT count(*) FROM projects WHERE code = ?1",
                [code],
                |r| r.get(0),
            )
        })
        .unwrap()
}

#[test]
fn c_l03_creating_a_project_from_the_ui_writes_the_marker_after_commit() {
    let w = world("marker-route");
    let repo = w.dir.join("repo");
    self::repo(&repo);
    let created = w.ok(
        "POST",
        "/api/v1/projects",
        Some(json!({ "name": "有目录", "code": "MARK", "sourcePath": repo.to_string_lossy(), "description": "", "coordinationMode": "SOLO" })),
        201,
    );
    assert_eq!(created["code"], "MARK", "{created}");
    assert!(
        created.get("marker_written").is_none() && created.get("markerWritten").is_none(),
        "{created}"
    );
    let marker: Value = serde_json::from_str(
        &std::fs::read_to_string(repo.join(".ayanami-task").join("project.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(marker["project_code"], "MARK", "{marker}");

    // 反例：marker 写不成（`.ayanami-task` 是个文件），项目照样建成，挡路的文件原样不动。
    let blocked = w.dir.join("blocked");
    self::repo(&blocked);
    std::fs::write(blocked.join(".ayanami-task"), "not a directory").unwrap();
    let created = w.ok(
        "POST",
        "/api/v1/projects",
        Some(json!({ "name": "挡住了", "code": "BLOK", "sourcePath": blocked.to_string_lossy(), "description": "", "coordinationMode": "SOLO" })),
        201,
    );
    assert_eq!(created["code"], "BLOK", "{created}");
    assert_eq!(
        std::fs::read_to_string(blocked.join(".ayanami-task")).unwrap(),
        "not a directory"
    );
    assert_eq!(projects_with_code(&w, "BLOK"), 1);
}
