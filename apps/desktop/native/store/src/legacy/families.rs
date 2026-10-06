//! 显式对象族清单（05 §1、§3、§5.2；W3b1）。
//!
//! 2.0 数据根里的每一张表、每一类文件都恰好归一个族。编号沿用 05 §5.2：R1–R12、K1–K5、P1–P11、F1–F7；
//! §5.2「显式排除」表的各行编为 X1–X12（05 没有给编号，按表格顺序）。同一编号可以有多个族（P3 是十四张表）。
//!
//! 转换报告（`report.json`）按这张表逐族输出；VERIFY 结束时，每个转换、重建或登记的族都必须至少有一项
//! 检查跑过，否则报覆盖缺口。尚未实现的族（sync / dispatch 归 W3b5，进行中的文件事务归 W3b6）标 `pending`，
//! 不算失败，但 W3d 的提交门要求 `pending` 为空。

/// 05 §3.4 的 `decision`。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    /// 逐行 / 逐文件转换进新库。
    Converted,
    /// 派生数据，在新库里重建；用查询等价校验。
    Rebuilt,
    /// 不进新库。理由写在 `drop_reason`。
    Dropped,
    /// 不复制，只登记引用（X 类资产）。
    Referenced,
}

impl Decision {
    pub fn as_str(self) -> &'static str {
        match self {
            Decision::Converted => "CONVERTED",
            Decision::Rebuilt => "REBUILT",
            Decision::Dropped => "DROPPED",
            Decision::Referenced => "REFERENCED",
        }
    }
}

/// 族所在的源：三类 DB，或数据根 / 项目目录里的文件。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Home {
    Registry,
    Knowledge,
    Project,
    /// `<L>\projects\<id>\` 下的文件（manifest、附件目录）。
    ProjectDir,
    /// 数据根下的其余文件与目录。
    Root,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FamilySpec {
    /// 05 §5.2 的编号。
    pub code: &'static str,
    /// 族名，在同一 `home` 里唯一；DB 族就是主源表名。报告里的族实例名是 `<范围>/<name>`。
    pub name: &'static str,
    pub home: Home,
    /// 相对数据根的路径类别（`/` 分隔，`<id>` 指项目 id）。
    pub path_class: &'static str,
    /// DB 族：主源表在前，FTS 的影子表由 `FTS_SHADOWS` 隐含。文件族：路径模式。
    pub sources: &'static [&'static str],
    pub decision: Decision,
    /// 目标表或目录；DROPPED 为空。
    pub target: &'static str,
    pub drop_reason: Option<&'static str>,
    /// 是否纳入 `business_digest`（05 §5.2 的「纳入」列）。
    pub business_digest: bool,
    /// 尚未实现时，负责的任务（W3b5、W3b6）。数据根下的文件族另有前提：转换要按数据根输入
    /// （[`super::LegacySources::from_root`]），否则这些族都算未覆盖（[`super::Report::pending`]）。
    pub pending: Option<&'static str>,
}

const REGISTRY_DB: &str = "registry/registry.sqlite";
const KNOWLEDGE_DB: &str = "knowledge/knowledge.sqlite";
const PROJECT_DB: &str = "projects/<id>/project.sqlite";

const fn db(
    code: &'static str,
    home: Home,
    sources: &'static [&'static str],
    decision: Decision,
    target: &'static str,
    drop_reason: Option<&'static str>,
    business_digest: bool,
) -> FamilySpec {
    FamilySpec {
        code,
        name: sources[0],
        home,
        path_class: match home {
            Home::Registry => REGISTRY_DB,
            Home::Knowledge => KNOWLEDGE_DB,
            _ => PROJECT_DB,
        },
        sources,
        decision,
        target,
        drop_reason,
        business_digest,
        pending: None,
    }
}

const fn converted(
    code: &'static str,
    home: Home,
    table: &'static [&'static str],
    target: &'static str,
) -> FamilySpec {
    db(code, home, table, Decision::Converted, target, None, true)
}

#[allow(clippy::too_many_arguments)]
const fn file(
    code: &'static str,
    name: &'static str,
    home: Home,
    path_class: &'static str,
    sources: &'static [&'static str],
    decision: Decision,
    target: &'static str,
    drop_reason: Option<&'static str>,
    business_digest: bool,
    pending: &'static str,
) -> FamilySpec {
    FamilySpec {
        code,
        name,
        home,
        path_class,
        sources,
        decision,
        target,
        drop_reason,
        business_digest,
        pending: if pending.is_empty() {
            None
        } else {
            Some(pending)
        },
    }
}

use Decision::{Converted, Dropped, Rebuilt, Referenced};
use Home::{Knowledge, Project, ProjectDir, Registry, Root};

const DERIVED: Option<&str> = Some("派生数据（D 类），3.0 不转换；内容来自已纳入的源表");

/// 全部对象族。顺序即报告顺序。
pub const FAMILIES: &[FamilySpec] = &[
    // ---- registry.sqlite ----
    converted("R1", Registry, &["projects"], "projects"),
    converted("R2", Registry, &["project_paths"], "project_paths"),
    converted("R3", Registry, &["quick_tasks"], "quick_tasks"),
    converted(
        "R4",
        Registry,
        &["quick_task_updates"],
        "quick_task_updates",
    ),
    converted("R5", Registry, &["saved_views"], "saved_views"),
    converted("R6", Registry, &["settings"], "settings"),
    converted("R7", Registry, &["import_history"], "import_history"),
    converted(
        "R8",
        Registry,
        &["project_restore_requests"],
        "project_restore_requests",
    ),
    converted("R9", Registry, &["global_events"], "global_feed"),
    converted("R10", Registry, &["app_meta"], "app_meta"),
    db(
        "R11",
        Registry,
        &["backup_catalog"],
        Referenced,
        "legacy_backups",
        None,
        true,
    ),
    db(
        "R12",
        Registry,
        &["schema_migrations"],
        Dropped,
        "",
        Some("身份：迁移集合记入 app_meta.converted_from"),
        true,
    ),
    db(
        "X1",
        Registry,
        &["project_summary_cache"],
        Dropped,
        "",
        DERIVED,
        false,
    ),
    db(
        "X1",
        Registry,
        &["global_search_documents", "global_search_documents_fts"],
        Dropped,
        "",
        Some("派生数据（D 类）：单库后全局搜索直接查 search_docs"),
        false,
    ),
    db(
        "X1",
        Registry,
        &["project_projection_state"],
        Dropped,
        "",
        DERIVED,
        false,
    ),
    // ---- knowledge.sqlite ----
    converted("K1", Knowledge, &["knowledge_meta"], "knowledge_meta"),
    converted("K2", Knowledge, &["knowledge_entries"], "knowledge_entries"),
    converted(
        "K3",
        Knowledge,
        &["knowledge_revisions"],
        "knowledge_revisions",
    ),
    converted(
        "K4",
        Knowledge,
        &["knowledge_operations"],
        "idempotency_receipts",
    ),
    db(
        "K5",
        Knowledge,
        &["schema_migrations"],
        Dropped,
        "",
        Some("身份：迁移集合记入 app_meta.converted_from"),
        true,
    ),
    db(
        "X1",
        Knowledge,
        &["knowledge_fts"],
        Rebuilt,
        "knowledge_fts",
        None,
        false,
    ),
    // ---- projects/<id>/project.sqlite ----
    converted("P1", Project, &["project_meta"], "projects"),
    converted("P2", Project, &["counters"], "counters"),
    converted("P3", Project, &["objectives"], "objectives"),
    converted("P3", Project, &["milestones"], "milestones"),
    converted("P3", Project, &["work_items"], "work_items"),
    converted(
        "P3",
        Project,
        &["work_item_relations"],
        "work_item_relations",
    ),
    converted("P3", Project, &["checklist_items"], "checklist_items"),
    db(
        "P3",
        Project,
        &["labels"],
        Dropped,
        "",
        Some("N-02d@1（C-16）：整表进报告附件"),
        true,
    ),
    db(
        "P3",
        Project,
        &["work_item_labels"],
        Dropped,
        "",
        Some("N-02e@1（C-16）：整表进报告附件"),
        true,
    ),
    converted("P3", Project, &["progress_updates"], "progress_updates"),
    converted("P3", Project, &["project_updates"], "project_updates"),
    converted("P3", Project, &["blockers"], "blockers"),
    converted("P3", Project, &["records"], "records"),
    converted("P3", Project, &["artifacts"], "artifacts"),
    converted("P3", Project, &["review_requests"], "review_requests"),
    converted("P3", Project, &["review_submissions"], "review_submissions"),
    converted("P4", Project, &["agents"], "agents"),
    converted("P4", Project, &["agent_sessions"], "agent_sessions"),
    converted("P4", Project, &["handoffs"], "handoffs"),
    converted("P5", Project, &["events"], "events"),
    converted("P6", Project, &["idempotency_keys"], "idempotency_receipts"),
    converted(
        "P7",
        Project,
        &["engineering_project_metrics"],
        "engineering_project_metrics",
    ),
    converted(
        "P7",
        Project,
        &["engineering_work_item_metrics"],
        "engineering_work_item_metrics",
    ),
    db(
        "P8",
        Project,
        &["settings"],
        Dropped,
        "",
        Some("2.0 无读写路径；必须为空，否则转换停"),
        true,
    ),
    db(
        "P9",
        Project,
        &["schema_migrations"],
        Dropped,
        "",
        Some("身份：迁移集合记入 app_meta.converted_from"),
        true,
    ),
    db("X1", Project, &["outbox"], Dropped, "", DERIVED, false),
    db(
        "X1",
        Project,
        &["search_documents", "search_documents_fts"],
        Rebuilt,
        "search_docs",
        None,
        false,
    ),
    // ---- projects/<id>/ 下的文件 ----
    file(
        "P10",
        "manifest.json",
        ProjectDir,
        "projects/<id>/manifest.json",
        &["projects/<id>/manifest.json"],
        Dropped,
        "",
        Some("项目身份冗余，只核对三个字段与 registry 一致"),
        true,
        "",
    ),
    file(
        "P11",
        "artifacts.files",
        ProjectDir,
        "projects/<id>/artifacts",
        &["projects/<id>/artifacts/**"],
        Converted,
        "data/artifacts/<id>",
        None,
        true,
        "",
    ),
    // ---- 数据根下的其余文件 ----
    file(
        "F1",
        "sync.config",
        Root,
        "sync/config.json",
        &["sync/config.json"],
        Converted,
        "sync_state",
        None,
        true,
        "W3b5",
    ),
    file(
        "F2",
        "sync.secrets",
        Root,
        "sync/secrets.dpapi.json",
        &["sync/secrets.dpapi.json"],
        Converted,
        "sync/secrets.dpapi.json",
        None,
        true,
        "W3b5",
    ),
    file(
        "F3",
        "dispatch.config",
        Root,
        "dispatch/config.json",
        &["dispatch/config.json"],
        Converted,
        "dispatch_config",
        None,
        true,
        "W3b5",
    ),
    file(
        "F4",
        "dispatch.runs",
        Root,
        "dispatch/runs.json",
        &["dispatch/runs.json"],
        Converted,
        "dispatch_runs",
        None,
        true,
        "W3b5",
    ),
    file(
        "F5",
        "dispatch.requests",
        Root,
        "dispatch/requests.json",
        &["dispatch/requests.json"],
        Converted,
        "dispatch_requests",
        None,
        true,
        "W3b5",
    ),
    file(
        "F6",
        "dispatch.logs.final",
        Root,
        "dispatch/logs",
        &[
            "dispatch/logs/<run>.jsonl",
            "dispatch/logs/<run>.stderr.log",
        ],
        Converted,
        "dispatch/logs",
        None,
        true,
        "W3b5",
    ),
    file(
        "F7",
        "dispatch.logs.running",
        Root,
        "dispatch/logs",
        &[
            "dispatch/logs/<run>.jsonl",
            "dispatch/logs/<run>.stderr.log",
        ],
        Referenced,
        "dispatch_runs.log_root",
        None,
        false,
        "W3b5",
    ),
    file(
        "X2",
        "runtime",
        Root,
        "runtime",
        &["runtime/**"],
        Dropped,
        "",
        Some("R 类：锁、令牌、进程见证"),
        false,
        "",
    ),
    file(
        "X3",
        "logs",
        Root,
        "logs",
        &["logs/**"],
        Dropped,
        "",
        Some("R 类：诊断与更新状态"),
        false,
        "",
    ),
    file(
        "X4",
        "install-copies",
        Root,
        "<install copies>",
        &[
            "ATM_AGENT_GUIDE.md",
            "docs/**",
            "skills/**",
            "*.staging-*",
            "*.backup-*",
            "mcp-stdio.cjs",
        ],
        Dropped,
        "",
        Some("每次启动由安装资源覆盖，不是用户数据"),
        false,
        "",
    ),
    file(
        "X5",
        "setup",
        Root,
        "<setup>",
        &["current", "updates/**"],
        Dropped,
        "",
        Some("setup / 发布链资产"),
        false,
        "",
    ),
    file(
        "X6",
        "webview",
        Root,
        "webview",
        &["webview/**"],
        Dropped,
        "",
        Some("浏览器配置目录（主题与侧栏偏好随之丢失，05 §7）"),
        false,
        "",
    ),
    file(
        "X7",
        "backups",
        Root,
        "<backups>",
        &["backups/**", "projects/<id>/backups/**"],
        Referenced,
        "legacy_backups",
        None,
        false,
        "",
    ),
    file(
        "X8",
        "exports",
        Root,
        "exports",
        &["exports/**"],
        Referenced,
        "report",
        None,
        false,
        "",
    ),
    file(
        "X9",
        "diagnostic-copies",
        Root,
        "<diagnostic copies>",
        &[
            "sync/config.corrupt.json",
            "dispatch/requests.corrupt.json",
            "**/*.tmp",
        ],
        Dropped,
        "",
        Some("诊断副本 / 临时件；主文件已纳入"),
        false,
        "",
    ),
    file(
        "X10",
        "sync.plain-secrets",
        Root,
        "sync/secrets.json",
        &["sync/secrets.json"],
        Dropped,
        "",
        Some("standalone 开发 daemon 的明文存储，正式 core 不读"),
        false,
        "",
    ),
    file(
        "X11",
        "trash",
        Root,
        "trash",
        &["trash/**"],
        Dropped,
        "",
        Some("2.0 只创建不写入；非空则 UNKNOWN"),
        false,
        "",
    ),
    file(
        "X12",
        "in-flight",
        Root,
        "<in-flight transactions>",
        &[
            "projects/.creating-<id>/",
            "projects/<id>.creating",
            "projects/.restore-<backupId>/",
            "projects/<id>/project.sqlite.restore-old-<id>",
            "knowledge/restore.json",
            "knowledge/restore-<ULID>.sqlite",
            "knowledge/.restore-<id>/",
        ],
        Dropped,
        "",
        Some("按 05 §4.1 在副本上落定后不单独转换"),
        false,
        "W3b6",
    ),
];

/// FTS5 外部表的影子表后缀（随主表归同一族）。
pub const FTS_SHADOWS: &[&str] = &["_config", "_content", "_data", "_docsize", "_idx"];

/// 按（home，族名）查族。
pub fn spec(home: Home, name: &str) -> Option<&'static FamilySpec> {
    FAMILIES.iter().find(|f| f.home == home && f.name == name)
}

/// 某个 DB 的全部已登记表名（含 FTS 影子表）。
pub fn tables(home: Home) -> Vec<String> {
    let mut out = Vec::new();
    for f in FAMILIES.iter().filter(|f| f.home == home) {
        for s in f.sources {
            out.push(s.to_string());
            if s.ends_with("_fts") {
                out.extend(FTS_SHADOWS.iter().map(|x| format!("{s}{x}")));
            }
        }
    }
    out
}
