//! 进程内的启动顺序（W4i，07 §2–§7，W3 peer r1 P2-02）：入口只在判定放行之后按 lease → HTTP → daemon.json →
//! 调度器的顺序开放；源身份不符、`A=legacy` 时先阻塞比较；冲突时入口一个都不开，只写启动状态；
//! 后台比较发现冲突时先撤下入口，再写启动状态。

mod support;

use std::time::Duration;

use atm_runtime::{Background, Event, Started};
use atm_store::conversion::{self as cv, AuthorityState, Layout};
use serde_json::Value;
use support::*;

const ENTRIES: [Event; 4] = [
    Event::Lease,
    Event::Http,
    Event::Descriptor,
    Event::Scheduler,
];

fn serving(started: Started) -> atm_runtime::Serving {
    match started {
        Started::Serving(s) => s,
        Started::Conflict(c) => panic!("conflict: {}", c.state.reason),
    }
}

fn descriptor(n: &std::path::Path) -> Option<Value> {
    std::fs::read(n.join("runtime/daemon.json"))
        .ok()
        .map(|b| serde_json::from_slice(&b).unwrap())
}

fn authority(n: &std::path::Path) -> cv::Authority {
    match cv::read_authority(&Layout::new(n)) {
        AuthorityState::Present(a) => a,
        other => panic!("{other:?}"),
    }
}

/// S1：没有 `L`，建空库后开放入口，顺序固定；`/health` 与 daemon.json、lease 对得上；没有启动状态。
#[test]
fn a_fresh_install_opens_the_entries_in_order() {
    let d = dir("fresh");
    let n = d.join("N");
    let events = Events::default();
    let s = serving(atm_runtime::start(&options(&n, &d.join("L-missing"), &events)).unwrap());
    assert_eq!(
        s.background(Duration::from_secs(60)),
        Some(Background::Unchanged)
    );
    let seen = events.take();
    assert_eq!(
        seen,
        [
            vec![Event::Admitted, Event::Published],
            ENTRIES.to_vec(),
            vec![Event::BackgroundCompare],
        ]
        .concat()
    );
    let published = descriptor(&n).unwrap();
    assert_eq!(published["layout"], "single");
    assert_eq!(published["pid"], std::process::id());
    assert_eq!(
        published["endpoint"],
        format!("http://127.0.0.1:{}", s.port())
    );
    assert_eq!(published["instanceId"], s.instance_id());
    assert_eq!(published["generation"], s.lease_generation());
    assert_eq!(published["token"].as_str().unwrap().len(), 64);
    let (status, body) = get(s.port(), "/health").unwrap();
    assert_eq!(status, 200, "{body}");
    let health: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(health["instanceId"], s.instance_id());
    assert_eq!(health["generation"], s.lease_generation());
    // 没有令牌的业务请求照样被挡。
    assert_eq!(get(s.port(), "/api/v1/projects").unwrap().0, 401);
    assert!(!n.join("runtime/startup-state.json").exists());
    let lease: Value =
        serde_json::from_slice(&std::fs::read(n.join("runtime/daemon.lock")).unwrap()).unwrap();
    assert_eq!(lease["nonce"], s.instance_id());
    assert_eq!(lease["layout"], "single");

    let port = s.port();
    s.stop(&*events.observer());
    assert_eq!(events.take(), [Event::Withdrawn]);
    assert!(descriptor(&n).is_none(), "the descriptor is withdrawn");
    assert!(get(port, "/health").is_none(), "nothing listens any more");

    // 第二次启动：lease 序号加一。
    let again = serving(atm_runtime::start(&options(&n, &d.join("L-missing"), &events)).unwrap());
    assert_eq!(again.lease_generation(), s_generation_plus_one(&lease));
    again.stop(&|_| {});
}

fn s_generation_plus_one(lease: &Value) -> u64 {
    lease["generation"].as_u64().unwrap() + 1
}

/// S2：从 `L` 转换，进度在任何入口之前写下；转换结束后才开放入口。
#[test]
fn a_conversion_reports_progress_before_any_entry() {
    let d = dir("convert");
    let (n, l) = (d.join("N"), legacy_root(&d));
    let events = Events::default();
    let mut o = options(&n, &l, &events);
    o.handoff = Some(atm_runtime::Handoff {
        txn: "T1".into(),
        install_root: d.join("install"),
    });
    let s = serving(atm_runtime::start(&o).unwrap());
    let seen = events.take();
    assert_eq!(&seen[..2], [Event::Admitted, Event::Published]);
    assert_eq!(
        &seen[2..7],
        [
            Event::Lease,
            Event::Http,
            Event::Descriptor,
            Event::Witness,
            Event::Scheduler
        ]
    );
    let progress = atm_install_state::startup::read_progress(&n).unwrap();
    assert_eq!(progress.txn, "T1");
    assert_eq!(progress.pid, std::process::id());
    assert_eq!(progress.generation.as_deref(), Some(s.generation()));
    assert!(progress.progress.work > 0, "{progress:?}");
    let a = authority(&n);
    assert_eq!((a.authority.as_str(), a.by.as_str()), ("v3", "publish"));
    let witness: Value = serde_json::from_slice(
        &std::fs::read(d.join("install/state/health/service-T1.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(witness["core"]["instanceId"], s.instance_id());
    assert_eq!(witness["generation"], s.lease_generation());
    assert_eq!(
        s.background(Duration::from_secs(60)),
        Some(Background::Unchanged)
    );
    s.stop(&|_| {});
}

/// B3（W3 peer r1 P2-02）：`A=v3` 与 `M` 对得上，但这次的 `L` 不是转换时的源（同样的内容放到了别的路径）：
/// 先阻塞比较，判冲突；lease、HTTP、daemon.json、调度器一样都没有，`N\runtime` 只多出启动状态。
#[test]
fn a_different_source_is_stopped_before_any_entry() {
    let d = dir("other-source");
    let (n, l) = (d.join("N"), legacy_root(&d));
    let events = Events::default();
    serving(atm_runtime::start(&options(&n, &l, &events)).unwrap()).stop(&|_| {});
    let moved = d.join("L-moved");
    copy_tree(&l, &moved);
    let before = runtime_files(&n);
    events.take();

    let started = atm_runtime::start(&options(&n, &moved, &events)).unwrap();
    let Started::Conflict(c) = started else {
        panic!("the moved source must not be served")
    };
    assert!(
        c.state.reason.contains("was converted from"),
        "{}",
        c.state.reason
    );
    assert_eq!(
        events.take(),
        [Event::Admitted, Event::BlockingCompare, Event::Conflict]
    );
    let mut expected = before.clone();
    expected.push("startup-state.json".into());
    expected.sort();
    expected.dedup();
    assert_eq!(runtime_files(&n), expected);
    assert!(descriptor(&n).is_none());
    drop(c);

    // 冲突一直在，直到用户选：再启动还是冲突，入口照样不开。
    let again = atm_runtime::start(&options(&n, &moved, &events)).unwrap();
    assert!(matches!(again, Started::Conflict(_)));
    assert_eq!(events.take(), [Event::Admitted, Event::Conflict]);
}

/// `A=legacy`（回滚到 2.x 之后再升级）：在开放入口之前阻塞比较。没动过 2.x → 无损接回；
/// 动过 → 封存后重转，新 generation 里有 2.x 写的数据。两种都是比较完才有入口。
#[test]
fn a_legacy_authority_is_compared_before_serving() {
    let d = dir("after-rollback");
    let (n, l) = (d.join("N"), legacy_root(&d));
    let layout = Layout::new(&n);
    let events = Events::default();
    let first = serving(atm_runtime::start(&options(&n, &l, &events)).unwrap());
    let g1 = first.generation().to_string();
    first.stop(&|_| {});
    let m = match cv::read_manifest(&layout) {
        cv::ManifestState::Present(m) => m,
        other => panic!("{other:?}"),
    };
    cv::write_authority(
        &layout,
        &cv::rollback_authority(Some(&authority(&n)), &m, "txn-r", T),
    )
    .unwrap();
    events.take();

    let resumed = serving(atm_runtime::start(&options(&n, &l, &events)).unwrap());
    assert_eq!(resumed.generation(), g1);
    assert_eq!(
        events.take(),
        [
            vec![Event::Admitted, Event::BlockingCompare],
            ENTRIES.to_vec()
        ]
        .concat()
    );
    assert_eq!(authority(&n).by, "resume-after-rollback");
    assert_eq!(resumed.background(Duration::from_millis(10)), None);
    resumed.stop(&|_| {});

    let m = match cv::read_manifest(&layout) {
        cv::ManifestState::Present(m) => m,
        other => panic!("{other:?}"),
    };
    cv::write_authority(
        &layout,
        &cv::rollback_authority(Some(&authority(&n)), &m, "txn-r2", T),
    )
    .unwrap();
    touch_legacy(&l);
    events.take();
    let reconverted = serving(atm_runtime::start(&options(&n, &l, &events)).unwrap());
    assert_ne!(reconverted.generation(), g1);
    let seen = events.take();
    assert_eq!(
        &seen[..3],
        [Event::Admitted, Event::BlockingCompare, Event::Published]
    );
    assert_eq!(&seen[3..7], ENTRIES);
    reconverted.stop(&|_| {});
}

/// 07 §6 末行：`A=v3` 照常开放入口，后台比较发现 2.x 变了 → 先撤下全部入口，再写启动状态；
/// 撤下之后不再监听，daemon.json 不在，调度器已停。发现之前写进 3.0 的数据留着。
#[test]
fn a_background_conflict_withdraws_every_entry_first() {
    let d = dir("background-conflict");
    let (n, l) = (d.join("N"), legacy_root(&d));
    let events = Events::default();
    serving(atm_runtime::start(&options(&n, &l, &events)).unwrap()).stop(&|_| {});
    touch_legacy(&l);
    events.take();

    let s = serving(atm_runtime::start(&options(&n, &l, &events)).unwrap());
    let port = s.port();
    let outcome = s.background(Duration::from_secs(120)).unwrap();
    let Background::Conflict(state) = outcome else {
        panic!("{outcome:?}")
    };
    assert!(state.reason.contains("changed"), "{}", state.reason);
    assert_eq!(
        events.take(),
        [
            vec![Event::Admitted],
            ENTRIES.to_vec(),
            vec![Event::BackgroundCompare, Event::Withdrawn, Event::Conflict],
        ]
        .concat()
    );
    assert!(descriptor(&n).is_none());
    assert!(get(port, "/health").is_none());
    assert!(n.join("runtime/startup-state.json").exists());
    drop(s);
    // 下一次启动直接是冲突，入口不开。
    assert!(matches!(
        atm_runtime::start(&options(&n, &l, &events)).unwrap(),
        Started::Conflict(_)
    ));
    assert_eq!(events.take(), [Event::Admitted, Event::Conflict]);
}

/// F7：同一个 `N` 只有一个实例拿得到准入。
#[test]
fn a_second_instance_is_refused() {
    let d = dir("second");
    let n = d.join("N");
    let events = Events::default();
    let s = serving(atm_runtime::start(&options(&n, &d.join("L-missing"), &events)).unwrap());
    assert!(matches!(
        atm_runtime::start(&options(&n, &d.join("L-missing"), &Events::default())),
        Err(atm_runtime::BootError::AlreadyRunning)
    ));
    s.stop(&|_| {});
}
