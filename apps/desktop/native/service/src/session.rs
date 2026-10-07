//! Session 生命周期（02 §1.1–§2.9；00 02 C-06、C-07、C-08、C-14、C-17；10 R3、R4′、R11 A1、A3 与 P1-3）。
//!
//! - **begin**：落点取决于服务端状态，走调用索引（A3），不经落点固定的流水线；撞上 TRASHED 项目时登记恢复请求
//!   **并提交**，再报 `PROJECT_DB_UNAVAILABLE`（S-003），所以自己管事务。
//! - **end / 强制关闭**：经写入流水线。end 不建 successor（S-021）。
//! - **超时扫描**：System 的周期作业（C-08），有客户端身份时看进程存活（R11 P1-3）。
//! - **git 上下文**：探测（IO）在服务之外，这里只按 S-022 写入。

use crate::fp::{self, JsValue};
use crate::ops::Target as Branch;
use crate::receipts::{self, CallKey, Candidate, NewReceipt, Rebuilt, ReceiptScope, Verdict};
use crate::work::Target;
use crate::write::{
    Author, Family, FpInput, Rebind, Service, SessionRef, WriteCtx, WriteRequest, Written, internal,
};
use atm_domain::capability::{self, Capability};
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::keys;
use atm_domain::principal::Principal;
use atm_domain::text::{js_trim, utf16_len};
use atm_domain::time::Timestamp;
use atm_store::events::{self as store_events, NewEvent};
use atm_store::{ReadError, WriteError};
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Map, Value, json};
use std::time::{SystemTime, UNIX_EPOCH};

pub const BEGIN_OPERATION: &str = "session.recover-or-begin";
pub const END_OPERATION: &str = "session.end";
pub const FORCE_CLOSE_OPERATION: &str = "session.force-close";

fn now() -> Timestamp {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    Timestamp::from_millis(i64::try_from(ms).unwrap_or(i64::MAX))
}

fn db(e: rusqlite::Error) -> DomainError {
    internal(e)
}

// ---------- 入参 ----------

/// 服务之外探测到的 git 上下文（02 §1.2；三值布尔：None = 未知）。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GitContext {
    pub available: bool,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub repo_root: Option<String>,
    pub worktree_root: Option<String>,
    pub common_dir: Option<String>,
    pub is_linked_worktree: Option<bool>,
    pub detached: Option<bool>,
    pub dirty: Option<bool>,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resume {
    /// R11 P1-3：默认。只接续客户端已退出、心跳超时、或带待确认交接关闭的同 agent / role / cwd session。
    Auto,
    /// 2.x 的 `resume:true`。
    Yes,
    /// 2.x 的 `resume:false`：总是新建。
    No,
}

impl Resume {
    fn as_str(self) -> &'static str {
        match self {
            Resume::Auto => "auto",
            Resume::Yes => "true",
            Resume::No => "false",
        }
    }
}

/// begin 的项目选择器：显式代码，或由 cwd 识别（路径键、marker、git common dir 都在服务外算好）。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProjectSelector {
    pub code: Option<String>,
    /// realpath 后去掉末尾分隔符、按 Windows 规则大小写折叠的路径键（04 C-L09）。
    pub path_key: Option<String>,
    /// cwd 里 marker 指向的项目 id（04 L-010）。
    pub marker_project_id: Option<String>,
    pub git_common_dir: Option<String>,
    /// realpath 之后的 cwd（begin ④ 建项目时登记成项目目录；唯一键由服务按 `atm_store::paths::path_key` 算）。
    /// 省略时用 cwd 原样。
    pub canonical_path: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BeginRequest {
    pub selector: ProjectSelector,
    pub cwd: Option<String>,
    pub title: Option<String>,
    /// `auto` / `project` / `quick`。
    pub mode: Option<String>,
    pub agent_id: String,
    pub display_name: Option<String>,
    pub client_kind: Option<String>,
    pub parent_session_id: Option<String>,
    pub thread_id: Option<String>,
    /// `PRIMARY` / `SUBAGENT` / `REVIEWER` / `OBSERVER`，缺省 PRIMARY。
    pub role: Option<String>,
    /// 请求里自报的分支与提交；git 探测可用时以探测值为准。
    pub git_branch: Option<String>,
    pub git_head: Option<String>,
    pub git: Option<GitContext>,
    /// None：调用方没给（按 `auto` 执行；与 2.x 旧回执比较时按 2.x 的缺省值 false 重建，R11 A3）。
    pub resume: Option<Resume>,
    /// R11 A1 优先级 1：显式接回这个 session（outcome `CURRENT`）。与 `predecessor_session_id` 互斥。
    pub session: Option<String>,
    pub predecessor_session_id: Option<String>,
    /// 2.x 的 `signals`（只含调用方给出的键）。
    pub signals: Map<String, Value>,
    pub allow_project_create: bool,
    pub creation_reason: Option<String>,
    /// R11 A1：连接属于「一个连接一个对话」的白名单客户端（桥判定）。只有这时才做同连接组接回。
    pub single_conversation: bool,
    /// 省略时不幂等（2.x 的非原子 begin）；桥总会签发一个（R11 A3）。
    pub op_id: Option<String>,
    /// 显式的 `expected_scope_generation`（A3 控制字段）：落到已有项目时世代必须仍是它。
    pub expected_generation: Option<i64>,
    /// 桥 resolve 时判定的分支目标（A3 的 expected_target）：新写入执行前按当前状态重新判定并对照。
    pub expected_target: Option<crate::ops::Target>,
}

impl BeginRequest {
    pub fn new(agent_id: impl Into<String>) -> Self {
        BeginRequest {
            selector: ProjectSelector::default(),
            cwd: None,
            title: None,
            mode: None,
            agent_id: agent_id.into(),
            display_name: None,
            client_kind: None,
            parent_session_id: None,
            thread_id: None,
            role: None,
            git_branch: None,
            git_head: None,
            git: None,
            resume: None,
            session: None,
            predecessor_session_id: None,
            signals: Map::new(),
            allow_project_create: false,
            creation_reason: None,
            single_conversation: false,
            op_id: None,
            expected_generation: None,
            expected_target: None,
        }
    }
}

const ROLES: [&str; 4] = ["PRIMARY", "SUBAGENT", "REVIEWER", "OBSERVER"];

fn invalid(field: &str, message: impl Into<String>) -> DomainError {
    DomainError::new(ErrorCode::INVALID_ARGUMENT, message).detail("field", field)
}

fn bounded(field: &str, value: Option<&str>, max: usize) -> Result<(), DomainError> {
    if let Some(v) = value
        && utf16_len(js_trim(v)) > max
    {
        return Err(invalid(field, format!("{field} 最多 {max} 个字符")).detail("max", max));
    }
    Ok(())
}

/// 规范化之后的 begin（trim、默认值）。
#[derive(Clone, Debug)]
struct Begin {
    req: BeginRequest,
    agent: String,
    display: String,
    client_kind: String,
    role: String,
    op_id: Option<String>,
    /// R11 P1-2：客户端身份（父进程 pid:创建时间）。取自可信入口给的 Principal（连接组），不由请求自报。
    client_identity: Option<String>,
}

impl Begin {
    fn resume(&self) -> Resume {
        self.req.resume.unwrap_or(Resume::Auto)
    }
}

fn opt_trim(v: &Option<String>) -> Option<String> {
    v.as_deref().map(|s| js_trim(s).to_owned())
}

fn normalize(req: BeginRequest, client_identity: Option<String>) -> Result<Begin, DomainError> {
    let agent = js_trim(&req.agent_id).to_owned();
    if agent.is_empty() || utf16_len(&agent) > 128 {
        return Err(invalid("agent_id", "agent_id 必须是 1 至 128 个字符"));
    }
    let role = req
        .role
        .as_deref()
        .map_or("PRIMARY".to_owned(), |r| js_trim(r).to_uppercase());
    if !ROLES.contains(&role.as_str()) {
        return Err(
            invalid("role", format!("role 只能是 {}", ROLES.join(" / ")))
                .detail("got", role.as_str())
                .detail("allowed", ROLES.to_vec()),
        );
    }
    // S-001：op_id trim 后 1–128。
    let op_id = match &req.op_id {
        Some(op) => {
            let t = js_trim(op);
            if t.is_empty() || utf16_len(t) > 128 {
                return Err(DomainError::new(
                    ErrorCode::OPERATION_ID_INVALID,
                    "op_id 去掉首尾空白后必须是 1 至 128 个字符",
                )
                .detail("field", "op_id"));
            }
            Some(t.to_owned())
        }
        None => None,
    };
    bounded("thread_id", req.thread_id.as_deref(), 256)?;
    bounded("display_name", req.display_name.as_deref(), 200)?;
    bounded("title", req.title.as_deref(), 400)?;
    if let Some(m) = req.mode.as_deref()
        && !["auto", "project", "quick"].contains(&js_trim(m).to_lowercase().as_str())
    {
        return Err(invalid("mode", "mode 只能是 auto / project / quick").detail("got", m));
    }
    // R11 A3：接回（session）与接续（predecessor）是两件事，同时给出说明调用方没想清楚。
    if req.session.is_some() && req.predecessor_session_id.is_some() {
        return Err(invalid(
            "session",
            "session（接回这个 session）与 predecessor_session_id（新建它的后继）只能给一个",
        )
        .detail("conflicts_with", "predecessor_session_id"));
    }
    let display = opt_trim(&req.display_name)
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| agent.clone());
    let client_kind = opt_trim(&req.client_kind)
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| "generic".to_owned());
    Ok(Begin {
        agent,
        display,
        client_kind,
        role,
        op_id,
        client_identity,
        req,
    })
}

// ---------- begin 的指纹 ----------

fn nullable(v: Option<&str>) -> Value {
    v.map_or(Value::Null, |s| Value::String(js_trim(s).to_owned()))
}

/// canon-v2：全部业务字段（不含 git 探测、客户端身份等定位与环境信息，A3）。
/// kernel-v1：02 §3.4 的 `session.recover-or-begin` 形状，全部键都在；省略的 resume 按 2.x 缺省值 false 重建。
fn begin_fp(b: &Begin, family: Family) -> Option<JsValue> {
    let r = &b.req;
    let v = match family {
        Family::CanonV2 => json!({
            "project": r.selector.code.as_deref().map(keys::normalize),
            "cwd": nullable(r.cwd.as_deref()),
            "title": nullable(r.title.as_deref()),
            "mode": r.mode.as_deref().map_or("auto".to_owned(), |m| js_trim(m).to_lowercase()),
            "agent_id": b.agent,
            "display_name": b.display,
            "client_kind": b.client_kind,
            "parent_session_id": nullable(r.parent_session_id.as_deref()),
            "thread_id": nullable(r.thread_id.as_deref()),
            "role": b.role,
            "git_branch": nullable(r.git_branch.as_deref()),
            "git_head": nullable(r.git_head.as_deref()),
            "resume": b.resume().as_str(),
            "session": nullable(r.session.as_deref()),
            "predecessor_session_id": nullable(r.predecessor_session_id.as_deref()),
            "signals": r.signals,
            "allow_project_create": r.allow_project_create,
            "creation_reason": nullable(r.creation_reason.as_deref()),
        }),
        Family::KernelV1 => {
            // 显式 session 在 2.x 的 DTO 里无法表达，显式 auto 也没有对应值：与旧行不可比（R11 A3 可比性检查）。
            if r.session.is_some() {
                return None;
            }
            let resume = match r.resume {
                Some(Resume::Auto) => return None,
                Some(Resume::Yes) => true,
                Some(Resume::No) | None => false,
            };
            json!({
                "projectCode": nullable(r.selector.code.as_deref()),
                "cwd": nullable(r.cwd.as_deref()),
                "title": nullable(r.title.as_deref()),
                "mode": r.mode.as_deref().map_or("auto".to_owned(), |m| js_trim(m).to_owned()),
                "agentId": b.agent,
                "displayName": b.display,
                "clientKind": b.client_kind,
                "parentSessionId": nullable(r.parent_session_id.as_deref()),
                "threadId": nullable(r.thread_id.as_deref()),
                "role": b.role,
                "gitBranch": nullable(r.git_branch.as_deref()),
                "gitHead": nullable(r.git_head.as_deref()),
                "resume": resume,
                "predecessorSessionId": nullable(r.predecessor_session_id.as_deref()),
                "signals": r.signals,
                "allowProjectCreate": r.allow_project_create,
                "creationReason": nullable(r.creation_reason.as_deref()),
            })
        }
        Family::KnowledgeV1 => return None,
    };
    Some(JsValue::from_json(&v))
}

fn rebuilt(b: &Begin, c: &Candidate) -> Rebuilt {
    let Some(family) = Family::parse(&c.fp_family) else {
        return Rebuilt::NotComparable;
    };
    let Some(input) = begin_fp(b, family) else {
        return Rebuilt::NotComparable;
    };
    match family {
        Family::KernelV1 => match fp::kernel_v1(&input) {
            Ok(f) => Rebuilt::Fingerprint(f),
            Err(e) => Rebuilt::Unsupported(e.key),
        },
        Family::CanonV2 => Rebuilt::Fingerprint(fp::canon_v2(&input)),
        Family::KnowledgeV1 => Rebuilt::NotComparable,
    }
}

// ---------- 项目定位 ----------

struct Project {
    id: String,
    code: String,
    name: String,
    lifecycle: String,
}

fn project_by(
    tx: &Transaction<'_>,
    clause: &str,
    value: &str,
) -> Result<Option<Project>, DomainError> {
    tx.query_row(
        &format!("SELECT p.id, p.code, p.name, p.lifecycle FROM projects p WHERE {clause}"),
        [value],
        |r| {
            Ok(Project {
                id: r.get(0)?,
                code: r.get(1)?,
                name: r.get(2)?,
                lifecycle: r.get(3)?,
            })
        },
    )
    .optional()
    .map_err(db)
}

/// 02 §2.2 第 2 步、04 L-010：显式代码；否则精确路径 → marker → git common dir。
fn locate(tx: &Transaction<'_>, s: &ProjectSelector) -> Result<Option<Project>, DomainError> {
    if let Some(code) = &s.code {
        let code = keys::normalize(code);
        return match project_by(tx, "p.code = ?1", &code)? {
            Some(p) => Ok(Some(p)),
            None => {
                let codes: Vec<String> = tx
                    .prepare("SELECT code FROM projects WHERE lifecycle <> 'TRASHED' ORDER BY code")
                    .map_err(db)?
                    .query_map([], |r| r.get(0))
                    .map_err(db)?
                    .collect::<rusqlite::Result<_>>()
                    .map_err(db)?;
                // 前两个字符（不是字节）：代码里可能有汉字。
                let head: String = code.chars().take(2).collect();
                let near: Vec<&String> = codes
                    .iter()
                    .filter(|c| c.starts_with(&head) || code.starts_with(c.as_str()))
                    .take(5)
                    .collect();
                Err(
                    DomainError::new(ErrorCode::PROJECT_NOT_FOUND, format!("项目 {code} 不存在"))
                        .detail("project", code.as_str())
                        .detail("did_you_mean", json!(near)),
                )
            }
        };
    }
    if let Some(key) = &s.path_key
        && let Some(p) = project_by(
            tx,
            "p.id = (SELECT project_id FROM project_paths WHERE path_key = ?1)",
            key,
        )?
    {
        return Ok(Some(p));
    }
    if let Some(id) = &s.marker_project_id {
        return match project_by(tx, "p.id = ?1", id)? {
            Some(p) => Ok(Some(p)),
            // L-010：marker 指向的项目不存在，不能借此建项目，报 PROJECT_NOT_FOUND 并带诊断。
            None => Err(DomainError::new(
                ErrorCode::PROJECT_NOT_FOUND,
                "目录里的 ATM 标记指向一个不存在的项目",
            )
            .detail("marker_project_id", id.as_str())
            .detail("diagnostic", "MARKER_PROJECT_MISSING")),
        };
    }
    if let Some(dir) = &s.git_common_dir {
        return project_by(
            tx,
            "p.id = (SELECT project_id FROM project_paths WHERE git_common_dir = ?1 ORDER BY is_primary DESC, last_seen_at DESC LIMIT 1)",
            dir,
        );
    }
    Ok(None)
}

/// begin 的分支目标（10 A3 的 ①–⑤，按顺序取第一个满足的；只读）。resolve 与执行时的目标核对共用这一个判定。
pub(crate) fn begin_target(
    tx: &Transaction<'_>,
    selector: &ProjectSelector,
    mode: Option<&str>,
    allow_project_create: bool,
) -> Result<Branch, DomainError> {
    Ok(match locate(tx, selector)? {
        // ①：登记恢复请求并报错，没有可写的目标。
        Some(p) if p.lifecycle == "TRASHED" => Branch::None,
        // ②：项目优先，无论 mode 与 allow_project_create。
        Some(p) => existing(tx, &p.id)?,
        None if is_quick(mode) => Branch::None,
        None if allow_project_create => Branch::Create,
        // ⑤：报错，不写任何东西。
        None => Branch::None,
    })
}

fn is_quick(mode: Option<&str>) -> bool {
    mode.is_some_and(|m| js_trim(m).eq_ignore_ascii_case("quick"))
}

fn existing(tx: &Transaction<'_>, project: &str) -> Result<Branch, DomainError> {
    let scope = ReceiptScope::project(project);
    let generation = crate::write::generation(tx, &scope).map_err(db)?;
    Ok(Branch::Existing { scope, generation })
}

/// 项目从来没有被按范围恢复过（世代仍是建项目时的初值）。
fn never_restored(tx: &Transaction<'_>, project: &str) -> Result<bool, DomainError> {
    tx.query_row(
        "SELECT NOT EXISTS (SELECT 1 FROM scope_generations
                             WHERE scope_kind = 'PROJECT' AND scope_id = ?1 AND reason = 'RESTORED')",
        [project],
        |r| r.get(0),
    )
    .map_err(db)
}

/// 新写入的目标核对（A3）：带 expected_target 时，按当前状态判定的分支必须与它一致。
fn check_target(b: &Begin, now: &Branch) -> Result<(), DomainError> {
    match &b.req.expected_target {
        Some(expected) => expected.check(now),
        None => Ok(()),
    }
}

/// S-003 / 04 L-003、L-004：TRASHED 项目登记或累加恢复请求（提交），之后报错。
fn trashed(tx: &Transaction<'_>, p: &Project, b: &Begin, at: &str) -> Result<Value, DomainError> {
    let (id, count) =
        crate::project::request_restore(tx, &p.id, &p.code, &b.agent, b.req.cwd.as_deref(), at)?;
    Ok(json!({ "request_id": id, "request_count": count }))
}

// ---------- session 行 ----------

#[derive(Clone, Debug)]
struct SessionRow {
    id: String,
    agent: String,
    cwd: Option<String>,
    thread: Option<String>,
    role: String,
    state: String,
    retirement: Option<String>,
}

fn session_row(
    tx: &Transaction<'_>,
    project: &str,
    id: &str,
) -> Result<Option<SessionRow>, DomainError> {
    tx.query_row(
        "SELECT id, agent_id, cwd, thread_id, role, connection_state, retirement_reason FROM agent_sessions
         WHERE project_id = ?1 AND id = ?2",
        [project, id],
        |r| {
            Ok(SessionRow {
                id: r.get(0)?,
                agent: r.get(1)?,
                cwd: r.get(2)?,
                thread: r.get(3)?,
                role: r.get(4)?,
                state: r.get(5)?,
                retirement: r.get(6)?,
            })
        },
    )
    .optional()
    .map_err(db)
}

/// 一次 begin 的写入上下文。
struct Ctx<'a> {
    tx: &'a Transaction<'a>,
    project: &'a str,
    at: String,
    op_id: Option<&'a str>,
    sequence: i64,
}

impl Ctx<'_> {
    fn emit(
        &mut self,
        kind: &str,
        agent: &str,
        session: &str,
        payload: &Value,
    ) -> Result<(), DomainError> {
        let appended = store_events::append_event(
            self.tx,
            &NewEvent {
                project_id: self.project,
                kind,
                actor_type: "AGENT",
                actor_id: agent,
                session_id: Some(session),
                aggregate_type: "SESSION",
                aggregate_id: session,
                correlation_id: None,
                op_id: self.op_id,
                payload_json: &payload.to_string(),
                at: &self.at,
            },
        )
        .map_err(|e| internal(format!("{e:?}")))?;
        self.sequence = appended.seq;
        Ok(())
    }
}

fn same_quad(s: &SessionRow, b: &Begin) -> bool {
    s.agent == b.agent
        && s.cwd == b.req.cwd
        && s.thread == opt_trim(&b.req.thread_id)
        && s.role == b.role
}

fn identity_mismatch(s: &SessionRow, b: &Begin) -> DomainError {
    DomainError::new(
        ErrorCode::SESSION_SUCCESSOR_IDENTITY_MISMATCH,
        format!("session {} 的身份与这次 begin 不一致，不能接续", s.id),
    )
    .detail("session_id", s.id.as_str())
    .detail(
        "expected",
        json!({ "agent_id": s.agent, "cwd": s.cwd, "thread_id": s.thread, "role": s.role }),
    )
    .detail(
        "requested",
        json!({ "agent_id": b.agent, "cwd": b.req.cwd, "thread_id": opt_trim(&b.req.thread_id), "role": b.role }),
    )
}

/// 给本 agent、尚未确认、来自这些 session 的交接数。
fn pending_handoffs(
    tx: &Transaction<'_>,
    project: &str,
    from: &str,
    agent: &str,
) -> Result<i64, DomainError> {
    tx.query_row(
        "SELECT count(*) FROM handoffs WHERE project_id = ?1 AND from_session_id = ?2 AND to_agent_id = ?3 AND to_session_id IS NULL",
        [project, from, agent],
        |r| r.get(0),
    )
    .map_err(db)
}

/// 新 session 要接的 predecessor，或要接回的同一条（2.x 的 C）。
enum Plan {
    Reattach(SessionRow, &'static str),
    New {
        predecessor: Option<String>,
        ack: bool,
        candidates: Vec<String>,
    },
}

fn plan(c: &Ctx<'_>, b: &Begin) -> Result<Plan, DomainError> {
    let tx = c.tx;
    let project = c.project;
    let fresh = |predecessor: Option<String>, ack: bool| Plan::New {
        predecessor,
        ack,
        candidates: Vec::new(),
    };
    // R11 A1 优先级 1：显式接回。必须在这个项目里、同 agent、同 role、还没关闭。
    if let Some(id) = &b.req.session {
        let id = js_trim(id);
        let s = session_row(tx, project, id)?.ok_or_else(|| {
            DomainError::new(
                ErrorCode::SESSION_NOT_FOUND,
                format!("项目里没有 session {id}"),
            )
            .detail("session_id", id)
        })?;
        if s.agent != b.agent {
            return Err(DomainError::new(
                ErrorCode::SESSION_SUCCESSOR_AGENT_MISMATCH,
                format!(
                    "session {id} 属于 agent {}，不能由 {} 接回",
                    s.agent, b.agent
                ),
            )
            .detail("session_id", id)
            .detail("expected_agent_id", s.agent.as_str())
            .detail("requested_agent_id", b.agent.as_str()));
        }
        if s.role != b.role {
            return Err(identity_mismatch(&s, b));
        }
        if s.state == "CLOSED" {
            return Err(DomainError::new(
                ErrorCode::SESSION_CLOSED,
                format!(
                    "session {id} 已经结束：带 predecessor_session_id 开一个新的 session 接续它"
                ),
            )
            .detail("session_id", id)
            .detail(
                "next",
                json!({ "operation": "begin", "predecessor_session_id": id, "resume": true }),
            ));
        }
        return Ok(Plan::Reattach(s, "CURRENT"));
    }
    // R11 A1：白名单客户端的同一连接组里已有 ONLINE PRIMARY，且 agent、role、cwd 一致 → 就是它（CURRENT）。
    if b.role == "PRIMARY"
        && b.resume() != Resume::No
        && b.req.single_conversation
        && b.req.predecessor_session_id.is_none()
        && let Some(identity) = &b.client_identity
    {
        let ids: Vec<String> = tx
            .prepare(
                "SELECT id FROM agent_sessions WHERE project_id = ?1 AND client_identity = ?2 AND agent_id = ?3
                   AND role = 'PRIMARY' AND cwd IS ?4 AND connection_state = 'ONLINE' ORDER BY started_at DESC, id DESC",
            )
            .map_err(db)?
            .query_map(params![project, identity, b.agent, b.req.cwd], |r| r.get(0))
            .map_err(db)?
            .collect::<rusqlite::Result<_>>()
            .map_err(db)?;
        if let [one] = ids.as_slice() {
            let row = session_row(tx, project, one)?.ok_or_else(|| internal("session vanished"))?;
            return Ok(Plan::Reattach(row, "CURRENT"));
        }
    }

    if let Some(pred_id) = &b.req.predecessor_session_id {
        let pred_id = js_trim(pred_id);
        let pred = session_row(tx, project, pred_id)?.ok_or_else(|| {
            DomainError::new(
                ErrorCode::SESSION_NOT_FOUND,
                format!("项目里没有 session {pred_id}"),
            )
            .detail("session_id", pred_id)
        })?;
        if pred.agent != b.agent {
            return Err(DomainError::new(
                ErrorCode::SESSION_SUCCESSOR_AGENT_MISMATCH,
                format!(
                    "session {pred_id} 属于 agent {}，不能由 {} 接续",
                    pred.agent, b.agent
                ),
            )
            .detail("session_id", pred_id)
            .detail("expected_agent_id", pred.agent.as_str())
            .detail("requested_agent_id", b.agent.as_str()));
        }
        if b.resume() == Resume::No {
            // 00 02 C-14 + 10 R3：非 resume 指名 predecessor，要求存在、同 agent、同 role。
            if pred.role != b.role {
                return Err(identity_mismatch(&pred, b));
            }
            return Ok(fresh(Some(pred.id), false));
        }
        if pred.state != "CLOSED" {
            if !same_quad(&pred, b) {
                return Err(identity_mismatch(&pred, b));
            }
            return Ok(Plan::Reattach(pred, "RESUMED"));
        }
        // 00 02 C-07：已关闭的 predecessor 只校验 agent 与 role，允许跨线程接力。
        if pred.role != b.role {
            return Err(identity_mismatch(&pred, b));
        }
        if pending_handoffs(tx, project, &pred.id, &b.agent)? > 0 || pred.retirement.is_some() {
            return Ok(fresh(Some(pred.id), true));
        }
        return Err(DomainError::new(
            ErrorCode::SESSION_NOT_RETIRED,
            format!("session {pred_id} 是正常结束的，没有待接续的交接：直接 begin 开新的 session"),
        )
        .detail("session_id", pred_id)
        .detail("next", json!({ "operation": "begin", "resume": false })));
    }

    match b.resume() {
        Resume::No => Ok(fresh(None, false)),
        Resume::Yes => {
            // 02 §2.3 B。
            let open: Vec<String> = tx
                .prepare(
                    "SELECT id FROM agent_sessions WHERE project_id = ?1 AND agent_id = ?2 AND cwd IS ?3 AND thread_id IS ?4
                       AND role = ?5 AND connection_state <> 'CLOSED' ORDER BY started_at DESC, id DESC LIMIT 2",
                )
                .map_err(db)?
                .query_map(
                    params![project, b.agent, b.req.cwd, opt_trim(&b.req.thread_id), b.role],
                    |r| r.get(0),
                )
                .map_err(db)?
                .collect::<rusqlite::Result<_>>()
                .map_err(db)?;
            match open.as_slice() {
                [_, _] => return Err(ambiguous(&b.agent, &open, false)),
                [one] => {
                    let row = session_row(tx, project, one)?
                        .ok_or_else(|| internal("session vanished"))?;
                    return Ok(Plan::Reattach(row, "RESUMED"));
                }
                _ => {}
            }
            let sources: Vec<String> = tx
                .prepare(
                    "SELECT DISTINCT s.id FROM handoffs h
                     JOIN agent_sessions s ON s.project_id = h.project_id AND s.id = h.from_session_id
                     WHERE h.project_id = ?1 AND h.to_agent_id = ?2 AND h.to_session_id IS NULL
                       AND s.connection_state = 'CLOSED' AND s.agent_id = ?2 AND s.cwd IS ?3 AND s.thread_id IS ?4 AND s.role = ?5
                     ORDER BY s.id LIMIT 2",
                )
                .map_err(db)?
                .query_map(
                    params![project, b.agent, b.req.cwd, opt_trim(&b.req.thread_id), b.role],
                    |r| r.get(0),
                )
                .map_err(db)?
                .collect::<rusqlite::Result<_>>()
                .map_err(db)?;
            match sources.as_slice() {
                [_, _] => Err(ambiguous(&b.agent, &sources, true)),
                [one] => Ok(fresh(Some(one.clone()), true)),
                _ => Ok(fresh(None, false)),
            }
        }
        Resume::Auto => {
            // R11 P1-3：同 agent、role、cwd，已关闭且「客户端退出 / 心跳超时 / 有给本 agent 的待确认交接」，还没被接续过。
            // 永远不接回一个 ONLINE session。
            let candidates: Vec<String> = tx
                .prepare(
                    "SELECT s.id FROM agent_sessions s
                     WHERE s.project_id = ?1 AND s.agent_id = ?2 AND s.role = ?3 AND s.cwd IS ?4 AND s.connection_state = 'CLOSED'
                       AND (s.close_reason IN ('CLIENT_EXITED', 'HEARTBEAT_TIMEOUT')
                            OR EXISTS (SELECT 1 FROM handoffs h WHERE h.project_id = s.project_id AND h.from_session_id = s.id
                                         AND h.to_agent_id = s.agent_id AND h.to_session_id IS NULL))
                       AND NOT EXISTS (SELECT 1 FROM agent_sessions n WHERE n.project_id = s.project_id AND n.predecessor_session_id = s.id)
                     ORDER BY s.started_at DESC, s.id DESC LIMIT 6",
                )
                .map_err(db)?
                .query_map(params![project, b.agent, b.role, b.req.cwd], |r| r.get(0))
                .map_err(db)?
                .collect::<rusqlite::Result<_>>()
                .map_err(db)?;
            match candidates.as_slice() {
                [one] => Ok(fresh(Some(one.clone()), true)),
                [] => Ok(fresh(None, false)),
                _ => Ok(Plan::New {
                    predecessor: None,
                    ack: false,
                    candidates,
                }),
            }
        }
    }
}

fn ambiguous(agent: &str, candidates: &[String], pending: bool) -> DomainError {
    let mut e = DomainError::new(
        ErrorCode::SESSION_SUCCESSOR_AMBIGUOUS,
        "有多个可接续的 session：带 predecessor_session_id 指明接哪一个",
    )
    .detail("agent_id", agent)
    .detail("candidates", candidates.to_vec())
    .detail("resolution", "predecessor_session_id");
    if pending {
        e = e.detail("pending_handoff", true);
    }
    e
}

/// R4′：确认 predecessor 及其祖先（同 agent、同 role 的 predecessor 链）发给本 agent、尚未确认的交接。
fn acknowledge(
    c: &Ctx<'_>,
    from: &str,
    to: &str,
    agent: &str,
    role: &str,
) -> Result<usize, DomainError> {
    let mut total = 0;
    let mut cursor = Some(from.to_owned());
    let mut seen = std::collections::HashSet::new();
    while let Some(id) = cursor {
        if !seen.insert(id.clone()) {
            break;
        }
        total += c
            .tx
            .execute(
                "UPDATE handoffs SET to_session_id = ?3, acknowledged_at = ?4, ack_by_session = ?3
                 WHERE project_id = ?1 AND from_session_id = ?2 AND to_agent_id = ?5 AND to_session_id IS NULL",
                params![c.project, id, to, c.at, agent],
            )
            .map_err(db)?;
        cursor =
            c.tx.query_row(
                "SELECT p.id FROM agent_sessions s JOIN agent_sessions p
                   ON p.project_id = s.project_id AND p.id = s.predecessor_session_id
                 WHERE s.project_id = ?1 AND s.id = ?2 AND p.agent_id = ?3 AND p.role = ?4",
                params![c.project, id, agent, role],
                |r| r.get(0),
            )
            .optional()
            .map_err(db)?;
    }
    Ok(total)
}

fn create(c: &mut Ctx<'_>, b: &Begin, predecessor: Option<&str>) -> Result<String, DomainError> {
    let tx = c.tx;
    // S-011：每次建 session 都 upsert agents，覆盖 display_name / client_kind。
    tx.execute(
        "INSERT INTO agents (project_id, id, display_name, client_kind, capabilities_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, '[]', ?5, ?5)
         ON CONFLICT (project_id, id) DO UPDATE SET display_name = excluded.display_name,
           client_kind = excluded.client_kind, updated_at = excluded.updated_at",
        params![c.project, b.agent, b.display, b.client_kind, c.at],
    )
    .map_err(db)?;
    let id = store_events::ulid(tx).map_err(db)?;
    let git = b.req.git.clone().unwrap_or_default();
    let (branch, head) = if git.available {
        (git.branch.clone(), git.head.clone())
    } else {
        (opt_trim(&b.req.git_branch), opt_trim(&b.req.git_head))
    };
    let tri = |v: Option<bool>| v.map(i64::from);
    tx.execute(
        "INSERT INTO agent_sessions (project_id, id, agent_id, parent_session_id, thread_id, role, cwd, git_branch, git_head,
           work_state, connection_state, heartbeat_at, version, started_at, updated_at, predecessor_session_id,
           git_repo_root, worktree_root, git_common_dir, git_is_linked_worktree, git_detached, git_dirty, git_available,
           git_error, client_identity)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'PLANNING', 'ONLINE', ?10, 0, ?10, ?10, ?11,
                 ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
        params![
            c.project,
            id,
            b.agent,
            opt_trim(&b.req.parent_session_id),
            opt_trim(&b.req.thread_id),
            b.role,
            b.req.cwd,
            branch,
            head,
            c.at,
            predecessor,
            git.repo_root,
            git.worktree_root,
            git.common_dir,
            tri(git.is_linked_worktree),
            tri(git.detached),
            tri(git.dirty),
            i64::from(git.available),
            git.error,
            b.client_identity,
        ],
    )
    .map_err(db)?;
    let payload = json!({
        "agentId": b.agent,
        "displayName": b.display,
        "role": b.role,
        "parentSessionId": opt_trim(&b.req.parent_session_id),
        "resume": b.resume().as_str(),
        "predecessorSessionId": predecessor,
        "git": { "available": git.available, "branch": branch, "head": head },
    });
    c.emit("agent.joined", &b.agent, &id, &payload)?;
    Ok(id)
}

/// 2.x 的 C：接回同一条。刷新心跳、置 ONLINE，不加 session version；发 `agent.resumed`。
fn reattach(c: &mut Ctx<'_>, b: &Begin, s: &SessionRow) -> Result<(), DomainError> {
    c.tx.execute(
        "UPDATE agent_sessions SET heartbeat_at = ?3, updated_at = ?3, connection_state = 'ONLINE',
           client_identity = COALESCE(?4, client_identity)
         WHERE project_id = ?1 AND id = ?2",
        params![c.project, s.id, c.at, b.client_identity],
    )
    .map_err(db)?;
    let payload = json!({
        "agentId": s.agent,
        "displayName": b.display,
        "role": s.role,
        "cwd": s.cwd,
        "threadId": s.thread,
    });
    c.emit("agent.resumed", &s.agent, &s.id, &payload)
}

fn session_view(tx: &Transaction<'_>, project: &str, id: &str) -> Result<Value, DomainError> {
    tx.query_row(
        "SELECT id, agent_id, role, cwd, thread_id, parent_session_id, predecessor_session_id, work_state,
                connection_state, started_at, heartbeat_at, git_branch, git_head, version
         FROM agent_sessions WHERE project_id = ?1 AND id = ?2",
        [project, id],
        |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "agentId": r.get::<_, String>(1)?,
                "role": r.get::<_, String>(2)?,
                "cwd": r.get::<_, Option<String>>(3)?,
                "threadId": r.get::<_, Option<String>>(4)?,
                "parentSessionId": r.get::<_, Option<String>>(5)?,
                "predecessorSessionId": r.get::<_, Option<String>>(6)?,
                "workState": r.get::<_, String>(7)?,
                "connectionState": r.get::<_, String>(8)?,
                "startedAt": r.get::<_, String>(9)?,
                "heartbeatAt": r.get::<_, Option<String>>(10)?,
                "gitBranch": r.get::<_, Option<String>>(11)?,
                "gitHead": r.get::<_, Option<String>>(12)?,
                "version": r.get::<_, i64>(13)?,
            }))
        },
    )
    .map_err(db)
}

enum BeginOutcome {
    Written(Written),
    Trashed { code: String, request: Value },
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

impl Service {
    /// begin（02 §2.2–2.3；R11 A1、A3、P1-3）。没有匹配到项目时的 quick / 建项目分支（A3 的 ③④）随 W2g 的
    /// 项目生命周期接入；此前一律 `PROJECT_REQUIRED`。
    pub fn begin(&self, principal: &Principal, req: BeginRequest) -> Result<Written, DomainError> {
        capability::require(principal, Capability::SessionBegin)?;
        let b = normalize(req, principal.client_group().map(str::to_owned))?;
        let outcome = self
            .store()
            .write(move |tx| begin_tx(tx, &b))
            .map_err(write_error)?;
        match outcome {
            BeginOutcome::Written(w) => Ok(w),
            BeginOutcome::Trashed { code, request } => Err(DomainError::new(
                ErrorCode::PROJECT_DB_UNAVAILABLE,
                format!("项目 {code} 在垃圾箱里：已登记恢复请求，等用户在界面里决定；不要另建项目或 quick 绕过"),
            )
            .detail("project", code.as_str())
            .detail("lifecycle", "TRASHED")
            // 02 §7：TRASHED 时把目录里的 retryable=true 覆盖为 false（W4 的错误信封据此填写）。
            .detail("retryable", false)
            .detail(
                "recovery",
                json!({ "action": "await_user_restore_authorization", "request_id": request["request_id"], "request_count": request["request_count"] }),
            )
            .detail("quick", json!({ "action": "do_not_bypass" }))),
        }
    }
}

fn begin_tx(tx: &Transaction<'_>, b: &Begin) -> Result<BeginOutcome, DomainError> {
    let at = now();
    let at_iso = at.to_string();
    let call = CallKey {
        principal_kind: "AGENT",
        principal_id: b.agent.clone(),
        operation: BEGIN_OPERATION.to_owned(),
    };
    let (project, created) = match locate(tx, &b.req.selector)? {
        Some(p) => (p, None),
        None => match unmatched(tx, b, &call, &at_iso)? {
            Unmatched::Done(w) => return Ok(BeginOutcome::Written(w)),
            Unmatched::Created(c, path) => (
                Project {
                    id: c.id.clone(),
                    code: c.code.clone(),
                    name: c.name.clone(),
                    lifecycle: "ACTIVE".to_owned(),
                },
                Some((c, path)),
            ),
        },
    };
    if project.lifecycle == "TRASHED" {
        let request = trashed(tx, &project, b, &at_iso)?;
        return Ok(BeginOutcome::Trashed {
            code: project.code,
            request,
        });
    }
    let scope = ReceiptScope::project(project.id.clone());
    if let Some(op) = &b.op_id {
        let legacy_key = format!("session-begin:{op}");
        let rebuild = |c: &Candidate| rebuilt(b, c);
        match receipts::find_call(tx, &call, op, Some((&scope, legacy_key.as_str())), &rebuild)
            .map_err(db)?
        {
            Verdict::New => {}
            Verdict::Replay(c) => {
                let mut result: Value = serde_json::from_str(&c.receipt_json).map_err(db_json)?;
                // 00 02 C-17：回放到已关闭的 session 时带上它此刻的状态。
                if let Some(sid) = result["session"]["id"].as_str()
                    && let Some(s) = session_row(tx, &project.id, sid)?
                {
                    result["sessionState"] = json!(s.state);
                }
                return Ok(BeginOutcome::Written(Written {
                    result,
                    replayed: true,
                    receipt_id: c.receipt_id,
                    rebound_to: None,
                }));
            }
            Verdict::Undone { generation } => {
                return Err(DomainError::new(
                    ErrorCode::OPERATION_UNDONE_BY_RESTORE,
                    "这个 op_id 的 begin 已被一次按范围恢复撤销：换一个新的 op_id 重新 begin",
                )
                .detail("op_id", op.as_str())
                .detail("restored_generation", generation));
            }
            Verdict::Conflict { reason, .. } => {
                let mut e = DomainError::new(
                    ErrorCode::IDEMPOTENCY_CONFLICT,
                    "这个 op_id 已经用于另一个不同的 begin：重试原请求请原样重发，新请求换一个新的 op_id",
                )
                .detail("op_id", op.as_str());
                if let Some(code) = reason.code() {
                    e = e.detail("reason", code);
                }
                return Err(e);
            }
        }
    }
    let generation = crate::write::generation(tx, &scope).map_err(db)?;
    if created.is_none() {
        let now = Branch::Existing {
            scope: scope.clone(),
            generation,
        };
        // CREATE 的目标在 resolve 之后被别人建好、而且从没恢复过：begin 接到这个项目上（A3）。
        let adopt =
            b.req.expected_target == Some(Branch::Create) && never_restored(tx, &project.id)?;
        if !adopt {
            check_target(b, &now)?;
        }
    }
    // CREATE 分支的新项目没有可比的世代（A3）。
    if created.is_none()
        && b.req.expected_generation.is_some()
        && b.req.expected_generation != generation
    {
        return Err(DomainError::new(
            ErrorCode::SCOPE_RESTORED,
            "目标项目在这次请求发出之后被恢复过：重新 begin",
        )
        .detail("expected_generation", b.req.expected_generation)
        .detail("current_generation", generation));
    }

    let mut c = Ctx {
        tx,
        project: &project.id,
        at: at_iso.clone(),
        op_id: b.op_id.as_deref(),
        sequence: 0,
    };
    let (session_id, outcome, predecessor, acknowledged, candidates) = match plan(&c, b)? {
        Plan::Reattach(s, outcome) => {
            reattach(&mut c, b, &s)?;
            // R4′：范围恢复会把已确认的交接退回待确认；接回的后继在这里重新确认祖先发给它的交接。
            // 平时这些交接在建后继时就确认过了，这里什么也不改。
            let predecessor: Option<String> = tx
                .query_row(
                    "SELECT predecessor_session_id FROM agent_sessions WHERE project_id = ?1 AND id = ?2",
                    params![project.id, s.id],
                    |r| r.get(0),
                )
                .map_err(db)?;
            let acked = match &predecessor {
                Some(p) => acknowledge(&c, p, &s.id, &b.agent, &b.role)?,
                None => 0,
            };
            (s.id.clone(), outcome, None, acked, Vec::new())
        }
        Plan::New {
            predecessor,
            ack,
            candidates,
        } => {
            let id = create(&mut c, b, predecessor.as_deref())?;
            let acked = match (&predecessor, ack) {
                (Some(p), true) => acknowledge(&c, p, &id, &b.agent, &b.role)?,
                _ => 0,
            };
            let outcome = if predecessor.is_some() {
                "SUCCESSOR"
            } else {
                "CREATED"
            };
            (id, outcome, predecessor, acked, candidates)
        }
    };
    let mut result = json!({
        "scope": "project",
        "project": { "id": project.id, "code": project.code, "name": project.name, "lifecycle": project.lifecycle },
        "session": session_view(tx, &project.id, &session_id)?,
        "outcome": outcome,
        "predecessorSessionId": predecessor,
        "acknowledgedHandoffs": acknowledged,
        "sequence": c.sequence,
    });
    if let Some((c, path)) = &created {
        // C-L03：marker 与 git exclude 由调用方在提交之后写。
        let view = c.view(path.as_ref());
        result["projectCreated"] = json!(true);
        result["sourcePath"] = view["sourcePath"].clone();
        result["marker"] = view["marker"].clone();
    }
    if !candidates.is_empty() {
        // R11 P1-3：多个候选不阻塞开工，列出来并给出带 predecessor 的 begin。
        result["resumeCandidates"] = json!(candidates
            .iter()
            .map(|id| json!({ "sessionId": id, "next": { "operation": "begin", "resume": true, "predecessor_session_id": id } }))
            .collect::<Vec<_>>());
    }
    let receipt_id = match &b.op_id {
        Some(op) => {
            let input = begin_fp(b, Family::CanonV2).ok_or_else(|| internal("canon-v2 begin"))?;
            receipts::insert(
                tx,
                &NewReceipt {
                    scope: &scope,
                    ns: None,
                    call: Some(&call),
                    op_id: op,
                    operation: BEGIN_OPERATION,
                    fingerprint: &fp::canon_v2(&input),
                    receipt_json: &result.to_string(),
                    author_agent: Some(&b.agent),
                    author_session: Some(&session_id),
                    actor_session_id: None,
                    scope_generation: generation,
                    created_at: &at_iso,
                },
            )
            .map_err(db)?
        }
        None => 0,
    };
    Ok(BeginOutcome::Written(Written {
        result,
        replayed: false,
        receipt_id,
        rebound_to: None,
    }))
}

fn db_json(e: serde_json::Error) -> DomainError {
    internal(e)
}

enum Unmatched {
    /// ③ 的 quick task，或调用索引的重放。
    Done(Written),
    /// ④ 新建的项目（本事务内），之后照常建 session。
    Created(crate::project::Created, Option<crate::project::PathInfo>),
}

/// 目录名：去掉末尾分隔符后的最后一段。
fn basename(path: &str) -> Option<&str> {
    path.trim_end_matches(['\\', '/'])
        .rsplit(['\\', '/'])
        .next()
        .filter(|n| !n.is_empty())
}

/// 没有匹配到项目（10 A3 的 ③④⑤）。分支按 2.x 的顺序取第一个满足的：显式 quick 先于建项目。
/// 调用索引全局共享，所以先查重放：同一个 op_id 原来落在 quick 或新项目上，都原样重放。
fn unmatched(
    tx: &Transaction<'_>,
    b: &Begin,
    call: &CallKey,
    at: &str,
) -> Result<Unmatched, DomainError> {
    if let Some(op) = &b.op_id {
        let rebuild = |c: &Candidate| rebuilt(b, c);
        match receipts::find_call(tx, call, op, None, &rebuild).map_err(db)? {
            Verdict::New => {}
            Verdict::Replay(c) => {
                return Ok(Unmatched::Done(Written {
                    result: serde_json::from_str(&c.receipt_json).map_err(db_json)?,
                    replayed: true,
                    receipt_id: c.receipt_id,
                    rebound_to: None,
                }));
            }
            Verdict::Undone { generation } => {
                return Err(DomainError::new(
                    ErrorCode::OPERATION_UNDONE_BY_RESTORE,
                    "这个 op_id 的 begin 已被一次按范围恢复撤销：换一个新的 op_id 重新 begin",
                )
                .detail("op_id", op.as_str())
                .detail("restored_generation", generation));
            }
            Verdict::Conflict { .. } => {
                return Err(DomainError::new(
                    ErrorCode::IDEMPOTENCY_CONFLICT,
                    "这个 op_id 已经用于另一个不同的 begin：重试原请求请原样重发，新请求换一个新的 op_id",
                )
                .detail("op_id", op.as_str()));
            }
        }
    }
    let mode = b
        .req
        .mode
        .as_deref()
        .map_or("auto".to_owned(), |m| js_trim(m).to_lowercase());
    if mode == "quick" {
        check_target(b, &Branch::None)?;
        // ③：quick task（全局，不随范围恢复回退）；op_id 让重试拿到同一个 Q 键（03 C-11）。
        let title = b
            .req
            .title
            .as_deref()
            .map(js_trim)
            .filter(|t| !t.is_empty())
            .unwrap_or("未命名临时任务");
        let quick =
            crate::quick::create_tx(tx, title, "", None, b.req.cwd.as_deref(), &b.agent, at)?;
        let result =
            json!({ "scope": "quick", "quick": quick, "session": null, "outcome": "QUICK" });
        let receipt_id = match &b.op_id {
            Some(op) => {
                let input =
                    begin_fp(b, Family::CanonV2).ok_or_else(|| internal("canon-v2 begin"))?;
                receipts::insert(
                    tx,
                    &NewReceipt {
                        scope: &ReceiptScope::global(),
                        ns: None,
                        call: Some(call),
                        op_id: op,
                        operation: BEGIN_OPERATION,
                        fingerprint: &fp::canon_v2(&input),
                        receipt_json: &result.to_string(),
                        author_agent: Some(&b.agent),
                        author_session: None,
                        actor_session_id: None,
                        scope_generation: None,
                        created_at: at,
                    },
                )
                .map_err(db)?
            }
            None => 0,
        };
        return Ok(Unmatched::Done(Written {
            result,
            replayed: false,
            receipt_id,
            rebound_to: None,
        }));
    }
    if !b.req.allow_project_create {
        check_target(b, &Branch::None)?;
        // ⑤：报错，不写任何东西（R11 P1-5：auto 不再静默建 quick）。
        return Err(with_begin_next(
            DomainError::new(
                ErrorCode::PROJECT_REQUIRED,
                "没有认出项目：在仓库里首次使用时 begin 加 allow_project_create:true，或者带 project 指明项目",
            ),
            b,
        ));
    }
    // ④：在同一个写事务里建项目，之后照常建 session。
    check_target(b, &Branch::Create)?;
    let canonical = b
        .req
        .selector
        .canonical_path
        .clone()
        .or_else(|| b.req.cwd.clone())
        .map(|c| js_trim(&c).to_owned())
        .filter(|c| !c.is_empty());
    let name = b
        .req
        .title
        .as_deref()
        .map(js_trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .or_else(|| canonical.as_deref().and_then(basename).map(str::to_owned))
        .unwrap_or_else(|| "未命名项目".to_owned());
    let path = canonical.map(|c| crate::project::PathInfo {
        canonical_path: c,
        git_common_dir: b.req.selector.git_common_dir.clone(),
    });
    let spec = crate::project::spec(&crate::project::CreateProjectRequest {
        path,
        creation_reason: b.req.creation_reason.clone(),
        signals: b.req.signals.clone(),
        ..crate::project::CreateProjectRequest::new(name)
    })?;
    let created = crate::project::create_tx(tx, &spec, &b.agent, at)?;
    Ok(Unmatched::Created(created, spec.path))
}

fn with_begin_next(e: DomainError, b: &Begin) -> DomainError {
    e.detail(
        "next",
        json!({ "operation": "begin", "agent_id": b.agent, "cwd": b.req.cwd, "allow_project_create": true }),
    )
}

// ---------- end（02 §2.6；S-013～S-015、S-021；00 02 C-06；03 C-04）----------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Completed,
    Paused,
    Blocked,
    Cancelled,
    Error,
    Retired,
}

impl Outcome {
    pub fn parse(text: &str) -> Option<Self> {
        Some(match js_trim(text).to_lowercase().as_str() {
            "completed" => Outcome::Completed,
            "paused" => Outcome::Paused,
            "blocked" => Outcome::Blocked,
            "cancelled" => Outcome::Cancelled,
            "error" => Outcome::Error,
            "retired" => Outcome::Retired,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Completed => "completed",
            Outcome::Paused => "paused",
            Outcome::Blocked => "blocked",
            Outcome::Cancelled => "cancelled",
            Outcome::Error => "error",
            Outcome::Retired => "retired",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct EndRequest {
    pub outcome: Outcome,
    pub summary: String,
    pub next: Vec<String>,
    /// 缺省 true。
    pub release_claims: bool,
    pub retirement_reason: Option<String>,
    /// 非 REPLAY 时在同一事务里先写 git 上下文（02 §2.6 第 2 步）。
    pub git: Option<GitContext>,
}

fn end_fp(r: &EndRequest, family: Family) -> Option<JsValue> {
    let next: Vec<Value> = r.next.iter().map(|n| json!(js_trim(n))).collect();
    let v = match family {
        Family::CanonV2 => json!({
            "outcome": r.outcome.as_str(),
            "summary": js_trim(&r.summary),
            "next": next,
            "release_claims": r.release_claims,
            "retirement_reason": nullable(r.retirement_reason.as_deref()),
        }),
        Family::KernelV1 => {
            let mut m = Map::new();
            m.insert("outcome".into(), json!(r.outcome.as_str()));
            m.insert("summary".into(), json!(js_trim(&r.summary)));
            m.insert("next".into(), Value::Array(next));
            m.insert("releaseClaims".into(), json!(r.release_claims));
            if let Some(reason) = &r.retirement_reason {
                m.insert("retirementReason".into(), json!(js_trim(reason)));
            }
            Value::Object(m)
        }
        Family::KnowledgeV1 => return None,
    };
    Some(JsValue::from_json(&v))
}

fn validate_end(r: &EndRequest) -> Result<(), DomainError> {
    let summary = js_trim(&r.summary);
    if summary.is_empty() || utf16_len(summary) > 500 {
        return Err(invalid("summary", "summary 必须是 1 至 500 个字符"));
    }
    if r.next.len() > 20 {
        return Err(invalid("next", "next 最多 20 条"));
    }
    for n in &r.next {
        bounded("next", Some(n), 500)?;
    }
    bounded("retirement_reason", r.retirement_reason.as_deref(), 500)
}

/// 释放 session 持有的领取（end、强制关闭共用；02 §2.6、§2.8；00 02 C-06：CLAIMED 回 READY 时连 assignee 一起清）。
/// 返回释放的任务 `(key, version)`。
fn release(
    tx: &Transaction<'_>,
    project: &str,
    code: &str,
    session: &str,
    at: &str,
) -> Result<Vec<Value>, DomainError> {
    let rows: Vec<(String, i64, i64)> = tx
        .prepare(
            "SELECT id, local_no, version FROM work_items WHERE project_id = ?1 AND claimed_by_session_id = ?2 ORDER BY local_no",
        )
        .map_err(db)?
        .query_map([project, session], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(db)?
        .collect::<rusqlite::Result<_>>()
        .map_err(db)?;
    let mut released = Vec::with_capacity(rows.len());
    for (id, no, version) in rows {
        tx.execute(
            "UPDATE work_items SET
               assignee_agent_id = CASE WHEN status = 'CLAIMED' THEN NULL ELSE assignee_agent_id END,
               phase = CASE WHEN status = 'CLAIMED' THEN 'READY' ELSE phase END,
               status = CASE WHEN status = 'CLAIMED' THEN 'READY' ELSE status END,
               claimed_by_session_id = NULL, claim_lease_until = NULL,
               version = version + 1, updated_at = ?3
             WHERE project_id = ?1 AND id = ?2",
            params![project, id, at],
        )
        .map_err(db)?;
        released.push(json!({ "key": keys::task_key(code, no), "version": version + 1 }));
    }
    Ok(released)
}

/// 关闭 session 的公共部分：状态、关闭原因、它领过的任务的 `last_session_closed_at`。
fn close(
    tx: &Transaction<'_>,
    project: &str,
    session: &str,
    reason: &str,
    retirement: Option<&str>,
    at: &str,
) -> Result<(), DomainError> {
    tx.execute(
        "UPDATE agent_sessions SET connection_state = 'CLOSED', work_state = 'IDLE', current_work_item_id = NULL,
           heartbeat_at = ?3, updated_at = ?3, closed_at = COALESCE(closed_at, ?3), close_reason = ?4,
           retirement_reason = ?5, version = version + 1
         WHERE project_id = ?1 AND id = ?2",
        params![project, session, at, reason, retirement],
    )
    .map_err(db)?;
    tx.execute(
        "UPDATE work_items SET last_session_closed_at = ?3 WHERE project_id = ?1 AND claimed_by_session_id = ?2",
        params![project, session, at],
    )
    .map_err(db)?;
    Ok(())
}

/// S-022：available 时取新值，否则保留旧值；`git_available`、`git_error` 总取新值；无变化不写。返回是否写了。
pub(crate) fn apply_git(
    tx: &Transaction<'_>,
    project: &str,
    session: &str,
    g: &GitContext,
    at: &str,
) -> Result<bool, DomainError> {
    let tri = |v: Option<bool>| v.map(i64::from);
    let changed = tx
        .execute(
            "UPDATE agent_sessions SET
               git_branch = CASE WHEN ?3 THEN ?4 ELSE git_branch END,
               git_head = CASE WHEN ?3 THEN ?5 ELSE git_head END,
               git_repo_root = CASE WHEN ?3 THEN ?6 ELSE git_repo_root END,
               worktree_root = CASE WHEN ?3 THEN ?7 ELSE worktree_root END,
               git_common_dir = CASE WHEN ?3 THEN ?8 ELSE git_common_dir END,
               git_is_linked_worktree = CASE WHEN ?3 THEN ?9 ELSE git_is_linked_worktree END,
               git_detached = CASE WHEN ?3 THEN ?10 ELSE git_detached END,
               git_dirty = CASE WHEN ?3 THEN ?11 ELSE git_dirty END,
               git_available = ?12, git_error = ?13, version = version + 1, updated_at = ?14
             WHERE project_id = ?1 AND id = ?2 AND NOT (
               (NOT ?3 OR (git_branch IS ?4 AND git_head IS ?5 AND git_repo_root IS ?6 AND worktree_root IS ?7
                 AND git_common_dir IS ?8 AND git_is_linked_worktree IS ?9 AND git_detached IS ?10 AND git_dirty IS ?11))
               AND git_available = ?12 AND git_error IS ?13)",
            params![
                project,
                session,
                g.available,
                g.branch,
                g.head,
                g.repo_root,
                g.worktree_root,
                g.common_dir,
                tri(g.is_linked_worktree),
                tri(g.detached),
                tri(g.dirty),
                i64::from(g.available),
                g.error,
                at
            ],
        )
        .map_err(db)?;
    Ok(changed > 0)
}

#[allow(clippy::too_many_arguments)]
fn system_event(
    tx: &Transaction<'_>,
    project: &str,
    kind: &str,
    actor: (&str, &str),
    session: &str,
    payload: &Value,
    op_id: Option<&str>,
    at: &str,
) -> Result<i64, DomainError> {
    store_events::append_event(
        tx,
        &NewEvent {
            project_id: project,
            kind,
            actor_type: actor.0,
            actor_id: actor.1,
            session_id: if actor.0 == "AGENT" {
                Some(session)
            } else {
                None
            },
            aggregate_type: "SESSION",
            aggregate_id: session,
            correlation_id: None,
            op_id,
            payload_json: &payload.to_string(),
            at,
        },
    )
    .map(|a| a.seq)
    .map_err(|e| internal(format!("{e:?}")))
}

fn project_code(tx: &Transaction<'_>, project: &str) -> Result<String, DomainError> {
    tx.query_row("SELECT code FROM projects WHERE id = ?1", [project], |r| {
        r.get(0)
    })
    .map_err(db)
}

/// 03 C-04：Agent 只能结束自己谱系里的 session。「自己」按连接组身份（A4 的 `X-ATM-Client`）认：
/// 谱系里有 session 记着连接组身份时，调用方的连接组必须是其中之一；谱系里谁都没记（直连客户端开的、
/// 或 2.x 迁移来的）时无从分辨，照 2.x 放行。结束别人的 session 走 User 的强制关闭。
fn end_owned(tx: &Transaction<'_>, ctx: &WriteCtx, group: Option<&str>) -> Result<(), DomainError> {
    let Some(session) = ctx.actor.session.as_deref() else {
        return Ok(());
    };
    let project = ctx.scope.id.as_str();
    let members = crate::lineage::lineage(tx, project, session).map_err(db)?;
    let mut owners = Vec::new();
    for m in &members {
        let identity: Option<String> = tx
            .query_row(
                "SELECT client_identity FROM agent_sessions WHERE project_id = ?1 AND id = ?2",
                [project, m.as_str()],
                |r| r.get(0),
            )
            .optional()
            .map_err(db)?
            .flatten();
        owners.extend(identity);
    }
    if owners.is_empty() || group.is_some_and(|g| owners.iter().any(|o| o == g)) {
        return Ok(());
    }
    Err(DomainError::new(
        ErrorCode::USER_AUTHORIZATION_REQUIRED,
        format!("session {session} 不是这个连接开的：Agent 只能结束自己谱系里的 session，结束别人的 session 请用户在界面里强制关闭"),
    )
    .detail("session_id", session))
}

fn end_action(tx: &Transaction<'_>, ctx: &WriteCtx, r: &EndRequest) -> Result<Value, DomainError> {
    let project = ctx.scope.id.as_str();
    let session = ctx
        .actor
        .session
        .clone()
        .ok_or_else(|| DomainError::new(ErrorCode::SESSION_REQUIRED, "atm_end 需要 session"))?;
    let at = ctx.now.to_string();
    let code = project_code(tx, project)?;
    if let Some(g) = &r.git {
        apply_git(tx, project, &session, g, &at)?;
    }
    let pause = matches!(r.outcome, Outcome::Paused | Outcome::Retired);
    // S-013：paused / retired 给未完成的领取写交接，与 release_claims 互相独立。
    let mut handoffs = 0;
    if pause {
        let seq: i64 = tx
            .query_row(
                "SELECT project_seq FROM projects WHERE id = ?1",
                [project],
                |r| r.get(0),
            )
            .map_err(db)?;
        let open: Vec<String> = tx
            .prepare(
                "SELECT id FROM work_items WHERE project_id = ?1 AND claimed_by_session_id = ?2
                   AND status NOT IN ('DONE', 'CANCELLED') ORDER BY local_no",
            )
            .map_err(db)?
            .query_map([project, session.as_str()], |r| r.get(0))
            .map_err(db)?
            .collect::<rusqlite::Result<_>>()
            .map_err(db)?;
        let next_action = r
            .next
            .first()
            .map_or("继续当前任务".to_owned(), |n| js_trim(n).to_owned());
        for item in open {
            let id = store_events::ulid(tx).map_err(db)?;
            tx.execute(
                "INSERT INTO handoffs (project_id, id, work_item_id, from_session_id, to_agent_id, summary, next_action,
                   created_at, checkpoint_sequence)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![project, id, item, session, ctx.actor.id, js_trim(&r.summary), next_action, at, seq],
            )
            .map_err(db)?;
            handoffs += 1;
        }
    }
    let released = if r.release_claims {
        release(tx, project, &code, &session, &at)?
    } else {
        Vec::new()
    };
    let (reason, retirement) = if r.outcome == Outcome::Retired {
        let text = r
            .retirement_reason
            .as_deref()
            .map(js_trim)
            .filter(|t| !t.is_empty())
            .unwrap_or("context rotation")
            .to_owned();
        ("EXPLICIT_RETIRE", Some(text))
    } else {
        ("EXPLICIT_END", None)
    };
    close(tx, project, &session, reason, retirement.as_deref(), &at)?;
    let next: Vec<String> = r.next.iter().map(|n| js_trim(n).to_owned()).collect();
    let seq = system_event(
        tx,
        project,
        "agent.left",
        ("AGENT", &ctx.actor.id),
        &session,
        &json!({ "outcome": r.outcome.as_str(), "summary": js_trim(&r.summary), "next": next }),
        Some(&ctx.op_id),
        &at,
    )?;
    Ok(json!({
        "session": session,
        "handoffs": handoffs,
        "releasedItems": released,
        "sequence": seq,
    }))
}

// ---------- 超时扫描（00 02 C-08；R11 P1-3；S-012）----------

/// 扫描策略。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SweepPolicy {
    /// 没有客户端身份时的超时（设置 `recovery.sessionTimeoutMinutes`，默认 5，夹到 [1, 1440]）。
    pub timeout_minutes: i64,
    /// 客户端进程仍存活时的兜底阈值（R11 P1-3：120 分钟）。
    pub alive_fallback_minutes: i64,
}

impl Default for SweepPolicy {
    fn default() -> Self {
        SweepPolicy {
            timeout_minutes: 5,
            alive_fallback_minutes: 120,
        }
    }
}

/// 客户端进程是否存活：`Some(true/false)`，查不到为 None（按没有身份处理）。
pub type Liveness<'a> = &'a (dyn Fn(&str) -> Option<bool> + Sync);

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SweepReport {
    /// `(project_id, session_id, close_reason)`。
    pub closed: Vec<(String, String, String)>,
}

impl Service {
    /// 常驻周期扫描（每分钟一次）。只扫 ACTIVE 项目（S-012）。不释放领取。
    pub fn sweep_sessions(
        &self,
        principal: &Principal,
        policy: SweepPolicy,
        alive: Liveness<'_>,
    ) -> Result<SweepReport, DomainError> {
        capability::require(principal, Capability::SessionRecoverStale)?;
        let at = now();
        let rows: Vec<(String, String, String, Option<String>, String)> = self
            .store()
            .read(|tx| {
                tx.prepare(
                    "SELECT s.project_id, s.id, s.agent_id, s.client_identity, COALESCE(s.heartbeat_at, s.updated_at)
                     FROM agent_sessions s JOIN projects p ON p.id = s.project_id
                     WHERE p.lifecycle = 'ACTIVE' AND s.connection_state = 'ONLINE'",
                )?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()
            })
            .map_err(read_error)?;
        let timeout = policy.timeout_minutes.clamp(1, 1440);
        let mut decided = Vec::new();
        for (project, id, agent, identity, last) in rows {
            let liveness = identity.as_deref().and_then(alive);
            let reason = match liveness {
                Some(false) => Some("CLIENT_EXITED"),
                _ => {
                    let minutes = if liveness == Some(true) {
                        policy.alive_fallback_minutes
                    } else {
                        timeout
                    };
                    let cutoff = Timestamp::from_millis(at.millis() - minutes * 60_000).to_string();
                    (last < cutoff).then_some("HEARTBEAT_TIMEOUT")
                }
            };
            if let Some(reason) = reason {
                decided.push((project, id, agent, reason, last));
            }
        }
        if decided.is_empty() {
            return Ok(SweepReport::default());
        }
        self.store()
            .write(move |tx| {
                let at_iso = at.to_string();
                let mut report = SweepReport::default();
                for (project, id, agent, reason, last) in decided {
                    // 读快照之后被写过（心跳前进了）或已关闭的，跳过。
                    let still: Option<String> = tx
                        .query_row(
                            "SELECT COALESCE(heartbeat_at, updated_at) FROM agent_sessions
                             WHERE project_id = ?1 AND id = ?2 AND connection_state = 'ONLINE'",
                            [&project, &id],
                            |r| r.get(0),
                        )
                        .optional()
                        .map_err(db)?;
                    if still.as_deref() != Some(last.as_str()) {
                        continue;
                    }
                    let retirement = if reason == "CLIENT_EXITED" {
                        "client exited"
                    } else {
                        "heartbeat expired"
                    };
                    tx.execute(
                        "UPDATE agent_sessions SET connection_state = 'CLOSED', work_state = 'IDLE', updated_at = ?3,
                           closed_at = COALESCE(closed_at, ?3), close_reason = ?4, retirement_reason = ?5, version = version + 1
                         WHERE project_id = ?1 AND id = ?2",
                        params![project, id, at_iso, reason, retirement],
                    )
                    .map_err(db)?;
                    tx.execute(
                        "UPDATE work_items SET last_session_closed_at = ?3 WHERE project_id = ?1 AND claimed_by_session_id = ?2",
                        params![project, id, at_iso],
                    )
                    .map_err(db)?;
                    system_event(
                        tx,
                        &project,
                        "agent.recovered_stale",
                        ("SYSTEM", "SYSTEM"),
                        &id,
                        &json!({ "agentId": agent, "claimDisposition": "STALE_TAKEOVER_REQUIRED", "closeReason": reason }),
                        None,
                        &at_iso,
                    )?;
                    report.closed.push((project, id, reason.to_owned()));
                }
                Ok(report)
            })
            .map_err(write_error)
    }

    /// atm_end（02 §2.6）。心跳超时的旧 session 有唯一在线 successor 时结束的是 successor，没有就 SESSION_CLOSED（S-021）。
    pub fn end_session(
        &self,
        principal: &Principal,
        target: &Target,
        req: EndRequest,
    ) -> Result<Written, DomainError> {
        validate_end(&req)?;
        let group = principal.client_group().map(str::to_owned);
        let fp_req = req.clone();
        let fingerprint: FpInput = Box::new(move |_, family, _: &Author| end_fp(&fp_req, family));
        self.write(
            principal,
            WriteRequest {
                capability: Capability::SessionEnd,
                operation: END_OPERATION,
                op_id: target.op_id.clone(),
                scope: ReceiptScope::project(target.project_id.clone()),
                session: target.session.as_ref().map(|s| SessionRef {
                    project_id: target.project_id.clone(),
                    session_id: s.clone(),
                }),
                actor: None,
                expected_generation: target.expected_generation,
                fingerprint,
                compat_v1: None,
                replay_guard: None,
                prepare: None,
                rebind: Rebind::ExistingOnly,
            },
            move |tx, ctx| {
                end_owned(tx, ctx, group.as_deref())?;
                end_action(tx, ctx, &req)
            },
        )
    }

    /// 强制关闭（USER_ONLY，02 §2.8，S-017）。默认释放领取；已关闭的也照样执行（覆盖 close_reason）。
    pub fn force_close_session(
        &self,
        principal: &Principal,
        target: &Target,
        session: &str,
        release_claims: bool,
    ) -> Result<Written, DomainError> {
        let sid = session.to_owned();
        let fp_sid = sid.clone();
        let fingerprint: FpInput = Box::new(move |_, family, _: &Author| match family {
            Family::CanonV2 => Some(JsValue::from_json(
                &json!({ "session_id": fp_sid, "release_claims": release_claims }),
            )),
            _ => None,
        });
        self.write(
            principal,
            WriteRequest {
                capability: Capability::SessionForceClose,
                operation: FORCE_CLOSE_OPERATION,
                op_id: target.op_id.clone(),
                scope: ReceiptScope::project(target.project_id.clone()),
                session: None,
                actor: None,
                expected_generation: target.expected_generation,
                fingerprint,
                compat_v1: None,
                replay_guard: None,
                prepare: None,
                rebind: Rebind::ExistingOnly,
            },
            move |tx, ctx| {
                let project = ctx.scope.id.as_str();
                let at = ctx.now.to_string();
                let agent: Option<String> = tx
                    .query_row(
                        "SELECT agent_id FROM agent_sessions WHERE project_id = ?1 AND id = ?2",
                        [project, sid.as_str()],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(db)?;
                let Some(agent) = agent else {
                    return Err(DomainError::new(
                        ErrorCode::SESSION_NOT_FOUND,
                        format!("项目里没有 session {sid}"),
                    )
                    .detail("session_id", sid.as_str()));
                };
                let code = project_code(tx, project)?;
                let released = if release_claims {
                    release(tx, project, &code, &sid, &at)?.len()
                } else {
                    0
                };
                close(
                    tx,
                    project,
                    &sid,
                    "FORCE_CLOSE",
                    Some("closed by user"),
                    &at,
                )?;
                let seq = system_event(
                    tx,
                    project,
                    "agent.force_closed",
                    ("USER", "USER"),
                    &sid,
                    &json!({ "agentId": agent, "releasedClaims": released }),
                    Some(&ctx.op_id),
                    &at,
                )?;
                Ok(json!({ "session": sid, "released": released, "sequence": seq }))
            },
        )
    }

    /// 界面的「刷新 git 上下文」（U25，USER）。无变化不写、不发事件（S-022）。
    pub fn refresh_git_context(
        &self,
        principal: &Principal,
        project: &str,
        session: &str,
        git: GitContext,
    ) -> Result<Value, DomainError> {
        capability::require(principal, Capability::SessionGitRefresh)?;
        let (p, s) = (project.to_owned(), session.to_owned());
        self.store()
            .write(move |tx| {
                let at = now().to_string();
                let agent: Option<String> = tx
                    .query_row(
                        "SELECT agent_id FROM agent_sessions WHERE project_id = ?1 AND id = ?2",
                        [&p, &s],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(db)?;
                let Some(agent) = agent else {
                    return Err(DomainError::new(
                        ErrorCode::SESSION_NOT_FOUND,
                        format!("项目里没有 session {s}"),
                    )
                    .detail("session_id", s.as_str()));
                };
                if !apply_git(tx, &p, &s, &git, &at)? {
                    let seq: i64 = tx
                        .query_row("SELECT project_seq FROM projects WHERE id = ?1", [&p], |r| r.get(0))
                        .map_err(db)?;
                    return Ok(json!({ "updated": false, "sequence": seq }));
                }
                let seq = system_event(
                    tx,
                    &p,
                    "agent.git_context.updated",
                    ("SYSTEM", "SYSTEM"),
                    &s,
                    &json!({
                        "agentId": agent, "available": git.available, "branch": git.branch, "head": git.head,
                        "worktreeRoot": git.worktree_root, "dirty": git.dirty, "error": git.error,
                    }),
                    None,
                    &at,
                )?;
                Ok(json!({ "updated": true, "sequence": seq }))
            })
            .map_err(write_error)
    }
}
