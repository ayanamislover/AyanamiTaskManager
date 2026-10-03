//! 单写线程、读连接池与 checkpoint（W1b）。
//!
//! 写入：所有写事务经一个写线程串行执行，队列有上限。入队就是「受理」：
//! - 等不到队列空位，在准入时限内返回 [`WriteError::Busy`]（STORE_BUSY）。这时作业没有入队，
//!   保证没有提交，以后也不会执行。
//! - 一旦入队，作业一定会执行完，结果是确定的：`Ok` 就是已提交，任何 `Err` 都已回滚。
//!   调用方不再等（[`Ticket`] 被丢弃或 [`Waited::Pending`]）不会取消它；
//!   想知道结果，用同一个 op_id 重放（00 Q-02、A6）。
//!
//! 读取：最多 `readers` 个只读连接，每次读在一个事务里看到一致的快照。
//! 读事务有时长上限，超过即被中断，快照随之释放，不会无限拖住 checkpoint。
//!
//! checkpoint：关掉 SQLite 的自动 checkpoint，改由写线程决定：
//! 队列排空时做 PASSIVE；空闲满 `idle_checkpoint` 时做 TRUNCATE（有读者占着就下次再试）。

use crate::{StoreError, configure, migrate};
use rusqlite::{Connection, OpenFlags, Transaction, TransactionBehavior};
use std::collections::VecDeque;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct Config {
    /// 排队（不含正在执行的）作业的上限。
    pub queue_capacity: usize,
    /// 等队列空位的最长时间，超过返回 STORE_BUSY。
    pub admit_wait: Duration,
    /// 单个写事务的默认时长预算，超过即回滚。
    pub write_budget: Duration,
    /// 只读连接数。
    pub readers: usize,
    /// 等空闲读连接的最长时间。
    pub read_wait: Duration,
    /// 单个读事务的时长上限。
    pub read_budget: Duration,
    /// 写线程空闲这么久后做 TRUNCATE checkpoint。
    pub idle_checkpoint: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            queue_capacity: 256,
            admit_wait: Duration::from_secs(5),
            write_budget: Duration::from_secs(2),
            readers: 4,
            read_wait: Duration::from_secs(5),
            read_budget: Duration::from_secs(5),
            idle_checkpoint: Duration::from_secs(30),
        }
    }
}

/// 写入的结果。除 `Busy` / `Closed` 外都表示作业已受理并执行过；所有 `Err` 都没有提交。
#[derive(Debug)]
pub enum WriteError<E> {
    /// STORE_BUSY：准入超时，没有入队。
    Busy,
    /// 存储已关闭，没有入队。
    Closed,
    /// 作业返回了错误，已回滚。
    Rejected(E),
    /// 超出时长预算，已回滚。
    OverBudget,
    /// 作业 panic，已回滚；写线程照常工作。
    Panicked,
    /// BEGIN 或 COMMIT 失败，已回滚。
    Sqlite(rusqlite::Error),
}

impl<E> WriteError<E> {
    /// 是否入过队。`false` 的两种情况，作业从未执行，以后也不会执行。
    pub fn admitted(&self) -> bool {
        !matches!(self, WriteError::Busy | WriteError::Closed)
    }

    /// 对外错误码（00 / 01 的错误目录）。`Rejected` 是作业自己的错误，由调用方映射，这里返回 `None`。
    /// 超预算、panic、SQLite 错误都是服务自身的缺陷，不是 Agent 能靠重试解决的，统一为 INTERNAL_ERROR。
    pub fn code(&self) -> Option<&'static str> {
        match self {
            WriteError::Busy => Some("STORE_BUSY"),
            WriteError::Closed => Some("SERVICE_UNAVAILABLE"),
            WriteError::Rejected(_) => None,
            WriteError::OverBudget | WriteError::Panicked | WriteError::Sqlite(_) => {
                Some("INTERNAL_ERROR")
            }
        }
    }
}

#[derive(Debug)]
pub enum ReadError<E> {
    /// 读连接全部占用，等待超时。
    Busy,
    /// 读事务超出时长上限，被中断。
    OverBudget,
    Rejected(E),
    Panicked,
    Sqlite(rusqlite::Error),
}

/// 计数器，供诊断和 W1g 基准读取。
#[derive(Debug, Default)]
pub struct Stats {
    pub admitted: AtomicU64,
    pub busy: AtomicU64,
    pub queue_high_water: AtomicU64,
    pub commits: AtomicU64,
    pub rollbacks: AtomicU64,
    pub over_budget: AtomicU64,
    pub passive_checkpoints: AtomicU64,
    pub truncate_checkpoints: AtomicU64,
    pub truncate_busy: AtomicU64,
    pub reads: AtomicU64,
    pub read_interrupts: AtomicU64,
}

impl Stats {
    pub fn get(counter: &AtomicU64) -> u64 {
        counter.load(Ordering::SeqCst)
    }
    fn bump(counter: &AtomicU64) {
        counter.fetch_add(1, Ordering::SeqCst);
    }
}

/// 时长预算：progress handler 每隔一段 VM 指令看一眼截止时间，过了就中断当前语句。
struct Budget {
    base: Instant,
    /// 截止时刻（相对 base 的纳秒）；0 表示未启用。
    deadline: AtomicU64,
    tripped: AtomicBool,
}

impl Budget {
    fn install(conn: &Connection) -> rusqlite::Result<Arc<Budget>> {
        let b = Arc::new(Budget {
            base: Instant::now(),
            deadline: AtomicU64::new(0),
            tripped: AtomicBool::new(false),
        });
        let h = b.clone();
        conn.progress_handler(
            1000,
            Some(move || {
                let d = h.deadline.load(Ordering::SeqCst);
                if d != 0 && h.base.elapsed().as_nanos() as u64 > d {
                    h.tripped.store(true, Ordering::SeqCst);
                    return true;
                }
                false
            }),
        )?;
        Ok(b)
    }

    fn arm(&self, limit: Duration) -> Instant {
        self.tripped.store(false, Ordering::SeqCst);
        let now = Instant::now();
        let at = (now - self.base + limit).as_nanos().max(1) as u64;
        self.deadline.store(at, Ordering::SeqCst);
        now
    }

    /// 停用并返回这次是否被中断过。
    fn disarm(&self) -> bool {
        self.deadline.store(0, Ordering::SeqCst);
        self.tripped.load(Ordering::SeqCst)
    }
}

type Job = Box<dyn FnOnce(&mut Connection, &Budget, &Stats) + Send>;

struct Queue {
    jobs: VecDeque<Job>,
    closed: bool,
}

struct Shared {
    queue: Mutex<Queue>,
    not_empty: Condvar,
    not_full: Condvar,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

struct Slot<T> {
    value: Mutex<Option<T>>,
    ready: Condvar,
}

/// 已受理的写入。丢弃它不会取消作业。
pub struct Ticket<R, E> {
    slot: Arc<Slot<Result<R, WriteError<E>>>>,
}

pub enum Waited<R, E> {
    Done(Result<R, WriteError<E>>),
    /// 已受理、还没执行完。结果确定，只是还没出来；可以继续等，也可以丢弃后凭 op_id 重放。
    Pending(Ticket<R, E>),
}

impl<R, E> Ticket<R, E> {
    pub fn wait(self) -> Result<R, WriteError<E>> {
        let mut v = lock(&self.slot.value);
        loop {
            if let Some(out) = v.take() {
                return out;
            }
            v = self.slot.ready.wait(v).unwrap_or_else(|e| e.into_inner());
        }
    }

    pub fn wait_timeout(self, limit: Duration) -> Waited<R, E> {
        let deadline = Instant::now() + limit;
        {
            let mut v = lock(&self.slot.value);
            loop {
                if let Some(out) = v.take() {
                    return Waited::Done(out);
                }
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    break;
                }
                v = self
                    .slot
                    .ready
                    .wait_timeout(v, left)
                    .unwrap_or_else(|e| e.into_inner())
                    .0;
            }
        }
        Waited::Pending(self)
    }
}

struct Reader {
    conn: Connection,
    budget: Arc<Budget>,
}

struct Pool {
    idle: Mutex<Vec<Reader>>,
    returned: Condvar,
}

pub struct Store {
    path: PathBuf,
    config: Config,
    shared: Arc<Shared>,
    stats: Arc<Stats>,
    pool: Pool,
    writer: Mutex<Option<JoinHandle<()>>>,
}

impl Store {
    /// 打开（或新建）数据库，迁移到最新，启动写线程，打开只读连接。
    pub fn open(path: &Path, config: Config) -> Result<Store, StoreError> {
        let conn = Connection::open(path)?;
        configure(&conn)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        // checkpoint 时机由写线程决定，不让提交顺手做。
        conn.pragma_update(None, "wal_autocheckpoint", 0)?;
        migrate(&conn)?;
        let budget = Budget::install(&conn)?;

        let mut readers = Vec::with_capacity(config.readers);
        for _ in 0..config.readers {
            let r = Connection::open_with_flags(
                path,
                OpenFlags::SQLITE_OPEN_READ_ONLY
                    | OpenFlags::SQLITE_OPEN_NO_MUTEX
                    | OpenFlags::SQLITE_OPEN_URI,
            )?;
            r.busy_timeout(Duration::from_secs(1))?;
            let budget = Budget::install(&r)?;
            readers.push(Reader { conn: r, budget });
        }

        let shared = Arc::new(Shared {
            queue: Mutex::new(Queue {
                jobs: VecDeque::new(),
                closed: false,
            }),
            not_empty: Condvar::new(),
            not_full: Condvar::new(),
        });
        let stats = Arc::new(Stats::default());
        let writer = {
            let (shared, stats, idle) = (shared.clone(), stats.clone(), config.idle_checkpoint);
            std::thread::Builder::new()
                .name("atm-store-writer".into())
                .spawn(move || writer_loop(conn, budget, shared, stats, idle))
                .map_err(|e| StoreError::Io(e.to_string()))?
        };
        Ok(Store {
            path: path.to_path_buf(),
            config,
            shared,
            stats,
            pool: Pool {
                idle: Mutex::new(readers),
                returned: Condvar::new(),
            },
            writer: Mutex::new(Some(writer)),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn stats(&self) -> &Stats {
        &self.stats
    }

    /// 提交一个写作业，等它执行完。
    pub fn write<R, E, F>(&self, f: F) -> Result<R, WriteError<E>>
    where
        F: FnOnce(&Transaction<'_>) -> Result<R, E> + Send + 'static,
        R: Send + 'static,
        E: Send + 'static,
    {
        self.submit(f)?.wait()
    }

    /// 提交一个写作业，用默认预算。返回 `Err` 只可能是 `Busy` / `Closed`（没有入队）。
    pub fn submit<R, E, F>(&self, f: F) -> Result<Ticket<R, E>, WriteError<E>>
    where
        F: FnOnce(&Transaction<'_>) -> Result<R, E> + Send + 'static,
        R: Send + 'static,
        E: Send + 'static,
    {
        self.submit_with(self.config.write_budget, f)
    }

    /// 同 [`Store::submit`]，指定这个作业的时长预算（恢复、转换这类大事务用）。
    pub fn submit_with<R, E, F>(
        &self,
        budget: Duration,
        f: F,
    ) -> Result<Ticket<R, E>, WriteError<E>>
    where
        F: FnOnce(&Transaction<'_>) -> Result<R, E> + Send + 'static,
        R: Send + 'static,
        E: Send + 'static,
    {
        let slot = Arc::new(Slot {
            value: Mutex::new(None),
            ready: Condvar::new(),
        });
        let out = slot.clone();
        let job: Job = Box::new(move |conn, b, stats| {
            let result = run_write(conn, b, stats, budget, f);
            *lock(&out.value) = Some(result);
            out.ready.notify_all();
        });
        self.enqueue(job)?;
        Ok(Ticket { slot })
    }

    /// 独占作业：在写线程上拿到整条写连接，不自动开事务。
    ///
    /// 只给需要在事务外做准备的维护操作用（例如按范围恢复要先 ATTACH 备份库，而 ATTACH 不能在事务里做）。
    /// 作业自己开、自己提交事务。预算只通过 progress handler 中断正在执行的 SQL，不做事后判定：
    /// 作业可能已经提交，没法再回滚。作业返回后，残留的事务一律回滚，ATTACH 的库一律 DETACH。
    pub fn submit_exclusive<R, E, F>(
        &self,
        budget: Duration,
        f: F,
    ) -> Result<Ticket<R, E>, WriteError<E>>
    where
        F: FnOnce(&mut Connection) -> Result<R, E> + Send + 'static,
        R: Send + 'static,
        E: Send + 'static,
    {
        let slot = Arc::new(Slot {
            value: Mutex::new(None),
            ready: Condvar::new(),
        });
        let out = slot.clone();
        let job: Job = Box::new(move |conn, b, stats| {
            let result = run_exclusive(conn, b, stats, budget, f);
            *lock(&out.value) = Some(result);
            out.ready.notify_all();
        });
        self.enqueue(job)?;
        Ok(Ticket { slot })
    }

    /// 入队即受理。等不到空位返回 Busy，已关闭返回 Closed；这两种情况作业被丢弃，从未执行。
    fn enqueue<E>(&self, job: Job) -> Result<(), WriteError<E>> {
        let deadline = Instant::now() + self.config.admit_wait;
        let mut q = lock(&self.shared.queue);
        loop {
            if q.closed {
                return Err(WriteError::Closed);
            }
            if q.jobs.len() < self.config.queue_capacity {
                break;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                Stats::bump(&self.stats.busy);
                return Err(WriteError::Busy);
            }
            q = self
                .shared
                .not_full
                .wait_timeout(q, left)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        q.jobs.push_back(job);
        self.stats
            .queue_high_water
            .fetch_max(q.jobs.len() as u64, Ordering::SeqCst);
        Stats::bump(&self.stats.admitted);
        drop(q);
        self.shared.not_empty.notify_one();
        Ok(())
    }

    /// 在一个只读事务里读。闭包里不要做网络、进程或文件 IO：快照在闭包返回前一直占着。
    pub fn read<R, E, F>(&self, f: F) -> Result<R, ReadError<E>>
    where
        F: FnOnce(&Transaction<'_>) -> Result<R, E>,
    {
        let mut reader = self.take_reader()?;
        let result = run_read(&mut reader, self.config.read_budget, &self.stats, f);
        lock(&self.pool.idle).push(reader);
        self.pool.returned.notify_one();
        result
    }

    fn take_reader<E>(&self) -> Result<Reader, ReadError<E>> {
        let deadline = Instant::now() + self.config.read_wait;
        let mut idle = lock(&self.pool.idle);
        loop {
            if let Some(r) = idle.pop() {
                return Ok(r);
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(ReadError::Busy);
            }
            idle = self
                .pool
                .returned
                .wait_timeout(idle, left)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }

    /// 停止受理新写入，执行完已受理的作业，最后做一次 TRUNCATE，然后结束写线程。可重复调用。
    pub fn shutdown(&self) {
        lock(&self.shared.queue).closed = true;
        self.shared.not_empty.notify_all();
        self.shared.not_full.notify_all();
        if let Some(h) = lock(&self.writer).take() {
            let _ = h.join();
        }
    }
}

impl Drop for Store {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn run_write<R, E, F>(
    conn: &mut Connection,
    b: &Budget,
    stats: &Stats,
    limit: Duration,
    f: F,
) -> Result<R, WriteError<E>>
where
    F: FnOnce(&Transaction<'_>) -> Result<R, E>,
{
    let result = (|| {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(WriteError::Sqlite)?;
        let started = b.arm(limit);
        let out = catch_unwind(AssertUnwindSafe(|| f(&tx)));
        // 一律按耗时判定：被 progress handler 中断时必然已过截止时间；
        // 不跑 SQL、只是在 Rust 里慢的作业，handler 没机会触发，也要算超时。
        b.disarm();
        let over = started.elapsed() > limit;
        // 下面每个 Err 分支都让 tx 被丢弃，丢弃即回滚。
        match out {
            Err(_) => Err(WriteError::Panicked),
            Ok(_) if over => {
                Stats::bump(&stats.over_budget);
                Err(WriteError::OverBudget)
            }
            Ok(Err(e)) => Err(WriteError::Rejected(e)),
            Ok(Ok(r)) => tx.commit().map(|_| r).map_err(WriteError::Sqlite),
        }
    })();
    Stats::bump(if result.is_ok() {
        &stats.commits
    } else {
        &stats.rollbacks
    });
    result
}

fn run_exclusive<R, E, F>(
    conn: &mut Connection,
    b: &Budget,
    stats: &Stats,
    limit: Duration,
    f: F,
) -> Result<R, WriteError<E>>
where
    F: FnOnce(&mut Connection) -> Result<R, E>,
{
    b.arm(limit);
    let out = catch_unwind(AssertUnwindSafe(|| f(&mut *conn)));
    b.disarm();
    // 作业没收尾的事务：回滚，免得下一个作业接着在它里面写。
    let leaked = !conn.is_autocommit();
    if leaked {
        let _ = conn.execute_batch("ROLLBACK");
    }
    detach_all(conn);
    let result = match out {
        Err(_) => Err(WriteError::Panicked),
        Ok(Err(e)) => Err(WriteError::Rejected(e)),
        Ok(Ok(_)) if leaked => Err(WriteError::Sqlite(rusqlite::Error::InvalidQuery)),
        Ok(Ok(r)) => Ok(r),
    };
    Stats::bump(if result.is_ok() {
        &stats.commits
    } else {
        &stats.rollbacks
    });
    result
}

fn detach_all(conn: &Connection) {
    let names: Vec<String> = conn
        .prepare("SELECT name FROM pragma_database_list WHERE name NOT IN ('main', 'temp')")
        .and_then(|mut st| st.query_map([], |r| r.get(0))?.collect())
        .unwrap_or_default();
    for name in names {
        let _ = conn.execute("DETACH DATABASE ?1", [name]);
    }
}

fn run_read<R, E, F>(
    reader: &mut Reader,
    limit: Duration,
    stats: &Stats,
    f: F,
) -> Result<R, ReadError<E>>
where
    F: FnOnce(&Transaction<'_>) -> Result<R, E>,
{
    Stats::bump(&stats.reads);
    let tx = reader
        .conn
        .transaction_with_behavior(TransactionBehavior::Deferred)
        .map_err(ReadError::Sqlite)?;
    reader.budget.arm(limit);
    let out = catch_unwind(AssertUnwindSafe(|| f(&tx)));
    let tripped = reader.budget.disarm();
    drop(tx); // 只读事务：回滚即释放快照
    if tripped {
        Stats::bump(&stats.read_interrupts);
        return Err(ReadError::OverBudget);
    }
    match out {
        Err(_) => Err(ReadError::Panicked),
        Ok(Err(e)) => Err(ReadError::Rejected(e)),
        Ok(Ok(r)) => Ok(r),
    }
}

fn writer_loop(
    mut conn: Connection,
    budget: Arc<Budget>,
    shared: Arc<Shared>,
    stats: Arc<Stats>,
    idle: Duration,
) {
    // WAL 里是否还有没被 TRUNCATE 掉的内容。
    let mut dirty = false;
    loop {
        let job = {
            let mut q = lock(&shared.queue);
            loop {
                // 先取作业再看 closed：关闭时已受理的作业照样执行完。
                if let Some(job) = q.jobs.pop_front() {
                    shared.not_full.notify_one();
                    break Some(job);
                }
                if q.closed {
                    break None;
                }
                let (g, waited) = shared
                    .not_empty
                    .wait_timeout(q, idle)
                    .unwrap_or_else(|e| e.into_inner());
                q = g;
                if waited.timed_out() && q.jobs.is_empty() && !q.closed && dirty {
                    drop(q);
                    dirty = !truncate(&conn, &stats);
                    q = lock(&shared.queue);
                }
            }
        };
        let Some(job) = job else { break };
        job(&mut conn, &budget, &stats);
        dirty = true;
        if lock(&shared.queue).jobs.is_empty() {
            passive(&conn, &stats);
        }
    }
    if dirty {
        truncate(&conn, &stats);
    }
}

fn checkpoint(conn: &Connection, mode: &str) -> rusqlite::Result<bool> {
    // 返回 (busy, log, checkpointed)；busy = 1 表示有读者挡着，没做完。
    conn.query_row(&format!("PRAGMA wal_checkpoint({mode})"), [], |r| {
        r.get::<_, i64>(0)
    })
    .map(|busy| busy == 0)
}

fn passive(conn: &Connection, stats: &Stats) {
    if checkpoint(conn, "PASSIVE").is_ok() {
        Stats::bump(&stats.passive_checkpoints);
    }
}

/// TRUNCATE 要等所有读者离开；不在写线程里等，挡住了就返回 false，下次空闲再试。
fn truncate(conn: &Connection, stats: &Stats) -> bool {
    let _ = conn.busy_timeout(Duration::ZERO);
    let done = matches!(checkpoint(conn, "TRUNCATE"), Ok(true));
    let _ = conn.busy_timeout(Duration::from_secs(5));
    Stats::bump(if done {
        &stats.truncate_checkpoints
    } else {
        &stats.truncate_busy
    });
    done
}
