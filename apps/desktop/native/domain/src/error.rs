//! 错误目录与统一错误信封（01 §7；00 §7 v6 清单；10 R3～R4、R11；11 §3）。
//!
//! 目录 = 2.x 的 `ERROR_POLICIES`（`packages/errors/src/index.ts`，HTTP 状态与可重试照抄）
//! 加上 ATM 3 新增的码。每个码都有一个默认的 `fix.kind`（11 §3），具体的 `fix.call` 由服务填。

use serde::Serialize;
use serde_json::{Map, Value};
use std::fmt;

macro_rules! catalog {
    ($($code:ident => $http:literal, $retry:literal, $fix:ident;)+) => {
        /// 全部错误码。
        #[allow(non_camel_case_types)]
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum ErrorCode { $($code),+ }

        impl ErrorCode {
            pub const ALL: &'static [ErrorCode] = &[$(ErrorCode::$code),+];

            pub const fn as_str(self) -> &'static str {
                match self { $(ErrorCode::$code => stringify!($code)),+ }
            }

            pub const fn http_status(self) -> u16 {
                match self { $(ErrorCode::$code => $http),+ }
            }

            pub const fn retryable(self) -> bool {
                match self { $(ErrorCode::$code => $retry),+ }
            }

            /// 11 §3 的默认出路种类。
            pub const fn fix_kind(self) -> FixKind {
                match self { $(ErrorCode::$code => FixKind::$fix),+ }
            }

            pub fn parse(text: &str) -> Option<Self> {
                match text { $(stringify!($code) => Some(ErrorCode::$code),)+ _ => None }
            }
        }
    };
}

// 码 => HTTP, 可重试, 默认 fix。
// Call：改正后的同一调用（或一步前置操作）；Reread：先读；AskUser：转告用户；Wait：稍后重试同一调用；
// None：只用于内部错误与 Agent 碰不到的码。
catalog! {
    // —— 2.x 继承 ——
    KNOWLEDGE_UNAVAILABLE => 503, true, Wait;
    AGENT_DOCS_MISSING => 500, true, None;
    AGENT_GUIDE_MISSING => 500, true, None;
    AGENT_RULE_MODIFIED_REQUIRES_REPAIR => 409, false, AskUser;
    AGENT_RULE_NEEDS_EXPLICIT_UPDATE => 409, false, AskUser;
    AGENT_SKILLS_MISSING => 500, true, None;
    AGENT_SKILL_MISSING => 500, true, None;
    AGENT_SKILL_MODIFIED_REQUIRES_REPAIR => 409, false, AskUser;
    // 10 R11 A3 起不再产生，只为 2.x 兼容说明保留。
    ATOMIC_BEGIN_REQUIRES_EXISTING_PROJECT => 422, false, Call;
    BACKUP_FILE_MISSING => 422, false, AskUser;
    BACKUP_HASH_MISMATCH => 422, false, AskUser;
    BACKUP_INTEGRITY_FAILED => 422, false, AskUser;
    BACKUP_MANIFEST_MISMATCH => 422, false, AskUser;
    BACKUP_MANIFEST_MISSING => 422, false, AskUser;
    BACKUP_NOT_FOUND => 404, false, Reread;
    BACKUP_PROJECT_IDENTITY_MISMATCH => 422, false, AskUser;
    BACKUP_RESTORE_SCOPE_UNSUPPORTED => 422, false, AskUser;
    BLOCKED_REASON_REQUIRED => 422, false, Call;
    CANDIDATE_HASH_MISMATCH => 422, false, Reread;
    CHECKLIST_NOT_FOUND => 404, false, Reread;
    CHECKLIST_TASK_MISMATCH => 409, false, Call;
    CLAIM_OWNER_REQUIRED => 422, false, Call;
    COMPLETION_GATE_FAILED => 409, false, Call;
    CONTINUATION_CONFLICT => 409, false, Reread;
    COUNTER_NOT_FOUND => 404, false, None;
    DEPENDENCY_CYCLE => 409, false, Call;
    DEPENDENCY_NOT_READY => 409, false, Call;
    DEPENDENCY_REF_NOT_FOUND => 404, false, Call;
    DISCOVERED_FROM_REF_NOT_FOUND => 404, false, Call;
    DUPLICATE_TOOL_DEFINITION => 500, false, None;
    EXTERNAL_NAME_MISSING => 500, false, None;
    FORBIDDEN => 403, false, None;
    HIERARCHY_CYCLE => 409, false, Call;
    HIERARCHY_DEPTH => 422, false, Call;
    IDEMPOTENCY_CONFLICT => 409, false, Reread;
    IMMUTABLE_RECORD => 409, false, Call;
    IMPORT_OBJECTIVE_MISSING => 422, false, Call;
    IMPORT_SOURCE_CHANGED => 409, false, Reread;
    INTERNAL_ERROR => 500, true, None;
    INVALID_ARGUMENT => 400, false, Call;
    INVALID_CURSOR => 422, false, Call;
    INVALID_PROJECT_CODE => 422, false, Call;
    INVALID_RESPONSE => 502, true, Wait;
    INVALID_TOOL_DESCRIPTION => 500, false, None;
    INVALID_TRANSITION => 409, false, Call;
    INVALID_WORK_ITEM_KEY => 422, false, Call;
    METHOD_NOT_ALLOWED => 405, false, None;
    MIGRATION_FILE_MISSING => 409, false, None;
    MIGRATION_GAP => 409, false, None;
    MIGRATION_HASH_MISMATCH => 409, false, None;
    MIGRATION_HASH_ORIGIN => 409, false, None;
    MIGRATION_HISTORY_GAP => 409, false, None;
    MIGRATION_NAME_MISMATCH => 409, false, None;
    MIGRATION_PLAN_EMPTY => 409, false, None;
    MILESTONE_OBJECTIVE_MISMATCH => 409, false, Call;
    MILESTONE_NOT_FOUND => 404, false, Call;
    NOT_FOUND => 404, false, Reread;
    OBJECTIVE_NOT_FOUND => 404, false, Call;
    OBJECTIVE_REQUIRED => 422, false, Call;
    OPERATION_ID_INVALID => 422, false, Call;
    OPERATION_NOT_FOUND => 404, false, Call;
    PARENT_REF_NOT_FOUND => 404, false, Call;
    PROGRESS_NOT_FOUND => 404, false, Reread;
    PROJECT_ALREADY_EXISTS => 409, false, Call;
    PROJECT_CODE_CONFLICT => 409, false, Call;
    PROJECT_CODE_EXHAUSTED => 409, false, Call;
    PROJECT_DB_QUICK_CHECK_FAILED => 500, true, AskUser;
    PROJECT_DB_UNAVAILABLE => 503, true, AskUser;
    PROJECT_LIFECYCLE_CONFLICT => 409, false, Reread;
    PROJECT_META_MISSING => 500, false, None;
    PROJECT_NOT_FOUND => 404, false, Call;
    PROJECT_PATH_CONFLICT => 409, false, AskUser;
    PROJECT_REQUIRED => 422, false, Call;
    PROJECT_RESTORE_REQUEST_DECIDED => 409, false, Reread;
    PROJECT_RESTORE_REQUEST_NOT_FOUND => 404, false, Reread;
    PROJECT_UPDATE_DRAFT_NOT_FOUND => 404, false, Reread;
    PROJECT_UPDATE_NOT_FOUND => 404, false, Reread;
    RECORD_NOT_FOUND => 404, false, Call;
    RESULT_TOO_LARGE => 422, false, Call;
    REVIEWER_REQUIRED => 403, false, Call;
    REVIEWER_SESSION_REQUIRED => 422, false, Call;
    REVIEW_ALREADY_SUBMITTED => 409, false, Reread;
    REVIEW_BINDING_MISMATCH => 409, false, Reread;
    REVIEW_CHECKLIST_CLOSED => 409, false, Reread;
    REVIEW_IDENTITY_MISMATCH => 409, false, Call;
    REVIEW_REQUEST_CONFLICT => 409, false, Reread;
    REVIEW_REQUEST_NOT_FOUND => 404, false, Reread;
    REVIEW_REQUEST_REQUIRES_SESSION => 422, false, Call;
    REVIEW_TASK_CLOSED => 409, false, Reread;
    REVIEW_TASK_INVALID => 422, false, Call;
    SAVED_VIEW_NAME_REQUIRED => 422, false, None;
    SESSION_CLOSED => 409, false, Call;
    SESSION_NOT_FOUND => 404, false, Call;
    SESSION_NOT_RETIRED => 409, false, Call;
    SESSION_REQUIRED => 422, false, Call;
    SESSION_SUCCESSOR_AGENT_MISMATCH => 409, false, Call;
    SESSION_SUCCESSOR_AMBIGUOUS => 409, false, Call;
    SESSION_SUCCESSOR_IDENTITY_MISMATCH => 409, false, Call;
    SETTING_KEY_INVALID => 422, false, None;
    SQLITE_FTS5_TRIGRAM_REQUIRED => 500, false, None;
    SQLITE_VERSION_UNSAFE => 500, false, None;
    TASK_ALREADY_CLAIMED => 409, false, Call;
    UNAUTHORIZED => 401, false, None;
    USER_AUTHORIZATION_REQUIRED => 403, false, AskUser;
    VALIDATION_ERROR => 422, false, Call;
    VERSION_CONFLICT => 409, true, Call;
    WAITING_FOR_REQUIRED => 422, false, Call;
    WORK_ITEM_NOT_FOUND => 404, false, Call;
    // —— ATM 3 新增（00 §7、10 R1～R4、R11）——
    CLAIM_NOT_OWNED => 409, false, Call;
    PLANNING_TARGET_CLOSED => 409, false, Call;
    REVIEW_SELF_NOT_ALLOWED => 409, false, AskUser;
    WORK_ITEM_TERMINAL => 409, false, Call;
    STORE_BUSY => 503, true, Wait;
    SERVICE_UNAVAILABLE => 503, true, Wait;
    KNOWLEDGE_SLUG_CONFLICT => 409, false, Call;
    OPERATION_UNDONE_BY_RESTORE => 409, false, Reread;
    SCOPE_RESTORED => 409, false, Reread;
    TARGET_CHANGED => 409, false, Call;
    EXPECTED_VERSION_REQUIRED => 422, false, Call;
    // 03 C-03：Phone / System 越权，只在内部出现（程序错误）。
    PRINCIPAL_CAPABILITY_DENIED => 403, false, None;
    // 10 R11 A3：桥也无法确定结果，fix.call 是带完整上下文的原调用。
    RESULT_UNKNOWN => 504, true, Call;
    // 03 §4.3、§4.4、P-008：宿主方法与手机命令的参数错误。
    NOTIFICATION_MODE_INVALID => 422, false, None;
    MCP_CLIENT_UNSUPPORTED => 422, false, None;
    COMMAND_EXPIRED => 410, false, None;
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Serialize for ErrorCode {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FixKind {
    Call,
    Reread,
    AskUser,
    Wait,
    None,
}

/// 11 §3 `committed`：这次写入有没有落库，是判断能不能重试的唯一依据。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Committed {
    No,
    Yes,
    Unknown,
}

impl Serialize for Committed {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Committed::No => s.serialize_bool(false),
            Committed::Yes => s.serialize_bool(true),
            Committed::Unknown => s.serialize_str("unknown"),
        }
    }
}

/// 一个可以原样执行的工具调用。`arguments` 必须能通过该工具的 schema（W4 校验）。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ToolCall {
    pub name: String,
    pub arguments: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Fix {
    Call {
        call: ToolCall,
        why: String,
    },
    Reread {
        call: ToolCall,
        why: String,
    },
    AskUser {
        message: String,
    },
    Wait {
        retry_after_ms: u64,
        call: Option<ToolCall>,
    },
    None,
}

/// INVALID_ARGUMENT 的逐项问题（11 §3）。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Problem {
    pub path: String,
    pub problem: ProblemKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub got: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub did_you_mean: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub over_by: Option<usize>,
}

impl Problem {
    pub fn new(path: impl Into<String>, problem: ProblemKind) -> Self {
        Problem {
            path: path.into(),
            problem,
            got: None,
            did_you_mean: None,
            allowed: None,
            over_by: None,
        }
    }

    pub fn got(mut self, value: impl Into<Value>) -> Self {
        self.got = Some(value.into());
        self
    }

    pub fn allowed(mut self, value: impl Into<Value>) -> Self {
        self.allowed = Some(value.into());
        self
    }

    pub fn over_by(mut self, n: usize) -> Self {
        self.over_by = Some(n);
        self
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProblemKind {
    Unknown,
    Missing,
    Enum,
    TooLong,
    TooShort,
    TooMany,
    TooFew,
    Pattern,
    Duplicate,
    Empty,
    Conflict,
}

/// 领域与服务的错误：码、中文消息、结构化 details。信封其余字段（committed、state、fix）由服务补。
#[derive(Clone, Debug, PartialEq)]
pub struct DomainError {
    pub code: ErrorCode,
    pub message: String,
    pub details: Map<String, Value>,
}

impl DomainError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        DomainError {
            code,
            message: message.into(),
            details: Map::new(),
        }
    }

    pub fn detail(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.details.insert(key.to_owned(), value.into());
        self
    }

    pub fn invalid_argument(problems: Vec<Problem>) -> Self {
        let message = match problems.first() {
            Some(p) => format!("参数不合法：{}", p.path),
            None => "参数不合法".to_owned(),
        };
        DomainError::new(ErrorCode::INVALID_ARGUMENT, message).detail(
            "problems",
            serde_json::to_value(problems).unwrap_or_default(),
        )
    }
}

impl fmt::Display for DomainError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for DomainError {}

/// 11 §3 的统一信封。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Envelope {
    pub ok: bool,
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    pub committed: Committed,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<Value>,
    pub fix: Fix,
    #[serde(skip_serializing_if = "Map::is_empty")]
    pub details: Map<String, Value>,
}

impl Envelope {
    pub fn new(error: DomainError, committed: Committed, state: Option<Value>, fix: Fix) -> Self {
        Envelope {
            ok: false,
            code: error.code,
            retryable: error.code.retryable(),
            message: error.message,
            committed,
            state,
            fix,
            details: error.details,
        }
    }
}
