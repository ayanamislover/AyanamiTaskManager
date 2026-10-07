//! 对账视图（`atm_task_list(view:"reconcile")`，W4c；2.x `application/test/reconcile.test.ts` 的三组分类）。

mod support;

use atm_domain::time::Timestamp;
use atm_service::read::ReconcileRequest;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Arc;
use support::*;

const NOW: &str = "2026-08-26T12:00:00.000Z";

fn fixed() -> World {
    world_with(
        &format!(
            "reconcile-{}",
            std::thread::current()
                .name()
                .unwrap_or("t")
                .replace("::", "-")
        ),
        Some(Arc::new(|| Timestamp::parse(NOW).unwrap())),
    )
}

/// 源码根登记成项目 PA 的主路径。
fn root(w: &World) -> std::path::PathBuf {
    let root = w.dir.join("src");
    std::fs::create_dir_all(&root).unwrap();
    let path = root.display().to_string().replace('\'', "''");
    w.exec(&format!(
        "INSERT INTO project_paths (id, project_id, path_key, canonical_path, is_primary, last_seen_at)
         VALUES ('PP1', 'PA', 'reconcile-root', '{path}', 1, '{T0}')"
    ));
    root
}

fn set(w: &World, key: &str, sets: &str) {
    let no: i64 = key.rsplit('-').next().unwrap().parse().unwrap();
    w.exec(&format!(
        "UPDATE work_items SET {sets} WHERE project_id = 'PA' AND local_no = {no}"
    ));
}

fn acceptance(w: &World, key: &str, lines: &[&str]) {
    let json = serde_json::to_string(lines).unwrap().replace('\'', "''");
    set(w, key, &format!("acceptance_json = '{json}'"));
}

fn all(w: &World) -> Value {
    w.svc
        .reconcile(
            &agent(),
            "ATM",
            &ReconcileRequest {
                include_active: true,
                limit: 100,
                ..ReconcileRequest::default()
            },
        )
        .unwrap()
}

fn classes(v: &Value) -> Vec<(String, String)> {
    v["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            (
                i["task_key"].as_str().unwrap().to_owned(),
                i["classification"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// 过期在线领取、已关闭停滞、可能已完成、正常活动四类；从未领取过才算「可能已完成」。
#[test]
fn tasks_fall_into_the_four_classes() {
    let w = fixed();
    let root = root(&w);
    write(&root.join("release/report.json"), "{}");
    write(&root.join("README.md"), "accepted");
    w.exec("UPDATE agent_sessions SET connection_state = 'CLOSED', closed_at = '2026-08-26T11:36:00.000Z' WHERE project_id = 'PA' AND id = 'SX'");
    let keys: Vec<String> = (1..=6).map(|i| w.task(&format!("任务 {i}"))).collect();
    set(
        &w,
        &keys[0],
        "status = 'IN_PROGRESS', claimed_by_session_id = 'S1', claim_lease_until = '2026-08-26T12:10:00.000Z', ever_claimed_at = '2026-08-26T11:00:00.000Z'",
    );
    set(
        &w,
        &keys[1],
        "status = 'IN_PROGRESS', claimed_by_session_id = 'S1', claim_lease_until = '2026-08-26T11:50:00.000Z', ever_claimed_at = '2026-08-26T11:00:00.000Z'",
    );
    set(
        &w,
        &keys[2],
        "status = 'CLAIMED', claimed_by_session_id = 'SX', claim_lease_until = '2026-08-26T11:40:00.000Z', ever_claimed_at = '2026-08-26T11:00:00.000Z'",
    );
    acceptance(
        &w,
        &keys[3],
        &["生成 `release/report.json`", "更新 `README.md`"],
    );
    acceptance(&w, &keys[4], &["生成 `missing.json`"]);
    acceptance(&w, &keys[5], &["更新 `release/report.json`"]);
    set(&w, &keys[5], "ever_claimed_at = '2026-08-26T11:40:00.000Z'");

    let before = w.snapshot();
    let v = all(&w);
    assert_eq!(w.snapshot(), before, "reconcile must not write");
    let want: Vec<(String, String)> = keys
        .iter()
        .zip([
            "ACTIVE",
            "LEASE_EXPIRED_ONLINE",
            "STALLED",
            "POSSIBLY_COMPLETE",
            "ACTIVE",
            "ACTIVE",
        ])
        .map(|(k, c)| (k.clone(), c.to_owned()))
        .collect();
    assert_eq!(classes(&v), want);
    let item = |i: usize| &v["items"][i];
    assert_eq!(item(1)["reason"], "claim_lease_expired_but_session_online");
    assert_eq!(item(1)["age_seconds"], 600);
    assert_eq!(item(1)["session"]["id"], "S1");
    assert_eq!(item(1)["session"]["connection_state"], "ONLINE");
    assert_eq!(item(2)["reason"], "session_closed_and_lease_expired");
    assert_eq!(item(2)["age_seconds"], 1200);
    assert_eq!(item(2)["session"]["ended_at"], "2026-08-26T11:36:00.000Z");
    assert_eq!(
        item(3)["reason"],
        "all_explicit_acceptance_paths_exist_and_never_claimed"
    );
    assert_eq!(
        item(3)["evidence_paths"],
        json!(["release/report.json", "README.md"])
    );
    assert_eq!(v["attention_count"], 3);
    assert_eq!(
        v["counts"],
        json!({"ACTIVE": 3, "LEASE_EXPIRED_ONLINE": 1, "STALLED": 1, "POSSIBLY_COMPLETE": 1})
    );
    assert_eq!(
        (v["view"].as_str(), v["project"].as_str()),
        (Some("reconcile"), Some("ATM"))
    );
    for i in v["items"].as_array().unwrap() {
        assert!(i["suggested_action"].as_str().unwrap().chars().count() > 5);
    }
    // 终态任务的领取即使过期也不需要对账。
    let finished = w.task("已完成");
    set(
        &w,
        &finished,
        "status = 'DONE', claimed_by_session_id = 'SX', claim_lease_until = '2026-08-26T11:00:00.000Z', ever_claimed_at = '2026-08-26T10:00:00.000Z'",
    );
    assert_eq!(
        classes(&all(&w)).last().unwrap(),
        &(finished.clone(), "ACTIVE".to_owned())
    );
    // 领取它的 session 根本不存在，也算停滞。
    set(&w, &keys[2], "claimed_by_session_id = 'GONE'");
    assert_eq!(
        all(&w)["items"][2]["reason"],
        "claim_session_missing_and_lease_expired"
    );
}

/// 散文里的 `Node.js`、`v1.5` 不是路径；只有显式写出的产物路径才算。
#[test]
fn prose_tokens_are_not_paths() {
    let w = fixed();
    let root = root(&w);
    write(&root.join("release/report.json"), "{}");
    let key = w.task("散文");
    acceptance(
        &w,
        &key,
        &["支持 Node.js 24 与 v1.5 协议", "生成 `release/report.json`"],
    );
    let v = all(&w);
    assert_eq!(v["items"][0]["classification"], "POSSIBLY_COMPLETE");
    assert_eq!(
        v["items"][0]["evidence_paths"],
        json!(["release/report.json"])
    );
    assert_eq!(
        atm_service::read::reconcile::explicit_paths(&[
            "改 src/a.rs 与 ./b/c.txt，见 ../d/e。".to_owned(),
            "`plain.md` 与 `not a path` 与 docs\\x.md".to_owned(),
        ]),
        ["src/a.rs", "./b/c.txt", "../d/e", "plain.md", "docs\\x.md"]
    );
}

/// 默认只列需对账的；缺失、`..` 越界、junction 越界的路径都不算；没有显式路径的也不算。
#[test]
fn missing_and_escaping_paths_never_suggest_completion() {
    let w = fixed();
    let root = root(&w);
    let outside = w.dir.join("outside");
    write(&root.join("artifacts/ok.txt"), "ok");
    write(&outside.join("outside.txt"), "outside");
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(root.join("escaped"))
        .arg(&outside)
        .stdout(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(status.success());
    let keys: Vec<String> = (1..=5).map(|i| w.task(&format!("路径 {i}"))).collect();
    acceptance(&w, &keys[0], &["产物 `artifacts/ok.txt` 存在"]);
    acceptance(
        &w,
        &keys[1],
        &["产物 `artifacts/ok.txt` 和 `artifacts/missing.txt` 存在"],
    );
    acceptance(&w, &keys[2], &["产物 `../outside/outside.txt` 存在"]);
    acceptance(&w, &keys[3], &["产物 `escaped/outside.txt` 存在"]);
    acceptance(&w, &keys[4], &["不包含显式路径，仅描述行为"]);
    let v = w
        .svc
        .reconcile(&agent(), "atm", &ReconcileRequest::default())
        .unwrap();
    assert_eq!(
        classes(&v),
        [(keys[0].clone(), "POSSIBLY_COMPLETE".to_owned())]
    );
    assert_eq!(
        v["counts"],
        json!({"ACTIVE": 4, "LEASE_EXPIRED_ONLINE": 0, "STALLED": 0, "POSSIBLY_COMPLETE": 1})
    );
    assert_eq!(v["attention_count"], 1);
    // 没有登记源码根：一概不提示。
    w.exec("DELETE FROM project_paths WHERE id = 'PP1'");
    assert_eq!(all(&w)["counts"]["POSSIBLY_COMPLETE"], 0);
}

/// offset 游标分页、预算收缩与 field_mask；坏游标是 INVALID_CURSOR。
#[test]
fn pages_by_offset_within_the_budget() {
    let w = fixed();
    for i in 1..=5 {
        w.task(&format!("分页 {i}"));
    }
    let page = |cursor: Option<&str>, limit: usize, max_chars: usize, mask: &[&str]| {
        w.svc
            .reconcile(
                &agent(),
                "ATM",
                &ReconcileRequest {
                    include_active: true,
                    limit,
                    cursor: cursor.map(str::to_owned),
                    field_mask: mask.iter().map(|s| (*s).to_owned()).collect(),
                    max_chars,
                },
            )
            .unwrap()
    };
    let first = page(None, 2, 12_000, &[]);
    assert_eq!(
        (
            first["returned_count"].as_u64(),
            first["has_more"].as_bool()
        ),
        (Some(2), Some(true))
    );
    assert_eq!(first["next_cursor"], "2");
    let last = page(Some("4"), 2, 12_000, &[]);
    assert_eq!(
        (last["returned_count"].as_u64(), last["has_more"].as_bool()),
        (Some(1), Some(false))
    );
    assert_eq!(last["next_cursor"], Value::Null);
    let masked = page(None, 5, 12_000, &["task_key", "classification"]);
    assert_eq!(masked["items"][0].as_object().unwrap().len(), 2);
    let tight = page(None, 5, 900, &[]);
    assert!(tight["truncated"].as_bool().unwrap());
    assert!(tight["returned_count"].as_u64().unwrap() < 5);
    assert!(
        serde_json::to_string(&tight)
            .unwrap()
            .encode_utf16()
            .count()
            <= 900
    );
    let e = w
        .svc
        .reconcile(
            &agent(),
            "ATM",
            &ReconcileRequest {
                cursor: Some("abc".into()),
                ..ReconcileRequest::default()
            },
        )
        .unwrap_err();
    assert_eq!(e.code.as_str(), "INVALID_CURSOR");
}
