//! P-017 / NS：派单只给用户和手机。Agent 与每一个系统作业从任何入口（派单器、手机同步的 DispatchPort）都起不了
//! 会话、改不了配置、取消不了、看不到状态；被拒时没有任何副作用——不拉起进程、不探测 claude、不写库、不记账本。
//! 手机只能派单：配置、取消、状态都只给用户。

mod support;

use atm_domain::principal::{JobId, Principal};
use atm_sync::dispatch::{DispatchPort, EnqueueInput};
use atm_sync::errors::Failure;
use serde_json::json;
use support::*;

const DENIED: &str = "PRINCIPAL_CAPABILITY_DENIED";

/// 被拒的身份与它该拿到的码：Agent 拿到「要用户来做」（带用户去哪里做的提示），系统作业是能力不足。
fn outsiders() -> Vec<(String, Principal, &'static str)> {
    let mut all = vec![("agent".to_owned(), agent(), "USER_AUTHORIZATION_REQUIRED")];
    for &job in JobId::ALL {
        all.push((format!("{job:?}"), Principal::system_job(job), DENIED));
    }
    all
}

/// 账本、派单、配置三张表的行数，与日志目录里的文件数。
fn footprint(w: &World) -> (i64, i64, i64, usize) {
    let files = std::fs::read_dir(&w.logs).map(|d| d.count()).unwrap_or(0);
    (
        w.count("SELECT COUNT(*) FROM dispatch_requests"),
        w.count("SELECT COUNT(*) FROM dispatch_runs"),
        w.count("SELECT COUNT(*) FROM dispatch_config"),
        files,
    )
}

#[test]
fn p017_only_the_user_and_the_phone_start_sessions_and_a_refusal_leaves_no_trace() {
    let w = world("p017");
    let key = w.seed_task("ATM", "派单身份");
    let d = w.dispatcher();
    w.enable(&d, json!({}));
    w.auth("ok");
    let before = footprint(&w);
    let probes = w.auth_probes();
    let config = d.config();
    for (n, (who, p, denied)) in outsiders().into_iter().enumerate() {
        let e = d.enqueue(&p, &desktop(&key)).unwrap_err();
        assert_eq!(e.code(), denied, "{who} 派单");
        let request = command_id(atm_sync::time::now_ms(), n as u32);
        let e = d.enqueue(&p, &mobile(&key, &request)).unwrap_err();
        assert_eq!(e.code(), denied, "{who} 带命令 ID 派单");
        let via_port = DispatchPort::enqueue(
            &d,
            &p,
            EnqueueInput {
                project: "ATM".into(),
                key: key.clone(),
                requested_by: None,
                request_id: Some(request),
            },
        );
        assert!(
            matches!(&via_port, Err(Failure::Domain(e)) if e.code.as_str() == denied),
            "{who} 经 DispatchPort：{:?}",
            via_port.err()
        );
        let e = d
            .update_config(&p, &json!({ "maxConcurrent": 3 }))
            .unwrap_err();
        assert_eq!(e.code(), denied, "{who} 改配置");
        assert_eq!(
            d.cancel(&p, "r-00000000").unwrap_err().code(),
            denied,
            "{who} 取消"
        );
        assert_eq!(d.status(&p).unwrap_err().code(), denied, "{who} 看状态");
    }
    // 手机：只能派单。
    let phone = phone("m-0123456789ab.cmd");
    assert_eq!(
        d.update_config(&phone, &json!({ "enabled": false }))
            .unwrap_err()
            .code(),
        DENIED
    );
    assert_eq!(d.cancel(&phone, "r-00000000").unwrap_err().code(), DENIED);
    assert_eq!(d.status(&phone).unwrap_err().code(), DENIED);
    // 被拒的这些一点痕迹都没有。
    assert_eq!(w.spawns(), 0);
    assert_eq!(w.auth_probes(), probes);
    assert_eq!(footprint(&w), before);
    assert_eq!(d.config(), config);
    assert!(d.list_runs().is_empty());
    // 对照：手机经 DispatchPort 真能起一次会话，账本记下这条命令。
    let request = command_id(atm_sync::time::now_ms(), 0xffff);
    let run = DispatchPort::enqueue(
        &d,
        &phone,
        EnqueueInput {
            project: "ATM".into(),
            key: key.clone(),
            requested_by: Some("Pixel 9".into()),
            request_id: Some(request),
        },
    )
    .unwrap();
    wait_state(&d, &run.run, "succeeded");
    assert_eq!(w.spawns(), 1);
    assert_eq!(w.count("SELECT COUNT(*) FROM dispatch_requests"), 1);
    d.close();
}
