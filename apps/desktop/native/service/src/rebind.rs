//! 带 session 的写入在执行前的 session 状态判定（02 §2.4 第 5–8 步，S-018～S-021；10 R11 P1-3）。
//!
//! 只在 R3′ 判定为新写入之后才看（S-036：已关闭 session 上成功过的请求照样 REPLAY）：
//! - ONLINE → 用它本身；
//! - 因心跳超时或客户端退出而关闭（`HEARTBEAT_TIMEOUT` / `CLIENT_EXITED`）→ rebind：唯一一条身份一致的 ONLINE
//!   successor 就用它；没有就在**同一个写事务**里新建（写入失败时一起回滚，D20 不留空 successor）；
//! - 其他关闭原因 → `SESSION_CLOSED`。
//!
//! 新写入成功后再记心跳（00 02 C-08：这个 session 的任何写入都刷新心跳），并给它持有的领取续租（10 R2 第 2 种续租）。

use crate::write::internal;
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::ownership::renewed_lease;
use atm_domain::time::Timestamp;
use atm_store::events::{self as store_events, NewEvent};
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::json;

/// 心跳超时的 session 上来了新写入时怎么办。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rebind {
    /// 没有 successor 就新建（项目写入、知识写入，02 C-20）。
    Create,
    /// 只认已有的 successor（`atm_end`，S-021）。
    ExistingOnly,
}

/// rebind 判定看的身份（02 §1.2：不含 cwd，与 resume 的四元组不同，⚠ X-17 的现状照旧）。
#[derive(Clone, Debug, PartialEq, Eq)]
struct Identity {
    agent: String,
    thread: Option<String>,
    parent: Option<String>,
    role: String,
}

fn identity(tx: &Transaction<'_>, project: &str, id: &str) -> rusqlite::Result<Identity> {
    tx.query_row(
        "SELECT agent_id, thread_id, parent_session_id, role FROM agent_sessions WHERE project_id = ?1 AND id = ?2",
        [project, id],
        |r| {
            Ok(Identity {
                agent: r.get(0)?,
                thread: r.get(1)?,
                parent: r.get(2)?,
                role: r.get(3)?,
            })
        },
    )
}

/// 判定这次写入实际用哪个 session。返回 `(session, 是否 rebind)`。
pub(crate) fn effective_session(
    tx: &Transaction<'_>,
    project: &str,
    session: &str,
    rebind: Rebind,
    op_id: &str,
    now: Timestamp,
) -> Result<(String, bool), DomainError> {
    let (state, reason): (String, Option<String>) = tx
        .query_row(
            "SELECT connection_state, close_reason FROM agent_sessions WHERE project_id = ?1 AND id = ?2",
            [project, session],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(internal)?;
    if state != "CLOSED" {
        return Ok((session.to_owned(), false));
    }
    let closed = || {
        DomainError::new(
            ErrorCode::SESSION_CLOSED,
            format!("session {session} 已经结束：先调用 atm_begin 开一个新的 session（可带 predecessor_session_id 接续）"),
        )
        .detail("entity", "SESSION")
        .detail("session_id", session)
        .detail("reference", session)
        .detail("close_reason", reason.clone())
        .detail(
            "next",
            json!({ "operation": "begin", "predecessor_session_id": session, "resume": true }),
        )
    };
    if !matches!(
        reason.as_deref(),
        Some("HEARTBEAT_TIMEOUT" | "CLIENT_EXITED")
    ) {
        return Err(closed());
    }
    let mine = identity(tx, project, session).map_err(internal)?;
    let successors: Vec<String> = tx
        .prepare_cached(
            "SELECT id FROM agent_sessions WHERE project_id = ?1 AND predecessor_session_id = ?2
               AND connection_state = 'ONLINE' ORDER BY started_at DESC, id DESC LIMIT 2",
        )
        .map_err(internal)?
        .query_map([project, session], |r| r.get(0))
        .map_err(internal)?
        .collect::<rusqlite::Result<_>>()
        .map_err(internal)?;
    match successors.as_slice() {
        [_, _] => Err(DomainError::new(
            ErrorCode::SESSION_SUCCESSOR_AMBIGUOUS,
            format!(
                "session {session} 有多个在线的后继，无法判定接到哪一个：显式带上要用的 session"
            ),
        )
        .detail("session_id", session)
        .detail("candidates", successors.clone())
        .detail("resolution", "session")),
        [one] => {
            let theirs = identity(tx, project, one).map_err(internal)?;
            if theirs != mine {
                return Err(identity_mismatch(session, one, &mine, &theirs));
            }
            Ok((one.clone(), true))
        }
        _ if rebind == Rebind::ExistingOnly => Err(closed()),
        _ => create_successor(tx, project, session, &mine, op_id, now).map(|id| (id, true)),
    }
}

fn identity_mismatch(
    session: &str,
    successor: &str,
    mine: &Identity,
    theirs: &Identity,
) -> DomainError {
    DomainError::new(
        ErrorCode::SESSION_SUCCESSOR_IDENTITY_MISMATCH,
        format!("session {session} 的在线后继 {successor} 身份不一致，不能接续"),
    )
    .detail("session_id", session)
    .detail("successor_session_id", successor)
    .detail(
        "expected",
        json!({ "agent_id": mine.agent, "thread_id": mine.thread, "parent_session_id": mine.parent, "role": mine.role }),
    )
    .detail(
        "actual",
        json!({ "agent_id": theirs.agent, "thread_id": theirs.thread, "parent_session_id": theirs.parent, "role": theirs.role }),
    )
}

/// 用旧 session 的身份与 git 上下文新建 successor（02 §2.4 第 7 步），发 `agent.joined`。
fn create_successor(
    tx: &Transaction<'_>,
    project: &str,
    session: &str,
    mine: &Identity,
    op_id: &str,
    now: Timestamp,
) -> Result<String, DomainError> {
    let display: Option<String> = tx
        .query_row(
            "SELECT display_name FROM agents WHERE project_id = ?1 AND id = ?2",
            [project, &mine.agent],
            |r| r.get(0),
        )
        .optional()
        .map_err(internal)?;
    let Some(display) = display else {
        return Err(DomainError::new(
            ErrorCode::SESSION_SUCCESSOR_IDENTITY_MISMATCH,
            format!(
                "session {session} 的 agent {} 不存在，不能新建后继",
                mine.agent
            ),
        )
        .detail("session_id", session)
        .detail("agent_id", mine.agent.as_str()));
    };
    let id = store_events::ulid(tx).map_err(internal)?;
    let at = now.to_string();
    tx.execute(
        "INSERT INTO agent_sessions (project_id, id, agent_id, parent_session_id, thread_id, role, cwd, git_branch, git_head,
           work_state, connection_state, heartbeat_at, version, started_at, updated_at, predecessor_session_id,
           git_repo_root, worktree_root, git_common_dir, git_is_linked_worktree, git_detached, git_dirty, git_available,
           git_error, client_identity)
         SELECT project_id, ?3, agent_id, parent_session_id, thread_id, role, cwd, git_branch, git_head,
           'PLANNING', 'ONLINE', ?4, 0, ?4, ?4, id,
           git_repo_root, worktree_root, git_common_dir, git_is_linked_worktree, git_detached, git_dirty, git_available,
           git_error, client_identity
         FROM agent_sessions WHERE project_id = ?1 AND id = ?2",
        params![project, session, id, at],
    )
    .map_err(internal)?;
    let git: (Option<String>, Option<String>) = tx
        .query_row(
            "SELECT git_branch, git_head FROM agent_sessions WHERE project_id = ?1 AND id = ?2",
            [project, &id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(internal)?;
    let payload = json!({
        "agentId": mine.agent,
        "displayName": display,
        "role": mine.role,
        "parentSessionId": mine.parent,
        "resume": true,
        "predecessorSessionId": session,
        "rebind": true,
        "git": { "branch": git.0, "head": git.1 },
    })
    .to_string();
    store_events::append_event(
        tx,
        &NewEvent {
            project_id: project,
            kind: "agent.joined",
            actor_type: "AGENT",
            actor_id: &mine.agent,
            session_id: Some(&id),
            aggregate_type: "SESSION",
            aggregate_id: &id,
            correlation_id: None,
            op_id: Some(op_id),
            payload_json: &payload,
            at: &at,
        },
    )
    .map_err(|e| internal(format!("{e:?}")))?;
    Ok(id)
}

/// 新写入成功之后：刷新心跳（不推 session 版本，心跳不是 session 内容的变化），并给这个 session 持有的未终态领取续租。
pub(crate) fn heartbeat(
    tx: &Transaction<'_>,
    project: &str,
    session: &str,
    now: Timestamp,
) -> Result<(), DomainError> {
    let at = now.to_string();
    let online = tx
        .execute(
            "UPDATE agent_sessions SET heartbeat_at = ?3 WHERE project_id = ?1 AND id = ?2 AND connection_state = 'ONLINE'",
            params![project, session, at],
        )
        .map_err(internal)?;
    // 这次写入把 session 关掉了（atm_end）：关闭的 session 没有心跳，也不续租。
    if online == 0 {
        return Ok(());
    }
    tx.execute(
        "UPDATE work_items SET claim_lease_until = ?3
         WHERE project_id = ?1 AND claimed_by_session_id = ?2 AND status NOT IN ('DONE', 'CANCELLED')
           AND claim_lease_until IS NOT NULL AND claim_lease_until < ?3",
        params![project, session, renewed_lease(now).to_string()],
    )
    .map_err(internal)?;
    Ok(())
}
