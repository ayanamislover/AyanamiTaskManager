//! atm.exe：AyanamiTaskManager 3 的命令行（06 §6、03 §2.5–2.6）。
//!
//! - 在线命令全部以 Agent 身份走 Agent REST（daemon.json 里的令牌，见 [`discover`]）。写操作（task create / patch、
//!   progress、record）每次新开一个 session、做完立刻结束，与 2.0 的 `inSession` 一样。
//! - 只有用户能做的子命令（project archive / restore、backup create / restore、export、import 不带 --preview）
//!   **在本地直接拒绝，不发任何请求**（连探活都不发）：退出码 3，stderr 写「该操作只能由用户在 ATM 桌面端操作：<入口>」，
//!   `--json` 时 stdout 是 `{"error":{"code":"USER_AUTHORIZATION_REQUIRED",…}}`。服务端照样会拒（双保险）。
//! - `doctor --offline` 只读文件，不连服务（[`offline`]）。
//!
//! 退出码：0 成功；1 服务回了错误（或响应没收全）；2 用法错误；3 只能由用户操作；4 服务不可用。

mod discover;
mod http;
mod offline;
mod ulid;

use atm_domain::capability::Capability;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::time::Duration;

const OK: i32 = 0;
const FAILED: i32 = 1;
const USAGE: i32 = 2;
const USER_ONLY: i32 = 3;
const UNAVAILABLE: i32 = 4;

/// 普通请求的总期限：整库备份、导入预览这类慢操作也在这之内。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
const AGENT_ID: &str = "atm-cli";

const HELP: &str = "\
AyanamiTaskManager 命令行

用法：atm [--json] [--compact] <命令> [参数]

  status                                   服务状态
  doctor [--offline]                       健康检查；--offline 不连服务、只读文件
  project list | open <代码>
  project create <路径> --name <名称> [--code <短代码>] [--mode solo|auto|multi]
  quick add <标题> [--note <备注>]
  quick list [--status <状态>]
  quick promote <id> --project <代码> --version <版本>
  brief <项目>
  task list <项目> [--status <状态>] [--owner <agent>] [--ready] [--limit <数量>]
            [--view core|context|full]
  task show <任务键> [--view core|context|full]
  task create <项目> --file <计划.json>
  task patch <任务键> --version <版本> --operation <操作> [--reason <原因>] [--title <标题>]
  progress <任务键> --summary <摘要> [--percent <0-100>] [--blocker <阻塞说明>]
  record <项目> --kind <类型> --summary <摘要> [--title <标题>] [--detail <详情>]
  events <项目> [--since <序列号>] [--limit <数量>]
  search <关键词> [--project <代码>]
  backup list [--limit <数量>]
  import <文件> --project <代码> --preview

只能由用户在 ATM 桌面端操作（本地拒绝，不发请求，退出码 3）：
  project archive / restore、backup create / restore、export、import（不带 --preview）

--json   输出单行 JSON（错误也是，形如 {\"error\":{\"code\":…}}）
--compact 省略空字段与列表字段

退出码：0 成功；1 服务回了错误；2 用法错误；3 只能由用户操作；4 服务不可用。
发现服务：ATM_ENDPOINT + ATM_TOKEN（只允许 http://127.0.0.1），否则读 ATM3_DATA_DIR 或
%LOCALAPPDATA%\\AyanamiTaskManager3 下的 runtime\\daemon.json。
";

#[derive(Clone, Copy, Default)]
struct Out {
    json: bool,
    compact: bool,
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let code = run(argv);
    let _ = std::io::stdout().flush();
    std::process::exit(code);
}

fn run(argv: Vec<String>) -> i32 {
    let mut out = Out::default();
    let mut rest = Vec::new();
    let mut literal = false;
    for arg in argv {
        match arg.as_str() {
            "--" if !literal => {
                literal = true;
                rest.push(arg);
            }
            "--json" if !literal => out.json = true,
            "--compact" if !literal => out.compact = true,
            _ => rest.push(arg),
        }
    }
    match rest.first().map(String::as_str) {
        None => {
            eprint!("{HELP}");
            return USAGE;
        }
        Some("-h" | "--help" | "help") => {
            print!("{HELP}");
            return OK;
        }
        _ => {}
    }
    // 先判本地拒绝，再做任何别的事：参数对不对都不发请求。
    if let Some((name, capability)) = user_only(&rest) {
        return refuse(out, name, capability);
    }
    let plan = match plan(&rest) {
        Ok(plan) => plan,
        Err(Usage { message, usage }) => return usage_error(out, &message, usage),
    };
    execute(out, plan)
}

// ---- 本地拒绝 ----------------------------------------------------------------------------------

/// 只能由用户操作的子命令与它对应的能力（入口文字取 [`Capability::user_entry`]，与服务端拒绝桩同一处）。
fn user_only(args: &[String]) -> Option<(&'static str, Capability)> {
    let first = args.first()?.as_str();
    let second = args.get(1).map(String::as_str);
    Some(match (first, second) {
        ("project", Some("archive")) => ("project archive", Capability::ProjectArchive),
        ("project", Some("restore")) => ("project restore", Capability::ProjectUnarchive),
        ("backup", Some("create")) => ("backup create", Capability::BackupCreateManual),
        ("backup", Some("restore")) => ("backup restore", Capability::BackupRestoreScope),
        // 00 C-07（v6）：导出只给用户。
        ("export", _) => ("export", Capability::ExportCreate),
        // 导入只保留预览；不带 --preview 的不先发预览请求。
        ("import", _) if !args[1..].iter().any(|a| a == "--preview") => {
            ("import", Capability::ImportApply)
        }
        _ => return None,
    })
}

fn refuse(out: Out, name: &str, capability: Capability) -> i32 {
    let entry = capability.user_entry().unwrap_or("ATM 桌面端");
    let message = format!("该操作只能由用户在 ATM 桌面端操作：{entry}");
    if out.json {
        println!(
            "{}",
            json!({"error": {
                "code": "USER_AUTHORIZATION_REQUIRED",
                "message": message,
                "command": name,
                "user_entry": entry,
                "committed": false,
            }})
        );
    } else {
        eprintln!("{message}");
    }
    USER_ONLY
}

// ---- 参数 ----------------------------------------------------------------------------------------

struct Usage {
    message: String,
    usage: &'static str,
}

struct Spec {
    usage: &'static str,
    positional: &'static [&'static str],
    valued: &'static [&'static str],
    required: &'static [&'static str],
    flags: &'static [&'static str],
}

struct Parsed {
    pos: Vec<String>,
    opts: HashMap<String, String>,
    flags: HashSet<String>,
}

impl Parsed {
    fn opt(&self, name: &str) -> Option<&str> {
        self.opts.get(name).map(String::as_str)
    }
    fn flag(&self, name: &str) -> bool {
        self.flags.contains(name)
    }
}

fn parse_args(spec: &Spec, args: &[String]) -> Result<Parsed, Usage> {
    let bad = |message: String| Usage {
        message,
        usage: spec.usage,
    };
    let mut parsed = Parsed {
        pos: Vec::new(),
        opts: HashMap::new(),
        flags: HashSet::new(),
    };
    let mut literal = false;
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        i += 1;
        if literal || !arg.starts_with("--") || arg == "--" {
            if arg == "--" && !literal {
                literal = true;
                continue;
            }
            parsed.pos.push(arg.clone());
            continue;
        }
        let (name, inline) = match arg[2..].split_once('=') {
            Some((name, value)) => (name, Some(value.to_owned())),
            None => (&arg[2..], None),
        };
        if spec.flags.contains(&name) {
            if inline.is_some() {
                return Err(bad(format!("--{name} 不带值")));
            }
            parsed.flags.insert(name.to_owned());
        } else if spec.valued.contains(&name) {
            let value = match inline {
                Some(value) => value,
                None => {
                    let Some(value) = args.get(i) else {
                        return Err(bad(format!("--{name} 缺少值")));
                    };
                    i += 1;
                    value.clone()
                }
            };
            if parsed.opts.insert(name.to_owned(), value).is_some() {
                return Err(bad(format!("--{name} 给了不止一次")));
            }
        } else {
            return Err(bad(format!("不认识的选项 --{name}")));
        }
    }
    if parsed.pos.len() < spec.positional.len() {
        return Err(bad(format!(
            "缺少参数 {}",
            spec.positional[parsed.pos.len()]
        )));
    }
    if parsed.pos.len() > spec.positional.len() {
        return Err(bad(format!(
            "多余的参数 {}",
            parsed.pos[spec.positional.len()]
        )));
    }
    if let Some(missing) = spec
        .required
        .iter()
        .find(|r| !parsed.opts.contains_key(**r))
    {
        return Err(bad(format!("缺少必填选项 --{missing}")));
    }
    Ok(parsed)
}

fn usage_error(out: Out, message: &str, usage: &str) -> i32 {
    if out.json {
        println!(
            "{}",
            json!({"error": {"code": "USAGE", "message": message, "usage": usage}})
        );
    } else {
        eprintln!("用法错误：{message}\n用法：{usage}\n完整说明：atm --help");
    }
    USAGE
}

// ---- 命令 → 请求 ---------------------------------------------------------------------------------

enum Plan {
    Status,
    Doctor,
    DoctorOffline,
    /// 读：`list` 是人读输出时按行展开的列表字段（按顺序，每个一节）。
    Get {
        path: String,
        list: &'static [(&'static str, &'static str)],
    },
    Post {
        path: String,
        body: Value,
    },
    /// 在一个新 session 里做一次写，做完立刻结束 session。
    Session {
        project: String,
        title: String,
        path: String,
        body: Value,
    },
    /// 跟随游标翻页，直到凑够 `limit` 条或没有下一页。
    TaskList {
        path: String,
        query: Vec<(&'static str, String)>,
        limit: usize,
    },
}

const NO_LIST: &[(&str, &str)] = &[];

fn plan(args: &[String]) -> Result<Plan, Usage> {
    let first = args[0].as_str();
    let group = matches!(first, "project" | "quick" | "task" | "backup");
    let (name, rest) = if group {
        match args.get(1) {
            Some(sub) => (format!("{first} {sub}"), &args[2..]),
            None => {
                return Err(Usage {
                    message: format!("{first} 后面要跟子命令"),
                    usage: group_usage(first),
                });
            }
        }
    } else {
        (first.to_owned(), &args[1..])
    };
    let spec = spec(&name).ok_or_else(|| Usage {
        message: format!("不认识的命令 {name}"),
        usage: if group {
            group_usage(first)
        } else {
            "atm --help"
        },
    })?;
    let p = parse_args(spec, rest)?;
    let bad = |message: String| Usage {
        message,
        usage: spec.usage,
    };
    let int = |name: &str, value: &str| -> Result<i64, Usage> {
        value
            .trim()
            .parse::<i64>()
            .map_err(|_| bad(format!("--{name} 要写整数，收到 {value}")))
    };
    let pos = |i: usize| p.pos[i].clone();
    Ok(match name.as_str() {
        "status" => Plan::Status,
        "doctor" if p.flag("offline") => Plan::DoctorOffline,
        "doctor" => Plan::Doctor,
        "project list" => Plan::Get {
            path: "/api/v1/projects".into(),
            list: &[("projects", "")],
        },
        "project open" => Plan::Get {
            path: format!("/api/v1/projects/{}", seg(&pos(0))),
            list: NO_LIST,
        },
        "project create" => {
            let path = std::path::absolute(pos(0))
                .map_err(|e| bad(format!("路径无效：{e}")))?
                .to_string_lossy()
                .into_owned();
            let mode = p.opt("mode").unwrap_or("auto").to_ascii_uppercase();
            if !matches!(mode.as_str(), "SOLO" | "AUTO" | "MULTI") {
                return Err(bad(format!(
                    "--mode 只能是 solo、auto 或 multi，收到 {mode}"
                )));
            }
            let mut body = json!({
                "name": p.opt("name"),
                "path": path,
                "coordination_mode": mode,
                "actor": AGENT_ID,
                "op_id": op_id("project"),
            });
            if let Some(code) = p.opt("code") {
                body["code"] = json!(code);
            }
            Plan::Post {
                path: "/api/v1/projects".into(),
                body,
            }
        }
        "quick add" => {
            let mut body = json!({"title": pos(0), "actor": AGENT_ID, "op_id": op_id("quick")});
            if let Some(note) = p.opt("note") {
                body["note"] = json!(note);
            }
            Plan::Post {
                path: "/api/v1/quick-tasks".into(),
                body,
            }
        }
        "quick list" => Plan::Get {
            path: with_query(
                "/api/v1/quick-tasks",
                &[("status", p.opt("status").map(str::to_ascii_uppercase))],
            ),
            list: &[("quick_tasks", "")],
        },
        "quick promote" => Plan::Post {
            path: format!("/api/v1/quick-tasks/{}/promote", seg(&pos(0))),
            body: json!({
                "expected_version": int("version", p.opt("version").unwrap_or_default())?,
                "target_project": p.opt("project"),
                "actor": AGENT_ID,
                "op_id": op_id("promote"),
            }),
        },
        "brief" => Plan::Get {
            path: format!("/api/v1/projects/{}/brief", seg(&pos(0))),
            list: NO_LIST,
        },
        "task list" => {
            let limit = match p.opt("limit") {
                Some(v) => int("limit", v)?,
                None => 20,
            };
            if limit < 1 {
                return Err(bad("--limit 至少是 1".into()));
            }
            let status = p.opt("status").map(|s| {
                if matches!(s.to_ascii_lowercase().as_str(), "open" | "closed" | "all") {
                    s.to_ascii_lowercase()
                } else {
                    s.to_ascii_uppercase()
                }
            });
            let mut query = Vec::new();
            if let Some(status) = status {
                query.push(("status", status));
            }
            if let Some(owner) = p.opt("owner") {
                query.push(("owner", owner.to_owned()));
            }
            if p.flag("ready") {
                query.push(("ready_only", "true".to_owned()));
            }
            // core 视图没有标题；默认 context，与 2.0 一样每行有任务名。
            query.push(("view", p.opt("view").unwrap_or("context").to_owned()));
            Plan::TaskList {
                path: format!("/api/v1/projects/{}/work-items", seg(&pos(0))),
                query,
                limit: limit as usize,
            }
        }
        "task show" => {
            let key = pos(0);
            let project = project_of(&key).map_err(bad)?;
            Plan::Get {
                path: with_query(
                    &format!(
                        "/api/v1/projects/{}/work-items/{}",
                        seg(&project),
                        seg(&key)
                    ),
                    &[("view", Some(p.opt("view").unwrap_or("context").to_owned()))],
                ),
                list: NO_LIST,
            }
        }
        "task create" => {
            let project = pos(0);
            let file = p.opt("file").unwrap_or_default();
            let text = std::fs::read_to_string(file)
                .map_err(|e| bad(format!("读不了计划文件 {file}：{e}")))?;
            let plan: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
                .map_err(|e| bad(format!("计划文件不是 JSON：{e}")))?;
            let Some(items) = plan.get("items").filter(|v| v.is_array()) else {
                return Err(bad("计划文件要写成 {\"items\": [...]}".into()));
            };
            Plan::Session {
                path: format!("/api/v1/projects/{}/work-items", seg(&project)),
                title: "CLI 创建计划".into(),
                body: json!({"items": items}),
                project,
            }
        }
        "task patch" => {
            let key = pos(0);
            let project = project_of(&key).map_err(bad)?;
            let mut item = json!({
                "task_key": key,
                "expected_version": int("version", p.opt("version").unwrap_or_default())?,
                "operation": p.opt("operation"),
            });
            if let Some(reason) = p.opt("reason") {
                item["blocked_reason"] = json!(reason);
            }
            if let Some(title) = p.opt("title") {
                item["title"] = json!(title);
            }
            Plan::Session {
                path: format!("/api/v1/projects/{}/work-items/patch", seg(&project)),
                title: format!("CLI 更新 {key}"),
                body: json!({"items": [item]}),
                project,
            }
        }
        "progress" => {
            let key = pos(0);
            let project = project_of(&key).map_err(bad)?;
            let summary = p.opt("summary").unwrap_or_default().to_owned();
            let mut body = json!({"scope": "task", "task_key": key, "summary": summary});
            if let Some(percent) = p.opt("percent") {
                body["percent"] = json!(int("percent", percent)?);
            }
            if let Some(blocker) = p.opt("blocker") {
                body["blocker"] = json!(blocker);
            }
            Plan::Session {
                path: format!("/api/v1/projects/{}/progress-updates", seg(&project)),
                title: summary,
                body,
                project,
            }
        }
        "record" => {
            let project = pos(0);
            let summary = p.opt("summary").unwrap_or_default().to_owned();
            let body = json!({
                "kind": p.opt("kind").unwrap_or_default().to_ascii_uppercase(),
                "title": p.opt("title").unwrap_or(&summary),
                "summary": summary,
                "detail": p.opt("detail").unwrap_or_default(),
                "importance": "NORMAL",
                "scope": "PROJECT",
            });
            Plan::Session {
                path: format!("/api/v1/projects/{}/records", seg(&project)),
                title: summary,
                body,
                project,
            }
        }
        "events" => {
            let since = match p.opt("since") {
                Some(v) => int("since", v)?,
                None => 0,
            };
            let limit = p.opt("limit").map(|v| int("limit", v)).transpose()?;
            Plan::Get {
                path: with_query(
                    &format!("/api/v1/projects/{}/events", seg(&pos(0))),
                    &[
                        ("since", Some(since.to_string())),
                        ("limit", limit.map(|l| l.to_string())),
                    ],
                ),
                list: &[("events", "")],
            }
        }
        "search" => {
            let base = match p.opt("project") {
                Some(project) => format!("/api/v1/projects/{}/search", seg(project)),
                None => "/api/v1/search".into(),
            };
            Plan::Get {
                path: with_query(&base, &[("query", Some(pos(0)))]),
                list: &[("hits", "")],
            }
        }
        "backup list" => {
            let limit = p.opt("limit").map(|v| int("limit", v)).transpose()?;
            Plan::Get {
                path: with_query(
                    "/api/v1/backups",
                    &[("limit", limit.map(|l| l.to_string()))],
                ),
                list: &[
                    ("backups", "3.0 整库备份"),
                    (
                        "legacyBackups",
                        "2.x 备份（只能在应用内作为项目或知识库导入）",
                    ),
                ],
            }
        }
        "import" => {
            let file = pos(0);
            let content =
                std::fs::read_to_string(&file).map_err(|e| bad(format!("读不了 {file}：{e}")))?;
            let source = std::path::absolute(&file)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or(file);
            Plan::Post {
                path: "/api/v1/imports/agenttask-md/preview".into(),
                body: json!({"project": p.opt("project"), "content": content, "source_name": source}),
            }
        }
        _ => unreachable!("spec() and plan() list the same commands"),
    })
}

fn spec(name: &str) -> Option<&'static Spec> {
    macro_rules! s {
        ($usage:expr, [$($p:expr),*], [$($v:expr),*], [$($r:expr),*], [$($f:expr),*]) => {
            &Spec { usage: $usage, positional: &[$($p),*], valued: &[$($v),*], required: &[$($r),*], flags: &[$($f),*] }
        };
    }
    Some(match name {
        "status" => s!("atm status", [], [], [], []),
        "doctor" => s!("atm doctor [--offline]", [], [], [], ["offline"]),
        "project list" => s!("atm project list", [], [], [], []),
        "project open" => s!("atm project open <代码>", ["<代码>"], [], [], []),
        "project create" => s!(
            "atm project create <路径> --name <名称> [--code <短代码>] [--mode solo|auto|multi]",
            ["<路径>"],
            ["name", "code", "mode"],
            ["name"],
            []
        ),
        "quick add" => s!(
            "atm quick add <标题> [--note <备注>]",
            ["<标题>"],
            ["note"],
            [],
            []
        ),
        "quick list" => s!("atm quick list [--status <状态>]", [], ["status"], [], []),
        "quick promote" => s!(
            "atm quick promote <id> --project <代码> --version <版本>",
            ["<id>"],
            ["project", "version"],
            ["project", "version"],
            []
        ),
        "brief" => s!("atm brief <项目>", ["<项目>"], [], [], []),
        "task list" => s!(
            "atm task list <项目> [--status <状态>] [--owner <agent>] [--ready] [--limit <数量>] [--view core|context|full]",
            ["<项目>"],
            ["status", "owner", "limit", "view"],
            [],
            ["ready"]
        ),
        "task show" => s!(
            "atm task show <任务键> [--view core|context|full]",
            ["<任务键>"],
            ["view"],
            [],
            []
        ),
        "task create" => s!(
            "atm task create <项目> --file <计划.json>",
            ["<项目>"],
            ["file"],
            ["file"],
            []
        ),
        "task patch" => s!(
            "atm task patch <任务键> --version <版本> --operation <操作> [--reason <原因>] [--title <标题>]",
            ["<任务键>"],
            ["version", "operation", "reason", "title"],
            ["version", "operation"],
            []
        ),
        "progress" => s!(
            "atm progress <任务键> --summary <摘要> [--percent <0-100>] [--blocker <阻塞说明>]",
            ["<任务键>"],
            ["summary", "percent", "blocker"],
            ["summary"],
            []
        ),
        "record" => s!(
            "atm record <项目> --kind <类型> --summary <摘要> [--title <标题>] [--detail <详情>]",
            ["<项目>"],
            ["kind", "summary", "title", "detail"],
            ["kind", "summary"],
            []
        ),
        "events" => s!(
            "atm events <项目> [--since <序列号>] [--limit <数量>]",
            ["<项目>"],
            ["since", "limit"],
            [],
            []
        ),
        "search" => s!(
            "atm search <关键词> [--project <代码>]",
            ["<关键词>"],
            ["project"],
            [],
            []
        ),
        // 3.0 的备份是整库的：--project 照收不过滤（与服务端一致）。
        "backup list" => s!(
            "atm backup list [--limit <数量>]",
            [],
            ["limit", "project"],
            [],
            []
        ),
        "import" => s!(
            "atm import <文件> --project <代码> --preview",
            ["<文件>"],
            ["project"],
            ["project"],
            ["preview"]
        ),
        _ => return None,
    })
}

fn group_usage(group: &str) -> &'static str {
    match group {
        "project" => "atm project list | open <代码> | create <路径> --name <名称>",
        "quick" => "atm quick add <标题> | list | promote <id> --project <代码> --version <版本>",
        "task" => {
            "atm task list <项目> | show <任务键> | create <项目> --file <计划.json> | patch <任务键> …"
        }
        _ => "atm backup list",
    }
}

/// `ATM-T-0001` → `ATM`（与 2.0 一样按任务键拆出项目代码）。
fn project_of(key: &str) -> Result<String, String> {
    let upper = key.to_ascii_uppercase();
    match upper.rfind("-T-") {
        Some(at)
            if at > 0
                && upper.len() > at + 3
                && upper[at + 3..].bytes().all(|b| b.is_ascii_digit()) =>
        {
            Ok(upper[..at].to_owned())
        }
        _ => Err(format!("无效任务键：{key}（应形如 ATM-T-0001）")),
    }
}

/// 路径段与 query 值的百分号编码：只留 RFC 3986 的非保留字符。
fn seg(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn with_query(path: &str, pairs: &[(&str, Option<String>)]) -> String {
    let mut out = path.to_owned();
    let mut sep = if path.contains('?') { '&' } else { '?' };
    for (key, value) in pairs {
        if let Some(value) = value {
            out.push(sep);
            out.push_str(key);
            out.push('=');
            out.push_str(&seg(value));
            sep = '&';
        }
    }
    out
}

fn op_id(kind: &str) -> String {
    format!(
        "cli-{kind}-{}",
        ulid::new().unwrap_or_else(|| format!("{}", std::process::id()))
    )
}

// ---- 执行 ----------------------------------------------------------------------------------------

enum Failure {
    /// 服务回了错误信封。
    Server { status: u16, body: Value },
    /// 连不上（请求没送到）。
    Unsent,
    /// 请求送到了，响应没收全：写操作是否提交未知。
    Response,
}

fn call(
    target: &discover::Target,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<Value, Failure> {
    let text = body.map(Value::to_string);
    let response = http::request(
        target.port,
        method,
        path,
        &target.token,
        text.as_deref(),
        REQUEST_TIMEOUT,
    )
    .map_err(|e| match e {
        http::Error::Refused | http::Error::Unsent => Failure::Unsent,
        http::Error::Response => Failure::Response,
    })?;
    let value: Value = serde_json::from_slice(&response.body).unwrap_or_else(|_| {
        json!({
            "code": "INVALID_RESPONSE",
            "message": String::from_utf8_lossy(&response.body).chars().take(500).collect::<String>(),
        })
    });
    if (200..300).contains(&response.status) {
        Ok(value)
    } else {
        Err(Failure::Server {
            status: response.status,
            body: value,
        })
    }
}

fn execute(out: Out, plan: Plan) -> i32 {
    if let Plan::DoctorOffline = plan {
        return doctor_offline(out);
    }
    let target = match discover::discover() {
        Ok(target) => target,
        Err(why) => return unavailable(out, &why, matches!(plan, Plan::Status | Plan::Doctor)),
    };
    let result = match &plan {
        Plan::Status => call(&target, "GET", "/api/v1/system/status", None),
        Plan::Doctor => call(&target, "GET", "/api/v1/system/status", None).map(|service| {
            let local = discover::data_root().map(|root| offline::doctor(&root).value);
            json!({"service": service, "local": local})
        }),
        Plan::Get { path, .. } => call(&target, "GET", path, None),
        Plan::Post { path, body } => call(&target, "POST", path, Some(body)),
        Plan::Session {
            project,
            title,
            path,
            body,
        } => in_session(&target, project, title, path, body),
        Plan::TaskList { path, query, limit } => task_list(&target, path, query, *limit),
        Plan::DoctorOffline => unreachable!("answered before discovery"),
    };
    match result {
        Ok(value) => {
            let list = match &plan {
                Plan::Get { list, .. } => *list,
                Plan::TaskList { .. } => &[("items", "")],
                _ => NO_LIST,
            };
            show(out, &value, list);
            OK
        }
        Err(failure) => fail(out, failure),
    }
}

fn in_session(
    target: &discover::Target,
    project: &str,
    title: &str,
    path: &str,
    body: &Value,
) -> Result<Value, Failure> {
    let title: String = title.chars().take(400).collect();
    let begun = call(
        target,
        "POST",
        "/api/v1/sessions",
        Some(&json!({
            "agent_id": AGENT_ID,
            "client_kind": "cli",
            "project": project,
            "mode": "project",
            "resume": false,
            "brief": "none",
            "title": title,
            "op_id": op_id("begin"),
        })),
    )?;
    let Some(session) = begun
        .get("session")
        .and_then(|s| s.as_str().or_else(|| s.get("id").and_then(Value::as_str)))
        .map(str::to_owned)
    else {
        return Err(Failure::Server {
            status: 200,
            body: json!({"code": "INVALID_RESPONSE", "message": "开始 session 的回执里没有 session id"}),
        });
    };
    let mut body = body.clone();
    body["session"] = json!(session);
    body["op_id"] = json!(op_id("write"));
    let result = call(target, "POST", path, Some(&body));
    let (outcome, summary) = match &result {
        Ok(_) => ("completed", title.clone()),
        Err(Failure::Server { body, .. }) => (
            "error",
            body.get("message")
                .and_then(Value::as_str)
                .unwrap_or("CLI 操作失败")
                .chars()
                .take(500)
                .collect(),
        ),
        Err(_) => ("error", "CLI 操作没有收到完整的响应".to_owned()),
    };
    let summary = if summary.trim().is_empty() {
        "CLI 操作".to_owned()
    } else {
        summary
    };
    let ended = call(
        target,
        "POST",
        &format!("/api/v1/sessions/{}/close", seg(&session)),
        Some(&json!({
            "summary": summary,
            "outcome": outcome,
            "next": [],
            "release_claims": true,
            "op_id": op_id("end"),
        })),
    );
    if ended.is_err() && result.is_ok() {
        eprintln!("提示：写入已完成，但 session {session} 没有正常结束；它会按超时自动关闭。");
    }
    result
}

fn task_list(
    target: &discover::Target,
    path: &str,
    query: &[(&'static str, String)],
    limit: usize,
) -> Result<Value, Failure> {
    let mut items = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page_size = (limit - items.len()).min(100);
        let mut pairs: Vec<(&str, Option<String>)> =
            query.iter().map(|(k, v)| (*k, Some(v.clone()))).collect();
        pairs.push(("limit", Some(page_size.to_string())));
        pairs.push(("cursor", cursor.clone()));
        let mut page = call(target, "GET", &with_query(path, &pairs), None)?;
        if let Some(Value::Array(more)) = page.get_mut("items").map(Value::take) {
            items.extend(more);
        }
        cursor = page
            .get("next_cursor")
            .and_then(Value::as_str)
            .filter(|c| !c.is_empty())
            .map(str::to_owned);
        if cursor.is_none() || items.len() >= limit {
            items.truncate(limit);
            page["returned_count"] = json!(items.len());
            page["items"] = Value::Array(items);
            return Ok(page);
        }
    }
}

fn doctor_offline(out: Out) -> i32 {
    let Some(root) = discover::data_root() else {
        return unavailable(out, &discover::Unavailable::NoDataRoot, false);
    };
    let report = offline::doctor(&root);
    show(out, &report.value, NO_LIST);
    if report.problems.is_empty() {
        OK
    } else {
        FAILED
    }
}

/// 服务不可用。`diagnose` 时（status / doctor）附上不含凭据的启动状态与离线检查（B2）。
fn unavailable(out: Out, why: &discover::Unavailable, diagnose: bool) -> i32 {
    let root = discover::data_root();
    let startup = root
        .as_deref()
        .and_then(discover::startup_state)
        .map(|s| json!({"state": s.state, "since": s.since, "reason": s.reason}));
    let mut error = json!({"code": why.code(), "message": why.message(), "startup_state": startup});
    if diagnose && let Some(root) = &root {
        error["local"] = offline::doctor(root).value;
    }
    if out.json {
        println!("{}", json!({ "error": error }));
    } else {
        eprintln!("{}：{}", why.code(), why.message());
        if diagnose && let Some(local) = error.get("local") {
            let mut buf = String::new();
            lines(&mut buf, local, out.compact);
            eprint!("{buf}");
        }
    }
    UNAVAILABLE
}

fn fail(out: Out, failure: Failure) -> i32 {
    let (status, body) = match failure {
        Failure::Server { status, body } => (Some(status), body),
        Failure::Unsent => (
            None,
            json!({"code": "ATM_RUNTIME_UNAVAILABLE", "message": "连不上 ATM 服务：请求没有送到", "committed": false}),
        ),
        Failure::Response => (
            None,
            json!({"code": "ATM_RESPONSE_INCOMPLETE",
                   "message": "请求已送到但响应没收全：写操作是否提交未知，请先读回核对再决定是否重试",
                   "committed": "unknown"}),
        ),
    };
    let code = body.get("code").and_then(Value::as_str).unwrap_or("ERROR");
    let exit = match (status, code) {
        (_, "USER_AUTHORIZATION_REQUIRED") => USER_ONLY,
        (None, "ATM_RUNTIME_UNAVAILABLE") => UNAVAILABLE,
        _ => FAILED,
    };
    if out.json {
        println!("{}", json!({ "error": body, "status": status }));
        return exit;
    }
    let message = body.get("message").and_then(Value::as_str).unwrap_or("");
    eprintln!("{code}：{message}");
    // 信封的 committed：false / true / "unknown"。
    match body.get("committed") {
        Some(Value::Bool(true)) => eprintln!("已提交：是"),
        Some(Value::String(state)) => {
            eprintln!("是否已提交：{state}（先读回核对，再决定是否重试）")
        }
        _ => {}
    }
    if let Some(problems) = body.get("problems").filter(|p| !p.is_null()) {
        eprintln!("问题：{problems}");
    }
    if let Some(fix) = body.get("fix").and_then(Value::as_object) {
        for key in ["why", "message"] {
            if let Some(text) = fix.get(key).and_then(Value::as_str) {
                eprintln!("下一步：{text}");
            }
        }
    }
    exit
}

// ---- 输出 ----------------------------------------------------------------------------------------

fn show(out: Out, value: &Value, list: &[(&str, &str)]) {
    let mut buf = String::new();
    if out.json {
        buf.push_str(&value.to_string());
        buf.push('\n');
    } else {
        let sections: Vec<(&str, &Vec<Value>)> = list
            .iter()
            .filter_map(|(key, heading)| {
                value
                    .get(*key)
                    .and_then(Value::as_array)
                    .map(|rows| (*heading, rows))
            })
            .collect();
        if sections.is_empty() {
            lines(&mut buf, value, out.compact);
        } else {
            let headed = sections.len() > 1;
            for (heading, rows) in sections {
                if headed {
                    buf.push_str(&format!("{heading}：\n"));
                }
                rows_into(&mut buf, rows);
            }
            if value.get("has_more").and_then(Value::as_bool) == Some(true) {
                buf.push_str("……还有更多，用 --json 查看完整结果\n");
            }
        }
    }
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(buf.as_bytes());
}

fn rows_into(buf: &mut String, rows: &[Value]) {
    if rows.is_empty() {
        buf.push_str("没有记录。\n");
        return;
    }
    let text = |row: &Value, keys: &[&str]| {
        keys.iter()
            .find_map(|k| {
                row.get(*k)
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
            })
            .map(str::to_owned)
    };
    for row in rows {
        let key = text(row, &["code", "key", "entity_key", "id"]).unwrap_or_else(|| "•".into());
        let label = text(row, &["name", "title", "summary"]).unwrap_or_else(|| {
            [
                text(row, &["kind", "type", "scope"]),
                text(row, &["createdAt", "created_at"]),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("  ")
        });
        // 状态，或者（搜索命中里）实体类型：同一个 key 可能既是任务又是它的进度。
        match text(row, &["status", "entity_type"]) {
            Some(status) => buf.push_str(&format!("{key}  [{status}]  {label}\n")),
            None => buf.push_str(&format!("{key}  {label}\n")),
        }
    }
}

fn lines(buf: &mut String, value: &Value, compact: bool) {
    let Some(map) = value.as_object() else {
        match value {
            Value::String(s) => buf.push_str(s),
            other => buf.push_str(&other.to_string()),
        }
        buf.push('\n');
        return;
    };
    let keep = |item: &Value| !compact || !(item.is_null() || item == "" || item.is_array());
    for (key, item) in map.iter().filter(|(_, item)| keep(item)) {
        let text = match item {
            Value::String(s) => s.clone(),
            Value::Object(_) | Value::Array(_) => item.to_string(),
            other => other.to_string(),
        };
        buf.push_str(&format!("{key}: {text}\n"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn user_only_commands_are_recognised_before_their_arguments() {
        for (args, name) in [
            (&["project", "archive", "ATM"][..], "project archive"),
            (&["project", "archive"][..], "project archive"),
            (
                &["project", "restore", "ATM", "--bogus"][..],
                "project restore",
            ),
            (&["backup", "create", "--project", "X"][..], "backup create"),
            (&["backup", "restore", "B1"][..], "backup restore"),
            (&["export", "ATM", "--format", "json"][..], "export"),
            (&["import", "plan.md", "--project", "ATM"][..], "import"),
        ] {
            assert_eq!(user_only(&v(args)).map(|(n, _)| n), Some(name), "{args:?}");
        }
        for args in [
            &["import", "plan.md", "--project", "ATM", "--preview"][..],
            &["backup", "list"][..],
            &["project", "list"][..],
            &["status"][..],
        ] {
            assert!(user_only(&v(args)).is_none(), "{args:?}");
        }
        // 每个都有用户入口文字（取不到就说明能力表与这里对不上）。
        for args in [
            &["project", "archive"][..],
            &["project", "restore"][..],
            &["backup", "create"][..],
            &["backup", "restore"][..],
            &["export"][..],
            &["import", "x"][..],
        ] {
            let (_, cap) = user_only(&v(args)).unwrap();
            assert!(cap.user_entry().is_some(), "{args:?}");
        }
    }

    #[test]
    fn arguments_are_checked_against_the_spec() {
        let spec = spec("task patch").unwrap();
        let p = parse_args(
            spec,
            &v(&["ATM-T-0001", "--version=3", "--operation", "start"]),
        )
        .ok()
        .unwrap();
        assert_eq!(p.pos, ["ATM-T-0001"]);
        assert_eq!(
            (p.opt("version"), p.opt("operation")),
            (Some("3"), Some("start"))
        );
        for (args, message) in [
            (
                &["ATM-T-0001", "--version", "3"][..],
                "缺少必填选项 --operation",
            ),
            (
                &["--version", "3", "--operation", "x"][..],
                "缺少参数 <任务键>",
            ),
            (
                &["A-T-1", "B", "--version", "3", "--operation", "x"][..],
                "多余的参数 B",
            ),
            (
                &["A-T-1", "--version", "3", "--operation", "x", "--nope"][..],
                "不认识的选项 --nope",
            ),
            (&["A-T-1", "--version"][..], "--version 缺少值"),
            (
                &[
                    "A-T-1",
                    "--version",
                    "1",
                    "--version",
                    "2",
                    "--operation",
                    "x",
                ][..],
                "--version 给了不止一次",
            ),
        ] {
            assert_eq!(
                parse_args(spec, &v(args)).err().map(|u| u.message),
                Some(message.to_owned()),
                "{args:?}"
            );
        }
        // `--` 之后都是位置参数。
        let p = parse_args(spec_of("search"), &v(&["--", "--json"]))
            .ok()
            .unwrap();
        assert_eq!(p.pos, ["--json"]);
    }

    fn spec_of(name: &str) -> &'static Spec {
        spec(name).unwrap()
    }

    #[test]
    fn task_keys_name_their_project() {
        assert_eq!(project_of("atm-T-0816"), Ok("ATM".into()));
        assert_eq!(project_of("MY-APP-T-12"), Ok("MY-APP".into()));
        for bad in ["ATM", "ATM-T-", "-T-1", "ATM-T-1a"] {
            assert!(project_of(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn path_segments_and_query_values_are_encoded() {
        assert_eq!(seg("a b/c?d#e%"), "a%20b%2Fc%3Fd%23e%25");
        assert_eq!(seg("经"), "%E7%BB%8F");
        assert_eq!(
            with_query(
                "/x",
                &[
                    ("a", Some("1 2".into())),
                    ("b", None),
                    ("c", Some("&".into()))
                ]
            ),
            "/x?a=1%202&c=%26"
        );
    }

    #[test]
    fn rows_and_objects_print_like_2_0() {
        let mut buf = String::new();
        rows_into(
            &mut buf,
            &[
                json!({"key": "ATM-T-1", "title": "写文档", "status": "READY"}),
                json!({"code": "ATM", "name": "主项目"}),
            ],
        );
        assert_eq!(buf, "ATM-T-1  [READY]  写文档\nATM  主项目\n");
        let mut buf = String::new();
        rows_into(&mut buf, &[]);
        assert_eq!(buf, "没有记录。\n");
        let mut buf = String::new();
        lines(
            &mut buf,
            &json!({"a": 1, "b": "", "c": [1], "d": {"e": null}, "f": null}),
            true,
        );
        assert_eq!(buf, "a: 1\nd: {\"e\":null}\n");
    }
}
