//! 知识库写入的验收（W2g3；04 L-101～L-108、L-117；10 A2）。

mod support;

use atm_domain::error::{DomainError, ErrorCode};
use atm_service::fp;
use atm_service::knowledge::{AgentSave, ArchiveRequest, Content, SourceRef, UserSave};
use atm_service::write::Written;
use atm_store::backup::create_backup;
use atm_store::restore::{RestoreOptions, restore_knowledge};
use serde_json::{Value, json};
use std::time::Duration;
use support::*;

// ---------- 助手 ----------

fn content(slug: &str, body: &str) -> Content {
    Content {
        slug: slug.into(),
        title: format!("{slug} 的标题"),
        summary: "摘要".into(),
        body_markdown: body.into(),
        ..Content::default()
    }
}

fn create(slug: &str, body: &str) -> UserSave {
    UserSave {
        content: content(slug, body),
        ..UserSave::default()
    }
}

fn update(e: &Value, c: Content) -> UserSave {
    UserSave {
        content: c,
        id: Some(e["id"].as_str().unwrap().into()),
        expected_version: e["version"].as_i64().unwrap(),
        expected_revision_id: Some(e["revisionId"].as_str().unwrap().into()),
    }
}

fn archive(e: &Value, archived: bool) -> ArchiveRequest {
    ArchiveRequest {
        id: e["id"].as_str().unwrap().into(),
        expected_version: e["version"].as_i64().unwrap(),
        expected_revision_id: e["revisionId"].as_str().unwrap().into(),
        archived,
    }
}

fn agent_new(slug: &str, body: &str) -> AgentSave {
    AgentSave {
        content: content(slug, body),
        ..AgentSave::default()
    }
}

impl World {
    fn save(&self, r: UserSave) -> Result<Written, DomainError> {
        let op = self.next_op();
        self.svc.knowledge_save(&user(), r, &op)
    }

    fn saved(&self, r: UserSave) -> Value {
        self.save(r).unwrap().result
    }

    fn agent_save(&self, session: &str, r: AgentSave, op: &str) -> Result<Written, DomainError> {
        self.svc
            .knowledge_save_agent(&agent(), "ATM", session, r, op)
    }

    fn revisions(&self) -> i64 {
        self.count("SELECT count(*) FROM knowledge_revisions")
    }

    fn sequence(&self) -> i64 {
        self.count("SELECT sequence FROM knowledge_meta")
    }

    fn db_id(&self) -> String {
        self.scalar("SELECT database_id FROM knowledge_meta")
            .as_str()
            .unwrap()
            .to_owned()
    }
}

// ---------- L-101、L-102 ----------

/// L-101：保存两次得到修订 1、2；修订 1 的快照逐字节不变；直接 UPDATE / DELETE 修订表报错。
#[test]
fn l101_revisions_are_immutable() {
    let w = world("kn-l101");
    let first = w.saved(create("immutable", "第一版"));
    let snapshot = |rev: i64| {
        w.scalar(&format!(
            "SELECT snapshot FROM knowledge_revisions WHERE revision = {rev}"
        ))
    };
    let before = snapshot(1);
    let second = w.saved(update(&first, content("immutable", "第二版")));
    assert_eq!(
        (first["revision"].clone(), second["revision"].clone()),
        (json!(1), json!(2))
    );
    assert_ne!(first["revisionId"], second["revisionId"]);
    assert_eq!(snapshot(1), before);
    for sql in [
        "UPDATE knowledge_revisions SET snapshot = '{}' WHERE revision = 1",
        "DELETE FROM knowledge_revisions WHERE revision = 1",
    ] {
        let r = w.svc.store().write(move |tx| tx.execute(sql, []));
        assert!(format!("{r:?}").contains("immutable"), "{sql}: {r:?}");
    }
    assert_eq!(snapshot(1), before);
}

/// L-102：保存 revision+1、version+1；归档只加 version，revision 与 revisionId 不变，不产生修订。
#[test]
fn l102_six_distinct_fields() {
    let w = world("kn-l102");
    let a = w.saved(create("fields", "一"));
    assert_eq!(
        (
            a["revision"].clone(),
            a["version"].clone(),
            a["archived"].clone()
        ),
        (json!(1), json!(1), json!(false))
    );
    let b = w.saved(update(&a, content("fields", "二")));
    assert_eq!(
        (b["revision"].clone(), b["version"].clone()),
        (json!(2), json!(2))
    );
    assert_eq!(b["id"], a["id"]);
    let revisions = w.revisions();
    let c = w
        .svc
        .knowledge_archive(&user(), archive(&b, true), "arc")
        .unwrap()
        .result;
    assert_eq!(
        (
            c["revision"].clone(),
            c["version"].clone(),
            c["archived"].clone()
        ),
        (json!(2), json!(3), json!(true))
    );
    assert_eq!(c["revisionId"], b["revisionId"]);
    assert_eq!(w.revisions(), revisions);
    assert_eq!(w.scalar("SELECT head_revision FROM knowledge_entries"), 2);
    // 新库第一次写知识时建身份行：新世代，reason CREATED，回执带着它。
    let generation = w.scalar("SELECT scope_gen FROM knowledge_meta");
    assert_eq!(
        w.scalar(&format!(
            "SELECT reason || ':' || scope_kind FROM scope_generations WHERE gen = {generation}"
        )),
        "CREATED:KNOWLEDGE"
    );
    assert_eq!(
        w.count(&format!("SELECT count(*) FROM idempotency_receipts WHERE scope_kind = 'KNOWLEDGE' AND scope_generation = {generation}")),
        3
    );
    assert_eq!(w.sequence(), 3);
}

// ---------- L-103、L-104 ----------

/// L-103：双 CAS；restore 之后 version 相同但 revisionId 不同也算冲突；schema。
#[test]
fn l103_user_save_checks_version_and_revision() {
    let w = world("kn-l103");
    let a = w.saved(create("cas", "一"));
    let b = w.saved(update(&a, content("cas", "二")));
    assert_eq!(b["version"], 2);
    w.refused(ErrorCode::VERSION_CONFLICT, || {
        w.save(update(&a, content("cas", "旧的")))
    });
    // 版本号对得上、修订对不上（恢复后版本号重用）。
    let reused = UserSave {
        expected_version: 2,
        ..update(&a, content("cas", "恢复后"))
    };
    let e = w.refused(ErrorCode::VERSION_CONFLICT, || w.save(reused));
    assert_eq!(e.details["current_revision_id"], b["revisionId"]);
    w.refused(ErrorCode::VERSION_CONFLICT, || {
        w.save(UserSave {
            expected_version: 1,
            ..create("brand-new", "x")
        })
    });
    let e = w.refused(ErrorCode::VALIDATION_ERROR, || {
        w.save(UserSave {
            expected_revision_id: None,
            ..update(&b, content("cas", "缺修订"))
        })
    });
    assert_eq!(e.details["field"], "expected_revision_id");
    w.refused(ErrorCode::NOT_FOUND, || {
        w.save(UserSave {
            id: Some("NOPE".into()),
            ..update(&b, content("cas", "没有"))
        })
    });
    let long = |n: usize| "长".repeat(n);
    for (c, field) in [
        (content("  ", "x"), "slug"),
        (
            Content {
                title: long(241),
                ..content("t", "x")
            },
            "title",
        ),
        (
            Content {
                summary: " ".into(),
                ..content("s", "x")
            },
            "summary",
        ),
        (
            Content {
                use_when: Some(long(2001)),
                ..content("u", "x")
            },
            "use_when",
        ),
        (
            Content {
                tags: vec!["t".into(); 31],
                ..content("g", "x")
            },
            "tags",
        ),
        (
            Content {
                tags: vec![" ".into()],
                ..content("g", "x")
            },
            "tags",
        ),
        (
            Content {
                aliases: vec![long(161)],
                ..content("a", "x")
            },
            "aliases",
        ),
        (
            Content {
                applies_to: vec![long(201)],
                ..content("p", "x")
            },
            "applies_to",
        ),
        (content("nul", "a\0b"), "body_markdown"),
        (content("big", &"b".repeat(500_001)), "body_markdown"),
        (
            Content {
                source_refs: vec![SourceRef {
                    kind: "book".into(),
                    reference: "r".into(),
                    ..SourceRef::default()
                }],
                ..content("r", "x")
            },
            "source_refs",
        ),
        (
            Content {
                source_refs: vec![SourceRef {
                    kind: "project_record".into(),
                    reference: "ATM-D-1".into(),
                    project_id: Some("PA".into()),
                    ..SourceRef::default()
                }],
                ..content("r", "x")
            },
            "source_refs",
        ),
    ] {
        let e = w.refused(ErrorCode::VALIDATION_ERROR, || {
            w.save(create("x", "y").with(c))
        });
        assert_eq!(e.details["field"], field);
    }
    // 边界值可以存，规范化后落库。
    let ok = w.saved(UserSave {
        content: Content {
            slug: "  edge  ".into(),
            title: long(240),
            tags: vec![" a ".into(); 30],
            use_when: Some(long(2000)),
            source_refs: vec![SourceRef {
                kind: "project_record".into(),
                reference: " ATM-D-1 ".into(),
                source_version: Some(0),
                project_id: Some("PA".into()),
                record_id: Some("R1".into()),
            }],
            ..content("edge", &"b".repeat(500_000))
        },
        ..UserSave::default()
    });
    assert_eq!(ok["slug"], "edge");
    assert_eq!(ok["tags"][0], "a");
    assert_eq!(
        ok["sourceRefs"][0],
        json!({ "type": "project_record", "reference": "ATM-D-1", "sourceVersion": 0, "projectId": "PA", "recordId": "R1" })
    );
    assert!(
        w.svc
            .knowledge_save(&agent(), create("z", "z"), "agent-user")
            .unwrap_err()
            .code
            == ErrorCode::USER_AUTHORIZATION_REQUIRED
    );
}

trait With {
    fn with(self, c: Content) -> Self;
}

impl With for UserSave {
    fn with(self, c: Content) -> Self {
        UserSave { content: c, ..self }
    }
}

/// L-104：归档双 CAS；归档后用户仍可编辑，条目仍是归档状态；取消归档。
#[test]
fn l104_archive_and_edit_archived() {
    let w = world("kn-l104");
    let a = w.saved(create("arch", "一"));
    w.refused(ErrorCode::VERSION_CONFLICT, || {
        w.svc.knowledge_archive(
            &user(),
            ArchiveRequest {
                expected_version: 2,
                ..archive(&a, true)
            },
            "x1",
        )
    });
    w.refused(ErrorCode::VERSION_CONFLICT, || {
        w.svc.knowledge_archive(
            &user(),
            ArchiveRequest {
                expected_revision_id: "R0".into(),
                ..archive(&a, true)
            },
            "x2",
        )
    });
    w.refused(ErrorCode::VALIDATION_ERROR, || {
        w.svc.knowledge_archive(
            &user(),
            ArchiveRequest {
                expected_version: 0,
                ..archive(&a, true)
            },
            "x3",
        )
    });
    let b = w
        .svc
        .knowledge_archive(&user(), archive(&a, true), "a1")
        .unwrap()
        .result;
    assert_eq!(
        (b["archived"].clone(), b["version"].clone()),
        (json!(true), json!(2))
    );
    let c = w.saved(update(&b, content("arch", "归档后编辑")));
    assert_eq!(
        (
            c["archived"].clone(),
            c["version"].clone(),
            c["revision"].clone()
        ),
        (json!(true), json!(3), json!(2))
    );
    assert_eq!(c["bodyMarkdown"], "归档后编辑");
    let d = w
        .svc
        .knowledge_archive(&user(), archive(&c, false), "a2")
        .unwrap()
        .result;
    assert_eq!(
        (d["archived"].clone(), d["version"].clone()),
        (json!(false), json!(4))
    );
    // 取消归档落了库：之后的保存读到的 head 不是归档状态。
    let e = w.saved(update(&d, content("arch", "取消归档后")));
    assert_eq!(e["archived"], false);
    // 同一个 op_id 换了归档方向：不是同一请求。
    w.refused(ErrorCode::IDEMPOTENCY_CONFLICT, || {
        w.svc.knowledge_archive(&user(), archive(&c, true), "a2")
    });
    assert_eq!(
        w.svc
            .knowledge_archive(&agent(), archive(&d, true), "a3")
            .unwrap_err()
            .code,
        ErrorCode::USER_AUTHORIZATION_REQUIRED
    );
}

// ---------- L-105、L-106 ----------

/// L-105：作者取自 session；关闭的 session 新 op 被拒；不能写已归档；只靠 revisionId 做 CAS。
#[test]
fn l105_agent_save() {
    let w = world("kn-l105");
    let a = w
        .agent_save("S1", agent_new("agent", "一"), "a1")
        .unwrap()
        .result;
    assert_eq!(
        a["publishedBy"],
        json!({ "type": "AGENT", "agentId": "claude", "sessionId": "S1", "projectId": "PA" })
    );
    // 只靠 revisionId：不管 version。
    let b = w
        .agent_save(
            "SX",
            AgentSave {
                id: a["id"].as_str().map(str::to_owned),
                expected_revision_id: a["revisionId"].as_str().map(str::to_owned),
                ..agent_new("agent", "codex 改的")
            },
            "a2",
        )
        .unwrap()
        .result;
    assert_eq!(b["version"], 2);
    assert_eq!(b["publishedBy"]["agentId"], "codex");
    let stale = AgentSave {
        id: a["id"].as_str().map(str::to_owned),
        expected_revision_id: a["revisionId"].as_str().map(str::to_owned),
        ..agent_new("agent", "过期")
    };
    w.refused(ErrorCode::VERSION_CONFLICT, || {
        w.agent_save("S1", stale.clone(), "a3")
    });
    let e = w.refused(ErrorCode::VALIDATION_ERROR, || {
        w.agent_save(
            "S1",
            AgentSave {
                expected_revision_id: None,
                ..stale.clone()
            },
            "a4",
        )
    });
    assert_eq!(e.details["field"], "expected_revision_id");
    w.refused(ErrorCode::VALIDATION_ERROR, || {
        w.agent_save(
            "S1",
            AgentSave {
                id: None,
                ..stale.clone()
            },
            "a5",
        )
    });
    // 已归档：INVALID_ARGUMENT。
    let archived = w
        .svc
        .knowledge_archive(&user(), archive(&b, true), "arc")
        .unwrap()
        .result;
    w.refused(ErrorCode::INVALID_ARGUMENT, || {
        w.agent_save(
            "S1",
            AgentSave {
                id: archived["id"].as_str().map(str::to_owned),
                expected_revision_id: archived["revisionId"].as_str().map(str::to_owned),
                ..agent_new("agent", "改归档的")
            },
            "a6",
        )
    });
    // 已结束的 session 提交新 op：SESSION_CLOSED；User 不能走 Agent 入口；session 不在项目里。
    w.exec("UPDATE agent_sessions SET connection_state = 'CLOSED', close_reason = 'EXPLICIT_END' WHERE id = 'S1'");
    w.refused(ErrorCode::SESSION_CLOSED, || {
        w.agent_save("S1", agent_new("closed", "x"), "a7")
    });
    w.refused(ErrorCode::SESSION_NOT_FOUND, || {
        w.agent_save("EX", agent_new("other", "x"), "a8")
    });
    assert_eq!(
        w.svc
            .knowledge_save_agent(&user(), "ATM", "S2", agent_new("u", "x"), "a9")
            .unwrap_err()
            .code,
        ErrorCode::PRINCIPAL_CAPABILITY_DENIED
    );
    // session 所在项目在垃圾箱里：拒绝新写入，重放照样拿回原回执。
    w.exec("UPDATE projects SET lifecycle = 'TRASHED' WHERE id = 'PA'");
    w.refused(ErrorCode::PROJECT_DB_UNAVAILABLE, || {
        w.agent_save("S2", agent_new("trash", "x"), "a10")
    });
    assert!(
        w.agent_save("S1", agent_new("agent", "一"), "a1")
            .unwrap()
            .replayed
    );
}

/// L-106：命名空间分开；同一 Agent 同一 op 不同正文冲突，零写入，sequence 不前进。
#[test]
fn l106_namespaces_are_separate() {
    let w = world("kn-l106");
    let a = w.agent_save("S1", agent_new("ns-a", "一"), "same").unwrap();
    let b = w.agent_save("SX", agent_new("ns-b", "一"), "same").unwrap();
    assert!(!a.replayed && !b.replayed);
    assert_ne!(a.result["id"], b.result["id"]);
    let u = w
        .svc
        .knowledge_save(&user(), create("ns-u", "一"), "same")
        .unwrap();
    assert!(!u.replayed);
    let seq = w.sequence();
    let e = w.refused(ErrorCode::IDEMPOTENCY_CONFLICT, || {
        w.agent_save("S1", agent_new("ns-a", "二"), "same")
    });
    assert_eq!(e.details["op_id"], "same");
    w.refused(ErrorCode::IDEMPOTENCY_CONFLICT, || {
        w.svc.knowledge_save(&user(), create("ns-u", "二"), "same")
    });
    // 同一个 op_id 用于另一种操作：冲突。
    w.refused(ErrorCode::IDEMPOTENCY_CONFLICT, || {
        w.svc
            .knowledge_archive(&user(), archive(&u.result, true), "same")
    });
    assert_eq!(w.sequence(), seq);
    // 同一 lineage 的后继重试：重放。
    assert!(
        w.agent_save("S2", agent_new("ns-a", "一"), "same")
            .unwrap()
            .replayed
    );
}

// ---------- L-107、L-108 ----------

/// L-107：重放返回原修订以及当时的 version 与 archived，session 关闭后也一样。
#[test]
fn l107_replay_returns_the_original_revision() {
    let w = world("kn-l107");
    let first = w
        .agent_save("S1", agent_new("replay", "R1 正文"), "r1")
        .unwrap()
        .result;
    let later = w.saved(update(&first, content("replay", "R2 正文")));
    w.svc
        .knowledge_archive(&user(), archive(&later, true), "arc")
        .unwrap();
    let revisions = w.revisions();
    let again = w
        .agent_save("S1", agent_new("replay", "R1 正文"), "r1")
        .unwrap();
    assert!(again.replayed);
    assert_eq!(again.result, first);
    assert_eq!(again.result["version"], 1);
    assert_eq!(again.result["archived"], false);
    w.exec("UPDATE agent_sessions SET connection_state = 'CLOSED', close_reason = 'EXPLICIT_END' WHERE id = 'S1'");
    assert_eq!(
        w.agent_save("S1", agent_new("replay", "R1 正文"), "r1")
            .unwrap()
            .result,
        first
    );
    assert_eq!(w.revisions(), revisions);
    // User 的重放同样不读 head。
    let u = w
        .svc
        .knowledge_save(&user(), create("user-replay", "U1"), "u1")
        .unwrap()
        .result;
    w.saved(update(&u, content("user-replay", "U2")));
    assert_eq!(
        w.svc
            .knowledge_save(&user(), create("user-replay", "U1"), "u1")
            .unwrap()
            .result,
        u
    );
}

/// L-108：改自己的 slug 可以；用别人占用的 slug：KNOWLEDGE_SLUG_CONFLICT。
#[test]
fn l108_slugs_are_unique() {
    let w = world("kn-l108");
    let a = w.saved(create("one", "x"));
    w.saved(create("two", "x"));
    let renamed = w.saved(update(&a, content("one-renamed", "x")));
    assert_eq!(renamed["slug"], "one-renamed");
    let e = w.refused(ErrorCode::KNOWLEDGE_SLUG_CONFLICT, || {
        w.save(update(&renamed, content("two", "x")))
    });
    assert_eq!(e.details["slug"], "two");
    w.refused(ErrorCode::KNOWLEDGE_SLUG_CONFLICT, || {
        w.save(create(" two ", "x"))
    });
    w.refused(ErrorCode::KNOWLEDGE_SLUG_CONFLICT, || {
        w.agent_save("S1", agent_new("two", "x"), "s")
    });
    // FTS 跟着 head：一条条目一行。
    assert_eq!(w.count("SELECT count(*) FROM knowledge_fts"), 2);
    assert_eq!(
        w.scalar(&format!(
            "SELECT title FROM knowledge_fts WHERE entry_id = '{}'",
            a["id"].as_str().unwrap()
        )),
        "one-renamed 的标题"
    );
}

// ---------- A2：转换来的回执 ----------

fn vectors() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/data/knowledge-v1-vectors.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn vector_content(v: &Value) -> Content {
    let c = &v["content"];
    let strings = |k: &str| -> Vec<String> {
        c[k].as_array().map_or_else(Vec::new, |a| {
            a.iter().map(|s| s.as_str().unwrap().to_owned()).collect()
        })
    };
    Content {
        slug: c["slug"].as_str().unwrap().into(),
        title: c["title"].as_str().unwrap().into(),
        summary: c["summary"].as_str().unwrap().into(),
        use_when: None,
        tags: strings("tags"),
        aliases: Vec::new(),
        applies_to: Vec::new(),
        body_markdown: c["bodyMarkdown"].as_str().unwrap().into(),
        source_refs: vec![SourceRef {
            kind: "manual".into(),
            reference: c["sourceRefs"][0]["reference"].as_str().unwrap().into(),
            ..SourceRef::default()
        }],
    }
}

impl World {
    fn legacy_receipt(&self, key: &str, fingerprint: &str, receipt: &Value) {
        let db = self.db_id();
        let generation = self.scalar("SELECT scope_gen FROM knowledge_meta");
        let receipt = receipt.to_string().replace('\'', "''");
        self.exec(&format!(
            "INSERT INTO idempotency_receipts (scope_kind, scope_id, legacy_key, operation, fp_v, fp_family, fingerprint, receipt_json, scope_generation)
             VALUES ('KNOWLEDGE', '{db}', '{key}', '*', 1, 'knowledge-v1', '{fingerprint}', '{receipt}', {generation})"
        ));
    }
}

/// A2：转换来的 knowledge-v1 回执（用 2.x 运行环境与 zod schema 生成的向量）按旧算法比对：同一请求重放，
/// 不同请求冲突；Agent 的旧键经 lineage 找到。
#[test]
fn a2_converted_receipts_replay() {
    let w = world("kn-a2");
    let v = vectors();
    let c = vector_content(&v);
    // 旧回执指向一条真实修订。
    let target = w.saved(create("target", "旧回执指向这里"));
    let receipt = json!({ "format": "knowledge-receipt-v2", "id": target["id"], "revisionId": target["revisionId"], "version": 1, "archived": false });
    let user_new = &v["user"][0];
    w.legacy_receipt(
        user_new["opId"].as_str().unwrap(),
        user_new["fp"].as_str().unwrap(),
        &receipt,
    );
    let agent_v = &v["agent"];
    assert_eq!(
        agent_v["key"],
        fp::knowledge_agent_legacy_key("PA", "S1", "a-new")
    );
    w.legacy_receipt(
        agent_v["key"].as_str().unwrap(),
        agent_v["fp"].as_str().unwrap(),
        &receipt,
    );
    // 2.x 旧格式回执本身就是条目。
    let archive_v = &v["archive"];
    let old_entry = json!({ "id": "OLD", "title": "旧格式", "version": 9, "archived": true });
    w.legacy_receipt(
        archive_v["opId"].as_str().unwrap(),
        archive_v["fp"].as_str().unwrap(),
        &old_entry,
    );
    let before = w.revisions();

    let r = w
        .svc
        .knowledge_save(
            &user(),
            UserSave {
                content: c.clone(),
                ..UserSave::default()
            },
            "u-new",
        )
        .unwrap();
    assert!(r.replayed);
    assert_eq!(r.result["revisionId"], target["revisionId"]);
    let e = w.refused(ErrorCode::IDEMPOTENCY_CONFLICT, || {
        w.svc.knowledge_save(
            &user(),
            UserSave {
                content: Content {
                    summary: "别的".into(),
                    ..c.clone()
                },
                ..UserSave::default()
            },
            "u-new",
        )
    });
    assert_eq!(e.details["op_id"], "u-new");
    let r = w
        .svc
        .knowledge_save_agent(
            &agent(),
            "ATM",
            "S1",
            AgentSave {
                content: c.clone(),
                ..AgentSave::default()
            },
            "a-new",
        )
        .unwrap();
    assert!(r.replayed);
    assert_eq!(r.result["id"], target["id"]);
    // 同一 lineage 的后继 S2 重试：经 S1 的旧键命中，按 S1 的作者重建指纹。
    assert!(
        w.svc
            .knowledge_save_agent(
                &agent(),
                "ATM",
                "S2",
                AgentSave {
                    content: c.clone(),
                    ..AgentSave::default()
                },
                "a-new"
            )
            .unwrap()
            .replayed
    );
    // 另一个 agent 的同名 op：旧键里含 session，不是候选。
    assert!(
        !w.svc
            .knowledge_save_agent(
                &agent(),
                "ATM",
                "SX",
                AgentSave {
                    content: Content {
                        slug: "sx-own".into(),
                        ..c.clone()
                    },
                    ..AgentSave::default()
                },
                "a-new"
            )
            .unwrap()
            .replayed
    );
    let r = w
        .svc
        .knowledge_archive(
            &user(),
            ArchiveRequest {
                id: "01KENTRY000000000000000000".into(),
                expected_version: 4,
                expected_revision_id: "01KREV00000000000000000003".into(),
                archived: true,
            },
            "u-arc",
        )
        .unwrap();
    assert!(r.replayed);
    assert_eq!(r.result, old_entry);
    assert_eq!(w.revisions(), before + 1);
}

// ---------- L-117 ----------

/// L-117：备份 B → X 成功、应答丢失 → 恢复到 B → X 重试：OPERATION_UNDONE_BY_RESTORE，修订数不变；
/// 备份里本来就有的回执照常重放。
#[test]
fn l117_restore_tombstones_later_operations() {
    let w = world("kn-l117");
    let kept = w
        .agent_save("S1", agent_new("kept", "备份前"), "before")
        .unwrap()
        .result;
    let backups = w.dir.join("backups");
    let b = create_backup(w.svc.store(), &backups, "MANUAL", T1)
        .unwrap()
        .id;
    w.agent_save("S1", agent_new("lost", "备份后"), "x")
        .unwrap();
    let opts = RestoreOptions {
        backups_root: &backups,
        at: "2026-10-05T02:00:00.000Z",
        pin_until: "2026-10-06T00:00:00.000Z",
        budget: Duration::from_secs(60),
    };
    restore_knowledge(w.svc.store(), &b, &opts).unwrap();
    let revisions = w.revisions();
    let e = w.refused(ErrorCode::OPERATION_UNDONE_BY_RESTORE, || {
        w.agent_save("S1", agent_new("lost", "备份后"), "x")
    });
    assert_eq!(e.details["op_id"], "x");
    assert_eq!(w.revisions(), revisions);
    let r = w
        .agent_save("S1", agent_new("kept", "备份前"), "before")
        .unwrap();
    assert!(r.replayed);
    assert_eq!(r.result, kept);
    // 新的 op_id 照常执行。
    assert!(
        !w.agent_save("S1", agent_new("lost", "备份后"), "y")
            .unwrap()
            .replayed
    );
}
