//! surface v6 的工具表（W4c；R11、11 §4）。参数沿用 2.0 的名字与上限，加上 v6 的放宽：
//! 别名（`project_code`、`session_id`、`key`、`work_item_key`、`details`、`content`、`body`、`op`）、
//! project / session / op_id 可省略（桥与服务按 A1 / A3 补）、单条 patch 不包 `items`、
//! `checklist` 是 `checklist_single` / `checklist_batch` 的合称。
//!
//! 发布：core 9 个、memory 4 个；`atm_delta`、`atm_feedback` 并入 brief / record 后只保留可调用的旧名；
//! `/mcp/actions` 只发布 `atm_task_patch`，其余 core 工具照常可调。

use crate::mcp::Profile;
use crate::schema::{Field, Tool, Ty};
use atm_domain::error::{Problem, ProblemKind};
use serde_json::{Map, Value};

// ---- 共用字段 -------------------------------------------------------------------------------

const PROJECT: Field = Field::new("project", Ty::Str { max: 20 }).aliases(&["project_code"]);
const SESSION: Field = Field::new("session", Ty::Str { max: 128 }).aliases(&["session_id"]);
const OP_ID: Field = Field::new("op_id", Ty::Str { max: 128 });
/// A3 的控制字段：显式给出时桥原样保留，服务按它判 `SCOPE_RESTORED`。由桥管理，只收不发布。
const GENERATION: Field = Field::new(
    "expected_scope_generation",
    Ty::Int {
        min: 0,
        max: i64::MAX,
    },
)
.hidden();
const TASK_KEY: Field =
    Field::new("task_key", Ty::Str { max: 40 }).aliases(&["key", "task", "work_item_key"]);
const FIELD_MASK: Ty = Ty::List {
    of: &Ty::Str { max: 64 },
    max: 30,
};
const STATUSES: &[&str] = &[
    "BACKLOG",
    "READY",
    "CLAIMED",
    "IN_PROGRESS",
    "BLOCKED",
    "WAITING_AGENT",
    "WAITING_USER",
    "VERIFYING",
    "DONE",
    "CANCELLED",
];
const EVIDENCE_KINDS: &[&str] = &[
    "git_sha",
    "atm_record",
    "atm_task",
    "test_result",
    "url",
    "file",
];
static EVIDENCE_OBJ: [Field; 3] = [
    Field::new("kind", Ty::Enum(EVIDENCE_KINDS)).required(),
    Field::new("value", Ty::Text { max: 2000 }).required(),
    Field::new("note", Ty::Str { max: 500 }),
];
/// 证据：文本，或 `{kind, value, note}`。
const EVIDENCE: Ty = Ty::List {
    of: &Ty::TextOr {
        max: 2000,
        obj: &EVIDENCE_OBJ,
    },
    max: 100,
};
const NEXT: Ty = Ty::List {
    of: &Ty::Str { max: 500 },
    max: 20,
};

// ---- core ---------------------------------------------------------------------------------

static BEGIN_SIGNALS: [Field; 7] = [
    Field::new(
        "expected_minutes",
        Ty::Int {
            min: 0,
            max: i64::MAX,
        },
    ),
    Field::new(
        "subtask_count",
        Ty::Int {
            min: 0,
            max: i64::MAX,
        },
    ),
    Field::new("multi_session", Ty::Bool),
    Field::new("multi_agent", Ty::Bool),
    Field::new("has_dependencies", Ty::Bool),
    Field::new("needs_evidence", Ty::Bool),
    Field::new("has_target_date", Ty::Bool),
];

static BEGIN_FIELDS: [Field; 21] = [
    Field::new("agent_id", Ty::Text { max: 128 }).required(),
    Field::new("cwd", Ty::Text { max: 0 }),
    PROJECT,
    Field::new("allow_project_create", Ty::Bool).default("false"),
    Field::new("mode", Ty::Enum(&["auto", "quick", "project"])).default("\"auto\""),
    Field::new(
        "role",
        Ty::Enum(&["PRIMARY", "SUBAGENT", "REVIEWER", "OBSERVER"]),
    )
    .default("\"PRIMARY\""),
    Field::new("resume", Ty::BoolOr(&["auto"])).default("\"auto\""),
    SESSION,
    Field::new("predecessor_session_id", Ty::Str { max: 128 }),
    Field::new("parent_session_id", Ty::Str { max: 128 }),
    Field::new("thread_id", Ty::Str { max: 256 }).hidden(),
    Field::new("title", Ty::Str { max: 400 }),
    Field::new("display_name", Ty::Str { max: 200 }).hidden(),
    Field::new("client_kind", Ty::Str { max: 100 }).hidden(),
    Field::new("creation_reason", Ty::Str { max: 500 }).hidden(),
    Field::new("signals", Ty::Obj(&BEGIN_SIGNALS)),
    Field::new("brief", Ty::Enum(&["none", "minimal", "full"])).default("\"full\""),
    Field::new(
        "max_chars",
        Ty::Int {
            min: 400,
            max: 5000,
        },
    )
    .default("1200"),
    OP_ID,
    GENERATION,
    Field::new("git_branch", Ty::Str { max: 256 }).hidden(),
];

fn begin_check(args: &Map<String, Value>) -> Vec<Problem> {
    // A1：显式接回（session）与新建后继（predecessor_session_id）是两件事，同时给出是参数错误。
    if args.contains_key("session") && args.contains_key("predecessor_session_id") {
        return vec![
            Problem::new("predecessor_session_id", ProblemKind::Conflict).allowed("session"),
        ];
    }
    Vec::new()
}

pub static BEGIN: Tool = Tool {
    name: "atm_begin",
    summary: "开始或接续会话并返回 brief。开工只调这一次，直接用返回的 brief；上下文压缩后改调无参的 atm_brief。在仓库里首次使用加 allow_project_create:true。resume 默认 auto：自动接上本 Agent 已退出的上一会话；要新会话传 resume:false。例：{agent_id:\"claude-code\", cwd:\"D:/repo\"}",
    fields: &BEGIN_FIELDS,
    check: Some(begin_check),
    read_only: false,
    destructive: false,
};

const BRIEF_INCLUDE: &[&str] = &[
    "objective",
    "counts",
    "own",
    "next",
    "records",
    "current",
    "handoff",
    "progress",
    "artifacts",
    "task",
    "delta",
];

static BRIEF_FIELDS: [Field; 7] = [
    PROJECT,
    SESSION,
    TASK_KEY,
    Field::new(
        "since_seq",
        Ty::Int {
            min: 0,
            max: i64::MAX,
        },
    ),
    Field::new(
        "include",
        Ty::List {
            of: &Ty::Enum(BRIEF_INCLUDE),
            max: 11,
        },
    ),
    Field::new("cursor", Ty::Text { max: 4000 }),
    Field::new(
        "max_chars",
        Ty::Int {
            min: 300,
            max: 5000,
        },
    )
    .default("1200"),
];

pub static BRIEF: Tool = Tool {
    name: "atm_brief",
    summary: "重新取回 working set，参数全部可选（省略时按本连接的会话）。只在上下文压缩或长时间离开后调用。带 since_seq 时附带增量（取代 atm_delta）。",
    fields: &BRIEF_FIELDS,
    check: None,
    read_only: true,
    destructive: false,
};

static TASK_LIST_FIELDS: [Field; 15] = [
    PROJECT,
    SESSION,
    Field::new("ready_only", Ty::Bool).default("false"),
    Field::new("mine", Ty::Bool).default("false"),
    Field::new("status", Ty::Str { max: 100 }),
    Field::new("owner", Ty::Str { max: 128 }),
    Field::new("parent_key", Ty::Str { max: 40 }),
    Field::new("milestone_id", Ty::Str { max: 128 }),
    Field::new("query", Ty::Str { max: 500 }),
    Field::new("view", Ty::Enum(&["core", "context", "full", "reconcile"])).default("\"core\""),
    Field::new("include_active", Ty::Bool).default("false"),
    Field::new(
        "field_mask",
        Ty::List {
            of: &Ty::Str { max: 64 },
            max: 20,
        },
    ),
    Field::new("limit", Ty::Int { min: 1, max: 100 }).default("10"),
    Field::new("cursor", Ty::Text { max: 4000 }),
    Field::new(
        "max_chars",
        Ty::Int {
            min: 500,
            max: 50000,
        },
    )
    .default("12000"),
];

pub static TASK_LIST: Tool = Tool {
    name: "atm_task_list",
    summary: "分页列任务。status 写 open、closed、all 或具体状态（BACKLOG|READY|CLAIMED|IN_PROGRESS|BLOCKED|WAITING_AGENT|WAITING_USER|VERIFYING|DONE|CANCELLED）；mine:true 只列本会话持有的；view=reconcile 时只看 include_active、limit、cursor、field_mask。",
    fields: &TASK_LIST_FIELDS,
    check: None,
    read_only: true,
    destructive: false,
};

static TASK_GET_FIELDS: [Field; 8] = [
    TASK_KEY.required(),
    PROJECT,
    // 读时续租用（R11 P3），由桥补，只收不发布。
    SESSION.hidden(),
    Field::new("view", Ty::Enum(&["core", "context", "full"])).default("\"core\""),
    Field::new("field_mask", FIELD_MASK),
    Field::new("last_progress", Ty::Int { min: 1, max: 10 }),
    Field::new("cursor", Ty::Text { max: 2000 }),
    Field::new(
        "max_chars",
        Ty::Int {
            min: 300,
            max: 50000,
        },
    )
    .default("12000"),
];

pub static TASK_GET: Tool = Tool {
    name: "atm_task_get",
    summary: "读单个任务。field_mask 只在 view 已有的字段内过滤，越界的回显在 ignored_fields；last_progress=N 附带最近 N 条进度。",
    fields: &TASK_GET_FIELDS,
    check: None,
    read_only: true,
    destructive: false,
};

static CREATE_CHECKLIST: [Field; 3] = [
    Field::new("title", Ty::Text { max: 400 }).required(),
    Field::new("evidence_required", Ty::Bool).default("false"),
    Field::new(
        "weight",
        Ty::Num {
            min: 0.001,
            max: 1000.0,
        },
    ),
];

static CREATE_ITEM: [Field; 21] = [
    Field::new("title", Ty::Text { max: 400 }).required(),
    Field::new("client_ref", Ty::Text { max: 100 }),
    Field::new(
        "depends_on",
        Ty::List {
            of: &Ty::Text { max: 100 },
            max: 50,
        },
    ),
    Field::new("parent", Ty::Text { max: 100 }),
    Field::new("status", Ty::Enum(STATUSES)).default("\"READY\""),
    Field::new(
        "type",
        Ty::Enum(&["EPIC", "TASK", "SUBTASK", "BUG", "RESEARCH", "REVIEW"]),
    )
    .aliases(&["kind"])
    .default("\"TASK\""),
    Field::new("priority", Ty::Enum(&["LOW", "NORMAL", "HIGH", "CRITICAL"])).default("\"NORMAL\""),
    Field::new("description", Ty::Str { max: 50000 }).aliases(&["detail", "details", "body"]),
    Field::new(
        "acceptance",
        Ty::List {
            of: &Ty::Text { max: 1000 },
            max: 100,
        },
    ),
    Field::new(
        "checklist",
        Ty::List {
            of: &Ty::Obj(&CREATE_CHECKLIST),
            max: 100,
        },
    ),
    Field::new("objective_id", Ty::Text { max: 128 }),
    Field::new("milestone_id", Ty::Str { max: 128 }).nullable(),
    Field::new("parent_key", Ty::Text { max: 100 }).hidden(),
    Field::new("parent_ref", Ty::Text { max: 100 }).hidden(),
    Field::new(
        "depends_on_refs",
        Ty::List {
            of: &Ty::Text { max: 100 },
            max: 50,
        },
    )
    .hidden(),
    Field::new("discovered_from", Ty::Text { max: 100 }),
    Field::new("discovered_from_ref", Ty::Text { max: 100 }).hidden(),
    Field::new(
        "weight",
        Ty::Num {
            min: 0.001,
            max: 1000.0,
        },
    ),
    Field::new("target_date", Ty::Str { max: 10 }),
    Field::new("verification_required", Ty::Bool).default("false"),
    Field::new("assignee_agent_id", Ty::Text { max: 128 }),
];

static TASK_CREATE_FIELDS: [Field; 5] = [
    Field::new(
        "items",
        Ty::List {
            of: &Ty::Obj(&CREATE_ITEM),
            max: 50,
        },
    )
    .required(),
    PROJECT,
    SESSION,
    OP_ID,
    GENERATION,
];

fn create_check(args: &Map<String, Value>) -> Vec<Problem> {
    let mut out = Vec::new();
    let Some(Value::Array(items)) = args.get("items") else {
        return out;
    };
    if items.is_empty() {
        out.push(Problem::new("items", ProblemKind::TooFew).allowed(1));
    }
    for (i, item) in items.iter().enumerate() {
        for (a, b) in [
            ("parent", "parent_key"),
            ("parent", "parent_ref"),
            ("parent_key", "parent_ref"),
            ("discovered_from", "discovered_from_ref"),
        ] {
            if item.get(a).is_some() && item.get(b).is_some() {
                out.push(Problem::new(format!("items[{i}].{b}"), ProblemKind::Conflict).allowed(a));
            }
        }
    }
    out
}

pub static TASK_CREATE: Tool = Tool {
    name: "atm_task_create",
    summary: "批量建任务，默认 READY（还没整理好的显式写 BACKLOG）。depends_on 与 parent 可以写已有任务 key，也可以写本批序号（\"1\" 起）或 client_ref。回执带 refs（client_ref→key）与检查项 id。例：{items:[{title:\"A\"},{title:\"B\",depends_on:[\"1\"]}]}",
    fields: &TASK_CREATE_FIELDS,
    check: Some(create_check),
    read_only: false,
    destructive: false,
};

/// 对外发布的 operation；`checklist` 按条数分派到旧的 single / batch。
pub const OPERATIONS: &[&str] = &[
    "start",
    "complete",
    "verify",
    "verify_and_complete",
    "block",
    "wait_user",
    "wait_agent",
    "ready",
    "release",
    "claim",
    "cancel",
    "reopen",
    "edit",
    "checklist",
    "review_request",
    "review_submit",
];
const OLD_OPERATIONS: &[&str] = &["checklist_single", "checklist_batch"];
const CHECKLIST_STATUS: &[&str] = &["TODO", "DOING", "DONE", "SKIPPED"];

static CHECK_CHANGE: [Field; 4] = [
    Field::new("item", Ty::Text { max: 400 }).aliases(&["id", "checklist_id"]),
    Field::new("status", Ty::Enum(CHECKLIST_STATUS)).required(),
    Field::new("evidence", EVIDENCE).compact("同顶层 evidence"),
    Field::new(
        "expected_checklist_version",
        Ty::Int {
            min: 0,
            max: i64::MAX,
        },
    ),
];

static EXPECTED_FIELDS: [Field; 5] = [
    Field::new("title", Ty::Text { max: 400 }),
    Field::new("description", Ty::Str { max: 50000 }),
    Field::new(
        "acceptance",
        Ty::List {
            of: &Ty::Text { max: 1000 },
            max: 100,
        },
    ),
    Field::new("target_date", Ty::Str { max: 10 }).nullable(),
    Field::new("parent_key", Ty::Str { max: 100 }).nullable(),
];

const CHECKLIST_CHANGES: Ty = Ty::List {
    of: &Ty::Obj(&CHECK_CHANGE),
    max: 100,
};

/// 一条 patch 的字段：所有 operation 共用一张表，哪个 operation 用哪些由 W4d 的映射层判。
const PATCH_ITEM_LEN: usize = 30;
const fn patch_item() -> [Field; PATCH_ITEM_LEN] {
    [
        TASK_KEY.required(),
        Field::new("operation", Ty::EnumPlus(OPERATIONS, OLD_OPERATIONS))
            .required()
            .aliases(&["op"]),
        Field::new(
            "expected_version",
            Ty::Int {
                min: 0,
                max: i64::MAX,
            },
        ),
        Field::new("takeover_stale", Ty::Bool).default("false"),
        Field::new("note", Ty::Str { max: 500 }),
        Field::new("evidence", EVIDENCE),
        Field::new("checklist", CHECKLIST_CHANGES).aliases(&["checklist_items"]),
        Field::new("blocked_reason", Ty::Text { max: 2000 }),
        Field::new("waiting_for", Ty::Text { max: 1000 }),
        Field::new("cancel_reason", Ty::Text { max: 2000 }),
        Field::new("duplicate_of", Ty::Str { max: 100 }).nullable(),
        Field::new("superseded_by", Ty::Str { max: 100 }).nullable(),
        Field::new("title", Ty::Text { max: 400 }),
        Field::new("description", Ty::Str { max: 50000 }).aliases(&["detail", "details", "body"]),
        Field::new(
            "acceptance",
            Ty::List {
                of: &Ty::Text { max: 1000 },
                max: 100,
            },
        ),
        Field::new("target_date", Ty::Str { max: 10 }).nullable(),
        Field::new("parent_key", Ty::Str { max: 100 }).nullable(),
        Field::new("assignee_agent_id", Ty::Str { max: 128 }).nullable(),
        Field::new(
            "depends_on",
            Ty::List {
                of: &Ty::Text { max: 100 },
                max: 50,
            },
        ),
        Field::new("discovered_from", Ty::Str { max: 100 }).nullable(),
        Field::new("expected_fields", Ty::Obj(&EXPECTED_FIELDS)),
        Field::new("request_key", Ty::Text { max: 128 }),
        Field::new("verdict", Ty::Enum(&["APPROVED", "CHANGES_REQUESTED"])),
        Field::new("candidate_hashes", Ty::Any),
        Field::new("parent_checklist_id", Ty::Text { max: 128 }),
        Field::new(
            "expected_parent_checklist_version",
            Ty::Int {
                min: 0,
                max: i64::MAX,
            },
        ),
        Field::new(
            "expected_checklist_version",
            Ty::Int {
                min: 0,
                max: i64::MAX,
            },
        )
        .hidden(),
        // 2.0 的 checklist_single / review_submit 旧形状：照收，不发布。
        Field::new("checklist_id", Ty::Text { max: 128 }).hidden(),
        Field::new("status", Ty::Enum(CHECKLIST_STATUS)).hidden(),
        Field::new("review_task_key", Ty::Str { max: 40 }).hidden(),
    ]
}

static PATCH_ITEM: [Field; PATCH_ITEM_LEN] = patch_item();

/// 一条 patch 能写的全部字段名（规范名）。映射层用它把根上的 project / session 等与 item 字段分开。
pub fn patch_item_names() -> Vec<&'static str> {
    PATCH_ITEM.iter().map(|f| f.name).collect()
}

/// 根：单条时 item 字段直接写在顶层（R11 P1-4 第 4 条），多条时放 `items`；两者不能同时用。
static TASK_PATCH_FIELDS: [Field; PATCH_ITEM_LEN + 5] = {
    let item = patch_item();
    let mut out = [PROJECT; PATCH_ITEM_LEN + 5];
    let mut i = 0;
    while i < PATCH_ITEM_LEN {
        out[i] = item[i].optional();
        i += 1;
    }
    out[PATCH_ITEM_LEN] = Field::new(
        "items",
        Ty::List {
            of: &Ty::Obj(&PATCH_ITEM),
            max: 50,
        },
    )
    .compact("字段与顶层相同，task_key、operation 必填");
    out[PATCH_ITEM_LEN + 1] = PROJECT;
    out[PATCH_ITEM_LEN + 2] = SESSION;
    out[PATCH_ITEM_LEN + 3] = OP_ID;
    out[PATCH_ITEM_LEN + 4] = GENERATION;
    out
};

fn patch_check(args: &Map<String, Value>) -> Vec<Problem> {
    let flat: Vec<&str> = PATCH_ITEM
        .iter()
        .map(|f| f.name)
        .filter(|n| args.contains_key(*n))
        .collect();
    match args.get("items") {
        Some(Value::Array(items)) if items.is_empty() => {
            vec![Problem::new("items", ProblemKind::TooFew).allowed(1)]
        }
        Some(_) => flat
            .iter()
            .map(|n| Problem::new(*n, ProblemKind::Conflict).allowed("items"))
            .collect(),
        None => ["task_key", "operation"]
            .iter()
            .filter(|n| !args.contains_key(**n))
            .map(|n| Problem::new(*n, ProblemKind::Missing))
            .collect(),
    }
}

pub static TASK_PATCH: Tool = Tool {
    name: "atm_task_patch",
    summary: "改任务状态。单条直接写 {task_key, operation, …}，多条放 items。complete、verify、block、wait_user、wait_agent 会自动先 start；本会话持有的任务不需要 expected_version，edit、cancel、reopen 和别人的任务需要。complete 可以同时带 note、evidence、checklist（item 写检查项 id、序号或标题）。block 填 blocked_reason，wait_* 填 waiting_for。例：{task_key:\"ATM-T-1\", operation:\"complete\", evidence:[\"cargo test 全绿\"]}",
    fields: &TASK_PATCH_FIELDS,
    check: Some(patch_check),
    read_only: false,
    destructive: true,
};

static COMPLETED_OBJ: [Field; 2] = [
    Field::new("text", Ty::Text { max: 500 }).required(),
    TASK_KEY,
];

static PROGRESS_FIELDS: [Field; 13] = [
    Field::new("summary", Ty::Text { max: 500 })
        .required()
        .aliases(&["content", "body"]),
    TASK_KEY,
    Field::new("scope", Ty::Enum(&["task", "project"])),
    Field::new(
        "percent",
        Ty::Num {
            min: 0.0,
            max: 100.0,
        },
    ),
    Field::new(
        "evidence",
        Ty::List {
            of: &Ty::TextOr {
                max: 2000,
                obj: &EVIDENCE_OBJ,
            },
            max: 20,
        },
    ),
    Field::new("next", NEXT),
    Field::new(
        "completed",
        Ty::List {
            of: &Ty::TextOr {
                max: 500,
                obj: &COMPLETED_OBJ,
            },
            max: 20,
        },
    ),
    Field::new(
        "health",
        Ty::Enum(&["ON_TRACK", "AT_RISK", "OFF_TRACK", "UNKNOWN"]),
    ),
    Field::new("blocker", Ty::Str { max: 1000 }),
    PROJECT,
    SESSION,
    OP_ID,
    GENERATION,
];

fn progress_check(args: &Map<String, Value>) -> Vec<Problem> {
    // scope 能推出来就推（P2-2）；显式给了就要和其余字段一致。
    let task = match args.get("scope").and_then(Value::as_str) {
        Some(s) => s == "task",
        None => args.contains_key("task_key"),
    };
    let mut out = Vec::new();
    if task && !args.contains_key("task_key") {
        out.push(Problem::new("task_key", ProblemKind::Missing));
    }
    if task && args.contains_key("health") {
        out.push(Problem::new("health", ProblemKind::Conflict).allowed("scope=project"));
    }
    if !task && args.contains_key("percent") {
        out.push(Problem::new("percent", ProblemKind::Conflict).allowed("scope=task"));
    }
    out
}

pub static PROGRESS_ADD: Tool = Tool {
    name: "atm_progress_add",
    summary: "写进度。带 task_key 就是任务进度，否则是项目进度；percent 只用于任务，health 只用于项目。要阻塞任务请用 atm_task_patch 的 block。",
    fields: &PROGRESS_FIELDS,
    check: Some(progress_check),
    read_only: false,
    destructive: false,
};

const RECORD_KINDS: &[&str] = &[
    "DECISION",
    "CONSTRAINT",
    "FACT",
    "RISK",
    "REFERENCE",
    "LESSON",
    "ATM_FEEDBACK",
];

static RECORD_FIELDS: [Field; 14] = [
    Field::new("kind", Ty::Enum(RECORD_KINDS)).required(),
    Field::new("title", Ty::Text { max: 400 }).required(),
    Field::new("summary", Ty::Text { max: 0 }).required(),
    Field::new("detail", Ty::Str { max: 100000 }).aliases(&["details", "content", "body"]),
    TASK_KEY,
    Field::new(
        "importance",
        Ty::Enum(&["LOW", "NORMAL", "HIGH", "CRITICAL"]),
    )
    .default("\"NORMAL\""),
    Field::new("supersedes", Ty::Str { max: 128 }),
    Field::new("topic", Ty::Text { max: 200 }),
    Field::new("subject_key", Ty::Text { max: 200 }),
    Field::new("scope", Ty::Str { max: 100 }),
    PROJECT,
    SESSION,
    OP_ID,
    GENERATION,
];

pub static RECORD: Tool = Tool {
    name: "atm_record",
    summary: "写长期记录（决策、约束、事实、风险、参考、教训）。summary 建议 300 字以内，超出部分自动移到 detail。kind=ATM_FEEDBACK 是给 ATM 本身的使用反馈（取代 atm_feedback）。",
    fields: &RECORD_FIELDS,
    check: None,
    read_only: false,
    destructive: false,
};

static END_FIELDS: [Field; 9] = [
    Field::new("summary", Ty::Text { max: 500 })
        .required()
        .aliases(&["content", "body"]),
    Field::new(
        "outcome",
        Ty::Enum(&[
            "completed",
            "paused",
            "blocked",
            "cancelled",
            "error",
            "retired",
        ]),
    ),
    Field::new("next", NEXT),
    Field::new("release_claims", Ty::Bool).default("true"),
    Field::new("retirement_reason", Ty::Str { max: 500 }),
    PROJECT,
    SESSION,
    OP_ID,
    GENERATION,
];

pub static END: Tool = Tool {
    name: "atm_end",
    summary: "结束会话并交接。outcome 省略时：还持有未完成的任务取 paused，否则 completed。",
    fields: &END_FIELDS,
    check: None,
    read_only: false,
    destructive: false,
};

// ---- memory -------------------------------------------------------------------------------

static SEARCH_FIELDS: [Field; 9] = [
    Field::new("query", Ty::Text { max: 500 }),
    Field::new("op_id", Ty::Str { max: 128 }),
    Field::new("list", Ty::Enum(&["records", "sessions"])),
    PROJECT,
    SESSION,
    TASK_KEY,
    Field::new(
        "field_mask",
        Ty::List {
            of: &Ty::Str { max: 64 },
            max: 20,
        },
    ),
    Field::new("limit", Ty::Int { min: 1, max: 30 }).default("20"),
    Field::new(
        "max_chars",
        Ty::Int {
            min: 300,
            max: 50000,
        },
    )
    .default("6000"),
];

fn search_check(args: &Map<String, Value>) -> Vec<Problem> {
    let has = |k: &str| args.contains_key(k);
    let mut out = Vec::new();
    if has("list") {
        for k in ["query", "op_id"] {
            if has(k) {
                out.push(Problem::new(k, ProblemKind::Conflict).allowed("list"));
            }
        }
    } else {
        if !has("query") && !has("op_id") {
            out.push(Problem::new("query", ProblemKind::Missing).allowed("query or op_id or list"));
        }
        if has("session") && !has("op_id") {
            out.push(Problem::new("session", ProblemKind::Conflict).allowed("op_id"));
        }
    }
    out
}

pub static SEARCH: Tool = Tool {
    name: "atm_search",
    summary: "搜索事实。多个词须同时命中（最多 8 个），双引号括起为相邻短语；任务或记录 key 直接精确读取。op_id 回查一次写操作（可带 session）。list=records|sessions 列表模式，与 query、op_id 不同用。",
    fields: &SEARCH_FIELDS,
    check: Some(search_check),
    read_only: true,
    destructive: false,
};

static KNOWLEDGE_SEARCH_FIELDS: [Field; 6] = [
    Field::new("query", Ty::Str { max: 500 }),
    Field::new("tag", Ty::Text { max: 80 }),
    Field::new("include_archived", Ty::Bool).default("false"),
    Field::new("limit", Ty::Int { min: 1, max: 50 }).default("5"),
    Field::new("max_chars", Ty::Int { min: 1, max: 50000 }).default("2400"),
    Field::new("cursor", Ty::Text { max: 4000 }),
];

pub static KNOWLEDGE_SEARCH: Tool = Tool {
    name: "atm_knowledge_search",
    summary: "搜索本地共享知识的摘要与适用范围。不需要 project 或 session。",
    fields: &KNOWLEDGE_SEARCH_FIELDS,
    check: None,
    read_only: true,
    destructive: false,
};

static KNOWLEDGE_GET_FIELDS: [Field; 7] = [
    Field::new("id", Ty::Text { max: 100 }).required(),
    Field::new("part", Ty::Enum(&["body", "metadata"])).default("\"body\""),
    Field::new("for_edit", Ty::Bool).default("false"),
    Field::new("revision_id", Ty::Text { max: 26 }),
    Field::new("section", Ty::Text { max: 200 }),
    Field::new("max_chars", Ty::Int { min: 1, max: 50000 }).default("6000"),
    Field::new("cursor", Ty::Text { max: 4000 }),
];

pub static KNOWLEDGE_GET: Tool = Tool {
    name: "atm_knowledge_get",
    summary: "读取一条知识的固定修订。要编辑就带 for_edit:true，沿 cursor 读完整再保存；metadataTruncated 时按 metadataRead 续读，各页 metadataJson 拼接后解析。",
    fields: &KNOWLEDGE_GET_FIELDS,
    check: None,
    read_only: true,
    destructive: false,
};

const SOURCE_KINDS: &[&str] = &["project_record", "file", "url", "manual"];
static SOURCE_REF: [Field; 5] = [
    Field::new("type", Ty::Enum(SOURCE_KINDS))
        .required()
        .aliases(&["kind"]),
    Field::new("reference", Ty::Text { max: 2000 }).required(),
    Field::new(
        "sourceVersion",
        Ty::Int {
            min: 0,
            max: i64::MAX,
        },
    )
    .aliases(&["source_version"]),
    Field::new("projectId", Ty::Text { max: 100 }).aliases(&["project_id"]),
    Field::new("recordId", Ty::Text { max: 100 }).aliases(&["record_id"]),
];

static KNOWLEDGE_SAVE_FIELDS: [Field; 15] = [
    Field::new("slug", Ty::Text { max: 160 }).required(),
    Field::new("title", Ty::Text { max: 240 }).required(),
    Field::new("summary", Ty::Text { max: 1000 }).required(),
    Field::new("body_markdown", Ty::Str { max: 500000 })
        .required()
        .aliases(&["body", "content"]),
    Field::new("use_when", Ty::Str { max: 2000 }),
    Field::new(
        "tags",
        Ty::List {
            of: &Ty::Text { max: 80 },
            max: 30,
        },
    ),
    Field::new(
        "aliases",
        Ty::List {
            of: &Ty::Text { max: 160 },
            max: 30,
        },
    ),
    Field::new(
        "applies_to",
        Ty::List {
            of: &Ty::Text { max: 200 },
            max: 30,
        },
    ),
    Field::new(
        "source_refs",
        Ty::List {
            of: &Ty::Obj(&SOURCE_REF),
            max: 30,
        },
    ),
    Field::new("id", Ty::Text { max: 100 }),
    Field::new("expected_revision_id", Ty::Text { max: 100 }),
    Field::new("project", Ty::Str { max: 100 }).aliases(&["project_code"]),
    Field::new("session", Ty::Str { max: 100 }).aliases(&["session_id"]),
    Field::new("op_id", Ty::Str { max: 200 }),
    GENERATION,
];

fn knowledge_save_check(args: &Map<String, Value>) -> Vec<Problem> {
    let mut out = Vec::new();
    match (
        args.contains_key("id"),
        args.contains_key("expected_revision_id"),
    ) {
        (true, false) => out.push(Problem::new("expected_revision_id", ProblemKind::Missing)),
        (false, true) => out.push(Problem::new("id", ProblemKind::Missing)),
        _ => {}
    }
    if let Some(Value::Array(refs)) = args.get("source_refs") {
        for (i, r) in refs.iter().enumerate() {
            if r.get("type").and_then(Value::as_str) == Some("project_record") {
                for k in ["projectId", "recordId", "sourceVersion"] {
                    if r.get(k).is_none() {
                        out.push(Problem::new(
                            format!("source_refs[{i}].{k}"),
                            ProblemKind::Missing,
                        ));
                    }
                }
            }
        }
    }
    out
}

pub static KNOWLEDGE_SAVE: Tool = Tool {
    name: "atm_knowledge_save",
    summary: "直接发布共享知识。先用 atm_knowledge_search 查重；更新要带 id 和 expected_revision_id 并提交完整内容，新建省略二者。source_refs 里 type=project_record 时还要 projectId、recordId、sourceVersion。",
    fields: &KNOWLEDGE_SAVE_FIELDS,
    check: Some(knowledge_save_check),
    read_only: false,
    destructive: false,
};

// ---- 只保留可调用的旧工具（R11 P3） -----------------------------------------------------------

static DELTA_FIELDS: [Field; 5] = [
    PROJECT,
    Field::new(
        "since_seq",
        Ty::Int {
            min: 0,
            max: i64::MAX,
        },
    ),
    Field::new("limit", Ty::Int { min: 1, max: 100 }).default("50"),
    Field::new(
        "types",
        Ty::List {
            of: &Ty::Text { max: 100 },
            max: 50,
        },
    ),
    Field::new(
        "max_chars",
        Ty::Int {
            min: 1000,
            max: 50000,
        },
    )
    .default("12000"),
];

pub static DELTA: Tool = Tool {
    name: "atm_delta",
    summary: "读增量变化（旧名，请改用 atm_brief 的 since_seq）。省略 since_seq 时返回最近 limit 条。",
    fields: &DELTA_FIELDS,
    check: None,
    read_only: true,
    destructive: false,
};

static FEEDBACK_FIELDS: [Field; 9] = [
    Field::new("summary", Ty::Text { max: 300 }).required(),
    Field::new("detail", Ty::Str { max: 50000 }).aliases(&["details", "content", "body"]),
    Field::new("severity", Ty::Enum(&["LOW", "NORMAL", "HIGH", "CRITICAL"])).default("\"NORMAL\""),
    Field::new("tool", Ty::Text { max: 128 }),
    TASK_KEY,
    PROJECT,
    SESSION,
    OP_ID,
    GENERATION,
];

pub static FEEDBACK: Tool = Tool {
    name: "atm_feedback",
    summary: "提交仅存本机的 ATM 使用反馈（旧名，请改用 atm_record 的 kind=ATM_FEEDBACK）。",
    fields: &FEEDBACK_FIELDS,
    check: None,
    read_only: false,
    destructive: false,
};

// ---- profile ------------------------------------------------------------------------------

/// U-7：合并后 core 的 tools 数组不超过 2.0 core + actions 之和（8,016 + 8,164）。
pub const CORE_BUDGET: usize = 16_180;
/// 2.0 的单 profile 可用预算（10,240 − 512）。
pub const PROFILE_BUDGET: usize = 9_728;

static CORE_TOOLS: [&Tool; 9] = [
    &BEGIN,
    &BRIEF,
    &TASK_LIST,
    &TASK_GET,
    &TASK_CREATE,
    &TASK_PATCH,
    &PROGRESS_ADD,
    &RECORD,
    &END,
];
static MEMORY_TOOLS: [&Tool; 4] = [&SEARCH, &KNOWLEDGE_SEARCH, &KNOWLEDGE_GET, &KNOWLEDGE_SAVE];
static OLD_TOOLS: [&Tool; 2] = [&DELTA, &FEEDBACK];
static ACTIONS_TOOLS: [&Tool; 1] = [&TASK_PATCH];
static ACTIONS_HIDDEN: [&Tool; 10] = [
    &BEGIN,
    &BRIEF,
    &TASK_LIST,
    &TASK_GET,
    &TASK_CREATE,
    &PROGRESS_ADD,
    &RECORD,
    &END,
    &DELTA,
    &FEEDBACK,
];

pub static PROFILES: [Profile; 3] = [
    Profile {
        name: "core",
        instructions: "MCP surface v6 · core。ATM 是本机任务账本。流程：atm_begin(agent_id, cwd) 只调一次，直接用返回的 brief → atm_task_patch(task_key, operation:\"start\") → 干活 → atm_task_patch(task_key, operation:\"complete\", note, evidence) → atm_end(summary)。在仓库里首次使用时 begin 加 allow_project_create:true。begin 之后写操作可以省略 project 和 op_id；Claude Code、Codex 还可以省略 session，其他客户端带上 begin 返回的 session。子代理和复核会话用 role 开自己的会话并显式传 session。只有 edit、cancel、reopen 和别人的任务需要 expected_version。出错时照 error.fix 执行。上下文压缩后调无参的 atm_brief()，不要重新 begin。",
        tools: &CORE_TOOLS,
        hidden: &OLD_TOOLS,
        budget: CORE_BUDGET,
    },
    Profile {
        name: "memory",
        instructions: "MCP surface v6 · memory。全文搜索、写操作回查与本机共享知识。会话由 core 的 atm_begin 建立；进度与记录在 core（atm_progress_add、atm_record）。",
        tools: &MEMORY_TOOLS,
        hidden: &OLD_TOOLS,
        budget: PROFILE_BUDGET,
    },
    Profile {
        name: "actions",
        instructions: "MCP surface v6 · actions 是 core 的别名，只为尚未更新的配置保留；atm_task_patch 已在 core 里，请改用 core profile。",
        tools: &ACTIONS_TOOLS,
        hidden: &ACTIONS_HIDDEN,
        budget: PROFILE_BUDGET,
    },
];
