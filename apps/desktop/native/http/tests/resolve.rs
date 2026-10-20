//! W4f：`POST /mcp/resolve` 与写工具上的 expected_target（10 R11 A3）。

mod support;

use serde_json::{Value, json};
use support::*;

/// 整库每张表的全部行（判定 resolve 零写入）。
fn snapshot(w: &World) -> Vec<(String, Vec<String>)> {
    w.svc
        .store()
        .read(|tx| {
            let names: Vec<String> = tx
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            let mut out = Vec::new();
            for name in names {
                let mut stmt = tx.prepare(&format!("SELECT * FROM \"{name}\""))?;
                let cols = stmt.column_count();
                let rows = stmt
                    .query_map([], |r| {
                        (0..cols)
                            .map(|i| r.get::<_, rusqlite::types::Value>(i).map(|v| format!("{v:?}")))
                            .collect::<rusqlite::Result<Vec<_>>>()
                            .map(|v| v.join("|"))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                out.push((name, rows));
            }
            Ok::<_, rusqlite::Error>(out)
        })
        .unwrap()
}

fn resolve(w: &World, client: Option<&str>, tool: &str, args: Value) -> (u16, Value) {
    let body = json!({"tool": tool, "arguments": args}).to_string();
    let (status, text) = http_as(w.port, client, "POST", "/mcp/resolve", &body);
    (status, serde_json::from_str(&text).unwrap_or(Value::Null))
}

fn error(r: &Value) -> &Value {
    assert_eq!(r["isError"], json!(true), "{r}");
    &r["structuredContent"]
}

const CLAUDE: &str = "4242:1700000000@claude-code";
const DESKTOP: &str = "4343:1700000000@claude-ai";

/// resolve 只读：判定 session 与目标，失败也不留下任何东西；只读工具不需要 resolve。
#[test]
fn resolve_reads_one_snapshot_and_writes_nothing() {
    let w = world("w4f-http-resolve");
    let before = snapshot(&w);
    let (status, r) = resolve(
        &w,
        None,
        "atm_begin",
        json!({"agent_id": "claude-code", "project": w.project}),
    );
    assert_eq!(status, 200, "{r}");
    assert_eq!(r["operation"], json!("session.recover-or-begin"));
    assert_eq!(r["expected_target"]["kind"], json!("EXISTING"));
    assert_eq!(r["expected_target"]["scope"]["id"], json!(w.project_id));
    assert_eq!(r["session"], Value::Null);
    // 没匹配到、允许建：只判定会创建，什么都不建。
    let fresh = w.dir.join("fresh-repo");
    std::fs::create_dir_all(&fresh).unwrap();
    let (_, r) = resolve(
        &w,
        None,
        "atm_begin",
        json!({"agent_id": "claude-code", "cwd": fresh.to_str().unwrap(), "allow_project_create": true}),
    );
    assert_eq!(r["expected_target"], json!({"kind": "CREATE"}), "{r}");
    let (_, r) = resolve(
        &w,
        None,
        "atm_task_patch",
        json!({"session_id": w.session, "task_key": w.task, "operation": "start"}),
    );
    assert_eq!(
        (
            &r["operation"],
            &r["project"],
            &r["session"],
            &r["session_defaulted"]
        ),
        (
            &json!("work.patch.batch"),
            &json!(w.project),
            &json!(w.session),
            &json!(false)
        ),
        "{r}"
    );
    let (_, r) = resolve(
        &w,
        None,
        "atm_progress_add",
        json!({"session": w.session, "summary": "x"}),
    );
    assert_eq!(r["operation"], json!("project-update.publish"));
    // 非白名单客户端缺 session：SESSION_REQUIRED，fix 补 session 参数。
    let (status, e) = resolve(
        &w,
        Some(DESKTOP),
        "atm_progress_add",
        json!({"task_key": w.task, "summary": "x"}),
    );
    assert_eq!(
        (status, &e["code"]),
        (422, &json!("SESSION_REQUIRED")),
        "{e}"
    );
    assert_eq!(
        (&e["fix"]["kind"], &e["fix"]["param"]),
        (&json!("add_param"), &json!("session")),
        "{e}"
    );
    let (status, e) = resolve(&w, None, "atm_task_get", json!({"task_key": w.task}));
    assert_eq!(
        (status, &e["code"]),
        (400, &json!("INVALID_ARGUMENT")),
        "{e}"
    );
    let (status, e) = resolve(&w, None, "atm_nothing", json!({}));
    assert_eq!(
        (status, &e["code"]),
        (400, &json!("INVALID_ARGUMENT")),
        "{e}"
    );
    let (_, e) = resolve(
        &w,
        None,
        "atm_task_patch",
        json!({"session": "NO-SUCH", "task_key": w.task, "operation": "start"}),
    );
    assert_eq!(e["code"], json!("SESSION_NOT_FOUND"), "{e}");
    assert_eq!(snapshot(&w), before, "resolve 写了东西");

    // 白名单客户端：begin 之后 resolve 补上它的默认 session。
    let begun = call_as(
        &w,
        Some(CLAUDE),
        "core",
        "atm_begin",
        json!({"agent_id": "claude-code", "project": w.project, "op_id": "begin-claude"}),
    );
    let session = begun["structuredContent"]["session"].clone();
    assert!(session.is_string(), "{begun}");
    let (_, r) = resolve(
        &w,
        Some(CLAUDE),
        "atm_progress_add",
        json!({"task_key": w.task, "summary": "x"}),
    );
    assert_eq!(
        (&r["session"], &r["session_defaulted"]),
        (&session, &json!(true)),
        "{r}"
    );

    // 要项目的读同样补默认 session（U-1：W4 里 task_get 拿检查项 id）；memory 上的按列表搜索也一样。
    let got = call_as(
        &w,
        Some(CLAUDE),
        "core",
        "atm_task_get",
        json!({"task_key": w.task}),
    );
    assert_eq!(got["structuredContent"]["key"], json!(w.task), "{got}");
    let listed = call_as(
        &w,
        Some(CLAUDE),
        "memory",
        "atm_search",
        json!({"list": "records"}),
    );
    assert_ne!(listed["isError"], json!(true), "{listed}");
    // atm_delta 不在 tools/list 里，但旧名可调用；照 2.x 恢复流程不带 session 调它也一样。
    let delta = call_as(&w, Some(CLAUDE), "memory", "atm_delta", json!({}));
    assert_ne!(delta["isError"], json!(true), "{delta}");
    // 全文搜索不补：补了 session 会被当成 op_id 回查的参数拒掉。
    let found = call_as(
        &w,
        Some(CLAUDE),
        "memory",
        "atm_search",
        json!({"query": "登录"}),
    );
    assert_ne!(found["isError"], json!(true), "{found}");
    // 非白名单客户端照旧要 session。
    let refused = call_as(
        &w,
        Some(DESKTOP),
        "core",
        "atm_task_get",
        json!({"task_key": w.task}),
    );
    assert_eq!(
        refused["structuredContent"]["code"],
        json!("SESSION_REQUIRED"),
        "{refused}"
    );
}

/// 写工具带上 resolve 的结果：目标一致就执行；scope 不一致是 TARGET_CHANGED（fix 是不带上下文的原调用）；
/// 世代变了是 SCOPE_RESTORED；显式的 expected_scope_generation 优先；形状不对是参数错误。
#[test]
fn writes_carry_the_resolved_target() {
    let w = world("w4f-http-target");
    let (_, r) = resolve(
        &w,
        None,
        "atm_progress_add",
        json!({"session": w.session, "task_key": w.task, "summary": "开工"}),
    );
    let target = r["expected_target"].clone();
    let generation = target["generation"].as_i64().unwrap();
    let ok = call(
        &w,
        "core",
        "atm_progress_add",
        json!({"session": w.session, "task_key": w.task, "summary": "开工", "expected_target": target}),
    );
    assert_ne!(ok["isError"], json!(true), "{ok}");

    let elsewhere = json!({"kind": "EXISTING", "scope": {"kind": "PROJECT", "id": "OTHER"}, "generation": generation});
    let r = call(
        &w,
        "core",
        "atm_progress_add",
        json!({"session": w.session, "task_key": w.task, "summary": "x", "op_id": "auto:01TEST", "expected_target": elsewhere}),
    );
    let e = error(&r);
    assert_eq!(e["code"], json!("TARGET_CHANGED"), "{e}");
    assert_eq!(e["fix"]["kind"], json!("call"));
    let again = e["fix"]["call"]["arguments"].as_object().unwrap();
    assert!(
        !again.contains_key("expected_target") && !again.contains_key("op_id"),
        "{e}"
    );

    let stale = json!({"kind": "EXISTING", "scope": {"kind": "PROJECT", "id": w.project_id}, "generation": generation + 100});
    let r = call(
        &w,
        "core",
        "atm_progress_add",
        json!({"session": w.session, "task_key": w.task, "summary": "x", "expected_target": stale}),
    );
    assert_eq!(error(&r)["code"], json!("SCOPE_RESTORED"), "{r}");
    let r = call(
        &w,
        "core",
        "atm_progress_add",
        json!({"session": w.session, "task_key": w.task, "summary": "x", "expected_target": stale, "expected_scope_generation": generation}),
    );
    assert_ne!(
        r["isError"],
        json!(true),
        "显式的 expected_scope_generation 优先：{r}"
    );

    for bad in [
        json!({"kind": "SOMEWHERE"}),
        json!("EXISTING"),
        json!({"kind": "NONE", "extra": 1}),
    ] {
        let r = call(
            &w,
            "core",
            "atm_record",
            json!({"session": w.session, "kind": "FACT", "title": "t", "summary": "s", "expected_target": bad}),
        );
        let e = error(&r);
        assert_eq!(e["code"], json!("INVALID_ARGUMENT"), "{e}");
        assert_eq!(e["problems"][0]["path"], json!("expected_target"), "{e}");
    }

    // begin：resolve 的 EXISTING 照常开会话；别的项目是 TARGET_CHANGED，不开会话。
    let (_, r) = resolve(
        &w,
        None,
        "atm_begin",
        json!({"agent_id": "codex", "project": w.project}),
    );
    let begun = call(
        &w,
        "core",
        "atm_begin",
        json!({"agent_id": "codex", "project": w.project, "op_id": "b-ok", "expected_target": r["expected_target"]}),
    );
    assert_ne!(begun["isError"], json!(true), "{begun}");
    let r = call(
        &w,
        "core",
        "atm_begin",
        json!({"agent_id": "codex", "project": w.project, "op_id": "b-moved", "expected_target": elsewhere}),
    );
    assert_eq!(error(&r)["code"], json!("TARGET_CHANGED"), "{r}");

    // 知识写入的目标是知识库：项目目标是 TARGET_CHANGED。
    let r = call(
        &w,
        "memory",
        "atm_knowledge_save",
        json!({"session": w.session, "slug": "w4f", "title": "t", "summary": "s", "body_markdown": "b",
               "expected_target": {"kind": "EXISTING", "scope": {"kind": "PROJECT", "id": w.project_id}, "generation": generation}}),
    );
    assert_eq!(error(&r)["code"], json!("TARGET_CHANGED"), "{r}");
    let (_, k) = resolve(
        &w,
        None,
        "atm_knowledge_save",
        json!({"session": w.session, "slug": "w4f", "title": "t", "summary": "s", "body_markdown": "b"}),
    );
    assert_eq!(
        k["expected_target"]["scope"]["kind"],
        json!("KNOWLEDGE"),
        "{k}"
    );
    let r = call(
        &w,
        "memory",
        "atm_knowledge_save",
        json!({"session": w.session, "slug": "w4f", "title": "t", "summary": "s", "body_markdown": "b",
               "expected_target": k["expected_target"]}),
    );
    assert_ne!(r["isError"], json!(true), "{r}");
}

/// 知识写入的 expected_target 连知识库身份一起核对（peer W4 r1 P1-01）：同为 KNOWLEDGE 但 database_id 不对是
/// TARGET_CHANGED 且零写入；身份对、世代不对是 SCOPE_RESTORED；resolve 时还没有身份（空 id）只对建身份的那次
/// 写入成立；重放先于核对，照样拿回原回执。
#[test]
fn knowledge_save_checks_the_knowledge_base_identity() {
    let w = world("w4-r1-p1-01");
    let save = |op: &str, slug: &str, target: &Value| {
        call(
            &w,
            "memory",
            "atm_knowledge_save",
            json!({"session": w.session, "op_id": op, "slug": slug, "title": "t", "summary": "s",
                   "body_markdown": "b", "expected_target": target}),
        )
    };
    // 首次创建：resolve 看到的知识库还没有身份。
    let (_, k) = resolve(
        &w,
        None,
        "atm_knowledge_save",
        json!({"session": w.session, "slug": "first", "title": "t", "summary": "s", "body_markdown": "b"}),
    );
    let blank = k["expected_target"].clone();
    assert_eq!(
        (&blank["scope"]["id"], &blank["generation"]),
        (&json!(""), &Value::Null),
        "{k}"
    );
    let first = save("k-first", "first", &blank);
    assert_ne!(first["isError"], json!(true), "{first}");

    // 重放：同一 op_id、同一（如今已过时的）空 id，先裁决重放，拿回原回执。
    let again = save("k-first", "first", &blank);
    assert_ne!(again["isError"], json!(true), "{again}");
    assert_eq!(
        again["structuredContent"]["replayed"],
        json!(true),
        "{again}"
    );
    assert_eq!(
        again["structuredContent"]["revisionId"], first["structuredContent"]["revisionId"],
        "{again}"
    );

    // 身份已经建好之后，空 id 的新写入是落点变了。
    let before = snapshot(&w);
    let r = save("k-blank", "blank", &blank);
    let e = error(&r);
    assert_eq!(e["code"], json!("TARGET_CHANGED"), "{e}");
    assert_eq!(snapshot(&w), before, "空 id 的新写入不该留下任何东西");

    let (_, k) = resolve(
        &w,
        None,
        "atm_knowledge_save",
        json!({"session": w.session, "slug": "second", "title": "t", "summary": "s", "body_markdown": "b"}),
    );
    let real = k["expected_target"].clone();
    let id = real["scope"]["id"].as_str().unwrap().to_owned();
    assert!(!id.is_empty(), "{k}");

    // 同为 KNOWLEDGE、database_id 不对。
    let mut wrong = real.clone();
    wrong["scope"]["id"] = json!(format!("{id}X"));
    let r = save("k-wrong-id", "wrong", &wrong);
    let e = error(&r);
    assert_eq!(e["code"], json!("TARGET_CHANGED"), "{e}");
    assert_eq!(
        e["details"]["current_target"]["scope"]["id"],
        json!(id),
        "{e}"
    );
    assert_eq!(snapshot(&w), before, "错 id 的写入不该留下任何东西");

    // 身份对、世代不对。
    let mut stale = real.clone();
    stale["generation"] = json!(real["generation"].as_i64().unwrap() + 1000);
    let r = save("k-stale", "stale", &stale);
    assert_eq!(error(&r)["code"], json!("SCOPE_RESTORED"), "{r}");
    assert_eq!(snapshot(&w), before, "世代不对的写入不该留下任何东西");

    // 对照：身份、世代都对。
    let r = save("k-ok", "second", &real);
    assert_ne!(r["isError"], json!(true), "{r}");
}

/// 工具入口与桥对「给没给」同一个判断（peer W4 r1 P1-02）：空白的 op_id、session、project 视同省略，
/// 不会拿空白当操作身份；resolve 应答里的 arguments 就是这份规范化结果。
#[test]
fn blank_identity_fields_are_absent_at_every_entry() {
    let w = world("w4-r1-p1-02");
    let r = call(
        &w,
        "core",
        "atm_record",
        json!({"session": w.session, "project": " ", "op_id": "  ", "kind": "FACT", "title": "t", "summary": "s"}),
    );
    assert_ne!(r["isError"], json!(true), "{r}");
    let op = r["structuredContent"]["op_id"].as_str().unwrap();
    assert!(op.starts_with("auto:"), "空白 op_id 被当成了操作身份：{r}");

    let (status, k) = resolve(
        &w,
        None,
        "atm_record",
        json!({"Session_Id": w.session, "op_id": 7, "project": "", "kind": "fact", "title": "t", "summary": "s"}),
    );
    assert_eq!(status, 200, "{k}");
    assert_eq!(
        k["arguments"],
        json!({"session": w.session, "op_id": "7", "kind": "FACT", "title": "t", "summary": "s"}),
        "{k}"
    );
    // 无法解释的值：resolve 就拒绝，与 tools/call 同一个信封。
    let (status, e) = resolve(
        &w,
        None,
        "atm_record",
        json!({"session": w.session, "op_id": false, "kind": "FACT", "title": "t", "summary": "s"}),
    );
    assert_eq!(
        (status, &e["code"], &e["problems"][0]["path"]),
        (400, &json!("INVALID_ARGUMENT"), &json!("op_id")),
        "{e}"
    );
    // 布尔字符串：resolve 判的分支与正式调用一致。
    let fresh = w.dir.join("p1-02-fresh");
    std::fs::create_dir_all(&fresh).unwrap();
    let (_, b) = resolve(
        &w,
        None,
        "atm_begin",
        json!({"agent_id": "a", "cwd": fresh.to_str().unwrap(), "allow_project_create": "TRUE"}),
    );
    assert_eq!(b["expected_target"], json!({"kind": "CREATE"}), "{b}");
}
