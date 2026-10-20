//! 托盘计数与系统通知的观察器（W5f；2.0 `desktop-observer.ts`、`notification-policy.ts`）。
//!
//! 事件走真实的服务写入（建任务、受阻、等待、完成）；`agent.recovered_stale` 与 `backup.failed` 直接追加到
//! 事件流（它们的产生方各有自己的用例），观察器读到的是同一条 global_feed。

#[path = "../../service/tests/support/mod.rs"]
mod support;

use std::sync::Arc;
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::time::{Duration, Instant};

use atm_domain::work::Operation;
use atm_jobs::notify::{Notice, Notifier, Observation, Observer, TrayCounts, should_notify};
use atm_service::work::Target;
use atm_service::write::Service;
use atm_store::events::{NewEvent, append_event, append_global};
use support::*;

const T: u64 = 1_800_000_000_000;
const MINUTE: u64 = 60_000;

fn notices(observations: &[Observation]) -> Vec<Notice> {
    observations
        .iter()
        .filter_map(|o| match o {
            Observation::Notice(n) => Some(n.clone()),
            _ => None,
        })
        .collect()
}

fn titles(observations: &[Observation]) -> Vec<String> {
    notices(observations).into_iter().map(|n| n.title).collect()
}

fn trays(observations: &[Observation]) -> Vec<TrayCounts> {
    observations
        .iter()
        .filter_map(|o| match o {
            Observation::Tray(t) => Some(t.clone()),
            _ => None,
        })
        .collect()
}

fn recovered_stale(svc: &Service, session: &str) {
    let session = session.to_owned();
    svc.store()
        .write(move |tx| {
            append_event(
                tx,
                &NewEvent {
                    project_id: "PA",
                    kind: "agent.recovered_stale",
                    actor_type: "SYSTEM",
                    actor_id: "SYSTEM",
                    session_id: Some(&session),
                    aggregate_type: "agent_session",
                    aggregate_id: &session,
                    correlation_id: None,
                    op_id: None,
                    payload_json: r#"{"agentId":"claude","closeReason":"HEARTBEAT_TIMEOUT"}"#,
                    at: T0,
                },
            )
            .map(|_| ())
        })
        .unwrap();
}

fn backup_failed(svc: &Service, id: &str) {
    let id = id.to_owned();
    svc.store()
        .write(move |tx| {
            append_global(
                tx,
                "backup.failed",
                &id,
                "SYSTEM",
                r#"{"scope":"GLOBAL","reason":"SCHEDULED","code":"DISK_FULL"}"#,
                None,
                T0,
            )
            .map(|_| ())
        })
        .unwrap();
}

/// 走一遍会产生全部四种项目通知事件的流程，返回任务 key。
fn every_project_event(w: &World) -> String {
    let k = w.task("要通知的");
    w.s1(p(&k, Operation::Start)).unwrap();
    w.s1(block(&k, "缺权限")).unwrap();
    w.s1(p(&k, Operation::Start)).unwrap();
    w.s1(p(&k, Operation::Verify)).unwrap();
    w.s1(wait(&k, Operation::WaitUser, "等用户看截图")).unwrap();
    w.s1(p(&k, Operation::Start)).unwrap();
    w.s1(p(&k, Operation::Complete)).unwrap();
    recovered_stale(&w.svc, "SX");
    k
}

#[test]
fn the_policy_is_the_2_0_policy() {
    let kinds = [
        "work.waiting",
        "work.blocked",
        "work.completed",
        "agent.recovered_stale",
        "backup.failed",
        "work.created",
        "record.created",
    ];
    let expect =
        |mode: &str| -> Vec<bool> { kinds.iter().map(|k| should_notify(mode, k)).collect() };
    assert_eq!(expect("ALL"), [true, true, true, true, true, false, false]);
    assert_eq!(
        expect("CRITICAL"),
        [false, true, false, true, true, false, false]
    );
    assert_eq!(expect("OFF"), [false; 7]);
}

#[test]
fn the_first_round_pushes_the_tray_and_does_not_replay_history() {
    let w = world("notify-first");
    let old = w.task("启动前");
    w.s1(block(&old, "早就受阻")).unwrap();
    backup_failed(&w.svc, "B-OLD");

    let mut observer = Observer::new();
    let first = observer.step(&w.svc, T).observations;
    assert_eq!(
        first,
        [Observation::Tray(TrayCounts {
            blocked: 1,
            waiting: 0,
            mode: "ALL"
        })]
    );
    // 什么都没变：托盘不再推，也没有通知。
    assert!(observer.step(&w.svc, T + 1).observations.is_empty());
}

#[test]
fn all_mode_sends_the_five_kinds_with_the_2_0_titles() {
    let w = world("notify-all");
    let mut observer = Observer::new();
    observer.step(&w.svc, T);
    let k = every_project_event(&w);
    backup_failed(&w.svc, "B-1");

    let round = observer.step(&w.svc, T + MINUTE).observations;
    assert_eq!(
        titles(&round),
        [
            "ATM · 任务受阻",
            "ATM · 任务正在等待",
            "ATM · 任务已完成",
            "ATM · Agent 异常退出",
            "备份失败",
        ]
    );
    let bodies: Vec<String> = notices(&round).into_iter().map(|n| n.body).collect();
    for body in &bodies[..3] {
        assert!(body.contains(&k), "{body}");
    }
    assert!(!bodies[3].is_empty());
    // 全局事件的说明是它的呈现（2.0 `event.summary`）。
    assert_eq!(bodies[4], "GLOBAL 备份（SCHEDULED）：DISK_FULL");
    // 计数回到 0/0，与第一轮一样：托盘不推。
    assert!(trays(&round).is_empty());
}

#[test]
fn critical_mode_sends_only_the_critical_kinds_and_off_sends_nothing() {
    let w = world("notify-critical");
    let mut observer = Observer::new();
    observer.step(&w.svc, T);
    w.svc
        .set_notification_mode(&user(), "CRITICAL", None, "mode-1")
        .unwrap();
    every_project_event(&w);
    backup_failed(&w.svc, "B-1");
    let round = observer.step(&w.svc, T + MINUTE).observations;
    assert_eq!(
        titles(&round),
        ["ATM · 任务受阻", "ATM · Agent 异常退出", "备份失败"]
    );
    // 方式变了：托盘的勾选跟着变。
    assert_eq!(
        trays(&round),
        [TrayCounts {
            blocked: 0,
            waiting: 0,
            mode: "CRITICAL"
        }]
    );

    w.svc
        .set_notification_mode(&user(), "OFF", None, "mode-2")
        .unwrap();
    every_project_event(&w);
    backup_failed(&w.svc, "B-2");
    let round = observer.step(&w.svc, T + 2 * MINUTE).observations;
    assert!(notices(&round).is_empty(), "{round:?}");
    assert_eq!(trays(&round)[0].mode, "OFF");
}

#[test]
fn the_same_task_is_notified_once_per_ten_minutes() {
    let w = world("notify-dedup");
    let mut observer = Observer::new();
    observer.step(&w.svc, T);
    let k = w.task("反复受阻");
    let other = w.task("另一个");
    w.s1(p(&k, Operation::Start)).unwrap();
    w.s1(block(&k, "第一次")).unwrap();
    assert_eq!(
        titles(&observer.step(&w.svc, T).observations),
        ["ATM · 任务受阻"]
    );

    // 9 分钟后又受阻：同一项目、同一种事件、同一个 key，不发。另一个任务照发。
    w.s1(p(&k, Operation::Start)).unwrap();
    w.s1(block(&k, "第二次")).unwrap();
    w.s1(p(&other, Operation::Start)).unwrap();
    w.s1(block(&other, "它也卡住")).unwrap();
    let round = observer.step(&w.svc, T + 9 * MINUTE).observations;
    let bodies: Vec<String> = notices(&round).into_iter().map(|n| n.body).collect();
    assert_eq!(bodies.len(), 1, "{bodies:?}");
    assert!(bodies[0].contains(&other));

    // 满 10 分钟：再发。
    w.s1(p(&k, Operation::Start)).unwrap();
    w.s1(block(&k, "第三次")).unwrap();
    let round = observer.step(&w.svc, T + 10 * MINUTE).observations;
    assert_eq!(titles(&round), ["ATM · 任务受阻"]);
    assert!(notices(&round)[0].body.contains(&k));
}

#[test]
fn a_backup_failure_is_notified_once_per_key() {
    let w = world("notify-backup");
    let mut observer = Observer::new();
    observer.step(&w.svc, T);
    backup_failed(&w.svc, "B-1");
    backup_failed(&w.svc, "B-1");
    backup_failed(&w.svc, "B-2");
    assert_eq!(
        titles(&observer.step(&w.svc, T).observations),
        ["备份失败", "备份失败"]
    );
}

#[test]
fn projects_that_are_not_active_stay_silent_but_still_count() {
    let w = world("notify-archived");
    let mut observer = Observer::new();
    observer.step(&w.svc, T);
    let k = w.task("归档项目里的");
    w.s1(p(&k, Operation::Start)).unwrap();
    w.s1(block(&k, "卡住")).unwrap();
    w.exec("UPDATE projects SET lifecycle = 'ARCHIVED' WHERE id = 'PA'");
    let round = observer.step(&w.svc, T + MINUTE).observations;
    assert!(notices(&round).is_empty(), "{round:?}");
    assert_eq!(trays(&round)[0].blocked, 1);
}

fn next(rx: &Receiver<Observation>) -> Observation {
    rx.recv_timeout(Duration::from_secs(20))
        .expect("the observer said nothing")
}

/// 在另一条线程上停下，限时等它返回：停不下来时用例按时变红，而不是挂满兜底周期。
fn stop_within(notifier: Notifier, limit: Duration) -> Duration {
    let (done, finished) = channel();
    let started = Instant::now();
    std::thread::spawn(move || {
        notifier.stop();
        let _ = done.send(());
    });
    finished
        .recv_timeout(limit)
        .expect("the notifier did not stop in time");
    started.elapsed()
}

#[test]
fn the_notifier_wakes_on_writes_and_stops_promptly() {
    let World { svc, .. } = world("notify-thread");
    let svc = Arc::new(svc);
    let (tx, rx) = channel();
    let tx = std::sync::Mutex::new(tx);
    // 兜底周期 1 小时：下面每一步都在几秒内发生，靠的只能是写入唤醒。
    let notifier = Notifier::start(
        svc.clone(),
        Arc::new(move |o| {
            let _ = tx.lock().unwrap().send(o);
        }),
        Duration::from_secs(3600),
    );
    assert_eq!(
        next(&rx),
        Observation::Tray(TrayCounts {
            blocked: 0,
            waiting: 0,
            mode: "ALL"
        })
    );

    let op = std::sync::atomic::AtomicU32::new(0);
    let target = || {
        let n = op.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Target::new("PA", Some("S1"), format!("thread-{n}"))
    };
    let created = svc
        .create_work_items(&agent(), &target(), vec![item("线程里的")])
        .unwrap();
    let k = created.result["items"][0]["key"]
        .as_str()
        .unwrap()
        .to_owned();
    svc.patch_work_items(&agent(), &target(), vec![p(&k, Operation::Start)])
        .unwrap();
    let started = Instant::now();
    svc.patch_work_items(&agent(), &target(), vec![block(&k, "线程里卡住")])
        .unwrap();
    let mut seen = Vec::new();
    while !seen.iter().any(|o| matches!(o, Observation::Notice(_))) {
        seen.push(next(&rx));
    }
    assert!(started.elapsed() < Duration::from_secs(20));
    assert_eq!(titles(&seen), ["ATM · 任务受阻"]);
    // 计数变了，托盘跟着推（通知在前，托盘在后）。
    let tray = next(&rx);
    assert_eq!(
        tray,
        Observation::Tray(TrayCounts {
            blocked: 1,
            waiting: 0,
            mode: "ALL"
        })
    );

    // 停下：在兜底周期里等着的线程立刻返回；回调随线程一起释放，之后的写入不再有回调。
    stop_within(notifier, Duration::from_secs(10));
    svc.patch_work_items(&agent(), &target(), vec![p(&k, Operation::Start)])
        .unwrap();
    assert_eq!(
        rx.recv_timeout(Duration::from_millis(500)),
        Err(RecvTimeoutError::Disconnected)
    );
}

#[test]
fn the_notifier_ends_when_the_store_shuts_down() {
    let World { svc, .. } = world("notify-shutdown");
    let svc = Arc::new(svc);
    let (tx, rx) = channel();
    let tx = std::sync::Mutex::new(tx);
    let notifier = Notifier::start(
        svc.clone(),
        Arc::new(move |o| {
            let _ = tx.lock().unwrap().send(o);
        }),
        Duration::from_secs(3600),
    );
    next(&rx);
    // 存储关闭：线程自己结束（不靠 stop 的叫醒），回调随之释放。
    svc.store().shutdown();
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(10)),
        Err(RecvTimeoutError::Disconnected)
    );
    stop_within(notifier, Duration::from_secs(10));
}

#[test]
fn a_long_backlog_is_read_over_several_rounds_without_losing_any() {
    let w = world("notify-backlog");
    let mut observer = Observer::new();
    observer.step(&w.svc, T);
    // 一轮最多 20 页 × 100 条；多出来的 100 条下一轮接着读。
    w.svc
        .store()
        .write(|tx| {
            for n in 0..2100 {
                append_global(
                    tx,
                    "backup.failed",
                    &format!("B-{n}"),
                    "SYSTEM",
                    "{}",
                    None,
                    T0,
                )?;
            }
            Ok::<_, atm_store::events::EventError>(())
        })
        .unwrap();
    let first = observer.step(&w.svc, T);
    assert!(first.more);
    assert_eq!(notices(&first.observations).len(), 2000);
    let second = observer.step(&w.svc, T);
    assert!(!second.more);
    assert_eq!(notices(&second.observations).len(), 100);
    assert!(observer.step(&w.svc, T).observations.is_empty());
}
