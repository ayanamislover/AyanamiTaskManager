//! 本地更新的协调（W5g，06 T-UPD；2.0 `update-coordinator.ts`、`updater.ts`）：投递物的识别与清理、
//! 检查的各种结论、上次安装的结果、并发检查合并、主体、诊断的脱敏与轮换、周期与落定复查。

use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use atm_domain::error::ErrorCode;
use atm_domain::principal::{JobId, Principal, UiSurface};
use atm_jobs::update::{
    Coordinator, FeedScan, Options, Schedule, compare_versions, install_root_of, prune_feed,
    sanitize_detail, scan_feed, version_valid,
};
use serde_json::{Value, json};

const CURRENT: &str = "3.0.0";

fn dir(name: &str) -> PathBuf {
    let root = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("target")
        })
        .join("jobs-tests")
        .join(name);
    let d = std::path::absolute(root).unwrap();
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn user() -> Principal {
    Principal::trusted_ui(UiSurface::Tray)
}

fn system() -> Principal {
    Principal::system_job(JobId::UpdateCheck)
}

/// 投递一个版本：先写包，再写清单。`edit` 改清单。
fn deliver(feed: &Path, version: &str, bytes: usize, edit: impl FnOnce(&mut Value)) -> PathBuf {
    std::fs::create_dir_all(feed).unwrap();
    let package = format!("atm-{version}-win-x64.zip");
    std::fs::write(feed.join(&package), vec![7u8; bytes]).unwrap();
    let mut manifest = json!({
        "format": 1, "version": version, "arch": "x64", "package": package,
        "packageBytes": bytes, "packageSha256": "00",
    });
    edit(&mut manifest);
    let path = feed.join(format!("atm-{version}-win-x64.json"));
    std::fs::write(&path, manifest.to_string()).unwrap();
    path
}

fn names(feed: &Path) -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(feed)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    out.sort();
    out
}

#[test]
fn versions_and_names_follow_the_packager() {
    for good in ["3.0.0", "10.20.30", "3.0.0-rc.1"] {
        assert!(version_valid(good), "{good}");
    }
    for bad in [
        "3.0",
        "3.0.0.1",
        "3.0.x",
        "3.0.0-",
        "3.0.0-a b",
        "1234567890.0.0",
        "..",
    ] {
        assert!(!version_valid(bad), "{bad}");
    }
    use std::cmp::Ordering::*;
    assert_eq!(compare_versions("1.1.0", "1.0.27"), Greater);
    assert_eq!(compare_versions("3.0", "3.0.0"), Equal);
    assert_eq!(compare_versions("2.9.9", "3.0.0"), Less);
}

#[test]
fn the_feed_scan_picks_the_highest_complete_newer_version_and_lists_what_is_consumed() {
    let feed = dir("update-scan").join("updates");
    deliver(&feed, "2.9.0", 3, |_| {});
    deliver(&feed, CURRENT, 3, |_| {});
    deliver(&feed, "3.0.5", 5, |_| {});
    let best = deliver(&feed, "3.1.0", 9, |_| {});
    std::fs::write(feed.join("RELEASES"), b"x").unwrap();
    std::fs::write(feed.join("AyanamiTaskManager-1.0.0-full.nupkg"), b"x").unwrap();
    std::fs::write(feed.join("notes.txt"), b"x").unwrap();
    std::fs::create_dir_all(feed.join("atm-9.9.9-win-x64.json")).unwrap();

    let scan = scan_feed(&feed, CURRENT);
    let candidate = scan.candidate.clone().unwrap();
    assert_eq!(
        (
            candidate.version.as_str(),
            candidate.manifest,
            candidate.package_bytes
        ),
        ("3.1.0", best, 9)
    );
    assert_eq!(scan.invalid, None);
    assert_eq!(
        scan.consumed,
        [
            "AyanamiTaskManager-1.0.0-full.nupkg",
            "RELEASES",
            "atm-2.9.0-win-x64.json",
            "atm-2.9.0-win-x64.zip",
            "atm-3.0.0-win-x64.json",
            "atm-3.0.0-win-x64.zip",
        ]
    );

    let removed = prune_feed(&feed, &scan.consumed);
    assert_eq!(removed, scan.consumed);
    assert_eq!(
        names(&feed),
        [
            "atm-3.0.5-win-x64.json",
            "atm-3.0.5-win-x64.zip",
            "atm-3.1.0-win-x64.json",
            "atm-3.1.0-win-x64.zip",
            "atm-9.9.9-win-x64.json",
            "notes.txt",
        ]
    );
    // 名字不是单层文件名的一律不删。
    assert!(prune_feed(&feed, &["../notes.txt".into(), "notes.txt\\..\\x".into()]).is_empty());
    // 没有更新目录：什么都没有。
    assert_eq!(
        scan_feed(&feed.join("missing"), CURRENT),
        FeedScan::default()
    );
}

/// 一种坏投递：在投放目录里把一份好的投递弄坏。
type Breakage = Box<dyn Fn(&Path)>;

#[test]
fn a_broken_delivery_of_the_highest_version_is_reported_not_installed() {
    let root = dir("update-broken");
    let cases: [(&str, Breakage); 5] = [
        (
            "PACKAGE_SIZE_MISMATCH",
            Box::new(|f| {
                deliver(f, "3.2.0", 9, |m| m["packageBytes"] = json!(10));
            }),
        ),
        (
            "MANIFEST_INVALID",
            Box::new(|f| {
                deliver(f, "3.2.0", 9, |m| m["arch"] = json!("arm64"));
            }),
        ),
        (
            "PACKAGE_MISSING",
            Box::new(|f| {
                deliver(f, "3.2.0", 9, |_| {});
                std::fs::remove_file(f.join("atm-3.2.0-win-x64.zip")).unwrap();
            }),
        ),
        (
            "MANIFEST_UNREADABLE",
            Box::new(|f| {
                deliver(f, "3.2.0", 9, |_| {});
                std::fs::write(f.join("atm-3.2.0-win-x64.json"), b"{not json").unwrap();
            }),
        ),
        (
            "MANIFEST_TOO_LARGE",
            Box::new(|f| {
                deliver(f, "3.2.0", 9, |_| {});
                std::fs::write(
                    f.join("atm-3.2.0-win-x64.json"),
                    vec![b' '; 4 * 1024 * 1024 + 1],
                )
                .unwrap();
            }),
        ),
    ];
    for (index, (reason, make)) in cases.iter().enumerate() {
        let feed = root.join(index.to_string());
        deliver(&feed, "3.1.0", 9, |_| {});
        make(&feed);
        let scan = scan_feed(&feed, CURRENT);
        assert_eq!(scan.candidate, None, "{reason}");
        assert_eq!(scan.invalid, Some(("3.2.0".into(), *reason)));
    }
}

#[test]
fn only_an_installed_layout_has_an_install_root() {
    let root = dir("update-root");
    let app = root.join("app-3.0.0");
    std::fs::create_dir_all(&app).unwrap();
    assert_eq!(install_root_of(&app), None);
    std::fs::write(root.join("app.json"), b"{}").unwrap();
    assert_eq!(install_root_of(&app), Some(root.clone()));
    for other in ["native", "app-x", "app-"] {
        std::fs::create_dir_all(root.join(other)).unwrap();
        assert_eq!(install_root_of(&root.join(other)), None, "{other}");
    }
}

struct World {
    n: PathBuf,
    root: PathBuf,
    feed: PathBuf,
    pending: Receiver<Option<String>>,
    coordinator: Arc<Coordinator>,
}

fn world(name: &str, installed: bool) -> World {
    let base = dir(name);
    let (n, root) = (base.join("N"), base.join("install"));
    std::fs::create_dir_all(root.join("state")).unwrap();
    let (tx, pending) = channel();
    let tx = Mutex::new(tx);
    let coordinator = Arc::new(Coordinator::new(Options {
        data_dir: n.clone(),
        current_version: CURRENT.into(),
        install_root: installed.then(|| root.clone()),
        on_pending: Arc::new(move |v| {
            let _ = tx.lock().unwrap().send(v);
        }),
        now: Some(Arc::new(|| 1_800_000_000_000)),
    }));
    World {
        feed: n.join("updates"),
        n,
        root,
        pending,
        coordinator,
    }
}

impl World {
    fn code(&self) -> String {
        self.coordinator.check(&user()).unwrap().unwrap().code
    }
    fn journal(&self, value: Value) {
        std::fs::write(
            self.root.join("state").join("install.json"),
            value.to_string(),
        )
        .unwrap();
    }
    fn events(&self) -> Vec<Option<String>> {
        self.pending.try_iter().collect()
    }
}

#[test]
fn portable_and_source_runs_do_not_take_part() {
    let w = world("update-portable", false);
    deliver(&w.feed, "3.1.0", 9, |_| {});
    deliver(&w.feed, "2.0.0", 9, |_| {});
    let status = w.coordinator.check(&user()).unwrap().unwrap();
    assert_eq!(
        (
            status.phase.as_str(),
            status.outcome.as_str(),
            status.code.as_str()
        ),
        ("CHECK", "SKIPPED", "UPDATE_UNSUPPORTED")
    );
    assert_eq!(status.action, "便携版与源码运行不参与自动更新。");
    // 不清理，不报就绪。
    assert_eq!(names(&w.feed).len(), 4);
    assert_eq!(w.coordinator.pending(), None);
    let applied = w.coordinator.apply(&user()).unwrap();
    assert_eq!(applied.manifest, None);
    assert_eq!(applied.status.unwrap().code, "UPDATE_UNSUPPORTED");
    assert!(w.events().is_empty());
}

#[test]
fn a_check_reports_ready_once_and_apply_hands_over_the_manifest() {
    let w = world("update-ready", true);
    assert_eq!(w.coordinator.status(&user()).unwrap(), None);
    assert_eq!(w.code(), "UPDATE_SOURCE_MISSING");
    let manifest = deliver(&w.feed, "3.1.0", 9, |_| {});
    deliver(&w.feed, "2.0.0", 9, |_| {});
    let ready = w.coordinator.check(&user()).unwrap().unwrap();
    assert_eq!(
        (
            ready.phase.as_str(),
            ready.code.as_str(),
            ready.version.as_deref()
        ),
        ("READY", "UPDATE_READY", Some("3.1.0"))
    );
    assert_eq!(ready.at, "2027-01-15T08:00:00.000Z");
    assert_eq!(w.coordinator.pending().as_deref(), Some("3.1.0"));
    // 旧包清掉了；就绪只告知一次。
    assert_eq!(
        names(&w.feed),
        ["atm-3.1.0-win-x64.json", "atm-3.1.0-win-x64.zip"]
    );
    assert_eq!(w.code(), "UPDATE_READY");
    assert_eq!(w.events(), [Some("3.1.0".to_owned())]);
    assert_eq!(
        w.coordinator.status(&user()).unwrap().unwrap().code,
        "UPDATE_READY"
    );

    let applied = w.coordinator.apply(&user()).unwrap();
    assert_eq!(applied.manifest, Some(manifest));
    let installing = applied.status.unwrap();
    assert_eq!(
        (
            installing.phase.as_str(),
            installing.outcome.as_str(),
            installing.code.as_str()
        ),
        ("INSTALL", "IN_PROGRESS", "INSTALLING")
    );
    assert_eq!(w.coordinator.launch_failed().code, "INSTALL_FAILED");

    // 包被拿走：就绪撤销，托盘跟着变。
    std::fs::remove_file(w.feed.join("atm-3.1.0-win-x64.json")).unwrap();
    assert_eq!(w.code(), "UPDATE_SOURCE_MISSING");
    assert_eq!(w.events(), [None]);
    let applied = w.coordinator.apply(&user()).unwrap();
    assert_eq!(applied.manifest, None);
}

#[test]
fn a_broken_delivery_withdraws_ready_and_consumed_packages_are_cleaned() {
    let w = world("update-verify", true);
    deliver(&w.feed, "3.1.0", 9, |_| {});
    assert_eq!(w.code(), "UPDATE_READY");
    deliver(&w.feed, "3.2.0", 9, |m| m["packageBytes"] = json!(1));
    let status = w.coordinator.check(&user()).unwrap().unwrap();
    assert_eq!(
        (status.code.as_str(), status.version.as_deref()),
        ("VERIFY_FAILED", Some("3.2.0"))
    );
    assert!(
        status.message.contains("PACKAGE_SIZE_MISMATCH"),
        "{}",
        status.message
    );
    assert_eq!(w.events(), [Some("3.1.0".to_owned()), None]);

    std::fs::remove_dir_all(&w.feed).unwrap();
    deliver(&w.feed, "2.9.0", 9, |_| {});
    let status = w.coordinator.check(&user()).unwrap().unwrap();
    assert_eq!(status.code, "UPDATE_SOURCE_CONSUMED");
    assert!(status.message.contains('2'), "{}", status.message);
    assert!(names(&w.feed).is_empty());
    assert_eq!(w.code(), "UPDATE_SOURCE_MISSING");
}

#[test]
fn the_outcome_of_the_last_install_is_read_from_the_install_journal() {
    let w = world("update-journal", true);
    deliver(&w.feed, "3.1.0", 9, |_| {});
    deliver(&w.feed, "2.0.0", 9, |_| {});
    w.coordinator.check(&user()).unwrap();
    w.coordinator.apply(&user()).unwrap();
    deliver(&w.feed, "2.0.0", 9, |_| {});

    // 事务还没落定（没有 outcome）：不报、不清。
    w.journal(json!({ "id": "T1", "to": "3.1.0", "state": "START" }));
    let status = w.coordinator.check(&user()).unwrap().unwrap();
    assert_eq!(status.code, "INSTALLING");
    assert!(names(&w.feed).contains(&"atm-2.0.0-win-x64.zip".to_owned()));

    // 回滚了：记下原因（只收枚举名）。
    w.journal(json!({ "id": "T1", "to": "3.1.0", "outcome": "ROLLED_BACK" }));
    let status = w.coordinator.check(&user()).unwrap().unwrap();
    assert_eq!(
        status.code, "UPDATE_READY",
        "the package is still there to retry"
    );
    let log = std::fs::read_to_string(w.n.join("logs").join("updater.ndjson")).unwrap();
    assert!(
        log.contains("INSTALL_FAILED") && log.contains("ROLLED_BACK"),
        "{log}"
    );

    w.coordinator.apply(&user()).unwrap();
    w.journal(json!({ "id": "T2", "to": "3.1.0", "outcome": "<script>C:\\Users\\x" }));
    w.coordinator.check(&user()).unwrap();
    let log = std::fs::read_to_string(w.n.join("logs").join("updater.ndjson")).unwrap();
    assert!(
        log.contains("（UNKNOWN）") && !log.contains("script"),
        "{log}"
    );

    // 装上了：本进程就是新版本，保留「已更新到」，不被「没有更新」盖掉。
    let w = world("update-installed", true);
    deliver(&w.feed, "3.1.0", 9, |_| {});
    w.coordinator.check(&user()).unwrap();
    w.coordinator.apply(&user()).unwrap();
    std::fs::remove_dir_all(&w.feed).unwrap();
    w.journal(json!({ "id": "T1", "to": CURRENT, "outcome": "COMMITTED" }));
    let status = w.coordinator.check(&user()).unwrap().unwrap();
    assert_eq!(
        (status.code.as_str(), status.version.as_deref()),
        ("UPDATE_INSTALLED", Some(CURRENT))
    );
    assert_eq!(w.code(), "UPDATE_SOURCE_MISSING");
}

#[test]
fn a_check_that_meets_a_running_one_takes_its_result() {
    let base = dir("update-merge");
    let n = base.join("N");
    let root = base.join("install");
    std::fs::create_dir_all(&root).unwrap();
    let (release, gate) = channel::<()>();
    let gate = Mutex::new(gate);
    let coordinator = Arc::new(Coordinator::new(Options {
        data_dir: n.clone(),
        current_version: CURRENT.into(),
        install_root: Some(root),
        // 第一次检查在告知就绪时停住，第二次检查就撞上它。
        on_pending: Arc::new(move |_| {
            let _ = gate.lock().unwrap().recv_timeout(Duration::from_secs(20));
        }),
        now: None,
    }));
    deliver(&n.join("updates"), "3.1.0", 9, |_| {});
    let first = {
        let c = coordinator.clone();
        std::thread::spawn(move || c.check(&user()).unwrap())
    };
    std::thread::sleep(Duration::from_millis(300));
    let second = {
        let c = coordinator.clone();
        std::thread::spawn(move || c.check(&system()).unwrap())
    };
    std::thread::sleep(Duration::from_millis(500));
    release.send(()).unwrap();
    let (a, b) = (
        first.join().unwrap().unwrap(),
        second.join().unwrap().unwrap(),
    );
    assert_eq!(
        (a.code.as_str(), b.code.as_str()),
        ("UPDATE_READY", "UPDATE_READY")
    );
    let log = std::fs::read_to_string(n.join("logs").join("updater.ndjson")).unwrap();
    assert_eq!(
        log.lines().count(),
        1,
        "the second check did not run again:\n{log}"
    );
}

#[test]
fn only_the_user_applies_and_the_job_may_only_check() {
    let w = world("update-principals", true);
    let agent = Principal::authenticated_agent(None);
    for e in [
        w.coordinator.status(&agent).unwrap_err(),
        w.coordinator.check(&agent).unwrap_err(),
        w.coordinator.apply(&agent).unwrap_err(),
    ] {
        assert_eq!(e.code, ErrorCode::USER_AUTHORIZATION_REQUIRED);
    }
    assert!(w.coordinator.check(&system()).is_ok());
    for e in [
        w.coordinator.status(&system()).unwrap_err(),
        w.coordinator.apply(&system()).unwrap_err(),
        w.coordinator
            .check(&Principal::system_job(JobId::Maintenance))
            .unwrap_err(),
    ] {
        assert_eq!(e.code, ErrorCode::PRINCIPAL_CAPABILITY_DENIED);
    }
    assert!(w.coordinator.status(&user()).is_ok());
    assert!(w.coordinator.apply(&user()).is_ok());
}

#[test]
fn details_are_redacted_and_bounded() {
    let cases = [
        (
            "Authorization: Bearer abc.def  ok",
            "Authorization: <redacted> ok",
        ),
        (
            "got bearer xyz from server",
            "got bearer <redacted> from server",
        ),
        (
            "GET /feed?token=s3cr3t&x=1",
            "GET /feed?token=<redacted>&x=1",
        ),
        // peer W5 r3：转义引号不结束值；括号包着的引号路径整段隐藏；Unicode 空白旁的键照样识别。
        (
            r#"{"password":"public\"SYNTHETIC_REVIEW_SECRET","n":1}"#,
            r#"{"password":<redacted>,"n":1}"#,
        ),
        (
            r#"open ("C:\Program Files\SYNTHETIC_REVIEW_SECRET\db") failed"#,
            "open <local-path> failed",
        ),
        (
            "日志\u{3000}token=SYNTHETIC_REVIEW_SECRET\u{3000}之后",
            "日志 token=<redacted> 之后",
        ),
        // peer W5 r5 P1-01：路径后紧跟的密钥键连同值和路径一起换成占位，密码不会从空格处露出。
        (
            r#"open 'C:\My Data\';password="public SYNTHETIC_REVIEW_SECRET" tail"#,
            "open <local-path> tail",
        ),
        // peer W5 r6 P2-01：路径里的键名不让路径的后半段露出来。
        (
            r#"open C:\data\token=public,SYNTHETIC_PRIVATE\report.txt failed"#,
            "open <local-path> failed",
        ),
        // peer W5 r4 P2-01：目录以分隔符结尾的引号路径，后面的失败原因不能被吞掉。
        (
            r#"open "C:\Program Files\" failed: access denied"#,
            "open <local-path> failed: access denied",
        ),
        // peer W5 r2 P1-01：同一个词里第二个键的值也要换掉。
        (
            r#"{"token":"public","authorization":"Bearer SYNTHETIC_REVIEW_SECRET"}"#,
            r#"{"token":<redacted>,"authorization":<redacted>}"#,
        ),
        (
            r#"password="public SYNTHETIC_REVIEW_SECRET" at "C:\Program Files\atm\x.db""#,
            "password=<redacted> at <local-path>",
        ),
        ("api_key=K1 monkey=fine", "api_key=<redacted> monkey=fine"),
        (
            "C:\\Users\\ayanami\\AppData\\x.json missing",
            "<local-path> missing",
        ),
        (
            "open \\\\server\\share\\f failed",
            "open <local-path> failed",
        ),
        ("file:///D:/atm/x.zip gone", "<local-path> gone"),
        ("  many \n spaces\t", "many spaces"),
    ];
    for (input, want) in cases {
        assert_eq!(sanitize_detail(input), want, "{input}");
    }
    let long = sanitize_detail(&"字".repeat(600));
    assert_eq!(long.chars().count(), 512);
    assert!(long.ends_with('…'));
}

#[test]
fn the_updater_log_rotates_and_keeps_three_files() {
    let w = world("update-rotate", true);
    // 写到第四次轮换以上：多留一份的错误才看得出来。
    for _ in 0..6000 {
        w.coordinator.check(&user()).unwrap();
    }
    let logs = w.n.join("logs");
    for name in ["updater.ndjson", "updater.1.ndjson", "updater.2.ndjson"] {
        let size = std::fs::metadata(logs.join(name)).unwrap().len();
        assert!(size > 0 && size <= 256 * 1024, "{name}: {size}");
    }
    assert!(!logs.join("updater.3.ndjson").exists());
}

#[test]
fn the_schedule_checks_at_start_and_rechecks_an_unsettled_install() {
    let base = dir("update-schedule");
    let (n, root) = (base.join("N"), base.join("install"));
    std::fs::create_dir_all(root.join("state")).unwrap();
    let coordinator = Arc::new(
        Coordinator::new(Options {
            data_dir: n.clone(),
            current_version: CURRENT.into(),
            install_root: Some(root.clone()),
            on_pending: Arc::new(|_| {}),
            now: None,
        })
        .with_settle_recheck(Duration::from_millis(300)),
    );
    let status = |c: &Coordinator| c.status(&user()).unwrap().map(|s| s.code);
    let eventually = |want: &str| {
        let started = Instant::now();
        while status(&coordinator).as_deref() != Some(want) {
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "never {want}: {:?}",
                status(&coordinator)
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    };
    // 启动即查一次（周期 1 小时：后面的都只能来自复查）。
    let schedule = Schedule::start(coordinator.clone(), Duration::from_secs(3600));
    eventually("UPDATE_SOURCE_MISSING");

    // 上次的安装没落定：用户手点的检查安排一次复查，周期线程到点复查，读到落定的结果。
    deliver(&n.join("updates"), "3.1.0", 9, |_| {});
    coordinator.check(&user()).unwrap();
    coordinator.apply(&user()).unwrap();
    std::fs::write(
        root.join("state").join("install.json"),
        json!({ "id": "T1", "to": "3.1.0", "state": "START" }).to_string(),
    )
    .unwrap();
    assert_eq!(
        coordinator.check(&user()).unwrap().unwrap().code,
        "INSTALLING"
    );
    // 落定：setup 换上了新版本（这里用 CURRENT 代表「本进程就是装上的那个」），包已用掉。
    std::fs::remove_dir_all(n.join("updates")).unwrap();
    std::fs::write(
        root.join("state").join("install.json"),
        json!({ "id": "T1", "to": CURRENT, "outcome": "COMMITTED" }).to_string(),
    )
    .unwrap();
    eventually("UPDATE_INSTALLED");

    // 停下：在另一条线程上停，限时等它返回（停不下来时按时变红，不挂满一小时的周期）。
    let (done, stopped) = channel();
    std::thread::spawn(move || {
        schedule.stop();
        let _ = done.send(());
    });
    stopped
        .recv_timeout(Duration::from_secs(5))
        .expect("the schedule did not stop in time");
}
