//! 保存视图与设置的验收（W2g2；04 L-016、L-017；03 C-06、C-L10）。

mod support;

use atm_domain::error::ErrorCode;
use atm_service::settings::BackupPolicy;
use atm_service::views::{SavedViewCreate, SavedViewUpdate};
use serde_json::json;
use support::*;

fn global(name: &str) -> SavedViewCreate {
    SavedViewCreate {
        scope: "GLOBAL".into(),
        name: name.into(),
        ..SavedViewCreate::default()
    }
}

fn rename(version: Option<i64>, name: &str) -> SavedViewUpdate {
    SavedViewUpdate {
        expected_version: version,
        name: Some(name.into()),
        ..SavedViewUpdate::default()
    }
}

// ---------- L-016 ----------

/// L-016 ✓：新建（v0）→ 改名（v1）→ 带 v1 删除；事件 actor 为 USER，回执在 GLOBAL。
#[test]
fn l016_saved_view_lifecycle() {
    let w = world("sv-l016");
    let r = w
        .svc
        .create_saved_view(
            &user(),
            SavedViewCreate {
                query: Some(json!({ "status": ["READY"] })),
                ..global("  我的 ")
            },
            "v-1",
        )
        .unwrap();
    let v = &r.result["view"];
    assert_eq!(v["name"], "我的");
    assert_eq!(v["version"], 0);
    assert_eq!(v["query"], json!({ "status": ["READY"] }));
    assert_eq!(v["sort"], json!({}));
    assert!(v["projectId"].is_null());
    let id = v["id"].as_str().unwrap().to_owned();
    assert_eq!(
        w.scalar(&format!(
            "SELECT scope_kind FROM idempotency_receipts WHERE receipt_id = {}",
            r.receipt_id
        )),
        "GLOBAL"
    );
    let renamed = w
        .svc
        .update_saved_view(&user(), &id, rename(Some(0), "改名"), "v-2")
        .unwrap();
    assert_eq!(renamed.result["view"]["version"], 1);
    assert_eq!(renamed.result["view"]["name"], "改名");
    assert_eq!(
        renamed.result["view"]["query"],
        json!({ "status": ["READY"] })
    );
    w.refused(ErrorCode::VERSION_CONFLICT, || {
        w.svc.delete_saved_view(&user(), &id, Some(0), "v-3")
    });
    let gone = w
        .svc
        .delete_saved_view(&user(), &id, Some(1), "v-4")
        .unwrap();
    assert_eq!(gone.result, json!({ "ok": 1, "id": id }));
    assert_eq!(w.count("SELECT count(*) FROM saved_views"), 0);
    assert!(
        w.svc
            .delete_saved_view(&user(), &id, Some(1), "v-4")
            .unwrap()
            .replayed
    );
    let kinds = w.scalar(
        "SELECT group_concat(type || ':' || actor, ',') FROM (SELECT type, actor FROM global_feed WHERE type LIKE 'saved_view.%' ORDER BY global_seq)",
    );
    assert_eq!(
        kinds,
        "saved_view.created:USER,saved_view.updated:USER,saved_view.deleted:USER"
    );
}

/// L-016 ✗：空白名字、scope FOO、PROJECT 不带项目、缺 expected_version、不存在、Agent 调用。
#[test]
fn l016_refusals() {
    let w = world("sv-l016-x");
    w.refused(ErrorCode::SAVED_VIEW_NAME_REQUIRED, || {
        w.svc.create_saved_view(&user(), global("  "), "a")
    });
    let e = w.refused(ErrorCode::VALIDATION_ERROR, || {
        w.svc.create_saved_view(
            &user(),
            SavedViewCreate {
                scope: "FOO".into(),
                ..global("x")
            },
            "b",
        )
    });
    assert_eq!(e.details["field"], "scope");
    w.refused(ErrorCode::PROJECT_REQUIRED, || {
        w.svc.create_saved_view(
            &user(),
            SavedViewCreate {
                scope: "PROJECT".into(),
                ..global("x")
            },
            "c",
        )
    });
    w.refused(ErrorCode::PROJECT_NOT_FOUND, || {
        w.svc.create_saved_view(
            &user(),
            SavedViewCreate {
                scope: "PROJECT".into(),
                project: Some("NOPE".into()),
                ..global("x")
            },
            "d",
        )
    });
    w.refused(ErrorCode::VALIDATION_ERROR, || {
        w.svc.create_saved_view(
            &user(),
            SavedViewCreate {
                sort: Some(json!([1])),
                ..global("x")
            },
            "e",
        )
    });
    w.refused(ErrorCode::USER_AUTHORIZATION_REQUIRED, || {
        w.svc.create_saved_view(&agent(), global("x"), "f")
    });
    let id = w
        .svc
        .create_saved_view(
            &user(),
            SavedViewCreate {
                scope: "PROJECT".into(),
                project: Some("atm".into()),
                ..global("项目的")
            },
            "g",
        )
        .unwrap()
        .result["view"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let e = w.refused(ErrorCode::VALIDATION_ERROR, || {
        w.svc
            .update_saved_view(&user(), &id, rename(None, "y"), "h")
    });
    assert_eq!(e.details["field"], "expected_version");
    w.refused(ErrorCode::VALIDATION_ERROR, || {
        w.svc.delete_saved_view(&user(), &id, None, "i")
    });
    w.refused(ErrorCode::SAVED_VIEW_NAME_REQUIRED, || {
        w.svc
            .update_saved_view(&user(), &id, rename(Some(0), " "), "j")
    });
    w.refused(ErrorCode::NOT_FOUND, || {
        w.svc
            .update_saved_view(&user(), "NOPE", rename(Some(0), "z"), "k")
    });
    w.refused(ErrorCode::USER_AUTHORIZATION_REQUIRED, || {
        w.svc.delete_saved_view(&agent(), &id, Some(0), "l")
    });
    // 列表：带项目只列这个项目的，带上 projectCode。
    w.svc
        .create_saved_view(&user(), global("全局的"), "m")
        .unwrap();
    let all = w.svc.list_saved_views(&user(), None).unwrap();
    assert_eq!(all["views"].as_array().unwrap().len(), 2);
    let mine = w.svc.list_saved_views(&user(), Some("ATM")).unwrap();
    let mine = mine["views"].as_array().unwrap();
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0]["projectCode"], "ATM");
    assert_eq!(
        w.svc.list_saved_views(&agent(), None).unwrap_err().code,
        ErrorCode::USER_AUTHORIZATION_REQUIRED
    );
}

// ---------- L-017 ----------

/// L-017 ✓：白名单 key 按 schema 写入；版本规则保持 2.x（-1、CAS、last-write-wins）。
#[test]
fn l017_whitelisted_settings() {
    let w = world("st-l017");
    let missing = w.svc.get_setting(&user(), "projects.order").unwrap();
    assert_eq!(missing["version"], -1);
    assert!(missing["value"].is_null());
    w.refused(ErrorCode::VERSION_CONFLICT, || {
        w.svc.set_setting(
            &user(),
            "projects.order",
            json!({ "ids": ["PA"] }),
            Some(0),
            "s0",
        )
    });
    let first = w
        .svc
        .set_setting(
            &user(),
            "projects.order",
            json!({ "ids": ["PA", "PE"] }),
            Some(-1),
            "s1",
        )
        .unwrap();
    assert_eq!(first.result["setting"]["version"], 0);
    let lww = w
        .svc
        .set_setting(&user(), "projects.order", json!({ "ids": [] }), None, "s2")
        .unwrap();
    assert_eq!(lww.result["setting"]["version"], 1);
    let e = w.refused(ErrorCode::VERSION_CONFLICT, || {
        w.svc.set_setting(
            &user(),
            "projects.order",
            json!({ "ids": ["PE"] }),
            Some(0),
            "s3",
        )
    });
    assert_eq!(e.details["actual"], 1);
    w.svc
        .set_setting(
            &user(),
            "projects.order",
            json!({ "ids": ["PE"] }),
            Some(1),
            "s4",
        )
        .unwrap();
    for ok in [1, 1440] {
        w.svc
            .set_setting(
                &user(),
                "recovery.sessionTimeoutMinutes",
                json!(ok),
                None,
                &format!("t{ok}"),
            )
            .unwrap();
    }
    assert_eq!(
        w.svc
            .get_setting(&user(), "recovery.sessionTimeoutMinutes")
            .unwrap()["value"],
        1440
    );
    let list = w.svc.list_settings(&user()).unwrap();
    let keys: Vec<&str> = list["settings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["key"].as_str().unwrap())
        .collect();
    assert_eq!(keys, ["projects.order", "recovery.sessionTimeoutMinutes"]);
    assert_eq!(
        w.count("SELECT count(*) FROM global_feed WHERE type = 'setting.updated' AND actor = 'USER' AND payload_json = '{}'"),
        5
    );
    assert_eq!(
        w.svc
            .get_setting(&agent(), "projects.order")
            .unwrap_err()
            .code,
        ErrorCode::USER_AUTHORIZATION_REQUIRED
    );
}

/// L-017 ✗：key 形状、白名单外、带语义的 key 指向专用入口、各 key 的 schema、Agent 调用。
#[test]
fn l017_refusals() {
    let w = world("st-l017-x");
    for bad in ["Projects.order", ".x", "a b", ""] {
        let e = w.refused(ErrorCode::SETTING_KEY_INVALID, || {
            w.svc.set_setting(&user(), bad, json!(1), None, "k")
        });
        assert!(e.details.get("reason").is_none(), "{bad}: {e:?}");
    }
    let e = w.refused(ErrorCode::SETTING_KEY_INVALID, || {
        w.svc
            .set_setting(&user(), "ui.theme", json!("dark"), None, "k")
    });
    assert_eq!(e.details["reason"], "NOT_WRITABLE");
    for (key, use_instead) in [
        ("mcp.memory-profile-enabled", "agents.profile_switch"),
        ("notification.mode", "notification.mode_set"),
        ("notification.enabled", "notification.mode_set"),
        ("backup.policy", "backup.policy_set"),
    ] {
        let e = w.refused(ErrorCode::SETTING_KEY_INVALID, || {
            w.svc.set_setting(&user(), key, json!(true), None, "k")
        });
        assert_eq!(e.details["reason"], "DEDICATED_CAPABILITY", "{key}");
        assert_eq!(e.details["use"], use_instead, "{key}");
    }
    for value in [
        json!(["PA"]),
        json!({ "ids": "PA" }),
        json!({ "ids": ["PA", 1] }),
        json!({ "ids": [""] }),
        json!({ "ids": [], "extra": 1 }),
    ] {
        w.refused(ErrorCode::VALIDATION_ERROR, || {
            w.svc
                .set_setting(&user(), "projects.order", value, None, "v")
        });
    }
    for value in [json!(0), json!(1441), json!(1.5), json!("5"), json!(null)] {
        w.refused(ErrorCode::VALIDATION_ERROR, || {
            w.svc
                .set_setting(&user(), "recovery.sessionTimeoutMinutes", value, None, "v")
        });
    }
    w.refused(ErrorCode::USER_AUTHORIZATION_REQUIRED, || {
        w.svc
            .set_setting(&agent(), "projects.order", json!({ "ids": [] }), None, "a")
    });
}

/// C-06：通知方式与备份策略走专用入口，各自校验。
#[test]
fn c06_dedicated_settings() {
    let w = world("st-c06");
    let r = w
        .svc
        .set_notification_mode(&user(), "CRITICAL", Some(-1), "n1")
        .unwrap();
    assert_eq!(r.result["setting"]["value"], "CRITICAL");
    assert_eq!(r.result["setting"]["version"], 0);
    for bad in ["critical", "NONE", ""] {
        w.refused(ErrorCode::NOTIFICATION_MODE_INVALID, || {
            w.svc.set_notification_mode(&user(), bad, None, "n2")
        });
    }
    w.refused(ErrorCode::VERSION_CONFLICT, || {
        w.svc.set_notification_mode(&user(), "OFF", Some(5), "n3")
    });
    w.refused(ErrorCode::USER_AUTHORIZATION_REQUIRED, || {
        w.svc.set_notification_mode(&agent(), "OFF", None, "n4")
    });

    let policy = BackupPolicy {
        enabled: false,
        daily_keep: 90,
        weekly_keep: 52,
        other_keep: 20,
    };
    let r = w
        .svc
        .set_backup_policy(&user(), policy, None, "b1")
        .unwrap();
    assert_eq!(
        r.result["setting"]["value"],
        json!({ "enabled": false, "dailyKeep": 90, "weeklyKeep": 52, "otherKeep": 20 })
    );
    assert_eq!(
        w.svc
            .set_backup_policy(&user(), BackupPolicy::default(), Some(0), "b2")
            .unwrap()
            .result["setting"]["value"]["dailyKeep"],
        2
    );
    for (bad, field) in [
        (
            BackupPolicy {
                daily_keep: 0,
                ..policy
            },
            "daily_keep",
        ),
        (
            BackupPolicy {
                daily_keep: 91,
                ..policy
            },
            "daily_keep",
        ),
        (
            BackupPolicy {
                weekly_keep: 53,
                ..policy
            },
            "weekly_keep",
        ),
        (
            BackupPolicy {
                weekly_keep: 0,
                ..policy
            },
            "weekly_keep",
        ),
        (
            BackupPolicy {
                other_keep: 21,
                ..policy
            },
            "other_keep",
        ),
        (
            BackupPolicy {
                other_keep: 0,
                ..policy
            },
            "other_keep",
        ),
    ] {
        let e = w.refused(ErrorCode::VALIDATION_ERROR, || {
            w.svc.set_backup_policy(&user(), bad, None, "b3")
        });
        assert_eq!(e.details["field"], field);
    }
    w.refused(ErrorCode::USER_AUTHORIZATION_REQUIRED, || {
        w.svc.set_backup_policy(&agent(), policy, None, "b4")
    });
}
