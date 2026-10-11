//! 安装探测（W8a，方案 §6 PROBE）：新版能不能打开或转换这台机器上的数据，全程只读。
//!
//! 夹具与 `legacy.rs` 一样用仓库里 2.x 自己的迁移 SQL 建合成的 `L`，`N` 由转换状态机建空库发布。
//! 每条都核对：探测前后两个根里的文件（路径、大小、修改时间）一个不差，没有多出 `-shm` 之类的文件。

use atm_store::conversion::{self as cv, Layout};
use atm_store::probe::{Checked, Failure, run};
use rusqlite::{Connection, params};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

const T: &str = "2026-09-01T00:00:00.000Z";
const AT: &str = "2026-10-11T00:00:00.000Z";
const G: &str = "01K0000000000000000000000G";

fn dir(name: &str) -> PathBuf {
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../target"));
    let d = target.join("store-tests").join("probe").join(name);
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

/// 按 2.x 的迁移文件建库并登记（同 `legacy.rs` 的 `legacy_upto`）。
fn legacy_db(path: &Path, kind: &str) {
    use sha2::Digest;
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
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
        let sha: String = sha2::Sha256::digest(&sql)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        c.execute_batch(std::str::from_utf8(&sql).unwrap()).unwrap();
        c.execute(
            "INSERT INTO schema_migrations VALUES (?1, ?2, ?3, ?4, 'APPLIED')",
            params![version, name, T, sha],
        )
        .unwrap();
    }
}

/// 一个 2.x 数据根：registry、knowledge、一个项目库。
fn legacy_root(l: &Path) {
    legacy_db(&l.join("registry").join("registry.sqlite"), "registry");
    legacy_db(&l.join("knowledge").join("knowledge.sqlite"), "knowledge");
    legacy_db(
        &l.join("projects").join("P1").join("project.sqlite"),
        "project",
    );
}

/// 两个根里的每个文件：(相对路径, 大小, 修改时间)。
fn files(roots: &[&Path]) -> BTreeMap<PathBuf, (u64, SystemTime)> {
    let mut out = BTreeMap::new();
    for root in roots {
        let mut stack = vec![root.to_path_buf()];
        while let Some(d) = stack.pop() {
            let Ok(entries) = fs::read_dir(&d) else {
                continue;
            };
            for e in entries {
                let e = e.unwrap();
                let meta = e.metadata().unwrap();
                if meta.is_dir() {
                    stack.push(e.path());
                } else {
                    out.insert(e.path(), (meta.len(), meta.modified().unwrap()));
                }
            }
        }
    }
    out
}

/// 探测一次，并核对它什么都没写。
fn probe(
    n: &Path,
    l: &Path,
    secrets_check: Option<fn(&[u8]) -> bool>,
) -> Result<atm_store::probe::Report, Failure> {
    let before = files(&[n, l]);
    let result = run(n, l, secrets_check);
    assert_eq!(files(&[n, l]), before, "the probe wrote something");
    result
}

fn scopes(databases: &[Checked]) -> Vec<&'static str> {
    databases.iter().map(|d| d.scope).collect()
}

fn add_migration(db: &Path, sql: &str) {
    let c = Connection::open(db).unwrap();
    c.execute_batch(sql).unwrap();
}

#[test]
fn a_machine_without_data_is_a_fresh_install() {
    let d = dir("fresh");
    let r = probe(&d.join("n"), &d.join("l"), None).unwrap();
    assert_eq!(r.startup, "FRESH_INSTALL");
    assert!(r.databases.is_empty());
}

#[test]
fn a_2x_root_is_checked_database_by_database_before_its_first_conversion() {
    let d = dir("first");
    let l = d.join("l");
    legacy_root(&l);
    let r = probe(&d.join("n"), &l, None).unwrap();
    assert_eq!(r.startup, "FIRST_CONVERSION");
    assert_eq!(scopes(&r.databases), ["registry", "knowledge", "project"]);
    assert!(r.databases.iter().all(|c| c.version.is_some_and(|v| v > 0)));
}

/// 2.x 的库里有转换器不认得的迁移（更新的 2.x 写的）、或者历史断档：转换会拒绝，探测先拒绝。
#[test]
fn a_2x_database_this_converter_does_not_know_is_refused() {
    let d = dir("legacy-unknown");
    let l = d.join("l");
    legacy_root(&l);
    let project = l.join("projects").join("P1").join("project.sqlite");
    add_migration(
        &project,
        "INSERT INTO schema_migrations VALUES (9999, '9999_future.sql', '2026-09-01T00:00:00.000Z', 'ab', 'APPLIED')",
    );
    let e = probe(&d.join("n"), &l, None).unwrap_err();
    assert_eq!(
        (e.code, e.scope),
        ("LEGACY_SCHEMA_UNKNOWN", "project"),
        "{e:?}"
    );

    let d = dir("legacy-gap");
    let l = d.join("l");
    legacy_root(&l);
    add_migration(
        &l.join("knowledge").join("knowledge.sqlite"),
        "INSERT INTO schema_migrations SELECT 9999, name, applied_at, content_sha256, hash_origin FROM schema_migrations WHERE version = 1;
         DELETE FROM schema_migrations WHERE version = 1",
    );
    let e = probe(&d.join("n"), &l, None).unwrap_err();
    assert_eq!(
        (e.code, e.scope),
        ("LEGACY_SCHEMA_UNKNOWN", "knowledge"),
        "{e:?}"
    );
}

/// `L` 在但没有 registry：这一次就要转换时转不了；已经发布了 3.0 时不碍事。
/// 空的 `L`、只有 setup 的 `current` 的 `L` 不算在（07 §1），是全新安装（W8b）。
#[test]
fn a_2x_root_without_a_registry_only_fails_when_it_would_be_converted() {
    let d = dir("no-registry");
    let (n, l) = (d.join("n"), d.join("l"));
    fs::create_dir_all(l.join("current")).unwrap();
    assert_eq!(probe(&n, &l, None).unwrap().startup, "FRESH_INSTALL");
    fs::create_dir_all(l.join("projects")).unwrap();
    let e = probe(&n, &l, None).unwrap_err();
    assert_eq!(
        (e.code, e.scope),
        ("LEGACY_UNREADABLE", "registry"),
        "{e:?}"
    );

    cv::fresh_install(&Layout::new(&n), G, AT).unwrap();
    let r = probe(&n, &l, None).unwrap();
    assert_eq!(r.startup, "PUBLISHED");
    assert_eq!(scopes(&r.databases), ["v3"]);
}

/// 已发布的 3.0 库：迁移都认得才行；更新的 3.x 写过的库（多出这个构建没有的迁移）拒绝。`L` 照样检查。
#[test]
fn a_published_store_must_carry_only_migrations_this_build_knows() {
    let d = dir("published");
    let (n, l) = (d.join("n"), d.join("l"));
    legacy_root(&l);
    let layout = Layout::new(&n);
    cv::fresh_install(&layout, G, AT).unwrap();
    let r = probe(&n, &l, None).unwrap();
    assert_eq!(r.startup, "PUBLISHED");
    assert_eq!(
        scopes(&r.databases),
        ["v3", "registry", "knowledge", "project"]
    );
    assert_eq!(
        r.databases[0].version,
        atm_store::MIGRATIONS.last().map(|m| m.version)
    );

    add_migration(
        &layout.database(),
        "INSERT INTO schema_migrations (version, name, sha256, applied_at) VALUES (9999, 'future', 'ab', '2026-10-11T00:00:00.000Z')",
    );
    let e = probe(&n, &l, None).unwrap_err();
    assert_eq!((e.code, e.scope), ("V3_SCHEMA_UNKNOWN", "v3"), "{e:?}");

    // 同一个版本号、文本不同（别的构建写的）：同样拒绝。
    add_migration(
        &layout.database(),
        "DELETE FROM schema_migrations WHERE version = 9999;
         UPDATE schema_migrations SET sha256 = 'ab' WHERE version = 1",
    );
    let e = probe(&n, &l, None).unwrap_err();
    assert_eq!((e.code, e.scope), ("V3_SCHEMA_UNKNOWN", "v3"), "{e:?}");
    assert!(e.detail.contains("differs"), "{e:?}");
}

fn opens(_: &[u8]) -> bool {
    true
}

fn refuses(_: &[u8]) -> bool {
    false
}

/// 同步密文这个 Windows 账户解不开：转换会停下等用户，探测先拒绝；解得开就放行；没有自检也不放行。
#[test]
fn sync_secrets_this_account_cannot_open_are_refused() {
    let d = dir("secrets");
    let (n, l) = (d.join("n"), d.join("l"));
    legacy_root(&l);
    fs::create_dir_all(l.join("sync")).unwrap();
    fs::write(l.join("sync").join("secrets.dpapi.json"), b"{\"v\":1}").unwrap();
    assert!(probe(&n, &l, Some(opens)).is_ok());
    for check in [Some(refuses as fn(&[u8]) -> bool), None] {
        let e = probe(&n, &l, check).unwrap_err();
        assert_eq!(
            (e.code, e.scope),
            ("SYNC_SECRETS_UNREADABLE", "sync"),
            "{e:?}"
        );
    }
}

/// 旧版还在服务时 `L` 的库是 WAL 模式、`-wal` 里有没合并的内容：只读打开照样读得到（迁移登记在 WAL 里也算），
/// 不建、不改任何文件。
#[test]
fn a_2x_root_in_use_is_read_without_touching_it() {
    let d = dir("in-use");
    let (n, l) = (d.join("n"), d.join("l"));
    legacy_root(&l);
    let registry = l.join("registry").join("registry.sqlite");
    let writer = Connection::open(&registry).unwrap();
    writer.pragma_update(None, "journal_mode", "WAL").unwrap();
    writer.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
    writer
        .execute(
            "INSERT INTO schema_migrations VALUES (9999, '9999_future.sql', ?1, 'ab', 'APPLIED')",
            [T],
        )
        .unwrap();
    // 旧版开着库：-wal、-shm 都在，探测前后都在、一字节不变。
    let e = probe(&n, &l, None).unwrap_err();
    assert_eq!(
        (e.code, e.scope),
        ("LEGACY_SCHEMA_UNKNOWN", "registry"),
        "{e:?}"
    );
    writer
        .execute("DELETE FROM schema_migrations WHERE version = 9999", [])
        .unwrap();
    let r = probe(&n, &l, None).unwrap();
    assert_eq!(r.startup, "FIRST_CONVERSION");
    drop(writer);
}
