//! W4d 写工具，经真实监听器与真实服务：写入目标的补缺（project 按 session、auto op_id）、R11 的默认值与推断、
//! task_patch 的单条顶层写法与 `checklist` 合称、复合操作只能单条（W-050）、ACK 的 v6 字段（merges 在顶层、
//! auto_applied、refs、deprecations、adjusted、normalized）、A1 白名单、C-04、P-001。

mod support;

use serde_json::{Value, json};
use support::*;

/// 白名单客户端与非白名单客户端的连接组身份（A4：`<祖先 pid>:<创建时间>@<clientInfo.name>`）。
const CLI: &str = "4242:1700000000@claude-code";
const DESKTOP: &str = "5151:1700000000@claude-desktop";

fn ok(r: &Value) -> &Value {
    assert_ne!(r["isError"], json!(true), "{r}");
    &r["structuredContent"]
}

fn err(r: &Value) -> &Value {
    assert_eq!(r["isError"], json!(true), "{r}");
    &r["structuredContent"]
}

fn task(w: &World, key: &str) -> Value {
    ok(&call(
        w,
        "core",
        "atm_task_get",
        json!({"project": w.project, "task_key": key, "view": "full"}),
    ))
    .clone()
}

/// A3：省略 project 时按 session 推出，省略 op_id 时签发 `auto:`；别名记进 normalized；
/// R11 P2-2：有 task_key 就是任务进度。
#[test]
fn writes_fill_the_target_and_infer_the_scope() {
    let w = world("write-target");
    let r = call(
        &w,
        "core",
        "atm_progress_add",
        json!({"session": w.session, "key": w.task, "content": "做了一半", "percent": 50}),
    );
    let ack = ok(&r);
    assert_eq!(ack["project"], json!(w.project));
    assert_eq!(ack["session"], json!(w.session));
    assert!(ack["op_id"].as_str().unwrap().starts_with("auto:"), "{ack}");
    assert_eq!(ack["replayed"], json!(false));
    assert_eq!(
        ack["normalized"],
        json!([{"from": "content", "to": "summary"}, {"from": "key", "to": "task_key"}])
    );
    let types: Vec<&str> = ack["entities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["entity_type"].as_str().unwrap())
        .collect();
    assert_eq!(types, ["WORK_ITEM", "PROGRESS"], "{ack}");
    // 显式 op_id 原样用，重放回同一个回执。
    let args = json!({"session": w.session, "summary": "项目周报", "op_id": "p-1"});
    let first = ok(&call(&w, "core", "atm_progress_add", args.clone())).clone();
    let again = ok(&call(&w, "core", "atm_progress_add", args)).clone();
    assert_eq!(first["op_id"], json!("p-1"));
    assert_eq!(
        first["entities"][0]["entity_type"],
        json!("PROJECT_UPDATE"),
        "没有 task_key 是项目进度：{first}"
    );
    assert_eq!(again["replayed"], json!(true));
    // 两者都没有：先 begin。
    let e = err(&call(
        &w,
        "core",
        "atm_record",
        json!({"kind": "fact", "title": "t", "summary": "s"}),
    ))
    .clone();
    assert_eq!(e["code"], json!("SESSION_REQUIRED"));
    assert_eq!(e["committed"], json!(false));
}

/// R11 P1-4 第 5 条、P1-5、P2-4：depends_on / parent 写 key 或本批序号与 client_ref；默认 READY；回执带 refs。
#[test]
fn task_create_links_keys_and_batch_refs() {
    let w = world("write-create");
    let r = call(
        &w,
        "core",
        "atm_task_create",
        json!({"session": w.session, "items": [
            {"title": "甲", "client_ref": "a"},
            {"title": "乙", "depends_on": ["1", w.task], "parent": "a"},
            {"title": "丙", "depends_on": ["a", "2"], "status": "backlog",
             "checklist": [{"title": "第一步"}, {"title": "第二步"}]},
        ]}),
    );
    let ack = ok(&r);
    let refs = ack["refs"].as_object().unwrap();
    assert_eq!(refs.len(), 3, "{ack}");
    let (a, b, c) = (
        refs["a"].as_str().unwrap(),
        refs["2"].as_str().unwrap(),
        refs["3"].as_str().unwrap(),
    );
    assert_eq!(ack["checklist"][c].as_array().unwrap().len(), 2, "{ack}");
    let got = task(&w, b);
    assert_eq!(got["status"], json!("READY"));
    let rel: Vec<(String, String, String)> = got["relations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["type"].as_str().unwrap().to_owned(),
                r["direction"].as_str().unwrap().to_owned(),
                r["task_key"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    for want in [
        ("BLOCKS", "INCOMING", a),
        ("BLOCKS", "INCOMING", w.task.as_str()),
        ("PARENT", "OUTGOING", a),
    ] {
        assert!(
            rel.iter()
                .any(|(t, d, k)| (t.as_str(), d.as_str(), k.as_str()) == want),
            "{want:?} 不在 {rel:?}"
        );
    }
    let got = task(&w, c);
    assert_eq!(got["status"], json!("BACKLOG"));
    let deps: Vec<&str> = got["relations"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["type"] == "BLOCKS" && r["direction"] == "INCOMING")
        .map(|r| r["task_key"].as_str().unwrap())
        .collect();
    assert_eq!(deps.len(), 2, "{got}");
    assert!(deps.contains(&a) && deps.contains(&b), "{deps:?}");
}

/// U-1：给还没开工的任务记进度会先 start，回执的 auto_applied 写明；任务进入 IN_PROGRESS。
#[test]
fn progress_on_an_unstarted_task_reports_the_auto_start() {
    let w = world("write-progress-start");
    let ack = ok(&call(
        &w,
        "core",
        "atm_progress_add",
        json!({"session": w.session, "task_key": w.task, "summary": "接口设计完成，开始写实现"}),
    ))
    .clone();
    assert_eq!(
        ack["auto_applied"],
        json!([{"task_key": w.task, "operations": ["start"]}]),
        "{ack}"
    );
    assert_eq!(task(&w, &w.task)["status"], json!("IN_PROGRESS"));
    // 已经开工的不再补。
    let ack = ok(&call(
        &w,
        "core",
        "atm_progress_add",
        json!({"session": w.session, "task_key": w.task, "summary": "实现写了一半"}),
    ))
    .clone();
    assert!(ack.get("auto_applied").is_none(), "{ack}");
}

/// 单条写在顶层；complete 自动补 start（auto_applied）；安全合并的 merges 在 ACK 顶层（01 Q-04）。
#[test]
fn task_patch_flat_auto_start_and_top_level_merges() {
    let w = world("write-patch");
    let r = call(
        &w,
        "core",
        "atm_task_patch",
        json!({"session": w.session, "task_key": w.task, "operation": "complete",
               "note": "做完了", "evidence": ["cargo test 全绿"]}),
    );
    let ack = ok(&r);
    assert_eq!(
        ack["auto_applied"],
        json!([{"task_key": w.task, "operations": ["start"]}])
    );
    assert_eq!(task(&w, &w.task)["status"], json!("DONE"));
    assert!(ack.get("merges").is_none(), "{ack}");

    // 另一个任务：先改 description，再拿旧版本 + expected_fields 改 title → 安全合并。
    let created = ok(&call(
        &w,
        "core",
        "atm_task_create",
        json!({"session": w.session, "items": [{"title": "旧", "target_date": "2026-12-31"}]}),
    ))
    .clone();
    let k = created["refs"]["1"].as_str().unwrap().to_owned();
    ok(&call(
        &w,
        "core",
        "atm_task_patch",
        json!({"session": w.session, "task_key": k, "operation": "edit",
               "expected_version": 1, "description": "B 改的"}),
    ));
    let r = call(
        &w,
        "actions",
        "atm_task_patch",
        json!({"session": w.session, "items": [{"task_key": k, "op": "EDIT", "expected_version": 1,
               "title": "新", "expected_fields": {"title": "旧"}}]}),
    );
    let ack = ok(&r);
    assert_eq!(ack["merges"][0]["fields"], json!(["title"]), "{ack}");
    assert_eq!(
        ack["normalized"],
        json!([{"from": "items[0].op", "to": "items[0].operation"}])
    );
    let got = task(&w, &k);
    assert_eq!(
        (&got["title"], &got["description"]),
        (&json!("新"), &json!("B 改的"))
    );
    // nullable 字段的显式 null 是清空，不是省略。读视图不带 target_date：清空之后拿旧版本做安全合并，
    // 比较值 target_date:null 只有在真的清空了时才对得上（W-101）。
    let v = got["version"].clone();
    ok(&call(
        &w,
        "core",
        "atm_task_patch",
        json!({"session": w.session, "task_key": k, "operation": "edit",
               "expected_version": v, "target_date": null}),
    ));
    let merged = ok(&call(
        &w,
        "core",
        "atm_task_patch",
        json!({"session": w.session, "task_key": k, "operation": "edit", "expected_version": v,
               "title": "再新", "expected_fields": {"title": "新", "target_date": null}}),
    ))
    .clone();
    assert_eq!(merged["merges"][0]["fields"], json!(["title"]), "{merged}");
}

/// W-050：复合操作只能单条、takeover_stale 只能 false；operation 不收的字段要报出来，不能静默丢掉。
#[test]
fn task_patch_rejects_mixed_batches_and_stray_fields() {
    let w = world("write-patch-shape");
    let e = err(&call(
        &w,
        "core",
        "atm_task_patch",
        json!({"session": w.session, "items": [
            {"task_key": w.task, "operation": "start"},
            {"task_key": w.task, "operation": "verify_and_complete"},
        ]}),
    ))
    .clone();
    assert_eq!(e["code"], json!("INVALID_ARGUMENT"));
    let problems = &e["problems"];
    assert_eq!(problems[0]["path"], json!("items[1].operation"), "{e}");
    assert_eq!(problems[0]["problem"], json!("conflict"));
    let e = err(&call(
        &w,
        "core",
        "atm_task_patch",
        json!({"session": w.session, "task_key": w.task, "operation": "verify_and_complete",
               "takeover_stale": true}),
    ))
    .clone();
    assert_eq!(e["problems"][0]["path"], json!("takeover_stale"));
    let e = err(&call(
        &w,
        "core",
        "atm_task_patch",
        json!({"session": w.session, "task_key": w.task, "operation": "start",
               "blocked_reason": "等人"}),
    ))
    .clone();
    let p = &e["problems"][0];
    assert_eq!(
        (&p["path"], &p["problem"]),
        (&json!("blocked_reason"), &json!("unknown"))
    );
    assert!(
        p["allowed"]
            .as_array()
            .unwrap()
            .contains(&json!("task_key")),
        "{p}"
    );
    let e = err(&call(
        &w,
        "core",
        "atm_task_patch",
        json!({"session": w.session, "task_key": w.task, "operation": "block"}),
    ))
    .clone();
    assert_eq!(
        e["problems"][0],
        json!({"path": "blocked_reason", "problem": "missing"})
    );
    // 都没写进去。
    assert_eq!(task(&w, &w.task)["status"], json!("READY"));
}

/// `checklist`：一条走 single（序号、标题都能写），多条走 batch；旧名照收并给弃用提示（C-12）。
#[test]
fn checklist_dispatches_by_count_and_accepts_the_old_names() {
    let w = world("write-checklist");
    let created = ok(&call(
        &w,
        "core",
        "atm_task_create",
        json!({"session": w.session, "items": [{"title": "带检查项",
               "checklist": [{"title": "第一步"}, {"title": "第二步"}, {"title": "第三步"}]}]}),
    ))
    .clone();
    let k = created["refs"]["1"].as_str().unwrap().to_owned();
    let ids: Vec<String> = created["checklist"][&k]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    ok(&call(
        &w,
        "core",
        "atm_task_patch",
        json!({"session": w.session, "task_key": k, "operation": "claim", "expected_version": 1}),
    ));
    let one = ok(&call(
        &w,
        "core",
        "atm_task_patch",
        json!({"session": w.session, "task_key": k, "operation": "checklist",
               "checklist": [{"item": "1", "status": "done", "evidence": ["看过了"]}]}),
    ))
    .clone();
    let changed: Vec<&Value> = one["entities"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["entity_type"] == "CHECKLIST")
        .map(|e| &e["key"])
        .collect();
    assert_eq!(changed, [&json!(ids[0])], "序号 1 是第一项：{one}");
    let many = ok(&call(
        &w,
        "core",
        "atm_task_patch",
        json!({"session": w.session, "task_key": k, "operation": "checklist",
               "checklist": [{"item": "第二步", "status": "DOING"}, {"item": ids[2], "status": "SKIPPED"}]}),
    ))
    .clone();
    assert!(many.get("deprecations").is_none(), "{many}");
    let changed: Vec<&Value> = many["entities"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["entity_type"] == "CHECKLIST")
        .map(|e| &e["key"])
        .collect();
    assert_eq!(changed, [&json!(ids[1]), &json!(ids[2])], "{many}");
    let got = task(&w, &k);
    let statuses: Vec<&Value> = got["checklist"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| &c["status"])
        .collect();
    assert_eq!(
        statuses,
        [&json!("DONE"), &json!("DOING"), &json!("SKIPPED")]
    );
    // 2.x 的 checklist_single：expected_version 比的是检查项版本。
    let version = got["checklist"][0]["version"].as_i64().unwrap();
    let old = ok(&call(
        &w,
        "actions",
        "atm_task_patch",
        json!({"session": w.session, "items": [{"task_key": k, "operation": "checklist_single",
               "expected_version": version, "checklist_items": [{"id": ids[0], "status": "TODO"}]}]}),
    ))
    .clone();
    let fields: Vec<&Value> = old["deprecations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| &d["field"])
        .collect();
    assert_eq!(
        fields,
        [&json!("expected_version"), &json!("operation")],
        "{old}"
    );
    // 同名标题要求改用 id 或序号。
    let e = err(&call(
        &w,
        "core",
        "atm_task_patch",
        json!({"session": w.session, "task_key": k, "operation": "checklist",
               "checklist": [{"item": "没有这一步", "status": "DONE"}]}),
    ))
    .clone();
    assert_eq!(e["code"], json!("CHECKLIST_NOT_FOUND"), "{e}");
}

/// R11 P2-1：长 summary 截断后 ACK 带 adjusted；R11 P3：kind=ATM_FEEDBACK 落成本机反馈。
#[test]
fn record_adjusts_long_summaries_and_takes_feedback() {
    let w = world("write-record");
    let long = "很长的一句话。".repeat(60);
    let ack = ok(&call(
        &w,
        "core",
        "atm_record",
        json!({"session": w.session, "kind": "decision", "title": "定了", "summary": long}),
    ))
    .clone();
    assert_eq!(
        ack["adjusted"],
        json!([{"field": "summary", "action": "truncated", "moved_to": "detail"}])
    );
    let ack = ok(&call(
        &w,
        "core",
        "atm_record",
        json!({"session": w.session, "kind": "atm_feedback", "title": "搜不到", "summary": "atm_search 漏了中文词",
               "detail": "复现：搜「交接」"}),
    ))
    .clone();
    let key = ack["entities"][0]["key"].as_str().unwrap().to_owned();
    let found = ok(&call(
        &w,
        "memory",
        "atm_search",
        json!({"project": w.project, "query": key}),
    ))
    .clone();
    let text = found.to_string();
    assert!(text.contains("ATM_FEEDBACK"), "{text}");
    assert!(text.contains("RISK"), "{text}");
}

/// R11 P2-3：省略 outcome 时，持有未完成的领取就是 paused，否则 completed。
#[test]
fn end_defaults_the_outcome_from_open_claims() {
    let w = world("write-end");
    ok(&call(
        &w,
        "core",
        "atm_task_patch",
        json!({"session": w.session, "task_key": w.task, "operation": "start"}),
    ));
    let ack = ok(&call(
        &w,
        "core",
        "atm_end",
        json!({"session": w.session, "summary": "先到这里", "release_claims": false}),
    ))
    .clone();
    assert_eq!(ack["outcome"], json!("paused"));
    let begun = ok(&call(
        &w,
        "core",
        "atm_begin",
        json!({"agent_id": "codex", "project": w.project, "resume": false, "brief": "none"}),
    ))
    .clone();
    let s = begun["session"].as_str().unwrap().to_owned();
    let ack = ok(&call(
        &w,
        "core",
        "atm_end",
        json!({"session": s, "summary": "没领东西"}),
    ))
    .clone();
    assert_eq!(ack["outcome"], json!("completed"));
}

/// R11 A1：白名单客户端重复 begin 接回同一 session；非白名单客户端（一个进程多个对话）两次 begin 各得各的，
/// 省略 session 的写入报 SESSION_REQUIRED。
#[test]
fn a1_only_single_conversation_clients_share_a_session() {
    let w = world("write-a1");
    let cwd = w.dir.join("repo");
    std::fs::create_dir_all(&cwd).unwrap();
    let cwd = cwd.display().to_string();
    let begin = |client: &str| {
        ok(&call_as(
            &w,
            Some(client),
            "core",
            "atm_begin",
            json!({"agent_id": "claude-code", "cwd": cwd, "project": w.project, "brief": "none"}),
        ))
        .clone()
    };
    let first = begin(CLI);
    let again = begin(CLI);
    assert_eq!(again["session"], first["session"], "{again}");
    assert_eq!(again["outcome"], json!("CURRENT"));

    let one = begin(DESKTOP);
    let two = begin(DESKTOP);
    assert_ne!(one["session"], two["session"], "{two}");
    assert_ne!(one["session"], first["session"]);
    let e = err(&call_as(
        &w,
        Some(DESKTOP),
        "core",
        "atm_progress_add",
        json!({"project": w.project, "summary": "没带 session"}),
    ))
    .clone();
    assert_eq!(e["code"], json!("SESSION_REQUIRED"), "{e}");
}

/// 03 C-04：只能结束本连接组谱系里的 session；结束别人的要 User 强制关闭。
#[test]
fn c04_end_only_your_own_lineage() {
    let w = world("write-c04");
    let mine = ok(&call_as(
        &w,
        Some(CLI),
        "core",
        "atm_begin",
        json!({"agent_id": "claude-code", "project": w.project, "resume": false, "brief": "none"}),
    ))
    .clone();
    let s = mine["session"].as_str().unwrap().to_owned();
    let e = err(&call_as(
        &w,
        Some(DESKTOP),
        "core",
        "atm_end",
        json!({"session": s, "summary": "踢掉它"}),
    ))
    .clone();
    assert_eq!(e["code"], json!("USER_AUTHORIZATION_REQUIRED"), "{e}");
    assert_eq!(e["committed"], json!(false));
    // 不带身份的直连客户端同样不是这个连接组。
    let e = err(&call(
        &w,
        "core",
        "atm_end",
        json!({"session": s, "summary": "踢掉它"}),
    ))
    .clone();
    assert_eq!(e["code"], json!("USER_AUTHORIZATION_REQUIRED"), "{e}");
    let ack = ok(&call_as(
        &w,
        Some(CLI),
        "core",
        "atm_end",
        json!({"session": s, "summary": "自己结束"}),
    ))
    .clone();
    assert_eq!(ack["session"], json!(s));
}

/// 03 P-001：`session:"USER"` 不能把 Agent 变成 User，写入被拒且没有落库。
#[test]
fn p001_session_user_is_not_a_principal() {
    let w = world("write-p001");
    for args in [
        json!({"session": "USER", "kind": "fact", "title": "冒充", "summary": "x"}),
        json!({"project": w.project, "session": "USER", "kind": "fact", "title": "冒充", "summary": "x"}),
    ] {
        let e = err(&call(&w, "core", "atm_record", args)).clone();
        assert_eq!(e["code"], json!("SESSION_NOT_FOUND"), "{e}");
    }
    let listed = ok(&call(
        &w,
        "memory",
        "atm_search",
        json!({"project": w.project, "list": "records"}),
    ))
    .clone();
    assert!(!listed.to_string().contains("冒充"), "{listed}");
}

/// C-L03：begin 建项目之后写 marker 与 git exclude，回执报告 marker_written。
#[test]
fn begin_writes_the_marker_after_commit() {
    let w = world("write-marker");
    let cwd = w.dir.join("fresh");
    std::fs::create_dir_all(&cwd).unwrap();
    let r = ok(&call(
        &w,
        "core",
        "atm_begin",
        json!({"agent_id": "codex", "cwd": cwd.display().to_string(), "allow_project_create": true,
               "title": "新仓库", "brief": "minimal"}),
    ))
    .clone();
    assert_eq!(r["project_created"], json!(true), "{r}");
    assert_eq!(r["marker_written"], json!(true));
    let marker: Value = serde_json::from_str(
        &std::fs::read_to_string(cwd.join(".ayanami-task").join("project.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(marker["project_code"], r["project"]);
    // 再从同一目录 begin：按 marker / 路径认出同一个项目。
    let again = ok(&call(
        &w,
        "core",
        "atm_begin",
        json!({"agent_id": "codex", "cwd": cwd.display().to_string(), "brief": "none"}),
    ))
    .clone();
    assert_eq!(again["project"], r["project"]);
    assert!(again.get("marker_written").is_none(), "{again}");
}

/// C-L03 反例：marker 写不成（目录里已有同名文件挡着），项目照样建成，回执如实报告 `marker_written: false`；
/// 挡路的文件原样不动。
#[test]
fn c_l03_begin_reports_a_marker_it_could_not_write() {
    let w = world("write-marker-blocked");
    let cwd = w.dir.join("blocked");
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::write(cwd.join(".ayanami-task"), "not a directory").unwrap();
    let r = ok(&call(
        &w,
        "core",
        "atm_begin",
        json!({"agent_id": "codex", "cwd": cwd.display().to_string(), "allow_project_create": true,
               "title": "挡住的仓库", "brief": "minimal"}),
    ))
    .clone();
    assert_eq!(r["project_created"], json!(true), "{r}");
    assert_eq!(r["marker_written"], json!(false), "{r}");
    assert_eq!(
        std::fs::read_to_string(cwd.join(".ayanami-task")).unwrap(),
        "not a directory"
    );
    // 项目确实建成了：再从同一目录 begin，按路径认出同一个项目。
    let again = ok(&call(
        &w,
        "core",
        "atm_begin",
        json!({"agent_id": "codex", "cwd": cwd.display().to_string(), "brief": "none"}),
    ))
    .clone();
    assert_eq!(again["project"], r["project"], "{again}");
}

/// knowledge_save：作者取自 session，回执带 op_id、project、session。
#[test]
fn knowledge_save_reports_the_receipt() {
    let w = world("write-knowledge");
    let ack = ok(&call(
        &w,
        "memory",
        "atm_knowledge_save",
        json!({"session": w.session, "slug": "rust-heredoc", "title": "heredoc 吞反斜杠",
               "summary": "写 Windows 路径用文件工具", "body": "正文"}),
    ))
    .clone();
    assert!(ack["op_id"].as_str().unwrap().starts_with("auto:"), "{ack}");
    assert_eq!(
        (&ack["project"], &ack["session"]),
        (&json!(w.project), &json!(w.session))
    );
    let e = err(&call(
        &w,
        "memory",
        "atm_knowledge_save",
        json!({"project": w.project, "slug": "x", "title": "x", "summary": "x", "body_markdown": "x"}),
    ))
    .clone();
    assert_eq!(e["code"], json!("SESSION_REQUIRED"));
}

/// review_request / review_submit：candidate_hashes 是 `{名称: 哈希}`，verdict 不分大小写，evidence 只能是对象。
#[test]
fn review_request_and_submit_map_their_fields() {
    let w = world("write-review");
    let created = ok(&call(
        &w,
        "core",
        "atm_task_create",
        json!({"session": w.session, "items": [
            {"title": "被审任务", "checklist": [{"title": "独立评审"}]},
            {"title": "评审", "type": "review", "parent": "1"},
        ]}),
    ))
    .clone();
    let parent = created["refs"]["1"].as_str().unwrap().to_owned();
    let review = created["refs"]["2"].as_str().unwrap().to_owned();
    let checklist = created["checklist"][&parent][0]
        .as_str()
        .unwrap()
        .to_owned();
    let asked = ok(&call(
        &w,
        "core",
        "atm_task_patch",
        json!({"session": w.session, "task_key": review, "operation": "review_request", "expected_version": 1,
               "parent_checklist_id": checklist, "expected_parent_checklist_version": 0,
               "candidate_hashes": {"Source": " ABCDEF1 "}}),
    ))
    .clone();
    let request = asked["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["entity_type"] == "REVIEW_REQUEST")
        .and_then(|e| e["key"].as_str())
        .unwrap()
        .to_owned();
    let reviewer = ok(&call(
        &w,
        "core",
        "atm_begin",
        json!({"agent_id": "codex", "project": w.project, "role": "reviewer", "resume": false, "brief": "none"}),
    ))["session"]
        .as_str()
        .unwrap()
        .to_owned();
    ok(&call(
        &w,
        "core",
        "atm_task_patch",
        json!({"session": reviewer, "task_key": review, "operation": "start", "expected_version": 1}),
    ));
    let e = err(&call(
        &w,
        "core",
        "atm_task_patch",
        json!({"session": reviewer, "task_key": review, "operation": "review_submit", "expected_version": 2,
               "request_key": request, "verdict": "approved", "candidate_hashes": ["abcdef1"],
               "evidence": [{"kind": "test_result", "value": "评审通过"}]}),
    ))
    .clone();
    assert_eq!(e["problems"][0]["path"], json!("candidate_hashes"), "{e}");
    let done = ok(&call(
        &w,
        "core",
        "atm_task_patch",
        json!({"session": reviewer, "task_key": review, "operation": "review_submit", "expected_version": 2,
               "request_key": request, "verdict": "approved", "candidate_hashes": {"source": "abcdef1"},
               "evidence": [{"kind": "test_result", "value": "评审通过"}]}),
    ))
    .clone();
    let types: Vec<&str> = done["entities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["entity_type"].as_str().unwrap())
        .collect();
    assert!(types.contains(&"REVIEW_SUBMISSION"), "{done}");
    let got = task(&w, &parent);
    assert_eq!(got["checklist"][0]["status"], json!("DONE"), "{got}");
}

/// 写入之后按 session 的 cwd 重新观察 git（02 S-022、X-05；00 C-03）：进度、complete、end 之后刷新；
/// start 不刷新；同一 op_id 的重放不刷新。
#[test]
fn writes_refresh_the_git_context_but_replays_do_not() {
    let w = world("write-git-refresh");
    let repo = w.dir.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let git = |args: &[&str]| {
        let out = std::process::Command::new("git")
            .args([
                "-c",
                "user.name=atm",
                "-c",
                "user.email=atm@example.invalid",
            ])
            .args(["-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"])
            .args(args)
            .current_dir(&repo)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {out:?}");
    };
    git(&["init", "-q", "-b", "main"]);
    git(&["commit", "-q", "--allow-empty", "-m", "first"]);
    let begun = ok(&call_as(
        &w,
        Some(CLI),
        "core",
        "atm_begin",
        json!({"agent_id": "claude-code", "cwd": repo.display().to_string(), "project": w.project}),
    ))
    .clone();
    let session = begun["session"]
        .as_str()
        .or(begun["session"]["id"].as_str())
        .unwrap()
        .to_owned();
    let branch = || -> Option<String> {
        let s = session.clone();
        w.svc
            .store()
            .read(move |tx| {
                tx.query_row(
                    "SELECT git_branch FROM agent_sessions WHERE id = ?1",
                    [&s],
                    |r| r.get(0),
                )
            })
            .unwrap()
    };
    assert_eq!(branch().as_deref(), Some("main"));

    git(&["checkout", "-q", "-b", "feature"]);
    ok(&call_as(
        &w,
        Some(CLI),
        "core",
        "atm_task_patch",
        json!({"session": session, "task_key": w.task, "operation": "start"}),
    ));
    assert_eq!(branch().as_deref(), Some("main"), "start 不刷新");
    let progress =
        json!({"session": session, "task_key": w.task, "summary": "换了分支", "op_id": "git-p1"});
    ok(&call_as(
        &w,
        Some(CLI),
        "core",
        "atm_progress_add",
        progress.clone(),
    ));
    assert_eq!(branch().as_deref(), Some("feature"), "进度之后刷新");

    git(&["checkout", "-q", "-b", "other"]);
    let replay = ok(&call_as(
        &w,
        Some(CLI),
        "core",
        "atm_progress_add",
        progress,
    ))
    .clone();
    assert_eq!(replay["replayed"], json!(true), "{replay}");
    assert_eq!(branch().as_deref(), Some("feature"), "重放不刷新");
    ok(&call_as(
        &w,
        Some(CLI),
        "core",
        "atm_task_patch",
        json!({"session": session, "task_key": w.task, "operation": "complete", "evidence": ["测试"]}),
    ));
    assert_eq!(branch().as_deref(), Some("other"), "complete 之后刷新");

    git(&["checkout", "-q", "-b", "last"]);
    ok(&call_as(
        &w,
        Some(CLI),
        "core",
        "atm_end",
        json!({"session": session, "summary": "完成"}),
    ));
    assert_eq!(branch().as_deref(), Some("last"), "end 之后刷新");
}

/// begin 遇到垃圾箱里的项目：恢复请求已经在这次 begin 的事务里登记并提交，信封如实报 committed:true、
/// retryable:false（peer W4 r1 P1-05），与库里的实际状态一致。
#[test]
fn begin_on_a_trashed_project_reports_the_committed_restore_request() {
    let w = world("write-trashed-begin");
    let user = atm_domain::principal::Principal::trusted_ui(atm_domain::principal::UiSurface::Tray);
    w.svc
        .set_lifecycle(
            &user,
            &w.project,
            atm_service::project::Transition::Trash,
            "trash-for-begin",
        )
        .unwrap();
    let requests = || -> i64 {
        w.svc
            .store()
            .read(|tx| {
                tx.query_row("SELECT count(*) FROM project_restore_requests", [], |r| {
                    r.get(0)
                })
            })
            .unwrap()
    };
    assert_eq!(requests(), 0);
    let r = call(
        &w,
        "core",
        "atm_begin",
        json!({"agent_id": "codex", "project": w.project, "op_id": "begin-trashed"}),
    );
    let e = err(&r);
    assert_eq!(
        (&e["code"], &e["committed"], &e["retryable"]),
        (
            &json!("PROJECT_DB_UNAVAILABLE"),
            &json!(true),
            &json!(false)
        ),
        "{e}"
    );
    assert_eq!(requests(), 1, "恢复请求确实落库了：{e}");
    atm_http::fix::check(e).unwrap();
}

/// 写入提交之后的读（ACK、知识回执展开）失败了：信封如实报 committed:true，出路保持原操作身份——项目内
/// 写入按 op_id 回查，知识写入是同一 op_id 的重放；照出路走不会再写一笔（peer W4 r1 P1-05、r2 P1-01）。
/// 新写入与重放、自动与显式 op_id 都过一遍，并对照库里的实际行数。故障由服务的测试钩子注入。
#[test]
fn reads_after_a_commit_that_fail_still_say_committed() {
    let w = world("write-after-commit-read");
    let failing = std::sync::Arc::new(std::sync::Mutex::new(None::<&'static str>));
    let at = failing.clone();
    w.svc
        .set_after_commit_read_fault(Some(std::sync::Arc::new(move |site: &str| {
            (*at.lock().unwrap() == Some(site)).then(|| {
                atm_domain::error::DomainError::new(
                    atm_domain::error::ErrorCode::STORE_BUSY,
                    "注入：提交之后的读繁忙",
                )
            })
        })));
    let fail_at = |site: Option<&'static str>| *failing.lock().unwrap() = site;
    let count = |sql: &str| -> i64 {
        let sql = sql.to_owned();
        w.svc
            .store()
            .read(move |tx| tx.query_row(&sql, [], |r| r.get(0)))
            .unwrap()
    };
    let committed = |r: &Value| -> Value {
        let e = err(r).clone();
        assert_eq!(
            (&e["committed"], &e["code"]),
            (&json!(true), &json!("STORE_BUSY")),
            "{e}"
        );
        atm_http::fix::check(&e).unwrap();
        e
    };

    // 项目内的写入，自动 op_id：回查的就是签发的那个 op_id。
    fail_at(Some("mutation.ack"));
    let record = |op: Option<&str>, title: &str| {
        let mut a = json!({"session": w.session, "kind": "FACT", "title": title, "summary": "s"});
        if let Some(op) = op {
            a["op_id"] = json!(op);
        }
        call(&w, "core", "atm_record", a)
    };
    let e = committed(&record(None, "after-commit-auto"));
    assert_eq!(e["fix"]["kind"], json!("reread"), "{e}");
    let op = e["fix"]["call"]["arguments"]["op_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(op.starts_with("auto:"), "{e}");
    assert_eq!(
        count("SELECT count(*) FROM records WHERE title = 'after-commit-auto'"),
        1
    );
    // 显式 op_id：新写入与重放都报已提交，库里只有一笔。
    for _ in 0..2 {
        let e = committed(&record(Some("rec-explicit"), "after-commit-explicit"));
        assert_eq!(
            e["fix"]["call"]["arguments"]["op_id"],
            json!("rec-explicit"),
            "{e}"
        );
    }
    assert_eq!(
        count("SELECT count(*) FROM records WHERE title = 'after-commit-explicit'"),
        1
    );
    fail_at(None);
    let found = call(
        &w,
        "memory",
        e["fix"]["call"]["name"].as_str().unwrap(),
        e["fix"]["call"]["arguments"].clone(),
    );
    assert_ne!(found["isError"], json!(true), "照出路回查：{found}");
    assert!(
        found.to_string().contains(&op),
        "回查到的就是那次写入：{found}"
    );

    // 知识写入，自动 op_id：出路是带着签发的 op_id 与 session 的同一调用，照做就是重放。
    fail_at(Some("knowledge.result"));
    let save = |op: Option<&str>, slug: &str| {
        let mut a = json!({"session": w.session, "slug": slug, "title": "t", "summary": "s", "body_markdown": "b"});
        if let Some(op) = op {
            a["op_id"] = json!(op);
        }
        call(&w, "memory", "atm_knowledge_save", a)
    };
    let e = committed(&save(None, "after-commit-auto"));
    let retry = e["fix"]["call"].clone();
    assert_eq!(
        (
            &e["fix"]["kind"],
            &retry["name"],
            &retry["arguments"]["session"]
        ),
        (
            &json!("call"),
            &json!("atm_knowledge_save"),
            &json!(w.session)
        ),
        "{e}"
    );
    assert!(
        retry["arguments"]["op_id"]
            .as_str()
            .unwrap()
            .starts_with("auto:"),
        "{e}"
    );
    let revisions = || count("SELECT count(*) FROM knowledge_revisions");
    assert_eq!(revisions(), 1);
    // 显式 op_id：新写入与重放都报已提交。
    for _ in 0..2 {
        let e = committed(&save(Some("k-explicit"), "after-commit-explicit"));
        assert_eq!(
            e["fix"]["call"]["arguments"]["op_id"],
            json!("k-explicit"),
            "{e}"
        );
    }
    assert_eq!(revisions(), 2);
    fail_at(None);
    let replayed = call(
        &w,
        "memory",
        "atm_knowledge_save",
        retry["arguments"].clone(),
    );
    assert_eq!(
        ok(&replayed)["replayed"],
        json!(true),
        "照出路重发是重放：{replayed}"
    );
    assert_eq!(revisions(), 2, "重放不该再写一笔");
}
