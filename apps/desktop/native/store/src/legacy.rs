//! 2.x → 3.0 转换原型（W1f；05 §3、10 R6 / R7‴）。
//!
//! 输入是 2.x 的 registry、knowledge、各项目库，或者整个数据根（[`LegacySources::from_root`]，附件、manifest、
//! 备份文件与 R / X 类路径一并处理，见 `store/REPORT.md`），输出是一个新的单库与目标旁的附件目录。
//! 规则：
//! - 源文件本身不打开：每个库先复制成工作副本（db 与 `-wal`），WAL 在副本里恢复，旧 schema 在副本上按 2.0 runner
//!   补迁移；来源证明（源 sha256、原有迁移、补跑的迁移）进报告与 `app_meta.converted_from`（W3b3）；
//! - id、序号、JSON 原文逐值保留；2.x 有、3.0 结构里放不下的原值（`projects.db_path`、整行 `project_meta`、
//!   回执的原 op_id 与分类）存进专门的 legacy 列，VERIFY 用它们反投影；
//! - 迁移历史必须是转换器认得的（名字与 hash 逐个核对，比转换器新的拒绝），出现未登记的表即拒绝；
//! - 进行中的生命周期（CREATING / RESTORING / MIGRATION_FAILED）按数据根落定（W3b6，`legacy/settle.rs`），没给数据根时拒绝；
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

mod families;
mod jsonfiles;
mod migrations;
mod root;
mod settle;
pub use families::{Decision, FAMILIES, FTS_SHADOWS, FamilySpec, Home};
pub use migrations::{LegacyMigration, MIGRATIONS};

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
    /// 2.0 数据根。给出时，数据根下的文件族（附件、manifest、备份文件、R / X 类路径）一并处理（W3b4）；
    /// 不给时只转三类库，这些族在 [`Report::pending`] 里。
    pub root: Option<PathBuf>,
}

impl LegacySources {
    /// 按数据根取三类源库：`registry/registry.sqlite`、`knowledge/knowledge.sqlite`（可以没有）、
    /// `projects/<id>/project.sqlite`。
    pub fn from_root(root: &Path) -> Result<LegacySources> {
        root::sources_from_root(root)
    }
}

#[derive(Clone, Debug)]
pub struct ConvertOptions<'a> {
    pub at: &'a str,
    /// 允许读取真实数据根。只有用户单独授权的真实数据转换才会打开它。
    pub allow_real_data_root: bool,
    /// 真实数据根的位置；`None` 取 [`real_data_root`]。测试用它指向一个假的根，不必改进程环境。
    pub real_data_root: Option<&'a Path>,
    /// 新库的 generation（07 S4 / S5：由转换状态机分配并写进 `M`）；`None` 时随机生成。
    pub generation: Option<&'a str>,
    /// `sync/secrets.dpapi.json` 的 DPAPI 自检（05 §3.4）：宿主拿文件内容试着解密，只回答成功与否。
    /// 存储包不碰 DPAPI；数据根里有这个文件而这里是 `None` 时转换停。
    pub secrets_check: Option<fn(&[u8]) -> bool>,
    /// 05 §4.1 `migrate --accept-unconvertible <code>`：用户显式点名、2.0 的重试也救不回来的 MIGRATION_FAILED 项目，
    /// 按「舍弃」处理——项目进回收站且没有数据，原库登记进 `legacy_backups`（`UNCONVERTIBLE_PROJECT`）。
    /// 点名的项目码没有对应的 MIGRATION_FAILED 项目时转换停（不让拼错的码被悄悄忽略）。
    pub accept_unconvertible: &'a [&'a str],
    /// 原始数据根（W3d）：`src.root` 是 SNAPSHOT 复制出的快照时，登记与改写的路径（备份、附件的 `local_path`、
    /// CREATING 落定的 `db_path`）仍指向原始根；X 类的备份不进快照，直接在原始根里只读登记。`None` 时就是 `src.root`。
    pub origin_root: Option<&'a Path>,
}

/// 密文在动目标之前自检：解不开说明换了 Windows 账户或机器，手机配对要重做，由用户决定（05 §3.4）。
fn check_secrets(root: &Path, opts: &ConvertOptions<'_>) -> Result<()> {
    let path = root.join("sync").join("secrets.dpapi.json");
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    match opts.secrets_check {
        None => Err(ConvertError::Unsupported(format!(
            "{}: sync/secrets.dpapi.json needs the host's DPAPI self-check (ConvertOptions::secrets_check)",
            root.display()
        ))),
        Some(check) if !check(&bytes) => Err(ConvertError::Unsupported(format!(
            "{}: sync/secrets.dpapi.json does not decrypt for this Windows account; phone pairing must be redone",
            root.display()
        ))),
        Some(_) => Ok(()),
    }
}

/// 2.x 的真实数据根：`%LOCALAPPDATA%\AyanamiTaskManager`。
pub fn real_data_root() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|l| PathBuf::from(l).join("AyanamiTaskManager"))
}

/// 一项检查：源与目标反投影的规范化摘要比对（05 §5.1）。归属 `scope` 范围里名为 `spec` 的族。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FamilyCheck {
    /// 检查名，`<范围>/<表>[.<方面>]`；失败时就是 `failures()` 里的那一条。
    pub family: String,
    /// 所属族名（[`FamilySpec::name`]）。
    pub spec: &'static str,
    /// `r`、`k` 或项目 id。
    pub scope: String,
    pub source_rows: i64,
    pub target_rows: i64,
    pub source_digest: String,
    pub target_digest: String,
    /// 摘要不等时逐行比对的结果：只在源、只在目标、内容不同的行数之和。相等时为 0。
    pub errors: i64,
    /// 第一处不一致：检查名 + 主键列的值，不含正文。
    pub first_failure_locator: Option<String>,
}

impl FamilyCheck {
    pub fn ok(&self) -> bool {
        self.source_rows == self.target_rows && self.source_digest == self.target_digest
    }
}

/// 一个 DB 族的源摘要：主源表全部列按主键排序（05 §5.1 的 `D(t)`，`business_digest` 用同一份）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceDigest {
    pub spec: &'static str,
    pub scope: String,
    /// DB 族是行数；文件族是文件数。
    pub rows: i64,
    /// 规范化摘要；只登记数量的 R / X 类文件族为空。
    pub digest: String,
    /// 文件族的总字节数。
    pub bytes: Option<i64>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Report {
    pub checks: Vec<FamilyCheck>,
    /// 每个 DB 族实例的源摘要（含舍弃与重建的族）。
    pub sources: Vec<SourceDigest>,
    /// VERIFY 看过的项目，按源给出的顺序。
    pub projects: Vec<String>,
    /// 有没有知识库。
    pub knowledge: bool,
    /// 是否按数据根处理了文件族（W3b4）。
    pub root: bool,
    /// 每个源库的来源证明（W3b3），也写进 `app_meta.converted_from.sources`。
    pub provenance: Vec<SourceProvenance>,
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
    /// VERIFY 独立重算的规则记录或附件与转换记下的不一致。
    pub rule_mismatches: Vec<String>,
    /// 业务图的停级违例（05 §3.3）：review 绑定、handoff 检查点、session 与 records 的环、计数器高水位、
    /// 回执里的序号、status 与 phase 的对应。每条带项目与主键，不含正文。
    pub graph_violations: Vec<String>,
    /// 信息项（05 §3.1–§3.3）：不停，只进报告。0015 投影重算不一致、SUPERSEDED 没有 ACTIVE 的替代、
    /// 知识修订号不连续、晋升的快任务与任务的 source_quick_id 对不上。
    pub notes: Vec<String>,
    /// 进行中文件事务的落定（W3b6；05 §4.1），按 2.0 启动恢复的顺序：知识库、CREATING / RESTORING（按 id）、
    /// MIGRATION_FAILED（按 code）。
    pub settlements: Vec<Settlement>,
    /// 用户点名舍弃的项目码（[`ConvertOptions::accept_unconvertible`]），独立 VERIFY 按它重做落定。
    pub accepted_unconvertible: Vec<String>,
    /// 原始数据根（[`ConvertOptions::origin_root`]），独立 VERIFY 按它重做落定。
    pub origin_root: Option<PathBuf>,
}

/// 一项落定：范围（`k` 或项目 id）、落定前后的状态与依据。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Settlement {
    pub scope: String,
    pub was: String,
    pub now: String,
    pub how: String,
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
            .checks
            .iter()
            .filter(|f| !f.ok())
            .map(|f| f.family.clone())
            .collect();
        out.extend(self.receipt_violations.iter().cloned());
        out.extend(self.rule_mismatches.iter().cloned());
        out.extend(self.graph_violations.iter().cloned());
        out.extend(self.uncovered());
        out
    }

    /// 尚未实现的族实例（`<范围>/<族名>: <负责任务>`）。W3d 的提交门要求为空。
    pub fn pending(&self) -> Vec<String> {
        self.instances()
            .into_iter()
            .filter_map(|(scope, f)| {
                self.pending_of(f)
                    .map(|w| format!("{scope}/{}: {w}", f.name))
            })
            .collect()
    }

    /// 回滚检测用的业务摘要（05 §5.2「纳入」的对象族；07 §3 VERIFY 写进 `M`，§6 重算比较）：
    /// `<范围>/<族名>` → 摘要。就是 VERIFY 的源摘要（同一套规范化），只取族表里 `business_digest` 为真的族；
    /// 只登记数量的 R / X 类、F7 与重建的索引不在里面。
    pub fn business_digest(&self) -> BTreeMap<String, String> {
        self.sources
            .iter()
            .filter_map(|s| {
                let homes: &[Home] = match s.scope.as_str() {
                    "r" => &[Home::Registry],
                    "k" => &[Home::Knowledge],
                    "root" => &[Home::Root],
                    _ => &[Home::Project, Home::ProjectDir],
                };
                let f = homes.iter().find_map(|h| families::spec(*h, s.spec))?;
                f.business_digest
                    .then(|| (format!("{}/{}", s.scope, s.spec), s.digest.clone()))
            })
            .collect()
    }

    /// 登记路径用的根：给了原始根就是它，否则是读取用的根。
    pub(crate) fn origin<'a>(&'a self, root: &'a Path) -> &'a Path {
        self.origin_root.as_deref().unwrap_or(root)
    }

    /// 一个族为什么还没处理：尚未实现的子任务，或文件族没给数据根。
    fn pending_of(&self, f: &FamilySpec) -> Option<&'static str> {
        let file = matches!(f.home, Home::Root | Home::ProjectDir);
        f.pending
            .or((file && !self.root).then_some("needs the data root"))
    }

    /// 覆盖缺口：转换、重建、登记的 DB 族实例至少要有一项检查，没有的记 `<族实例>: no check ran`；
    /// 给了数据根时项目目录里的文件族和数据根下转换的文件族（F1–F6）也一样。
    /// 由 `checks` 现算，计入 [`Report::failures`]；尚未实现（pending）的族不算。
    pub fn uncovered(&self) -> Vec<String> {
        self.instances()
            .into_iter()
            .filter(|(_, f)| {
                f.pending.is_none()
                    && f.decision != Decision::Dropped
                    && (matches!(f.home, Home::Registry | Home::Knowledge | Home::Project)
                        || (self.root && f.home == Home::ProjectDir)
                        || (self.root && f.home == Home::Root && f.decision == Decision::Converted))
            })
            .filter(|(scope, f)| {
                !self
                    .checks
                    .iter()
                    .any(|c| &c.scope == scope && c.spec == f.name)
            })
            .map(|(scope, f)| format!("{scope}/{}: no check ran", f.name))
            .collect()
    }

    /// 某个 DB 族实例的源摘要。
    pub fn source(&self, family: &str) -> Option<&SourceDigest> {
        self.sources
            .iter()
            .find(|s| format!("{}/{}", s.scope, s.spec) == family)
    }

    /// 报告里的全部族实例：registry 与数据根各一份，知识库有就一份，每个项目一份。
    fn instances(&self) -> Vec<(String, &'static FamilySpec)> {
        let mut out = Vec::new();
        for f in FAMILIES {
            let scopes: Vec<String> = match f.home {
                Home::Registry => vec!["r".into()],
                Home::Knowledge if self.knowledge => vec!["k".into()],
                Home::Knowledge => vec![],
                Home::Project | Home::ProjectDir => self.projects.clone(),
                Home::Root => vec!["root".into()],
            };
            out.extend(scopes.into_iter().map(|s| (s, f)));
        }
        out
    }

    /// 05 §3.4 的机器可读报告（`staging\<g>\report.json`）：逐族的源、目标、决定与检查，
    /// 加上规则记录与回执分类。只含表名、主键、计数与摘要，不含正文与密钥；附件另见 [`Report::attachment_jsonl`]。
    pub fn report_json(&self) -> String {
        let s = |v: &str| json_string(v);
        let opt = |v: Option<&str>| v.map_or("null".to_string(), json_string);
        let mut families = Vec::new();
        for (scope, f) in self.instances() {
            let name = format!("{scope}/{}", f.name);
            let checks: Vec<&FamilyCheck> = self
                .checks
                .iter()
                .filter(|c| c.scope == scope && c.spec == f.name)
                .collect();
            let source = self.source(&name);
            let primary = checks.iter().find(|c| c.family == name);
            let is_db = matches!(f.home, Home::Registry | Home::Knowledge | Home::Project);
            let (src_key, tgt_key) = if is_db {
                ("rows", "table")
            } else {
                ("files", "dir")
            };
            let check_list: Vec<String> = checks
                .iter()
                .map(|c| {
                    format!(
                        "{{\"name\":{},\"result\":{},\"errors\":{},\"first_failure_locator\":{}}}",
                        s(&c.family),
                        s(if c.ok() { "PASS" } else { "FAIL" }),
                        c.errors,
                        opt(c.first_failure_locator.as_deref())
                    )
                })
                .collect();
            families.push(format!(
                "{{\"code\":{},\"family\":{},\"decision\":{},\"drop_reason\":{},\"business_digest\":{},\"pending\":{},\
                 \"source\":{{\"path_class\":{},\"{src_key}\":{},\"bytes\":{},\"digest\":{}}},\
                 \"target\":{{\"{tgt_key}\":{},\"rows\":{},\"digest\":{}}},\"checks\":[{}]}}",
                s(f.code),
                s(&name),
                s(f.decision.as_str()),
                opt(f.drop_reason),
                f.business_digest,
                opt(self.pending_of(f)),
                s(f.path_class),
                source.map_or("null".to_string(), |x| x.rows.to_string()),
                source
                    .and_then(|x| x.bytes)
                    .map_or("null".to_string(), |b| b.to_string()),
                opt(source.map(|x| x.digest.as_str()).filter(|d| !d.is_empty())),
                if f.target.is_empty() { "null".to_string() } else { s(f.target) },
                primary.map_or("null".to_string(), |c| c.target_rows.to_string()),
                opt(primary.map(|c| c.target_digest.as_str())),
                check_list.join(",")
            ));
        }
        let normalizations: Vec<String> = self
            .normalizations
            .iter()
            .map(|n| {
                let (rule, reason) = n
                    .rule
                    .split_once(':')
                    .map_or((n.rule.as_str(), None), |(r, x)| (r, Some(x)));
                format!(
                    "{{\"rule\":{},\"reason\":{},\"family\":{},\"count\":{},\"keys_digest\":{}}}",
                    s(rule),
                    opt(reason),
                    s(&n.family),
                    n.count,
                    s(&n.keys_digest)
                )
            })
            .collect();
        let list = |v: &[String]| v.iter().map(|x| s(x)).collect::<Vec<_>>().join(",");
        let map = |m: &BTreeMap<String, usize>| {
            m.iter()
                .map(|(k, v)| format!("{}:{v}", s(k)))
                .collect::<Vec<_>>()
                .join(",")
        };
        format!(
            "{{\"format\":\"atm-conversion-report\",\"version\":1,\"knowledge\":{},\"families\":[{}],\
             \"normalizations\":[{}],\"rule_mismatches\":[{}],\"coverage_gaps\":[{}],\"graph_violations\":[{}],\"notes\":[{}],\"settlements\":[{}],\
             \"receipts\":{{\"classes\":{{{}}},\"promotion_shaped_agent\":{},\"promotion_status\":{{{}}},\"violations\":[{}]}},\
             \"global_feed\":{{\"orphans\":{},\"mirrors_replayed\":{}}},\"outbox_without_event\":{},\
             \"unresolved_promotions\":{},\"artifact_rows\":{}}}",
            s(if self.knowledge { "PRESENT" } else { "MISSING" }),
            families.join(","),
            normalizations.join(","),
            list(&self.rule_mismatches),
            list(&self.uncovered()),
            list(&self.graph_violations),
            list(&self.notes),
            self.settlements
                .iter()
                .map(|x| format!(
                    "{{\"scope\":{},\"was\":{},\"now\":{},\"how\":{}}}",
                    s(&x.scope),
                    s(&x.was),
                    s(&x.now),
                    s(&x.how)
                ))
                .collect::<Vec<_>>()
                .join(","),
            map(&self.receipt_classes),
            self.promotion_shaped_agent,
            map(&self.promotion_status),
            list(&self.receipt_violations),
            self.global_orphans,
            self.mirrors_replayed,
            self.outbox_without_event,
            self.unresolved_promotions,
            self.artifact_rows
        )
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

/// 支持的最新版本，与嵌入的迁移计划一致（`migrations.rs`，用例核对）。
const REGISTRY_MIGRATIONS: i64 = 8;
const KNOWLEDGE_MIGRATIONS: i64 = 1;
const PROJECT_MIGRATIONS: i64 = 18;

/// 2.x project_paths 的一行：id（可能为 NULL）、project_id、canonical_path、git_common_dir、is_primary、last_seen_at。
type PathRow = (Option<String>, String, String, Option<String>, i64, String);
/// registry 里按列名原样搬的表。
const REGISTRY_COPY: &[&str] = &[
    "quick_tasks",
    "quick_task_updates",
    "saved_views",
    "settings",
    "import_history",
    "project_restore_requests",
];

/// 项目库里按列名原样搬、只加 project_id 的表。
const PROJECT_COPY: &[&str] = &[
    "counters",
    "objectives",
    "milestones",
    "progress_updates",
    "project_updates",
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
/// N-02g～i：00 C-16 删除的遗留取值，改写成 3.0 的取值、原值进附件。（规则，表，列，谓词）
const N02_VALUES: &[(&str, &str, &str, &str)] = &[
    ("N-02g@1", "checklist_items", "kind", "kind <> 'ACCEPTANCE'"),
    ("N-02h@1", "blockers", "status", "status = 'CANCELLED'"),
    (
        "N-02i@1",
        "work_items",
        "progress_source",
        "progress_source = 'STATUS'",
    ),
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

/// 2.x 的 `notification.mode` 是否合法：整段文本按 `JSON.parse` 解析成字符串，值为三者之一
/// （区分大小写，同 2.x 的 `includes`）。用 JS 语义的解析器而不是 SQLite 的 JSON 函数：后者在原始 NUL 处
/// 截断，会把 `"ALL"` 后面跟 NUL 与垃圾的文本当成合法（W3a peer r1 P1-02）。
fn valid_mode(value_json: &str) -> bool {
    matches!(
        crate::jsjson::parse(value_json),
        Ok(Some(doc)) if doc.as_string().is_some_and(|s| ["ALL", "CRITICAL", "OFF"].contains(&s.as_str()))
    )
}

/// N-04 的推导值：`enabled` 的整段文本按 `JSON.parse` 恰好是 `false` 时为 OFF，其余（缺失、不合法、其他值）为 ALL。
fn mode_from_enabled(enabled: Option<&str>) -> &'static str {
    match enabled.map(crate::jsjson::parse) {
        Some(Ok(Some(doc))) if doc.as_bool() == Some(false) => "\"OFF\"",
        _ => "\"ALL\"",
    }
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
                params![NOTIFY_MODE, mode_from_enabled(Some(e_value)), e_version, e_at],
            )
            .ctx("settings")?;
            touched.push(NOTIFY_MODE.to_string());
        }
    }
    if let Some((m_value, _, _)) = &mode
        && !valid_mode(m_value)
    {
        let derived = mode_from_enabled(enabled.as_ref().map(|(v, _, _)| v.as_str()));
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
            "progress_source" => {
                "CASE WHEN progress_source = 'STATUS' THEN 'NONE' ELSE progress_source END"
                    .to_string()
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

    // N-05：不改数据，按原因记录无效边与同一时刻的有效边。先确认时间都能比较。
    check_lineage_times(tx, pid)?;
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

    // N-02g、h：checklist_items 的 kind 一律 ACCEPTANCE；2.0 完成门不看的 OPTIONAL 项（不必证、未完成）改为
    // SKIPPED，3.0 完成门对它的结论与 2.0 相同。blockers 的 CANCELLED 改为 RESOLVED（完成门只看 ACTIVE）。
    for (table, overrides) in [
        (
            "checklist_items",
            &[
                ("kind", "'ACCEPTANCE'"),
                (
                    "status",
                    "CASE WHEN kind = 'OPTIONAL' AND evidence_required = 0 AND status IN ('TODO','DOING')
                          THEN 'SKIPPED' ELSE status END",
                ),
            ][..],
        ),
        (
            "blockers",
            &[("status", "CASE WHEN status = 'CANCELLED' THEN 'RESOLVED' ELSE status END")][..],
        ),
    ] {
        let (cols, _) = columns(tx, "p", table)?;
        let select = cols
            .iter()
            .map(|c| {
                overrides
                    .iter()
                    .find(|(col, _)| col == c)
                    .map_or_else(|| format!("\"{c}\""), |(_, e)| e.to_string())
            })
            .collect::<Vec<_>>()
            .join(", ");
        tx.execute(
            &format!(
                "INSERT INTO main.{table} (project_id, {}) SELECT ?1, {select} FROM p.{table}",
                list(&cols)
            ),
            [pid],
        )
        .ctx(table)?;
    }
    for (rule, table, col, predicate) in N02_VALUES {
        let f = format!("{}.{col}", family(table));
        let keys = key_list(tx, &format!("SELECT id FROM p.{table} WHERE {predicate}"))?;
        let extra = if *table == "checklist_items" {
            ", 'status', status"
        } else {
            ""
        };
        let rows = key_list(
            tx,
            &format!(
                "SELECT json_object('id', id, 'value', \"{col}\"{extra}) FROM p.{table} WHERE {predicate} ORDER BY id"
            ),
        )?;
        if !rows.is_empty() {
            report.attachment.insert(f.clone(), rows);
        }
        report.normalizations.push(record(rule, &f, keys));
    }
    Ok(())
}

/// N-05 的时间接受域：`toISOString()` 的形状（`YYYY-MM-DDTHH:MM:SS.sssZ`），且是真实存在的日期时间。
/// 在这个域里字符串序就是时间序，与 3.0 运行时 lineage 的比较一致。
fn canonical_utc_millis(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 24 {
        return false;
    }
    let digits = [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 22];
    let shape = digits.iter().all(|&i| b[i].is_ascii_digit())
        && b[4] == b'-'
        && b[7] == b'-'
        && b[10] == b'T'
        && b[13] == b':'
        && b[16] == b':'
        && b[19] == b'.'
        && b[23] == b'Z';
    if !shape {
        return false;
    }
    let n = |a: usize, z: usize| s[a..z].parse::<u32>().unwrap_or(u32::MAX);
    let (year, month, day) = (n(0, 4), n(5, 7), n(8, 10));
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&day) && n(11, 13) < 24 && n(14, 16) < 60 && n(17, 19) < 60
}

/// N-05：参与 predecessor 边的 session，其 started_at 必须在接受域里；否则显式失败，不按字典序猜先后。
fn check_lineage_times(tx: &Transaction<'_>, pid: &str) -> Result<()> {
    let mut st = tx.prepare(
        "SELECT id, started_at FROM p.agent_sessions
         WHERE predecessor_session_id IS NOT NULL
            OR id IN (SELECT predecessor_session_id FROM p.agent_sessions WHERE predecessor_session_id IS NOT NULL)
         ORDER BY id",
    )?;
    let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (id, at) = row?;
        if !canonical_utc_millis(&at) {
            return Err(ConvertError::Unsupported(format!(
                "project {pid}: agent_sessions {id}.started_at is not a canonical UTC timestamp, \
                 so lineage order cannot be decided (N-05)"
            )));
        }
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
            let origin = opts.origin_root.map(Path::to_path_buf);
            for p in std::iter::once(&src.registry)
                .chain(src.knowledge.iter())
                .chain(src.projects.iter())
                .chain(src.root.iter())
                .chain(origin.iter())
            {
                refuse_real_root(&root, p)?;
            }
        }
    }
    if target.exists() {
        return Err(ConvertError::TargetExists(target.to_path_buf()));
    }
    let mut report = Report {
        accepted_unconvertible: opts
            .accept_unconvertible
            .iter()
            .map(|c| c.to_string())
            .collect(),
        origin_root: opts.origin_root.map(Path::to_path_buf),
        ..Report::default()
    };
    // 数据根：未登记的条目、非空的 trash、进行中的事务残留，在动目标之前就停（W3b4）。
    if let Some(root) = &src.root {
        root::scan(root, opts.at, &mut report)?;
        report.root = true;
        check_secrets(root, opts)?;
    }
    // 源库一律先复制成工作副本（W3b3）：WAL 在副本里恢复，旧 schema 在副本上补迁移，源文件本身不打开。
    let work = work_dir(target, WORK_DIR)?;
    let used = prepare_sources(src, &work, opts.at, &mut report)?;

    let mut t = crate::open(target)?;
    register_functions(&t)?;
    let gens = convert_registry(&mut t, &used, opts.at, opts.generation, &mut report)?;
    let mut promotions: Vec<(String, String)> = Vec::new();
    let mut seen = HashSet::new();
    for p in &used.projects {
        let pid = convert_project(&mut t, p, &gens, &mut report, &mut promotions)?;
        if !seen.insert(pid.clone()) {
            return Err(ConvertError::Mismatch(format!("project {pid} given twice")));
        }
    }
    for id in gens.projects.keys() {
        // CREATING 落定成 TRASHED 的项目没有数据（W3b6）。
        let husk = report
            .settlements
            .iter()
            .any(|s| &s.scope == id && s.now == "TRASHED");
        if !seen.contains(id) && !husk {
            return Err(ConvertError::Mismatch(format!(
                "project {id} is in the registry but no database was given"
            )));
        }
    }
    finish(&mut t, &gens, &promotions, &mut report)?;
    if let Some(root) = &src.root {
        root::convert_files(&mut t, root, &target_dir(target), &mut report)?;
        jsonfiles::convert(&mut t, root, &target_dir(target), opts.at, &mut report)?;
    }
    verify(&t, &used, &mut report)?;
    if !report.failures().is_empty() {
        return Err(ConvertError::Verify(Box::new(report)));
    }
    drop(t);
    // 成功后工作副本没用了；失败时留着，随 staging 一起丢弃或供诊断。
    let _ = std::fs::remove_dir_all(&work);
    Ok(report)
}

/// 转换与独立 VERIFY 各自的工作副本目录，放在目标库旁边（staging 里），不放 %TEMP%。
const WORK_DIR: &str = "legacy-work";
const VERIFY_DIR: &str = "legacy-verify";

/// 转换器版本：写进 `app_meta.converted_from.converterVersion`。迁移嵌入、规范化规则、映射有变化时升。
pub const CONVERTER_VERSION: &str = "atm-store-legacy/1";

/// 目标库所在的目录（staging）：附件、工作副本都放这里。
fn target_dir(target: &Path) -> PathBuf {
    target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
        .to_path_buf()
}

fn work_dir(target: &Path, name: &str) -> Result<PathBuf> {
    let dir = target_dir(target).join(name);
    // 上一次失败留下的同名目录是本转换器自己的产物，重来前清掉。
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// 一个源库的来源证明（W3b3）：源文件的 sha256、源里登记的迁移、在副本上补跑的迁移。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceProvenance {
    /// `registry`、`knowledge` 或 `project:<id>`。
    pub role: String,
    /// 源 db 文件的 sha256（转换开始时）。
    pub sha256: String,
    /// 源旁边 `-wal` 的 sha256；没有或为空时是 `None`。
    pub wal_sha256: Option<String>,
    /// 源里 `schema_migrations` 的原样内容：(version, name, content_sha256, hash_origin)。
    pub migrations: Vec<(i64, String, String, String)>,
    /// 在副本上按 2.0 runner 补跑的版本。
    pub upgraded: Vec<i64>,
}

impl SourceProvenance {
    fn json(&self) -> String {
        let migrations: Vec<String> = self
            .migrations
            .iter()
            .map(|(v, n, s, o)| {
                format!(
                    "{{\"version\":{v},\"name\":{},\"sha256\":{},\"origin\":{}}}",
                    json_string(n),
                    json_string(s),
                    json_string(o)
                )
            })
            .collect();
        format!(
            "{{\"role\":{},\"sha256\":{},\"walSha256\":{},\"migrations\":[{}],\"upgraded\":[{}]}}",
            json_string(&self.role),
            json_string(&self.sha256),
            self.wal_sha256
                .as_deref()
                .map_or("null".to_string(), json_string),
            migrations.join(","),
            self.upgraded
                .iter()
                .map(i64::to_string)
                .collect::<Vec<_>>()
                .join(",")
        )
    }
}

fn provenance_json(all: &[SourceProvenance]) -> String {
    format!(
        "[{}]",
        all.iter()
            .map(SourceProvenance::json)
            .collect::<Vec<_>>()
            .join(",")
    )
}

fn file_sha256(path: &Path) -> Result<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

/// 把三类源库都做成工作副本，返回转换实际读取的那一组路径。
fn prepare_sources(
    src: &LegacySources,
    work: &Path,
    at: &str,
    report: &mut Report,
) -> Result<LegacySources> {
    let one = |path: &Path, home: Home, slot: String, report: &mut Report| -> Result<PathBuf> {
        let (working, p) = prepare_source(path, home, &work.join(format!("{slot}.sqlite")), at)?;
        report.provenance.push(p);
        Ok(working)
    };
    let registry = one(&src.registry, Home::Registry, "registry".into(), report)?;
    let knowledge = match &src.knowledge {
        Some(k) => Some(one(k, Home::Knowledge, "knowledge".into(), report)?),
        None => None,
    };
    // 给了数据根时，先在 registry 的工作副本上落定进行中的事务（W3b6），决定每个项目取哪个文件。
    let mut originals = src.projects.clone();
    let mut prepared = Vec::new();
    if let Some(root) = &src.root {
        originals = settle::projects(root, &registry, &src.projects, work, at, report)?;
        prepared = settle::migration_failed(root, &registry, &mut originals, work, at, report)?;
    }
    for (i, p) in originals.into_iter().enumerate() {
        let working = one(&p, Home::Project, format!("project-{i}"), report)?;
        prepared.push((p, working));
    }
    // 按源文件排序：与落定之前一样按项目目录的顺序。
    prepared.sort();
    Ok(LegacySources {
        registry,
        knowledge,
        projects: prepared.into_iter().map(|(_, w)| w).collect(),
        root: src.root.clone(),
    })
}

/// 一个源库 → 工作副本（05 §3.3、07 IMPORT；W3b3）：
/// 1. 复制 db 与 `-wal`（不复制 `-shm`），源文件只读不开；
/// 2. 在副本上 `quick_check`（第一次读取时恢复 WAL）；
/// 3. 核对 `schema_migrations` 的来源：每行的版本在支持的计划里、名字与 hash 认得、来源合法，版本不断档；
/// 4. 缺的迁移按 2.0 runner 的语义补跑：`foreign_keys = ON`，每个迁移一个事务，`applied_at` 取 `at`；
/// 5. `foreign_key_check`、登记完整性（表集合恰好是族表登记的那些）；
/// 6. 合并 WAL、改回单文件，供转换与 VERIFY 只读挂载。
fn prepare_source(
    original: &Path,
    home: Home,
    working: &Path,
    at: &str,
) -> Result<(PathBuf, SourceProvenance)> {
    let shown = original.display().to_string();
    let wal = sidecar(original, "-wal");
    let wal_sha256 = match std::fs::metadata(&wal) {
        Ok(m) if m.len() > 0 => {
            std::fs::copy(&wal, sidecar(working, "-wal"))?;
            Some(file_sha256(&wal)?)
        }
        _ => None,
    };
    std::fs::copy(original, working)?;
    let sha256 = file_sha256(original)?;
    let c = Connection::open(working)?;
    let quick: Vec<String> = c
        .prepare("PRAGMA quick_check")
        .and_then(|mut st| st.query_map([], |r| r.get(0))?.collect())
        .map_err(|e| ConvertError::Mismatch(format!("{shown}: source quick_check: {e}")))?;
    if quick != ["ok"] {
        return Err(ConvertError::Mismatch(format!(
            "{shown}: source quick_check: {}",
            quick.join("; ")
        )));
    }

    let has_table: bool = c.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations')",
        [],
        |r| r.get(0),
    )?;
    if !has_table {
        return Err(ConvertError::UnsupportedSchema(format!(
            "{shown}: no schema_migrations"
        )));
    }
    let applied: Vec<(i64, String, String, String)> = c
        .prepare("SELECT version, name, content_sha256, hash_origin FROM schema_migrations ORDER BY version")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let plan = migrations::plan(home);
    for (version, name, sha, origin) in &applied {
        let Some(m) = plan.iter().find(|m| m.version == *version) else {
            return Err(ConvertError::UnsupportedSchema(format!(
                "{shown}: migration {version} {name} is not one this converter knows"
            )));
        };
        if !migrations::recognizes(m, name, sha) {
            return Err(ConvertError::UnsupportedSchema(format!(
                "{shown}: migration {version} recorded as {name} with sha256 {sha}, expected {} with {}",
                m.name, m.sha256
            )));
        }
        if origin != "APPLIED" && origin != "LEGACY_BASELINE_UNVERIFIED" {
            return Err(ConvertError::UnsupportedSchema(format!(
                "{shown}: migration {version} has hash_origin {origin}"
            )));
        }
    }
    // 2.0 assertAppliedMigrations：低于最高已应用版本的迁移都必须在。
    let highest = applied.last().map_or(0, |a| a.0);
    if let Some(gap) = plan
        .iter()
        .find(|m| m.version < highest && !applied.iter().any(|a| a.0 == m.version))
    {
        return Err(ConvertError::UnsupportedSchema(format!(
            "{shown}: migration history skips {}",
            gap.version
        )));
    }
    let pending: Vec<_> = plan
        .iter()
        .filter(|m| !applied.iter().any(|a| a.0 == m.version))
        .collect();
    let mut c = c;
    if !pending.is_empty() {
        c.pragma_update(None, "foreign_keys", true)?;
        for m in &pending {
            let tx = c.transaction()?;
            tx.execute_batch(m.sql).map_err(|e| {
                ConvertError::Mismatch(format!("{shown}: upgrading to {} failed: {e}", m.name))
            })?;
            tx.execute(
                "INSERT INTO schema_migrations (version, name, applied_at, content_sha256, hash_origin)
                 VALUES (?1, ?2, ?3, ?4, 'APPLIED')",
                params![m.version, m.name, at, m.sha256],
            )?;
            tx.commit()?;
        }
    }

    let dangling: Option<(String, Option<i64>, String)> = c
        .query_row(
            "SELECT \"table\", rowid, parent FROM pragma_foreign_key_check ORDER BY 1, 2 LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    if let Some((table, rowid, parent)) = dangling {
        return Err(ConvertError::Mismatch(format!(
            "{shown}: source foreign_key_check: {table} rowid {} -> {parent}",
            rowid.unwrap_or_default()
        )));
    }
    let tables = families::tables(home);
    let allowed: HashSet<&str> = tables.iter().map(String::as_str).collect();
    let names: Vec<String> = c
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for n in &names {
        if !allowed.contains(n.as_str()) {
            return Err(ConvertError::UnknownTable(format!("{shown}: {n}")));
        }
    }
    for t in &tables {
        if !names.iter().any(|n| n == t) {
            return Err(ConvertError::UnsupportedSchema(format!(
                "{shown}: missing {t}"
            )));
        }
    }
    let role = match home {
        Home::Registry => "registry".to_string(),
        Home::Knowledge => "knowledge".to_string(),
        _ => format!(
            "project:{}",
            c.query_row("SELECT project_id FROM project_meta", [], |r| r
                .get::<_, String>(0))?
        ),
    };
    c.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
    c.query_row("PRAGMA journal_mode = DELETE", [], |_| Ok(()))?;
    drop(c);
    Ok((
        working.to_path_buf(),
        SourceProvenance {
            role,
            sha256,
            wal_sha256,
            migrations: applied,
            upgraded: pending.iter().map(|m| m.version).collect(),
        },
    ))
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
    generation: Option<&str>,
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
                "project {id} is {life}; in-flight lifecycles need the data root to be settled (05 4.1)"
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
                                'knowledgeMigrations', ?3, 'sourceCurrentSequence', ?4, 'convertedAt', ?5,
                                'converterVersion', ?6, 'sources', json(?7))",
            params![
                REGISTRY_MIGRATIONS,
                PROJECT_MIGRATIONS,
                KNOWLEDGE_MIGRATIONS,
                current,
                at,
                CONVERTER_VERSION,
                provenance_json(&report.provenance)
            ],
            |r| r.get(0),
        )?;
        let (root, epoch) = (ulid(&tx)?, ulid(&tx)?);
        let generation = match generation {
            Some(g) => g.to_string(),
            None => ulid(&tx)?,
        };
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
    let mut buf = Vec::new();
    while let Some(row) = q.next()? {
        rows += 1;
        buf.clear();
        for i in 0..n {
            encode_value(&mut buf, row.get_ref(i)?);
        }
        body.update(&buf);
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

/// 05 §5.1 的值编码：`NULL→00`、`INTEGER→01 十进制 00`、`REAL→02 大端 8 字节`、`TEXT→03 u32 长度 原字节`、`BLOB→04 u32 长度 原字节`。
fn encode_value(buf: &mut Vec<u8>, v: ValueRef<'_>) {
    match v {
        ValueRef::Null => buf.push(0x00),
        ValueRef::Integer(v) => {
            buf.push(0x01);
            buf.extend_from_slice(v.to_string().as_bytes());
            buf.push(0x00);
        }
        ValueRef::Real(v) => {
            buf.push(0x02);
            buf.extend_from_slice(&v.to_be_bytes());
        }
        ValueRef::Text(t) => {
            buf.push(0x03);
            buf.extend_from_slice(&(t.len() as u32).to_be_bytes());
            buf.extend_from_slice(t);
        }
        ValueRef::Blob(b) => {
            buf.push(0x04);
            buf.extend_from_slice(&(b.len() as u32).to_be_bytes());
            buf.extend_from_slice(b);
        }
    }
}

/// 定位用的主键值：文本按 JSON 字符串写、超过 64 个字符截断；BLOB 只写长度。
fn render_key(v: ValueRef<'_>) -> String {
    match v {
        ValueRef::Null => "null".into(),
        ValueRef::Integer(v) => v.to_string(),
        ValueRef::Real(v) => format!("{v:?}"),
        ValueRef::Text(t) => {
            let t = String::from_utf8_lossy(t);
            let cut: String = t.chars().take(64).collect();
            json_string(&if cut.len() < t.len() {
                format!("{cut}…")
            } else {
                cut
            })
        }
        ValueRef::Blob(b) => format!("blob({})", b.len()),
    }
}

/// 一项检查的身份：所属族、检查名、定位用的主键列（必须在比对列里）。
struct Ck<'a> {
    spec: &'static str,
    label: &'a str,
    key: &'a [&'a str],
}

/// 一边查询结果的逐行视图：（编码后的主键，整行哈希，定位串），按查询顺序。
type Keyed = Vec<(Vec<u8>, [u8; 32], String)>;

fn keyed_rows(
    c: &Connection,
    label: &str,
    key: &[usize],
    sql: &str,
    args: &[&dyn rusqlite::ToSql],
) -> Result<Keyed> {
    let mut st = c.prepare(sql)?;
    let n = st.column_count();
    let mut q = st.query(args)?;
    let mut out = Vec::new();
    while let Some(row) = q.next()? {
        let mut whole = Vec::new();
        for i in 0..n {
            encode_value(&mut whole, row.get_ref(i)?);
        }
        let mut k = Vec::new();
        let mut shown = Vec::new();
        for &i in key {
            encode_value(&mut k, row.get_ref(i)?);
            shown.push(render_key(row.get_ref(i)?));
        }
        let locator = if key.is_empty() {
            label.to_string()
        } else {
            format!("{label}({})", shown.join(","))
        };
        out.push((k, Sha256::digest(&whole).into(), locator));
    }
    Ok(out)
}

/// 摘要不等时的第二遍：按主键配对，数出不一致的行，记下第一处（源的顺序优先，其次目标多出来的行）。
fn first_failure(source: Keyed, target: Keyed) -> (i64, Option<String>) {
    let mut pool: HashMap<Vec<u8>, Vec<[u8; 32]>> = HashMap::new();
    for (k, h, _) in &target {
        pool.entry(k.clone()).or_default().push(*h);
    }
    let (mut errors, mut first) = (0i64, None);
    for (k, h, at) in source {
        match pool.get_mut(&k) {
            Some(hs) if !hs.is_empty() => {
                if let Some(i) = hs.iter().position(|x| *x == h) {
                    hs.swap_remove(i);
                } else {
                    hs.pop();
                    errors += 1;
                    first.get_or_insert(at);
                }
            }
            _ => {
                errors += 1;
                first.get_or_insert(at);
            }
        }
    }
    for (k, _, at) in target {
        if let Some(hs) = pool.get_mut(&k).filter(|hs| !hs.is_empty()) {
            errors += hs.len() as i64;
            hs.clear();
            first.get_or_insert(at);
        }
    }
    (errors, first)
}

#[allow(clippy::too_many_arguments)]
fn compare(
    c: &Connection,
    report: &mut Report,
    ck: Ck<'_>,
    cols: &[String],
    source_sql: &str,
    source_args: &[&dyn rusqlite::ToSql],
    target_sql: &str,
    target_args: &[&dyn rusqlite::ToSql],
) -> Result<()> {
    let label = ck.label;
    let (source_rows, source_digest) = digest(c, label, cols, source_sql, source_args)?;
    let (target_rows, target_digest) = digest(c, label, cols, target_sql, target_args)?;
    let (mut errors, mut first_failure_locator) = (0, None);
    if source_rows != target_rows || source_digest != target_digest {
        let key = ck
            .key
            .iter()
            .map(|k| {
                cols.iter().position(|c| c == k).ok_or_else(|| {
                    ConvertError::Unsupported(format!(
                        "check {label}: key column {k} is not compared"
                    ))
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let source = keyed_rows(c, label, &key, source_sql, source_args)?;
        let target = keyed_rows(c, label, &key, target_sql, target_args)?;
        (errors, first_failure_locator) = first_failure(source, target);
    }
    report.checks.push(FamilyCheck {
        family: label.to_string(),
        spec: ck.spec,
        scope: label.split('/').next().unwrap_or_default().to_string(),
        source_rows,
        target_rows,
        source_digest,
        target_digest,
        errors,
        first_failure_locator,
    });
    Ok(())
}

/// 源 DB 族的规范化摘要：主源表全部列按主键排序。舍弃、重建的族也算，供报告与 `business_digest`。
fn digest_sources(
    c: &Connection,
    report: &mut Report,
    schema: &str,
    home: Home,
    scope: &str,
) -> Result<()> {
    for f in FAMILIES.iter().filter(|f| f.home == home) {
        let table = f.sources[0];
        let (cols, pk) = columns(c, schema, table)?;
        let (rows, digest) = digest(
            c,
            &format!("{scope}/{}", f.name),
            &cols,
            &format!(
                "SELECT {} FROM {schema}.\"{table}\" ORDER BY {}",
                list(&cols),
                list(&pk)
            ),
            &[],
        )?;
        report.sources.push(SourceDigest {
            spec: f.name,
            scope: scope.to_string(),
            rows,
            digest,
            bytes: None,
        });
    }
    Ok(())
}

/// 按列名逐表比对：源 `schema.table` 与目标同名表（可选 project_id 过滤）。族名即表名，定位用主键。
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
    let home = match schema {
        "r" => Home::Registry,
        "k" => Home::Knowledge,
        _ => Home::Project,
    };
    let spec = families::spec(home, table)
        .map(|f| f.name)
        .ok_or_else(|| ConvertError::Unsupported(format!("{table} is not a registered family")))?;
    let key: Vec<&str> = pk.iter().map(String::as_str).collect();
    let ck = || Ck {
        spec,
        label: &family,
        key: &key,
    };
    match project {
        Some(p) => compare(
            c,
            report,
            ck(),
            &cols,
            &format!("SELECT {l} FROM {schema}.{table} ORDER BY {order}"),
            &[],
            &format!("SELECT {l} FROM main.{table} WHERE project_id = ?1 ORDER BY {order}"),
            &[&p],
        ),
        None => compare(
            c,
            report,
            ck(),
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
/// 源库重新做一遍工作副本（独立于转换时的那一份），所以转换之后源有变化也看得出来：
/// 内容不一致落在逐族比对里，源文件本身变了落在来源证明的比对里。
pub fn verify_converted(target: &Path, src: &LegacySources, conversion: &Report) -> Result<Report> {
    let t = Connection::open(target)?;
    crate::configure(&t)?;
    register_functions(&t)?;
    let at: String = t.query_row(
        "SELECT converted_from ->> '$.convertedAt' FROM app_meta",
        [],
        |r| r.get(0),
    )?;
    let mut report = Report {
        normalizations: conversion.normalizations.clone(),
        attachment: conversion.attachment.clone(),
        accepted_unconvertible: conversion.accepted_unconvertible.clone(),
        origin_root: conversion.origin_root.clone(),
        ..Report::default()
    };
    if let Some(root) = &src.root {
        root::scan(root, &at, &mut report)?;
        report.root = true;
    }
    let work = work_dir(target, VERIFY_DIR)?;
    let r = prepare_sources(src, &work, &at, &mut report)
        .and_then(|used| verify(&t, &used, &mut report));
    drop(t);
    let _ = std::fs::remove_dir_all(&work);
    r?;
    Ok(report)
}

/// 07 §6 的 `business_digest'`：对数据根按转换同样的流程（工作副本、落定、规范化）重算业务摘要，
/// 用来判断 2.x 在转换之后有没有写过。
///
/// - `opts.at` 必须是转换时的那一个：落定会把它写进 registry 的工作副本，换了时刻摘要就变。
/// - 目标库与复制出的文件都写在 `scratch` 下一个专用的子目录里，算完整个删掉；`L` 只读。
/// - 读失败、出现未登记的文件或表、超出接受域、源与目标对不上：返回错误，调用方按 UNKNOWN 处理。
pub fn business_digest(
    src: &LegacySources,
    scratch: &Path,
    opts: &ConvertOptions<'_>,
) -> Result<BTreeMap<String, String>> {
    let dir = scratch.join("business-digest");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    let r = convert(src, &dir.join("atm.sqlite"), opts).map(|r| r.business_digest());
    let _ = std::fs::remove_dir_all(&dir);
    r
}

/// 07 §3 SNAPSHOT 要复制的文件（05 §4.2）：§5.2「纳入」的族的文件，加上 §4.1 落定要读的残留件；
/// 以 `/` 分隔的相对路径，按路径排序。先按数据根枚举一遍（未登记的条目、超出接受域的文件在这里就停）。
///
/// - 三类库（含 `-wal` / `-shm`）、知识库目录里的恢复残留、项目目录（库、manifest、附件、回滚件、
///   `.creating-*` / `.restore-*` 暂存）；
/// - `sync\config.json`、`sync\secrets.dpapi.json`，`dispatch\` 的三个 JSON 与非运行中的 run 的日志；
/// - 知识恢复日志在时，它点名的 `before-restore-<id>.sqlite`（落定可能把它当现库）。
///
/// 不复制：备份（X7，原地只读登记）、运行中的 run 的日志（子进程还在写）、其余 R / X 类。
pub fn snapshot_files(root: &Path, at: &str) -> Result<Vec<String>> {
    let mut report = Report::default();
    root::scan(root, at, &mut report)?;
    let loaded = jsonfiles::load(root, at)?;
    let running: HashSet<String> = jsonfiles::classify_logs(root, &loaded)?
        .running
        .into_iter()
        .map(|f| f.0)
        .collect();
    let journal = settle::knowledge(root)?.journal.map(|(id, _)| id);
    let keep = |rel: &str| -> bool {
        let parts: Vec<&str> = rel.split('/').collect();
        match parts.as_slice() {
            ["registry" | "knowledge", ..] => true,
            ["projects", _, "backups", ..] => false,
            ["projects", ..] => true,
            ["sync", "config.json" | "secrets.dpapi.json"] => true,
            ["dispatch", "config.json" | "runs.json" | "requests.json"] => true,
            ["dispatch", "logs", name] => !running.contains(*name),
            ["backups", "knowledge", name] => journal.as_ref().is_some_and(|id| {
                let db = format!("before-restore-{id}.sqlite");
                *name == db || *name == format!("{db}-wal")
            }),
            _ => false,
        }
    };
    Ok(root::walk(root)?
        .into_iter()
        .map(|f| f.0)
        .filter(|rel| keep(rel))
        .collect())
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
        // 报告契约：每个（规则，族）恰好一条，摘要是 64 位小写十六进制（W3a peer r1 P2-01、P2-02）。
        let mut seen = std::collections::BTreeSet::new();
        for n in &report.normalizations {
            if !seen.insert((n.rule.clone(), n.family.clone())) {
                report
                    .rule_mismatches
                    .push(format!("{} {}: duplicate record", n.rule, n.family));
            }
            let well_formed = n.keys_digest.len() == 64
                && n.keys_digest
                    .bytes()
                    .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
            if !well_formed {
                report
                    .rule_mismatches
                    .push(format!("{} {}: malformed keys_digest", n.rule, n.family));
            }
        }
        let (ours, theirs) = (index(&self.records), index(&report.normalizations));
        let show = |n: Option<&(i64, String)>| {
            n.map_or("missing".to_string(), |(c, d)| {
                format!("{c} {}", d.chars().take(12).collect::<String>())
            })
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
    report.knowledge = src.knowledge.is_some();
    let mut re = Recheck::default();
    let r = (|| {
        digest_sources(t, report, "r", Home::Registry, "r")?;
        // 来源证明：这一次读到的源（sha256、原有迁移、补跑的迁移）与转换时写进目标的那一份相同。
        let provenance = provenance_json(&report.provenance);
        compare(
            t,
            report,
            Ck {
                spec: "schema_migrations",
                label: "r/app_meta.sources",
                key: &[],
            },
            &["sources".to_string()],
            "SELECT json(?1)",
            &[&provenance],
            "SELECT converted_from -> '$.sources' FROM main.app_meta",
            &[],
        )?;
        verify_registry(t, report, &mut re)?;
        expect_global_begin(t)?;
        if let Some(k) = &src.knowledge {
            attach(t, k, "k")?;
            let r = digest_sources(t, report, "k", Home::Knowledge, "k")
                .and_then(|()| verify_knowledge(t, report));
            detach(t, "k");
            r?;
        }
        for p in &src.projects {
            attach(t, p, "p")?;
            let r = verify_project(t, report, &mut re).and_then(|()| expect_global_project(t));
            detach(t, "p");
            r?;
        }
        verify_global(t, report)?;
        if let Some(root) = &src.root {
            let out = target_dir(Path::new(t.path().unwrap_or_default()));
            root::verify_files(t, root, &out, report)?;
            jsonfiles::verify(t, root, &out, report)?;
        }
        Ok(())
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
    // 信息项：晋升的快任务解析到的任务，source_quick_id 应当指回它（05 §3.1）。
    let unmarked: Vec<String> = c
        .prepare(
            "SELECT q.id FROM main.quick_tasks q JOIN main.work_items w
               ON w.project_id = q.promoted_project_id AND w.id = q.promoted_work_item_id
             WHERE q.status = 'PROMOTED' AND w.source_quick_id IS NOT q.id ORDER BY q.id",
        )?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<_>>()?;
    if let Some(first) = unmarked.first() {
        report.notes.push(format!(
            "r/quick_tasks: {} promoted tasks not marked with source_quick_id, first {first}",
            unmarked.len()
        ));
    }
    let baseline: i64 = c.query_row("SELECT current_sequence FROM r.app_meta", [], |r| r.get(0))?;
    compare(
        c,
        report,
        Ck {
            spec: "global_events",
            label: "r/global_feed.links",
            key: &["global_seq"],
        },
        &["global_seq", "project_id", "event_id"].map(String::from),
        "SELECT global_seq, project_id, event_id FROM temp.expected_links ORDER BY global_seq",
        &[],
        "SELECT global_seq, project_id, event_id FROM main.global_feed WHERE global_seq <= ?1 ORDER BY global_seq",
        &[&baseline],
    )?;
    compare(
        c,
        report,
        Ck {
            spec: "global_events",
            label: "r/global_feed.replayed",
            key: &["global_seq"],
        },
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
        Ck {
            spec: "app_meta",
            label: "r/app_meta.global_seq",
            key: &[],
        },
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
        Ck {
            spec: "projects",
            label: "r/projects",
            key: &["id"],
        },
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
        Ck {
            spec: "global_events",
            label: "r/global_events",
            key: &["sequence"],
        },
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
        Ck {
            spec: "backup_catalog",
            label: "r/backup_catalog",
            key: &["id"],
        },
        &cols,
        "SELECT id, scope, project_id, path, sha256, size_bytes, reason, schema_version, created_at, verified_at
         FROM r.backup_catalog ORDER BY id",
        &[],
        "SELECT id, scope, project_id, legacy_path, sha256, size_bytes, reason, schema_version, created_at, verified_at
         FROM main.legacy_backups WHERE source = 'CATALOG' ORDER BY id",
        &[],
    )?;
    compare_migrations(c, report, "r", "r", "registryMigrations")
}

/// R12 / K5 / P9：源的迁移集合必须恰好是 `app_meta.converted_from` 记下的 1..=N。
fn compare_migrations(
    c: &Connection,
    report: &mut Report,
    schema: &str,
    scope: &str,
    field: &str,
) -> Result<()> {
    compare(
        c,
        report,
        Ck {
            spec: "schema_migrations",
            label: &format!("{scope}/schema_migrations"),
            key: &["version"],
        },
        &["version".to_string()],
        &format!("SELECT version FROM {schema}.schema_migrations ORDER BY version"),
        &[],
        &format!(
            "WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v + 1 FROM n
               WHERE v < (SELECT converted_from ->> '$.{field}' FROM main.app_meta))
             SELECT v FROM n ORDER BY v"
        ),
        &[],
    )
}

fn verify_knowledge(c: &Connection, report: &mut Report) -> Result<()> {
    // 信息项：每个条目的修订号从 1 连续到 head_revision（05 §3.2）。
    let gaps: Vec<String> = c
        .prepare(
            "SELECT e.id FROM k.knowledge_entries e
             WHERE (SELECT count(*) FROM k.knowledge_revisions r WHERE r.entry_id = e.id) <> e.head_revision
                OR (SELECT min(revision) FROM k.knowledge_revisions r WHERE r.entry_id = e.id) IS NOT 1
                OR (SELECT max(revision) FROM k.knowledge_revisions r WHERE r.entry_id = e.id) IS NOT e.head_revision
             ORDER BY e.id",
        )?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<_>>()?;
    if let Some(first) = gaps.first() {
        report.notes.push(format!(
            "k/knowledge_revisions: revisions not contiguous for {} entries, first {first}",
            gaps.len()
        ));
    }
    compare_table(c, report, "k", "knowledge_meta", None)?;
    compare_table(c, report, "k", "knowledge_entries", None)?;
    compare_table(c, report, "k", "knowledge_revisions", None)?;
    compare_migrations(c, report, "k", "k", "knowledgeMigrations")?;
    // knowledge_fts 在 3.0 从 head revision 重建（X1 REBUILT）。比对被索引的文本列：两边相同，同一查询命中的条目就相同。
    // metadata 是 UNINDEXED 的展示数据，读取时再用条目行覆盖，不参与匹配。
    let cols: Vec<String> = [
        "entry_id",
        "title",
        "aliases",
        "tags",
        "summary",
        "use_when",
        "applies_to",
        "body",
    ]
    .map(String::from)
    .to_vec();
    compare(
        c,
        report,
        Ck {
            spec: "knowledge_fts",
            label: "k/knowledge_fts",
            key: &["entry_id"],
        },
        &cols,
        &format!(
            "SELECT {} FROM k.knowledge_fts ORDER BY entry_id",
            list(&cols)
        ),
        &[],
        &format!(
            "SELECT {} FROM main.knowledge_fts ORDER BY entry_id",
            list(&cols)
        ),
        &[],
    )?;
    let cols: Vec<String> = ["op_id", "fingerprint", "receipt"]
        .map(String::from)
        .to_vec();
    compare(
        c,
        report,
        Ck {
            spec: "knowledge_operations",
            label: "k/knowledge_operations",
            key: &["op_id"],
        },
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
    report.projects.push(pid.clone());
    digest_sources(c, report, "p", Home::Project, p)?;
    compare_migrations(c, report, "p", p, "projectMigrations")?;
    // P8：项目 settings 舍弃，前提是它为空（转换入口已拒绝非空；这里独立再查一遍）。
    compare(
        c,
        report,
        Ck {
            spec: "settings",
            label: &format!("{p}/settings"),
            key: &["key"],
        },
        &["key", "value_json", "version", "updated_at"].map(String::from),
        "SELECT key, value_json, version, updated_at FROM p.settings ORDER BY key",
        &[],
        "SELECT NULL, NULL, NULL, NULL WHERE 0",
        &[],
    )?;
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
        Ck {
            spec: "project_meta",
            label: &format!("{p}/project_meta"),
            key: &[],
        },
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
        Ck {
            spec: "project_meta",
            label: &format!("{p}/project_meta(derived)"),
            key: &[],
        },
        &derived,
        "SELECT health, version, current_sequence, schema_version FROM p.project_meta",
        &[],
        "SELECT health, meta_version, project_seq, legacy_schema_version FROM main.projects WHERE id = ?1",
        &[&p],
    )?;
    for table in PROJECT_COPY.iter().filter(|t| **t != "artifacts") {
        compare_table(c, report, "p", table, Some(p))?;
    }
    // artifacts：local_path 可能已改写到新根（W3b4），用 legacy_local_path 反投影原值（05 §3.3）。
    let (cols, pk) = columns(c, "p", "artifacts")?;
    let target = cols
        .iter()
        .map(|col| {
            if col == "local_path" {
                "legacy_local_path".to_string()
            } else {
                format!("\"{col}\"")
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    let key: Vec<&str> = pk.iter().map(String::as_str).collect();
    compare(
        c,
        report,
        Ck {
            spec: "artifacts",
            label: &format!("{p}/artifacts"),
            key: &key,
        },
        &cols,
        &format!(
            "SELECT {} FROM p.artifacts ORDER BY {}",
            list(&cols),
            list(&pk)
        ),
        &[],
        &format!(
            "SELECT {target} FROM main.artifacts WHERE project_id = ?1 ORDER BY {}",
            list(&pk)
        ),
        &[&p],
    )?;
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
        Ck {
            spec: "events",
            label: &format!("{p}/events"),
            key: &["sequence"],
        },
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
        Ck {
            spec: "idempotency_keys",
            label: &format!("{p}/idempotency_keys"),
            key: &["key"],
        },
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
        Ck {
            spec: "search_documents",
            label: &format!("{p}/search_documents"),
            key: &["entity_type", "entity_id"],
        },
        &cols,
        "SELECT entity_type, entity_id, entity_key, title, body, updated_at FROM p.search_documents ORDER BY entity_type, entity_id",
        &[],
        "SELECT entity_type, entity_id, entity_key, title, body, updated_at FROM main.search_docs WHERE project_id = ?1
         ORDER BY entity_type, entity_id",
        &[&p],
    )?;
    verify_search_queries(c, report, p)?;
    verify_graph(c, report, p)
}

/// 搜索的查询等价（05 §2.5；search_documents 是 X1 REBUILT）。每个实体类型取一份文档（entity_id 最小），
/// 从它抽探针：标题与正文里第一个不含空白、至少 3 个字符的片段的前 3 个字符（走 FTS），
/// 第一组相邻的两个汉字（2.0 扫表的短词路径），以及 entity_key 本身（FTS 不索引 key，靠 LIKE）。
/// 每个探针在源库上按 2.0 的项目搜索（`project-activity-read-model.ts:158-170`）查，在目标库上按 3.0 的
/// [`crate::search::match_docs`] 查，命中的 entity_key 集合必须相同。定位只写实体类型与探针种类，不写探针文本。
fn verify_search_queries(c: &Connection, report: &mut Report, p: &str) -> Result<()> {
    use crate::search::{Scope, fts_phrase, like_pattern, match_docs, uses_fts};
    let label = format!("{p}/search_documents.queries");
    let docs: Vec<(String, String, String, String)> = c
        .prepare(
            "SELECT entity_type, entity_key, title, body FROM p.search_documents d
             WHERE entity_id = (SELECT min(entity_id) FROM p.search_documents x WHERE x.entity_type = d.entity_type)
             ORDER BY entity_type",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let fragment = |text: &str| {
        text.split_whitespace()
            .find(|w| w.chars().count() >= 3)
            .map(|w| w.chars().take(3).collect::<String>())
    };
    let han = |ch: char| (0x4E00..=0x9FFF).contains(&(ch as u32));
    let pair = |text: &str| {
        let cs: Vec<char> = text.chars().collect();
        cs.windows(2)
            .find(|w| han(w[0]) && han(w[1]))
            .map(|w| w.iter().collect::<String>())
    };
    let mut probes: Vec<(String, String)> = Vec::new();
    for (kind, key, title, body) in &docs {
        let both = format!("{title}\n{body}");
        for (aspect, term) in [
            ("title", fragment(title)),
            ("body", fragment(body)),
            ("han", pair(&both)),
            ("key", Some(key.clone())),
        ] {
            if let Some(term) = term {
                probes.push((format!("{kind}.{aspect}"), term));
            }
        }
    }
    let (mut src_body, mut tgt_body) = (Sha256::new(), Sha256::new());
    let (mut source_rows, mut target_rows, mut errors) = (0i64, 0i64, 0i64);
    let mut first = None;
    for (at, term) in &probes {
        let (predicate, args) = if uses_fts(term) {
            (
                "(d.entity_type, d.entity_id) IN (SELECT entity_type, entity_id FROM p.search_documents_fts
                                                   WHERE search_documents_fts MATCH ?1)
                 OR d.entity_key LIKE ?2 ESCAPE '\\'",
                vec![fts_phrase(term), like_pattern(term)],
            )
        } else {
            (
                "d.title LIKE ?1 ESCAPE '\\' OR d.body LIKE ?1 ESCAPE '\\'",
                vec![like_pattern(term)],
            )
        };
        let mut st = c.prepare(&format!(
            "SELECT d.entity_key FROM p.search_documents d WHERE {predicate} ORDER BY d.entity_key"
        ))?;
        let theirs: Vec<String> = st
            .query_map(rusqlite::params_from_iter(&args), |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let mut ours: Vec<String> =
            match_docs(c, std::slice::from_ref(term), &Scope::Project(p), 1_000_000)?
                .into_iter()
                .map(|h| h.entity_key)
                .collect();
        ours.sort();
        source_rows += theirs.len() as i64;
        target_rows += ours.len() as i64;
        for (h, keys) in [(&mut src_body, &theirs), (&mut tgt_body, &ours)] {
            h.update(at.as_bytes());
            h.update([0]);
            for k in keys {
                h.update(k.as_bytes());
                h.update([0]);
            }
            h.update([0xff]);
        }
        if theirs != ours {
            errors += 1;
            first.get_or_insert_with(|| format!("{label}({at})"));
        }
    }
    let hex = |h: Sha256| {
        h.finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    };
    report.checks.push(FamilyCheck {
        family: label,
        spec: "search_documents",
        scope: p.to_string(),
        source_rows,
        target_rows,
        source_digest: hex(src_body),
        target_digest: hex(tgt_body),
        errors,
        first_failure_locator: first,
    });
    Ok(())
}

/// 计数器与它分配编号的表（05 §1.4、§3.3）。
const COUNTERS: &[(&str, &str)] = &[
    ("objective", "objectives"),
    ("milestone", "milestones"),
    ("work_item", "work_items"),
    ("blocker", "blockers"),
    ("record", "records"),
    ("review_request", "review_requests"),
    ("review_submission", "review_submissions"),
];

/// 项目的业务图校验（05 §3.3，停级）与信息项。在目标上按 project_id 查（与源逐族相等已由摘要证明），
/// 0015 投影的重算在源上跑 2.0 的 SQL。违例只写项目、表与主键。
fn verify_graph(c: &Connection, report: &mut Report, p: &str) -> Result<()> {
    let ids = |sql: &str| -> Result<Vec<String>> {
        Ok(c.prepare(sql)?
            .query_map([p], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<_>>()?)
    };
    fn stop(report: &mut Report, p: &str, what: &str, found: Vec<String>) {
        if let Some(first) = found.first() {
            report
                .graph_violations
                .push(format!("{p}/{what}: {} rows, first {first}", found.len()));
        }
    }
    // review：被审任务必须是 REVIEW；父检查项属于父任务。提交引用的记录在同一项目由复合外键保证。
    stop(
        report,
        p,
        "review_requests.review_work_item",
        ids("SELECT rr.id FROM review_requests rr
             JOIN work_items w ON w.project_id = rr.project_id AND w.id = rr.review_work_item_id
             WHERE rr.project_id = ?1 AND w.type IS NOT 'REVIEW' ORDER BY rr.id")?,
    );
    stop(
        report,
        p,
        "review_requests.parent_checklist",
        ids("SELECT rr.id FROM review_requests rr
             LEFT JOIN checklist_items ci ON ci.project_id = rr.project_id AND ci.id = rr.parent_checklist_id
             WHERE rr.project_id = ?1 AND ci.work_item_id IS NOT rr.parent_work_item_id ORDER BY rr.id")?,
    );
    // handoff 的检查点不超过项目序号。
    stop(
        report,
        p,
        "handoffs.checkpoint_sequence",
        ids(
            "SELECT h.id FROM handoffs h JOIN projects pr ON pr.id = h.project_id
             WHERE h.project_id = ?1 AND h.checkpoint_sequence > pr.project_seq ORDER BY h.id",
        )?,
    );
    // parent_session_id 与 supersedes_id 的链不成环（predecessor 的同刻环是 N-05 允许的，不在这里）。
    for (what, table, link) in [
        (
            "agent_sessions.parent_session_id",
            "agent_sessions",
            "parent_session_id",
        ),
        ("records.supersedes_id", "records", "supersedes_id"),
    ] {
        stop(
            report,
            p,
            what,
            ids(&format!(
                "WITH RECURSIVE walk(start, cur) AS (
                   SELECT id, {link} FROM {table} WHERE project_id = ?1 AND {link} IS NOT NULL
                   UNION
                   SELECT w.start, t.{link} FROM walk w JOIN {table} t ON t.project_id = ?1 AND t.id = w.cur
                   WHERE t.{link} IS NOT NULL)
                 SELECT start FROM walk WHERE cur = start ORDER BY start"
            ))?,
        );
    }
    // 计数器高水位：表里有编号时，计数器必须存在且大于最大编号。
    for (name, table) in COUNTERS {
        let (max, next): (Option<i64>, Option<i64>) = c.query_row(
            &format!(
                "SELECT (SELECT max(local_no) FROM {table} WHERE project_id = ?1),
                        (SELECT next_value FROM counters WHERE project_id = ?1 AND name = ?2)"
            ),
            params![p, name],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if let Some(max) = max
            && next.is_none_or(|n| n <= max)
        {
            report.graph_violations.push(format!(
                "{p}/counters.{name}: next_value {} is not above {table} local_no {max}",
                next.map_or("missing".to_string(), |n| n.to_string())
            ));
        }
    }
    // 回执里出现的事件序号不超过项目序号。
    stop(
        report,
        p,
        "idempotency_keys.sequence",
        // 回执原文不一定是合法 JSON（2.x 只保证 json_valid，且原始 NUL 会骗过它）：不合法的按空数组展开。
        ids("SELECT DISTINCT r.legacy_key FROM idempotency_receipts r,
                  json_tree(CASE WHEN instr(CAST(r.receipt_json AS BLOB), x'00') = 0 AND json_valid(r.receipt_json)
                                 THEN r.receipt_json ELSE '[]' END) t
             WHERE r.scope_kind = 'PROJECT' AND r.scope_id = ?1
               AND t.key = 'sequence' AND t.type = 'integer'
               AND t.atom > (SELECT project_seq FROM projects WHERE id = ?1)
             ORDER BY 1")?,
    );
    // status 与 (phase, waiting_on)：等待中的 status 对应 waiting_on，phase 仍是未结束的阶段；
    // 其余 status 等于 phase，waiting_on 为空（2.0 work-item-lifecycle-commands.ts 的写法）。
    stop(
        report,
        p,
        "work_items.status",
        ids("SELECT id FROM work_items WHERE project_id = ?1 AND NOT (
               (status = 'WAITING_USER' AND waiting_on IS 'USER' AND phase NOT IN ('DONE', 'CANCELLED'))
               OR (status = 'WAITING_AGENT' AND waiting_on IS 'AGENT' AND phase NOT IN ('DONE', 'CANCELLED'))
               OR (status NOT IN ('WAITING_USER', 'WAITING_AGENT') AND status = phase AND waiting_on IS NULL))
             ORDER BY id")?,
    );

    // 信息项：0015 的派生列按 2.0 的 SQL 在源上重算（project/0015:9-82），不一致只记报告。
    let drift = c
        .prepare(&format!(
            "SELECT id FROM (SELECT w.id, w.ever_claimed_at, w.last_started_at, w.last_session_closed_at, w.last_evidence_at,
                                    {PROJECTION_0015}
                             FROM p.work_items w)
             WHERE ever_claimed_at IS NOT e_ever OR last_started_at IS NOT e_started
                OR last_session_closed_at IS NOT e_closed OR last_evidence_at IS NOT e_evidence
             ORDER BY id"
        ))?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if let Some(first) = drift.first() {
        report.notes.push(format!(
            "{p}/work_items: 0015 projection differs on {} rows, first {first}",
            drift.len()
        ));
    }
    let lonely = ids(
        "SELECT id FROM records r WHERE project_id = ?1 AND status = 'SUPERSEDED'
                      AND NOT EXISTS (SELECT 1 FROM records n WHERE n.project_id = r.project_id
                                      AND n.supersedes_id = r.id AND n.status = 'ACTIVE')
                      ORDER BY id",
    )?;
    if let Some(first) = lonely.first() {
        report.notes.push(format!(
            "{p}/records: {} SUPERSEDED without an ACTIVE successor, first {first}",
            lonely.len()
        ));
    }
    Ok(())
}

/// 2.0 迁移 0015 的四个派生列表达式（`migrations/project/0015_reconciliation_projection.sql:9-82`），
/// 以 `w` 为当前任务、在源库 `p` 上求值，列名 e_ever / e_started / e_closed / e_evidence。
const PROJECTION_0015: &str = "
    COALESCE((SELECT MIN(event.created_at) FROM p.events event
              WHERE event.aggregate_type = 'WORK_ITEM' AND event.aggregate_id = w.id
                AND event.type IN ('work.claimed', 'work.started')), w.started_at) AS e_ever,
    COALESCE((SELECT MAX(event.created_at) FROM p.events event
              WHERE event.aggregate_type = 'WORK_ITEM' AND event.aggregate_id = w.id
                AND event.type = 'work.started'), w.started_at) AS e_started,
    (SELECT MAX(session.closed_at) FROM p.events event
       JOIN p.agent_sessions session ON session.id = event.session_id
     WHERE event.aggregate_type = 'WORK_ITEM' AND event.aggregate_id = w.id
       AND event.type IN ('work.claimed', 'work.started') AND session.closed_at IS NOT NULL) AS e_closed,
    (SELECT MAX(candidate.at) FROM (
       SELECT progress.created_at AS at FROM p.progress_updates progress
       WHERE progress.work_item_id = w.id AND COALESCE(json_array_length(progress.evidence_json), 0) > 0
       UNION ALL
       SELECT checklist.updated_at AS at FROM p.checklist_items checklist
       WHERE checklist.work_item_id = w.id AND COALESCE(json_array_length(checklist.evidence_json), 0) > 0
       UNION ALL
       SELECT submission.created_at AS at FROM p.review_submissions submission
         JOIN p.review_requests request ON request.id = submission.request_id
       WHERE (request.review_work_item_id = w.id OR request.parent_work_item_id = w.id)
         AND COALESCE(json_array_length(submission.evidence_json), 0) > 0
       UNION ALL
       SELECT project_update.created_at AS at FROM p.project_updates project_update
         JOIN json_each(CASE WHEN json_valid(project_update.completed_json) THEN project_update.completed_json ELSE '[]' END) completed
       WHERE project_update.status = 'PUBLISHED'
         AND COALESCE(json_array_length(project_update.evidence_json), 0) > 0
         AND json_type(CASE WHEN completed.type = 'object' THEN completed.value ELSE '{}' END, '$.workItemKey') = 'text'
         AND json_extract(CASE WHEN completed.type = 'object' THEN completed.value ELSE '{}' END, '$.workItemKey') =
             (SELECT meta.project_code || '-T-' || printf('%04d', w.local_no) FROM p.project_meta meta WHERE meta.singleton = 1)
     ) candidate) AS e_evidence";

// ===== VERIFY：规范化规则的独立重算（store/NORMALIZATION.md）=====
// 这里的 SQL 与转换写入的那一份分开写：同一条规则由两段代码各自表述，互相核对。

/// N-04：registry settings 的期望目标由源按 2.x 读法推出，与目标逐行比对；受影响的键另算一份。
fn verify_settings(c: &Connection, report: &mut Report, re: &mut Recheck) -> Result<()> {
    let cols: Vec<String> = ["key", "value_json", "version", "updated_at"]
        .map(String::from)
        .to_vec();
    // SQLite 的 JSON 函数在原始 NUL 处截断：先排除含 NUL 的文本，再交给 json_valid；嵌套 CASE 保证
    // 不合法的文本不会进 json_type / ->>（W3a peer r1 P1-02）。
    let mode_ok = |v: &str| {
        format!(
            "CASE WHEN instr(CAST({v} AS BLOB), x'00') > 0 THEN 0
                  WHEN NOT json_valid({v}) THEN 0
                  WHEN json_type({v}) <> 'text' THEN 0
                  ELSE ({v} ->> '$') IN ('ALL', 'CRITICAL', 'OFF') END"
        )
    };
    let enabled_off = "CASE WHEN instr(CAST(v AS BLOB), x'00') > 0 THEN 0
                            WHEN NOT json_valid(v) THEN 0
                            ELSE json_type(v) = 'false' END";
    let expected = format!(
        "WITH e AS (SELECT value_json AS v, version, updated_at FROM r.settings WHERE key = 'notification.enabled'),
              m AS (SELECT value_json AS v, version, updated_at FROM r.settings WHERE key = 'notification.mode'),
              ok AS (SELECT {} AS valid FROM m),
              derived AS (SELECT coalesce((SELECT CASE WHEN {enabled_off} THEN '\"OFF\"' END FROM e), '\"ALL\"') AS d)
         SELECT key, value_json, version, updated_at FROM r.settings
           WHERE key NOT IN ('notification.enabled', 'notification.mode')
         UNION ALL
         SELECT 'notification.mode', iif((SELECT valid FROM ok) = 1, m.v, (SELECT d FROM derived)), m.version, m.updated_at FROM m
         UNION ALL
         SELECT 'notification.mode', (SELECT d FROM derived), e.version, e.updated_at FROM e
           WHERE NOT EXISTS (SELECT 1 FROM m)
         ORDER BY 1",
        mode_ok("v")
    );
    compare(
        c,
        report,
        Ck {
            spec: "settings",
            label: "r/settings",
            key: &["key"],
        },
        &cols,
        &expected,
        &[],
        "SELECT key, value_json, version, updated_at FROM main.settings ORDER BY key",
        &[],
    )?;
    let keys = key_list(
        c,
        &format!(
            "SELECT key FROM r.settings WHERE key = 'notification.enabled'
             UNION
             SELECT 'notification.mode' FROM r.settings
               WHERE key = 'notification.enabled' AND NOT EXISTS (SELECT 1 FROM r.settings WHERE key = 'notification.mode')
             UNION
             SELECT key FROM r.settings WHERE key = 'notification.mode' AND NOT ({})",
            mode_ok("value_json")
        ),
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
            "progress_source" => {
                "iif(progress_source IS 'STATUS', 'NONE', progress_source)".to_string()
            }
            _ => format!("\"{col}\""),
        })
        .collect::<Vec<_>>()
        .join(", ");
    let order = list(&pk);
    let key: Vec<&str> = pk.iter().map(String::as_str).collect();
    compare(
        c,
        report,
        Ck {
            spec: "work_items",
            label: &family("work_items"),
            key: &key,
        },
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
    let key: Vec<&str> = pk.iter().map(String::as_str).collect();
    compare(
        c,
        report,
        Ck {
            spec: "work_item_relations",
            label: &family("work_item_relations"),
            key: &key,
        },
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

    // N-02g、h：checklist_items 与 blockers 的期望目标；N-02g～i 的主键集合与附件。
    for (table, overrides) in [
        (
            "checklist_items",
            &[
                ("kind", "'ACCEPTANCE'"),
                (
                    "status",
                    "iif(kind IS 'OPTIONAL' AND evidence_required = 0 AND (status IS 'TODO' OR status IS 'DOING'),
                         'SKIPPED', status)",
                ),
            ][..],
        ),
        ("blockers", &[("status", "iif(status IS 'CANCELLED', 'RESOLVED', status)")][..]),
    ] {
        let (cols, pk) = columns(c, "p", table)?;
        let source = cols
            .iter()
            .map(|col| {
                overrides
                    .iter()
                    .find(|(name, _)| name == col)
                    .map_or_else(|| format!("\"{col}\""), |(_, e)| e.to_string())
            })
            .collect::<Vec<_>>()
            .join(", ");
        let order = list(&pk);
        let key: Vec<&str> = pk.iter().map(String::as_str).collect();
        compare(
            c,
            report,
            Ck {
                spec: table,
                label: &family(table),
                key: &key,
            },
            &cols,
            &format!("SELECT {source} FROM p.{table} ORDER BY {order}"),
            &[],
            &format!("SELECT {} FROM main.{table} WHERE project_id = ?1 ORDER BY {order}", list(&cols)),
            &[&p],
        )?;
    }
    for (rule, table, col, predicate, extra) in [
        (
            "N-02g@1",
            "checklist_items",
            "kind",
            "kind IN ('REQUIRED', 'OPTIONAL', 'VERIFICATION')",
            ", 'status', status",
        ),
        ("N-02h@1", "blockers", "status", "status IS 'CANCELLED'", ""),
        (
            "N-02i@1",
            "work_items",
            "progress_source",
            "progress_source IS 'STATUS'",
            "",
        ),
    ] {
        let f = format!("{}.{col}", family(table));
        re.push(
            rule,
            &f,
            key_list(c, &format!("SELECT id FROM p.{table} WHERE {predicate}"))?,
        );
        re.attach(
            f,
            key_list(
                c,
                &format!(
                    "SELECT json_object('id', id, 'value', \"{col}\"{extra}) FROM p.{table} WHERE {predicate} ORDER BY id"
                ),
            )?,
        );
    }

    // N-05 的时间接受域，与转换侧的 canonical_utc_millis 分开写：形状逐位核对，时、分、秒各自查范围，
    // 日期用 SQLite 的 date() 往返（2 月 30 日会被挪到 3 月，往返后不等）。只靠 strftime 往返会放过 24:00
    // （W3a peer r2 P2-R2-01）。
    let odd: i64 = c.query_row(
        "SELECT count(*) FROM p.agent_sessions a
         WHERE (a.predecessor_session_id IS NOT NULL
                OR EXISTS (SELECT 1 FROM p.agent_sessions b WHERE b.predecessor_session_id = a.id))
           AND NOT (typeof(a.started_at) = 'text'
                    AND length(a.started_at) = 24
                    AND a.started_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
                    AND CAST(substr(a.started_at, 12, 2) AS INTEGER) < 24
                    AND CAST(substr(a.started_at, 15, 2) AS INTEGER) < 60
                    AND CAST(substr(a.started_at, 18, 2) AS INTEGER) < 60
                    AND date(substr(a.started_at, 1, 10)) IS substr(a.started_at, 1, 10))",
        [],
        |r| r.get(0),
    )?;
    if odd > 0 {
        report.rule_mismatches.push(format!(
            "{}: {odd} lineage endpoints outside the N-05 time domain",
            family("agent_sessions")
        ));
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
