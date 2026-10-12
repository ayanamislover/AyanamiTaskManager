//! 不写源目录地读一个 SQLite 库：启动判定、安装探测、离线诊断（W8 关口 peer r1 P1-01 / P1-02，r2 P1-01～P1-03）。
//!
//! 只读连接（`SQLITE_OPEN_READ_ONLY`）对 WAL 库并不只读：没有 `-shm` 就建一个，有就改它的读标记，没有 `-wal`
//! 还会建一个空的（rusqlite 0.39 自带的 SQLite 实测）。读写连接更不行：最后一个连接关闭时会 checkpoint、删 `-wal`，
//! 坏库的原字节就没了。`immutable=1` 什么都不写，但看不到 `-wal` 里已提交的内容、无视热回滚日志，而且不拿任何锁：
//! 别的进程这时在写，它就会读到没提交的页，或者把两次提交读进同一条查询（peer r2 P1-02）。
//!
//! 所以先让源库在读的这段时间里不会变（冻结），再读：
//! - 按 SQLite 在 Windows 上的锁协议（`os_win.c`），在库文件上独占 PENDING 字节。新连接拿 SHARED 要先拿它，
//!   写者从 RESERVED 升 EXCLUSIVE 也要先拿它：握着它，就没有人能开始读写，也没有人能改库文件、回滚日志。
//! - 还有别的连接握着 SHARED、库又是 WAL 模式：这些连接不必再拿 PENDING 就能往 `-wal` 追加、checkpoint 进库文件。
//!   再在 `-shm` 上独占写锁与 checkpoint 锁两个字节（`WIN_SHM_BASE` = 120 起）：追加、checkpoint、重置 `-wal`
//!   都要其中之一。`-shm` 只打开、加锁，不写。
//! - 拿不到（有人正在提交、checkpoint、回滚）就放掉已拿的、等一会儿重来，到期限还拿不到报 [`Error::Busy`]。
//!   被挡住的连接按各自的 busy_timeout 等，冻结只持续一次读或一次复制。
//!
//! 冻结之后：
//! - 没有热回滚日志、`-wal` 不在或为空：按 `immutable` 读源文件本身，读完才解冻；
//! - 否则在冻结中把库与 `-wal`、热日志复制进调用方给的暂存目录，解冻后在副本上正常打开（SQLite 在副本上回滚日志、
//!   恢复 WAL），读完删掉副本。不再拿文件的大小、修改时间猜复制是不是一致的（peer r2 P1-03）。
//!
//! 源目录一个字节不动，也不多出文件。副本删不掉（被别的程序占着）或进程被杀没来得及删的，下一次在同一个暂存目录读时，
//! 按目录名里的 pid 清：那个进程已经不在了就删。

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use rusqlite::{Connection, OpenFlags};

/// 回滚日志头的魔数（SQLite 文件格式 §4.1）。
const JOURNAL_MAGIC: [u8; 8] = [0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7];

/// 库文件上的锁字节（`sqlite3.c` 的 `PENDING_BYTE`、`SHARED_FIRST`、`SHARED_SIZE`）。
const PENDING_BYTE: u64 = 0x4000_0000;
const SHARED_FIRST: u64 = PENDING_BYTE + 2;
const SHARED_SIZE: u32 = 510;
/// `-shm` 上的写锁（`WAL_WRITE_LOCK`）与紧挨着的 checkpoint 锁（`WAL_CKPT_LOCK`）：`WIN_SHM_BASE` = (22 + 8) * 4。
const SHM_WRITE_AND_CHECKPOINT: u64 = 120;

/// 冻结源库最多等多久（[`read`] 用的）。写事务通常是毫秒级的，等不到说明有人长时间占着写锁。
pub const PATIENCE: Duration = Duration::from_secs(10);

/// 读不出的原因：打不开（含复制失败）；源库一直在被写，期限内冻结不了；或打开了、查询失败。
#[derive(Debug)]
pub enum Error<E> {
    Open(String),
    Busy(String),
    Read(E),
}

fn sidecar(db: &Path, suffix: &str) -> PathBuf {
    let mut s = db.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

/// SQLite 打开时会回滚的那种日志：`-journal` 在，且以日志头的魔数开头。
/// 空的、头被清零的（`journal_mode=TRUNCATE` / `PERSIST` 提交后留下的）是冷的，SQLite 不理它，这里也不理。
/// 正在写的事务的日志也以魔数开头：冻结时它的写者提交不了，库文件是已提交的状态，在副本上回滚它不改变内容。
pub fn hot_journal(db: &Path) -> bool {
    let Ok(mut f) = File::open(sidecar(db, "-journal")) else {
        return false;
    };
    let mut head = [0u8; 8];
    f.read_exact(&mut head).is_ok() && head == JOURNAL_MAGIC
}

/// `-wal` 里有没有帧（文件在且非空）。
pub fn wal_has_frames(db: &Path) -> bool {
    fs::metadata(sidecar(db, "-wal")).is_ok_and(|m| m.len() > 0)
}

/// 按 `immutable` 只读打开：SQLite 不建、不改任何文件，也不看 `-wal` 与回滚日志，不拿锁。
/// 源库可能正被写时不能单独用它，要在 [`read`] 的冻结里用。
pub fn open_immutable(db: &Path) -> Result<Connection, String> {
    let c = Connection::open_with_flags(
        file_uri(db, "mode=ro&immutable=1"),
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    crate::harden(&c).map_err(|e| e.to_string())?;
    Ok(c)
}

fn file_uri(path: &Path, query: &str) -> String {
    let mut uri = String::from("file:");
    let shown = path.to_string_lossy();
    let shown = shown
        .strip_prefix(r"\\?\")
        .unwrap_or(&shown)
        .replace('\\', "/");
    if !shown.starts_with('/') {
        uri.push_str("///");
    }
    for c in shown.chars() {
        match c {
            '?' => uri.push_str("%3f"),
            '#' => uri.push_str("%23"),
            '%' => uri.push_str("%25"),
            ' ' => uri.push_str("%20"),
            c => uri.push(c),
        }
    }
    uri.push('?');
    uri.push_str(query);
    uri
}

/// 读 `db`，源目录不写（见模块说明）。`scratch` 放副本，必须不在库所在的目录里，不在的话按需建出来、读完拿掉。
pub fn read<T, E>(
    db: &Path,
    scratch: &Path,
    f: impl Fn(&Connection) -> Result<T, E>,
) -> Result<T, Error<E>> {
    read_patiently(db, scratch, PATIENCE, f)
}

/// 同 [`read`]，冻结最多等 `patience`。
pub fn read_patiently<T, E>(
    db: &Path,
    scratch: &Path,
    patience: Duration,
    f: impl Fn(&Connection) -> Result<T, E>,
) -> Result<T, Error<E>> {
    if !db.is_file() {
        return Err(Error::Open(format!("{} is missing", db.display())));
    }
    let source_dir = db.parent().unwrap_or(Path::new("."));
    if inside(scratch, source_dir).map_err(Error::Open)? {
        return Err(Error::Open(format!(
            "the scratch directory {} is inside {}",
            scratch.display(),
            source_dir.display()
        )));
    }
    let frozen = freeze(db, patience)?;
    if !hot_journal(db) && !wal_has_frames(db) {
        let c = open_immutable(db).map_err(Error::Open)?;
        let r = f(&c).map_err(Error::Read);
        drop(c);
        drop(frozen);
        return r;
    }
    let copy = Copy::make(db, &frozen, scratch).map_err(Error::Open)?;
    drop(frozen);
    let c = Connection::open_with_flags(
        &copy.db,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| Error::Open(e.to_string()))?;
    crate::harden(&c).map_err(|e| Error::Open(e.to_string()))?;
    let r = f(&c).map_err(Error::Read);
    drop(c);
    drop(copy);
    r
}

/// `scratch` 是否落在 `source_dir` 里。`scratch` 还不存在时看它最近的已存在的上级：那一级在源目录外，
/// 往下建出来的也在外面（peer r2 P2-01）。
fn inside(scratch: &Path, source_dir: &Path) -> Result<bool, String> {
    let source =
        fs::canonicalize(source_dir).map_err(|e| format!("{}: {e}", source_dir.display()))?;
    let scratch =
        std::path::absolute(scratch).map_err(|e| format!("{}: {e}", scratch.display()))?;
    let mut existing = scratch.as_path();
    loop {
        match fs::canonicalize(existing) {
            Ok(real) => return Ok(real.starts_with(&source)),
            Err(_) => match existing.parent() {
                Some(parent) => existing = parent,
                None => return Err(format!("{} has no existing parent", scratch.display())),
            },
        }
    }
}

// ---------------------------------------------------------------- 冻结

/// 冻结中的源库：丢掉时按相反的次序解锁。
struct Frozen {
    db: File,
    shm: Option<File>,
}

impl Drop for Frozen {
    fn drop(&mut self) {
        if let Some(shm) = &self.shm {
            os::unlock(shm, SHM_WRITE_AND_CHECKPOINT, 2);
        }
        os::unlock(&self.db, PENDING_BYTE, 1);
    }
}

fn freeze<E>(db: &Path, patience: Duration) -> Result<Frozen, Error<E>> {
    let start = Instant::now();
    let mut wait = Duration::from_millis(2);
    loop {
        let why = match try_freeze(db) {
            Ok(Ok(frozen)) => return Ok(frozen),
            Ok(Err(why)) => why,
            Err(e) => return Err(Error::Open(e)),
        };
        if start.elapsed() >= patience {
            return Err(Error::Busy(format!(
                "{} is being written by another program ({why}) and did not hold still for {} s",
                db.display(),
                patience.as_secs_f32()
            )));
        }
        std::thread::sleep(wait);
        wait = (wait * 2).min(Duration::from_millis(50));
    }
}

/// 一次尝试：`Ok(Err(为什么没拿到))` 是该等一会儿再试。
fn try_freeze(db: &Path) -> Result<Result<Frozen, &'static str>, String> {
    let file = File::open(db).map_err(|e| format!("{}: {e}", db.display()))?;
    if !os::try_lock(&file, PENDING_BYTE, 1) {
        return Ok(Err("a connection is starting or committing"));
    }
    let mut frozen = Frozen {
        db: file,
        shm: None,
    };
    // 别的连接还握着 SHARED：回滚日志模式的读者正在读，或者 WAL 模式的连接开着（它们一直握着）。
    let others = if os::try_lock(&frozen.db, SHARED_FIRST, SHARED_SIZE) {
        os::unlock(&frozen.db, SHARED_FIRST, SHARED_SIZE);
        false
    } else {
        true
    };
    if others && wal_mode(db, &frozen.db) {
        // 刚拿到 SHARED 的连接还没来得及建 `-shm`：等它建好。
        let Ok(shm) = File::open(sidecar(db, "-shm")) else {
            return Ok(Err("a connection is opening the write-ahead log"));
        };
        if !os::try_lock(&shm, SHM_WRITE_AND_CHECKPOINT, 2) {
            return Ok(Err("a connection is writing or checkpointing"));
        }
        frozen.shm = Some(shm);
    }
    Ok(Ok(frozen))
}

/// 按 WAL 打开：`-wal` 在（SQLite 一看到它就按 WAL 打开），或库头第 18、19 字节是 2。
fn wal_mode(db: &Path, file: &File) -> bool {
    if sidecar(db, "-wal").exists() {
        return true;
    }
    let mut head = [0u8; 20];
    os::read_at(file, 0, &mut head).is_ok_and(|n| n == head.len()) && head[18] == 2 && head[19] == 2
}

// ---------------------------------------------------------------- 副本

/// `scratch` 下的一份副本，丢掉时删除（连同 SQLite 在副本旁建的文件）。
struct Copy {
    dir: PathBuf,
    db: PathBuf,
    /// 为放副本新建的上级目录，由深到浅；删完副本后空了就拿掉。
    created: Vec<PathBuf>,
}

impl Copy {
    /// 在冻结中复制：库文件、有帧的 `-wal`、热日志。
    fn make(db: &Path, frozen: &Frozen, scratch: &Path) -> Result<Copy, String> {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        sweep(scratch);
        let created = create_dirs(scratch)?;
        let dir = scratch.join(format!(
            "read-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        let copy = Copy {
            db: dir.join("db.sqlite"),
            dir,
            created,
        };
        fs::create_dir(&copy.dir).map_err(|e| format!("{}: {e}", copy.dir.display()))?;
        copy_database(&frozen.db, &copy.db).map_err(|e| format!("copy {}: {e}", db.display()))?;
        #[cfg(test)]
        if let Some(hook) = tests::AFTER_DATABASE_COPY.with(|h| h.borrow_mut().take()) {
            hook();
        }
        for (part, wanted) in [("-wal", wal_has_frames(db)), ("-journal", hot_journal(db))] {
            if wanted {
                let from = sidecar(db, part);
                fs::copy(&from, sidecar(&copy.db, part))
                    .map_err(|e| format!("copy {}: {e}", from.display()))?;
            }
        }
        Ok(copy)
    }
}

impl Drop for Copy {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
        // 暂存目录本身与为它新建的上级，空了就一并拿掉（不是空的说明别的读还在用，留着）。
        if let Some(parent) = self.dir.parent() {
            let _ = fs::remove_dir(parent);
        }
        for dir in &self.created {
            let _ = fs::remove_dir(dir);
        }
    }
}

/// 建出 `dir` 及缺的上级，返回新建的那些（由深到浅）。
fn create_dirs(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut missing = Vec::new();
    let mut at = Some(dir);
    while let Some(d) = at
        && !d.exists()
    {
        missing.push(d.to_path_buf());
        at = d.parent();
    }
    let mut created = Vec::new();
    for d in missing.iter().rev() {
        match fs::create_dir(d) {
            Ok(()) => created.push(d.clone()),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(format!("{}: {e}", d.display())),
        }
    }
    created.reverse();
    Ok(created)
}

/// 清掉已经不在的进程留下的副本目录（`read-<pid>-<序号>`）。pid 被别的进程重用了就留着，下次再看。
fn sweep(scratch: &Path) {
    let Ok(entries) = fs::read_dir(scratch) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name
            .to_str()
            .and_then(|n| n.strip_prefix("read-"))
            .and_then(|n| n.split('-').next())
            .and_then(|p| p.parse::<u32>().ok())
        else {
            continue;
        };
        if pid != std::process::id() && !os::running(pid) {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// 经冻结时的句柄复制库文件。PENDING 字节所在那一页 SQLite 从来不用，别的进程可能在上面握着锁、读不了：
/// 锁字节那 512 个字节写零。
fn copy_database(from: &File, to: &Path) -> io::Result<()> {
    let len = from.metadata()?.len();
    let mut out = File::create(to)?;
    let mut buf = vec![0u8; 1 << 20];
    let mut at = 0u64;
    while at < len {
        let lock_start = PENDING_BYTE;
        let lock_end = PENDING_BYTE + 512;
        let n = if (lock_start..lock_end).contains(&at) {
            let n = (lock_end.min(len) - at) as usize;
            buf[..n].fill(0);
            n
        } else {
            let limit = if at < lock_start { lock_start } else { len };
            let want = ((limit.min(len) - at) as usize).min(buf.len());
            let n = os::read_at(from, at, &mut buf[..want])?;
            if n == 0 {
                break;
            }
            n
        };
        out.write_all(&buf[..n])?;
        at += n as u64;
    }
    out.sync_all()
}

#[cfg(windows)]
mod os {
    use std::fs::File;
    use std::os::windows::fs::FileExt;
    use std::os::windows::io::AsRawHandle;

    use windows_sys::Win32::Storage::FileSystem::{
        LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY, LockFileEx, UnlockFileEx,
    };
    use windows_sys::Win32::System::IO::OVERLAPPED;

    fn at(offset: u64) -> OVERLAPPED {
        // SAFETY: OVERLAPPED 全零是合法的初值。
        let mut o: OVERLAPPED = unsafe { std::mem::zeroed() };
        o.Anonymous.Anonymous.Offset = offset as u32;
        o.Anonymous.Anonymous.OffsetHigh = (offset >> 32) as u32;
        o
    }

    /// 独占锁住 `[offset, offset + len)`，拿不到立即返回 false。
    pub fn try_lock(file: &File, offset: u64, len: u32) -> bool {
        let mut o = at(offset);
        // SAFETY: 句柄在 `file` 活着时有效；同步句柄上 LOCKFILE_FAIL_IMMEDIATELY 立即返回。
        unsafe {
            LockFileEx(
                file.as_raw_handle(),
                LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                0,
                len,
                0,
                &mut o,
            ) != 0
        }
    }

    pub fn unlock(file: &File, offset: u64, len: u32) {
        let mut o = at(offset);
        // SAFETY: 同上；解的是自己加的那一段。
        unsafe {
            UnlockFileEx(file.as_raw_handle(), 0, len, 0, &mut o);
        }
    }

    pub fn read_at(file: &File, offset: u64, buf: &mut [u8]) -> std::io::Result<usize> {
        file.seek_read(buf, offset)
    }

    pub fn running(pid: u32) -> bool {
        atm_install_state::procs::find(pid).is_some()
    }
}

/// 只在 Windows 上发行；别的平台上（只为能编译、跑与锁无关的用例）不加锁。
#[cfg(not(windows))]
mod os {
    use std::fs::File;
    use std::os::unix::fs::FileExt;

    pub fn try_lock(_file: &File, _offset: u64, _len: u32) -> bool {
        true
    }

    pub fn unlock(_file: &File, _offset: u64, _len: u32) {}

    pub fn read_at(file: &File, offset: u64, buf: &mut [u8]) -> std::io::Result<usize> {
        file.read_at(buf, offset)
    }

    pub fn running(_pid: u32) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::sync::mpsc;

    thread_local! {
        /// 复制完库文件、还没复制 `-wal` 时调一次（只在单元测试里有）。
        pub(super) static AFTER_DATABASE_COPY: RefCell<Option<Box<dyn FnOnce()>>> =
            const { RefCell::new(None) };
    }

    fn dir(name: &str) -> PathBuf {
        let target = std::env::var_os("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../target"));
        let d = target.join("store-tests").join("detached-unit").join(name);
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// peer r2 P1-03：复制库文件与复制 `-wal` 之间，开着的连接提交一次、checkpoint(TRUNCATE)、再只改左表。
    /// 源的每个已提交状态都满足 左 = 右 或 左 = 右 + 1；不冻结的话副本是旧库文件配新 `-wal`，读出 (6, 0)。
    /// 冻结时这些写都要等复制完，副本是复制开始时那一次提交的状态 (1, 0)。
    #[test]
    fn writes_between_copying_the_database_and_its_wal_wait_for_the_copy() {
        let d = dir("copy-interleave");
        fs::create_dir_all(d.join("src")).unwrap();
        let db = d.join("src").join("source.sqlite");
        let live = Connection::open(&db).unwrap();
        live.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
             CREATE TABLE l(x); CREATE TABLE r(x); INSERT INTO l VALUES (0); INSERT INTO r VALUES (0);
             PRAGMA wal_checkpoint(TRUNCATE); UPDATE l SET x = 1;",
        )
        .unwrap();
        assert!(wal_has_frames(&db));
        let (done, finished) = mpsc::channel();
        let path = db.clone();
        let waited = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let seen = waited.clone();
        AFTER_DATABASE_COPY.with(|h| {
            *h.borrow_mut() = Some(Box::new(move || {
                std::thread::spawn(move || {
                    let w = Connection::open(&path).unwrap();
                    w.busy_timeout(Duration::from_secs(30)).unwrap();
                    w.execute_batch(
                        "BEGIN; UPDATE l SET x = 5; UPDATE r SET x = 5; COMMIT;
                         PRAGMA wal_checkpoint(TRUNCATE); UPDATE l SET x = 6;",
                    )
                    .unwrap();
                    let _ = done.send(());
                });
                std::thread::sleep(Duration::from_millis(400));
                seen.store(
                    finished.try_recv().is_err(),
                    std::sync::atomic::Ordering::SeqCst,
                );
            }));
        });
        let pair = read(&db, &d.join("scratch"), |c| {
            c.query_row("SELECT (SELECT x FROM l), (SELECT x FROM r)", [], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
            })
        })
        .unwrap();
        assert!(
            waited.load(std::sync::atomic::Ordering::SeqCst),
            "the writer finished during the copy"
        );
        assert_eq!(pair, (1, 0));
        // 读完写者就能做完：之后读到的是它最后一次提交。
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let now = read(&db, &d.join("scratch"), |c| {
                c.query_row("SELECT (SELECT x FROM l), (SELECT x FROM r)", [], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
                })
            })
            .unwrap();
            if now == (6, 5) {
                break;
            }
            assert!(now == (1, 0) || now == (5, 5), "{now:?}");
            assert!(Instant::now() < deadline, "the writer never finished");
            std::thread::sleep(Duration::from_millis(50));
        }
        drop(live);
    }
}
