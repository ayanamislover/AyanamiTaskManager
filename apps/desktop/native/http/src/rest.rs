//! Agent REST（06 §2 路由总表；03 §1.1、§5.2；W4h）。
//!
//! [`ROUTES`] 是 2.0 的 109 条路由逐条的 3.0 处置，Agent HTTP 的 REST 部分完全由它生成：
//! - **A / A+U**：绑定处理器。有对应 MCP 工具的（任务、进度、记录、搜索、begin / end 等）走同一套参数
//!   校验与同一个服务入口——路径里的项目代码、任务 key、session 注入参数，其余参数与工具同名；
//!   GET 的 query 按工具字段的类型转换。没有工具的读写（项目、quick、事件、review 请求、状态等）在这里映射。
//! - **U\***：统一拒绝桩，`USER_AUTHORIZATION_REQUIRED`（403），不读 body、不绑定任何处理器、不碰服务。
//! - **U 与删**：Agent HTTP 上没有这条入口，一律 404：显式登记成 404，同一路径有别的方法时、或者会被同方法的
//!   参数路由接走时（`ui/checklist/batch` 与 `ui/checklist/:id`），也是 404 而不是 405 或别的处理器。
//! - **MCP**：`/mcp/<profile>` 由 [`crate::mcp::routes`] 注册；这里只登记，供快照与守卫核对。
//!
//! 与 06 §2 的出入：#27 导出按 00 C-07（v6，晚于 06）只给 User，所以是拒绝桩而不是 A+U。

use crate::agent::{Args, Surface};
use crate::mcp::{Handler, invalid_argument};
use crate::schema::{Field, Tool, Ty};
use crate::{Agent, AppState, read_json, refuse, reply};
use atm_domain::capability::{Capability, USER_NEXT_STEP};
use atm_domain::error::{Committed, DomainError, Envelope, ErrorCode, Fix, Problem, ProblemKind};
use atm_service::project::{CreateProjectRequest, PathInfo};
use atm_service::quick::{QuickCreateRequest, QuickPromoteRequest};
use atm_service::work::{MilestoneRequest, ObjectiveRequest};
use atm_service::write::Written;
use axum::Router;
use axum::body::Body;
use axum::extract::rejection::PathRejection;
use axum::extract::{Path, RawQuery, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{MethodFilter, on};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::Arc;

/// U\* 拒绝桩指向的用户入口：一个 U-only 能力（入口文字取 [`Capability::user_entry`]），或者 2.0 里
/// 「以用户身份写」的界面路由（能力本身 Agent 也有，只是这条路由代表用户）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Deny {
    Cap(Capability),
    Ui(&'static str),
}

impl Deny {
    pub fn entry(self) -> &'static str {
        match self {
            Deny::Cap(c) => c.user_entry().unwrap_or("ATM 桌面端"),
            Deny::Ui(entry) => entry,
        }
    }
}

/// 06 §0 的 3.0 处置。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Disp {
    /// 只在 Agent HTTP。
    A,
    /// Agent HTTP 与 ui-bridge 都有（ui-bridge 在 W5）。
    Au,
    /// 2.0 USER_ONLY：Agent HTTP 上是拒绝桩。
    UStar(Deny),
    /// 只在 ui-bridge（含两条兼容替代）：Agent HTTP 上 404。
    U,
    /// 删除：两边都 404。
    Gone,
    /// MCP 入口（POST）与它的 405（GET / DELETE）。
    Mcp,
}

/// 一条 2.0 路由与它的 3.0 处置。路径用 2.0 的 `:参数` 写法。
#[derive(Clone, Copy, Debug)]
pub struct Route {
    pub n: u16,
    pub method: &'static str,
    pub path: &'static str,
    pub disp: Disp,
}

const fn r(n: u16, method: &'static str, path: &'static str, disp: Disp) -> Route {
    Route {
        n,
        method,
        path,
        disp,
    }
}

use Capability as C;
use Deny::{Cap, Ui};
use Disp::{A, Au, Gone, Mcp, U, UStar};

/// 06 §2 的路由总表（2.0 共 109 条），编号与 06 一致。
pub const ROUTES: &[Route] = &[
    // §2.1 系统、视图、设置、项目
    r(1, "GET", "/api/v1/system/status", Au),
    r(2, "GET", "/api/v1/overview", U),
    // #3、#4：投影健康面板的两条重试，随面板在 W5 删除（00 §6）。
    r(
        3,
        "POST",
        "/api/v1/projects/:code/projection/reconcile",
        Gone,
    ),
    r(4, "POST", "/api/v1/system/projections/reconcile", Gone),
    r(5, "GET", "/api/v1/saved-views", U),
    r(
        6,
        "POST",
        "/api/v1/saved-views",
        UStar(Cap(C::SavedViewManage)),
    ),
    r(7, "PATCH", "/api/v1/saved-views/:id", Gone),
    r(
        8,
        "DELETE",
        "/api/v1/saved-views/:id",
        UStar(Cap(C::SavedViewManage)),
    ),
    r(9, "GET", "/api/v1/settings", U),
    r(
        10,
        "PUT",
        "/api/v1/settings/:key",
        UStar(Cap(C::SettingsWrite)),
    ),
    r(11, "GET", "/api/v1/projects", Au),
    r(12, "GET", "/api/v1/trash/projects", U),
    r(
        13,
        "POST",
        "/api/v1/trash/restore-requests/:id/approve",
        UStar(Cap(C::ProjectRestoreRequestDecide)),
    ),
    r(
        14,
        "POST",
        "/api/v1/trash/restore-requests/:id/reject",
        UStar(Cap(C::ProjectRestoreRequestDecide)),
    ),
    r(15, "POST", "/api/v1/projects", Au),
    r(16, "GET", "/api/v1/projects/:code", A),
    r(17, "POST", "/api/v1/projects/:code/paths", Gone),
    r(18, "GET", "/api/v1/projects/:code/engineering-metrics", U),
    r(
        19,
        "POST",
        "/api/v1/projects/:code/archive",
        UStar(Cap(C::ProjectArchive)),
    ),
    r(
        20,
        "POST",
        "/api/v1/projects/:code/restore",
        UStar(Cap(C::ProjectUnarchive)),
    ),
    r(
        21,
        "POST",
        "/api/v1/projects/:code/trash",
        UStar(Cap(C::ProjectTrash)),
    ),
    // §2.2 备份、导入导出、项目读取
    r(22, "GET", "/api/v1/backups", Au),
    r(
        23,
        "POST",
        "/api/v1/backups",
        UStar(Cap(C::BackupCreateManual)),
    ),
    r(
        24,
        "POST",
        "/api/v1/backups/:id/restore",
        UStar(Cap(C::BackupRestoreScope)),
    ),
    r(25, "POST", "/api/v1/imports/agenttask-md/preview", Au),
    r(
        26,
        "POST",
        "/api/v1/imports/agenttask-md/apply",
        UStar(Cap(C::ImportApply)),
    ),
    // 00 C-07（v6）：导出只给 User（06 原写 A+U）。
    r(
        27,
        "GET",
        "/api/v1/exports/:projectCode",
        UStar(Cap(C::ExportCreate)),
    ),
    r(28, "GET", "/api/v1/projects/:code/objectives", U),
    r(29, "GET", "/api/v1/projects/:code/milestones", U),
    r(30, "GET", "/api/v1/projects/:code/agents", U),
    r(
        31,
        "GET",
        "/api/v1/projects/:code/sessions/:sessionId",
        Gone,
    ),
    r(32, "GET", "/api/v1/projects/:code/reconciliation", U),
    r(33, "GET", "/api/v1/projects/:code/records", U),
    r(34, "GET", "/api/v1/projects/:code/records/:recordKey", Gone),
    r(
        35,
        "GET",
        "/api/v1/projects/:code/progress-updates/:progressId",
        Gone,
    ),
    r(36, "GET", "/api/v1/projects/:code/project-updates", U),
    r(
        37,
        "GET",
        "/api/v1/projects/:code/project-updates/:updateId",
        Gone,
    ),
    r(38, "GET", "/api/v1/projects/:code/operations/:opId", Gone),
    r(
        39,
        "POST",
        "/api/v1/projects/:code/project-updates/draft",
        UStar(Cap(C::ProjectUpdateDraft)),
    ),
    r(
        40,
        "POST",
        "/api/v1/projects/:code/project-updates",
        UStar(Cap(C::ProjectUpdatePublish)),
    ),
    r(41, "GET", "/api/v1/projects/:code/brief", Au),
    // §2.3 知识库
    r(42, "GET", "/api/v1/knowledge/preview-record", U),
    r(
        43,
        "GET",
        "/api/v1/projects/:code/records/:recordKey/knowledge-preview",
        Gone,
    ),
    r(44, "GET", "/api/v1/knowledge", U),
    r(
        45,
        "POST",
        "/api/v1/knowledge",
        UStar(Cap(C::KnowledgeUserEdit)),
    ),
    r(46, "PUT", "/api/v1/knowledge/:id", Gone),
    r(
        47,
        "PATCH",
        "/api/v1/knowledge/:id",
        UStar(Cap(C::KnowledgeUserEdit)),
    ),
    r(48, "GET", "/api/v1/knowledge/:id", U),
    r(49, "GET", "/api/v1/knowledge/:id/history", U),
    r(
        50,
        "POST",
        "/api/v1/knowledge/:id/archive",
        UStar(Cap(C::KnowledgeArchive)),
    ),
    // §2.4 工作项、检查项、review、记录、搜索、事件
    r(51, "POST", "/api/v1/projects/:code/objectives", A),
    r(52, "POST", "/api/v1/projects/:code/milestones", A),
    r(
        53,
        "POST",
        "/api/v1/projects/:code/ui/objectives",
        UStar(Ui("ATM 窗口 → 项目 → 新建目标")),
    ),
    r(
        54,
        "POST",
        "/api/v1/projects/:code/ui/milestones",
        UStar(Ui("ATM 窗口 → 项目 → 新建里程碑")),
    ),
    r(
        55,
        "POST",
        "/api/v1/projects/:code/ui/work-items",
        UStar(Ui("ATM 窗口 → 项目 → 新建任务")),
    ),
    r(
        56,
        "POST",
        "/api/v1/projects/:code/ui/work-items/patch",
        UStar(Ui("ATM 窗口 → 任务详情")),
    ),
    r(
        57,
        "POST",
        "/api/v1/projects/:code/ui/work-items/:taskKey/verify-and-complete",
        Gone,
    ),
    r(
        58,
        "PATCH",
        "/api/v1/projects/:code/ui/checklist/batch",
        Gone,
    ),
    r(
        59,
        "PATCH",
        "/api/v1/projects/:code/ui/checklist/:id",
        UStar(Ui("ATM 窗口 → 任务详情 → 检查项")),
    ),
    r(60, "GET", "/api/v1/projects/:code/ui/work-items", U),
    r(61, "GET", "/api/v1/projects/:code/ui/progress-strip", U),
    r(62, "GET", "/api/v1/projects/:code/ui/work-items/closed", U),
    r(
        63,
        "GET",
        "/api/v1/projects/:code/ui/work-items/:taskKey",
        U,
    ),
    r(64, "GET", "/api/v1/projects/:code/work-items", A),
    r(65, "POST", "/api/v1/projects/:code/work-items", A),
    r(66, "POST", "/api/v1/projects/:code/work-items/patch", A),
    r(
        67,
        "POST",
        "/api/v1/projects/:code/work-items/:taskKey/verify-and-complete",
        Gone,
    ),
    r(68, "GET", "/api/v1/projects/:code/work-items/:taskKey", Au),
    r(69, "POST", "/api/v1/projects/:code/reviews/requests", Gone),
    r(
        70,
        "GET",
        "/api/v1/projects/:code/reviews/requests/:requestKey",
        A,
    ),
    r(
        71,
        "POST",
        "/api/v1/projects/:code/reviews/requests/:requestKey/submit",
        Gone,
    ),
    r(72, "PATCH", "/api/v1/projects/:code/checklist/batch", Gone),
    r(73, "PATCH", "/api/v1/projects/:code/checklist/:id", Gone),
    r(74, "POST", "/api/v1/projects/:code/progress-updates", A),
    r(75, "POST", "/api/v1/projects/:code/records", A),
    r(
        76,
        "POST",
        "/api/v1/projects/:code/ui/records",
        UStar(Ui("ATM 窗口 → 项目 → 新建记录")),
    ),
    r(77, "GET", "/api/v1/projects/:code/search", Au),
    r(78, "GET", "/api/v1/search", Au),
    r(79, "GET", "/api/v1/projects/:code/events", Au),
    // §2.5 session、quick
    r(80, "POST", "/api/v1/sessions", A),
    r(81, "POST", "/api/v1/sessions/:id/close", A),
    r(
        82,
        "POST",
        "/api/v1/sessions/:id/force-close",
        UStar(Cap(C::SessionForceClose)),
    ),
    r(
        83,
        "POST",
        "/api/v1/projects/:code/sessions/:id/git-context/refresh",
        UStar(Cap(C::SessionGitRefresh)),
    ),
    r(84, "GET", "/api/v1/quick-tasks", Au),
    r(85, "POST", "/api/v1/quick-tasks", Au),
    r(86, "PATCH", "/api/v1/quick-tasks/:id", U),
    r(87, "POST", "/api/v1/quick-tasks/:id/promote", Au),
    // §2.6 派单、同步
    r(88, "GET", "/api/v1/dispatch/status", U),
    r(
        89,
        "PUT",
        "/api/v1/dispatch/config",
        UStar(Cap(C::DispatchConfigure)),
    ),
    r(
        90,
        "POST",
        "/api/v1/projects/:code/ui/work-items/:taskKey/dispatch",
        UStar(Cap(C::DispatchLaunch)),
    ),
    r(
        91,
        "POST",
        "/api/v1/dispatch/runs/:run/cancel",
        UStar(Cap(C::DispatchCancel)),
    ),
    r(92, "GET", "/api/v1/sync/status", U),
    r(
        93,
        "PUT",
        "/api/v1/sync/config",
        UStar(Cap(C::SyncConfigure)),
    ),
    r(
        94,
        "POST",
        "/api/v1/sync/test",
        UStar(Cap(C::SyncTestRelay)),
    ),
    r(
        95,
        "POST",
        "/api/v1/sync/pairing",
        UStar(Cap(C::SyncPairingCreate)),
    ),
    r(96, "POST", "/api/v1/sync/reset", UStar(Cap(C::SyncReset))),
    // §2.7 MCP 与 WS
    r(97, "POST", "/mcp", Gone),
    r(98, "POST", "/mcp/core", Mcp),
    r(99, "POST", "/mcp/memory", Mcp),
    r(100, "POST", "/mcp/actions", Mcp),
    r(101, "GET", "/mcp", Gone),
    r(102, "DELETE", "/mcp", Gone),
    r(103, "GET", "/mcp/core", Mcp),
    r(104, "DELETE", "/mcp/core", Mcp),
    r(105, "GET", "/mcp/memory", Mcp),
    r(106, "DELETE", "/mcp/memory", Mcp),
    r(107, "GET", "/mcp/actions", Mcp),
    r(108, "DELETE", "/mcp/actions", Mcp),
    r(109, "GET", "/api/v1/ws", Gone),
    // 3.0 新增（W6c，方案 §4）：项目包与 2.x 备份的导入。来源列表与预览只在 ui-bridge；导入只有 User，
    // Agent HTTP 上是拒绝桩（说清楚去哪里操作，而不是 404）。
    r(110, "GET", "/api/v1/imports/packages", U),
    r(111, "POST", "/api/v1/imports/packages/preview", U),
    r(
        112,
        "POST",
        "/api/v1/imports/packages/apply",
        UStar(Cap(C::ImportApply)),
    ),
];

/// 运行时补进 `/api/v1/system/status` 的部分（产品版本、启动时间、转换状态……）。服务层不知道这些。
pub type RuntimeStatus = Arc<dyn Fn() -> Value + Send + Sync>;

/// 2.0 的 `:参数` 换成 axum 的 `{参数}`。
fn axum_path(path: &str) -> String {
    path.split('/')
        .map(|s| match s.strip_prefix(':') {
            Some(name) => format!("{{{name}}}"),
            None => s.to_owned(),
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn filter(method: &str) -> MethodFilter {
    match method {
        "GET" => MethodFilter::GET,
        "POST" => MethodFilter::POST,
        "PUT" => MethodFilter::PUT,
        "PATCH" => MethodFilter::PATCH,
        "DELETE" => MethodFilter::DELETE,
        other => panic!("route table: unsupported method {other}"),
    }
}

/// U\* 的拒绝信封（03 §5.2）：`{principal:"AGENT", where, next_step}`，外加路由编号与能力名，便于对照。
pub fn denial(route: &Route, deny: Deny) -> Envelope {
    let entry = deny.entry();
    let mut e = DomainError::new(
        ErrorCode::USER_AUTHORIZATION_REQUIRED,
        format!(
            "{} {} 只能由用户在 ATM 桌面端操作（{entry}）",
            route.method, route.path
        ),
    )
    .detail("principal", "AGENT")
    .detail("where", entry)
    .detail("next_step", USER_NEXT_STEP)
    .detail("route", route.n);
    if let Deny::Cap(c) = deny {
        e = e.detail("capability", c.as_str());
    }
    Envelope::new(
        e,
        Committed::No,
        None,
        Fix::AskUser {
            message: format!("请用户在 {entry} 完成这一步"),
        },
    )
}

// ---- 有工具的路由：参数与工具同名，路径参数注入 ----------------------------------------------------

/// 一条走 MCP 工具的 REST 路由。
struct ViaTool {
    tool: &'static str,
    /// 路径参数 → 工具参数。
    inject: &'static [(&'static str, &'static str)],
    created: bool,
}

const fn via(
    tool: &'static str,
    inject: &'static [(&'static str, &'static str)],
    created: bool,
) -> ViaTool {
    ViaTool {
        tool,
        inject,
        created,
    }
}

const CODE: &[(&str, &str)] = &[("code", "project")];

fn via_tool(n: u16) -> Option<ViaTool> {
    Some(match n {
        41 => via("atm_brief", CODE, false),
        64 => via("atm_task_list", CODE, false),
        65 => via("atm_task_create", CODE, true),
        66 => via("atm_task_patch", CODE, false),
        68 => via(
            "atm_task_get",
            &[("code", "project"), ("taskKey", "task_key")],
            false,
        ),
        74 => via("atm_progress_add", CODE, false),
        75 => via("atm_record", CODE, true),
        77 => via("atm_search", CODE, false),
        78 => via("atm_search", &[], false),
        80 => via("atm_begin", &[], true),
        81 => via("atm_end", &[("id", "session")], false),
        _ => return None,
    })
}

// ---- 没有工具的路由：参数表（与工具同一个校验器：别名、大小写、did_you_mean） --------------------------

const fn rest_tool(name: &'static str, fields: &'static [Field], read_only: bool) -> Tool {
    Tool {
        name,
        summary: "",
        fields,
        check: None,
        read_only,
        destructive: false,
    }
}

const STR: Ty = Ty::Str { max: 0 };
const TEXT: Ty = Ty::Text { max: 200 };
const HIDDEN_TARGET: Field = Field::new("expected_target", Ty::Any).hidden();
const OP_ID: Field = Field::new("op_id", Ty::Text { max: 200 }).aliases(&["opId", "operation_id"]);
const SESSION: Field =
    Field::new("session", Ty::Text { max: 200 }).aliases(&["session_id", "sessionId"]);
const PROJECT: Field =
    Field::new("project", Ty::Text { max: 64 }).aliases(&["project_code", "projectCode"]);

static T_STATUS: Tool = rest_tool("GET /api/v1/system/status", &[], true);
static T_PROJECTS: Tool = rest_tool("GET /api/v1/projects", &[], true);
static T_PROJECT: Tool = rest_tool("GET /api/v1/projects/:code", &[PROJECT], true);
static T_BACKUPS: Tool = rest_tool(
    "GET /api/v1/backups",
    &[
        Field::new("limit", Ty::Int { min: 1, max: 200 }),
        // 3.0 的备份是整库的：按项目过滤没有意义，照收不报错。
        PROJECT,
    ],
    true,
);
static T_EVENTS: Tool = rest_tool(
    "GET /api/v1/projects/:code/events",
    &[
        PROJECT,
        Field::new(
            "since",
            Ty::Int {
                min: 0,
                max: i64::MAX,
            },
        )
        .aliases(&["since_seq", "sinceSeq"]),
        Field::new("limit", Ty::Int { min: 1, max: 100 }),
        Field::new("types", Ty::List { of: &STR, max: 50 }),
    ],
    true,
);
static T_QUICK_LIST: Tool = rest_tool(
    "GET /api/v1/quick-tasks",
    &[Field::new(
        "status",
        Ty::Enum(&[
            "OPEN",
            "IN_PROGRESS",
            "BLOCKED",
            "DONE",
            "CANCELLED",
            "PROMOTED",
        ]),
    )],
    true,
);
static T_PROJECT_CREATE: Tool = rest_tool(
    "POST /api/v1/projects",
    &[
        Field::new("name", TEXT).required(),
        Field::new("code", Ty::Text { max: 12 }),
        Field::new("description", Ty::Str { max: 4000 }),
        Field::new("path", Ty::Text { max: 4096 }).aliases(&["source_path", "sourcePath", "cwd"]),
        Field::new("coordination_mode", Ty::Enum(&["SOLO", "AUTO", "MULTI"]))
            .aliases(&["coordinationMode"]),
        Field::new("creation_reason", Ty::Str { max: 1000 }).aliases(&["creationReason"]),
        Field::new("signals", Ty::Any).aliases(&["creation_signals", "creationSignals"]),
        Field::new("actor", Ty::Text { max: 128 }),
        SESSION,
        OP_ID,
        HIDDEN_TARGET,
    ],
    false,
);
static T_IMPORT_PREVIEW: Tool = rest_tool(
    "POST /api/v1/imports/agenttask-md/preview",
    &[
        PROJECT.required(),
        Field::new("content", STR).required(),
        Field::new("source_name", Ty::Text { max: 255 }).aliases(&["sourceName"]),
    ],
    true,
);
static T_OBJECTIVE: Tool = rest_tool(
    "POST /api/v1/projects/:code/objectives",
    &[
        PROJECT,
        SESSION,
        OP_ID,
        Field::new("title", TEXT).required(),
        Field::new("description", Ty::Str { max: 4000 }),
        Field::new("definition_of_done", Ty::List { of: &STR, max: 50 })
            .aliases(&["definitionOfDone"]),
        Field::new(
            "expected_scope_generation",
            Ty::Int {
                min: 1,
                max: i64::MAX,
            },
        )
        .hidden(),
        HIDDEN_TARGET,
    ],
    false,
);
static T_MILESTONE: Tool = rest_tool(
    "POST /api/v1/projects/:code/milestones",
    &[
        PROJECT,
        SESSION,
        OP_ID,
        Field::new("objective_id", Ty::Text { max: 200 })
            .aliases(&["objectiveId"])
            .required(),
        Field::new("title", TEXT).required(),
        Field::new("description", Ty::Str { max: 4000 }),
        Field::new("target_date", Ty::Text { max: 10 }).aliases(&["targetDate"]),
        Field::new(
            "expected_scope_generation",
            Ty::Int {
                min: 1,
                max: i64::MAX,
            },
        )
        .hidden(),
        HIDDEN_TARGET,
    ],
    false,
);
static T_QUICK_CREATE: Tool = rest_tool(
    "POST /api/v1/quick-tasks",
    &[
        Field::new("title", TEXT).required(),
        Field::new("note", Ty::Str { max: 4000 }),
        Field::new("due_date", Ty::Text { max: 10 }).aliases(&["dueDate"]),
        Field::new("source_cwd", Ty::Text { max: 4096 }).aliases(&["sourceCwd", "cwd"]),
        Field::new("actor", Ty::Text { max: 128 }),
        OP_ID,
    ],
    false,
);
static T_QUICK_PROMOTE: Tool = rest_tool(
    "POST /api/v1/quick-tasks/:id/promote",
    &[
        Field::new("id", Ty::Text { max: 200 }).hidden(),
        Field::new(
            "expected_version",
            Ty::Int {
                min: 0,
                max: i64::MAX,
            },
        )
        .aliases(&["expectedVersion"])
        .required(),
        Field::new("target_project", Ty::Text { max: 64 }).aliases(&[
            "target_project_code",
            "targetProjectCode",
            "project",
        ]),
        Field::new("actor", Ty::Text { max: 128 }),
        SESSION,
        OP_ID,
        HIDDEN_TARGET,
    ],
    false,
);
static T_REVIEW: Tool = rest_tool(
    "GET /api/v1/projects/:code/reviews/requests/:requestKey",
    &[PROJECT, Field::new("request_key", Ty::Text { max: 64 })],
    true,
);

static OWN_TOOLS: [&Tool; 13] = [
    &T_STATUS,
    &T_PROJECTS,
    &T_PROJECT,
    &T_BACKUPS,
    &T_IMPORT_PREVIEW,
    &T_PROJECT_CREATE,
    &T_OBJECTIVE,
    &T_MILESTONE,
    &T_REVIEW,
    &T_EVENTS,
    &T_QUICK_LIST,
    &T_QUICK_CREATE,
    &T_QUICK_PROMOTE,
];

/// 按名字（`方法 路径模板`）找没有工具的路由的参数表：这些路由的 fix 指向自己（例如缺 session 时
/// `add_param` 的 tool 就是这条路由），出路的校验用它（peer W4 r1 P1-04）。
pub(crate) fn own_tool_named(name: &str) -> Option<&'static Tool> {
    OWN_TOOLS.iter().copied().find(|t| t.name == name)
}

/// 没有工具的 A / A+U 路由用哪张参数表。
fn own_tool(n: u16) -> Option<&'static Tool> {
    Some(match n {
        1 => &T_STATUS,
        11 => &T_PROJECTS,
        16 => &T_PROJECT,
        22 => &T_BACKUPS,
        25 => &T_IMPORT_PREVIEW,
        15 => &T_PROJECT_CREATE,
        51 => &T_OBJECTIVE,
        52 => &T_MILESTONE,
        70 => &T_REVIEW,
        79 => &T_EVENTS,
        84 => &T_QUICK_LIST,
        85 => &T_QUICK_CREATE,
        87 => &T_QUICK_PROMOTE,
        _ => return None,
    })
}

/// 路径参数 → 参数名（没有工具的路由）。
fn own_inject(n: u16) -> &'static [(&'static str, &'static str)] {
    match n {
        16 | 51 | 52 | 79 => CODE,
        70 => &[("code", "project"), ("requestKey", "request_key")],
        87 => &[("id", "id")],
        _ => &[],
    }
}

fn created(n: u16) -> bool {
    matches!(n, 15 | 51 | 52 | 85)
}

// ---- 请求 → 参数 ----------------------------------------------------------------------------------

/// `%XX` 与 `+` 的解码（query 用）。坏的转义原样保留，交给校验器报。
fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                match std::str::from_utf8(&bytes[i + 1..i + 3])
                    .ok()
                    .and_then(|h| u8::from_str_radix(h, 16).ok())
                {
                    Some(b) => {
                        out.push(b);
                        i += 3;
                        continue;
                    }
                    None => out.push(b'%'),
                }
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// query 的一个值转成 JSON：校验器已经认数字字符串与 `true` / `false`，这里只补它不认的两种写法——
/// 2.0 CLI 的 `ready=1` 这类 `1` / `0` 布尔，与逗号分隔的列表（`types=a,b`）。其余原样给字符串。
fn coerce(ty: &Ty, raw: &str) -> Value {
    match (ty, raw.trim()) {
        (Ty::Bool | Ty::BoolOr(_), "1") => json!(true),
        (Ty::Bool | Ty::BoolOr(_), "0") => json!(false),
        (Ty::List { of, .. }, _) => Value::Array(
            raw.split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| coerce(of, s))
                .collect(),
        ),
        _ => json!(raw),
    }
}

fn field<'t>(tool: &'t Tool, key: &str) -> Option<&'t Field> {
    tool.fields
        .iter()
        .find(|f| f.name == key || f.aliases.contains(&key))
}

/// query → 参数。同名键出现多次时合成列表（列表字段）或取最后一个。
fn query_args(tool: &Tool, query: Option<&str>) -> Map<String, Value> {
    let mut out = Map::new();
    for pair in query
        .unwrap_or_default()
        .split('&')
        .filter(|p| !p.is_empty())
    {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let (k, v) = (decode(k), decode(v));
        let value = match field(tool, &k) {
            Some(f) => coerce(&f.ty, &v),
            None => json!(v),
        };
        match (out.get_mut(&k), value) {
            (Some(Value::Array(existing)), Value::Array(more)) => existing.extend(more),
            (_, value) => {
                out.insert(k, value);
            }
        }
    }
    out
}

/// 路径参数写进参数表，返回与路径不一致的参数（冲突，不悄悄挑一个）。body / query 里写这个参数的每一种
/// 写法（规范名、别名，大小写不论，与校验器同一个认法）都要比：不一致的报一条冲突并去掉，参数表里留下的
/// 就是以路径为准的同一调用。冲突不在这里提前返回：要和校验器的问题一起报，fix.call 也要过同一个校验
/// （peer W4 r1 P1-04）。
fn inject(
    tool: &Tool,
    args: &mut Map<String, Value>,
    params: &HashMap<String, String>,
    pairs: &[(&str, &str)],
) -> Vec<Problem> {
    let mut problems = Vec::new();
    for (from, to) in pairs {
        let Some(v) = params.get(*from) else { continue };
        let named = |k: &str| {
            k.eq_ignore_ascii_case(to)
                || tool
                    .fields
                    .iter()
                    .any(|f| f.name == *to && f.aliases.iter().any(|a| a.eq_ignore_ascii_case(k)))
        };
        let keys: Vec<String> = args.keys().filter(|k| named(k)).cloned().collect();
        for key in keys {
            let given = match &args[&key] {
                Value::Null => continue,
                Value::String(s) if s.trim().is_empty() => continue,
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            if !given.trim().eq_ignore_ascii_case(v.trim()) {
                problems.push(
                    Problem::new(key.as_str(), ProblemKind::Conflict)
                        .got(args[&key].clone())
                        .allowed(v.clone()),
                );
            }
            args.remove(&key);
        }
        args.insert((*to).to_owned(), json!(v));
    }
    problems
}

/// 参数表的最终判定（U-4）：路径冲突与校验器的问题一起报；fix.call 只给两者都更正过、并且通过同一个
/// 校验的调用（校验器给的更正本身已经再校验过；没有冲突之外的问题时，以路径为准的参数表就是它）。
fn checked(
    tool: &'static Tool,
    args: Map<String, Value>,
    conflicts: Vec<Problem>,
) -> Result<crate::schema::Checked, Envelope> {
    let result = tool.validate(&Value::Object(args));
    if conflicts.is_empty() {
        return result.map_err(|r| invalid_argument(tool, r));
    }
    let (mut problems, corrected) = match result {
        Ok(c) => (Vec::new(), Some(c.args)),
        Err(r) => (r.problems, r.corrected),
    };
    problems.extend(conflicts);
    problems.sort_by(|a, b| a.path.cmp(&b.path));
    let mut envelope = invalid_argument(
        tool,
        crate::schema::Rejected {
            problems,
            corrected,
        },
    );
    if let Fix::Call { why, .. } = &mut envelope.fix {
        *why = "路径里的值为准、其余按 problems 更正后的同一调用".to_owned();
    }
    Err(envelope)
}

fn ok(value: Value, created: bool) -> Response {
    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    (
        status,
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        value.to_string(),
    )
        .into_response()
}

/// `taskKey` → `task_key`：2.0 的 REST 与 CLI 用 camelCase，这里照收。只改工具认得的字段，顶层与
/// 顶层数组里的对象（task_patch / task_create 的 items）都改；同名的 snake_case 已经在时不动，交给校验器报。
fn snake_case(tool: &Tool, args: &mut Map<String, Value>) {
    fn snake(k: &str) -> String {
        let mut out = String::with_capacity(k.len() + 4);
        for c in k.chars() {
            if c.is_ascii_uppercase() {
                out.push('_');
                out.push(c.to_ascii_lowercase());
            } else {
                out.push(c);
            }
        }
        out
    }
    fn rename(map: &mut Map<String, Value>, known: &dyn Fn(&str) -> bool) {
        let keys: Vec<String> = map
            .keys()
            .filter(|k| k.chars().any(|c| c.is_ascii_uppercase()))
            .cloned()
            .collect();
        for k in keys {
            let s = snake(&k);
            if known(&s) && !known(&k) && !map.contains_key(&s) {
                let v = map.remove(&k).unwrap_or(Value::Null);
                map.insert(s, v);
            }
        }
    }
    /// 按 schema 往下走：对象数组、对象里的键也照收 camelCase（任务的 `checklist[].evidenceRequired`）。
    fn nested(ty: &Ty, value: &mut Value) {
        match (ty, value) {
            (Ty::List { of, .. }, Value::Array(items)) => {
                items.iter_mut().for_each(|item| nested(of, item))
            }
            (Ty::Obj(fields) | Ty::TextOr { obj: fields, .. }, Value::Object(m)) => {
                let known = |k: &str| fields.iter().any(|f| f.name == k || f.aliases.contains(&k));
                rename(m, &known);
                for (name, inner) in m.iter_mut() {
                    if let Some(f) = fields
                        .iter()
                        .find(|f| f.name == name || f.aliases.contains(&name.as_str()))
                    {
                        nested(&f.ty, inner);
                    }
                }
            }
            _ => {}
        }
    }
    let top = |k: &str| field(tool, k).is_some();
    rename(args, &top);
    for (name, value) in args.iter_mut() {
        if let Some(f) = field(tool, name) {
            nested(&f.ty, value);
        }
    }
}

/// ui-bridge（W5）：界面上有 MCP 工具对应的写，与 Agent 入口走同一份参数 schema 与同一个工具处理器（03 A6）：
/// camelCase 照收（[`snake_case`]），`pairs` 是路径里的值（`(工具字段, 值)`，与 body 里同名的值冲突时报
/// CONFLICT），然后校验、交给处理器。主体由调用方给（ui-bridge 构造的 User）。
pub fn call_tool_as(
    surface: &Surface,
    p: &atm_domain::principal::Principal,
    tool_name: &str,
    mut args: Map<String, Value>,
    pairs: &[(&str, &str)],
) -> Result<Value, Envelope> {
    let Some(tool) = crate::tools::find(tool_name) else {
        return Err(refuse(
            DomainError::new(ErrorCode::INTERNAL_ERROR, format!("没有工具 {tool_name}")),
            Fix::None,
        ));
    };
    snake_case(tool, &mut args);
    let params: HashMap<String, String> = pairs
        .iter()
        .map(|(field, value)| ((*field).to_owned(), (*value).to_owned()))
        .collect();
    let same: Vec<(&str, &str)> = pairs.iter().map(|(field, _)| (*field, *field)).collect();
    let conflicts = inject(tool, &mut args, &params, &same);
    let checked = checked(tool, args, conflicts)?;
    surface.call(p, tool, checked)
}

/// 同 [`call_tool_as`]，另外带回服务的原始写结果（`Written::result`，2.0 界面路由回的就是它的形状）。
/// 参数校验、处理器、错误信封都与 Agent 入口同一份；只有回给界面的形状不同（06 T-COMPAT）。
/// 原始结果是 `None`：这个工具不经过写回执（读工具），或者在写入之前就失败了。
pub fn call_tool_raw_as(
    surface: &Surface,
    p: &atm_domain::principal::Principal,
    tool_name: &str,
    args: Map<String, Value>,
    pairs: &[(&str, &str)],
) -> Result<(Value, Option<Value>), Envelope> {
    struct Close;
    impl Drop for Close {
        fn drop(&mut self) {
            crate::write::RAW.with(|slot| slot.borrow_mut().take());
        }
    }
    crate::write::RAW.with(|slot| *slot.borrow_mut() = Some(None));
    let close = Close;
    let ack = call_tool_as(surface, p, tool_name, args, pairs)?;
    let raw = crate::write::RAW.with(|slot| slot.borrow_mut().take().flatten());
    drop(close);
    Ok((ack, raw))
}

/// 一个请求的全部输入：路径参数、query、body（GET 没有 body），校验、规范化之后。
async fn arguments(
    route: &Route,
    tool: &'static Tool,
    params: Result<Path<HashMap<String, String>>, PathRejection>,
    query: Option<String>,
    body: Body,
    pairs: &[(&str, &str)],
) -> Result<crate::schema::Checked, Envelope> {
    let params = params.map(|Path(p)| p).unwrap_or_default();
    let mut args = if route.method == "GET" {
        query_args(tool, query.as_deref())
    } else {
        match read_json(body).await? {
            Value::Object(m) => m,
            other => {
                return Err(refuse(
                    DomainError::invalid_argument(vec![
                        Problem::new("$", ProblemKind::Pattern)
                            .got(other.to_string().chars().take(80).collect::<String>())
                            .allowed("a JSON object"),
                    ]),
                    Fix::None,
                ));
            }
        }
    };
    snake_case(tool, &mut args);
    let conflicts = inject(tool, &mut args, &params, pairs);
    checked(tool, args, conflicts)
}

impl Surface {
    /// Agent HTTP 的 REST 路由：由 [`ROUTES`] 生成。`handler` 是 MCP 工具的同一个处理器。
    pub fn rest_routes(
        self: &Arc<Surface>,
        handler: Handler,
        runtime: RuntimeStatus,
    ) -> Router<AppState> {
        let mut router = Router::new();
        for route in ROUTES {
            let path = axum_path(route.path);
            let method = filter(route.method);
            match route.disp {
                Disp::A | Disp::Au => {
                    let me = self.clone();
                    let handler = handler.clone();
                    let runtime = runtime.clone();
                    router = router.route(
                        &path,
                        on(
                            method,
                            move |State(state): State<AppState>,
                                  agent: Agent,
                                  params: Result<Path<HashMap<String, String>>, PathRejection>,
                                  RawQuery(query): RawQuery,
                                  body: Body| {
                                let me = me.clone();
                                let handler = handler.clone();
                                let runtime = runtime.clone();
                                async move {
                                    me.serve(
                                        route, state, agent, params, query, body, handler, runtime,
                                    )
                                    .await
                                }
                            },
                        ),
                    );
                }
                Disp::UStar(deny) => {
                    // 不读 body、不碰服务：拒绝之前什么都没有发生。
                    router = router.route(
                        &path,
                        on(method, move || async move { reply(denial(route, deny)) }),
                    );
                }
                // 显式登记成 404：否则同方法的参数路由会把它接走（例如「删」的 `ui/checklist/batch`
                // 落进拒绝桩 `ui/checklist/:id`）。
                Disp::U | Disp::Gone => {
                    router = router.route(&path, on(method, crate::not_found));
                }
                Disp::Mcp => {}
            }
        }
        router
    }

    #[allow(clippy::too_many_arguments)]
    async fn serve(
        self: Arc<Surface>,
        route: &'static Route,
        state: AppState,
        agent: Agent,
        params: Result<Path<HashMap<String, String>>, PathRejection>,
        query: Option<String>,
        body: Body,
        handler: Handler,
        runtime: RuntimeStatus,
    ) -> Response {
        if let Some(spec) = via_tool(route.n) {
            let Some(tool) = crate::tools::find(spec.tool) else {
                return reply(refuse(
                    DomainError::new(ErrorCode::INTERNAL_ERROR, format!("没有工具 {}", spec.tool)),
                    Fix::None,
                ));
            };
            let checked = match arguments(route, tool, params, query, body, spec.inject).await {
                Ok(c) => c,
                Err(e) => return reply(e),
            };
            return match state
                .calls
                .run(move || handler(&agent, tool, checked))
                .await
            {
                Ok(Ok(v)) => ok(v, spec.created),
                Ok(Err(e)) | Err(e) => reply(e),
            };
        }
        let Some(tool) = own_tool(route.n) else {
            return reply(refuse(
                DomainError::new(
                    ErrorCode::INTERNAL_ERROR,
                    format!("路由 #{} 没有接到服务上", route.n),
                ),
                Fix::None,
            ));
        };
        let checked = match arguments(route, tool, params, query, body, own_inject(route.n)).await {
            Ok(c) => c.args,
            Err(e) => return reply(e),
        };
        let n = route.n;
        match state
            .calls
            .run(move || {
                let p = &agent.0;
                self.own(n, p, tool, &checked, &runtime).map_err(|(e, c)| {
                    match crate::write::committed_write(e) {
                        // 提交之后的读失败：同 MCP 写工具一样回查，不是重做（W4 r2 P1-01）。
                        Ok(envelope) => envelope,
                        Err(e) => self.envelope(p, tool, &checked, e, c),
                    }
                })
            })
            .await
        {
            Ok(Ok(v)) => ok(v, created(n)),
            Ok(Err(e)) | Err(e) => reply(e),
        }
    }

    /// 没有工具的 A / A+U 路由。
    fn own(
        &self,
        n: u16,
        p: &atm_domain::principal::Principal,
        tool: &'static Tool,
        args: &Map<String, Value>,
        runtime: &RuntimeStatus,
    ) -> Result<Value, (DomainError, Committed)> {
        let a = Args(args);
        let read = |r: Result<Value, DomainError>| r.map_err(|e| (e, Committed::No));
        let write = |r: Result<Written, DomainError>| {
            r.map_err(|e| {
                let c = if e.code == ErrorCode::INTERNAL_ERROR {
                    Committed::Unknown
                } else {
                    Committed::No
                };
                (e, c)
            })
        };
        let op_id = || {
            a.str("op_id")
                .map_or_else(|| self.svc.auto_op_id(), Ok)
                .map_err(|e| (e, Committed::No))
        };
        match n {
            1 => {
                let mut out = read(self.svc.system_status(p))?;
                if let (Value::Object(m), Value::Object(extra)) = (&mut out, runtime()) {
                    for (k, v) in extra {
                        m.entry(k).or_insert(v);
                    }
                }
                Ok(out)
            }
            11 => read(self.svc.project_list(p)),
            16 => read(
                self.svc
                    .project_info(p, &a.str("project").unwrap_or_default()),
            ),
            22 => {
                let mut out = read(self.svc.list_backups(p, a.usize("limit").unwrap_or(50)))?;
                out["scope"] = json!("store");
                Ok(out)
            }
            25 => read(self.svc.preview_import(
                p,
                &a.str("project").unwrap_or_default(),
                &a.str("content").unwrap_or_default(),
                a.str("source_name").as_deref(),
            )),
            70 => read(self.svc.review_request_get(
                p,
                &a.str("project").unwrap_or_default(),
                &a.str("request_key").unwrap_or_default(),
            )),
            79 => read(self.svc.events_page(
                p,
                &a.str("project").unwrap_or_default(),
                a.int("since"),
                a.usize("limit").unwrap_or(50),
                &a.strs("types"),
            )),
            84 => read(self.svc.quick_list(p, a.str("status").as_deref())),
            15 => {
                let mut r = CreateProjectRequest::new(a.str("name").unwrap_or_default());
                r.code = a.str("code");
                r.description = a.str("description");
                r.path = a
                    .str("path")
                    .map(|raw| crate::workspace::canonical(&raw).unwrap_or(raw))
                    .map(|path| PathInfo {
                        git_common_dir: crate::workspace::git_common_dir(&path),
                        canonical_path: path,
                    });
                r.coordination_mode = a.str("coordination_mode");
                r.creation_reason = a.str("creation_reason");
                if let Some(Value::Object(s)) = a.get("signals") {
                    r.signals = s.clone();
                }
                r.actor = a.str("actor");
                r.session = a.str("session");
                r.op_id = Some(op_id()?);
                r.expected_target = target(&a)?;
                let op = r.op_id.clone().unwrap_or_default();
                let written = write(self.svc.create_project(p, r))?;
                // C-L03：marker 与 git exclude 在提交之后写，写没写成如实报告。
                let marker = written.result.get("marker").filter(|m| m.is_object());
                let marker_written = marker.map(crate::workspace::write_marker);
                let mut result = written.result.clone();
                if let Value::Object(m) = &mut result {
                    m.remove("marker");
                }
                Ok(json!({
                    "ok": true,
                    "operation": "project.create",
                    "op_id": op,
                    "replayed": written.replayed,
                    "result": result,
                    "marker_written": marker_written,
                }))
            }
            51 | 52 => {
                let place = self.place(p, &a).map_err(|e| (e, Committed::No))?;
                let (operation, written) = if n == 51 {
                    let r = ObjectiveRequest {
                        title: a.str("title").unwrap_or_default(),
                        description: a.str("description").unwrap_or_default(),
                        definition_of_done: a.strs("definition_of_done"),
                    };
                    (
                        atm_service::work::OBJECTIVE_OPERATION,
                        write(self.svc.create_objective(p, &place.target, r))?,
                    )
                } else {
                    let r = MilestoneRequest {
                        objective_id: a.str("objective_id").unwrap_or_default(),
                        title: a.str("title").unwrap_or_default(),
                        description: a.str("description").unwrap_or_default(),
                        target_date: a.str("target_date"),
                    };
                    (
                        atm_service::work::MILESTONE_OPERATION,
                        write(self.svc.create_milestone(p, &place.target, r))?,
                    )
                };
                let mut ack = self
                    .ack(&place, operation, &written)
                    .map_err(|e| (e, Committed::Yes))?;
                // 新建的目标 / 里程碑本身（id 是建里程碑、挂任务要用的）；固定形状的 ACK 里没有它。
                let mut created = written.result.clone();
                if let Value::Object(m) = &mut created {
                    m.remove("sequence");
                }
                ack[if n == 51 { "objective" } else { "milestone" }] = created;
                Ok(ack)
            }
            85 => {
                let op = op_id()?;
                let r = QuickCreateRequest {
                    title: a.str("title").unwrap_or_default(),
                    note: a.str("note"),
                    due_date: a.str("due_date"),
                    source_cwd: a.str("source_cwd"),
                    actor: a.str("actor"),
                };
                let written = write(self.svc.quick_create(p, r, &op))?;
                Ok(plain(atm_service::quick::CREATE_OPERATION, &op, &written))
            }
            87 => {
                let op = op_id()?;
                let r = QuickPromoteRequest {
                    expected_version: a.int("expected_version").unwrap_or_default(),
                    target_project: a.str("target_project"),
                    actor: a.str("actor"),
                    session: a.str("session"),
                    expected_target: target(&a)?,
                };
                let written =
                    write(
                        self.svc
                            .quick_promote(p, &a.str("id").unwrap_or_default(), r, &op),
                    )?;
                Ok(plain(atm_service::quick::PROMOTE_OPERATION, &op, &written))
            }
            _ => {
                let _ = tool;
                Err((
                    DomainError::new(
                        ErrorCode::INTERNAL_ERROR,
                        format!("路由 #{n} 没有接到服务上"),
                    ),
                    Committed::No,
                ))
            }
        }
    }
}

/// 不落在项目上的写（项目、quick）的回执：操作、op_id、是否重放与服务的结果原文。
fn plain(operation: &str, op_id: &str, written: &Written) -> Value {
    json!({
        "ok": true,
        "operation": operation,
        "op_id": op_id,
        "replayed": written.replayed,
        "result": written.result,
    })
}

fn target(a: &Args<'_>) -> Result<Option<atm_service::ops::Target>, (DomainError, Committed)> {
    match a.get("expected_target") {
        None | Some(Value::Null) => Ok(None),
        Some(v) => atm_service::ops::Target::from_json(v)
            .map(Some)
            .ok_or_else(|| {
                (
                    DomainError::invalid_argument(vec![
                        Problem::new("expected_target", ProblemKind::Pattern).got(v.to_string()),
                    ]),
                    Committed::No,
                )
            }),
    }
}
