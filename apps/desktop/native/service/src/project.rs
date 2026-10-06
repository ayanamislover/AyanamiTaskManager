//! 项目：创建、路径、生命周期、恢复请求（W2g1；04 L-001～L-012，D32、D33；10 A3 的 project.create）。
//!
//! - **创建**（L-001）：一个写事务里写 projects、scope_generations、counters、project_paths 与全局事件，提交后就是
//!   ACTIVE。marker 与 git exclude 是用户项目目录里的文件，不能放进写事务（C-L03）：回执给出要写的内容，
//!   由调用方在提交之后写，并如实报告 `markerWritten`。落点由服务端决定，所以走调用索引（A3）。
//! - **生命周期**（L-002）：只有 User；归档、进垃圾箱之前先做 PRE_* 备份，备份失败生命周期不变。
//! - **恢复请求**（L-003～L-006）：同一项目同时只有一条 PENDING，只有第一次登记记事件；决定只能做一次，
//!   批准与恢复在同一事务；用户直接从垃圾箱恢复时结掉挂着的请求。
//! - **垃圾箱项目不可写**（L-008）：写入流水线对项目范围的写入调用 [`require_writable`]；生命周期操作自己判定。

use crate::fp::{self, JsValue};
use crate::receipts::{self, CallKey, Candidate, NewReceipt, Rebuilt, ReceiptScope, Verdict};
use crate::write::{Family, FpInput, Rebind, Service, WriteCtx, WriteRequest, Written, internal};
use atm_domain::capability::{self, Capability};
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::keys;
use atm_domain::principal::{Principal, PrincipalKind};
use atm_domain::text::{js_trim, utf16_len};
use atm_store::events::{self as store_events};
use atm_store::paths::path_key;
use atm_store::{ReadError, WriteError};
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Map, Value, json};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

pub const CREATE_OPERATION: &str = "project.create";
pub const PATH_ATTACH_OPERATION: &str = "project.path-attach";
pub const RESTORE_DECIDE_OPERATION: &str = "project.restore-request.decide";

/// 生命周期操作：自己判定 TRASHED 的处理，不受 [`require_writable`] 拦截。
pub const LIFECYCLE_OPERATIONS: [&str; 5] = [
    "project.archive",
    "project.unarchive",
    "project.trash",
    "project.untrash",
    RESTORE_DECIDE_OPERATION,
];

/// 每个新项目都有的公开编号计数器。
const COUNTERS: [&str; 7] = [
    "work_item",
    "blocker",
    "objective",
    "milestone",
    "record",
    "review_request",
    "review_submission",
];

pub(crate) fn db(e: rusqlite::Error) -> DomainError {
    internal(e)
}

fn now_iso() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    atm_domain::time::Timestamp::from_millis(i64::try_from(ms).unwrap_or(i64::MAX)).to_string()
}

pub(crate) fn invalid(field: &str, message: impl Into<String>) -> DomainError {
    DomainError::new(ErrorCode::VALIDATION_ERROR, message).detail("field", field)
}

// ---------- 垃圾箱 ----------

/// TRASHED 项目的内容不可读写（04 §1.3、L-008）。
pub(crate) fn trashed_error(code: &str) -> DomainError {
    DomainError::new(
        ErrorCode::PROJECT_DB_UNAVAILABLE,
        format!("项目 {code} 在垃圾箱里，内容不可读写：等用户在界面里恢复"),
    )
    .detail("project", code)
    .detail("lifecycle", "TRASHED")
    .detail("retryable", false)
    .detail("recovery", json!({ "action": "restore_project" }))
}

/// 写入流水线的 L-008 闸门：项目在垃圾箱里就拒绝。
pub(crate) fn require_writable(tx: &Transaction<'_>, project_id: &str) -> Result<(), DomainError> {
    let row: Option<(String, String)> = tx
        .query_row(
            "SELECT code, lifecycle FROM projects WHERE id = ?1",
            [project_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(db)?;
    match row {
        Some((code, lifecycle)) if lifecycle == "TRASHED" => Err(trashed_error(&code)),
        _ => Ok(()),
    }
}

// ---------- 项目代码（L-012；2.x domain/src/index.ts） ----------

fn valid_code(code: &str) -> bool {
    let b = code.as_bytes();
    (2..=12).contains(&b.len())
        && b[0].is_ascii_uppercase()
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == b'-')
}

/// 2.x `codeCandidate`：驼峰拆词，非字母数字当分隔；多词时首字母 + 短尾词，或各词首字母；单词取前 6 个字符。
fn code_candidate(name: &str) -> Option<String> {
    let chars: Vec<char> = name.chars().collect();
    let mut spaced = String::new();
    for (i, &c) in chars.iter().enumerate() {
        if i > 0
            && c.is_ascii_uppercase()
            && (chars[i - 1].is_ascii_lowercase() || chars[i - 1].is_ascii_digit())
        {
            spaced.push(' ');
        }
        spaced.push(if c.is_ascii_alphanumeric() { c } else { ' ' });
    }
    let words: Vec<&str> = spaced.split_whitespace().collect();
    let (first, last) = (words.first()?, words.last()?);
    let raw: String = if words.len() > 1 && last.len() <= 4 {
        format!("{}{last}", &first[..1])
    } else if words.len() > 1 {
        words.iter().map(|w| &w[..1]).collect()
    } else {
        first.chars().take(6).collect()
    };
    let candidate: String = raw
        .to_ascii_uppercase()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(12)
        .collect();
    let b = candidate.as_bytes();
    (b.len() >= 2 && b[0].is_ascii_uppercase()).then_some(candidate)
}

/// 2.x `allocateProjectCode`：冲突时在末尾加数字后缀（总长不超过 12），试到 9999。
fn allocate_code(name: &str, existing: &[String]) -> Result<String, DomainError> {
    let base = code_candidate(name).unwrap_or_else(|| format!("AYT-{:04}", existing.len() + 1));
    if !existing.contains(&base) {
        return Ok(base);
    }
    for suffix in 2..10_000 {
        let s = suffix.to_string();
        let candidate = format!("{}{s}", &base[..base.len().min(12 - s.len())]);
        if !existing.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Err(DomainError::new(
        ErrorCode::PROJECT_CODE_EXHAUSTED,
        format!("无法为项目分配唯一代码：{name}"),
    )
    .detail("name", name)
    .detail("base", base.as_str())
    .detail("attempts", 9999))
}

// ---------- 创建 ----------

/// 调用方 realpath 之后的项目目录（唯一键由服务按 [`path_key`] 算）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PathInfo {
    pub canonical_path: String,
    pub git_common_dir: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CreateProjectRequest {
    pub name: String,
    /// 显式代码：按 `^[A-Z][A-Z0-9-]{1,11}$` 校验（先转大写）；省略时由名字派生。
    pub code: Option<String>,
    pub description: Option<String>,
    pub path: Option<PathInfo>,
    /// `SOLO` / `AUTO` / `MULTI`，缺省 AUTO。
    pub coordination_mode: Option<String>,
    pub creation_reason: Option<String>,
    pub signals: Map<String, Value>,
    /// 无 session 的 Agent 自报的 actor（调用索引的 principal id 与事件 actor）。
    pub actor: Option<String>,
    pub op_id: Option<String>,
}

impl CreateProjectRequest {
    pub fn new(name: impl Into<String>) -> Self {
        CreateProjectRequest {
            name: name.into(),
            code: None,
            description: None,
            path: None,
            coordination_mode: None,
            creation_reason: None,
            signals: Map::new(),
            actor: None,
            op_id: None,
        }
    }
}

/// 规范化之后的建项目输入。
#[derive(Clone, Debug)]
pub(crate) struct NewProjectSpec {
    pub name: String,
    pub code: Option<String>,
    pub description: String,
    pub path: Option<PathInfo>,
    pub coordination_mode: String,
    pub creation_reason: Option<String>,
    pub signals: Map<String, Value>,
}

pub(crate) fn spec(r: &CreateProjectRequest) -> Result<NewProjectSpec, DomainError> {
    let name = js_trim(&r.name).to_owned();
    if name.is_empty() || utf16_len(&name) > 200 {
        return Err(invalid("name", "name 必须是 1～200 个字符"));
    }
    let code = match r.code.as_deref().map(js_trim).filter(|c| !c.is_empty()) {
        Some(c) => {
            let upper = c.to_ascii_uppercase();
            if !valid_code(&upper) {
                return Err(DomainError::new(
                    ErrorCode::INVALID_PROJECT_CODE,
                    format!("项目代码无效：{c}"),
                )
                .detail("code", c)
                .detail("pattern", "^[A-Z][A-Z0-9-]{1,11}$"));
            }
            Some(upper)
        }
        None => None,
    };
    let description = r.description.clone().unwrap_or_default();
    if utf16_len(&description) > 5000 {
        return Err(invalid("description", "description 最多 5000 个字符"));
    }
    let coordination_mode = match r.coordination_mode.as_deref().map(js_trim) {
        None | Some("") => "AUTO".to_owned(),
        Some(m) => {
            let m = m.to_ascii_uppercase();
            if !["SOLO", "AUTO", "MULTI"].contains(&m.as_str()) {
                return Err(invalid(
                    "coordination_mode",
                    "coordination_mode 只能是 SOLO / AUTO / MULTI",
                ));
            }
            m
        }
    };
    let path = match &r.path {
        Some(p) => {
            let canonical = js_trim(&p.canonical_path).to_owned();
            if canonical.is_empty() {
                return Err(invalid("path", "项目目录不能为空"));
            }
            Some(PathInfo {
                canonical_path: canonical,
                git_common_dir: p.git_common_dir.clone().filter(|d| !js_trim(d).is_empty()),
            })
        }
        None => None,
    };
    Ok(NewProjectSpec {
        name,
        code,
        description,
        path,
        coordination_mode,
        creation_reason: r.creation_reason.clone(),
        signals: r.signals.clone(),
    })
}

/// 新建出来的项目。
#[derive(Clone, Debug)]
pub(crate) struct Created {
    pub id: String,
    pub code: String,
    pub name: String,
    pub generation: i64,
}

impl Created {
    /// 回执里的项目与待写的 marker（C-L03：提交之后由调用方写）。
    pub fn view(&self, path: Option<&PathInfo>) -> Value {
        json!({
            "project": { "id": self.id, "code": self.code, "name": self.name, "lifecycle": "ACTIVE", "version": 0 },
            "sourcePath": path.map(|p| p.canonical_path.clone()),
            "marker": path.map(|p| json!({
                "directory": p.canonical_path,
                "file": ".ayanami-task/project.json",
                "content": { "schema_version": 1, "project_id": self.id, "project_code": self.code, "name": self.name },
                "gitExclude": ".ayanami-task/",
            })),
        })
    }
}

/// 一个事务里建出 ACTIVE 项目（L-001）。路径已被任何项目（含垃圾箱里的）认领时 `PROJECT_ALREADY_EXISTS`（L-009）。
pub(crate) fn create_tx(
    tx: &Transaction<'_>,
    s: &NewProjectSpec,
    actor: &str,
    at: &str,
) -> Result<Created, DomainError> {
    if let Some(p) = &s.path {
        let key = path_key(&p.canonical_path);
        let owner: Option<(String, String)> = tx
            .query_row(
                "SELECT pr.code, pr.lifecycle FROM project_paths pp JOIN projects pr ON pr.id = pp.project_id
                 WHERE pp.path_key = ?1 OR (?2 IS NOT NULL AND pp.git_common_dir = ?2) LIMIT 1",
                params![key, p.git_common_dir],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(db)?;
        if let Some((code, lifecycle)) = owner {
            return Err(DomainError::new(
                ErrorCode::PROJECT_ALREADY_EXISTS,
                format!("这个目录已经属于项目 {code}（{lifecycle}）：直接用它，不要另建"),
            )
            .detail("source_path", p.canonical_path.as_str())
            .detail("project", code.as_str())
            .detail("lifecycle", lifecycle.as_str()));
        }
    }
    let existing: Vec<String> = tx
        .prepare("SELECT code FROM projects")
        .map_err(db)?
        .query_map([], |r| r.get(0))
        .map_err(db)?
        .collect::<rusqlite::Result<_>>()
        .map_err(db)?;
    let code = match &s.code {
        Some(c) if existing.contains(c) => {
            return Err(DomainError::new(
                ErrorCode::PROJECT_CODE_CONFLICT,
                format!("项目代码已存在：{c}"),
            )
            .detail("code", c.as_str()));
        }
        Some(c) => c.clone(),
        None => allocate_code(&s.name, &existing)?,
    };
    let id = store_events::ulid(tx).map_err(db)?;
    let (generation, epoch) =
        atm_store::restore::allocate_generation(tx).map_err(|e| internal(format!("{e:?}")))?;
    tx.execute(
        "INSERT INTO scope_generations (gen, scope_kind, scope_id, reason, epoch, created_at)
         VALUES (?1, 'PROJECT', ?2, 'CREATED', ?3, ?4)",
        params![generation, id, epoch, at],
    )
    .map_err(db)?;
    tx.execute(
        "INSERT INTO projects (id, code, name, description, lifecycle, coordination_mode, health, creation_reason,
                               creation_signals_json, version, meta_version, project_seq, scope_gen, epoch, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'ACTIVE', ?5, 'UNKNOWN', ?6, ?7, 0, 0, 0, ?8, ?9, ?10, ?10)",
        params![
            id,
            code,
            s.name,
            s.description,
            s.coordination_mode,
            s.creation_reason,
            Value::Object(s.signals.clone()).to_string(),
            generation,
            epoch,
            at
        ],
    )
    .map_err(db)?;
    for name in COUNTERS {
        tx.execute(
            "INSERT INTO counters (project_id, name, next_value) VALUES (?1, ?2, 1)",
            params![id, name],
        )
        .map_err(db)?;
    }
    if let Some(p) = &s.path {
        let path_id = store_events::ulid(tx).map_err(db)?;
        tx.execute(
            "INSERT INTO project_paths (id, project_id, path_key, canonical_path, git_common_dir, is_primary, last_seen_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)",
            params![path_id, id, path_key(&p.canonical_path), p.canonical_path, p.git_common_dir, at],
        )
        .map_err(db)?;
    }
    store_events::append_global(
        tx,
        "project.created",
        &id,
        actor,
        &json!({ "code": code, "sourcePath": s.path.as_ref().map(|p| &p.canonical_path) })
            .to_string(),
        None,
        at,
    )
    .map_err(|e| internal(format!("{e:?}")))?;
    Ok(Created {
        id,
        code,
        name: s.name.clone(),
        generation,
    })
}

fn create_fp(s: &NewProjectSpec) -> JsValue {
    JsValue::from_json(&json!({
        "name": s.name,
        "code": s.code,
        "description": s.description,
        "path": s.path.as_ref().map(|p| path_key(&p.canonical_path)),
        "coordination_mode": s.coordination_mode,
        "creation_reason": s.creation_reason,
        "signals": s.signals,
    }))
}

fn call_identity(principal: &Principal, actor: Option<&str>) -> (&'static str, String) {
    match principal.kind() {
        PrincipalKind::Agent => (
            "AGENT",
            actor.map_or("AGENT_ANON".to_owned(), str::to_owned),
        ),
        _ => ("USER", "USER".to_owned()),
    }
}

pub(crate) fn write_error(e: WriteError<DomainError>) -> DomainError {
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

fn read_error(e: ReadError<rusqlite::Error>) -> DomainError {
    match e {
        ReadError::Busy => DomainError::new(ErrorCode::STORE_BUSY, "存储繁忙，稍后重试"),
        other => internal(format!("{other:?}")),
    }
}

pub(crate) fn dom_read_error(e: ReadError<DomainError>) -> DomainError {
    match e {
        ReadError::Rejected(e) => e,
        ReadError::Busy => DomainError::new(ErrorCode::STORE_BUSY, "存储繁忙，稍后重试"),
        other => internal(format!("{other:?}")),
    }
}

pub(crate) fn idempotency_conflict(op: &str, operation: &str) -> DomainError {
    DomainError::new(
        ErrorCode::IDEMPOTENCY_CONFLICT,
        format!("这个 op_id 已经用于另一个不同的 {operation}：重试原请求请原样重发，新请求换一个新的 op_id"),
    )
    .detail("op_id", op)
}

// ---------- 恢复请求 ----------

/// 登记或续上一条 PENDING（L-004）：续上时只累加次数并更新请求者与来源目录；只有第一次登记记事件。
pub(crate) fn request_restore(
    tx: &Transaction<'_>,
    project_id: &str,
    code: &str,
    requested_by: &str,
    cwd: Option<&str>,
    at: &str,
) -> Result<(String, i64), DomainError> {
    let existing: Option<(String, i64)> = tx
        .query_row(
            "SELECT id, request_count FROM project_restore_requests WHERE project_id = ?1 AND status = 'PENDING'",
            [project_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(db)?;
    if let Some((id, n)) = existing {
        tx.execute(
            "UPDATE project_restore_requests SET request_count = request_count + 1, requested_by = ?2, source_cwd = ?3,
                    updated_at = ?4 WHERE id = ?1",
            params![id, requested_by, cwd, at],
        )
        .map_err(db)?;
        return Ok((id, n + 1));
    }
    let id = store_events::ulid(tx).map_err(db)?;
    tx.execute(
        "INSERT INTO project_restore_requests (id, project_id, requested_by, source_cwd, status, request_count, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'PENDING', 1, ?5, ?5)",
        params![id, project_id, requested_by, cwd, at],
    )
    .map_err(db)?;
    store_events::append_global(
        tx,
        "project.restore_requested",
        project_id,
        requested_by,
        &json!({ "code": code, "requestId": id, "sourceCwd": cwd }).to_string(),
        None,
        at,
    )
    .map_err(|e| internal(format!("{e:?}")))?;
    Ok((id, 1))
}

/// 结掉一条 PENDING（调用方在同一事务里处理生命周期）。
fn decide_request(
    tx: &Transaction<'_>,
    id: &str,
    decision: &str,
    actor: &str,
    code: &str,
    at: &str,
) -> Result<Value, DomainError> {
    let (status, requested_by, project_id): (String, String, String) = tx
        .query_row(
            "SELECT status, requested_by, project_id FROM project_restore_requests WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(db)?
        .ok_or_else(|| restore_request_not_found(id))?;
    if status != "PENDING" {
        return Err(DomainError::new(
            ErrorCode::PROJECT_RESTORE_REQUEST_DECIDED,
            format!("恢复请求已处理过：{status}"),
        )
        .detail("request_id", id)
        .detail("status", status.as_str()));
    }
    tx.execute(
        "UPDATE project_restore_requests SET status = ?2, decided_at = ?3, decided_by = ?4, updated_at = ?3 WHERE id = ?1",
        params![id, decision, at, actor],
    )
    .map_err(db)?;
    let kind = if decision == "APPROVED" {
        "project.restore_approved"
    } else {
        "project.restore_rejected"
    };
    store_events::append_global(
        tx,
        kind,
        &project_id,
        actor,
        &json!({ "code": code, "requestId": id, "requestedBy": requested_by }).to_string(),
        None,
        at,
    )
    .map_err(|e| internal(format!("{e:?}")))?;
    restore_request_view(tx, id)
}

fn restore_request_not_found(id: &str) -> DomainError {
    DomainError::new(
        ErrorCode::PROJECT_RESTORE_REQUEST_NOT_FOUND,
        format!("恢复请求不存在：{id}"),
    )
    .detail("request_id", id)
}

fn restore_request_view(tx: &Transaction<'_>, id: &str) -> Result<Value, DomainError> {
    tx.query_row(
        "SELECT r.id, p.code, r.requested_by, r.source_cwd, r.status, r.request_count, r.created_at, r.updated_at,
                r.decided_at, r.decided_by
         FROM project_restore_requests r JOIN projects p ON p.id = r.project_id WHERE r.id = ?1",
        [id],
        |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "projectCode": r.get::<_, String>(1)?,
                "requestedBy": r.get::<_, String>(2)?,
                "sourceCwd": r.get::<_, Option<String>>(3)?,
                "status": r.get::<_, String>(4)?,
                "requestCount": r.get::<_, i64>(5)?,
                "createdAt": r.get::<_, String>(6)?,
                "updatedAt": r.get::<_, String>(7)?,
                "decidedAt": r.get::<_, Option<String>>(8)?,
                "decidedBy": r.get::<_, Option<String>>(9)?,
            }))
        },
    )
    .optional()
    .map_err(db)?
    .ok_or_else(|| restore_request_not_found(id))
}

// ---------- 生命周期 ----------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transition {
    Archive,
    Unarchive,
    Trash,
    Untrash,
}

impl Transition {
    fn operation(self) -> &'static str {
        match self {
            Transition::Archive => "project.archive",
            Transition::Unarchive => "project.unarchive",
            Transition::Trash => "project.trash",
            Transition::Untrash => "project.untrash",
        }
    }

    fn capability(self) -> Capability {
        match self {
            Transition::Archive => Capability::ProjectArchive,
            Transition::Unarchive => Capability::ProjectUnarchive,
            Transition::Trash => Capability::ProjectTrash,
            Transition::Untrash => Capability::ProjectUntrash,
        }
    }

    /// 迁移前要做的备份（L-002）。
    fn backup(self) -> Option<&'static str> {
        match self {
            Transition::Archive => Some("PRE_ARCHIVE"),
            Transition::Trash => Some("PRE_TRASH"),
            _ => None,
        }
    }

    /// 从 `from` 出发的目标：`Ok(None)` 是已经在目标上（幂等），`Err` 是不允许的迁移。
    fn target(self, from: &str) -> Result<Option<&'static str>, &'static str> {
        match (self, from) {
            (Transition::Archive, "ACTIVE") => Ok(Some("ARCHIVED")),
            (Transition::Archive, "ARCHIVED") => Ok(None),
            (Transition::Archive, _) => Err("垃圾箱里的项目不能归档：先 untrash"),
            (Transition::Unarchive, "ARCHIVED") => Ok(Some("ACTIVE")),
            (Transition::Unarchive, "ACTIVE") => Ok(None),
            (Transition::Unarchive, _) => Err("垃圾箱里的项目用 untrash 恢复"),
            (Transition::Trash, "ACTIVE" | "ARCHIVED") => Ok(Some("TRASHED")),
            (Transition::Trash, _) => Ok(None),
            (Transition::Untrash, "TRASHED") => Ok(Some("ACTIVE")),
            (Transition::Untrash, "ACTIVE") => Ok(None),
            (Transition::Untrash, _) => Err("归档的项目用 unarchive 恢复"),
        }
    }
}

/// 生命周期动作要求先做备份时的内部标记（值是做备份前的项目版本）；只在 [`Service::set_lifecycle`]
/// 内部流转，不出服务。
const NEEDS_BACKUP: &str = "__needs_backup";
/// 备份期间项目版本一直在变时最多重做几次。
const LIFECYCLE_ATTEMPTS: usize = 4;

fn lifecycle_event(target: &str) -> &'static str {
    match target {
        "ARCHIVED" => "project.archived",
        "TRASHED" => "project.trashed",
        _ => "project.restored",
    }
}

#[derive(Clone, Debug)]
struct ProjectRow {
    id: String,
    code: String,
    name: String,
    lifecycle: String,
    version: i64,
}

fn project_row(tx: &Transaction<'_>, code_or_id: &str) -> Result<ProjectRow, DomainError> {
    let code = keys::normalize(code_or_id);
    tx.query_row(
        "SELECT id, code, name, lifecycle, version FROM projects WHERE code = ?1 OR id = ?2",
        params![code, js_trim(code_or_id)],
        |r| {
            Ok(ProjectRow {
                id: r.get(0)?,
                code: r.get(1)?,
                name: r.get(2)?,
                lifecycle: r.get(3)?,
                version: r.get(4)?,
            })
        },
    )
    .optional()
    .map_err(db)?
    .ok_or_else(|| {
        DomainError::new(ErrorCode::PROJECT_NOT_FOUND, format!("项目 {code} 不存在"))
            .detail("project", code.as_str())
    })
}

fn project_view(p: &ProjectRow) -> Value {
    json!({ "id": p.id, "code": p.code, "name": p.name, "lifecycle": p.lifecycle, "version": p.version })
}

/// 改生命周期：version+1、全局事件；从 TRASHED 回到 ACTIVE 时结掉挂着的 PENDING（L-006）。
fn apply_lifecycle(
    tx: &Transaction<'_>,
    p: &ProjectRow,
    target: &str,
    actor: &str,
    at: &str,
) -> Result<Option<Value>, DomainError> {
    tx.execute(
        "UPDATE projects SET lifecycle = ?2, version = version + 1, updated_at = ?3 WHERE id = ?1",
        params![p.id, target, at],
    )
    .map_err(db)?;
    store_events::append_global(
        tx,
        lifecycle_event(target),
        &p.id,
        actor,
        &json!({ "code": p.code }).to_string(),
        None,
        at,
    )
    .map_err(|e| internal(format!("{e:?}")))?;
    if p.lifecycle == "TRASHED" && target == "ACTIVE" {
        let pending: Option<String> = tx
            .query_row(
                "SELECT id FROM project_restore_requests WHERE project_id = ?1 AND status = 'PENDING'",
                [&p.id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db)?;
        if let Some(id) = pending {
            return decide_request(tx, &id, "APPROVED", actor, &p.code, at).map(Some);
        }
    }
    Ok(None)
}

impl Service {
    /// 换备份目录（生命周期迁移前的 PRE_* 备份写在这里）。
    pub fn with_backups_root(mut self, root: PathBuf) -> Self {
        self.backups_root = Some(root);
        self
    }

    /// project.create（04 L-001、L-009、L-012；10 A3：落点由服务端决定，走调用索引）。
    pub fn create_project(
        &self,
        principal: &Principal,
        r: CreateProjectRequest,
    ) -> Result<Written, DomainError> {
        capability::require(principal, Capability::ProjectCreate)?;
        let s = spec(&r)?;
        let (kind, id) = call_identity(principal, r.actor.as_deref());
        let op_id = match r.op_id.as_deref().map(js_trim) {
            Some("") => return Err(invalid("op_id", "op_id 不能为空")),
            Some(op) if utf16_len(op) > 128 => {
                return Err(invalid("op_id", "op_id 最多 128 个字符"));
            }
            other => other.map(str::to_owned),
        };
        let actor = if kind == "AGENT" {
            id.clone()
        } else {
            "USER".to_owned()
        };
        self.store()
            .write(move |tx| {
                let at = now_iso();
                let call = CallKey {
                    principal_kind: kind,
                    principal_id: id.clone(),
                    operation: CREATE_OPERATION.to_owned(),
                };
                let input = create_fp(&s);
                if let Some(op) = &op_id {
                    let rebuild = |c: &Candidate| match Family::parse(&c.fp_family) {
                        Some(Family::CanonV2) => Rebuilt::Fingerprint(fp::canon_v2(&input)),
                        _ => Rebuilt::NotComparable,
                    };
                    match receipts::find_call(tx, &call, op, None, &rebuild).map_err(db)? {
                        Verdict::New => {}
                        Verdict::Replay(c) => {
                            return Ok(Written {
                                result: serde_json::from_str(&c.receipt_json).map_err(internal)?,
                                replayed: true,
                                receipt_id: c.receipt_id,
                                rebound_to: None,
                            });
                        }
                        Verdict::Undone { generation } => {
                            return Err(DomainError::new(
                                ErrorCode::OPERATION_UNDONE_BY_RESTORE,
                                "这个 op_id 建的项目已被一次按范围恢复撤销：先读当前状态，再决定是否用新的 op_id 重建",
                            )
                            .detail("op_id", op.as_str())
                            .detail("restored_generation", generation));
                        }
                        Verdict::Conflict { .. } => {
                            return Err(idempotency_conflict(op, CREATE_OPERATION));
                        }
                    }
                }
                let created = create_tx(tx, &s, &actor, &at)?;
                let result = created.view(s.path.as_ref());
                let receipt_id = match &op_id {
                    Some(op) => receipts::insert(
                        tx,
                        &NewReceipt {
                            scope: &ReceiptScope::project(created.id.clone()),
                            ns: None,
                            call: Some(&call),
                            op_id: op,
                            operation: CREATE_OPERATION,
                            fingerprint: &fp::canon_v2(&input),
                            receipt_json: &result.to_string(),
                            author_agent: (kind == "AGENT").then_some(id.as_str()),
                            author_session: None,
                            actor_session_id: None,
                            scope_generation: Some(created.generation),
                            created_at: &at,
                        },
                    )
                    .map_err(db)?,
                    None => 0,
                };
                Ok(Written {
                    result,
                    replayed: false,
                    receipt_id,
                    rebound_to: None,
                })
            })
            .map_err(write_error)
    }

    /// 登记项目目录（User；04 L-009、L-010）。已被别的项目认领（含经 git common dir）→ `PROJECT_PATH_CONFLICT`；
    /// `primary` 时把这个项目的其他路径改成非 primary。marker 由调用方在提交后写。
    pub fn attach_path(
        &self,
        principal: &Principal,
        project: &str,
        path: PathInfo,
        primary: bool,
        op_id: &str,
    ) -> Result<Written, DomainError> {
        capability::require(principal, Capability::ProjectPathAttach)?;
        let canonical = js_trim(&path.canonical_path).to_owned();
        if canonical.is_empty() {
            return Err(invalid("path", "项目目录不能为空"));
        }
        let target = self.project_scope(project)?;
        let common = path
            .git_common_dir
            .clone()
            .filter(|d| !js_trim(d).is_empty());
        let key = path_key(&canonical);
        let fp_value = json!({ "path": key, "git_common_dir": common, "primary": primary });
        self.write(
            principal,
            WriteRequest {
                capability: Capability::ProjectPathAttach,
                operation: PATH_ATTACH_OPERATION,
                op_id: op_id.to_owned(),
                scope: ReceiptScope::project(target.clone()),
                session: None,
                actor: None,
                expected_generation: None,
                fingerprint: fixed_fp(fp_value),
                compat_v1: None,
                replay_guard: None,
                prepare: None,
                rebind: Rebind::Create,
            },
            move |tx, ctx| {
                let at = ctx.now.to_string();
                let p = project_row(tx, &target)?;
                let owner: Option<(String, String)> = tx
                    .query_row(
                        "SELECT pr.id, pr.code FROM project_paths pp JOIN projects pr ON pr.id = pp.project_id
                         WHERE pp.path_key = ?1 OR (?2 IS NOT NULL AND pp.git_common_dir = ?2)
                         ORDER BY pp.path_key = ?1 DESC LIMIT 1",
                        params![key, common],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()
                    .map_err(db)?;
                if let Some((owner, code)) = &owner
                    && *owner != p.id
                {
                    return Err(DomainError::new(
                        ErrorCode::PROJECT_PATH_CONFLICT,
                        format!("这个目录已经属于项目 {code}"),
                    )
                    .detail("path", canonical.as_str())
                    .detail("project", code.as_str()));
                }
                if primary {
                    tx.execute(
                        "UPDATE project_paths SET is_primary = 0 WHERE project_id = ?1 AND path_key <> ?2",
                        params![p.id, key],
                    )
                    .map_err(db)?;
                }
                let updated = tx
                    .execute(
                        "UPDATE project_paths SET canonical_path = ?3, git_common_dir = ?4, last_seen_at = ?5,
                                is_primary = CASE WHEN ?6 THEN 1 ELSE is_primary END
                         WHERE project_id = ?1 AND path_key = ?2",
                        params![p.id, key, canonical, common, at, primary],
                    )
                    .map_err(db)?;
                if updated == 0 {
                    let id = store_events::ulid(tx).map_err(db)?;
                    tx.execute(
                        "INSERT INTO project_paths (id, project_id, path_key, canonical_path, git_common_dir, is_primary, last_seen_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                        params![id, p.id, key, canonical, common, primary, at],
                    )
                    .map_err(db)?;
                }
                tx.execute(
                    "UPDATE projects SET version = version + 1, updated_at = ?2 WHERE id = ?1",
                    params![p.id, at],
                )
                .map_err(db)?;
                let p = project_row(tx, &p.id)?;
                Ok(json!({
                    "project": project_view(&p),
                    "path": canonical,
                    "primary": primary,
                    "marker": {
                        "directory": canonical,
                        "file": ".ayanami-task/project.json",
                        "content": { "schema_version": 1, "project_id": p.id, "project_code": p.code, "name": p.name },
                        "gitExclude": ".ayanami-task/",
                    },
                }))
            },
        )
    }

    /// 归档、取消归档、进垃圾箱、从垃圾箱恢复（User；04 L-002、L-006、L-007）。
    ///
    /// PRE_* 备份是文件 IO，不能放进写事务；但它也不能早于幂等裁决（peer W2 r1 P1-02）。所以分两趟：
    /// 第一趟不带备份走完整条流水线——重放、冲突、已经在目标上的请求在这里就有结果，不碰备份；
    /// 只有判定为新操作、而且真要迁移时，动作以 [`NEEDS_BACKUP`] 失败（整个事务回滚，零写入）。
    /// 这时做备份，再带着它写第二趟。第二趟里项目版本变了（并发迁移抢先）就重做备份；第二趟以重放、
    /// 冲突、没迁移或失败告终时，这份备份不属于任何迁移，撤回（删行、删目录；尽力而为，见
    /// [`Service::withdraw_backup`]）。备份失败生命周期不变。
    pub fn set_lifecycle(
        &self,
        principal: &Principal,
        project: &str,
        transition: Transition,
        op_id: &str,
    ) -> Result<Written, DomainError> {
        capability::require(principal, transition.capability())?;
        let target_id = self.project_scope(project)?;
        let mut backup: Option<(atm_store::backup::BackupInfo, i64)> = None;
        for _ in 0..LIFECYCLE_ATTEMPTS {
            let pre = backup.as_ref().map(|(b, v)| (b.id.clone(), *v));
            match self.lifecycle_write(principal, &target_id, transition, op_id, pre) {
                Err(e) if e.details.contains_key(NEEDS_BACKUP) => {
                    if let Some((stale, _)) = backup.take() {
                        self.withdraw_backup(&stale);
                    }
                    let version = e.details[NEEDS_BACKUP].as_i64().unwrap_or_default();
                    let kind = transition
                        .backup()
                        .ok_or_else(|| internal("迁移不需要备份"))?;
                    backup = Some((self.pre_backup(kind)?, version));
                    if let Some(hook) = &self.backup_hook {
                        hook();
                    }
                }
                other => {
                    if let Some((b, _)) = backup.take() {
                        let used = matches!(&other, Ok(w) if !w.replayed && w.result["backupId"] == b.id.as_str());
                        if !used {
                            self.withdraw_backup(&b);
                        }
                    }
                    return other;
                }
            }
        }
        if let Some((b, _)) = backup.take() {
            self.withdraw_backup(&b);
        }
        Err(DomainError::new(
            ErrorCode::STORE_BUSY,
            "项目生命周期在备份期间反复被改动，这次没有迁移；稍后重试",
        )
        .detail("committed", false))
    }

    fn pre_backup(&self, kind: &'static str) -> Result<atm_store::backup::BackupInfo, DomainError> {
        let root = self
            .backups_root
            .clone()
            .ok_or_else(|| internal("没有配置备份目录：生命周期迁移前的备份做不了"))?;
        atm_store::backup::create_backup(self.store(), &root, kind, &now_iso()).map_err(|e| {
            DomainError::new(
                ErrorCode::INTERNAL_ERROR,
                format!("{kind} 备份失败，项目生命周期没有改变：{e}"),
            )
            .detail("backup_kind", kind)
        })
    }

    /// 撤回一份没用上的备份。尽力而为：撤回失败时留下的是一份完整、有效的备份（W5 的保留期会清），
    /// 不能因此把已经有结果的请求（迁移、重放、冲突）改报成错误，也不该因此中止一次还没开始的迁移。
    fn withdraw_backup(&self, b: &atm_store::backup::BackupInfo) {
        let _ = atm_store::backup::discard_backup(self.store(), b);
    }

    /// 一趟生命周期写入。`pre` 是已经做好的备份与做备份前读到的项目版本。
    fn lifecycle_write(
        &self,
        principal: &Principal,
        target_id: &str,
        transition: Transition,
        op_id: &str,
        pre: Option<(String, i64)>,
    ) -> Result<Written, DomainError> {
        let target_id = target_id.to_owned();
        self.write(
            principal,
            WriteRequest {
                capability: transition.capability(),
                operation: transition.operation(),
                op_id: op_id.to_owned(),
                scope: ReceiptScope::project(target_id.clone()),
                session: None,
                actor: None,
                expected_generation: None,
                fingerprint: fixed_fp(json!({ "project": target_id })),
                compat_v1: None,
                replay_guard: None,
                prepare: None,
                rebind: Rebind::Create,
            },
            move |tx, ctx: &WriteCtx| {
                let at = ctx.now.to_string();
                let p = project_row(tx, &target_id)?;
                let target = transition.target(&p.lifecycle).map_err(|why| {
                    DomainError::new(ErrorCode::PROJECT_LIFECYCLE_CONFLICT, why)
                        .detail("lifecycle", p.lifecycle.as_str())
                        .detail("operation", transition.operation())
                })?;
                let backup = match (target, transition.backup(), &pre) {
                    (Some(_), Some(_), Some((id, version))) if *version == p.version => {
                        Some(id.clone())
                    }
                    (Some(_), Some(_), _) => {
                        return Err(internal("迁移前要先做备份").detail(NEEDS_BACKUP, p.version));
                    }
                    _ => None,
                };
                let (changed, request) = match target {
                    Some(t) => (true, apply_lifecycle(tx, &p, t, &ctx.actor.id, &at)?),
                    None => (false, None),
                };
                let p = project_row(tx, &target_id)?;
                Ok(json!({
                    "project": project_view(&p),
                    "changed": changed,
                    "backupId": backup,
                    "restoreRequest": request,
                }))
            },
        )
    }

    /// 决定一条恢复请求（User；04 L-005）：批准时项目回到 ACTIVE，同一事务。
    pub fn decide_restore_request(
        &self,
        principal: &Principal,
        request_id: &str,
        approve: bool,
        op_id: &str,
    ) -> Result<Written, DomainError> {
        capability::require(principal, Capability::ProjectRestoreRequestDecide)?;
        let request_id = js_trim(request_id).to_owned();
        let project_id: String = {
            let id = request_id.clone();
            self.store()
                .read(move |tx| {
                    tx.query_row(
                        "SELECT project_id FROM project_restore_requests WHERE id = ?1",
                        [&id],
                        |r| r.get(0),
                    )
                    .optional()
                })
                .map_err(read_error)?
                .ok_or_else(|| restore_request_not_found(&request_id))?
        };
        let decision = if approve { "APPROVED" } else { "REJECTED" };
        self.write(
            principal,
            WriteRequest {
                capability: Capability::ProjectRestoreRequestDecide,
                operation: RESTORE_DECIDE_OPERATION,
                op_id: op_id.to_owned(),
                scope: ReceiptScope::project(project_id.clone()),
                session: None,
                actor: None,
                expected_generation: None,
                fingerprint: fixed_fp(json!({ "request_id": request_id, "decision": decision })),
                compat_v1: None,
                replay_guard: None,
                prepare: None,
                rebind: Rebind::Create,
            },
            move |tx, ctx| {
                let at = ctx.now.to_string();
                let p = project_row(tx, &project_id)?;
                let request =
                    decide_request(tx, &request_id, decision, &ctx.actor.id, &p.code, &at)?;
                if approve && p.lifecycle == "TRASHED" {
                    apply_lifecycle(tx, &p, "ACTIVE", &ctx.actor.id, &at)?;
                }
                let p = project_row(tx, &project_id)?;
                Ok(json!({ "request": request, "project": project_view(&p) }))
            },
        )
    }

    /// 读注册信息（任何生命周期都可读，04 L-008）。
    pub fn project_info(&self, principal: &Principal, project: &str) -> Result<Value, DomainError> {
        capability::require(principal, Capability::ProjectRead)?;
        let project = project.to_owned();
        self.store()
            .read(move |tx| {
                let p = project_row(tx, &project)?;
                let paths: Vec<Value> = tx
                    .prepare(
                        "SELECT canonical_path, git_common_dir, is_primary FROM project_paths
                         WHERE project_id = ?1 ORDER BY is_primary DESC, canonical_path",
                    )
                    .map_err(db)?
                    .query_map([&p.id], |r| {
                        Ok(json!({
                            "path": r.get::<_, String>(0)?,
                            "gitCommonDir": r.get::<_, Option<String>>(1)?,
                            "primary": r.get::<_, i64>(2)? == 1,
                        }))
                    })
                    .map_err(db)?
                    .collect::<rusqlite::Result<_>>()
                    .map_err(db)?;
                let mut v = project_view(&p);
                v["paths"] = Value::Array(paths);
                Ok(v)
            })
            .map_err(dom_read_error)
    }

    /// 垃圾箱：TRASHED 项目与它们挂着的恢复请求（User 界面）。
    pub fn trash(&self, principal: &Principal) -> Result<Value, DomainError> {
        capability::require(principal, Capability::ProjectRestoreRequestDecide)?;
        self.store()
            .read(|tx| -> Result<Value, rusqlite::Error> {
                let projects: Vec<Value> = tx
                    .prepare(
                        "SELECT p.id, p.code, p.name, p.version, p.updated_at,
                                r.id, r.request_count, r.requested_by, r.source_cwd, r.updated_at
                         FROM projects p
                         LEFT JOIN project_restore_requests r ON r.project_id = p.id AND r.status = 'PENDING'
                         WHERE p.lifecycle = 'TRASHED' ORDER BY p.updated_at DESC, p.code",
                    )?
                    .query_map([], |r| {
                        let request = match r.get::<_, Option<String>>(5)? {
                            Some(id) => json!({
                                "id": id,
                                "requestCount": r.get::<_, i64>(6)?,
                                "requestedBy": r.get::<_, String>(7)?,
                                "sourceCwd": r.get::<_, Option<String>>(8)?,
                                "updatedAt": r.get::<_, String>(9)?,
                            }),
                            None => Value::Null,
                        };
                        Ok(json!({
                            "id": r.get::<_, String>(0)?,
                            "code": r.get::<_, String>(1)?,
                            "name": r.get::<_, String>(2)?,
                            "version": r.get::<_, i64>(3)?,
                            "trashedAt": r.get::<_, String>(4)?,
                            "pendingRequest": request,
                        }))
                    })?
                    .collect::<rusqlite::Result<_>>()?;
                Ok(json!({ "projects": projects }))
            })
            .map_err(read_error)
    }

    /// 按代码或 id 找到项目 id（不看生命周期）。
    pub(crate) fn project_scope(&self, project: &str) -> Result<String, DomainError> {
        let project = project.to_owned();
        let found: Option<String> = {
            let code = keys::normalize(&project);
            let id = js_trim(&project).to_owned();
            self.store()
                .read(move |tx| {
                    tx.query_row(
                        "SELECT id FROM projects WHERE code = ?1 OR id = ?2",
                        params![code, id],
                        |r| r.get(0),
                    )
                    .optional()
                })
                .map_err(read_error)?
        };
        found.ok_or_else(|| {
            let code = keys::normalize(&project);
            DomainError::new(ErrorCode::PROJECT_NOT_FOUND, format!("项目 {code} 不存在"))
                .detail("project", code.as_str())
        })
    }
}

/// 落点固定、只有 canon-v2 的 User 写入的指纹。
pub(crate) fn fixed_fp(value: Value) -> FpInput {
    Box::new(move |_, family, _| match family {
        Family::CanonV2 => Some(JsValue::from_json(&value)),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_candidates_follow_2x() {
        assert_eq!(code_candidate("AyanamiTaskManager").as_deref(), Some("ATM"));
        assert_eq!(code_candidate("ayanami task").as_deref(), Some("ATASK"));
        assert_eq!(
            code_candidate("Payments Service API").as_deref(),
            Some("PAPI")
        );
        assert_eq!(
            code_candidate("big service platform").as_deref(),
            Some("BSP")
        );
        assert_eq!(code_candidate("frontend").as_deref(), Some("FRONTE"));
        assert_eq!(code_candidate("项目"), None);
        assert_eq!(code_candidate("9lives"), None);
    }

    #[test]
    fn allocation_adds_suffixes_and_falls_back() {
        let existing = vec!["ATM".to_owned(), "ATM2".to_owned()];
        assert_eq!(
            allocate_code("AyanamiTaskManager", &existing).unwrap(),
            "ATM3"
        );
        assert_eq!(allocate_code("项目", &existing).unwrap(), "AYT-0003");
        let long = vec!["ABCDEFGHIJKL".to_owned()];
        assert_eq!(allocate_code("abcdefghijkl", &long).unwrap(), "ABCDEF");
        // 12 位的基础代码加后缀时截短，总长仍是 12。
        assert_eq!(
            allocate_code("a b c d e f g h i j k lemon", &long).unwrap(),
            "ABCDEFGHIJK2"
        );
    }

    #[test]
    fn explicit_codes_are_validated() {
        assert!(valid_code("ATM"));
        assert!(valid_code("A-1"));
        assert!(!valid_code("A"));
        assert!(!valid_code("1AB"));
        assert!(!valid_code("ABCDEFGHIJKLM"));
        assert!(!valid_code("aTM"));
        assert!(!valid_code("AtM"));
    }
}
