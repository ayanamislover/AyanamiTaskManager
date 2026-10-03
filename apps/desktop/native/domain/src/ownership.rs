//! 领取归属（01 W-025、W-026、W-028；00 C-07、C-08、C-22；10 R1、R2）。
//!
//! 领取属于 session lineage，不属于单个 session（R2）。lineage 要查身份图，由服务算好后以
//! `holder_in_lineage` 传进来：请求 session 与当前持有领取的 session 是否同属一个 lineage
//! （同一个 session 当然也算）。本模块只做判定，不读库。

use crate::time::Timestamp;

/// 租约长度：最近一次续租时刻 + 10 分钟（W-025；R2 的续租也续到 now + 10min）。
pub const LEASE_MINUTES: i64 = 10;

/// 00 C-22：全局唯一的过期判定。租约非空并且不晚于 now 才算过期；
/// 没有租约（User 的领取、旧数据）永远不算过期。
pub fn is_stale(lease_until: Option<Timestamp>, now: Timestamp) -> bool {
    matches!(lease_until, Some(lease) if lease <= now)
}

pub fn renewed_lease(now: Timestamp) -> Timestamp {
    now.plus_minutes(LEASE_MINUTES)
}

/// 任务上的领取事实。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Claim<'a> {
    /// `claimed_by_session_id`。
    pub session: Option<&'a str>,
    /// `claim_lease_until`。
    pub lease_until: Option<Timestamp>,
    /// `assignee_agent_id`（User 领取时是 `"USER"`）。
    pub assignee: Option<&'a str>,
}

impl Claim<'_> {
    pub const UNCLAIMED: Claim<'static> = Claim {
        session: None,
        lease_until: None,
        assignee: None,
    };

    pub fn is_held(&self) -> bool {
        self.session.is_some()
    }

    pub fn is_stale(&self, now: Timestamp) -> bool {
        is_stale(self.lease_until, now)
    }
}

/// 发起写入的一方（服务已解析好 session 与 lineage）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Requester<'a> {
    User,
    Agent {
        agent_id: &'a str,
        session: &'a str,
        /// 请求 session 与 `Claim::session` 同属一个 lineage。任务没有领取时取 false。
        holder_in_lineage: bool,
    },
}

impl Requester<'_> {
    /// 写进 assignee 的 id：User 恒为 `"USER"`（01 术语）。
    pub fn principal_id(&self) -> &str {
        match self {
            Requester::User => "USER",
            Requester::Agent { agent_id, .. } => agent_id,
        }
    }
}

/// CLAIM_NOT_OWNED 的事实（R1；details 带领取者与是否过期，fix 由服务按 11 P1-3 第 3 条给）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaimNotOwned {
    pub holder_session: String,
    pub holder_agent: Option<String>,
    pub lease_until: Option<Timestamp>,
}

/// R1 `may_modify`：会修改已领取任务的写入（`Operation::guarded_by_claim` 为真的操作、检查项、
/// 进度、复合操作、往任务挂证据或 blocker）在任何写入之前先过它。
pub fn may_modify(
    claim: Claim<'_>,
    requester: Requester<'_>,
    now: Timestamp,
) -> Result<(), ClaimNotOwned> {
    let allowed = match requester {
        // User 的写入不受限；反过来 User 的领取没有 session，对 Agent 也不构成排他锁。
        Requester::User => true,
        Requester::Agent {
            holder_in_lineage, ..
        } => !claim.is_held() || claim.is_stale(now) || holder_in_lineage,
    };
    if allowed {
        Ok(())
    } else {
        Err(ClaimNotOwned {
            holder_session: claim.session.unwrap_or_default().to_owned(),
            holder_agent: claim.assignee.map(str::to_owned),
            lease_until: claim.lease_until,
        })
    }
}

/// claim / start 能否拿到领取。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Acquire {
    /// 任务没有领取。
    Free,
    /// 本 lineage 已持有（R2：后继不需要 takeoverStale）。
    Lineage,
    /// 别人的过期领取，带 takeoverStale 接管。
    TakeOver,
}

/// TASK_ALREADY_CLAIMED 的事实（W-025）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AlreadyClaimed {
    pub holder_session: String,
    pub lease_until: Option<Timestamp>,
    pub stale: bool,
}

/// W-025 + R2。占用按 lineage 判定；User 没有 session，别人（Agent）持有的领取对它同样是占用。
pub fn acquire(
    claim: Claim<'_>,
    requester: Requester<'_>,
    takeover_stale: bool,
    now: Timestamp,
) -> Result<Acquire, AlreadyClaimed> {
    let Some(holder) = claim.session else {
        return Ok(Acquire::Free);
    };
    if let Requester::Agent {
        holder_in_lineage: true,
        ..
    } = requester
    {
        return Ok(Acquire::Lineage);
    }
    let stale = claim.is_stale(now);
    if stale && takeover_stale {
        return Ok(Acquire::TakeOver);
    }
    Err(AlreadyClaimed {
        holder_session: holder.to_owned(),
        lease_until: claim.lease_until,
        stale,
    })
}

/// W-026：IN_PROGRESS 上的 claim 只在「原 assignee 回来接手」时被状态机放行。
/// lineage 只连同一 agent 的 session（R3），所以按 agent id 比较已经覆盖了 R2 的后继。
pub fn is_successor_reclaim(claim: Claim<'_>, requester: Requester<'_>) -> bool {
    claim.assignee == Some(requester.principal_id())
}

/// CLAIM_OWNER_REQUIRED 的事实（W-028）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwnerRequired {
    pub holder_session: Option<String>,
    pub stale: bool,
}

/// release（W-028 + C-08 + R2）。
/// - Agent：无人领取（C-08）、本 lineage 持有（R2）、或别人的过期领取并带 takeoverStale（C-08）；
/// - User：无人领取，或领取已过期。
pub fn may_release(
    claim: Claim<'_>,
    requester: Requester<'_>,
    takeover_stale: bool,
    now: Timestamp,
) -> Result<(), OwnerRequired> {
    let stale = claim.is_stale(now);
    let allowed = !claim.is_held()
        || match requester {
            Requester::User => stale,
            Requester::Agent {
                holder_in_lineage, ..
            } => holder_in_lineage || stale && takeover_stale,
        };
    if allowed {
        Ok(())
    } else {
        Err(OwnerRequired {
            holder_session: claim.session.map(str::to_owned),
            stale,
        })
    }
}

/// R2 的自动转移与续租：本 lineage 对这个任务的一次成功、非 REPLAY 的写入之后，
/// 领取转到写入的 session，租约续到 now + 10 分钟。别人持有或没有领取时不动
/// （没有领取的任务不会因为一次 verify 之类的写入而被领取）。终态任务没有领取（C-03），也不动。
pub fn claim_after_write<'a>(
    claim: Claim<'a>,
    requester: Requester<'a>,
    now: Timestamp,
) -> Option<(&'a str, Timestamp)> {
    match requester {
        Requester::Agent {
            session,
            holder_in_lineage: true,
            ..
        } if claim.is_held() => Some((session, renewed_lease(now))),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(min: i64) -> Timestamp {
        Timestamp::from_millis(min * 60_000)
    }

    #[test]
    fn c22_stale_means_lease_not_after_now() {
        assert!(!is_stale(None, t(100)));
        assert!(!is_stale(Some(t(11)), t(10)));
        assert!(is_stale(Some(t(10)), t(10)));
        assert!(is_stale(Some(t(9)), t(10)));
    }
}
