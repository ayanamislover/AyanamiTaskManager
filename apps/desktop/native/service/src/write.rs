//! 写入流水线：落点固定的 operation 都走这里（03 P-004；10 R3′、R4）。
//!
//! 顺序是定死的，每一步都在前一步通过之后才做：
//! 1. **能力检查**（P-004）：先于读库、先于回执重放、先于任何副作用。被拒绝的调用连存储都不碰。
//! 2. **入队世代**（R4）：记下目标范围此刻的 scope generation（调用方显式给了就用它）。
//! 3. **同一个写事务里**：
//!    1. 确定命名空间与 lineage，按 R3′ 收候选、裁决。REPLAY 原样返回保存的结果；UNDONE、CONFLICT 报错。
//!       这一步在世代屏障之前：已经提交过的请求，即使范围后来被恢复，重试也得到 REPLAY 或 UNDONE，而不是 SCOPE_RESTORED。
//!    2. 只有新写入才过**世代屏障**：入队后范围被恢复过就报 SCOPE_RESTORED。
//!    3. 执行业务动作，在同一事务里写回执（canon-v2）。
//!
//! 业务动作返回 `Err` 时整个事务回滚：拒绝、撤销、冲突都是零写入。

use crate::fp::{self, JsValue};
use crate::lineage::lineage;
pub use crate::rebind::Rebind;
use crate::receipts::{
    self, Candidate, CandidateSummary, ConflictReason, FixedLookup, LegacyProbe, NewReceipt, Ns,
    Rebuilt, ReceiptScope, ScopeKind, Verdict,
};
use atm_domain::capability::{self, Capability};
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::principal::{Principal, PrincipalKind};
use atm_domain::time::Timestamp;
use atm_store::restore::{ScopeRef, current_generation};
use atm_store::{ReadError, Store, WriteError};
use rusqlite::{OptionalExtension, Transaction};
use serde_json::{Value, json};
use std::time::{SystemTime, UNIX_EPOCH};

/// 指纹族（回执行的 `fp_family`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Family {
    KernelV1,
    KnowledgeV1,
    CanonV2,
}

impl Family {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "kernel-v1" => Some(Family::KernelV1),
            "knowledge-v1" => Some(Family::KnowledgeV1),
            "canon-v2" => Some(Family::CanonV2),
            _ => None,
        }
    }
}

/// 重建指纹时用的作者：候选保存的原作者，或这次请求自己的作者。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Author {
    pub agent: Option<String>,
    pub session: Option<String>,
}

/// 这次请求在某个指纹族下、以某个作者身份的指纹输入（业务字段，已规范化，不含定位与控制字段）。
/// `None`：这个族表达不了这次请求（A3 的可比性检查），与该族的候选不是同一请求。
/// canon-v2 必须总能表达。
///
/// 事务参数用于只读的规范化（W-012：证据里的 atm_record / atm_task 引用改写成规范 key）。规范化失败时
/// 退回原样（02 §3.3，与 2.x 的 session 闸门一致），由业务动作报出准确的错误。
pub type FpInput = Box<dyn Fn(&Transaction<'_>, Family, &Author) -> Option<JsValue> + Send>;

/// 重放之前再做的校验（02 §3.3 唯一的兼容请求：checklist.update 的旧形状不含 taskKey，重放前确认检查项
/// 仍属于请求给的任务）。返回 Err 时不重放，原样报错。
pub type ReplayGuard = Box<dyn Fn(&Transaction<'_>) -> Result<(), DomainError> + Send>;

/// Agent 的 session。sessions 按项目划分，所以带项目。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionRef {
    pub project_id: String,
    pub session_id: String,
}

pub struct WriteRequest {
    pub capability: Capability,
    pub operation: &'static str,
    pub op_id: String,
    /// 回执落在哪个范围；落点固定的 operation 由请求就能确定。
    pub scope: ReceiptScope,
    /// 只有 Agent 有。
    pub session: Option<SessionRef>,
    /// 无 session 的 Agent 写入自报的 actor（只是归属标签，不是凭据）。
    pub actor: Option<String>,
    /// 调用上下文里带着的世代；没有时按入队时刻记（R4）。
    pub expected_generation: Option<i64>,
    pub fingerprint: FpInput,
    /// kernel-v1 下另一个也算同一请求的形状（02 §3.3 的兼容请求）；没有就是 None。
    pub compat_v1: Option<FpInput>,
    pub replay_guard: Option<ReplayGuard>,
    /// session 因心跳超时关闭时：新建 successor，还是只认已有的（02 §2.4）。
    pub rebind: Rebind,
}

/// 写入者：已经由可信入口与 session 解析确定，业务动作直接用。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Actor {
    pub kind: PrincipalKind,
    /// 事件的 actor_type：`USER` / `AGENT` / `SYSTEM`。Phone 的写入记作 `USER`，actor_id 带设备（03 C-05）。
    pub event_type: &'static str,
    /// 事件的 actor_id，也是写进 assignee 的 id：Agent 是 agent_id，User 是 `USER`，
    /// Phone 是 `PHONE:<device>`，System 是 `SYSTEM`。
    pub id: String,
    pub session: Option<String>,
    /// session 所在 lineage 的全部成员（含自己），无 session 时为空（R2、R3）。
    pub lineage: Vec<String>,
}

impl Actor {
    pub fn in_lineage(&self, session: &str) -> bool {
        self.lineage.iter().any(|m| m == session)
    }
}

/// 业务动作看到的上下文。
#[derive(Clone, Debug)]
pub struct WriteCtx {
    pub scope: ReceiptScope,
    pub generation: Option<i64>,
    pub author: Author,
    pub actor: Actor,
    pub op_id: String,
    pub now: Timestamp,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Written {
    /// 新写入是业务动作的结果；重放是保存的回执原文。
    pub result: Value,
    pub replayed: bool,
    pub receipt_id: i64,
    /// 这次写入被 rebind 到了哪个 session（02 §2.4 REBOUND；ACK 的 `session_rebound`）。
    pub rebound_to: Option<String>,
}

pub struct Service {
    store: Store,
}

impl Service {
    pub fn new(store: Store) -> Self {
        Service { store }
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    /// 执行一次落点固定的写入，见模块说明。
    pub fn write<A>(
        &self,
        principal: &Principal,
        req: WriteRequest,
        action: A,
    ) -> Result<Written, DomainError>
    where
        A: FnOnce(&Transaction<'_>, &WriteCtx) -> Result<Value, DomainError> + Send + 'static,
    {
        capability::require(principal, req.capability)?;
        let actor_ns = admit(principal, &req)?;
        let seed = actor_seed(principal, &req);
        let enqueued = match req.expected_generation {
            Some(g) => Some(g),
            None => self
                .store
                .read(|tx| generation(tx, &req.scope))
                .map_err(read_error)?,
        };
        self.store
            .write(move |tx| run(tx, req, actor_ns, seed, enqueued, action))
            .map_err(write_error)
    }
}

/// 无 session 的写入者，以及 Agent 写入者的种类；session 与 lineage 在事务里补。
fn actor_seed(principal: &Principal, req: &WriteRequest) -> Actor {
    let kind = principal.kind();
    let (event_type, id) = match kind {
        PrincipalKind::User => ("USER", "USER".to_owned()),
        PrincipalKind::System => ("SYSTEM", "SYSTEM".to_owned()),
        PrincipalKind::Phone => (
            "USER",
            format!("PHONE:{}", principal.phone().map_or("", |p| p.1)),
        ),
        PrincipalKind::Agent => (
            "AGENT",
            req.actor.clone().unwrap_or_else(|| "AGENT_ANON".to_owned()),
        ),
    };
    Actor {
        kind,
        event_type,
        id,
        session: None,
        lineage: Vec::new(),
    }
}

/// 不碰存储就能判定的入参问题；返回无 session 写入的 ACTOR 命名空间。
fn admit(principal: &Principal, req: &WriteRequest) -> Result<Option<Ns>, DomainError> {
    if req.op_id.is_empty() {
        return Err(
            DomainError::new(ErrorCode::INVALID_ARGUMENT, "op_id 不能为空")
                .detail("field", "op_id"),
        );
    }
    let kind = principal.kind();
    if kind != PrincipalKind::Agent && req.session.is_some() {
        return Err(DomainError::new(
            ErrorCode::INVALID_ARGUMENT,
            "只有 Agent 的写入可以带 session",
        )
        .detail("field", "session"));
    }
    if req.session.is_some() {
        return Ok(None);
    }
    if kind == PrincipalKind::Agent && req.capability.grant().agent_needs_session {
        return Err(DomainError::new(
            ErrorCode::SESSION_REQUIRED,
            format!(
                "{} 需要 session：先调用 atm_begin，再带上返回的 session",
                req.operation
            ),
        )
        .detail("operation", req.operation));
    }
    // 3.0 的 ACTOR 命名空间。Agent 的加 `AGENT:` 前缀，与 User 的 `USER`、转换来的 2.x 常量互不相交。
    let id = match kind {
        PrincipalKind::User => "USER".to_owned(),
        PrincipalKind::System => "SYSTEM".to_owned(),
        PrincipalKind::Phone => format!("PHONE:{}", principal.phone().map_or("", |p| p.1)),
        PrincipalKind::Agent => format!("AGENT:{}", req.actor.as_deref().unwrap_or("AGENT_ANON")),
    };
    Ok(Some(Ns::actor(id)))
}

/// 范围当前的世代（沿用存储层的 R4 定义）。GLOBAL 没有世代；范围不存在时也是 None。
pub fn generation(tx: &Transaction<'_>, scope: &ReceiptScope) -> rusqlite::Result<Option<i64>> {
    match scope.kind {
        ScopeKind::Project => current_generation(tx, ScopeRef::Project(&scope.id)),
        ScopeKind::Knowledge => current_generation(tx, ScopeRef::Knowledge),
        ScopeKind::Global => Ok(None),
    }
}

fn now() -> Timestamp {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    Timestamp::from_millis(i64::try_from(ms).unwrap_or(i64::MAX))
}

pub(crate) fn internal(e: impl std::fmt::Display) -> DomainError {
    DomainError::new(ErrorCode::INTERNAL_ERROR, format!("服务内部错误：{e}"))
}

fn run<A>(
    tx: &Transaction<'_>,
    req: WriteRequest,
    actor_ns: Option<Ns>,
    mut actor: Actor,
    enqueued: Option<i64>,
    action: A,
) -> Result<Written, DomainError>
where
    A: FnOnce(&Transaction<'_>, &WriteCtx) -> Result<Value, DomainError>,
{
    let WriteRequest {
        operation,
        op_id,
        scope,
        session,
        fingerprint,
        compat_v1,
        replay_guard,
        rebind,
        ..
    } = req;
    let now = now();
    let (own, others, legacy, author) = match (&session, actor_ns) {
        (Some(s), _) => {
            let agent: Option<String> =
                if scope.kind == ScopeKind::Project && s.project_id != scope.id {
                    None
                } else {
                    tx.query_row(
                        "SELECT agent_id FROM agent_sessions WHERE project_id = ?1 AND id = ?2",
                        [&s.project_id, &s.session_id],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(internal)?
                };
            let Some(agent) = agent else {
                return Err(DomainError::new(
                    ErrorCode::SESSION_NOT_FOUND,
                    format!("项目 {} 里没有 session {}", s.project_id, s.session_id),
                )
                .detail("project_id", s.project_id.as_str())
                .detail("session_id", s.session_id.as_str()));
            };
            let members = lineage(tx, &s.project_id, &s.session_id).map_err(internal)?;
            let others = members
                .iter()
                .filter(|m| **m != s.session_id)
                .map(Ns::session)
                .collect();
            // 2.x 知识库 Agent 的旧键：lineage 里每个 session 各一个（R3′ 第 2 步）。
            let legacy = if scope.kind == ScopeKind::Knowledge {
                members
                    .iter()
                    .map(|m| LegacyProbe {
                        key: fp::knowledge_agent_legacy_key(&s.project_id, m, &op_id),
                        session: Some(m.clone()),
                        own: *m == s.session_id,
                    })
                    .collect()
            } else {
                Vec::new()
            };
            actor.id = agent.clone();
            actor.session = Some(s.session_id.clone());
            actor.lineage = members;
            let author = Author {
                agent: Some(agent),
                session: Some(s.session_id.clone()),
            };
            (Ns::session(s.session_id.clone()), others, legacy, author)
        }
        (None, Some(ns)) => {
            // 2.x 知识库的 User 写入以 op_id 原值为键。
            let legacy = if scope.kind == ScopeKind::Knowledge && ns.id == "USER" {
                vec![LegacyProbe {
                    key: op_id.clone(),
                    session: None,
                    own: true,
                }]
            } else {
                Vec::new()
            };
            (ns, Vec::new(), legacy, Author::default())
        }
        (None, None) => return Err(internal("namespace")),
    };

    let lookup = FixedLookup {
        scope: &scope,
        op_id: &op_id,
        operation,
        own: own.clone(),
        others,
        legacy,
    };
    let rebuild = |c: &Candidate| rebuild(tx, c, &fingerprint, compat_v1.as_ref());
    match receipts::find_fixed(tx, &lookup, &rebuild).map_err(internal)? {
        Verdict::New => {}
        Verdict::Replay(c) => {
            if let Some(guard) = &replay_guard {
                guard(tx)?;
            }
            let result = serde_json::from_str(&c.receipt_json).map_err(internal)?;
            return Ok(Written {
                result,
                replayed: true,
                receipt_id: c.receipt_id,
                rebound_to: None,
            });
        }
        Verdict::Undone { generation } => {
            return Err(DomainError::new(
                ErrorCode::OPERATION_UNDONE_BY_RESTORE,
                "这个 op_id 的写入已被一次按范围恢复撤销：先重新读取当前状态，再决定是否用新的 op_id 重做",
            )
            .detail("op_id", op_id.as_str())
            .detail("restored_generation", generation));
        }
        Verdict::Conflict { reason, candidates } => {
            return Err(conflict(&op_id, &reason, &candidates));
        }
    }

    // 02 §2.4 第 5–8 步：新写入才看 session 状态；心跳超时的旧 session 换成它的 successor。
    let (own, author, rebound_to) = match &session {
        Some(s) => {
            let (effective, rebound) = crate::rebind::effective_session(
                tx,
                &s.project_id,
                &s.session_id,
                rebind,
                &op_id,
                now,
            )?;
            if rebound {
                actor.session = Some(effective.clone());
                actor.lineage = lineage(tx, &s.project_id, &effective).map_err(internal)?;
                let author = Author {
                    agent: author.agent,
                    session: Some(effective.clone()),
                };
                (Ns::session(effective.clone()), author, Some(effective))
            } else {
                (own, author, None)
            }
        }
        None => (own, author, None),
    };

    // R4：只有新写入才看世代。
    let current = generation(tx, &scope).map_err(internal)?;
    if enqueued.is_some() && enqueued != current {
        return Err(DomainError::new(
            ErrorCode::SCOPE_RESTORED,
            "目标范围在这次请求发出之后被恢复过：先重新读取，再决定是否重做",
        )
        .detail(
            "scope",
            json!({ "kind": scope.kind.as_str(), "id": scope.id }),
        )
        .detail("expected_generation", enqueued)
        .detail("current_generation", current));
    }

    let own_input =
        fingerprint(tx, Family::CanonV2, &author).ok_or_else(|| internal("canon-v2 input"))?;
    let own_fp = fp::canon_v2(&own_input);
    let ctx = WriteCtx {
        scope,
        generation: current,
        author,
        actor,
        op_id,
        now,
    };
    let result = action(tx, &ctx)?;
    if let (Some(s), Some(effective)) = (&session, ctx.actor.session.as_deref()) {
        crate::rebind::heartbeat(tx, &s.project_id, effective, now)?;
    }
    let receipt_json = serde_json::to_string(&result).map_err(internal)?;
    let created_at = ctx.now.to_string();
    let receipt_id = receipts::insert(
        tx,
        &NewReceipt {
            scope: &ctx.scope,
            ns: Some(&own),
            call: None,
            op_id: &ctx.op_id,
            operation,
            fingerprint: &own_fp,
            receipt_json: &receipt_json,
            author_agent: ctx.author.agent.as_deref(),
            author_session: ctx.author.session.as_deref(),
            actor_session_id: ctx.author.session.as_deref(),
            scope_generation: ctx.generation,
            created_at: &created_at,
        },
    )
    .map_err(internal)?;
    Ok(Written {
        result,
        replayed: false,
        receipt_id,
        rebound_to,
    })
}

/// R3′ 第 4 步：按候选自己的族与原作者重建这次请求的指纹。
fn rebuild(
    tx: &Transaction<'_>,
    c: &Candidate,
    fingerprint: &FpInput,
    compat_v1: Option<&FpInput>,
) -> Rebuilt {
    let Some(family) = Family::parse(&c.fp_family) else {
        return Rebuilt::NotComparable;
    };
    let author = match family {
        Family::CanonV2 => Author {
            agent: c.author_agent.clone(),
            session: c.author_session.clone(),
        },
        Family::KernelV1 => Author {
            agent: None,
            session: c.actor_session_id.clone(),
        },
        Family::KnowledgeV1 => Author {
            agent: None,
            session: c.via_session.clone(),
        },
    };
    let Some(input) = fingerprint(tx, family, &author) else {
        return Rebuilt::NotComparable;
    };
    match family {
        Family::KernelV1 => match fp::kernel_v1(&input) {
            Ok(f) => {
                let compat = compat_v1
                    .and_then(|compat| compat(tx, family, &author))
                    .and_then(|v| fp::kernel_v1(&v).ok());
                match compat {
                    Some(other) => Rebuilt::AnyOf(vec![f, other]),
                    None => Rebuilt::Fingerprint(f),
                }
            }
            Err(e) => Rebuilt::Unsupported(e.key),
        },
        Family::KnowledgeV1 => Rebuilt::Fingerprint(fp::knowledge_v1(&input)),
        Family::CanonV2 => Rebuilt::Fingerprint(fp::canon_v2(&input)),
    }
}

fn conflict(op_id: &str, reason: &ConflictReason, candidates: &[CandidateSummary]) -> DomainError {
    let message = match reason {
        ConflictReason::Mismatch | ConflictReason::AmbiguousLegacy => {
            "这个 op_id 已经用于另一个不同的请求：重试原请求请原样重发，新请求换一个新的 op_id".to_owned()
        }
        ConflictReason::AmbiguousLineage => {
            "同一 lineage 的多个 session 用这个 op_id 写过不同的结果，无法判定是哪一次：换一个新的 op_id".to_owned()
        }
        ConflictReason::FpV1UnsupportedKey(key) => format!(
            "这个 op_id 对应一条 2.x 的旧回执，字段名 {key} 无法按旧算法复现，不能确认是同一请求：换一个新的 op_id"
        ),
    };
    let mut e = DomainError::new(ErrorCode::IDEMPOTENCY_CONFLICT, message).detail("op_id", op_id);
    if let Some(code) = reason.code() {
        e = e.detail("reason", code);
    }
    if let ConflictReason::FpV1UnsupportedKey(key) = reason {
        e = e.detail("key", key.as_str());
    }
    if candidates.len() > 1 {
        let list: Vec<Value> = candidates
            .iter()
            .map(|c| json!({ "session": c.session, "state": c.state }))
            .collect();
        e = e.detail("candidates", list);
    }
    e
}

fn read_error(e: ReadError<rusqlite::Error>) -> DomainError {
    match e {
        ReadError::Busy => {
            DomainError::new(ErrorCode::STORE_BUSY, "存储繁忙，稍后用同一个 op_id 重试")
        }
        other => internal(format!("{other:?}")),
    }
}

fn write_error(e: WriteError<DomainError>) -> DomainError {
    match e {
        WriteError::Rejected(e) => e,
        WriteError::Busy => {
            DomainError::new(ErrorCode::STORE_BUSY, "存储繁忙，稍后用同一个 op_id 重试")
        }
        WriteError::Closed => DomainError::new(
            ErrorCode::SERVICE_UNAVAILABLE,
            "服务正在关闭，稍后用同一个 op_id 重试",
        ),
        other => internal(format!("{other:?}")),
    }
}
