//! 不写源目录地读一个 SQLite 库：启动判定、安装探测、离线诊断（W8 关口 peer r1 P1-01 / P1-02）。
//!
//! 只读连接（`SQLITE_OPEN_READ_ONLY`）对 WAL 库并不只读：没有 `-shm` 就建一个，有就改它的读标记，没有 `-wal`
//! 还会建一个空的（rusqlite 0.39 自带的 SQLite 实测）。读写连接更不行：最后一个连接关闭时会 checkpoint、删 `-wal`，
//! 坏库的原字节就没了。`immutable=1` 什么都不写，但看不到 `-wal` 里已提交的内容，也无视热回滚日志、读到半截的页。
//! 所以这里分两条路：
//! - 没有热回滚日志、`-wal` 不在或为空：按 `immutable` 读源文件本身；
//! - 否则把库与 `-wal`、热日志复制进调用方给的暂存目录，在副本上正常打开（SQLite 在副本上回滚日志、恢复 WAL），
//!   读完删掉副本。源目录一个字节不动，也不多出文件。
//!
//! 复制时别的进程可能还在写（安装探测时旧版在服务）：复制前后源文件的大小与修改时间变了就重来，最多三次；仍在变
//! 就用最后一份，读不出由调用方照实报告。超过 1 GiB 的库在 Windows 上有 SQLite 锁住的那一页，别的进程开着时复制会
//! 失败，同样照实报告。

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

use rusqlite::{Connection, OpenFlags};

/// 回滚日志头的魔数（SQLite 文件格式 §4.1）。
const JOURNAL_MAGIC: [u8; 8] = [0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7];

/// 读不出的原因：打不开（含复制失败），或打开了、查询失败。
#[derive(Debug)]
pub enum Error<E> {
    Open(String),
    Read(E),
}

fn sidecar(db: &Path, suffix: &str) -> PathBuf {
    let mut s = db.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

/// SQLite 打开时会回滚的那种日志：`-journal` 在，且以日志头的魔数开头。
/// 空的、头被清零的（`journal_mode=TRUNCATE` / `PERSIST` 提交后留下的）是冷的，SQLite 不理它，这里也不理。
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

/// 按 `immutable` 只读打开：SQLite 不建、不改任何文件，也不看 `-wal` 与回滚日志。
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

/// 读 `db`，源目录不写：能 `immutable` 就直接读，否则在 `scratch` 下的副本上读（见模块说明）。
/// `scratch` 必须不在库所在的目录里。
pub fn read<T, E>(
    db: &Path,
    scratch: &Path,
    f: impl Fn(&Connection) -> Result<T, E>,
) -> Result<T, Error<E>> {
    if !db.is_file() {
        return Err(Error::Open(format!("{} is missing", db.display())));
    }
    if !hot_journal(db) && !wal_has_frames(db) {
        let c = open_immutable(db).map_err(Error::Open)?;
        return f(&c).map_err(Error::Read);
    }
    let copy = Copy::make(db, scratch).map_err(Error::Open)?;
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

/// `scratch` 下的一份副本，丢掉时删除（连同 SQLite 在副本旁建的文件）。
struct Copy {
    dir: PathBuf,
    db: PathBuf,
}

impl Copy {
    fn make(db: &Path, scratch: &Path) -> Result<Copy, String> {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let source_dir = db.parent().unwrap_or(Path::new("."));
        if let (Ok(s), Ok(d)) = (fs::canonicalize(scratch), fs::canonicalize(source_dir))
            && s.starts_with(&d)
        {
            return Err(format!(
                "the scratch directory {} is inside {}",
                scratch.display(),
                source_dir.display()
            ));
        }
        let dir = scratch.join(format!(
            "read-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let copy = Copy {
            db: dir.join("db.sqlite"),
            dir,
        };
        let parts = ["", "-wal", "-journal"];
        for _ in 0..3 {
            let before = stamps(db, &parts);
            for part in parts {
                let to = sidecar(&copy.db, part);
                let _ = fs::remove_file(&to);
                let from = sidecar(db, part);
                let wanted = match part {
                    "" => true,
                    "-wal" => wal_has_frames(db),
                    _ => hot_journal(db),
                };
                if wanted {
                    fs::copy(&from, &to).map_err(|e| format!("copy {}: {e}", from.display()))?;
                }
            }
            if stamps(db, &parts) == before {
                break;
            }
        }
        Ok(copy)
    }
}

impl Drop for Copy {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
        // 暂存目录本身空了就一并拿掉（不是空的说明别的读还在用，留着）。
        if let Some(parent) = self.dir.parent() {
            let _ = fs::remove_dir(parent);
        }
    }
}

fn stamps(db: &Path, parts: &[&str]) -> Vec<Option<(u64, Option<SystemTime>)>> {
    parts
        .iter()
        .map(|part| {
            fs::metadata(sidecar(db, part))
                .ok()
                .map(|m| (m.len(), m.modified().ok()))
        })
        .collect()
}
