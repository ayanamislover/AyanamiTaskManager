//! 知识库读取与搜索的验收（W2g4；04 L-109～L-116；00 C-L12、C-L13）。

mod support;

use atm_domain::error::{DomainError, ErrorCode};
use atm_service::knowledge::{Content, UserSave};
use atm_service::read::{KnowledgeGetRequest, KnowledgeSearchRequest, Part};
use atm_store::backup::create_backup;
use atm_store::restore::{RestoreOptions, restore_knowledge};
use serde_json::{Value, json};
use std::time::Duration;
use support::*;

// ---------- 助手 ----------

fn content(slug: &str, title: &str, body: &str) -> Content {
    Content {
        slug: slug.into(),
        title: title.into(),
        summary: format!("{title} 的摘要"),
        body_markdown: body.into(),
        ..Content::default()
    }
}

impl World {
    fn put(&self, c: Content) -> Value {
        let op = self.next_op();
        self.svc
            .knowledge_save(
                &user(),
                UserSave {
                    content: c,
                    ..UserSave::default()
                },
                &op,
            )
            .unwrap()
            .result
    }

    fn edit(&self, e: &Value, c: Content) -> Value {
        let op = self.next_op();
        self.svc
            .knowledge_save(
                &user(),
                UserSave {
                    content: c,
                    id: e["id"].as_str().map(str::to_owned),
                    expected_version: e["version"].as_i64().unwrap(),
                    expected_revision_id: e["revisionId"].as_str().map(str::to_owned),
                },
                &op,
            )
            .unwrap()
            .result
    }

    fn search(&self, query: &str) -> Result<Value, DomainError> {
        self.svc.knowledge_search(
            &user(),
            &KnowledgeSearchRequest {
                query: query.into(),
                limit: 50,
                max_chars: 50_000,
                ..KnowledgeSearchRequest::default()
            },
        )
    }

    fn found(&self, query: &str) -> Vec<String> {
        self.search(query).unwrap()["hits"]
            .as_array()
            .unwrap()
            .iter()
            .map(|h| h["slug"].as_str().unwrap().to_owned())
            .collect()
    }
}

fn get(id: &Value) -> KnowledgeGetRequest {
    KnowledgeGetRequest::new(id.as_str().unwrap())
}

fn code(r: Result<Value, DomainError>) -> DomainError {
    r.expect_err("expected an error")
}

// ---------- L-109、C-L13 ----------

/// L-109：按 revisionId 读旧修订，version 报 head 的值、isHead 为 false；拿它去保存被拒。
#[test]
fn l109_old_revisions_report_the_head_version() {
    let w = world("kr-l109");
    let r1 = w.put(content("old", "旧", "R1 正文"));
    let r2 = w.edit(&r1, content("old", "旧", "R2 正文"));
    let r3 = w.edit(&r2, content("old", "旧", "R3 正文"));
    let old = w
        .svc
        .knowledge_get(
            &user(),
            &KnowledgeGetRequest {
                revision_id: r1["revisionId"].as_str().map(str::to_owned),
                ..get(&r1["id"])
            },
        )
        .unwrap();
    assert_eq!(old["bodyMarkdown"], "R1 正文");
    assert_eq!(old["version"], 3);
    assert_eq!(old["revision"], 1);
    assert_eq!(old["isHead"], false);
    let head = w.svc.knowledge_get(&user(), &get(&r1["id"])).unwrap();
    assert_eq!(head["isHead"], true);
    assert_eq!(head["revisionId"], r3["revisionId"]);
    let e = w
        .svc
        .knowledge_save(
            &user(),
            UserSave {
                content: content("old", "旧", "覆盖"),
                id: r1["id"].as_str().map(str::to_owned),
                expected_version: 3,
                expected_revision_id: r1["revisionId"].as_str().map(str::to_owned),
            },
            "stale",
        )
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::VERSION_CONFLICT);
    // 修订 id 格式不对、条目或修订不存在。
    let bad = KnowledgeGetRequest {
        revision_id: Some("not-a-ulid".into()),
        ..get(&r1["id"])
    };
    assert_eq!(
        code(w.svc.knowledge_get(&user(), &bad)).code,
        ErrorCode::VALIDATION_ERROR
    );
    let missing = KnowledgeGetRequest {
        revision_id: Some("01AAAAAAAAAAAAAAAAAAAAAAAA".into()),
        ..get(&r1["id"])
    };
    assert_eq!(
        code(w.svc.knowledge_get(&user(), &missing)).code,
        ErrorCode::NOT_FOUND
    );
    assert_eq!(
        code(w.svc.knowledge_get(&user(), &get(&json!("NOPE")))).code,
        ErrorCode::NOT_FOUND
    );
}

// ---------- L-110 ----------

/// L-110：正文分页锁定 revisionId 与 editVersion；续页换 revisionId 被拒；拼回原文逐字相等。
#[test]
fn l110_body_pages_pin_the_revision_and_version() {
    let w = world("kr-l110");
    let body: String = (0..600).map(|i| format!("第{i}行 😀 text\n")).collect();
    let a = w.put(content("paged", "分页", &body));
    let first_req = KnowledgeGetRequest {
        max_chars: 1500,
        ..get(&a["id"])
    };
    let mut page = w.svc.knowledge_get(&user(), &first_req).unwrap();
    assert_eq!(page["truncated"], true);
    assert_eq!(page["version"], 1);
    // 第一页之后条目被更新到 version 2。
    let b = w.edit(&a, content("paged", "分页", "新正文"));
    let mut text = page["bodyMarkdown"].as_str().unwrap().to_owned();
    let mut pages = 1;
    while let Some(c) = page["nextCursor"].as_str().map(str::to_owned) {
        page = w
            .svc
            .knowledge_get(
                &user(),
                &KnowledgeGetRequest {
                    cursor: Some(c),
                    ..first_req.clone()
                },
            )
            .unwrap();
        assert_eq!(page["version"], 1, "续页仍报首页的 version");
        // 截断的页要塞满预算：再多一个码元（转义后最多 2 个字符，或退回半个代理对）就放不下。
        if page["truncated"] == true {
            assert!(serde_json::to_string(&page).unwrap().encode_utf16().count() >= 1496);
        }
        assert_eq!(page["revisionId"], a["revisionId"]);
        assert!(serde_json::to_string(&page).unwrap().encode_utf16().count() <= 1500);
        text.push_str(page["bodyMarkdown"].as_str().unwrap());
        pages += 1;
        assert!(pages < 100);
    }
    assert!(pages > 3);
    assert_eq!(text, body);
    // 续页带了与游标不同的 revisionId。
    let first_req = KnowledgeGetRequest {
        revision_id: a["revisionId"].as_str().map(str::to_owned),
        ..first_req
    };
    let p1 = w.svc.knowledge_get(&user(), &first_req).unwrap();
    assert_eq!(
        (p1["isHead"].clone(), p1["version"].clone()),
        (json!(false), json!(2))
    );
    let c = p1["nextCursor"].as_str().unwrap().to_owned();
    assert!(
        w.svc
            .knowledge_get(
                &user(),
                &KnowledgeGetRequest {
                    cursor: Some(c.clone()),
                    ..first_req.clone()
                }
            )
            .is_ok()
    );
    let e = code(w.svc.knowledge_get(
        &user(),
        &KnowledgeGetRequest {
            cursor: Some(c.clone()),
            revision_id: b["revisionId"].as_str().map(str::to_owned),
            ..first_req.clone()
        },
    ));
    assert_eq!(e.code, ErrorCode::INVALID_CURSOR);
    // 游标被改过、或者拿去读别的章节。
    let mut forged = c.clone();
    forged.push('x');
    assert_eq!(
        code(w.svc.knowledge_get(
            &user(),
            &KnowledgeGetRequest {
                cursor: Some(forged),
                ..first_req.clone()
            }
        ))
        .details["reason"],
        "INVALID_OR_TAMPERED"
    );
    assert_eq!(
        code(w.svc.knowledge_get(
            &user(),
            &KnowledgeGetRequest {
                cursor: Some(c.clone()),
                section: Some("h-1".into()),
                ..first_req.clone()
            }
        ))
        .code,
        ErrorCode::INVALID_CURSOR
    );
    // Agent 的续页只带身份与正文。
    let ap = w.svc.knowledge_get(&agent(), &first_req).unwrap();
    let next = w
        .svc
        .knowledge_get(
            &agent(),
            &KnowledgeGetRequest {
                cursor: ap["nextCursor"].as_str().map(str::to_owned),
                ..first_req.clone()
            },
        )
        .unwrap();
    let mut keys: Vec<&str> = next
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "archived",
            "bodyMarkdown",
            "id",
            "nextCursor",
            "revisionId",
            "truncated"
        ]
    );
}

// ---------- L-111、L-112 ----------

/// L-111：搜索游标绑定目录序号；期间有写入、或改了 query：INVALID_CURSOR。
#[test]
fn l111_search_cursors_bind_the_catalog() {
    let w = world("kr-l111");
    for i in 0..5 {
        w.put(content(&format!("alpha-{i}"), &format!("alpha {i}"), "x"));
    }
    let req = KnowledgeSearchRequest {
        query: "alpha".into(),
        limit: 2,
        ..KnowledgeSearchRequest::default()
    };
    let p1 = w.svc.knowledge_search(&user(), &req).unwrap();
    assert_eq!(p1["hits"].as_array().unwrap().len(), 2);
    assert_eq!(p1["hasMore"], true);
    let c = p1["nextCursor"].as_str().unwrap().to_owned();
    let p2 = w
        .svc
        .knowledge_search(
            &user(),
            &KnowledgeSearchRequest {
                cursor: Some(c.clone()),
                ..req.clone()
            },
        )
        .unwrap();
    assert_eq!(p2["hits"].as_array().unwrap().len(), 2);
    assert_ne!(p2["hits"][0]["id"], p1["hits"][0]["id"]);
    let e = code(w.svc.knowledge_search(
        &user(),
        &KnowledgeSearchRequest {
            cursor: Some(c.clone()),
            query: "beta".into(),
            ..req.clone()
        },
    ));
    assert_eq!(e.code, ErrorCode::INVALID_CURSOR);
    let e = code(w.svc.knowledge_search(
        &user(),
        &KnowledgeSearchRequest {
            cursor: Some(c.clone()),
            include_archived: true,
            ..req.clone()
        },
    ));
    assert_eq!(e.code, ErrorCode::INVALID_CURSOR);
    w.put(content("other", "other", "x"));
    let e = code(w.svc.knowledge_search(
        &user(),
        &KnowledgeSearchRequest {
            cursor: Some(c),
            ..req.clone()
        },
    ));
    assert_eq!(e.code, ErrorCode::INVALID_CURSOR);
    assert_eq!(e.details["reason"], "CATALOG_CHANGED");
    // 正文游标拿来翻搜索：不是同一种游标。
    let long = w.put(content("zzz", "zzz", &"y".repeat(5000)));
    let g = w
        .svc
        .knowledge_get(
            &user(),
            &KnowledgeGetRequest {
                max_chars: 1000,
                ..get(&long["id"])
            },
        )
        .unwrap();
    let gc = g["nextCursor"].as_str().unwrap().to_owned();
    assert_eq!(
        code(w.svc.knowledge_search(
            &user(),
            &KnowledgeSearchRequest {
                cursor: Some(gc),
                ..req.clone()
            }
        ))
        .details["reason"],
        "INVALID_OR_TAMPERED"
    );
}

/// L-112：恢复之后的旧游标 SCOPE_RESTORED；2.x 的 k1 游标 FORMAT_RETIRED。
#[test]
fn l112_restores_and_old_formats_invalidate_cursors() {
    let w = world("kr-l112");
    let body = "长".repeat(3000);
    let a = w.put(content("restore", "恢复", &body));
    let backups = w.dir.join("backups");
    let b = create_backup(w.svc.store(), &backups, "MANUAL", T1)
        .unwrap()
        .id;
    let req = KnowledgeGetRequest {
        max_chars: 1000,
        ..get(&a["id"])
    };
    let c = w.svc.knowledge_get(&user(), &req).unwrap()["nextCursor"]
        .as_str()
        .unwrap()
        .to_owned();
    let opts = RestoreOptions {
        backups_root: &backups,
        at: "2026-10-05T02:00:00.000Z",
        pin_until: "2026-10-06T00:00:00.000Z",
        budget: Duration::from_secs(60),
    };
    restore_knowledge(w.svc.store(), &b, &opts).unwrap();
    let e = code(w.svc.knowledge_get(
        &user(),
        &KnowledgeGetRequest {
            cursor: Some(c),
            ..req.clone()
        },
    ));
    assert_eq!(
        (e.code, e.details["reason"].clone()),
        (ErrorCode::INVALID_CURSOR, json!("SCOPE_RESTORED"))
    );
    // 恢复之后的新游标正常。
    let fresh = w.svc.knowledge_get(&user(), &req).unwrap()["nextCursor"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        w.svc
            .knowledge_get(
                &user(),
                &KnowledgeGetRequest {
                    cursor: Some(fresh),
                    ..req.clone()
                }
            )
            .is_ok()
    );
    let e = code(w.svc.knowledge_search(
        &user(),
        &KnowledgeSearchRequest {
            cursor: Some("k1.eyJ9.abc".into()),
            ..KnowledgeSearchRequest::default()
        },
    ));
    assert_eq!(e.details["reason"], "FORMAT_RETIRED");
}

// ---------- L-113 ----------

/// L-113：history 用 beforeRevision 翻页，期间的新修订不影响已经翻过的页；参数越界 INVALID_ARGUMENT。
#[test]
fn l113_history_pages_by_keyset() {
    let w = world("kr-l113");
    let mut e = w.put(content("hist", "历史", "v1"));
    for i in 2..=5 {
        e = w.edit(&e, content("hist", "历史", &format!("v{i}")));
    }
    let id = e["id"].as_str().unwrap();
    let p1 = w.svc.knowledge_history(&user(), id, None, Some(2)).unwrap();
    let revs = |p: &Value| {
        p["revisions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["revision"].as_i64().unwrap())
            .collect::<Vec<_>>()
    };
    assert_eq!(revs(&p1), [5, 4]);
    assert_eq!(p1["nextRevision"], 4);
    assert!(p1["revisions"][0].get("bodyMarkdown").is_none());
    w.edit(&e, content("hist", "历史", "v6"));
    let p2 = w
        .svc
        .knowledge_history(&user(), id, Some(4), Some(2))
        .unwrap();
    assert_eq!(revs(&p2), [3, 2]);
    let p3 = w
        .svc
        .knowledge_history(&user(), id, Some(2), Some(2))
        .unwrap();
    assert_eq!(revs(&p3), [1]);
    assert!(p3["nextRevision"].is_null());
    assert_eq!(
        revs(&w.svc.knowledge_history(&user(), id, None, None).unwrap()).len(),
        6
    );
    for (before, limit) in [(None, Some(0)), (None, Some(101)), (Some(0), None)] {
        assert_eq!(
            w.svc
                .knowledge_history(&user(), id, before, limit)
                .unwrap_err()
                .code,
            ErrorCode::INVALID_ARGUMENT
        );
    }
    assert_eq!(
        w.svc
            .knowledge_history(&user(), "NOPE", None, None)
            .unwrap_err()
            .code,
        ErrorCode::NOT_FOUND
    );
}

// ---------- L-114 ----------

/// L-114：≥3 字走 FTS、2 字扫表；多词 AND；引号短语；`%_\` 按字面；9 个词报错；默认不含归档；tag 精确匹配；排名。
#[test]
fn l114_search_behaves_like_2x() {
    let w = world("kr-l114");
    w.put(content(
        "backup-policy",
        "保留策略",
        "每天的备份策略：两份。D-398 HALF_OPEN 复审裁决",
    ));
    w.put(Content {
        tags: vec!["ops".into()],
        ..content("phrase", "短语", "foo bar 相邻；字面量 100%_done\\x")
    });
    w.put(content("apart", "分开", "foo 在这里 bar 在那里"));
    let archived = w.put(content("archived", "归档的备份策略", "备份策略"));
    w.svc
        .knowledge_archive(
            &user(),
            atm_service::knowledge::ArchiveRequest {
                id: archived["id"].as_str().unwrap().into(),
                expected_version: 1,
                expected_revision_id: archived["revisionId"].as_str().unwrap().into(),
                archived: true,
            },
            "arc",
        )
        .unwrap();
    assert_eq!(w.found("备份策略"), ["backup-policy"]);
    assert_eq!(w.found("备份"), ["backup-policy"]);
    assert_eq!(w.found("D-398 HALF_OPEN 复审"), ["backup-policy"]);
    assert!(w.found("D-398 HALF_OPEN 不存在").is_empty());
    let mut both = w.found("foo bar");
    both.sort();
    assert_eq!(both, ["apart", "phrase"]);
    assert_eq!(w.found("\"foo bar\""), ["phrase"]);
    assert_eq!(w.found("100%_done"), ["phrase"]);
    assert_eq!(w.found("%_"), ["phrase"]);
    assert!(w.found("1%0").is_empty());
    assert_eq!(w.found("\\x"), ["phrase"]);
    let e = code(w.search("1 2 3 4 5 6 7 8 9"));
    assert_eq!(
        (e.code, e.details["field"].clone()),
        (ErrorCode::VALIDATION_ERROR, json!("query"))
    );
    // includeArchived。
    let mut with_archived = w
        .svc
        .knowledge_search(
            &user(),
            &KnowledgeSearchRequest {
                query: "备份策略".into(),
                include_archived: true,
                limit: 50,
                ..KnowledgeSearchRequest::default()
            },
        )
        .unwrap()["hits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["slug"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    with_archived.sort();
    assert_eq!(with_archived, ["archived", "backup-policy"]);
    // tag 精确匹配。
    let tagged = |tag: &str| {
        w.svc
            .knowledge_search(
                &user(),
                &KnowledgeSearchRequest {
                    tag: Some(tag.into()),
                    limit: 50,
                    ..KnowledgeSearchRequest::default()
                },
            )
            .unwrap()["hits"]
            .as_array()
            .unwrap()
            .len()
    };
    assert_eq!((tagged("ops"), tagged("op")), (1, 0));
    // 排名：标题整条相等（0）在只有正文命中（4）之前；同名次 id 倒序。
    w.put(content("rank-body", "无关", "保留策略写在正文里"));
    assert_eq!(w.found("保留策略"), ["backup-policy", "rank-body"]);
    // 标题整条相等（0）在标题包含（1）之前，即使后者 id 更大；同为标题包含时 id 倒序。
    w.put(content("deploy-main", "deploy", "x"));
    w.put(content("deploy-guide", "deploy guide", "x"));
    w.put(content("deploy-faq", "deploy faq", "x"));
    // 同一毫秒里生成的两个 ULID 先后不定，所以期望按实际 id 排，不按插入顺序。
    let newer_first: bool = w
        .svc
        .store()
        .read(|tx| {
            tx.query_row(
                "SELECT (SELECT id FROM knowledge_entries WHERE slug = 'deploy-faq')
                      > (SELECT id FROM knowledge_entries WHERE slug = 'deploy-guide')",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    let (a, b) = if newer_first {
        ("deploy-faq", "deploy-guide")
    } else {
        ("deploy-guide", "deploy-faq")
    };
    assert_eq!(w.found("deploy"), ["deploy-main", a, b]);
    // 空 query 列出全部未归档条目。
    assert_eq!(w.found("").len(), 7);
    for (r, field) in [
        (
            KnowledgeSearchRequest {
                limit: 0,
                ..KnowledgeSearchRequest::default()
            },
            "limit",
        ),
        (
            KnowledgeSearchRequest {
                limit: 51,
                ..KnowledgeSearchRequest::default()
            },
            "limit",
        ),
        (
            KnowledgeSearchRequest {
                max_chars: 50_001,
                ..KnowledgeSearchRequest::default()
            },
            "max_chars",
        ),
        (
            KnowledgeSearchRequest {
                query: "a\0b".into(),
                ..KnowledgeSearchRequest::default()
            },
            "query",
        ),
        (
            KnowledgeSearchRequest {
                query: "q".repeat(501),
                ..KnowledgeSearchRequest::default()
            },
            "query",
        ),
        (
            KnowledgeSearchRequest {
                tag: Some(" ".into()),
                ..KnowledgeSearchRequest::default()
            },
            "tag",
        ),
    ] {
        let e = code(w.svc.knowledge_search(&user(), &r));
        assert_eq!(
            (e.code, e.details["field"].clone()),
            (ErrorCode::VALIDATION_ERROR, json!(field))
        );
    }
}

// ---------- L-115、L-116 ----------

/// L-115：预算恰好放得下一项时返回 1 项和游标；一项都放不下 RESULT_TOO_LARGE，不返回空页加游标。
#[test]
fn l115_budgets_never_return_empty_pages() {
    let w = world("kr-l115");
    for i in 0..3 {
        w.put(content(&format!("budget-{i}"), &format!("budget {i}"), "x"));
    }
    let base = KnowledgeSearchRequest {
        query: "budget".into(),
        limit: 3,
        ..KnowledgeSearchRequest::default()
    };
    let full = w
        .svc
        .knowledge_search(
            &user(),
            &KnowledgeSearchRequest {
                max_chars: 50_000,
                ..base.clone()
            },
        )
        .unwrap();
    let one = json!({ "hits": [full["hits"][0].clone()], "hasMore": true, "nextCursor": "k2.x.y" });
    // 一项加游标的长度：游标长度不固定，用实际返回值核对。
    let mut max = serde_json::to_string(&one).unwrap().encode_utf16().count() as i64;
    let page = loop {
        match w.svc.knowledge_search(
            &user(),
            &KnowledgeSearchRequest {
                max_chars: max,
                ..base.clone()
            },
        ) {
            Ok(p) => break p,
            Err(e) => {
                assert_eq!(e.code, ErrorCode::RESULT_TOO_LARGE);
                max += 1;
                assert!(max < 2000);
            }
        }
    };
    assert_eq!(page["hits"].as_array().unwrap().len(), 1);
    assert!(page["nextCursor"].is_string());
    assert_eq!(
        serde_json::to_string(&page).unwrap().encode_utf16().count() as i64,
        max
    );
    let e = code(w.svc.knowledge_search(
        &user(),
        &KnowledgeSearchRequest {
            max_chars: 50,
            ..base.clone()
        },
    ));
    assert_eq!(e.code, ErrorCode::RESULT_TOO_LARGE);
    // 没有命中时空页可以返回。
    let none = w
        .svc
        .knowledge_search(
            &user(),
            &KnowledgeSearchRequest {
                query: "不存在".into(),
                max_chars: 100,
                ..base.clone()
            },
        )
        .unwrap();
    assert_eq!(
        none,
        json!({ "hits": [], "hasMore": false, "nextCursor": null })
    );
    // 正文：预算从小往上加，第一次成功的页里至少有一个字（只放得下元数据时报错，不发指回原处的游标）。
    let long = w.put(content("budget-long", "长正文", &"字".repeat(500)));
    let mut max = 200;
    let first = loop {
        match w.svc.knowledge_get(
            &user(),
            &KnowledgeGetRequest {
                max_chars: max,
                ..get(&long["id"])
            },
        ) {
            Ok(p) => break p,
            Err(e) => {
                assert_eq!(e.code, ErrorCode::RESULT_TOO_LARGE);
                max += 1;
                assert!(max < 3000);
            }
        }
    };
    assert!(!first["bodyMarkdown"].as_str().unwrap().is_empty());
    let id = &full["hits"][0]["id"];
    assert_eq!(
        code(w.svc.knowledge_get(
            &user(),
            &KnowledgeGetRequest {
                max_chars: 100,
                ..get(id)
            }
        ))
        .code,
        ErrorCode::RESULT_TOO_LARGE
    );
}

/// L-115、L-116：Agent 视图去掉管理字段；首页元数据放不下时不给截断后的编辑值，改走元数据分页，拼回来逐字相等。
#[test]
fn l116_agent_views_and_metadata_paging() {
    let w = world("kr-l116");
    let saved = w
        .svc
        .knowledge_save_agent(
            &agent(),
            "ATM",
            "S1",
            atm_service::knowledge::AgentSave {
                content: Content {
                    applies_to: (0..30)
                        .map(|i| format!("适用范围 {i} {}", "很长".repeat(40)))
                        .collect(),
                    tags: vec!["t1".into(), "t2".into()],
                    ..content("agent-view", "Agent 视图", "# 一\n正文\n## 二\n更多")
                },
                ..atm_service::knowledge::AgentSave::default()
            },
            "a1",
        )
        .unwrap()
        .result;
    let hit = &w
        .svc
        .knowledge_search(
            &agent(),
            &KnowledgeSearchRequest {
                query: "Agent".into(),
                max_chars: 50_000,
                ..KnowledgeSearchRequest::default()
            },
        )
        .unwrap()["hits"][0];
    for k in [
        "publishedBy",
        "slug",
        "version",
        "revision",
        "createdAt",
        "aliases",
        "bodyMarkdown",
    ] {
        assert!(hit.get(k).is_none(), "agent hit leaks {k}");
    }
    assert_eq!(hit["id"], saved["id"]);
    let user_hit = &w.search("Agent").unwrap()["hits"][0];
    assert_eq!(user_hit["publishedBy"]["sessionId"], "S1");
    // 预算足够：首页带目录、元数据与 edit 块。
    let roomy = w
        .svc
        .knowledge_get(
            &agent(),
            &KnowledgeGetRequest {
                for_edit: true,
                max_chars: 50_000,
                ..get(&saved["id"])
            },
        )
        .unwrap();
    assert!(roomy.get("publishedBy").is_none());
    assert_eq!(roomy["toc"].as_array().unwrap().len(), 2);
    assert_eq!(roomy["edit"]["tags"], json!(["t1", "t2"]));
    assert_eq!(roomy["isHead"], true);
    let plain = w
        .svc
        .knowledge_get(
            &agent(),
            &KnowledgeGetRequest {
                max_chars: 50_000,
                ..get(&saved["id"])
            },
        )
        .unwrap();
    assert!(plain.get("edit").is_none());
    // 预算放不下元数据：截断标记、不给 edit、指向元数据分页。
    let tight = w
        .svc
        .knowledge_get(
            &agent(),
            &KnowledgeGetRequest {
                for_edit: true,
                max_chars: 1500,
                ..get(&saved["id"])
            },
        )
        .unwrap();
    assert_eq!(tight["metadataTruncated"], true);
    assert!(tight.get("edit").is_none());
    assert_eq!(tight["appliesToTotal"], 30);
    assert_eq!(tight["metadataRead"]["part"], "metadata");
    let mut text = String::new();
    let mut req = KnowledgeGetRequest {
        part: Part::Metadata,
        max_chars: 1200,
        ..get(&saved["id"])
    };
    for _ in 0..50 {
        let p = w.svc.knowledge_get(&agent(), &req).unwrap();
        assert_eq!(
            p["offset"].as_u64().unwrap() as usize,
            text.encode_utf16().count()
        );
        text.push_str(p["metadataJson"].as_str().unwrap());
        match p["nextCursor"].as_str() {
            Some(c) => req.cursor = Some(c.into()),
            None => break,
        }
    }
    let meta: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(meta["appliesTo"].as_array().unwrap().len(), 30);
    assert!(meta.get("bodyMarkdown").is_none());
    // 正文游标的 section 恰好叫 metadata 时 scope 与元数据游标相同，只能靠游标种类区分。
    // 别名把元数据文本拉长（Agent 首页不显示别名），让正文游标的位置也落在元数据文本之内。
    let doc = w.put(Content {
        aliases: (0..30)
            .map(|i| format!("别名{i}{}", "长".repeat(150)))
            .collect(),
        ..content(
            "kinds",
            "种类",
            &format!("# metadata\n{}", "长".repeat(4000)),
        )
    });
    let body_cursor = w
        .svc
        .knowledge_get(
            &agent(),
            &KnowledgeGetRequest {
                section: Some("metadata".into()),
                max_chars: 1500,
                ..get(&doc["id"])
            },
        )
        .unwrap()["nextCursor"]
        .as_str()
        .unwrap()
        .to_owned();
    let e = code(w.svc.knowledge_get(
        &agent(),
        &KnowledgeGetRequest {
            part: Part::Metadata,
            cursor: Some(body_cursor),
            ..get(&doc["id"])
        },
    ));
    assert_eq!(e.details["reason"], "INVALID_OR_TAMPERED");
    // User 不走元数据分页；元数据分页不能带 section。
    assert_eq!(
        code(w.svc.knowledge_get(
            &user(),
            &KnowledgeGetRequest {
                part: Part::Metadata,
                ..get(&saved["id"])
            }
        ))
        .code,
        ErrorCode::INVALID_ARGUMENT
    );
    assert_eq!(
        code(w.svc.knowledge_get(
            &agent(),
            &KnowledgeGetRequest {
                part: Part::Metadata,
                section: Some("h-1".into()),
                ..get(&saved["id"])
            }
        ))
        .code,
        ErrorCode::INVALID_ARGUMENT
    );
}

/// 章节：按 id 或标题选；标题重复要求用 id；不存在 NOT_FOUND；空库搜索是空页。
#[test]
fn sections_and_an_empty_catalog() {
    let w = world("kr-sections");
    assert_eq!(
        w.svc
            .knowledge_search(&user(), &KnowledgeSearchRequest::default())
            .unwrap(),
        json!({ "hits": [], "hasMore": false, "nextCursor": null })
    );
    let a = w.put(content(
        "sec",
        "章节",
        "# 甲\n甲的内容\n## 乙\n乙的内容\n# 丙\n丙的内容\n## 乙\n又一个乙\n",
    ));
    let read = |section: &str| {
        w.svc.knowledge_get(
            &user(),
            &KnowledgeGetRequest {
                section: Some(section.into()),
                ..get(&a["id"])
            },
        )
    };
    assert_eq!(
        read("h-1").unwrap()["bodyMarkdown"],
        "# 甲\n甲的内容\n## 乙\n乙的内容\n"
    );
    assert_eq!(
        read("丙").unwrap()["bodyMarkdown"],
        "# 丙\n丙的内容\n## 乙\n又一个乙\n"
    );
    assert_eq!(read("h-4").unwrap()["bodyMarkdown"], "## 乙\n又一个乙\n");
    let e = code(read("乙"));
    assert_eq!(
        (e.code, e.details["candidateIds"].clone()),
        (ErrorCode::INVALID_ARGUMENT, json!(["h-2", "h-4"]))
    );
    assert_eq!(code(read("丁")).code, ErrorCode::NOT_FOUND);
}
