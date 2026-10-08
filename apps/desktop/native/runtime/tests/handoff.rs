//! setup 与真实 3.x 进程的交接（W4i，07 §8，W3 peer r1 P2-02）：拉起开发用的无头二进制，用 setup 自己的等待循环
//! （`atm_install_state::handoff::await_healthy`，含 SERVICE_HEALTHY 的交叉核对）等它，覆盖 START、接管、死亡、
//! 卡住与取消、写 `A` 的时机，以及冲突时不开任何入口。

mod support;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use atm_install_state::ProcessIdentity;
use atm_install_state::handoff::{self, Await};
use atm_install_state::procs;
use atm_install_state::startup::{self, RollbackAuthority, WaitPolicy};
use atm_store::conversion::{self as cv, AuthorityState, Layout, ManifestState};
use support::*;

const VERSION: &str = "3.0.0-dev";

/// 一次交接的场地：新根 `N`、旧根 `L`、安装根（见证与记账在这里）。
struct Site {
    dir: PathBuf,
    n: PathBuf,
    legacy: PathBuf,
    install: PathBuf,
}

impl Site {
    fn new(name: &str, with_legacy: bool) -> Site {
        let dir = dir(name);
        let legacy = if with_legacy {
            legacy_root(&dir)
        } else {
            dir.join("L-missing")
        };
        Site {
            n: dir.join("N"),
            install: dir.join("install"),
            legacy,
            dir,
        }
    }

    fn launch(&self, txn: &str, legacy: &Path, extra: &[&str]) -> Running {
        let (n, l, i) = (
            self.n.to_string_lossy().into_owned(),
            legacy.to_string_lossy().into_owned(),
            self.install.to_string_lossy().into_owned(),
        );
        let mut args = vec![
            "--n",
            &n,
            "--legacy",
            &l,
            "--version",
            VERSION,
            "--txn-start",
            txn,
            "--install-root",
            &i,
            "--background",
        ];
        args.extend_from_slice(extra);
        let (_child, identity) =
            procs::spawn(Path::new(env!("CARGO_BIN_EXE_atm-runtime")), &args).unwrap();
        Running(identity)
    }

    fn wait(&self, txn: &str, who: &ProcessIdentity, policy: WaitPolicy) -> Result<(), String> {
        let health = self.install.join("state").join("health");
        let ledger = self
            .install
            .join("state")
            .join("txn")
            .join(txn)
            .join(handoff::LEDGER_FILE);
        handoff::await_healthy(
            &Await {
                health_dir: &health,
                legacy_runtime: &self.dir.join("L-runtime-unused"),
                v3_root: &self.n,
                ledger: &ledger,
                txn,
                version: VERSION,
                identity: who,
                policy,
                poll: Duration::from_millis(100),
            },
            &mut |line| eprintln!("{line}"),
        )
    }

    fn authority(&self) -> AuthorityState {
        cv::read_authority(&Layout::new(&self.n))
    }

    fn generation(&self) -> Option<String> {
        match cv::read_manifest(&Layout::new(&self.n)) {
            ManifestState::Present(m) => Some(m.generation),
            _ => None,
        }
    }
}

/// 用例拉起的进程；用例结束（含失败）时按身份结束它。
struct Running(ProcessIdentity);

impl Running {
    fn kill(&self) {
        procs::terminate(&self.0);
        assert!(
            procs::wait_all_gone(std::slice::from_ref(&self.0), Duration::from_secs(20)),
            "the runtime did not exit"
        );
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        procs::terminate(&self.0);
        let _ = procs::wait_all_gone(std::slice::from_ref(&self.0), Duration::from_secs(20));
    }
}

fn policy(first: u64, stall: u64, cap: u64) -> WaitPolicy {
    WaitPolicy {
        first_progress: Duration::from_secs(first),
        stall: Duration::from_secs(stall),
        cap: Duration::from_secs(cap),
    }
}

/// 等到这个进程写出第一条被接受的进度（转换已经开始）。
fn until_progress(n: &Path, txn: &str, who: &ProcessIdentity, phase: Option<&str>) {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if let Some(p) = startup::read_progress(n)
            && p.txn == txn
            && p.pid == who.pid
            && p.process_created_at == who.started_at_ms
            && phase.is_none_or(|ph| p.phase == ph)
        {
            return;
        }
        assert!(Instant::now() < deadline, "no progress from {}", who.pid);
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// START：全新安装，SERVICE_HEALTHY 成立（见证、lease、daemon.json、`/health`、端口归属逐项对上）。
/// 见证只认本事务：用别的 txn 去等，同一个健康的进程也永远不算成功。
#[test]
fn a_start_is_healthy_only_through_its_own_witness() {
    let s = Site::new("handoff-start", false);
    let p = s.launch("T1", &s.legacy, &[]);
    s.wait("T1", &p.0, policy(60, 600, 600)).unwrap();
    let descriptor: serde_json::Value =
        serde_json::from_slice(&std::fs::read(s.n.join("runtime/daemon.json")).unwrap()).unwrap();
    assert_eq!(descriptor["pid"], p.0.pid);
    assert_eq!(descriptor["layout"], "single");
    let other = s.wait("T-OTHER", &p.0, policy(2, 600, 600)).unwrap_err();
    assert!(other.starts_with("START_TIMEOUT"), "{other}");
}

/// F15：转换比首条进度期限长，一直有进度，setup 等到 SERVICE_HEALTHY；记账落盘、记下了最后的进度。
#[test]
fn a_long_conversion_is_waited_out_through_its_progress() {
    let s = Site::new("handoff-convert", true);
    let started = Instant::now();
    let p = s.launch("T1", &s.legacy, &["--drill-pace-ms", "300"]);
    s.wait("T1", &p.0, policy(2, 600, 600)).unwrap();
    assert!(
        started.elapsed() > Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
    let ledger: startup::WaitLedger = serde_json::from_slice(
        &std::fs::read(s.install.join("state/txn/T1").join(handoff::LEDGER_FILE)).unwrap(),
    )
    .unwrap();
    assert_eq!(
        (ledger.pid, ledger.process_created_at),
        (p.0.pid, p.0.started_at_ms)
    );
    assert!(ledger.last.is_some(), "{ledger:?}");
    match s.authority() {
        AuthorityState::Present(a) => {
            assert_eq!((a.authority.as_str(), a.by.as_str()), ("v3", "publish"))
        }
        other => panic!("{other:?}"),
    }
}

/// F18 与 P2-02：setup 等到一半被杀（这里用很短的总上限模拟），重启后接管同一个进程：
/// 那个进程的进度照收，预算从它第一次被等时算起，不因重建而重来。
#[test]
fn a_restarted_setup_takes_over_with_the_budget_already_spent() {
    let s = Site::new("handoff-takeover", true);
    // 卡在 IMPORT：进度停在那里，总上限是唯一会到的期限。
    let p = s.launch("T1", &s.legacy, &["--drill-hold-at", "IMPORT"]);
    let first = s.wait("T1", &p.0, policy(60, 600, 2)).unwrap_err();
    assert!(first.starts_with("START_TIMEOUT"), "{first}");
    let resumed = Instant::now();
    let second = s.wait("T1", &p.0, policy(60, 600, 6)).unwrap_err();
    assert!(second.starts_with("START_TIMEOUT"), "{second}");
    // 已经花掉约 2 s：再等约 4 s 就到 6 s 的总上限；重新计时的话要整整 6 s。
    assert!(
        resumed.elapsed() < Duration::from_millis(5_000),
        "{:?}",
        resumed.elapsed()
    );
    assert!(procs::alive(&p.0), "a takeover never kills by itself");
}

/// 卡住（07 §8，F16）与取消：进度停住、`stall` 内没动 → START_STUCK。setup 结束它、确认它放掉了准入，
/// 才按持久阶段处理：还没 PUBLISHED，不写 `A`。之前（进程还活着）一律拒绝。
#[test]
fn a_stuck_start_is_given_up_and_cancelled_without_authority() {
    let s = Site::new("handoff-stuck", true);
    let p = s.launch("T1", &s.legacy, &["--drill-hold-at", "IMPORT"]);
    let stuck = s.wait("T1", &p.0, policy(60, 2, 600)).unwrap_err();
    // 卡在报 IMPORT 进度之前：最后一条进度是 SNAPSHOT。
    assert!(stuck.starts_with("START_STUCK"), "{stuck}");
    assert!(stuck.contains("SNAPSHOT"), "{stuck}");
    let refused = startup::settle_for_rollback(&s.n, "T1", handoff::now_ms()).unwrap_err();
    assert!(refused.starts_with("V3_STILL_ADMITTED"), "{refused}");
    p.kill();
    assert!(startup::await_admission_released(
        &s.n,
        startup::ADMISSION_GRACE
    ));
    match startup::settle_for_rollback(&s.n, "T1", handoff::now_ms()).unwrap() {
        RollbackAuthority::NotWritten(why) => assert!(why.contains("IMPORT"), "{why}"),
        other => panic!("{other:?}"),
    }
    assert_eq!(s.authority(), AuthorityState::Missing);
}

/// F17：转换中途进程死了 → START_HOST_EXITED；不写 `A`；再次升级走 S3，换新 generation 转换到健康。
#[test]
fn a_dead_conversion_fails_the_start_and_the_next_one_restarts() {
    let s = Site::new("handoff-death", true);
    let p = s.launch("T1", &s.legacy, &["--drill-hold-at", "VERIFY"]);
    until_progress(&s.n, "T1", &p.0, Some("IMPORT"));
    let killed_generation = s.generation();
    assert!(killed_generation.is_some());
    let waiter = {
        let s = Site {
            dir: s.dir.clone(),
            n: s.n.clone(),
            legacy: s.legacy.clone(),
            install: s.install.clone(),
        };
        let who = p.0.clone();
        std::thread::spawn(move || s.wait("T1", &who, policy(60, 600, 600)))
    };
    std::thread::sleep(Duration::from_millis(500));
    p.kill();
    let dead = waiter.join().unwrap().unwrap_err();
    assert!(dead.starts_with("START_HOST_EXITED"), "{dead}");
    assert!(matches!(
        startup::settle_for_rollback(&s.n, "T1", handoff::now_ms()).unwrap(),
        RollbackAuthority::NotWritten(_)
    ));
    assert_eq!(s.authority(), AuthorityState::Missing);

    let again = s.launch("T2", &s.legacy, &[]);
    s.wait("T2", &again.0, policy(60, 600, 600)).unwrap();
    assert_ne!(s.generation(), killed_generation);
}

/// 07 §8 回滚事务：已经 PUBLISHED 的 3.x 要先退出、放掉准入，setup 才写 `A=legacy by setup-rollback`
/// （在切换版本目录之前）。之后再升级、2.x 没动过：阻塞比较判不变，无损接回，`A=v3 by resume-after-rollback`。
#[test]
fn the_rollback_authority_is_written_only_after_the_process_is_gone() {
    let s = Site::new("handoff-rollback", true);
    let p = s.launch("T1", &s.legacy, &[]);
    s.wait("T1", &p.0, policy(60, 600, 600)).unwrap();
    let generation = s.generation().unwrap();
    let refused = startup::settle_for_rollback(&s.n, "T-RB", handoff::now_ms()).unwrap_err();
    assert!(refused.starts_with("V3_STILL_ADMITTED"), "{refused}");
    assert!(matches!(s.authority(), AuthorityState::Present(a) if a.authority == "v3"));
    p.kill();
    assert_eq!(
        startup::settle_for_rollback(&s.n, "T-RB", handoff::now_ms()).unwrap(),
        RollbackAuthority::Written {
            generation: generation.clone()
        }
    );
    match s.authority() {
        AuthorityState::Present(a) => {
            assert_eq!(
                (a.authority.as_str(), a.by.as_str()),
                ("legacy", "setup-rollback")
            );
            assert_eq!(a.txn.as_deref(), Some("T-RB"));
        }
        other => panic!("{other:?}"),
    }

    let back = s.launch("T2", &s.legacy, &[]);
    s.wait("T2", &back.0, policy(60, 600, 600)).unwrap();
    assert_eq!(s.generation().as_deref(), Some(generation.as_str()));
    match s.authority() {
        AuthorityState::Present(a) => assert_eq!(a.by, "resume-after-rollback"),
        other => panic!("{other:?}"),
    }
}

/// 冲突（B3、07 §7）：转换时的源是 `L`，这次给的是同样内容的另一个路径。进程活着、持有准入，
/// 但没有任何入口：没有 daemon.json、没有见证，`N\runtime` 里只多出启动状态；setup 永远等不到健康。
#[test]
fn a_conflicting_start_never_publishes_an_entry() {
    let s = Site::new("handoff-conflict", true);
    let first = s.launch("T1", &s.legacy, &[]);
    s.wait("T1", &first.0, policy(60, 600, 600)).unwrap();
    first.kill();
    // 被杀的进程留下了 daemon.json；下一个拿到准入的实例先撤掉它。
    assert!(s.n.join("runtime/daemon.json").exists());
    let moved = s.dir.join("L-moved");
    copy_tree(&s.legacy, &moved);
    let mut before = runtime_files(&s.n);
    // 被杀时后台比较的临时目录（compare）也可能还在：下一次比较开始时清掉它。
    before.retain(|f| f != "daemon.json" && f != "compare");

    let p = s.launch("T2", &moved, &[]);
    let waited = s.wait("T2", &p.0, policy(60, 3, 600)).unwrap_err();
    assert!(waited.starts_with("START_STUCK"), "{waited}");
    assert!(procs::alive(&p.0));
    assert!(!startup::admission_released(&s.n));
    assert!(!s.n.join("runtime/daemon.json").exists());
    assert!(!s.install.join("state/health/service-T2.json").exists());
    let mut expected = before;
    expected.push("startup-state.json".into());
    expected.sort();
    expected.dedup();
    assert_eq!(runtime_files(&s.n), expected);
    let state: serde_json::Value =
        serde_json::from_slice(&std::fs::read(s.n.join("runtime/startup-state.json")).unwrap())
            .unwrap();
    assert_eq!(state["state"], "SOURCE_CONFLICT");
}
