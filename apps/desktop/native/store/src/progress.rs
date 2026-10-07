//! 转换进度（07 §8；W3 peer r1 P2-03）。
//!
//! 回调收到 `(阶段, 已完成, 总数, 工作量)`：
//! - 阶段、已完成、总数是给人看的粗粒度（SNAPSHOT 按文件，IMPORT、VERIFY 按项目）；
//! - 工作量单调递增，每做完一个有界的工作批次加一：读写文件每 [`FILE_BYTES`] 字节、枚举每个文件、
//!   SQLite 每执行 [`SQLITE_OPS`] 条虚拟机指令（迁移、IMPORT、VERIFY 都在 SQL 里做）。
//!
//! 宿主据此判断「还在动」：四项里有一项变了才算推进。工作量只随真实的工作增加，不做事就不变——
//! 不是按时间刷新的心跳，卡住的转换照样会被判卡住。回调可能很密（每几毫秒一次），落盘由宿主节流。
//!
//! 深处的代码（散列、复制、打开的库）不必层层传参：[`with`] 在当前线程上装一个计量，作用域结束时撤掉；
//! 没有计量时 [`set`]、[`pulse`] 什么都不做。
//!
//! [`stop_at`] 是测试注入（W3 peer r1 P2-05）：工作量到第 N 批时「进程被杀」——SQLite 中断正在执行的语句，
//! 读文件返回错误，转换不做任何收尾就返回 `Interrupted`。这样能确定性地停在复制到一半、事务做到一半。

use rusqlite::Connection;
use std::cell::{Cell, RefCell};

/// 进度回调：`(阶段, 已完成, 总数, 工作量)`。
pub type ProgressFn<'a> = &'a dyn Fn(&str, usize, usize, u64);

/// SQLite 每执行这么多条虚拟机指令推进一次工作量（几毫秒的工作）。
pub const SQLITE_OPS: i32 = 1_000_000;

/// 读写文件每这么多字节推进一次工作量。
pub const FILE_BYTES: u64 = 64 << 20;

/// 一次转换的进度计量。
pub struct Meter<'a> {
    report: ProgressFn<'a>,
    stage: RefCell<(String, usize, usize)>,
    work: Cell<u64>,
}

impl<'a> Meter<'a> {
    pub fn new(report: ProgressFn<'a>) -> Meter<'a> {
        Meter {
            report,
            stage: RefCell::new((String::new(), 0, 0)),
            work: Cell::new(0),
        }
    }

    fn set(&self, stage: &str, done: usize, total: usize) {
        *self.stage.borrow_mut() = (stage.to_string(), done, total);
        self.emit();
    }

    fn pulse(&self) {
        self.work.set(self.work.get() + 1);
        self.emit();
        if STOP.with(Cell::get).is_some_and(|at| self.work.get() >= at) {
            STOPPED.with(|s| s.set(true));
        }
    }

    fn emit(&self) {
        let (stage, done, total) = self.stage.borrow().clone();
        (self.report)(&stage, done, total, self.work.get());
    }
}

thread_local! {
    /// 当前线程上的计量；只在 [`with`] 的作用域内非空。
    static CURRENT: Cell<*const Meter<'static>> = const { Cell::new(std::ptr::null()) };
    static STOP: Cell<Option<u64>> = const { Cell::new(None) };
    static STOPPED: Cell<bool> = const { Cell::new(false) };
}

/// 测试注入：执行 `f` 期间，计量的工作量到 `at` 时要求停下（[`stopped`] 变真）。作用域结束时复原。
pub fn stop_at<R>(at: u64, f: impl FnOnce() -> R) -> R {
    struct Restore(Option<u64>, bool);
    impl Drop for Restore {
        fn drop(&mut self) {
            STOP.with(|s| s.set(self.0));
            STOPPED.with(|s| s.set(self.1));
        }
    }
    let _restore = Restore(
        STOP.with(|s| s.replace(Some(at))),
        STOPPED.with(|s| s.replace(false)),
    );
    f()
}

/// 注入的停下已经发生：调用方按「进程被杀」处理，不做任何收尾。
pub fn stopped() -> bool {
    STOPPED.with(Cell::get)
}

fn stopped_error() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Interrupted, "stopped by injection")
}

/// 在 `f` 执行期间把 `meter` 装到当前线程上（`None` 时沿用外层的）。作用域结束（含 panic）时恢复外层的。
pub fn with<R>(meter: Option<&Meter<'_>>, f: impl FnOnce() -> R) -> R {
    let Some(meter) = meter else {
        return f();
    };
    struct Restore(*const Meter<'static>);
    impl Drop for Restore {
        fn drop(&mut self) {
            CURRENT.with(|c| c.set(self.0));
        }
    }
    // 生命周期只在这里抹掉：指针只在本作用域内可见，`Restore` 在返回（或展开）时换回外层的值，
    // `meter` 的借用覆盖整个作用域。
    let raw = (meter as *const Meter<'_>).cast::<Meter<'static>>();
    let _restore = Restore(CURRENT.with(|c| c.replace(raw)));
    f()
}

fn current(f: impl FnOnce(&Meter<'_>)) {
    let raw = CURRENT.with(Cell::get);
    if !raw.is_null() {
        // SAFETY: 非空只发生在 `with` 的作用域内，那时它指向的计量还活着（见 `with`）。
        f(unsafe { &*raw });
    }
}

/// 进入一个阶段，或推进粗粒度的计数。
pub fn set(stage: &str, done: usize, total: usize) {
    current(|m| m.set(stage, done, total));
}

/// 做完了一个有界的工作批次。
pub fn pulse() {
    current(|m| m.pulse());
}

/// 在 `c` 上执行 SQL 时，每 [`SQLITE_OPS`] 条虚拟机指令 [`pulse`] 一次（执行时当前线程上有计量才有效）。
pub fn watch(c: &Connection) -> rusqlite::Result<()> {
    c.progress_handler(
        SQLITE_OPS,
        Some(|| {
            pulse();
            stopped()
        }),
    )
}

/// 按字节计量的读：每读满 [`FILE_BYTES`] 字节 [`pulse`] 一次。
pub struct Read<R>(pub R, u64);

impl<R> Read<R> {
    pub fn new(inner: R) -> Read<R> {
        Read(inner, 0)
    }
}

impl<R: std::io::Read> std::io::Read for Read<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.0.read(buf)?;
        let before = self.1 / FILE_BYTES;
        self.1 += n as u64;
        for _ in before..self.1 / FILE_BYTES {
            pulse();
        }
        if stopped() {
            return Err(stopped_error());
        }
        Ok(n)
    }
}

/// 复制一个文件到已打开的 `to`（排他新建还是覆盖由调用方决定），按 [`FILE_BYTES`] 计量；复制完再推进一次。
pub fn copy(from: &std::path::Path, to: &mut std::fs::File) -> std::io::Result<u64> {
    use std::io::{Read as _, Write as _};
    let mut r = Read::new(std::fs::File::open(from)?);
    let mut buf = vec![0u8; 1 << 20];
    let mut n = 0u64;
    loop {
        let k = r.read(&mut buf)?;
        if k == 0 {
            break;
        }
        to.write_all(&buf[..k])?;
        n += k as u64;
    }
    pulse();
    if stopped() {
        return Err(stopped_error());
    }
    Ok(n)
}

/// `std::fs::copy` 的计量版：目标不存在就建，存在就截断。
pub fn copy_path(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<u64> {
    copy(from, &mut std::fs::File::create(to)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_meter_reports_only_inside_its_scope_and_restores_the_outer_one() {
        let seen = RefCell::new(Vec::new());
        let outer_report = |s: &str, d: usize, t: usize, w: u64| {
            seen.borrow_mut().push(format!("outer {s} {d}/{t} {w}"))
        };
        let inner_report = |s: &str, d: usize, t: usize, w: u64| {
            seen.borrow_mut().push(format!("inner {s} {d}/{t} {w}"))
        };
        // 每个作用域结束后先看线程上装的是谁（在用到它之前）：没换回来就是悬垂的指针。
        let installed = || CURRENT.with(Cell::get).cast::<()>();
        pulse();
        assert!(installed().is_null());
        let outer = Meter::new(&outer_report);
        let outer_at = (&outer as *const Meter<'_>).cast::<()>();
        with(Some(&outer), || {
            set("SNAPSHOT", 0, 0);
            pulse();
            let inner = Meter::new(&inner_report);
            with(Some(&inner), || set("IMPORT", 1, 2));
            assert_eq!(installed(), outer_at, "the inner meter is still installed");
            with(None, pulse);
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                with(Some(&inner), || panic!("unwinds"))
            }));
            assert!(r.is_err());
            assert_eq!(
                installed(),
                outer_at,
                "unwinding left the inner meter installed"
            );
            pulse();
        });
        assert!(installed().is_null(), "the outer meter is still installed");
        pulse();
        assert_eq!(
            seen.into_inner(),
            [
                "outer SNAPSHOT 0/0 0",
                "outer SNAPSHOT 0/0 1",
                "inner IMPORT 1/2 0",
                "outer SNAPSHOT 0/0 2",
                "outer SNAPSHOT 0/0 3",
            ]
        );
    }

    #[test]
    fn sql_and_bytes_move_the_work_counter() {
        let work = Cell::new(0u64);
        let report = |_: &str, _: usize, _: usize, w: u64| work.set(w);
        let meter = Meter::new(&report);
        let c = Connection::open_in_memory().unwrap();
        watch(&c).unwrap();
        with(Some(&meter), || {
            c.query_row(
                "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000000)
                 SELECT count(*) FROM n",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap();
        });
        let after_sql = work.get();
        assert!(after_sql >= 3, "{after_sql}");
        let bytes = vec![0u8; (FILE_BYTES * 2 + 1) as usize];
        with(Some(&meter), || {
            let mut r = Read::new(&bytes[..]);
            std::io::copy(&mut r, &mut std::io::sink()).unwrap();
        });
        assert_eq!(work.get(), after_sql + 2);
    }
}
