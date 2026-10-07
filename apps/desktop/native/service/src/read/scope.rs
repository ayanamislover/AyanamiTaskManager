//! 适配层的定位读（W4c / W4d；R11 A3）：省略 project 时按最终生效的 session 推出项目，
//! 写入的 [`crate::work::Target`] 要项目内部 id 而对外参数是项目代码。

use super::{db, locate};
use crate::write::Service;
use atm_domain::capability::{self, Capability};
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::principal::Principal;

/// 一个 session 所在的项目与它的身份字段。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionScope {
    pub session: String,
    /// 项目代码。
    pub project: String,
    pub project_id: String,
    pub agent_id: String,
    pub role: String,
    /// `connection_state` 是 ONLINE。
    pub online: bool,
}

impl Service {
    /// 按 session id 找它所在的项目。TRASHED 项目里的 session 与项目本身一样不可读。
    pub fn session_scope(
        &self,
        principal: &Principal,
        session: &str,
    ) -> Result<SessionScope, DomainError> {
        capability::require(principal, Capability::SessionRead)?;
        let session = session.trim().to_owned();
        let rows = self
            .store()
            .read(|tx| {
                let mut stmt = tx
                    .prepare(
                        "SELECT p.code, s.project_id, s.agent_id, s.role, s.connection_state
                           FROM agent_sessions s JOIN projects p ON p.id = s.project_id
                          WHERE s.id = ?1",
                    )
                    .map_err(db)?;
                let rows = stmt
                    .query_map([&session], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, String>(3)?,
                            r.get::<_, String>(4)?,
                        ))
                    })
                    .map_err(db)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(db)?;
                if let [(code, ..)] = rows.as_slice() {
                    // 与项目读同一套可读性判定（TRASHED 报 PROJECT_DB_UNAVAILABLE）。
                    locate(tx, code)?;
                }
                Ok(rows)
            })
            .map_err(super::read_error)?;
        match rows.as_slice() {
            [] => Err(DomainError::new(
                ErrorCode::SESSION_NOT_FOUND,
                format!("没有 session {session}"),
            )
            .detail("session_id", session.as_str())),
            [(project, project_id, agent_id, role, state)] => Ok(SessionScope {
                session,
                project: project.clone(),
                project_id: project_id.clone(),
                agent_id: agent_id.clone(),
                role: role.clone(),
                online: state == "ONLINE",
            }),
            // session id 是 ULID，正常不会跨项目重复；导入的数据万一撞上，要求调用方显式给 project。
            many => Err(DomainError::new(
                ErrorCode::PROJECT_REQUIRED,
                format!("session {session} 同时出现在多个项目里，请显式传 project"),
            )
            .detail("session_id", session.as_str())
            .detail(
                "candidates",
                many.iter().map(|r| r.0.clone()).collect::<Vec<_>>(),
            )),
        }
    }

    /// owner 的读也续租（R11 P3；02 C-08：没有客户端身份的直连客户端，读也算心跳）：刷新这个 session 的
    /// 心跳，并给它持有的未终态领取续租，与新写入成功之后做的一样（[`crate::rebind`]）。
    /// 只对 Agent 生效；session 不存在或已关闭时什么都不做。这是读路径上唯一的写，失败不影响读的结果，
    /// 由调用方决定是否忽略。
    pub fn touch_session(&self, principal: &Principal, session: &str) -> Result<(), DomainError> {
        if principal.kind() != atm_domain::principal::PrincipalKind::Agent {
            return Ok(());
        }
        capability::require(principal, Capability::SessionRead)?;
        let session = session.trim().to_owned();
        let now = self.clock();
        self.store()
            .write(move |tx| {
                let projects: Vec<String> = {
                    let mut stmt = tx
                        .prepare("SELECT project_id FROM agent_sessions WHERE id = ?1")
                        .map_err(db)?;
                    stmt.query_map([&session], |r| r.get(0))
                        .map_err(db)?
                        .collect::<Result<_, _>>()
                        .map_err(db)?
                };
                // 跨项目重名（只可能来自导入）时不猜。
                if let [project] = projects.as_slice() {
                    crate::rebind::heartbeat(tx, project, &session, now)?;
                }
                Ok(())
            })
            .map_err(|e| match e {
                atm_store::WriteError::Rejected(e) => e,
                other => DomainError::new(ErrorCode::STORE_BUSY, format!("{other:?}")),
            })
    }

    /// 项目代码（不区分大小写）→ 内部 id。不存在报 `PROJECT_NOT_FOUND`，TRASHED 报 `PROJECT_DB_UNAVAILABLE`。
    pub fn project_id(&self, principal: &Principal, project: &str) -> Result<String, DomainError> {
        capability::require(principal, Capability::ProjectRead)?;
        self.store()
            .read(|tx| locate(tx, project).map(|p| p.id))
            .map_err(super::read_error)
    }
}
