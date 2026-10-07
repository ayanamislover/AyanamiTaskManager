//! 2.x → 3.0 的转换状态机（W3d；07 §1–§5）：准入、SNAPSHOT / IMPORT / VERIFY / PUBLISHING / PUBLISHED、
//! 清单 `M` 与权威记录 `A` 的原子写、staging、启动判定 S1–S6、封存与隔离。
//!
//! 只管文件与状态；进程级的事（单实例互斥、旧版是否静止、起不起入口）由宿主决定，这里给出判定结果。
//! 发布之前不起任何入口：[`decide`] 返回 [`Startup::Published`] 之前，宿主不应启动服务。
//!
//! 布局（`N` 是新根）：
//! - `N\conversion.json`：清单 `M`；`N\authority.json`：权威记录 `A`；
//! - `N\staging\<g>\`：一次转换尝试——`src\`（SNAPSHOT 的副本）、`data\`（转换出的库、附件、sync / dispatch 文件）、
//!   `report.json`；
//! - `N\data\`：发布物（`atm.sqlite` 及其旁边的 `artifacts\`、`sync\`、`dispatch\`），由 `staging\<g>\data\` 整体改名而来；
//! - `N\quarantine\`、`N\superseded\`：隔离与封存，按 generation 整体移入；
//! - `N\runtime\service.lock`：准入的 lease；`N\runtime\seal.json`：进行中的封存 / 隔离（重入时据此续做）。

use crate::jsjson::{self, Value};
use crate::legacy::{self, ConvertError, ConvertOptions, LegacySources, Report};
use crate::pin;
use rusqlite::{Connection, OpenFlags};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------- 布局

/// 新根 `N` 下的各个位置。
#[derive(Clone, Debug)]
pub struct Layout {
    pub root: PathBuf,
}

impl Layout {
    pub fn new(root: impl Into<PathBuf>) -> Layout {
        Layout { root: root.into() }
    }
    pub fn manifest(&self) -> PathBuf {
        self.root.join("conversion.json")
    }
    pub fn authority(&self) -> PathBuf {
        self.root.join("authority.json")
    }
    pub fn data(&self) -> PathBuf {
        self.root.join("data")
    }
    pub fn database(&self) -> PathBuf {
        self.data().join("atm.sqlite")
    }
    pub fn staging(&self, generation: &str) -> PathBuf {
        self.root.join("staging").join(generation)
    }
    pub fn runtime(&self) -> PathBuf {
        self.root.join("runtime")
    }
    fn seal_intent(&self) -> PathBuf {
        self.runtime().join("seal.json")
    }
}

// ---------------------------------------------------------------- 错误

#[derive(Debug)]
pub enum Error {
    Io(std::io::Error),
    Sqlite(rusqlite::Error),
    Store(crate::StoreError),
    /// 转换器拒绝或 VERIFY 失败（报告已写到 staging）。
    Convert(ConvertError),
    /// SNAPSHOT 前后两次枚举不一致，或副本与源不一致：源未静止（07 §3、F1）。
    SourceNotQuiet(String),
    /// VERIFY 通过了，但报告里还有没处理的族实例（提交门，REPORT.md「pending」）。
    Unpublishable(String),
    /// 前提不满足，动手之前就拒绝（例如 dry-run 的输出目录落在数据根里）。
    Refused(String),
    /// 测试注入的中断（模拟进程被杀）。
    Interrupted(&'static str),
    /// dry-run 的清理没做完：输出目录里有不是本次建的东西，或者本次建的东西被换过。那些条目原样留下，
    /// 不删；`outcome` 是清理之前的结果（报告已经写出时它就在输出目录里）。
    CleanupIncomplete {
        left: Vec<String>,
        outcome: String,
    },
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Io(e) => write!(f, "{e}"),
            Error::Sqlite(e) => write!(f, "{e}"),
            Error::Store(e) => write!(f, "{e}"),
            Error::Convert(e) => write!(f, "{e}"),
            Error::SourceNotQuiet(m) => write!(f, "the 2.x data root changed during SNAPSHOT: {m}"),
            Error::Unpublishable(why) => write!(f, "the conversion cannot be published: {why}"),
            Error::Refused(why) => write!(f, "refused: {why}"),
            Error::Interrupted(at) => write!(f, "interrupted at {at}"),
            Error::CleanupIncomplete { left, outcome } => write!(
                f,
                "the dry-run output was not fully removed (left as is: {}); the run itself ended with {outcome}",
                left.join("; ")
            ),
        }
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Error {
        Error::Io(e)
    }
}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Error {
        Error::Sqlite(e)
    }
}

impl From<crate::StoreError> for Error {
    fn from(e: crate::StoreError) -> Error {
        Error::Store(e)
    }
}

impl From<ConvertError> for Error {
    fn from(e: ConvertError) -> Error {
        Error::Convert(e)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

// ---------------------------------------------------------------- 原子写

/// 改名，落盘之后才返回（07 §1）：共用的持久化契约（[`atm_install_state::durable::rename`]，
/// `MoveFileExW(WRITE_THROUGH [| REPLACE_EXISTING])`，共享冲突退避重试）。不替换时目标已存在就失败（发布与封存都不覆盖）。
fn rename_durable(from: &Path, to: &Path, replace: bool) -> std::io::Result<()> {
    atm_install_state::durable::rename(from, to, replace)
}

/// IO 错误带上操作与路径：诊断时光有「系统找不到指定的文件」无从下手。
fn located(e: std::io::Error, what: &str, path: &dyn std::fmt::Display) -> std::io::Error {
    std::io::Error::new(e.kind(), format!("{what} {path}: {e}"))
}

trait Located<T> {
    fn at(self, what: &str, path: &Path) -> std::io::Result<T>;
}

impl<T> Located<T> for std::io::Result<T> {
    fn at(self, what: &str, path: &Path) -> std::io::Result<T> {
        self.map_err(|e| located(e, what, &path.display()))
    }
}

/// 先写同目录的临时文件并刷盘，再落盘地改名替换：替换要么是旧的、要么是新的（[`atm_install_state::durable::write_atomic`]）。
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    atm_install_state::durable::write_atomic(path, bytes)
}

fn is_sha256_hex(d: &str) -> bool {
    d.len() == 64
        && d.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn sha_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn file_sha256(path: &Path) -> std::io::Result<String> {
    let mut h = Sha256::new();
    let mut f = crate::progress::Read::new(File::open(path).at("open", path)?);
    std::io::copy(&mut f, &mut h).at("read", path)?;
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

// ---------------------------------------------------------------- 清单 M

/// SNAPSHOT 枚举到的一个源文件。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceFile {
    pub rel: String,
    pub size: u64,
    /// 修改时间，Unix 毫秒。只用于排读取顺序，不参与判定（07 §6）。
    pub mtime_ms: i64,
    pub sha256: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Snapshot,
    Import,
    Verify,
    Publishing,
    Published,
    /// 这次尝试失败了：staging 保留供诊断，下次启动按 S3 丢弃重来。
    Failed,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Snapshot => "SNAPSHOT",
            Phase::Import => "IMPORT",
            Phase::Verify => "VERIFY",
            Phase::Publishing => "PUBLISHING",
            Phase::Published => "PUBLISHED",
            Phase::Failed => "FAILED",
        }
    }
    fn parse(s: &str) -> Option<Phase> {
        Some(match s {
            "SNAPSHOT" => Phase::Snapshot,
            "IMPORT" => Phase::Import,
            "VERIFY" => Phase::Verify,
            "PUBLISHING" => Phase::Publishing,
            "PUBLISHED" => Phase::Published,
            "FAILED" => Phase::Failed,
            _ => return None,
        })
    }
}

/// `N\conversion.json`（07 §1）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Manifest {
    pub converter_version: String,
    /// `L`；全新安装（S1）时为 `None`。
    pub source_root: Option<String>,
    pub source_files: Vec<SourceFile>,
    pub business_digest: BTreeMap<String, String>,
    /// 用户点名舍弃的不可转换项目（`ConvertOptions::accept_unconvertible`）。§6 重算 business_digest' 时照样传，
    /// 否则同一个源会因为这些项目转换失败而得出 UNKNOWN。
    pub accepted_unconvertible: Vec<String>,
    pub generation: String,
    pub phase: Phase,
    /// `report.json` 的 sha256。
    pub verify_digest: Option<String>,
    /// 发布物里库之外的文件集合（附件、sync、dispatch）的摘要；S4 据此与库内 generation 一起认发布物。
    pub publication_digest: Option<String>,
    /// 转换时刻：落定与 `updated_at` 都用它，§6 重算 business_digest 也要用同一个。
    pub started_at: String,
    pub published_at: Option<String>,
    /// FAILED 的原因（不含正文与密钥）。
    pub failure: Option<String>,
}

fn s(v: &str) -> Value {
    Value::String(v.to_string())
}

fn opt(v: &Option<String>) -> Value {
    v.as_deref().map_or(Value::Null, s)
}

fn field<'v>(v: &'v Value, key: &str) -> Option<&'v Value> {
    match v {
        Value::Object(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
        _ => None,
    }
}

fn text(v: &Value, key: &str) -> Option<String> {
    match field(v, key) {
        Some(Value::String(x)) => Some(x.clone()),
        _ => None,
    }
}

fn opt_text(v: &Value, key: &str) -> Option<Option<String>> {
    match field(v, key) {
        Some(Value::String(x)) => Some(Some(x.clone())),
        Some(Value::Null) => Some(None),
        _ => None,
    }
}

impl Manifest {
    pub fn to_json(&self) -> String {
        let files = self
            .source_files
            .iter()
            .map(|f| {
                Value::Object(vec![
                    ("rel".into(), s(&f.rel)),
                    ("size".into(), Value::Number(f.size as f64)),
                    ("mtime".into(), Value::Number(f.mtime_ms as f64)),
                    ("sha256".into(), s(&f.sha256)),
                ])
            })
            .collect();
        let digest = self
            .business_digest
            .iter()
            .map(|(k, v)| (k.clone(), s(v)))
            .collect();
        jsjson::jcs(&Value::Object(vec![
            ("schema".into(), Value::Number(1.0)),
            ("converter_version".into(), s(&self.converter_version)),
            ("source_root".into(), opt(&self.source_root)),
            ("source_files".into(), Value::Array(files)),
            ("business_digest".into(), Value::Object(digest)),
            (
                "accepted_unconvertible".into(),
                Value::Array(self.accepted_unconvertible.iter().map(|p| s(p)).collect()),
            ),
            ("generation".into(), s(&self.generation)),
            ("phase".into(), s(self.phase.as_str())),
            ("verify_digest".into(), opt(&self.verify_digest)),
            ("publication_digest".into(), opt(&self.publication_digest)),
            ("started_at".into(), s(&self.started_at)),
            ("published_at".into(), opt(&self.published_at)),
            ("failure".into(), opt(&self.failure)),
        ]))
    }

    /// 形状不对就是损坏（`None`），不猜缺省值。
    pub fn parse(text_: &str) -> Option<Manifest> {
        let v = jsjson::parse_value(text_).ok().flatten()?;
        if !matches!(field(&v, "schema"), Some(Value::Number(n)) if *n == 1.0) {
            return None;
        }
        let mut source_files = Vec::new();
        match field(&v, "source_files")? {
            Value::Array(items) => {
                for f in items {
                    let num = |k: &str| match field(f, k) {
                        Some(Value::Number(n)) if n.fract() == 0.0 => Some(*n),
                        _ => None,
                    };
                    source_files.push(SourceFile {
                        rel: text(f, "rel")?,
                        size: num("size")? as u64,
                        mtime_ms: num("mtime")? as i64,
                        sha256: text(f, "sha256")?,
                    });
                }
            }
            _ => return None,
        }
        let business_digest = match field(&v, "business_digest")? {
            Value::Object(entries) => entries
                .iter()
                .map(|(k, x)| match x {
                    Value::String(d) => Some((k.clone(), d.clone())),
                    _ => None,
                })
                .collect::<Option<_>>()?,
            _ => return None,
        };
        let accepted_unconvertible = match field(&v, "accepted_unconvertible")? {
            Value::Array(items) => items
                .iter()
                .map(|x| match x {
                    Value::String(p) => Some(p.clone()),
                    _ => None,
                })
                .collect::<Option<_>>()?,
            _ => return None,
        };
        // 摘要只收 64 位小写十六进制；PUBLISHING 与 PUBLISHED 必须有发布物摘要（S4 靠它认发布物）。
        let publication_digest = opt_text(&v, "publication_digest")?;
        let phase = Phase::parse(&text(&v, "phase")?)?;
        match &publication_digest {
            Some(d) if !is_sha256_hex(d) => return None,
            None if matches!(phase, Phase::Publishing | Phase::Published) => return None,
            _ => {}
        }
        Some(Manifest {
            converter_version: text(&v, "converter_version")?,
            source_root: opt_text(&v, "source_root")?,
            source_files,
            business_digest,
            accepted_unconvertible,
            generation: text(&v, "generation")?,
            phase,
            verify_digest: opt_text(&v, "verify_digest")?,
            publication_digest,
            started_at: text(&v, "started_at")?,
            published_at: opt_text(&v, "published_at")?,
            failure: opt_text(&v, "failure")?,
        })
    }
}

/// 读 `M`：不存在、损坏（读不出、不是合法形状）、正常。
#[derive(Clone, Debug, PartialEq, Eq)]
// 每次启动只构造一两次，不值得为大小装箱。
#[allow(clippy::large_enum_variant)]
pub enum ManifestState {
    Missing,
    Corrupt,
    Present(Manifest),
}

pub fn read_manifest(layout: &Layout) -> ManifestState {
    match std::fs::read(layout.manifest()) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => ManifestState::Missing,
        Err(_) => ManifestState::Corrupt,
        Ok(bytes) => match std::str::from_utf8(&bytes).ok().and_then(Manifest::parse) {
            Some(m) => ManifestState::Present(m),
            None => ManifestState::Corrupt,
        },
    }
}

pub fn write_manifest(layout: &Layout, m: &Manifest) -> std::io::Result<()> {
    write_atomic(&layout.manifest(), m.to_json().as_bytes())
}

// ---------------------------------------------------------------- 权威记录 A

/// `N\authority.json`（07 §1）。`by` 取 `publish`、`setup-rollback`、`user-choice`、`resume-after-rollback`。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Authority {
    /// `v3` 或 `legacy`。
    pub authority: String,
    pub by: String,
    pub txn: Option<String>,
    pub at: String,
    /// 这条记录绑定的 generation（B3：与 `M.generation` 对不上就按冲突处理）。
    pub generation: Option<String>,
    /// 用户选「沿用 3.0」时接受的 business_digest'（07 §7，W3e）。只有完整摘要能被接受：
    /// 比较是 UNKNOWN 时没有东西可绑，那次选择只放行当次，下一次比较仍是 UNKNOWN 就再冲突（07 §6）。
    pub accepted_source_digest: Option<BTreeMap<String, String>>,
}

impl Authority {
    pub fn to_json(&self) -> String {
        let accepted = self
            .accepted_source_digest
            .as_ref()
            .map_or(Value::Null, |d| {
                Value::Object(d.iter().map(|(k, v)| (k.clone(), s(v))).collect())
            });
        jsjson::jcs(&Value::Object(vec![
            ("authority".into(), s(&self.authority)),
            ("by".into(), s(&self.by)),
            ("txn".into(), opt(&self.txn)),
            ("at".into(), s(&self.at)),
            ("generation".into(), opt(&self.generation)),
            ("accepted_source_digest".into(), accepted),
        ]))
    }

    pub fn parse(text_: &str) -> Option<Authority> {
        let v = jsjson::parse_value(text_).ok().flatten()?;
        let authority = text(&v, "authority")?;
        if authority != "v3" && authority != "legacy" {
            return None;
        }
        let accepted = match field(&v, "accepted_source_digest") {
            None | Some(Value::Null) => None,
            Some(Value::Object(entries)) => Some(
                entries
                    .iter()
                    .map(|(k, x)| match x {
                        Value::String(d) => Some((k.clone(), d.clone())),
                        _ => None,
                    })
                    .collect::<Option<_>>()?,
            ),
            Some(_) => return None,
        };
        Some(Authority {
            authority,
            by: text(&v, "by")?,
            txn: opt_text(&v, "txn")?,
            at: text(&v, "at")?,
            generation: opt_text(&v, "generation")?,
            accepted_source_digest: accepted,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AuthorityState {
    Missing,
    Corrupt,
    Present(Authority),
}

pub fn read_authority(layout: &Layout) -> AuthorityState {
    match std::fs::read(layout.authority()) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => AuthorityState::Missing,
        Err(_) => AuthorityState::Corrupt,
        Ok(bytes) => match std::str::from_utf8(&bytes).ok().and_then(Authority::parse) {
            Some(a) => AuthorityState::Present(a),
            None => AuthorityState::Corrupt,
        },
    }
}

pub fn write_authority(layout: &Layout, a: &Authority) -> std::io::Result<()> {
    write_atomic(&layout.authority(), a.to_json().as_bytes())
}

// ---------------------------------------------------------------- 准入

/// 旧版是否静止（07 §2 第 2 条），由宿主判定：lease、进程映像路径、安装事务的 FENCE。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Quiesce {
    Quiet,
    /// 旧版还在运行，或者判定不了：进 `WAIT_LEGACY_QUIESCE`，不转换、不发布。
    Wait(String),
}

/// 拿到了准入：持有 `N\runtime\service.lock` 的独占锁，直到它被丢弃。
#[derive(Debug)]
pub struct Admission {
    _lock: File,
}

#[derive(Debug)]
pub enum AdmitError {
    /// 另一个实例持有 lease（F7）。
    AlreadyRunning,
    /// 旧版还没静止。
    WaitLegacyQuiesce(String),
    Io(std::io::Error),
}

/// 准入：先拿 `N` 的 lease，再问旧版是否静止。两步都过才能转换。
pub fn admit(
    layout: &Layout,
    legacy: impl FnOnce() -> Quiesce,
) -> std::result::Result<Admission, AdmitError> {
    std::fs::create_dir_all(layout.runtime()).map_err(AdmitError::Io)?;
    let f = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(layout.runtime().join("service.lock"))
        .map_err(AdmitError::Io)?;
    match f.try_lock() {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => return Err(AdmitError::AlreadyRunning),
        Err(std::fs::TryLockError::Error(e)) => return Err(AdmitError::Io(e)),
    }
    match legacy() {
        Quiesce::Quiet => Ok(Admission { _lock: f }),
        Quiesce::Wait(reason) => Err(AdmitError::WaitLegacyQuiesce(reason)),
    }
}

// ---------------------------------------------------------------- 启动判定

/// 07 §4 的判定结果。
#[derive(Clone, Debug, PartialEq, Eq)]
// 每次启动只构造一两次，不值得为大小装箱。
#[allow(clippy::large_enum_variant)]
pub enum Startup {
    /// 上一次封存 / 隔离被打断：先 [`seal`] 续做完，再重新判定。
    ResumeSeal,
    /// S1：`L` 不存在，也没有 `M`：建空库。
    FreshInstall,
    /// S2：没有 `M`，`L` 存在：从 SNAPSHOT 开始。
    FirstConversion,
    /// S3：`M` 停在 SNAPSHOT / IMPORT / VERIFY / FAILED，或停在 PUBLISHING 但还没改名：
    /// [`discard_attempt`] 后换新 generation 重来。
    Restart { generation: String },
    /// S4：`M` 停在 PUBLISHING，发布物的 generation 与文件摘要都与 `M` 一致：[`finish_publishing`]。
    FinishPublishing { generation: String },
    /// S4 的另一支与 S5：发布物不可信（身份不一致、读不出，或 `M` 缺失 / 损坏）。
    /// [`seal`]`(Quarantine)` 后重新判定（走 S2 / S1）。`M` 缺失或损坏时发布物绝不打开。
    Quarantine { reason: String },
    /// S6：`M` 是 PUBLISHED，库内 generation 一致：进 §6 的权威判定（[`judge`]）。
    Published(Manifest),
    /// S6，但这个 generation 正处于数据源冲突（07 §7）：不起任何业务入口，等用户在窗口里
    /// [`choose_v3`] 或 [`choose_legacy`]。
    SourceConflict(StartupState),
}

/// 发布物在不在：`N\data\` 里有任何东西都算在。
fn publication_exists(layout: &Layout) -> bool {
    std::fs::read_dir(layout.data()).is_ok_and(|mut d| d.next().is_some())
}

/// 库内的 `app_meta.generation`（只读打开）。只在 `M` 可信时调用。
fn published_generation(layout: &Layout) -> Option<String> {
    let db = layout.database();
    if !db.is_file() {
        return None;
    }
    let c = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    c.query_row("SELECT generation FROM app_meta", [], |r| r.get(0))
        .ok()
}

/// 发布物里库之外的文件：`artifacts\`、`sync\`、`dispatch\` 三个子树里 (相对路径, size, sha256) 的集合摘要。
/// 库与它的 -wal / -shm 由 generation 认，不算。只看这三个子树：库旁边会冒出别的程序的临时文件
/// （实测有 `ATM.SQLITE-SHM.tmp`，随建随删、还被占着），它们不属于发布物。列出后又消失的文件同理跳过。
fn publication_digest(dir: &Path) -> std::io::Result<String> {
    let gone = |e: &std::io::Error| e.kind() == std::io::ErrorKind::NotFound;
    let mut files = Vec::new();
    let mut stack: Vec<(PathBuf, String)> = ["artifacts", "sync", "dispatch"]
        .into_iter()
        .map(|sub| (dir.join(sub), sub.to_string()))
        .filter(|(d, _)| d.is_dir())
        .collect();
    while let Some((d, prefix)) = stack.pop() {
        for e in std::fs::read_dir(&d).at("list", &d)? {
            let e = e.at("list", &d)?;
            let rel = format!("{prefix}/{}", e.file_name().to_string_lossy());
            let meta = match e.metadata() {
                Err(x) if gone(&x) => continue,
                m => m.at("stat", &e.path())?,
            };
            if meta.is_dir() {
                stack.push((e.path(), rel));
                continue;
            }
            match file_sha256(&e.path()) {
                Err(x) if gone(&x) => continue,
                sha => files.push((rel, meta.len(), sha?)),
            }
        }
    }
    files.sort();
    let mut h = Sha256::new();
    h.update(b"ATM-PUBLICATION-1");
    for (rel, size, sha) in files {
        h.update(rel.as_bytes());
        h.update([0]);
        h.update(size.to_string().as_bytes());
        h.update([0]);
        h.update(sha.as_bytes());
        h.update([0]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// 07 §4：只看 `M`、发布物的身份与有没有进行中的封存。`legacy_exists` 是 `L` 在不在。
/// 发布之后服务会往附件、sync、dispatch 里写，所以 S6 只认库内 generation；文件摘要只在 S4（服务还没起过）比。
pub fn decide(layout: &Layout, legacy_exists: bool) -> Startup {
    if layout.seal_intent().exists() {
        return Startup::ResumeSeal;
    }
    let m = match read_manifest(layout) {
        ManifestState::Present(m) => m,
        state => {
            return if publication_exists(layout) {
                // S5：M 缺失或损坏，发布物不可信，绝不打开。
                Startup::Quarantine {
                    reason: if state == ManifestState::Corrupt {
                        "the manifest is corrupt".into()
                    } else {
                        "the manifest is missing".into()
                    },
                }
            } else if legacy_exists {
                Startup::FirstConversion
            } else {
                Startup::FreshInstall
            };
        }
    };
    let published = publication_exists(layout);
    match m.phase {
        Phase::Snapshot | Phase::Import | Phase::Verify | Phase::Failed if published => {
            Startup::Quarantine {
                // 还没走到 PUBLISHING，却有发布物：不是这个 M 的。
                reason: format!(
                    "a publication exists while generation {} is {}",
                    m.generation,
                    m.phase.as_str()
                ),
            }
        }
        Phase::Snapshot | Phase::Import | Phase::Verify | Phase::Failed => Startup::Restart {
            generation: m.generation,
        },
        // 改名之前被打断：什么都没发布，按 S3 重来。
        Phase::Publishing if !published => Startup::Restart {
            generation: m.generation,
        },
        Phase::Publishing => {
            // 只有「实际读出的摘要」与「M 里合法的摘要」相等才算同一份；读失败不能变成可相等的缺省值。
            let same_files = match (publication_digest(&layout.data()), &m.publication_digest) {
                (Ok(actual), Some(expected)) => actual == *expected,
                _ => false,
            };
            match published_generation(layout) {
                Some(g) if g == m.generation && same_files => Startup::FinishPublishing {
                    generation: m.generation,
                },
                Some(g) if g == m.generation => Startup::Quarantine {
                    reason: format!(
                        "the published files of generation {} do not match the manifest",
                        m.generation
                    ),
                },
                Some(g) => Startup::Quarantine {
                    reason: format!(
                        "the publication is generation {g}, the manifest says {}",
                        m.generation
                    ),
                },
                None => Startup::Quarantine {
                    reason: format!("generation {} has no readable publication", m.generation),
                },
            }
        }
        Phase::Published => match published_generation(layout) {
            Some(g) if g == m.generation => match read_startup_state(layout) {
                Some(state) if state.generation == m.generation => Startup::SourceConflict(state),
                _ => Startup::Published(m),
            },
            Some(g) => Startup::Quarantine {
                reason: format!(
                    "the publication is generation {g}, the manifest says {}",
                    m.generation
                ),
            },
            None => Startup::Quarantine {
                reason: format!("generation {} has no readable publication", m.generation),
            },
        },
    }
}

// ---------------------------------------------------------------- 封存与隔离

/// 封存（被 2.x 取代、整体留存）或隔离（不可信、不打开）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Seal {
    Superseded,
    Quarantine,
}

impl Seal {
    fn dir(self) -> &'static str {
        match self {
            Seal::Superseded => "superseded",
            Seal::Quarantine => "quarantine",
        }
    }
}

fn stamp(at: &str) -> String {
    at.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// 07 §5：把整个 generation（`N\data\` 全部、`M` 与 `A` 的副本）移进 `N\<quarantine|superseded>\<g>-<ts>\`。
/// - 封存先在独占条件下 `wal_checkpoint(TRUNCATE)`；做不了（库坏了）就原样保留整套文件。隔离绝不打开库。
/// - 先把目标写进 `N\runtime\seal.json`，再移动；中断后再调用，按记下的目标续做，已在目标里的不再覆盖。
/// - 完成后删掉 `M` 与 `A`（它们的副本已在目标里），调用方随后按 S2 / S1 继续。
pub fn seal(layout: &Layout, kind: Seal, at: &str) -> Result<PathBuf> {
    seal_with(layout, kind, at, &mut |_| true)
}

/// 封存的注入点（测试模拟中途被杀）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SealStep {
    /// 意图文件写好、还没移动。
    Intended,
    /// 发布物已移走、`M` 与 `A` 还没收尾。
    Moved,
    /// `M` 的副本已写好、`A` 的还没写。
    ManifestCopied,
}

/// [`seal`] 带注入点：`stop` 返回 `false` 时就地中断。
pub fn seal_with(
    layout: &Layout,
    kind: Seal,
    at: &str,
    stop: &mut dyn FnMut(SealStep) -> bool,
) -> Result<PathBuf> {
    let intent = layout.seal_intent();
    // 续做时以意图文件为准（种类与目标都不变），参数里的 kind 只在新开一次时用。
    let resumed = std::fs::read_to_string(&intent).ok().and_then(|t| {
        let v = jsjson::parse_value(&t).ok().flatten()?;
        let kind = match text(&v, "kind")?.as_str() {
            "superseded" => Seal::Superseded,
            "quarantine" => Seal::Quarantine,
            _ => return None,
        };
        Some((kind, text(&v, "name")?))
    });
    let (kind, target) = match resumed {
        Some((kind, name)) => (kind, layout.root.join(kind.dir()).join(name)),
        None => {
            let generation = match read_manifest(layout) {
                ManifestState::Present(m) => m.generation,
                _ => "unknown".to_string(),
            };
            let base = layout.root.join(kind.dir());
            let mut name = format!("{generation}-{}", stamp(at));
            let mut n = 1;
            while base.join(&name).exists() {
                n += 1;
                name = format!("{generation}-{}-{n}", stamp(at));
            }
            write_atomic(
                &intent,
                jsjson::jcs(&Value::Object(vec![
                    ("kind".into(), s(kind.dir())),
                    ("name".into(), s(&name)),
                ]))
                .as_bytes(),
            )?;
            (kind, base.join(name))
        }
    };
    std::fs::create_dir_all(&target)?;
    if !stop(SealStep::Intended) {
        return Err(Error::Interrupted("SEAL"));
    }
    if kind == Seal::Superseded && layout.database().is_file() {
        // 做不了就算了：原样保留整套文件（07 §5）。
        let _ = Connection::open(layout.database())
            .and_then(|c| c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);"));
    }
    if layout.data().exists() {
        // 目标里已经有 data（上一次移过，之后又出现了新的发布物）：换个名字整体移入，不覆盖、不删除。
        let mut to = target.join("data");
        let mut n = 1;
        while to.exists() {
            n += 1;
            to = target.join(format!("data-{n}"));
        }
        rename_durable(&layout.data(), &to, false)?;
    }
    if !stop(SealStep::Moved) {
        return Err(Error::Interrupted("SEAL"));
    }
    let copies = [
        (layout.manifest(), target.join("conversion.json")),
        (layout.authority(), target.join("authority.json")),
    ];
    for (i, (from, dest)) in copies.iter().enumerate() {
        copy_complete(from, dest)?;
        if i == 0 && !stop(SealStep::ManifestCopied) {
            return Err(Error::Interrupted("SEAL"));
        }
    }
    // 原件只在两份副本都核对完整之后才删。
    for (from, _) in &copies {
        if from.exists() {
            std::fs::remove_file(from).at("remove", from)?;
        }
    }
    std::fs::remove_file(&intent).at("remove", &intent)?;
    Ok(target)
}

/// 把 `M` 或 `A` 原件的完整副本落到封存目录：原子写（临时文件、刷盘、改名），写完读回核对。
/// 重入时目标已在：
/// - 与原件逐字节相同：跳过；
/// - 是原件的真前缀（早先的复制写了一半）：按残缺件重写；
/// - 其余（另一份完整内容）：拒绝，不覆盖，原件也不删。
fn copy_complete(from: &Path, dest: &Path) -> Result<()> {
    let original = match std::fs::read(from) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        r => r.at("read", from)?,
    };
    let existing = match std::fs::read(dest) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        r => Some(r.at("read", dest)?),
    };
    match existing {
        Some(x) if x == original => return Ok(()),
        Some(x) if !original.starts_with(&x) => {
            return Err(Error::Refused(format!(
                "{} already holds different content than {}",
                dest.display(),
                from.display()
            )));
        }
        _ => {}
    }
    write_atomic(dest, &original)?;
    if std::fs::read(dest).at("read", dest)? != original {
        return Err(Error::Io(std::io::Error::other(format!(
            "the copy at {} does not match {}",
            dest.display(),
            from.display()
        ))));
    }
    Ok(())
}

// ---------------------------------------------------------------- 执行

/// 测试用的注入点（模拟进程在这些位置被杀）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    /// SNAPSHOT 把源复制到 staging 之后、第二次枚举之前。
    SnapshotCopied,
    /// IMPORT 开始之后（`M.phase = IMPORT` 已写）。
    Importing,
    /// VERIFY 通过、`M.phase = VERIFY` 写完之后。
    Verified,
    /// `M.phase = PUBLISHING` 写完、改名之前。
    BeforeRename,
    /// 改名成功之后、`M.phase = PUBLISHED` 之前（F5）。
    Renamed,
}

pub use crate::progress::ProgressFn;

pub struct RunOptions<'a> {
    /// 转换时刻（`toISOString` 形状）。
    pub at: &'a str,
    /// 新的 generation（ULID），由调用方分配。
    pub generation: &'a str,
    /// 旧根 `L`。
    pub legacy_root: &'a Path,
    pub allow_real_data_root: bool,
    pub real_data_root: Option<&'a Path>,
    pub secrets_check: Option<fn(&[u8]) -> bool>,
    pub accept_unconvertible: &'a [&'a str],
    /// 每个注入点调用一次；返回 `false` 时就地中断（模拟被杀，不做任何收尾）。
    pub hook: &'a mut dyn FnMut(Step) -> bool,
    /// 阶段进度 `(阶段, 已完成, 总数)`（07 §8）：SNAPSHOT 按文件，IMPORT / VERIFY 按项目，
    /// PUBLISHING / PUBLISHED 各一次。宿主把它写成 `N\runtime\startup-progress.json` 交给 setup。
    pub progress: Option<ProgressFn<'a>>,
}

fn checkpoint(hook: &mut dyn FnMut(Step) -> bool, step: Step, name: &'static str) -> Result<()> {
    if hook(step) {
        Ok(())
    } else {
        Err(Error::Interrupted(name))
    }
}

/// `L` 里 SNAPSHOT 集合的每个文件：(相对路径, size, mtime, sha256)。
fn enumerate(root: &Path, at: &str) -> Result<Vec<SourceFile>> {
    let mut out = Vec::new();
    for rel in legacy::snapshot_files(root, at)? {
        let path = root.join(&rel);
        let meta = std::fs::metadata(&path).at("stat", &path)?;
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as i64);
        out.push(SourceFile {
            rel,
            size: meta.len(),
            mtime_ms,
            sha256: file_sha256(&path)?,
        });
        crate::progress::pulse();
        if crate::progress::stopped() {
            return Err(Error::Interrupted("SNAPSHOT"));
        }
    }
    Ok(out)
}

/// 07 §3 SNAPSHOT 的复制方式：枚举 F0、复制到 `src`、调 `after_copy`、再枚举 F1；
/// F1 ≠ F0 或副本的 sha256 与 F0 不符都是源未静止。转换与 §6 的比较共用。
///
/// `copy(from, rel)` 把一个源文件放到 `src` 下的 `rel`：正式转换与比较用 [`copy_under`]（按路径），
/// dry-run 用钉住的目录树（[`Pinned`]）。
fn snapshot(
    root: &Path,
    at: &str,
    src: &Path,
    copy: &mut dyn FnMut(&Path, &str) -> std::io::Result<()>,
    copied: &dyn Fn(usize, usize),
    after_copy: &mut dyn FnMut() -> Result<()>,
) -> Result<Vec<SourceFile>> {
    let f0 = enumerate(root, at)?;
    copied(0, f0.len());
    for (i, f) in f0.iter().enumerate() {
        copy(&root.join(&f.rel), &f.rel)?;
        copied(i + 1, f0.len());
    }
    after_copy()?;
    let f1 = enumerate(root, at)?;
    let set = |v: &[SourceFile]| -> Vec<(String, u64, String)> {
        v.iter()
            .map(|f| (f.rel.clone(), f.size, f.sha256.clone()))
            .collect()
    };
    if set(&f0) != set(&f1) {
        let first = set(&f0)
            .into_iter()
            .zip(set(&f1))
            .find(|(a, b)| a != b)
            .map_or_else(|| "the file set changed".to_string(), |(a, _)| a.0);
        return Err(Error::SourceNotQuiet(first));
    }
    for f in &f0 {
        if file_sha256(&src.join(&f.rel))? != f.sha256 {
            return Err(Error::SourceNotQuiet(format!(
                "the copy of {} differs",
                f.rel
            )));
        }
    }
    Ok(f0)
}

/// SNAPSHOT 按路径复制到 `dst` 下（staging 与比较的 scratch 都在 `N` 里，是本程序自己的目录）。
fn copy_under(dst: &Path) -> impl FnMut(&Path, &str) -> std::io::Result<()> + '_ {
    move |from, rel| {
        let to = dst.join(rel);
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)?;
        }
        crate::progress::copy_path(from, &to)
            .at("copy", from)
            .map(|_| ())
    }
}

/// 提交门：报告里不能有没处理的族实例（`Report::pending`）。VERIFY 只比已处理的族，漏掉的族要在这里拦下。
fn publishable(report: &Report) -> std::result::Result<(), String> {
    let pending = report.pending();
    if pending.is_empty() {
        Ok(())
    } else {
        Err(format!("pending families: {}", pending.join(", ")))
    }
}

fn fail(layout: &Layout, m: &mut Manifest, why: String) -> std::io::Result<()> {
    // 注入的「进程被杀」（`progress::stop_at`）之后什么都不写：被杀的进程写不了 FAILED。
    if crate::progress::stopped() {
        return Ok(());
    }
    m.phase = Phase::Failed;
    m.failure = Some(why);
    write_manifest(layout, m)
}

/// 07 §3：从 SNAPSHOT 一直走到 PUBLISHED。调用方先拿到准入，并按 [`decide`] 处理掉 S3 / S4 / S5 的残留。
/// 失败时 `M` 记 FAILED 与原因，staging 保留供诊断；源与发布物都不改。
pub fn run(layout: &Layout, opts: RunOptions<'_>) -> Result<Manifest> {
    // 没有回调也计量：工作量还用于测试注入的停下（`progress::stop_at`）。
    let quiet = |_: &str, _: usize, _: usize, _: u64| {};
    let meter = crate::progress::Meter::new(opts.progress.unwrap_or(&quiet));
    crate::progress::with(Some(&meter), || {
        // 首条进度在任何枚举、复制之前（W3 peer r1 P2-03）：setup 的首条进度预算从进程启动算起。
        crate::progress::set("SNAPSHOT", 0, 0);
        run_metered(layout, opts)
    })
}

fn run_metered(layout: &Layout, opts: RunOptions<'_>) -> Result<Manifest> {
    let g = opts.generation;
    clear_startup_state(layout)?;
    let staging = layout.staging(g);
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)?;
    let mut m = Manifest {
        converter_version: legacy::CONVERTER_VERSION.to_string(),
        source_root: Some(opts.legacy_root.to_string_lossy().into_owned()),
        source_files: Vec::new(),
        business_digest: BTreeMap::new(),
        accepted_unconvertible: Vec::new(),
        generation: g.to_string(),
        phase: Phase::Snapshot,
        verify_digest: None,
        publication_digest: None,
        started_at: opts.at.to_string(),
        published_at: None,
        failure: None,
    };
    write_manifest(layout, &m)?;

    match attempt(layout, opts, &mut m) {
        Err(e @ Error::Interrupted(_)) => Err(e),
        // 注入的「进程被杀」（`progress::stop_at`）：同上，不做任何收尾。
        Err(_) if crate::progress::stopped() => {
            Err(Error::Interrupted("a killed process (injected)"))
        }
        Err(e) => {
            // 发布之前的任何失败（含磁盘满、写不进 staging）都记 FAILED 与原因（F8）；
            // 已经在 PUBLISHING 的不改：改名前失败按 S3 重来，改名后按 S4 认发布物。
            if !matches!(
                m.phase,
                Phase::Failed | Phase::Publishing | Phase::Published
            ) {
                fail(layout, &mut m, e.to_string())?;
            }
            Err(e)
        }
        ok => ok,
    }
}

/// [`run`] 写下第一份 `M` 之后的各阶段。
fn attempt(layout: &Layout, opts: RunOptions<'_>, m: &mut Manifest) -> Result<Manifest> {
    let staging = layout.staging(&m.generation);
    // SNAPSHOT：枚举 F0、复制、再枚举 F1，副本的 sha256 逐个等于 F0。
    let src = staging.join("src");
    let snapshot = snapshot(
        opts.legacy_root,
        opts.at,
        &src,
        &mut copy_under(&src),
        &|done, total| crate::progress::set("SNAPSHOT", done, total),
        &mut || checkpoint(opts.hook, Step::SnapshotCopied, "SNAPSHOT"),
    );
    match snapshot {
        Ok(files) => m.source_files = files,
        Err(e @ Error::Interrupted(_)) => return Err(e),
        Err(e) => {
            fail(layout, m, e.to_string())?;
            return Err(e);
        }
    }

    // IMPORT + VERIFY：在副本上转换（转换器自带独立 VERIFY），登记路径指向 L。
    m.phase = Phase::Import;
    write_manifest(layout, m)?;
    checkpoint(opts.hook, Step::Importing, "IMPORT")?;
    let data = staging.join("data");
    std::fs::create_dir_all(&data)?;
    let src = staging.join("src");
    let converted = LegacySources::from_root(&src).and_then(|sources| {
        legacy::convert(
            &sources,
            &data.join("atm.sqlite"),
            &ConvertOptions {
                at: opts.at,
                allow_real_data_root: opts.allow_real_data_root,
                real_data_root: opts.real_data_root,
                generation: Some(opts.generation),
                secrets_check: opts.secrets_check,
                accept_unconvertible: opts.accept_unconvertible,
                origin_root: Some(opts.legacy_root),
                // 计量已经装在当前线程上（`run`）。
                progress: None,
            },
        )
    });
    let report: Report = match converted {
        Ok(r) => r,
        Err(e) => {
            if let ConvertError::Verify(r) = &e {
                write_atomic(&staging.join("report.json"), r.report_json().as_bytes())?;
            }
            fail(layout, m, e.to_string())?;
            return Err(e.into());
        }
    };
    let report_json = report.report_json();
    write_atomic(&staging.join("report.json"), report_json.as_bytes())?;
    write_atomic(
        &staging.join("attachment.jsonl"),
        report.attachment_jsonl().as_bytes(),
    )?;
    if let Err(why) = publishable(&report) {
        fail(layout, m, why.clone())?;
        return Err(Error::Unpublishable(why));
    }
    m.phase = Phase::Verify;
    m.verify_digest = Some(sha_hex(report_json.as_bytes()));
    m.business_digest = report.business_digest();
    m.accepted_unconvertible = report.accepted_unconvertible.clone();
    write_manifest(layout, m)?;
    checkpoint(opts.hook, Step::Verified, "VERIFY")?;

    // PUBLISHING：新库合并 WAL、改回单文件后关闭；M 先落盘，再整体改名。
    {
        let c = Connection::open(data.join("atm.sqlite"))?;
        c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;")?;
    }
    // 复制来的附件、日志、密文与库逐个刷盘，再写 M、再改名发布（W3 peer r1 P2-04）。
    atm_install_state::durable::sync_tree(&data)?;
    m.phase = Phase::Publishing;
    m.publication_digest = Some(publication_digest(&data)?);
    write_manifest(layout, m)?;
    crate::progress::set("PUBLISHING", 0, 1);
    checkpoint(opts.hook, Step::BeforeRename, "PUBLISHING")?;
    if layout.data().exists() {
        // 发布目标已经有东西（不该有：调用方应已按 S5 处理）。不覆盖，整体隔离。
        seal_data_only(layout, opts.at)?;
    }
    rename_durable(&data, &layout.data(), false)?;
    checkpoint(opts.hook, Step::Renamed, "PUBLISHING")?;
    publish(layout, m, opts.at)?;
    crate::progress::set("PUBLISHED", 1, 1);
    Ok(m.clone())
}

/// 发布目标被占用时的兜底：只把 `N\data\` 移进隔离区，不动 `M`（它属于正在发布的这一次）。
fn seal_data_only(layout: &Layout, at: &str) -> Result<()> {
    let base = layout.root.join("quarantine");
    let mut target = base.join(format!("unclaimed-{}", stamp(at)));
    let mut n = 1;
    while target.exists() {
        n += 1;
        target = base.join(format!("unclaimed-{}-{n}", stamp(at)));
    }
    std::fs::create_dir_all(&target)?;
    rename_durable(&layout.data(), &target.join("data"), false)?;
    Ok(())
}

/// PUBLISHED：`M.phase = PUBLISHED`，再写 `A = v3 by publish`，最后删掉 staging 里的源副本。
fn publish(layout: &Layout, m: &mut Manifest, at: &str) -> Result<()> {
    m.phase = Phase::Published;
    m.published_at = Some(at.to_string());
    write_manifest(layout, m)?;
    write_authority(
        layout,
        &Authority {
            authority: "v3".into(),
            by: "publish".into(),
            txn: None,
            at: at.to_string(),
            generation: Some(m.generation.clone()),
            accepted_source_digest: None,
        },
    )?;
    let _ = std::fs::remove_dir_all(layout.staging(&m.generation).join("src"));
    Ok(())
}

/// S4：发布物身份与 `M` 一致，补写 PUBLISHED 与 `A`。
pub fn finish_publishing(layout: &Layout, at: &str) -> Result<Manifest> {
    let ManifestState::Present(mut m) = read_manifest(layout) else {
        return Err(Error::Io(std::io::Error::other("no manifest to finish")));
    };
    publish(layout, &mut m, at)?;
    Ok(m)
}

/// S1：`L` 不存在、也没有 `M`。建一个空库，走同样的 PUBLISHING → PUBLISHED，
/// `M{phase: PUBLISHED, source_root: null}`、`A = v3 by publish`。中断后按 S3 / S4 续做，与转换相同。
pub fn fresh_install(layout: &Layout, generation: &str, at: &str) -> Result<Manifest> {
    clear_startup_state(layout)?;
    let staging = layout.staging(generation);
    let _ = std::fs::remove_dir_all(&staging);
    let data = staging.join("data");
    std::fs::create_dir_all(&data)?;
    {
        let c = crate::open(&data.join("atm.sqlite"))?;
        let (root, epoch) = (crate::events::ulid(&c)?, crate::events::ulid(&c)?);
        c.execute(
            "INSERT INTO app_meta (singleton, schema_version, data_root_id, generation, instance_epoch, created_at, updated_at)
             VALUES (1, 1, ?1, ?2, ?3, ?4, ?4)",
            rusqlite::params![root, generation, epoch, at],
        )?;
        c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;")?;
    }
    atm_install_state::durable::sync_tree(&data)?;
    let mut m = Manifest {
        converter_version: legacy::CONVERTER_VERSION.to_string(),
        source_root: None,
        source_files: Vec::new(),
        business_digest: BTreeMap::new(),
        accepted_unconvertible: Vec::new(),
        generation: generation.to_string(),
        phase: Phase::Publishing,
        verify_digest: None,
        publication_digest: Some(publication_digest(&data)?),
        started_at: at.to_string(),
        published_at: None,
        failure: None,
    };
    write_manifest(layout, &m)?;
    rename_durable(&data, &layout.data(), false)?;
    publish(layout, &mut m, at)?;
    let _ = std::fs::remove_dir_all(&staging);
    Ok(m)
}

/// S3：丢弃上一次尝试的 staging 与 `M`（换新 generation 重来之前）。
pub fn discard_attempt(layout: &Layout, generation: &str) -> Result<()> {
    let _ = std::fs::remove_dir_all(layout.staging(generation));
    if layout.manifest().exists() {
        std::fs::remove_file(layout.manifest())?;
    }
    Ok(())
}

// ---------------------------------------------------------------- 权威判定与数据源冲突（07 §6–§7，W3e）

/// 对 `L` 重算的 business_digest' 与基准逐族比较的结果（07 §6 第 3 条）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Comparison {
    /// 全部对象族都相等。带上算出的摘要：用户选「沿用 3.0」时绑定的就是它。
    Unchanged(BTreeMap<String, String>),
    /// 至少一族不等。`families` 是不等的族（含两边只有一边有的族，例如 2.x 里新建或删掉了项目）。
    Changed {
        digest: BTreeMap<String, String>,
        families: Vec<String>,
    },
    /// 说不清：读失败、比较期间源在变、出现 05 没有登记的文件或表、超出接受域。
    Unknown(String),
    /// `L` 整个不在了（用户删掉了 2.x 的数据目录）。
    LegacyGone,
}

pub struct CompareOptions<'a> {
    /// 旧根 `L`。
    pub legacy_root: &'a Path,
    pub allow_real_data_root: bool,
    pub real_data_root: Option<&'a Path>,
    pub secrets_check: Option<fn(&[u8]) -> bool>,
}

/// 比较的基准：用户选过「沿用 3.0」就是当时接受的摘要，否则是转换时写进 `M` 的。
/// 回滚写的 `A=legacy` 要带着它（[`rollback_authority`]），否则回滚后没动过 2.x 也会被当成「变了」。
pub fn baseline<'a>(m: &'a Manifest, a: Option<&'a Authority>) -> &'a BTreeMap<String, String> {
    a.and_then(|a| a.accepted_source_digest.as_ref())
        .unwrap_or(&m.business_digest)
}

/// 07 §6 第 1 条：`A` 不是一条与 `M` 对得上的 v3 记录时，必须在发布任何入口之前阻塞比较；
/// 是的话服务照常启动，比较放到后台低优先级做（每次启动都做，没有元数据快速路径）。
pub fn must_compare_before_serving(a: &AuthorityState, m: &Manifest) -> bool {
    !matches!(a, AuthorityState::Present(a)
        if a.authority == "v3" && a.generation.as_deref() == Some(m.generation.as_str()))
}

/// 07 §6 第 2–3 条：对 `L` 做一次只读快照（与 SNAPSHOT 同样的复制方式，放在 `N\runtime\compare\`，用完删掉），
/// 用转换时的 `at` 与当时接受舍弃的项目按同一流程重算 business_digest'，再与 `base` 逐族比较。
/// 只读 `L`；不碰 `N\data\`。SQLite 的物理哈希不参与，checkpoint、SHM 重建、VACUUM 都不会误判。
pub fn compare(
    layout: &Layout,
    m: &Manifest,
    base: &BTreeMap<String, String>,
    opts: &CompareOptions<'_>,
) -> Comparison {
    match std::fs::symlink_metadata(opts.legacy_root) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Comparison::LegacyGone,
        Err(e) => {
            return Comparison::Unknown(
                located(e, "stat", &opts.legacy_root.display()).to_string(),
            );
        }
        Ok(_) => {}
    }
    let scratch = layout.runtime().join("compare");
    let _ = std::fs::remove_dir_all(&scratch);
    let digest = (|| -> Result<BTreeMap<String, String>> {
        let src = scratch.join("src");
        snapshot(
            opts.legacy_root,
            &m.started_at,
            &src,
            &mut copy_under(&src),
            &|_, _| {},
            &mut || Ok(()),
        )?;
        let sources = LegacySources::from_root(&src)?;
        let accept: Vec<&str> = m
            .accepted_unconvertible
            .iter()
            .map(String::as_str)
            .collect();
        Ok(legacy::business_digest(
            &sources,
            &scratch,
            &ConvertOptions {
                at: &m.started_at,
                allow_real_data_root: opts.allow_real_data_root,
                real_data_root: opts.real_data_root,
                generation: None,
                secrets_check: opts.secrets_check,
                accept_unconvertible: &accept,
                origin_root: Some(opts.legacy_root),
                progress: None,
            },
        )?)
    })();
    let _ = std::fs::remove_dir_all(&scratch);
    match digest {
        Err(e) => Comparison::Unknown(e.to_string()),
        Ok(digest) => {
            let families = differing(base, &digest);
            if families.is_empty() {
                Comparison::Unchanged(digest)
            } else {
                Comparison::Changed { digest, families }
            }
        }
    }
}

/// 两边摘要不等的族：值不同的，以及只有一边有的（2.x 里新建或删掉了项目、知识库）。
fn differing(base: &BTreeMap<String, String>, digest: &BTreeMap<String, String>) -> Vec<String> {
    base.keys()
        .chain(digest.keys())
        .filter(|k| base.get(*k) != digest.get(*k))
        .cloned()
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// 07 §6 判定表的结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// 正常启动（`A=v3` 且不变）。
    Serve,
    /// `A=legacy` 且不变（回滚后没在 2.x 写过）：[`resume_after_rollback`] 后正常启动，什么都不丢。
    ResumeAfterRollback,
    /// `A=legacy` 且变了：以 2.x 为准，[`seal`]`(Superseded)` 当前 generation 后按 S2 重新转换。
    Reconvert,
    /// 数据源冲突（§7）：[`enter_conflict`]，停掉业务入口，等用户选。
    Conflict(String),
}

fn same_root(recorded: &str, root: &Path) -> bool {
    let norm = |s: &str| {
        s.replace('/', "\\")
            .trim_end_matches('\\')
            .to_ascii_lowercase()
    };
    norm(recorded) == norm(&root.to_string_lossy())
}

/// 07 §6 的判定表，加上 B3：`A` 缺失、损坏、绑定的 generation 与 `M` 不符，或 `M.source_root` 不是这次的 `L`，
/// 不猜 v3 还是 legacy，一律冲突。
///
/// | `A` | 比较 | 结果 |
/// | --- | --- | --- |
/// | v3 | 不变 / `L` 不在了 | Serve |
/// | v3 | 变了 / UNKNOWN | Conflict（后台比较得出时立即进入） |
/// | legacy | 不变 | ResumeAfterRollback |
/// | legacy | 变了 | Reconvert |
/// | legacy | UNKNOWN / `L` 不在了 | Conflict |
pub fn judge(a: &AuthorityState, m: &Manifest, legacy_root: &Path, cmp: &Comparison) -> Verdict {
    let a = match a {
        AuthorityState::Missing => {
            return Verdict::Conflict("the authority record is missing".into());
        }
        AuthorityState::Corrupt => {
            return Verdict::Conflict("the authority record is corrupt".into());
        }
        AuthorityState::Present(a) => a,
    };
    if a.generation.as_deref() != Some(m.generation.as_str()) {
        return Verdict::Conflict(format!(
            "the authority record is bound to generation {}, the manifest says {}",
            a.generation.as_deref().unwrap_or("(none)"),
            m.generation
        ));
    }
    if let Some(recorded) = &m.source_root
        && !same_root(recorded, legacy_root)
    {
        return Verdict::Conflict(format!(
            "generation {} was converted from {recorded}, not from {}",
            m.generation,
            legacy_root.display()
        ));
    }
    match (a.authority.as_str(), cmp) {
        ("v3", Comparison::Unchanged(_) | Comparison::LegacyGone) => Verdict::Serve,
        ("v3", Comparison::Changed { families, .. }) => Verdict::Conflict(format!(
            "the 2.x data changed after the conversion: {}",
            families.join(", ")
        )),
        ("v3", Comparison::Unknown(why)) => {
            Verdict::Conflict(format!("the 2.x data cannot be compared: {why}"))
        }
        (_, Comparison::Unchanged(_)) => Verdict::ResumeAfterRollback,
        (_, Comparison::Changed { .. }) => Verdict::Reconvert,
        (_, Comparison::Unknown(why)) => {
            Verdict::Conflict(format!("the 2.x data cannot be compared: {why}"))
        }
        (_, Comparison::LegacyGone) => {
            Verdict::Conflict("2.x was chosen as the source, but its data root is gone".into())
        }
    }
}

/// setup 回滚事务写的 `A`（07 §8）：`A=legacy by setup-rollback`，带上 generation 与已接受的摘要。
/// 只有带着它们，回滚后没动过 2.x 时才能按 [`Verdict::ResumeAfterRollback`] 无损接回 3.0。
/// 只沿用同一个 generation 下接受的摘要。setup 自己按同样的规则写（`atm_install_state::startup::settle_for_rollback`），
/// 两边由契约用例对着验。
pub fn rollback_authority(
    prev: Option<&Authority>,
    m: &Manifest,
    txn: &str,
    at: &str,
) -> Authority {
    Authority {
        authority: "legacy".into(),
        by: "setup-rollback".into(),
        txn: Some(txn.to_string()),
        at: at.to_string(),
        generation: Some(m.generation.clone()),
        accepted_source_digest: prev
            .filter(|a| a.generation.as_deref() == Some(m.generation.as_str()))
            .and_then(|a| a.accepted_source_digest.clone()),
    }
}

/// [`Verdict::ResumeAfterRollback`] 的落地：`A=v3 by resume-after-rollback`，沿用原来接受的摘要。
pub fn resume_after_rollback(
    layout: &Layout,
    prev: &Authority,
    at: &str,
) -> std::io::Result<Authority> {
    let a = Authority {
        authority: "v3".into(),
        by: "resume-after-rollback".into(),
        txn: None,
        at: at.to_string(),
        generation: prev.generation.clone(),
        accepted_source_digest: prev.accepted_source_digest.clone(),
    };
    write_authority(layout, &a)?;
    Ok(a)
}

/// `N\runtime\startup-state.json`（07 §7）：不含凭据。`atm-mcp.exe` 桥和 CLI 连不上服务时读它，
/// 向 Agent 报告「需要在 ATM 窗口中选择数据来源」。只对写它的那个 generation 有效。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StartupState {
    /// 目前只有 `SOURCE_CONFLICT`。
    pub state: String,
    pub since: String,
    pub generation: String,
    pub reason: String,
}

impl StartupState {
    pub fn to_json(&self) -> String {
        jsjson::jcs(&Value::Object(vec![
            ("state".into(), s(&self.state)),
            ("since".into(), s(&self.since)),
            ("generation".into(), s(&self.generation)),
            ("reason".into(), s(&self.reason)),
        ]))
    }

    pub fn parse(text_: &str) -> Option<StartupState> {
        let v = jsjson::parse_value(text_).ok().flatten()?;
        let state = text(&v, "state")?;
        if state != "SOURCE_CONFLICT" {
            return None;
        }
        Some(StartupState {
            state,
            since: text(&v, "since")?,
            generation: text(&v, "generation")?,
            reason: text(&v, "reason")?,
        })
    }
}

fn startup_state_path(layout: &Layout) -> PathBuf {
    layout.runtime().join("startup-state.json")
}

/// 读启动状态。文件损坏时当作冲突仍在（不能因为文件坏了就放行入口），原因写明损坏。
pub fn read_startup_state(layout: &Layout) -> Option<StartupState> {
    let generation = || match read_manifest(layout) {
        ManifestState::Present(m) => m.generation,
        _ => String::new(),
    };
    match std::fs::read(startup_state_path(layout)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => Some(StartupState {
            state: "SOURCE_CONFLICT".into(),
            since: String::new(),
            generation: generation(),
            reason: format!("the startup state cannot be read: {e}"),
        }),
        Ok(bytes) => std::str::from_utf8(&bytes)
            .ok()
            .and_then(StartupState::parse)
            .or_else(|| {
                Some(StartupState {
                    state: "SOURCE_CONFLICT".into(),
                    since: String::new(),
                    generation: generation(),
                    reason: "the startup state is corrupt".into(),
                })
            }),
    }
}

fn clear_startup_state(layout: &Layout) -> std::io::Result<()> {
    match std::fs::remove_file(startup_state_path(layout)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            Err(located(e, "remove", &startup_state_path(layout).display()))
        }
        _ => Ok(()),
    }
}

/// 进入数据源冲突（07 §7）：写启动状态，之后 [`decide`] 对这个 generation 返回 [`Startup::SourceConflict`]，
/// 宿主不起 HTTP、不写 daemon.json、不起调度器 / 同步 / 派单。已经在冲突中就保留原来的 `since`。
/// 这里不写任何业务数据；后台比较发现冲突之前写进 3.0 的数据留在 3.0 这一边。
pub fn enter_conflict(
    layout: &Layout,
    m: &Manifest,
    reason: &str,
    at: &str,
) -> std::io::Result<StartupState> {
    let since = match read_startup_state(layout) {
        Some(prev) if prev.generation == m.generation && !prev.since.is_empty() => prev.since,
        _ => at.to_string(),
    };
    let state = StartupState {
        state: "SOURCE_CONFLICT".into(),
        since,
        generation: m.generation.clone(),
        reason: reason.to_string(),
    };
    write_atomic(&startup_state_path(layout), state.to_json().as_bytes())?;
    Ok(state)
}

/// 用户选「沿用 3.0（忽略 2.x 期间的修改）」（07 §7，只认 User，B2 由调用方保证）：
/// `A=v3 by user-choice`，绑定这次比较算出的摘要；此后再比较以它为准，2.x 再有新写入还能识别出来。
/// 比较是 UNKNOWN 时没有完整摘要可绑：只放行这一次，沿用同一 generation 下之前接受过的摘要（没有就是 `None`，
/// 以 `M.business_digest` 为准）；下一次比较仍是 UNKNOWN 就再冲突，原因相同也一样（07 §6，W3 peer r1 P1-01）。
/// 先写 `A`，再清启动状态：中间被杀的话下次启动还会再问一次，不会在没有决定的情况下放行。
pub fn choose_v3(
    layout: &Layout,
    m: &Manifest,
    cmp: &Comparison,
    at: &str,
) -> std::io::Result<Authority> {
    let accepted_source_digest = match cmp {
        Comparison::Unchanged(d) | Comparison::Changed { digest: d, .. } => Some(d.clone()),
        Comparison::Unknown(_) | Comparison::LegacyGone => match read_authority(layout) {
            AuthorityState::Present(prev)
                if prev.generation.as_deref() == Some(m.generation.as_str()) =>
            {
                prev.accepted_source_digest
            }
            _ => None,
        },
    };
    let a = Authority {
        authority: "v3".into(),
        by: "user-choice".into(),
        txn: None,
        at: at.to_string(),
        generation: Some(m.generation.clone()),
        accepted_source_digest,
    };
    write_authority(layout, &a)?;
    clear_startup_state(layout)?;
    Ok(a)
}

/// 用户选「从 2.x 重新转换（当前 3.0 数据封存）」，或判定为 [`Verdict::Reconvert`]：
/// [`seal`]`(Superseded)` 整个 generation，之后 [`decide`] 走 S2。启动状态由下一次 [`run`] 清掉。
pub fn choose_legacy(layout: &Layout, at: &str) -> Result<PathBuf> {
    seal(layout, Seal::Superseded, at)
}

// ---------------------------------------------------------------- dry-run（07 §9，W3g）

pub struct DryRunOptions<'a> {
    /// 转换时刻（`toISOString` 形状）。
    pub at: &'a str,
    /// 旧根 `L`：只读。
    pub source: &'a Path,
    /// 输出目录：不存在或是空的，不在 `L` 里，也不在 `N` 里。
    pub out: &'a Path,
    /// 新根 `N`（知道的话）：输出目录不许落在里面，dry-run 不写 `N`。
    pub v3_root: Option<&'a Path>,
    pub allow_real_data_root: bool,
    pub real_data_root: Option<&'a Path>,
    pub secrets_check: Option<fn(&[u8]) -> bool>,
    pub accept_unconvertible: &'a [&'a str],
    /// 留下转换出的库（`out\data\`），供人检查。默认不留：里面是用户数据。
    pub keep_data: bool,
    /// 旧版是否静止（规则同 07 §2）。不静止就只报告，什么都不做。
    pub quiesce: &'a mut dyn FnMut() -> Quiesce,
    /// 测试注入：复制完、第二次枚举之前调用一次。
    pub after_copy: &'a mut dyn FnMut(),
}

/// dry-run 的结论。除 [`DryRun::SourceBusy`] 外，`out\report.json` 都已写出。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DryRun {
    /// 转换与独立 VERIFY 都通过。`pending` 不空时真转换会在提交门停下。
    Verified {
        business_digest: BTreeMap<String, String>,
        pending: Vec<String>,
    },
    /// VERIFY 发现差异：报告照样写出，指出是哪些族（F4）。
    VerifyFailed(Vec<String>),
    /// SNAPSHOT 期间源在变：只报告，不转换（`report.json` 不写）。
    SourceNotQuiet(String),
    /// 旧版还在运行或判定不了：只报告，什么都没做（输出目录也不建）。
    SourceBusy(String),
}

/// 路径的真实位置（按 Windows 规则不分大小写的分量序列）：最近一个已存在的祖先用 `canonicalize` 解析
/// （跟随 junction 与符号链接），再接上还不存在的部分。同一个目录的不同拼写（别名、大小写、`..`）得到同一个结果。
fn real_components(p: &Path) -> std::io::Result<Vec<String>> {
    let abs = std::path::absolute(p).at("resolve", p)?;
    let mut existing = abs.as_path();
    let mut missing = Vec::new();
    loop {
        match std::fs::symlink_metadata(existing) {
            Ok(_) => break,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                missing.push(existing.file_name().map(|n| n.to_os_string()).ok_or(e)?);
                existing = existing.parent().unwrap_or(existing);
            }
            Err(e) => return Err(e).at("stat", existing),
        }
    }
    let mut real = std::fs::canonicalize(existing).at("resolve", existing)?;
    real.extend(missing.into_iter().rev());
    Ok(real
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
        .collect())
}

/// `child` 是 `parent` 本身或在它里面（按真实位置；不要求存在）。
fn within(child: &Path, parent: &Path) -> std::io::Result<bool> {
    let (c, p) = (real_components(child)?, real_components(parent)?);
    Ok(c.len() >= p.len() && c[..p.len()] == p[..])
}

/// 两个目录有没有重叠：一个是另一个本身或在它里面。
fn overlaps(a: &Path, b: &Path) -> std::io::Result<bool> {
    Ok(within(a, b)? || within(b, a)?)
}

/// dry-run 的输出目录不许与 `L`、`N` 重叠（任一方向）。按真实位置判断，junction 别名绕不过去。
fn refuse_overlap(out: &Path, source: &Path, v3_root: Option<&Path>) -> Result<()> {
    if overlaps(out, source)? {
        return Err(Error::Refused(format!(
            "the output {} overlaps the 2.x data root",
            out.display()
        )));
    }
    if let Some(n) = v3_root
        && overlaps(out, n)?
    {
        return Err(Error::Refused(format!(
            "the output {} overlaps the 3.0 data root",
            out.display()
        )));
    }
    Ok(())
}

/// 钉住输出目录（W3 r2 P1-R2-01）：先钉住最近一个已存在的祖先，按它的真实位置查重叠，再把缺的每一层
/// 相对父目录的句柄排他新建。返回整条链，最后一个是输出目录。链上的目录在 dry-run 期间不能改名、
/// 不能换成 junction，所以之后按钉住的最终路径写入与清理，到达的都是这里钉住的目录。
fn pin_out(out: &Path, source: &Path, v3_root: Option<&Path>) -> Result<Vec<pin::Dir>> {
    let abs = std::path::absolute(out).at("resolve", out)?;
    let mut existing = abs.as_path();
    let mut missing = Vec::new();
    loop {
        match std::fs::symlink_metadata(existing) {
            Ok(_) => break,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                missing.push(existing.file_name().ok_or(e)?.to_os_string());
                existing = existing.parent().unwrap_or(existing);
            }
            Err(e) => return Err(located(e, "stat", &existing.display()).into()),
        }
    }
    missing.reverse();
    let base = pin::open(existing).at("open", existing)?;
    let mut target = base.path().to_path_buf();
    target.extend(&missing);
    refuse_overlap(&target, source, v3_root)?;
    if missing.is_empty() {
        let mut entries = std::fs::read_dir(base.path()).at("list", base.path())?;
        if entries.next().is_some() {
            return Err(Error::Refused(format!(
                "the output {} is not empty",
                out.display()
            )));
        }
    }
    let mut chain = vec![base];
    for name in &missing {
        let parent = chain.last().expect("the chain starts with the base");
        let next = pin::create(parent, name).at("create", &parent.path().join(name))?;
        chain.push(next);
    }
    Ok(chain)
}

/// dry-run 的 SNAPSHOT 副本：`src` 下的每一层目录都排他新建并钉住，文件排他新建（名字被占就失败）并记下身份。
/// 清理只删这些：文件与目录都按新建时的身份核对，不认识的条目一律不碰（W3 r3 P1-R3-01）。
struct Pinned {
    root: pin::Dir,
    /// (相对 `src` 的目录, 钉住的目录)，按建出的先后。
    dirs: Vec<(PathBuf, pin::Dir)>,
    /// (所在目录相对 `src` 的路径, 新建的文件)。
    files: Vec<(PathBuf, pin::FileMark)>,
}

impl Pinned {
    fn copy(&mut self, from: &Path, rel: &str) -> std::io::Result<()> {
        let rel = Path::new(rel);
        let plain = || {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("{} is not a plain relative path", rel.display()),
            )
        };
        let mut at: Option<usize> = None;
        let mut prefix = PathBuf::new();
        for c in rel.parent().into_iter().flat_map(Path::components) {
            let std::path::Component::Normal(name) = c else {
                return Err(plain());
            };
            prefix.push(name);
            at = Some(match self.dirs.iter().position(|(p, _)| *p == prefix) {
                Some(i) => i,
                None => {
                    let parent = at.map_or(&self.root, |i| &self.dirs[i].1);
                    let dir = pin::create(parent, name).at("create", &parent.path().join(name))?;
                    self.dirs.push((prefix.clone(), dir));
                    self.dirs.len() - 1
                }
            });
        }
        let parent = at.map_or(&self.root, |i| &self.dirs[i].1);
        let name = rel.file_name().ok_or_else(plain)?;
        let to = parent.path().join(name);
        let (mut w, mark) = pin::create_file(parent, name).at("create", &to)?;
        self.files.push((prefix, mark));
        crate::progress::copy(from, &mut w).at("copy", from)?;
        Ok(())
    }

    /// 删掉整个副本：先按身份删本次建的文件，再由深到浅删本次建的目录，最后是 `src` 自己。哪一处删不掉（被换过、
    /// 里面有别人的东西），它和它的每一层祖先都原样留下——祖先里有它，删不掉也不该删。返回留下的条目。
    fn remove(self) -> Vec<String> {
        let mut left = Vec::new();
        let mut kept: Vec<PathBuf> = Vec::new();
        // pin 的错误文本里已经带着那个文件或目录的路径。
        for (dir, mark) in self.files {
            if let Err(e) = pin::remove_file(mark) {
                left.push(e.to_string());
                kept.push(dir);
            }
        }
        for (rel, dir) in self.dirs.into_iter().rev() {
            if kept.iter().any(|k| k.starts_with(&rel)) {
                drop(dir);
                continue;
            }
            if let Err(e) = dir.remove() {
                left.push(e.to_string());
                kept.push(rel);
            }
        }
        if kept.is_empty()
            && let Err(e) = self.root.remove()
        {
            left.push(e.to_string());
        }
        left
    }
}

/// dry-run 写报告：在钉住的目录里排他新建临时文件、刷盘、不替换地改名。名字被占就失败，不会写进别人放在那里
/// 的文件。临时文件从新建到改名一直开着，改名与失败时的丢弃都按句柄做（W3 r4 P1-R4-01）：这段时间里别人
/// 改不了它的名、删不掉它，所以按名字删到别人的文件这种事不会发生。
fn write_new(dir: &pin::Dir, name: &str, bytes: &[u8]) -> std::io::Result<()> {
    let temporary = format!("{name}.{}.tmp", std::process::id());
    let at = dir.path().join(&temporary);
    let mut f = pin::create_open(dir, OsStr::new(&temporary)).at("create", &at)?;
    let written = f
        .file()
        .write_all(bytes)
        .and_then(|()| f.file().sync_all())
        .at("write", &at)
        .and_then(|()| f.rename_into(dir, OsStr::new(name)));
    if let Err(e) = written {
        if let Err(d) = f.discard() {
            return Err(std::io::Error::new(
                e.kind(),
                format!("{e}; the temporary was not removed: {d}"),
            ));
        }
        return Err(e);
    }
    Ok(())
}

/// 07 §9：`atm.exe migrate --dry-run --source <L> --out <dir>` 的库入口。
/// 在 `out` 里执行 SNAPSHOT → IMPORT / VERIFY，写出 `report.json` 与 `attachment.jsonl`；
/// 不写 `L`，不写 `N`（不碰 `M`、`A`、启动状态与进度），不起任何调度器。
///
/// 输出目录、它的祖先、`src` 与 `data` 在整个写入与清理期间都是钉住的（[`pin`]）：检查之后把哪一层换成指向
/// `L` 或 `N` 的 junction 都做不到。`src`、`data` 与 `src` 下的每层目录都是本次排他新建的，清理只删它们；
/// `src` 里只删本次建的文件与目录（按身份），别的条目留下，并以 [`Error::CleanupIncomplete`] 报告。
pub fn dry_run(o: DryRunOptions<'_>) -> Result<DryRun> {
    let refuse = |why: String| Err(Error::Refused(why));
    refuse_overlap(o.out, o.source, o.v3_root)?;
    match std::fs::read_dir(o.out) {
        Ok(mut entries) => {
            if entries.next().is_some() {
                return refuse(format!("the output {} is not empty", o.out.display()));
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(located(e, "list", &o.out.display()).into()),
    }
    if let Quiesce::Wait(why) = (o.quiesce)() {
        return Ok(DryRun::SourceBusy(why));
    }
    // 静止判定之后才钉住、才建：钉住时按真实位置再查一次重叠，之后去向就不会再变。
    let chain = pin_out(o.out, o.source, o.v3_root)?;
    let out_dir = chain.last().expect("pin_out returns at least the base");
    let out = out_dir.path().to_path_buf();
    let mut src = Pinned {
        root: pin::create(out_dir, OsStr::new("src")).at("create", &out.join("src"))?,
        dirs: Vec::new(),
        files: Vec::new(),
    };
    let mut data: Option<pin::Dir> = None;
    let after_copy = o.after_copy;
    let outcome = (|| -> Result<DryRun> {
        let src_path = src.root.path().to_path_buf();
        match snapshot(
            o.source,
            o.at,
            &src_path,
            &mut |from, rel| src.copy(from, rel),
            &|_, _| {},
            &mut || {
                after_copy();
                Ok(())
            },
        ) {
            Ok(_) => {}
            Err(Error::SourceNotQuiet(why)) => return Ok(DryRun::SourceNotQuiet(why)),
            Err(e) => return Err(e),
        }
        let data =
            data.insert(pin::create(out_dir, OsStr::new("data")).at("create", &out.join("data"))?);
        let converted = LegacySources::from_root(&src_path).and_then(|sources| {
            legacy::convert(
                &sources,
                &data.path().join("atm.sqlite"),
                &ConvertOptions {
                    at: o.at,
                    allow_real_data_root: o.allow_real_data_root,
                    real_data_root: o.real_data_root,
                    generation: None,
                    secrets_check: o.secrets_check,
                    accept_unconvertible: o.accept_unconvertible,
                    origin_root: Some(o.source),
                    progress: None,
                },
            )
        });
        let report = match converted {
            Ok(report) => report,
            Err(ConvertError::Verify(report)) => *report,
            Err(e) => return Err(e.into()),
        };
        write_new(out_dir, "report.json", report.report_json().as_bytes())?;
        write_new(
            out_dir,
            "attachment.jsonl",
            report.attachment_jsonl().as_bytes(),
        )?;
        let failures = report.failures();
        Ok(if failures.is_empty() {
            DryRun::Verified {
                business_digest: report.business_digest(),
                pending: report.pending(),
            }
        } else {
            DryRun::VerifyFailed(failures)
        })
    })();
    let mut left = src.remove();
    if let Some(data) = data
        && !o.keep_data
        && let Err(e) = data.remove_tree()
    {
        left.push(format!("{}: {e}", out.join("data").display()));
    }
    drop(chain);
    if left.is_empty() {
        return outcome;
    }
    // 清理没做完不能报成功：留下的东西要有人看（W3 r3 P1-R3-01）。
    Err(Error::CleanupIncomplete {
        left,
        outcome: match &outcome {
            Ok(r) => format!("{r:?}"),
            Err(e) => e.to_string(),
        },
    })
}

// ---------------------------------------------------------------- 演练

pub struct RehearseOptions<'a> {
    pub at: &'a str,
    /// 旧根 `L`：只读，原路径直接用（附件等路径按它映射），不另做副本。
    pub source: &'a Path,
    /// 空的工作目录：dry-run 输出到 `work\dry`，完整转换的 `N` 是 `work\n`。
    pub work: &'a Path,
    pub generation: &'a str,
    pub allow_real_data_root: bool,
    pub real_data_root: Option<&'a Path>,
    pub secrets_check: Option<fn(&[u8]) -> bool>,
    /// 测试注入：每一步开始之前调用，参数是步名（`dry-run`、`run`、`compare`）。
    pub before: &'a mut dyn FnMut(&str),
}

/// 演练走完了：每一步都是正式结论。
#[derive(Debug)]
pub struct Rehearsal {
    /// 正式 SNAPSHOT 的文件清单（[`crate::legacy::snapshot_files`]）。
    pub files: Vec<String>,
    pub dry_run_digest: BTreeMap<String, String>,
    pub layout: Layout,
    pub manifest: Manifest,
}

/// 演练停在哪一步。每一种都是失败：调用方以非零退出。
#[derive(Debug)]
pub enum RehearseStop {
    /// 正式枚举与守卫拒绝了这个根（未登记的条目等）。
    Refused(Error),
    /// dry-run 没有 VERIFY 通过，或者真转换会在提交门停下（`pending` 不空）。
    DryRun(String),
    /// 完整转换失败。
    Run(Error),
    /// dry-run 与完整转换各做一次 SNAPSHOT，两次的 business_digest 不同（列出不同的族）：两次之间 `L` 变了。
    Moved(Vec<String>),
    /// 启动判定不是 Published。
    Decide(Box<Startup>),
    /// 转换之后再比较 `L` 不是 Unchanged：多半是 2.x 在这期间写了数据，换个静止的时刻重跑。
    Compare(Box<Comparison>),
}

/// W3i 的演练方法（W3 peer r2 P2-07）：对 `L` 原样走正式的 dry-run、完整转换、启动判定与比较，任何一步不是
/// 正式意义上的通过就停下。不自己挑文件、不另做副本，所以复制集合、恢复依赖、路径映射都与正式转换相同。
///
/// 一致性边界：2.x 可能还在运行（演练不停它），所以静止判定按「静止」放行；副本的一致性由 SNAPSHOT 保证——
/// 复制前后两次枚举（F0、F1）相同、副本的 sha256 逐个等于 F0，否则 dry-run 报 [`DryRun::SourceNotQuiet`]，
/// 完整转换失败。得到的是 `L` 在复制期间没有变过的那一刻；最后的比较再确认转换之后 `L` 仍是那一刻的内容。
/// 只读 `L`；只写 `work`。
pub fn rehearse(o: RehearseOptions<'_>) -> std::result::Result<Rehearsal, RehearseStop> {
    let files = crate::legacy::snapshot_files(o.source, o.at)
        .map_err(|e| RehearseStop::Refused(e.into()))?;
    let n = o.work.join("n");
    (o.before)("dry-run");
    let dry = dry_run(DryRunOptions {
        at: o.at,
        source: o.source,
        out: &o.work.join("dry"),
        v3_root: Some(&n),
        allow_real_data_root: o.allow_real_data_root,
        real_data_root: o.real_data_root,
        secrets_check: o.secrets_check,
        accept_unconvertible: &[],
        keep_data: false,
        quiesce: &mut || Quiesce::Quiet,
        after_copy: &mut || {},
    });
    let dry_run_digest = match dry {
        Ok(DryRun::Verified {
            business_digest,
            pending,
        }) if pending.is_empty() => business_digest,
        Ok(other) => return Err(RehearseStop::DryRun(format!("{other:?}"))),
        Err(e) => return Err(RehearseStop::DryRun(e.to_string())),
    };
    let layout = Layout::new(n);
    (o.before)("run");
    let manifest = run(
        &layout,
        RunOptions {
            at: o.at,
            generation: o.generation,
            legacy_root: o.source,
            allow_real_data_root: o.allow_real_data_root,
            real_data_root: o.real_data_root,
            secrets_check: o.secrets_check,
            accept_unconvertible: &[],
            hook: &mut |_| true,
            progress: None,
        },
    )
    .map_err(RehearseStop::Run)?;
    let moved: Vec<String> = dry_run_digest
        .keys()
        .chain(manifest.business_digest.keys())
        .filter(|k| dry_run_digest.get(*k) != manifest.business_digest.get(*k))
        .cloned()
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    if !moved.is_empty() {
        return Err(RehearseStop::Moved(moved));
    }
    match decide(&layout, true) {
        Startup::Published(_) => {}
        other => return Err(RehearseStop::Decide(Box::new(other))),
    }
    (o.before)("compare");
    match compare(
        &layout,
        &manifest,
        &manifest.business_digest,
        &CompareOptions {
            legacy_root: o.source,
            allow_real_data_root: o.allow_real_data_root,
            real_data_root: o.real_data_root,
            secrets_check: o.secrets_check,
        },
    ) {
        Comparison::Unchanged(_) => {}
        other => return Err(RehearseStop::Compare(Box::new(other))),
    }
    Ok(Rehearsal {
        files,
        dry_run_digest,
        layout,
        manifest,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 比较只按族：值不同的、只有一边有的都算变了，排好序、不重复。
    #[test]
    fn differing_families_include_both_sides() {
        let map = |pairs: &[(&str, &str)]| -> BTreeMap<String, String> {
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        };
        let base = map(&[("P1/tasks", "a"), ("P2/tasks", "b"), ("r/projects", "c")]);
        assert!(differing(&base, &base).is_empty());
        let digest = map(&[("P1/tasks", "a"), ("P3/tasks", "d"), ("r/projects", "x")]);
        assert_eq!(
            differing(&base, &digest),
            ["P2/tasks", "P3/tasks", "r/projects"]
        );
    }

    /// W3 r3 P1-R3-01：清理时发现某一层目录被换过（放开钉住到按身份重开之间），它和它的每一层祖先都原样留下，
    /// 并报告出来；它里面本次建的文件、旁支的目录照常删。
    #[cfg(windows)]
    #[test]
    fn a_replaced_directory_keeps_itself_and_every_ancestor() {
        let base = std::env::var_os("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("target")
            })
            .join("store-unit")
            .join("pinned-replaced");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let from = base.join("from.txt");
        std::fs::write(&from, b"x").unwrap();
        let outer = pin::open(&base).unwrap();
        let mut p = Pinned {
            root: pin::create(&outer, OsStr::new("src")).unwrap(),
            dirs: Vec::new(),
            files: Vec::new(),
        };
        for rel in ["a/b/c.txt", "a/d.txt", "e/f.txt", "g.txt"] {
            p.copy(&from, rel).unwrap();
        }
        p.dirs
            .iter_mut()
            .find(|(rel, _)| rel == Path::new("a/b"))
            .unwrap()
            .1
            .forge_identity();
        let left = p.remove();
        assert_eq!(left.len(), 1, "{left:?}");
        assert!(left[0].contains("was replaced"), "{left:?}");
        let src = base.join("src");
        assert!(src.join("a/b").is_dir() && src.join("a").is_dir() && src.is_dir());
        for gone in ["a/b/c.txt", "a/d.txt", "e/f.txt", "e", "g.txt"] {
            assert!(!src.join(gone).exists(), "{gone}");
        }
        drop(outer);
        std::fs::remove_dir_all(&base).unwrap();
    }

    /// 不按数据根输入的报告：数据根下的文件族都是 pending，不能发布。
    #[test]
    fn a_report_with_pending_families_is_not_publishable() {
        let why = publishable(&Report::default()).unwrap_err();
        assert!(why.starts_with("pending families: "), "{why}");
        assert!(why.contains("needs the data root"), "{why}");
    }
}
