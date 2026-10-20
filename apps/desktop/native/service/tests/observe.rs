//! 托盘与通知观察器的读（W5f；06 §2 桌面观察器，03 §2.4 notify.observe）。
//!
//! 3.0 只追一条全局流：项目事件在同一个写事务里镜像进 global_feed，带着项目代码与生命周期读出来；
//! 托盘计数与通知方式在同一个读事务里。

mod support;

use atm_domain::error::ErrorCode;
use atm_domain::principal::{JobId, Principal};
use atm_domain::work::Operation;
use atm_service::observe::{FeedProject, OBSERVE_MAX};
use support::*;

fn observer() -> Principal {
    Principal::system_job(JobId::NotifyObserve)
}

#[test]
fn observe_starts_at_the_tail_and_follows_project_events_with_counts() {
    let w = world("observe-flow");
    let before = w.task("早就有的");
    w.s1(block(&before, "启动前就受阻")).unwrap();

    // 第一次（since = None）：不读事件，从当前末尾开始；计数照实给出。
    let start = w.svc.observe(&observer(), None, OBSERVE_MAX).unwrap();
    assert!(start.events.is_empty());
    assert_eq!(
        start.next_seq,
        w.count("SELECT max(global_seq) FROM global_feed")
    );
    assert_eq!((start.blocked, start.waiting, start.mode), (1, 0, "ALL"));

    let k = w.task("要通知的");
    w.s1(p(&k, Operation::Start)).unwrap();
    w.s1(block(&k, "缺权限")).unwrap();
    w.s1(p(&k, Operation::Start)).unwrap();
    w.s1(p(&k, Operation::Verify)).unwrap();
    w.s1(wait(&k, Operation::WaitUser, "等用户看截图")).unwrap();

    let seen = w
        .svc
        .observe(&observer(), Some(start.next_seq), OBSERVE_MAX)
        .unwrap();
    let kinds: Vec<&str> = seen.events.iter().map(|e| e.kind.as_str()).collect();
    assert_eq!(
        kinds,
        [
            "work.created",
            "work.started",
            "work.blocked",
            "work.started",
            "work.verification_requested",
            "work.waiting"
        ]
    );
    assert!(seen.events.windows(2).all(|p| p[0].seq < p[1].seq));
    assert_eq!(seen.next_seq, seen.events.last().unwrap().seq);
    assert!(!seen.has_more);
    let blocked = &seen.events[2];
    assert_eq!(blocked.key.as_deref(), Some(k.as_str()));
    assert_eq!(
        blocked.project,
        Some(FeedProject {
            code: "ATM".into(),
            active: true
        })
    );
    assert!(blocked.summary.contains(&k), "{}", blocked.summary);
    // 呈现与 2.x event-presentation 相同：等待的说明不进摘要。
    assert_eq!(seen.events[5].summary, format!("{k}「要通知的」 进入等待"));
    // 早就受阻的还在，新任务现在在等用户。
    assert_eq!((seen.blocked, seen.waiting), (1, 1));

    // 读到末尾之后再读：没有新事件，next_seq 不动。
    let again = w
        .svc
        .observe(&observer(), Some(seen.next_seq), OBSERVE_MAX)
        .unwrap();
    assert!(again.events.is_empty());
    assert_eq!(again.next_seq, seen.next_seq);

    w.s1(p(&k, Operation::Start)).unwrap();
    w.s1(p(&k, Operation::Complete)).unwrap();
    let done = w
        .svc
        .observe(&observer(), Some(seen.next_seq), OBSERVE_MAX)
        .unwrap();
    assert_eq!(
        done.events
            .iter()
            .map(|e| e.kind.as_str())
            .collect::<Vec<_>>(),
        ["work.started", "work.completed"]
    );
    assert_eq!((done.blocked, done.waiting), (1, 0));
}

#[test]
fn archived_and_trashed_projects_are_marked_and_trashed_ones_leave_the_counts() {
    let w = world("observe-lifecycle");
    let start = w
        .svc
        .observe(&observer(), None, OBSERVE_MAX)
        .unwrap()
        .next_seq;
    let k = w.task("A");
    w.s1(block(&k, "卡住")).unwrap();
    w.exec("UPDATE projects SET lifecycle = 'ARCHIVED' WHERE id = 'PA'");
    let seen = w
        .svc
        .observe(&observer(), Some(start), OBSERVE_MAX)
        .unwrap();
    assert!(seen.events.iter().all(|e| e.project
        == Some(FeedProject {
            code: "ATM".into(),
            active: false
        })));
    // 总览列出归档项目，计数照算；进了回收站就不算（与总览同一口径）。
    assert_eq!(seen.blocked, 1);
    w.exec("UPDATE projects SET lifecycle = 'TRASHED' WHERE id = 'PA'");
    assert_eq!(
        w.svc.observe(&observer(), Some(start), 1).unwrap().blocked,
        0
    );
}

#[test]
fn pages_are_bounded_and_resume_after_the_last_seq() {
    let w = world("observe-pages");
    let start = w
        .svc
        .observe(&observer(), None, OBSERVE_MAX)
        .unwrap()
        .next_seq;
    for n in 0..5 {
        w.task(&format!("任务 {n}"));
    }
    let first = w.svc.observe(&observer(), Some(start), 2).unwrap();
    assert_eq!(first.events.len(), 2);
    assert!(first.has_more);
    let second = w.svc.observe(&observer(), Some(first.next_seq), 2).unwrap();
    assert_eq!(second.events.len(), 2);
    assert!(second.has_more);
    let third = w
        .svc
        .observe(&observer(), Some(second.next_seq), 2)
        .unwrap();
    assert_eq!(third.events.len(), 1);
    assert!(!third.has_more);
    let all: Vec<i64> = [first.events, second.events, third.events]
        .concat()
        .iter()
        .map(|e| e.seq)
        .collect();
    let mut sorted = all.clone();
    sorted.dedup();
    assert_eq!(all.len(), 5);
    assert_eq!(sorted, all);
    // limit 夹到 1～OBSERVE_MAX。
    assert_eq!(
        w.svc
            .observe(&observer(), Some(start), 0)
            .unwrap()
            .events
            .len(),
        1
    );
}

#[test]
fn the_mode_is_read_with_the_counts_and_an_invalid_stored_mode_reads_as_all() {
    let w = world("observe-mode");
    assert_eq!(w.svc.observe(&observer(), None, 1).unwrap().mode, "ALL");
    w.svc
        .set_notification_mode(&user(), "CRITICAL", None, "mode-1")
        .unwrap();
    assert_eq!(
        w.svc.observe(&observer(), None, 1).unwrap().mode,
        "CRITICAL"
    );
    w.svc
        .set_notification_mode(&user(), "OFF", None, "mode-2")
        .unwrap();
    assert_eq!(w.svc.observe(&observer(), None, 1).unwrap().mode, "OFF");
    // 库里留着不合法的值（手改、旧数据）：按 ALL，与 2.0 的 normalizeNotificationMode 一样。
    w.exec("UPDATE settings SET value_json = '\"LOUD\"' WHERE key = 'notification.mode'");
    assert_eq!(w.svc.observe(&observer(), None, 1).unwrap().mode, "ALL");
    w.exec("UPDATE settings SET value_json = 'not json' WHERE key = 'notification.mode'");
    assert_eq!(w.svc.observe(&observer(), None, 1).unwrap().mode, "ALL");
}

#[test]
fn only_principals_that_may_read_events_and_settings_can_observe() {
    let w = world("observe-perm");
    // Agent 能读事件，不能读设置（settings.read 的 A 是 –，只有 User 能读）。
    let e = w.svc.observe(&agent(), None, 1).unwrap_err();
    assert_eq!(e.code, ErrorCode::USER_AUTHORIZATION_REQUIRED);
    // 其他 job 没有 events.read。
    let e = w
        .svc
        .observe(&Principal::system_job(JobId::Maintenance), None, 1)
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::PRINCIPAL_CAPABILITY_DENIED);
    // 观察器自己不能改通知方式：那只能由 User（窗口、托盘）改（03 §3 notification.mode_set）。
    let e = w
        .svc
        .set_notification_mode(&observer(), "OFF", None, "mode-x")
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::PRINCIPAL_CAPABILITY_DENIED);
    assert!(w.svc.observe(&user(), None, 1).is_ok());
}
