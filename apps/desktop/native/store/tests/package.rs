//! 项目包（W6c，方案 §4、00 C-07 v6、05 §7-3、r2 A4）：导出 `.aytproj` v2 / JSON / CSV，导入 v2、v1、2.x 的
//! 项目与知识库备份。
//!
//! - 导出 → 导入往返：新项目逐表与原项目相同（除了导入时按约定改写的列），附件逐字节相同，manifest 绑定附件哈希；
//!   包里只有这一个项目（别的项目、全局表、知识库、回执、`app_meta` 都没有）。
//! - 被改过的包（附件、清单、条目名、迁移、快照）一律拒绝，库与附件根一个字节都不变。
//! - 2.x：v1 包与 2.x 项目备份经转换器作为新项目导入；2.x 知识库备份合并、不覆盖。反例：错的种类、坏库。

use atm_store::backup::artifacts_root;
use atm_store::events::{NewEvent, append_event, next_number};
use atm_store::package::{
    self, ExportOptions, Format, ImportOptions, ImportSource, NOT_PACKAGED, PACKAGED_TABLES,
    PackageError,
};
use atm_store::restore::PROJECT_TABLES;
use atm_store::search::{Doc, Scope, match_docs, terms, upsert_doc};
use atm_store::{Config, Store};
use rusqlite::{Connection, OptionalExtension, params};
use sha2::Digest;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

const T0: &str = "2026-10-03T00:00:00.000Z";
const T1: &str = "2026-10-03T01:00:00.000Z";
const T2: &str = "2026-10-03T02:00:00.000Z";

struct World {
    dir: PathBuf,
    store: Store,
    exports: PathBuf,
}

fn dir(name: &str) -> PathBuf {
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("target")
        });
    let d = target.join("store-tests").join(name);
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

fn world(name: &str) -> World {
    let d = dir(name);
    fs::create_dir_all(d.join("data")).unwrap();
    let store = Store::open(
        &d.join("data").join("atm.sqlite"),
        Config {
            write_budget: Duration::from_secs(30),
            ..Config::default()
        },
    )
    .unwrap();
    let pa_art = artifacts_root(store.path()).join("PA");
    let pa_art = pa_art.to_str().unwrap().to_string();
    store
        .write(move |tx| {
            tx.execute_batch(&format!(
                "INSERT INTO app_meta (singleton, schema_version, data_root_id, generation, instance_epoch, scope_gen_counter, created_at, updated_at)
                   VALUES (1, 1, 'ROOT', 'G', 'EPOCH-1', 3, '{T0}', '{T0}');
                 INSERT INTO scope_generations (gen, scope_kind, scope_id, reason, epoch, created_at) VALUES
                   (1, 'PROJECT', 'PA', 'CREATED', 'EA', '{T0}'),
                   (2, 'PROJECT', 'PB', 'CREATED', 'EB', '{T0}'),
                   (3, 'KNOWLEDGE', 'KDB', 'CREATED', 'EK', '{T0}');
                 INSERT INTO knowledge_meta (singleton, database_id, generation, sequence, scope_gen) VALUES (1, 'KDB', 'KG0', 5, 3);
                 INSERT INTO knowledge_revisions (entry_id, revision, revision_id, snapshot) VALUES
                   ('K-OLD', 1, 'K-OLD-R1', '{{\"title\":\"Present\",\"aliases\":[],\"tags\":[],\"summary\":\"\",\"useWhen\":\"\",\"appliesTo\":[],\"bodyMarkdown\":\"kept\"}}');
                 INSERT INTO knowledge_entries (id, slug, head_revision, version, archived) VALUES ('K-OLD', 'single-db', 1, 1, 0);
                 INSERT INTO project_paths (id, project_id, path_key, canonical_path, is_primary, last_seen_at)
                   VALUES ('PP1', 'PA', 'c:/work/pa', 'C:/work/pa', 1, '{T0}');
                 INSERT INTO idempotency_receipts (scope_kind, scope_id, ns_kind, ns_id, op_id, operation, fp_v, fp_family, fingerprint,
                                                   receipt_json, scope_generation, created_at)
                   VALUES ('PROJECT', 'PA', 'SESSION', 'S1', 'op-1', 'op', 2, 'canon-v2', 'fp', '{{}}', 1, '{T0}');"
            ))?;
            for (id, code, g, e) in [("PA", "ALPHA", 1, "EA"), ("PB", "BRAVO", 2, "EB")] {
                tx.execute(
                    "INSERT INTO projects (id, code, name, description, lifecycle, health, meta_version, project_seq, scope_gen, epoch, created_at, updated_at)
                     VALUES (?1, ?2, ?2 || ' name', 'desc ' || ?2, 'ACTIVE', 'ON_TRACK', 4, 0, ?3, ?4, ?5, ?5)",
                    params![id, code, g, e, T0],
                )?;
                tx.execute(
                    "INSERT INTO objectives (project_id, id, local_no, title, status, created_at, updated_at) VALUES (?1, 'OBJ', 1, 'o', 'ACTIVE', ?2, ?2)",
                    params![id, T0],
                )?;
                tx.execute("INSERT INTO counters (project_id, name, next_value) VALUES (?1, 'work_item', 1)", [id])?;
                tx.execute(
                    "INSERT INTO agents (project_id, id, display_name, client_kind, created_at, updated_at) VALUES (?1, 'claude', 'Claude', 'cli', ?2, ?2)",
                    params![id, T0],
                )?;
                tx.execute(
                    "INSERT INTO agent_sessions (project_id, id, agent_id, role, work_state, connection_state, started_at, updated_at, client_identity)
                     VALUES (?1, 'S1', 'claude', 'PRIMARY', 'WORKING', 'ONLINE', ?2, ?2, '42:1000')",
                    params![id, T0],
                )?;
                tx.execute(
                    "INSERT INTO agent_sessions (project_id, id, agent_id, role, work_state, connection_state, started_at, updated_at, closed_at, close_reason,
                                                 client_identity)
                     VALUES (?1, 'S0', 'claude', 'PRIMARY', 'IDLE', 'CLOSED', ?2, ?2, ?2, 'EXPLICIT_END', '43:1000')",
                    params![id, T0],
                )?;
            }
            tx.execute(
                "INSERT INTO artifacts (project_id, id, kind, name, local_path, sha256, size_bytes, actor, created_at)
                 VALUES ('PA', 'A1', 'FILE', 'notes', ?1 || char(92) || 'docs' || char(92) || 'notes.txt', NULL, NULL, 'USER', ?2),
                        ('PA', 'A2', 'LINK', 'elsewhere', 'D:' || char(92) || 'outside.txt', NULL, NULL, 'USER', ?2)",
                params![pa_art, T0],
            )?;
            tx.execute(
                "INSERT INTO import_history (source_sha256, project_id, result_json, imported_at) VALUES ('abc', 'PA', '{}', ?1)",
                [T0],
            )?;
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    let w = World {
        exports: d.join("exports"),
        dir: d,
        store,
    };
    task(&w, "PA", "alpha first", Some("S1"), T1);
    task(&w, "PA", "alpha, \"quoted\" second", None, T1);
    task(&w, "PB", "bravo secret", None, T1);
    attachment(&w, "PA", "docs/notes.txt", "alpha attachment");
    attachment(&w, "PA", "b.bin", "binary-ish");
    attachment(&w, "PB", "secret.txt", "bravo only");
    w
}

fn task(w: &World, project: &str, title: &str, claim: Option<&str>, at: &str) {
    let (project, title, claim, at) = (
        project.to_string(),
        title.to_string(),
        claim.map(str::to_string),
        at.to_string(),
    );
    w.store
        .write(move |tx| {
            let no = next_number(tx, &project, "work_item").unwrap();
            let id = format!("{project}-W{no}");
            tx.execute(
                "INSERT INTO work_items (project_id, id, local_no, objective_id, type, title, status, priority, claimed_by_session_id,
                                         computed_progress, blocked_reason, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 'OBJ', 'TASK', ?4, 'IN_PROGRESS', 'NORMAL', ?5, 0.5, 'waits', ?6, ?6)",
                params![project, id, no, title, claim, at],
            )?;
            tx.execute(
                "INSERT INTO progress_updates (project_id, id, work_item_id, summary, summary_hash, actor, created_at)
                 VALUES (?1, ?2 || '-U', ?2, 'latest for ' || ?3, 'h', 'claude', ?4)",
                params![project, id, title, at],
            )?;
            append_event(
                tx,
                &NewEvent {
                    project_id: &project,
                    kind: "work.created",
                    actor_type: "AGENT",
                    actor_id: "claude",
                    session_id: claim.as_deref(),
                    aggregate_type: "WORK_ITEM",
                    aggregate_id: &id,
                    correlation_id: None,
                    op_id: None,
                    payload_json: "{}",
                    at: &at,
                },
            )
            .unwrap();
            append_event(
                tx,
                &NewEvent {
                    project_id: &project,
                    kind: "project.updated",
                    actor_type: "USER",
                    actor_id: "USER",
                    session_id: None,
                    aggregate_type: "PROJECT",
                    aggregate_id: &project,
                    correlation_id: None,
                    op_id: None,
                    payload_json: "{}",
                    at: &at,
                },
            )
            .unwrap();
            let key = format!("{project}-T-{no:04}");
            upsert_doc(
                tx,
                &Doc {
                    project_id: &project,
                    entity_type: "WORK_ITEM",
                    entity_id: &id,
                    entity_key: &key,
                    title: &title,
                    body: "",
                    updated_at: &at,
                },
            )?;
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
}

fn attachment(w: &World, project: &str, rel: &str, body: &str) {
    let path = artifacts_root(w.store.path()).join(project).join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, body).unwrap();
}

fn export(w: &World, project: &str, format: Format, at: &str) -> package::Exported {
    package::export_project(
        &w.store,
        project,
        format,
        &ExportOptions {
            exports_dir: &w.exports,
            at,
            app_version: "3.0.0-test",
        },
    )
    .unwrap()
}

fn import(
    w: &World,
    source: ImportSource<'_>,
    code: Option<&str>,
) -> Result<package::Imported, PackageError> {
    package::import_project(
        &w.store,
        source,
        &ImportOptions {
            exports_dir: &w.exports,
            at: T2,
            code,
            source_label: "test",
        },
    )
}

/// 一个项目在某张表里的全部行（不含 project_id 与 `skip` 列），按 rowid 之外的内容排序，便于比较。
fn rows(w: &World, table: &str, project: &str, skip: &[&str]) -> Vec<String> {
    let (table, project) = (table.to_string(), project.to_string());
    let skip: Vec<String> = skip.iter().map(|s| s.to_string()).collect();
    w.store
        .read(move |tx| {
            let cols: Vec<String> = tx
                .prepare(&format!(
                    "SELECT name FROM pragma_table_info('{table}') ORDER BY cid"
                ))?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            let cols: Vec<&String> = cols
                .iter()
                .filter(|c| {
                    c.as_str() != "project_id" && c.as_str() != "doc_id" && !skip.contains(c)
                })
                .collect();
            let expr = cols
                .iter()
                .map(|c| format!("quote({c})"))
                .collect::<Vec<_>>()
                .join(" || '|' || ");
            let mut out: Vec<String> = tx
                .prepare(&format!("SELECT {expr} FROM {table} WHERE project_id = ?1"))?
                .query_map([&project], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            out.sort();
            Ok::<_, rusqlite::Error>(out)
        })
        .unwrap()
}

fn one<T: rusqlite::types::FromSql + Send + 'static>(
    w: &World,
    sql: &str,
    p: &[&str],
) -> Option<T> {
    let sql = sql.to_string();
    let p: Vec<String> = p.iter().map(|s| s.to_string()).collect();
    w.store
        .read(move |tx| {
            tx.query_row(&sql, rusqlite::params_from_iter(p), |r| r.get(0))
                .optional()
        })
        .unwrap()
}

fn tree(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    fn walk(root: &Path, d: &Path, out: &mut Vec<(String, Vec<u8>)>) {
        let Ok(it) = fs::read_dir(d) else { return };
        for e in it {
            let p = e.unwrap().path();
            if p.is_dir() {
                walk(root, &p, out);
            } else {
                let rel = p
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push((rel, fs::read(&p).unwrap()));
            }
        }
    }
    walk(dir, dir, &mut out);
    out.sort();
    out
}

/// 库的全部业务内容（逐表）。用来证明「什么都没变」。
fn fingerprint(w: &World) -> Vec<String> {
    w.store
        .read(|tx| {
            let tables: Vec<String> = tx
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                       AND name NOT LIKE '%_fts%' ORDER BY name",
                )?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            let mut out = Vec::new();
            for t in tables {
                let n: i64 = tx.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get(0))?;
                out.push(format!("{t}:{n}"));
            }
            out.push(tx.query_row("SELECT quote(scope_gen_counter) || quote(global_seq) FROM app_meta", [], |r| r.get(0))?);
            Ok::<_, rusqlite::Error>(out)
        })
        .unwrap()
}

/// zip 的条目：（名字，内容）。
type Entries = Vec<(String, Vec<u8>)>;

fn entries(zip_path: &Path) -> Entries {
    let mut a = zip::ZipArchive::new(fs::File::open(zip_path).unwrap()).unwrap();
    let mut out = Vec::new();
    for i in 0..a.len() {
        let mut e = a.by_index(i).unwrap();
        let mut b = Vec::new();
        e.read_to_end(&mut b).unwrap();
        out.push((e.name().to_string(), b));
    }
    out
}

fn write_zip(path: &Path, entries: &[(String, Vec<u8>)]) {
    let mut z = zip::ZipWriter::new(fs::File::create(path).unwrap());
    let o = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (n, b) in entries {
        z.start_file(n.as_str(), o).unwrap();
        z.write_all(b).unwrap();
    }
    z.finish().unwrap();
}

fn sha(b: &[u8]) -> String {
    sha2::Sha256::digest(b)
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
}

fn search(w: &World, word: &str, project: String) -> usize {
    let t = terms(word).unwrap();
    let p: &'static str = Box::leak(project.into_boxed_str());
    w.store
        .read(move |tx| match_docs(tx, &t, &Scope::Project(p), 50))
        .unwrap()
        .len()
}

#[test]
fn every_table_with_a_project_column_is_packaged_or_excluded() {
    let w = world("package-coverage");
    let tables: Vec<String> = w
        .store
        .read(|tx| {
            tx.prepare(
                "SELECT m.name FROM sqlite_master m JOIN pragma_table_info(m.name) c
                 WHERE m.type = 'table' AND c.name = 'project_id' ORDER BY m.name",
            )?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()
        })
        .unwrap();
    let listed: Vec<&str> = PACKAGED_TABLES
        .iter()
        .copied()
        .chain(NOT_PACKAGED.iter().map(|(t, _)| *t))
        .collect();
    for t in &tables {
        assert!(
            listed.contains(&t.as_str()),
            "{t} has project_id but no package decision"
        );
    }
    for t in &listed {
        assert!(
            tables.iter().any(|x| x == t),
            "{t} is listed but has no project_id column"
        );
    }
    assert_eq!(listed.len(), tables.len(), "no table is listed twice");
    // 按范围恢复替换的工作数据都要进包。
    for t in PROJECT_TABLES {
        assert!(
            PACKAGED_TABLES.contains(t),
            "{t} is restored per project but not packaged"
        );
    }
}

#[test]
fn an_exported_package_imports_as_an_identical_new_project() {
    let w = world("package-roundtrip");
    let before_pa: Vec<Vec<String>> = PACKAGED_TABLES
        .iter()
        .map(|t| rows(&w, t, "PA", &[]))
        .collect();
    let exported = export(&w, "PA", Format::Package, T1);
    assert_eq!(exported.project_code, "ALPHA");
    assert_eq!(
        exported.path,
        w.exports.join("ALPHA-2026-10-03T01-00-00-000Z.aytproj")
    );
    assert_eq!(exported.attachments, 2);
    assert_eq!(exported.sha256, sha(&fs::read(&exported.path).unwrap()));
    // 暂存清干净了，exports 里只有这个包。
    let left: Vec<_> = fs::read_dir(w.exports.join(".staging")).unwrap().collect();
    assert!(left.is_empty(), "staging left behind: {left:?}");

    // 包的内容：只有约定的条目；SHA256SUMS 覆盖库与附件；manifest 绑定附件清单与摘要。
    let e = entries(&exported.path);
    let mut names: Vec<&str> = e.iter().map(|(n, _)| n.as_str()).collect();
    names.sort();
    assert_eq!(
        names,
        [
            "SHA256SUMS.txt",
            "artifacts/b.bin",
            "artifacts/docs/notes.txt",
            "manifest.json",
            "project.sqlite"
        ]
    );
    let get = |n: &str| e.iter().find(|(x, _)| x == n).unwrap().1.clone();
    let db_bytes = get("project.sqlite");
    let sums = String::from_utf8(get("SHA256SUMS.txt")).unwrap();
    assert_eq!(
        sums,
        format!(
            "{}  project.sqlite\n{}  artifacts/b.bin\n{}  artifacts/docs/notes.txt\n",
            sha(&db_bytes),
            sha(b"binary-ish"),
            sha(b"alpha attachment")
        )
    );
    let m: serde_json::Value = serde_json::from_slice(&get("manifest.json")).unwrap();
    assert_eq!(m["format"], "ayanami-task-project");
    assert_eq!(m["formatVersion"], 2);
    assert_eq!(
        m["project"],
        serde_json::json!({"id": "PA", "code": "ALPHA", "name": "ALPHA name"})
    );
    assert_eq!(m["snapshotSha256"], sha(&db_bytes));
    assert_eq!(m["counts"]["work_items"], 2);
    assert_eq!(m["attachments"]["files"][1]["path"], "docs/notes.txt");
    assert_eq!(
        m["attachments"]["files"][1]["sha256"],
        sha(b"alpha attachment")
    );

    // 包里的库只有这个项目：别的项目、全局表、知识库、回执、app_meta 都是空的，空闲页里也没有别的项目的字。
    let unpacked = w.dir.join("unpacked.sqlite");
    fs::write(&unpacked, &db_bytes).unwrap();
    {
        let c = Connection::open(&unpacked).unwrap();
        let n = |sql: &str| -> i64 { c.query_row(sql, [], |r| r.get(0)).unwrap() };
        assert_eq!(n("SELECT count(*) FROM projects"), 1);
        assert_eq!(
            n("SELECT count(*) FROM work_items WHERE project_id <> 'PA'"),
            0
        );
        for t in [
            "app_meta",
            "knowledge_entries",
            "knowledge_meta",
            "idempotency_receipts",
            "project_paths",
            "global_feed",
            "backups",
        ] {
            assert_eq!(
                n(&format!("SELECT count(*) FROM {t}")),
                0,
                "{t} leaked into the package"
            );
        }
        assert_eq!(
            n("SELECT count(*) FROM artifacts WHERE local_path = 'artifacts/docs/notes.txt'"),
            1,
            "the attachment row points into the package"
        );
        assert_eq!(
            n("SELECT count(*) FROM artifacts WHERE local_path LIKE 'D:%'"),
            1
        );
    }
    let raw = String::from_utf8_lossy(&db_bytes).into_owned();
    assert!(
        !raw.contains("bravo secret") && !raw.contains("BRAVO"),
        "another project's text is in the file"
    );

    // 预览：只读，库与附件根不变。
    let fp = fingerprint(&w);
    let art_before = tree(&artifacts_root(w.store.path()));
    let seen = package::inspect_package(&exported.path).unwrap();
    assert_eq!(seen.format_version, 2);
    assert_eq!(seen.project.code, "ALPHA");
    assert_eq!(seen.attachments.len(), 2);
    assert_eq!(seen.counts.as_ref().unwrap()["work_items"], 2);
    assert_eq!(
        package::code_status(&w.store, "ALPHA").unwrap().as_deref(),
        Some("ALPHA2")
    );
    assert_eq!(package::code_status(&w.store, "OTHER").unwrap(), None);
    assert_eq!(fingerprint(&w), fp);
    assert_eq!(tree(&artifacts_root(w.store.path())), art_before);

    // 代码被占：拒绝，给出建议，什么都不变。
    match import(&w, ImportSource::Package(&exported.path), None) {
        Err(PackageError::CodeTaken { code, suggested }) => {
            assert_eq!((code.as_str(), suggested.as_str()), ("ALPHA", "ALPHA2"));
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(fingerprint(&w), fp);
    assert_eq!(tree(&artifacts_root(w.store.path())), art_before);

    let got = import(&w, ImportSource::Package(&exported.path), Some("ALPHA2")).unwrap();
    assert_eq!(got.code, "ALPHA2");
    assert_eq!(got.name, "ALPHA name");
    assert_eq!(got.source_project_id, "PA");
    assert_eq!(got.attachments, 2);
    assert_eq!(got.sessions_closed, 1);
    let new = got.project_id.clone();
    assert_ne!(new, "PA");

    // 逐表与原项目相同，除了约定改写的列。
    for (t, before) in PACKAGED_TABLES.iter().zip(&before_pa) {
        let skip: &[&str] = match *t {
            "agent_sessions" => &[
                "connection_state",
                "work_state",
                "current_work_item_id",
                "closed_at",
                "close_reason",
                "retirement_reason",
                "client_identity",
                "updated_at",
                "version",
            ],
            "events" => &["aggregate_id"],
            "artifacts" => &["local_path"],
            "work_items" => &["last_session_closed_at"],
            _ => &[],
        };
        let orig = if skip.is_empty() {
            before.clone()
        } else {
            rows(&w, t, "PA", skip)
        };
        assert_eq!(
            rows(&w, t, &new, skip),
            orig,
            "{t} differs after the round trip"
        );
    }
    // 原项目一点没动。
    for (t, before) in PACKAGED_TABLES.iter().zip(&before_pa) {
        assert_eq!(
            &rows(&w, t, "PA", &[]),
            before,
            "{t} of the source project changed"
        );
    }
    // 项目行：新身份、新世代（IMPORTED）、新 epoch；名字、描述、序号照旧。
    let row: String = one(&w, "SELECT code || '|' || name || '|' || description || '|' || lifecycle || '|' || meta_version || '|' || project_seq || '|' || version FROM projects WHERE id = ?1", &[&new]).unwrap();
    assert_eq!(row, "ALPHA2|ALPHA name|desc ALPHA|ACTIVE|4|4|0");
    let reason: String = one(&w, "SELECT g.reason FROM projects p JOIN scope_generations g ON g.gen = p.scope_gen WHERE p.id = ?1", &[&new]).unwrap();
    assert_eq!(reason, "IMPORTED");
    let epochs: i64 = one(&w, "SELECT count(DISTINCT epoch) FROM projects", &[]).unwrap();
    assert_eq!(epochs, 3);
    // 改写的列：项目事件指向新 id；附件行指向这台电脑上的新位置；在线 session 关闭、没有客户端身份。
    let agg: i64 = one(&w, "SELECT count(*) FROM events WHERE project_id = ?1 AND aggregate_type = 'PROJECT' AND aggregate_id = ?1", &[&new]).unwrap();
    assert_eq!(agg, 2);
    let local: String = one(
        &w,
        "SELECT local_path FROM artifacts WHERE project_id = ?1 AND id = 'A1'",
        &[&new],
    )
    .unwrap();
    assert_eq!(
        PathBuf::from(local),
        artifacts_root(w.store.path())
            .join(&new)
            .join("docs")
            .join("notes.txt")
    );
    let outside: String = one(
        &w,
        "SELECT local_path FROM artifacts WHERE project_id = ?1 AND id = 'A2'",
        &[&new],
    )
    .unwrap();
    assert_eq!(outside, "D:\\outside.txt");
    let online: i64 = one(&w, "SELECT count(*) FROM agent_sessions WHERE project_id = ?1 AND (connection_state <> 'CLOSED' OR client_identity IS NOT NULL)", &[&new]).unwrap();
    assert_eq!(online, 0);
    let closed: String = one(&w, "SELECT close_reason || '|' || retirement_reason FROM agent_sessions WHERE project_id = ?1 AND id = 'S1'", &[&new]).unwrap();
    assert_eq!(closed, "FORCE_CLOSE|imported copy");
    let stale: i64 = one(&w, "SELECT count(*) FROM work_items WHERE project_id = ?1 AND claimed_by_session_id = 'S1' AND last_session_closed_at = ?2", &[&new, T2]).unwrap();
    assert_eq!(stale, 1);
    // 附件逐字节相同；原项目的附件还在。
    let root = artifacts_root(w.store.path());
    assert_eq!(tree(&root.join(&new)), tree(&root.join("PA")));
    assert_eq!(
        tree(&root.join("PB")),
        vec![("secret.txt".to_string(), b"bravo only".to_vec())]
    );
    // 搜索、全局事件、不带过来的东西。
    assert_eq!(search(&w, "alpha", new.clone()), 2);
    let ev: String = one(&w, "SELECT payload_json FROM global_feed WHERE type = 'project.imported' AND aggregate_id = ?1", &[&new]).unwrap();
    let ev: serde_json::Value = serde_json::from_str(&ev).unwrap();
    assert_eq!(ev["sourceProjectId"], "PA");
    assert_eq!(ev["format"], "aytproj-v2");
    assert_eq!(ev["packageSha256"], exported.sha256);
    let paths: i64 = one(
        &w,
        "SELECT count(*) FROM project_paths WHERE project_id = ?1",
        &[&new],
    )
    .unwrap();
    assert_eq!(paths, 0);
    let receipts: i64 = one(
        &w,
        "SELECT count(*) FROM idempotency_receipts WHERE scope_id = ?1",
        &[&new],
    )
    .unwrap();
    assert_eq!(receipts, 0);
    let ok: String = w
        .store
        .write(|tx| {
            let fk: i64 =
                tx.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
                    r.get(0)
                })?;
            assert_eq!(fk, 0);
            tx.query_row("PRAGMA integrity_check", [], |r| r.get(0))
        })
        .unwrap();
    assert_eq!(ok, "ok");
    assert!(
        fs::read_dir(w.exports.join(".staging"))
            .unwrap()
            .next()
            .is_none()
    );
}

#[test]
fn json_and_csv_exports_hold_only_the_project() {
    let w = world("package-json-csv");
    let j = export(&w, "PA", Format::Json, T1);
    assert!(j.path.ends_with("ALPHA-2026-10-03T01-00-00-000Z.json"));
    let v: serde_json::Value = serde_json::from_slice(&fs::read(&j.path).unwrap()).unwrap();
    assert_eq!(v["format"], 2);
    assert_eq!(v["project"]["code"], "ALPHA");
    assert_eq!(v["data"]["work_items"].as_array().unwrap().len(), 2);
    assert_eq!(v["data"]["projects"].as_array().unwrap().len(), 1);
    assert!(v["data"].get("search_docs").is_none());
    assert!(v["data"].get("app_meta").is_none());
    let text = String::from_utf8(fs::read(&j.path).unwrap()).unwrap();
    assert!(!text.contains("bravo") && !text.contains("BRAVO"));

    let c = export(&w, "PA", Format::Csv, T1);
    let bytes = fs::read(&c.path).unwrap();
    assert!(bytes.starts_with("\u{FEFF}".as_bytes()));
    let text = String::from_utf8(bytes[3..].to_vec()).unwrap();
    let lines: Vec<&str> = text.split("\r\n").collect();
    assert_eq!(
        lines[0],
        "project_code,task_key,parent_key,type,title,status,priority,assignee,target_date,progress,blocker,latest_update"
    );
    assert_eq!(
        lines[1],
        "ALPHA,ALPHA-T-0001,,TASK,alpha first,IN_PROGRESS,NORMAL,,,0.5,waits,latest for alpha first"
    );
    assert_eq!(
        lines[2],
        "ALPHA,ALPHA-T-0002,,TASK,\"alpha, \"\"quoted\"\" second\",IN_PROGRESS,NORMAL,,,0.5,waits,\"latest for alpha, \"\"quoted\"\" second\""
    );
    assert_eq!(lines[3], "");
    assert_eq!(lines.len(), 4);

    // 同一时刻再导一次：不覆盖前一个。
    let again = export(&w, "PA", Format::Csv, T1);
    assert_ne!(again.path, c.path);
    assert!(c.path.exists());
    // 没有这个项目。
    let missing = package::export_project(
        &w.store,
        "NOPE",
        Format::Package,
        &ExportOptions {
            exports_dir: &w.exports,
            at: T1,
            app_version: "x",
        },
    );
    assert!(
        matches!(missing, Err(PackageError::NotFound(_))),
        "{missing:?}"
    );
}

#[test]
fn tampered_packages_are_refused_without_changes() {
    let w = world("package-tamper");
    let good = export(&w, "PA", Format::Package, T1).path;
    let original = entries(&good);
    let fp = fingerprint(&w);
    let root = artifacts_root(w.store.path());
    let art = tree(&root);
    let replace = |name: &str, body: &[u8]| -> Vec<(String, Vec<u8>)> {
        original
            .iter()
            .map(|(n, b)| (n.clone(), if n == name { body.to_vec() } else { b.clone() }))
            .collect()
    };
    let manifest: serde_json::Value = serde_json::from_slice(
        &original
            .iter()
            .find(|(n, _)| n == "manifest.json")
            .unwrap()
            .1,
    )
    .unwrap();
    let with_manifest = |f: &dyn Fn(&mut serde_json::Value)| {
        let mut m = manifest.clone();
        f(&mut m);
        replace(
            "manifest.json",
            serde_json::to_string(&m).unwrap().as_bytes(),
        )
    };
    let mut extra = original.clone();
    extra.push(("artifacts/unlisted.txt".into(), b"x".to_vec()));
    let mut traversal = original.clone();
    traversal.push(("artifacts/../escape.txt".into(), b"x".to_vec()));
    let mut stray = original.clone();
    stray.push(("readme.txt".into(), b"x".to_vec()));
    let missing_db: Vec<_> = original
        .iter()
        .filter(|(n, _)| n != "project.sqlite")
        .cloned()
        .collect();
    let cases: Vec<(&str, Entries, &str)> = vec![
        (
            "changed attachment",
            replace("artifacts/b.bin", b"changed"),
            "SHA256SUMS.txt does not match",
        ),
        (
            "unlisted attachment",
            extra,
            "SHA256SUMS.txt does not match",
        ),
        ("path traversal", traversal, "component \"..\""),
        ("stray entry", stray, "unexpected entry"),
        ("missing database", missing_db, "project.sqlite is missing"),
        (
            "other migrations",
            with_manifest(&|m| m["migrations"][0]["sha256"] = "00".into()),
            "schema mismatch",
        ),
        (
            "attachment list",
            with_manifest(&|m| m["attachments"]["files"][0]["sizeBytes"] = 99.into()),
            "attachments differ",
        ),
        (
            "snapshot hash",
            with_manifest(&|m| m["snapshotSha256"] = "ab".into()),
            "snapshotSha256",
        ),
        (
            "another format",
            with_manifest(&|m| m["format"] = "zip".into()),
            "not an ayanami-task-project",
        ),
        (
            "future version",
            with_manifest(&|m| m["formatVersion"] = 3.into()),
            "formatVersion 3",
        ),
    ];
    for (label, content, why) in cases {
        let p = w.dir.join(format!("{}.aytproj", label.replace(' ', "-")));
        write_zip(&p, &content);
        let preview = package::inspect_package(&p);
        let msg = preview
            .as_ref()
            .err()
            .map(|e| e.to_string())
            .unwrap_or_default();
        assert!(
            preview.is_err() && msg.contains(why),
            "{label}: preview {msg}"
        );
        let applied = import(&w, ImportSource::Package(&p), Some("TAMPER"));
        let msg = applied
            .as_ref()
            .err()
            .map(|e| e.to_string())
            .unwrap_or_default();
        assert!(
            applied.is_err() && msg.contains(why),
            "{label}: apply {msg}"
        );
        assert_eq!(fingerprint(&w), fp, "{label}: the store changed");
        assert_eq!(tree(&root), art, "{label}: the attachments changed");
        assert!(!w.dir.join("escape.txt").exists() && !w.exports.join("escape.txt").exists());
    }
    assert!(
        fs::read_dir(w.exports.join(".staging"))
            .unwrap()
            .next()
            .is_none()
    );
    // 不是 zip。
    let junk = w.dir.join("junk.aytproj");
    fs::write(&junk, b"not a zip").unwrap();
    assert!(matches!(
        package::inspect_package(&junk),
        Err(PackageError::Invalid(_))
    ));
    assert!(matches!(
        package::inspect_package(&w.dir.join("absent.aytproj")),
        Err(PackageError::NotFound(_))
    ));
}

// ---------- 2.x ----------

/// 跑完 2.x 全部迁移的库（与 legacy 用例相同：迁移在仓库根的 `migrations/` 里读）。
fn legacy_db(path: &Path, kind: &str) -> Connection {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../migrations")
        .join(kind);
    let mut files: Vec<PathBuf> = fs::read_dir(&root)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    files.sort();
    let c = Connection::open(path).unwrap();
    c.execute_batch(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL,
           content_sha256 TEXT NOT NULL, hash_origin TEXT NOT NULL CHECK(hash_origin IN ('APPLIED','LEGACY_BASELINE_UNVERIFIED')))",
    )
    .unwrap();
    for f in files {
        let name = f.file_name().unwrap().to_string_lossy().into_owned();
        let version: i64 = name[..4].parse().unwrap();
        let sql = fs::read(&f).unwrap();
        c.execute_batch(std::str::from_utf8(&sql).unwrap()).unwrap();
        c.execute(
            "INSERT INTO schema_migrations VALUES (?1, ?2, ?3, ?4, 'APPLIED')",
            params![version, name, T0, sha(&sql)],
        )
        .unwrap();
    }
    c
}

fn legacy_project(path: &Path, pid: &str, code: &str) {
    let p = legacy_db(path, "project");
    p.execute_batch(&format!(
        "INSERT INTO project_meta (singleton, project_id, project_code, name, description, lifecycle, coordination_mode, health,
                                   current_sequence, schema_version, version, created_at, updated_at)
           VALUES (1, '{pid}', '{code}', 'Legacy {code}', 'from 2.x', 'ACTIVE', 'AUTO', 'AT_RISK', 1, 18, 3, '{T0}', '{T1}');
         INSERT INTO counters (name, next_value) VALUES ('work_item', 2), ('objective', 2);
         INSERT INTO objectives (id, local_no, title, status, created_at, updated_at) VALUES ('OBJ', 1, 'goal', 'ACTIVE', '{T0}', '{T0}');
         INSERT INTO agents (id, display_name, client_kind, created_at, updated_at) VALUES ('claude', 'Claude', 'cli', '{T0}', '{T0}');
         INSERT INTO agent_sessions (id, agent_id, role, work_state, connection_state, started_at, updated_at)
           VALUES ('S1', 'claude', 'PRIMARY', 'WORKING', 'ONLINE', '{T0}', '{T0}');
         INSERT INTO work_items (id, local_no, objective_id, type, title, status, phase, priority, claimed_by_session_id, created_at, updated_at)
           VALUES ('W1', 1, 'OBJ', 'TASK', 'legacy task words', 'IN_PROGRESS', 'IN_PROGRESS', 'NORMAL', 'S1', '{T0}', '{T0}');
         INSERT INTO search_documents (entity_type, entity_id, entity_key, title, body, updated_at)
           VALUES ('WORK_ITEM', 'W1', '{code}-T-0001', 'legacy task words', '', '{T0}');
         INSERT INTO search_documents_fts (entity_type, entity_id, entity_key, title, body)
           SELECT entity_type, entity_id, entity_key, title, body FROM search_documents;
         INSERT INTO events (id, sequence, type, actor_type, actor_id, session_id, aggregate_type, aggregate_id, payload_json, created_at)
           VALUES ('E1', 1, 'work.created', 'AGENT', 'claude', 'S1', 'WORK_ITEM', 'W1', '{{}}', '{T0}');"
    ))
    .unwrap();
}

fn legacy_knowledge(path: &Path) {
    let k = legacy_db(path, "knowledge");
    k.execute_batch(
        "INSERT INTO knowledge_meta (singleton, database_id, generation, sequence) VALUES (1, 'KDB-OLD', 'KG1', 4);
         INSERT INTO knowledge_entries (id, slug, head_revision, version, archived) VALUES
           ('K1', 'single-db', 1, 1, 0), ('K2', 'brand-new', 2, 2, 0);
         INSERT INTO knowledge_revisions (entry_id, revision, revision_id, snapshot) VALUES
           ('K1', 1, 'K1-R1', '{\"title\":\"Overwrite attempt\",\"aliases\":[],\"tags\":[],\"summary\":\"\",\"useWhen\":\"\",\"appliesTo\":[],\"bodyMarkdown\":\"no\"}'),
           ('K2', 1, 'K2-R1', '{\"title\":\"First\",\"aliases\":[],\"tags\":[],\"summary\":\"\",\"useWhen\":\"\",\"appliesTo\":[],\"bodyMarkdown\":\"one\"}'),
           ('K2', 2, 'K2-R2', '{\"title\":\"Recovered note\",\"aliases\":[\"rn\"],\"tags\":[\"x\"],\"summary\":\"s\",\"useWhen\":\"u\",\"appliesTo\":[],\"bodyMarkdown\":\"zebra body\"}');
         INSERT INTO knowledge_fts (entry_id, metadata, title, aliases, tags, summary, use_when, applies_to, body) VALUES
           ('K1', '{\"id\":\"K1\"}', 'Overwrite attempt', '', '', '', '', '', 'no'),
           ('K2', '{\"id\":\"K2\"}', 'Recovered note', 'rn', 'x', 's', 'u', '', 'zebra body');",
    )
    .unwrap();
}

#[test]
fn a_2x_project_backup_and_a_v1_package_import_through_the_converter() {
    let w = world("package-legacy");
    let backup = w.dir.join("2x").join("LEG.sqlite");
    fs::create_dir_all(backup.parent().unwrap()).unwrap();
    legacy_project(&backup, "P-LEG", "LEG");
    let source_bytes = fs::read(&backup).unwrap();

    // 预览不动源文件（immutable 打开，没有 -wal / -shm）。
    let seen = package::inspect_legacy(&backup, atm_store::legacy::Home::Project).unwrap();
    assert_eq!(seen.project.as_ref().unwrap().code, "LEG");
    assert_eq!(seen.counts["work_items"], 1);
    assert_eq!(fs::read(&backup).unwrap(), source_bytes);
    assert!(
        !w.dir.join("2x").join("LEG.sqlite-wal").exists()
            && !w.dir.join("2x").join("LEG.sqlite-shm").exists()
    );

    let got = import(&w, ImportSource::LegacyProject(&backup), None).unwrap();
    assert_eq!(
        (
            got.code.as_str(),
            got.name.as_str(),
            got.source_project_id.as_str()
        ),
        ("LEG", "Legacy LEG", "P-LEG")
    );
    assert_eq!(got.sessions_closed, 1);
    let title: String = one(
        &w,
        "SELECT title FROM work_items WHERE project_id = ?1 AND local_no = 1",
        &[&got.project_id],
    )
    .unwrap();
    assert_eq!(title, "legacy task words");
    assert_eq!(search(&w, "legacy task", got.project_id.clone()), 1);
    let ev: String = one(&w, "SELECT payload_json FROM global_feed WHERE type = 'project.imported' AND aggregate_id = ?1", &[&got.project_id]).unwrap();
    assert!(ev.contains("2.x-project-backup"), "{ev}");
    assert_eq!(
        fs::read(&backup).unwrap(),
        source_bytes,
        "the 2.x backup was written"
    );

    // v1 包（2.0 的导出：2.x 项目库 + 附件 + manifest v1 + SHA256SUMS）。
    let db = fs::read(&backup).unwrap();
    let manifest = serde_json::json!({
        "format": "ayanami-task-project", "formatVersion": 1, "applicationVersion": "2.0.0",
        "project": {"id": "P-LEG", "code": "LEG", "name": "Legacy LEG"},
        "schemaVersion": 18, "createdAt": T1, "snapshotSha256": sha(&db),
    });
    let sums = format!(
        "{}  project.sqlite\n{}  artifacts/old/report.txt\n",
        sha(&db),
        sha(b"v1 file")
    );
    let v1 = w.dir.join("LEG-v1.aytproj");
    write_zip(
        &v1,
        &[
            ("project.sqlite".into(), db.clone()),
            ("artifacts/old/report.txt".into(), b"v1 file".to_vec()),
            (
                "manifest.json".into(),
                serde_json::to_vec(&manifest).unwrap(),
            ),
            ("SHA256SUMS.txt".into(), sums.into_bytes()),
        ],
    );
    let seen = package::inspect_package(&v1).unwrap();
    assert_eq!(
        (seen.format_version, seen.project.code.as_str()),
        (1, "LEG")
    );
    assert!(seen.counts.is_none());
    match import(&w, ImportSource::Package(&v1), None) {
        Err(PackageError::CodeTaken { suggested, .. }) => assert_eq!(suggested, "LEG2"),
        other => panic!("{other:?}"),
    }
    let v1got = import(&w, ImportSource::Package(&v1), Some("LEG2")).unwrap();
    assert_eq!(v1got.attachments, 1);
    assert_eq!(
        fs::read(
            artifacts_root(w.store.path())
                .join(&v1got.project_id)
                .join("old")
                .join("report.txt")
        )
        .unwrap(),
        b"v1 file"
    );
    let ev: String = one(&w, "SELECT payload_json FROM global_feed WHERE type = 'project.imported' AND aggregate_id = ?1", &[&v1got.project_id]).unwrap();
    assert!(ev.contains("aytproj-v1"), "{ev}");

    // manifest 说的是另一个项目：拒绝。
    let mut lying = manifest.clone();
    lying["project"]["id"] = "P-OTHER".into();
    let bad = w.dir.join("lying.aytproj");
    write_zip(
        &bad,
        &[
            ("project.sqlite".into(), db.clone()),
            ("manifest.json".into(), serde_json::to_vec(&lying).unwrap()),
            (
                "SHA256SUMS.txt".into(),
                format!("{}  project.sqlite\n", sha(&db)).into_bytes(),
            ),
        ],
    );
    let fp = fingerprint(&w);
    let refused = import(&w, ImportSource::Package(&bad), Some("LEG3"));
    assert!(
        refused
            .as_ref()
            .err()
            .is_some_and(|e| e.to_string().contains("P-OTHER")),
        "{refused:?}"
    );
    assert_eq!(fingerprint(&w), fp);

    // 反例：知识库备份当项目导入、坏文件、不存在的文件。
    let kdb = w.dir.join("2x").join("knowledge.sqlite");
    legacy_knowledge(&kdb);
    let wrong = import(&w, ImportSource::LegacyProject(&kdb), Some("KNOW"));
    assert!(wrong.is_err(), "{wrong:?}");
    assert!(package::inspect_legacy(&kdb, atm_store::legacy::Home::Project).is_err());
    let broken = w.dir.join("2x").join("broken.sqlite");
    fs::write(&broken, b"SQLite format 3\0garbage").unwrap();
    assert!(import(&w, ImportSource::LegacyProject(&broken), Some("BROKEN")).is_err());
    assert!(package::inspect_legacy(&broken, atm_store::legacy::Home::Project).is_err());
    assert!(matches!(
        import(
            &w,
            ImportSource::LegacyProject(&w.dir.join("absent.sqlite")),
            None
        ),
        Err(PackageError::NotFound(_))
    ));
    assert_eq!(fingerprint(&w), fp, "a refused import changed the store");
    assert!(
        fs::read_dir(w.exports.join(".staging"))
            .unwrap()
            .next()
            .is_none()
    );
}

#[test]
fn a_2x_knowledge_backup_merges_without_overwriting() {
    let w = world("package-knowledge");
    let kdb = w.dir.join("knowledge-backup.sqlite");
    legacy_knowledge(&kdb);
    let bytes = fs::read(&kdb).unwrap();
    let seen = package::inspect_legacy(&kdb, atm_store::legacy::Home::Knowledge).unwrap();
    assert_eq!(seen.counts["knowledge_entries"], 2);
    assert!(seen.project.is_none());
    let (new, existing) = package::knowledge_overlap(&w.store, &kdb).unwrap();
    assert_eq!(
        (new, existing),
        (vec!["brand-new".to_string()], vec!["single-db".to_string()])
    );
    let opts = ImportOptions {
        exports_dir: &w.exports,
        at: T2,
        code: None,
        source_label: "backup K",
    };
    let merged = package::import_legacy_knowledge(&w.store, &kdb, &opts).unwrap();
    assert_eq!(merged.inserted, ["brand-new"]);
    assert_eq!(merged.skipped, ["single-db"]);
    assert_eq!(fs::read(&kdb).unwrap(), bytes);
    // 已有的条目原样；新条目连同修订进来，可以搜到；序号前进；全局事件。
    let kept: String = one(
        &w,
        "SELECT snapshot ->> '$.bodyMarkdown' FROM knowledge_revisions WHERE entry_id = 'K-OLD'",
        &[],
    )
    .unwrap();
    assert_eq!(kept, "kept");
    let revs: i64 = one(
        &w,
        "SELECT count(*) FROM knowledge_revisions WHERE entry_id = 'K2'",
        &[],
    )
    .unwrap();
    assert_eq!(revs, 2);
    let hit: i64 = one(
        &w,
        "SELECT count(*) FROM knowledge_fts WHERE knowledge_fts MATCH 'zebra'",
        &[],
    )
    .unwrap();
    assert_eq!(hit, 1);
    let seq: i64 = one(&w, "SELECT sequence FROM knowledge_meta", &[]).unwrap();
    assert_eq!(seq, 6);
    let ev: String = one(
        &w,
        "SELECT payload_json FROM global_feed WHERE type = 'knowledge.imported'",
        &[],
    )
    .unwrap();
    assert!(ev.contains("brand-new") && ev.contains("single-db"), "{ev}");
    // 第二次：全部已在，什么都不插，序号不动。
    let again = package::import_legacy_knowledge(&w.store, &kdb, &opts).unwrap();
    assert!(again.inserted.is_empty());
    assert_eq!(again.skipped.len(), 2);
    let seq: i64 = one(&w, "SELECT sequence FROM knowledge_meta", &[]).unwrap();
    assert_eq!(seq, 6);
    // 反例：项目库当知识库。
    let pdb = w.dir.join("project.sqlite");
    legacy_project(&pdb, "P-X", "PX");
    let fp = fingerprint(&w);
    assert!(package::import_legacy_knowledge(&w.store, &pdb, &opts).is_err());
    assert!(package::inspect_legacy(&pdb, atm_store::legacy::Home::Knowledge).is_err());
    assert_eq!(fingerprint(&w), fp);
}

/// 把一个正常导出的包改成项目代码是 `code` 的（库、manifest、SHA256SUMS 一致，包本身校验得过）。
fn package_with_code(w: &World, good: &Path, code: &str, name: &str) -> PathBuf {
    let mut zip_entries = entries(good);
    let db = w.dir.join(format!("{name}.sqlite"));
    fs::write(
        &db,
        &zip_entries
            .iter()
            .find(|(n, _)| n == "project.sqlite")
            .unwrap()
            .1,
    )
    .unwrap();
    Connection::open(&db)
        .unwrap()
        .execute("UPDATE projects SET code = ?1", [code])
        .unwrap();
    let bytes = fs::read(&db).unwrap();
    let _ = fs::remove_file(&db);
    for (n, body) in &mut zip_entries {
        if n == "project.sqlite" {
            *body = bytes.clone();
        }
        if n == "manifest.json" {
            let mut m: serde_json::Value = serde_json::from_slice(body).unwrap();
            m["project"]["code"] = code.into();
            m["snapshotSha256"] = sha(&bytes).into();
            m["sizeBytes"] = (bytes.len() as u64).into();
            *body = serde_json::to_vec(&m).unwrap();
        }
    }
    let sums: String = zip_entries
        .iter()
        .filter(|(n, _)| n != "manifest.json" && n != "SHA256SUMS.txt")
        .map(|(n, b)| format!("{}  {n}\n", sha(b)))
        .collect();
    zip_entries
        .iter_mut()
        .find(|(n, _)| n == "SHA256SUMS.txt")
        .unwrap()
        .1 = sums.into_bytes();
    let out = w.dir.join(format!("{name}.aytproj"));
    write_zip(&out, &zip_entries);
    out
}

/// peer W6 r1 P1-01：包（或 2.x 库）带来的项目代码不可信。没有另给代码时按项目代码的规则校验，不合格不导入、
/// 零写入；另给一个合格代码就能导入。导出文件名只用代码里安全的字符，落在 exports 里，不覆盖已有的同名文件。
#[test]
fn a_package_code_that_is_not_a_project_code_is_refused_and_exports_stay_inside() {
    let w = world("package-bad-code");
    let good = export(&w, "PA", Format::Package, T1).path;
    let outside = w.dir.join("outside-root");
    fs::create_dir_all(&outside).unwrap();
    let sentinel = outside.join(format!("owned-{}.json", T1.replace([':', '.'], "-")));
    fs::write(&sentinel, b"user original bytes").unwrap();
    let absolute = outside.join("owned").to_string_lossy().into_owned();
    for (i, bad) in [
        absolute.as_str(),
        "../UP",
        "AB/CD",
        "lower",
        "A",
        "TOO-LONG-CODE1",
        "1AB",
    ]
    .into_iter()
    .enumerate()
    {
        let pkg = package_with_code(&w, &good, bad, &format!("bad-{i}"));
        package::inspect_package(&pkg).unwrap();
        let before = fingerprint(&w);
        match import(&w, ImportSource::Package(&pkg), None) {
            Err(PackageError::BadCode { code }) => assert_eq!(code, bad),
            other => panic!("{bad}: {other:?}"),
        }
        assert_eq!(fingerprint(&w), before, "{bad}: nothing written");
        // 另给一个合格代码就能导入（给定的代码优先）。
        let code = format!("OK{i}");
        let imported = import(&w, ImportSource::Package(&pkg), Some(&code)).unwrap();
        assert_eq!(imported.code, code);
    }
    assert_eq!(fs::read(&sentinel).unwrap(), b"user original bytes");
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);

    // 库里的代码就算被改坏了，导出也只在 exports 里、名字是一个安全组件；已有的同名文件不动。
    let w = world("package-export-name");
    w.store
        .write(|tx| {
            tx.execute(
                "UPDATE projects SET code = '..\\..\\EVIL' WHERE id = 'PA'",
                [],
            )
        })
        .unwrap();
    let exported = export(&w, "PA", Format::Json, T1);
    assert_eq!(exported.path.parent().unwrap(), w.exports.as_path());
    let name = exported
        .path
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert!(
        !name.contains("..") && !name.contains('\\') && !name.contains('/'),
        "{name}"
    );
    let w = world("package-export-existing");
    let first = export(&w, "PA", Format::Json, T1).path;
    fs::write(&first, b"kept").unwrap();
    let second = export(&w, "PA", Format::Json, T1).path;
    assert_ne!(first, second);
    assert_eq!(fs::read(&first).unwrap(), b"kept");
}

#[cfg(windows)]
fn junction(link: &Path, target: &Path) {
    let made = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .stdout(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(made.success(), "mklink /J {}", link.display());
}

/// 数据根外面的一棵树（用户的东西），逐字节。
#[cfg(windows)]
fn outside_tree(w: &World) -> PathBuf {
    let outside = w.dir.join("outside-root");
    fs::create_dir_all(outside.join("user-folder")).unwrap();
    fs::write(outside.join("user-folder").join("keep.txt"), b"keep").unwrap();
    // 名字像 ATM 暂存的也一样：在数据根外面就不是 ATM 的。
    fs::create_dir_all(outside.join("01J0000000000000000000000A")).unwrap();
    fs::write(outside.join("01J0000000000000000000000A").join("x"), b"x").unwrap();
    outside
}

/// peer W6 r1 P1-02：exports、.staging、附件根是链接（junction）时，导出、导入在任何副作用之前拒绝；暂存清理只删
/// ATM 起的（ULID 名字）暂存，里面的链接只删链接本身，不跟进去。数据根外面的树逐字节不变。
#[cfg(windows)]
#[test]
fn links_in_the_data_root_are_refused_before_any_side_effect() {
    // 1. `.staging` 本身是 junction：拒绝，外面的树原样。
    let w = world("package-link-staging");
    let outside = outside_tree(&w);
    let before = tree(&outside);
    fs::create_dir_all(&w.exports).unwrap();
    let staging = w.exports.join(".staging");
    junction(&staging, &outside);
    let r = package::export_project(
        &w.store,
        "PA",
        Format::Json,
        &ExportOptions {
            exports_dir: &w.exports,
            at: T1,
            app_version: "t",
        },
    );
    assert!(matches!(r, Err(PackageError::LinkedPath(_))), "{r:?}");
    let pkg = w.dir.join("none.aytproj");
    assert!(matches!(
        import(&w, ImportSource::Package(&pkg), None),
        Err(PackageError::LinkedPath(_))
    ));
    assert_eq!(tree(&outside), before);
    fs::remove_dir(&staging).unwrap(); // 只删链接本身

    // 2. `.staging` 是普通目录，里面有一个 ULID 名字的 junction 与一个不是 ATM 起的目录：前者只删链接，后者不碰。
    let w = world("package-link-inside");
    let outside = outside_tree(&w);
    let before = tree(&outside);
    let staging = w.exports.join(".staging");
    fs::create_dir_all(staging.join("user-notes")).unwrap();
    fs::write(staging.join("user-notes").join("n.txt"), b"n").unwrap();
    let ulid_link = staging.join("01J0000000000000000000000B");
    junction(&ulid_link, &outside);
    let exported = export(&w, "PA", Format::Json, T1);
    assert!(exported.path.is_file());
    assert!(
        fs::symlink_metadata(&ulid_link).is_err(),
        "the stale link is gone"
    );
    assert_eq!(
        fs::read(staging.join("user-notes").join("n.txt")).unwrap(),
        b"n"
    );
    assert_eq!(tree(&outside), before);

    // 3. 附件：项目的附件目录是 junction → 导出拒绝；附件根是 junction → 导入拒绝、零写入。
    let w = world("package-link-artifacts");
    let outside = outside_tree(&w);
    let good = export(&w, "PA", Format::Package, T1).path;
    let before = tree(&outside);
    let pa = artifacts_root(w.store.path()).join("PA");
    fs::remove_dir_all(&pa).unwrap();
    junction(&pa, &outside);
    assert!(matches!(
        package::export_project(
            &w.store,
            "PA",
            Format::Package,
            &ExportOptions {
                exports_dir: &w.exports,
                at: T2,
                app_version: "t"
            }
        ),
        Err(PackageError::LinkedPath(_))
    ));
    fs::remove_dir(&pa).unwrap();
    let root = artifacts_root(w.store.path());
    fs::remove_dir_all(&root).unwrap();
    junction(&root, &outside);
    let fp = fingerprint(&w);
    let r = import(&w, ImportSource::Package(&good), Some("PZ"));
    assert!(matches!(r, Err(PackageError::LinkedPath(_))), "{r:?}");
    assert_eq!(fingerprint(&w), fp, "nothing committed");
    fs::remove_dir(&root).unwrap();
    assert_eq!(tree(&outside), before);
}
