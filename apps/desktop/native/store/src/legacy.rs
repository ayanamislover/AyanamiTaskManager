//! 2.x → 3.0 转换原型（W1f；05 §3、10 R6 / R7‴）。
//!
//! 输入是 2.x 的 registry、knowledge、各项目库（只读打开，路径由调用方逐个给出），输出是一个新的单库。
//! 规则：
//! - id、序号、JSON 原文逐值保留；2.x 有、3.0 结构里放不下的原值（`projects.db_path`、整行 `project_meta`、
//!   回执的原 op_id 与分类）存进专门的 legacy 列，VERIFY 用它们反投影；
//! - 只接受已迁移到最新的 2.x（registry 1–8、knowledge 1、project 1–18），出现未登记的表即拒绝；
//! - 进行中的生命周期（CREATING / RESTORING / MIGRATION_FAILED）留给 W3 的落定规则（05 §4.1），这里拒绝；
//! - 转换完成后逐族比对：源表与目标反投影的规范化摘要（05 §5.1）必须相等；
//! - 默认拒绝读取真实数据根（`%LOCALAPPDATA%\AyanamiTaskManager`）：真实数据转换需要单独授权。
//!
//! 失败时目标库处于未定义状态，由调用方丢弃（W3 的 staging 负责）。

use crate::backup::path_str;
use crate::events::ulid;
use crate::search::rebuild_knowledge_fts;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub enum ConvertError {
    Sqlite(rusqlite::Error),
    /// 某一步写入目标库时违反约束：3.0 的约束比 2.x 严，带上表名。
    Constraint {
        table: String,
        error: rusqlite::Error,
    },
    Io(std::io::Error),
    /// 源路径在真实数据根下，而调用方没有明确允许。
    RealDataRoot(PathBuf),
    TargetExists(PathBuf),
    /// 源库的迁移集合不是转换器支持的那一组。
    UnsupportedSchema(String),
    /// 源库里有未登记的表（05 §5.1 登记完整性）。
    UnknownTable(String),
    /// 源数据处于原型不处理的状态（进行中的生命周期、项目 settings 非空等）。
    Unsupported(String),
    /// 源数据彼此对不上（registry 与项目库身份不一致、序号高水位矛盾等）。
    Mismatch(String),
    /// VERIFY 失败：逐族摘要不等，或回执自相矛盾（R7‴ F1–F3）。附报告。
    Verify(Box<Report>),
}

impl std::fmt::Display for ConvertError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConvertError::Sqlite(e) => write!(f, "sqlite: {e}"),
            ConvertError::Constraint { table, error } => {
                write!(f, "constraint in {table}: {error}")
            }
            ConvertError::Io(e) => write!(f, "io: {e}"),
            ConvertError::RealDataRoot(p) => {
                write!(f, "refusing to read the real data root: {}", p.display())
            }
            ConvertError::TargetExists(p) => write!(f, "target already exists: {}", p.display()),
            ConvertError::UnsupportedSchema(m) => write!(f, "unsupported source schema: {m}"),
            ConvertError::UnknownTable(m) => write!(f, "unregistered table in source: {m}"),
            ConvertError::Unsupported(m) => write!(f, "unsupported source state: {m}"),
            ConvertError::Mismatch(m) => write!(f, "sources disagree: {m}"),
            ConvertError::Verify(r) => write!(f, "verify failed: {:?}", r.failures()),
        }
    }
}

impl std::error::Error for ConvertError {}

impl From<rusqlite::Error> for ConvertError {
    fn from(e: rusqlite::Error) -> Self {
        ConvertError::Sqlite(e)
    }
}

impl From<std::io::Error> for ConvertError {
    fn from(e: std::io::Error) -> Self {
        ConvertError::Io(e)
    }
}

impl From<crate::StoreError> for ConvertError {
    fn from(e: crate::StoreError) -> Self {
        match e {
            crate::StoreError::Sqlite(e) => ConvertError::Sqlite(e),
            other => ConvertError::Unsupported(other.to_string()),
        }
    }
}

impl From<crate::backup::BackupError> for ConvertError {
    fn from(e: crate::backup::BackupError) -> Self {
        match e {
            crate::backup::BackupError::Sqlite(e) => ConvertError::Sqlite(e),
            other => ConvertError::Unsupported(other.to_string()),
        }
    }
}

pub type Result<T> = std::result::Result<T, ConvertError>;

/// 给写入步骤加上表名，让约束冲突能定位。
trait Context<T> {
    fn ctx(self, table: &str) -> Result<T>;
}

impl<T> Context<T> for rusqlite::Result<T> {
    fn ctx(self, table: &str) -> Result<T> {
        self.map_err(|error| match &error {
            rusqlite::Error::SqliteFailure(f, _)
                if f.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                ConvertError::Constraint {
                    table: table.to_string(),
                    error,
                }
            }
            _ => ConvertError::Sqlite(error),
        })
    }
}

#[derive(Clone, Debug)]
pub struct LegacySources {
    pub registry: PathBuf,
    pub knowledge: Option<PathBuf>,
    pub projects: Vec<PathBuf>,
}

#[derive(Clone, Debug)]
pub struct ConvertOptions<'a> {
    pub at: &'a str,
    /// 允许读取真实数据根。只有用户单独授权的真实数据转换才会打开它。
    pub allow_real_data_root: bool,
    /// 真实数据根的位置；`None` 取 [`real_data_root`]。测试用它指向一个假的根，不必改进程环境。
    pub real_data_root: Option<&'a Path>,
}

/// 2.x 的真实数据根：`%LOCALAPPDATA%\AyanamiTaskManager`。
pub fn real_data_root() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|l| PathBuf::from(l).join("AyanamiTaskManager"))
}

/// 一个对象族的比对结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FamilyCheck {
    pub family: String,
    pub source_rows: i64,
    pub target_rows: i64,
    pub source_digest: String,
    pub target_digest: String,
}

impl FamilyCheck {
    pub fn ok(&self) -> bool {
        self.source_rows == self.target_rows && self.source_digest == self.target_digest
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Report {
    pub families: Vec<FamilyCheck>,
    /// 舍弃的派生族及其源行数。
    pub dropped: BTreeMap<String, i64>,
    /// 回执分类计数（R7‴）。
    pub receipt_classes: BTreeMap<String, usize>,
    /// 按 AGENT 处理、但形状是晋升的回执（R7‴ 第 4 类的特别标注）。
    pub promotion_shaped_agent: usize,
    /// 晋升历史的关联状态计数（MATCHED / UNMARKED / OTHER_TARGET / QUICK_MISSING）。
    pub promotion_status: BTreeMap<String, usize>,
    /// 回执自相矛盾（F1–F3），每条带定位（项目 + key），不含回执正文。
    pub receipt_violations: Vec<String>,
    /// 全局流里指向项目事件、但事件已不存在的行（R6 孤儿）。
    pub global_orphans: usize,
    /// 没有全局镜像的项目事件，转换时补到全局流末尾的条数（R6）。
    /// 按差集算：源项目事件减去已关联到全局行的事件，不看 outbox。
    pub mirrors_replayed: usize,
    /// 未送达、但找不到对应事件的 outbox 行（只计数；outbox 整族舍弃）。
    pub outbox_without_event: usize,
    /// quick 的晋升目标在项目里解析不到的条数。
    pub unresolved_promotions: usize,
    /// artifacts 行数（2.0 不写 artifacts，预期 0；有行时 local_path 原样保留并抄入 legacy 列）。
    pub artifact_rows: i64,
    /// 规范化规则的执行记录（`store/NORMALIZATION.md`），按（规则，族）排序。计数为 0 的也有一条。
    pub normalizations: Vec<Normalization>,
    /// 报告附件：被舍弃结构（N-02）的非默认值，族 → 按主键排序的 JSON 行。可能含用户正文，与报告分开存放。
    pub attachment: BTreeMap<String, Vec<String>>,
    /// 只报告、不改动的遗留值（O-01～O-03）：`编号 族` → 行数。
    pub observations: BTreeMap<String, i64>,
    /// VERIFY 独立重算的规则记录或附件与转换记下的不一致。
    pub rule_mismatches: Vec<String>,
}

/// 一条规范化规则在一个族上的执行记录。
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Normalization {
    /// `编号@版本`，N-05 另带原因：`N-05@1:CROSS_AGENT`。
    pub rule: String,
    pub family: String,
    pub count: i64,
    /// 受影响主键集合的摘要（NORMALIZATION.md「主键集合摘要」）。
    pub keys_digest: String,
}

impl Report {
    pub fn failures(&self) -> Vec<String> {
        let mut out: Vec<String> = self
            .families
            .iter()
            .filter(|f| !f.ok())
            .map(|f| f.family.clone())
            .collect();
        out.extend(self.receipt_violations.iter().cloned());
        out.extend(self.rule_mismatches.iter().cloned());
        out
    }

    /// 附件的 JSON Lines 文本：每行 `{"family":…,"row":…}`，族按名字、行按主键排序。W3d 写到 `staging\<g>\`。
    pub fn attachment_jsonl(&self) -> String {
        let mut out = String::new();
        for (family, rows) in &self.attachment {
            for row in rows {
                out.push_str(&format!(
                    "{{\"family\":{},\"row\":{row}}}\n",
                    json_string(family)
                ));
            }
        }
        out
    }
}

const REGISTRY_MIGRATIONS: i64 = 8;
const KNOWLEDGE_MIGRATIONS: i64 = 1;
const PROJECT_MIGRATIONS: i64 = 18;

const FTS_SHADOWS: &[&str] = &["_config", "_content", "_data", "_docsize", "_idx"];

const REGISTRY_TABLES: &[&str] = &[
    "app_meta",
    "backup_catalog",
    "global_events",
    "global_search_documents",
    "import_history",
    "project_paths",
    "project_projection_state",
    "project_restore_requests",
    "project_summary_cache",
    "projects",
    "quick_task_updates",
    "quick_tasks",
    "saved_views",
    "settings",
    "schema_migrations",
];
/// 2.x project_paths 的一行：id（可能为 NULL）、project_id、canonical_path、git_common_dir、is_primary、last_seen_at。
type PathRow = (Option<String>, String, String, Option<String>, i64, String);
const REGISTRY_FTS: &str = "global_search_documents_fts";
/// registry 里按列名原样搬的表。
const REGISTRY_COPY: &[&str] = &[
    "quick_tasks",
    "quick_task_updates",
    "saved_views",
    "settings",
    "import_history",
    "project_restore_requests",
];
const REGISTRY_DROPPED: &[&str] = &[
    "global_search_documents",
    "project_projection_state",
    "project_summary_cache",
];

const KNOWLEDGE_TABLES: &[&str] = &[
    "knowledge_entries",
    "knowledge_meta",
    "knowledge_operations",
    "knowledge_revisions",
    "schema_migrations",
];
const KNOWLEDGE_FTS: &str = "knowledge_fts";

const PROJECT_TABLES_V2: &[&str] = &[
    "agent_sessions",
    "agents",
    "artifacts",
    "blockers",
    "checklist_items",
    "counters",
    "engineering_project_metrics",
    "engineering_work_item_metrics",
    "events",
    "handoffs",
    "idempotency_keys",
    "labels",
    "milestones",
    "objectives",
    "outbox",
    "progress_updates",
    "project_meta",
    "project_updates",
    "records",
    "review_requests",
    "review_submissions",
    "search_documents",
    "settings",
    "work_item_labels",
    "work_item_relations",
    "work_items",
    "schema_migrations",
];
const PROJECT_FTS: &str = "search_documents_fts";
/// 项目库里按列名原样搬、只加 project_id 的表。
const PROJECT_COPY: &[&str] = &[
    "counters",
    "objectives",
    "milestones",
    "checklist_items",
    "progress_updates",
    "project_updates",
    "blockers",
    "records",
    "artifacts",
    "agents",
    "agent_sessions",
    "handoffs",
    "review_requests",
    "review_submissions",
    "engineering_project_metrics",
    "engineering_work_item_metrics",
];

// ===== 规范化规则（10 R9′；store/NORMALIZATION.md）=====

const N01: &str = "N-01@1";
/// N-02a～c：3.0 不建的 work_items 列，各自的非默认值谓词。
const N02_COLUMNS: &[(&str, &str, &str)] = &[
    ("N-02a@1", "archived_at", "archived_at IS NOT NULL"),
    ("N-02b@1", "phase_inferred", "phase_inferred <> 0"),
    (
        "N-02c@1",
        "planned_start_date",
        "planned_start_date IS NOT NULL",
    ),
];
/// N-02d、e：3.0 不建的表，整表进附件。（规则，表，主键）
const N02_TABLES: &[(&str, &str, &str)] = &[
    ("N-02d@1", "labels", "id"),
    ("N-02e@1", "work_item_labels", "work_item_id, label_id"),
];
const N02F: &str = "N-02f@1";
/// 3.0 保留的关系类型；其余（RELATES、DUPLICATES）按 N-02f 进附件。
const KEPT_RELATIONS: &str = "('BLOCKS','DISCOVERED_FROM')";
const N04: &str = "N-04@1";
const N05: &str = "N-05@1";
const N05_REASONS: &[&str] = &["CROSS_AGENT", "CROSS_ROLE", "TIME_REVERSED", "SAME_INSTANT"];
/// 只报告、不改动的遗留值。（编号，表，谓词）
const OBSERVED: &[(&str, &str, &str)] = &[
    ("O-01", "checklist_items", "kind <> 'ACCEPTANCE'"),
    ("O-02", "blockers", "status = 'CANCELLED'"),
    ("O-03", "work_items", "progress_source = 'STATUS'"),
];
const NOTIFY_ENABLED: &str = "notification.enabled";
const NOTIFY_MODE: &str = "notification.mode";

/// 主键集合摘要：`sha256("ATM-NORM-1" ‖ 规则 ‖ 0 ‖ 族 ‖ 0 ‖ 排序后的每个主键 ‖ 0)`。
fn keys_digest(rule: &str, family: &str, mut keys: Vec<String>) -> String {
    keys.sort();
    let mut h = Sha256::new();
    h.update(b"ATM-NORM-1");
    h.update(rule.as_bytes());
    h.update([0]);
    h.update(family.as_bytes());
    h.update([0]);
    for k in &keys {
        h.update(k.as_bytes());
        h.update([0]);
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// 一列文本结果：多列主键用 0x1F 连接成一个键。
fn key_list(c: &Connection, sql: &str) -> Result<Vec<String>> {
    let mut st = c.prepare(sql)?;
    let n = st.column_count();
    let rows = st.query_map([], |r| {
        (0..n)
            .map(|i| r.get::<_, String>(i))
            .collect::<rusqlite::Result<Vec<_>>>()
            .map(|v| v.join("\u{1f}"))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn record(rule: &str, family: &str, keys: Vec<String>) -> Normalization {
    Normalization {
        rule: rule.to_string(),
        family: family.to_string(),
        count: keys.len() as i64,
        keys_digest: keys_digest(rule, family, keys),
    }
}

/// 一张表全部列的 `json_object(…)` 表达式（附件整行）。
fn row_json(c: &Connection, schema: &str, table: &str) -> Result<String> {
    let (cols, _) = columns(c, schema, table)?;
    Ok(format!(
        "json_object({})",
        cols.iter()
            .map(|col| format!("'{col}', \"{col}\""))
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

/// JSON 字符串字面量（附件行的族名）。
fn json_string(s: &str) -> String {
    let mut out = String::from("\"");
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// 2.x 的 `notification.mode` 是否合法：JSON 字符串，值为三者之一（区分大小写，同 2.x 的 `includes`）。
fn valid_mode(tx: &Transaction<'_>, value_json: &str) -> Result<bool> {
    Ok(tx.query_row(
        "SELECT CASE WHEN json_valid(?1) THEN json_type(?1) = 'text' AND (?1 ->> '$') IN ('ALL', 'CRITICAL', 'OFF')
                ELSE 0 END",
        [value_json],
        |r| r.get(0),
    )?)
}

/// N-04 的推导值：`enabled` 恰好是 JSON `false` 时为 OFF，其余（缺失、非 JSON、其他值）为 ALL。
fn mode_from_enabled(tx: &Transaction<'_>, enabled: Option<&str>) -> Result<&'static str> {
    let off: bool = match enabled {
        None => false,
        Some(v) => tx.query_row(
            "SELECT CASE WHEN json_valid(?1) THEN json_type(?1) = 'false' ELSE 0 END",
            [v],
            |r| r.get(0),
        )?,
    };
    Ok(if off { "\"OFF\"" } else { "\"ALL\"" })
}

/// N-04：在目标库的 registry settings 上合并通知设置。返回受影响的键。
fn normalize_notification(tx: &Transaction<'_>) -> Result<Vec<String>> {
    type Row = (String, i64, String);
    let get = |key: &str| -> Result<Option<Row>> {
        Ok(tx
            .query_row(
                "SELECT value_json, version, updated_at FROM main.settings WHERE key = ?1",
                [key],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?)
    };
    let (enabled, mode) = (get(NOTIFY_ENABLED)?, get(NOTIFY_MODE)?);
    let mut touched = Vec::new();
    if let Some((e_value, e_version, e_at)) = &enabled {
        tx.execute("DELETE FROM main.settings WHERE key = ?1", [NOTIFY_ENABLED])?;
        touched.push(NOTIFY_ENABLED.to_string());
        if mode.is_none() {
            tx.execute(
                "INSERT INTO main.settings (key, value_json, version, updated_at) VALUES (?1, ?2, ?3, ?4)",
                params![NOTIFY_MODE, mode_from_enabled(tx, Some(e_value))?, e_version, e_at],
            )
            .ctx("settings")?;
            touched.push(NOTIFY_MODE.to_string());
        }
    }
    if let Some((m_value, _, _)) = &mode
        && !valid_mode(tx, m_value)?
    {
        let derived = mode_from_enabled(tx, enabled.as_ref().map(|(v, _, _)| v.as_str()))?;
        tx.execute(
            "UPDATE main.settings SET value_json = ?2 WHERE key = ?1",
            params![NOTIFY_MODE, derived],
        )?;
        touched.push(NOTIFY_MODE.to_string());
    }
    Ok(touched)
}

/// 项目库里按规则搬的部分：work_items（N-01、N-02a～c）、work_item_relations（N-02f）、
/// 不建的表（N-02d、e），以及只记录的 N-05 与 O-01～O-03。
fn normalize_project(tx: &Transaction<'_>, pid: &str, report: &mut Report) -> Result<()> {
    let family = |table: &str| format!("{pid}/{table}");

    // work_items：不建 N-02a～c 的三列；终态任务的领取两列置 NULL（N-01）。
    let (cols, _) = columns(tx, "p", "work_items")?;
    let kept: Vec<String> = cols
        .iter()
        .filter(|c| !N02_COLUMNS.iter().any(|(_, col, _)| col == c))
        .cloned()
        .collect();
    let select = kept
        .iter()
        .map(|c| match c.as_str() {
            "claimed_by_session_id" | "claim_lease_until" => {
                format!("CASE WHEN status IN ('DONE','CANCELLED') THEN NULL ELSE \"{c}\" END")
            }
            _ => format!("\"{c}\""),
        })
        .collect::<Vec<_>>()
        .join(", ");
    tx.execute(
        &format!(
            "INSERT INTO main.work_items (project_id, {}) SELECT ?1, {select} FROM p.work_items",
            list(&kept)
        ),
        [pid],
    )
    .ctx("work_items")?;
    let keys = key_list(
        tx,
        "SELECT id FROM p.work_items WHERE status IN ('DONE','CANCELLED')
           AND (claimed_by_session_id IS NOT NULL OR claim_lease_until IS NOT NULL)",
    )?;
    report
        .normalizations
        .push(record(N01, &family("work_items"), keys));
    for (rule, col, predicate) in N02_COLUMNS {
        let f = format!("{}.{col}", family("work_items"));
        let keys = key_list(
            tx,
            &format!("SELECT id FROM p.work_items WHERE {predicate}"),
        )?;
        let rows = key_list(
            tx,
            &format!(
                "SELECT json_object('id', id, 'value', \"{col}\") FROM p.work_items WHERE {predicate} ORDER BY id"
            ),
        )?;
        if !rows.is_empty() {
            report.attachment.insert(f.clone(), rows);
        }
        report.normalizations.push(record(rule, &f, keys));
    }

    // work_item_relations：只建 3.0 保留的两类，其余进附件（N-02f）。
    let (cols, _) = columns(tx, "p", "work_item_relations")?;
    let l = list(&cols);
    tx.execute(
        &format!(
            "INSERT INTO main.work_item_relations (project_id, {l}) SELECT ?1, {l} FROM p.work_item_relations
             WHERE relation_type IN {KEPT_RELATIONS}"
        ),
        [pid],
    )
    .ctx("work_item_relations")?;
    let dropped = format!("FROM p.work_item_relations WHERE relation_type NOT IN {KEPT_RELATIONS}");
    let keys = key_list(
        tx,
        &format!("SELECT source_id, target_id, relation_type {dropped}"),
    )?;
    let rows = key_list(
        tx,
        &format!(
            "SELECT {} {dropped} ORDER BY source_id, target_id, relation_type",
            row_json(tx, "p", "work_item_relations")?
        ),
    )?;
    let f = family("work_item_relations");
    if !rows.is_empty() {
        report.attachment.insert(f.clone(), rows);
    }
    report.normalizations.push(record(N02F, &f, keys));

    // labels、work_item_labels：3.0 不建，整表进附件（N-02d、e）。
    for (rule, table, pk) in N02_TABLES {
        let keys = key_list(tx, &format!("SELECT {pk} FROM p.{table}"))?;
        let rows = key_list(
            tx,
            &format!(
                "SELECT {} FROM p.{table} ORDER BY {pk}",
                row_json(tx, "p", table)?
            ),
        )?;
        let f = family(table);
        if !rows.is_empty() {
            report.attachment.insert(f.clone(), rows);
        }
        report.normalizations.push(record(rule, &f, keys));
    }

    // N-05：不改数据，按原因记录无效边与同一时刻的有效边。
    let edges: Vec<(String, String)> = {
        let mut st = tx.prepare(
            "SELECT s.id,
                    CASE WHEN s.agent_id <> q.agent_id THEN 'CROSS_AGENT'
                         WHEN s.role <> q.role THEN 'CROSS_ROLE'
                         WHEN s.started_at < q.started_at THEN 'TIME_REVERSED'
                         WHEN s.started_at = q.started_at THEN 'SAME_INSTANT' END
             FROM p.agent_sessions s JOIN p.agent_sessions q ON q.id = s.predecessor_session_id",
        )?;
        st.query_map([], |r| Ok((r.get(0)?, r.get::<_, Option<String>>(1)?)))?
            .filter_map(|r| match r {
                Ok((id, Some(reason))) => Some(Ok((id, reason))),
                Ok((_, None)) => None,
                Err(e) => Some(Err(e)),
            })
            .collect::<rusqlite::Result<_>>()?
    };
    for reason in N05_REASONS {
        let keys = edges
            .iter()
            .filter(|(_, r)| r == reason)
            .map(|(id, _)| id.clone())
            .collect();
        report.normalizations.push(record(
            &format!("{N05}:{reason}"),
            &family("agent_sessions"),
            keys,
        ));
    }

    for (code, table, predicate) in OBSERVED {
        let n: i64 = tx.query_row(
            &format!("SELECT count(*) FROM p.{table} WHERE {predicate}"),
            [],
            |r| r.get(0),
        )?;
        *report
            .observations
            .entry(format!("{code} {}", family(table)))
            .or_default() += n;
    }
    Ok(())
}

/// 把一组 2.x 库转换成 `target` 处的新单库，并逐族校验。
pub fn convert(src: &LegacySources, target: &Path, opts: &ConvertOptions<'_>) -> Result<Report> {
    if !opts.allow_real_data_root {
        let root = opts
            .real_data_root
            .map(Path::to_path_buf)
            .or_else(real_data_root);
        if let Some(root) = root {
            for p in std::iter::once(&src.registry)
                .chain(src.knowledge.iter())
                .chain(src.projects.iter())
            {
                refuse_real_root(&root, p)?;
            }
        }
    }
    if target.exists() {
        return Err(ConvertError::TargetExists(target.to_path_buf()));
    }
    check_source(
        &src.registry,
        REGISTRY_TABLES,
        &[REGISTRY_FTS],
        REGISTRY_MIGRATIONS,
    )?;
    if let Some(k) = &src.knowledge {
        check_source(k, KNOWLEDGE_TABLES, &[KNOWLEDGE_FTS], KNOWLEDGE_MIGRATIONS)?;
    }
    for p in &src.projects {
        check_source(p, PROJECT_TABLES_V2, &[PROJECT_FTS], PROJECT_MIGRATIONS)?;
    }

    let mut t = crate::open(target)?;
    register_functions(&t)?;
    let mut report = Report::default();
    let gens = convert_registry(&mut t, src, opts.at, &mut report)?;
    let mut promotions: Vec<(String, String)> = Vec::new();
    let mut seen = HashSet::new();
    for p in &src.projects {
        let pid = convert_project(&mut t, p, &gens, &mut report, &mut promotions)?;
        if !seen.insert(pid.clone()) {
            return Err(ConvertError::Mismatch(format!("project {pid} given twice")));
        }
    }
    for id in gens.projects.keys() {
        if !seen.contains(id) {
            return Err(ConvertError::Mismatch(format!(
                "project {id} is in the registry but no database was given"
            )));
        }
    }
    finish(&mut t, &gens, &promotions, &mut report)?;
    verify(&t, src, &mut report)?;
    if !report.failures().is_empty() {
        return Err(ConvertError::Verify(Box::new(report)));
    }
    Ok(report)
}

fn refuse_real_root(root: &Path, p: &Path) -> Result<()> {
    // 两边都规范化后再比，`..`、大小写、符号链接都绕不过去；根不存在时没有可保护的东西。
    let Ok(root) = root.canonicalize() else {
        return Ok(());
    };
    let path = p.canonicalize().map_err(ConvertError::Io)?;
    if path.starts_with(&root) {
        return Err(ConvertError::RealDataRoot(p.to_path_buf()));
    }
    Ok(())
}

fn check_source(path: &Path, tables: &[&str], fts: &[&str], migrations: i64) -> Result<()> {
    let c = crate::backup::side_reader(path)?;
    let mut allowed: HashSet<String> = tables.iter().map(|s| s.to_string()).collect();
    for f in fts {
        allowed.insert(f.to_string());
        for s in FTS_SHADOWS {
            allowed.insert(format!("{f}{s}"));
        }
    }
    let names: Vec<String> = c
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for n in &names {
        if !allowed.contains(n) {
            return Err(ConvertError::UnknownTable(format!(
                "{}: {n}",
                path.display()
            )));
        }
    }
    for t in tables {
        if !names.iter().any(|n| n == t) {
            return Err(ConvertError::UnsupportedSchema(format!(
                "{}: missing {t}",
                path.display()
            )));
        }
    }
    let versions: Vec<i64> = c
        .prepare("SELECT version FROM schema_migrations ORDER BY version")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    if versions != (1..=migrations).collect::<Vec<_>>() {
        return Err(ConvertError::UnsupportedSchema(format!(
            "{}: migrations {versions:?}, expected 1..={migrations}",
            path.display()
        )));
    }
    Ok(())
}

fn uri(path: &Path) -> Result<String> {
    let raw = path_str(path)?.replace('\\', "/");
    let mut s = String::from(if raw.starts_with('/') {
        "file://"
    } else {
        "file:///"
    });
    for c in raw.chars() {
        match c {
            '%' => s.push_str("%25"),
            '?' => s.push_str("%3F"),
            '#' => s.push_str("%23"),
            _ => s.push(c),
        }
    }
    s.push_str("?mode=ro");
    Ok(s)
}

fn attach(c: &Connection, path: &Path, name: &str) -> Result<()> {
    c.execute(&format!("ATTACH DATABASE ?1 AS {name}"), [uri(path)?])?;
    Ok(())
}

fn detach(c: &Connection, name: &str) {
    let _ = c.execute(&format!("DETACH DATABASE {name}"), []);
}

/// 表的列名（按定义顺序）与主键列（按主键顺序）。
fn columns(c: &Connection, schema: &str, table: &str) -> Result<(Vec<String>, Vec<String>)> {
    // 表值 pragma 前面的 `schema.` 会被忽略，查回来的是 main 的表；schema 必须作为第二个参数传。
    let mut st = c.prepare("SELECT name, pk FROM pragma_table_info(?1, ?2) ORDER BY cid")?;
    let rows: Vec<(String, i64)> = st
        .query_map([table, schema], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    if rows.is_empty() {
        return Err(ConvertError::UnsupportedSchema(format!(
            "{schema}.{table} has no columns"
        )));
    }
    let cols: Vec<String> = rows.iter().map(|(n, _)| n.clone()).collect();
    let mut pk: Vec<(i64, String)> = rows
        .into_iter()
        .filter(|(_, k)| *k > 0)
        .map(|(n, k)| (k, n))
        .collect();
    pk.sort();
    let pk: Vec<String> = if pk.is_empty() {
        cols.clone()
    } else {
        pk.into_iter().map(|(_, n)| n).collect()
    };
    Ok((cols, pk))
}

fn list(cols: &[String]) -> String {
    cols.iter()
        .map(|c| format!("\"{c}\""))
        .collect::<Vec<_>>()
        .join(", ")
}

/// registry 转换出来的世代分配：每个项目一个，知识库一个。
struct Gens {
    projects: BTreeMap<String, (i64, String)>,
    knowledge: Option<(i64, String)>,
}

fn convert_registry(
    t: &mut Connection,
    src: &LegacySources,
    at: &str,
    report: &mut Report,
) -> Result<Gens> {
    attach(t, &src.registry, "r")?;
    if let Some(k) = &src.knowledge {
        attach(t, k, "k")?;
    }
    let result = (|| {
        let tx = t.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let bad: Option<(String, String)> = tx
            .query_row(
                "SELECT id, lifecycle FROM r.projects WHERE lifecycle NOT IN ('ACTIVE', 'ARCHIVED', 'TRASHED') ORDER BY id LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((id, life)) = bad {
            return Err(ConvertError::Unsupported(format!(
                "project {id} is {life}; in-flight lifecycles are settled by W3 (05 4.1)"
            )));
        }
        let (current, max_seq): (i64, i64) = tx.query_row(
            "SELECT (SELECT current_sequence FROM r.app_meta), coalesce((SELECT max(sequence) FROM r.global_events), 0)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if current < max_seq {
            return Err(ConvertError::Mismatch(format!(
                "registry current_sequence {current} is below its highest global event {max_seq}"
            )));
        }

        // 世代：项目按 id 排序依次分配，知识库最后。
        let ids: Vec<String> = tx
            .prepare("SELECT id FROM r.projects ORDER BY id")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let mut gens = Gens {
            projects: BTreeMap::new(),
            knowledge: None,
        };
        let mut next = 0;
        for id in ids {
            next += 1;
            let epoch = ulid(&tx)?;
            tx.execute(
                "INSERT INTO scope_generations (gen, scope_kind, scope_id, reason, epoch, created_at) VALUES (?1, 'PROJECT', ?2, 'CONVERTED', ?3, ?4)",
                params![next, id, epoch, at],
            )
            .ctx("scope_generations")?;
            gens.projects.insert(id, (next, epoch));
        }
        let knowledge_id: Option<String> = if src.knowledge.is_some() {
            tx.query_row("SELECT database_id FROM k.knowledge_meta", [], |r| r.get(0))
                .optional()?
        } else {
            None
        };
        if let Some(db) = &knowledge_id {
            next += 1;
            let epoch = ulid(&tx)?;
            tx.execute(
                "INSERT INTO scope_generations (gen, scope_kind, scope_id, reason, epoch, created_at) VALUES (?1, 'KNOWLEDGE', ?2, 'CONVERTED', ?3, ?4)",
                params![next, db, epoch, at],
            )
            .ctx("scope_generations")?;
            gens.knowledge = Some((next, epoch));
        }

        let converted_from: String = tx.query_row(
            "SELECT json_object('format', 'atm2', 'registryMigrations', ?1, 'projectMigrations', ?2,
                                'knowledgeMigrations', ?3, 'sourceCurrentSequence', ?4, 'convertedAt', ?5)",
            params![REGISTRY_MIGRATIONS, PROJECT_MIGRATIONS, KNOWLEDGE_MIGRATIONS, current, at],
            |r| r.get(0),
        )?;
        let (root, generation, epoch) = (ulid(&tx)?, ulid(&tx)?, ulid(&tx)?);
        tx.execute(
            "INSERT INTO app_meta (singleton, schema_version, data_root_id, generation, instance_epoch, global_seq,
                                   scope_gen_counter, converted_from, created_at, updated_at)
             VALUES (1, 1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![root, generation, epoch, current, next, converted_from, at],
        )
        .ctx("app_meta")?;

        // projects：registry 列；项目库那一份在 convert_project 里补。
        let mut st = tx.prepare("SELECT id FROM r.projects ORDER BY id")?;
        let ids: Vec<String> = st
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        drop(st);
        for id in ids {
            let (g, e) = &gens.projects[&id];
            tx.execute(
                "INSERT INTO projects (id, code, name, description, lifecycle, coordination_mode, creation_reason,
                                       creation_signals_json, version, created_at, updated_at,
                                       scope_gen, epoch, legacy_json)
                 SELECT id, code, name, description, lifecycle, coordination_mode, creation_reason,
                        creation_signals_json, version, created_at, updated_at,
                        ?2, ?3, json_object('registryDbPath', db_path, 'archivedAt', archived_at)
                 FROM r.projects WHERE id = ?1",
                params![id, g, e],
            )
            .ctx("projects")?;
        }

        for table in REGISTRY_COPY {
            let (cols, _) = columns(&tx, "r", table)?;
            let l = list(&cols);
            tx.execute(
                &format!("INSERT INTO main.{table} ({l}) SELECT {l} FROM r.{table}"),
                [],
            )
            .ctx(table)?;
        }
        let touched = normalize_notification(&tx)?;
        report
            .normalizations
            .push(record(N04, "r/settings", touched));
        // project_paths：另算唯一键 path_key（04 C-L09）。两个项目认领同一个键会撞上唯一约束，
        // 转换就此失败，不会悄悄留下其中一条（L-009）。
        let mut st = tx.prepare(
            "SELECT id, project_id, canonical_path, git_common_dir, is_primary, last_seen_at FROM r.project_paths ORDER BY rowid",
        )?;
        let paths: Vec<PathRow> = st
            .query_map([], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            })?
            .collect::<rusqlite::Result<_>>()?;
        drop(st);
        for (id, project, canonical, common, primary, seen) in paths {
            tx.execute(
                "INSERT INTO project_paths (id, project_id, path_key, canonical_path, git_common_dir, is_primary, last_seen_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![id, project, crate::paths::path_key(&canonical), canonical, common, primary, seen],
            )
            .ctx("project_paths")?;
        }
        tx.execute(
            "INSERT INTO global_feed (global_seq, type, aggregate_id, actor, payload_json, created_at, dedupe_key)
             SELECT sequence, type, aggregate_id, actor, payload_json, created_at, dedupe_key FROM r.global_events",
            [],
        )
        .ctx("global_feed")?;
        tx.execute(
            "INSERT INTO legacy_backups (id, source, scope, project_id, legacy_path, sha256, size_bytes, reason,
                                         schema_version, created_at, verified_at, importable)
             SELECT id, 'CATALOG', scope, project_id, path, sha256, size_bytes, reason, schema_version, created_at, verified_at,
                    CASE scope WHEN 'PROJECT' THEN 'AS_PROJECT' WHEN 'KNOWLEDGE' THEN 'AS_KNOWLEDGE' ELSE 'NO' END
             FROM r.backup_catalog",
            [],
        )
        .ctx("legacy_backups")?;
        for table in REGISTRY_DROPPED {
            let n: i64 =
                tx.query_row(&format!("SELECT count(*) FROM r.{table}"), [], |r| r.get(0))?;
            report.dropped.insert(format!("registry.{table}"), n);
        }

        if let (Some(db), Some((g, _))) = (&knowledge_id, &gens.knowledge) {
            tx.execute(
                "INSERT INTO knowledge_meta (singleton, database_id, generation, sequence, scope_gen)
                 SELECT singleton, database_id, generation, sequence, ?1 FROM k.knowledge_meta",
                [g],
            )
            .ctx("knowledge_meta")?;
            for table in ["knowledge_revisions", "knowledge_entries"] {
                let (cols, _) = columns(&tx, "k", table)?;
                let l = list(&cols);
                tx.execute(
                    &format!("INSERT INTO main.{table} ({l}) SELECT {l} FROM k.{table}"),
                    [],
                )
                .ctx(table)?;
            }
            // knowledge_operations → 回执（05 §3.2）：op_id 原值作 legacy_key，operation 记 '*'（只按指纹判冲突）。
            tx.execute(
                "INSERT INTO idempotency_receipts (scope_kind, scope_id, legacy_key, operation, fp_v, fp_family, fingerprint,
                                                   receipt_json, receipt_format, scope_generation)
                 SELECT 'KNOWLEDGE', ?1, op_id, '*', 1, 'knowledge-v1', fingerprint, receipt,
                        CASE WHEN json_valid(receipt)
                             THEN CASE WHEN json_extract(receipt, '$.format') = 'knowledge-receipt-v2'
                                       THEN 'knowledge-receipt-v2' ELSE 'knowledge-entry-legacy' END
                             ELSE 'knowledge-entry-legacy' END,
                        ?2
                 FROM k.knowledge_operations",
                params![db, g],
            )
            .ctx("idempotency_receipts")?;
            rebuild_knowledge_fts(&tx)?;
        }
        commit_checked(tx, "registry")?;
        Ok(gens)
    })();
    detach(t, "r");
    if src.knowledge.is_some() {
        detach(t, "k");
    }
    result
}

/// 提交前先查延迟外键：报出第一条悬空引用的表、行和指向的父表，而不只是一句「FOREIGN KEY constraint failed」。
fn commit_checked(tx: Transaction<'_>, stage: &str) -> Result<()> {
    let first: Option<(String, Option<i64>, String, i64)> = tx
        .query_row(
            "SELECT \"table\", rowid, parent, fkid FROM pragma_foreign_key_check LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    if let Some((table, rowid, parent, fkid)) = first {
        let (from, to): (String, String) = tx.query_row(
            &format!("SELECT group_concat(\"from\"), group_concat(\"to\") FROM pragma_foreign_key_list('{table}') WHERE id = ?1"),
            [fkid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        return Err(ConvertError::Mismatch(format!(
            "{stage}: dangling reference {table}({from}) rowid {} -> {parent}({to})",
            rowid.unwrap_or_default()
        )));
    }
    tx.commit()?;
    Ok(())
}

/// R7‴ 的分类结果。
struct Classified {
    class: &'static str,
    /// 能被 3.0 请求命中的类，给出新键 (ns_kind, ns_id)。
    ns: Option<(&'static str, String)>,
    promotion_quick: Option<String>,
    promotion_shaped_agent: bool,
}

fn is_ulid(s: &str) -> bool {
    s.len() == 26
        && s.bytes()
            .all(|b| b"0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(&b))
}

/// R7‴：前缀 = key 去掉末尾的 `:` + op_id；key 等于 op_id 时前缀为空。返回 None 表示 F1。
fn prefix_of<'a>(key: &'a str, op: &str) -> Option<&'a str> {
    if key == op {
        return Some("");
    }
    key.strip_suffix(op)?.strip_suffix(':')
}

struct LegacyRow {
    key: String,
    operation: String,
    op_id: Option<String>,
    actor_session_id: Option<String>,
}

fn classify(
    row: &LegacyRow,
    sessions: &HashSet<String>,
    promotion_prefixes: &HashSet<String>,
) -> std::result::Result<Classified, String> {
    let Some(op) = row.op_id.as_deref() else {
        return Err("F1: op_id is NULL".into());
    };
    let Some(prefix) = prefix_of(&row.key, op) else {
        return Err("F1: key does not end with :op_id".into());
    };
    let actor = row.actor_session_id.as_deref();
    if actor.is_some_and(|a| a != prefix) {
        return Err("F2: actor_session_id differs from the key prefix".into());
    }
    if row.operation == "session.recover-or-begin" && (prefix != "session-begin" || actor.is_some())
    {
        return Err("F3: begin receipt with a foreign prefix or a session".into());
    }
    let promotion = row.operation == "work.create.batch" && op.starts_with("promote-");
    let supplement = matches!(
        row.operation.as_str(),
        "objective.create" | "milestone.create"
    ) && (op
        .strip_prefix("objective-")
        .or_else(|| op.strip_prefix("milestone-")))
    .is_some_and(is_ulid)
        && promotion_prefixes.contains(prefix);
    let quick = if promotion {
        op.strip_prefix("promote-").map(str::to_string)
    } else {
        None
    };
    let c = |class, ns| Classified {
        class,
        ns,
        promotion_quick: quick.clone(),
        promotion_shaped_agent: false,
    };
    Ok(
        if actor.is_none() && row.operation == "session.recover-or-begin" {
            c("BEGIN", None)
        } else if prefix == "USER" {
            c("USER", Some(("ACTOR", "USER".to_string())))
        } else if prefix == "SYSTEM" || prefix == "planning-root" {
            c("SYSTEM_CONST", Some(("ACTOR", prefix.to_string())))
        } else if actor == Some(prefix) && sessions.contains(prefix) {
            Classified {
                class: "AGENT",
                ns: Some(("SESSION", prefix.to_string())),
                promotion_quick: quick.clone(),
                promotion_shaped_agent: promotion || supplement,
            }
        } else if promotion || supplement {
            c("PROMOTION_HISTORY", None)
        } else {
            c("LEGACY_UNCLASSIFIED", None)
        },
    )
}

fn convert_project(
    t: &mut Connection,
    path: &Path,
    gens: &Gens,
    report: &mut Report,
    promotions: &mut Vec<(String, String)>,
) -> Result<String> {
    attach(t, path, "p")?;
    let result = (|| {
        let tx = t.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (pid, code): (String, String) = tx.query_row(
            "SELECT project_id, project_code FROM p.project_meta",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let registered: Option<String> = tx
            .query_row(
                "SELECT code FROM main.projects WHERE id = ?1",
                [&pid],
                |r| r.get(0),
            )
            .optional()?;
        match registered {
            None => {
                return Err(ConvertError::Mismatch(format!(
                    "project database {pid} is not in the registry"
                )));
            }
            Some(c) if c != code => {
                return Err(ConvertError::Mismatch(format!(
                    "project {pid}: registry code {c}, database code {code}"
                )));
            }
            Some(_) => {}
        }
        let (generation, _) = gens.projects[&pid].clone();
        let settings: i64 = tx.query_row("SELECT count(*) FROM p.settings", [], |r| r.get(0))?;
        if settings > 0 {
            return Err(ConvertError::Unsupported(format!(
                "project {pid}: project settings must be empty"
            )));
        }
        let expiring: i64 = tx.query_row(
            "SELECT count(*) FROM p.idempotency_keys WHERE expires_at IS NOT NULL",
            [],
            |r| r.get(0),
        )?;
        if expiring > 0 {
            return Err(ConvertError::Unsupported(format!(
                "project {pid}: idempotency_keys.expires_at is set"
            )));
        }
        let (current, max_seq): (i64, i64) = tx.query_row(
            "SELECT (SELECT current_sequence FROM p.project_meta), coalesce((SELECT max(sequence) FROM p.events), 0)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if current < max_seq {
            return Err(ConvertError::Mismatch(format!(
                "project {pid}: current_sequence {current} is below its highest event {max_seq}"
            )));
        }

        // projects 行：项目库的 health / version / current_sequence / schema_version，以及整行原值。
        let (meta_cols, _) = columns(&tx, "p", "project_meta")?;
        let meta_json = format!(
            "json_object({})",
            meta_cols
                .iter()
                .map(|c| format!("'{c}', m.\"{c}\""))
                .collect::<Vec<_>>()
                .join(", ")
        );
        tx.execute(
            &format!(
                "UPDATE main.projects SET health = m.health, meta_version = m.version, project_seq = m.current_sequence,
                        legacy_schema_version = m.schema_version,
                        legacy_json = json_set(main.projects.legacy_json, '$.projectMeta', json({meta_json}))
                 FROM p.project_meta AS m WHERE main.projects.id = ?1"
            ),
            [&pid],
        )
        .ctx("projects")?;

        for table in PROJECT_COPY {
            let (cols, _) = columns(&tx, "p", table)?;
            let l = list(&cols);
            tx.execute(
                &format!(
                    "INSERT INTO main.{table} (project_id, {l}) SELECT ?1, {l} FROM p.{table}"
                ),
                [&pid],
            )
            .ctx(table)?;
        }
        normalize_project(&tx, &pid, report)?;
        report.artifact_rows += tx.query_row(
            "SELECT count(*) FROM main.artifacts WHERE project_id = ?1",
            [&pid],
            |r| r.get::<_, i64>(0),
        )?;
        tx.execute(
            "UPDATE main.artifacts SET legacy_local_path = local_path WHERE project_id = ?1",
            [&pid],
        )?;

        tx.execute(
            "INSERT INTO main.events (project_id, seq, id, type, actor_type, actor_id, session_id, aggregate_type, aggregate_id,
                                      causation_id, correlation_id, payload_json, created_at, op_id)
             SELECT ?1, sequence, id, type, actor_type, actor_id, session_id, aggregate_type, aggregate_id,
                    causation_id, correlation_id, payload_json, created_at, op_id FROM p.events",
            [&pid],
        )
        .ctx("events")?;
        tx.execute(
            "INSERT INTO main.search_docs (project_id, entity_type, entity_id, entity_key, title, body, updated_at)
             SELECT ?1, entity_type, entity_id, entity_key, title, body, updated_at FROM p.search_documents",
            [&pid],
        )
        .ctx("search_docs")?;

        convert_receipts(&tx, &pid, generation, report, promotions)?;
        report.outbox_without_event += count_outbox_without_event(&tx)?;
        let n: i64 = tx.query_row("SELECT count(*) FROM p.outbox", [], |r| r.get(0))?;
        *report.dropped.entry("project.outbox".into()).or_default() += n;
        commit_checked(tx, &format!("project {pid}"))?;
        Ok(pid)
    })();
    detach(t, "p");
    result
}

fn convert_receipts(
    tx: &Transaction<'_>,
    pid: &str,
    generation: i64,
    report: &mut Report,
    promotions: &mut Vec<(String, String)>,
) -> Result<()> {
    let sessions: HashSet<String> = tx
        .prepare("SELECT id FROM p.agent_sessions")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let rows: Vec<LegacyRow> = tx
        .prepare(
            "SELECT key, operation, op_id, actor_session_id FROM p.idempotency_keys ORDER BY key",
        )?
        .query_map([], |r| {
            Ok(LegacyRow {
                key: r.get(0)?,
                operation: r.get(1)?,
                op_id: r.get(2)?,
                actor_session_id: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    // 晋升补建形状要求同一项目里有前缀相同的晋升形状行。
    let promotion_prefixes: HashSet<String> = rows
        .iter()
        .filter(|r| {
            r.operation == "work.create.batch"
                && r.op_id
                    .as_deref()
                    .is_some_and(|o| o.starts_with("promote-"))
        })
        .filter_map(|r| prefix_of(&r.key, r.op_id.as_deref()?).map(str::to_string))
        .collect();
    for row in &rows {
        let c = match classify(row, &sessions, &promotion_prefixes) {
            Ok(c) => c,
            Err(why) => {
                report
                    .receipt_violations
                    .push(format!("project {pid} key {}: {why}", row.key));
                continue;
            }
        };
        *report
            .receipt_classes
            .entry(c.class.to_string())
            .or_default() += 1;
        if c.promotion_shaped_agent {
            report.promotion_shaped_agent += 1;
        }
        if let Some(q) = &c.promotion_quick
            && (c.class == "PROMOTION_HISTORY" || c.promotion_shaped_agent)
        {
            promotions.push((pid.to_string(), q.clone()));
        }
        let (ns_kind, ns_id, op_id) = match &c.ns {
            Some((k, id)) => (Some(*k), Some(id.as_str()), row.op_id.as_deref()),
            None => (None, None, None),
        };
        tx.execute(
            "INSERT INTO idempotency_receipts (scope_kind, scope_id, ns_kind, ns_id, op_id, legacy_key, legacy_op_id, legacy_class,
                                               actor_session_id, operation, fp_v, fp_family, fingerprint, receipt_json,
                                               scope_generation, created_at)
             SELECT 'PROJECT', ?1, ?2, ?3, ?4, key, op_id, ?5, actor_session_id, operation, 1, 'kernel-v1',
                    request_fingerprint, response_json, ?6, created_at
             FROM p.idempotency_keys WHERE key = ?7",
            params![pid, ns_kind, ns_id, op_id, c.class, generation, row.key],
        )
        .ctx("idempotency_receipts")?;
    }
    Ok(())
}

/// 未送达、而且对应事件不存在（或 payload 里没有 eventId）的 outbox 行数。只进报告。
fn count_outbox_without_event(tx: &Transaction<'_>) -> Result<usize> {
    Ok(tx.query_row(
        "SELECT count(*) FROM p.outbox o
         WHERE o.delivered_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM p.events e WHERE e.id = atm_json_text(o.payload_json, 'eventId',
                 'project ' || (SELECT project_id FROM p.project_meta) || ' outbox ' || o.id))",
        [],
        |r| r.get::<_, i64>(0),
    )? as usize)
}

/// R6 补投影：一个项目里没有全局镜像的事件，按项目内序号排列，形状与 2.0 投影相同
/// （`registry-projection-dispatcher.ts` + `outbox-read-model.ts`）：
/// - payload 是 `JSON.stringify({ ...readJson(事件 payload, {}), 项目字段 })`，由 SQL 函数
///   `atm_mirror_payload` 按 V8 的语义算出（[`crate::jsjson`]，W1 peer r2 P1-r2-01、r3 P1-r3-01 / 02），
///   与 2.0 逐字节一致；嵌套超过 [`crate::jsjson::MAX_DEPTH`] 层时报错，转换整体失败，不把内容清空。
/// - aggregate_id 为空时取项目 id；actor 取 actor_id，没有就 actor_type，再没有就 SYSTEM；
/// - dedupe_key = `project:<id>:event:<event_id>`。
///
/// 转换和 VERIFY 共用：转换时 `events` 是目标库的 `main.events`、`projects` 是 `main.projects`；
/// VERIFY 时是源项目库的 `p.events` 与源 registry 的 `r.projects`。`linked` 是已关联事件的集合
/// （`SELECT event_id ...`），`event_project` 是事件表上限定项目的条件，`?1` 是项目 id。
///
/// 返回列：seq, type, aggregate_id, actor, payload, created_at, dedupe, event_id。
fn mirror_rows(
    events: &str,
    seq: &str,
    projects: &str,
    event_project: &str,
    linked: &str,
) -> String {
    format!(
        "SELECT e.{seq} AS seq, e.type AS type, CASE WHEN e.aggregate_id = '' THEN ?1 ELSE e.aggregate_id END AS aggregate_id,
                coalesce(e.actor_id, e.actor_type, 'SYSTEM') AS actor,
                atm_mirror_payload(e.payload_json, json_object(
                    'projectId', ?1, 'projectCode', pr.code, 'projectName', pr.name,
                    'projectSequence', e.{seq}, 'sourceEventId', e.id, 'sourceProjectSequence', e.{seq},
                    'sourceAggregateType', e.aggregate_type, 'sourceAggregateId', e.aggregate_id)) AS payload,
                e.created_at AS created_at, 'project:' || ?1 || ':event:' || e.id AS dedupe, e.id AS event_id
         FROM {events} e JOIN {projects} pr ON pr.id = ?1
         WHERE {event_project} AND e.id NOT IN ({linked})
         ORDER BY e.{seq}"
    )
}

/// 转换与 VERIFY 的连接上要用的 SQL 函数。读旧 payload 一律走 [`crate::jsjson`]，不用 SQLite 的 JSON 函数
/// （W1 peer r3：它会改坏数组里的字符串和数字，也会把深层的合法 JSON 当成非法）。
/// - `atm_mirror_payload(payload, fields)`：补投影的 payload，见 [`mirror_rows`]；
/// - `atm_json_text(json, key, row)`：`JSON.parse(json)[key]`，是字符串时返回它，否则 NULL；
///   `row` 是这一行在源库里的位置（项目 + 全局序号或 outbox id），只用于报错（W1 peer r4 P2-09）。
///
/// 嵌套超过上限时两者都报错，转换或 VERIFY 失败并在错误里写明事件，不静默回退。
fn register_functions(c: &Connection) -> rusqlite::Result<()> {
    use crate::jsjson::{MAX_DEPTH, mirror_payload, top_level_string};
    use rusqlite::functions::FunctionFlags;
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC;
    c.create_scalar_function("atm_mirror_payload", 2, flags, |ctx| {
        let payload = text_arg(ctx.get_raw(0));
        let fields = text_arg(ctx.get_raw(1)).unwrap_or_default();
        mirror_payload(payload.as_deref(), &fields).map_err(|_| {
            let field = |k| {
                top_level_string(&fields, k)
                    .ok()
                    .flatten()
                    .unwrap_or_default()
            };
            too_deep(format!(
                "event {}/{}: payload nests deeper than {MAX_DEPTH} levels",
                field("projectId"),
                field("sourceEventId")
            ))
        })
    })?;
    c.create_scalar_function("atm_json_text", 3, flags, |ctx| {
        let Some(json) = text_arg(ctx.get_raw(0)) else {
            return Ok(None);
        };
        let key = text_arg(ctx.get_raw(1)).unwrap_or_default();
        top_level_string(&json, &key).map_err(|_| {
            let row = text_arg(ctx.get_raw(2)).unwrap_or_default();
            too_deep(format!(
                "{row}: payload nests deeper than {MAX_DEPTH} levels (reading {key})"
            ))
        })
    })
}

/// 2.0 用 better-sqlite3 读 TEXT，非法 UTF-8 按替换字符解码；这里同样处理。数字、NULL 按 `readJson` 的回退走。
fn text_arg(v: ValueRef<'_>) -> Option<String> {
    match v {
        ValueRef::Text(b) | ValueRef::Blob(b) => Some(String::from_utf8_lossy(b).into_owned()),
        _ => None,
    }
}

fn too_deep(message: String) -> rusqlite::Error {
    rusqlite::Error::UserFunctionError(
        format!("{message}; the converter refuses it rather than drop its content").into(),
    )
}

/// 全局流的旧行认领项目、关联事件（R6）。`?1` 项目 id，`?2` = `project:<id>:`，`?3` = `project:<id>:event:`。
/// 认领看 dedupe_key 前缀；事件先按 dedupe_key 的后缀找，找不到再按 payload 的 sourceEventId，
/// 只填项目里真有的事件。`feed` / `events` 是表名，`event_project` 是事件表上限定项目的条件。
fn link_sql(feed: &str, events: &str, event_project: &str) -> [String; 2] {
    [
        format!("UPDATE {feed} SET project_id = ?1 WHERE substr(dedupe_key, 1, length(?2)) = ?2"),
        format!(
            "UPDATE {feed} AS g SET event_id = coalesce(
               (SELECT e.id FROM {events} e WHERE {event_project}
                  AND e.id = CASE WHEN substr(g.dedupe_key, 1, length(?3)) = ?3
                                  THEN substr(g.dedupe_key, length(?3) + 1) END),
               (SELECT e.id FROM {events} e WHERE {event_project}
                  AND e.id = atm_json_text(g.payload_json, 'sourceEventId',
                        'project ' || ?1 || ' global row ' || g.global_seq || ' (' || coalesce(g.dedupe_key, '') || ')')))
             WHERE g.project_id = ?1"
        ),
    ]
}

fn finish(
    t: &mut Connection,
    gens: &Gens,
    promotions: &[(String, String)],
    report: &mut Report,
) -> Result<()> {
    let tx = t.transaction_with_behavior(TransactionBehavior::Immediate)?;
    // R6：全局流的旧行认领项目、关联事件；指向事件但事件已不存在的是孤儿。
    let [claim, link] = link_sql("main.global_feed", "main.events", "e.project_id = ?1");
    for pid in gens.projects.keys() {
        let (prefix, event_prefix) = (format!("project:{pid}:"), format!("project:{pid}:event:"));
        tx.execute(&claim, params![pid, prefix])?;
        tx.execute(&link, params![pid, prefix, event_prefix])?;
        let orphans: i64 = tx.query_row(
            "SELECT count(*) FROM global_feed WHERE substr(dedupe_key, 1, length(?1)) = ?1 AND event_id IS NULL",
            [&event_prefix],
            |r| r.get(0),
        )?;
        report.global_orphans += orphans as usize;
    }
    // R6：没有镜像的项目事件（差集，不看 outbox），按项目 id、项目内序号追加到全局流末尾。
    for pid in gens.projects.keys() {
        let rows = mirror_rows(
            "main.events",
            "seq",
            "main.projects",
            "e.project_id = ?1",
            "SELECT event_id FROM main.global_feed WHERE project_id = ?1 AND event_id IS NOT NULL",
        );
        let n = tx
            .execute(
                &format!(
                    "INSERT INTO main.global_feed (global_seq, type, aggregate_id, actor, payload_json, created_at, dedupe_key, project_id, event_id)
                     SELECT (SELECT global_seq FROM main.app_meta) + row_number() OVER (ORDER BY m.seq),
                            m.type, m.aggregate_id, m.actor, m.payload, m.created_at, m.dedupe, ?1, m.event_id
                     FROM ({rows}) AS m"
                ),
                [pid],
            )
            .ctx("global_feed")?;
        tx.execute(
            "UPDATE app_meta SET global_seq = global_seq + ?1",
            [n as i64],
        )?;
        report.mirrors_replayed += n;
    }
    // R5：quick 的晋升目标补上实体 id；解析不到的计数。
    tx.execute(
        "UPDATE quick_tasks SET promoted_work_item_id = (
           SELECT w.id FROM work_items w JOIN projects p ON p.id = w.project_id
           WHERE w.project_id = quick_tasks.promoted_project_id
             AND quick_tasks.promoted_work_item_key = p.code || '-T-' || printf('%04d', w.local_no))
         WHERE promoted_work_item_key IS NOT NULL",
        [],
    )?;
    report.unresolved_promotions = tx.query_row(
        "SELECT count(*) FROM quick_tasks WHERE promoted_work_item_key IS NOT NULL AND promoted_work_item_id IS NULL",
        [],
        |r| r.get::<_, i64>(0),
    )? as usize;
    // R7‴ 的关联状态（只进报告）。
    let mut quick: HashMap<String, (String, Option<String>)> = HashMap::new();
    {
        let mut st = tx.prepare("SELECT id, status, promoted_project_id FROM quick_tasks")?;
        for row in st.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })? {
            let (id, status, target) = row?;
            quick.insert(id, (status, target));
        }
    }
    for (pid, q) in promotions {
        let status = match quick.get(q) {
            None => "QUICK_MISSING",
            Some((s, Some(target))) if s == "PROMOTED" && target == pid => "MATCHED",
            Some((s, Some(_))) if s == "PROMOTED" => "OTHER_TARGET",
            Some(_) => "UNMARKED",
        };
        *report
            .promotion_status
            .entry(status.to_string())
            .or_default() += 1;
    }
    tx.execute(
        "UPDATE app_meta SET converted_from = json_set(converted_from, '$.mirrorsReplayed', ?1)",
        [report.mirrors_replayed as i64],
    )?;
    commit_checked(tx, "finish")?;
    let integrity: String = t.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if integrity != "ok" {
        return Err(ConvertError::Mismatch(format!(
            "target integrity_check: {integrity}"
        )));
    }
    Ok(())
}

// ===== VERIFY：规范化摘要（05 §5.1）=====

/// `D = sha256("ATM-CANON-1" ‖ 表名 ‖ 列名 ‖ u64 行数 ‖ 全部行)`，值按类型编码。返回 (行数, 摘要)。
fn digest(
    c: &Connection,
    family: &str,
    cols: &[String],
    sql: &str,
    args: &[&dyn rusqlite::ToSql],
) -> Result<(i64, String)> {
    let mut body = Sha256::new();
    let mut rows = 0i64;
    let mut st = c.prepare(sql)?;
    let n = st.column_count();
    let mut q = st.query(args)?;
    while let Some(row) = q.next()? {
        rows += 1;
        for i in 0..n {
            match row.get_ref(i)? {
                ValueRef::Null => body.update([0x00]),
                ValueRef::Integer(v) => {
                    body.update([0x01]);
                    body.update(v.to_string().as_bytes());
                    body.update([0x00]);
                }
                ValueRef::Real(v) => {
                    body.update([0x02]);
                    body.update(v.to_be_bytes());
                }
                ValueRef::Text(t) => {
                    body.update([0x03]);
                    body.update((t.len() as u32).to_be_bytes());
                    body.update(t);
                }
                ValueRef::Blob(b) => {
                    body.update([0x04]);
                    body.update((b.len() as u32).to_be_bytes());
                    body.update(b);
                }
            }
        }
    }
    let mut h = Sha256::new();
    h.update(b"ATM-CANON-1");
    h.update(family.as_bytes());
    h.update([0]);
    for col in cols {
        h.update(col.as_bytes());
        h.update([0]);
    }
    h.update((rows as u64).to_be_bytes());
    h.update(body.finalize());
    Ok((
        rows,
        h.finalize().iter().map(|b| format!("{b:02x}")).collect(),
    ))
}

#[allow(clippy::too_many_arguments)]
fn compare(
    c: &Connection,
    report: &mut Report,
    family: &str,
    cols: &[String],
    source_sql: &str,
    source_args: &[&dyn rusqlite::ToSql],
    target_sql: &str,
    target_args: &[&dyn rusqlite::ToSql],
) -> Result<()> {
    let (source_rows, source_digest) = digest(c, family, cols, source_sql, source_args)?;
    let (target_rows, target_digest) = digest(c, family, cols, target_sql, target_args)?;
    report.families.push(FamilyCheck {
        family: family.to_string(),
        source_rows,
        target_rows,
        source_digest,
        target_digest,
    });
    Ok(())
}

/// 按列名逐表比对：源 `schema.table` 与目标同名表（可选 project_id 过滤）。
fn compare_table(
    c: &Connection,
    report: &mut Report,
    schema: &str,
    table: &str,
    project: Option<&str>,
) -> Result<()> {
    let (cols, pk) = columns(c, schema, table)?;
    let l = list(&cols);
    let order = list(&pk);
    let family = match project {
        Some(p) => format!("{p}/{table}"),
        None => format!("{schema}/{table}"),
    };
    match project {
        Some(p) => compare(
            c,
            report,
            &family,
            &cols,
            &format!("SELECT {l} FROM {schema}.{table} ORDER BY {order}"),
            &[],
            &format!("SELECT {l} FROM main.{table} WHERE project_id = ?1 ORDER BY {order}"),
            &[&p],
        ),
        None => compare(
            c,
            report,
            &family,
            &cols,
            &format!("SELECT {l} FROM {schema}.{table} ORDER BY {order}"),
            &[],
            &format!("SELECT {l} FROM main.{table} ORDER BY {order}"),
            &[],
        ),
    }
}

/// 对一个已经转换好的库重做逐族比对（W3 的 VERIFY 阶段、以及测试用）。
/// `conversion` 是转换时的报告：VERIFY 独立重算规范化记录与附件，与它记下的比对。
pub fn verify_converted(target: &Path, src: &LegacySources, conversion: &Report) -> Result<Report> {
    let t = Connection::open(target)?;
    crate::configure(&t)?;
    register_functions(&t)?;
    let mut report = Report {
        normalizations: conversion.normalizations.clone(),
        attachment: conversion.attachment.clone(),
        ..Report::default()
    };
    verify(&t, src, &mut report)?;
    Ok(report)
}

/// VERIFY 从源独立重算的规则记录与附件。
#[derive(Default)]
struct Recheck {
    records: Vec<Normalization>,
    attachment: BTreeMap<String, Vec<String>>,
}

impl Recheck {
    fn push(&mut self, rule: &str, family: &str, keys: Vec<String>) {
        self.records.push(record(rule, family, keys));
    }

    fn attach(&mut self, family: String, rows: Vec<String>) {
        if !rows.is_empty() {
            self.attachment.insert(family, rows);
        }
    }

    /// 与转换记下的逐条比对；不一致的写进 `rule_mismatches`（只写规则、族、计数与摘要前缀，不写正文）。
    fn settle(self, report: &mut Report) {
        type Key = (String, String);
        let index = |v: &[Normalization]| -> BTreeMap<Key, (i64, String)> {
            v.iter()
                .map(|n| {
                    (
                        (n.rule.clone(), n.family.clone()),
                        (n.count, n.keys_digest.clone()),
                    )
                })
                .collect()
        };
        let (ours, theirs) = (index(&self.records), index(&report.normalizations));
        let show = |n: Option<&(i64, String)>| {
            n.map_or("missing".to_string(), |(c, d)| format!("{c} {}", &d[..12]))
        };
        let keys: std::collections::BTreeSet<&Key> = ours.keys().chain(theirs.keys()).collect();
        for k in keys {
            if ours.get(k) != theirs.get(k) {
                report.rule_mismatches.push(format!(
                    "{} {}: converted {}, verify {}",
                    k.0,
                    k.1,
                    show(theirs.get(k)),
                    show(ours.get(k))
                ));
            }
        }
        let families: std::collections::BTreeSet<&String> = self
            .attachment
            .keys()
            .chain(report.attachment.keys())
            .collect();
        let mut wrong = Vec::new();
        for f in families {
            let (a, b) = (self.attachment.get(f), report.attachment.get(f));
            if a != b {
                wrong.push(format!(
                    "attachment {f}: converted {} rows, verify {} rows",
                    b.map_or(0, Vec::len),
                    a.map_or(0, Vec::len)
                ));
            }
        }
        report.rule_mismatches.extend(wrong);
    }
}

fn verify(t: &Connection, src: &LegacySources, report: &mut Report) -> Result<()> {
    attach(t, &src.registry, "r")?;
    let mut re = Recheck::default();
    let r = (|| {
        verify_registry(t, report, &mut re)?;
        expect_global_begin(t)?;
        if let Some(k) = &src.knowledge {
            attach(t, k, "k")?;
            let r = verify_knowledge(t, report);
            detach(t, "k");
            r?;
        }
        for p in &src.projects {
            attach(t, p, "p")?;
            let r = verify_project(t, report, &mut re).and_then(|()| expect_global_project(t));
            detach(t, "p");
            r?;
        }
        verify_global(t, report)
    })();
    if r.is_ok() {
        re.settle(report);
    }
    let _ = t.execute_batch(
        "DROP TABLE IF EXISTS temp.expected_links; DROP TABLE IF EXISTS temp.expected_mirrors;",
    );
    detach(t, "r");
    r
}

/// R6 的 VERIFY：全局流的预期由源库独立算出，不看转换器记下的计数。
/// `expected_links` 是旧行该有的项目与事件关联；`expected_mirrors` 是该补的镜像。
fn expect_global_begin(c: &Connection) -> Result<()> {
    c.execute_batch(
        "DROP TABLE IF EXISTS temp.expected_links; DROP TABLE IF EXISTS temp.expected_mirrors;
         CREATE TEMP TABLE expected_links (global_seq INTEGER PRIMARY KEY, dedupe_key TEXT, payload_json TEXT,
                                           project_id TEXT, event_id TEXT);
         INSERT INTO temp.expected_links SELECT sequence, dedupe_key, payload_json, NULL, NULL FROM r.global_events;
         CREATE TEMP TABLE expected_mirrors (project_id TEXT NOT NULL, seq INTEGER NOT NULL, type, aggregate_id, actor,
                                             payload, created_at, dedupe, event_id, PRIMARY KEY (project_id, seq));",
    )?;
    Ok(())
}

/// 一个源项目（挂在 `p`）对全局流的预期：旧行的关联，以及没有镜像的事件。
fn expect_global_project(c: &Connection) -> Result<()> {
    let pid: String = c.query_row("SELECT project_id FROM p.project_meta", [], |r| r.get(0))?;
    let (prefix, event_prefix) = (format!("project:{pid}:"), format!("project:{pid}:event:"));
    let [claim, link] = link_sql("temp.expected_links", "p.events", "1");
    c.execute(&claim, params![pid, prefix])?;
    c.execute(&link, params![pid, prefix, event_prefix])?;
    let rows = mirror_rows(
        "p.events",
        "sequence",
        "r.projects",
        "1",
        "SELECT event_id FROM temp.expected_links WHERE project_id = ?1 AND event_id IS NOT NULL",
    );
    c.execute(
        &format!(
            "INSERT INTO temp.expected_mirrors
             SELECT ?1, m.seq, m.type, m.aggregate_id, m.actor, m.payload, m.created_at, m.dedupe, m.event_id FROM ({rows}) AS m"
        ),
        [&pid],
    )?;
    Ok(())
}

fn verify_global(c: &Connection, report: &mut Report) -> Result<()> {
    let baseline: i64 = c.query_row("SELECT current_sequence FROM r.app_meta", [], |r| r.get(0))?;
    compare(
        c,
        report,
        "r/global_feed.links",
        &["global_seq", "project_id", "event_id"].map(String::from),
        "SELECT global_seq, project_id, event_id FROM temp.expected_links ORDER BY global_seq",
        &[],
        "SELECT global_seq, project_id, event_id FROM main.global_feed WHERE global_seq <= ?1 ORDER BY global_seq",
        &[&baseline],
    )?;
    compare(
        c,
        report,
        "r/global_feed.replayed",
        &[
            "global_seq",
            "type",
            "aggregate_id",
            "actor",
            "payload_json",
            "created_at",
            "dedupe_key",
            "project_id",
            "event_id",
            "undone_by_restore_gen",
        ]
        .map(String::from),
        "SELECT ?1 + row_number() OVER (ORDER BY project_id, seq), type, aggregate_id, actor, payload, created_at,
                dedupe, project_id, event_id, NULL
         FROM temp.expected_mirrors ORDER BY project_id, seq",
        &[&baseline],
        "SELECT global_seq, type, aggregate_id, actor, payload_json, created_at, dedupe_key, project_id, event_id,
                undone_by_restore_gen
         FROM main.global_feed WHERE global_seq > ?1 ORDER BY global_seq",
        &[&baseline],
    )?;
    // 高水位 = 源高水位 + 应补条数；converted_from 里的两个数也要对得上。
    compare(
        c,
        report,
        "r/app_meta.global_seq",
        &["global_seq", "mirrors_replayed", "source_current_sequence"].map(String::from),
        "SELECT ?1 + count(*), count(*), ?1 FROM temp.expected_mirrors",
        &[&baseline],
        "SELECT global_seq, converted_from ->> '$.mirrorsReplayed', converted_from ->> '$.sourceCurrentSequence'
         FROM main.app_meta",
        &[],
    )?;
    Ok(())
}

fn verify_registry(c: &Connection, report: &mut Report, re: &mut Recheck) -> Result<()> {
    let (cols, _) = columns(c, "r", "projects")?;
    let source = list(&cols);
    let target = cols
        .iter()
        .map(|col| {
            if col == "db_path" {
                "legacy_json ->> '$.registryDbPath'".to_string()
            } else if col == "archived_at" {
                // 04 C-L15：3.0 删了这一列，原值放在 legacy_json 里。
                "legacy_json ->> '$.archivedAt'".to_string()
            } else {
                format!("\"{col}\"")
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    compare(
        c,
        report,
        "r/projects",
        &cols,
        &format!("SELECT {source} FROM r.projects ORDER BY id"),
        &[],
        &format!("SELECT {target} FROM main.projects ORDER BY id"),
        &[],
    )?;
    for table in REGISTRY_COPY.iter().filter(|t| **t != "settings") {
        compare_table(c, report, "r", table, None)?;
    }
    verify_settings(c, report, re)?;
    // 按 2.x 的列比较。3.0 多出来的 path_key 在转换时由 canonical_path 推出，靠唯一约束兜底。
    compare_table(c, report, "r", "project_paths", None)?;
    let baseline: i64 = c.query_row("SELECT current_sequence FROM r.app_meta", [], |r| r.get(0))?;
    let cols: Vec<String> = [
        "sequence",
        "type",
        "aggregate_id",
        "actor",
        "payload_json",
        "created_at",
        "dedupe_key",
    ]
    .map(String::from)
    .to_vec();
    compare(
        c,
        report,
        "r/global_events",
        &cols,
        "SELECT sequence, type, aggregate_id, actor, payload_json, created_at, dedupe_key FROM r.global_events ORDER BY sequence",
        &[],
        "SELECT global_seq, type, aggregate_id, actor, payload_json, created_at, dedupe_key FROM main.global_feed
         WHERE global_seq <= ?1 ORDER BY global_seq",
        &[&baseline],
    )?;
    let cols: Vec<String> = [
        "id",
        "scope",
        "project_id",
        "path",
        "sha256",
        "size_bytes",
        "reason",
        "schema_version",
        "created_at",
        "verified_at",
    ]
    .map(String::from)
    .to_vec();
    compare(
        c,
        report,
        "r/backup_catalog",
        &cols,
        "SELECT id, scope, project_id, path, sha256, size_bytes, reason, schema_version, created_at, verified_at
         FROM r.backup_catalog ORDER BY id",
        &[],
        "SELECT id, scope, project_id, legacy_path, sha256, size_bytes, reason, schema_version, created_at, verified_at
         FROM main.legacy_backups WHERE source = 'CATALOG' ORDER BY id",
        &[],
    )
}

fn verify_knowledge(c: &Connection, report: &mut Report) -> Result<()> {
    compare_table(c, report, "k", "knowledge_meta", None)?;
    compare_table(c, report, "k", "knowledge_entries", None)?;
    compare_table(c, report, "k", "knowledge_revisions", None)?;
    let cols: Vec<String> = ["op_id", "fingerprint", "receipt"]
        .map(String::from)
        .to_vec();
    compare(
        c,
        report,
        "k/knowledge_operations",
        &cols,
        "SELECT op_id, fingerprint, receipt FROM k.knowledge_operations ORDER BY op_id",
        &[],
        "SELECT legacy_key, fingerprint, receipt_json FROM main.idempotency_receipts WHERE scope_kind = 'KNOWLEDGE' ORDER BY legacy_key",
        &[],
    )
}

fn verify_project(c: &Connection, report: &mut Report, re: &mut Recheck) -> Result<()> {
    let pid: String = c.query_row("SELECT project_id FROM p.project_meta", [], |r| r.get(0))?;
    let p = pid.as_str();
    // project_meta：整行原值在 legacy_json 里；3.0 的派生列必须与它一致。
    let (cols, _) = columns(c, "p", "project_meta")?;
    let source = list(&cols);
    let target = cols
        .iter()
        .map(|col| format!("legacy_json -> '$.projectMeta' ->> '$.{col}'"))
        .collect::<Vec<_>>()
        .join(", ");
    compare(
        c,
        report,
        &format!("{p}/project_meta"),
        &cols,
        &format!("SELECT {source} FROM p.project_meta"),
        &[],
        &format!("SELECT {target} FROM main.projects WHERE id = ?1"),
        &[&p],
    )?;
    let derived: Vec<String> = ["health", "version", "current_sequence", "schema_version"]
        .map(String::from)
        .to_vec();
    compare(
        c,
        report,
        &format!("{p}/project_meta(derived)"),
        &derived,
        "SELECT health, version, current_sequence, schema_version FROM p.project_meta",
        &[],
        "SELECT health, meta_version, project_seq, legacy_schema_version FROM main.projects WHERE id = ?1",
        &[&p],
    )?;
    for table in PROJECT_COPY {
        compare_table(c, report, "p", table, Some(p))?;
    }
    verify_rules(c, report, re, p)?;
    let (cols, _) = columns(c, "p", "events")?;
    let source = list(&cols);
    let target = cols
        .iter()
        .map(|col| {
            if col == "sequence" {
                "seq".to_string()
            } else {
                format!("\"{col}\"")
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    compare(
        c,
        report,
        &format!("{p}/events"),
        &cols,
        &format!("SELECT {source} FROM p.events ORDER BY sequence"),
        &[],
        &format!("SELECT {target} FROM main.events WHERE project_id = ?1 ORDER BY seq"),
        &[&p],
    )?;
    let cols: Vec<String> = [
        "key",
        "operation",
        "request_fingerprint",
        "response_json",
        "created_at",
        "expires_at",
        "op_id",
        "actor_session_id",
    ]
    .map(String::from)
    .to_vec();
    compare(
        c,
        report,
        &format!("{p}/idempotency_keys"),
        &cols,
        "SELECT key, operation, request_fingerprint, response_json, created_at, expires_at, op_id, actor_session_id
         FROM p.idempotency_keys ORDER BY key",
        &[],
        "SELECT legacy_key, operation, fingerprint, receipt_json, created_at, NULL, legacy_op_id, actor_session_id
         FROM main.idempotency_receipts WHERE scope_kind = 'PROJECT' AND scope_id = ?1 ORDER BY legacy_key",
        &[&p],
    )?;
    let cols: Vec<String> = [
        "entity_type",
        "entity_id",
        "entity_key",
        "title",
        "body",
        "updated_at",
    ]
    .map(String::from)
    .to_vec();
    compare(
        c,
        report,
        &format!("{p}/search_documents"),
        &cols,
        "SELECT entity_type, entity_id, entity_key, title, body, updated_at FROM p.search_documents ORDER BY entity_type, entity_id",
        &[],
        "SELECT entity_type, entity_id, entity_key, title, body, updated_at FROM main.search_docs WHERE project_id = ?1
         ORDER BY entity_type, entity_id",
        &[&p],
    )
}

// ===== VERIFY：规范化规则的独立重算（store/NORMALIZATION.md）=====
// 这里的 SQL 与转换写入的那一份分开写：同一条规则由两段代码各自表述，互相核对。

/// N-04：registry settings 的期望目标由源按 2.x 读法推出，与目标逐行比对；受影响的键另算一份。
fn verify_settings(c: &Connection, report: &mut Report, re: &mut Recheck) -> Result<()> {
    let cols: Vec<String> = ["key", "value_json", "version", "updated_at"]
        .map(String::from)
        .to_vec();
    let expected = "WITH e AS (SELECT value_json AS v, version, updated_at FROM r.settings WHERE key = 'notification.enabled'),
              m AS (SELECT value_json AS v, version, updated_at FROM r.settings WHERE key = 'notification.mode'),
              ok AS (SELECT CASE WHEN json_valid(v) AND json_type(v) = 'text' AND (v ->> '$') IN ('ALL', 'CRITICAL', 'OFF')
                                 THEN 1 ELSE 0 END AS valid FROM m),
              derived AS (SELECT coalesce((SELECT CASE WHEN json_valid(v) AND json_type(v) = 'false' THEN '\"OFF\"' END FROM e),
                                          '\"ALL\"') AS d)
         SELECT key, value_json, version, updated_at FROM r.settings
           WHERE key NOT IN ('notification.enabled', 'notification.mode')
         UNION ALL
         SELECT 'notification.mode', iif((SELECT valid FROM ok) = 1, m.v, (SELECT d FROM derived)), m.version, m.updated_at FROM m
         UNION ALL
         SELECT 'notification.mode', (SELECT d FROM derived), e.version, e.updated_at FROM e
           WHERE NOT EXISTS (SELECT 1 FROM m)
         ORDER BY 1";
    compare(
        c,
        report,
        "r/settings",
        &cols,
        expected,
        &[],
        "SELECT key, value_json, version, updated_at FROM main.settings ORDER BY key",
        &[],
    )?;
    let keys = key_list(
        c,
        "SELECT key FROM r.settings WHERE key = 'notification.enabled'
         UNION
         SELECT 'notification.mode' FROM r.settings
           WHERE key = 'notification.enabled' AND NOT EXISTS (SELECT 1 FROM r.settings WHERE key = 'notification.mode')
         UNION
         SELECT key FROM r.settings WHERE key = 'notification.mode'
           AND NOT (json_valid(value_json) AND json_type(value_json) = 'text' AND (value_json ->> '$') IN ('ALL', 'CRITICAL', 'OFF'))",
    )?;
    re.push(N04, "r/settings", keys);
    Ok(())
}

/// 项目里的 N-01、N-02、N-05：work_items 与关系的期望目标、规则主键集合与附件，都从源另算。
fn verify_rules(c: &Connection, report: &mut Report, re: &mut Recheck, p: &str) -> Result<()> {
    let family = |table: &str| format!("{p}/{table}");
    // work_items：目标 schema 没有的列即 N-02 舍弃的列，必须恰好是登记的三列。
    let (source_cols, pk) = columns(c, "p", "work_items")?;
    let (target_cols, _) = columns(c, "main", "work_items")?;
    let missing: Vec<&String> = source_cols
        .iter()
        .filter(|col| !target_cols.contains(col))
        .collect();
    let mut registered: Vec<&str> = N02_COLUMNS.iter().map(|(_, col, _)| *col).collect();
    registered.sort_unstable();
    let mut missing_names: Vec<&str> = missing.iter().map(|s| s.as_str()).collect();
    missing_names.sort_unstable();
    if missing_names != registered {
        report.rule_mismatches.push(format!(
            "{}: columns not carried over {missing_names:?}, registered {registered:?}",
            family("work_items")
        ));
    }
    let cols: Vec<String> = source_cols
        .iter()
        .filter(|col| target_cols.contains(col))
        .cloned()
        .collect();
    let source = cols
        .iter()
        .map(|col| match col.as_str() {
            "claimed_by_session_id" | "claim_lease_until" => {
                format!("iif(status = 'DONE' OR status = 'CANCELLED', NULL, \"{col}\")")
            }
            _ => format!("\"{col}\""),
        })
        .collect::<Vec<_>>()
        .join(", ");
    let order = list(&pk);
    compare(
        c,
        report,
        &family("work_items"),
        &cols,
        &format!("SELECT {source} FROM p.work_items ORDER BY {order}"),
        &[],
        &format!(
            "SELECT {} FROM main.work_items WHERE project_id = ?1 ORDER BY {order}",
            list(&cols)
        ),
        &[&p],
    )?;
    re.push(
        N01,
        &family("work_items"),
        key_list(
            c,
            "SELECT id FROM p.work_items
             WHERE NOT (claimed_by_session_id IS NULL AND claim_lease_until IS NULL)
               AND (status = 'CANCELLED' OR status = 'DONE')",
        )?,
    );
    for (rule, col, predicate) in [
        ("N-02a@1", "archived_at", "archived_at NOT NULL"),
        ("N-02b@1", "phase_inferred", "phase_inferred IS NOT 0"),
        (
            "N-02c@1",
            "planned_start_date",
            "planned_start_date NOT NULL",
        ),
    ] {
        let f = format!("{}.{col}", family("work_items"));
        re.push(
            rule,
            &f,
            key_list(c, &format!("SELECT id FROM p.work_items WHERE {predicate}"))?,
        );
        re.attach(
            f,
            key_list(
                c,
                &format!(
                    "SELECT json_object('id', id, 'value', \"{col}\") FROM p.work_items WHERE {predicate} ORDER BY id"
                ),
            )?,
        );
    }

    // work_item_relations：目标只有 BLOCKS 与 DISCOVERED_FROM；其余是 N-02f 的附件。
    let (cols, pk) = columns(c, "p", "work_item_relations")?;
    let (l, order) = (list(&cols), list(&pk));
    compare(
        c,
        report,
        &family("work_item_relations"),
        &cols,
        &format!(
            "SELECT {l} FROM p.work_item_relations
             WHERE relation_type = 'BLOCKS' OR relation_type = 'DISCOVERED_FROM' ORDER BY {order}"
        ),
        &[],
        &format!("SELECT {l} FROM main.work_item_relations WHERE project_id = ?1 ORDER BY {order}"),
        &[&p],
    )?;
    let other = "FROM p.work_item_relations WHERE NOT (relation_type = 'BLOCKS' OR relation_type = 'DISCOVERED_FROM')";
    re.push(
        N02F,
        &family("work_item_relations"),
        key_list(
            c,
            &format!("SELECT source_id, target_id, relation_type {other}"),
        )?,
    );
    re.attach(
        family("work_item_relations"),
        key_list(
            c,
            &format!(
                "SELECT {} {other} ORDER BY {order}",
                row_json(c, "p", "work_item_relations")?
            ),
        )?,
    );

    // labels、work_item_labels：目标不建，附件是整表。
    for (rule, table) in [("N-02d@1", "labels"), ("N-02e@1", "work_item_labels")] {
        let (_, pk) = columns(c, "p", table)?;
        let order = list(&pk);
        re.push(
            rule,
            &family(table),
            key_list(c, &format!("SELECT {order} FROM p.{table}"))?,
        );
        re.attach(
            family(table),
            key_list(
                c,
                &format!(
                    "SELECT {} FROM p.{table} ORDER BY {order}",
                    row_json(c, "p", table)?
                ),
            )?,
        );
    }

    // N-05：每个原因单独一条谓词。
    for (reason, predicate) in [
        ("CROSS_AGENT", "a.agent_id <> b.agent_id"),
        ("CROSS_ROLE", "a.agent_id = b.agent_id AND a.role <> b.role"),
        (
            "TIME_REVERSED",
            "a.agent_id = b.agent_id AND a.role = b.role AND a.started_at < b.started_at",
        ),
        (
            "SAME_INSTANT",
            "a.agent_id = b.agent_id AND a.role = b.role AND a.started_at = b.started_at",
        ),
    ] {
        re.push(
            &format!("{N05}:{reason}"),
            &family("agent_sessions"),
            key_list(
                c,
                &format!(
                    "SELECT a.id FROM p.agent_sessions a, p.agent_sessions b
                     WHERE b.id = a.predecessor_session_id AND {predicate}"
                ),
            )?,
        );
    }
    Ok(())
}
