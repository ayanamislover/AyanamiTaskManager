//! 读模型的验收（W2f；02 §4，S-050～S-070，D24–D27、D30；00 02 C-04、C-05、C-09、C-10、C-12、C-15、C-16、
//! C-19、Q-01、Q-05；03 F-05；04 §1.3；10 R2、R4′；R11 P2-5）。

mod support;

use atm_domain::error::ErrorCode;
use atm_domain::time::Timestamp;
use atm_domain::work::Operation;
use atm_service::memory::{FeedbackRequest, ProgressRequest, RecordRequest};
use atm_service::read::{
    BeginBrief, BriefRequest, DeltaRequest, ListRequest, SearchRequest, TaskGetRequest,
    TaskListRequest, TaskView,
};
use atm_service::session::{BeginRequest, EndRequest, Outcome, ProjectSelector, Resume};
use atm_service::work::{CreateItem, Target};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use support::*;

// ---------- 助手 ----------

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn brief(w: &World, r: BriefRequest) -> Value {
    w.svc.brief(&agent(), "ATM", &r).unwrap()
}

fn brief_err(w: &World, r: BriefRequest) -> atm_domain::error::DomainError {
    w.svc.brief(&agent(), "ATM", &r).unwrap_err()
}

fn rec(w: &World, kind: &str, title: &str, summary: &str, importance: &str) -> String {
    let r = w
        .svc
        .create_record(
            &agent(),
            &w.target(Some("S1")),
            RecordRequest {
                importance: Some(importance.into()),
                ..RecordRequest::new(kind, title, summary)
            },
        )
        .unwrap();
    r.result["record"]["key"].as_str().unwrap().to_owned()
}

fn keys_of(v: &Value) -> Vec<String> {
    v.as_object().unwrap().keys().cloned().collect()
}

fn agent_begin(w: &World, agent_id: &str, thread: &str, resume: Resume) -> String {
    let r = w
        .svc
        .begin(
            &agent(),
            BeginRequest {
                selector: ProjectSelector {
                    code: Some("ATM".into()),
                    ..ProjectSelector::default()
                },
                cwd: Some("R:/repo".into()),
                thread_id: Some(thread.into()),
                resume: Some(resume),
                ..BeginRequest::new(agent_id)
            },
        )
        .unwrap();
    r.result["session"]["id"].as_str().unwrap().to_owned()
}

fn pause(w: &World, session: &str) {
    w.svc
        .end_session(
            &agent(),
            &w.target(Some(session)),
            EndRequest {
                outcome: Outcome::Paused,
                summary: "先停".into(),
                next: vec!["接着写测试".into()],
                release_claims: false,
                retirement_reason: None,
                git: None,
            },
        )
        .unwrap();
}

fn search(w: &World, r: SearchRequest) -> Value {
    w.svc.search(&agent(), &r).unwrap()
}

// ================= brief =================

/// S-050：精选记录——用户约束优先、CRITICAL 优先、最多 8 条；LOW FACT 与 ATM_FEEDBACK 不进。
#[test]
fn s050_brief_selects_records() {
    let w = world("rd-brief-records");
    // CRITICAL 最旧、LOW 最新：排序与上限都得靠规则而不是时间。
    let critical = rec(&w, "RISK", "风险", "严重", "CRITICAL");
    let decisions: Vec<String> = (0..7)
        .map(|i| rec(&w, "DECISION", &format!("决定{i}"), "高", "HIGH"))
        .collect();
    let low = rec(&w, "FACT", "普通事实", "低", "LOW");
    let user = w
        .svc
        .create_record(
            &user(),
            &w.target(None),
            RecordRequest::new("CONSTRAINT", "用户约束", "必须"),
        )
        .unwrap()
        .result["record"]["key"]
        .as_str()
        .unwrap()
        .to_owned();
    w.svc
        .feedback(
            &agent(),
            &w.target(Some("S1")),
            FeedbackRequest {
                summary: "反馈".into(),
                detail: None,
                tool: None,
                severity: Some("CRITICAL".into()),
                task_key: None,
            },
        )
        .unwrap();
    let b = brief(
        &w,
        BriefRequest {
            max_chars: 5000,
            ..BriefRequest::default()
        },
    );
    let records = b["records"].as_array().unwrap();
    assert_eq!(records.len(), 8);
    assert_eq!(records[0]["key"], user.as_str());
    assert_eq!(records[1]["key"], critical.as_str());
    // 其余 6 条是最新的 6 个 DECISION（最旧的一个被上限挤掉），字母是 D。
    let rest: Vec<&str> = records[2..]
        .iter()
        .map(|r| r["key"].as_str().unwrap())
        .collect();
    let newest: Vec<&str> = decisions[1..].iter().rev().map(String::as_str).collect();
    assert_eq!(rest, newest);
    assert!(rest.iter().all(|k| k.contains("-D-") && *k != low));
    // brief 里的记录不带来源三元组。
    assert_eq!(
        keys_of(&records[0]),
        ["key", "kind", "summary", "importance", "source_type"]
    );
    assert_eq!(b["truncated"], false);
}

/// S-052 + C-10：include 只留点名分节与身份键；task / delta 只在给了 task_key / since_seq 时出现；
/// milestone 取活动 objective 下的活动 milestone。
#[test]
fn s052_c10_include_and_sections() {
    let w = world("rd-brief-include");
    let k = w.task("一");
    let more: Vec<String> = (2..5).map(|i| w.task(&format!("任务{i}"))).collect();
    // next 最多 3 个 ready 任务，按优先级、sort_key、创建顺序。
    let b = brief(&w, BriefRequest::default());
    assert_eq!(b["next"], json!([k, more[0], more[1]]));
    let b = brief(
        &w,
        BriefRequest {
            include: vec!["counts".into()],
            ..BriefRequest::default()
        },
    );
    assert_eq!(
        keys_of(&b),
        [
            "project",
            "seq",
            "active",
            "blocked",
            "waitingUser",
            "waitingAgent",
            "truncated"
        ]
    );
    let b = brief(
        &w,
        BriefRequest {
            include: vec!["task".into()],
            ..BriefRequest::default()
        },
    );
    assert!(b.get("task").is_none());
    let b = brief(
        &w,
        BriefRequest {
            task_key: Some(k.to_lowercase()),
            since_seq: Some(0),
            max_chars: 5000,
            ..BriefRequest::default()
        },
    );
    assert_eq!(b["task"]["key"], k.as_str());
    assert_eq!(
        keys_of(&b["task"]),
        [
            "key",
            "title",
            "status",
            "progress",
            "version",
            "acceptance",
            "blockedReason",
            "waitingFor"
        ]
    );
    assert_eq!(b["delta"]["events"][0]["type"], "work.created");
    // C-10：O1 下的活动 milestone；已完成 objective 下的 M2 不会被选中。
    assert_eq!(b["objective"], "主目标");
    assert_eq!(b["milestone"], "里程碑");
    w.exec("UPDATE milestones SET status = 'DONE' WHERE id = 'M1'");
    let b = brief(&w, BriefRequest::default());
    assert_eq!(b["milestone"], Value::Null);
    let e = brief_err(
        &w,
        BriefRequest {
            include: vec!["nope".into()],
            ..BriefRequest::default()
        },
    );
    assert_eq!(e.code, ErrorCode::INVALID_ARGUMENT);
}

/// S-051 + R4′ + R2：唯一同四元组的已关闭来源展示交接；两个来源都不展示；lineage 祖先的待确认交接展示给后继。
#[test]
fn s051_r4_handoffs_by_identity() {
    let w = world("rd-brief-handoff");
    let a = agent_begin(&w, "codex", "t", Resume::No);
    let k = w.task("一");
    w.patch_as(&agent(), Some(&a), vec![p(&k, Operation::Start)])
        .unwrap();
    pause(&w, &a);
    let ready: Vec<String> = (0..3).map(|i| w.task(&format!("待办{i}"))).collect();
    // 同四元组的新 session（不接续）：任务按 assignee 成为 currentTask，交接来自唯一来源。
    let b1 = agent_begin(&w, "codex", "t", Resume::No);
    let b = brief(
        &w,
        BriefRequest {
            session: Some(b1.clone()),
            max_chars: 5000,
            ..BriefRequest::default()
        },
    );
    assert_eq!(b["currentTask"]["key"], k.as_str());
    assert_eq!(b["handoff"]["nextAction"], "接着写测试");
    // next：交接的下一步在前，再接 ready 任务，总共最多 3 个。
    assert_eq!(b["next"], json!(["接着写测试", ready[0], ready[1]]));
    assert_eq!(b["session_id"], b1.as_str());
    // 线程不同：不展示。
    let other = agent_begin(&w, "codex", "other", Resume::No);
    let b = brief(
        &w,
        BriefRequest {
            session: Some(other),
            max_chars: 5000,
            ..BriefRequest::default()
        },
    );
    assert_eq!(b["handoff"], Value::Null);
    // 第二个同四元组来源 → 都不展示。
    let a2 = agent_begin(&w, "codex", "t", Resume::No);
    let k2 = w.task("二");
    w.patch_as(&agent(), Some(&a2), vec![p(&k2, Operation::Start)])
        .unwrap();
    pause(&w, &a2);
    let b = brief(
        &w,
        BriefRequest {
            session: Some(b1.clone()),
            max_chars: 5000,
            ..BriefRequest::default()
        },
    );
    assert_eq!(b["handoff"], Value::Null);
    // R4′：指名 predecessor（不接续、不确认）后，lineage 里的祖先交接照样展示，即使线程不同（C-07）。
    let succ = w
        .svc
        .begin(
            &agent(),
            BeginRequest {
                selector: ProjectSelector {
                    code: Some("ATM".into()),
                    ..ProjectSelector::default()
                },
                cwd: Some("R:/elsewhere".into()),
                thread_id: Some("new".into()),
                resume: Some(Resume::No),
                predecessor_session_id: Some(a.clone()),
                ..BeginRequest::new("codex")
            },
        )
        .unwrap()
        .result["session"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let b = brief(
        &w,
        BriefRequest {
            session: Some(succ),
            max_chars: 5000,
            ..BriefRequest::default()
        },
    );
    // R2：领取属于 lineage，祖先领的任务是「自己的」。
    assert_eq!(b["own"], json!([k]));
    assert_eq!(b["currentTask"]["key"], k.as_str());
    assert_eq!(b["handoff"]["summary"], "先停");
}

fn long_records(w: &World, n: usize) -> Vec<String> {
    (0..n)
        .map(|i| {
            rec(
                w,
                "DECISION",
                &format!("决定{i}"),
                &format!("{i}{}", "很长的摘要".repeat(40)),
                "HIGH",
            )
        })
        .collect()
}

/// S-053 + S-054：预算按分节丢弃、records 整条分页、不截断字符串；续读拿到剩下的记录，不丢不重。
#[test]
fn s053_s054_budget_and_continuation() {
    let w = world("rd-brief-budget");
    long_records(&w, 8);
    let first = brief(&w, BriefRequest::default());
    assert!(js(&first) <= 1200, "{}", js(&first));
    assert_eq!(first["truncated"], true);
    let shown = first["records"].as_array().unwrap().len();
    assert!(shown < 8);
    for r in first["records"].as_array().unwrap() {
        assert!(r["summary"].as_str().unwrap().ends_with("很长的摘要"));
    }
    assert_eq!(first["omitted_collections"][0]["total_items"], 8);
    let mut seen: Vec<String> = first["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["key"].as_str().unwrap().to_owned())
        .collect();
    let mut cursor = first["continuation"]["cursor"].as_str().unwrap().to_owned();
    assert!(cursor.starts_with("b4."));
    assert!(seen[0].contains("-D-"));
    // 有界：续读不前进时不挂死，而是在下面的数量断言上变红。
    for _ in 0..10 {
        let page = brief(
            &w,
            BriefRequest {
                cursor: Some(cursor.clone()),
                ..BriefRequest::default()
            },
        );
        assert!(js(&page) <= 1200);
        assert_eq!(page["offset"], seen.len());
        seen.extend(
            page["records"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| r["key"].as_str().unwrap().to_owned()),
        );
        match page["continuation"]["cursor"].as_str() {
            Some(c) => cursor = c.to_owned(),
            None => break,
        }
    }
    let mut unique = seen.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(seen.len(), 8);
    assert_eq!(unique.len(), 8);
    // 改一位签名 → INVALID_OR_TAMPERED。
    let mut bad = first["continuation"]["cursor"].as_str().unwrap().to_owned();
    let last = bad.pop().unwrap();
    bad.push(if last == 'A' { 'B' } else { 'A' });
    let e = brief_err(
        &w,
        BriefRequest {
            cursor: Some(bad),
            ..BriefRequest::default()
        },
    );
    assert_eq!(
        (e.code, e.details["reason"].clone()),
        (ErrorCode::INVALID_CURSOR, json!("INVALID_OR_TAMPERED"))
    );
    assert_eq!(e.details["recovery"]["action"], "restart_read");
}

fn js(v: &Value) -> usize {
    serde_json::to_string(v).unwrap().encode_utf16().count()
}

fn utf16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// S-055～S-059：目标不一致、记录变化、过期、放不下、快照推进。
#[test]
fn s055_s059_continuation_rules() {
    let clock = Arc::new(AtomicI64::new(now_ms()));
    let c = clock.clone();
    let w = world_with(
        "rd-brief-rules",
        Some(Arc::new(move || {
            Timestamp::from_millis(c.load(Ordering::SeqCst))
        })),
    );
    let keys = long_records(&w, 8);
    let first = brief(&w, BriefRequest::default());
    let cursor = first["continuation"]["cursor"].as_str().unwrap().to_owned();
    // S-055：换 include → TARGET_MISMATCH（保留游标）。
    let e = brief_err(
        &w,
        BriefRequest {
            cursor: Some(cursor.clone()),
            include: vec!["records".into()],
            ..BriefRequest::default()
        },
    );
    assert_eq!(e.code, ErrorCode::CONTINUATION_CONFLICT);
    assert_eq!(e.details["reason"], "TARGET_MISMATCH");
    assert_eq!(e.details["recovery"]["preserve_cursor"], true);
    // S-059：写一条新事件，续读照常并标出快照推进。
    let k = w.task("一");
    let page = brief(
        &w,
        BriefRequest {
            cursor: Some(cursor.clone()),
            ..BriefRequest::default()
        },
    );
    assert!(page["snapshot_advanced_to"].as_i64() > page["snapshot_advanced_from"].as_i64());
    let _ = k;
    // S-058：一条都放不下 → RESULT_TOO_LARGE，保留游标。
    let e = brief_err(
        &w,
        BriefRequest {
            cursor: Some(cursor.clone()),
            max_chars: 300,
            ..BriefRequest::default()
        },
    );
    assert_eq!(e.code, ErrorCode::RESULT_TOO_LARGE);
    assert_eq!(e.details["recovery"]["preserve_cursor"], true);
    // S-057：过期。游标里的过期时刻 e 当时仍有效，e+1 起 INVALID_CURSOR EXPIRED，出路是重新读。
    let now = clock.load(Ordering::SeqCst);
    let expires: i64 = cursor.split('.').nth(5).unwrap().parse().unwrap();
    clock.store(expires, Ordering::SeqCst);
    brief(
        &w,
        BriefRequest {
            cursor: Some(cursor.clone()),
            ..BriefRequest::default()
        },
    );
    clock.store(expires + 1, Ordering::SeqCst);
    let e = brief_err(
        &w,
        BriefRequest {
            cursor: Some(cursor.clone()),
            ..BriefRequest::default()
        },
    );
    assert_eq!(e.code, ErrorCode::INVALID_CURSOR);
    assert_eq!(e.details["reason"], "EXPIRED");
    assert_eq!(e.details["recovery"]["action"], "restart_read");
    clock.store(now, Ordering::SeqCst);
    // S-056：冻结的记录被替代 → STALE，带 record_key。
    let frozen = keys.last().unwrap();
    w.svc
        .create_record(
            &agent(),
            &w.target(Some("S1")),
            RecordRequest {
                supersedes: Some(frozen.clone()),
                ..RecordRequest::new("DECISION", "新", "替代")
            },
        )
        .unwrap();
    let e = brief_err(
        &w,
        BriefRequest {
            cursor: Some(cursor),
            ..BriefRequest::default()
        },
    );
    assert_eq!(e.details["reason"], "STALE");
    assert!(e.details["record_key"].is_string());
    // A3：按范围恢复之后，旧游标是 SCOPE_RESTORED（先于记录核对）。
    w.exec(&format!(
        "INSERT INTO scope_generations (gen, scope_kind, scope_id, reason, epoch, created_at) VALUES (9, 'PROJECT', 'PA', 'RESTORED', 'EA', '{T0}');
         UPDATE projects SET scope_gen = 9 WHERE id = 'PA';"
    ));
    let e = brief_err(
        &w,
        BriefRequest {
            cursor: Some(first["continuation"]["cursor"].as_str().unwrap().to_owned()),
            ..BriefRequest::default()
        },
    );
    assert_eq!(e.details["reason"], "SCOPE_RESTORED");
}

/// S-060：begin 的 brief 模式；身份永不裁剪。C-16：普通 brief 连身份都放不下时报错。
#[test]
fn s060_c16_begin_brief_modes() {
    let w = world("rd-begin-brief");
    long_records(&w, 8);
    let begun = w
        .svc
        .begin(
            &agent(),
            BeginRequest {
                selector: ProjectSelector {
                    code: Some("ATM".into()),
                    ..ProjectSelector::default()
                },
                op_id: Some("b1".into()),
                ..BeginRequest::new("codex")
            },
        )
        .unwrap();
    let none = w
        .svc
        .begin_brief(&agent(), &begun, BeginBrief::None, 1200)
        .unwrap();
    assert_eq!(
        keys_of(&none),
        [
            "scope",
            "session",
            "project",
            "surface_version",
            "outcome",
            "acknowledged_handoffs",
            "brief_mode",
            "brief_truncated"
        ]
    );
    let minimal = w
        .svc
        .begin_brief(&agent(), &begun, BeginBrief::Minimal, 5000)
        .unwrap();
    for k in ["active", "next", "currentTask", "handoff"] {
        assert!(minimal.get(k).is_some(), "{k}");
    }
    for k in ["records", "objective", "own", "artifacts"] {
        assert!(minimal.get(k).is_none(), "{k}");
    }
    assert_eq!(minimal["brief_mode"], "minimal");
    let full = w
        .svc
        .begin_brief(&agent(), &begun, BeginBrief::Full, 400)
        .unwrap();
    assert_eq!(full["session"], begun.result["session"]["id"]);
    assert_eq!(full["brief_truncated"], true);
    // S-005：8 条长记录、400 字符的预算下，身份字段一个不少（只有可裁剪的 body 被丢）。
    for k in ["scope", "session", "project", "surface_version", "outcome"] {
        assert!(full.get(k).is_some_and(|v| !v.is_null()), "{k}: {full}");
    }
    let e = brief_err(
        &w,
        BriefRequest {
            session: Some("S".repeat(400)),
            max_chars: 300,
            ..BriefRequest::default()
        },
    );
    assert_eq!(e.code, ErrorCode::RESULT_TOO_LARGE);
}

// ================= delta =================

fn delta(w: &World, r: DeltaRequest) -> Value {
    w.svc.delta(&agent(), "ATM", &r).unwrap()
}

/// S-061～S-063 + C-04：since 升序与 has_more；最新窗口；预算按实际返回推进，续读带 types。
#[test]
fn s061_s063_c04_delta() {
    let w = world("rd-delta");
    w.create_as(
        &agent(),
        Some("S1"),
        (0..30).map(|i| item(&format!("任务{i}"))).collect(),
    )
    .unwrap();
    let current = w
        .scalar("SELECT project_seq FROM projects WHERE id = 'PA'")
        .as_i64()
        .unwrap();
    let d = delta(
        &w,
        DeltaRequest {
            since_seq: Some(10),
            limit: 5,
            ..DeltaRequest::default()
        },
    );
    let seqs: Vec<i64> = d["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["seq"].as_i64().unwrap())
        .collect();
    assert_eq!(seqs, [11, 12, 13, 14, 15]);
    assert_eq!(
        (d["has_more"].clone(), d["next_seq"].clone()),
        (json!(true), json!(15))
    );
    assert_eq!(d["current_sequence"], current);
    assert_eq!(d["continuation"]["arguments"]["since_seq"], 15);
    let d = delta(
        &w,
        DeltaRequest {
            since_seq: Some(current),
            ..DeltaRequest::default()
        },
    );
    assert_eq!(
        (d["returned_count"].clone(), d["has_more"].clone()),
        (json!(0), json!(false))
    );
    // S-062：最新窗口。
    let d = delta(
        &w,
        DeltaRequest {
            limit: 3,
            ..DeltaRequest::default()
        },
    );
    assert_eq!(d["window"], "latest");
    assert_eq!(d["since_seq"], current - 3);
    assert_eq!(d["has_more"], false);
    let next = delta(
        &w,
        DeltaRequest {
            since_seq: d["since_seq"].as_i64(),
            limit: 3,
            ..DeltaRequest::default()
        },
    );
    assert_eq!(next["events"], d["events"]);
    // S-063 + C-04：预算只够几条 → next_seq 是最后返回的那条；续读参数带 types。
    let d = delta(
        &w,
        DeltaRequest {
            since_seq: Some(0),
            limit: 30,
            types: vec!["work.created".into()],
            max_chars: 1000,
        },
    );
    let n = d["returned_count"].as_i64().unwrap();
    assert!(n > 0 && n < 30);
    assert_eq!(d["truncated"], true);
    assert_eq!(d["next_seq"], d["events"][n as usize - 1]["seq"]);
    assert_eq!(
        d["continuation"]["arguments"]["types"],
        json!(["work.created"])
    );
    assert!(js(&d) <= 1000);
    // 照续读参数再调一次：仍只有点名的类型，从上一页之后接着给。
    let args = &d["continuation"]["arguments"];
    let next = delta(
        &w,
        DeltaRequest {
            since_seq: args["since_seq"].as_i64(),
            limit: 30,
            types: vec![args["types"][0].as_str().unwrap().to_owned()],
            max_chars: 1000,
        },
    );
    let events = next["events"].as_array().unwrap();
    assert!(!events.is_empty());
    assert!(events.iter().all(|e| e["type"] == "work.created"));
    assert!(events[0]["seq"].as_i64() > d["next_seq"].as_i64());
}

/// S-064：单条放不下 → oversized_event 给出 REST 回取路径，next_seq 越过它。
#[test]
fn s064_oversized_event() {
    let w = world("rd-delta-big");
    w.task("一");
    let seq = w
        .scalar("SELECT project_seq FROM projects WHERE id = 'PA'")
        .as_i64()
        .unwrap();
    let big = "大".repeat(5000);
    w.exec(&format!(
        "INSERT INTO events (project_id, seq, id, type, actor_type, actor_id, aggregate_type, aggregate_id, payload_json, created_at)
         VALUES ('PA', {s1}, 'EVBIG', 'work.updated', 'AGENT', 'claude', 'WORK_ITEM', 'X', '{{\"summary\":\"{big}\"}}', '{T0}'),
                ('PA', {s2}, 'EVNEXT', 'work.updated', 'AGENT', 'claude', 'WORK_ITEM', 'Y', '{{}}', '{T0}');
         UPDATE projects SET project_seq = {s2} WHERE id = 'PA';",
        s1 = seq + 1,
        s2 = seq + 2,
    ));
    let d = delta(
        &w,
        DeltaRequest {
            since_seq: Some(seq),
            max_chars: 1000,
            ..DeltaRequest::default()
        },
    );
    assert_eq!(d["returned_count"], 0);
    assert_eq!(d["next_seq"], seq + 1);
    assert_eq!(d["has_more"], true);
    assert_eq!(
        d["oversized_event"]["continuation"]["path"],
        format!("/api/v1/projects/ATM/events?since={seq}&limit=1")
    );
    assert_eq!(d["continuation"]["arguments"]["since_seq"], seq + 1);
    let rest = delta(
        &w,
        DeltaRequest {
            since_seq: d["next_seq"].as_i64(),
            max_chars: 1000,
            ..DeltaRequest::default()
        },
    );
    assert_eq!(rest["events"][0]["seq"], seq + 2);
}

// ================= 列表 =================

fn task_list(w: &World, r: TaskListRequest) -> Result<Value, atm_domain::error::DomainError> {
    w.svc.task_list(&agent(), "ATM", &r)
}

/// S-065 + R11 P2-5：keyset + 每项游标 —— 按预算截断续读不丢不重；换过滤条件 / 项目的游标无效；
/// status=open|closed|all、mine。
#[test]
fn s065_task_list_paging() {
    let w = world("rd-task-list");
    let keys: Vec<String> = (0..20).map(|i| w.task(&format!("任务{i}"))).collect();
    let mut seen = Vec::new();
    let mut cursor = None;
    for _ in 0..30 {
        let page = task_list(
            &w,
            TaskListRequest {
                limit: 7,
                cursor: cursor.clone(),
                max_chars: 1000,
                ..TaskListRequest::default()
            },
        )
        .unwrap();
        assert!(js(&page) <= 1000);
        seen.extend(
            page["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|i| i["key"].as_str().unwrap().to_owned()),
        );
        if page["has_more"] == false {
            break;
        }
        cursor = page["next_cursor"].as_str().map(str::to_owned);
    }
    assert_eq!(seen, keys);
    let first = task_list(
        &w,
        TaskListRequest {
            limit: 2,
            ..TaskListRequest::default()
        },
    )
    .unwrap();
    let c = first["next_cursor"].as_str().unwrap().to_owned();
    assert!(c.starts_with("tl2."));
    let e = task_list(
        &w,
        TaskListRequest {
            cursor: Some(c.clone()),
            ready_only: true,
            ..TaskListRequest::default()
        },
    )
    .unwrap_err();
    assert_eq!(
        (e.code, e.details["reason"].clone()),
        (ErrorCode::INVALID_CURSOR, json!("INVALID_OR_TAMPERED"))
    );
    let e = w
        .svc
        .task_list(
            &agent(),
            "EMP",
            &TaskListRequest {
                cursor: Some(c),
                ..TaskListRequest::default()
            },
        )
        .unwrap_err();
    assert_eq!(e.details["reason"], "INVALID_OR_TAMPERED");
    // oversized_item：一条都放不下时空页 + 起点游标，续读不丢这一条。
    w.exec(&format!(
        "UPDATE work_items SET description = '{}' WHERE project_id = 'PA' AND local_no = 1",
        "长".repeat(400)
    ));
    let page = task_list(
        &w,
        TaskListRequest {
            view: TaskView::Context,
            max_chars: 500,
            limit: 1,
            ..TaskListRequest::default()
        },
    )
    .unwrap();
    assert_eq!(page["returned_count"], 0);
    assert_eq!(page["oversized_item"]["key"], keys[0].as_str());
    assert_eq!(page["has_more"], true);
    let again = task_list(
        &w,
        TaskListRequest {
            view: TaskView::Context,
            max_chars: 2000,
            limit: 1,
            cursor: page["next_cursor"].as_str().map(str::to_owned),
            ..TaskListRequest::default()
        },
    )
    .unwrap();
    assert_eq!(again["items"][0]["key"], keys[0].as_str());
    // status 与 mine。
    w.s1(p(&keys[0], Operation::Start)).unwrap();
    w.s1(p(&keys[0], Operation::Complete)).unwrap();
    w.patch_as(&agent(), Some("SX"), vec![p(&keys[1], Operation::Claim)])
        .unwrap();
    w.s1(p(&keys[2], Operation::Claim)).unwrap();
    let count = |r: TaskListRequest| {
        task_list(&w, TaskListRequest { limit: 100, ..r }).unwrap()["returned_count"].clone()
    };
    assert_eq!(
        count(TaskListRequest {
            status: Some("closed".into()),
            ..TaskListRequest::default()
        }),
        1
    );
    assert_eq!(
        count(TaskListRequest {
            status: Some("open".into()),
            ..TaskListRequest::default()
        }),
        19
    );
    assert_eq!(
        count(TaskListRequest {
            status: Some("all".into()),
            ..TaskListRequest::default()
        }),
        20
    );
    assert_eq!(
        count(TaskListRequest {
            status: Some("claimed".into()),
            ..TaskListRequest::default()
        }),
        2
    );
    assert_eq!(
        count(TaskListRequest {
            mine_session: Some("SX".into()),
            ..TaskListRequest::default()
        }),
        1
    );
    assert_eq!(
        count(TaskListRequest {
            mine_session: Some("S2".into()),
            ..TaskListRequest::default()
        }),
        1
    );
    let e = task_list(
        &w,
        TaskListRequest {
            status: Some("weird".into()),
            ..TaskListRequest::default()
        },
    )
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::INVALID_ARGUMENT);
    let e = task_list(
        &w,
        TaskListRequest {
            milestone_id: Some("NOPE".into()),
            ..TaskListRequest::default()
        },
    )
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::MILESTONE_NOT_FOUND);
}

/// 02 §4.5：视图字段集与 field_mask 越界回显。
#[test]
fn task_views_and_masks() {
    let w = world("rd-task-views");
    let k = w.task("一");
    let core = task_list(&w, TaskListRequest::default()).unwrap();
    assert_eq!(
        keys_of(&core["items"][0]),
        [
            "key",
            "status",
            "phase",
            "waiting_on",
            "progress",
            "progress_source",
            "version",
            "updated_at"
        ]
    );
    let get = |r: TaskGetRequest| w.svc.task_get(&agent(), "ATM", &r).unwrap();
    let full = get(TaskGetRequest {
        view: TaskView::Full,
        ..TaskGetRequest::new(k.clone())
    });
    for f in [
        "title",
        "description_preview",
        "checklist_summary",
        "description",
        "checklist",
        "relations",
    ] {
        assert!(full.get(f).is_some(), "{f}");
    }
    let masked = get(TaskGetRequest {
        field_mask: vec!["status".into(), "title".into()],
        ..TaskGetRequest::new(k.clone())
    });
    assert_eq!(
        masked,
        json!({ "status": "READY", "ignored_fields": ["title"] })
    );
    w.svc
        .add_progress(
            &agent(),
            &w.target(Some("S1")),
            ProgressRequest::task(&k, "进展一"),
        )
        .unwrap();
    let with = get(TaskGetRequest {
        last_progress: Some(3),
        field_mask: vec!["key".into()],
        ..TaskGetRequest::new(k.clone())
    });
    assert_eq!(with["recent_progress"][0]["summary"], "进展一");
    assert!(with["recent_progress"][0].get("task_key").is_none());
    let e = w
        .svc
        .task_get(&agent(), "ATM", &TaskGetRequest::new("ATM-T-0099"))
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::WORK_ITEM_NOT_FOUND);
}

/// 02 §4.5 + C-19：长字段续读到完整原文；偏移不切开代理对；字段内容变了 → STALE；mask 变了 → TARGET_MISMATCH。
#[test]
fn c19_field_continuation() {
    let w = world("rd-field");
    let k = w.task("一");
    let text = format!("a{}", "\u{1F600}字".repeat(700));
    w.exec(&format!(
        "UPDATE work_items SET description = '{text}' WHERE project_id = 'PA' AND local_no = 1"
    ));
    let req = |cursor: Option<String>| TaskGetRequest {
        view: TaskView::Full,
        field_mask: vec!["description".into()],
        cursor,
        max_chars: 1200,
        ..TaskGetRequest::new(k.clone())
    };
    let first = w.svc.task_get(&agent(), "ATM", &req(None)).unwrap();
    assert_eq!(first["truncated"], true);
    let mut got = first["description"].as_str().unwrap().to_owned();
    // 首页按最宽的一级截断，不是一刀截成空串。
    assert!(utf16(&got) > 400, "{}", utf16(&got));
    let mut cursor = first["truncated_fields"][0]["continuation"]["cursor"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(cursor.starts_with("f3."));
    let initial = cursor.clone();
    for _ in 0..20 {
        let page = w
            .svc
            .task_get(&agent(), "ATM", &req(Some(cursor.clone())))
            .unwrap();
        assert!(js(&page) <= 1200);
        got.push_str(page["value"].as_str().unwrap());
        if page["done"] == true {
            break;
        }
        cursor = page["next_cursor"].as_str().unwrap().to_owned();
    }
    assert_eq!(got, text);
    let e = w
        .svc
        .task_get(
            &agent(),
            "ATM",
            &TaskGetRequest {
                field_mask: vec!["description".into(), "title".into()],
                ..req(Some(initial.clone()))
            },
        )
        .unwrap_err();
    assert_eq!(e.details["reason"], "TARGET_MISMATCH");
    // 只改标题（字段本身没变）：实体版本变了，也是 STALE。
    w.exec("UPDATE work_items SET title = '新标题' WHERE project_id = 'PA' AND local_no = 1");
    let e = w
        .svc
        .task_get(&agent(), "ATM", &req(Some(initial.clone())))
        .unwrap_err();
    assert_eq!(e.details["reason"], "STALE");
    w.exec("UPDATE work_items SET description = 'x' || description WHERE project_id = 'PA' AND local_no = 1");
    let e = w
        .svc
        .task_get(&agent(), "ATM", &req(Some(initial)))
        .unwrap_err();
    assert_eq!(
        (e.code, e.details["reason"].clone()),
        (ErrorCode::CONTINUATION_CONFLICT, json!("STALE"))
    );
}

/// S-066 + S-067 + C-15：记录、session 列表的 keyset；session 游标绑定 task_key 过滤。
#[test]
fn s066_s067_c15_record_and_session_lists() {
    let w = world("rd-lists");
    for i in 0..5 {
        rec(&w, "FACT", &format!("事实{i}"), "s", "NORMAL");
    }
    w.exec(&format!(
        "UPDATE records SET updated_at = '{T0}' WHERE project_id = 'PA'"
    ));
    let list = |r: ListRequest| w.svc.record_list(&agent(), "ATM", &r).unwrap();
    let page = list(ListRequest {
        limit: 3,
        ..ListRequest::default()
    });
    let keys: Vec<&str> = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["key"].as_str().unwrap())
        .collect();
    assert_eq!(keys, ["ATM-R-005", "ATM-R-004", "ATM-R-003"]);
    assert_eq!(
        keys_of(&page["items"][0]),
        [
            "key",
            "kind",
            "title",
            "summary",
            "importance",
            "status",
            "topic",
            "subject_key",
            "source_type",
            "updated_at"
        ]
    );
    let rest = list(ListRequest {
        limit: 3,
        cursor: page["next_cursor"].as_str().map(str::to_owned),
        ..ListRequest::default()
    });
    assert_eq!(rest["items"][0]["key"], "ATM-R-002");
    assert_eq!(rest["has_more"], false);
    for bad in [format!("{}x", page["next_cursor"].as_str().unwrap()), {
        // 只改签名的最后一位：载荷完好，只有签名核对能发现。
        let mut t = page["next_cursor"].as_str().unwrap().to_owned();
        let last = t.pop().unwrap();
        t.push(if last == 'A' { 'B' } else { 'A' });
        t
    }] {
        let e = w
            .svc
            .record_list(
                &agent(),
                "ATM",
                &ListRequest {
                    cursor: Some(bad),
                    ..ListRequest::default()
                },
            )
            .unwrap_err();
        assert_eq!(e.details["reason"], "INVALID_OR_TAMPERED");
    }
    // session 列表。
    let sessions = |r: ListRequest| w.svc.session_list(&agent(), "ATM", &r);
    let page = sessions(ListRequest {
        limit: 2,
        ..ListRequest::default()
    })
    .unwrap();
    assert_eq!(page["list"], "sessions");
    let c = page["next_cursor"].as_str().unwrap().to_owned();
    assert!(c.starts_with("sl2."));
    let e = sessions(ListRequest {
        cursor: Some(c.clone()),
        task_key: Some("ATM-T-0001".into()),
        ..ListRequest::default()
    })
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::INVALID_CURSOR);
    let e = w
        .svc
        .session_list(
            &agent(),
            "EMP",
            &ListRequest {
                cursor: Some(c),
                ..ListRequest::default()
            },
        )
        .unwrap_err();
    assert_eq!(e.details["reason"], "INVALID_OR_TAMPERED");
    let none = sessions(ListRequest {
        task_key: Some("garbage".into()),
        ..ListRequest::default()
    })
    .unwrap();
    assert_eq!(none["returned_count"], 0);
    // C-15 的正例：按 task_key 过滤命中正在做它的 session，带同一过滤的游标逐页续读得到同一组。
    let k = w.task("被过滤的任务");
    let other = w.task("别的任务");
    w.s1(p(&k, Operation::Start)).unwrap();
    w.patch_as(&agent(), Some("SX"), vec![p(&other, Operation::Start)])
        .unwrap();
    let ids = |page: &Value| -> Vec<String> {
        page["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["id"].as_str().unwrap().to_owned())
            .collect()
    };
    let whole = ids(&sessions(ListRequest {
        task_key: Some(k.to_lowercase()),
        ..ListRequest::default()
    })
    .unwrap());
    assert!(
        whole.contains(&"S1".to_owned()) && !whole.contains(&"SX".to_owned()),
        "{whole:?}"
    );
    let mut paged = Vec::new();
    let mut cursor = None;
    loop {
        let page = sessions(ListRequest {
            limit: 1,
            cursor: cursor.clone(),
            task_key: Some(k.to_lowercase()),
            ..ListRequest::default()
        })
        .unwrap();
        paged.extend(ids(&page));
        cursor = page["next_cursor"].as_str().map(str::to_owned);
        if page["has_more"] == false {
            break;
        }
    }
    assert_eq!(paged, whole);
}

// ================= 搜索与精确读取 =================

/// S-068 + C-09：词规则、快照、keyset、查询哈希；truncated 只表示预算截断。
#[test]
fn s068_c09_search() {
    let w = world("rd-search");
    for i in 0..6 {
        w.task(&format!("检索目标 alpha {i}"));
    }
    w.task("别的东西");
    let q = |query: &str, limit: usize, cursor: Option<String>| SearchRequest {
        project: Some("ATM".into()),
        query: Some(query.into()),
        limit,
        cursor,
        ..SearchRequest::default()
    };
    let first = search(&w, q("alpha 检索", 4, None));
    assert_eq!(first["returned_count"], 4);
    assert_eq!(first["truncated"], false);
    assert_eq!(first["has_more"], true);
    let c = first["next_cursor"].as_str().unwrap().to_owned();
    assert!(c.starts_with("s2."));
    // 首页之后新增的文档（时间更旧，按排序本该落在后面的页里）不出现：快照按 doc_id 上限。
    w.exec(&format!(
        "INSERT INTO search_docs (project_id, entity_type, entity_id, entity_key, title, updated_at)
           VALUES ('PA', 'WORK_ITEM', 'Z', 'ATM-T-0999', '检索目标 alpha 新来的', '{PAST}')"
    ));
    let second = search(&w, q("alpha 检索", 4, Some(c.clone())));
    assert_eq!(second["returned_count"], 2, "{second}");
    assert_eq!(second["has_more"], false);
    assert!(
        second["hits"]
            .as_array()
            .unwrap()
            .iter()
            .all(|h| !h["title"].as_str().unwrap().contains("新来的"))
    );
    // 新搜索看得到它。
    let fresh = search(&w, q("新来的", 20, None));
    assert_eq!(fresh["returned_count"], 1);
    let e = w.svc.search(&agent(), &q("alpha", 4, Some(c))).unwrap_err();
    assert_eq!(e.code, ErrorCode::INVALID_CURSOR);
    // 结果本来就少于 limit：truncated 仍是 false（C-09）。
    let few = search(&w, q("别的东西", 20, None));
    assert_eq!(
        (few["returned_count"].clone(), few["truncated"].clone()),
        (json!(1), json!(false))
    );
    let none = search(&w, q("不存在的词", 20, None));
    assert_eq!(none["next_step"]["reason"], "NO_MATCH");
    let e = w
        .svc
        .search(&agent(), &q("a b c d e f g h i", 20, None))
        .unwrap_err();
    assert_eq!(
        (e.code, e.details["issue"].clone()),
        (ErrorCode::VALIDATION_ERROR, json!("too_many_terms"))
    );
    // 预算只够一部分：truncated=true，游标落在最后一个返回项上。
    let tight = search(
        &w,
        SearchRequest {
            max_chars: 600,
            ..q("alpha", 20, None)
        },
    );
    assert_eq!(tight["truncated"], true);
    assert!(js(&tight) <= 600);
    // C-09：首页一条都放不下 → 起点游标（不是 null），放宽预算后用它续读拿到这一条。
    w.exec(&format!(
        "INSERT INTO search_docs (project_id, entity_type, entity_id, entity_key, title, body, updated_at)
           VALUES ('PA', 'RECORD', 'BIG', 'ATM-R-900', '超长 zeta', '{}', '{T1}')",
        "长".repeat(400)
    ));
    let none_fit = search(
        &w,
        SearchRequest {
            max_chars: 300,
            ..q("zeta", 20, None)
        },
    );
    assert_eq!(
        (
            none_fit["returned_count"].clone(),
            none_fit["truncated"].clone()
        ),
        (json!(0), json!(true))
    );
    let start = none_fit["next_cursor"].as_str().unwrap().to_owned();
    let retry = search(&w, q("zeta", 20, Some(start)));
    assert_eq!(retry["hits"][0]["entity_key"], "ATM-R-900");
}

/// 03 F-05 + 04 §1.3：全局搜索不看垃圾箱项目，能搜到 quick task；垃圾箱项目的内容不可读。
#[test]
fn f05_global_search_and_trashed_projects() {
    let w = world("rd-global");
    w.task("全局可见 omega");
    w.exec(&format!(
        "INSERT INTO quick_tasks (id, local_no, title, status, actor, created_at, updated_at)
           VALUES ('Q1', 1, '临时 omega', 'OPEN', 'claude', '{T1}', '{T1}');
         INSERT INTO search_docs (project_id, entity_type, entity_id, entity_key, title, updated_at)
           VALUES ('PE', 'WORK_ITEM', 'X', 'EMP-T-0001', '垃圾箱里的 omega', '{T1}');
         UPDATE projects SET lifecycle = 'TRASHED' WHERE id = 'PE';"
    ));
    let g = search(
        &w,
        SearchRequest {
            query: Some("omega".into()),
            ..SearchRequest::default()
        },
    );
    let keys: Vec<&str> = g["hits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["entity_key"].as_str().unwrap())
        .collect();
    assert!(keys.contains(&"Q-0001"));
    assert!(keys.contains(&"ATM-T-0001"));
    assert!(!keys.contains(&"EMP-T-0001"));
    let quick = g["hits"]
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["entity_key"] == "Q-0001")
        .unwrap();
    assert_eq!(quick["project"], Value::Null);
    let e = w
        .svc
        .brief(&agent(), "EMP", &BriefRequest::default())
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::PROJECT_DB_UNAVAILABLE);
    assert_eq!(e.details["retryable"], false);
    assert_eq!(e.details["recovery"]["action"], "restore_project");
}

/// 02 §4.5：完整 key、progress:/session: ULID 的精确读取。
#[test]
fn exact_reads() {
    let w = world("rd-exact");
    let k = w.task("一");
    let r = rec(&w, "FACT", "事实", "摘要", "NORMAL");
    let t = search(
        &w,
        SearchRequest {
            query: Some(k.to_lowercase()),
            ..SearchRequest::default()
        },
    );
    assert_eq!(
        (t["exact"].clone(), t["entity_type"].clone()),
        (json!(true), json!("WORK_ITEM"))
    );
    assert_eq!(t["entity"]["key"], k.as_str());
    let rr = search(
        &w,
        SearchRequest {
            project: Some(" atm ".into()),
            query: Some(r.clone()),
            field_mask: vec!["key".into(), "nope".into()],
            ..SearchRequest::default()
        },
    );
    assert_eq!(rr["entity"], json!({ "key": r }));
    assert_eq!(rr["ignored_fields"], json!(["nope"]));
    let pid = w
        .svc
        .add_progress(
            &agent(),
            &w.target(Some("S1")),
            ProgressRequest::task(&k, "进展"),
        )
        .unwrap()
        .result["progressId"]
        .as_str()
        .unwrap()
        .to_owned();
    let pr = search(
        &w,
        SearchRequest {
            project: Some("ATM".into()),
            query: Some(format!("progress:{}", pid.to_lowercase())),
            ..SearchRequest::default()
        },
    );
    assert_eq!(pr["entity"]["summary"], "进展");
    let e = w
        .svc
        .search(
            &agent(),
            &SearchRequest {
                project: Some("ATM".into()),
                query: Some("session:not-a-ulid".into()),
                ..SearchRequest::default()
            },
        )
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::VALIDATION_ERROR);
    let e = w
        .svc
        .search(
            &agent(),
            &SearchRequest {
                query: Some("progress:01ARZ3NDEKTSV4RRFFQ69G5FAV".into()),
                ..SearchRequest::default()
            },
        )
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::PROJECT_REQUIRED);
}

/// S-069 + C-05 + Q-05：ACK 的 details_cursor 原样调用就能查到实体；rebind 时 session 是后继；没有 projection。
#[test]
fn s069_c05_q05_ack_and_trace() {
    let w = world("rd-ack");
    let k = w.task("一");
    let t = Target::new("PA", Some("S1"), "op-ack");
    let written = w
        .svc
        .patch_work_items(
            &agent(),
            &t,
            vec![p(&k, Operation::Claim), p(&k, Operation::Start)],
        )
        .unwrap();
    let ack = w
        .svc
        .mutation_ack("atm", "work.patch.batch", "op-ack", Some("S1"), &written)
        .unwrap();
    assert!(ack.get("projection").is_none());
    assert_eq!(ack["project"], "ATM");
    assert_eq!(
        ack["entities"],
        json!([{
            "entity_type": "WORK_ITEM", "key": k, "version": w.version(&k), "status": "IN_PROGRESS",
            "waiting_on": null, "claimed_by_session_id": "S1", "claim_lease_until": w.col(&k, "claim_lease_until"),
        }])
    );
    let args = &ack["details_cursor"]["arguments"];
    let trace = search(
        &w,
        SearchRequest {
            project: args["project"].as_str().map(str::to_owned),
            op_id: args["op_id"].as_str().map(str::to_owned),
            session: args["session"].as_str().map(str::to_owned),
            field_mask: vec!["op_id".into(), "entities".into()],
            max_chars: 50_000,
            ..SearchRequest::default()
        },
    );
    assert_eq!(trace["operation"]["entities"], ack["entities"]);
    let e = w
        .svc
        .search(
            &agent(),
            &SearchRequest {
                project: Some("ATM".into()),
                op_id: Some("op-ack".into()),
                session: Some("RC".into()),
                ..SearchRequest::default()
            },
        )
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::OPERATION_NOT_FOUND);
    // C-05：S1 写下的回执由同 lineage 的 S2 重放，ACK 报 S1，details_cursor 原样可查。
    let replay = w
        .svc
        .patch_work_items(
            &agent(),
            &Target::new("PA", Some("S2"), "op-ack"),
            vec![p(&k, Operation::Claim), p(&k, Operation::Start)],
        )
        .unwrap();
    assert!(replay.replayed);
    let ack2 = w
        .svc
        .mutation_ack("ATM", "work.patch.batch", "op-ack", Some("S2"), &replay)
        .unwrap();
    assert_eq!(
        (ack2["session"].clone(), ack2["replayed"].clone()),
        (json!("S1"), json!(true))
    );
    // C-05：心跳超时后 rebind，ACK 与回查都用后继。
    w.exec("UPDATE agent_sessions SET connection_state = 'CLOSED', close_reason = 'HEARTBEAT_TIMEOUT' WHERE id = 'SX'");
    let t = Target::new("PA", Some("SX"), "op-rebound");
    let written = w
        .svc
        .create_record(&agent(), &t, RecordRequest::new("FACT", "f", "s"))
        .unwrap();
    let ack = w
        .svc
        .mutation_ack("ATM", "record.create", "op-rebound", Some("SX"), &written)
        .unwrap();
    let successor = written.rebound_to.clone().unwrap();
    assert_eq!(
        (ack["session"].clone(), ack["session_rebound"].clone()),
        (json!(successor), json!(true))
    );
    let trace = search(
        &w,
        SearchRequest {
            project: Some("ATM".into()),
            op_id: Some("op-rebound".into()),
            session: Some(successor),
            ..SearchRequest::default()
        },
    );
    assert_eq!(trace["operation"]["records"][0]["key"], "ATM-R-001");
    let e = w
        .svc
        .search(
            &agent(),
            &SearchRequest {
                project: Some("ATM".into()),
                query: Some("op:nope".into()),
                ..SearchRequest::default()
            },
        )
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::OPERATION_NOT_FOUND);
}

// ================= 游标格式 =================

/// 00 02 Q-01：2.x 的游标一律 FORMAT_RETIRED；A3：按范围恢复之后旧游标 SCOPE_RESTORED。S-070：项目隔离。
#[test]
fn q01_retired_cursors_and_generations() {
    let w = world("rd-cursor-formats");
    for i in 0..3 {
        w.task(&format!("任务{i}"));
    }
    for old in [
        "b3.x.0.0.0..sig",
        "tl1.e30.sig",
        "rl1.e30.sig",
        "sl1.e30.sig",
        "s1.e30.sig",
        "f2.e30.sig",
    ] {
        let e = task_list(
            &w,
            TaskListRequest {
                cursor: Some(old.into()),
                ..TaskListRequest::default()
            },
        )
        .unwrap_err();
        assert_eq!(
            (e.code, e.details["reason"].clone()),
            (ErrorCode::INVALID_CURSOR, json!("FORMAT_RETIRED")),
            "{old}"
        );
    }
    let e = brief_err(
        &w,
        BriefRequest {
            cursor: Some("b3.abc.0.1.2.R-1:abcdefgh.sig".into()),
            ..BriefRequest::default()
        },
    );
    assert_eq!(e.details["reason"], "FORMAT_RETIRED");
    let page = task_list(
        &w,
        TaskListRequest {
            limit: 1,
            ..TaskListRequest::default()
        },
    )
    .unwrap();
    let c = page["next_cursor"].as_str().unwrap().to_owned();
    w.exec(&format!(
        "INSERT INTO scope_generations (gen, scope_kind, scope_id, reason, epoch, created_at) VALUES (9, 'PROJECT', 'PA', 'RESTORED', 'EA', '{T0}');
         UPDATE projects SET scope_gen = 9 WHERE id = 'PA';"
    ));
    let e = task_list(
        &w,
        TaskListRequest {
            cursor: Some(c),
            ..TaskListRequest::default()
        },
    )
    .unwrap_err();
    assert_eq!(e.details["reason"], "SCOPE_RESTORED");
}

// ================= 补充 =================

/// 02 §4.5：字段续读游标按 7 天桶过期。
#[test]
fn field_cursor_expires() {
    let clock = Arc::new(AtomicI64::new(now_ms()));
    let c = clock.clone();
    let w = world_with(
        "rd-field-expiry",
        Some(Arc::new(move || {
            Timestamp::from_millis(c.load(Ordering::SeqCst))
        })),
    );
    let k = w.task("一");
    w.exec(&format!(
        "UPDATE work_items SET description = '{}' WHERE project_id = 'PA' AND local_no = 1",
        "长".repeat(3000)
    ));
    let req = |cursor: Option<String>| TaskGetRequest {
        view: TaskView::Full,
        field_mask: vec!["description".into()],
        cursor,
        max_chars: 1200,
        ..TaskGetRequest::new(k.clone())
    };
    let first = w.svc.task_get(&agent(), "ATM", &req(None)).unwrap();
    let cursor = first["truncated_fields"][0]["continuation"]["cursor"]
        .as_str()
        .unwrap()
        .to_owned();
    clock.fetch_add(6 * 24 * 60 * 60 * 1000, Ordering::SeqCst);
    w.svc
        .task_get(&agent(), "ATM", &req(Some(cursor.clone())))
        .unwrap();
    clock.fetch_add(9 * 24 * 60 * 60 * 1000, Ordering::SeqCst);
    let e = w
        .svc
        .task_get(&agent(), "ATM", &req(Some(cursor)))
        .unwrap_err();
    assert_eq!(e.details["reason"], "EXPIRED");
}

/// C-17：已关闭的 session 在 brief 身份里带 session_state；在线的、不存在的都不带。
#[test]
fn c17_brief_flags_a_closed_session() {
    let w = world("rd-brief-closed");
    let with = |s: &str| {
        brief(
            &w,
            BriefRequest {
                session: Some(s.into()),
                ..BriefRequest::default()
            },
        )
    };
    assert!(with("S1").get("session_state").is_none());
    w.exec("UPDATE agent_sessions SET connection_state = 'CLOSED' WHERE id = 'S1'");
    assert_eq!(with("S1")["session_state"], "CLOSED");
    let missing = with("NOPE");
    assert_eq!(missing["session_id"], "NOPE");
    assert!(missing.get("session_state").is_none());
}

/// C-12：冻结记录的版本不含 related_records——同 topic 的新记录不让续读失效；记录本身改了才 STALE。
#[test]
fn c12_related_records_do_not_stale_the_cursor() {
    let w = world("rd-brief-related");
    for i in 0..8 {
        w.svc
            .create_record(
                &agent(),
                &w.target(Some("S1")),
                RecordRequest {
                    importance: Some("HIGH".into()),
                    topic: Some("主题".into()),
                    ..RecordRequest::new("DECISION", &format!("决定{i}"), &"很长的摘要".repeat(40))
                },
            )
            .unwrap();
    }
    let first = brief(&w, BriefRequest::default());
    let cursor = first["continuation"]["cursor"].as_str().unwrap().to_owned();
    w.svc
        .create_record(
            &agent(),
            &w.target(Some("S1")),
            RecordRequest {
                importance: Some("LOW".into()),
                topic: Some("主题".into()),
                ..RecordRequest::new("FACT", "旁支", "不进 brief")
            },
        )
        .unwrap();
    let page = brief(
        &w,
        BriefRequest {
            cursor: Some(cursor.clone()),
            ..BriefRequest::default()
        },
    );
    assert!(!page["records"].as_array().unwrap().is_empty());
    w.exec("UPDATE records SET summary = summary || '改' WHERE project_id = 'PA' AND local_no = 1");
    let e = brief_err(
        &w,
        BriefRequest {
            cursor: Some(cursor),
            ..BriefRequest::default()
        },
    );
    assert_eq!(e.details["reason"], "STALE");
}

/// R2：「自己的」任务按 lineage 判断，已完成的不算；别的 agent 看不到。
#[test]
fn r2_own_follows_the_lineage() {
    let w = world("rd-brief-own");
    let a = w.task("一");
    let b = w.task("二");
    w.s1(p(&a, Operation::Claim)).unwrap();
    w.s1(p(&b, Operation::Start)).unwrap();
    w.s1(p(&b, Operation::Complete)).unwrap();
    // 2.x 迁来的行可能在 DONE 上残留领取：照样不算「自己的」。
    w.exec("UPDATE work_items SET claimed_by_session_id = 'S1' WHERE project_id = 'PA' AND local_no = 2");
    let with = |s: &str| {
        brief(
            &w,
            BriefRequest {
                session: Some(s.into()),
                max_chars: 5000,
                ..BriefRequest::default()
            },
        )
    };
    let succ = with("S2");
    assert_eq!(succ["own"], json!([a]));
    assert_eq!(succ["currentTask"]["key"], a.as_str());
    assert_eq!(succ["active"], 1);
    let other = with("SX");
    assert_eq!(other["own"], json!([]));
    assert_eq!(other["currentTask"], Value::Null);
}

/// 02 §4.3：types 只留点名的事件类型。
#[test]
fn delta_types_filter() {
    let w = world("rd-delta-types");
    let k = w.task("一");
    w.s1(p(&k, Operation::Claim)).unwrap();
    let all = delta(
        &w,
        DeltaRequest {
            since_seq: Some(0),
            ..DeltaRequest::default()
        },
    );
    assert!(all["returned_count"].as_i64().unwrap() > 1);
    let only = delta(
        &w,
        DeltaRequest {
            since_seq: Some(0),
            types: vec!["work.created".into()],
            ..DeltaRequest::default()
        },
    );
    assert_eq!(only["returned_count"], 1);
    assert_eq!(only["events"][0]["type"], "work.created");
    assert_eq!(only["events"][0]["key"], k.as_str());
}

/// 02 §4.7：ACK 的实体预览最多 12 项，其余计数并标 entities_truncated。
#[test]
fn ack_preview_is_bounded() {
    let w = world("rd-ack-preview");
    let t = Target::new("PA", Some("S1"), "op-many");
    let written = w
        .svc
        .create_work_items(
            &agent(),
            &t,
            (0..15).map(|i| item(&format!("任务{i}"))).collect(),
        )
        .unwrap();
    let ack = w
        .svc
        .mutation_ack("ATM", "work.create.batch", "op-many", Some("S1"), &written)
        .unwrap();
    assert_eq!(ack["entities"].as_array().unwrap().len(), 12);
    assert_eq!(ack["entity_count"], 15);
    assert_eq!(ack["entities_truncated"], true);
    assert_eq!(ack["replayed"], false);
    assert_eq!(ack["session"], "S1");
    let again = w
        .svc
        .create_work_items(
            &agent(),
            &t,
            (0..15).map(|i| item(&format!("任务{i}"))).collect(),
        )
        .unwrap();
    let ack = w
        .svc
        .mutation_ack("ATM", "work.create.batch", "op-many", Some("S1"), &again)
        .unwrap();
    assert_eq!(ack["replayed"], true);
}

// ================= 追溯补齐（W2h2） =================

/// S-067：session 列表按 (started_at, id) 降序；同一时刻按 id 降序；逐页续读不丢不重。
#[test]
fn s067_session_list_order_and_paging() {
    let w = world("rd-s067");
    let ids = |page: &Value| -> Vec<String> {
        page["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["id"].as_str().unwrap().to_owned())
            .collect()
    };
    let whole = ids(&w
        .svc
        .session_list(&agent(), "ATM", &ListRequest::default())
        .unwrap());
    assert_eq!(whole, ["S2", "RV2", "SX", "S1", "RZ", "RV", "RC"]);
    let mut paged = Vec::new();
    let mut cursor = None;
    loop {
        let page = w
            .svc
            .session_list(
                &agent(),
                "ATM",
                &ListRequest {
                    limit: 2,
                    cursor: cursor.clone(),
                    ..ListRequest::default()
                },
            )
            .unwrap();
        paged.extend(ids(&page));
        cursor = page["next_cursor"].as_str().map(str::to_owned);
        if page["has_more"] == false {
            break;
        }
    }
    assert_eq!(paged, whole);
}

/// S-070：两个项目有相同的任务号、事件序号和 session id，各自只读到自己的。
#[test]
fn s070_projects_with_the_same_keys_stay_apart() {
    let w = world("rd-s070");
    w.exec(&format!(
        "INSERT INTO agent_sessions (project_id, id, agent_id, role, work_state, connection_state, started_at, updated_at)
           VALUES ('PE', 'S1', 'claude', 'PRIMARY', 'IDLE', 'ONLINE', '{T0}', '{T0}')"
    ));
    w.task("甲项目的任务");
    w.svc
        .create_work_items(
            &agent(),
            &Target::new("PE", Some("S1"), "pe-1"),
            vec![CreateItem {
                objective_id: None,
                ..item("乙项目的任务")
            }],
        )
        .unwrap();
    for code in ["ATM", "EMP"] {
        let list = w
            .svc
            .task_list(&agent(), code, &TaskListRequest::default())
            .unwrap();
        let items = list["items"].as_array().unwrap();
        assert_eq!(items.len(), 1, "{code}");
        assert_eq!(items[0]["key"], format!("{code}-T-0001"));
        let d = w
            .svc
            .delta(
                &agent(),
                code,
                &DeltaRequest {
                    since_seq: Some(0),
                    ..DeltaRequest::default()
                },
            )
            .unwrap();
        let keys: Vec<&Value> = d["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| &e["key"])
            .collect();
        assert!(
            keys.contains(&&json!(format!("{code}-T-0001"))),
            "{code}: {keys:?}"
        );
        let other = if code == "ATM" {
            "EMP-T-0001"
        } else {
            "ATM-T-0001"
        };
        assert!(!keys.contains(&&json!(other)), "{code}: {keys:?}");
    }
    let emp_sessions = w
        .svc
        .session_list(&agent(), "EMP", &ListRequest::default())
        .unwrap();
    let ids: Vec<&str> = emp_sessions["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["S1", "EX"]);
}

/// S-086：反馈不进 brief 的精选记录（s050），但在记录列表里照常可见，CRITICAL 也一样。
#[test]
fn s086_feedback_is_listed_but_not_briefed() {
    let w = world("rd-s086");
    w.svc
        .feedback(
            &agent(),
            &w.target(Some("S1")),
            FeedbackRequest {
                summary: "回执看不懂".into(),
                detail: None,
                tool: None,
                severity: Some("critical".into()),
                task_key: None,
            },
        )
        .unwrap();
    let list = w
        .svc
        .record_list(&agent(), "ATM", &ListRequest::default())
        .unwrap();
    assert_eq!(list["items"][0]["importance"], "CRITICAL");
    assert_eq!(list["items"][0]["topic"], "atm-agent-feedback");
    let b = brief(&w, BriefRequest::default());
    assert!(
        b["records"].as_array().is_none_or(|r| r.is_empty()),
        "{}",
        b["records"]
    );
}

/// peer W2 r1 P1-01：查询的前三个字节不在字符边界上（`a中`、`😀`、`abé`）也只是普通查询，不 panic；
/// `op:` 前缀照常按 ASCII 不分大小写识别，后面可以跟非 ASCII。
#[test]
fn unicode_queries_are_plain_searches() {
    let w = world("rd-unicode");
    w.task("a中 混排");
    w.task("abé 变音");
    w.task("表情 😀");
    let q = |query: &str| SearchRequest {
        project: Some("ATM".into()),
        query: Some(query.into()),
        limit: 20,
        ..SearchRequest::default()
    };
    for (query, hits) in [
        ("abc", 0),
        ("中文", 0),
        ("a中", 1),
        ("😀", 1),
        ("abé", 1),
        ("é", 1),
    ] {
        let r = search(&w, q(query));
        assert_eq!(r["returned_count"], hits, "{query}: {r}");
    }
    for query in ["op:中", "OP:😀", "Op:abé"] {
        let e = w.svc.search(&agent(), &q(query)).unwrap_err();
        assert_ne!(e.code, ErrorCode::INTERNAL_ERROR, "{query}");
        assert_ne!(e.code, ErrorCode::VALIDATION_ERROR, "{query}: {e:?}");
    }
}

/// peer W2 r1 P2-01 + 02 §4.4：搜索的查询哈希与任务列表的选择集先做 NFC——同一查询换成组合字符写法
/// （`cafe` + U+0301）仍能用原游标续读；不等价的查询（`cafe`）照旧 INVALID_CURSOR。
#[test]
fn s065_s068_cursors_bind_the_nfc_form() {
    let w = world("rd-nfc");
    // 两条都同时含两种写法：两种查询各自都能命中两条，才谈得上续读。
    w.task("café cafe\u{301} 一");
    w.task("café cafe\u{301} 二");
    let composed = "café";
    let decomposed = "cafe\u{301}";
    assert_ne!(composed, decomposed);
    let q = |query: &str, cursor: Option<String>| SearchRequest {
        project: Some("ATM".into()),
        query: Some(query.into()),
        limit: 1,
        cursor,
        ..SearchRequest::default()
    };
    let first = search(&w, q(composed, None));
    let c = first["next_cursor"].as_str().unwrap().to_owned();
    w.svc
        .search(&agent(), &q(decomposed, Some(c.clone())))
        .unwrap();
    let e = w.svc.search(&agent(), &q("cafe", Some(c))).unwrap_err();
    assert_eq!(e.code, ErrorCode::INVALID_CURSOR);

    let l = |query: &str, cursor: Option<String>| TaskListRequest {
        query: Some(query.into()),
        limit: 1,
        cursor,
        ..TaskListRequest::default()
    };
    let first = task_list(&w, l(composed, None)).unwrap();
    let c = first["next_cursor"].as_str().unwrap().to_owned();
    task_list(&w, l(decomposed, Some(c.clone()))).unwrap();
    let e = task_list(&w, l("cafe", Some(c))).unwrap_err();
    assert_eq!(e.code, ErrorCode::INVALID_CURSOR);
}
