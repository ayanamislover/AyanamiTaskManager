//! 持久化契约（07 §1；W3 peer r1 P2-04）。store 与 setup 共用这一份，不各写各的。
//!
//! - **改名**：[`rename`] 是 `MoveFileExW(WRITE_THROUGH [| REPLACE_EXISTING])`，返回时改名已落盘。
//!   `std::fs::rename` 不带 WRITE_THROUGH；Windows 上目录不能单独 fsync，这个标志就是「fsync 目录」那一步。
//!   不替换时目标已存在就失败。
//! - **整份替换**：[`write_atomic`] 先写同目录的临时文件并刷盘（`FlushFileBuffers`），再按上面的方式改名替换：
//!   读者看到的要么是完整的旧内容，要么是完整的新内容。
//! - **复制来的文件**：发布之前用 [`sync_tree`] 逐个刷盘，再改名发布。
//!
//! 刚写完的文件常被杀毒或索引短暂打开，改名会得到 ACCESS_DENIED / SHARING_VIOLATION / LOCK_VIOLATION（5、32、33）：
//! 退避重试约 10 秒，仍不行才报错。其余错误立即报错。
//!
//! [`record`] 记下作用域内经过这里的每一次改名与刷盘（当前线程），用例据此核对调用方真的走了这里、标志与先后对不对。
//! [`inject`] 让作用域内的某些写入失败（磁盘满、改名失败），用例据此确定性地造出写不进的状态（W3 peer r1 P2-05）。

use std::cell::RefCell;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
pub const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

/// 共享冲突一类错误的退避重试总预算。
pub const RETRY_BUDGET: Duration = Duration::from_secs(10);

/// 经过这里的一次落盘操作。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Op {
    Move {
        from: PathBuf,
        to: PathBuf,
        flags: u32,
    },
    Sync(PathBuf),
    /// [`write_atomic`] 写临时文件（只用于注入，不记录）。
    Write(PathBuf),
}

/// 注入的失败：对一次操作返回 `Some(错误)` 就让它失败。
pub type Injector = Box<dyn FnMut(&Op) -> Option<io::Error>>;

thread_local! {
    static RECORDER: RefCell<Option<Vec<Op>>> = const { RefCell::new(None) };
    static INJECTOR: RefCell<Option<Injector>> = const { RefCell::new(None) };
}

/// 执行 `f`，其间（当前线程上）每次操作之前先问 `injector`：返回错误就不做、直接以这个错误失败（不重试）。
pub fn inject<R>(injector: Injector, f: impl FnOnce() -> R) -> R {
    struct Restore(Option<Injector>);
    impl Drop for Restore {
        fn drop(&mut self) {
            let outer = self.0.take();
            INJECTOR.with(|i| *i.borrow_mut() = outer);
        }
    }
    let _restore = Restore(INJECTOR.with(|i| i.replace(Some(injector))));
    f()
}

fn injected(op: impl FnOnce() -> Op) -> io::Result<()> {
    INJECTOR.with(|i| match i.borrow_mut().as_mut() {
        Some(f) => f(&op()).map_or(Ok(()), Err),
        None => Ok(()),
    })
}

fn note(op: impl FnOnce() -> Op) {
    RECORDER.with(|r| {
        if let Some(ops) = r.borrow_mut().as_mut() {
            ops.push(op());
        }
    });
}

/// 执行 `f`，返回它的结果与其间（当前线程上）成功完成的改名与刷盘，按先后。
pub fn record<R>(f: impl FnOnce() -> R) -> (R, Vec<Op>) {
    let outer = RECORDER.with(|r| r.replace(Some(Vec::new())));
    struct Restore(Option<Option<Vec<Op>>>);
    impl Drop for Restore {
        fn drop(&mut self) {
            if let Some(outer) = self.0.take() {
                RECORDER.with(|r| *r.borrow_mut() = outer);
            }
        }
    }
    let mut restore = Restore(Some(outer));
    let result = f();
    let ops = RECORDER.with(|r| r.borrow_mut().take()).unwrap_or_default();
    let outer = restore.0.take().unwrap_or_default();
    RECORDER.with(|r| {
        *r.borrow_mut() = outer.map(|mut o| {
            o.extend(ops.iter().cloned());
            o
        })
    });
    (result, ops)
}

/// 落盘地改名。`replace` 为假时目标已存在就失败。
pub fn rename(from: &Path, to: &Path, replace: bool) -> io::Result<()> {
    rename_with(
        from,
        to,
        replace,
        &mut imp::move_file,
        &mut std::thread::sleep,
    )
}

/// [`rename`] 的本体：`mv` 做一次改名（失败给出系统错误），`sleep` 退避。用例注入它们核对标志与重试。
pub fn rename_with(
    from: &Path,
    to: &Path,
    replace: bool,
    mv: &mut dyn FnMut(&Path, &Path, u32) -> io::Result<()>,
    sleep: &mut dyn FnMut(Duration),
) -> io::Result<()> {
    let flags = MOVEFILE_WRITE_THROUGH
        | if replace {
            MOVEFILE_REPLACE_EXISTING
        } else {
            0
        };
    let mut delay = Duration::from_millis(10);
    let mut waited = Duration::ZERO;
    injected(|| Op::Move {
        from: from.to_path_buf(),
        to: to.to_path_buf(),
        flags,
    })
    .map_err(|e| {
        io::Error::new(
            e.kind(),
            format!("move {} -> {}: {e}", from.display(), to.display()),
        )
    })?;
    loop {
        let e = match mv(from, to, flags) {
            Ok(()) => {
                note(|| Op::Move {
                    from: from.to_path_buf(),
                    to: to.to_path_buf(),
                    flags,
                });
                return Ok(());
            }
            Err(e) => e,
        };
        let transient = matches!(e.raw_os_error(), Some(5 | 32 | 33));
        if !transient || waited >= RETRY_BUDGET {
            return Err(io::Error::new(
                e.kind(),
                format!("move {} -> {}: {e}", from.display(), to.display()),
            ));
        }
        sleep(delay);
        waited += delay;
        delay = (delay * 2).min(Duration::from_millis(500));
    }
}

/// 先写同目录的临时文件并刷盘，再落盘地改名替换。失败时删掉临时文件。
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other(format!("{} has no parent", path.display())))?;
    fs::create_dir_all(parent)?;
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let temporary = path.with_file_name(format!("{name}.{}.tmp", std::process::id()));
    let written = (|| {
        injected(|| Op::Write(temporary.clone()))?;
        let mut f = fs::File::create(&temporary)?;
        f.write_all(bytes)?;
        f.sync_all()
    })()
    .map_err(|e| io::Error::new(e.kind(), format!("write {}: {e}", temporary.display())));
    let r = written.and_then(|()| rename(&temporary, path, true));
    if r.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    r
}

/// 把一个已经写完的文件刷到盘上（`FlushFileBuffers`）。
pub fn sync_file(path: &Path) -> io::Result<()> {
    injected(|| Op::Sync(path.to_path_buf()))
        .map_err(|e| io::Error::new(e.kind(), format!("flush {}: {e}", path.display())))?;
    fs::OpenOptions::new()
        .write(true)
        .open(path)
        .and_then(|f| f.sync_all())
        .map_err(|e| io::Error::new(e.kind(), format!("flush {}: {e}", path.display())))?;
    note(|| Op::Sync(path.to_path_buf()));
    Ok(())
}

/// `dir` 下的每个文件逐个刷盘（不跟随链接）。目录不在时什么都不做。
pub fn sync_tree(dir: &Path) -> io::Result<()> {
    let entries = match fs::read_dir(dir) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        r => r?,
    };
    let mut entries: Vec<_> = entries.collect::<io::Result<_>>()?;
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let kind = e.file_type()?;
        if kind.is_dir() {
            sync_tree(&e.path())?;
        } else if kind.is_file() {
            sync_file(&e.path())?;
        }
    }
    Ok(())
}

#[cfg(windows)]
mod imp {
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

    fn wide(p: &Path) -> Vec<u16> {
        p.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    pub(super) fn move_file(from: &Path, to: &Path, flags: u32) -> io::Result<()> {
        let (a, b) = (wide(from), wide(to));
        // SAFETY: 两个指针指向以 0 结尾、调用期间一直存活的 UTF-16 缓冲区；函数不保留它们。
        if unsafe { MoveFileExW(a.as_ptr(), b.as_ptr(), flags) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    use std::io;
    use std::path::Path;

    pub(super) fn move_file(from: &Path, to: &Path, flags: u32) -> io::Result<()> {
        if flags & super::MOVEFILE_REPLACE_EXISTING == 0 && std::fs::symlink_metadata(to).is_ok() {
            return Err(io::Error::from(io::ErrorKind::AlreadyExists));
        }
        std::fs::rename(from, to)?;
        std::fs::File::open(to.parent().unwrap_or(Path::new(".")))?.sync_all()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        // 放在 target 下，不在 %TEMP% 里留东西。
        let d = std::env::var_os("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("target")
            })
            .join("install-state-unit")
            .join(name);
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn os(code: i32) -> io::Error {
        io::Error::from_raw_os_error(code)
    }

    /// 标志：总带 WRITE_THROUGH；只有要替换时才带 REPLACE_EXISTING。
    #[test]
    fn flags_always_write_through_and_replace_only_when_asked() {
        for (replace, expected) in [(true, 0x9), (false, 0x8)] {
            let mut seen = Vec::new();
            rename_with(
                Path::new("a"),
                Path::new("b"),
                replace,
                &mut |_, _, f| {
                    seen.push(f);
                    Ok(())
                },
                &mut |_| panic!("no retry"),
            )
            .unwrap();
            assert_eq!(seen, [expected]);
        }
    }

    /// 共享冲突一类（5、32、33）退避重试，放开了就成功；退避是 10、20、40 ms 递增。
    #[test]
    fn a_briefly_held_file_is_retried_until_it_moves() {
        let mut errors = vec![os(32), os(33), os(5)].into_iter();
        let mut slept = Vec::new();
        let (r, ops) = record(|| {
            rename_with(
                Path::new("a"),
                Path::new("b"),
                true,
                &mut |_, _, _| errors.next().map_or(Ok(()), Err),
                &mut |d| slept.push(d),
            )
        });
        r.unwrap();
        assert_eq!(slept, [10, 20, 40].map(Duration::from_millis));
        assert_eq!(
            ops,
            [Op::Move {
                from: "a".into(),
                to: "b".into(),
                flags: 0x9
            }]
        );
    }

    /// 一直被占：约 10 秒后报错，错误里有两个路径；不算成功，不记录。
    #[test]
    fn a_file_held_for_good_fails_after_the_budget() {
        let mut slept = Duration::ZERO;
        let mut tries = 0;
        let (r, ops) = record(|| {
            rename_with(
                Path::new("from.json"),
                Path::new("to.json"),
                true,
                &mut |_, _, _| {
                    tries += 1;
                    Err(os(32))
                },
                &mut |d| slept += d,
            )
        });
        let e = r.unwrap_err();
        assert!(
            e.to_string().contains("from.json") && e.to_string().contains("to.json"),
            "{e}"
        );
        assert!(slept >= RETRY_BUDGET && slept < RETRY_BUDGET + Duration::from_secs(1));
        assert!(tries < 40, "{tries}");
        assert!(ops.is_empty());
    }

    /// 其余错误（例如找不到文件）立即报错，不重试。
    #[test]
    fn other_errors_are_not_retried() {
        let mut tries = 0;
        let r = rename_with(
            Path::new("a"),
            Path::new("b"),
            false,
            &mut |_, _, _| {
                tries += 1;
                Err(os(2))
            },
            &mut |_| panic!("no retry"),
        );
        assert!(r.is_err());
        assert_eq!(tries, 1);
    }

    /// 不替换：目标已存在就失败，两边原样。替换：目标换成新内容，临时文件不留。
    #[test]
    fn a_rename_without_replace_never_overwrites() {
        let d = scratch("no-overwrite");
        fs::write(d.join("a"), b"new").unwrap();
        fs::write(d.join("b"), b"old").unwrap();
        assert!(rename(&d.join("a"), &d.join("b"), false).is_err());
        assert_eq!(fs::read(d.join("a")).unwrap(), b"new");
        assert_eq!(fs::read(d.join("b")).unwrap(), b"old");
        let (r, ops) = record(|| write_atomic(&d.join("b"), b"replaced"));
        r.unwrap();
        assert_eq!(fs::read(d.join("b")).unwrap(), b"replaced");
        assert_eq!(fs::read_dir(&d).unwrap().count(), 2);
        assert!(matches!(&ops[..], [Op::Move { to, flags: 0x9, .. }] if *to == d.join("b")));
        let (r, ops) = record(|| sync_tree(&d));
        r.unwrap();
        assert_eq!(ops, [Op::Sync(d.join("a")), Op::Sync(d.join("b"))]);
        fs::remove_dir_all(&d).unwrap();
    }

    /// 注入：被点名的操作以给定的错误失败、不重试、不记录；写临时文件失败时目标原样、临时文件不留；作用域外恢复正常。
    #[test]
    fn injected_failures_fail_without_retry_and_leave_the_target() {
        let d = scratch("inject");
        fs::write(d.join("m.json"), b"last good").unwrap();
        let full = || io::Error::from_raw_os_error(112);
        let (r, ops) = record(|| {
            inject(
                Box::new(move |op| matches!(op, Op::Write(_)).then(full)),
                || write_atomic(&d.join("m.json"), b"never written"),
            )
        });
        assert_eq!(r.unwrap_err().raw_os_error(), None, "wrapped with the path");
        assert!(ops.is_empty());
        assert_eq!(fs::read(d.join("m.json")).unwrap(), b"last good");
        assert_eq!(fs::read_dir(&d).unwrap().count(), 1);
        let r = inject(
            Box::new(|op| matches!(op, Op::Move { .. }).then(|| io::Error::from_raw_os_error(32))),
            || {
                rename_with(
                    Path::new("a"),
                    Path::new("b"),
                    true,
                    &mut |_, _, _| panic!("not attempted"),
                    &mut |_| panic!("no retry"),
                )
            },
        );
        assert!(r.unwrap_err().to_string().contains("a -> b"));
        write_atomic(&d.join("m.json"), b"written").unwrap();
        assert_eq!(fs::read(d.join("m.json")).unwrap(), b"written");
        fs::remove_dir_all(&d).unwrap();
    }

    /// 嵌套的记录：内层看到自己的，外层看到全部。
    #[test]
    fn records_nest() {
        let mv = &mut |_: &Path, _: &Path, _: u32| Ok(());
        let (((), inner), outer) = record(|| {
            rename_with(Path::new("1"), Path::new("2"), false, mv, &mut |_| {}).unwrap();
            record(|| {
                rename_with(Path::new("3"), Path::new("4"), false, mv, &mut |_| {}).unwrap();
            })
        });
        assert_eq!(inner.len(), 1);
        assert_eq!(outer.len(), 2);
    }
}
