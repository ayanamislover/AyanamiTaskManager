//! job `maintenance`（W5h；03 §2.4、P-005、P-009、U11；2.x `backup-maintenance.ts`、`backup-retention.ts`）。
//!
//! 备份走真实的存储层（整库在线备份 + manifest），修剪走存储层的撤回；目录与登记逐份对照。

#[path = "../../service/tests/support/mod.rs"]
mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use atm_domain::error::ErrorCode;
use atm_domain::principal::{JobId, Principal};
use atm_domain::time::Timestamp;
use atm_jobs::maintenance::{Maintenance, run_once};
use atm_jobs::notify::{Notice, Observation, Observer};
use atm_service::backups::RestoreScope;
use atm_service::project::Transition;
use atm_service::settings::BackupPolicy;
use serde_json::Value;
use support::*;

const DAY: i64 = 24 * 60 * 60 * 1000;

fn day(n: i64) -> Timestamp {
    Timestamp::from_millis(
        Timestamp::parse("2027-01-15T10:00:00.000Z")
            .unwrap()
            .millis()
            + n * DAY,
    )
}

/// (kind, created_at) 最新的在前。
fn rows(w: &World) -> Vec<(String, String)> {
    w.svc
        .store()
        .read(|tx| {
            tx.prepare("SELECT kind, created_at FROM backups ORDER BY created_at DESC, id DESC")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()
        })
        .unwrap()
}

fn kinds(w: &World, kind: &str) -> Vec<String> {
    rows(w)
        .into_iter()
        .filter(|(k, _)| k == kind)
        .map(|(_, at)| at)
        .collect()
}

/// 目录与登记一致：备份根下（隔离区与创建区除外）的目录正好是登记里的那些。
fn assert_dirs_match(w: &World) {
    let mut on_disk: Vec<String> = std::fs::read_dir(w.dir.join("backups"))
        .map(|d| {
            d.map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .filter(|n| !n.starts_with('.'))
                .collect()
        })
        .unwrap_or_default();
    on_disk.sort();
    let mut registered: Vec<String> = w
        .svc
        .store()
        .read(|tx| {
            tx.prepare("SELECT path FROM backups")?
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap()
        .into_iter()
        .map(|p| {
            std::path::Path::new(&p)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    registered.sort();
    assert_eq!(on_disk, registered);
}

fn set_policy(w: &World, enabled: bool, daily: i64, weekly: i64, other: i64) {
    let policy = BackupPolicy {
        enabled,
        daily_keep: daily,
        weekly_keep: weekly,
        other_keep: other,
    };
    w.svc
        .set_backup_policy(&user(), policy, None, &w.next_op())
        .unwrap();
}

/// 直接改存着的值（模拟 2.x 留下的、不经校验的行）。
fn store_policy(w: &World, value: &str) {
    w.exec(&format!(
        "INSERT INTO settings (key, value_json, version, updated_at) VALUES ('backup.policy', '{value}', 1, '{T0}')
         ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json"
    ));
}

fn maintenance() -> Principal {
    Principal::system_job(JobId::Maintenance)
}

/// P-009 成功例：当天没有 DAILY 才做，最近的 WEEKLY 满 7 天才做；每种按策略留最新的几份（默认 2）。
#[test]
fn daily_and_weekly_backups_are_made_when_due_and_pruned_by_policy() {
    let w = world("maint-due");
    let first = run_once(&w.svc, day(0)).unwrap();
    assert_eq!(
        (first.daily_created, first.weekly_created),
        (1, 1),
        "{first:?}"
    );
    assert!(first.errors.is_empty(), "{first:?}");
    // 同一天（UTC 日期）再跑：什么都不做。
    let again = run_once(&w.svc, Timestamp::from_millis(day(0).millis() + 3_600_000)).unwrap();
    assert_eq!(
        (again.daily_created, again.weekly_created, again.pruned),
        (0, 0, 0)
    );

    for n in 1..=6 {
        let r = run_once(&w.svc, day(n)).unwrap();
        assert_eq!(
            (r.daily_created, r.weekly_created),
            (1, 0),
            "day {n}: {r:?}"
        );
    }
    // 7 天 DAILY 只留最新的 2 份；WEEKLY 还只有第一份。
    assert_eq!(kinds(&w, "DAILY"), [day(6).to_string(), day(5).to_string()]);
    assert_eq!(kinds(&w, "WEEKLY"), [day(0).to_string()]);
    // 满 7 天做第二份 WEEKLY；第 14、21 天再各一份，第三份出现时最旧的那份被修剪。
    for n in [7, 14, 21] {
        let r = run_once(&w.svc, day(n)).unwrap();
        assert_eq!(r.weekly_created, 1, "day {n}: {r:?}");
    }
    assert_eq!(
        kinds(&w, "WEEKLY"),
        [day(21).to_string(), day(14).to_string()]
    );
    assert_dirs_match(&w);

    // 调小保留数，下一轮就收敛（U04 的语义副作用）。
    set_policy(&w, true, 1, 1, 1);
    let r = run_once(&w.svc, day(22)).unwrap();
    assert_eq!((r.daily_created, r.pruned), (1, 3), "{r:?}");
    assert_eq!(kinds(&w, "DAILY"), [day(22).to_string()]);
    assert_eq!(kinds(&w, "WEEKLY"), [day(21).to_string()]);
    assert_dirs_match(&w);

    // 存着的值按 2.x 的读法：取整后夹到 1～上限，缺了或不是数用默认（2），enabled 只有 false 才关。
    store_policy(
        &w,
        r#"{"enabled":"no","dailyKeep":2.9,"weeklyKeep":-4,"otherKeep":"x"}"#,
    );
    for n in 23..=25 {
        run_once(&w.svc, day(n)).unwrap();
    }
    assert_eq!(kinds(&w, "DAILY").len(), 2);
    assert_eq!(kinds(&w, "WEEKLY").len(), 1);
    // 上限 90：留 57 份不受影响（超过 WEEKLY 的上限 52，各项的上限没有串）。
    store_policy(&w, r#"{"dailyKeep":1e9}"#);
    for n in 26..=80 {
        run_once(&w.svc, day(n)).unwrap();
    }
    assert_eq!(kinds(&w, "DAILY").len(), 57);
    // WEEKLY 用自己的保留数（缺了是默认 2），不跟着 dailyKeep 走。
    assert_eq!(kinds(&w, "WEEKLY").len(), 2);
    store_policy(&w, r#"{"dailyKeep":3,"weeklyKeep":53}"#);
    run_once(&w.svc, day(30)).unwrap();
    assert_eq!(kinds(&w, "DAILY").len(), 3);
}

/// 2.x 原样转换来的保留数是字符串、布尔、空串、数组时，读出来的数和 2.x 的 `Number(value ?? fallback)` 一样
/// （peer W5 r1 P1-01）：`"20"` 留 20 份而不是退回默认 2 份；`""` 与 `false` 是 0，夹到 1；`null` 用默认。
#[test]
fn legacy_policy_values_are_read_like_2_x() {
    let w = world("mt-legacy-values");
    store_policy(&w, r#"{"otherKeep":"20"}"#);
    for _ in 0..4 {
        w.svc.create_manual_backup(&user()).unwrap();
    }
    assert_dirs_match(&w);
    assert_eq!(kinds(&w, "MANUAL").len(), 4);
    store_policy(&w, r#"{"otherKeep":" 3.9 "}"#);
    w.svc.create_manual_backup(&user()).unwrap();
    assert_dirs_match(&w);
    assert_eq!(kinds(&w, "MANUAL").len(), 3);
    store_policy(&w, r#"{"otherKeep":["2"]}"#);
    w.svc.create_manual_backup(&user()).unwrap();
    assert_eq!(kinds(&w, "MANUAL").len(), 2);
    store_policy(&w, r#"{"otherKeep":null}"#);
    w.svc.create_manual_backup(&user()).unwrap();
    assert_eq!(kinds(&w, "MANUAL").len(), 2);
    store_policy(&w, r#"{"otherKeep":""}"#);
    w.svc.create_manual_backup(&user()).unwrap();
    assert_dirs_match(&w);
    assert_eq!(kinds(&w, "MANUAL").len(), 1);
    store_policy(&w, r#"{"otherKeep":true}"#);
    w.svc.create_manual_backup(&user()).unwrap();
    assert_eq!(kinds(&w, "MANUAL").len(), 1);
}

/// 修剪跳过固定还没到期的、被恢复引用着的（A4）；固定已经到期的照常修剪。
#[test]
fn retention_skips_live_pins_and_restore_references() {
    let w = world("maint-pins");
    for n in 0..2 {
        run_once(&w.svc, day(n)).unwrap();
    }
    let daily = |w: &World| -> Vec<(String, String)> {
        w.svc
            .store()
            .read(|tx| {
                tx.prepare(
                    "SELECT id, created_at FROM backups WHERE kind = 'DAILY' ORDER BY created_at",
                )?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()
            })
            .unwrap()
    };
    let oldest = daily(&w)[0].0.clone();
    atm_store::backup::pin(w.svc.store(), &oldest, &day(30).to_string()).unwrap();
    let r = run_once(&w.svc, day(2)).unwrap();
    assert_eq!((r.pruned, r.kept), (0, 1), "{r:?}");
    assert_eq!(daily(&w).len(), 3);
    // 留下的原因在撤回诊断里（固定挡在前面，不是删行那一步才发现）。
    let recent = w.svc.list_backups(&user(), 1).unwrap()["withdrawals"]["recent"].clone();
    assert_eq!(
        recent.as_array().unwrap().last().unwrap()["reason"],
        "PINNED",
        "{recent}"
    );

    // 第二旧的被一次恢复引用着。
    let second = daily(&w)[1].0.clone();
    w.exec(&format!(
        "UPDATE scope_generations SET backup_id = '{second}' WHERE gen = 1"
    ));
    let r = run_once(&w.svc, day(3)).unwrap();
    assert_eq!((r.pruned, r.kept), (0, 2), "{r:?}");
    let ids: Vec<String> = daily(&w).into_iter().map(|(id, _)| id).collect();
    assert_eq!(ids.len(), 4);
    assert!(ids.contains(&oldest) && ids.contains(&second));

    // 固定到期之后，下一轮把它修剪掉；恢复引用的照留。
    w.exec(&format!(
        "UPDATE backups SET pinned_until = '{}' WHERE id = '{oldest}'",
        day(3)
    ));
    let r = run_once(&w.svc, day(4)).unwrap();
    assert_eq!((r.pruned, r.kept), (2, 1), "{r:?}");
    let ids: Vec<String> = daily(&w).into_iter().map(|(id, _)| id).collect();
    assert!(!ids.contains(&oldest), "{ids:?}");
    assert!(ids.contains(&second), "{ids:?}");
    assert_dirs_match(&w);
}

/// `backup.policy.enabled = false`：整轮跳过，连修剪也不做（2.x 一样）。
#[test]
fn a_disabled_policy_skips_the_round() {
    let w = world("maint-disabled");
    run_once(&w.svc, day(0)).unwrap();
    for _ in 0..3 {
        w.svc.create_manual_backup(&user()).unwrap();
    }
    set_policy(&w, false, 1, 1, 1);
    let before = rows(&w);
    let r = run_once(&w.svc, day(1)).unwrap();
    assert!(r.skipped, "{r:?}");
    assert_eq!(rows(&w), before);
}

/// P-009 反例：maintenance 不能恢复、不能动项目生命周期、不能做手动备份，被拒且零副作用；
/// 其他主体（User、Agent、别的 job）也不能跑维护。
#[test]
fn maintenance_cannot_make_user_decisions() {
    let w = world("maint-p009");
    let id = w.svc.create_manual_backup(&user()).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let m = maintenance();
    let (db, files) = (w.snapshot(), rows(&w));
    let denied = |e: atm_domain::error::DomainError| {
        assert_eq!(e.code, ErrorCode::PRINCIPAL_CAPABILITY_DENIED, "{e:?}");
    };
    denied(
        w.svc
            .restore_scope(&m, &id, RestoreScope::Project("ATM".into()))
            .unwrap_err(),
    );
    denied(
        w.svc
            .restore_scope(&m, &id, RestoreScope::Knowledge)
            .unwrap_err(),
    );
    denied(
        w.svc
            .set_lifecycle(&m, "EMP", Transition::Trash, "op-m")
            .unwrap_err(),
    );
    denied(w.svc.create_manual_backup(&m).unwrap_err());
    assert_eq!((w.snapshot(), rows(&w)), (db, files));

    for p in [
        user(),
        agent(),
        Principal::system_job(JobId::UpdateCheck),
        Principal::system_job(JobId::MetricsCapture),
    ] {
        let before = rows(&w);
        let e = w.svc.run_maintenance(&p, day(0)).unwrap_err();
        assert!(
            matches!(
                e.code,
                ErrorCode::PRINCIPAL_CAPABILITY_DENIED | ErrorCode::USER_AUTHORIZATION_REQUIRED
            ),
            "{p:?}: {e:?}"
        );
        assert_eq!(rows(&w), before);
    }
}

/// P-005 / U11：手动备份做完按 MANUAL 修剪；PRE_ARCHIVE（生命周期迁移前）同样按原因修剪。
#[test]
fn every_new_backup_prunes_its_own_kind() {
    let w = world("maint-after");
    let mut made = Vec::new();
    for _ in 0..4 {
        made.push(w.svc.create_manual_backup(&user()).unwrap()["id"].clone());
    }
    let manual: Vec<Value> = w.svc.list_backups(&user(), 50).unwrap()["backups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["id"].clone())
        .collect();
    assert_eq!(manual, [made[3].clone(), made[2].clone()]);
    for _ in 0..3 {
        w.svc
            .set_lifecycle(&user(), "EMP", Transition::Archive, &w.next_op())
            .unwrap();
        w.svc
            .set_lifecycle(&user(), "EMP", Transition::Unarchive, &w.next_op())
            .unwrap();
    }
    assert_eq!(kinds(&w, "PRE_ARCHIVE").len(), 2);
    // 调成 1：下一份手动备份之后只剩它自己。
    set_policy(&w, true, 2, 2, 1);
    let last = w.svc.create_manual_backup(&user()).unwrap();
    assert_eq!(kinds(&w, "MANUAL").len(), 1);
    // 只修剪刚做的那一种：PRE_ARCHIVE 等它自己下一份（或下一轮维护）。
    assert_eq!(kinds(&w, "PRE_ARCHIVE").len(), 2);
    assert_eq!(
        w.svc.list_backups(&user(), 1).unwrap()["backups"][0]["id"],
        last["id"]
    );
    assert_dirs_match(&w);
}

/// 做备份失败：一条全局 `backup.failed`，托盘的观察器据此发「备份失败」。
#[test]
fn a_failed_backup_is_reported_and_notified() {
    let dir = test_root().join("maint-failed-root");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    // 备份根是一个文件：目录建不起来。
    let blocked = dir.join("backups");
    std::fs::write(&blocked, b"not a directory").unwrap();
    let w = world_full("maint-failed", None, Some(blocked));
    let mut observer = Observer::new();
    observer.step(&w.svc, 1_800_000_000_000);

    let r = run_once(&w.svc, day(0)).unwrap();
    assert_eq!((r.daily_created, r.weekly_created), (0, 0));
    assert_eq!(r.errors.len(), 2, "{r:?}");
    let payloads: Vec<Value> = w
        .svc
        .store()
        .read(|tx| {
            tx.prepare("SELECT payload_json FROM global_feed WHERE type = 'backup.failed' ORDER BY global_seq")?
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap()
        .into_iter()
        .map(|p| serde_json::from_str(&p).unwrap())
        .collect();
    assert_eq!(payloads.len(), 2);
    assert_eq!(payloads[0]["scope"], "DATABASE");
    assert_eq!(payloads[0]["reason"], "DAILY");
    assert_eq!(payloads[1]["reason"], "WEEKLY");
    assert!(payloads[0]["code"].is_string());

    let round = observer.step(&w.svc, 1_800_000_060_000).observations;
    let notices: Vec<Notice> = round
        .into_iter()
        .filter_map(|o| match o {
            Observation::Notice(n) => Some(n),
            _ => None,
        })
        .collect();
    assert_eq!(notices.len(), 2, "{notices:?}");
    assert_eq!(notices[0].title, "备份失败");
    assert!(
        notices[0].body.starts_with("DATABASE 备份（DAILY）："),
        "{}",
        notices[0].body
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// 线程：过 `first` 跑第一轮；停下立刻返回，停在第一轮之前就什么都不做。
#[test]
fn the_thread_runs_after_the_delay_and_stops() {
    let w = world("maint-thread");
    let svc = Arc::new(w.svc);
    let early = Maintenance::start(
        svc.clone(),
        Duration::from_secs(60),
        Duration::from_secs(3600),
    );
    std::thread::sleep(Duration::from_secs(1));
    let t = Instant::now();
    early.stop();
    assert!(t.elapsed() < Duration::from_secs(5));
    let count = |svc: &atm_service::write::Service| -> i64 {
        svc.store()
            .read(|tx| tx.query_row("SELECT count(*) FROM backups", [], |r| r.get(0)))
            .unwrap()
    };
    assert_eq!(count(&svc), 0);

    let running = Maintenance::start(
        svc.clone(),
        Duration::from_millis(50),
        Duration::from_secs(3600),
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    while count(&svc) < 2 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(count(&svc), 2, "the first round makes a DAILY and a WEEKLY");
    let t = Instant::now();
    running.stop();
    assert!(t.elapsed() < Duration::from_secs(5));
}
