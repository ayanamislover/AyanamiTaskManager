//! 领取归属（D04；W-025、W-026、W-028；00 C-07、C-08、C-22；10 R1、R2）。

use atm_domain::ownership::{
    Acquire, Claim, Requester, acquire, claim_after_write, is_stale, is_successor_reclaim,
    may_modify, may_release,
};
use atm_domain::time::Timestamp;

fn t(min: i64) -> Timestamp {
    Timestamp::from_millis(min * 60_000)
}

const NOW: i64 = 100;

fn held(lease_min: i64) -> Claim<'static> {
    Claim {
        session: Some("S1"),
        lease_until: Some(t(lease_min)),
        assignee: Some("agent-a"),
    }
}

fn live() -> Claim<'static> {
    held(NOW + 5)
}

fn stale() -> Claim<'static> {
    held(NOW - 1)
}

fn lineage() -> Requester<'static> {
    Requester::Agent {
        agent_id: "agent-a",
        session: "S2",
        holder_in_lineage: true,
    }
}

fn other() -> Requester<'static> {
    Requester::Agent {
        agent_id: "agent-b",
        session: "S9",
        holder_in_lineage: false,
    }
}

#[test]
fn c22_is_stale_is_a_time_comparison() {
    assert!(is_stale(Some(t(NOW)), t(NOW)), "lease == now is stale");
    assert!(
        !is_stale(Some(Timestamp::from_millis(t(NOW).millis() + 1)), t(NOW)),
        "lease 1 ms ahead is live"
    );
    assert!(!is_stale(None, t(NOW)), "no lease never goes stale");
}

#[test]
fn r1_may_modify() {
    let now = t(NOW);
    // 阳性：User、无人领取、过期、同 lineage。
    assert!(may_modify(live(), Requester::User, now).is_ok());
    assert!(may_modify(Claim::UNCLAIMED, other(), now).is_ok());
    assert!(may_modify(stale(), other(), now).is_ok());
    assert!(may_modify(live(), lineage(), now).is_ok());
    // 反例：他人持有有效领取。
    let err = may_modify(live(), other(), now).unwrap_err();
    assert_eq!(err.holder_session, "S1");
    assert_eq!(err.holder_agent.as_deref(), Some("agent-a"));
    assert_eq!(err.lease_until, Some(t(NOW + 5)));
    // User 的领取没有 session，对 Agent 不构成排他锁。
    let user_claim = Claim {
        session: None,
        lease_until: None,
        assignee: Some("USER"),
    };
    assert!(may_modify(user_claim, other(), now).is_ok());
    // 同一 agent 但不在 lineage（新开的、没接上的 session）仍被拒：占用按 lineage，不按 agent。
    let same_agent_new_session = Requester::Agent {
        agent_id: "agent-a",
        session: "S3",
        holder_in_lineage: false,
    };
    assert!(may_modify(live(), same_agent_new_session, now).is_err());
}

#[test]
fn w025_and_r2_acquire() {
    let now = t(NOW);
    assert_eq!(
        acquire(Claim::UNCLAIMED, other(), false, now),
        Ok(Acquire::Free)
    );
    // R2：lineage 后继直接接手，不需要 takeoverStale。
    assert_eq!(acquire(live(), lineage(), false, now), Ok(Acquire::Lineage));
    assert_eq!(acquire(stale(), other(), true, now), Ok(Acquire::TakeOver));
    // 反例：未过期带 takeover；过期不带 takeover；User 碰到 Agent 的有效领取。
    let e = acquire(live(), other(), true, now).unwrap_err();
    assert!(!e.stale);
    assert_eq!(e.holder_session, "S1");
    assert!(acquire(stale(), other(), false, now).unwrap_err().stale);
    assert!(acquire(live(), Requester::User, true, now).is_err());
    assert_eq!(
        acquire(stale(), Requester::User, true, now),
        Ok(Acquire::TakeOver)
    );
}

#[test]
fn w026_successor_reclaim_is_the_original_assignee() {
    let released_in_progress = Claim {
        session: None,
        lease_until: None,
        assignee: Some("agent-a"),
    };
    assert!(is_successor_reclaim(released_in_progress, lineage()));
    assert!(!is_successor_reclaim(released_in_progress, other()));
    assert!(!is_successor_reclaim(released_in_progress, Requester::User));
    let user_task = Claim {
        session: None,
        lease_until: None,
        assignee: Some("USER"),
    };
    assert!(is_successor_reclaim(user_task, Requester::User));
}

#[test]
fn w028_c08_r2_release() {
    let now = t(NOW);
    // Agent：无人领取（C-08）、本 lineage（R2）、别人的过期领取 + takeover（C-08）。
    assert!(may_release(Claim::UNCLAIMED, other(), false, now).is_ok());
    assert!(may_release(live(), lineage(), false, now).is_ok());
    assert!(may_release(stale(), other(), true, now).is_ok());
    assert!(may_release(stale(), other(), false, now).is_err());
    assert!(may_release(live(), other(), true, now).is_err());
    // User：无人领取或过期；不能释放别人有效的领取。
    assert!(may_release(Claim::UNCLAIMED, Requester::User, false, now).is_ok());
    assert!(may_release(stale(), Requester::User, false, now).is_ok());
    let e = may_release(live(), Requester::User, true, now).unwrap_err();
    assert_eq!((e.holder_session.as_deref(), e.stale), (Some("S1"), false));
}

#[test]
fn r2_claim_follows_the_writing_session_and_renews() {
    let now = t(NOW);
    assert_eq!(
        claim_after_write(stale(), lineage(), now),
        Some(("S2", t(NOW + 10)))
    );
    assert_eq!(
        claim_after_write(live(), lineage(), now),
        Some(("S2", t(NOW + 10)))
    );
    // 别人、User、无人领取：不动。
    assert_eq!(claim_after_write(live(), other(), now), None);
    assert_eq!(claim_after_write(live(), Requester::User, now), None);
    let unclaimed_lineage = Requester::Agent {
        agent_id: "agent-a",
        session: "S2",
        holder_in_lineage: true,
    };
    assert_eq!(
        claim_after_write(Claim::UNCLAIMED, unclaimed_lineage, now),
        None
    );
}
