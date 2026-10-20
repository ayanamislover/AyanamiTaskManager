//! agenttask-md 导入的验收（peer W2 r1 P1-05；03 U13、A18、§5.3；00 C-17）。
//!
//! 解析对照 `tests/data/agenttask-vectors.json`：由 2.x 的 `parseAgentTaskMarkdown` 原样生成
//! （生成脚本同目录 `agenttask-vectors.mjs`）。唯一的有意差异是记录标题截断不切开代理对
//! （00 02 C-19），向量里以 `splitSurrogate` 标出。

mod support;

use atm_domain::error::ErrorCode;
use atm_service::work::{ImportPlan, Target, parse_agenttask};
use serde_json::{Value, json};
use support::*;

fn plan_json(p: &ImportPlan) -> Value {
    json!({
        "sha256": p.sha256,
        "sourceName": p.source_name,
        "objectives": p.objectives.iter().map(|o| json!({ "ref": o.r#ref, "title": o.title, "line": o.line })).collect::<Vec<_>>(),
        "milestones": p.milestones.iter().map(|m| json!({ "ref": m.r#ref, "objectiveRef": m.objective_ref, "title": m.title, "line": m.line })).collect::<Vec<_>>(),
        "tasks": p.tasks.iter().map(|t| json!({ "ref": t.r#ref, "objectiveRef": t.objective_ref, "milestoneRef": t.milestone_ref, "title": t.title, "completed": t.completed, "line": t.line })).collect::<Vec<_>>(),
        "records": p.records.iter().map(|r| json!({ "title": r.title, "detail": r.detail, "line": r.line })).collect::<Vec<_>>(),
        "warnings": p.warnings,
    })
}

/// A18：解析与 2.x 逐字段一致（标题、行号、ref、警告、sha256）。
#[test]
fn agenttask_parsing_matches_2x() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/data/agenttask-vectors.json"
    );
    let vectors: Vec<Value> =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert!(vectors.len() >= 10);
    let mut split = 0;
    for v in &vectors {
        let mut expected = v["plan"].clone();
        for r in expected["records"].as_array_mut().unwrap() {
            if r.as_object_mut()
                .unwrap()
                .remove("splitSurrogate")
                .is_some()
            {
                split += 1;
            }
        }
        let source = expected["sourceName"].as_str().unwrap().to_owned();
        let got = plan_json(&parse_agenttask(v["content"].as_str().unwrap(), &source));
        assert_eq!(got, expected, "{}", v["name"]);
    }
    assert_eq!(split, 1, "向量里应有一处被 2.x 切开的代理对");
}

const SOURCE: &str =
    "# 目标一\n## 阶段 A\n- [ ] 待办\n- [x] 已完成\n普通说明\n# 目标二\n- [ ] 另一项";

/// A18：预览只解析不落账，Agent 也可以；U13：应用只有 User，Agent 403 且零写入。
#[test]
fn preview_is_read_only_and_apply_is_user_only() {
    let w = world("im-preview");
    let before = w.snapshot();
    let v = w.svc.preview_import(&agent(), "ATM", SOURCE, None).unwrap();
    assert_eq!(w.snapshot(), before);
    assert_eq!(
        (
            v["objectiveCount"].clone(),
            v["milestoneCount"].clone(),
            v["taskCount"].clone(),
            v["recordCount"].clone(),
            v["alreadyImported"].clone()
        ),
        (json!(2), json!(1), json!(3), json!(1), json!(false))
    );
    assert_eq!(v["project"]["code"], "ATM");
    w.refused(ErrorCode::USER_AUTHORIZATION_REQUIRED, || {
        w.svc
            .apply_import(&agent(), &w.target(Some("S1")), SOURCE, None, None)
    });
    let e = w
        .svc
        .preview_import(&agent(), "ATM", &"x".repeat(2 * 1024 * 1024 + 1), None)
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::INVALID_ARGUMENT);
}

/// U13 + C-17：一个事务建全 objective / milestone / 任务 / 记录与 import_history；勾了的任务直接 DONE，
/// 事件写明来源；同一个源再导入是 alreadyImported，不再写业务行；同 op_id 重放。
#[test]
fn apply_imports_everything_at_once() {
    let w = world("im-apply");
    let t = Target::new("PA", None, "import-1");
    let r = w
        .svc
        .apply_import(&user(), &t, SOURCE, Some("plan.md"), None)
        .unwrap();
    assert_eq!(
        (
            r.result["importedObjectives"].clone(),
            r.result["importedMilestones"].clone(),
            r.result["importedTasks"].clone(),
            r.result["importedRecords"].clone(),
            r.result["alreadyImported"].clone()
        ),
        (json!(2), json!(1), json!(3), json!(1), json!(false))
    );
    assert_eq!(
        w.count("SELECT count(*) FROM objectives WHERE project_id = 'PA'"),
        4
    );
    // 后导入的「目标二」是 ACTIVE，其余降为 PLANNED（与显式建 objective 同规则）。
    assert_eq!(
        w.scalar("SELECT title FROM objectives WHERE project_id = 'PA' AND status = 'ACTIVE'"),
        "目标二"
    );
    assert_eq!(
        w.scalar("SELECT group_concat(status, ',') FROM (SELECT status FROM work_items WHERE project_id = 'PA' ORDER BY local_no)"),
        "READY,DONE,READY"
    );
    assert_eq!(
        w.count("SELECT count(*) FROM events WHERE type = 'work.created' AND json_extract(payload_json, '$.source') = 'agenttask_import'"),
        3
    );
    assert_eq!(
        w.scalar("SELECT source_type || ':' || source_ref || ':' || kind FROM records WHERE project_id = 'PA'"),
        "IMPORT:plan.md:REFERENCE"
    );
    // 第二个任务挂在「阶段 A」，第三个不挂 milestone。
    assert_eq!(
        w.scalar("SELECT count(*) FROM work_items wi JOIN milestones m ON m.project_id = wi.project_id AND m.id = wi.milestone_id WHERE m.title = '阶段 A'"),
        2
    );
    assert_eq!(w.count("SELECT count(*) FROM import_history"), 1);

    let before = w.snapshot();
    let again = w
        .svc
        .apply_import(&user(), &t, SOURCE, Some("plan.md"), None)
        .unwrap();
    assert!(again.replayed);
    assert_eq!(w.snapshot(), before);

    let tasks = w.count("SELECT count(*) FROM work_items");
    let other = w
        .svc
        .apply_import(&user(), &w.target(None), SOURCE, Some("plan.md"), None)
        .unwrap();
    assert_eq!(other.result["alreadyImported"], true);
    assert_eq!(other.result["importedTasks"], 3);
    assert_eq!(w.count("SELECT count(*) FROM work_items"), tasks);
    assert_eq!(
        w.svc.preview_import(&user(), "ATM", SOURCE, None).unwrap()["alreadyImported"],
        true
    );
}

/// U13 反例：源在预览后变了、某个标题不合法（整个导入回滚，前面合法的 objective 也不留）——都零写入。
/// 超过一批（50 条）的任务分批建在同一事务里。
#[test]
fn apply_is_all_or_nothing() {
    let w = world("im-atomic");
    w.refused(ErrorCode::IMPORT_SOURCE_CHANGED, || {
        w.svc
            .apply_import(&user(), &w.target(None), SOURCE, None, Some("deadbeef"))
    });
    let bad = format!("# 合法的目标\n- [ ] 合法任务\n# {}", "长".repeat(401));
    let e = w.refused(ErrorCode::INVALID_ARGUMENT, || {
        w.svc
            .apply_import(&user(), &w.target(None), &bad, None, None)
    });
    assert_eq!(e.details["line"], 3);

    let many: String = (1..=60).map(|i| format!("- [ ] 任务 {i}\n")).collect();
    let r = w
        .svc
        .apply_import(&user(), &w.target(None), &many, None, None)
        .unwrap();
    assert_eq!(r.result["importedTasks"], 60);
    assert_eq!(
        w.count("SELECT count(*) FROM work_items WHERE project_id = 'PA'"),
        60
    );
    assert_eq!(
        w.scalar("SELECT title FROM objectives WHERE project_id = 'PA' AND status = 'ACTIVE'"),
        "导入任务"
    );
}
