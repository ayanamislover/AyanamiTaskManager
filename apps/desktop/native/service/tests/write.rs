//! 写入流水线的验收（W2b；03 P-004，10 R3′、R4、R7‴）。
//!
//! 「零写入」一律按整库逐表逐行的快照比对，不只数回执或事件。

use atm_domain::capability::Capability;
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::principal::{JobId, Principal, UiSurface};
use atm_service::fp::{self, JsValue};
use atm_service::receipts::ReceiptScope;
use atm_service::write::{
    Author, Family, FpInput, Service, SessionRef, WriteCtx, WriteRequest, Written,
};
use atm_store::backup::create_backup;
use atm_store::events::{NewEvent, append_event};
use atm_store::restore::{RestoreOptions, restore_project};
use atm_store::{Config, Stats, Store};
use rusqlite::{Transaction, params};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const T0: &str = "2026-10-03T00:00:00.000Z";
const T1: &str = "2026-10-03T01:00:00.000Z";
const T2: &str = "2026-10-03T02:00:00.000Z";
const T3: &str = "2026-10-03T03:00:00.000Z";
/// 种子里给墓碑用的恢复世代。
const TOMB_GEN: i64 = 9;

struct World {
    svc: Service,
    backups: PathBuf,
    calls: Arc<AtomicUsize>,
}

fn world(name: &str) -> World {
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("target")
        });
    let dir = target.join("service-tests").join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let store = Store::open(
        &dir.join("atm.sqlite"),
        Config {
            idle_checkpoint: Duration::from_secs(3600),
            ..Config::default()
        },
    )
    .unwrap();
    store
        .write(|tx| {
            tx.execute_batch(&format!(
                "INSERT INTO app_meta (singleton, schema_version, data_root_id, generation, instance_epoch, scope_gen_counter, created_at, updated_at)
                   VALUES (1, 1, 'ROOT', 'G', 'EPOCH-1', {TOMB_GEN}, '{T0}', '{T0}');
                 INSERT INTO scope_generations (gen, scope_kind, scope_id, reason, epoch, created_at) VALUES
                   (1, 'PROJECT', 'PA', 'CREATED', 'EA', '{T0}'),
                   (2, 'PROJECT', 'PB', 'CREATED', 'EB', '{T0}'),
                   (3, 'KNOWLEDGE', 'KDB', 'CREATED', 'EK', '{T0}'),
                   ({TOMB_GEN}, 'PROJECT', 'PA', 'RESTORED', 'EA', '{T0}');
                 INSERT INTO knowledge_meta (singleton, database_id, generation, sequence, scope_gen) VALUES (1, 'KDB', 'KG0', 0, 3);"
            ))?;
            for (id, g, e) in [("PA", 1, "EA"), ("PB", 2, "EB")] {
                tx.execute(
                    "INSERT INTO projects (id, code, name, lifecycle, health, meta_version, scope_gen, epoch, created_at, updated_at)
                     VALUES (?1, ?1, ?1, 'ACTIVE', 'ON_TRACK', 0, ?2, ?3, ?4, ?4)",
                    params![id, g, e, T0],
                )?;
                for agent in ["claude", "codex"] {
                    tx.execute(
                        "INSERT INTO agents (project_id, id, display_name, client_kind, created_at, updated_at) VALUES (?1, ?2, ?2, 'cli', ?3, ?3)",
                        params![id, agent, T0],
                    )?;
                }
            }
            // S0 → S1、S2（兄弟后继）；SR 是 S0 的后继但 role 不同；SX 是另一个 agent；PB0 在另一个项目。
            for (project, id, agent, role, pred, at) in [
                ("PA", "S0", "claude", "PRIMARY", None, T0),
                ("PA", "S1", "claude", "PRIMARY", Some("S0"), T1),
                ("PA", "S2", "claude", "PRIMARY", Some("S0"), T1),
                ("PA", "SR", "claude", "REVIEWER", Some("S0"), T1),
                ("PA", "SX", "codex", "PRIMARY", None, T0),
                ("PB", "PB0", "claude", "PRIMARY", None, T0),
            ] {
                tx.execute(
                    "INSERT INTO agent_sessions (project_id, id, agent_id, role, work_state, connection_state, started_at, updated_at, predecessor_session_id)
                     VALUES (?1, ?2, ?3, ?4, 'IDLE', 'ONLINE', ?5, ?5, ?6)",
                    params![project, id, agent, role, at, pred],
                )?;
            }
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    World {
        svc: Service::new(store),
        backups: dir.join("backups"),
        calls: Arc::new(AtomicUsize::new(0)),
    }
}

fn agent() -> Principal {
    Principal::authenticated_agent(None)
}

fn user() -> Principal {
    Principal::trusted_ui(UiSurface::Tray)
}

/// 测试用的指纹输入：业务字段 title，另带作者 session（这样「按原作者重建」是否生效会直接反映在结果上）。
fn title_fp(title: &str) -> FpInput {
    let title = title.to_owned();
    Box::new(
        move |_: &rusqlite::Transaction<'_>, family: Family, author: &Author| {
            let by = JsValue::opt(author.session.clone().map(JsValue::String));
            Some(match family {
                Family::CanonV2 => JsValue::object([("title", JsValue::str(&title)), ("by", by)]),
                Family::KernelV1 => {
                    JsValue::object([("title", JsValue::str(&title)), ("actorSessionId", by)])
                }
                Family::KnowledgeV1 => JsValue::object([("title", JsValue::str(&title))]),
            })
        },
    )
}

fn canon(title: &str, by: Option<&str>) -> String {
    fp::canon_v2(&JsValue::object([
        ("title", JsValue::str(title)),
        ("by", JsValue::opt(by.map(JsValue::str))),
    ]))
}

fn req(
    cap: Capability,
    scope: ReceiptScope,
    session: Option<&str>,
    op: &str,
    fingerprint: FpInput,
) -> WriteRequest {
    let project = match &scope.kind {
        atm_service::receipts::ScopeKind::Project => scope.id.clone(),
        _ => "PA".to_owned(),
    };
    WriteRequest {
        capability: cap,
        operation: cap.as_str(),
        op_id: op.to_owned(),
        scope,
        session: session.map(|s| SessionRef {
            project_id: project,
            session_id: s.to_owned(),
        }),
        actor: None,
        expected_generation: None,
        fingerprint,
        compat_v1: None,
        replay_guard: None,
    }
}

/// 项目里的一次记录写入（RecordCreate），由 `session` 发出。
fn record(session: Option<&str>, op: &str, title: &str) -> WriteRequest {
    req(
        Capability::RecordCreate,
        ReceiptScope::project("PA"),
        session,
        op,
        title_fp(title),
    )
}

/// 业务动作：在目标项目里追加一条事件（GLOBAL / 知识库不写），返回结果。记下被调用的次数。
fn act(
    w: &World,
    title: &str,
) -> impl FnOnce(&Transaction<'_>, &WriteCtx) -> Result<Value, DomainError> + Send + 'static {
    let calls = w.calls.clone();
    let title = title.to_owned();
    move |tx, ctx| {
        calls.fetch_add(1, Ordering::SeqCst);
        let mut out = json!({ "title": title });
        if ctx.scope.kind == atm_service::receipts::ScopeKind::Project {
            let payload = json!({ "title": title }).to_string();
            let at = ctx.now.to_string();
            let e = append_event(
                tx,
                &NewEvent {
                    project_id: &ctx.scope.id,
                    kind: "record.created",
                    actor_type: "AGENT",
                    actor_id: ctx.author.agent.as_deref().unwrap_or("USER"),
                    session_id: ctx.author.session.as_deref(),
                    aggregate_type: "RECORD",
                    aggregate_id: "R1",
                    correlation_id: None,
                    op_id: Some(&ctx.op_id),
                    payload_json: &payload,
                    at: &at,
                },
            )
            .map_err(|e| DomainError::new(ErrorCode::INTERNAL_ERROR, e.to_string()))?;
            out["seq"] = json!(e.seq);
        }
        Ok(out)
    }
}

fn write(w: &World, p: &Principal, r: WriteRequest, title: &str) -> Result<Written, DomainError> {
    w.svc.write(p, r, act(w, title))
}

/// 整库快照：每张表的每一行。
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

fn assert_zero_writes(w: &World, before: &[(String, Vec<String>)]) {
    let after = snapshot(w);
    for ((name, a), (_, b)) in before.iter().zip(&after) {
        assert_eq!(a, b, "table {name} changed");
    }
    assert_eq!(before.len(), after.len());
}

fn count(w: &World, sql: &str) -> i64 {
    w.svc
        .store()
        .read(|tx| tx.query_row(sql, [], |r| r.get(0)))
        .map_err(|e| format!("{e:?}"))
        .unwrap()
}

/// 直接写一行「旧数据」回执（兄弟后继各写各的、转换来的 2.x 行等）。
#[derive(Default)]
struct Raw<'a> {
    scope: (&'a str, &'a str),
    ns: Option<(&'a str, &'a str)>,
    op: Option<&'a str>,
    legacy_key: Option<&'a str>,
    legacy_class: Option<&'a str>,
    operation: &'a str,
    family: &'a str,
    fingerprint: String,
    receipt: &'a str,
    author: (Option<&'a str>, Option<&'a str>),
    actor_session: Option<&'a str>,
    generation: Option<i64>,
    tombstoned: bool,
}

fn raw(w: &World, r: Raw<'_>) -> i64 {
    let fp_v = if r.family == "canon-v2" { 2 } else { 1 };
    let (state, tomb, tomb_at) = if r.tombstoned {
        ("TOMBSTONED", Some(TOMB_GEN), Some(T2))
    } else {
        ("VALID", None, None)
    };
    let p = (
        r.scope.0.to_owned(),
        r.scope.1.to_owned(),
        r.ns.map(|n| (n.0.to_owned(), n.1.to_owned())),
        r.op.map(str::to_owned),
        r.legacy_key.map(str::to_owned),
        r.legacy_class.map(str::to_owned),
        r.operation.to_owned(),
        r.family.to_owned(),
        r.fingerprint,
        r.receipt.to_owned(),
        (r.author.0.map(str::to_owned), r.author.1.map(str::to_owned)),
        r.actor_session.map(str::to_owned),
        r.generation,
    );
    w.svc
        .store()
        .write(move |tx| {
            let (sk, sid, ns, op, lk, lc, operation, family, fingerprint, receipt, author, actor, generation) = p;
            tx.execute(
                "INSERT INTO idempotency_receipts (scope_kind, scope_id, ns_kind, ns_id, op_id, legacy_key, legacy_class, actor_session_id,
                                                   operation, fp_v, fp_family, fingerprint, receipt_json, author_agent, author_session,
                                                   scope_generation, created_at, state, tombstoned_by_gen, tombstoned_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
                params![
                    sk,
                    sid,
                    ns.as_ref().map(|n| n.0.clone()),
                    ns.as_ref().map(|n| n.1.clone()),
                    op,
                    lk,
                    lc,
                    actor,
                    operation,
                    fp_v,
                    family,
                    fingerprint,
                    receipt,
                    author.0,
                    author.1,
                    generation,
                    T1,
                    state,
                    tomb,
                    tomb_at
                ],
            )?;
            Ok::<_, rusqlite::Error>(tx.last_insert_rowid())
        })
        .unwrap()
}

/// S 在 PA 里用 canon-v2 写下的旧行。
fn sibling_row(
    w: &World,
    session: &str,
    op: &str,
    title: &str,
    receipt: &str,
    tombstoned: bool,
) -> i64 {
    raw(
        w,
        Raw {
            scope: ("PROJECT", "PA"),
            ns: Some(("SESSION", session)),
            op: Some(op),
            operation: "record.create",
            family: "canon-v2",
            fingerprint: canon(title, Some(session)),
            receipt,
            author: (Some("claude"), Some(session)),
            actor_session: Some(session),
            generation: Some(1),
            tombstoned,
            ..Raw::default()
        },
    )
}

fn code(r: Result<Written, DomainError>) -> DomainError {
    match r {
        Ok(w) => panic!("expected an error, got {w:?}"),
        Err(e) => e,
    }
}

// ===== 能力检查先于一切 =====

#[test]
fn a_refused_capability_writes_nothing_and_never_reaches_the_store() {
    let w = world("refused-capability");
    let before = snapshot(&w);
    let archive = || {
        req(
            Capability::ProjectArchive,
            ReceiptScope::project("PA"),
            None,
            "a1",
            title_fp("x"),
        )
    };
    let e = code(write(&w, &agent(), archive(), "x"));
    assert_eq!(e.code, ErrorCode::USER_AUTHORIZATION_REQUIRED);
    let e = code(write(
        &w,
        &Principal::system_job(JobId::Maintenance),
        record(None, "a1", "x"),
        "x",
    ));
    assert_eq!(e.code, ErrorCode::PRINCIPAL_CAPABILITY_DENIED);
    assert_eq!(w.calls.load(Ordering::SeqCst), 0);
    assert_zero_writes(&w, &before);
    // 先于读库、先于回执：存储关掉之后，拒绝照旧是能力错误，而不是 SERVICE_UNAVAILABLE。
    let reads = Stats::get(&w.svc.store().stats().reads);
    w.svc.store().shutdown();
    let e = code(write(&w, &agent(), archive(), "x"));
    assert_eq!(e.code, ErrorCode::USER_AUTHORIZATION_REQUIRED);
    assert_eq!(Stats::get(&w.svc.store().stats().reads), reads);
    let e = code(write(&w, &agent(), record(Some("S0"), "a2", "x"), "x"));
    assert_eq!(e.code, ErrorCode::SERVICE_UNAVAILABLE);
}

/// 已经由 User 提交过的 op_id，Agent 拿同一个 op_id 也换不来重放：能力检查在回执查找之前。
#[test]
fn a_refused_capability_is_refused_even_when_a_receipt_exists() {
    let w = world("refused-before-replay");
    let archive = || {
        req(
            Capability::ProjectArchive,
            ReceiptScope::project("PA"),
            None,
            "u1",
            title_fp("x"),
        )
    };
    write(&w, &user(), archive(), "x").unwrap();
    let before = snapshot(&w);
    let e = code(write(&w, &agent(), archive(), "x"));
    assert_eq!(e.code, ErrorCode::USER_AUTHORIZATION_REQUIRED);
    assert_zero_writes(&w, &before);
}

#[test]
fn an_agent_without_a_session_is_told_to_begin() {
    let w = world("session-required");
    let before = snapshot(&w);
    let e = code(write(&w, &agent(), record(None, "s1", "x"), "x"));
    assert_eq!(e.code, ErrorCode::SESSION_REQUIRED);
    assert!(e.message.contains("atm_begin"), "{}", e.message);
    let e = code(write(&w, &agent(), record(Some("NOPE"), "s1", "x"), "x"));
    assert_eq!(e.code, ErrorCode::SESSION_NOT_FOUND);
    // PA 的 session 写 PB：不在 PB 里。
    let pb = req(
        Capability::RecordCreate,
        ReceiptScope::project("PB"),
        None,
        "s1",
        title_fp("x"),
    );
    let pb = WriteRequest {
        session: Some(SessionRef {
            project_id: "PA".into(),
            session_id: "S0".into(),
        }),
        ..pb
    };
    let e = code(write(&w, &agent(), pb, "x"));
    assert_eq!(e.code, ErrorCode::SESSION_NOT_FOUND);
    assert_eq!(w.calls.load(Ordering::SeqCst), 0);
    assert_zero_writes(&w, &before);
}

// ===== 重放、冲突、回滚 =====

#[test]
fn a_replay_returns_the_original_receipt_and_adds_nothing() {
    let w = world("replay");
    let first = write(&w, &agent(), record(Some("S0"), "op-1", "hello"), "hello").unwrap();
    assert!(!first.replayed);
    assert_eq!(first.result, json!({ "title": "hello", "seq": 1 }));
    assert_eq!(count(&w, "SELECT count(*) FROM events"), 1);
    let before = snapshot(&w);
    let again = write(&w, &agent(), record(Some("S0"), "op-1", "hello"), "hello").unwrap();
    assert!(again.replayed);
    assert_eq!(again.result, first.result);
    assert_eq!(again.receipt_id, first.receipt_id);
    assert_eq!(w.calls.load(Ordering::SeqCst), 1);
    assert_zero_writes(&w, &before);
    // 回执行的内容：3.0 新写入是 canon-v2，作者与世代都记下了。
    let row: (String, String, String, Option<String>, Option<String>, Option<i64>) = w
        .svc
        .store()
        .read(|tx| {
            tx.query_row(
                "SELECT fp_family, fingerprint, receipt_json, author_agent, author_session, scope_generation FROM idempotency_receipts",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
        })
        .map_err(|e| format!("{e:?}"))
        .unwrap();
    assert_eq!(row.0, "canon-v2");
    assert_eq!(row.1, canon("hello", Some("S0")));
    assert_eq!(serde_json::from_str::<Value>(&row.2).unwrap(), first.result);
    assert_eq!(
        (row.3.as_deref(), row.4.as_deref(), row.5),
        (Some("claude"), Some("S0"), Some(1))
    );
}

#[test]
fn the_same_op_id_with_a_different_request_always_conflicts() {
    let w = world("conflict");
    write(&w, &agent(), record(Some("S0"), "op-1", "hello"), "hello").unwrap();
    let before = snapshot(&w);
    let e = code(write(
        &w,
        &agent(),
        record(Some("S0"), "op-1", "other"),
        "other",
    ));
    assert_eq!(e.code, ErrorCode::IDEMPOTENCY_CONFLICT);
    assert_eq!(e.details.get("reason"), None);
    assert_eq!(e.details["op_id"], "op-1");
    // operation 不同也是冲突（同一个 scope、同一个命名空间）。
    let plan = req(
        Capability::WorkPlan,
        ReceiptScope::project("PA"),
        Some("S0"),
        "op-1",
        title_fp("hello"),
    );
    let e = code(write(&w, &agent(), plan, "hello"));
    assert_eq!(e.code, ErrorCode::IDEMPOTENCY_CONFLICT);
    assert_eq!(w.calls.load(Ordering::SeqCst), 1);
    assert_zero_writes(&w, &before);
}

#[test]
fn a_failed_action_rolls_back_and_leaves_no_receipt() {
    let w = world("rollback");
    let before = snapshot(&w);
    let calls = w.calls.clone();
    let failing = move |tx: &Transaction<'_>, ctx: &WriteCtx| -> Result<Value, DomainError> {
        calls.fetch_add(1, Ordering::SeqCst);
        let at = ctx.now.to_string();
        append_event(
            tx,
            &NewEvent {
                project_id: "PA",
                kind: "record.created",
                actor_type: "AGENT",
                actor_id: "claude",
                session_id: Some("S0"),
                aggregate_type: "RECORD",
                aggregate_id: "R1",
                correlation_id: None,
                op_id: Some("op-1"),
                payload_json: "{}",
                at: &at,
            },
        )
        .unwrap();
        Err(DomainError::new(ErrorCode::VERSION_CONFLICT, "stale"))
    };
    let e = code(
        w.svc
            .write(&agent(), record(Some("S0"), "op-1", "hello"), failing),
    );
    assert_eq!(e.code, ErrorCode::VERSION_CONFLICT);
    assert_zero_writes(&w, &before);
    // 没有留下回执：同一个 op_id 之后照常执行。
    let ok = write(&w, &agent(), record(Some("S0"), "op-1", "hello"), "hello").unwrap();
    assert!(!ok.replayed);
}

/// 不同主体、不同 agent、不同 scope 的同一个 op_id 互不相干。
#[test]
fn namespaces_and_scopes_keep_op_ids_apart() {
    let w = world("namespaces");
    write(&w, &agent(), record(Some("S0"), "x", "a"), "a").unwrap();
    // 另一个 agent 的 session。
    assert!(
        !write(&w, &agent(), record(Some("SX"), "x", "b"), "b")
            .unwrap()
            .replayed
    );
    // User 在同一个项目。
    assert!(
        !write(&w, &user(), record(None, "x", "c"), "c")
            .unwrap()
            .replayed
    );
    // User 在另一个项目。
    let pb = req(
        Capability::RecordCreate,
        ReceiptScope::project("PB"),
        None,
        "x",
        title_fp("d"),
    );
    assert!(!write(&w, &user(), pb, "d").unwrap().replayed);
    // 无 session 的 Agent 写 GLOBAL，与 User 的 GLOBAL 写入分开。
    let quick = |actor: Option<&str>| WriteRequest {
        actor: actor.map(str::to_owned),
        ..req(
            Capability::QuickCreate,
            ReceiptScope::global(),
            None,
            "x",
            title_fp("q"),
        )
    };
    assert!(!write(&w, &agent(), quick(None), "q").unwrap().replayed);
    assert!(write(&w, &agent(), quick(None), "q").unwrap().replayed);
    assert!(
        !write(&w, &agent(), quick(Some("USER")), "q")
            .unwrap()
            .replayed,
        "an agent actor never lands in USER"
    );
    assert!(!write(&w, &user(), quick(None), "q").unwrap().replayed);
    assert_eq!(w.calls.load(Ordering::SeqCst), 7);
}

// ===== lineage（R3′ 的验收向量）=====

#[test]
fn a_successor_retrying_its_predecessors_write_replays_it() {
    let w = world("lineage-successor");
    let first = write(&w, &agent(), record(Some("S0"), "x", "a"), "a").unwrap();
    let before = snapshot(&w);
    // 指纹里带作者：只有按原作者（S0）重建才匹配。
    for s in ["S1", "S2"] {
        let again = write(&w, &agent(), record(Some(s), "x", "a"), "a").unwrap();
        assert!(again.replayed, "{s}");
        assert_eq!(again.result, first.result);
    }
    // 后继发来不同的请求：没有精确命中，唯一候选不匹配。
    let e = code(write(&w, &agent(), record(Some("S1"), "x", "b"), "b"));
    assert_eq!(e.code, ErrorCode::IDEMPOTENCY_CONFLICT);
    assert_eq!(e.details["reason"], "AMBIGUOUS_LINEAGE");
    assert_zero_writes(&w, &before);
}

#[test]
fn cross_role_edges_are_not_lineage() {
    let w = world("lineage-role");
    write(&w, &agent(), record(Some("S0"), "x", "a"), "a").unwrap();
    // SR 的前序是 S0，但 role 不同：不是同一个 lineage，S0 的回执不是候选。
    assert!(
        !write(&w, &agent(), record(Some("SR"), "x", "b"), "b")
            .unwrap()
            .replayed
    );
}

#[test]
fn siblings_that_wrote_different_requests_are_ambiguous() {
    let w = world("lineage-siblings-differ");
    sibling_row(&w, "S1", "x", "a", r#"{"title":"a"}"#, false);
    sibling_row(&w, "S2", "x", "b", r#"{"title":"b"}"#, false);
    let before = snapshot(&w);
    let e = code(write(&w, &agent(), record(Some("S0"), "x", "a"), "a"));
    assert_eq!(e.code, ErrorCode::IDEMPOTENCY_CONFLICT);
    assert_eq!(e.details["reason"], "AMBIGUOUS_LINEAGE");
    let sessions: Vec<&str> = e.details["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["session"].as_str().unwrap())
        .collect();
    assert_eq!(sessions, ["S1", "S2"]);
    assert_zero_writes(&w, &before);
}

#[test]
fn siblings_that_wrote_the_same_request_replay_the_earliest() {
    let w = world("lineage-siblings-same");
    let first = sibling_row(&w, "S1", "x", "a", r#"{"title":"a","seq":7}"#, false);
    sibling_row(&w, "S2", "x", "a", r#"{"title":"a","seq":7}"#, false);
    let before = snapshot(&w);
    let r = write(&w, &agent(), record(Some("S0"), "x", "a"), "a").unwrap();
    assert!(r.replayed);
    assert_eq!(r.receipt_id, first);
    assert_eq!(r.result, json!({ "title": "a", "seq": 7 }));
    assert_zero_writes(&w, &before);
    // 回执原文不同（例如各自写出了不同的序号）：仍是 AMBIGUOUS。
    let w = world("lineage-siblings-same-request-different-receipt");
    sibling_row(&w, "S1", "x", "a", r#"{"title":"a","seq":7}"#, false);
    sibling_row(&w, "S2", "x", "a", r#"{"title":"a","seq":8}"#, false);
    let e = code(write(&w, &agent(), record(Some("S0"), "x", "a"), "a"));
    assert_eq!(e.details["reason"], "AMBIGUOUS_LINEAGE");
}

#[test]
fn tombstones_in_the_lineage() {
    // 全是墓碑 → UNDONE。
    let w = world("lineage-all-tombstoned");
    sibling_row(&w, "S1", "x", "a", r#"{"title":"a"}"#, true);
    sibling_row(&w, "S2", "x", "a", r#"{"title":"a"}"#, true);
    let before = snapshot(&w);
    let e = code(write(&w, &agent(), record(Some("S0"), "x", "a"), "a"));
    assert_eq!(e.code, ErrorCode::OPERATION_UNDONE_BY_RESTORE);
    assert_eq!(e.details["restored_generation"], TOMB_GEN);
    assert_zero_writes(&w, &before);
    // VALID 与 TOMBSTONED 混合 → AMBIGUOUS，原文相同也不能绕过墓碑。
    let w = world("lineage-mixed");
    sibling_row(&w, "S1", "x", "a", r#"{"title":"a"}"#, false);
    sibling_row(&w, "S2", "x", "a", r#"{"title":"a"}"#, true);
    let before = snapshot(&w);
    let e = code(write(&w, &agent(), record(Some("S0"), "x", "a"), "a"));
    assert_eq!(e.details["reason"], "AMBIGUOUS_LINEAGE");
    let states: Vec<&str> = e.details["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["state"].as_str().unwrap())
        .collect();
    assert_eq!(states, ["VALID", "TOMBSTONED"]);
    assert_zero_writes(&w, &before);
}

/// 请求方自己的键精确命中时只看这一条，lineage 里别的候选不参与。
#[test]
fn an_exact_hit_is_judged_alone() {
    let w = world("lineage-exact");
    sibling_row(&w, "S1", "x", "b", r#"{"title":"b"}"#, false);
    sibling_row(&w, "S0", "x", "a", r#"{"title":"a"}"#, false);
    let before = snapshot(&w);
    // S1 自己的那条不匹配：普通冲突，没有 reason；S0 那条匹配也不改变结果。
    let e = code(write(&w, &agent(), record(Some("S1"), "x", "a"), "a"));
    assert_eq!(e.code, ErrorCode::IDEMPOTENCY_CONFLICT);
    assert_eq!(e.details.get("reason"), None);
    // S1 自己的那条匹配：REPLAY，S0 那条不匹配也不改变结果。
    let r = write(&w, &agent(), record(Some("S1"), "x", "b"), "b").unwrap();
    assert!(r.replayed);
    assert_eq!(r.result, json!({ "title": "b" }));
    // S1 自己的那条是墓碑：UNDONE。
    let w2 = world("lineage-exact-tombstone");
    sibling_row(&w2, "S1", "x", "a", r#"{"title":"a"}"#, true);
    sibling_row(&w2, "S0", "x", "a", r#"{"title":"a"}"#, false);
    let e = code(write(&w2, &agent(), record(Some("S1"), "x", "a"), "a"));
    assert_eq!(e.code, ErrorCode::OPERATION_UNDONE_BY_RESTORE);
    assert_zero_writes(&w, &before);
}

// ===== 转换来的 2.x 行 =====

#[test]
fn converted_kernel_rows_replay_byte_for_byte() {
    let w = world("kernel-v1");
    let v1 = fp::kernel_v1(&JsValue::object([
        ("title", JsValue::str("a")),
        ("actorSessionId", JsValue::str("S0")),
    ]))
    .unwrap();
    let legacy = r#"{"ok":true,"record":{"id":"R-1"}}"#;
    raw(
        &w,
        Raw {
            scope: ("PROJECT", "PA"),
            ns: Some(("SESSION", "S0")),
            op: Some("k1"),
            legacy_key: Some("S0:k1"),
            legacy_class: Some("AGENT"),
            operation: "record.create",
            family: "kernel-v1",
            fingerprint: v1,
            receipt: legacy,
            actor_session: Some("S0"),
            generation: Some(1),
            ..Raw::default()
        },
    );
    let before = snapshot(&w);
    // 后继重试：按候选的 actor_session_id（S0）重建 kernel-v1 指纹。
    let r = write(&w, &agent(), record(Some("S1"), "k1", "a"), "a").unwrap();
    assert!(r.replayed);
    assert_eq!(r.result, serde_json::from_str::<Value>(legacy).unwrap());
    assert_zero_writes(&w, &before);
}

#[test]
fn a_kernel_key_that_cannot_be_reproduced_conflicts_with_zero_writes() {
    let w = world("kernel-v1-unsupported");
    raw(
        &w,
        Raw {
            scope: ("PROJECT", "PA"),
            ns: Some(("SESSION", "S0")),
            op: Some("k1"),
            legacy_key: Some("S0:k1"),
            legacy_class: Some("AGENT"),
            operation: "record.create",
            family: "kernel-v1",
            fingerprint: "0".repeat(64),
            receipt: "{}",
            actor_session: Some("S0"),
            generation: Some(1),
            ..Raw::default()
        },
    );
    let before = snapshot(&w);
    let odd: FpInput = Box::new(|_, _, _| Some(JsValue::object([("标题", JsValue::str("a"))])));
    let e = code(write(
        &w,
        &agent(),
        req(
            Capability::RecordCreate,
            ReceiptScope::project("PA"),
            Some("S0"),
            "k1",
            odd,
        ),
        "a",
    ));
    assert_eq!(e.code, ErrorCode::IDEMPOTENCY_CONFLICT);
    assert_eq!(e.details["reason"], "FP_V1_UNSUPPORTED_KEY");
    assert_eq!(e.details["key"], "标题");
    assert_eq!(w.calls.load(Ordering::SeqCst), 0);
    assert_zero_writes(&w, &before);
}

/// 旧族表达不了这次请求（A3 的可比性检查）：与该候选不是同一请求。
#[test]
fn a_request_the_old_family_cannot_express_does_not_match_it() {
    let w = world("not-comparable");
    raw(
        &w,
        Raw {
            scope: ("PROJECT", "PA"),
            ns: Some(("SESSION", "S0")),
            op: Some("k1"),
            legacy_key: Some("S0:k1"),
            legacy_class: Some("AGENT"),
            operation: "record.create",
            family: "kernel-v1",
            fingerprint: "0".repeat(64),
            receipt: "{}",
            actor_session: Some("S0"),
            generation: Some(1),
            ..Raw::default()
        },
    );
    let only_v2: FpInput = Box::new(|_, family, _| {
        (family == Family::CanonV2).then(|| JsValue::object([("a", JsValue::Null)]))
    });
    let e = code(write(
        &w,
        &agent(),
        req(
            Capability::RecordCreate,
            ReceiptScope::project("PA"),
            Some("S0"),
            "k1",
            only_v2,
        ),
        "a",
    ));
    assert_eq!(e.code, ErrorCode::IDEMPOTENCY_CONFLICT);
    assert_eq!(e.details.get("reason"), None);
}

#[test]
fn converted_knowledge_rows_replay_for_the_lineage_and_the_user() {
    let w = world("knowledge-v1");
    let agent_key = fp::knowledge_agent_legacy_key("PA", "S0", "kop");
    fn knowledge_row<'a>(key: &'a str, receipt: &'a str) -> Raw<'a> {
        Raw {
            scope: ("KNOWLEDGE", "KDB"),
            legacy_key: Some(key),
            operation: "*",
            family: "knowledge-v1",
            fingerprint: fp::knowledge_v1(&JsValue::object([("title", JsValue::str("K"))])),
            receipt,
            generation: Some(3),
            ..Raw::default()
        }
    }
    raw(&w, knowledge_row(&agent_key, r#"{"revision":3}"#));
    raw(&w, knowledge_row("uop", r#"{"revision":4}"#));
    let save = |session: &str, op: &str, title: &str| {
        req(
            Capability::KnowledgeAgentSave,
            ReceiptScope::knowledge("KDB"),
            Some(session),
            op,
            title_fp(title),
        )
    };
    // 转换来的知识哈希行，由后继 session 重试 → REPLAY 原修订（R3′ 验收向量）。
    let r = write(&w, &agent(), save("S1", "kop", "K"), "K").unwrap();
    assert!(r.replayed);
    assert_eq!(r.result, json!({ "revision": 3 }));
    let e = code(write(&w, &agent(), save("S1", "kop", "other"), "other"));
    assert_eq!(e.details["reason"], "AMBIGUOUS_LINEAGE");
    // 另一个 agent 的同名 op_id：旧键里含 session，不是候选。
    assert!(
        !write(&w, &agent(), save("SX", "kop", "K"), "K")
            .unwrap()
            .replayed
    );
    // User 的旧键是 op_id 原值。
    let edit = req(
        Capability::KnowledgeUserEdit,
        ReceiptScope::knowledge("KDB"),
        None,
        "uop",
        title_fp("K"),
    );
    let r = write(&w, &user(), edit, "K").unwrap();
    assert!(r.replayed);
    assert_eq!(r.result, json!({ "revision": 4 }));
    // Agent 拿 User 的原值键也换不来重放。
    assert!(
        !write(&w, &agent(), save("S0", "uop", "K"), "K")
            .unwrap()
            .replayed
    );
}

// ===== 恢复：墓碑与世代屏障（R4）=====

/// R4 的时间线：备份 B → S1 写 X、响应丢失 → 恢复 B → S0 重试 X，经 lineage 找到 S1:X 的墓碑。
#[test]
fn a_write_undone_by_a_restore_is_reported_not_redone() {
    let w = world("restore-timeline");
    let b = create_backup(w.svc.store(), &w.backups, "MANUAL", T1)
        .unwrap()
        .id;
    write(&w, &agent(), record(Some("S1"), "X", "a"), "a").unwrap();
    let opts = RestoreOptions {
        backups_root: &w.backups,
        at: T3,
        pin_until: "2026-10-04T00:00:00.000Z",
        budget: Duration::from_secs(60),
    };
    restore_project(w.svc.store(), &b, "PA", &opts).unwrap();
    let before = snapshot(&w);
    for s in ["S0", "S1"] {
        let e = code(write(&w, &agent(), record(Some(s), "X", "a"), "a"));
        assert_eq!(e.code, ErrorCode::OPERATION_UNDONE_BY_RESTORE, "{s}");
    }
    assert_eq!(w.calls.load(Ordering::SeqCst), 1);
    assert_zero_writes(&w, &before);
    // 新的 op_id 照常执行，落在新世代上。
    let r = write(&w, &agent(), record(Some("S0"), "Y", "a"), "a").unwrap();
    assert!(!r.replayed);
}

#[test]
fn a_stale_generation_refuses_new_writes_but_not_replays() {
    let w = world("stale-generation");
    let first = write(&w, &agent(), record(Some("S0"), "x", "a"), "a").unwrap();
    let before = snapshot(&w);
    let stale = |op: &str| WriteRequest {
        expected_generation: Some(TOMB_GEN + 100),
        ..record(Some("S0"), op, "a")
    };
    let e = code(write(&w, &agent(), stale("y"), "a"));
    assert_eq!(e.code, ErrorCode::SCOPE_RESTORED);
    assert_eq!(e.details["expected_generation"], TOMB_GEN + 100);
    assert_eq!(e.details["current_generation"], 1);
    assert_zero_writes(&w, &before);
    // 已经提交过的 op_id：回执查找在屏障之前，照样 REPLAY。
    let r = write(&w, &agent(), stale("x"), "a").unwrap();
    assert!(r.replayed);
    assert_eq!(r.result, first.result);
    // 当前世代：照常执行。
    let fresh = WriteRequest {
        expected_generation: Some(1),
        ..record(Some("S0"), "z", "a")
    };
    assert!(!write(&w, &agent(), fresh, "a").unwrap().replayed);
}

/// 「旧队列里的请求跨过一次恢复」→ SCOPE_RESTORED，零写入（R4 验收）。
#[test]
fn a_request_queued_across_a_restore_is_refused() {
    let w = world("queued-across-restore");
    let store = w.svc.store();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    // 模拟一次正在写线程上执行的恢复：先占住写线程，放行后把 PA 换到新世代。
    let restore = store
        .submit_exclusive(Duration::from_secs(60), move |conn| {
            entered_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            let tx = conn.transaction()?;
            tx.execute(
                "INSERT INTO scope_generations (gen, scope_kind, scope_id, reason, epoch, created_at) VALUES (20, 'PROJECT', 'PA', 'RESTORED', 'EA2', ?1)",
                [T3],
            )?;
            tx.execute("UPDATE projects SET scope_gen = 20 WHERE id = 'PA'", [])?;
            tx.commit()?;
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    entered_rx.recv().unwrap();
    let admitted = Stats::get(&store.stats().admitted);
    let events = count(&w, "SELECT count(*) FROM events");
    let receipts = count(&w, "SELECT count(*) FROM idempotency_receipts");
    let result = std::thread::scope(|s| {
        let h = s.spawn(|| write(&w, &agent(), record(Some("S0"), "q", "a"), "a"));
        let deadline = Instant::now() + Duration::from_secs(10);
        while Stats::get(&store.stats().admitted) == admitted {
            assert!(
                Instant::now() < deadline,
                "the write never reached the queue"
            );
            std::thread::yield_now();
        }
        release_tx.send(()).unwrap();
        h.join().unwrap()
    });
    restore.wait().unwrap();
    let e = code(result);
    assert_eq!(e.code, ErrorCode::SCOPE_RESTORED);
    assert_eq!(e.details["expected_generation"], 1);
    assert_eq!(e.details["current_generation"], 20);
    assert_eq!(w.calls.load(Ordering::SeqCst), 0);
    assert_eq!(count(&w, "SELECT count(*) FROM events"), events);
    assert_eq!(
        count(&w, "SELECT count(*) FROM idempotency_receipts"),
        receipts
    );
    // 重新读取之后重发（同一个 op_id 从未提交过）：在新世代上执行。
    assert!(
        !write(&w, &agent(), record(Some("S0"), "q", "a"), "a")
            .unwrap()
            .replayed
    );
}
