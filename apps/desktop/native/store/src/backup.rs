//! 整库备份与校验（W1e，05 §2.7 第 1 步、A4）。
//!
//! 一个备份是一个目录 `<备份根>/<备份 id>/`：
//! - `atm.sqlite`：`VACUUM INTO` 得到的一致快照，在旁路只读连接上做，不占写线程；
//! - `artifacts/**`：附件文件的副本（数据根下 `artifacts/` 的全部内容）；
//! - `manifest.json`：库的 sha256 与大小、迁移清单、app_meta 身份、各项目与知识库的序号和世代、
//!   附件清单及其摘要（A4：manifest 绑定附件及其哈希）。
//!
//! 每个文件先写 `.tmp`、落盘后再改名；manifest 最后写，有 manifest 的目录才是完整的备份。
//! 登记写进 `backups` 表。校验（[`verify_backup`]）逐项核对文件、manifest、目录、完整性、schema 与时间线。

use crate::Store;
use crate::events::ulid;
use atm_install_state::durable;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, TryLockError};

pub const MANIFEST_FORMAT: &str = "atm3-backup-1";
pub(crate) const DB_FILE: &str = "atm.sqlite";
const MANIFEST_FILE: &str = "manifest.json";
const ARTIFACTS_DIR: &str = "artifacts";

#[derive(Debug)]
pub enum BackupError {
    Sqlite(rusqlite::Error),
    Io(std::io::Error),
    /// 写线程 / 读连接池拒绝或执行失败。`failure` 区分准入与执行，服务层据它给错误码，不解析说明文字。
    Write {
        failure: StoreFailure,
        message: String,
    },
    NotFound(String),
    /// 文件、manifest、目录三者对不上，或完整性检查失败。
    Corrupt(String),
    /// 备份的迁移清单与当前库不同。
    SchemaMismatch,
    /// 备份与当前库不在同一条时间线上（data_root_id / instance_epoch 不同，或回执对不上）。
    TimelineMismatch(String),
    /// 备份里没有要恢复的范围。
    ScopeMissing(String),
    /// 附件目录里有符号链接 / 重解析点。
    Unsupported(String),
    /// 数据根往下的这一层是链接（junction、符号链接）：在任何副作用之前拒绝（peer W6 r2 P1-01）。
    LinkedPath(String),
    /// 一次按范围恢复已经提交（这个项目的库已是 `generation` 代），附件还没换入。
    /// [`crate::restore::finish_attachment_swaps`] 成功之前，整库备份、再次恢复、读这个项目的附件都会拒绝，
    /// 免得把恢复后的库和恢复前的附件拼成一份（W1 peer r1 P1-05）。
    AttachmentsPending {
        project: String,
        generation: i64,
        cause: String,
    },
    /// 在写线程的作业里调用了要拿附件锁的操作（备份、恢复、附件访问）。
    /// 恢复持着附件锁时要等写线程执行它的作业，写线程再等附件锁就互相等死，所以直接拒绝。
    Reentrant(&'static str),
}

impl std::fmt::Display for BackupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BackupError::Sqlite(e) => write!(f, "sqlite: {e}"),
            BackupError::Io(e) => write!(f, "io: {e}"),
            BackupError::Write { message, .. } => write!(f, "store: {message}"),
            BackupError::NotFound(m) => write!(f, "backup not found: {m}"),
            BackupError::Corrupt(m) => write!(f, "backup corrupt: {m}"),
            BackupError::SchemaMismatch => {
                write!(f, "backup schema differs from the current database")
            }
            BackupError::TimelineMismatch(m) => write!(f, "backup is from another timeline: {m}"),
            BackupError::ScopeMissing(m) => write!(f, "scope not in backup: {m}"),
            BackupError::Unsupported(m) => write!(f, "unsupported file: {m}"),
            BackupError::LinkedPath(p) => write!(f, "{p} is a link (junction or symbolic link)"),
            BackupError::AttachmentsPending {
                project,
                generation,
                cause,
            } => write!(
                f,
                "project {project} was restored to generation {generation} but its attachments are not swapped in yet: {cause}"
            ),
            BackupError::Reentrant(what) => {
                write!(
                    f,
                    "{what} cannot run inside a write job on the writer thread"
                )
            }
        }
    }
}

impl std::error::Error for BackupError {}

impl From<crate::chain::ChainError> for BackupError {
    fn from(e: crate::chain::ChainError) -> Self {
        match e {
            crate::chain::ChainError::Linked(p) => BackupError::LinkedPath(p.display().to_string()),
            crate::chain::ChainError::NotADirectory(p) => {
                BackupError::Unsupported(format!("{} is not a directory", p.display()))
            }
            crate::chain::ChainError::Io(e) => BackupError::Io(e),
        }
    }
}

impl From<rusqlite::Error> for BackupError {
    fn from(e: rusqlite::Error) -> Self {
        BackupError::Sqlite(e)
    }
}

impl From<std::io::Error> for BackupError {
    fn from(e: std::io::Error) -> Self {
        BackupError::Io(e)
    }
}

/// 存储执行失败的类别（W2 peer r2 P2-01）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StoreFailure {
    /// 写准入超时：作业没有入队，以后也不会执行。
    WriteBusy,
    /// 读连接全部占用：这一次读没有执行。
    ReadBusy,
    /// 存储已关闭，作业没有入队。
    Closed,
    /// 作业执行了、失败并回滚（超预算、panic、SQLite 错误、作业自己的错误）。
    Failed,
}

impl<E: std::fmt::Debug> From<crate::WriteError<E>> for BackupError {
    fn from(e: crate::WriteError<E>) -> Self {
        let failure = match e {
            crate::WriteError::Busy => StoreFailure::WriteBusy,
            crate::WriteError::Closed => StoreFailure::Closed,
            _ => StoreFailure::Failed,
        };
        BackupError::Write {
            failure,
            message: format!("write: {e:?}"),
        }
    }
}

impl<E: std::fmt::Debug> From<crate::ReadError<E>> for BackupError {
    fn from(e: crate::ReadError<E>) -> Self {
        let failure = match e {
            crate::ReadError::Busy => StoreFailure::ReadBusy,
            _ => StoreFailure::Failed,
        };
        BackupError::Write {
            failure,
            message: format!("read: {e:?}"),
        }
    }
}

pub type Result<T> = std::result::Result<T, BackupError>;

/// 数据根下的附件目录：与库文件同级的 `artifacts/`（05 §3.3：`N\data\artifacts\<project_id>\**`）。
pub fn artifacts_root(db_path: &Path) -> PathBuf {
    db_path
        .parent()
        .map(|p| p.join(ARTIFACTS_DIR))
        .unwrap_or_else(|| PathBuf::from(ARTIFACTS_DIR))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileEntry {
    /// 相对路径，`/` 分隔。
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Clone, Debug)]
pub struct BackupInfo {
    pub id: String,
    pub kind: String,
    pub dir: PathBuf,
    pub sha256: String,
    pub size_bytes: u64,
    pub attachments_sha256: String,
    pub created_at: String,
}

/// 只读的旁路连接：备份与校验用，不进读连接池，也不受读事务时长上限约束。
pub fn side_reader(path: &Path) -> Result<Connection> {
    let c = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_URI,
    )?;
    c.busy_timeout(std::time::Duration::from_secs(5))?;
    crate::harden(&c).map_err(|e| match e {
        crate::StoreError::Sqlite(e) => BackupError::Sqlite(e),
        other => BackupError::Corrupt(other.to_string()),
    })?;
    Ok(c)
}

/// 附件目录的协调锁：整库备份、按范围恢复、附件收尾与附件访问共用（W1 peer r1 P1-05）。
///
/// 锁顺序：附件锁在外，Store 的写线程与读池在内。持锁的一方可以等写线程、借读连接；
/// 反过来不行：写线程的作业里不能拿附件锁（直接拒绝，[`BackupError::Reentrant`]），
/// 读事务的闭包里也不要拿（恢复持锁时要借读连接，借不到会在 `read_wait` 后失败）。
static ATTACHMENTS_LOCK: Mutex<()> = Mutex::new(());

/// 正在等附件锁的操作：（库路径，操作名）。拿不到锁时登记，拿到后注销。
/// 供测试确认一个操作确实停在锁上，而不是还没走到那里（W1 peer r3 P2-07）。
static WAITING: Mutex<Vec<(PathBuf, &'static str)>> = Mutex::new(Vec::new());

/// 附件锁，外加从库所在目录往下钉住的附件根、恢复暂存与换下来的旧版本目录（peer W6 r2 P1-01）：拿到它之后、
/// 任何副作用（包括上一次恢复的收尾清理）之前，这条链上没有链接；持有期间也换不成链接。拿着它直到操作结束。
///
/// 附件的读写一律走 [`AttachmentsGuard::artifacts`] 给的真实位置（peer W6 r3 P1-01）：库路径上数据根以上的
/// 链接在持锁期间可以被换掉，真实位置不能。附件根下还不存在的层用 [`AttachmentsGuard::ensure`] 排他新建并钉住。
pub(crate) struct AttachmentsGuard {
    pinned: crate::chain::Pinned,
    _lock: MutexGuard<'static, ()>,
}

impl AttachmentsGuard {
    /// 附件根的真实位置（可能还不存在）。
    pub(crate) fn artifacts(&self) -> PathBuf {
        self.pinned.real(Path::new(ARTIFACTS_DIR))
    }

    fn rel(sub: &[&str]) -> PathBuf {
        let mut rel = PathBuf::from(ARTIFACTS_DIR);
        rel.extend(sub);
        rel
    }

    /// 钉住附件根下 `sub` 的每一层，不存在的排他新建。返回真实位置。
    pub(crate) fn ensure(&mut self, sub: &[&str]) -> Result<PathBuf> {
        Ok(self.pinned.ensure(&Self::rel(sub))?)
    }

    /// 附件根下 `sub` 整条链都在、都钉住时的真实位置；不在时 `None`（不建）。取得守卫之后才出现的层同样逐层核对，
    /// 是链接就拒绝（peer W6 r4 P1-01）。要枚举、读、删的位置都先经过这里。
    pub(crate) fn existing(&mut self, sub: &[&str]) -> Result<Option<PathBuf>> {
        Ok(self.pinned.existing(&Self::rel(sub))?)
    }

    /// 附件根下钉住的 `sub` 这一层的句柄；没钉住时 `None`。
    pub(crate) fn dir(&self, sub: &[&str]) -> Option<&crate::pin::Dir> {
        self.pinned.dir(&Self::rel(sub))
    }

    /// 库文件在钉住的数据根里的真实位置（peer W6 r4 P1-02）：旁路连接（备份、导出的快照）从这里打开，与附件读的
    /// 是同一个数据根；不再按 `store.path()` 的字面写法重新解析——那上面数据根以上的链接在持锁期间可以被换掉。
    pub(crate) fn database(&self, store: &Store) -> PathBuf {
        let name = store.path().file_name().unwrap_or_default();
        self.pinned.real(Path::new(name))
    }

    /// 在钉住的 `parent`（附件根下）里排他新建 `name` 并钉住，交给调用方；删它、改它的名之前先放开。
    pub(crate) fn create_owned(&self, parent: &[&str], name: &str) -> Result<crate::pin::Dir> {
        Ok(self
            .pinned
            .create_owned(&Self::rel(parent), std::ffi::OsStr::new(name))?)
    }
}

/// 备份根（peer W6 r3 P1-01，与附件同一类问题）：从它的上一层往下钉住备份根、隔离区与「正在创建」，
/// 之后的创建、撤回、清扫都走真实位置。登记进库的路径照旧是调用方给的备份根下的路径。
pub(crate) struct BackupsRoot {
    pinned: crate::chain::Pinned,
    name: PathBuf,
    literal: PathBuf,
}

impl BackupsRoot {
    /// 备份根在数据根下时（通常如此），换算到 Store 打开时钉住的数据根的真实位置里再钉（peer W6 r5 P1-01：
    /// 与附件同一个根因）；登记的路径仍是调用方给的。
    pub(crate) fn pin_for(store: &Store, root: &Path) -> Result<Self> {
        let mut pinned = Self::pin(&store.rebase(root)?)?;
        pinned.literal = root.to_path_buf();
        Ok(pinned)
    }

    pub(crate) fn pin(root: &Path) -> Result<Self> {
        let parent = root
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let name = PathBuf::from(root.file_name().ok_or_else(|| {
            BackupError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("{} has no directory name", root.display()),
            ))
        })?);
        let pinned = crate::chain::pin_inside(
            parent,
            &[&name.join(WITHDRAWN_DIR), &name.join(CREATING_DIR)],
        )?;
        Ok(Self {
            pinned,
            name,
            literal: root.to_path_buf(),
        })
    }

    /// 备份根（或它下面的 `sub`）的真实位置。
    pub(crate) fn real(&self, sub: Option<&str>) -> PathBuf {
        let mut rel = self.name.clone();
        rel.extend(sub);
        self.pinned.real(&rel)
    }

    /// 钉住备份根（以及 `sub`），不存在的排他新建。
    pub(crate) fn ensure(&mut self, sub: Option<&str>) -> Result<PathBuf> {
        let mut rel = self.name.clone();
        rel.extend(sub);
        Ok(self.pinned.ensure(&rel)?)
    }

    /// 备份根（或 `sub`）整条链都在、都钉住时的真实位置，不在时 `None`（见 [`AttachmentsGuard::existing`]）。
    fn existing(&mut self, sub: Option<&str>) -> Result<Option<PathBuf>> {
        let mut rel = self.name.clone();
        rel.extend(sub);
        Ok(self.pinned.existing(&rel)?)
    }

    /// 登记进库的路径：调用方给的备份根下的 `id`。
    fn registered(&self, id: &str) -> PathBuf {
        self.literal.join(id)
    }

    /// 放开 `sub`（要删掉它了）。
    fn release(&mut self, sub: &str) {
        self.pinned.release(&self.name.join(sub));
    }

    fn create_owned(&self, name: &str) -> Result<crate::pin::Dir> {
        Ok(self
            .pinned
            .create_owned(&self.name, std::ffi::OsStr::new(name))?)
    }
}

/// 从 Store 打开时钉住的数据根往下钉（peer W6 r5 P1-01）：不再按 `store.path()` 的字面写法重新选根——Store 打开
/// 之后、守卫取得之前，那上面的链接可以被换向，换到的数据根不是这个 Store 的连接读写的那个。钉住之后再核对一次
/// 身份，与打开时的数据根不是同一个目录就在任何副作用之前拒绝。
pub(crate) fn attachments_lock(store: &Store, what: &'static str) -> Result<AttachmentsGuard> {
    let lock = lock_attachments(store, what)?;
    let artifacts = Path::new(ARTIFACTS_DIR);
    let pinned = crate::chain::pin_inside(
        store.root().path(),
        &[
            &artifacts.join(crate::restore::STAGING_DIR),
            &artifacts.join(crate::restore::OLD_DIR),
        ],
    )?;
    if pinned.root_id() != store.root().id() {
        return Err(BackupError::LinkedPath(
            store
                .path()
                .parent()
                .unwrap_or(Path::new("."))
                .display()
                .to_string(),
        ));
    }
    Ok(AttachmentsGuard {
        pinned,
        _lock: lock,
    })
}

fn lock_attachments(store: &Store, what: &'static str) -> Result<MutexGuard<'static, ()>> {
    if std::thread::current().name() == Some(crate::engine::WRITER_THREAD) {
        return Err(BackupError::Reentrant(what));
    }
    match ATTACHMENTS_LOCK.try_lock() {
        Ok(guard) => return Ok(guard),
        Err(TryLockError::Poisoned(e)) => return Ok(e.into_inner()),
        Err(TryLockError::WouldBlock) => {}
    }
    let me = (store.path().to_path_buf(), what);
    WAITING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(me.clone());
    let guard = ATTACHMENTS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut waiting = WAITING.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(i) = waiting.iter().position(|w| *w == me) {
        waiting.remove(i);
    }
    Ok(guard)
}

/// 这个库上正在等附件锁的操作名（`create_backup`、`restore_project` 等）。只供测试使用。
#[doc(hidden)]
pub fn attachment_lock_waiters(db_path: &Path) -> Vec<&'static str> {
    WAITING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .filter(|(p, _)| p == db_path)
        .map(|(_, what)| *what)
        .collect()
}

/// 附件根目录下恢复用的内部目录（暂存、换下来的旧版本），不属于任何项目，不进备份。
pub(crate) fn is_internal(rel: &str) -> bool {
    rel.starts_with(".restore-")
}

/// 做一个整库备份并登记。`kind` 取 `backups.kind` 的取值之一。
///
/// 先把上一次恢复没换完的附件换完；换不完就拒绝（[`BackupError::AttachmentsPending`]），
/// 不会把恢复后的库和恢复前的附件打进同一份备份。
pub fn create_backup(store: &Store, root: &Path, kind: &str, at: &str) -> Result<BackupInfo> {
    let mut lock = attachments_lock(store, "create_backup")?;
    crate::restore::finish_swaps_locked(store, &mut lock)?;
    let mut backups = BackupsRoot::pin_for(store, root)?;
    sweep_withdrawn_locked(store, &mut backups);
    create_backup_locked(store, &mut backups, &mut lock, kind, at)
}

/// 已持有 [`attachments_lock`] 时用（按范围恢复里的 PRE_RESTORE）。有已提交、未换入的附件就拒绝。
pub(crate) fn create_backup_locked(
    store: &Store,
    backups: &mut BackupsRoot,
    attachments: &mut AttachmentsGuard,
    kind: &str,
    at: &str,
) -> Result<BackupInfo> {
    crate::restore::refuse_pending_swaps(store, attachments)?;
    // 库与附件出自同一个钉住的数据根（peer W6 r4 P1-02）。
    let side = side_reader(&attachments.database(store))?;
    let id = ulid(&side)?;
    // 读写都在真实位置；登记的是调用方给的备份根下的路径。
    let root = backups.ensure(None)?;
    let dir = root.join(&id);
    // 先落一个「正在创建」标记，登记成功才删（W2 peer r3 P1-01）。登记之前任何一步失败都删目录；
    // 删不掉（文件被占用）就留着标记，下次清扫按它找回目录再删——备份根下没有找不回的未登记目录。
    let marker = backups.ensure(Some(CREATING_DIR))?.join(&id);
    fs::write(&marker, b"")?;
    sync_file(&marker)?;
    // 备份目录排他新建，写完之前一直钉着；删它之前先放开。
    let made = backups.create_owned(&id).and_then(|owned| {
        let made = write_backup(
            store,
            side,
            &id,
            (&dir, &backups.registered(&id)),
            attachments,
            kind,
            at,
        );
        drop(owned);
        made
    });
    let settled = match &made {
        Ok(_) => true,
        Err(_) => match fs::remove_dir_all(&dir) {
            Ok(()) => true,
            Err(e) => e.kind() == std::io::ErrorKind::NotFound,
        },
    };
    if settled && fs::remove_file(&marker).is_ok() {
        backups.release(CREATING_DIR);
        let _ = fs::remove_dir(root.join(CREATING_DIR));
    }
    made
}

fn write_backup(
    store: &Store,
    side: Connection,
    id: &str,
    (dir, registered): (&Path, &Path),
    attachments: &mut AttachmentsGuard,
    kind: &str,
    at: &str,
) -> Result<BackupInfo> {
    // `dir` 是写在哪（真实位置），`registered` 是登记成什么（调用方给的备份根下的路径）。
    let id = id.to_string();

    let tmp = dir.join(format!("{DB_FILE}.tmp"));
    side.execute("VACUUM INTO ?1", [path_str(&tmp)?])?;
    drop(side);
    sync_file(&tmp)?;
    let db = dir.join(DB_FILE);
    atm_install_state::durable::rename(&tmp, &db, true)?;
    let (sha256, size_bytes) = hash_file(&db)?;

    // 附件根在取得守卫时不存在、之后才出现的，照样核对；不在就是没有附件。
    let files = match attachments.existing(&[])? {
        Some(source) => {
            copy_tree_filtered(&source, &dir.join(ARTIFACTS_DIR), &|rel| !is_internal(rel))?
        }
        None => Vec::new(),
    };
    let attachments_sha256 = attachments_digest(&files);

    // manifest 的内容全部从快照本身读出，保证与库一致。
    let snap = side_reader(&db)?;
    let files_json = files_json(&snap, &files)?;
    let manifest: String = snap.query_row(
        "SELECT json_object(
           'format', ?1, 'backupId', ?2, 'kind', ?3, 'createdAt', ?4,
           'db', json_object('file', ?5, 'sha256', ?6, 'sizeBytes', ?7),
           'migrations', (SELECT json_group_array(json_object('version', version, 'sha256', sha256))
                          FROM (SELECT version, sha256 FROM schema_migrations ORDER BY version)),
           'appMeta', (SELECT json_object('dataRootId', data_root_id, 'instanceEpoch', instance_epoch,
                                          'generation', generation, 'globalSeq', global_seq,
                                          'scopeGenCounter', scope_gen_counter) FROM app_meta),
           'projects', (SELECT json_group_array(json_object('id', id, 'code', code, 'lifecycle', lifecycle,
                                                            'projectSeq', project_seq, 'scopeGen', scope_gen, 'epoch', epoch))
                        FROM (SELECT * FROM projects ORDER BY id)),
           'knowledge', (SELECT json_object('databaseId', database_id, 'generation', generation,
                                            'sequence', sequence, 'scopeGen', scope_gen) FROM knowledge_meta),
           'attachments', json_object('sha256', ?8, 'files', json(?9)))",
        params![MANIFEST_FORMAT, id, kind, at, DB_FILE, sha256, size_bytes as i64, attachments_sha256, files_json],
        |r| r.get(0),
    )?;
    let (schema_version, generation): (i64, String) = snap.query_row(
        "SELECT (SELECT max(version) FROM schema_migrations), coalesce((SELECT generation FROM app_meta), '')",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    drop(snap);
    write_atomically(&dir.join(MANIFEST_FILE), manifest.as_bytes())?;

    let row = (
        id.clone(),
        kind.to_string(),
        path_str(registered)?.to_string(),
        sha256.clone(),
        size_bytes as i64,
        attachments_sha256.clone(),
        at.to_string(),
    );
    store.write(move |tx| {
        tx.execute(
            "INSERT INTO backups (id, kind, path, sha256, size_bytes, schema_version, generation,
                                  attachments_manifest_sha256, created_at, verified_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
            params![
                row.0,
                row.1,
                row.2,
                row.3,
                row.4,
                schema_version,
                generation,
                row.5,
                row.6
            ],
        )
    })?;
    Ok(BackupInfo {
        id,
        kind: kind.to_string(),
        dir: registered.to_path_buf(),
        sha256,
        size_bytes,
        attachments_sha256,
        created_at: at.to_string(),
    })
}

/// 备份根目录下的隔离区：撤回时目录先挪到这里再删登记行，删不掉的留在这里等下次清理。
pub const WITHDRAWN_DIR: &str = ".withdrawn";
/// 备份根下的「正在创建」标记目录：每份备份创建期间有一个以 id 命名的空文件，登记成功才删。
pub const CREATING_DIR: &str = ".creating";

/// 一次撤回的结果（W2 peer r2 P1-02）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Withdrawal {
    /// 登记行和目录都删掉了。
    Withdrawn,
    /// 原样保留，登记与目录都完整：`PINNED`（已固定）、`RESTORE_REFERENCE`（有恢复记着它）、
    /// `FILES_IN_USE`（目录挪不动）、`NOT_REGISTERED`（登记行已经不在，不碰目录）。
    Kept(&'static str),
    /// 登记行已删，目录留在隔离区，下次 [`create_backup`] / [`discard_backup`] 时清理。
    CleanupPending,
    /// 存储出错，状态见隔离区（下次清理会按登记行把目录放回或删掉）。
    Failed(String),
}

impl Withdrawal {
    pub fn as_str(&self) -> &'static str {
        match self {
            Withdrawal::Withdrawn => "WITHDRAWN",
            Withdrawal::Kept(_) => "KEPT",
            Withdrawal::CleanupPending => "CLEANUP_PENDING",
            Withdrawal::Failed(_) => "FAILED",
        }
    }
}

/// 撤回一份调用方自己刚做、自己没用上的备份（服务层生命周期迁移在并发里被抢先时）。
///
/// 「自己没用上」不等于「谁都没用上」：两趟之间它可能已被别人选中恢复。所以：
/// - 持附件锁，与按范围恢复（选中、校验、固定都在锁里）和备份串行；
/// - 只删没固定、没有恢复引用的，条件写在 DELETE 本身里，不靠事先查一次；
/// - 目录先改名进隔离区再删行：改名挪不动（文件被占用）就整份保留；删行没删成就改名放回；
///   删行之后目录删不掉，登记已无、目录在隔离区，下次清理（[`sweep_withdrawn`]）。
///
/// 任何时刻都不会出现「目录在备份根下却没有登记」或「登记着却缺一半文件」。
pub fn discard_backup(store: &Store, info: &BackupInfo) -> Result<Withdrawal> {
    withdraw(store, info, None)
}

/// 按保留策略修剪一份备份（W5h，job `maintenance` 与手动备份之后）。与 [`discard_backup`] 同一套撤回，
/// 只是固定到 `now` 之前（已过期）的不再挡着；固定还没到期的、被恢复引用着的照样保留。
pub fn prune_backup(store: &Store, info: &BackupInfo, now: &str) -> Result<Withdrawal> {
    withdraw(store, info, Some(now))
}

/// `now` 为 `None`：任何固定都挡着（撤回自己刚做的备份）；给了 `now`：只有 `pinned_until > now` 才挡着。
fn withdraw(store: &Store, info: &BackupInfo, now: Option<&str>) -> Result<Withdrawal> {
    let _lock = attachments_lock(store, "discard_backup")?;
    let (Some(root), Some(name)) = (info.dir.parent(), info.dir.file_name()) else {
        return Err(BackupError::Corrupt(format!(
            "backup dir has no parent: {}",
            info.dir.display()
        )));
    };
    let mut backups = BackupsRoot::pin_for(store, root)?;
    sweep_withdrawn_locked(store, &mut backups);
    // 登记的是字面路径；挪、删都走真实位置。
    let dir = backups.real(None).join(name);
    let key = info.id.clone();
    let at = now.map(str::to_owned);
    let state: Option<String> = store.read(move |tx| {
        tx.query_row(
            "SELECT CASE WHEN b.pinned_until IS NOT NULL AND (?2 IS NULL OR b.pinned_until > ?2) THEN 'PINNED'
                         WHEN EXISTS (SELECT 1 FROM scope_generations g WHERE g.backup_id = b.id) THEN 'RESTORE_REFERENCE'
                         ELSE '' END
             FROM backups b WHERE b.id = ?1",
            params![key, at],
            |r| r.get(0),
        )
        .optional()
    })?;
    match state.as_deref() {
        None => return Ok(Withdrawal::Kept("NOT_REGISTERED")),
        Some("PINNED") => return Ok(Withdrawal::Kept("PINNED")),
        Some("RESTORE_REFERENCE") => return Ok(Withdrawal::Kept("RESTORE_REFERENCE")),
        _ => {}
    }
    let quarantine = backups.ensure(Some(WITHDRAWN_DIR))?;
    let parked = quarantine.join(&info.id);
    // 目录先隔离、再删登记行、删不成再放回：三步都按共享的持久化契约落盘（W4 关口 P2-W4A-02）。
    // 占着就留到下次（KEPT），不等。
    if durable::rename_once(&dir, &parked, false).is_err() {
        backups.release(WITHDRAWN_DIR);
        let _ = fs::remove_dir(&quarantine);
        return Ok(Withdrawal::Kept("FILES_IN_USE"));
    }
    let key = info.id.clone();
    let at = now.map(str::to_owned);
    let deleted = store.write(move |tx| {
        tx.execute(
            "DELETE FROM backups WHERE id = ?1
               AND (pinned_until IS NULL OR (?2 IS NOT NULL AND pinned_until <= ?2))
               AND NOT EXISTS (SELECT 1 FROM scope_generations WHERE backup_id = ?1)",
            params![key, at],
        )
    });
    match deleted {
        Ok(1) => {}
        other => {
            // 没删成：放回原处。放不回时登记还在、目录在隔离区，下次清理按登记行放回。
            let _ = durable::rename_once(&parked, &dir, false);
            backups.release(WITHDRAWN_DIR);
            let _ = fs::remove_dir(&quarantine);
            return match other {
                Ok(_) => Ok(Withdrawal::Kept("RESTORE_REFERENCE")),
                Err(e) => Err(e.into()),
            };
        }
    }
    if fs::remove_dir_all(&parked).is_err() {
        return Ok(Withdrawal::CleanupPending);
    }
    backups.release(WITHDRAWN_DIR);
    let _ = fs::remove_dir(&quarantine);
    Ok(Withdrawal::Withdrawn)
}

/// 清理备份根下的残留：隔离区里登记行还在的放回备份根、不在的删掉；「正在创建」标记对应的备份
/// 已登记的只删标记，没登记的（创建失败、目录当时删不掉）删目录再删标记。返回清不掉的个数。
/// 调用方持附件锁，创建与撤回也都在锁里，所以这里看到的标记和隔离条目都不属于进行中的操作。
pub fn sweep_withdrawn(store: &Store, root: &Path) -> Result<usize> {
    let _lock = attachments_lock(store, "sweep_withdrawn")?;
    let mut backups = BackupsRoot::pin_for(store, root)?;
    Ok(sweep_withdrawn_locked(store, &mut backups))
}

/// 还有几份残留没清掉：隔离区条目加「正在创建」标记（诊断用；不拿锁，可能与正在进行的撤回或创建差一份）。
pub fn withdrawn_pending(root: &Path) -> usize {
    [WITHDRAWN_DIR, CREATING_DIR]
        .iter()
        .map(|d| fs::read_dir(root.join(d)).map_or(0, |d| d.count()))
        .sum()
}

/// 只碰整条链都钉住的位置（peer W6 r4 P1-01）：取得守卫时不存在、之后才出现的备份根、隔离区、「正在创建」先核对，
/// 是链接就不清（计进返回的个数），不跟着它枚举、删除。
pub(crate) fn sweep_withdrawn_locked(store: &Store, backups: &mut BackupsRoot) -> usize {
    let registered = |id: &str| {
        let key = id.to_string();
        store.read(move |tx| {
            tx.query_row("SELECT count(*) FROM backups WHERE id = ?1", [key], |r| {
                r.get::<_, i64>(0)
            })
        })
    };
    let mut left = 0;
    let root = match backups.existing(None) {
        Ok(Some(root)) => root,
        Ok(None) => return 0,
        Err(_) => return 1,
    };
    match backups.existing(Some(WITHDRAWN_DIR)) {
        Ok(Some(quarantine)) => {
            if let Ok(entries) = fs::read_dir(&quarantine) {
                for entry in entries.flatten() {
                    let id = entry.file_name().to_string_lossy().into_owned();
                    let done = match registered(&id) {
                        Ok(0) => fs::remove_dir_all(entry.path()).is_ok(),
                        Ok(_) => {
                            durable::rename_once(&entry.path(), &root.join(&id), false).is_ok()
                        }
                        Err(_) => false,
                    };
                    if !done {
                        left += 1;
                    }
                }
            }
            backups.release(WITHDRAWN_DIR);
            let _ = fs::remove_dir(&quarantine);
        }
        Ok(None) => {}
        Err(_) => left += 1,
    }
    match backups.existing(Some(CREATING_DIR)) {
        Ok(Some(creating)) => {
            if let Ok(entries) = fs::read_dir(&creating) {
                for entry in entries.flatten() {
                    let id = entry.file_name().to_string_lossy().into_owned();
                    let gone = match registered(&id) {
                        Ok(0) => match fs::remove_dir_all(root.join(&id)) {
                            Ok(()) => true,
                            Err(e) => e.kind() == std::io::ErrorKind::NotFound,
                        },
                        Ok(_) => true,
                        Err(_) => false,
                    };
                    if !(gone && fs::remove_file(entry.path()).is_ok()) {
                        left += 1;
                    }
                }
            }
            backups.release(CREATING_DIR);
            let _ = fs::remove_dir(&creating);
        }
        Ok(None) => {}
        Err(_) => left += 1,
    }
    left
}

/// 校验通过的备份：恢复需要的定位信息。
///
/// `dir`、`db` 是登记的路径（展示用）。校验与之后的读取都走 [`VerifiedBackup::source_db`] /
/// [`VerifiedBackup::source_artifacts`]：备份目录在校验时钉住，这份值活着就一直钉着（peer W6 r4 P1-02 的同类通道）——
/// 登记路径上的链接在校验之后被换向，读到的仍是校验过的那一份。
#[derive(Clone, Debug)]
pub struct VerifiedBackup {
    pub id: String,
    pub dir: PathBuf,
    pub db: PathBuf,
    pub created_at: String,
    /// 备份时的 global_seq：全局流里比它大的行都在备份点之后。
    pub global_seq: i64,
    pub attachments: Vec<FileEntry>,
    source: Arc<PinnedBackup>,
}

/// 钉住的备份目录与它的 `artifacts/`（在的话）。
struct PinnedBackup {
    _pinned: crate::chain::Pinned,
    root: PathBuf,
    artifacts: Option<PathBuf>,
}

impl std::fmt::Debug for PinnedBackup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PinnedBackup")
            .field("root", &self.root)
            .finish()
    }
}

impl VerifiedBackup {
    /// 登记路径下的附件目录（展示用）。
    pub fn artifacts_dir(&self) -> PathBuf {
        self.dir.join(ARTIFACTS_DIR)
    }

    /// 校验过的库文件：钉住的备份目录里的真实位置。
    pub(crate) fn source_db(&self) -> PathBuf {
        self.source.root.join(DB_FILE)
    }

    /// 校验过的附件目录：钉住的真实位置；备份里没有附件时 `None`。
    pub(crate) fn source_artifacts(&self) -> Option<&Path> {
        self.source.artifacts.as_deref()
    }
}

/// 逐项核对一个已登记的备份。任一项不符都拒绝，不做部分恢复。
pub fn verify_backup(store: &Store, id: &str) -> Result<VerifiedBackup> {
    let key = id.to_string();
    let row: Option<(String, String, i64, Option<String>, String)> = store.read(move |tx| {
        tx.query_row(
            "SELECT path, sha256, size_bytes, attachments_manifest_sha256, created_at FROM backups WHERE id = ?1",
            [&key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
    })?;
    let (dir, sha, size, attachments_sha, created_at) =
        row.ok_or_else(|| BackupError::NotFound(id.to_string()))?;
    let dir = PathBuf::from(dir);
    let db = dir.join(DB_FILE);
    // 登记的是调用方给的写法；在数据根下的换算到 Store 钉住的真实位置里再找（peer W6 r6 P2-01）。
    let located = store.rebase(&dir)?;
    if !located.join(DB_FILE).is_file() {
        return Err(BackupError::Corrupt(format!("{} is missing", db.display())));
    }
    // 从这里起只读钉住的真实位置：校验的与之后恢复读的是同一份。
    let mut pinned = crate::chain::Pinned::open(&located)?;
    let root = pinned.real(Path::new(""));
    let artifacts = pinned.existing(Path::new(ARTIFACTS_DIR))?;
    let source = Arc::new(PinnedBackup {
        _pinned: pinned,
        root: root.clone(),
        artifacts: artifacts.clone(),
    });
    let real_db = root.join(DB_FILE);
    let (actual_sha, actual_size) = hash_file(&real_db)?;
    if actual_sha != sha || actual_size as i64 != size {
        return Err(BackupError::Corrupt(
            "database file differs from the catalog".into(),
        ));
    }

    let manifest = fs::read_to_string(root.join(MANIFEST_FILE))
        .map_err(|e| BackupError::Corrupt(format!("manifest unreadable: {e}")))?;
    let side = side_reader(&real_db)?;
    struct Head {
        format: Option<String>,
        id: Option<String>,
        sha: Option<String>,
        size: Option<i64>,
        attachments: Option<String>,
    }
    let head = side.query_row(
        "SELECT ?1 ->> '$.format', ?1 ->> '$.backupId', ?1 ->> '$.db.sha256', ?1 ->> '$.db.sizeBytes',
                ?1 ->> '$.attachments.sha256'",
        [&manifest],
        |r| {
            Ok(Head {
                format: r.get(0)?,
                id: r.get(1)?,
                sha: r.get(2)?,
                size: r.get(3)?,
                attachments: r.get(4)?,
            })
        },
    )?;
    let m_att = head.attachments;
    if head.format.as_deref() != Some(MANIFEST_FORMAT)
        || head.id.as_deref() != Some(id)
        || head.sha.as_deref() != Some(sha.as_str())
        || head.size != Some(size)
    {
        return Err(BackupError::Corrupt(
            "manifest does not describe this database file".into(),
        ));
    }

    let attachments = match &artifacts {
        Some(a) => list_tree(a)?,
        None => Vec::new(),
    };
    let digest = attachments_digest(&attachments);
    if m_att.as_deref() != Some(digest.as_str())
        || attachments_sha.as_deref() != Some(digest.as_str())
    {
        return Err(BackupError::Corrupt(
            "attachments differ from the manifest".into(),
        ));
    }

    let check: String = side.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    if check != "ok" {
        return Err(BackupError::Corrupt(format!("quick_check: {check}")));
    }

    let backup_migrations = migrations(&side)?;
    let backup_identity = identity(&side)?;
    let global_seq: i64 = side.query_row(
        "SELECT coalesce((SELECT global_seq FROM app_meta), 0)",
        [],
        |r| r.get(0),
    )?;
    drop(side);
    let (current_migrations, current_identity) =
        store.read(|tx| Ok::<_, rusqlite::Error>((migrations(tx)?, identity(tx)?)))?;
    if backup_migrations != current_migrations {
        return Err(BackupError::SchemaMismatch);
    }
    if backup_identity.is_none() || backup_identity != current_identity {
        return Err(BackupError::TimelineMismatch(
            "data_root_id / instance_epoch differ".into(),
        ));
    }

    let key = id.to_string();
    store.write(move |tx| {
        tx.execute(
            "UPDATE backups SET verified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1",
            [key],
        )
    })?;
    Ok(VerifiedBackup {
        id: id.to_string(),
        dir,
        db,
        created_at,
        global_seq,
        attachments,
        source,
    })
}

/// 固定一个备份到 `until`（A4：恢复前先固定，保留策略不得删除）。
pub fn pin(store: &Store, id: &str, until: &str) -> Result<()> {
    let (key, until) = (id.to_string(), until.to_string());
    let n = store.write(move |tx| {
        tx.execute(
            "UPDATE backups SET pinned_until = ?2 WHERE id = ?1",
            [key, until],
        )
    })?;
    if n == 0 {
        return Err(BackupError::NotFound(id.to_string()));
    }
    Ok(())
}

fn migrations(c: &Connection) -> rusqlite::Result<Vec<(i64, String)>> {
    let mut st = c.prepare("SELECT version, sha256 FROM schema_migrations ORDER BY version")?;
    st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect()
}

fn identity(c: &Connection) -> rusqlite::Result<Option<(String, String)>> {
    c.query_row(
        "SELECT data_root_id, instance_epoch FROM app_meta",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
}

pub(crate) fn path_str(p: &Path) -> Result<&str> {
    p.to_str()
        .ok_or_else(|| BackupError::Unsupported(format!("non-UTF-8 path {}", p.display())))
}

pub(crate) fn hash_file(path: &Path) -> Result<(String, u64)> {
    let mut f = File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    let mut total = 0u64;
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        total += n as u64;
    }
    Ok((hex(&h.finalize()), total))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 落盘。Windows 上 FlushFileBuffers 要求句柄有写权限，只读打开会被拒绝。
fn sync_file(path: &Path) -> Result<()> {
    fs::OpenOptions::new().write(true).open(path)?.sync_all()?;
    Ok(())
}

/// 共用的持久化契约（[`atm_install_state::durable::write_atomic`]）：刷盘后 WRITE_THROUGH 地替换。
pub(crate) fn write_atomically(path: &Path, bytes: &[u8]) -> Result<()> {
    atm_install_state::durable::write_atomic(path, bytes)?;
    Ok(())
}

/// 附件清单的摘要：按相对路径字节序排列的 `路径 \0 大小 \0 sha256 \n` 序列的 sha256（05 §5.1 文件集合族）。
pub fn attachments_digest(files: &[FileEntry]) -> String {
    let mut h = Sha256::new();
    for f in files {
        h.update(f.path.as_bytes());
        h.update([0]);
        h.update(f.size.to_string().as_bytes());
        h.update([0]);
        h.update(f.sha256.as_bytes());
        h.update(b"\n");
    }
    hex(&h.finalize())
}

fn files_json(c: &Connection, files: &[FileEntry]) -> Result<String> {
    let mut json = String::from("[]");
    for f in files {
        json = c.query_row(
            "SELECT json_insert(?1, '$[#]', json_object('path', ?2, 'sizeBytes', ?3, 'sha256', ?4))",
            params![json, f.path, f.size as i64, f.sha256],
            |r| r.get(0),
        )?;
    }
    Ok(json)
}

/// 列出目录下的全部普通文件（相对路径、大小、sha256），按路径字节序。目录不存在视为空。
pub fn list_tree(root: &Path) -> Result<Vec<FileEntry>> {
    let mut out = Vec::new();
    if root.exists() {
        walk(root, root, &mut |abs, rel| {
            let (sha256, size) = hash_file(abs)?;
            out.push(FileEntry {
                path: rel.to_string(),
                size,
                sha256,
            });
            Ok(())
        })?;
    }
    out.sort_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
    Ok(out)
}

/// 把 `from` 下的全部普通文件复制到 `to`，返回清单。
pub fn copy_tree(from: &Path, to: &Path) -> Result<Vec<FileEntry>> {
    copy_tree_filtered(from, to, &|_| true)
}

/// 同 [`copy_tree`]，只复制 `keep(相对路径)` 为真的文件。
fn copy_tree_filtered(
    from: &Path,
    to: &Path,
    keep: &dyn Fn(&str) -> bool,
) -> Result<Vec<FileEntry>> {
    if from.exists() {
        walk(from, from, &mut |abs, rel| {
            if !keep(rel) {
                return Ok(());
            }
            let dest = to.join(rel);
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(abs, &dest)?;
            sync_file(&dest)?;
            Ok(())
        })?;
    }
    list_tree(to)
}

fn walk(root: &Path, dir: &Path, f: &mut dyn FnMut(&Path, &str) -> Result<()>) -> Result<()> {
    let mut entries: Vec<_> = fs::read_dir(dir)?.collect::<std::io::Result<_>>()?;
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let path = e.path();
        let meta = fs::symlink_metadata(&path)?;
        if meta.file_type().is_symlink() || is_reparse_point(&meta) {
            return Err(BackupError::Unsupported(path.display().to_string()));
        }
        if meta.is_dir() {
            walk(root, &path, f)?;
        } else if meta.is_file() {
            let rel = path
                .strip_prefix(root)
                .map_err(|_| BackupError::Unsupported(path.display().to_string()))?;
            let rel: Vec<String> = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect();
            f(&path, &rel.join("/"))?;
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_reparse_point(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_meta: &fs::Metadata) -> bool {
    false
}
