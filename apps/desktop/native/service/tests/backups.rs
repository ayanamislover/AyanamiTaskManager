//! 备份入口与记录预览的验收（peer W2 r1 P1-05；03 backup.list / backup.create_manual / backup.restore_scope /
//! knowledge.preview_record 与 §5.3 的拒绝；方案 §4；10 R4、R5）。

mod support;

use atm_domain::error::{DomainError, ErrorCode};
use atm_service::backups::{RESTORE_PIN_DAYS, RestoreScope};
use atm_service::memory::RecordRequest;
use serde_json::Value;
use support::*;

fn backup_dirs(w: &World) -> usize {
    std::fs::read_dir(w.dir.join("backups")).map_or(0, |d| d.count())
}

/// 应当被拒绝的调用：错误码对、整库与备份目录都零变化。
fn refused(
    w: &World,
    code: ErrorCode,
    call: impl FnOnce() -> Result<Value, DomainError>,
) -> DomainError {
    let (db, files) = (w.snapshot(), backup_dirs(w));
    let e = call().expect_err("expected an error");
    assert_eq!(e.code, code, "{e:?}");
    assert_eq!((w.snapshot(), backup_dirs(w)), (db, files));
    e
}

/// backup.list：User 与 Agent 都能读，最新的在前；backup.create_manual 只有 User，Agent 零副作用。
#[test]
fn backups_are_listed_and_made_by_the_user() {
    let w = world("bk-manual");
    assert_eq!(
        w.svc.list_backups(&agent(), 50).unwrap()["backups"],
        serde_json::json!([])
    );
    refused(&w, ErrorCode::USER_AUTHORIZATION_REQUIRED, || {
        w.svc.create_manual_backup(&agent())
    });
    // 04 C-L06：垃圾箱里的项目照样在备份里（单库的手动备份是整库）。
    w.exec("UPDATE projects SET lifecycle = 'TRASHED' WHERE id = 'PE'");
    let a = w.svc.create_manual_backup(&user()).unwrap();
    let manifest: Value = serde_json::from_str(
        &std::fs::read_to_string(
            std::path::Path::new(a["path"].as_str().unwrap()).join("manifest.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert!(
        manifest["projects"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == "PE" && p["lifecycle"] == "TRASHED"),
        "{manifest}"
    );
    let b = w.svc.create_manual_backup(&user()).unwrap();
    assert_eq!(a["kind"], "MANUAL");
    assert_eq!(backup_dirs(&w), 2);
    let list = w.svc.list_backups(&agent(), 50).unwrap();
    let ids: Vec<&Value> = list["backups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| &r["id"])
        .collect();
    assert_eq!(ids, vec![&b["id"], &a["id"]]);
    assert_eq!(
        w.svc.list_backups(&user(), 1).unwrap()["backups"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

/// backup.restore_scope：只有 User。项目恢复到备份时的样子（之后新建的任务没了），选中的备份固定
/// RESTORE_PIN_DAYS 天，先做 PRE_RESTORE；编号不回退（R5）。反例都零变化。
#[test]
fn restore_scope_is_user_only_and_restores_one_project() {
    let w = world("bk-restore");
    w.task("备份前");
    let backup = w.svc.create_manual_backup(&user()).unwrap();
    let id = backup["id"].as_str().unwrap().to_owned();
    w.task("备份后");
    refused(&w, ErrorCode::USER_AUTHORIZATION_REQUIRED, || {
        w.svc
            .restore_scope(&agent(), &id, RestoreScope::Project("ATM".into()))
    });
    refused(&w, ErrorCode::INVALID_ARGUMENT, || {
        w.svc
            .restore_scope(&user(), " ", RestoreScope::Project("ATM".into()))
    });
    refused(&w, ErrorCode::BACKUP_NOT_FOUND, || {
        w.svc
            .restore_scope(&user(), "NOPE", RestoreScope::Project("ATM".into()))
    });
    refused(&w, ErrorCode::PROJECT_NOT_FOUND, || {
        w.svc
            .restore_scope(&user(), &id, RestoreScope::Project("NOPE".into()))
    });
    // 备份里没有知识库（合成库从没写过知识）。
    // 校验已经做过（verified_at 更新），但不固定备份、不做 PRE_RESTORE、不动任何业务数据。
    let (files, rows) = (backup_dirs(&w), w.count("SELECT count(*) FROM backups"));
    let e = w
        .svc
        .restore_scope(&user(), &id, RestoreScope::Knowledge)
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::BACKUP_RESTORE_SCOPE_UNSUPPORTED, "{e:?}");
    assert_eq!(
        (backup_dirs(&w), w.count("SELECT count(*) FROM backups")),
        (files, rows)
    );
    assert_eq!(
        w.scalar(&format!(
            "SELECT pinned_until FROM backups WHERE id = '{id}'"
        )),
        Value::Null
    );

    let r = w
        .svc
        .restore_scope(&user(), &id, RestoreScope::Project("ATM".into()))
        .unwrap();
    assert_eq!(r["scope"]["projectId"], "PA");
    assert_eq!(
        w.count("SELECT count(*) FROM work_items WHERE project_id = 'PA'"),
        1
    );
    let pre = r["preRestoreBackupId"].as_str().unwrap();
    assert_eq!(
        w.scalar(&format!("SELECT kind FROM backups WHERE id = '{pre}'")),
        "PRE_RESTORE"
    );
    let pinned = w.scalar(&format!(
        "SELECT pinned_until FROM backups WHERE id = '{id}'"
    ));
    assert_eq!(pinned, r["pinnedUntil"]);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let until = atm_domain::time::Timestamp::parse(pinned.as_str().unwrap())
        .unwrap()
        .millis();
    assert_eq!((until - now + 60_000) / 86_400_000, RESTORE_PIN_DAYS);
    // R5：编号不回退。
    let next = w.task("恢复后");
    assert_eq!(next, "ATM-T-0003");
}

/// knowledge.preview_record：只有 User；返回草稿与固定版本的来源，只读。
#[test]
fn records_preview_as_knowledge() {
    let w = world("bk-preview");
    let r = w
        .svc
        .create_record(
            &agent(),
            &w.target(Some("S1")),
            RecordRequest {
                detail: "正文".into(),
                ..RecordRequest::new("DECISION", "用单库", "摘要")
            },
        )
        .unwrap();
    let key = r.result["record"]["key"].as_str().unwrap().to_owned();
    let e = w.svc.preview_record(&agent(), "ATM", &key).unwrap_err();
    assert_eq!(e.code, ErrorCode::USER_AUTHORIZATION_REQUIRED);
    let before = w.snapshot();
    let v = w.svc.preview_record(&user(), "ATM", &key).unwrap();
    assert_eq!(w.snapshot(), before);
    assert_eq!(v["title"], "用单库");
    assert_eq!(v["bodyMarkdown"], "正文");
    assert_eq!(v["sourceRef"]["type"], "project_record");
    assert_eq!(v["sourceRef"]["reference"], key);
    assert_eq!(v["sourceRef"]["projectId"], "PA");
    assert_eq!(v["sourceRef"]["sourceVersion"], 0);
    let e = w
        .svc
        .preview_record(&user(), "ATM", "ATM-D-0099")
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::RECORD_NOT_FOUND);
}

/// 同一个库、换一套存储配置的第二个 Service（备份根相同）。
fn sibling(w: &World, config: atm_store::Config) -> atm_service::write::Service {
    let store = atm_store::Store::open(&w.dir.join("atm.sqlite"), config).unwrap();
    atm_service::write::Service::new(store).with_backups_root(w.dir.join("backups"))
}

/// peer W2 r2 P2-01：存储失败按类别给错误码，不一律报可重试的 STORE_BUSY。
/// 写准入超时 → STORE_BUSY + committed:false；读连接占满 → STORE_BUSY；存储关闭 → SERVICE_UNAVAILABLE；
/// 执行了又失败（超预算）→ INTERNAL_ERROR。失败的备份不在备份根下留没登记的目录。
#[test]
fn backup_store_failures_keep_their_kind() {
    use std::sync::mpsc::channel;
    use std::time::Duration;
    let w = world("backup-store-failures");
    let id = w.svc.create_manual_backup(&user()).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let project = || RestoreScope::Project("ATM".into());
    let rows = || w.count("SELECT count(*) FROM backups") as usize;

    // 执行失败：写预算为零，校验登记那一笔写超预算回滚。
    let other = sibling(
        &w,
        atm_store::Config {
            write_budget: Duration::ZERO,
            ..Default::default()
        },
    );
    let e = other.restore_scope(&user(), &id, project()).unwrap_err();
    assert_eq!(e.code, ErrorCode::INTERNAL_ERROR, "{e:?}");
    assert_eq!(e.details.get("committed"), None);
    drop(other);

    // 写准入超时：一个作业占着写线程、一个排满队列，第三笔等不到位置。
    let other = sibling(
        &w,
        atm_store::Config {
            queue_capacity: 1,
            admit_wait: Duration::from_millis(100),
            ..Default::default()
        },
    );
    let (started_tx, started_rx) = channel();
    let (gate_tx, gate_rx) = channel::<()>();
    let a = other
        .store()
        .submit(move |_| {
            started_tx.send(()).unwrap();
            let _ = gate_rx.recv_timeout(Duration::from_secs(10));
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let b = other
        .store()
        .submit(|_| Ok::<_, rusqlite::Error>(()))
        .unwrap();
    let e = other.restore_scope(&user(), &id, project()).unwrap_err();
    let made = other.create_manual_backup(&user()).unwrap_err();
    gate_tx.send(()).unwrap();
    a.wait().unwrap();
    b.wait().unwrap();
    assert_eq!(e.code, ErrorCode::STORE_BUSY, "{e:?}");
    assert_eq!(e.details["committed"], false);
    assert_eq!(made.code, ErrorCode::STORE_BUSY, "{made:?}");
    assert_eq!(
        backup_dirs(&w),
        rows(),
        "a failed backup left an unregistered directory"
    );
    drop(other);

    // 读连接占满。
    let other = sibling(
        &w,
        atm_store::Config {
            readers: 1,
            read_wait: Duration::from_millis(100),
            ..Default::default()
        },
    );
    let e = std::thread::scope(|s| {
        let (held_tx, held_rx) = channel();
        let (gate_tx, gate_rx) = channel::<()>();
        let store = other.store();
        s.spawn(move || {
            store
                .read(|_| {
                    held_tx.send(()).unwrap();
                    let _ = gate_rx.recv_timeout(Duration::from_secs(10));
                    Ok::<_, rusqlite::Error>(())
                })
                .unwrap();
        });
        held_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        // 知识库范围不经服务层的项目解析，第一次读就在存储层的备份校验里。
        let e = other
            .restore_scope(&user(), &id, RestoreScope::Knowledge)
            .unwrap_err();
        gate_tx.send(()).unwrap();
        e
    });
    assert_eq!(e.code, ErrorCode::STORE_BUSY, "{e:?}");
    assert!(e.message.starts_with("store: read"), "{e:?}");
    assert_eq!(e.details.get("committed"), None);

    // 存储已关闭。
    other.store().shutdown();
    let e = other.create_manual_backup(&user()).unwrap_err();
    assert_eq!(e.code, ErrorCode::SERVICE_UNAVAILABLE, "{e:?}");
    drop(other);
    assert_eq!(
        backup_dirs(&w),
        rows(),
        "a failed backup left an unregistered directory"
    );
}

/// 对照：库已恢复、附件没换入，不是「没提交」——INTERNAL_ERROR 带实际的世代，不带 committed:false。
#[test]
fn restore_with_attachments_pending_reports_the_committed_generation() {
    use atm_store::restore::{SwapStep, finish_attachment_swaps, inject_swap_fault};
    let w = world("backup-restore-pending");
    w.task("before");
    let backup = w.svc.create_manual_backup(&user()).unwrap();
    w.task("after");
    inject_swap_fault(w.svc.store().path(), SwapStep::MoveStagedIn);
    let e = w
        .svc
        .restore_scope(
            &user(),
            backup["id"].as_str().unwrap(),
            RestoreScope::Project("ATM".into()),
        )
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::INTERNAL_ERROR);
    assert_eq!(
        e.details["attachments_pending_generation"],
        w.scalar("SELECT scope_gen FROM projects WHERE id = 'PA'")
    );
    assert_eq!(e.details.get("committed"), None);
    assert_eq!(
        w.count("SELECT count(*) FROM work_items WHERE project_id = 'PA'"),
        1
    );
    finish_attachment_swaps(w.svc.store()).unwrap();
}
