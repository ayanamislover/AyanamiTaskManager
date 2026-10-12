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

/// S1 的另一种样子（W8b 演练）：从没装过 2.x 的机器首装，setup 的 FENCE 已经在 `L` 里建好 `current` junction，
/// 宿主才判定。只有它的 `L` 不是 2.x 数据根：建空库开放入口，不去转换；后台比较也不当成冲突；`L` 原样不动。
#[test]
fn a_first_install_is_fresh_beside_setups_junction() {
    let d = dir("fresh-junction");
    let (n, l, install) = (d.join("N"), d.join("L"), d.join("install"));
    std::fs::create_dir_all(&l).unwrap();
    std::fs::create_dir_all(&install).unwrap();
    let made = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(l.join("current"))
        .arg(&install)
        .output()
        .unwrap();
    assert!(made.status.success(), "{made:?}");
    let events = Events::default();
    let s = serving(atm_runtime::start(&options(&n, &l, &events)).unwrap());
    let m = match cv::read_manifest(&Layout::new(&n)) {
        cv::ManifestState::Present(m) => m,
        other => panic!("{other:?}"),
    };
    assert_eq!(m.source_root, None, "a fresh install has no 2.x source");
    assert!(
        !n.join("staging").exists()
            || std::fs::read_dir(n.join("staging"))
                .unwrap()
                .next()
                .is_none()
    );
    assert!(!matches!(
        s.background(Duration::from_secs(60)),
        Some(Background::Conflict(_))
    ));
    let names: Vec<_> = std::fs::read_dir(&l)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(names, ["current"]);
    assert!(descriptor(&n).is_some());
}

/// 全新安装的第二次启动（W8d packaged-smoke）：第一次启动后宿主往 `L` 里装了指南、docs 与 skills。它们是共享的
/// Agent 文档资产（00 决定 #6），不是 2.x 数据根：照常服务，后台比较也不当成「2.x 比较不了」的冲突。
#[test]
fn a_fresh_install_restarts_beside_the_shared_agent_documents() {
    let d = dir("fresh-docs");
    let (n, l) = (d.join("N"), d.join("L"));
    let first = Events::default();
    drop(serving(
        atm_runtime::start(&options(&n, &l, &first)).unwrap(),
    ));
    std::fs::create_dir_all(l.join("docs")).unwrap();
    std::fs::create_dir_all(l.join("skills").join("atm-task")).unwrap();
    std::fs::write(l.join("ATM_AGENT_GUIDE.md"), "guide").unwrap();
    let again = Events::default();
    let s = serving(atm_runtime::start(&options(&n, &l, &again)).unwrap());
    assert!(!matches!(
        s.background(Duration::from_secs(60)),
        Some(Background::Conflict(_))
    ));
    assert!(descriptor(&n).is_some());
    assert_eq!(authority(&n).authority, "v3");
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
    // 不要令牌的入口只答这三项（peer W4 r1 P2-01），多一项都是红。
    let mut keys: Vec<&str> = health
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(keys, ["generation", "instanceId", "pid"], "{body}");
    assert_eq!(health["pid"], published["pid"], "{body}");
    // 没有令牌的业务请求照样被挡。
    assert_eq!(get(s.port(), "/api/v1/projects").unwrap().0, 401);
    // 带令牌的 status（06 #1、07 §7）：单库，转换状态是这份发布物；界面版拿的是同一份（`Serving::conversion`）。
    let token = published["token"].as_str().unwrap();
    let (code, body) = get_authorized(s.port(), "/api/v1/system/status", token).unwrap();
    assert_eq!(code, 200, "{body}");
    let status: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(status["layout"], "single", "{body}");
    assert_eq!(status["conversion"]["phase"], "PUBLISHED", "{body}");
    assert_eq!(status["conversion"]["generation"], s.generation(), "{body}");
    assert!(!s.generation().is_empty());
    assert_eq!(status["conversion"], s.conversion());
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

/// W4i peer r1 P1-02：后台比较还没结束时直接丢弃 `Serving`（不调 `stop`，例如作用域退出、错误返回）。
/// 丢弃要等比较线程结束、入口撤下之后才放掉准入：丢弃返回时旧的 `/health` 已经不答、daemon.json 已撤，
/// 下一个实例这时才能起来，两个实例不会同时服务。
#[test]
fn dropping_a_serving_closes_everything_before_the_admission_goes() {
    use std::sync::{Arc, Mutex, mpsc};
    use std::time::Instant;
    let d = dir("boot-drop");
    let (n, l) = (d.join("N"), d.join("L-missing"));
    let mut o = options(&n, &l, &Events::default());
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let release_rx = Mutex::new(release_rx);
    o.observe = Arc::new(move |e| {
        if e == Event::BackgroundCompare {
            let _ = entered_tx.send(());
            let _ = release_rx
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(30));
        }
    });
    let Started::Serving(first) = atm_runtime::start(&o).unwrap() else {
        panic!("expected serving");
    };
    entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    let port = first.port();
    assert_eq!(get(port, "/health").map(|r| r.0), Some(200));
    let released_at = Arc::new(Mutex::new(None));
    let mark = released_at.clone();
    let releaser = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        *mark.lock().unwrap() = Some(Instant::now());
        release_tx.send(()).unwrap();
    });
    drop(first);
    let dropped_at = Instant::now();
    releaser.join().unwrap();
    let released = *released_at.lock().unwrap();
    assert!(
        released.is_some_and(|r| r <= dropped_at),
        "the drop returned while the background compare still held the entries"
    );
    assert!(atm_install_state::startup::admission_released(&n));
    assert_eq!(get(port, "/health"), None, "the old HTTP still answers");
    assert!(!n.join("runtime").join("daemon.json").exists());

    let Started::Serving(next) = atm_runtime::start(&options(&n, &l, &Events::default())).unwrap()
    else {
        panic!("expected serving");
    };
    if next.port() != port {
        assert_eq!(get(port, "/health"), None);
    }
    next.stop(&|_| {});
}

/// W4i peer r2 补查：入口发布到一半（HTTP 已开、daemon.json 已写）出错或 panic 时，`start` 返回之前就把
/// 已开的入口撤干净：旧端口不再答 `/health`，daemon.json 不留给 Agent，准入随之释放，下一个实例照常起来。
/// 出错用安装根的 `state` 是个文件（写不了见证）；panic 用 observe 在 `Descriptor` 时 panic。
#[test]
fn a_publish_that_fails_halfway_leaves_no_entry_behind() {
    use std::sync::{Arc, Mutex};
    for panics in [false, true] {
        let d = dir(if panics {
            "boot-half-panic"
        } else {
            "boot-half-error"
        });
        let n = d.join("N");
        let l = d.join("L-missing");
        let install = d.join("install");
        std::fs::create_dir_all(&install).unwrap();
        std::fs::write(
            install.join(atm_install_state::STATE_DIR),
            b"not a directory",
        )
        .unwrap();
        let port = Arc::new(Mutex::new(None));
        let mut o = options(&n, &l, &Events::default());
        o.handoff = (!panics).then(|| atm_runtime::Handoff {
            txn: "T1".into(),
            install_root: install.clone(),
        });
        let (seen, nn) = (port.clone(), n.clone());
        o.observe = Arc::new(move |e| {
            if e == Event::Descriptor {
                let endpoint = descriptor(&nn).unwrap()["endpoint"]
                    .as_str()
                    .unwrap()
                    .to_string();
                let p: u16 = endpoint.rsplit(':').next().unwrap().parse().unwrap();
                assert_eq!(get(p, "/health").map(|r| r.0), Some(200));
                *seen.lock().unwrap() = Some(p);
                if panics {
                    panic!("observer fails after the descriptor");
                }
            }
        });
        let result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| atm_runtime::start(&o)));
        match (&result, panics) {
            (Err(_), true) => {}
            (Ok(Err(atm_runtime::BootError::Failed(_))), false) => {}
            _ => panic!("panics={panics}: unexpected outcome"),
        }
        drop(result);
        let p = port.lock().unwrap().expect("the descriptor was written");
        assert_eq!(
            get(p, "/health"),
            None,
            "panics={panics}: the HTTP still answers"
        );
        assert!(
            descriptor(&n).is_none(),
            "panics={panics}: daemon.json left behind"
        );
        assert!(atm_install_state::startup::admission_released(&n));
        let next = serving(atm_runtime::start(&options(&n, &l, &Events::default())).unwrap());
        next.stop(&|_| {});
    }
}

/// W4i peer r3 P1-01：持久状态里拼进路径的名字不是单独一层时不跟随，写入、移动都留在 N 里。
/// - 封存意图 `seal.json` 的 name 是 N 外面的绝对路径：当作没有可续做的意图，按新的一次隔离走；
/// - `M` 的 generation 是 `..\..\outside`：`M` 按损坏处理，发布物隔离进 `N\quarantine\unknown-…`，
///   不会拿它拼出 `N\quarantine\..\..\outside-…`。
///
/// 两种之后都照常起来（S1 重新建库），N 外面什么也没有多出来。
#[test]
fn names_persisted_in_n_never_lead_outside_it() {
    for case in ["seal-name", "generation"] {
        let d = dir(&format!("boot-names-{case}"));
        let (n, l) = (d.join("N"), d.join("L-missing"));
        let outside = d.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        // 先正常起一次，得到一份真实的发布物与 M。
        serving(atm_runtime::start(&options(&n, &l, &Events::default())).unwrap()).stop(&|_| {});
        let layout = Layout::new(&n);
        std::fs::write(layout.data().join("marker"), b"published").unwrap();
        match case {
            "seal-name" => {
                let intent = serde_json::json!({"kind": "quarantine", "name": outside.display().to_string()});
                std::fs::write(layout.runtime().join("seal.json"), intent.to_string()).unwrap();
            }
            _ => {
                let mut m: Value =
                    serde_json::from_slice(&std::fs::read(layout.manifest()).unwrap()).unwrap();
                m["generation"] = Value::from(r"..\..\outside");
                std::fs::write(layout.manifest(), m.to_string()).unwrap();
            }
        }
        let before: Vec<_> = std::fs::read_dir(&d)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        let s = serving(atm_runtime::start(&options(&n, &l, &Events::default())).unwrap());
        s.stop(&|_| {});
        let after: Vec<_> = std::fs::read_dir(&d)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(after, before, "{case}: something was written next to N");
        assert!(
            std::fs::read_dir(&outside).unwrap().next().is_none(),
            "{case}: something was moved outside N"
        );
        let quarantined: Vec<_> = std::fs::read_dir(n.join("quarantine"))
            .unwrap()
            .map(|e| e.unwrap().path().join("data").join("marker"))
            .filter(|p| p.is_file())
            .collect();
        assert_eq!(
            quarantined.len(),
            1,
            "{case}: the publication was not quarantined inside N"
        );
    }
}

/// W4i peer r3 P1-01：进程内的 `start` 在任何写入之前核对 txn：不是单独一层就失败，N 都不建。
#[test]
fn a_txn_that_is_not_one_name_is_refused_before_admission() {
    let d = dir("boot-bad-txn");
    let (n, l) = (d.join("N"), d.join("L-missing"));
    for txn in [r"x\..\..\outside", "..", r"C:\x", "CON"] {
        let mut o = options(&n, &l, &Events::default());
        o.handoff = Some(atm_runtime::Handoff {
            txn: txn.into(),
            install_root: d.join("install"),
        });
        assert!(
            matches!(
                atm_runtime::start(&o),
                Err(atm_runtime::BootError::Failed(_))
            ),
            "{txn}"
        );
        assert!(!n.exists() && !d.join("install").exists(), "{txn}");
    }
}

/// W6b（03 §2.5 R3、R4）：离线恢复做到一半（意图文件在）时不启动、一个入口都不开；做完之后的第一次启动
/// 先收尾——推进范围世代、记一条 `database.recovered`、删掉标记——再开放入口。
#[test]
fn an_offline_recovery_is_settled_before_serving() {
    use atm_store::recover::{self, RecoverOptions, Step};
    let d = dir("offline-recovery");
    let n = d.join("N");
    let l = d.join("L-missing");
    serving(atm_runtime::start(&options(&n, &l, &Events::default())).unwrap()).stop(&|_| {});
    let layout = Layout::new(&n);
    let store = atm_store::Store::open(&layout.database(), atm_store::Config::default()).unwrap();
    let id = atm_store::backup::create_backup(
        &store,
        &n.join("backups"),
        "MANUAL",
        "2026-10-10T00:00:00.000Z",
    )
    .unwrap()
    .id;
    drop(store);
    let o = RecoverOptions {
        at: "2026-10-10T01:00:00.000Z",
        pin_until: "2026-11-10T01:00:00.000Z",
    };
    recover::recover_with(&layout, &id, o, &mut |s| s != Step::Quarantined).unwrap_err();

    let events = Events::default();
    match atm_runtime::start(&options(&n, &l, &events)) {
        Err(atm_runtime::BootError::Failed(why)) => {
            assert!(why.contains("unfinished") && why.contains(&id), "{why}")
        }
        Err(other) => panic!("{other}"),
        Ok(_) => panic!("started with an unfinished recovery"),
    }
    assert_eq!(events.take(), [Event::Admitted]);
    assert!(descriptor(&n).is_none());

    recover::recover(&layout, &id, o).unwrap();
    assert!(n.join("runtime").join(recover::MARKER).is_file());
    let s = serving(atm_runtime::start(&options(&n, &l, &Events::default())).unwrap());
    assert!(!n.join("runtime").join(recover::MARKER).exists());
    let (svc, _) = s.service().unwrap();
    let recovered: i64 = svc
        .store()
        .read(|tx| {
            tx.query_row(
                "SELECT count(*) FROM global_feed WHERE type = 'database.recovered' AND aggregate_id = ?1",
                [&id],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(recovered, 1);
    drop(svc);
    s.stop(&|_| {});
}

/// W8f-3 掉电演练：已发布的库读不出时不服务、不隔离、不建空库（否则 3.0 的写入悄悄消失，备份也因 generation
/// 换了而用不上）。启动以 Damaged 结束、放掉准入，再启动还是一样；`atm recover --offline` 从这一代的备份恢复后照常服务。
#[test]
fn a_damaged_database_waits_for_an_offline_recovery() {
    use atm_store::recover::{self, RecoverOptions};
    let d = dir("damaged-database");
    let n = d.join("N");
    let l = d.join("L-missing");
    serving(atm_runtime::start(&options(&n, &l, &Events::default())).unwrap()).stop(&|_| {});
    let layout = Layout::new(&n);
    let generation = match cv::read_manifest(&layout) {
        cv::ManifestState::Present(m) => m.generation,
        other => panic!("{other:?}"),
    };
    let store = atm_store::Store::open(&layout.database(), atm_store::Config::default()).unwrap();
    let id = atm_store::backup::create_backup(
        &store,
        &n.join("backups"),
        "MANUAL",
        "2026-10-12T00:00:00.000Z",
    )
    .unwrap()
    .id;
    drop(store);
    let mut bytes = std::fs::read(layout.database()).unwrap();
    bytes[..100].fill(0x5a);
    std::fs::write(layout.database(), &bytes).unwrap();

    for _ in 0..2 {
        let events = Events::default();
        match atm_runtime::start(&options(&n, &l, &events)) {
            Err(atm_runtime::BootError::Damaged {
                generation: g,
                reason,
            }) => {
                assert_eq!(g, generation);
                assert!(reason.contains("cannot be read"), "{reason}");
            }
            Err(other) => panic!("{other}"),
            Ok(_) => panic!("served a database that cannot be read"),
        }
        assert_eq!(events.take(), [Event::Admitted]);
        assert!(descriptor(&n).is_none());
        assert!(
            !n.join("quarantine").exists(),
            "the publication was quarantined"
        );
        assert_eq!(std::fs::read(layout.database()).unwrap(), bytes);
    }

    let o = RecoverOptions {
        at: "2026-10-12T01:00:00.000Z",
        pin_until: "2026-11-12T01:00:00.000Z",
    };
    recover::recover(&layout, &id, o).unwrap();
    let s = serving(atm_runtime::start(&options(&n, &l, &Events::default())).unwrap());
    match cv::read_manifest(&layout) {
        cv::ManifestState::Present(m) => assert_eq!(m.generation, generation),
        other => panic!("{other:?}"),
    }
    s.stop(&|_| {});
}

/// 宿主正在退出（`may_open` 答 false）：入口一样都不开——没有 lease、HTTP、daemon.json，也没有观察到 Lease；
/// 启动以失败结束、放掉准入，下一次照常开放（peer W6 r9 P2-01）。
#[test]
fn a_host_that_is_exiting_opens_no_entry() {
    let d = dir("may-open-refused");
    let n = d.join("N");
    let events = Events::default();
    let mut o = options(&n, &d.join("L-missing"), &events);
    let asked = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let count = asked.clone();
    o.may_open = Some(std::sync::Arc::new(move || {
        count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        false
    }));
    match atm_runtime::start(&o) {
        Err(atm_runtime::BootError::Failed(why)) => assert!(why.contains("exiting"), "{why}"),
        Ok(_) => panic!("the entries opened"),
        Err(other) => panic!("{other}"),
    }
    assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert!(descriptor(&n).is_none(), "daemon.json written");
    let files = runtime_files(&n);
    assert!(
        !files
            .iter()
            .any(|f| f == "daemon.json" || f == "daemon.lock"),
        "{files:?}"
    );
    assert!(!events.seen().contains(&Event::Lease));
    o.may_open = None;
    let s = serving(atm_runtime::start(&o).unwrap());
    assert!(descriptor(&n).is_some());
    s.stop(&|_| {});
}

/// W8h（07 §7）：用户在窗口里选数据来源。
///
/// - `A=legacy` 且 2.x 比较不了（多了一个未登记的文件）→ 冲突；「沿用 3.0」绑进 `A=v3 by user-choice`，清掉启动状态，
///   再启动就服务同一个 generation，3.0 里的数据都在；
/// - 2.x 写过（`A=v3`，后台比较发现）→ 冲突；「从 2.x 重新转换」封存当前 generation，再启动换了 generation、带着 2.x 写的数据；
/// - 3.0 是从另一个数据根转换来的：「沿用 3.0」拒绝（绑不住，下次还会冲突），什么都不写；「重新转换」照常。
#[test]
fn the_users_choice_settles_a_source_conflict() {
    let d = dir("source-choice");
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
    std::fs::write(l.join("stray.bin"), b"not a 2.x file").unwrap();

    let Started::Conflict(c) = atm_runtime::start(&options(&n, &l, &events)).unwrap() else {
        panic!("an uncomparable 2.x after a rollback must ask")
    };
    assert_eq!(
        cv::conflict_cause(&c.state.reason),
        "UNREADABLE",
        "{}",
        c.state.reason
    );
    let kept = serving(
        c.choose(&options(&n, &l, &events), atm_runtime::SourceChoice::KeepV3)
            .unwrap(),
    );
    let a = authority(&n);
    assert_eq!(
        (a.authority.as_str(), a.by.as_str(), a.generation.as_deref()),
        ("v3", "user-choice", Some(g1.as_str()))
    );
    assert!(!n.join("runtime/startup-state.json").exists());
    assert_eq!(kept.generation(), g1);
    // 按选择启动的这一轮不再后台比较：同样的 UNKNOWN 不会当场推翻用户刚做的决定。
    assert_eq!(kept.background(Duration::from_secs(5)), None);
    assert!(descriptor(&n).is_some());
    kept.stop(&|_| {});
    // 只放行这一次：下一次正常启动照常开放入口、后台比较，仍比较不了就再问（07 §6：v3 + UNKNOWN）。
    let next = serving(atm_runtime::start(&options(&n, &l, &events)).unwrap());
    match next.background(Duration::from_secs(120)) {
        Some(Background::Conflict(state)) => {
            assert_eq!(
                cv::conflict_cause(&state.reason),
                "UNREADABLE",
                "{}",
                state.reason
            )
        }
        other => panic!("an uncomparable 2.x asks again on the next start: {other:?}"),
    }
    drop(next);
    // 冲突一旦写下就一直在，直到用户再选：2.x 恢复可比较了也照样问。这次比较得出完整摘要，沿用 3.0 就绑定它。
    std::fs::remove_file(l.join("stray.bin")).unwrap();
    let Started::Conflict(again) = atm_runtime::start(&options(&n, &l, &events)).unwrap() else {
        panic!("the conflict found in the background stays")
    };
    let healed = serving(
        again
            .choose(&options(&n, &l, &events), atm_runtime::SourceChoice::KeepV3)
            .unwrap(),
    );
    assert_eq!(healed.generation(), g1);
    assert!(authority(&n).accepted_source_digest.is_some());
    healed.stop(&|_| {});

    // 2.x 写过：后台比较发现，冲突；选重新转换。
    touch_legacy(&l);
    let s = serving(atm_runtime::start(&options(&n, &l, &events)).unwrap());
    let outcome = s.background(Duration::from_secs(120)).unwrap();
    let Background::Conflict(state) = outcome else {
        panic!("{outcome:?}")
    };
    assert_eq!(
        cv::conflict_cause(&state.reason),
        "CHANGED",
        "{}",
        state.reason
    );
    drop(s);
    let Started::Conflict(c) = atm_runtime::start(&options(&n, &l, &events)).unwrap() else {
        panic!("the conflict stays until the user chooses")
    };
    let reconverted = serving(
        c.choose(
            &options(&n, &l, &events),
            atm_runtime::SourceChoice::Reconvert,
        )
        .unwrap(),
    );
    let g2 = reconverted.generation().to_string();
    assert_ne!(g2, g1);
    assert!(!n.join("runtime/startup-state.json").exists());
    reconverted.stop(&|_| {});

    // 换了数据根：沿用 3.0 绑不住，拒绝且不写 A；重新转换照常。
    let moved = d.join("L-moved");
    copy_tree(&l, &moved);
    let Started::Conflict(c) = atm_runtime::start(&options(&n, &moved, &events)).unwrap() else {
        panic!("a moved source must ask")
    };
    assert_eq!(cv::conflict_cause(&c.state.reason), "OTHER_SOURCE");
    let before = std::fs::read(n.join("authority.json")).unwrap();
    let refused = match c.choose(
        &options(&n, &moved, &events),
        atm_runtime::SourceChoice::KeepV3,
    ) {
        Err(e) => e.to_string(),
        Ok(_) => panic!("keeping 3.0 converted from another root must be refused"),
    };
    assert!(refused.starts_with("SOURCE_KEEP_UNAVAILABLE"), "{refused}");
    assert_eq!(std::fs::read(n.join("authority.json")).unwrap(), before);
    let Started::Conflict(c) = atm_runtime::start(&options(&n, &moved, &events)).unwrap() else {
        panic!("still in conflict after a refused choice")
    };
    let from_moved = serving(
        c.choose(
            &options(&n, &moved, &events),
            atm_runtime::SourceChoice::Reconvert,
        )
        .unwrap(),
    );
    assert_ne!(from_moved.generation(), g2);
    from_moved.stop(&|_| {});
}
