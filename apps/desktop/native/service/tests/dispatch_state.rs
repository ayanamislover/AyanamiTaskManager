//! P-017 在服务层（W7d）：派单状态的读写只给派单器用得上的身份。起会话要的准入（`dispatch_target`）只给用户和
//! 手机——跟踪作业能读写历史（记下会话的结局），但拿不到准入，也就起不了会话；Agent 与其它系统作业什么都碰不到，
//! 被拒的写入一行都不落。

mod support;

use atm_domain::principal::{JobId, Principal};
use atm_service::dispatch_state::{ConfigRow, DispatchWrite};
use support::*;

fn phone() -> Principal {
    Principal::verified_phone("space".into(), "m-0123456789ab".into(), "cmd".into())
}

fn config_write() -> DispatchWrite {
    DispatchWrite {
        config: Some(ConfigRow {
            enabled: true,
            permission_mode: "auto".into(),
            max_concurrent: 1,
            model: None,
            effort: None,
            source_state: "OK".into(),
        }),
        ..DispatchWrite::default()
    }
}

/// (读历史, 读账本, 查任务还在不在, 写, 准入) 各自成不成。
fn reach(w: &World, p: &Principal) -> [bool; 5] {
    let refs = [("ATM".to_owned(), "W-1".to_owned())];
    [
        w.svc.dispatch_runs(p).is_ok(),
        w.svc.dispatch_requests(p).is_ok(),
        w.svc.dispatch_live_tasks(p, &refs).is_ok(),
        w.svc.dispatch_save(p, &config_write()).is_ok(),
        w.svc.dispatch_target(p, "ATM", "ATM-T-0001").is_ok(),
    ]
}

#[test]
fn p017_dispatch_state_is_reachable_only_by_the_dispatcher_s_principals() {
    let w = world("dispatch-state-principals");
    let configs = || w.count("SELECT COUNT(*) FROM dispatch_config");
    let mut outsiders = vec![("agent".to_owned(), agent())];
    for &job in JobId::ALL {
        if job != JobId::DispatchTrack {
            outsiders.push((format!("{job:?}"), Principal::system_job(job)));
        }
    }
    for (who, p) in &outsiders {
        assert_eq!(reach(&w, p), [false; 5], "{who}");
        let e = w.svc.dispatch_save(p, &config_write()).unwrap_err();
        assert!(
            e.code.as_str().ends_with("DENIED") || e.code.as_str() == "USER_AUTHORIZATION_REQUIRED",
            "{who}: {e:?}"
        );
    }
    assert_eq!(configs(), 0, "被拒的写入一行都不落");
    // 跟踪作业：历史可读可写，准入没有。
    let tracker = Principal::system_job(JobId::DispatchTrack);
    assert_eq!(reach(&w, &tracker), [true, true, true, true, false]);
    assert!(
        w.svc
            .dispatch_target(&tracker, "ATM", "ATM-T-0001")
            .is_err()
    );
    // 手机派单：读写历史、准入都要。
    assert_eq!(reach(&w, &phone()), [true; 5]);
    assert_eq!(reach(&w, &user()), [true; 5]);
    assert_eq!(configs(), 1);
}
