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
