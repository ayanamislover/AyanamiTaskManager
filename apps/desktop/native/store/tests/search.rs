//! 搜索的验收（W1d）：增删改后结果正确、短词回退、范围过滤、VACUUM 后映射不变、知识 FTS 重建。

use atm_store::open;
use atm_store::search::{
    Doc, Hit, Scope, TermsError, check_fts, delete_doc, delete_project_docs, index_knowledge_entry,
    match_docs, rebuild_knowledge_fts, rebuild_search_fts, terms, upsert_doc,
};
use rusqlite::{Connection, params};
use std::path::PathBuf;

fn db_path(name: &str) -> PathBuf {
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("target")
        });
    let dir = target.join("store-tests").join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("atm.sqlite")
}

const T: &str = "2026-10-03T00:00:00.000Z";

/// 三个项目：PA、PB 为 ACTIVE，PT 已进回收站。
fn seeded(name: &str) -> Connection {
    let mut c = open(&db_path(name)).unwrap();
    let tx = c.transaction().unwrap();
    for (g, id, life) in [
        (1, "PA", "ACTIVE"),
        (2, "PB", "ACTIVE"),
        (3, "PT", "TRASHED"),
    ] {
        tx.execute(
            "INSERT INTO scope_generations (gen, scope_kind, scope_id, reason, epoch, created_at) VALUES (?1, 'PROJECT', ?2, 'CREATED', 'E', ?3)",
            params![g, id, T],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO projects (id, code, name, lifecycle, scope_gen, epoch, created_at, updated_at)
             VALUES (?1, ?1, ?1, ?2, ?3, 'E', ?4, ?4)",
            params![id, life, g, T],
        )
        .unwrap();
    }
    tx.commit().unwrap();
    c
}

fn doc<'a>(
    project_id: &'a str,
    id: &'a str,
    key: &'a str,
    title: &'a str,
    body: &'a str,
    at: &'a str,
) -> Doc<'a> {
    Doc {
        project_id,
        entity_type: "WORK_ITEM",
        entity_id: id,
        entity_key: key,
        title,
        body,
        updated_at: at,
    }
}

fn put(c: &mut Connection, d: Doc<'_>) {
    let tx = c.transaction().unwrap();
    upsert_doc(&tx, &d).unwrap();
    tx.commit().unwrap();
}

fn keys(c: &Connection, query: &str, scope: Scope<'_>) -> Vec<String> {
    let t = terms(query).unwrap();
    match_docs(c, &t, &scope, 100)
        .unwrap()
        .into_iter()
        .map(|h: Hit| h.entity_key)
        .collect()
}

fn pa(c: &Connection, query: &str) -> Vec<String> {
    keys(c, query, Scope::Project("PA"))
}

#[test]
fn edits_and_deletes_are_reflected_in_results() {
    let mut c = seeded("search-edits");
    put(
        &mut c,
        doc(
            "PA",
            "W1",
            "PA-T-0001",
            "Rewrite the storage layer",
            "single database file",
            T,
        ),
    );
    assert_eq!(pa(&c, "storage"), ["PA-T-0001"]);
    assert_eq!(pa(&c, "database"), ["PA-T-0001"]);

    // 同一实体再写一次：整体替换，旧词搜不到。
    put(
        &mut c,
        doc(
            "PA",
            "W1",
            "PA-T-0001",
            "Rewrite the event model",
            "single feed",
            "2026-10-03T01:00:00.000Z",
        ),
    );
    assert!(pa(&c, "storage").is_empty() && pa(&c, "database").is_empty());
    assert_eq!(pa(&c, "event"), ["PA-T-0001"]);
    check_fts(&c).unwrap();

    // 另一个项目里同 id 的文档不受删除影响。
    put(
        &mut c,
        doc("PB", "W1", "PB-T-0001", "event elsewhere", "", T),
    );
    let tx = c.transaction().unwrap();
    assert!(delete_doc(&tx, "PA", "WORK_ITEM", "W1").unwrap());
    assert!(!delete_doc(&tx, "PA", "WORK_ITEM", "W1").unwrap());
    tx.commit().unwrap();
    assert!(pa(&c, "event").is_empty());
    assert_eq!(keys(&c, "event", Scope::Project("PB")), ["PB-T-0001"]);
    check_fts(&c).unwrap();
}

#[test]
fn terms_and_their_fallbacks_match_like_2x() {
    let mut c = seeded("search-terms");
    put(
        &mut c,
        doc(
            "PA",
            "W1",
            "PA-T-0012",
            "D-398 HALF_OPEN 复审裁决",
            "breaker stays open; 50 percent",
            "2026-10-03T00:00:01.000Z",
        ),
    );
    put(
        &mut c,
        doc(
            "PA",
            "W2",
            "PA-T-0013",
            "复审流程说明",
            "500 items AND more",
            "2026-10-03T00:00:02.000Z",
        ),
    );
    put(
        &mut c,
        doc(
            "PA",
            "W3",
            "PA-T-0014",
            "ab test",
            "half open circuit",
            "2026-10-03T00:00:03.000Z",
        ),
    );

    // 多词各自命中、彼此 AND；词不必相邻。
    assert_eq!(pa(&c, "D-398 HALF_OPEN 复审裁决"), ["PA-T-0012"]);
    // 引号短语要求相邻。
    assert_eq!(pa(&c, "half open"), ["PA-T-0014", "PA-T-0012"]);
    assert_eq!(pa(&c, "\"half open\""), ["PA-T-0014"]);
    // key 片段：entity_key 不进 FTS，靠 LIKE 补。
    assert_eq!(pa(&c, "T-0013"), ["PA-T-0013"]);
    // 中文双字词、两字母词：不足 3 个 code point，走 LIKE。
    assert_eq!(pa(&c, "复审"), ["PA-T-0013", "PA-T-0012"]);
    assert_eq!(pa(&c, "ab"), ["PA-T-0014"]);
    assert_eq!(
        pa(&c, "50"),
        ["PA-T-0013", "PA-T-0012"],
        "a short term also searches the body"
    );
    // LIKE 元字符要转义：`0%` 不能当通配符匹配到 500。
    assert!(pa(&c, "0%").is_empty());
    assert_eq!(pa(&c, "0_i").len(), 0);
    // FTS 语法字面化：AND、连字符、冒号都只是字符。
    assert_eq!(pa(&c, "AND"), ["PA-T-0013"]);
    assert!(pa(&c, "open:").is_empty());
    // 大小写：ASCII 不区分。
    assert_eq!(pa(&c, "BREAKER"), ["PA-T-0012"]);
    // 没有词：空结果，不是全部。
    assert!(pa(&c, "   ").is_empty());
}

#[test]
fn query_parsing_follows_search_terms_ts() {
    assert_eq!(terms("  a  b\tc ").unwrap(), ["a", "b", "c"]);
    // 空白集合按 ECMAScript：U+0085 不是空白，U+FEFF、U+3000、U+2028 是。
    assert_eq!(terms("a\u{85}b").unwrap(), ["a\u{85}b"]);
    assert_eq!(
        terms("a\u{feff}b\u{3000}c\u{2028}d\u{0b}e").unwrap(),
        ["a", "b", "c", "d", "e"]
    );
    assert_eq!(
        terms("\u{85}x\u{85}").unwrap(),
        ["\u{85}x\u{85}"],
        "trim keeps U+0085 too"
    );
    assert_eq!(terms("\"half open\" x").unwrap(), ["half open", "x"]);
    assert_eq!(
        terms("ab\"cd ef\"").unwrap(),
        ["ab\"cd", "ef\""],
        "a quote only opens a phrase at the start of a term"
    );
    assert_eq!(
        terms("\"unclosed phrase").unwrap(),
        ["\"unclosed", "phrase"]
    );
    assert_eq!(terms("\"a b\"c").unwrap(), ["a b", "c"]);
    assert_eq!(
        terms("Foo foo FOO bar").unwrap(),
        ["Foo", "bar"],
        "dedupe is case-folded, first spelling wins"
    );
    assert_eq!(
        terms("\"  \" \"\" x").unwrap(),
        ["x"],
        "empty phrases are dropped"
    );
    assert_eq!(
        terms("a\u{3000}b\u{feff}c").unwrap(),
        ["a", "b", "c"],
        "unicode spaces split like JS \\s"
    );
    assert_eq!(terms("1 2 3 4 5 6 7 8").unwrap().len(), 8);
    assert_eq!(
        terms("1 2 3 4 5 6 7 8 9"),
        Err(TermsError::TooMany { actual: 9 })
    );
    assert_eq!(
        terms("1 2 3 4 5 6 7 8 8 8").unwrap().len(),
        8,
        "the limit counts distinct terms"
    );
}

#[test]
fn project_and_global_scopes_filter_by_project_and_lifecycle() {
    let mut c = seeded("search-scope");
    put(
        &mut c,
        doc(
            "PA",
            "W1",
            "PA-T-0001",
            "shared word alpha",
            "",
            "2026-10-03T00:00:01.000Z",
        ),
    );
    put(
        &mut c,
        doc(
            "PB",
            "W1",
            "PB-T-0001",
            "shared word beta",
            "",
            "2026-10-03T00:00:02.000Z",
        ),
    );
    put(
        &mut c,
        doc(
            "PT",
            "W1",
            "PT-T-0001",
            "shared word gamma",
            "",
            "2026-10-03T00:00:03.000Z",
        ),
    );
    assert_eq!(pa(&c, "shared"), ["PA-T-0001"]);
    assert_eq!(
        keys(
            &c,
            "shared",
            Scope::Global {
                lifecycles: &["ACTIVE", "ARCHIVED"]
            }
        ),
        ["PB-T-0001", "PA-T-0001"]
    );
    assert_eq!(
        keys(
            &c,
            "shared",
            Scope::Global {
                lifecycles: &["TRASHED"]
            }
        ),
        ["PT-T-0001"]
    );
    assert!(keys(&c, "shared", Scope::Global { lifecycles: &[] }).is_empty());

    // 删一个项目的全部文档，其他项目不受影响。
    let tx = c.transaction().unwrap();
    assert_eq!(delete_project_docs(&tx, "PB").unwrap(), 1);
    tx.commit().unwrap();
    assert_eq!(
        keys(
            &c,
            "shared",
            Scope::Global {
                lifecycles: &["ACTIVE"]
            }
        ),
        ["PA-T-0001"]
    );
    check_fts(&c).unwrap();
}

#[test]
fn vacuum_keeps_the_fts_rowid_mapping() {
    let mut c = seeded("search-vacuum");
    let ids: Vec<String> = (0..60).map(|i| format!("W{i}")).collect();
    let tx = c.transaction().unwrap();
    for (i, id) in ids.iter().enumerate() {
        let key = format!("PA-T-{i:04}");
        let title = format!("token{i:02}x common");
        upsert_doc(&tx, &doc("PA", id, &key, &title, "", T)).unwrap();
    }
    // 删掉偶数号，在 rowid 里留下空洞。
    for id in ids.iter().step_by(2) {
        delete_doc(&tx, "PA", "WORK_ITEM", id).unwrap();
    }
    tx.commit().unwrap();
    let doc_ids = |c: &Connection| -> Vec<(i64, String)> {
        let mut st = c
            .prepare("SELECT rowid, entity_id FROM search_docs ORDER BY rowid")
            .unwrap();
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    // FTS 按 rowid 指回内容表。SQLite 只保证显式 INTEGER PRIMARY KEY 在 VACUUM 后不变，
    // 隐式 rowid「可能」被重排（当前打包的版本实测没有重排，不能拿 VACUUM 当守卫），
    // 所以直接要求 doc_id 就是 rowid 的别名。
    let not_alias: i64 = c
        .query_row(
            "SELECT count(*) FROM search_docs WHERE doc_id IS NOT rowid",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(not_alias, 0, "doc_id must be the rowid alias");
    let before = doc_ids(&c);
    c.execute_batch("VACUUM").unwrap();
    assert_eq!(
        doc_ids(&c),
        before,
        "VACUUM must not renumber the rowids the index points at"
    );
    check_fts(&c).unwrap();
    for i in 0..60 {
        let hit = pa(&c, &format!("token{i:02}x"));
        if i % 2 == 0 {
            assert!(hit.is_empty(), "deleted doc {i} came back as {hit:?}");
        } else {
            assert_eq!(hit, [format!("PA-T-{i:04}")]);
        }
    }
    assert_eq!(pa(&c, "common").len(), 30);

    // 索引被清空：一致性检查必须发现它和内容表对不上；整表 rebuild 之后恢复。
    c.execute(
        "INSERT INTO search_fts (search_fts) VALUES ('delete-all')",
        [],
    )
    .unwrap();
    assert!(
        check_fts(&c).is_err(),
        "an emptied index must fail the content check"
    );
    assert!(pa(&c, "token01x").is_empty());
    let tx = c.transaction().unwrap();
    rebuild_search_fts(&tx).unwrap();
    tx.commit().unwrap();
    check_fts(&c).unwrap();
    assert_eq!(pa(&c, "token01x"), ["PA-T-0001"]);
}

fn knowledge_entry(c: &Connection, id: &str, head: i64, snapshots: &[&str]) {
    for (i, s) in snapshots.iter().enumerate() {
        c.execute(
            "INSERT INTO knowledge_revisions (entry_id, revision, revision_id, snapshot) VALUES (?1, ?2, ?3, ?4)",
            params![id, i as i64 + 1, format!("{id}-R{}", i + 1), s],
        )
        .unwrap();
    }
    c.execute(
        "INSERT INTO knowledge_entries (id, slug, head_revision, version, archived) VALUES (?1, ?1, ?2, ?2, 0)
         ON CONFLICT (id) DO UPDATE SET head_revision = excluded.head_revision, version = excluded.version",
        params![id, head],
    )
    .unwrap();
}

fn knowledge_hits(c: &Connection, phrase: &str) -> Vec<String> {
    let mut st = c
        .prepare(
            "SELECT entry_id FROM knowledge_fts WHERE knowledge_fts MATCH ?1 ORDER BY entry_id",
        )
        .unwrap();
    st.query_map([format!("\"{phrase}\"")], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

#[test]
fn knowledge_fts_is_rebuilt_from_head_revisions() {
    let mut c = seeded("search-knowledge");
    let tx = c.transaction().unwrap();
    knowledge_entry(
        &tx,
        "K1",
        2,
        &[
            r#"{"title":"Old storage notes","aliases":[],"tags":[],"summary":"","useWhen":"","appliesTo":[],"bodyMarkdown":"legacy"}"#,
            r#"{"title":"Single database","aliases":["one file","atm db"],"tags":["store","w1"],"summary":"why one file","useWhen":"designing storage","appliesTo":["atm3"],"bodyMarkdown":"write ahead log","sourceRefs":["x"]}"#,
        ],
    );
    knowledge_entry(
        &tx,
        "K2",
        1,
        &[
            r#"{"title":"Breaker","aliases":["circuit"],"tags":[],"summary":"","useWhen":"","appliesTo":[],"bodyMarkdown":"half open"}"#,
        ],
    );
    rebuild_knowledge_fts(&tx).unwrap();
    tx.commit().unwrap();

    assert_eq!(knowledge_hits(&c, "Single database"), ["K1"]);
    assert!(
        knowledge_hits(&c, "Old storage").is_empty(),
        "only the head revision is indexed"
    );
    assert!(knowledge_hits(&c, "legacy").is_empty());
    assert_eq!(knowledge_hits(&c, "write ahead"), ["K1"]);
    let (aliases, tags, applies, metadata): (String, String, String, String) = c
        .query_row(
            "SELECT aliases, tags, applies_to, metadata FROM knowledge_fts WHERE entry_id = 'K1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!(
        (aliases.as_str(), tags.as_str(), applies.as_str()),
        ("one file\natm db", "store\nw1", "atm3")
    );
    let meta: (Option<String>, Option<String>, Option<String>, String, i64, String) = c
        .query_row(
            "SELECT ?1 ->> '$.bodyMarkdown', ?1 ->> '$.aliases', ?1 ->> '$.sourceRefs', ?1 ->> '$.title', ?1 ->> '$.version', json_type(?1, '$.archived')",
            [&metadata],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .unwrap();
    assert_eq!(
        meta,
        (
            None,
            None,
            None,
            "Single database".into(),
            2,
            "false".into()
        )
    );

    // 单条重建：K2 发布新 head 之后只改它自己的行。
    let tx = c.transaction().unwrap();
    tx.execute(
        "INSERT INTO knowledge_revisions (entry_id, revision, revision_id, snapshot) VALUES ('K2', 2, 'K2-R2', ?1)",
        [r#"{"title":"Circuit breaker v2","aliases":[],"tags":[],"summary":"","useWhen":"","appliesTo":[],"bodyMarkdown":"closed"}"#],
    )
    .unwrap();
    tx.execute(
        "UPDATE knowledge_entries SET head_revision = 2, version = 2 WHERE id = 'K2'",
        [],
    )
    .unwrap();
    index_knowledge_entry(&tx, "K2").unwrap();
    tx.commit().unwrap();
    assert_eq!(knowledge_hits(&c, "breaker v2"), ["K2"]);
    assert!(knowledge_hits(&c, "half open").is_empty());
    assert_eq!(knowledge_hits(&c, "Single database"), ["K1"]);
    let rows: i64 = c
        .query_row("SELECT count(*) FROM knowledge_fts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 2);
    check_fts(&c).unwrap();
}
