//! `metrics.read`（03 C-08、P-014；W2 peer r2 P1-03）：只返回已存的指标，User 与 Agent 都能读，
//! 只看本项目，读前读后整库与数据根文件不变，不调 git、不刷新。

mod support;

use atm_domain::error::ErrorCode;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::Path;
use support::*;

fn files(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(root, &p, out);
            } else {
                let rel = p
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                // 库文件由快照比较；-shm 里的读标记读一次就会变。
                if !rel.starts_with("atm.sqlite") {
                    out.insert(rel, std::fs::read(&p).unwrap_or_default());
                }
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

/// PA 两条项目指标（取最新那条）、ATM-T-0001 有指标、ATM-T-0002 只有基线；PE 一条更新的项目指标和一个任务的指标。
/// PE 的任务与 ATM-T-0001 用同一个 id（id 只在项目内唯一），漏了 `project_id` 条件就会串到别的项目。
fn seeded(name: &str) -> World {
    let w = world(name);
    with_paths(&w, &["PA", "PE"]);
    let (a1, a2) = (w.task("有指标"), w.task("只有基线"));
    assert_eq!((a1.as_str(), a2.as_str()), ("ATM-T-0001", "ATM-T-0002"));
    w.exec(
        "INSERT INTO objectives (project_id, id, local_no, title, status, created_at, updated_at)
           SELECT 'PE', 'EO1', 1, title, status, created_at, updated_at FROM objectives WHERE project_id = 'PA' AND id = 'O1';
         CREATE TEMP TABLE w AS SELECT * FROM work_items WHERE project_id = 'PA' AND local_no = 1;
         UPDATE w SET project_id = 'PE', objective_id = 'EO1', milestone_id = NULL, parent_id = NULL, title = '别的项目';
         INSERT INTO work_items SELECT * FROM w;
         DROP TABLE w;
         INSERT INTO engineering_project_metrics (project_id, id, git_head, captured_at, payload_json) VALUES
           ('PA', 'M-OLD', 'aaa', '2026-09-01T00:00:00.000Z', '{\"head\":\"aaa\",\"files\":1}'),
           ('PA', 'M-NEW', 'bbb', '2026-09-02T00:00:00.000Z', '{\"head\":\"bbb\",\"files\":2}'),
           ('PE', 'M-PE', 'zzz', '2026-09-03T00:00:00.000Z', '{\"head\":\"zzz\",\"files\":99}');
         INSERT INTO engineering_work_item_metrics (project_id, work_item_id, baseline_ref, baseline_captured_at, payload_json, captured_at, updated_at)
           SELECT 'PA', id, 'base1', '2026-09-01T00:00:00.000Z', '{\"added\":3}', '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z'
           FROM work_items WHERE project_id = 'PA' AND local_no = 1;
         INSERT INTO engineering_work_item_metrics (project_id, work_item_id, baseline_ref, baseline_captured_at, payload_json, captured_at, updated_at)
           SELECT 'PA', id, 'base2', '2026-09-01T00:00:00.000Z', NULL, NULL, '2026-09-01T00:00:00.000Z'
           FROM work_items WHERE project_id = 'PA' AND local_no = 2;
         INSERT INTO engineering_work_item_metrics (project_id, work_item_id, baseline_ref, baseline_captured_at, payload_json, captured_at, updated_at)
           SELECT 'PE', id, 'other', '2026-09-03T00:00:00.000Z', '{\"added\":99}', '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z'
           FROM work_items WHERE project_id = 'PE' AND local_no = 1;",
    );
    w
}

/// 给项目登记源码目录（读只看有没有，不去访问它）。
fn with_paths(w: &World, projects: &[&str]) {
    for p in projects {
        w.exec(&format!(
            "INSERT INTO project_paths (id, project_id, path_key, canonical_path, is_primary, last_seen_at)
             VALUES ('PATH-{p}', '{p}', 'c:/src/{p}', 'C:/src/{p}', 1, '{T0}')"
        ));
    }
}

#[test]
fn metrics_read_returns_stored_values_for_user_and_agent() {
    let w = seeded("metrics-read");
    for who in [user(), agent()] {
        let r = w.svc.metrics_read(&who, "ATM", Some("ATM-T-0001")).unwrap();
        assert_eq!(r["available"], true);
        assert_eq!(r["reason"], Value::Null);
        assert_eq!(r["project"], json!({ "head": "bbb", "files": 2 }));
        assert_eq!(r["projectHead"], "bbb");
        assert_eq!(r["projectCapturedAt"], "2026-09-02T00:00:00.000Z");
        assert_eq!(
            r["workItem"],
            json!({
                "taskKey": "ATM-T-0001",
                "baseline": "base1",
                "baselineCapturedAt": "2026-09-01T00:00:00.000Z",
                "metrics": { "added": 3 },
                "capturedAt": "2026-09-02T00:00:00.000Z",
                "updatedAt": "2026-09-02T00:00:00.000Z",
            })
        );
        // 只记了基线的任务：行在，指标为 null，不当场去算。
        let r = w.svc.metrics_read(&who, "ATM", Some("ATM-T-0002")).unwrap();
        assert_eq!(r["workItem"]["baseline"], "base2");
        assert_eq!(r["workItem"]["metrics"], Value::Null);
        assert_eq!(r["workItem"]["capturedAt"], Value::Null);
        // 没给任务键：只有项目指标。
        let r = w.svc.metrics_read(&who, "ATM", None).unwrap();
        assert_eq!(r["workItem"], Value::Null);
        assert_eq!(r["project"]["files"], 2);
    }
}

#[test]
fn metrics_read_without_data_or_target() {
    let w = world("metrics-read-empty");
    w.task("没有指标的任务");
    with_paths(&w, &["PA"]);
    // 没有任何指标不是错误；任务存在但没有指标行，workItem 为 null。没有源码目录先报这个（2.x 一样）。
    for (project, reason) in [("ATM", "NO_DATA"), ("EMP", "NO_SOURCE_PATH")] {
        let r = w.svc.metrics_read(&agent(), project, None).unwrap();
        assert_eq!(
            (
                r["available"].clone(),
                r["reason"].clone(),
                r["project"].clone()
            ),
            (json!(false), json!(reason), Value::Null)
        );
        assert!(r["message"].is_string());
    }
    // 源码目录被移除、旧指标还在：照样是 NO_SOURCE_PATH，不回显旧的（2.x 先看目录）。
    w.exec(&format!(
        "INSERT INTO engineering_project_metrics (project_id, id, git_head, captured_at, payload_json)
         VALUES ('PE', 'M-PE', 'h', '{T0}', '{{\"head\":\"h\"}}')"
    ));
    let r = w.svc.metrics_read(&agent(), "EMP", None).unwrap();
    assert_eq!(
        (
            r["available"].clone(),
            r["reason"].clone(),
            r["project"].clone()
        ),
        (json!(false), json!("NO_SOURCE_PATH"), Value::Null),
        "{r}"
    );
    let r = w
        .svc
        .metrics_read(&agent(), "ATM", Some("ATM-T-0001"))
        .unwrap();
    assert_eq!(
        (r["available"].clone(), r["workItem"].clone()),
        (json!(false), Value::Null)
    );
    for (project, key, code) in [
        ("NOPE", None, ErrorCode::PROJECT_NOT_FOUND),
        ("ATM", Some("ATM-T-0099"), ErrorCode::WORK_ITEM_NOT_FOUND),
        ("ATM", Some("garbage"), ErrorCode::WORK_ITEM_NOT_FOUND),
    ] {
        let e = w.svc.metrics_read(&agent(), project, key).unwrap_err();
        assert_eq!(e.code, code, "{project} {key:?}");
    }
}

/// 只看本项目：EMP 的项目指标更新也不会成为 ATM 的「最新」；别的项目的任务键在这里找不到。
#[test]
fn metrics_read_is_project_scoped() {
    let w = seeded("metrics-read-isolation");
    let r = w.svc.metrics_read(&agent(), "ATM", None).unwrap();
    assert_eq!(r["projectHead"], "bbb");
    let r = w
        .svc
        .metrics_read(&agent(), "EMP", Some("EMP-T-0001"))
        .unwrap();
    assert_eq!(r["projectHead"], "zzz");
    assert_eq!(r["workItem"]["metrics"], json!({ "added": 99 }));
    let e = w
        .svc
        .metrics_read(&agent(), "ATM", Some("EMP-T-0001"))
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::WORK_ITEM_NOT_FOUND);
}

/// C-08 / 03 :569–570：读前读后整库、数据根文件都不变（2.x 在这里会调 git、写指标行）。
#[test]
fn metrics_read_writes_nothing() {
    let w = seeded("metrics-read-zero-write");
    let (db, tree) = (w.snapshot(), files(&w.dir));
    for who in [user(), agent()] {
        for key in [
            None,
            Some("ATM-T-0001"),
            Some("ATM-T-0002"),
            Some("ATM-T-0099"),
        ] {
            let _ = w.svc.metrics_read(&who, "ATM", key);
        }
        let _ = w.svc.metrics_read(&who, "EMP", None);
    }
    assert_eq!(w.snapshot(), db);
    assert_eq!(files(&w.dir), tree);
    // 入口本身不碰写线程、不起进程：采集与刷新留给 W5 的观察者。
    let src =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/read/metrics.rs"))
            .unwrap();
    for banned in [
        "std::process",
        "Command::new",
        ".write(",
        "INSERT",
        "UPDATE",
        "DELETE",
    ] {
        assert!(
            !src.contains(banned),
            "metrics.read must stay read-only: {banned}"
        );
    }
}
