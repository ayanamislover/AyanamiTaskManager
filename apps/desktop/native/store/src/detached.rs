//! 不写源目录地读一个 SQLite 库：启动判定、安装探测、离线诊断（W8 关口 peer r1 P1-01 / P1-02，r2 P1-01～P1-03，
//! r3 P1-01）。
//!
//! 只读连接（`SQLITE_OPEN_READ_ONLY`）对 WAL 库并不只读：没有 `-shm` 就建一个，有就改它的读标记，没有 `-wal`
//! 还会建一个空的（rusqlite 0.39 自带的 SQLite 实测）。读写连接更不行：最后一个连接关闭时会 checkpoint、删 `-wal`，
//! 坏库的原字节就没了。`immutable=1` 什么都不写，但看不到 `-wal` 里已提交的内容、无视热回滚日志，而且不拿任何锁：
//! 别的进程这时在写，它就会读到没提交的页，或者把两次提交读进同一条查询（peer r2 P1-02）。
//!
//! 所以先让源库在读的这段时间里不会变（冻结），再读：
//! - 按 SQLite 在 Windows 上的锁协议（`os_win.c`），在库文件上独占 PENDING 字节。新连接拿 SHARED 要先拿它，
//!   写者从 RESERVED 升 EXCLUSIVE 也要先拿它：握着它，就没有新的连接能开始读写，也没有写者能提交。
//!   有写者已经拿着它、在等读者读完好提交时，冻结拿不到、让它先提交，不插它的队。
//! - 再握住 SHARED 区（510 字节）：没有别的连接时独占，有就和它们一起共享。任何 EXCLUSIVE 都要独占这一区，
//!   而有几条路是从 SHARED 直接升 EXCLUSIVE、不经过 PENDING 的（peer r3 P1-01）：最后一个 WAL 连接关闭时的
//!   checkpoint 与删除 `-wal`、`locking_mode=EXCLUSIVE`、热日志回滚、`journal_mode` 切换。握着它，这些都拿不到。
//!   代价是那个最后关闭的连接这次不 checkpoint、不删 `-wal` 与 `-shm`，留给下一个打开的连接（SQLite 本来就这样处理
//!   「关闭时还有别的连接」）。
//! - 还有别的连接、库又是 WAL 模式：这些连接拿着 SHARED，不必再拿 PENDING 就能往 `-wal` 追加、checkpoint 进库文件。
//!   再在 `-shm` 上独占写锁与 checkpoint 锁两个字节（`WIN_SHM_BASE` = 120 起）：追加、checkpoint、重置 `-wal`
//!   都要其中之一。`-shm` 只打开、加锁，不写。
//! - 拿不到（有人正在提交、checkpoint、回滚，或握着 EXCLUSIVE）就放掉已拿的、等一会儿重来，到期限还拿不到报
//!   [`Error::Busy`]。
//!
//! 被挡住的写者按各自的 busy_timeout 等（2.x 是 5 s），等不到就报 busy：冻结只持续一次 `immutable` 读、或一次复制
//! （本机 256 MiB 的库约 0.16 s），清扫旧副本、核对暂存目录都在冻结之前做。
//!
//! 冻结之后：
//! - 没有热回滚日志、`-wal` 不在或为空：按 `immutable` 读源文件本身，读完才解冻；
//! - 否则在冻结中把库与 `-wal`、热日志复制进调用方给的暂存目录，解冻后在副本上正常打开（SQLite 在副本上回滚日志、
//!   恢复 WAL），读完删掉副本。不再拿文件的大小、修改时间猜复制是不是一致的（peer r2 P1-03）。
//!
//! 源目录一个字节不动，也不多出文件。副本删不掉（被别的程序占着）或进程被杀没来得及删的，下一次在同一个暂存目录读时，
//! 按目录名 `read-<pid>-<序号>` 里的 pid 清：确知那个进程已经不在了才删，名字对不上的、查不了的都不碰。
//! 暂存目录与源目录不许互相包含：任一方向都在清扫与读之前拒绝（源库在暂存目录里，清扫就可能把它当副本删掉）。
//!
//! 暂存目录绑在句柄上（peer r5 P1-01 / P2-01，r6 P1-01 / P2-01）：调用方给的路径只在开头按名字找一次——最近的
//! 已存在的那一级打开、握住，缺的各级相对它新建（`NtCreateFile`，建出来的同时就握住）。之后清扫、新建副本、复制、
//! 删除都只经握住的句柄与它的真实路径，不再按调用方的路径找：路径中途被改指向别处（junction 换目标、上级被换掉），
//! 碰到的仍是开头握住的那些目录。握着的目录不共享删除，Windows 不许改名、删除它，也不许改名它的任何上级，所以它的
//! 真实路径在读的这段时间里不变。删除都按句柄：先不跟进地打开那一项（junction、符号链接打开的是链接自己，不算副本），
//! 核对类型，再对这个句柄删——删的就是核对过的那一个。此外：
//! - 副本目录独占新建（同名的已经在就换下一个序号，不打开、不删别人的）；
//! - 删副本（自己的和清扫到的）只删副本里会有的那几个普通文件、再删空目录，不递归删；
//! - 源库所在的目录与库文件本身按卷号 + 文件号认出来，清扫与删副本时碰到就不删（哪怕它在读的过程中被挪进暂存目录）；
//! - 只删这次新建的上级目录；调用方原有的暂存目录（哪怕是 junction）不碰。
//! - 几个读（几个进程）可以同时用同一个暂存目录：共用的那几级握着时谁都不要删除权，彼此打得开；这次新建的那几级
//!   丢掉时另行打开、核对身份再删，别的读还握着就留给它（W8 关口在 CI 上，见 `Scratch`）。

use std::ffi::{OsStr, OsString};
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
    let source = Source::of(db).map_err(Error::Open)?;
    let source_real = fs::canonicalize(source_dir)
        .map_err(|e| Error::Open(format!("{}: {e}", source_dir.display())))?;
    let mut held = Scratch::open(scratch).map_err(Error::Open)?;
    let real = held.real().map_err(Error::Open)?;
    // 握住的最深一级（还缺的各级会建在它下面）在源目录里：建出来的也在里面（peer r2 P2-01）。
    if real.starts_with(&source_real) {
        return Err(Error::Open(format!(
            "the scratch directory {} is inside {}",
            scratch.display(),
            source_dir.display()
        )));
    }
    // 反过来也不行：源库在暂存目录里的话，清扫会把它当成某个副本删掉（peer r4 P1-01）。暂存目录还不存在时里面什么都没有。
    if held.dir().is_some() && source_real.starts_with(&real) {
        return Err(Error::Open(format!(
            "the scratch directory {} contains {}",
            scratch.display(),
            source_dir.display()
        )));
    }
    #[cfg(test)]
    if let Some(hook) = tests::AFTER_CHECKS.with(|h| h.borrow_mut().take()) {
        hook();
    }
    sweep(&held, &source);
    let frozen = freeze(db, patience)?;
    if !hot_journal(db) && !wal_has_frames(db) {
        let c = open_immutable(db).map_err(Error::Open)?;
        let r = f(&c).map_err(Error::Read);
        drop(c);
        drop(frozen);
        return r;
    }
    let copy = Copy::make(db, &frozen, &mut held, source).map_err(Error::Open)?;
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
    drop(held);
    r
}

// ---------------------------------------------------------------- 冻结

/// 冻结中的源库：丢掉时按相反的次序解锁。
struct Frozen {
    db: File,
    /// 握着 SHARED 区（独占或共享）。
    shared: bool,
    shm: Option<File>,
}

impl Drop for Frozen {
    fn drop(&mut self) {
        if let Some(shm) = &self.shm {
            os::unlock(shm, SHM_WRITE_AND_CHECKPOINT, 2);
        }
        if self.shared {
            os::unlock(&self.db, SHARED_FIRST, SHARED_SIZE);
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
    if !os::try_lock(&file, PENDING_BYTE, 1, true) {
        return Ok(Err("a connection is starting or committing"));
    }
    let mut frozen = Frozen {
        db: file,
        shared: false,
        shm: None,
    };
    // 独占得到 SHARED 区：没有别的连接（新连接又被 PENDING 挡着）。独占不到就和别的连接一起共享：回滚日志模式的读者
    // 正在读，或者 WAL 模式的连接开着（它们一直握着 SHARED）。共享也拿不到，是有人握着 EXCLUSIVE。
    let others = if os::try_lock(&frozen.db, SHARED_FIRST, SHARED_SIZE, true) {
        false
    } else if os::try_lock(&frozen.db, SHARED_FIRST, SHARED_SIZE, false) {
        true
    } else {
        return Ok(Err("a connection holds the database exclusively"));
    };
    frozen.shared = true;
    if others && wal_mode(db, &frozen.db) {
        // 刚拿到 SHARED 的连接还没来得及建 `-shm`：等它建好。
        let Ok(shm) = File::open(sidecar(db, "-shm")) else {
            return Ok(Err("a connection is opening the write-ahead log"));
        };
        if !os::try_lock(&shm, SHM_WRITE_AND_CHECKPOINT, 2, true) {
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

// ---------------------------------------------------------------- 暂存目录

/// 源库的身份：它所在的目录与库文件本身。清扫与删副本时碰到这两个就不删。认不出来就不读。
#[derive(Clone, Copy)]
struct Source {
    dir: os::Id,
    db: os::Id,
}

impl Source {
    fn of(db: &Path) -> Result<Source, String> {
        let id = |p: &Path| os::identify(p).map_err(|e| format!("{}: {e}", p.display()));
        Ok(Source {
            dir: id(db.parent().unwrap_or(Path::new(".")))?,
            db: id(db)?,
        })
    }

    fn is(&self, id: os::Id) -> bool {
        id == self.dir || id == self.db
    }
}

/// 调用方给的暂存目录，绑在句柄上（见模块说明）：丢掉时按相反的次序删掉这次新建的各级（空了、也没有别的读握着
/// 才删得掉），原来就有的只放手。
///
/// 几个读（几个进程）可以同时用同一个暂存目录（W8 关口在 CI 上：两个 `doctor --offline` 同时读）。所以这几级
/// 握着时都不要删除权、也都不共享删除：彼此打得开，别人改不了名、删不掉。这次新建的那几级，丢掉时先放手，再相对
/// 仍握着的上一级不跟进地重新打开它、核对还是我们建的那一个（卷号 + 文件号）才删；别的读正握着它就打不开，留给它。
struct Scratch {
    /// 由浅到深握住的各级：先是最近的已存在的那一级，然后是这次新建或打开的；这次新建的带着名字与身份。
    held: Vec<(os::Handle, Option<(OsString, os::Id)>)>,
    /// 还缺的各级，由浅到深。
    missing: Vec<OsString>,
}

/// 共享冲突（`ERROR_SHARING_VIOLATION`）。另一个读正要删它这次新建、刚放手的那一级时，会短暂地出现。
fn sharing_violation(e: &io::Error) -> bool {
    e.raw_os_error() == Some(32)
}

/// 碰上共享冲突就等一会儿再试（最多约 1 s）：那一级要么很快删掉了（POSIX 语义，名字立即消失），要么放开了。
fn patiently<T>(mut f: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    for _ in 0..40 {
        match f() {
            Err(e) if sharing_violation(&e) => std::thread::sleep(Duration::from_millis(25)),
            other => return other,
        }
    }
    f()
}

impl Scratch {
    /// 按名字找最近的已存在的那一级，打开并握住；之后不再按 `scratch` 这个路径找。
    fn open(scratch: &Path) -> Result<Scratch, String> {
        let full =
            std::path::absolute(scratch).map_err(|e| format!("{}: {e}", scratch.display()))?;
        let mut missing = Vec::new();
        let mut at = full.as_path();
        let base = loop {
            match patiently(|| os::hold_dir(at)) {
                Ok(h) => break h,
                Err(e) if absent(&e) => match (at.parent(), at.file_name()) {
                    (Some(parent), Some(name)) => {
                        missing.push(name.to_os_string());
                        at = parent;
                    }
                    _ => return Err(format!("{} has no existing parent", scratch.display())),
                },
                Err(e) => return Err(format!("{}: {e}", at.display())),
            }
        };
        missing.reverse();
        Ok(Scratch {
            held: vec![(base, None)],
            missing,
        })
    }

    fn deepest(&self) -> &os::Handle {
        &self.held[self.held.len() - 1].0
    }

    /// 握住的最深一级的真实路径。
    fn real(&self) -> Result<PathBuf, String> {
        os::real_path(self.deepest()).map_err(|e| format!("the scratch directory: {e}"))
    }

    /// 暂存目录本身：已经存在、或这次已经建出来了。
    fn dir(&self) -> Option<&os::Handle> {
        self.missing.is_empty().then(|| self.deepest())
    }

    /// 建出还缺的各级，每一级相对握住的上一级新建；已经有了（别的读刚建的）就打开它，但不能是链接。
    /// 中途失败就报错，这次新建的在丢掉时拿掉（peer r3 P2-02）。
    fn create(&mut self) -> Result<&os::Handle, String> {
        while !self.missing.is_empty() {
            let name = self.missing.remove(0);
            let at = self.real()?.join(&name);
            let fail = |e: io::Error| format!("{}: {e}", at.display());
            let (h, made) = patiently(|| os::create_dir_in(self.deepest(), &name, false, false))
                .map_err(fail)?;
            let mine = if made {
                Some((name, os::id(&h).map_err(fail)?))
            } else {
                None
            };
            self.held.push((h, mine));
        }
        Ok(self.deepest())
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        while let Some((h, mine)) = self.held.pop() {
            drop(h);
            let (Some((name, id)), Some((parent, _))) = (mine, self.held.last()) else {
                continue;
            };
            #[cfg(test)]
            if let Some(hook) = tests::BEFORE_SHARED_DELETE.with(|h| h.borrow_mut().take()) {
                hook();
            }
            if let Ok(d) = os::open_child_to_delete(parent, &name)
                && os::id(&d).is_ok_and(|now| now == id)
            {
                delete_dir_patiently(&d);
            }
        }
    }
}

/// 删握着的目录；不空就等一会儿再试（最多约 1 s）。副本旁边会冒出别的程序的临时文件（实测有 `DB.SQLITE-SHM.tmp`，
/// 随建随删，见 `conversion.rs` 的 `publication_digest`），它还在时目录删不掉。那个文件不是我们的，不删它，等它自己消失；
/// 等不到就留着目录，下次清扫。
fn delete_dir_patiently(dir: &os::Handle) {
    const ERROR_DIR_NOT_EMPTY: i32 = 145;
    for _ in 0..40 {
        match os::delete(dir) {
            Err(e) if e.raw_os_error() == Some(ERROR_DIR_NOT_EMPTY) => {
                std::thread::sleep(Duration::from_millis(25));
            }
            _ => return,
        }
    }
}

/// 打开时「这一级不在」：找它的上一级。
fn absent(e: &io::Error) -> bool {
    const ERROR_INVALID_NAME: i32 = 123;
    e.kind() == io::ErrorKind::NotFound || e.raw_os_error() == Some(ERROR_INVALID_NAME)
}

// ---------------------------------------------------------------- 副本

/// 暂存目录下的一份副本，丢掉时删除（连同 SQLite 在副本旁建的文件）。目录是这次独占新建的，一直握着。
struct Copy {
    dir: os::Handle,
    db: PathBuf,
    source: Source,
}

impl Copy {
    /// 在冻结中复制：库文件、有帧的 `-wal`、热日志。
    fn make(
        db: &Path,
        frozen: &Frozen,
        scratch: &mut Scratch,
        source: Source,
    ) -> Result<Copy, String> {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let parent = scratch.create()?;
        let mut attempts = 0;
        let dir = loop {
            let name = format!(
                "read-{}-{}",
                std::process::id(),
                SEQ.fetch_add(1, Ordering::Relaxed)
            );
            match os::create_dir_in(parent, OsStr::new(&name), true, true) {
                Ok((h, _)) => break h,
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists && attempts < 1000 => {
                    attempts += 1;
                }
                Err(e) => return Err(format!("{name}: {e}")),
            }
        };
        let real = os::real_path(&dir).map_err(|e| format!("the copy directory: {e}"))?;
        let copy = Copy {
            db: real.join(COPY_FILES[0]),
            dir,
            source,
        };
        copy_database(&frozen.db, &copy.db).map_err(|e| format!("copy {}: {e}", db.display()))?;
        #[cfg(test)]
        if let Some(hook) = tests::AFTER_DATABASE_COPY.with(|h| h.borrow_mut().take()) {
            hook();
        }
        for (part, wanted) in [("-wal", wal_has_frames(db)), ("-journal", hot_journal(db))] {
            if wanted {
                let from = sidecar(db, part);
                copy_file(&from, &sidecar(&copy.db, part))
                    .map_err(|e| format!("copy {}: {e}", from.display()))?;
            }
        }
        Ok(copy)
    }
}

impl Drop for Copy {
    fn drop(&mut self) {
        remove_copy(&self.dir, &self.source, true);
    }
}

/// 清掉已经不在的进程留下的副本目录。只认 [`Copy::make`] 起的名字 `read-<pid>-<序号>`（两段都是数字），且必须是真目录
/// （junction、符号链接不跟进）；确知那个进程已经不在了才删。查不了（没有权限等）、pid 被别的进程重用了，都留着
/// （peer r3 P2-01）。在冻结之前做。每一项不跟进地打开、握住、核对之后，按句柄删（见模块说明）；源库所在的目录不碰。
fn sweep(scratch: &Scratch, source: &Source) {
    let Some(dir) = scratch.dir() else {
        return;
    };
    let Ok(real) = os::real_path(dir) else {
        return;
    };
    let Ok(entries) = fs::read_dir(&real) else {
        return;
    };
    for entry in entries.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(copy_pid) else {
            continue;
        };
        let Ok(copy) = os::open_entry(&real.join(entry.file_name()), true) else {
            continue;
        };
        match os::id(&copy) {
            Ok(id) if !source.is(id) => {}
            _ => continue,
        }
        if os::gone(pid) {
            remove_copy(&copy, source, false);
        }
    }
}

/// 副本目录里只会有这几个文件：库、复制过来的 `-wal` / 热日志，和打开副本时 SQLite 建的 `-shm`。
const COPY_FILES: [&str; 4] = [
    "db.sqlite",
    "db.sqlite-wal",
    "db.sqlite-journal",
    "db.sqlite-shm",
];

/// 只删副本的那几个文件（是普通文件、不是源库才删），再删目录（空了才删得掉）。别的东西一律留着。
/// 都按句柄：`dir` 是握着的那个目录，每个文件不跟进地打开、核对之后对它的句柄删。`patient`：自己的副本，
/// 目录一时不空就等一会儿（[`delete_dir_patiently`]）；清扫到的遗留副本不等，留到下次。
fn remove_copy(dir: &os::Handle, source: &Source, patient: bool) {
    let Ok(real) = os::real_path(dir) else {
        return;
    };
    #[cfg(test)]
    if let Some(hook) = tests::BEFORE_REMOVE.with(|h| h.borrow_mut().take()) {
        hook(&real);
    }
    for name in COPY_FILES {
        if let Ok(file) = os::open_entry(&real.join(name), false)
            && os::id(&file).is_ok_and(|id| !source.is(id))
        {
            let _ = os::delete(&file);
        }
    }
    if patient {
        delete_dir_patiently(dir);
    } else {
        let _ = os::delete(dir);
    }
}

/// 打开那个进程的结果 → 它确知已经不在了吗。`open_error`：打不开时系统给的错误码；`exit`：打开了、查到的退出码
/// （查不到是 `None`）。只有「没有这个进程」（`ERROR_INVALID_PARAMETER`）和「查到了、不是 `STILL_ACTIVE`」算不在；
/// 没有权限之类打不开、查不到退出码，都当它还在（peer r3 P2-01）。退出码恰好是 259 的进程也当它还在，宁可留着。
fn gone_by(open_error: Option<u32>, exit: Option<u32>) -> bool {
    const STILL_ACTIVE: u32 = 259;
    match open_error {
        Some(code) => code == os::ERROR_NO_SUCH_PROCESS,
        None => exit.is_some_and(|code| code != STILL_ACTIVE),
    }
}

/// `read-<pid>-<序号>` 里的 pid；名字不是这个样子就是 `None`。
fn copy_pid(name: &str) -> Option<u32> {
    let (pid, seq) = name.strip_prefix("read-")?.split_once('-')?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if digits(pid) && digits(seq) {
        pid.parse().ok()
    } else {
        None
    }
}

/// 把 `from` 复制成新建的 `to`（已经有同名的就失败，不覆盖）。
fn copy_file(from: &Path, to: &Path) -> io::Result<()> {
    let mut out = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(to)?;
    io::copy(&mut File::open(from)?, &mut out)?;
    Ok(())
}

/// 经冻结时的句柄复制库文件。PENDING 字节所在那一页 SQLite 从来不用，别的进程可能在上面握着锁、读不了：
/// 锁字节那 512 个字节写零。副本读完就删，不刷盘（少占冻结的时间）。
fn copy_database(from: &File, to: &Path) -> io::Result<()> {
    let len = from.metadata()?.len();
    let mut out = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(to)?;
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
    Ok(())
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

    /// 锁住 `[offset, offset + len)`（`exclusive` 时独占，否则共享），拿不到立即返回 false。
    pub fn try_lock(file: &File, offset: u64, len: u32, exclusive: bool) -> bool {
        let mut o = at(offset);
        let flags = LOCKFILE_FAIL_IMMEDIATELY
            | if exclusive {
                LOCKFILE_EXCLUSIVE_LOCK
            } else {
                0
            };
        // SAFETY: 句柄在 `file` 活着时有效；同步句柄上 LOCKFILE_FAIL_IMMEDIATELY 立即返回。
        unsafe { LockFileEx(file.as_raw_handle(), flags, 0, len, 0, &mut o) != 0 }
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

    /// 确知这个进程已经不在了：系统说没有这个 pid（`ERROR_INVALID_PARAMETER`），或打开了、它已经退出。
    /// 打不开的别的原因（没有权限等）不算。
    pub fn gone(pid: u32) -> bool {
        use windows_sys::Win32::Foundation::{CloseHandle, GetLastError};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        // SAFETY: 只查询；打开的句柄在返回前关掉。
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return super::gone_by(Some(GetLastError()), None);
            }
            let mut code = 0u32;
            let exit = (GetExitCodeProcess(h, &mut code) != 0).then_some(code);
            CloseHandle(h);
            super::gone_by(None, exit)
        }
    }

    /// 握着的目录或文件。
    pub type Handle = File;
    /// 身份：卷序列号与文件号。
    pub type Id = (u32, u32, u32);

    use std::io;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::FromRawHandle;
    use std::path::{Path, PathBuf};
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, DELETE, FILE_ADD_FILE, FILE_ADD_SUBDIRECTORY,
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY,
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE,
        SYNCHRONIZE,
    };

    /// 握着目录时要的权限：列、穿过、在里面建、读属性。
    const HOLD: u32 = FILE_LIST_DIRECTORY
        | FILE_TRAVERSE
        | FILE_ADD_FILE
        | FILE_ADD_SUBDIRECTORY
        | FILE_READ_ATTRIBUTES
        | SYNCHRONIZE;
    /// 握着目录时不共享删除：它不能被改名、删除，它的上级也不能被改名。
    const NO_DELETE: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE;

    fn info(f: &File) -> io::Result<BY_HANDLE_FILE_INFORMATION> {
        use windows_sys::Win32::Storage::FileSystem::GetFileInformationByHandle;
        // SAFETY: 全零是合法的初值；句柄在 `f` 活着时有效。
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(f.as_raw_handle(), &mut info) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(info)
    }

    pub fn id(f: &File) -> io::Result<Id> {
        let i = info(f)?;
        Ok((i.dwVolumeSerialNumber, i.nFileIndexHigh, i.nFileIndexLow))
    }

    /// 按路径认出 `path` 指的那个东西（跟进链接）。
    pub fn identify(path: &Path) -> io::Result<Id> {
        let f = std::fs::OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)?;
        id(&f)
    }

    fn not(what: &str) -> io::Error {
        io::Error::new(io::ErrorKind::InvalidInput, what.to_string())
    }

    /// 按路径打开目录并握住（跟进链接：握住的是真正的那个目录）。
    pub fn hold_dir(path: &Path) -> io::Result<File> {
        let f = std::fs::OpenOptions::new()
            .access_mode(HOLD)
            .share_mode(NO_DELETE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)?;
        if info(&f)?.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
            return Err(not("not a directory"));
        }
        Ok(f)
    }

    /// 不跟进地打开 `path` 这一项本身（junction、符号链接打开的是链接自己），以便按句柄删除。`dir` 时要求是真目录并握住，
    /// 否则要求是普通文件；是链接、类型不对都报错。
    pub fn open_entry(path: &Path, dir: bool) -> io::Result<File> {
        let (access, share) = if dir {
            (HOLD | DELETE, NO_DELETE)
        } else {
            (
                DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            )
        };
        let f = std::fs::OpenOptions::new()
            .access_mode(access)
            .share_mode(share)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        let a = info(&f)?.dwFileAttributes;
        if a & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(not("a link"));
        }
        if (a & FILE_ATTRIBUTE_DIRECTORY != 0) != dir {
            return Err(not(if dir {
                "not a directory"
            } else {
                "a directory"
            }));
        }
        Ok(f)
    }

    /// 在握着的 `parent` 里建名为 `name` 的目录并握住（`NtCreateFile` 相对 `parent`：建出来的同时就握住，中间没有
    /// 可被换掉的空档）。`exclusive` 时已有同名的就报 AlreadyExists；否则打开已有的那个，但它不能是链接。
    /// 返回的 `bool` 是不是这次新建的。
    ///
    /// `delete`：握住时连删除权一起要，好在丢掉时按这个句柄删。只有这次读独有的目录（副本目录）才要：几个读共用的
    /// 那几级（暂存目录本身和它缺的上级）谁握着删除权，别的读按 `NO_DELETE` 就打不开它（W8 关口在 CI 上：两个
    /// `doctor --offline` 同时读，后来的那个报共享冲突）。共用的那几级在丢掉时另按 [`open_child_to_delete`] 删。
    pub fn create_dir_in(
        parent: &File,
        name: &std::ffi::OsStr,
        exclusive: bool,
        delete: bool,
    ) -> io::Result<(File, bool)> {
        use windows_sys::Wdk::Storage::FileSystem::{FILE_CREATE, FILE_OPEN_IF};
        let access = if delete { HOLD | DELETE } else { HOLD };
        let disposition = if exclusive { FILE_CREATE } else { FILE_OPEN_IF };
        let (f, made) = open_in(parent, name, access, NO_DELETE, disposition)?;
        if !made && info(&f)?.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(not("a link"));
        }
        Ok((f, made))
    }

    /// 为了删除，相对握着的 `parent` 不跟进地打开名为 `name` 的目录：是链接、不是目录都报错。只要删除与读属性，
    /// 共享一切；但别人正握着它（握的时候不共享删除）就打不开，报共享冲突，这时它不归我们删。
    pub fn open_child_to_delete(parent: &File, name: &std::ffi::OsStr) -> io::Result<File> {
        use windows_sys::Wdk::Storage::FileSystem::FILE_OPEN;
        let (f, _) = open_in(
            parent,
            name,
            DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            FILE_OPEN,
        )?;
        if info(&f)?.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(not("a link"));
        }
        Ok(f)
    }

    /// `NtCreateFile` 相对 `parent` 打开（或建）名为 `name` 的目录，不跟进链接。返回句柄和是不是这次新建的。
    fn open_in(
        parent: &File,
        name: &std::ffi::OsStr,
        access: u32,
        share: u32,
        disposition: u32,
    ) -> io::Result<(File, bool)> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
        use windows_sys::Wdk::Storage::FileSystem::{
            FILE_DIRECTORY_FILE, FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT,
            NtCreateFile,
        };
        use windows_sys::Win32::Foundation::{
            HANDLE, OBJ_CASE_INSENSITIVE, RtlNtStatusToDosError, UNICODE_STRING,
        };
        use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;
        const FILE_CREATED: usize = 2;
        let wide: Vec<u16> = name.encode_wide().collect();
        let bytes = u16::try_from(wide.len() * 2).map_err(|_| not("a name that is too long"))?;
        let us = UNICODE_STRING {
            Length: bytes,
            MaximumLength: bytes,
            Buffer: wide.as_ptr() as *mut u16,
        };
        let oa = OBJECT_ATTRIBUTES {
            Length: std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
            RootDirectory: parent.as_raw_handle(),
            ObjectName: &us,
            Attributes: OBJ_CASE_INSENSITIVE,
            SecurityDescriptor: std::ptr::null(),
            SecurityQualityOfService: std::ptr::null(),
        };
        let mut h: HANDLE = std::ptr::null_mut();
        // SAFETY: 全零是合法的初值。
        let mut iosb: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
        // SAFETY: 名字、属性块在调用期间有效；`parent` 是打开着的目录句柄；成功时 `h` 归我们所有。
        let status = unsafe {
            NtCreateFile(
                &mut h,
                access,
                &oa,
                &mut iosb,
                std::ptr::null(),
                FILE_ATTRIBUTE_NORMAL,
                share,
                disposition,
                FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
                std::ptr::null(),
                0,
            )
        };
        if status < 0 {
            // SAFETY: 只换算错误码。
            let code = unsafe { RtlNtStatusToDosError(status) };
            return Err(io::Error::from_raw_os_error(code as i32));
        }
        // SAFETY: 成功时 `h` 是新打开的句柄，交给 `File` 关闭。
        let f = unsafe { File::from_raw_handle(h) };
        Ok((f, iosb.Information == FILE_CREATED))
    }

    /// 握着的东西的真实路径（`\\?\` 形式，链接都已解开）。
    pub fn real_path(f: &File) -> io::Result<PathBuf> {
        use std::os::windows::ffi::OsStringExt;
        use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
        let mut buf = vec![0u16; 512];
        loop {
            // SAFETY: 缓冲区长度如实给出；句柄在 `f` 活着时有效。
            let n = unsafe {
                GetFinalPathNameByHandleW(f.as_raw_handle(), buf.as_mut_ptr(), buf.len() as u32, 0)
            } as usize;
            if n == 0 {
                return Err(io::Error::last_os_error());
            }
            if n < buf.len() {
                return Ok(PathBuf::from(std::ffi::OsString::from_wide(&buf[..n])));
            }
            buf.resize(n + 1, 0);
        }
    }

    /// 按句柄删除：删的就是这个句柄打开的那一个。目录不空时失败。按 POSIX 语义删（名字立即消失，别的程序还开着它也不留
    /// 「待删除」的名字挡住上级目录的删除）；文件系统不支持就退回普通的删除标记。
    pub fn delete(f: &File) -> io::Result<()> {
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
            FILE_DISPOSITION_INFO, FILE_DISPOSITION_INFO_EX, FileDispositionInfo,
            FileDispositionInfoEx, SetFileInformationByHandle,
        };
        let ex = FILE_DISPOSITION_INFO_EX {
            Flags: FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
        };
        // SAFETY: 结构体与长度如实给出；句柄在 `f` 活着时有效。
        if unsafe {
            SetFileInformationByHandle(
                f.as_raw_handle(),
                FileDispositionInfoEx,
                (&ex as *const FILE_DISPOSITION_INFO_EX).cast(),
                std::mem::size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
            )
        } != 0
        {
            return Ok(());
        }
        let err = io::Error::last_os_error();
        const ERROR_INVALID_FUNCTION: i32 = 1;
        const ERROR_NOT_SUPPORTED: i32 = 50;
        const ERROR_INVALID_PARAMETER: i32 = 87;
        if !matches!(
            err.raw_os_error(),
            Some(ERROR_INVALID_FUNCTION | ERROR_NOT_SUPPORTED | ERROR_INVALID_PARAMETER)
        ) {
            return Err(err);
        }
        let plain = FILE_DISPOSITION_INFO { DeleteFile: true };
        // SAFETY: 同上。
        if unsafe {
            SetFileInformationByHandle(
                f.as_raw_handle(),
                FileDispositionInfo,
                (&plain as *const FILE_DISPOSITION_INFO).cast(),
                std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        } != 0
        {
            return Ok(());
        }
        Err(io::Error::last_os_error())
    }

    /// 打开一个不存在的 pid 时系统给的错误码。
    pub const ERROR_NO_SUCH_PROCESS: u32 = windows_sys::Win32::Foundation::ERROR_INVALID_PARAMETER;
}

/// 只在 Windows 上发行；别的平台上（只为能编译、跑与锁无关的用例）不加锁。
#[cfg(not(windows))]
mod os {
    use std::fs::File;
    use std::os::unix::fs::FileExt;

    pub fn try_lock(_file: &File, _offset: u64, _len: u32, _exclusive: bool) -> bool {
        true
    }

    pub fn unlock(_file: &File, _offset: u64, _len: u32) {}

    pub fn read_at(file: &File, offset: u64, buf: &mut [u8]) -> std::io::Result<usize> {
        file.read_at(buf, offset)
    }

    pub fn gone(_pid: u32) -> bool {
        false
    }

    pub const ERROR_NO_SUCH_PROCESS: u32 = 87;

    // 按路径做的近似实现：只为能编译、跑与句柄无关的用例。
    use std::io;
    use std::os::unix::fs::MetadataExt;
    use std::path::{Path, PathBuf};

    pub struct Handle(PathBuf);
    pub type Id = (u64, u64);

    pub fn id(h: &Handle) -> io::Result<Id> {
        let m = std::fs::symlink_metadata(&h.0)?;
        Ok((m.dev(), m.ino()))
    }

    pub fn identify(path: &Path) -> io::Result<Id> {
        let m = std::fs::metadata(path)?;
        Ok((m.dev(), m.ino()))
    }

    pub fn hold_dir(path: &Path) -> io::Result<Handle> {
        if !std::fs::metadata(path)?.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "not a directory",
            ));
        }
        Ok(Handle(std::fs::canonicalize(path)?))
    }

    pub fn open_entry(path: &Path, dir: bool) -> io::Result<Handle> {
        let t = std::fs::symlink_metadata(path)?.file_type();
        if t.is_symlink() || t.is_dir() != dir {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a copy"));
        }
        Ok(Handle(path.to_path_buf()))
    }

    pub fn open_child_to_delete(parent: &Handle, name: &std::ffi::OsStr) -> io::Result<Handle> {
        open_entry(&parent.0.join(name), true)
    }

    pub fn create_dir_in(
        parent: &Handle,
        name: &std::ffi::OsStr,
        exclusive: bool,
        _delete: bool,
    ) -> io::Result<(Handle, bool)> {
        let path = parent.0.join(name);
        match std::fs::create_dir(&path) {
            Ok(()) => Ok((Handle(path), true)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists && !exclusive => {
                open_entry(&path, true).map(|h| (h, false))
            }
            Err(e) => Err(e),
        }
    }

    pub fn real_path(h: &Handle) -> io::Result<PathBuf> {
        Ok(h.0.clone())
    }

    pub fn delete(h: &Handle) -> io::Result<()> {
        if std::fs::symlink_metadata(&h.0)?.is_dir() {
            std::fs::remove_dir(&h.0)
        } else {
            std::fs::remove_file(&h.0)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::sync::mpsc;

    pub(super) type RemoveHook = Box<dyn FnOnce(&Path)>;

    thread_local! {
        /// 核对完暂存目录、清扫之前调一次（只在单元测试里有）。
        pub(super) static AFTER_CHECKS: RefCell<Option<Box<dyn FnOnce()>>> =
            const { RefCell::new(None) };
        /// 删副本之前调一次，给出副本目录的真实路径（只在单元测试里有）。
        pub(super) static BEFORE_REMOVE: RefCell<Option<RemoveHook>> = const { RefCell::new(None) };
        /// 复制完库文件、还没复制 `-wal` 时调一次（只在单元测试里有）。
        pub(super) static AFTER_DATABASE_COPY: RefCell<Option<Box<dyn FnOnce()>>> =
            const { RefCell::new(None) };
        /// 放开这次新建的一级、重新打开它来删之前调一次（只在单元测试里有）。
        pub(super) static BEFORE_SHARED_DELETE: RefCell<Option<Box<dyn FnOnce()>>> =
            const { RefCell::new(None) };
    }

    fn dir(name: &str) -> PathBuf {
        let target = std::env::var_os("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("target")
            });
        // 规范的绝对路径（W8 关口在 CI 上）：没设 CARGO_TARGET_DIR 时原来是 `store/../target`，交给
        // `cmd /c mklink` 时那个 `/` 被当成开关。
        let target = std::path::absolute(target).unwrap();
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

    /// peer r3 P2-01：只有确知进程不在了才清它的副本；查不了的当它还在。
    #[test]
    fn a_process_is_gone_only_when_windows_says_so() {
        const ACCESS_DENIED: u32 = 5;
        assert!(gone_by(Some(os::ERROR_NO_SUCH_PROCESS), None));
        assert!(!gone_by(Some(ACCESS_DENIED), None));
        assert!(gone_by(None, Some(0)));
        assert!(!gone_by(None, Some(259)));
        assert!(!gone_by(None, None));
        assert!(!os::gone(std::process::id()));
        assert_eq!(copy_pid("read-12-3"), Some(12));
        for name in [
            "read-12",
            "read-12-",
            "read--3",
            "read-12-3x",
            "read-x-3",
            "copy-12-3",
        ] {
            assert_eq!(copy_pid(name), None, "{name}");
        }
    }

    /// peer r3 P1-01：复制完库文件、还没复制 `-wal` 时，最后一个开着的连接关掉。它关闭时从 SHARED 直接要 EXCLUSIVE
    /// 去 checkpoint 并删 `-wal`，不经过 PENDING。冻结握着 SHARED 区，它拿不到，`-wal` 留着：副本里有那次已提交的写。
    #[test]
    fn the_last_wal_connection_closing_during_the_copy_does_not_take_the_wal_away() {
        let d = dir("last-close");
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
        AFTER_DATABASE_COPY.with(|h| *h.borrow_mut() = Some(Box::new(move || drop(live))));
        let q = |c: &Connection| {
            c.query_row("SELECT (SELECT x FROM l), (SELECT x FROM r)", [], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
            })
        };
        assert_eq!(read(&db, &d.join("scratch"), q).unwrap(), (1, 0));
        // 那个连接关闭时没能 checkpoint：`-wal` 还在，下一次读照样读到它。
        assert!(wal_has_frames(&db));
        assert_eq!(read(&db, &d.join("scratch"), q).unwrap(), (1, 0));
    }

    /// 一个 WAL 库，`-wal` 里有帧（读它要复制）；连接留着，帧就一直在。
    fn wal_source(d: &Path, name: &str, x: i64) -> (PathBuf, Connection) {
        let src = d.join(name);
        fs::create_dir_all(&src).unwrap();
        let db = src.join("source.sqlite");
        let live = Connection::open(&db).unwrap();
        live.execute_batch(&format!(
            "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
             CREATE TABLE t(x); INSERT INTO t VALUES ({x});"
        ))
        .unwrap();
        assert!(wal_has_frames(&db));
        (db, live)
    }

    fn value(c: &Connection) -> rusqlite::Result<i64> {
        c.query_row("SELECT x FROM t", [], |r| r.get(0))
    }

    /// W8 关口在 CI 上：两个读同时用同一个还不存在的暂存目录。先到的那个建出它；以前它连删除权一起握着，后到的那个
    /// 按不共享删除就打不开，报共享冲突（`doctor --offline` 并行时的 os error 32）。现在两个都读得出，
    /// 读完后这次新建的各级照样删掉。
    #[test]
    fn two_reads_share_a_scratch_directory_that_one_of_them_creates() {
        let d = dir("shared-scratch");
        let (outer, outer_live) = wal_source(&d, "outer", 1);
        let (inner, inner_live) = wal_source(&d, "inner", 2);
        let scratch = d.join("scratch").join("shared");
        let at = scratch.clone();
        let got = std::rc::Rc::new(RefCell::new(None));
        let slot = got.clone();
        AFTER_DATABASE_COPY.with(|h| {
            *h.borrow_mut() = Some(Box::new(move || {
                // 这时外面那个读握着它新建的两级，副本也在里面。
                assert!(at.is_dir());
                *slot.borrow_mut() = Some(read(&inner, &at, value).map_err(|e| format!("{e:?}")));
            }));
        });
        assert_eq!(read(&outer, &scratch, value).unwrap(), 1);
        assert_eq!(got.borrow_mut().take(), Some(Ok(2)));
        assert!(
            !d.join("scratch").exists(),
            "the levels this read made are removed"
        );
        drop((outer_live, inner_live));
    }

    /// 读完要删这次新建的暂存目录时，别人还握着它（另一个读正在用）：打不开、不删，留给它；读照样成功。
    #[test]
    fn a_scratch_directory_another_read_still_holds_is_left_to_it() {
        let d = dir("held-scratch");
        let (db, live) = wal_source(&d, "src", 7);
        let scratch = d.join("scratch");
        let at = scratch.clone();
        let other = std::rc::Rc::new(RefCell::new(None));
        let slot = other.clone();
        AFTER_DATABASE_COPY.with(|h| {
            *h.borrow_mut() = Some(Box::new(move || {
                *slot.borrow_mut() = Some(os::hold_dir(&at).unwrap());
            }));
        });
        assert_eq!(read(&db, &scratch, value).unwrap(), 7);
        assert!(other.borrow().is_some(), "the other holder opened it");
        assert!(scratch.is_dir(), "left to the read that still holds it");
        drop(other.borrow_mut().take());
        // 下一次读照样用它；它不是这次新建的，读完不删。
        assert_eq!(read(&db, &scratch, value).unwrap(), 7);
        assert!(scratch.is_dir());
        drop(live);
    }

    /// 放开这次新建的暂存目录、还没重新打开它来删的空档里，它被改了名、原处又建了一个同名的目录：那不是我们建的
    /// （身份对不上），不删。挪走的那个也不按名字找回来删，留着。
    #[test]
    fn a_scratch_directory_swapped_before_the_delete_is_not_ours_to_delete() {
        let d = dir("swapped-scratch");
        let (db, live) = wal_source(&d, "src", 3);
        let scratch = d.join("scratch");
        let (at, moved) = (scratch.clone(), d.join("moved"));
        let swapped = std::rc::Rc::new(std::cell::Cell::new(false));
        let seen = swapped.clone();
        BEFORE_SHARED_DELETE.with(|h| {
            *h.borrow_mut() = Some(Box::new(move || {
                fs::rename(&at, &moved).unwrap();
                fs::create_dir(&at).unwrap();
                seen.set(true);
            }));
        });
        assert_eq!(read(&db, &scratch, value).unwrap(), 3);
        assert!(swapped.get(), "the hook ran");
        assert!(
            scratch.is_dir(),
            "the directory now under that name is not ours"
        );
        assert!(d.join("moved").is_dir());
        drop(live);
    }

    /// 另一个读正带着删除权打开暂存目录（它正要删自己新建的那一级）时，这次读按不共享删除打不开它：等一会儿再试，
    /// 不报错。
    #[test]
    fn a_scratch_directory_another_read_is_deleting_is_waited_for() {
        let d = dir("deleting-scratch");
        let (db, live) = wal_source(&d, "src", 5);
        let scratch = d.join("scratch");
        fs::create_dir_all(&scratch).unwrap();
        let parent = os::hold_dir(&d).unwrap();
        let deleting = os::open_child_to_delete(&parent, OsStr::new("scratch")).unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            drop(deleting);
        });
        assert_eq!(read(&db, &scratch, value).unwrap(), 5);
        release.join().unwrap();
        drop((parent, live));
    }

    /// peer r5 P1-01：检查时暂存目录还不存在，检查完、清扫前它被建成指向源库上级的 junction。清扫要重新看一次：
    /// 这时暂存目录包含源库，整个不清。源库就叫 `db.sqlite`、在 `read-<已退出的 pid>-1\` 里，和一个遗留副本分不出来——
    /// 只删副本文件也会删到它，所以这里靠的是重查；源库与旁边的文件都原样。
    #[test]
    fn a_scratch_that_turns_into_a_link_after_the_checks_is_not_swept() {
        let d = dir("late-link");
        let actual = d.join("actual");
        let root = actual.join("read-4294967295-1");
        fs::create_dir_all(&root).unwrap();
        let db = root.join("db.sqlite");
        let c = Connection::open(&db).unwrap();
        c.execute_batch("CREATE TABLE marker(x); INSERT INTO marker VALUES (1);")
            .unwrap();
        drop(c);
        fs::write(root.join("user-file.txt"), b"must remain").unwrap();
        let original = fs::read(&db).unwrap();
        let scratch = d.join("late-scratch");
        let link = scratch.clone();
        AFTER_CHECKS.with(|h| {
            *h.borrow_mut() = Some(Box::new(move || {
                assert!(!link.exists());
                let r = std::process::Command::new("cmd")
                    .arg("/c")
                    .arg("mklink")
                    .arg("/J")
                    .arg(&link)
                    .arg(&actual)
                    .output()
                    .unwrap();
                assert!(r.status.success(), "{r:?}");
            }))
        });
        let v = read(&db, &scratch, |c| {
            c.query_row("SELECT x FROM marker", [], |r| r.get::<_, i64>(0))
        });
        assert!(scratch.exists(), "the hook did not run");
        assert_eq!(v.unwrap(), 1);
        assert_eq!(fs::read(&db).unwrap(), original);
        assert_eq!(
            fs::read(root.join("user-file.txt")).unwrap(),
            b"must remain"
        );
    }

    /// peer r6 P1-01：检查之后，源库所在的目录被整个挪进暂存目录，名字像一个遗留副本（`read-<已退出的 pid>-1`，
    /// 库就叫 `db.sqlite`，旁边留着有帧的 `-wal`）；或者只把库文件挪进一个遗留副本里。清扫按卷号 + 文件号认出源库所在的
    /// 目录与库文件，不删（`-wal` 只靠认出目录）。挪走之后原路径没了，读报错；挪过去的源库、`-wal` 与旁边的文件都原样。
    #[test]
    fn a_source_moved_into_the_scratch_after_the_checks_is_not_swept() {
        for whole_directory in [true, false] {
            let d = dir(if whole_directory {
                "moved-source-dir"
            } else {
                "moved-source-db"
            });
            let src = d.join("src");
            fs::create_dir_all(&src).unwrap();
            let db = src.join("db.sqlite");
            let c = Connection::open(&db).unwrap();
            if whole_directory {
                // 关闭时不删 `-wal`、不 checkpoint：源目录里留着有帧的 `db.sqlite-wal`。
                let mut persist = 1i32;
                // SAFETY: 连接开着；参数是 `int*`。
                let rc = unsafe {
                    rusqlite::ffi::sqlite3_file_control(
                        c.handle(),
                        c"main".as_ptr(),
                        rusqlite::ffi::SQLITE_FCNTL_PERSIST_WAL,
                        (&mut persist as *mut i32).cast(),
                    )
                };
                assert_eq!(rc, 0);
                c.execute_batch(
                    "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
                     CREATE TABLE marker(x); INSERT INTO marker VALUES (1);",
                )
                .unwrap();
            } else {
                c.execute_batch("CREATE TABLE marker(x); INSERT INTO marker VALUES (1);")
                    .unwrap();
            }
            drop(c);
            assert_eq!(wal_has_frames(&db), whole_directory);
            fs::write(src.join("user-file.txt"), b"must remain").unwrap();
            let original = fs::read(&db).unwrap();
            let wal = fs::read(sidecar(&db, "-wal")).ok();
            let scratch = d.join("scratch");
            let left = scratch.join("read-4294967295-1");
            let moved = if whole_directory {
                fs::create_dir_all(&scratch).unwrap();
                left.join("db.sqlite")
            } else {
                fs::create_dir_all(&left).unwrap();
                left.join("db.sqlite")
            };
            let (from_dir, from_db, to) = (src.clone(), db.clone(), left.clone());
            AFTER_CHECKS.with(|h| {
                *h.borrow_mut() = Some(Box::new(move || {
                    if whole_directory {
                        fs::rename(&from_dir, &to).unwrap();
                    } else {
                        fs::rename(&from_db, to.join("db.sqlite")).unwrap();
                    }
                }))
            });
            let v = read(&db, &scratch, |c| {
                c.query_row("SELECT x FROM marker", [], |r| r.get::<_, i64>(0))
            });
            assert!(v.is_err(), "{v:?}");
            assert_eq!(
                fs::read(&moved).unwrap(),
                original,
                "whole directory: {whole_directory}"
            );
            if whole_directory {
                assert_eq!(
                    fs::read(left.join("user-file.txt")).unwrap(),
                    b"must remain"
                );
                assert_eq!(
                    fs::read(left.join("db.sqlite-wal")).ok(),
                    wal,
                    "the source's -wal"
                );
            }
        }
    }

    /// peer r6 P1-01：删副本时（读完、SQLite 已经关掉，副本目录里没有别的打开的文件），副本目录与它的上级都不能被改名：
    /// 握着它、不共享删除。它的真实路径不变，按它打开、删掉的就是副本里的文件。
    #[test]
    fn a_copy_cannot_be_moved_while_it_is_removed() {
        let d = dir("held-while-removed");
        fs::create_dir_all(d.join("src")).unwrap();
        let db = d.join("src").join("source.sqlite");
        let live = Connection::open(&db).unwrap();
        live.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
             CREATE TABLE marker(x); INSERT INTO marker VALUES (1);",
        )
        .unwrap();
        assert!(wal_has_frames(&db));
        let scratch = d.join("scratch");
        fs::create_dir_all(&scratch).unwrap();
        let tried = std::rc::Rc::new(RefCell::new(Vec::new()));
        let seen = tried.clone();
        BEFORE_REMOVE.with(|h| {
            *h.borrow_mut() = Some(Box::new(move |real: &Path| {
                for from in [real.to_path_buf(), real.parent().unwrap().to_path_buf()] {
                    let to = PathBuf::from(format!("{}-moved", from.display()));
                    seen.borrow_mut()
                        .push((from.clone(), fs::rename(&from, &to).is_ok()));
                }
            }))
        });
        let v = read(&db, &scratch, |c| {
            c.query_row("SELECT x FROM marker", [], |r| r.get::<_, i64>(0))
        });
        assert_eq!(v.unwrap(), 1);
        assert_eq!(tried.borrow().len(), 2, "the hook did not run");
        for (from, moved) in tried.borrow().iter() {
            assert!(
                !moved,
                "{} was moved while the copy was removed",
                from.display()
            );
        }
        assert_eq!(
            fs::read_dir(&scratch).unwrap().count(),
            0,
            "the copy is left"
        );
        drop(live);
    }

    /// 检查时暂存目录还不在，之后别人（例如同时在读的另一个进程）把它建了出来：这次相对上一级打开的是那个现成的，
    /// 不是这次建的，读完不删它；这次自己的副本照样删掉。
    #[test]
    fn a_scratch_someone_else_made_meanwhile_is_kept() {
        let d = dir("made-meanwhile");
        fs::create_dir_all(d.join("src")).unwrap();
        let db = d.join("src").join("source.sqlite");
        let live = Connection::open(&db).unwrap();
        live.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
             CREATE TABLE marker(x); INSERT INTO marker VALUES (1);",
        )
        .unwrap();
        assert!(wal_has_frames(&db));
        let scratch = d.join("scratch");
        let other = scratch.clone();
        AFTER_CHECKS.with(|h| {
            *h.borrow_mut() = Some(Box::new(move || {
                assert!(!other.exists());
                fs::create_dir(&other).unwrap();
            }))
        });
        let v = read(&db, &scratch, |c| {
            c.query_row("SELECT x FROM marker", [], |r| r.get::<_, i64>(0))
        });
        assert_eq!(v.unwrap(), 1);
        assert!(
            scratch.is_dir(),
            "a scratch this read did not make was removed"
        );
        assert_eq!(
            fs::read_dir(&scratch).unwrap().count(),
            0,
            "the copy is left"
        );
        drop(live);
    }
}
