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
        json!({"session": w.session, "slug": "w4f"}),
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
