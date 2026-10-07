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
use rusqlite::{Connection, OpenFlags};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
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
    /// 测试注入的中断（模拟进程被杀）。
    Interrupted(&'static str),
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
            Error::Interrupted(at) => write!(f, "interrupted at {at}"),
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

/// 改名，落盘之后才返回（07 §1）：Windows 上是 `MoveFileExW(WRITE_THROUGH [| REPLACE_EXISTING])`。
/// `std::fs::rename` 不带 WRITE_THROUGH，而 Windows 上目录不能单独 fsync，这个标志就是「fsync 目录」那一步。
/// 不替换时目标已存在就失败（发布与封存都不覆盖）。
#[cfg(windows)]
fn rename_durable(from: &Path, to: &Path, replace: bool) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    let wide = |p: &Path| {
        p.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<u16>>()
    };
    let (a, b) = (wide(from), wide(to));
    let flags = MOVEFILE_WRITE_THROUGH
        | if replace {
            MOVEFILE_REPLACE_EXISTING
        } else {
            0
        };
    // 刚写完的文件常被杀毒软件或索引器短暂打开，改名会得到 ACCESS_DENIED / SHARING_VIOLATION / LOCK_VIOLATION。
    // 这类占用几百毫秒内就会放开：退避重试约 10 秒，仍不行才报错（W3d 变异运行里实测撞到过 32）。
    let mut delay = std::time::Duration::from_millis(10);
    let mut waited = std::time::Duration::ZERO;
    loop {
        // SAFETY: 两个指针指向以 0 结尾、调用期间一直存活的 UTF-16 缓冲区；函数不保留它们。
        if unsafe { MoveFileExW(a.as_ptr(), b.as_ptr(), flags) } != 0 {
            return Ok(());
        }
        let e = std::io::Error::last_os_error();
        let transient = matches!(e.raw_os_error(), Some(5 | 32 | 33));
        if !transient || waited >= std::time::Duration::from_secs(10) {
            return Err(located(
                e,
                "move",
                &format!("{} -> {}", from.display(), to.display()),
            ));
        }
        std::thread::sleep(delay);
        waited += delay;
        delay = (delay * 2).min(std::time::Duration::from_millis(500));
    }
}

#[cfg(not(windows))]
fn rename_durable(from: &Path, to: &Path, replace: bool) -> std::io::Result<()> {
    if !replace && std::fs::symlink_metadata(to).is_ok() {
        return Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists));
    }
    std::fs::rename(from, to)?;
    File::open(to.parent().unwrap_or(Path::new(".")))?.sync_all()
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

/// 先写同目录的临时文件并刷盘，再落盘地改名替换：替换要么是旧的、要么是新的。
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).at("create", parent)?;
    }
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let temporary = path.with_file_name(format!("{name}.{}.tmp", std::process::id()));
    {
        let mut f = File::create(&temporary).at("create", &temporary)?;
        f.write_all(bytes).at("write", &temporary)?;
        f.sync_all().at("flush", &temporary)?;
    }
    let r = rename_durable(&temporary, path, true);
    if r.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    r
}

fn sha_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn file_sha256(path: &Path) -> std::io::Result<String> {
    let mut h = Sha256::new();
    let mut f = File::open(path).at("open", path)?;
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
        Some(Manifest {
            converter_version: text(&v, "converter_version")?,
            source_root: opt_text(&v, "source_root")?,
            source_files,
            business_digest,
            accepted_unconvertible,
            generation: text(&v, "generation")?,
            phase: Phase::parse(&text(&v, "phase")?)?,
            verify_digest: opt_text(&v, "verify_digest")?,
            publication_digest: opt_text(&v, "publication_digest")?,
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
    /// 用户选「沿用 3.0」时接受的 business_digest'（07 §7，W3e）。
    pub accepted_source_digest: Option<BTreeMap<String, String>>,
    /// 用户在比较结果为 UNKNOWN 时选了「沿用 3.0」：记下当时的原因。之后 `A=v3` 再遇到同一个原因不再打扰，
    /// 原因变了（多了别的问题，或者问题消失、能算出摘要了）照常判定（W3e 的取舍，见 REPORT.md）。
    pub accepted_unknown: Option<String>,
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
            ("accepted_unknown".into(), opt(&self.accepted_unknown)),
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
            accepted_unknown: match field(&v, "accepted_unknown") {
                None => None,
                Some(_) => opt_text(&v, "accepted_unknown")?,
            },
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
            let same_files = publication_digest(&layout.data()).ok() == m.publication_digest;
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
    for (from, name) in [
        (layout.manifest(), "conversion.json"),
        (layout.authority(), "authority.json"),
    ] {
        let dest = target.join(name);
        if from.exists() && !dest.exists() {
            std::fs::copy(&from, &dest).at("copy", &from)?;
        }
    }
    for from in [layout.manifest(), layout.authority()] {
        if from.exists() {
            std::fs::remove_file(from)?;
        }
    }
    std::fs::remove_file(&intent)?;
    Ok(target)
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

/// 阶段进度回调 `(阶段, 已完成, 总数)`。
pub type ProgressFn<'a> = &'a dyn Fn(&str, usize, usize);

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
    }
    Ok(out)
}

/// 07 §3 SNAPSHOT 的复制方式：枚举 F0、复制到 `src`、调 `after_copy`、再枚举 F1；
/// F1 ≠ F0 或副本的 sha256 与 F0 不符都是源未静止。转换与 §6 的比较共用。
fn snapshot(
    root: &Path,
    at: &str,
    src: &Path,
    copied: &dyn Fn(usize, usize),
    after_copy: &mut dyn FnMut() -> Result<()>,
) -> Result<Vec<SourceFile>> {
    let f0 = enumerate(root, at)?;
    copied(0, f0.len());
    for (i, f) in f0.iter().enumerate() {
        let to = src.join(&f.rel);
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let from = root.join(&f.rel);
        std::fs::copy(&from, &to).at("copy", &from)?;
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
    m.phase = Phase::Failed;
    m.failure = Some(why);
    write_manifest(layout, m)
}

/// 07 §3：从 SNAPSHOT 一直走到 PUBLISHED。调用方先拿到准入，并按 [`decide`] 处理掉 S3 / S4 / S5 的残留。
/// 失败时 `M` 记 FAILED 与原因，staging 保留供诊断；源与发布物都不改。
pub fn run(layout: &Layout, opts: RunOptions<'_>) -> Result<Manifest> {
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

    // SNAPSHOT：枚举 F0、复制、再枚举 F1，副本的 sha256 逐个等于 F0。
    let report_progress = |stage: &str, done: usize, total: usize| {
        if let Some(p) = opts.progress {
            p(stage, done, total);
        }
    };
    let snapshot = snapshot(
        opts.legacy_root,
        opts.at,
        &staging.join("src"),
        &|done, total| report_progress("SNAPSHOT", done, total),
        &mut || checkpoint(opts.hook, Step::SnapshotCopied, "SNAPSHOT"),
    );
    match snapshot {
        Ok(files) => m.source_files = files,
        Err(e @ Error::Interrupted(_)) => return Err(e),
        Err(e) => {
            fail(layout, &mut m, e.to_string())?;
            return Err(e);
        }
    }

    // IMPORT + VERIFY：在副本上转换（转换器自带独立 VERIFY），登记路径指向 L。
    m.phase = Phase::Import;
    write_manifest(layout, &m)?;
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
                generation: Some(g),
                secrets_check: opts.secrets_check,
                accept_unconvertible: opts.accept_unconvertible,
                origin_root: Some(opts.legacy_root),
                progress: opts.progress.map(legacy::Progress),
            },
        )
    });
    let report: Report = match converted {
        Ok(r) => r,
        Err(e) => {
            if let ConvertError::Verify(r) = &e {
                write_atomic(&staging.join("report.json"), r.report_json().as_bytes())?;
            }
            fail(layout, &mut m, e.to_string())?;
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
        fail(layout, &mut m, why.clone())?;
        return Err(Error::Unpublishable(why));
    }
    m.phase = Phase::Verify;
    m.verify_digest = Some(sha_hex(report_json.as_bytes()));
    m.business_digest = report.business_digest();
    m.accepted_unconvertible = report.accepted_unconvertible.clone();
    write_manifest(layout, &m)?;
    checkpoint(opts.hook, Step::Verified, "VERIFY")?;

    // PUBLISHING：新库合并 WAL、改回单文件后关闭；M 先落盘，再整体改名。
    {
        let c = Connection::open(data.join("atm.sqlite"))?;
        c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;")?;
    }
    m.phase = Phase::Publishing;
    m.publication_digest = Some(publication_digest(&data)?);
    write_manifest(layout, &m)?;
    report_progress("PUBLISHING", 0, 1);
    checkpoint(opts.hook, Step::BeforeRename, "PUBLISHING")?;
    if layout.data().exists() {
        // 发布目标已经有东西（不该有：调用方应已按 S5 处理）。不覆盖，整体隔离。
        seal_data_only(layout, opts.at)?;
    }
    rename_durable(&data, &layout.data(), false)?;
    checkpoint(opts.hook, Step::Renamed, "PUBLISHING")?;
    publish(layout, &mut m, opts.at)?;
    report_progress("PUBLISHED", 1, 1);
    Ok(m)
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
            accepted_unknown: None,
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
/// | v3 | 不变 / `L` 不在了 / 与用户接受过的同一个 UNKNOWN | Serve |
/// | v3 | 变了 / 其他 UNKNOWN | Conflict（后台比较得出时立即进入） |
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
        ("v3", Comparison::Unknown(why)) if a.accepted_unknown.as_deref() == Some(why.as_str()) => {
            Verdict::Serve
        }
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
        accepted_unknown: None,
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
        accepted_unknown: None,
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
/// 比较是 UNKNOWN 时没有摘要可绑，记下原因（[`Authority::accepted_unknown`]）。先写 `A`，再清启动状态：
/// 中间被杀的话下次启动还会再问一次，不会在没有决定的情况下放行。
pub fn choose_v3(
    layout: &Layout,
    m: &Manifest,
    cmp: &Comparison,
    at: &str,
) -> std::io::Result<Authority> {
    let (accepted_source_digest, accepted_unknown) = match cmp {
        Comparison::Unchanged(d) | Comparison::Changed { digest: d, .. } => (Some(d.clone()), None),
        Comparison::Unknown(why) => (None, Some(why.clone())),
        Comparison::LegacyGone => (None, None),
    };
    let a = Authority {
        authority: "v3".into(),
        by: "user-choice".into(),
        txn: None,
        at: at.to_string(),
        generation: Some(m.generation.clone()),
        accepted_source_digest,
        accepted_unknown,
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

    /// 不按数据根输入的报告：数据根下的文件族都是 pending，不能发布。
    #[test]
    fn a_report_with_pending_families_is_not_publishable() {
        let why = publishable(&Report::default()).unwrap_err();
        assert!(why.starts_with("pending families: "), "{why}");
        assert!(why.contains("needs the data root"), "{why}");
    }
}
