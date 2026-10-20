//! 托盘与通知的观察器归入口管（W5f）：入口开放后起，撤下入口时先停；回调随它一起释放。

mod support;

use std::sync::mpsc::{RecvTimeoutError, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use atm_domain::principal::{Principal, UiSurface};
use atm_runtime::{Background, Observation, Started, TrayCounts};
use support::*;

#[test]
fn the_entries_run_the_observer_and_stop_it_on_withdrawal() {
    let d = dir("notify");
    let n = d.join("N");
    let events = Events::default();
    let (tx, rx) = channel();
    let tx = Mutex::new(tx);
    let mut opts = options(&n, &d.join("L-missing"), &events);
    opts.notify = Some(Arc::new(move |o| {
        let _ = tx.lock().unwrap().send(o);
    }));
    let Started::Serving(s) = atm_runtime::start(&opts).unwrap() else {
        panic!("conflict")
    };
    drop(opts);
    assert_eq!(
        s.background(Duration::from_secs(60)),
        Some(Background::Unchanged)
    );
    let wait = || rx.recv_timeout(Duration::from_secs(20));
    assert_eq!(
        wait().unwrap(),
        Observation::Tray(TrayCounts {
            blocked: 0,
            waiting: 0,
            mode: "ALL"
        })
    );

    // 托盘（或窗口）改了通知方式：观察器被这次写入叫醒，推来新的勾选。
    let (svc, _) = s.service().unwrap();
    svc.set_notification_mode(
        &Principal::trusted_ui(UiSurface::Tray),
        "CRITICAL",
        None,
        "mode-1",
    )
    .unwrap();
    drop(svc);
    assert_eq!(
        wait().unwrap(),
        Observation::Tray(TrayCounts {
            blocked: 0,
            waiting: 0,
            mode: "CRITICAL"
        })
    );

    // 撤下入口：观察器停下，回调随之释放（不是等满兜底周期）。
    s.stop(&|_| {});
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(20)),
        Err(RecvTimeoutError::Disconnected)
    );
}
