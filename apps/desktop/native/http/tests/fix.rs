//! W4e 统一错误信封与 fix 生成器（11 §3；§5 U-3、U-4；R11 A3 的 add_param）。
//!
//! - U-4 静态：`ErrorCode::ALL` 里每个码都登记了生成器，不重复；`none` 只给 INTERNAL_ERROR；
//! - U-4 全码扫：每个码在几种上下文下给出的信封都过 [`atm_http::fix::check`]（包括推不出 agent_id 的上下文）；
//! - U-4 动态：夹具里所有工具调用出错时都过同一个检查（`support::call_as`）；
//! - U-3：猜错语料，每条要么规范化后直接成功，要么照 `fix.call` 执行一次就成功。

mod support;

use atm_domain::error::{Committed, DomainError, ErrorCode};
use atm_domain::principal::Principal;
use atm_http::fix::{self, Ctx, GENERATORS};
use atm_http::tools::{self, PROFILES};
use serde_json::{Map, Value, json};
use support::*;

/// 工具由哪个 profile 发布或接受（core 优先）。
fn profile_of(tool: &str) -> &'static str {
    PROFILES
        .iter()
        .find(|p| p.find(tool).is_some())
        .map(|p| p.name)
        .unwrap()
}

#[test]
fn every_error_code_has_one_generator() {
    for &code in ErrorCode::ALL {
        let n = GENERATORS.iter().filter(|(c, _)| *c == code).count();
        assert_eq!(n, 1, "{code}: {n} 个生成器");
    }
    assert_eq!(GENERATORS.len(), ErrorCode::ALL.len());
}

fn sweep(w: &World, principal: &Principal, tool: &str, args: Value, details: Value) {
    let tool = tools::find(tool).unwrap();
    let args = match args {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    for &code in ErrorCode::ALL {
        let mut e = DomainError::new(code, "合成的错误");
        if let Value::Object(d) = &details {
            for (k, v) in d {
                e = e.detail(k, v.clone());
            }
        }
        let ctx = Ctx {
            svc: &w.svc,
            principal,
            tool,
            args: &args,
        };
        let envelope = serde_json::to_value(fix::envelope(e, Committed::No, &ctx)).unwrap();
        if let Err(problem) = fix::check(&envelope) {
            panic!("{} / {details}: {problem}\n{envelope}", tool.name);
        }
    }
}

/// 每个码、几种上下文：带 session 的 patch、只给 project 的 patch（推不出 agent_id）、begin、读工具；
/// details 里放服务常写的线索（next 指向 begin、指向 checklist、没有 operation）。
#[test]
fn every_code_yields_an_executable_fix() {
    let w = world("fix-sweep");
    let agent = Principal::authenticated_agent(None);
    let patch = json!({"session": w.session, "task_key": w.task, "operation": "complete"});
    let bare = json!({"project": w.project, "task_key": w.task, "operation": "complete"});
    let begin = json!({"agent_id": "codex", "cwd": "D:/nowhere"});
    let read = json!({"project": w.project, "task_key": w.task, "max_chars": 300, "cursor": "c"});
    let hints = [
        json!({}),
        json!({"task_key": w.task, "current_version": 1}),
        json!({"next": {"operation": "begin", "resume": true, "predecessor_session_id": "S0"}}),
        json!({"next": {"operation": "checklist", "task_key": w.task, "checklist_id": "C1", "expected_checklist_version": 2}}),
        json!({"next": {"task_key": w.task, "takeover_stale": true}}),
        json!({"next": {"operation": "task_list", "ready_only": true}}),
        json!({"candidates": ["S1", "S2"], "resolution": "session"}),
        json!({"did_you_mean": [w.project]}),
        json!({"reasons": [{"code": "CHECKLIST_INCOMPLETE", "checklist_id": "C1", "status": "TODO"}]}),
    ];
    for details in &hints {
        sweep(&w, &agent, "atm_task_patch", patch.clone(), details.clone());
        sweep(&w, &agent, "atm_task_patch", bare.clone(), details.clone());
        sweep(&w, &agent, "atm_begin", begin.clone(), details.clone());
        sweep(&w, &agent, "atm_task_get", read.clone(), details.clone());
    }
}

/// 任务相关的错误带 state：当前版本、状态、领取者是不是自己、合法操作。
#[test]
fn task_errors_carry_the_current_state() {
    let w = world("fix-state");
    let r = call(
        &w,
        "core",
        "atm_task_patch",
        json!({"session": w.session, "task_key": w.task, "operation": "reopen", "expected_version": 1}),
    );
    let e = &r["structuredContent"];
    assert_eq!(e["code"], json!("INVALID_TRANSITION"), "{e}");
    let s = &e["state"];
    assert_eq!(
        (&s["task_key"], &s["version"], &s["status"]),
        (&json!(w.task), &json!(1), &json!("READY"))
    );
    assert!(
        s["legal_operations"]
            .as_array()
            .unwrap()
            .contains(&json!("start")),
        "{s}"
    );
    assert_eq!(s["claimed_by"], Value::Null);
    // 领取之后：state 说是自己的。
    call(
        &w,
        "core",
        "atm_task_patch",
        json!({"session": w.session, "task_key": w.task, "operation": "start"}),
    );
    let e = call(
        &w,
        "core",
        "atm_task_patch",
        json!({"session": w.session, "task_key": w.task, "operation": "reopen", "expected_version": 2}),
    )["structuredContent"]
        .clone();
    assert_eq!(e["state"]["claimed_by"]["mine"], json!(true), "{e}");
    assert_eq!(e["state"]["claimed_by"]["session"], json!(w.session));
    // 自己领着的任务拿旧版本 complete：fix 直接省掉 expected_version（11 §3「owner 路径直接省掉版本」）。
    let e = call(
        &w,
        "core",
        "atm_task_patch",
        json!({"session": w.session, "task_key": w.task, "operation": "complete", "expected_version": 1}),
    )["structuredContent"]
        .clone();
    assert_eq!(e["code"], json!("VERSION_CONFLICT"), "{e}");
    let args = &e["fix"]["call"]["arguments"];
    assert_eq!(args["operation"], json!("complete"), "{e}");
    assert!(args.get("expected_version").is_none(), "{e}");
}

/// 守卫自己的阳性与阴性对照：过不了 schema 的调用、缺 committed、非内部错误给 none、退回兜底，都要报出来。
#[test]
fn the_fix_checks_reject_what_they_must() {
    use atm_domain::error::{Fix, ToolCall};
    let good = Fix::Call {
        call: ToolCall {
            name: "atm_task_list".into(),
            arguments: json!({"ready_only": true}),
        },
        why: String::new(),
    };
    let bad = Fix::Call {
        call: ToolCall {
            name: "atm_begin".into(),
            arguments: json!({"cwd": "D:/x"}),
        },
        why: String::new(),
    };
    assert!(fix::valid(&good));
    assert!(!fix::valid(&bad), "begin 缺 agent_id");
    let envelope = |fix: Value, extra: Value| {
        let mut v = json!({"code": "VERSION_CONFLICT", "committed": false, "fix": fix});
        if let (Value::Object(m), Value::Object(x)) = (&mut v, extra) {
            m.extend(x);
        }
        v
    };
    let ok = json!({"kind": "call", "call": {"name": "atm_task_list", "arguments": {"ready_only": true}}});
    assert_eq!(fix::check(&envelope(ok.clone(), json!({}))), Ok(()));
    for (fix_value, extra) in [
        (
            json!({"kind": "call", "call": {"name": "atm_begin", "arguments": {}}}),
            json!({}),
        ),
        (json!({"kind": "none"}), json!({})),
        (json!({"kind": "call"}), json!({})),
        (
            json!({"kind": "add_param", "tool": "atm_record"}),
            json!({}),
        ),
        (ok.clone(), json!({"committed": null})),
        (ok.clone(), json!({"details": {"fix_degraded": true}})),
    ] {
        let v = envelope(fix_value, extra);
        assert!(fix::check(&v).is_err(), "应当被拒：{v}");
    }
}

/// 没有 session 的写：`add_param`（A3）；op_id 撞了别的内容：`reread` 回查它。
#[test]
fn missing_sessions_and_reused_op_ids() {
    let w = world("fix-session");
    let e = call(
        &w,
        "core",
        "atm_record",
        json!({"project": w.project, "kind": "fact", "title": "t", "summary": "s"}),
    )["structuredContent"]
        .clone();
    assert_eq!(e["code"], json!("SESSION_REQUIRED"));
    assert_eq!(
        (&e["fix"]["kind"], &e["fix"]["param"], &e["fix"]["tool"]),
        (&json!("add_param"), &json!("session"), &json!("atm_record"))
    );
    let first = json!({"session": w.session, "kind": "fact", "title": "一", "summary": "s", "op_id": "dup-1"});
    assert_ne!(
        call(&w, "core", "atm_record", first)["isError"],
        json!(true)
    );
    let e = call(
        &w,
        "core",
        "atm_record",
        json!({"session": w.session, "kind": "fact", "title": "二", "summary": "s", "op_id": "dup-1"}),
    )["structuredContent"]
        .clone();
    assert_eq!(e["code"], json!("IDEMPOTENCY_CONFLICT"), "{e}");
    assert_eq!(e["fix"]["kind"], json!("reread"));
    let c = &e["fix"]["call"];
    assert_eq!(c["name"], json!("atm_search"));
    let found = call(&w, "memory", "atm_search", c["arguments"].clone());
    assert_ne!(found["isError"], json!(true), "{found}");
    assert!(found.to_string().contains("dup-1"), "{found}");
}

/// 参数校验失败：能更正就是更正后的调用，不能就是 add_param 指向要补的参数；problems 在信封顶层。
#[test]
fn schema_rejections_point_at_the_parameter() {
    let w = world("fix-schema");
    let e = call(
        &w,
        "core",
        "atm_task_patch",
        json!({"session": w.session, "task_key": w.task, "operation": "block"}),
    )["structuredContent"]
        .clone();
    assert_eq!(e["code"], json!("INVALID_ARGUMENT"));
    assert_eq!(e["problems"][0]["path"], json!("blocked_reason"), "{e}");
    assert!(e["details"].get("problems").is_none(), "{e}");
    assert_eq!(
        (&e["fix"]["kind"], &e["fix"]["param"]),
        (&json!("add_param"), &json!("blocked_reason"))
    );
    // MCP 层的 schema 校验拒绝、又没法自动更正（缺必填项）：add_param 点名缺的那个参数。
    let e = call(
        &w,
        "core",
        "atm_record",
        json!({"session": w.session, "kind": "DECISION"}),
    )["structuredContent"]
        .clone();
    assert_eq!(
        (&e["code"], &e["fix"]["kind"], &e["fix"]["param"]),
        (
            &json!("INVALID_ARGUMENT"),
            &json!("add_param"),
            &json!("summary")
        ),
        "{e}"
    );
    // 2.x 单条形状 checklist_id 不带 status：要求补上，不能悄悄当成 TODO。
    let e = call(
        &w,
        "core",
        "atm_task_patch",
        json!({"session": w.session, "task_key": w.task, "operation": "checklist", "checklist_id": "C1"}),
    )["structuredContent"]
        .clone();
    assert_eq!(
        (&e["code"], &e["problems"][0]["path"], &e["fix"]["param"]),
        (
            &json!("INVALID_ARGUMENT"),
            &json!("status"),
            &json!("status")
        ),
        "{e}"
    );
}

/// 一条猜错的调用：直接成功，或者照 fix.call 执行一次就成功。返回最终成功的结果。
fn guess(w: &World, tool: &str, args: Value) -> Value {
    let r = call(w, profile_of(tool), tool, args.clone());
    if r["isError"] != json!(true) {
        return r["structuredContent"].clone();
    }
    let e = &r["structuredContent"];
    assert_eq!(
        e["fix"]["kind"],
        json!("call"),
        "U-3：{tool} {args} 既没有直接成功，也没有给出可执行的 fix：{e}"
    );
    let c = &e["fix"]["call"];
    let name = c["name"].as_str().unwrap();
    let again = call(w, profile_of(name), name, c["arguments"].clone());
    assert_ne!(
        again["isError"],
        json!(true),
        "U-3：{tool} {args} 的 fix.call 执行一次没有成功：{c}\n{again}"
    );
    again["structuredContent"].clone()
}

/// U-3 猜错语料：11 §1.1 的猜错，加上别名与大小写的变体。
#[test]
fn u3_guesses_succeed_directly_or_after_one_fix() {
    let w = world("fix-u3");
    let s = w.session.clone();
    // W3：不写 client_ref、依赖写序号、默认就是 READY。
    let created = guess(
        &w,
        "atm_task_create",
        json!({"session": s, "items": [{"title": "甲"}, {"title": "乙", "depends_on": ["1"]},
               {"title": "带检查项", "checklist": [{"title": "一"}, {"title": "二"}]}]}),
    );
    let a = created["refs"]["1"].as_str().unwrap().to_owned();
    let c = created["refs"]["3"].as_str().unwrap().to_owned();
    let ids: Vec<String> = created["checklist"][&c]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    // 参数名猜法：key、content、details、work_item_key；枚举大小写。
    guess(&w, "atm_task_get", json!({"project": w.project, "key": a}));
    // 展示上限猜大了：fix.call 是夹到上限的同一调用。
    let found = guess(
        &w,
        "atm_search",
        json!({"project": w.project, "list": "records", "limit": 50}),
    );
    assert!(found.is_object(), "{found}");
    guess(
        &w,
        "atm_task_get",
        json!({"project": w.project, "task_key": a, "last_progress": 99}),
    );
    // 习惯性地处处带 session：列表与全文搜索不收，fix.call 是去掉它的原调用，不是再补一次。
    guess(
        &w,
        "atm_search",
        json!({"project": w.project, "session": s, "list": "records"}),
    );
    guess(
        &w,
        "atm_search",
        json!({"project": w.project, "session": s, "query": "甲"}),
    );
    guess(
        &w,
        "atm_progress_add",
        json!({"session": s, "work_item_key": a, "content": "开个头"}),
    );
    guess(
        &w,
        "atm_record",
        json!({"session": s, "kind": "decision", "title": "定了", "summary": "用 Rust", "details": "长说明"}),
    );
    // W4：claim 与 start 同批都写同一个版本。
    guess(
        &w,
        "atm_task_patch",
        json!({"session": s, "items": [
            {"task_key": w.task, "operation": "claim", "expected_version": 1},
            {"task_key": w.task, "operation": "start", "expected_version": 1},
        ]}),
    );
    // W4：progress 推高了版本，拿旧版本去 complete。
    let before = guess(
        &w,
        "atm_task_get",
        json!({"project": w.project, "task_key": w.task}),
    )["version"]
        .as_i64()
        .unwrap();
    guess(
        &w,
        "atm_progress_add",
        json!({"session": s, "task_key": w.task, "summary": "快好了"}),
    );
    guess(
        &w,
        "atm_task_patch",
        json!({"session": s, "task_key": w.task, "op": "COMPLETE", "expected_version": before}),
    );
    // W4：从没开工的任务直接 complete；W6：在 READY 上 wait_user。
    guess(
        &w,
        "atm_task_patch",
        json!({"session": s, "task_key": a, "operation": "complete"}),
    );
    let b = created["refs"]["2"].as_str().unwrap().to_owned();
    guess(
        &w,
        "atm_task_patch",
        json!({"session": s, "task_key": b, "operation": "wait_user", "waiting_for": "用户确认"}),
    );
    // 检查项：拿任务版本当检查项版本（旧名 checklist_single）。
    guess(
        &w,
        "atm_task_patch",
        json!({"session": s, "task_key": c, "operation": "claim", "expected_version": 1}),
    );
    let task_version = guess(
        &w,
        "atm_task_get",
        json!({"project": w.project, "task_key": c}),
    )["version"]
        .clone();
    guess(
        &w,
        "atm_task_patch",
        json!({"session": s, "task_key": c, "operation": "checklist_single", "expected_version": task_version,
               "checklist_items": [{"id": ids[0], "status": "DONE"}]}),
    );
    // 逐条带了过期的检查项版本（又一种猜法）：换上当前版本，逐条的旧版本作废。
    guess(
        &w,
        "atm_task_patch",
        json!({"session": s, "task_key": c, "operation": "checklist",
               "checklist": [{"item": ids[0], "status": "DONE", "expected_checklist_version": 7}]}),
    );
    // edit 不带版本。
    guess(
        &w,
        "atm_task_patch",
        json!({"session": s, "task_key": c, "operation": "edit", "title": "改个名"}),
    );
    // 键名拼错（能按 did_you_mean 更正）。
    guess(
        &w,
        "atm_task_patch",
        json!({"session": s, "task_key": c, "opration": "start"}),
    );
    // 完成门：还有一项检查项没勾就 complete，fix 是预填了检查项的同一个 complete。
    let args = json!({"session": s, "task_key": c, "operation": "complete"});
    let gate = call(&w, "core", "atm_task_patch", args.clone())["structuredContent"].clone();
    assert_eq!(gate["code"], json!("COMPLETION_GATE_FAILED"), "{gate}");
    assert_eq!(
        gate["fix"]["call"]["arguments"]["checklist"],
        json!([{"item": ids[1], "status": "DONE"}]),
        "{gate}"
    );
    guess(&w, "atm_task_patch", args);
    // W9：end 不写 outcome。
    let ended = guess(&w, "atm_end", json!({"session": s, "summary": "收工"}));
    assert_eq!(ended["outcome"], json!("paused"), "还领着任务：{ended}");
}

/// 生成的调用过不了 schema 时退回兜底，并在 details 里标出 fix_degraded（U-4 的动态检查以它为红）。
#[test]
fn degraded_fixes_fall_back_and_are_flagged() {
    let w = world("fix-degraded");
    let agent = Principal::authenticated_agent(None);
    let tool = tools::find("atm_task_get").unwrap();
    let args = match json!({"project": w.project, "task_key": w.task}) {
        Value::Object(m) => m,
        _ => unreachable!(),
    };
    // did_you_mean 是一个超出 project 上限的代码：「换成它重发」过不了 schema。
    let e = DomainError::new(ErrorCode::PROJECT_NOT_FOUND, "没有这个项目")
        .detail("did_you_mean", json!(["X".repeat(30)]));
    let ctx = Ctx {
        svc: &w.svc,
        principal: &agent,
        tool,
        args: &args,
    };
    let v = serde_json::to_value(fix::envelope(e, Committed::No, &ctx)).unwrap();
    assert_eq!(v["details"]["fix_degraded"], json!(true), "{v}");
    assert!(fix::check(&v).is_err(), "降级必须被动态检查抓到：{v}");
    // 兜底本身仍然是能执行的出路。
    let kind = v["fix"]["kind"].as_str().unwrap();
    assert_ne!(kind, "none", "{v}");
    if let Some(c) = v["fix"].get("call") {
        let name = c["name"].as_str().unwrap();
        assert!(
            tools::find(name).unwrap().validate(&c["arguments"]).is_ok(),
            "{v}"
        );
    }
}

/// 排不上队（STORE_BUSY）：一行都没执行，wait 带着原样的同一调用。
#[test]
fn busy_calls_wait_with_the_same_call() {
    let calls = atm_http::Calls::new(1, std::time::Duration::from_millis(200));
    let w = world_with("fix-busy", calls.clone());
    let hold = calls.clone();
    w._rt.spawn(async move {
        let _ = hold
            .run(|| std::thread::sleep(std::time::Duration::from_millis(1500)))
            .await;
    });
    std::thread::sleep(std::time::Duration::from_millis(300));
    let args = json!({"project": w.project, "task_key": w.task});
    let r = call(&w, "core", "atm_task_get", args.clone());
    let e = &r["structuredContent"];
    assert_eq!(e["code"], json!("STORE_BUSY"), "{e}");
    assert_eq!(e["fix"]["kind"], json!("wait"));
    assert_eq!(
        e["fix"]["call"],
        json!({"name": "atm_task_get", "arguments": args}),
        "{e}"
    );
}
