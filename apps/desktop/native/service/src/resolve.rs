//! `POST /mcp/resolve` 的服务端（10 R11 A3「什么时候调用 resolve」）：桥在签发缺字段的写调用之前，
//! 在**同一个只读快照**里拿到最终生效的 session 与这次请求会走的分支目标。
//!
//! - 只读：只判定「会创建」，不创建任何东西；失败也不留下任何东西（begin 的项目识别也是只读查找）。
//! - session：显式给的原样核对（不存在、与显式 project 不匹配，报与不经 resolve 时相同的业务错误）；
//!   缺失并且这个 operation 需要 session 时，取连接组的默认 session——只有白名单客户端才有默认值，
//!   否则 `SESSION_REQUIRED`。
//! - 目标：按 [`crate::ops`] 的表与当前状态判定 NONE、EXISTING(scope, generation) 或 CREATE。

use crate::ops::{self, Target, TargetKind};
use crate::receipts::ReceiptScope;
use crate::session::ProjectSelector;
use crate::write::Service;
use atm_domain::capability::{self, Capability};
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::principal::Principal;
use atm_store::ReadError;
use rusqlite::{OptionalExtension, Transaction};
use serde_json::{Value, json};

/// 桥带来的请求：operation 与请求里**显式给出**的字段（桥从不替 begin 等补目标选择器）。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ResolveRequest {
    pub operation: String,
    pub session: Option<String>,
    /// 显式的项目代码。
    pub project: Option<String>,
    /// begin 的选择器与分支开关。
    pub selector: ProjectSelector,
    pub mode: Option<String>,
    pub allow_project_create: bool,
    /// `quick.promote` 的目标项目代码。
    pub target_project: Option<String>,
    /// 连接属于「一个连接一个对话」的白名单客户端（R11 A1）：只有这时才有默认 session。
    pub single_conversation: bool,
}

/// resolve 的结果。
#[derive(Clone, Debug, PartialEq)]
pub struct Resolved {
    /// 最终生效的 session（不需要时为空）。
    pub session: Option<String>,
    /// session 是从连接组的默认值补的（而不是请求里显式给的）。
    pub session_defaulted: bool,
    /// 落到项目时的项目代码。
    pub project: Option<String>,
    pub target: Target,
}

impl Resolved {
    pub fn to_json(&self) -> Value {
        json!({
            "session": self.session,
            "session_defaulted": self.session_defaulted,
            "project": self.project,
            "expected_target": self.target.to_json(),
        })
    }
}

fn db(e: rusqlite::Error) -> DomainError {
    crate::write::internal(e)
}

fn read_error(e: ReadError<DomainError>) -> DomainError {
    match e {
        ReadError::Rejected(e) => e,
        ReadError::Busy => DomainError::new(ErrorCode::STORE_BUSY, "存储繁忙，稍后重试 resolve"),
        other => crate::write::internal(format!("{other:?}")),
    }
}

/// session 所在的项目 (id, code)。session id 跨项目重复（只可能来自导入）时要求显式 project。
fn session_project(
    tx: &Transaction<'_>,
    session: &str,
    project: Option<&str>,
) -> Result<(String, String), DomainError> {
    let rows: Vec<(String, String)> = tx
        .prepare(
            "SELECT p.id, p.code FROM agent_sessions s JOIN projects p ON p.id = s.project_id
              WHERE s.id = ?1 AND (?2 IS NULL OR p.code = ?2)",
        )
        .map_err(db)?
        .query_map(
            rusqlite::params![session, project.map(atm_domain::keys::normalize)],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(db)?
        .collect::<rusqlite::Result<_>>()
        .map_err(db)?;
    match rows.as_slice() {
        [] => Err(match project {
            Some(code) => DomainError::new(
                ErrorCode::SESSION_NOT_FOUND,
                format!("项目 {code} 里没有 session {session}"),
            )
            .detail("project", code),
            None => DomainError::new(
                ErrorCode::SESSION_NOT_FOUND,
                format!("没有 session {session}"),
            ),
        }
        .detail("session_id", session)),
        [(id, code)] => {
            // 与项目读同一套可读性判定（TRASHED 报 PROJECT_DB_UNAVAILABLE）。
            crate::read::locate(tx, code)?;
            Ok((id.clone(), code.clone()))
        }
        many => Err(DomainError::new(
            ErrorCode::PROJECT_REQUIRED,
            format!("session {session} 同时出现在多个项目里，请显式传 project"),
        )
        .detail("session_id", session)
        .detail(
            "candidates",
            many.iter().map(|r| r.1.clone()).collect::<Vec<_>>(),
        )),
    }
}

/// 连接组的默认 session：这个连接组最近用过的 ONLINE **PRIMARY** session（begin 接回、写入都会刷新心跳）。
/// 子代理、复核会话开在同一个连接组里也不会顶替它：它们必须显式带 session（11 P1-2；U-6 子代理场景）。
fn default_session(tx: &Transaction<'_>, group: &str) -> Result<Option<String>, DomainError> {
    tx.query_row(
        "SELECT s.id FROM agent_sessions s JOIN projects p ON p.id = s.project_id
          WHERE s.client_identity = ?1 AND s.connection_state = 'ONLINE' AND s.role = 'PRIMARY'
            AND p.lifecycle <> 'TRASHED'
          ORDER BY COALESCE(s.heartbeat_at, s.started_at) DESC, s.id DESC LIMIT 1",
        [group],
        |r| r.get(0),
    )
    .optional()
    .map_err(db)
}

fn existing_project(tx: &Transaction<'_>, code: &str) -> Result<(String, Target), DomainError> {
    let p = crate::read::locate(tx, code)?;
    Ok((
        p.code,
        Target::Existing {
            scope: ReceiptScope::project(p.id),
            generation: Some(p.generation),
        },
    ))
}

fn knowledge(tx: &Transaction<'_>) -> Result<Target, DomainError> {
    let row: Option<(String, Option<i64>)> = tx
        .query_row(
            "SELECT database_id, scope_gen FROM knowledge_meta",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(db)?;
    // 知识库还没有身份（第一次写入时才建）：没有可比的世代。
    Ok(match row {
        Some((id, generation)) => Target::Existing {
            scope: ReceiptScope::knowledge(id),
            generation,
        },
        None => Target::Existing {
            scope: ReceiptScope::knowledge(""),
            generation: None,
        },
    })
}

impl Service {
    /// 本连接组的默认 session（与写入的 resolve 同一条规则，A1）：给无参的读用，例如上下文压缩后的
    /// `atm_brief()`（11 §4）。是不是白名单里的单对话客户端由调用方判定（`single_conversation`）；
    /// 不是，或者没有连接组身份，就没有默认 session。
    pub fn connection_session(
        &self,
        principal: &Principal,
        single_conversation: bool,
    ) -> Result<Option<String>, DomainError> {
        capability::require(principal, Capability::SessionRead)?;
        let Some(group) = principal.client_group().filter(|_| single_conversation) else {
            return Ok(None);
        };
        let group = group.to_owned();
        self.store()
            .read(move |tx| default_session(tx, &group))
            .map_err(read_error)
    }

    /// 在一个只读快照里判定 session 与分支目标。
    pub fn resolve(
        &self,
        principal: &Principal,
        r: ResolveRequest,
    ) -> Result<Resolved, DomainError> {
        capability::require(principal, Capability::SessionRead)?;
        let Some(op) = ops::find(r.operation.trim()) else {
            return Err(DomainError::new(
                ErrorCode::INVALID_ARGUMENT,
                format!("没有 operation {}", r.operation),
            )
            .detail("field", "operation"));
        };
        let group = principal.client_group().map(str::to_owned);
        self.store()
            .read(move |tx| {
                let is_begin = op.operation == crate::session::BEGIN_OPERATION;
                // ---- session
                let explicit = r
                    .session
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                let (session, defaulted) = match explicit {
                    Some(s) => (Some(s.to_owned()), false),
                    // begin 不取默认 session（A3「begin 的其他约定」）。
                    None if is_begin || !op.agent_needs_session() => (None, false),
                    None => {
                        let found = match (&group, r.single_conversation) {
                            (Some(g), true) => default_session(tx, g)?,
                            _ => None,
                        };
                        match found {
                            Some(s) => (Some(s), true),
                            None => {
                                return Err(DomainError::new(
                                    ErrorCode::SESSION_REQUIRED,
                                    format!(
                                        "{} 需要 session：这个客户端没有可用的默认 session，带上 atm_begin 返回的 session",
                                        op.operation
                                    ),
                                )
                                .detail("operation", op.operation)
                                .detail("field", "session"));
                            }
                        }
                    }
                };
                let from_session = match (&session, is_begin) {
                    (Some(s), false) => Some(session_project(tx, s, r.project.as_deref())?),
                    _ => None,
                };
                // ---- 目标
                let (project, target) = if is_begin {
                    let target = crate::session::begin_target(
                        tx,
                        &r.selector,
                        r.mode.as_deref(),
                        r.allow_project_create,
                    )?;
                    let code = match &target {
                        Target::Existing { scope, .. } => tx
                            .query_row("SELECT code FROM projects WHERE id = ?1", [&scope.id], |x| {
                                x.get(0)
                            })
                            .optional()
                            .map_err(db)?,
                        _ => None,
                    };
                    (code, target)
                } else if op.operation == crate::quick::PROMOTE_OPERATION {
                    match r.target_project.as_deref() {
                        Some(code) => {
                            let (code, t) = existing_project(tx, code)?;
                            (Some(code), t)
                        }
                        None => (None, Target::Create),
                    }
                } else if op.targets == [TargetKind::Create] {
                    (None, Target::Create)
                } else if op.targets == [TargetKind::Knowledge] {
                    (from_session.map(|s| s.1), knowledge(tx)?)
                } else if op.always_none() {
                    (None, Target::None)
                } else {
                    let code = match (&r.project, &from_session) {
                        (_, Some((_, code))) => code.clone(),
                        (Some(code), None) => code.clone(),
                        (None, None) => {
                            return Err(DomainError::new(
                                ErrorCode::PROJECT_REQUIRED,
                                "没有 project，也没有可以推出项目的 session：带上 project 或 session",
                            )
                            .detail("operation", op.operation));
                        }
                    };
                    let (code, t) = existing_project(tx, &code)?;
                    (Some(code), t)
                };
                Ok(Resolved {
                    session,
                    session_defaulted: defaulted,
                    project,
                    target,
                })
            })
            .map_err(read_error)
    }
}
