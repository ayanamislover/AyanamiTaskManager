//! 由代码生成的 Agent 文档（W4j-3；11 §5 U-7 的数字、GUIDE 的自动节）。
//!
//! 生成 `docs/generated/` 下的四页，以及 `ATM_AGENT_GUIDE.md`、`docs/agent-integration.md`、`README.md`
//! 里成对标记之间的段落。仓库里的文件必须与生成结果逐字节一致，不一致就红；`ATM_DOCS_BLESS=1` 重写。
//!
//! 数据源：工具表（`tools::PROFILES`）、状态机（`atm_domain::work`）、task_patch 的字段映射
//! （`write::COMMON` / `operation_fields` / `COMPOSITE`）、错误码表（`ErrorCode::ALL`）。
//! 写入回执与错误信封各取几次真实调用：回执里出现了没写进字段表的字段、或者字段表里的字段一次都没出现，都会红。

mod support;

use atm_domain::error::{Committed, Envelope, ErrorCode, Fix, FixKind};
use atm_domain::work::{
    self, AutoStart, Operation, PatchKind, StateWrite, Status, VersionNeed, WorkState,
};
use atm_http::mcp::{PROTOCOL_VERSIONS, Profile, SURFACE_VERSION};
use atm_http::tools::{self, PROFILES};
use atm_http::write::{COMMON, COMPOSITE, operation_fields};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use support::*;

const BLESS: &str = "ATM_DOCS_BLESS";
const REGENERATE: &str = "ATM_DOCS_BLESS=1 cargo test -p atm-http --test docs";

const WORK_ITEM_OPERATIONS: &str = "WORK_ITEM_OPERATIONS";
const TASK_PATCH_COMPOSITE: &str = "TASK_PATCH_COMPOSITE";
const MUTATION_ACK_CONTRACT: &str = "MUTATION_ACK_CONTRACT";
const ERROR_ENVELOPE: &str = "ERROR_ENVELOPE";
const MCP_TOOL_STATS: &str = "MCP_TOOL_STATS";

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..")
}

// ---- 排版 ------------------------------------------------------------------------------------

fn thousands(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn tick(s: &str) -> String {
    format!("`{s}`")
}

fn ticks<'a>(items: impl IntoIterator<Item = &'a str>) -> String {
    items.into_iter().map(tick).collect::<Vec<_>>().join("、")
}

/// 一张表。`right` 是右对齐的列。单元格里的竖线转义，免得把表切开。
fn table(head: &[&str], right: &[usize], rows: &[Vec<String>]) -> String {
    let line = |cells: Vec<String>| format!("| {} |\n", cells.join(" | "));
    let mut out = line(head.iter().map(|h| h.to_string()).collect());
    out.push_str(&line(
        (0..head.len())
            .map(|i| if right.contains(&i) { "---:" } else { "---" }.to_owned())
            .collect(),
    ));
    for r in rows {
        assert_eq!(r.len(), head.len(), "{head:?} {r:?}");
        out.push_str(&line(r.iter().map(|c| c.replace('|', "\\|")).collect()));
    }
    out
}

/// 每张表每一行的竖线数一致。单元格里的竖线没转义会把那一行切成更多列，页面上整张表散架，
/// 而逐字节对照照样全绿：它比的是两边一样，不是比出来的东西还算不算一张表。
fn table_problems(what: &str, text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut columns: Option<usize> = None;
    for (i, line) in text.lines().enumerate() {
        if !line.starts_with('|') {
            columns = None;
            continue;
        }
        let n = line.replace("\\|", "").matches('|').count();
        match columns {
            None => columns = Some(n),
            Some(c) if c != n => out.push(format!(
                "{what}:{}: 这一行有 {n} 个列分隔符，表头有 {c} 个",
                i + 1
            )),
            Some(_) => {}
        }
    }
    out
}

/// 成对标记之间的一段。内容整段放在 prettier-ignore 里，`pnpm format` 不会改动生成结果。
fn marked(name: &str, body: &str) -> String {
    format!(
        "<!-- {name}:BEGIN -->\n\n<!-- prettier-ignore-start -->\n\n{}\n\n<!-- prettier-ignore-end -->\n\n<!-- {name}:END -->",
        body.trim_end()
    )
}

/// 生成页：标题、来源说明，然后各段。
fn page(title: &str, source: &str, sections: &[String]) -> String {
    format!(
        "# {title}\n\n> 由 {source}生成，不要手改。重新生成：`{REGENERATE}`。\n\n{}\n",
        sections.join("\n\n")
    )
}

/// 把 `text` 里每一对标记之间的内容换成生成结果。标记缺失或不成对就报错，不悄悄跳过。
fn splice(path: &str, text: &str, sections: &[(&str, &str)]) -> Result<String, String> {
    let mut out = text.to_owned();
    for (name, body) in sections {
        let begin = format!("<!-- {name}:BEGIN -->");
        let end = format!("<!-- {name}:END -->");
        let (Some(a), Some(b)) = (out.find(&begin), out.find(&end)) else {
            return Err(format!("{path}: 缺少 {begin} / {end}"));
        };
        if b < a || out.matches(&begin).count() != 1 || out.matches(&end).count() != 1 {
            return Err(format!("{path}: {name} 的标记不成对"));
        }
        out = format!(
            "{}{}{}",
            &out[..a],
            marked(name, body),
            &out[b + end.len()..]
        );
    }
    Ok(out)
}

// ---- MCP 工具契约 ---------------------------------------------------------------------------

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn hidden_names(p: &Profile) -> Vec<&'static str> {
    p.hidden.iter().map(|t| t.name).collect()
}

fn contracts() -> String {
    let mut out = format!(
        "# MCP 工具契约\n\n> 由 `atm-http` 的工具表（`tools::PROFILES`）生成，不要手改。重新生成：`{REGENERATE}`。\n\n"
    );
    out.push_str(&format!("- Surface：`{SURFACE_VERSION}`\n"));
    out.push_str(&format!(
        "- MCP 协议版本（新的在前；客户端要的不在表里时回最新的）：{}\n",
        ticks(PROTOCOL_VERSIONS.iter().copied())
    ));
    out.push_str(
        "- 字节数是 `tools/list` 结果里 `tools` 数组的 JSON 字节数，不含外壳与 JSON-RPC 信封。\n",
    );
    out.push_str("- 工具的 schema hash 是 `inputSchema` JSON 的 SHA-256 前 16 位，与 `tools/list` 里的 `_meta.schema_hash` 相同；profile 的 SHA-256 取整个 `tools` 数组。\n");
    out.push_str("- 「只收不发布」的工具不出现在 `tools/list` 里，`tools/call` 照常可用。\n\n");

    out.push_str("## Profile\n\n");
    let rows: Vec<Vec<String>> = PROFILES
        .iter()
        .map(|p| {
            let bytes = p.bytes();
            let json = serde_json::to_vec(&p.tools_json()).unwrap();
            vec![
                tick(p.name),
                p.tools.len().to_string(),
                p.hidden.len().to_string(),
                thousands(bytes),
                thousands(p.budget),
                thousands(p.budget.saturating_sub(bytes)),
                tick(&sha256(&json)),
            ]
        })
        .collect();
    out.push_str(&table(
        &[
            "Profile",
            "发布",
            "只收不发布",
            "字节",
            "预算",
            "余量",
            "tools SHA-256",
        ],
        &[1, 2, 3, 4, 5],
        &rows,
    ));

    out.push_str("\n## instructions\n");
    for p in &PROFILES {
        out.push_str(&format!("\n### `{}`\n\n> {}\n", p.name, p.instructions));
    }

    out.push_str("\n## 工具\n\n");
    let mut rows = Vec::new();
    for p in &PROFILES {
        for t in p.tools_json() {
            rows.push(vec![
                tick(p.name),
                tick(t["name"].as_str().unwrap()),
                t["annotations"]["readOnlyHint"].to_string(),
                t["annotations"]["destructiveHint"].to_string(),
                tick(t["_meta"]["schema_hash"].as_str().unwrap()),
            ]);
        }
    }
    out.push_str(&table(
        &["Profile", "工具", "只读", "destructive", "schema hash"],
        &[],
        &rows,
    ));
    out.push_str("\n只收不发布：\n\n");
    let rows: Vec<Vec<String>> = PROFILES
        .iter()
        .map(|p| vec![tick(p.name), ticks(hidden_names(p))])
        .collect();
    out.push_str(&table(&["Profile", "工具"], &[], &rows));

    out.push_str("\n## 工具说明\n\n> 与 `tools/list` 里的 `description` 逐字相同。\n");
    let mut seen = BTreeSet::new();
    for p in &PROFILES {
        for t in p.tools.iter().chain(p.hidden) {
            if seen.insert(t.name) {
                let published = PROFILES
                    .iter()
                    .any(|q| q.tools.iter().any(|x| x.name == t.name));
                let mark = if published {
                    ""
                } else {
                    "（只收不发布）"
                };
                out.push_str(&format!(
                    "\n### `{}`{mark}\n\n{}\n",
                    t.name,
                    t.description()
                ));
            }
        }
    }
    out
}

fn tool_stats() -> String {
    let published: BTreeSet<&str> = PROFILES
        .iter()
        .flat_map(|p| p.tools.iter().map(|t| t.name))
        .collect();
    let old: Vec<&str> = {
        let mut seen = BTreeSet::new();
        PROFILES
            .iter()
            .flat_map(|p| p.hidden.iter().map(|t| t.name))
            .filter(|n| !published.contains(n) && seen.insert(*n))
            .collect()
    };
    let mut out = format!(
        "### MCP 工具面统计（生成）\n\n> 由 `atm-http` 的工具表生成，逐项含义见 [docs/generated/mcp-tool-contracts.md](docs/generated/mcp-tool-contracts.md)。重新生成：`{REGENERATE}`。\n\n"
    );
    out.push_str(&table(
        &["指标", "当前值"],
        &[1],
        &[
            vec!["MCP surface".into(), SURFACE_VERSION.into()],
            vec!["Profile 数".into(), PROFILES.len().to_string()],
            vec!["发布的工具（去重）".into(), published.len().to_string()],
            vec![
                format!("只收不发布的旧名（{}）", ticks(old.iter().copied())),
                old.len().to_string(),
            ],
        ],
    ));
    out.push('\n');
    let rows: Vec<Vec<String>> = PROFILES
        .iter()
        .map(|p| {
            let bytes = p.bytes();
            vec![
                p.name.into(),
                p.tools.len().to_string(),
                format!("{} bytes", thousands(bytes)),
                format!("{} bytes", thousands(p.budget)),
                format!("{} bytes", thousands(p.budget.saturating_sub(bytes))),
            ]
        })
        .collect();
    out.push_str(&table(
        &["Profile", "工具数", "tools 字节", "预算", "余量"],
        &[1, 2, 3, 4],
        &rows,
    ));
    out
}

// ---- 状态机与 task_patch -----------------------------------------------------------------------

fn statuses(list: &[Status]) -> String {
    ticks(list.iter().map(|s| s.as_str()))
}

fn work_item_operations() -> String {
    let mut out = String::from(
        "### 状态与操作（自动生成）\n\n> 由 `atm_domain::work` 的状态机生成。这里只有状态机这一层；依赖、领取、完成门等前置条件另行判定，被拒时照错误里的 `fix` 执行。\n\n",
    );
    let rows: Vec<Vec<String>> = Status::ALL
        .iter()
        .map(|&s| {
            let ops = work::legal_operations(WorkState::from_status(s));
            let cells: Vec<String> = ops
                .iter()
                .map(|(op, to)| format!("`{op}` → `{to}`"))
                .collect();
            vec![tick(s.as_str()), cells.join("、")]
        })
        .collect();
    out.push_str(&table(&["状态", "可用操作 → 之后的状态"], &[], &rows));

    // 操作表放行、但上表没列的组合：目前只有 IN_PROGRESS 上的 claim。出现别的组合时这段说明要跟着改。
    let unlisted: Vec<(Operation, Status)> = Operation::ALL
        .iter()
        .flat_map(|&op| op.allowed_from().iter().map(move |&s| (op, s)))
        .filter(|&(op, s)| {
            !work::legal_operations(WorkState::from_status(s))
                .iter()
                .any(|(o, _)| *o == op)
        })
        .collect();
    assert_eq!(
        unlisted,
        [(Operation::Claim, Status::InProgress)],
        "状态机多了只在特定条件下成立的组合，更新这段说明"
    );
    out.push_str(
        "\n`IN_PROGRESS` 上的 `claim` 只在同一条会话链的后继会话接回领取时成立，上表没有列出。\n\n",
    );

    let rows: Vec<Vec<String>> = Operation::ALL
        .iter()
        .map(|&op| {
            vec![
                tick(op.as_str()),
                statuses(op.allowed_from()),
                if op.guarded_by_claim() { "是" } else { "否" }.into(),
            ]
        })
        .collect();
    out.push_str(&table(
        &["操作", "可以从这些状态发起", "任务被别人领取时拒绝"],
        &[],
        &rows,
    ));
    out.push_str("\n`claim`、`start`、`release` 本身就是领取规则：能不能接手由领取是否过期、是否同一条会话链决定。\n\n");

    // 自动补 start。
    out.push_str("#### 自动补 start\n\n下列写入遇到还没开工的任务时，在同一事务里先 `start` 再执行（调用方能领取时）；");
    out.push_str("遇到 `BLOCKED` / `WAITING_*` 不补（`start` 会解除阻塞），被拒时 `fix` 就是那条 `start`。\n\n");
    let open: Vec<Status> = Status::ALL
        .iter()
        .copied()
        .filter(|s| !s.is_terminal())
        .collect();
    let writes: Vec<(String, StateWrite)> = Operation::ALL
        .iter()
        .map(|&op| (op.as_str().to_owned(), StateWrite::Basic(op)))
        .chain([
            (
                "verify_and_complete".to_owned(),
                StateWrite::VerifyAndComplete,
            ),
            (
                "atm_progress_add（任务进度）".to_owned(),
                StateWrite::Progress,
            ),
        ])
        .filter(|(_, w)| {
            open.iter()
                .any(|&s| work::auto_start(*w, s) != AutoStart::NotApplicable)
        })
        .collect();
    let rows: Vec<Vec<String>> = writes
        .iter()
        .map(|(name, w)| {
            let mut row = vec![tick(name)];
            row.extend(open.iter().map(|&s| {
                match work::auto_start(*w, s) {
                    AutoStart::Apply => "先 start",
                    AutoStart::SuggestStart => "拒绝，fix 给 start",
                    AutoStart::NotApplicable => "—",
                }
                .to_owned()
            }));
            row
        })
        .collect();
    let mut head = vec!["写入".to_owned()];
    head.extend(open.iter().map(|s| tick(s.as_str())));
    let head: Vec<&str> = head.iter().map(String::as_str).collect();
    out.push_str(&table(&head, &[], &rows));
    out.push_str("\n「—」：不涉及自动 start，按上面的状态表处理。\n\n");
    out.push_str(
        "任务进度的 start 是尽力而为：前置没完成或领不到时不补、不报错，进度照记，任务保持原状态；",
    );
    out.push_str(
        "带 `blocker` 时补上 start 再阻塞，补不上就按原状态判定（`READY` 上不能阻塞）。\n\n",
    );

    // expected_version。
    out.push_str("#### 什么时候要带 `expected_version`\n\n");
    let kinds: Vec<(String, PatchKind)> = Operation::ALL
        .iter()
        .map(|&op| (tick(op.as_str()), PatchKind::Basic(op)))
        .chain([
            (tick("verify_and_complete"), PatchKind::VerifyAndComplete),
            ("`checklist`（1 条）".to_owned(), PatchKind::ChecklistSingle),
            ("`checklist`（多条）".to_owned(), PatchKind::ChecklistBatch),
            (tick("review_request"), PatchKind::ReviewRequest),
            (tick("review_submit"), PatchKind::ReviewSubmit),
        ])
        .collect();
    let need = |n: VersionNeed| match n {
        VersionNeed::Required => "必填",
        VersionNeed::Optional => "可省略",
    };
    let rows: Vec<Vec<String>> = kinds
        .iter()
        .map(|(name, k)| {
            vec![
                name.clone(),
                need(work::version_need(*k, true)).into(),
                need(work::version_need(*k, false)).into(),
            ]
        })
        .collect();
    out.push_str(&table(
        &["写入", "本会话链持有领取", "没有持有（别人的任务、未领取）"],
        &[],
        &rows,
    ));
    out.push_str("\n「持有领取」以执行那一刻为准，包括这次 `claim` / `start` / 自动 start 刚拿到的领取。版本号用上一次回执里的 `entities[].version`，不要自己加一。\n");
    out
}

fn task_patch_operations() -> String {
    let field = |name: &str| {
        tools::TASK_PATCH
            .fields
            .iter()
            .find(|f| f.name == name)
            .unwrap_or_else(|| panic!("task_patch 没有字段 {name}"))
    };
    let mut out = String::from(
        "### task_patch 的操作与字段（自动生成）\n\n> 由 `atm-http` 的 task_patch 映射生成（`write::COMMON`、`write::operation_fields`、`write::COMPOSITE`）。\n\n",
    );
    out.push_str("单条直接把字段写在顶层：`{task_key, operation, …}`；多条放进 `items`，每条同形，两种写法不能混用。");
    out.push_str(&format!(
        "每条都能写的字段：{}。\n\n",
        ticks(COMMON.iter().copied())
    ));
    let rows: Vec<Vec<String>> = tools::OPERATIONS
        .iter()
        .map(|&op| {
            let (extra, required) = operation_fields(op);
            let fields: Vec<String> = extra
                .iter()
                .filter(|n| !field(n).hidden)
                .map(|n| {
                    if required.contains(n) {
                        format!("**`{n}`**")
                    } else {
                        tick(n)
                    }
                })
                .collect();
            vec![
                tick(op),
                if fields.is_empty() {
                    "—".to_owned()
                } else {
                    fields.join("、")
                },
                if COMPOSITE.contains(&op) { "是" } else { "" }.into(),
            ]
        })
        .collect();
    out.push_str(&table(
        &["operation", "额外字段（粗体必填）", "只能单条"],
        &[],
        &rows,
    ));
    let old: Vec<&str> = COMPOSITE
        .iter()
        .copied()
        .filter(|op| !tools::OPERATIONS.contains(op))
        .collect();
    out.push_str(&format!(
        "\n只能单条的操作不放进多条的 `items`，也不收 `takeover_stale`。旧名 {} 照收，等同于 `checklist`（按条数分派）。\n",
        ticks(old.iter().copied())
    ));
    out
}

// ---- 写入回执 ----------------------------------------------------------------------------------

/// 回执的固定字段：每次写入都有。
const ACK_FIXED: &[(&str, &str)] = &[
    (
        "ok",
        "恒为 `true`。写入失败时返回的是错误信封（见下一节），不是 `ok:false` 的回执。",
    ),
    (
        "op_id",
        "这次写入的幂等键。省略时由 ATM 生成；同一写入要自己重试时，带上这个值，结果是重放而不是再执行一次。",
    ),
    ("project", "规范化后的项目代码。"),
    (
        "session",
        "回执所属的会话：会话被接续时是后继会话，重放时是当初写下回执的那个会话。",
    ),
    (
        "session_rebound",
        "原会话已经失效、ATM 把这次写入接到了同一条会话链的后继会话上时为 `true`。",
    ),
    (
        "replayed",
        "同一 `op_id` 的重放：这次没有再执行，返回的是当初的结果。",
    ),
    (
        "entities",
        "受影响实体的有界预览。每项有 `entity_type`、`key`、`version`；任务还有 `status`、`waiting_on`、`claimed_by_session_id`、`claim_lease_until`。版本是这次写入之后的版本，下一次写同一实体直接用它，不要自己加一。",
    ),
    ("entity_count", "受影响实体的总数，不受预览截断影响。"),
    (
        "entities_truncated",
        "预览被截断时为 `true`；这时原样执行 `details_cursor` 取全部实体。",
    ),
    (
        "details_cursor",
        "可以原样执行的 `atm_search` 调用，回查这次写入的全部实体。",
    ),
];

/// 只在特定写入里出现的字段。
const ACK_EXTRA: &[(&str, &str)] = &[
    (
        "normalized",
        "参数里用了别名或非规范写法时出现：`[{from, to}]`，说明改成了哪个规范名。下次直接用规范名。",
    ),
    (
        "auto_applied",
        "自动补了 `start` 时出现：`[{task_key, operations}]`。",
    ),
    (
        "refs",
        "`atm_task_create`：本批序号（`\"1\"` 起）与 `client_ref` 到任务 key 的对照。",
    ),
    (
        "checklist",
        "`atm_task_create`：每个新任务的检查项 id，按任务 key 分组。",
    ),
    (
        "adjusted",
        "服务端调整了参数时出现，例如 summary 太长被截断、全文移到 detail：`[{field, action, moved_to}]`。",
    ),
    (
        "deprecations",
        "用了仍然照收的旧写法时出现，说明该换成什么。",
    ),
    (
        "merges",
        "`edit` 带 `expected_fields` 时，与并发修改安全合并的字段。",
    ),
];

/// 不靠一次简单调用就能触发的字段（有各自的专门用例），不要求在样本里出现。
const ACK_UNSAMPLED: &[&str] = &["merges"];

const ENTITY_FIELDS: &[&str] = &[
    "entity_type",
    "key",
    "version",
    "status",
    "waiting_on",
    "claimed_by_session_id",
    "claim_lease_until",
];

fn ok(r: &Value) -> Value {
    assert_ne!(r["isError"], json!(true), "{r}");
    r["structuredContent"].clone()
}

fn failed(r: &Value) -> Value {
    assert_eq!(r["isError"], json!(true), "{r}");
    r["structuredContent"].clone()
}

/// 把会话 id、领取租约这类每次都不同的值换成占位符。
fn placeholders(w: &World, v: &Value) -> String {
    let mut text = serde_json::to_string_pretty(v).unwrap();
    text = text.replace(&w.session, "<session>");
    for lease in collect_strings(v, "claim_lease_until") {
        text = text.replace(&lease, "<lease>");
    }
    text
}

fn collect_strings(v: &Value, key: &str) -> Vec<String> {
    let mut out = Vec::new();
    match v {
        Value::Object(m) => {
            for (k, x) in m {
                if k == key
                    && let Some(s) = x.as_str()
                {
                    out.push(s.to_owned());
                }
                out.extend(collect_strings(x, key));
            }
        }
        Value::Array(a) => a.iter().for_each(|x| out.extend(collect_strings(x, key))),
        _ => {}
    }
    out
}

fn keys(v: &Value) -> BTreeSet<String> {
    v.as_object().unwrap().keys().cloned().collect()
}

fn mutation_ack(w: &World) -> String {
    // 样本：别名 + 自动 start（normalized、auto_applied）；建任务（refs、checklist）；长 summary（adjusted）；
    // 旧的 checklist_single（deprecations）。
    let created = ok(&call(
        w,
        "core",
        "atm_task_create",
        json!({"session": w.session, "items": [{"title": "样本", "checklist": [{"title": "第一步"}]}]}),
    ));
    let key = created["refs"]["1"].as_str().unwrap().to_owned();
    let item = created["checklist"][&key][0].as_str().unwrap().to_owned();
    let example = ok(&call(
        w,
        "core",
        "atm_task_patch",
        json!({"project": w.project, "session": w.session, "key": w.task, "operation": "verify", "op_id": "op-example"}),
    ));
    let adjusted = ok(&call(
        w,
        "core",
        "atm_record",
        json!({"session": w.session, "kind": "FACT", "title": "样本", "summary": "很长的一句话。".repeat(60)}),
    ));
    let deprecated = ok(&call(
        w,
        "core",
        "atm_task_patch",
        json!({"session": w.session, "task_key": key, "operation": "checklist_single",
               "checklist_id": item, "status": "DONE", "expected_version": 0}),
    ));
    let progress = ok(&call(
        w,
        "core",
        "atm_progress_add",
        json!({"session": w.session, "task_key": w.task, "summary": "样本"}),
    ));
    let samples = [&created, &example, &adjusted, &deprecated, &progress];

    let fixed: BTreeSet<String> = ACK_FIXED.iter().map(|(k, _)| k.to_string()).collect();
    let extra: BTreeSet<String> = ACK_EXTRA.iter().map(|(k, _)| k.to_string()).collect();
    let mut seen = BTreeSet::new();
    for s in samples {
        let k = keys(s);
        assert!(fixed.is_subset(&k), "回执少了固定字段：{s}");
        let stray: Vec<&String> = k
            .difference(&fixed)
            .filter(|x| !extra.contains(*x))
            .collect();
        assert!(stray.is_empty(), "回执里有字段表没写的字段 {stray:?}：{s}");
        seen.extend(k);
    }
    for (k, _) in ACK_EXTRA {
        if !ACK_UNSAMPLED.contains(k) {
            assert!(seen.contains(*k), "字段表里的 {k} 在样本里一次都没出现");
        }
    }
    let entity: BTreeSet<String> = example["entities"][0]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    let documented: BTreeSet<String> = ENTITY_FIELDS.iter().map(|s| s.to_string()).collect();
    assert_eq!(entity, documented, "任务实体的字段变了：{example}");

    let mut out = String::from("### 写入回执（自动生成）\n\n");
    out.push_str("`atm_task_create`、`atm_task_patch`、`atm_progress_add`、`atm_record`、`atm_end` 等项目写入都返回同一形状的回执；");
    out.push_str("`atm_knowledge_save` 写的是共享知识库，回执另有形状，不适用本节。\n\n");
    let rows: Vec<Vec<String>> = ACK_FIXED
        .iter()
        .map(|(k, d)| vec![tick(k), "总有".into(), (*d).into()])
        .chain(
            ACK_EXTRA
                .iter()
                .map(|(k, d)| vec![tick(k), "按需".into(), (*d).into()]),
        )
        .collect();
    out.push_str(&table(&["字段", "出现", "含义"], &[], &rows));
    out.push_str("\n下例是一次真实的 `atm_task_patch` 回执：用了别名 `key`，任务还没开工所以先自动 `start` 再 `verify`。会话 id 与租约时间换成了占位符。\n\n");
    out.push_str(&format!("```json\n{}\n```\n", placeholders(w, &example)));
    out
}

// ---- 错误信封 ----------------------------------------------------------------------------------

/// 信封的字段表。用解构写死字段：`Envelope` 加了字段，这里编译不过。
fn envelope_fields() -> Vec<(&'static str, &'static str, &'static str)> {
    let probe = Envelope::new(
        atm_domain::error::DomainError::new(ErrorCode::NOT_FOUND, ""),
        Committed::No,
        None,
        Fix::None,
    );
    let Envelope {
        ok: _,
        code: _,
        message: _,
        retryable: _,
        committed: _,
        state: _,
        fix: _,
        problems: _,
        details: _,
    } = probe;
    vec![
        ("ok", "总有", "恒为 `false`。"),
        (
            "code",
            "总有",
            "错误码，全表见 `docs/generated/error-codes.md`。",
        ),
        ("message", "总有", "给人看的说明。"),
        (
            "retryable",
            "总有",
            "原样重试同一调用有没有可能成功（等待后）。",
        ),
        (
            "committed",
            "总有",
            "这次写入有没有落库：`false` 没有，`true` 已经落库（不要重试，按 fix 往下走），`\"unknown\"` 不确定（按 fix 原样重试，同一 `op_id` 会得到重放）。",
        ),
        (
            "fix",
            "总有",
            "下一步怎么做，`kind` 见下表。带 `call` 的可以原样执行：参数已经补齐并通过 schema。",
        ),
        (
            "problems",
            "参数错误",
            "`INVALID_ARGUMENT` 的逐项问题：`path`、`problem`，以及按需的 `got`、`allowed`、`did_you_mean`。",
        ),
        (
            "state",
            "按需",
            "与错误有关的当前状态（例如任务现在的状态与版本），先读再决定时不必再查一次。",
        ),
        ("details", "按需", "其余结构化细节。"),
    ]
}

fn fix_kind_text(k: FixKind) -> &'static str {
    match k {
        FixKind::Call => "执行 `fix.call`：改正后的同一调用，或者先做的那一步（例如 `start`）。",
        FixKind::Reread => "先执行 `fix.call` 读一次当前状态，再决定下一步。",
        FixKind::AskUser => "把 `fix.message` 转告用户，由用户处理。",
        FixKind::Wait => "等 `fix.retry_after_ms` 毫秒后重试；有 `fix.call` 时执行它。",
        FixKind::AddParam => {
            "补上 `fix.param` 再调 `fix.tool`（例如带上 `atm_begin` 返回的 session）。"
        }
        FixKind::None => "内部错误，或者 Agent 碰不到的错误；不要重试，告诉用户。",
    }
}

const FIX_KINDS: &[FixKind] = &[
    FixKind::Call,
    FixKind::Reread,
    FixKind::AskUser,
    FixKind::Wait,
    FixKind::AddParam,
    FixKind::None,
];

fn kind_name(k: FixKind) -> String {
    serde_json::to_value(k)
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned()
}

fn error_envelope(w: &World) -> String {
    for code in ErrorCode::ALL {
        assert!(
            FIX_KINDS.contains(&code.fix_kind()),
            "{code} 的 fix 种类不在表里"
        );
    }
    // 样本：写错 operation（INVALID_ARGUMENT，fix.call 是改正后的调用）；版本不对（VERSION_CONFLICT）；
    // 没有这个任务（WORK_ITEM_NOT_FOUND）。
    let typo = failed(&call(
        w,
        "core",
        "atm_task_patch",
        json!({"project": w.project, "session": w.session, "task_key": w.task, "operation": "complet", "op_id": "op-typo"}),
    ));
    let conflict = failed(&call(
        w,
        "core",
        "atm_task_patch",
        json!({"session": w.session, "task_key": w.task, "operation": "edit", "title": "改名", "expected_version": 99}),
    ));
    let missing = failed(&call(
        w,
        "core",
        "atm_task_get",
        json!({"project": w.project, "task_key": format!("{}-T-9999", w.project)}),
    ));
    let fields = envelope_fields();
    let documented: BTreeSet<String> = fields.iter().map(|(k, ..)| k.to_string()).collect();
    let mut seen = BTreeSet::new();
    for s in [&typo, &conflict, &missing] {
        let k = keys(s);
        let stray: Vec<&String> = k.difference(&documented).collect();
        assert!(stray.is_empty(), "信封里有字段表没写的字段 {stray:?}：{s}");
        seen.extend(k);
    }
    for (k, ..) in &fields {
        assert!(seen.contains(*k), "字段表里的 {k} 在样本里一次都没出现");
    }

    let mut out = String::from("### 错误信封（自动生成）\n\n");
    out.push_str("工具调用出错时 `isError: true`，`structuredContent` 是下面的信封。照 `fix` 执行就是下一步，不需要读文档。\n\n");
    let rows: Vec<Vec<String>> = fields
        .iter()
        .map(|(k, when, d)| vec![tick(k), (*when).into(), (*d).into()])
        .collect();
    out.push_str(&table(&["字段", "出现", "含义"], &[], &rows));
    out.push('\n');
    let rows: Vec<Vec<String>> = FIX_KINDS
        .iter()
        .map(|&k| vec![tick(&kind_name(k)), fix_kind_text(k).into()])
        .collect();
    out.push_str(&table(&["`fix.kind`", "怎么做"], &[], &rows));
    out.push_str("\n下例是一次真实的出错调用：`operation` 写成了 `complet`。`fix.call` 是改正后的完整调用，可以原样执行。会话 id 换成了占位符。\n\n");
    out.push_str(&format!("```json\n{}\n```\n", placeholders(w, &typo)));
    out
}

fn error_codes() -> String {
    let row = |c: &ErrorCode| {
        vec![
            tick(c.as_str()),
            c.http_status().to_string(),
            if c.retryable() { "是" } else { "" }.into(),
            tick(&kind_name(c.fix_kind())),
        ]
    };
    let reachable: Vec<Vec<String>> = ErrorCode::ALL
        .iter()
        .filter(|c| c.fix_kind() != FixKind::None)
        .map(row)
        .collect();
    let internal: Vec<String> = ErrorCode::ALL
        .iter()
        .filter(|c| c.fix_kind() == FixKind::None)
        .map(|c| tick(c.as_str()))
        .collect();
    let mut out = String::from("## 错误码\n\n");
    out.push_str("每个错误码默认的 `fix.kind`；具体一次错误里的 `fix` 以信封为准（同一个码在不同场合可能给出更具体的出路）。\n\n");
    out.push_str(&table(
        &["code", "HTTP", "可重试", "默认 fix"],
        &[1],
        &reachable,
    ));
    out.push_str(&format!(
        "\n内部错误与 Agent 碰不到的码（`fix.kind` 为 `none`）：{}。\n",
        internal.join("、")
    ));
    out
}

// ---- 用例 --------------------------------------------------------------------------------------

#[test]
fn generated_docs_match_the_code() {
    let w = world("docs");
    let ops = work_item_operations();
    let patch = task_patch_operations();
    let ack = mutation_ack(&w);
    let envelope = error_envelope(&w);
    let stats = tool_stats();

    let pages: Vec<(&str, String)> = vec![
        ("docs/generated/mcp-tool-contracts.md", contracts()),
        (
            "docs/generated/work-item-operations.md",
            page(
                "任务状态与操作",
                "`atm_domain::work` 与 `atm-http` 的 task_patch 映射",
                &[
                    marked(WORK_ITEM_OPERATIONS, &ops),
                    marked(TASK_PATCH_COMPOSITE, &patch),
                ],
            ),
        ),
        (
            "docs/generated/mutation-acknowledgement.md",
            page(
                "写入回执",
                "`atm-http` 的写入回执（对照真实调用）",
                &[marked(MUTATION_ACK_CONTRACT, &ack)],
            ),
        ),
        (
            "docs/generated/error-codes.md",
            page(
                "错误信封与错误码",
                "`atm_domain::error` 的错误码表与真实出错调用",
                &[marked(ERROR_ENVELOPE, &envelope), error_codes()],
            ),
        ),
    ];
    let spliced: Vec<(&str, Vec<(&str, &str)>)> = vec![
        (
            "ATM_AGENT_GUIDE.md",
            vec![
                (WORK_ITEM_OPERATIONS, ops.as_str()),
                (TASK_PATCH_COMPOSITE, patch.as_str()),
                (MUTATION_ACK_CONTRACT, ack.as_str()),
                (ERROR_ENVELOPE, envelope.as_str()),
            ],
        ),
        (
            "docs/agent-integration.md",
            vec![(MUTATION_ACK_CONTRACT, ack.as_str())],
        ),
        ("README.md", vec![(MCP_TOOL_STATS, stats.as_str())]),
    ];

    let mut problems = Vec::new();
    for (rel, text) in &pages {
        problems.extend(table_problems(rel, text));
    }
    for (name, body) in [
        (WORK_ITEM_OPERATIONS, &ops),
        (TASK_PATCH_COMPOSITE, &patch),
        (MUTATION_ACK_CONTRACT, &ack),
        (ERROR_ENVELOPE, &envelope),
        (MCP_TOOL_STATS, &stats),
    ] {
        problems.extend(table_problems(name, body));
    }

    let bless = std::env::var_os(BLESS).is_some();
    let check = |rel: &str, expected: String| -> Option<String> {
        let path = root().join(rel);
        let current = std::fs::read_to_string(&path).unwrap_or_default();
        if current == expected {
            return None;
        }
        if bless {
            std::fs::write(&path, expected).unwrap();
            return None;
        }
        Some(format!("{rel}: 与生成结果不一致（{REGENERATE}）"))
    };
    for (rel, text) in pages {
        problems.extend(check(rel, text));
    }
    for (rel, sections) in spliced {
        let current = std::fs::read_to_string(root().join(rel)).unwrap();
        match splice(rel, &current, &sections) {
            Ok(text) => problems.extend(check(rel, text)),
            Err(e) => problems.push(e),
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

/// 单元格里的竖线会被转义；没转义的竖线会被列数检查抓到（阳性对照）。
#[test]
fn table_cells_escape_pipes_and_the_column_check_sees_a_broken_row() {
    let t = table(&["a", "b"], &[], &[vec!["x|y".into(), "z".into()]]);
    assert!(t.contains("x\\|y"), "{t}");
    assert!(table_problems("t", &t).is_empty(), "{t}");
    let broken = "| a | b |\n| --- | --- |\n| x|y | z |\n";
    assert_eq!(table_problems("t", broken).len(), 1);
    // 两张表之间隔着正文时各算各的。
    let two = "| a | b |\n| --- | --- |\n\n| a | b | c |\n| --- | --- | --- |\n";
    assert!(table_problems("t", two).is_empty());
}

/// 标记缺失或重复时报错，不悄悄跳过（阳性对照：拿掉 END 就红）。
#[test]
fn splice_refuses_missing_or_repeated_markers() {
    let ok_text = "前\n<!-- X:BEGIN -->\n旧\n<!-- X:END -->\n后\n";
    let done = splice("t.md", ok_text, &[("X", "新")]).unwrap();
    assert!(
        done.contains("新") && !done.contains("旧") && done.ends_with("后\n"),
        "{done}"
    );
    assert_eq!(
        splice("t.md", &done, &[("X", "新")]).unwrap(),
        done,
        "重写一次不再变化"
    );
    assert!(splice("t.md", "<!-- X:BEGIN -->\n", &[("X", "新")]).is_err());
    assert!(
        splice(
            "t.md",
            "<!-- X:BEGIN -->\n<!-- X:END -->\n<!-- X:BEGIN -->\n<!-- X:END -->\n",
            &[("X", "新")]
        )
        .is_err()
    );
    assert!(splice("t.md", "<!-- X:END -->\n<!-- X:BEGIN -->\n", &[("X", "新")]).is_err());
}
