//! peer W6 r4 的反例（P1-01、P1-02）：守卫拿到之后，才把上层链接换向，或者把当时不存在的层建成链接；
//! 之后清扫、备份、恢复读到的、删掉的都还必须在原来的数据根里。外面那份一个字节都不能变。
//! peer W6 r5 P1-01：把换向提前到 Store 打开之后、守卫取得之前，走公开的备份与导出入口，结论一样。

use std::fs;
use std::path::{Path, PathBuf};

use crate::backup::{
    BackupsRoot, attachments_lock, create_backup, create_backup_locked, side_reader,
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
