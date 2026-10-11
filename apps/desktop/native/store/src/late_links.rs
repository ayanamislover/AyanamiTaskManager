//! peer W6 r4 的反例（P1-01、P1-02）：守卫拿到之后，才把上层链接换向，或者把当时不存在的层建成链接；
//! 之后清扫、备份、恢复读到的、删掉的都还必须在原来的数据根里。外面那份一个字节都不能变。
//! peer W6 r5 P1-01：把换向提前到 Store 打开之后、守卫取得之前，走公开的备份与导出入口，结论一样。

use std::fs;
use std::path::{Path, PathBuf};

use crate::backup::{
    BackupsRoot, DB_FILE, attachments_lock, create_backup, create_backup_locked, side_reader,
    sweep_withdrawn_locked, verify_backup,
};
use crate::{Config, Store};

fn base(name: &str) -> PathBuf {
    let d = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("target")
        })
        .join("store-unit")
        .join(format!("late-{name}"));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

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

/// 删链接本身（不碰目标）。
fn unlink(p: &Path) {
    if fs::symlink_metadata(p).is_ok() {
        fs::remove_dir(p).unwrap();
    }
}

fn store_with_identity(db: &Path, identity: &'static str) -> Store {
    let s = Store::open(db, Config::default()).unwrap();
    s.write(move |tx| {
        tx.execute(
            "INSERT INTO app_meta (singleton, schema_version, data_root_id, generation, instance_epoch, scope_gen_counter, created_at, updated_at)
             VALUES (1, 1, ?1, 'G', 'E', 0, 't', 't')",
            [identity],
        )
    })
    .unwrap();
    s
}

/// 外面那份留作对照的文件：返回它和它现在的内容。
fn victim(path: PathBuf, bytes: &[u8]) -> (PathBuf, Vec<u8>) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, bytes).unwrap();
    (path, bytes.to_vec())
}

/// P1-01：备份根、隔离区、「正在创建」在取得守卫时不存在，清扫之前被建成指向外面的 junction。清扫不跟着它
/// 枚举、删除；外面的文件原样还在。
#[test]
fn a_backup_layer_that_appears_as_a_link_after_pinning_is_not_swept() {
    for layer in ["backups", ".withdrawn", ".creating"] {
        let b = base(&format!("sweep{layer}"));
        fs::create_dir_all(b.join("N")).unwrap();
        let store = Store::open(&b.join("N").join("atm.sqlite"), Config::default()).unwrap();
        let root = b.join("N").join("backups");
        if layer != "backups" {
            fs::create_dir(&root).unwrap();
        }
        let _lock = attachments_lock(&store, "late_links").unwrap();
        let mut pinned = BackupsRoot::pin(&root).unwrap();
        let outside = b.join("outside");
        let id = "01J0000000000000000000000B";
        let (file, bytes) = match layer {
            "backups" => victim(outside.join(".withdrawn").join(id).join("keep.txt"), b"x1"),
            ".withdrawn" => victim(outside.join(id).join("keep.txt"), b"x2"),
            _ => victim(outside.join(id), b"external marker"),
        };
        let link = if layer == "backups" {
            root.clone()
        } else {
            root.join(layer)
        };
        junction(&link, &outside);
        sweep_withdrawn_locked(&store, &mut pinned);
        assert_eq!(fs::read(&file).unwrap(), bytes, "{layer}");
        assert!(
            fs::symlink_metadata(&link).is_ok(),
            "{layer}: 链接本身也留着"
        );
        drop(pinned);
        unlink(&link);
    }
}

/// P1-01：附件根、`.restore-staging` 在取得附件守卫时不存在，收尾之前被建成指向外面的 junction（外面放着一个
/// 看起来像未提交恢复的标记与暂存）。收尾拒绝，不丢弃外面的暂存。
#[test]
fn a_restore_layer_that_appears_as_a_link_after_pinning_is_not_cleaned() {
    for layer in ["artifacts", ".restore-staging"] {
        let b = base(&format!("finish{layer}"));
        fs::create_dir_all(b.join("N")).unwrap();
        let store = Store::open(&b.join("N").join("atm.sqlite"), Config::default()).unwrap();
        let root = b.join("N").join("artifacts");
        if layer != "artifacts" {
            fs::create_dir(&root).unwrap();
        }
        let mut guard = attachments_lock(&store, "late_links").unwrap();
        let outside = b.join("outside");
        let staging = if layer == "artifacts" {
            outside.join(".restore-staging")
        } else {
            outside.clone()
        };
        let (file, bytes) = victim(staging.join("PA").join("keep.txt"), b"external bytes");
        fs::write(staging.join("PA.gen"), b"0").unwrap();
        let link = if layer == "artifacts" {
            root.clone()
        } else {
            root.join(layer)
        };
        junction(&link, &outside);
        let result = crate::restore::finish_swaps_locked(&store, &mut guard);
        assert!(
            matches!(result, Err(crate::backup::BackupError::LinkedPath(_))),
            "{layer}: {result:?}"
        );
        assert_eq!(fs::read(&file).unwrap(), bytes, "{layer}");
        assert!(staging.join("PA.gen").is_file(), "{layer}");
        drop(guard);
        unlink(&link);
    }
}

/// 阳性对照：取得守卫之后才出现的是普通目录（真有一次没收尾的恢复留下的），照常清掉。
#[test]
fn a_plain_layer_that_appears_after_pinning_is_still_swept() {
    let b = base("sweep-plain");
    fs::create_dir_all(b.join("N")).unwrap();
    let store = Store::open(&b.join("N").join("atm.sqlite"), Config::default()).unwrap();
    let root = b.join("N").join("backups");
    let _lock = attachments_lock(&store, "late_links").unwrap();
    let mut pinned = BackupsRoot::pin(&root).unwrap();
    let parked = root.join(".withdrawn").join("01J0000000000000000000000C");
    fs::create_dir_all(&parked).unwrap();
    fs::write(parked.join("f"), b"x").unwrap();
    assert_eq!(sweep_withdrawn_locked(&store, &mut pinned), 0);
    assert!(!parked.exists());
}

/// P1-02：取得附件守卫与备份根之后，把数据根以上的 alias 换向另一个数据根。备份里的库与附件都还出自原来的数据根。
#[test]
fn a_backup_reads_the_database_from_the_pinned_root() {
    let b = base("db-alias");
    let (real, foreign) = (b.join("real"), b.join("foreign"));
    for p in [&real, &foreign] {
        fs::create_dir_all(p.join("N").join("artifacts")).unwrap();
    }
    let (alias, old) = (b.join("alias"), b.join("alias-old"));
    junction(&alias, &real);
    let store = store_with_identity(&alias.join("N").join("atm.sqlite"), "ORIGINAL");
    let other = store_with_identity(&foreign.join("N").join("atm.sqlite"), "FOREIGN");
    fs::write(real.join("N/artifacts/source.txt"), b"original attachments").unwrap();
    fs::write(
        foreign.join("N/artifacts/source.txt"),
        b"foreign attachments",
    )
    .unwrap();
    let mut lock = attachments_lock(&store, "late_links").unwrap();
    let mut backups = BackupsRoot::pin(&alias.join("N").join("backups")).unwrap();
    fs::rename(&alias, &old).unwrap();
    junction(&alias, &foreign);
    let made = create_backup_locked(
        &store,
        &mut backups,
        &mut lock,
        "MANUAL",
        "2026-10-10T12:00:00Z",
    );
    drop(backups);
    drop(lock);
    unlink(&alias);
    fs::rename(&old, &alias).unwrap();
    let info = made.unwrap();
    let c = side_reader(&info.dir.join("atm.sqlite")).unwrap();
    let id: String = c
        .query_row("SELECT data_root_id FROM app_meta", [], |r| r.get(0))
        .unwrap();
    drop(c);
    assert_eq!(id, "ORIGINAL");
    assert_eq!(
        fs::read(info.dir.join("artifacts").join("source.txt")).unwrap(),
        b"original attachments"
    );
    drop(store);
    drop(other);
    unlink(&alias);
}

/// P1-02 的同类通道：校验之后，把备份根以上的 alias 换向别处的同名备份。恢复读的仍是校验过的那一份。
#[test]
fn a_verified_backup_keeps_reading_what_was_verified() {
    let b = base("verified");
    fs::create_dir_all(b.join("N")).unwrap();
    let store = store_with_identity(&b.join("N").join("atm.sqlite"), "ORIGINAL");
    let (shelf, other_shelf) = (b.join("shelf"), b.join("other-shelf"));
    fs::create_dir_all(&shelf).unwrap();
    let alias = b.join("alias");
    junction(&alias, &shelf);
    let info = create_backup(
        &store,
        &alias.join("backups"),
        "MANUAL",
        "2026-10-10T12:00:00Z",
    )
    .unwrap();
    let vb = verify_backup(&store, &info.id).unwrap();
    // 别处放一份同名、内容不同的「备份」，把 alias 指过去。
    let fake = other_shelf.join("backups").join(&info.id);
    fs::create_dir_all(&fake).unwrap();
    fs::write(fake.join("atm.sqlite"), b"not the verified database").unwrap();
    fs::rename(&alias, b.join("alias-old")).unwrap();
    junction(&alias, &other_shelf);
    let (sha, _) = crate::backup::hash_file(&vb.source_db()).unwrap();
    assert_eq!(sha, info.sha256);
    // 登记路径（展示用）已经指向别处，读取路径没有跟过去。
    assert!(!crate::backup::hash_file(&vb.db).is_ok_and(|(s, _)| s == info.sha256));
    drop(vb);
    unlink(&alias);
    unlink(&b.join("alias-old"));
}

/// P1-01（备份一路）：附件根在取得守卫时不存在，备份之前被建成指向外面的 junction。备份拒绝，不把外面的文件当附件打包。
#[test]
fn a_backup_does_not_copy_attachments_through_a_late_link() {
    let b = base("late-artifacts");
    fs::create_dir_all(b.join("N")).unwrap();
    let store = store_with_identity(&b.join("N").join("atm.sqlite"), "ORIGINAL");
    let mut lock = attachments_lock(&store, "late_links").unwrap();
    let mut backups = BackupsRoot::pin(&b.join("N").join("backups")).unwrap();
    let outside = b.join("outside");
    victim(outside.join("PA").join("secret.txt"), b"not ours");
    let link = b.join("N").join("artifacts");
    junction(&link, &outside);
    let made = create_backup_locked(
        &store,
        &mut backups,
        &mut lock,
        "MANUAL",
        "2026-10-10T12:00:00Z",
    );
    assert!(
        matches!(made, Err(crate::backup::BackupError::LinkedPath(_))),
        "{made:?}"
    );
    let copied = fs::read_dir(b.join("N").join("backups"))
        .map(|d| d.flatten().any(|e| e.path().join("artifacts").exists()))
        .unwrap_or(false);
    assert!(!copied);
    drop(backups);
    drop(lock);
    unlink(&link);
}

/// 数据根 `real/N` 与 `foreign/N` 各有一个库、一个附件；`alias` 先指向 `real`，从 `alias/N` 打开 ORIGINAL。
/// 返回 (base, real, foreign, alias, ORIGINAL, FOREIGN)。
fn two_roots(name: &str) -> (PathBuf, PathBuf, PathBuf, PathBuf, Store, Store) {
    let b = base(name);
    let (real, foreign) = (b.join("real"), b.join("foreign"));
    for p in [&real, &foreign] {
        fs::create_dir_all(p.join("N").join("artifacts").join("PA")).unwrap();
    }
    let alias = b.join("alias");
    junction(&alias, &real);
    let store = store_with_identity(&alias.join("N").join("atm.sqlite"), "ORIGINAL");
    let other = store_with_identity(&foreign.join("N").join("atm.sqlite"), "FOREIGN");
    for (s, code) in [(&store, "ORIGINALP"), (&other, "FOREIGNP")] {
        s.write(move |tx| {
            tx.execute_batch(
                "INSERT INTO scope_generations (gen, scope_kind, scope_id, reason, epoch, created_at)
                 VALUES (1, 'PROJECT', 'PA', 'CREATED', 'EPA', 't');",
            )?;
            tx.execute(
                "INSERT INTO projects (id, code, name, lifecycle, health, meta_version, scope_gen, epoch, created_at, updated_at)
                 VALUES ('PA', ?1, ?1, 'ACTIVE', 'ON_TRACK', 0, 1, 'EPA', 't', 't')",
                [code],
            )
        })
        .unwrap();
    }
    fs::write(
        real.join("N/artifacts/PA/source.txt"),
        b"original attachments",
    )
    .unwrap();
    fs::write(
        foreign.join("N/artifacts/PA/source.txt"),
        b"foreign attachments",
    )
    .unwrap();
    (b, real, foreign, alias, store, other)
}

/// 把 `alias` 换向 `to`（原来那个链接改名留着），返回改名后的位置。
fn swing(alias: &Path, to: &Path) -> PathBuf {
    let old = alias.with_file_name("alias-old");
    fs::rename(alias, &old).unwrap();
    junction(alias, to);
    old
}

fn swing_back(alias: &Path, old: &Path) {
    unlink(alias);
    fs::rename(old, alias).unwrap();
}

/// r5 P1-01（备份一路）：Store 已打开、守卫还没取得时把 alias 换向 FOREIGN，再走公开的 `create_backup`
/// （备份根也写成 alias 下的路径）。备份里的库与附件都出自 ORIGINAL，备份目录也落在 ORIGINAL 里；FOREIGN 原样。
#[test]
fn a_backup_after_an_early_alias_swing_still_reads_the_live_store() {
    let (b, real, foreign, alias, store, other) = two_roots("early-backup");
    let old = swing(&alias, &foreign);
    let made = create_backup(
        &store,
        &alias.join("N").join("backups"),
        "MANUAL",
        "2026-10-10T12:00:00Z",
    );
    // 换向期间写进 Store 的东西也还在 ORIGINAL。
    store
        .write(|tx| {
            tx.execute(
                "UPDATE projects SET name = 'still original' WHERE id = 'PA'",
                [],
            )
        })
        .unwrap();
    swing_back(&alias, &old);
    let info = made.unwrap();
    // 登记的是调用方给的路径；文件在 ORIGINAL 的真实位置里。
    assert_eq!(info.dir, alias.join("N").join("backups").join(&info.id));
    let on_disk = real.join("N").join("backups").join(&info.id);
    let c = side_reader(&on_disk.join("atm.sqlite")).unwrap();
    let id: String = c
        .query_row("SELECT data_root_id FROM app_meta", [], |r| r.get(0))
        .unwrap();
    drop(c);
    assert_eq!(id, "ORIGINAL");
    assert_eq!(
        fs::read(on_disk.join("artifacts").join("PA").join("source.txt")).unwrap(),
        b"original attachments"
    );
    assert!(!foreign.join("N").join("backups").exists());
    verify_backup(&store, &info.id).unwrap();
    let name: String = other
        .read(|tx| tx.query_row("SELECT name FROM projects", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(name, "FOREIGNP");
    drop(store);
    drop(other);
    unlink(&alias);
    let _ = b;
}

/// r5 P1-01（导出一路）：同样的提前换向之后，公开的 `export_project` 导出的仍是 ORIGINAL 的项目与附件。
#[test]
fn an_export_after_an_early_alias_swing_still_reads_the_live_store() {
    let (b, _real, foreign, alias, store, other) = two_roots("early-export");
    let old = swing(&alias, &foreign);
    let exports = b.join("exports");
    let made = crate::package::export_project(
        &store,
        "PA",
        crate::package::Format::Json,
        &crate::package::ExportOptions {
            exports_dir: &exports,
            at: "2026-10-10T12:00:00Z",
            app_version: "test",
        },
    );
    swing_back(&alias, &old);
    let ex = made.unwrap();
    assert_eq!(ex.project_code, "ORIGINALP");
    let text = String::from_utf8_lossy(&fs::read(&ex.path).unwrap()).into_owned();
    assert!(text.contains("ORIGINALP") && !text.contains("FOREIGNP"));
    assert!(!foreign.join("N").join("exports").exists());
    drop(store);
    drop(other);
    unlink(&alias);
}

/// r5 P1-01 的守卫：钉住的数据根与 Store 打开时不是同一个目录（这里伪造身份来模拟）就在任何副作用之前拒绝。
#[test]
fn a_guard_on_a_different_root_than_the_store_opened_is_refused() {
    let b = base("root-identity");
    fs::create_dir_all(b.join("N")).unwrap();
    let mut store = store_with_identity(&b.join("N").join("atm.sqlite"), "ORIGINAL");
    store.forge_root_identity();
    let refused = attachments_lock(&store, "late_links");
    assert!(
        matches!(refused, Err(crate::backup::BackupError::LinkedPath(_))),
        "{:?}",
        refused.err()
    );
    let made = create_backup(
        &store,
        &b.join("N").join("backups"),
        "MANUAL",
        "2026-10-10T12:00:00Z",
    );
    assert!(made.is_err());
    assert!(!b.join("N").join("backups").exists());
}
/// r5 P1-01（打开一路）：钉住数据根之后、打开连接之前 alias 被换向——写连接、读池、checkpoint 都从钉住的真实位置
/// 打开，Store 读写的仍是 ORIGINAL，FOREIGN 一个字节都不变。
#[test]
fn connections_open_in_the_root_that_was_pinned() {
    let b = base("open-window");
    let (real, foreign) = (b.join("real"), b.join("foreign"));
    for p in [&real, &foreign] {
        fs::create_dir_all(p.join("N")).unwrap();
    }
    let alias = b.join("alias");
    junction(&alias, &real);
    let original = store_with_identity(&real.join("N").join("atm.sqlite"), "ORIGINAL");
    drop(original);
    let other = store_with_identity(&foreign.join("N").join("atm.sqlite"), "FOREIGN");
    drop(other);
    let foreign_db = foreign.join("N").join("atm.sqlite");
    let before = fs::read(&foreign_db).unwrap();
    let db = alias.join("N").join("atm.sqlite");
    let (a, f) = (alias.clone(), foreign.clone());
    crate::engine::on_next_open_after_pin(&db, move || {
        swing(&a, &f);
    });
    let store = Store::open(&db, Config::default()).unwrap();
    let id: String = store
        .read(|tx| tx.query_row("SELECT data_root_id FROM app_meta", [], |r| r.get(0)))
        .unwrap();
    store
        .write(|tx| tx.execute("UPDATE app_meta SET updated_at = 'written'", []))
        .unwrap();
    drop(store);
    swing_back(&alias, &alias.with_file_name("alias-old"));
    assert_eq!(id, "ORIGINAL");
    assert_eq!(fs::read(&foreign_db).unwrap(), before);
    unlink(&alias);
}

/// FOREIGN 里一个 ATM 自己会清的暂存（名字是 ULID）与一个备份标记：被误认成本 Store 的就会被删。
fn foreign_sentinels(foreign: &Path) -> Vec<PathBuf> {
    let id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    let staged = foreign
        .join("N")
        .join("exports")
        .join(".staging")
        .join(id)
        .join("foreign.txt");
    let backup = foreign
        .join("N")
        .join("backups")
        .join(id)
        .join("foreign.txt");
    for f in [&staged, &backup] {
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(f, b"FOREIGN keep").unwrap();
    }
    let creating = foreign.join("N").join("backups").join(".creating");
    fs::create_dir_all(&creating).unwrap();
    fs::write(creating.join(id), b"").unwrap();
    vec![staged, backup, creating.join(id)]
}

/// r6 P1-01：导出与两种导入的暂存（`exports\.staging`）也跟着 Store 的数据根走。提前换向之后以 alias 下的
/// `exports` 调三个公开入口：暂存建在 ORIGINAL 里，FOREIGN 的暂存与备份一个都不删，导出文件也不落进 FOREIGN。
/// 两种导入给的是坏来源：它们在暂存之后才失败，暂存那一步照样走到。
#[test]
fn export_and_import_staging_stays_with_the_live_store() {
    for entry in ["export", "import-package", "import-knowledge"] {
        let (b, real, foreign, alias, store, other) = two_roots(&format!("staging-{entry}"));
        let kept = foreign_sentinels(&foreign);
        let garbage = b.join("not-a-package.bin");
        fs::write(&garbage, b"not a package").unwrap();
        let old = swing(&alias, &foreign);
        let exports = alias.join("N").join("exports");
        let import = crate::package::ImportOptions {
            exports_dir: &exports,
            at: "2026-10-10T12:00:00Z",
            code: None,
            source_label: "late_links",
        };
        let outcome: Result<Option<PathBuf>, String> = match entry {
            "export" => crate::package::export_project(
                &store,
                "PA",
                crate::package::Format::Json,
                &crate::package::ExportOptions {
                    exports_dir: &exports,
                    at: "2026-10-10T12:00:00Z",
                    app_version: "test",
                },
            )
            .map(|e| Some(e.path))
            .map_err(|e| e.to_string()),
            "import-package" => crate::package::import_project(
                &store,
                crate::package::ImportSource::Package(&b.join("missing.aytproj")),
                &import,
            )
            .map(|_| None)
            .map_err(|e| e.to_string()),
            _ => crate::package::import_legacy_knowledge(&store, &garbage, &import)
                .map(|_| None)
                .map_err(|e| e.to_string()),
        };
        swing_back(&alias, &old);
        for f in &kept {
            assert!(f.exists(), "{entry}: {} was removed", f.display());
        }
        let foreign_exports: Vec<_> = fs::read_dir(foreign.join("N").join("exports"))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(foreign_exports, [".staging"], "{entry}");
        assert!(
            real.join("N").join("exports").join(".staging").is_dir(),
            "{entry}: the staging was not made in ORIGINAL"
        );
        if entry == "export" {
            let out = outcome.unwrap().unwrap();
            assert!(
                real.join("N")
                    .join("exports")
                    .join(out.file_name().unwrap())
                    .is_file()
            );
        } else {
            assert!(outcome.is_err(), "{entry}: {outcome:?}");
        }
        drop(store);
        drop(other);
        unlink(&alias);
    }
}

/// r6 P1-02：同一个位置换种写法（大小写、`\\?\`、正斜杠、`.` 与 `..`）还是 Store 的数据根下，备份与清扫都落在
/// ORIGINAL，FOREIGN 的标记与备份不动。对照：数据根以外的备份根照调用方的写法用。
#[test]
fn a_backup_root_spelled_another_way_is_still_inside_the_store() {
    for mode in [
        "exact", "case", "verbatim", "device", "slashes", "dots", "external",
    ] {
        let (b, real, foreign, alias, store, other) = two_roots(&format!("spelling-{mode}"));
        let kept = foreign_sentinels(&foreign);
        let plain = alias.join("N").join("backups");
        let root = match mode {
            "case" => PathBuf::from(plain.to_string_lossy().to_uppercase()),
            "verbatim" => PathBuf::from(format!(r"\\?\{}", plain.display())),
            "device" => PathBuf::from(format!(r"\\.\{}", plain.display())),
            "slashes" => PathBuf::from(plain.to_string_lossy().replace('\\', "/")),
            "dots" => alias
                .join("N")
                .join(".")
                .join("x")
                .join("..")
                .join("backups"),
            "external" => b.join("external-backups"),
            _ => plain.clone(),
        };
        let old = swing(&alias, &foreign);
        let made = create_backup(&store, &root, "MANUAL", "2026-10-10T12:00:00Z");
        swing_back(&alias, &old);
        let info = made.unwrap_or_else(|e| panic!("{mode}: {e}"));
        for f in &kept {
            assert!(f.exists(), "{mode}: {} was removed", f.display());
        }
        assert!(
            !foreign.join("N").join("backups").join(&info.id).exists(),
            "{mode}"
        );
        let landed = if mode == "external" {
            b.join("external-backups")
        } else {
            real.join("N").join("backups")
        };
        assert!(landed.join(&info.id).join(DB_FILE).is_file(), "{mode}");
        drop(store);
        drop(other);
        unlink(&alias);
    }
}

/// r6 P2-01：alias 还指着别处时，刚建的备份照样校验得过（按 Store 钉住的位置找，不按登记的写法）。
#[test]
fn a_backup_verifies_while_the_alias_still_points_elsewhere() {
    let (_b, real, foreign, alias, store, other) = two_roots("verify-swung");
    let old = swing(&alias, &foreign);
    let made = create_backup(
        &store,
        &alias.join("N").join("backups"),
        "MANUAL",
        "2026-10-10T12:00:00Z",
    )
    .unwrap();
    assert!(
        real.join("N")
            .join("backups")
            .join(&made.id)
            .join(DB_FILE)
            .is_file()
    );
    let verified = verify_backup(&store, &made.id).map(|_| ());
    swing_back(&alias, &old);
    verified.unwrap();
    drop(store);
    drop(other);
    unlink(&alias);
}

/// `Location`：Windows 上的同一个位置认作同一个；段的边界不跨（`N` 不是 `N2` 的前缀）；不做多字符的大小写展开；
/// `\\?\` 写法里的 `..`、`/` 是名字（Windows 不解释它们）。
#[test]
fn locations_follow_windows_path_equality() {
    use crate::engine::Location;
    let inside = |p: &str, base: &str| {
        Location::of(Path::new(p))
            .below(&Location::of(Path::new(base)))
            .map(|rest| {
                rest.iter()
                    .map(|c| c.to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
            })
    };
    let base = r"C:\Data\N";
    for p in [
        r"c:\data\n\BACKUPS",
        r"\\?\C:\Data\N\backups",
        "C:/Data/N/backups",
        r"C:\Data\.\N\x\..\backups\",
    ] {
        // 之下的部分保留调用方的写法。
        let rest = inside(p, base).unwrap_or_else(|| panic!("{p}"));
        assert_eq!(rest.len(), 1, "{p}");
        assert!(rest[0].eq_ignore_ascii_case("backups"), "{p}");
    }
    assert_eq!(inside(base, base), Some(vec![]));
    assert_eq!(
        inside(r"\\?\UNC\server\share\N\x", r"\\server\share\N"),
        Some(vec!["x".to_owned()])
    );
    assert_eq!(inside(r"C:\server\share\N", r"\\server\share\N"), None);
    assert_eq!(inside(r"C:\Data\N2\backups", base), None);
    // ß 的大写是 SS（两个字符），NTFS 不这样比：两个名字不同。单个码元的大小写照常等价。
    assert_eq!(inside(r"C:\STRASSE\N", r"C:\straße\N"), None);
    assert_eq!(
        inside(r"C:\STRAßE\N\b", r"C:\straße\N"),
        Some(vec!["b".to_owned()])
    );
    assert_eq!(inside(r"C:\ÄRGER\N", r"C:\ärger\N"), Some(vec![]));
    // `\\?\` 写法：`..` 与 `/` 原样是名字，不归一。
    assert_eq!(
        inside(r"\\?\C:\Data\N\..\N2", base),
        Some(vec!["..".to_owned(), "N2".to_owned()])
    );
    assert_eq!(
        inside(r"\\?\C:\Data\N\a/b", base),
        Some(vec!["a/b".to_owned()])
    );
    // 设备命名空间 `\\.\` 与普通写法是同一个位置（peer r8）；`UNC` 不分大小写。
    assert_eq!(
        inside(r"\\.\C:\Data\N\backups", base),
        Some(vec!["backups".to_owned()])
    );
    for p in [r"\\.\UNC\server\share\N\x", r"\\?\unc\server\share\N\x"] {
        assert_eq!(
            inside(p, r"\\server\share\N"),
            Some(vec!["x".to_owned()]),
            "{p}"
        );
        assert_eq!(inside(p, r"C:\server\share\N"), None, "{p}");
    }
    // 设备命名空间照样经 Win32 归一；Store 自己用这种写法打开、调用方用普通写法，也是同一个位置。
    assert_eq!(
        inside(r"\\.\C:\Data\N\x\..\backups", base),
        Some(vec!["backups".to_owned()])
    );
    assert_eq!(
        inside(r"C:\Data\N\backups", r"\\.\C:\Data\N"),
        Some(vec!["backups".to_owned()])
    );
    // 普通写法里连续的分隔符由 Win32 归一；`\\?\` 写法中间的空段记作打不开（peer r8 P1-02），末尾的分隔符不算。
    let gaps = |p: &str| Location::of(Path::new(p)).gaps;
    assert_eq!(
        inside(r"C:\Data\N\\child", base),
        Some(vec!["child".to_owned()])
    );
    assert!(!gaps(r"C:\Data\N\\child"));
    assert!(gaps(r"\\?\C:\Data\N\\child"));
    assert!(gaps(r"\\?\C:\Data\\N\child"));
    assert!(gaps(r"\\?\UNC\server\share\\N"));
    assert!(!gaps(r"\\?\C:\Data\N\backups\"));
    // 只认盘符与 UNC 两种命名空间；GLOBALROOT、卷 GUID、设备对象都不支持，也不在任何位置之下（peer r9 P1-01）。
    for p in [
        r"\\?\GLOBALROOT\??\C:\Data\N\backups",
        r"\\.\GLOBALROOT\??\C:\Data\N\backups",
        r"\\?\GLOBALROOT\GLOBAL??\C:\Data\N\backups",
        r"\\?\Volume{00000000-0000-0000-0000-000000000000}\Data\N",
        r"\\.\PIPE\N",
    ] {
        let l = Location::of(Path::new(p));
        assert!(!l.supported(), "{p}");
        assert_eq!(inside(p, base), None, "{p}");
    }
    assert!(Location::of(Path::new(base)).supported());
    assert!(Location::of(Path::new(r"\\server\share\N")).supported());
    // 盘符的两种查询都换掉：QueryDosDeviceW 给 subst、网络映射与设备目标；GetVolumeNameForVolumeMountPointW 只对
    // 「卷的根」给卷名（这里按 Windows 的样子：目标正好是 `\Device\HarddiskVolumeN`，不带后缀）。subst 换成它指向的
    // 路径，网络映射盘符换成 UNC，其余按卷名比——同一个卷的两个盘符是同一个位置（peer r10 P1-01）；不是卷根的
    // 设备目标、认不出的重定向器都不支持（peer r11 P1-01）。
    let dev = |d: &[u16]| -> Option<Vec<u16>> {
        let letter = String::from_utf16_lossy(d).to_ascii_uppercase();
        let target = match letter.as_str() {
            "Z:" => r"\??\C:\Data".to_owned(),
            "G:" => r"\??\C:\".to_owned(),
            "Y:" => r"\Device\LanmanRedirector\;Y:0000000000012345\server\share".to_owned(),
            "X:" => r"\Device\Mup\;LanmanRedirector\;X:0000000000012345\server\share".to_owned(),
            "M:" => r"\Device\LanmanRedirector\;M:0000000000012345\server\share\;team".to_owned(),
            // 不是卷根的设备目标、认不出的重定向器与格式。
            "D:" => r"\Device\HarddiskVolume3\Data".to_owned(),
            "F:" => {
                r"\Device\WebDavRedirector\;F:0000000000012345\server@SSL\DavWWWRoot".to_owned()
            }
            "H:" => r"\Device\Mup\;WebDavRedirector\;H:0000000000012345\server\share".to_owned(),
            "I:" => r"\Device\Mup\;LanmanRedirector\;I:0000000000012345".to_owned(),
            "J:" => r"\Device\LanmanRedirector\;J:0000000000012345\server\\share".to_owned(),
            "L:" => r"\Device\LanmanRedirector\;L:0000000000012345\;server\share".to_owned(),
            "N:" => r"\Device\LanmanRedirector\;N:0000000000012345\server".to_owned(),
            "C:" | "K:" => r"\Device\HarddiskVolume3".to_owned(),
            // subst 套 subst：V → U → T → S → R → Q；P 指向自己。
            "V:" => r"\??\U:\v".to_owned(),
            "U:" => r"\??\T:\u".to_owned(),
            "T:" => r"\??\S:\t".to_owned(),
            "S:" => r"\??\R:\s".to_owned(),
            "R:" => r"\??\Q:\r".to_owned(),
            "P:" => r"\??\P:\p".to_owned(),
            // 没有这个盘符。
            "E:" => return None,
            other => format!(r"\Device\HarddiskVolume{}", other.as_bytes()[0]),
        };
        Some(target.encode_utf16().collect())
    };
    let vol = |d: &[u16]| -> Option<Vec<u16>> {
        let target = String::from_utf16_lossy(&dev(d)?);
        let device = target.strip_prefix(r"\Device\")?;
        (device.starts_with("HarddiskVolume") && !device.contains('\\'))
            .then(|| format!(r"\\?\Volume{{{device}}}\").encode_utf16().collect())
    };
    let key = |p: &str| Location::of_with(Path::new(p), &dev, &vol);
    let with = |p: &str, b: &str| {
        key(p).below(&key(b)).map(|rest| {
            rest.iter()
                .map(|c| c.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        })
    };
    let x = || Some(vec!["x".to_owned()]);
    assert_eq!(
        with(r"Z:\N\backups", base),
        Some(vec!["backups".to_owned()])
    );
    assert_eq!(with(r"C:\Data\N\x", r"z:\N"), x());
    // subst 指向卷根：不多拼分隔符（peer r10 P2-01）。
    assert_eq!(with(r"G:\Data\N\x", base), x());
    assert!(key(r"G:\Data\N").supported());
    for p in [r"Y:\N\x", r"X:\N\x"] {
        assert_eq!(with(p, r"\\server\share\N"), x(), "{p}");
    }
    // 重定向器只去掉打头的 `;` 段：共享之后以 `;` 开头的目录名照样是名字（peer r10 P1-02）。
    assert_eq!(with(r"M:\N\x", r"\\server\share\;team\N"), x());
    assert_eq!(with(r"M:\N\x", r"\\server\share\N"), None);
    // 同一个卷的另一个盘符是同一个位置；别的卷不是（peer r10 P1-01）。
    assert_eq!(with(r"K:\Data\N\x", base), x());
    assert_eq!(with(r"W:\Data\N", base), None);
    assert!(key(r"W:\Data\N").supported());
    // 证明不了的盘符一律不支持，不当外部位置（peer r11 P1-01）：设备目标带路径后缀（与 `C:\Data` 是同一个位置，
    // 但不是卷的根）。认不出的重定向器另有一条用例（`unrecognised_redirector_targets_are_refused`）。
    assert!(!key(r"D:\N\x").supported());
    assert!(!key(r"D:\N\x").unc());
    assert_eq!(with(r"D:\N\x", base), None);
    // 至多跟 4 层 subst：U 经四层到 Q；V 要五层，不支持（不当外部位置）。指向自己的、没有的盘符也不支持。
    assert_eq!(with(r"U:\x", r"Q:\r\s\t\u"), x());
    for p in [r"V:\x", r"P:\x", r"E:\x"] {
        assert!(!key(p).supported(), "{p}");
        assert_eq!(with(p, r"Q:\r\s\t\u\v"), None, "{p}");
    }
    // 空段在换算盘符之前就定下：经 subst 换算也照样打不开（peer r10 P1-03）。
    for p in [r"\\?\Z:\N\\", r"\\?\Z:\N\\x", r"\\?\G:\Data\\N"] {
        let k = key(p);
        assert!(k.gaps && !k.supported(), "{p}");
        assert_eq!(with(p, base), None, "{p}");
    }
    assert_eq!(
        inside(r"\\?\C:\Data\N\backups\", base),
        Some(vec!["backups".to_owned()])
    );
}

/// r11 P1-01（r12 P2-01 拆成单独一条：变异要能打在这几种重定向器目标上，不被别的断言先挡住）：映射盘符的目标
/// 只认格式完全对得上的 LanmanRedirector。其余的不支持、也不是 UNC：WebDAV、Mup 下的其他重定向器、残缺的 Mup
/// 目标、目标里有空段、服务器名以 `;` 开头、只有服务器没有共享。卷名查询照 Windows 的样子给不出（这些盘符不是卷的
/// 根）。对照：格式对得上的两种是那个 UNC 位置。
#[test]
fn unrecognised_redirector_targets_are_refused() {
    use crate::engine::Location;
    let dev = |d: &[u16]| -> Option<Vec<u16>> {
        let target = match String::from_utf16_lossy(d).to_ascii_uppercase().as_str() {
            "Y:" => r"\Device\LanmanRedirector\;Y:0000000000012345\server\share",
            "X:" => r"\Device\Mup\;LanmanRedirector\;X:0000000000012345\server\share",
            "F:" => r"\Device\WebDavRedirector\;F:0000000000012345\server@SSL\DavWWWRoot",
            "H:" => r"\Device\Mup\;WebDavRedirector\;H:0000000000012345\server\share",
            "I:" => r"\Device\Mup\;LanmanRedirector\;I:0000000000012345",
            "J:" => r"\Device\LanmanRedirector\;J:0000000000012345\server\\share",
            "L:" => r"\Device\LanmanRedirector\;L:0000000000012345\;server\share",
            "N:" => r"\Device\LanmanRedirector\;N:0000000000012345\server",
            _ => return None,
        };
        Some(target.encode_utf16().collect())
    };
    let vol = |_: &[u16]| -> Option<Vec<u16>> { None };
    let key = |p: &str| Location::of_with(Path::new(p), &dev, &vol);
    let share = key(r"\\server\share\N");
    for p in [r"Y:\N\x", r"X:\N\x"] {
        assert!(key(p).unc(), "{p}");
        assert_eq!(key(p).below(&share).map(|r| r.len()), Some(1), "{p}");
    }
    let mut accepted = Vec::new();
    for p in [
        r"F:\N\x", r"H:\N\x", r"I:\N\x", r"J:\N\x", r"L:\N\x", r"N:\N\x",
    ] {
        let k = key(p);
        if k.supported() || k.unc() {
            accepted.push(format!("{p}: {k:?}"));
        }
    }
    assert!(accepted.is_empty(), "accepted: {accepted:?}");
}

/// r7 P1-01：名字只是「Unicode 全量大写后相同」的另一个目录（`straße` 与 `STRASSE`）是真正的外部位置：备份落在
/// 调用方给的那里，Store 自己的备份根一个标记都不清。
#[test]
fn an_external_root_that_only_upper_cases_alike_stays_external() {
    let b = base("unicode-external");
    let (ours, theirs) = (b.join("straße"), b.join("STRASSE"));
    fs::create_dir_all(ours.join("N")).unwrap();
    fs::create_dir_all(theirs.join("N")).unwrap();
    let (a, z) = (
        crate::pin::open(&ours).unwrap().id(),
        crate::pin::open(&theirs).unwrap().id(),
    );
    assert_ne!(a, z, "两个不同的目录");
    let store = store_with_identity(&ours.join("N").join("atm.sqlite"), "ORIGINAL");
    let id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    let keep = ours.join("N").join("backups").join(id).join("keep.txt");
    fs::create_dir_all(keep.parent().unwrap()).unwrap();
    fs::write(&keep, b"keep").unwrap();
    let creating = ours.join("N").join("backups").join(".creating");
    fs::create_dir_all(&creating).unwrap();
    fs::write(creating.join(id), b"").unwrap();
    let made = create_backup(
        &store,
        &theirs.join("N").join("backups"),
        "MANUAL",
        "2026-10-10T12:00:00Z",
    )
    .unwrap();
    assert!(
        theirs
            .join("N")
            .join("backups")
            .join(&made.id)
            .join(DB_FILE)
            .is_file()
    );
    assert!(!ours.join("N").join("backups").join(&made.id).exists());
    assert!(
        keep.exists() && creating.join(id).exists(),
        "Store 自己的标记被清了"
    );
}

/// r7 P1-02：`\\?\` 写法里数据根之下的 `..` 不会被换算成兄弟目录：原来打不开的路径换算后照样打不开，兄弟目录里
/// 什么都不写、什么都不清。
#[test]
fn a_verbatim_dot_dot_below_the_root_does_not_become_a_sibling() {
    let b = base("verbatim-dots");
    let real = b.join("real");
    fs::create_dir_all(real.join("N")).unwrap();
    let alias = b.join("alias");
    junction(&alias, &real);
    let store = store_with_identity(&alias.join("N").join("atm.sqlite"), "ORIGINAL");
    let id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    let sibling = real.join("N2").join("backups");
    let keep = sibling.join(id).join("keep.txt");
    fs::create_dir_all(keep.parent().unwrap()).unwrap();
    fs::write(&keep, b"keep").unwrap();
    fs::create_dir_all(sibling.join(".creating")).unwrap();
    fs::write(sibling.join(".creating").join(id), b"").unwrap();
    let literal = PathBuf::from(format!(r"\\?\{}\N\..\N2\backups", alias.display()));
    assert!(
        crate::pin::open(literal.parent().unwrap()).is_err(),
        "原路径本来就打不开"
    );
    let made = create_backup(&store, &literal, "MANUAL", "2026-10-10T12:00:00Z");
    drop(store);
    unlink(&alias);
    assert!(made.is_err(), "{made:?}");
    assert!(keep.exists() && sibling.join(".creating").join(id).exists());
    let entries: Vec<_> = fs::read_dir(&sibling)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(entries.len(), 2, "兄弟目录里多了东西：{entries:?}");
}

/// r8 P1-02：`\\?\` 写法中间的空段（连续的 `\`）Windows 打不开；之后按 `std::path` 拆父目录与名字时空段会被并掉、
/// 变成一个打得开的邻近目录。在任何创建、清扫之前拒绝，数据根之下与之外都一样：邻近目录里的哨兵与标记都在、
/// 什么也不多。
#[test]
fn a_verbatim_empty_segment_is_refused_before_anything_is_written() {
    let b = base("verbatim-gap");
    let real = b.join("real");
    fs::create_dir_all(real.join("N")).unwrap();
    let alias = b.join("alias");
    junction(&alias, &real);
    let store = store_with_identity(&alias.join("N").join("atm.sqlite"), "ORIGINAL");
    let id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    for (case, near, literal) in [
        (
            "inside",
            real.join("N").join("folder").join("backups"),
            PathBuf::from(format!(r"\\?\{}\N\\folder\backups", alias.display())),
        ),
        (
            "inside-last",
            real.join("N").join("backups"),
            PathBuf::from(format!(r"\\?\{}\N\\backups", alias.display())),
        ),
        (
            "external",
            b.join("ext").join("backups"),
            PathBuf::from(format!(r"\\?\{}\ext\\backups", b.display())),
        ),
    ] {
        let keep = near.join(id).join("keep.txt");
        fs::create_dir_all(keep.parent().unwrap()).unwrap();
        fs::write(&keep, b"keep").unwrap();
        fs::create_dir_all(near.join(".creating")).unwrap();
        fs::write(near.join(".creating").join(id), b"").unwrap();
        assert!(
            crate::pin::open(&literal).is_err(),
            "{case}: 原路径本来就打不开"
        );
        let made = create_backup(&store, &literal, "MANUAL", "2026-10-10T12:00:00Z");
        assert!(made.is_err(), "{case}: {made:?}");
        assert!(
            keep.exists() && near.join(".creating").join(id).exists(),
            "{case}: 邻近目录的标记被清了"
        );
        let entries: Vec<_> = fs::read_dir(&near)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(entries.len(), 2, "{case}: 邻近目录里多了东西：{entries:?}");
    }
    drop(store);
    unlink(&alias);
}

/// r8 P1-01 的反向：Store 自己经设备命名空间（`\\.\`）打开，调用方用普通写法给 alias 下的备份根；换向之后
/// 仍认得出在数据根下，落在钉住的真实位置，FOREIGN 原样。
#[test]
fn a_store_opened_through_the_device_namespace_still_knows_its_root() {
    let b = base("device-store");
    let (real, foreign) = (b.join("real"), b.join("foreign"));
    for p in [&real, &foreign] {
        fs::create_dir_all(p.join("N")).unwrap();
    }
    let alias = b.join("alias");
    junction(&alias, &real);
    let device = PathBuf::from(format!(
        r"\\.\{}",
        alias.join("N").join("atm.sqlite").display()
    ));
    let store = store_with_identity(&device, "ORIGINAL");
    let other = store_with_identity(&foreign.join("N").join("atm.sqlite"), "FOREIGN");
    let kept = foreign_sentinels(&foreign);
    let old = swing(&alias, &foreign);
    let made = create_backup(
        &store,
        &alias.join("N").join("backups"),
        "MANUAL",
        "2026-10-10T12:00:00Z",
    );
    swing_back(&alias, &old);
    let info = made.unwrap();
    for f in &kept {
        assert!(f.exists(), "{} was removed", f.display());
    }
    assert!(
        real.join("N")
            .join("backups")
            .join(&info.id)
            .join(DB_FILE)
            .is_file()
    );
    drop(store);
    drop(other);
    unlink(&alias);
}

/// r9 P1-01：`GLOBALROOT` 一类写法 Windows 打得开、能指向同一个数据根，但不是盘符或 UNC，判断不了在不在数据根
/// 下：在任何创建、清扫之前就拒绝，不当作外部位置放行。换向之后 FOREIGN 的哨兵与标记都在，里面什么也不多；
/// 导出也一样。Store 自己用这种写法打开也拒绝。
#[test]
fn a_globalroot_spelling_is_refused_before_anything_is_written() {
    for (n, prefix) in [
        r"\\?\GLOBALROOT\??\",
        r"\\.\GLOBALROOT\??\",
        r"\\?\GLOBALROOT\GLOBAL??\",
    ]
    .into_iter()
    .enumerate()
    {
        let (_b, real, foreign, alias, store, other) = two_roots(&format!("globalroot-{n}"));
        let spelled = |p: &Path| PathBuf::from(format!("{prefix}{}", p.display()));
        assert_eq!(
            crate::pin::open(&spelled(&alias.join("N"))).unwrap().id(),
            crate::pin::open(&alias.join("N")).unwrap().id(),
            "{prefix}: Windows 打得开，是同一个目录"
        );
        let kept = foreign_sentinels(&foreign);
        let before: Vec<_> = fs::read_dir(foreign.join("N").join("backups"))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        let old = swing(&alias, &foreign);
        let made = create_backup(
            &store,
            &spelled(&alias.join("N").join("backups")),
            "MANUAL",
            "2026-10-10T12:00:00Z",
        );
        let exported = crate::package::export_project(
            &store,
            "PA",
            crate::package::Format::Json,
            &crate::package::ExportOptions {
                exports_dir: &spelled(&alias.join("N").join("exports")),
                at: "2026-10-10T12:00:00Z",
                app_version: "test",
            },
        );
        swing_back(&alias, &old);
        assert!(made.is_err(), "{prefix}: {made:?}");
        assert!(
            exported.is_err(),
            "{prefix}: {:?}",
            exported.map(|e| e.path)
        );
        for f in &kept {
            assert!(f.exists(), "{prefix}: {} was removed", f.display());
        }
        let after: Vec<_> = fs::read_dir(foreign.join("N").join("backups"))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(before, after, "{prefix}");
        assert!(!real.join("N").join("backups").exists(), "{prefix}");
        // Store 自己用这种写法打开：拒绝。
        let opened = Store::open(
            &spelled(&alias.join("N").join("atm.sqlite")),
            Config::default(),
        );
        assert!(opened.is_err(), "{prefix}");
        drop(store);
        drop(other);
        unlink(&alias);
    }
}

/// 换掉本线程的盘符查询（`engine::DOS_DEVICES`、`engine::VOLUME_NAMES`）与读到的本机卷（`engine::LOCAL_VOLUMES`），
/// 离开作用域时还原。造真的 subst、映射盘符要改本机的盘符映射。
#[derive(Default)]
struct Injected;

impl Injected {
    fn devices(self, f: impl Fn(&[u16]) -> Option<Vec<u16>> + 'static) -> Injected {
        crate::engine::DOS_DEVICES.with(|o| *o.borrow_mut() = Some(Box::new(f)));
        self
    }

    fn volume_names(self, f: impl Fn(&[u16]) -> Option<Vec<u16>> + 'static) -> Injected {
        crate::engine::VOLUME_NAMES.with(|o| *o.borrow_mut() = Some(Box::new(f)));
        self
    }

    fn local_volumes(self, v: Result<Vec<u32>, String>) -> Injected {
        crate::engine::LOCAL_VOLUMES.with(|o| *o.borrow_mut() = Some(v));
        self
    }
}

impl Drop for Injected {
    fn drop(&mut self) {
        crate::engine::DOS_DEVICES.with(|o| *o.borrow_mut() = None);
        crate::engine::VOLUME_NAMES.with(|o| *o.borrow_mut() = None);
        crate::engine::LOCAL_VOLUMES.with(|o| *o.borrow_mut() = None);
    }
}

fn wide(t: &str) -> Vec<u16> {
    t.encode_utf16().collect()
}

/// 盘符 `d` 的注入：`map` 里有的用注入的，没有的查本机。
fn lookup(map: &[(String, Vec<u16>)], d: &[u16]) -> Option<Option<Vec<u16>>> {
    let asked = String::from_utf16_lossy(d).to_ascii_uppercase();
    map.iter()
        .find(|(l, _)| *l == asked)
        .map(|(_, t)| (!t.is_empty()).then(|| t.clone()))
}

/// r10 P1-01 / P1-03 / P2-01、r11 P1-01（公开入口）：本线程的盘符查询换成注入的。数据根所在的盘符记作 L，提前换向之后：
/// - `subst G: L:\`（指向卷根）、与 L 同一个卷的另一个盘符 K：经它们写的数据根下的备份根，备份照样落在 ORIGINAL，
///   FOREIGN 的哨兵与标记都在；
/// - 经 G 的 `\\?\` 写法、末尾两个分隔符（Windows 打不开）：拒绝，什么都不写；
/// - 要跟五层 subst 才到 L 的盘符：拒绝，不当作外部位置；
/// - 指向「L 的设备 + 数据根的上级目录」的盘符 D（与数据根是同一个位置，先核对 Windows 经这个设备路径打开的确实是
///   同一个目录；但它不是卷的根）：拒绝，不当作外部位置（r11 P1-01）。
///
/// 拒绝都断言了原因：注入的盘符在本机并不存在，只断言「失败」的话其他原因的失败也会算进来。
#[test]
fn drive_letter_aliases_keep_the_location_or_are_refused() {
    for mode in [
        "volume-root-subst",
        "second-letter",
        "gap-through-subst",
        "too-deep",
        "device-dir",
    ] {
        let (_b, real, foreign, alias, store, other) = two_roots(&format!("letters-{mode}"));
        let kept = foreign_sentinels(&foreign);
        let plain = alias.join("N").join("backups");
        let s = plain.to_string_lossy().into_owned();
        let own = s[..2].to_ascii_uppercase();
        let tail = s[3..].to_owned();
        let real_dev = crate::engine::query_dos_device(&wide(&own)).unwrap();
        let real_volume = crate::engine::query_volume_name(&wide(&own)).unwrap();
        // 注入的盘符不能与 L 相同。
        let mut letters = "GKVUTSHJD".chars().filter(|c| !own.starts_with(*c));
        let mut next = || format!("{}:", letters.next().unwrap());
        let (g, k) = (next(), next());
        let chain: Vec<String> = (0..5).map(|_| next()).collect();
        let d = next();
        let parent = alias.parent().unwrap().to_string_lossy().into_owned();
        let device_dir = format!("{}\\{}", String::from_utf16_lossy(&real_dev), &parent[3..]);
        if mode == "device-dir" {
            let through = format!(r"\\?\GLOBALROOT{device_dir}\alias\N");
            assert_eq!(
                crate::pin::open(Path::new(&through)).unwrap().id(),
                crate::pin::open(&alias.join("N")).unwrap().id(),
                "Windows 经这个设备路径打开的是同一个目录"
            );
        }
        let mut devices: Vec<(String, Vec<u16>)> = vec![
            (g.clone(), wide(&format!(r"\??\{own}\"))),
            (k.clone(), real_dev),
            (d.clone(), wide(&device_dir)),
        ];
        // chain[0] → chain[1] → … → chain[4] → L：五层 subst。
        for w in chain.windows(2) {
            devices.push((w[0].clone(), wide(&format!(r"\??\{}\", w[1]))));
        }
        devices.push((chain[4].clone(), wide(&format!(r"\??\{own}\"))));
        // K 是 L 所在卷的另一个盘符；D 不是卷的根（挂载管理器给不出卷名）。
        let volumes = vec![(k.clone(), real_volume), (d.clone(), Vec::new())];
        let _injected = Injected
            .devices(move |x| {
                lookup(&devices, x).unwrap_or_else(|| crate::engine::query_dos_device(x))
            })
            .volume_names(move |x| {
                lookup(&volumes, x).unwrap_or_else(|| crate::engine::query_volume_name(x))
            });
        let root = PathBuf::from(match mode {
            "volume-root-subst" => format!(r"{g}\{tail}"),
            "second-letter" => format!(r"{k}\{tail}"),
            "gap-through-subst" => format!(r"\\?\{g}\{tail}\\"),
            "device-dir" => format!(r"{d}\alias\N\backups"),
            _ => format!(r"{}\{tail}", chain[0]),
        });
        if mode == "gap-through-subst" {
            fs::create_dir_all(real.join("N").join("backups")).unwrap();
            assert!(
                crate::pin::open(Path::new(&format!(r"\\?\{s}\\"))).is_err(),
                "Windows 打不开末尾两个分隔符的写法"
            );
        }
        let before = fs::read_dir(real.join("N"))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect::<Vec<_>>();
        let old = swing(&alias, &foreign);
        let made = create_backup(&store, &root, "MANUAL", "2026-10-10T12:00:00Z");
        swing_back(&alias, &old);
        for f in &kept {
            assert!(f.exists(), "{mode}: {} was removed", f.display());
        }
        match mode {
            "volume-root-subst" | "second-letter" => {
                let info = made.unwrap_or_else(|e| panic!("{mode}: {e}"));
                assert!(
                    real.join("N")
                        .join("backups")
                        .join(&info.id)
                        .join(DB_FILE)
                        .is_file(),
                    "{mode}"
                );
                assert!(
                    !foreign.join("N").join("backups").join(&info.id).exists(),
                    "{mode}"
                );
            }
            _ => {
                let why = match made {
                    Err(e) => e.to_string(),
                    Ok(i) => panic!("{mode}: made {}", i.id),
                };
                let expected = if mode == "gap-through-subst" {
                    "has an empty segment"
                } else {
                    "is not a drive or UNC path whose location can be compared"
                };
                assert!(why.contains(expected), "{mode}: {why}");
                let after = fs::read_dir(real.join("N"))
                    .unwrap()
                    .map(|e| e.unwrap().file_name())
                    .collect::<Vec<_>>();
                assert_eq!(before, after, "{mode}");
                if real.join("N").join("backups").exists() {
                    assert_eq!(
                        fs::read_dir(real.join("N").join("backups"))
                            .unwrap()
                            .count(),
                        0,
                        "{mode}"
                    );
                }
            }
        }
        drop(store);
        drop(other);
        unlink(&alias);
    }
}

/// 同类通道（r10 之后自查；r11 P1-02）：经本机共享回到本机的写法字面上认不出是数据根，当成外部位置会跟着路径上的
/// 链接走。用例把数据根所在的盘符 L 注入成「映射到本机共享的网络盘符」（`\Device\LanmanRedirector\;L:…\localhost\L$`），
/// 于是同一个路径在位置判定里是 UNC、打开的却是本机的卷。提前换向之后，两种本机卷的读法下都拒绝：
/// - 读到了本机的卷：数据根所在的卷就在里面；
/// - 本机的卷没读全（注入成读不全）：证明不了不在本机。
///
/// 四个入口：`create_backup`、`export_project`（这两个先钉 Store 自己的数据根，那里同样是 L 的写法，也在那里被拒）、
/// 直接钉外部位置（`chain::Pinned::open`，只走外部那一处）、`Store::open`。都拒绝，错误说明是哪一种，FOREIGN 的
/// 哨兵与标记都在，ORIGINAL 什么都没多。
#[test]
fn a_network_path_back_to_this_machine_is_refused() {
    for unreadable in [false, true] {
        for entry in ["backup", "export", "external-pin", "open"] {
            let (_b, real, foreign, alias, store, other) =
                two_roots(&format!("loopback-{entry}-{unreadable}"));
            let kept = foreign_sentinels(&foreign);
            let s = alias.to_string_lossy().into_owned();
            let own = s[..2].to_ascii_uppercase();
            let share = wide(&format!(
                r"\Device\LanmanRedirector\;{own}0000000000012345\localhost\{}$",
                &own[..1]
            ));
            let devices = vec![(own.clone(), share)];
            let mut injected = Injected.devices(move |x| {
                lookup(&devices, x).unwrap_or_else(|| crate::engine::query_dos_device(x))
            });
            if unreadable {
                injected = injected.local_volumes(Err("injected: FindNextVolumeW failed".into()));
            }
            let before = fs::read_dir(real.join("N"))
                .unwrap()
                .map(|e| e.unwrap().file_name())
                .collect::<Vec<_>>();
            let old = swing(&alias, &foreign);
            let why = match entry {
                "backup" => create_backup(
                    &store,
                    &alias.join("N").join("backups"),
                    "MANUAL",
                    "2026-10-10T12:00:00Z",
                )
                .map(|i| i.id)
                .map_err(|e| e.to_string()),
                "export" => crate::package::export_project(
                    &store,
                    "PA",
                    crate::package::Format::Json,
                    &crate::package::ExportOptions {
                        exports_dir: &alias.join("N").join("exports"),
                        at: "2026-10-10T12:00:00Z",
                        app_version: "test",
                    },
                )
                .map(|e| e.path.display().to_string())
                .map_err(|e| e.to_string()),
                "external-pin" => crate::chain::Pinned::open(&alias.join("N"))
                    .map(|_| "pinned".to_owned())
                    .map_err(|e| format!("{e:?}")),
                _ => Store::open(&alias.join("N").join("atm.sqlite"), Config::default())
                    .map(|_| "opened".to_owned())
                    .map_err(|e| e.to_string()),
            };
            swing_back(&alias, &old);
            drop(injected);
            let label = format!("{entry} unreadable={unreadable}");
            let why = why.expect_err(&label);
            let expected = if unreadable {
                "the volumes of this machine could not all be read"
            } else {
                "its volume has the same serial number as a volume of this machine"
            };
            assert!(
                why.contains("cannot be confirmed to be outside this machine")
                    && why.contains(expected),
                "{label}: {why}"
            );
            for f in &kept {
                assert!(f.exists(), "{label}: {} was removed", f.display());
            }
            let after = fs::read_dir(real.join("N"))
                .unwrap()
                .map(|e| e.unwrap().file_name())
                .collect::<Vec<_>>();
            assert_eq!(before, after, "{label}");
            drop(store);
            drop(other);
            unlink(&alias);
        }
    }
}

/// 本机卷的列举认得出数据根所在的卷；不是 UNC 的写法不过这一道。UNC 写法：卷序列号不同就放行，相同、或本机的卷
/// 读不全就拒绝（r11 P1-02、P2-01：拒绝的说明如实写「证明不了不在本机」，不只说「改用盘符」）。
#[test]
fn the_volumes_of_this_machine_are_listed() {
    let b = base("volumes");
    fs::create_dir_all(&b).unwrap();
    let serial = crate::pin::open(&b).unwrap().id().0;
    assert!(
        crate::engine::local_volume_serials()
            .unwrap()
            .contains(&serial)
    );
    assert!(crate::engine::refuse_loopback(&b, serial).is_ok());
    let remote = Path::new(r"\\server\share\N");
    {
        let _i = Injected.local_volumes(Ok(vec![1, 2]));
        assert!(crate::engine::refuse_loopback(remote, 3).is_ok());
        let why = crate::engine::refuse_loopback(remote, 2)
            .unwrap_err()
            .to_string();
        assert!(why.contains("same serial number"), "{why}");
        assert!(why.contains("remote share"), "{why}");
    }
    let _i = Injected.local_volumes(Err("injected".into()));
    let why = crate::engine::refuse_loopback(remote, 3)
        .unwrap_err()
        .to_string();
    assert!(why.contains("could not all be read"), "{why}");
}

mod volume_list {
    //! 本机卷的枚举（`engine::volume_serials_with`）：每一种失败都读不全，只有列完了才算读全。卷名按顺序是
    //! v1、v2、v3：v1 有序列号 11，v2 没插盘（不算），v3 有序列号 33。

    use crate::engine::{VolumeApi, volume_serials_with};
    use std::cell::Cell;

    thread_local! {
        static CLOSED: Cell<u32> = const { Cell::new(0) };
    }

    fn put(name: &mut [u16], s: &str) {
        let w: Vec<u16> = s.encode_utf16().chain([0]).collect();
        name[..w.len()].copy_from_slice(&w);
    }

    fn read(name: &[u16]) -> String {
        let end = name.iter().position(|u| *u == 0).unwrap();
        String::from_utf16_lossy(&name[..end])
    }

    fn first(name: &mut [u16]) -> Result<isize, u32> {
        put(name, "v1");
        Ok(7)
    }

    fn next(_: isize, name: &mut [u16]) -> Result<bool, u32> {
        match read(name).as_str() {
            "v1" => put(name, "v2"),
            "v2" => put(name, "v3"),
            _ => return Ok(false),
        }
        Ok(true)
    }

    fn serial(name: &[u16]) -> Result<Option<u32>, u32> {
        Ok(match read(name).as_str() {
            "v1" => Some(11),
            "v2" => None,
            _ => Some(33),
        })
    }

    fn close(find: isize) {
        assert_eq!(find, 7);
        CLOSED.with(|c| c.set(c.get() + 1));
    }

    const OK: VolumeApi = VolumeApi {
        first,
        next,
        serial,
        close,
    };

    #[test]
    fn every_failure_leaves_the_list_unread() {
        assert_eq!(volume_serials_with(&OK), Ok(vec![11, 33]));
        let cases: [(&str, VolumeApi); 3] = [
            (
                "FindFirstVolumeW",
                VolumeApi {
                    first: |_| Err(5),
                    ..OK
                },
            ),
            (
                "FindNextVolumeW",
                VolumeApi {
                    next: |_, name| match read(name).as_str() {
                        "v1" => {
                            put(name, "v2");
                            Ok(true)
                        }
                        _ => Err(5),
                    },
                    ..OK
                },
            ),
            (
                "GetVolumeInformationW",
                VolumeApi {
                    serial: |name| match read(name).as_str() {
                        "v3" => Err(5),
                        _ => Ok(Some(11)),
                    },
                    ..OK
                },
            ),
        ];
        for (step, api) in cases {
            let got = volume_serials_with(&api);
            let why = got.expect_err(step);
            assert!(why.contains(step) && why.contains("error 5"), "{why}");
        }
        // 开始就失败的没有句柄要关；其余每次都关一次。
        assert_eq!(CLOSED.with(|c| c.get()), 3);
    }
}
