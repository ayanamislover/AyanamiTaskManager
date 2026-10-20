//! 适配层的定位读与读时续租（W4c；R11 A3、P3）。

mod support;

use atm_domain::time::Timestamp;
use serde_json::{Value, json};
use std::sync::Arc;
use support::*;

const NOW: &str = "2026-10-05T02:00:00.000Z";

fn fixed(name: &str) -> World {
    world_with(name, Some(Arc::new(|| Timestamp::parse(NOW).unwrap())))
}

/// session → 项目；不存在报 SESSION_NOT_FOUND；跨项目重名要求显式 project；TRASHED 项目里的不可读。
#[test]
fn a_session_names_its_project() {
    let w = fixed("scope-session");
    let s = w.svc.session_scope(&agent(), " S1 ").unwrap();
    assert_eq!(
        (
            s.project.as_str(),
            s.project_id.as_str(),
            s.agent_id.as_str(),
            s.role.as_str(),
            s.online
        ),
        ("ATM", "PA", "claude", "PRIMARY", true)
    );
    assert!(!w.svc.session_scope(&agent(), "RZ").unwrap().online);
    let e = w.svc.session_scope(&agent(), "NOPE").unwrap_err();
    assert_eq!(e.code.as_str(), "SESSION_NOT_FOUND");
    // 导入的数据万一跨项目撞名：不猜，列出候选。
    w.exec(&format!(
        "INSERT INTO agent_sessions (project_id, id, agent_id, role, work_state, connection_state, started_at, updated_at)
         VALUES ('PE', 'S1', 'claude', 'PRIMARY', 'IDLE', 'ONLINE', '{T0}', '{T0}')"
    ));
    let e = w.svc.session_scope(&agent(), "S1").unwrap_err();
    assert_eq!(e.code.as_str(), "PROJECT_REQUIRED");
    assert_eq!(e.details["candidates"], json!(["ATM", "EMP"]));
    // TRASHED 项目里的 session 与项目本身一样不可读。
    w.exec("UPDATE projects SET lifecycle = 'TRASHED' WHERE id = 'PE'");
    let e = w.svc.session_scope(&agent(), "EX").unwrap_err();
    assert_eq!(e.code.as_str(), "PROJECT_DB_UNAVAILABLE", "{e:?}");
    // 用户也能用（读能力）。
    assert_eq!(w.svc.session_scope(&user(), "SX").unwrap().project, "ATM");
}

/// 项目代码 → 内部 id，不区分大小写。
#[test]
fn a_project_code_names_its_id() {
    let w = fixed("scope-project");
    assert_eq!(w.svc.project_id(&agent(), " atm ").unwrap(), "PA");
    assert_eq!(
        w.svc
            .project_id(&agent(), "NOPE")
            .unwrap_err()
            .code
            .as_str(),
        "PROJECT_NOT_FOUND"
    );
}

/// 读时续租：只续这个 session 持有的、未终态的、已经过期或快到期的领取，并刷新心跳；
/// 关闭的 session、用户读、别人的领取都不动；不推版本，不写事件。
#[test]
fn touching_a_session_renews_only_its_own_open_claims() {
    let w = fixed("scope-touch");
    let mine = w.task("我的");
    let done = w.task("我的、已完成");
    let other = w.task("别人的");
    let old = "2026-10-05T01:30:00.000Z";
    for (key, session, status) in [
        (&mine, "S1", "IN_PROGRESS"),
        (&done, "S1", "DONE"),
        (&other, "SX", "IN_PROGRESS"),
    ] {
        let no: i64 = key.rsplit('-').next().unwrap().parse().unwrap();
        w.exec(&format!(
            "UPDATE work_items SET status = '{status}', claimed_by_session_id = '{session}', claim_lease_until = '{old}'
              WHERE project_id = 'PA' AND local_no = {no}"
        ));
    }
    let versions = |w: &World| -> Vec<i64> {
        [&mine, &done, &other]
            .iter()
            .map(|k| w.version(k))
            .collect()
    };
    let events = |w: &World| w.count("SELECT count(*) FROM events");
    let (v0, e0) = (versions(&w), events(&w));

    // 用户读不续租。
    w.svc.touch_session(&user(), "S1").unwrap();
    assert_eq!(w.col(&mine, "claim_lease_until"), json!(old));

    w.svc.touch_session(&agent(), "S1").unwrap();
    assert_eq!(
        w.col(&mine, "claim_lease_until"),
        json!("2026-10-05T02:10:00.000Z")
    );
    assert_eq!(
        w.col(&done, "claim_lease_until"),
        json!(old),
        "terminal claims stay"
    );
    assert_eq!(
        w.col(&other, "claim_lease_until"),
        json!(old),
        "another session's claim stays"
    );
    assert_eq!(w.session("S1", "heartbeat_at"), json!(NOW));
    assert_eq!(
        (versions(&w), events(&w)),
        (v0, e0),
        "touching is not a content change"
    );

    // 关闭的 session 没有心跳，也不续租。
    let no: i64 = other.rsplit('-').next().unwrap().parse().unwrap();
    w.exec(&format!("UPDATE agent_sessions SET connection_state = 'CLOSED' WHERE id = 'SX'; UPDATE work_items SET claimed_by_session_id = 'SX' WHERE local_no = {no}"));
    w.svc.touch_session(&agent(), "SX").unwrap();
    assert_eq!(w.col(&other, "claim_lease_until"), json!(old));
    // 跨项目重名的 session（只可能来自导入）：不猜是哪个，什么都不续。
    w.exec(&format!(
        "INSERT INTO agent_sessions (project_id, id, agent_id, role, work_state, connection_state, started_at, updated_at)
         VALUES ('PE', 'S1', 'claude', 'PRIMARY', 'IDLE', 'ONLINE', '{T0}', '{T0}');
         UPDATE work_items SET claim_lease_until = '{old}' WHERE project_id = 'PA' AND claimed_by_session_id = 'S1'"
    ));
    w.svc.touch_session(&agent(), "S1").unwrap();
    assert_eq!(w.col(&mine, "claim_lease_until"), json!(old));
    // 不存在的 session：什么都不做。
    w.svc.touch_session(&agent(), "NOPE").unwrap();
    assert_eq!(w.session("SX", "heartbeat_at"), Value::Null);
}
