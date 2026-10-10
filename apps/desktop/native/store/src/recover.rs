//! 离线整库恢复（W6b；03 §2.5 R3–R4，05 §2.2 / §6 第 636 行，00 决定 11，A4）。
//!
//! 只由 `atm.exe recover --offline` 在**取得独占准入之后**调用（准入在调用方：宿主单实例互斥 + `N\runtime\service.lock`
//! + 没有安装事务）；HTTP、MCP、ui-bridge 都没有通到这里的入口（`cli/tests/recover.rs` 的静态守卫）。
//!
//! 一次恢复：
//! 1. 选中的整库备份逐项核对，不依赖库里的备份目录表（当前库可能已经坏了）：manifest 的格式、id、库文件的 sha256 与大小、
//!    附件摘要、`quick_check`、迁移集合与本程序一致、`app_meta.generation` 与发布清单 `M` 一致（不一致的话启动判定会把它
//!    整个隔离掉）。
//! 2. 写意图 `N\runtime\recover.json`。之后任何一步中断，再跑一次 recover 按意图续做；宿主看到意图就不启动。
//! 3. 把备份复制进 `N\recover-staging\data\`，复制后再核对一遍。
//! 4. 从当前库（读得了的话）取出手机同步与派单的账本（05 §6）：`sync_processed` 取并集、`sync_state.cursor` 保留当前的、
//!    `dispatch_requests` 取并集、`dispatch_meta` 取较新的水位；当前库读不了就把 `dispatch_meta.lost_before` 设为恢复时刻、
//!    同步游标置空（走游标救援）。
//! 5. 在暂存的库上收尾：换新 `instance_epoch`（所有游标失效）、合并账本、把选中的备份登记并固定（A4）。
//! 6. 当前的 `N\data\`（库、`-wal`、`-shm`、附件，整代）移进 `N\quarantine\<generation>-<时刻>-recover\data\`，
//!    暂存的 `data\` 换进来。两步都按「目标已在就跳过」写，续做是幂等的。
//! 7. 写下标记 `N\runtime\recovered.json`，删意图与暂存目录。服务下次启动时看到标记（[`settle`]）：给每个项目和知识库
//!    推进 scope generation，追加一条 `database.recovered` 全局事件，然后删标记。
//!
//! 整库恢复不为恢复点之后的写入生成墓碑（00 决定 11，已接受的灾备取舍）。

use crate::Store;
use crate::backup::{
    BackupError, FileEntry, MANIFEST_FORMAT, attachments_digest, copy_tree, hash_file, list_tree,
    side_reader,
};
use crate::conversion::{Layout, ManifestState, read_manifest};
use crate::events::{EventError, append_global, ulid};
use crate::restore::allocate_generation;
use atm_install_state::is_path_name;
use rusqlite::{Connection, OptionalExtension, params};
use std::fs;
use std::path::{Path, PathBuf};

/// `N\runtime\recover.json`：恢复做到一半。
pub const INTENT: &str = "recover.json";
/// `N\runtime\recovered.json`：恢复做完、服务还没收尾。
pub const MARKER: &str = "recovered.json";
const STAGING: &str = "recover-staging";
const DB_FILE: &str = "atm.sqlite";
const MANIFEST_FILE: &str = "manifest.json";
const ARTIFACTS_DIR: &str = "artifacts";

#[derive(Debug)]
pub enum RecoverError {
    /// 发布清单不是 PUBLISHED：没有可恢复的「当前一代」。
    NotPublished(String),
    NoSuchBackup(String),
    /// 备份核对不过。
    Unusable {
        id: String,
        why: String,
    },
    /// 测试注入点要求中断（[`recover_with`]）：意图留着，再跑一次续做。
    Interrupted(Step),
    Io(std::io::Error),
    Sqlite(rusqlite::Error),
}

impl std::fmt::Display for RecoverError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RecoverError::NotPublished(why) => write!(f, "nothing to recover into: {why}"),
            RecoverError::NoSuchBackup(id) => write!(f, "no backup {id}"),
            RecoverError::Unusable { id, why } => write!(f, "backup {id} cannot be used: {why}"),
            RecoverError::Io(e) => write!(f, "io: {e}"),
            RecoverError::Sqlite(e) => write!(f, "sqlite: {e}"),
            RecoverError::Interrupted(step) => write!(f, "interrupted after {step:?}"),
        }
    }
}

impl From<std::io::Error> for RecoverError {
    fn from(e: std::io::Error) -> Self {
        RecoverError::Io(e)
    }
}

impl From<rusqlite::Error> for RecoverError {
    fn from(e: rusqlite::Error) -> Self {
        RecoverError::Sqlite(e)
    }
}

impl From<EventError> for RecoverError {
    fn from(e: EventError) -> Self {
        match e {
            EventError::Sqlite(e) => RecoverError::Sqlite(e),
            other => RecoverError::Io(std::io::Error::other(format!("{other:?}"))),
        }
    }
}

impl From<BackupError> for RecoverError {
    fn from(e: BackupError) -> Self {
        match e {
            BackupError::Io(e) => RecoverError::Io(e),
            BackupError::Sqlite(e) => RecoverError::Sqlite(e),
            other => RecoverError::Io(std::io::Error::other(other.to_string())),
        }
    }
}

pub type Result<T> = std::result::Result<T, RecoverError>;

/// 一份候选备份。`problem` 为 `None` 才能用。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub id: String,
    pub kind: String,
    pub created_at: String,
    pub problem: Option<String>,
}

/// 核对通过的备份。
#[derive(Clone, Debug)]
struct Checked {
    id: String,
    kind: String,
    dir: PathBuf,
    created_at: String,
    sha256: String,
    size: u64,
    attachments_sha256: String,
    schema_version: i64,
    generation: String,
}

fn published_generation(layout: &Layout) -> Result<String> {
    match read_manifest(layout) {
        ManifestState::Present(m) if m.phase.as_str() == "PUBLISHED" => Ok(m.generation),
        ManifestState::Present(m) => Err(RecoverError::NotPublished(format!(
            "generation {} is {}",
            m.generation,
            m.phase.as_str()
        ))),
        ManifestState::Missing => Err(RecoverError::NotPublished("the manifest is missing".into())),
        ManifestState::Corrupt => Err(RecoverError::NotPublished("the manifest is corrupt".into())),
    }
}

fn backups_dir(layout: &Layout) -> PathBuf {
    layout.root.join("backups")
}

/// `N\backups\` 下的整库备份，最新的在前；每份都核对过，`problem` 说明不能用的原因。
pub fn candidates(layout: &Layout) -> Result<Vec<Candidate>> {
    let generation = published_generation(layout)?;
    let mut out = Vec::new();
    let entries = match fs::read_dir(backups_dir(layout)) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e.into()),
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || !entry.file_type()?.is_dir() {
            continue;
        }
        match check(&entry.path(), &name, &generation) {
            Ok(c) => out.push(Candidate {
                id: c.id,
                kind: c.kind,
                created_at: c.created_at,
                problem: None,
            }),
            Err(why) => {
                let (kind, created_at) = manifest_head(&entry.path()).unwrap_or_default();
                out.push(Candidate {
                    id: name,
                    kind,
                    created_at,
                    problem: Some(why),
                })
            }
        }
    }
    out.sort_by(|a, b| (&b.created_at, &b.id).cmp(&(&a.created_at, &a.id)));
    Ok(out)
}

/// manifest 里的 (kind, createdAt)，列表展示用；读不出就是 None。
fn manifest_head(dir: &Path) -> Option<(String, String)> {
    let text = fs::read_to_string(dir.join(MANIFEST_FILE)).ok()?;
    let mem = Connection::open_in_memory().ok()?;
    mem.query_row(
        "SELECT coalesce(?1 ->> '$.kind', ''), coalesce(?1 ->> '$.createdAt', '')",
        [&text],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .ok()
}

/// 逐项核对一份备份（不读当前库的备份目录表）。返回不能用的原因。
fn check(dir: &Path, id: &str, generation: &str) -> std::result::Result<Checked, String> {
    if !is_path_name(id) {
        return Err("not a plain backup id".into());
    }
    let text = fs::read_to_string(dir.join(MANIFEST_FILE))
        .map_err(|e| format!("the manifest cannot be read: {e}"))?;
    let mem = Connection::open_in_memory().map_err(|e| e.to_string())?;
    #[allow(clippy::type_complexity)]
    let head: (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
        Option<String>,
    ) = mem
        .query_row(
            "SELECT ?1 ->> '$.format', ?1 ->> '$.backupId', ?1 ->> '$.kind', ?1 ->> '$.createdAt',
                    ?1 ->> '$.db.sha256', ?1 ->> '$.db.sizeBytes', ?1 ->> '$.db.file', ?1 ->> '$.attachments.sha256'",
            [&text],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                ))
            },
        )
        .map_err(|_| "the manifest is not JSON".to_string())?;
    let (format, backup_id, kind, created_at, sha, size, file, attachments) = head;
    if format.as_deref() != Some(MANIFEST_FORMAT) || backup_id.as_deref() != Some(id) {
        return Err("the manifest does not describe this backup".into());
    }
    if file.as_deref() != Some(DB_FILE) {
        return Err("the manifest names another database file".into());
    }
    let (Some(kind), Some(created_at), Some(sha), Some(size), Some(attachments)) =
        (kind, created_at, sha, size, attachments)
    else {
        return Err("the manifest is incomplete".into());
    };
    let db = dir.join(DB_FILE);
    let (actual_sha, actual_size) =
        hash_file(&db).map_err(|e| format!("the database file cannot be read: {e}"))?;
    if actual_sha != sha || actual_size as i64 != size {
        return Err("the database file differs from the manifest".into());
    }
    let files = list_tree(&dir.join(ARTIFACTS_DIR)).map_err(|e| e.to_string())?;
    if attachments_digest(&files) != attachments {
        return Err("the attachments differ from the manifest".into());
    }
    let side = side_reader(&db).map_err(|e| e.to_string())?;
    let check: String = side
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if check != "ok" {
        return Err(format!("quick_check: {check}"));
    }
    let migrations: Vec<(i64, String)> = side
        .prepare("SELECT version, sha256 FROM schema_migrations ORDER BY version")
        .and_then(|mut st| {
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()
        })
        .map_err(|e| e.to_string())?;
    let expected: Vec<(i64, String)> = crate::MIGRATIONS
        .iter()
        .map(|m| (m.version, m.sha256()))
        .collect();
    if migrations != expected {
        return Err("the backup was made by another schema".into());
    }
    let backup_generation: String = side
        .query_row("SELECT generation FROM app_meta", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if backup_generation != generation {
        return Err(format!(
            "the backup belongs to generation {backup_generation}, the publication is {generation}"
        ));
    }
    let schema_version = expected.last().map_or(0, |m| m.0);
    Ok(Checked {
        id: id.to_owned(),
        kind,
        dir: dir.to_path_buf(),
        created_at,
        sha256: sha,
        size: actual_size,
        attachments_sha256: attachments,
        schema_version,
        generation: backup_generation,
    })
}

/// 恢复的结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Recovered {
    pub backup_id: String,
    /// 原来的 `N\data\` 现在的位置。
    pub quarantine: PathBuf,
    /// 当前库读不了，手机同步与派单的账本没能保留（05 §6）。
    pub ledgers_lost: bool,
}

/// 恢复做到一半（意图文件在）。宿主看到它就不启动，等再跑一次 recover。
pub fn interrupted(layout: &Layout) -> Option<String> {
    let text = fs::read_to_string(layout.runtime().join(INTENT)).ok()?;
    let mem = Connection::open_in_memory().ok()?;
    mem.query_row("SELECT coalesce(?1 ->> '$.backupId', '')", [&text], |r| {
        r.get(0)
    })
    .ok()
    .or(Some(String::new()))
}

struct Intent {
    backup_id: String,
    at: String,
    quarantine: String,
    ledgers_lost: bool,
}

fn write_intent(layout: &Layout, i: &Intent) -> Result<()> {
    let mem = Connection::open_in_memory()?;
    let text: String = mem.query_row(
        "SELECT json_object('backupId', ?1, 'at', ?2, 'quarantine', ?3, 'ledgersLost', json(?4))",
        params![
            i.backup_id,
            i.at,
            i.quarantine,
            if i.ledgers_lost { "true" } else { "false" }
        ],
        |r| r.get(0),
    )?;
    fs::create_dir_all(layout.runtime())?;
    atm_install_state::durable::write_atomic(&layout.runtime().join(INTENT), text.as_bytes())?;
    Ok(())
}

fn read_intent(layout: &Layout) -> Result<Option<Intent>> {
    let text = match fs::read_to_string(layout.runtime().join(INTENT)) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let mem = Connection::open_in_memory()?;
    let row: Option<(String, String, String, bool)> = mem
        .query_row(
            "SELECT ?1 ->> '$.backupId', ?1 ->> '$.at', ?1 ->> '$.quarantine', coalesce(?1 ->> '$.ledgersLost', 0)",
            [&text],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .ok()
        .flatten();
    match row {
        Some((backup_id, at, quarantine, ledgers_lost)) if is_path_name(&quarantine) => {
            Ok(Some(Intent {
                backup_id,
                at,
                quarantine,
                ledgers_lost,
            }))
        }
        _ => Err(RecoverError::Io(std::io::Error::other(
            "the recovery intent is corrupt",
        ))),
    }
}

/// 上次没做完的恢复用的是哪份备份（续做时必须是同一份）。
pub fn pending_backup(layout: &Layout) -> Result<Option<String>> {
    Ok(read_intent(layout)?.map(|i| i.backup_id))
}

fn stamp(at: &str) -> String {
    at.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// 恢复的时刻与选中备份的固定期限（A4）。
#[derive(Clone, Copy, Debug)]
pub struct RecoverOptions<'a> {
    pub at: &'a str,
    pub pin_until: &'a str,
}

/// 恢复的注入点（测试模拟中途被杀）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    /// 暂存库已收尾，当前的 `data\` 还没动。
    Staged,
    /// 当前的 `data\` 已移进隔离区，暂存的还没换进来。
    Quarantined,
}

/// 把 `N` 恢复到备份 `backup_id`。调用方已经取得独占准入。有没做完的恢复时，`backup_id` 必须是同一份，按意图续做。
pub fn recover(layout: &Layout, backup_id: &str, o: RecoverOptions<'_>) -> Result<Recovered> {
    recover_with(layout, backup_id, o, &mut |_| true)
}

/// [`recover`] 带注入点：`go` 返回 `false` 时就地中断。
pub fn recover_with(
    layout: &Layout,
    backup_id: &str,
    o: RecoverOptions<'_>,
    go: &mut dyn FnMut(Step) -> bool,
) -> Result<Recovered> {
    let at = o.at;
    let generation = published_generation(layout)?;
    let dir = backups_dir(layout).join(backup_id);
    if !is_path_name(backup_id) || !dir.is_dir() {
        return Err(RecoverError::NoSuchBackup(backup_id.to_owned()));
    }
    let intent = match read_intent(layout)? {
        Some(i) if i.backup_id != backup_id => {
            return Err(RecoverError::Unusable {
                id: backup_id.to_owned(),
                why: format!(
                    "an unfinished recovery to {} must be completed first",
                    i.backup_id
                ),
            });
        }
        Some(i) => i,
        None => Intent {
            backup_id: backup_id.to_owned(),
            at: at.to_owned(),
            quarantine: format!("{generation}-{}-recover", stamp(at)),
            ledgers_lost: false,
        },
    };
    let quarantine = layout.root.join("quarantine").join(&intent.quarantine);
    let data = layout.data();
    let staging = layout.root.join(STAGING);

    // 已经换过（续做）：不再核对与暂存，直接收尾。
    let swapped = quarantine.join("data").exists();
    let mut intent = intent;
    if !swapped {
        let checked =
            check(&dir, backup_id, &generation).map_err(|why| RecoverError::Unusable {
                id: backup_id.to_owned(),
                why,
            })?;
        write_intent(layout, &intent)?;
        stage(&checked, &staging)?;
        let ledgers = harvest(&layout.database());
        intent.ledgers_lost = ledgers.is_none();
        write_intent(layout, &intent)?;
        finish_staged(
            &staging.join("data").join(DB_FILE),
            &checked,
            ledgers.as_ref(),
            &intent.at,
            o.pin_until,
        )?;
        if !go(Step::Staged) {
            return Err(RecoverError::Interrupted(Step::Staged));
        }
        fs::create_dir_all(&quarantine)?;
        if data.exists() {
            fs::rename(&data, quarantine.join("data"))?;
        }
        if !go(Step::Quarantined) {
            return Err(RecoverError::Interrupted(Step::Quarantined));
        }
    }
    if !data.exists() {
        fs::rename(staging.join("data"), &data)?;
    }
    let _ = fs::remove_dir_all(&staging);
    write_marker(layout, &intent)?;
    fs::remove_file(layout.runtime().join(INTENT))?;
    Ok(Recovered {
        backup_id: intent.backup_id,
        quarantine,
        ledgers_lost: intent.ledgers_lost,
    })
}

/// 备份复制进暂存目录，复制完再核对一遍。
fn stage(c: &Checked, staging: &Path) -> Result<()> {
    if staging.exists() {
        fs::remove_dir_all(staging)?;
    }
    let data = staging.join("data");
    fs::create_dir_all(&data)?;
    let db = data.join(DB_FILE);
    fs::copy(c.dir.join(DB_FILE), &db)?;
    let (sha, size) = hash_file(&db)?;
    let files: Vec<FileEntry> = copy_tree(&c.dir.join(ARTIFACTS_DIR), &data.join(ARTIFACTS_DIR))?;
    if sha != c.sha256 || size != c.size || attachments_digest(&files) != c.attachments_sha256 {
        return Err(RecoverError::Unusable {
            id: c.id.clone(),
            why: "the staged copy differs from the backup".into(),
        });
    }
    Ok(())
}

/// `dispatch_requests` 的一行：(id, at, run_snapshot_json, rejected_code, rejected_message)。
type RequestRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// 当前库里的手机同步与派单账本（05 §6）。读不了就是 None。
struct Ledgers {
    processed: Vec<(i64, String)>,
    cursor: Option<String>,
    requests: Vec<RequestRow>,
    requests_since: Option<String>,
    lost_before: Option<String>,
}

fn harvest(db: &Path) -> Option<Ledgers> {
    if !db.is_file() {
        return None;
    }
    let c = side_reader(db).ok()?;
    let check: String = c.query_row("PRAGMA quick_check", [], |r| r.get(0)).ok()?;
    if check != "ok" {
        return None;
    }
    let processed = c
        .prepare("SELECT ord, command_id FROM sync_processed ORDER BY ord")
        .and_then(|mut st| {
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .ok()?;
    let cursor = c
        .query_row("SELECT cursor FROM sync_state", [], |r| r.get(0))
        .optional()
        .ok()?
        .flatten();
    let requests = c
        .prepare(
            "SELECT id, at, run_snapshot_json, rejected_code, rejected_message FROM dispatch_requests",
        )
        .and_then(|mut st| {
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .ok()?;
    let meta: Option<(Option<String>, Option<String>)> = c
        .query_row(
            "SELECT requests_since, lost_before FROM dispatch_meta",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .ok()?;
    let (requests_since, lost_before) = meta.unwrap_or_default();
    Some(Ledgers {
        processed,
        cursor,
        requests,
        requests_since,
        lost_before,
    })
}

fn later(a: Option<String>, b: Option<String>) -> Option<String> {
    match (a, b) {
        (Some(a), Some(b)) => Some(if a >= b { a } else { b }),
        (a, b) => a.or(b),
    }
}

/// 暂存库的收尾：新 instance_epoch、账本、登记并固定选中的备份。
fn finish_staged(
    db: &Path,
    c: &Checked,
    ledgers: Option<&Ledgers>,
    at: &str,
    pin_until: &str,
) -> Result<()> {
    let mut conn = Connection::open(db)?;
    let tx = conn.transaction()?;
    let epoch = ulid(&tx)?;
    tx.execute(
        "UPDATE app_meta SET instance_epoch = ?1, updated_at = ?2",
        params![epoch, at],
    )?;
    match ledgers {
        Some(l) => {
            // 已处理的手机命令取并集：恢复点之后处理过的命令不能再执行一次。
            let mut next: i64 = tx.query_row(
                "SELECT coalesce(max(ord), 0) FROM sync_processed",
                [],
                |r| r.get(0),
            )?;
            for (_, command) in &l.processed {
                let present: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM sync_processed WHERE command_id = ?1)",
                    [command],
                    |r| r.get(0),
                )?;
                if !present {
                    next += 1;
                    tx.execute(
                        "INSERT INTO sync_processed (ord, command_id) VALUES (?1, ?2)",
                        params![next, command],
                    )?;
                }
            }
            if l.cursor.is_some() {
                tx.execute("UPDATE sync_state SET cursor = ?1", [&l.cursor])?;
            }
            for (id, req_at, snapshot, code, message) in &l.requests {
                tx.execute(
                    "INSERT OR IGNORE INTO dispatch_requests (id, at, run_snapshot_json, rejected_code, rejected_message)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![id, req_at, snapshot, code, message],
                )?;
            }
            let current: Option<(Option<String>, Option<String>)> = tx
                .query_row(
                    "SELECT requests_since, lost_before FROM dispatch_meta",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            if let Some((since, lost)) = current {
                tx.execute(
                    "UPDATE dispatch_meta SET requests_since = ?1, lost_before = ?2",
                    params![
                        later(since, l.requests_since.clone()),
                        later(lost, l.lost_before.clone())
                    ],
                )?;
            }
        }
        None => {
            // 当前库读不了：恢复点之后的派单请求与手机命令都无从得知。
            tx.execute("UPDATE dispatch_meta SET lost_before = ?1", [at])?;
            tx.execute("UPDATE sync_state SET cursor = NULL", [])?;
        }
    }
    // A4：选中的备份登记进恢复后的目录并固定，保留策略不会删它（备份自己的库里没有自己这一行）。
    tx.execute(
        "INSERT INTO backups (id, kind, path, sha256, size_bytes, schema_version, generation,
                              attachments_manifest_sha256, created_at, verified_at, pinned_until)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET verified_at = excluded.verified_at, pinned_until = excluded.pinned_until",
        params![
            c.id,
            c.kind,
            c.dir.to_string_lossy(),
            c.sha256,
            c.size as i64,
            c.schema_version,
            c.generation,
            c.attachments_sha256,
            c.created_at,
            at,
            pin_until
        ],
    )?;
    tx.commit()?;
    drop(conn);
    for suffix in ["-wal", "-shm", "-journal"] {
        let _ = fs::remove_file(db.with_file_name(format!("{DB_FILE}{suffix}")));
    }
    Ok(())
}

fn write_marker(layout: &Layout, i: &Intent) -> Result<()> {
    let mem = Connection::open_in_memory()?;
    let text: String = mem.query_row(
        "SELECT json_object('backupId', ?1, 'at', ?2, 'quarantine', ?3, 'ledgersLost', json(?4))",
        params![
            i.backup_id,
            i.at,
            i.quarantine,
            if i.ledgers_lost { "true" } else { "false" }
        ],
        |r| r.get(0),
    )?;
    atm_install_state::durable::write_atomic(&layout.runtime().join(MARKER), text.as_bytes())?;
    Ok(())
}

/// 服务启动时的收尾（R4）：有 `recovered.json` 就给每个项目与知识库推进 scope generation，追加 `database.recovered`
/// 全局事件，然后删标记。同一次恢复只做一次（全局事件按恢复时刻去重）。返回恢复用的备份 id。
pub fn settle(store: &Store, layout: &Layout, at: &str) -> Result<Option<String>> {
    let path = layout.runtime().join(MARKER);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let at = at.to_owned();
    let backup_id = store
        .write(move |tx| -> Result<String> {
            let (backup_id, recovered_at, ledgers_lost): (String, String, bool) = tx.query_row(
                "SELECT coalesce(?1 ->> '$.backupId', ''), coalesce(?1 ->> '$.at', ''),
                        coalesce(?1 ->> '$.ledgersLost', 0)",
                [&text],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?;
            let dedupe = format!("database-recovered:{recovered_at}");
            let done: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM global_feed WHERE dedupe_key = ?1)",
                [&dedupe],
                |r| r.get(0),
            )?;
            if done {
                return Ok(backup_id);
            }
            let projects: Vec<String> = tx
                .prepare("SELECT id FROM projects ORDER BY id")?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            for project in &projects {
                let (generation, epoch) = allocate_generation(tx)?;
                tx.execute(
                    "UPDATE projects SET scope_gen = ?2, epoch = ?3 WHERE id = ?1",
                    params![project, generation, epoch],
                )?;
                tx.execute(
                    "INSERT INTO scope_generations (gen, scope_kind, scope_id, reason, backup_id, epoch, created_at)
                     VALUES (?1, 'PROJECT', ?2, 'RESTORED', ?3, ?4, ?5)",
                    params![generation, project, backup_id, epoch, at],
                )?;
            }
            let knowledge: Option<String> = tx
                .query_row("SELECT database_id FROM knowledge_meta", [], |r| r.get(0))
                .optional()?;
            if let Some(database_id) = knowledge {
                let (generation, epoch) = allocate_generation(tx)?;
                let new_generation = ulid(tx)?;
                tx.execute(
                    "UPDATE knowledge_meta SET scope_gen = ?1, generation = ?2",
                    params![generation, new_generation],
                )?;
                tx.execute(
                    "INSERT INTO scope_generations (gen, scope_kind, scope_id, reason, backup_id, epoch, created_at)
                     VALUES (?1, 'KNOWLEDGE', ?2, 'RESTORED', ?3, ?4, ?5)",
                    params![generation, database_id, backup_id, epoch, at],
                )?;
            }
            let payload: String = tx.query_row(
                "SELECT json_object('backupId', ?1, 'recoveredAt', ?2, 'ledgersLost', json(?3), 'projects', ?4)",
                params![backup_id, recovered_at, if ledgers_lost { "true" } else { "false" }, projects.len() as i64],
                |r| r.get(0),
            )?;
            append_global(tx, "database.recovered", &backup_id, "SYSTEM", &payload, Some(&dedupe), &at)?;
            Ok(backup_id)
        })
        .map_err(|e| match e {
            crate::WriteError::Rejected(e) => e,
            crate::WriteError::Sqlite(e) => RecoverError::Sqlite(e),
            other => RecoverError::Io(std::io::Error::other(format!("{other:?}"))),
        })?;
    fs::remove_file(&path)?;
    Ok(Some(backup_id))
}
