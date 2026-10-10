//! 界面的数据交换路由（W6c）：#27 导出、#110 来源列表、#111 预览、#112 导入。
//!
//! - 导出只有 User，写进 `N\exports`；格式不认识时 400 / 422。
//! - 列表只列两处 exports 里的 `.aytproj` 与可导入的 2.x 备份；预览只读，什么都不写。
//! - 导入：项目包成为新项目（代码被占用时 409 带建议代码，代码按规则校验并转大写）；来源只能按文件名点名，
//!   路径、未知来源一律拒绝；2.x 项目备份作为新项目、2.x 知识库备份合并进知识库（新库也行）；
//!   登记之后被改过的 2.x 备份、不能导入的种类拒绝。Agent 不能导出、不能导入。

mod support;

use atm_domain::error::ErrorCode;
use atm_service::exchange::ImportFrom;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use sha2::Digest;
use std::fs;
use std::path::{Path, PathBuf};
use support::*;

fn listing(dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = fs::read_dir(dir)
        .map(|it| {
            it.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

fn sha(b: &[u8]) -> String {
    sha2::Sha256::digest(b)
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
}

fn package_source(name: &str) -> Value {
    json!({"kind": "PACKAGE", "origin": "EXPORTS", "name": name})
}

#[test]
fn a_project_exports_and_imports_back_as_a_new_project() {
    let w = world("exchange-roundtrip");
    let code = w.project("Alpha", "ALPHA");
    let obj = w.objective(&code, "目标");
    let key = w.task(&code, &obj, "导出往返的任务");

    let out = w.ok("POST", "/api/v1/exports/ALPHA?format=aytproj", None, 200);
    assert_eq!(out["format"], "aytproj");
    assert_eq!(out["projectCode"], "ALPHA");
    let path = PathBuf::from(out["path"].as_str().unwrap());
    assert_eq!(path.parent().unwrap(), w.dir.join("exports"));
    assert_eq!(out["sha256"], sha(&fs::read(&path).unwrap()));
    let name = path.file_name().unwrap().to_string_lossy().into_owned();
    // 缺省格式是 aytproj（与 2.0 相同）；JSON、CSV 也在。
    let plain = w.ok("POST", "/api/v1/exports/ALPHA", None, 200);
    assert_eq!(plain["format"], "aytproj");
    for f in ["json", "csv"] {
        let v = w.ok(
            "POST",
            &format!("/api/v1/exports/ALPHA?format={f}"),
            None,
            200,
        );
        assert!(
            v["path"].as_str().unwrap().ends_with(&format!(".{f}")),
            "{v}"
        );
    }
    error(
        &w.call("POST", "/api/v1/exports/ALPHA?format=zip", None),
        400,
        "INVALID_ARGUMENT",
    );
    error(
        &w.call("POST", "/api/v1/exports/NOPE", None),
        404,
        "PROJECT_NOT_FOUND",
    );
    let denied = w.call_as(&agent(), "POST", "/api/v1/exports/ALPHA", None);
    assert_ne!(denied.status, 200, "{}", denied.body);
    // 服务层自己也拒绝 Agent（界面入口之外的调用方），在写任何文件之前（P-004）。
    let exports = listing(&w.dir.join("exports"));
    let e = w.svc.export_project(&agent(), "ALPHA", "csv").unwrap_err();
    assert_eq!(e.code, ErrorCode::USER_AUTHORIZATION_REQUIRED, "{e:?}");
    assert_eq!(listing(&w.dir.join("exports")), exports);

    // 列表：只有 .aytproj，JSON / CSV 不在。
    let list = w.get("/api/v1/imports/packages");
    let packages = list["packages"].as_array().unwrap();
    assert_eq!(packages.len(), 2, "{list}");
    assert!(
        packages
            .iter()
            .all(|p| p["origin"] == "EXPORTS" && p["name"].as_str().unwrap().ends_with(".aytproj"))
    );
    assert!(
        packages
            .iter()
            .any(|p| p["source"] == package_source(&name))
    );
    assert_eq!(list["legacyBackups"], json!([]));

    // 预览：只读。
    let projects_before = w.get("/api/v1/projects");
    let exports_before = listing(&w.dir.join("exports"));
    let seen = w.ok(
        "POST",
        "/api/v1/imports/packages/preview",
        Some(json!({"source": package_source(&name)})),
        200,
    );
    assert_eq!(seen["kind"], "PROJECT");
    assert_eq!(seen["formatVersion"], 2);
    assert_eq!(seen["project"]["code"], "ALPHA");
    assert_eq!(seen["codeTaken"], true);
    assert_eq!(seen["suggestedCode"], "ALPHA2");
    assert_eq!(seen["counts"]["work_items"], 1);
    assert_eq!(seen["source"], package_source(&name));
    assert_eq!(w.get("/api/v1/projects"), projects_before);
    assert_eq!(listing(&w.dir.join("exports")), exports_before);

    // 代码被占：409，带建议代码；代码不合规则：400。
    let taken = w.call(
        "POST",
        "/api/v1/imports/packages/apply",
        Some(json!({"source": package_source(&name)})),
    );
    error(&taken, 409, "PROJECT_CODE_CONFLICT");
    assert!(taken.body.to_string().contains("ALPHA2"), "{}", taken.body);
    error(
        &w.call(
            "POST",
            "/api/v1/imports/packages/apply",
            Some(json!({"source": package_source(&name), "code": "1bad"})),
        ),
        400,
        "INVALID_ARGUMENT",
    );
    // 来源只能按文件名点名。
    for bad in [
        json!({"kind": "PACKAGE", "origin": "EXPORTS", "name": format!("../exports/{name}")}),
        json!({"kind": "PACKAGE", "origin": "EXPORTS", "name": "x.json"}),
        json!({"kind": "PACKAGE", "origin": "ELSEWHERE", "name": name}),
        json!({"kind": "PATH", "path": path.to_string_lossy()}),
    ] {
        for route in ["preview", "apply"] {
            error(
                &w.call(
                    "POST",
                    &format!("/api/v1/imports/packages/{route}"),
                    Some(json!({"source": bad, "code": "ZED"})),
                ),
                400,
                "INVALID_ARGUMENT",
            );
        }
    }
    error(
        &w.call(
            "POST",
            "/api/v1/imports/packages/preview",
            Some(json!({"source": package_source("absent.aytproj")})),
        ),
        404,
        "NOT_FOUND",
    );
    let agent_apply = w.call_as(
        &agent(),
        "POST",
        "/api/v1/imports/packages/apply",
        Some(json!({"source": package_source(&name), "code": "ZED"})),
    );
    assert_ne!(agent_apply.status, 200, "{}", agent_apply.body);
    let from = ImportFrom::from_json(&package_source(&name)).unwrap();
    let e = w
        .svc
        .import_source(&agent(), &from, Some("ZED"))
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::USER_AUTHORIZATION_REQUIRED, "{e:?}");
    // 列表与预览 Agent 也可以（import.preview 是 A+U），只读。
    assert!(w.svc.import_sources(&agent()).is_ok());
    assert_eq!(
        w.svc.preview_import_source(&agent(), &from).unwrap()["project"]["code"],
        "ALPHA"
    );
    assert_eq!(w.get("/api/v1/projects"), projects_before);

    // 导入：代码转大写；任务按新代码编号、内容相同。
    let got = w.ok(
        "POST",
        "/api/v1/imports/packages/apply",
        Some(json!({"source": package_source(&name), "code": "alpha-copy"})),
        200,
    );
    assert_eq!(got["kind"], "PROJECT");
    assert_eq!(got["code"], "ALPHA-COPY");
    assert_eq!(got["sourceCode"], "ALPHA");
    let copied = w.get(&format!(
        "/api/v1/projects/ALPHA-COPY/work-items/{}",
        key.replace("ALPHA-", "ALPHA-COPY-")
    ));
    let original = w.get(&format!("/api/v1/projects/ALPHA/work-items/{key}"));
    assert!(copied.to_string().contains("导出往返的任务"), "{copied}");
    assert_eq!(copied["title"], original["title"]);
    let codes: Vec<String> = w
        .get("/api/v1/projects")
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["code"].as_str().unwrap().to_owned())
        .collect();
    assert!(
        codes.contains(&"ALPHA-COPY".to_string()) && codes.contains(&"ALPHA".to_string()),
        "{codes:?}"
    );
}

/// 跑完 2.x 全部迁移的库（迁移在仓库根的 `migrations/` 里读）。
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
           content_sha256 TEXT NOT NULL, hash_origin TEXT NOT NULL)",
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

#[test]
fn legacy_backups_import_as_a_project_or_into_the_knowledge_base() {
    let w = world("exchange-legacy");
    let backups = w.dir.join("L").join("backups");
    fs::create_dir_all(&backups).unwrap();
    let pdb = backups.join("project-LEG.sqlite");
    legacy_db(&pdb, "project")
        .execute_batch(&format!(
            "INSERT INTO project_meta (singleton, project_id, project_code, name, description, lifecycle, coordination_mode, health,
                                       current_sequence, schema_version, version, created_at, updated_at)
               VALUES (1, 'P-LEG', 'LEG', 'Legacy', '', 'ACTIVE', 'AUTO', 'UNKNOWN', 0, 18, 0, '{T0}', '{T0}');
             INSERT INTO counters (name, next_value) VALUES ('work_item', 2), ('objective', 2);
             INSERT INTO objectives (id, local_no, title, status, created_at, updated_at) VALUES ('OBJ', 1, 'goal', 'ACTIVE', '{T0}', '{T0}');
             INSERT INTO work_items (id, local_no, objective_id, type, title, status, phase, priority, created_at, updated_at)
               VALUES ('W1', 1, 'OBJ', 'TASK', '旧版的任务', 'READY', 'READY', 'NORMAL', '{T0}', '{T0}');"
        ))
        .unwrap();
    let kdb = backups.join("knowledge.sqlite");
    legacy_db(&kdb, "knowledge")
        .execute_batch(
            "INSERT INTO knowledge_meta (singleton, database_id, generation, sequence) VALUES (1, 'KDB-OLD', 'KG1', 1);
             INSERT INTO knowledge_entries (id, slug, head_revision, version, archived) VALUES ('K1', 'old-note', 1, 1, 0);
             INSERT INTO knowledge_revisions (entry_id, revision, revision_id, snapshot) VALUES
               ('K1', 1, 'K1-R1', '{\"title\":\"旧笔记\",\"aliases\":[],\"tags\":[],\"summary\":\"\",\"useWhen\":\"\",\"appliesTo\":[],\"bodyMarkdown\":\"内容\"}');
             INSERT INTO knowledge_fts (entry_id, metadata, title, aliases, tags, summary, use_when, applies_to, body)
               VALUES ('K1', '{\"id\":\"K1\"}', '旧笔记', '', '', '', '', '', '内容');",
        )
        .unwrap();
    let changed = backups.join("changed.sqlite");
    fs::copy(&pdb, &changed).unwrap();
    let file = |p: &Path| {
        (
            p.to_string_lossy().into_owned(),
            sha(&fs::read(p).unwrap()),
            fs::metadata(p).unwrap().len() as i64,
        )
    };
    let (pp, ps, pz) = file(&pdb);
    let (kp, ks, kz) = file(&kdb);
    let (cp, _, cz) = file(&changed);
    w.svc
        .store()
        .write(move |tx| {
            for (id, source, scope, path, sha, size, importable) in [
                ("LB-P", "CATALOG", "PROJECT", pp.as_str(), ps.as_str(), pz, "AS_PROJECT"),
                ("LB-K", "KNOWLEDGE_BEFORE_RESTORE", "KNOWLEDGE", kp.as_str(), ks.as_str(), kz, "AS_KNOWLEDGE"),
                ("LB-C", "CATALOG", "PROJECT", cp.as_str(), "00", cz, "AS_PROJECT"),
                ("LB-R", "CATALOG", "REGISTRY", pp.as_str(), ps.as_str(), pz, "NO"),
            ] {
                tx.execute(
                    "INSERT INTO legacy_backups (id, source, scope, project_id, legacy_path, sha256, size_bytes, reason, schema_version,
                                                 created_at, verified_at, importable)
                     VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, 'DAILY', 18, ?7, ?7, ?8)",
                    params![id, source, scope, path, sha, size, T0, importable],
                )?;
            }
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();

    let list = w.get("/api/v1/imports/packages");
    let mut ids: Vec<&str> = list["legacyBackups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["id"].as_str().unwrap())
        .collect();
    ids.sort();
    assert_eq!(ids, ["LB-C", "LB-K", "LB-P"], "{list}");
    let src = |id: &str| json!({"source": {"kind": "LEGACY_BACKUP", "id": id}});

    let source_bytes = (fs::read(&pdb).unwrap(), fs::read(&kdb).unwrap());
    let seen = w.ok(
        "POST",
        "/api/v1/imports/packages/preview",
        Some(src("LB-P")),
        200,
    );
    assert_eq!(
        (
            seen["kind"].as_str(),
            seen["project"]["code"].as_str(),
            seen["codeTaken"].as_bool()
        ),
        (Some("PROJECT"), Some("LEG"), Some(false)),
        "{seen}"
    );
    let seen = w.ok(
        "POST",
        "/api/v1/imports/packages/preview",
        Some(src("LB-K")),
        200,
    );
    assert_eq!(seen["kind"], "KNOWLEDGE");
    assert_eq!(seen["newEntries"], json!(["old-note"]));
    // 登记之后被改过、不能导入的种类、不存在的登记：拒绝。
    for (id, status, code) in [
        ("LB-C", 422, "BACKUP_INTEGRITY_FAILED"),
        ("LB-R", 422, "BACKUP_RESTORE_SCOPE_UNSUPPORTED"),
        ("LB-X", 404, "BACKUP_NOT_FOUND"),
    ] {
        error(
            &w.call("POST", "/api/v1/imports/packages/preview", Some(src(id))),
            status,
            code,
        );
        error(
            &w.call("POST", "/api/v1/imports/packages/apply", Some(src(id))),
            status,
            code,
        );
    }
    assert!(w.get("/api/v1/projects").as_array().unwrap().is_empty());

    let got = w.ok(
        "POST",
        "/api/v1/imports/packages/apply",
        Some(src("LB-P")),
        200,
    );
    assert_eq!(
        (got["kind"].as_str(), got["code"].as_str()),
        (Some("PROJECT"), Some("LEG")),
        "{got}"
    );
    let task = w.get("/api/v1/projects/LEG/work-items/LEG-T-0001");
    assert_eq!(task["title"], "旧版的任务", "{task}");
    // 新库还没有知识库：导入时建好身份再合并。
    let merged = w.ok(
        "POST",
        "/api/v1/imports/packages/apply",
        Some(src("LB-K")),
        200,
    );
    assert_eq!(merged["kind"], "KNOWLEDGE");
    assert_eq!(merged["inserted"], json!(["old-note"]));
    let kb = w.get("/api/v1/knowledge");
    assert!(kb.to_string().contains("旧笔记"), "{kb}");
    // 再导一次：项目代码已占；知识条目全部跳过。
    error(
        &w.call("POST", "/api/v1/imports/packages/apply", Some(src("LB-P"))),
        409,
        "PROJECT_CODE_CONFLICT",
    );
    let again = w.ok(
        "POST",
        "/api/v1/imports/packages/apply",
        Some(src("LB-K")),
        200,
    );
    assert_eq!(again["skipped"], json!(["old-note"]));
    assert_eq!(
        (fs::read(&pdb).unwrap(), fs::read(&kdb).unwrap()),
        source_bytes,
        "a 2.x backup was written"
    );
}
