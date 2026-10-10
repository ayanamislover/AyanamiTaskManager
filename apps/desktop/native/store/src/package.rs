//! 项目包：导出 `.aytproj` v2 / JSON / CSV，导入 `.aytproj` v2 与 v1、2.x 的项目与知识库备份（方案 §4、
//! 00 C-07 v6、05 §7-3、r2 A4）。
//!
//! **导出**（只有 User，00 C-07 v6：不建 EXPORT 备份、不修剪）：
//! - 先 `VACUUM INTO` 得到一致的读快照；新建一个同 schema 的空库，只把这个项目的行抄进去（[`PACKAGED_TABLES`]），
//!   再 `VACUUM INTO` 一次。别的项目、全局表、知识库、回执、`app_meta`（含读游标的密钥）一行都不进包，
//!   连空闲页里也没有。
//! - `.aytproj` v2 是 zip：`project.sqlite`、`artifacts/**`（`N\data\artifacts\<项目>\**`）、`manifest.json`
//!   （格式、迁移、快照 sha256、附件清单与摘要、各表行数）与 `SHA256SUMS.txt`（`<sha256>  <路径>`，与 v1 一样不含
//!   manifest 自己）。附件行的 `local_path` 在包里改成 `artifacts/<相对路径>`。
//! - JSON：同一份单项目快照逐表的行；CSV：2.0 的十二列（BOM + CRLF）。
//! - 输出 `exports\<CODE>-<stamp>.<ext>`，stamp 是 createdAt 把 `:`、`.` 换成 `-`（与 2.0 相同）；先写到暂存再改名。
//!
//! **导入**（预览 A+U 只读、零副作用；应用只有 User）：一律作为**新项目**导入——新的项目 id、新的 scope generation
//! （`IMPORTED`）与 epoch；项目代码被占用时拒绝并给出建议代码，由用户换一个再来。
//! - v2：逐项核对 SHA256SUMS、manifest 的快照 sha256 与附件摘要、迁移集合与本程序一致；
//! - v1（2.0 导出的包）与 2.x 的项目备份：先用转换器（[`crate::legacy::convert`]，配一份只含这个项目的合成 registry）
//!   转成 3.0 的单项目库，再走同一条导入路径；
//! - 2.x 的知识库备份：同样转换后**合并**进知识库，id 或 slug 已存在的条目跳过（不覆盖），跳过的列在结果里。
//!
//! 导入的副本里，原项目仍在线的 session 全部关闭（FORCE_CLOSE，清掉客户端身份），认领保留但成为需要接管的旧认领：
//! 同一台电脑上导入自己的导出时，副本不会冒充原项目里正在工作的 Agent。

use crate::Store;
use crate::backup::{
    BackupError, FileEntry, attachments_digest, attachments_lock, copy_tree, hash_file, list_tree,
    path_str, side_reader,
};
use crate::events::ulid;
use crate::legacy::{ConvertError, ConvertOptions, Home, LegacySources};
use crate::restore::{allocate_generation, readonly_uri};
use rusqlite::types::ValueRef;
use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior, params,
};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

pub const FORMAT: &str = "ayanami-task-project";
pub const FORMAT_VERSION: i64 = 2;
const DB_ENTRY: &str = "project.sqlite";
const MANIFEST_ENTRY: &str = "manifest.json";
const SUMS_ENTRY: &str = "SHA256SUMS.txt";
const ARTIFACTS_PREFIX: &str = "artifacts/";
/// 导出、导入的暂存目录（在 `exports\` 下）。同一时间只有一个导出或导入（附件锁），开始时里面剩下的都是上一次中断的残留。
pub const STAGING_DIR: &str = ".staging";
const MAX_ENTRIES: usize = 100_000;
const MAX_TOTAL_BYTES: u64 = 16 << 30;
const MAX_TEXT_BYTES: u64 = 8 << 20;
const IMPORT_BUDGET: Duration = Duration::from_secs(60);

/// 进包的表：项目范围的工作数据（与按范围恢复同一张表），加上身份（agents、agent_sessions）、导入记录与搜索文档。
/// `projects` 只进这一行，`scope_generations` 只进它当前世代那一行（外键要有）。
pub const PACKAGED_TABLES: &[&str] = &[
    "counters",
    "objectives",
    "milestones",
    "work_items",
    "work_item_relations",
    "checklist_items",
    "progress_updates",
    "project_updates",
    "blockers",
    "records",
    "artifacts",
    "handoffs",
    "events",
    "review_requests",
    "review_submissions",
    "engineering_project_metrics",
    "engineering_work_item_metrics",
    "agents",
    "agent_sessions",
    "import_history",
    "search_docs",
];

/// 有 `project_id` 列、但不进包的表与理由。新加带 `project_id` 的表必须登记到两处之一（用例核对）。
pub const NOT_PACKAGED: &[(&str, &str)] = &[
    (
        "global_feed",
        "global history; the import records one project.imported event",
    ),
    (
        "project_paths",
        "paths of this computer; the imported copy is not bound to a directory",
    ),
    ("saved_views", "user preferences"),
    (
        "project_restore_requests",
        "lifecycle requests of the original project",
    ),
    ("legacy_backups", "the 2.x backup catalog of this computer"),
];

const SEARCH_DOC_COLUMNS: &str =
    "project_id, entity_type, entity_id, entity_key, title, body, updated_at";

#[derive(Debug)]
pub enum PackageError {
    /// 项目、包文件或备份不存在。
    NotFound(String),
    /// 包不完整、哈希对不上、条目名不安全、格式不认识。
    Invalid(String),
    /// v2 包的迁移集合与本程序不同。
    SchemaMismatch(String),
    /// 导入后的项目代码不合格（包或 2.x 库里带来的，没有另给代码）：不导入（peer W6 r1 P1-01）。
    BadCode {
        code: String,
    },
    /// 项目代码已被占用；`suggested` 是一个空着的代码。
    CodeTaken {
        code: String,
        suggested: String,
    },
    /// 2.x 库的转换失败。
    Legacy(ConvertError),
    Backup(BackupError),
    Sqlite(rusqlite::Error),
    Io(std::io::Error),
    /// 写入没有执行或没有提交（存储忙、正在关闭）。
    Write(String),
    /// 数据目录里本该是普通目录的地方是链接（junction、符号链接）：什么都没改（peer W6 r1 P1-02）。
    LinkedPath(String),
}

impl std::fmt::Display for PackageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PackageError::NotFound(m) => write!(f, "not found: {m}"),
            PackageError::Invalid(m) => write!(f, "invalid package: {m}"),
            PackageError::SchemaMismatch(m) => write!(f, "schema mismatch: {m}"),
            PackageError::BadCode { code } => write!(f, "project code {code:?} is not valid"),
            PackageError::CodeTaken { code, suggested } => {
                write!(f, "project code {code} is taken (try {suggested})")
            }
            PackageError::Legacy(e) => write!(f, "2.x conversion: {e}"),
            PackageError::Backup(e) => write!(f, "{e}"),
            PackageError::Sqlite(e) => write!(f, "sqlite: {e}"),
            PackageError::Io(e) => write!(f, "io: {e}"),
            PackageError::LinkedPath(p) => write!(f, "{p} is a link"),
            PackageError::Write(m) => write!(f, "write: {m}"),
        }
    }
}

impl std::error::Error for PackageError {}

impl From<rusqlite::Error> for PackageError {
    fn from(e: rusqlite::Error) -> Self {
        PackageError::Sqlite(e)
    }
}

impl From<std::io::Error> for PackageError {
    fn from(e: std::io::Error) -> Self {
        PackageError::Io(e)
    }
}

impl From<BackupError> for PackageError {
    fn from(e: BackupError) -> Self {
        match e {
            BackupError::Sqlite(e) => PackageError::Sqlite(e),
            BackupError::Io(e) => PackageError::Io(e),
            other => PackageError::Backup(other),
        }
    }
}

impl From<ConvertError> for PackageError {
    fn from(e: ConvertError) -> Self {
        PackageError::Legacy(e)
    }
}

impl From<crate::StoreError> for PackageError {
    fn from(e: crate::StoreError) -> Self {
        match e {
            crate::StoreError::Sqlite(e) => PackageError::Sqlite(e),
            other => PackageError::Invalid(other.to_string()),
        }
    }
}

impl From<crate::events::EventError> for PackageError {
    fn from(e: crate::events::EventError) -> Self {
        match e {
            crate::events::EventError::Sqlite(e) => PackageError::Sqlite(e),
            other => PackageError::Invalid(format!("{other:?}")),
        }
    }
}

impl From<zip::result::ZipError> for PackageError {
    fn from(e: zip::result::ZipError) -> Self {
        match e {
            zip::result::ZipError::Io(e) => PackageError::Io(e),
            other => PackageError::Invalid(other.to_string()),
        }
    }
}

pub type Result<T> = std::result::Result<T, PackageError>;

fn invalid(m: impl Into<String>) -> PackageError {
    PackageError::Invalid(m.into())
}

// ---------- 导出 ----------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Package,
    Json,
    Csv,
}

impl Format {
    pub fn parse(s: &str) -> Option<Format> {
        match s {
            "aytproj" => Some(Format::Package),
            "json" => Some(Format::Json),
            "csv" => Some(Format::Csv),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Format::Package => "aytproj",
            Format::Json => "json",
            Format::Csv => "csv",
        }
    }
}

#[derive(Clone, Debug)]
pub struct ExportOptions<'a> {
    /// `N\exports`。
    pub exports_dir: &'a Path,
    pub at: &'a str,
    /// 写进 manifest 的产品版本。
    pub app_version: &'a str,
}

#[derive(Clone, Debug)]
pub struct Exported {
    pub format: Format,
    pub project_code: String,
    pub path: PathBuf,
    pub sha256: String,
    pub size_bytes: u64,
    pub created_at: String,
    pub attachments: usize,
}

/// 导出一个项目（`project_id` 是 id）。
pub fn export_project(
    store: &Store,
    project_id: &str,
    format: Format,
    opts: &ExportOptions<'_>,
) -> Result<Exported> {
    let _lock = attachments_lock(store, "export_project")?;
    crate::restore::finish_swaps_locked(store)?;
    let staging = fresh_staging(opts.exports_dir)?;
    let result = export_in(store, project_id, format, opts, &staging);
    let _ = fs::remove_dir_all(&staging);
    result
}

fn export_in(
    store: &Store,
    project_id: &str,
    format: Format,
    opts: &ExportOptions<'_>,
    staging: &Path,
) -> Result<Exported> {
    let snapshot = staging.join("snapshot.sqlite");
    {
        let side = side_reader(store.path())?;
        side.execute("VACUUM INTO ?1", [path_str(&snapshot)?])?;
    }
    let artifacts = crate::backup::artifacts_root(store.path());
    let prefix = artifacts.join(project_id);
    refuse_links(&[
        artifacts.parent().unwrap_or(&artifacts),
        &artifacts,
        &prefix,
    ])?;
    let db = staging.join(DB_ENTRY);
    let (code, name) = extract_project(&snapshot, &db, project_id, &prefix)?;
    remove_db(&snapshot);
    let stamp = opts.at.replace([':', '.'], "-");
    let stem = file_component(&code);
    let file_name = format!("{stem}-{stamp}.{}", format.as_str());
    let out = staging.join(&file_name);
    let attachments = match format {
        Format::Package => {
            let files = copy_tree(&prefix, &staging.join("artifacts"))?;
            let manifest = manifest(&db, project_id, &code, &name, &files, opts)?;
            write_zip(&out, &db, &manifest, &staging.join("artifacts"), &files)?;
            files.len()
        }
        Format::Json => {
            fs::write(&out, json_export(&db, project_id, &code, &name, opts.at)?)?;
            0
        }
        Format::Csv => {
            fs::write(&out, csv_export(&db)?)?;
            0
        }
    };
    fs::create_dir_all(opts.exports_dir)?;
    let mut target = opts.exports_dir.join(&file_name);
    let mut n = 2;
    while target.exists() {
        target = opts
            .exports_dir
            .join(format!("{stem}-{stamp}-{n}.{}", format.as_str()));
        n += 1;
    }
    sync(&out)?;
    atm_install_state::durable::rename(&out, &target, false)?;
    let (sha256, size_bytes) = hash_file(&target)?;
    Ok(Exported {
        format,
        project_code: code,
        path: target,
        sha256,
        size_bytes,
        created_at: opts.at.to_string(),
        attachments,
    })
}

/// 新建同 schema 的空库，只抄这个项目。返回 (code, name)。
fn extract_project(
    snapshot: &Path,
    out: &Path,
    project_id: &str,
    artifacts_prefix: &Path,
) -> Result<(String, String)> {
    let build = out.with_extension("build");
    let c = crate::open(&build)?;
    c.execute("ATTACH DATABASE ?1 AS s", [readonly_uri(snapshot)?])?;
    let found: Option<(String, String)> = c
        .query_row(
            "SELECT code, name FROM s.projects WHERE id = ?1",
            [project_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((code, name)) = found else {
        return Err(PackageError::NotFound(format!("project {project_id}")));
    };
    {
        let tx = c.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO main.scope_generations SELECT * FROM s.scope_generations
             WHERE gen = (SELECT scope_gen FROM s.projects WHERE id = ?1)",
            [project_id],
        )?;
        tx.execute(
            "INSERT INTO main.projects SELECT * FROM s.projects WHERE id = ?1",
            [project_id],
        )?;
        for t in PACKAGED_TABLES {
            tx.execute(
                &format!("INSERT INTO main.{t} SELECT * FROM s.{t} WHERE project_id = ?1"),
                [project_id],
            )?;
        }
        let prefix = path_str(artifacts_prefix)?.replace('\\', "/");
        tx.execute(
            "UPDATE main.artifacts SET local_path = 'artifacts/' || substr(replace(local_path, char(92), '/'), length(?1) + 2)
             WHERE local_path IS NOT NULL
               AND lower(substr(replace(local_path, char(92), '/'), 1, length(?1) + 1)) = lower(?1 || '/')",
            [&prefix],
        )?;
        tx.commit()?;
    }
    c.execute("DETACH DATABASE s", [])?;
    c.execute("VACUUM INTO ?1", [path_str(out)?])?;
    drop(c);
    remove_db(&build);
    Ok((code, name))
}

fn remove_db(path: &Path) {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let mut p = path.as_os_str().to_owned();
        p.push(suffix);
        let _ = fs::remove_file(PathBuf::from(p));
    }
}

fn counts(c: &Connection) -> Result<Map<String, Value>> {
    let mut out = Map::new();
    for t in std::iter::once(&"projects").chain(PACKAGED_TABLES) {
        let n: i64 = c.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get(0))?;
        out.insert((*t).to_string(), json!(n));
    }
    Ok(out)
}

fn current_migrations() -> Vec<Value> {
    crate::MIGRATIONS
        .iter()
        .map(|m| json!({"version": m.version, "sha256": m.sha256()}))
        .collect()
}

fn files_view(files: &[FileEntry]) -> Vec<Value> {
    files
        .iter()
        .map(|f| json!({"path": f.path, "sizeBytes": f.size, "sha256": f.sha256}))
        .collect()
}

fn manifest(
    db: &Path,
    project_id: &str,
    code: &str,
    name: &str,
    files: &[FileEntry],
    opts: &ExportOptions<'_>,
) -> Result<Vec<u8>> {
    let (sha256, size) = hash_file(db)?;
    let c = side_reader(db)?;
    let v = json!({
        "format": FORMAT,
        "formatVersion": FORMAT_VERSION,
        "applicationVersion": opts.app_version,
        "project": {"id": project_id, "code": code, "name": name},
        "schemaVersion": crate::MIGRATIONS.last().map_or(0, |m| m.version),
        "migrations": current_migrations(),
        "createdAt": opts.at,
        "snapshotSha256": sha256,
        "sizeBytes": size,
        "counts": counts(&c)?,
        "attachments": {"sha256": attachments_digest(files), "files": files_view(files)},
    });
    let mut text = serde_json::to_string_pretty(&v).map_err(|e| invalid(e.to_string()))?;
    text.push('\n');
    Ok(text.into_bytes())
}

fn write_zip(
    out: &Path,
    db: &Path,
    manifest: &[u8],
    artifacts: &Path,
    files: &[FileEntry],
) -> Result<()> {
    use zip::write::SimpleFileOptions;
    let opts = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .large_file(true);
    let (db_sha, _) = hash_file(db)?;
    let mut sums = format!("{db_sha}  {DB_ENTRY}\n");
    for f in files {
        sums.push_str(&format!("{}  {ARTIFACTS_PREFIX}{}\n", f.sha256, f.path));
    }
    let mut zip = zip::ZipWriter::new(File::create(out)?);
    zip.start_file(DB_ENTRY, opts)?;
    std::io::copy(&mut File::open(db)?, &mut zip)?;
    for f in files {
        zip.start_file(format!("{ARTIFACTS_PREFIX}{}", f.path), opts)?;
        std::io::copy(&mut File::open(artifacts.join(&f.path))?, &mut zip)?;
    }
    zip.start_file(MANIFEST_ENTRY, opts)?;
    zip.write_all(manifest)?;
    zip.start_file(SUMS_ENTRY, opts)?;
    zip.write_all(sums.as_bytes())?;
    zip.finish()?;
    Ok(())
}

fn sql_value(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Value::String(b.iter().map(|x| format!("{x:02x}")).collect()),
    }
}

fn table_rows(c: &Connection, table: &str) -> Result<Vec<Value>> {
    let mut st = c.prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))?;
    let names: Vec<String> = st.column_names().iter().map(|s| s.to_string()).collect();
    let mut rows = st.query([])?;
    let mut out = Vec::new();
    while let Some(r) = rows.next()? {
        let mut m = Map::new();
        for (i, n) in names.iter().enumerate() {
            m.insert(n.clone(), sql_value(r.get_ref(i)?));
        }
        out.push(Value::Object(m));
    }
    Ok(out)
}

/// JSON：单项目快照逐表的行（2.0 是 `format: 1` 的项目库表；3.0 是单库的同名表，`search_docs` 是派生的，不导出）。
fn json_export(db: &Path, project_id: &str, code: &str, name: &str, at: &str) -> Result<Vec<u8>> {
    let c = side_reader(db)?;
    let mut data = Map::new();
    for t in std::iter::once(&"projects")
        .chain(PACKAGED_TABLES)
        .filter(|t| **t != "search_docs")
    {
        data.insert((*t).to_string(), Value::Array(table_rows(&c, t)?));
    }
    let v = json!({
        "format": FORMAT_VERSION,
        "project": {"id": project_id, "code": code, "name": name},
        "createdAt": at,
        "data": data,
    });
    let mut text = serde_json::to_string_pretty(&v).map_err(|e| invalid(e.to_string()))?;
    text.push('\n');
    Ok(text.into_bytes())
}

const CSV_COLUMNS: &[&str] = &[
    "project_code",
    "task_key",
    "parent_key",
    "type",
    "title",
    "status",
    "priority",
    "assignee",
    "target_date",
    "progress",
    "blocker",
    "latest_update",
];

fn csv_cell(v: ValueRef<'_>) -> String {
    let text = match v {
        ValueRef::Null => return String::new(),
        ValueRef::Integer(i) => i.to_string(),
        ValueRef::Real(f) => crate::jsjson::number_to_string(f),
        ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
        ValueRef::Blob(_) => String::new(),
    };
    if text.contains(['"', ',', '\r', '\n']) {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text
    }
}

/// CSV：2.0 的十二列（`manager.ts` 的 csv 分支），BOM 开头，CRLF 换行。
fn csv_export(db: &Path) -> Result<Vec<u8>> {
    let c = side_reader(db)?;
    let mut st = c.prepare(
        "SELECT p.code, p.code || '-T-' || printf('%04d', i.local_no),
                CASE WHEN parent.local_no IS NULL THEN '' ELSE p.code || '-T-' || printf('%04d', parent.local_no) END,
                i.type, i.title, i.status, i.priority, coalesce(i.assignee_agent_id, ''), coalesce(i.target_date, ''),
                i.computed_progress, coalesce(i.blocked_reason, ''),
                coalesce((SELECT u.summary FROM progress_updates u WHERE u.project_id = i.project_id AND u.work_item_id = i.id
                          ORDER BY u.created_at DESC LIMIT 1), '')
         FROM work_items i JOIN projects p ON p.id = i.project_id
         LEFT JOIN work_items parent ON parent.project_id = i.project_id AND parent.id = i.parent_id
         ORDER BY i.local_no",
    )?;
    let mut lines = vec![CSV_COLUMNS.join(",")];
    let mut rows = st.query([])?;
    while let Some(r) = rows.next()? {
        let cells: Vec<String> = (0..CSV_COLUMNS.len())
            .map(|i| r.get_ref(i).map(csv_cell))
            .collect::<rusqlite::Result<_>>()?;
        lines.push(cells.join(","));
    }
    let mut out = "\u{FEFF}".as_bytes().to_vec();
    out.extend_from_slice(lines.join("\r\n").as_bytes());
    out.extend_from_slice(b"\r\n");
    Ok(out)
}

// ---------- 读包 ----------

/// `.aytproj` 的条目名：只允许 `project.sqlite`、`manifest.json`、`SHA256SUMS.txt` 与 `artifacts/<安全的相对路径>`。
fn entry_kind(name: &str) -> Result<Entry> {
    match name {
        DB_ENTRY => Ok(Entry::Db),
        MANIFEST_ENTRY => Ok(Entry::Manifest),
        SUMS_ENTRY => Ok(Entry::Sums),
        _ => match name.strip_prefix(ARTIFACTS_PREFIX) {
            Some(rel) => {
                safe_relative(rel).map_err(|why| invalid(format!("entry {name:?}: {why}")))?;
                Ok(Entry::Artifact(rel.to_string()))
            }
            None => Err(invalid(format!("unexpected entry {name:?}"))),
        },
    }
}

enum Entry {
    Db,
    Manifest,
    Sums,
    Artifact(String),
}

const RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// 安全的相对路径（与 setup 解包的规则相同）：不是绝对路径、没有盘符与流、没有 `.` / `..`、没有保留名。
fn safe_relative(name: &str) -> std::result::Result<PathBuf, String> {
    if name.is_empty() || name.len() > 400 {
        return Err("empty or overlong name".into());
    }
    if name.starts_with(['/', '\\']) || name.contains(':') || name.contains('\\') {
        return Err("absolute, drive, stream or backslash name".into());
    }
    let mut path = PathBuf::new();
    for part in name.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(format!("component {part:?}"));
        }
        if part.ends_with(['.', ' '])
            || part
                .chars()
                .any(|c| c.is_control() || "<>\"|?*".contains(c))
        {
            return Err(format!("component {part:?}"));
        }
        let stem = part.split('.').next().unwrap_or("").to_ascii_lowercase();
        if RESERVED.contains(&stem.as_str()) {
            return Err(format!("reserved name {part:?}"));
        }
        path.push(part);
    }
    if path
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("non-normal component".into());
    }
    Ok(path)
}

/// 读完一个包的结果。`extracted` 给了时文件写在那里（`project.sqlite`、`artifacts/**`）。
struct Scanned {
    db: (String, u64),
    manifest: Value,
    sums: BTreeMap<String, String>,
    artifacts: Vec<FileEntry>,
}

fn sha_hex(h: Sha256) -> String {
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// 逐条读 zip（流式算 sha256，`extract` 给了就同时写出）。核对条目名、数量、总大小、声明大小与实际大小。
fn scan(package: &Path, extract: Option<&Path>) -> Result<Scanned> {
    let file = File::open(package)
        .map_err(|e| PackageError::NotFound(format!("{}: {e}", package.display())))?;
    let mut archive = zip::ZipArchive::new(file)?;
    if archive.len() > MAX_ENTRIES {
        return Err(invalid("too many entries"));
    }
    let mut seen = BTreeSet::new();
    let mut total = 0u64;
    let mut db = None;
    let mut manifest = None;
    let mut sums = None;
    let mut artifacts = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let name = entry.name().to_owned();
        if entry.is_symlink() {
            return Err(invalid(format!("entry {name:?} is a link")));
        }
        if entry.is_dir() {
            continue;
        }
        let kind = entry_kind(&name)?;
        if !seen.insert(name.to_ascii_lowercase()) {
            return Err(invalid(format!("entry {name:?} appears twice")));
        }
        let declared = entry.size();
        total = total.saturating_add(declared);
        if total > MAX_TOTAL_BYTES {
            return Err(invalid("the package is larger than supported"));
        }
        let text = matches!(kind, Entry::Manifest | Entry::Sums);
        if text && declared > MAX_TEXT_BYTES {
            return Err(invalid(format!("entry {name:?} is too large")));
        }
        let dest = match (&kind, extract) {
            (Entry::Db, Some(dir)) => Some(dir.join(DB_ENTRY)),
            (Entry::Artifact(rel), Some(dir)) => Some(dir.join("artifacts").join(rel)),
            _ => None,
        };
        let mut out = match &dest {
            Some(d) => {
                if let Some(parent) = d.parent() {
                    fs::create_dir_all(parent)?;
                }
                Some(File::create(d)?)
            }
            None => None,
        };
        let mut h = Sha256::new();
        let mut buf = vec![0u8; 256 * 1024];
        let mut kept = Vec::new();
        let mut read_total = 0u64;
        let mut limited = (&mut entry).take(declared + 1);
        loop {
            let n = limited.read(&mut buf)?;
            if n == 0 {
                break;
            }
            read_total += n as u64;
            if read_total > declared {
                return Err(invalid(format!("entry {name:?} is longer than declared")));
            }
            h.update(&buf[..n]);
            if let Some(o) = out.as_mut() {
                o.write_all(&buf[..n])?;
            }
            if text {
                kept.extend_from_slice(&buf[..n]);
            }
        }
        if read_total != declared {
            return Err(invalid(format!("entry {name:?} is shorter than declared")));
        }
        if let Some(o) = out {
            o.sync_all()?;
        }
        let sha = sha_hex(h);
        match kind {
            Entry::Db => db = Some((sha, declared)),
            Entry::Manifest => {
                manifest = Some(
                    serde_json::from_slice::<Value>(&kept)
                        .map_err(|e| invalid(format!("manifest.json: {e}")))?,
                );
            }
            Entry::Sums => sums = Some(parse_sums(&kept)?),
            Entry::Artifact(rel) => artifacts.push(FileEntry {
                path: rel,
                size: declared,
                sha256: sha,
            }),
        }
    }
    artifacts.sort_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
    Ok(Scanned {
        db: db.ok_or_else(|| invalid("project.sqlite is missing"))?,
        manifest: manifest.ok_or_else(|| invalid("manifest.json is missing"))?,
        sums: sums.ok_or_else(|| invalid("SHA256SUMS.txt is missing"))?,
        artifacts,
    })
}

fn parse_sums(bytes: &[u8]) -> Result<BTreeMap<String, String>> {
    let text = std::str::from_utf8(bytes).map_err(|_| invalid("SHA256SUMS.txt is not UTF-8"))?;
    let mut out = BTreeMap::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let (sha, path) = line
            .split_once("  ")
            .ok_or_else(|| invalid(format!("SHA256SUMS.txt line {line:?}")))?;
        if sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(invalid(format!("SHA256SUMS.txt line {line:?}")));
        }
        if out
            .insert(path.to_string(), sha.to_ascii_lowercase())
            .is_some()
        {
            return Err(invalid(format!("SHA256SUMS.txt lists {path:?} twice")));
        }
    }
    Ok(out)
}

/// 包里声明的项目。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PackagedProject {
    pub id: String,
    pub code: String,
    pub name: String,
}

/// 预览：核对通过的包是什么。
#[derive(Clone, Debug)]
pub struct Inspection {
    pub format_version: i64,
    pub project: PackagedProject,
    pub created_at: Option<String>,
    pub application_version: Option<String>,
    pub schema_version: Option<i64>,
    /// v2 的 manifest 里的行数（已由快照 sha256 绑定）；v1 没有。
    pub counts: Option<Value>,
    pub attachments: Vec<FileEntry>,
    pub sha256: String,
    pub size_bytes: u64,
}

fn text_field(v: &Value, pointer: &str) -> Result<String> {
    v.pointer(pointer)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| invalid(format!("manifest.json: {pointer} is missing")))
}

/// 核对一个读完的包：SHA256SUMS 与实际条目一一对应且哈希相等；manifest 的格式、版本、快照 sha256；
/// v2 另核对附件摘要与清单、迁移集合。
fn verify_scanned(s: &Scanned) -> Result<(i64, PackagedProject)> {
    let m = &s.manifest;
    if m.get("format").and_then(Value::as_str) != Some(FORMAT) {
        return Err(invalid(
            "manifest.json: not an ayanami-task-project package",
        ));
    }
    let version = m
        .get("formatVersion")
        .and_then(Value::as_i64)
        .ok_or_else(|| invalid("manifest.json: formatVersion is missing"))?;
    if version != 1 && version != FORMAT_VERSION {
        return Err(invalid(format!(
            "formatVersion {version} is not supported (1 and {FORMAT_VERSION} are)"
        )));
    }
    let mut actual = BTreeMap::new();
    actual.insert(DB_ENTRY.to_string(), s.db.0.clone());
    for f in &s.artifacts {
        actual.insert(format!("{ARTIFACTS_PREFIX}{}", f.path), f.sha256.clone());
    }
    if actual != s.sums {
        let listed: BTreeSet<&String> = s.sums.keys().collect();
        let present: BTreeSet<&String> = actual.keys().collect();
        let missing: Vec<_> = listed.difference(&present).collect();
        let unlisted: Vec<_> = present.difference(&listed).collect();
        let differ: Vec<_> = actual
            .iter()
            .filter(|(k, v)| s.sums.get(*k).is_some_and(|x| x != *v))
            .map(|(k, _)| k)
            .collect();
        return Err(invalid(format!(
            "SHA256SUMS.txt does not match the entries (missing {missing:?}, unlisted {unlisted:?}, different {differ:?})"
        )));
    }
    if m.get("snapshotSha256").and_then(Value::as_str) != Some(s.db.0.as_str()) {
        return Err(invalid(
            "manifest.json: snapshotSha256 does not match project.sqlite",
        ));
    }
    let project = PackagedProject {
        id: text_field(m, "/project/id")?,
        code: text_field(m, "/project/code")?,
        name: text_field(m, "/project/name")?,
    };
    if version == FORMAT_VERSION {
        let digest = attachments_digest(&s.artifacts);
        let listed = m
            .pointer("/attachments/files")
            .cloned()
            .unwrap_or(Value::Null);
        if m.pointer("/attachments/sha256").and_then(Value::as_str) != Some(digest.as_str())
            || listed != Value::Array(files_view(&s.artifacts))
        {
            return Err(invalid(
                "manifest.json: attachments differ from the package",
            ));
        }
        let migrations = m.get("migrations").cloned().unwrap_or(Value::Null);
        if migrations != Value::Array(current_migrations()) {
            return Err(PackageError::SchemaMismatch(format!(
                "the package was written with migrations {migrations}, this build has {}",
                Value::Array(current_migrations())
            )));
        }
    }
    Ok((version, project))
}

/// 预览一个 `.aytproj`：只读，不写任何文件（流式核对）。
pub fn inspect_package(package: &Path) -> Result<Inspection> {
    let s = scan(package, None)?;
    let (format_version, project) = verify_scanned(&s)?;
    let (sha256, size_bytes) = hash_file(package)?;
    let m = &s.manifest;
    Ok(Inspection {
        format_version,
        project,
        created_at: m
            .get("createdAt")
            .and_then(Value::as_str)
            .map(str::to_owned),
        application_version: m
            .get("applicationVersion")
            .and_then(Value::as_str)
            .map(str::to_owned),
        schema_version: m.get("schemaVersion").and_then(Value::as_i64),
        counts: m.get("counts").filter(|c| c.is_object()).cloned(),
        attachments: s.artifacts,
        sha256,
        size_bytes,
    })
}

// ---------- 2.x 单库 ----------

/// 2.x 的一个项目库或知识库（2.x 备份、v1 包里的 `project.sqlite`）里有什么：只读打开（immutable），不写源。
#[derive(Clone, Debug)]
pub struct LegacyInspection {
    pub project: Option<PackagedProject>,
    pub schema_version: Option<i64>,
    pub counts: Value,
}

/// 只读、不改源文件（`immutable=1`，不建 -wal / -shm）。
fn open_immutable(path: &Path) -> Result<Connection> {
    let uri = format!("{}&immutable=1", readonly_uri(path)?);
    let c = Connection::open_with_flags(
        uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    crate::harden(&c)?;
    c.pragma_update(None, "query_only", true)?;
    Ok(c)
}

fn count_if(c: &Connection, table: &str) -> Result<Option<i64>> {
    let exists: bool = c.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [table],
        |r| r.get(0),
    )?;
    if !exists {
        return Ok(None);
    }
    Ok(Some(c.query_row(
        &format!("SELECT count(*) FROM {table}"),
        [],
        |r| r.get(0),
    )?))
}

/// 预览 2.x 的项目库（`home` 为 Project）或知识库（Knowledge）。源文件不动。
pub fn inspect_legacy(path: &Path, home: Home) -> Result<LegacyInspection> {
    if !path.is_file() {
        return Err(PackageError::NotFound(path.display().to_string()));
    }
    let c = open_immutable(path)?;
    let quick: String = c.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    if quick != "ok" {
        return Err(invalid(format!("{}: quick_check: {quick}", path.display())));
    }
    let schema_version: Option<i64> = c
        .query_row("SELECT max(version) FROM schema_migrations", [], |r| {
            r.get(0)
        })
        .optional()
        .ok()
        .flatten()
        .flatten();
    let (project, tables): (_, &[&str]) = match home {
        Home::Project => {
            let p = c
                .query_row(
                    "SELECT project_id, project_code, name FROM project_meta",
                    [],
                    |r| {
                        Ok(PackagedProject {
                            id: r.get(0)?,
                            code: r.get(1)?,
                            name: r.get(2)?,
                        })
                    },
                )
                .optional()
                .map_err(|e| invalid(format!("not a 2.x project database: {e}")))?
                .ok_or_else(|| invalid("not a 2.x project database: project_meta is empty"))?;
            (
                Some(p),
                &["work_items", "records", "progress_updates", "events"],
            )
        }
        Home::Knowledge => {
            count_if(&c, "knowledge_entries")?
                .ok_or_else(|| invalid("not a 2.x knowledge database"))?;
            (None, &["knowledge_entries", "knowledge_revisions"])
        }
        _ => {
            return Err(invalid(
                "only 2.x project and knowledge databases can be imported",
            ));
        }
    };
    let mut counts = Map::new();
    for t in tables {
        if let Some(n) = count_if(&c, t)? {
            counts.insert((*t).to_string(), json!(n));
        }
    }
    Ok(LegacyInspection {
        project,
        schema_version,
        counts: Value::Object(counts),
    })
}

/// 2.x 知识库备份里的条目与当前知识库的重叠（给预览用）：`(会插入的 slug, 已存在而会跳过的 slug)`。
/// 与合并的判断相同：id 或 slug 已在知识库里就跳过。源文件只读打开。
pub fn knowledge_overlap(store: &Store, path: &Path) -> Result<(Vec<String>, Vec<String>)> {
    inspect_legacy(path, Home::Knowledge)?;
    let c = open_immutable(path)?;
    let entries: Vec<(String, String)> = c
        .prepare("SELECT id, slug FROM knowledge_entries ORDER BY slug, id")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    drop(c);
    let present: BTreeSet<String> = store
        .read(|tx| {
            tx.prepare("SELECT id FROM knowledge_entries UNION SELECT 'slug:' || slug FROM knowledge_entries")?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()
        })
        .map_err(|e| PackageError::Write(format!("{e:?}")))?;
    let (mut new, mut existing) = (Vec::new(), Vec::new());
    for (id, slug) in entries {
        if present.contains(&id) || present.contains(&format!("slug:{slug}")) {
            existing.push(slug);
        } else {
            new.push(slug);
        }
    }
    Ok((new, existing))
}

/// 一份只有 2.x 迁移、没有别的内容的 registry（合成，给转换器当来源）；给了项目就登记这一个。
fn synthetic_registry(path: &Path, project: Option<&Connection>, at: &str) -> Result<()> {
    let c = Connection::open(path)?;
    crate::harden(&c)?;
    c.execute_batch(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL,
           content_sha256 TEXT NOT NULL, hash_origin TEXT NOT NULL CHECK(hash_origin IN ('APPLIED','LEGACY_BASELINE_UNVERIFIED')))",
    )?;
    for m in crate::legacy::MIGRATIONS
        .iter()
        .filter(|m| m.home == Home::Registry)
    {
        c.execute_batch(m.sql)?;
        c.execute(
            "INSERT INTO schema_migrations VALUES (?1, ?2, ?3, ?4, 'APPLIED')",
            params![m.version, m.name, at, m.sha256],
        )?;
    }
    c.execute(
        "INSERT INTO app_meta (singleton, current_sequence, data_version, created_at, updated_at) VALUES (1, 0, 1, ?1, ?1)",
        [at],
    )?;
    if let Some(p) = project {
        let row: (String, String, String, String, String, String, String) = p.query_row(
            "SELECT project_id, project_code, name, description, coordination_mode, created_at, updated_at FROM project_meta",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        )?;
        c.execute(
            "INSERT INTO projects (id, code, name, description, db_path, lifecycle, coordination_mode, version, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, NULL, 'ACTIVE', ?5, 0, ?6, ?7)",
            params![row.0, row.1, row.2, row.3, row.4, row.5, row.6],
        )?;
    }
    Ok(())
}

/// 把一个 2.x 的项目库或知识库转成 3.0 的库（在 `work` 里）。源先复制进 `work`：转换器不读真实数据根，
/// 源文件本身也不打开写。
fn convert_legacy(source: &Path, home: Home, work: &Path, at: &str) -> Result<PathBuf> {
    fs::create_dir_all(work)?;
    let copy = work.join("source.sqlite");
    fs::copy(source, &copy)?;
    let registry = work.join("registry.sqlite");
    {
        let src = open_immutable(&copy)?;
        synthetic_registry(&registry, (home == Home::Project).then_some(&src), at)?;
    }
    let target_dir = work.join("converted");
    fs::create_dir_all(&target_dir)?;
    let target = target_dir.join("atm.sqlite");
    let sources = LegacySources {
        registry,
        knowledge: (home == Home::Knowledge).then(|| copy.clone()),
        projects: if home == Home::Project {
            vec![copy.clone()]
        } else {
            Vec::new()
        },
        root: None,
    };
    crate::legacy::convert(
        &sources,
        &target,
        &ConvertOptions {
            at,
            allow_real_data_root: false,
            real_data_root: None,
            generation: None,
            secrets_check: None,
            accept_unconvertible: &[],
            origin_root: None,
            progress: None,
        },
    )?;
    Ok(target)
}

// ---------- 导入 ----------

#[derive(Clone, Debug)]
pub struct ImportOptions<'a> {
    /// `N\exports`：暂存在它下面的 `.staging`。
    pub exports_dir: &'a Path,
    pub at: &'a str,
    /// 导入后的项目代码；`None` 用包里的代码。服务层已按项目代码的规则校验过。
    pub code: Option<&'a str>,
    /// 写进 `project.imported` 事件的来源说明（文件名、备份 id）。
    pub source_label: &'a str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Imported {
    pub project_id: String,
    pub code: String,
    pub name: String,
    pub source_project_id: String,
    pub source_code: String,
    pub generation: i64,
    pub attachments: usize,
    pub sessions_closed: usize,
}

/// 导入要从哪里来。
#[derive(Clone, Copy, Debug)]
pub enum ImportSource<'a> {
    /// `.aytproj`（v1 或 v2）。
    Package(&'a Path),
    /// 2.x 的项目备份（单个项目库文件）。
    LegacyProject(&'a Path),
}

/// 项目代码的规则（04 L-012，2.x `domain/src/index.ts`）：大写字母开头，2–12 位大写字母、数字或连字符。
/// 服务的新建、导入时给的代码与这里的导入、导出共用这一条。
pub fn valid_project_code(code: &str) -> bool {
    let b = code.as_bytes();
    (2..=12).contains(&b.len())
        && b[0].is_ascii_uppercase()
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == b'-')
}

/// 导出文件名里的项目代码：只留一个路径组件里安全的字符（库里的代码都合规，这里只是不让任何值拼出别的路径）。
fn file_component(code: &str) -> String {
    let s: String = code
        .chars()
        .take(40)
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if s.trim_matches('_').is_empty() {
        "project".into()
    } else {
        s
    }
}

/// 一个空着的代码：原代码，或在末尾加数字（总长不超过 12，与新建项目的分配规则相同）。
pub fn suggest_code(base: &str, taken: &dyn Fn(&str) -> bool) -> String {
    if !taken(base) {
        return base.to_string();
    }
    for n in 2..10_000 {
        let s = n.to_string();
        let candidate = format!(
            "{}{s}",
            &base[..base.len().min(12usize.saturating_sub(s.len()))]
        );
        if !taken(&candidate) {
            return candidate;
        }
    }
    format!("IMP-{}", &base[..base.len().min(8)])
}

/// 项目代码现在空不空（给预览用）；被占用时给一个空着的建议代码。
pub fn code_status(store: &Store, code: &str) -> Result<Option<String>> {
    let codes: BTreeSet<String> = store
        .read(|tx| {
            tx.prepare("SELECT code FROM projects")?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()
        })
        .map_err(|e| PackageError::Write(format!("{e:?}")))?;
    Ok(codes
        .contains(code)
        .then(|| suggest_code(code, &|c| codes.contains(c))))
}

/// 导入一个项目包或 2.x 项目备份，成为新项目。
pub fn import_project(
    store: &Store,
    source: ImportSource<'_>,
    opts: &ImportOptions<'_>,
) -> Result<Imported> {
    let _lock = attachments_lock(store, "import_project")?;
    crate::restore::finish_swaps_locked(store)?;
    let staging = fresh_staging(opts.exports_dir)?;
    let result = import_in(store, source, opts, &staging);
    let _ = fs::remove_dir_all(&staging);
    result
}

fn import_in(
    store: &Store,
    source: ImportSource<'_>,
    opts: &ImportOptions<'_>,
    staging: &Path,
) -> Result<Imported> {
    let (db, artifacts, format, package_sha) = match source {
        ImportSource::Package(path) => {
            let s = scan(path, Some(staging))?;
            let (version, project) = verify_scanned(&s)?;
            let (sha, _) = hash_file(path)?;
            let db = if version == FORMAT_VERSION {
                staging.join(DB_ENTRY)
            } else {
                let converted = convert_legacy(
                    &staging.join(DB_ENTRY),
                    Home::Project,
                    &staging.join("legacy"),
                    opts.at,
                )?;
                let id = single_project(&converted)?;
                if id != project.id {
                    return Err(invalid(format!(
                        "manifest.json names project {}, project.sqlite holds {id}",
                        project.id
                    )));
                }
                converted
            };
            if version == FORMAT_VERSION && single_project(&db)? != project.id {
                return Err(invalid(
                    "manifest.json names another project than project.sqlite",
                ));
            }
            (
                db,
                staging.join("artifacts"),
                format!("aytproj-v{version}"),
                Some(sha),
            )
        }
        ImportSource::LegacyProject(path) => {
            if !path.is_file() {
                return Err(PackageError::NotFound(path.display().to_string()));
            }
            let converted = convert_legacy(path, Home::Project, &staging.join("legacy"), opts.at)?;
            single_project(&converted)?;
            let (sha, _) = hash_file(path)?;
            (
                converted,
                staging.join("artifacts"),
                "2.x-project-backup".to_string(),
                Some(sha),
            )
        }
    };
    {
        let c = side_reader(&db)?;
        let quick: String = c.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        if quick != "ok" {
            return Err(invalid(format!("project.sqlite: quick_check: {quick}")));
        }
    }
    let artifacts_root = crate::backup::artifacts_root(store.path());
    let uri = readonly_uri(&db)?;
    let ctx = ImportCtx {
        code: opts.code.map(str::to_owned),
        at: opts.at.to_string(),
        format,
        package_sha256: package_sha,
        source_label: opts.source_label.to_string(),
        artifacts_root: artifacts_root.clone(),
        staged_artifacts: artifacts,
    };
    let placed = std::sync::Arc::new(std::sync::Mutex::new(None::<PathBuf>));
    let placed_in = placed.clone();
    let outcome = store
        .submit_exclusive(IMPORT_BUDGET, move |conn| {
            conn.execute("ATTACH DATABASE ?1 AS pk", [uri])?;
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let out = import_tx(&tx, &ctx, &placed_in)?;
            tx.commit()?;
            Ok::<_, PackageError>(out)
        })
        .map_err(|e| PackageError::Write(format!("{e:?}")))?
        .wait();
    match outcome {
        Ok(out) => Ok(out),
        Err(e) => {
            // 事务没有提交：已经挪进附件根的目录挪走（新 id，没有别人用）。
            let dir = placed.lock().unwrap_or_else(|e| e.into_inner()).take();
            if let Some(dir) = dir {
                let _ = fs::remove_dir_all(dir);
            }
            Err(match e {
                crate::WriteError::Rejected(e) => e,
                other => PackageError::Write(format!("{other:?}")),
            })
        }
    }
}

/// 3.0 单项目库里唯一的项目 id。
fn single_project(db: &Path) -> Result<String> {
    let c = side_reader(db)?;
    let ids: Vec<String> = c
        .prepare("SELECT id FROM projects")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    match ids.as_slice() {
        [one] => Ok(one.clone()),
        _ => Err(invalid(format!(
            "project.sqlite holds {} projects",
            ids.len()
        ))),
    }
}

struct ImportCtx {
    code: Option<String>,
    at: String,
    format: String,
    package_sha256: Option<String>,
    source_label: String,
    artifacts_root: PathBuf,
    staged_artifacts: PathBuf,
}

fn columns(tx: &Transaction<'_>, table: &str) -> Result<Vec<String>> {
    let cols: Vec<String> = tx
        .prepare(&format!(
            "SELECT name FROM pragma_table_info('{table}', 'main') ORDER BY cid"
        ))?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(cols)
}

fn import_tx(
    tx: &Transaction<'_>,
    c: &ImportCtx,
    placed: &std::sync::Mutex<Option<PathBuf>>,
) -> Result<Imported> {
    let (src, src_code, name): (String, String, String) =
        tx.query_row("SELECT id, code, name FROM pk.projects", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?;
    let code = c.code.clone().unwrap_or_else(|| src_code.clone());
    // 包或 2.x 库带来的代码不可信：与给定的代码同一条规则，不合格就不导入（导出会拿它拼文件名）。
    if !valid_project_code(&code) {
        return Err(PackageError::BadCode { code });
    }
    let taken = |x: &str| -> bool {
        tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM main.projects WHERE code = ?1)",
            [x],
            |r| r.get(0),
        )
        .unwrap_or(true)
    };
    if taken(&code) {
        return Err(PackageError::CodeTaken {
            suggested: suggest_code(&code, &taken),
            code,
        });
    }
    let id = ulid(tx)?;
    let (generation, epoch) = allocate_generation(tx)?;
    tx.execute(
        "INSERT INTO main.scope_generations (gen, scope_kind, scope_id, reason, epoch, created_at)
         VALUES (?1, 'PROJECT', ?2, 'IMPORTED', ?3, ?4)",
        params![generation, id, epoch, c.at],
    )?;
    tx.execute(
        "INSERT INTO main.projects (id, code, name, description, lifecycle, coordination_mode, health, creation_reason,
                                    creation_signals_json, version, meta_version, project_seq, scope_gen, epoch,
                                    legacy_schema_version, legacy_json, created_at, updated_at)
         SELECT ?1, ?2, name, description, 'ACTIVE', coordination_mode, health, creation_reason,
                creation_signals_json, 0, meta_version, project_seq, ?3, ?4,
                legacy_schema_version, legacy_json, created_at, ?5
         FROM pk.projects WHERE id = ?6",
        params![id, code, generation, epoch, c.at, src],
    )?;
    for t in PACKAGED_TABLES.iter().filter(|t| **t != "search_docs") {
        let cols = columns(tx, t)?;
        let select: Vec<&str> = cols
            .iter()
            .map(|col| {
                if col == "project_id" {
                    "?1"
                } else {
                    col.as_str()
                }
            })
            .collect();
        tx.execute(
            &format!(
                "INSERT INTO main.{t} ({}) SELECT {} FROM pk.{t} WHERE project_id = ?2",
                cols.join(", "),
                select.join(", ")
            ),
            params![id, src],
        )?;
    }
    tx.execute(
        &format!(
            "INSERT INTO main.search_docs ({SEARCH_DOC_COLUMNS})
             SELECT ?1, entity_type, entity_id, entity_key, title, body, updated_at FROM pk.search_docs WHERE project_id = ?2"
        ),
        params![id, src],
    )?;
    // 项目自己的事件：聚合 id 是项目 id 的改成新 id。
    tx.execute(
        "UPDATE main.events SET aggregate_id = ?1 WHERE project_id = ?1 AND aggregate_type = 'PROJECT' AND aggregate_id = ?2",
        params![id, src],
    )?;
    // 附件行：包里的 `artifacts/<相对路径>` 换成这台电脑上的位置。
    let dir = c.artifacts_root.join(&id);
    let dir_text = path_str(&dir)?.to_string();
    tx.execute(
        "UPDATE main.artifacts SET local_path = ?2 || char(92) || replace(substr(local_path, 11), '/', char(92))
         WHERE project_id = ?1 AND local_path LIKE 'artifacts/%'",
        params![id, dir_text],
    )?;
    // 原项目里还在线的 session：副本里一律关闭，不留客户端身份（见模块说明）。
    let sessions_closed = tx.execute(
        "UPDATE main.agent_sessions SET connection_state = 'CLOSED', work_state = 'IDLE', current_work_item_id = NULL,
                closed_at = COALESCE(closed_at, ?2), close_reason = COALESCE(close_reason, 'FORCE_CLOSE'),
                retirement_reason = COALESCE(retirement_reason, 'imported copy'), client_identity = NULL,
                updated_at = ?2, version = version + 1
         WHERE project_id = ?1 AND connection_state <> 'CLOSED'",
        params![id, c.at],
    )?;
    tx.execute(
        "UPDATE main.agent_sessions SET client_identity = NULL WHERE project_id = ?1",
        [&id],
    )?;
    tx.execute(
        "UPDATE main.work_items SET last_session_closed_at = ?2
         WHERE project_id = ?1 AND claimed_by_session_id IS NOT NULL",
        params![id, c.at],
    )?;
    let payload = json!({
        "code": code,
        "sourceProjectId": src,
        "sourceCode": src_code,
        "format": c.format,
        "packageSha256": c.package_sha256,
        "source": c.source_label,
        "gen": generation,
    });
    crate::events::append_global(
        tx,
        "project.imported",
        &id,
        "USER",
        &payload.to_string(),
        None,
        &c.at,
    )?;
    // 附件换入：新 id 的目录不可能已经存在；挪进去之后事务失败由调用方挪走。
    let attachments = if c.staged_artifacts.exists() {
        let n = list_tree(&c.staged_artifacts)?.len();
        refuse_links(&[
            c.artifacts_root.parent().unwrap_or(&c.artifacts_root),
            &c.artifacts_root,
        ])?;
        fs::create_dir_all(&c.artifacts_root)?;
        atm_install_state::durable::rename(&c.staged_artifacts, &dir, false)?;
        *placed.lock().unwrap_or_else(|e| e.into_inner()) = Some(dir);
        n
    } else {
        0
    };
    Ok(Imported {
        project_id: id,
        code,
        name,
        source_project_id: src,
        source_code: src_code,
        generation,
        attachments,
        sessions_closed,
    })
}

// ---------- 2.x 知识库备份 ----------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KnowledgeMerged {
    pub inserted: Vec<String>,
    /// id 或 slug 已在知识库里的条目（slug）：不覆盖。
    pub skipped: Vec<String>,
}

/// 把 2.x 的知识库备份合并进知识库：新条目连同全部修订插入；已有的（同 id 或同 slug）跳过。
pub fn import_legacy_knowledge(
    store: &Store,
    source: &Path,
    opts: &ImportOptions<'_>,
) -> Result<KnowledgeMerged> {
    if !source.is_file() {
        return Err(PackageError::NotFound(source.display().to_string()));
    }
    let _lock = attachments_lock(store, "import_knowledge")?;
    let staging = fresh_staging(opts.exports_dir)?;
    let result = (|| {
        let converted = convert_legacy(source, Home::Knowledge, &staging.join("legacy"), opts.at)?;
        let (sha, _) = hash_file(source)?;
        let uri = readonly_uri(&converted)?;
        let at = opts.at.to_string();
        let label = opts.source_label.to_string();
        store
            .submit_exclusive(IMPORT_BUDGET, move |conn| {
                conn.execute("ATTACH DATABASE ?1 AS kb", [uri])?;
                let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let out = merge_knowledge_tx(&tx, &at, &sha, &label)?;
                tx.commit()?;
                Ok::<_, PackageError>(out)
            })
            .map_err(|e| PackageError::Write(format!("{e:?}")))?
            .wait()
            .map_err(|e| match e {
                crate::WriteError::Rejected(e) => e,
                other => PackageError::Write(format!("{other:?}")),
            })
    })();
    let _ = fs::remove_dir_all(&staging);
    result
}

fn merge_knowledge_tx(
    tx: &Transaction<'_>,
    at: &str,
    sha: &str,
    label: &str,
) -> Result<KnowledgeMerged> {
    let existing: Option<String> = tx
        .query_row("SELECT database_id FROM main.knowledge_meta", [], |r| {
            r.get(0)
        })
        .optional()?;
    // 新库还没有写过知识：与第一次写知识一样，在这个事务里建知识库的身份（新世代，reason CREATED）。
    let database_id = match existing {
        Some(id) => id,
        None => {
            let id = ulid(tx)?;
            let generation_id = ulid(tx)?;
            let (generation, epoch) = allocate_generation(tx)?;
            tx.execute(
                "INSERT INTO main.scope_generations (gen, scope_kind, scope_id, reason, epoch, created_at)
                 VALUES (?1, 'KNOWLEDGE', ?2, 'CREATED', ?3, ?4)",
                params![generation, id, epoch, at],
            )?;
            tx.execute(
                "INSERT INTO main.knowledge_meta (singleton, database_id, generation, sequence, scope_gen) VALUES (1, ?1, ?2, 0, ?3)",
                params![id, generation_id, generation],
            )?;
            id
        }
    };
    let entries: Vec<(String, String)> = tx
        .prepare("SELECT id, slug FROM kb.knowledge_entries ORDER BY slug, id")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut merged = KnowledgeMerged {
        inserted: Vec::new(),
        skipped: Vec::new(),
    };
    for (id, slug) in entries {
        let clash: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM main.knowledge_entries WHERE id = ?1 OR slug = ?2)
                 OR EXISTS (SELECT 1 FROM main.knowledge_revisions r JOIN kb.knowledge_revisions b
                            ON b.revision_id = r.revision_id WHERE b.entry_id = ?1)",
            params![id, slug],
            |r| r.get(0),
        )?;
        if clash {
            merged.skipped.push(slug);
            continue;
        }
        tx.execute(
            "INSERT INTO main.knowledge_revisions SELECT * FROM kb.knowledge_revisions WHERE entry_id = ?1",
            [&id],
        )?;
        tx.execute(
            "INSERT INTO main.knowledge_entries SELECT * FROM kb.knowledge_entries WHERE id = ?1",
            [&id],
        )?;
        crate::search::index_knowledge_entry(tx, &id)?;
        merged.inserted.push(slug);
    }
    if !merged.inserted.is_empty() {
        tx.execute("UPDATE main.knowledge_meta SET sequence = sequence + 1", [])?;
    }
    let payload = json!({
        "inserted": merged.inserted,
        "skipped": merged.skipped,
        "sourceSha256": sha,
        "source": label,
    });
    crate::events::append_global(
        tx,
        "knowledge.imported",
        &database_id,
        "USER",
        &payload.to_string(),
        None,
        at,
    )?;
    Ok(merged)
}

// ---------- 暂存 ----------

#[cfg(windows)]
fn is_link(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    meta.file_type().is_symlink() || meta.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_link(meta: &fs::Metadata) -> bool {
    meta.file_type().is_symlink()
}

/// 这些路径里已经存在的都必须是普通目录，不能是链接（junction、符号链接等 reparse point）：删除、解包、换入、
/// 复制之前先查，链接会把副作用带到数据根外面（peer W6 r1 P1-02）。不存在的跳过（之后由我们自己建）。
fn refuse_links(paths: &[&Path]) -> Result<()> {
    for p in paths {
        match fs::symlink_metadata(p) {
            Ok(m) if is_link(&m) => return Err(PackageError::LinkedPath(p.display().to_string())),
            Ok(m) if !m.is_dir() => {
                return Err(PackageError::Invalid(format!(
                    "{} is not a directory",
                    p.display()
                )));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

/// ATM 自己起的暂存目录名（ULID）：清理只认这些。
fn owned_staging_name(name: &str) -> bool {
    name.len() == 26
        && name
            .bytes()
            .all(|b| b"0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(&b))
}

/// `exports\.staging\<新目录>`：先清掉上一次中断留下的（调用方持有附件锁，同一时间只有一个导出或导入）。
/// 数据根、exports、.staging 都不能是链接；只删名字是 ULID 的暂存（ATM 自己起的），里面的链接只删链接本身。
fn fresh_staging(exports_dir: &Path) -> Result<PathBuf> {
    let root = exports_dir.join(STAGING_DIR);
    let data_root = exports_dir.parent().unwrap_or(exports_dir);
    refuse_links(&[data_root, exports_dir, &root])?;
    if root.exists() {
        for e in fs::read_dir(&root)? {
            let e = e?;
            if !e.file_name().to_str().is_some_and(owned_staging_name) {
                continue;
            }
            let p = e.path();
            let meta = fs::symlink_metadata(&p)?;
            let _ = if is_link(&meta) {
                // 链接本身（不跟进去）：目录型 junction 用 remove_dir，文件型符号链接用 remove_file。
                fs::remove_dir(&p).or_else(|_| fs::remove_file(&p))
            } else if meta.is_dir() {
                // std 的 remove_dir_all 遇到里面的链接只删链接，不跟进去。
                fs::remove_dir_all(&p)
            } else {
                fs::remove_file(&p)
            };
        }
    }
    let name = {
        let c = Connection::open_in_memory()?;
        ulid(&c)?
    };
    let dir = root.join(name);
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn sync(path: &Path) -> Result<()> {
    fs::OpenOptions::new().write(true).open(path)?.sync_all()?;
    Ok(())
}
