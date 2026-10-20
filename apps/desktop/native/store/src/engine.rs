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
//! 读事务有时长上限：SQL 超时当场中断，快照随之释放，不会无限拖住 checkpoint；
//! 慢在 Rust 里的闭包中断不了，返回时按耗时判为超时（所以读闭包里只做查询）。
//!
//! checkpoint：关掉 SQLite 的自动 checkpoint。写线程每执行完一个作业就通知 checkpoint 线程（只置位，
//! 不等），后者合并请求做 PASSIVE，两次之间至少隔 `checkpoint_gap`。不能只在队列排空时通知：
//! 队列一直有积压时就永远没有 checkpoint，WAL 无界增长。PASSIVE 用自己的连接，和写入并发进行，不占写线程：
//! W1g 实测一次 PASSIVE 最长 349 ms（复制页再 fsync 整个库文件），放在写线程上时，
//! 这段时间里所有写入都在排队。
//! 读者几乎一直持有快照时，PASSIVE 追不平 WAL，WAL 就不会被复用，只增不减
//! （W1g 实测 30 s 涨到 2.2 GiB）。所以 PASSIVE 报告的 WAL 帧数超过 `wal_soft_limit` 时，
//! checkpoint 线程只置一个标志；写线程在两个作业之间看到它，就在自己的连接上做 RESTART：
//! 写线程这时不持有事务，不必和自己抢写锁（放在 checkpoint 线程上做时，写线程一提交就开始下一个作业，
//! 忙等待没有公平性，积压时 RESTART 一直抢不到锁，W1 peer r1 P1-02）。RESTART 最多等
//! `wal_restart_wait` 让读者离开 WAL，之后下一个写事务从头复用 WAL，并按 `journal_size_limit`
//! （同一个值）截短文件。等待只管读者；复制和 fsync 的时间另算，期间写入照样排队，
//! 所以软上限不是硬上限，WAL 的峰值取决于写入速度和读者。
//! 写线程空闲满 `idle_checkpoint` 时自己做 TRUNCATE（有读者或正在进行的 PASSIVE 挡着就下次再试）；
//! 关闭时先停 checkpoint 线程，再做最后一次 TRUNCATE。

use crate::{StoreError, configure, migrate};
use rusqlite::{Connection, OpenFlags, Transaction, TransactionBehavior};
use std::collections::VecDeque;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// 写线程的名字。附件协调锁据此拒绝在写线程上加锁（见 `backup::attachments_lock`）。
pub(crate) const WRITER_THREAD: &str = "atm-store-writer";

#[derive(Clone, Debug)]
pub struct Config {
    /// 排队（不含正在执行的）作业的上限。
    pub queue_capacity: usize,
    /// 等队列空位的最长时间，超过返回 STORE_BUSY。
    pub admit_wait: Duration,
    /// 单个写事务的默认时长预算，超过即回滚。从 BEGIN 成功开始计，到 COMMIT 之前判定：
    /// 不含排队、等 BEGIN 的写锁（busy timeout）和 COMMIT 本身，所以不是端到端时延的上限（W1 peer r4 P2-01）。
    /// SQL 执行中超时由 progress handler 当场中断；纯 Rust 的慢计算中断不了，只能在闭包返回后按耗时判定、回滚。
    pub write_budget: Duration,
    /// 只读连接数。
    pub readers: usize,
    /// 等空闲读连接的最长时间。
    pub read_wait: Duration,
    /// 单个读事务的时长上限，判定方式同 `write_budget`：SQL 当场中断（快照随即释放），
    /// 纯 Rust 的慢计算要等闭包返回才判定，期间快照一直占着。超时的读一律返回 `ReadError::OverBudget`，
    /// 算出来的结果丢弃。所以读闭包里只做查询、把行收出来，处理放到闭包外（W1 peer r4 P2-01）。
    pub read_budget: Duration,
    /// 写线程空闲这么久后做 TRUNCATE checkpoint。
    pub idle_checkpoint: Duration,
    /// 两次 PASSIVE checkpoint 之间的最小间隔。checkpoint 要 fsync，和写入抢同一个文件：
    /// W1g 的 Agent 档里 250 ms 时写入 p99 75.6 ms，1 s 时 4.9 ms（`output/w1-bench/REPORT.md`）。
    pub checkpoint_gap: Duration,
    /// WAL 的软上限，字节。超过后做 RESTART；也是 `journal_size_limit`。
    pub wal_soft_limit: u64,
    /// RESTART 最多等读者多久（这段时间里新写入排队）。读者一直重叠、总有一个占着同一个 read mark 时，
    /// RESTART 会等满这个时长后放弃，到下一次 PASSIVE（至少隔 `checkpoint_gap`）再试；
    /// 所以「等读者」这一部分让写线程停顿的比例，稳态下约为 `wal_restart_wait / checkpoint_gap`。
    /// 这只是等待预算的估计：RESTART 成功时还要复制页、fsync，那部分不受它限制，也不是单次停顿的上限。
    pub wal_restart_wait: Duration,
    /// 每条连接（写连接和每个读连接）的 page cache 上限，KiB。W1g 的 cache 矩阵（每格一次运行，
    /// 有界观测）里 512～8192 之间时延看不出差别（库文件有操作系统的文件缓存兜着），内存随之上涨；
    /// 取 1024。见 `output/w1-bench/REPORT.md`。
    pub cache_kib: u32,
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
            checkpoint_gap: Duration::from_secs(1),
            wal_soft_limit: 64 << 20,
            wal_restart_wait: Duration::from_millis(100),
            cache_kib: 1024,
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
    /// 单次 PASSIVE checkpoint 的最长耗时与累计耗时，µs。PASSIVE 在 checkpoint 线程上做，不挡写入。
    pub passive_max_us: AtomicU64,
    pub passive_total_us: AtomicU64,
    /// WAL 超过软上限后做的 RESTART：成功、被读者挡住、最长耗时（µs，期间新写入排队）。
    pub restart_checkpoints: AtomicU64,
    pub restart_busy: AtomicU64,
    pub restart_max_us: AtomicU64,
    /// 正在执行的 PASSIVE / RESTART（0 或 1）。诊断用，也让关闭用例确认 checkpoint 确实在进行中。
    pub passive_running: AtomicU64,
    pub restart_running: AtomicU64,
    /// 单个写作业（含 BEGIN / COMMIT）在写线程上的最长执行时间，µs。
    pub job_max_us: AtomicU64,
    pub reads: AtomicU64,
    /// 读事务里的 SQL 被 progress handler 中断。
    pub read_interrupts: AtomicU64,
    /// 读闭包返回时已超出预算（SQL 没被中断，慢在 Rust 里）。
    pub read_overruns: AtomicU64,
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

type Run = Box<dyn FnOnce(&mut Connection, &Budget, &Stats) + Send>;

/// 一个写作业与它的时长预算（看门狗用预算判断「跑得久」还是「卡住了」）。
struct Job {
    budget: Duration,
    run: Run,
}

struct Queue {
    jobs: VecDeque<Job>,
    closed: bool,
}

/// 见 [`Store::write_mark`]。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WriteMark {
    pub jobs: u64,
    pub wakes: u64,
}

#[derive(Default)]
struct Done {
    jobs: u64,
    closed: bool,
    wakes: u64,
}

struct Shared {
    queue: Mutex<Queue>,
    not_empty: Condvar,
    not_full: Condvar,
    /// 写线程执行完的作业数、写线程是否已结束、[`Store::wake_waiters`] 的次数，见 [`Store::wait_for_writes`]。
    done: Mutex<Done>,
    /// 正在执行的作业：开始的时刻与它的预算（[`Store::current_job`]）。
    running: Mutex<Option<(Instant, Duration)>>,
    done_changed: Condvar,
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
    /// 调用方给的库路径：只用于展示、登记与日志。
    path: PathBuf,
    /// 打开时钉住的数据根（库所在目录，跟随链接解析一次；peer W6 r5 P1-01）。整个 Store 生命周期都持有：
    /// 写连接、读池、checkpoint、附件守卫与旁路读都从它的真实位置出发，`path` 上数据根以上的链接之后再被换向，
    /// 也换不走这个 Store 读写的数据根；它自己与它的祖先在持有期间改不了名（不共享删除）。
    root: crate::pin::Dir,
    /// 库文件在 `root` 真实位置里的路径。
    real: PathBuf,
    /// 打开时数据根字面写法的位置（[`Location`]），[`Store::rebase`] 用它认「在数据根下」。
    literal_root: Location,
    config: Config,
    shared: Arc<Shared>,
    stats: Arc<Stats>,
    pool: Pool,
    writer: Mutex<Option<JoinHandle<()>>>,
}

impl Store {
    /// 打开（或新建）数据库，迁移到最新，启动写线程，打开只读连接。
    pub fn open(path: &Path, config: Config) -> Result<Store, StoreError> {
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let name = path
            .file_name()
            .ok_or_else(|| StoreError::Io(format!("{} has no file name", path.display())))?;
        // 打开时就记下字面写法的位置键：之后当前目录变了，相对写法的数据根也认得出来。
        let literal_root = Location::of(parent);
        // 数据根的写法认不出来，之后就判断不了调用方给的位置在不在它下面（peer W6 r9 P1-01）。
        if !literal_root.supported() {
            return Err(StoreError::Io(unsupported_spelling(parent).to_string()));
        }
        let root = crate::pin::open(parent)
            .map_err(|e| StoreError::Io(format!("{}: {e}", parent.display())))?;
        refuse_loopback(parent, root.id().0).map_err(|e| StoreError::Io(e.to_string()))?;
        let real = root.path().join(name);
        #[cfg(test)]
        after_pin(path);
        let path_given = path;
        let path = real.as_path();
        let conn = Connection::open(path)?;
        configure(&conn)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        // checkpoint 时机由写线程决定，不让提交顺手做。
        conn.pragma_update(None, "wal_autocheckpoint", 0)?;
        conn.pragma_update(None, "cache_size", -i64::from(config.cache_kib))?;
        conn.pragma_update(None, "journal_size_limit", config.wal_soft_limit as i64)?;
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
            crate::harden(&r)?;
            r.pragma_update(None, "cache_size", -i64::from(config.cache_kib))?;
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
            done: Mutex::new(Done::default()),
            running: Mutex::new(None),
            done_changed: Condvar::new(),
        });
        let stats = Arc::new(Stats::default());
        let writer = {
            let checkpointer = Checkpointer::start(path, path_given, &config, stats.clone())?;
            let (shared, stats, idle) = (shared.clone(), stats.clone(), config.idle_checkpoint);
            std::thread::Builder::new()
                .name(WRITER_THREAD.into())
                .spawn(move || writer_loop(conn, budget, shared, stats, idle, checkpointer))
                .map_err(|e| StoreError::Io(e.to_string()))?
        };
        Ok(Store {
            path: path_given.to_path_buf(),
            real: real.clone(),
            literal_root,
            root,
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

    /// 库文件的真实位置（`\\?\` 完整写法），即连接实际打开的那个文件。
    pub fn real_path(&self) -> &Path {
        &self.real
    }

    /// 打开时钉住的数据根。
    pub(crate) fn root(&self) -> &crate::pin::Dir {
        &self.root
    }

    /// 测试用：让守卫的身份核对对不上，等于「打开之后数据根被换成了别的目录」。
    #[cfg(test)]
    pub(crate) fn forge_root_identity(&mut self) {
        self.root.forge_identity();
    }

    /// 调用方给的、在数据根字面写法之下的位置，换算到 Store 钉住的数据根的真实位置里；不在数据根下的原样返回
    /// （调用方另选的外部位置，照它的写法用）。「在数据根下」按 Windows 的同一位置比（[`Location`]）：
    /// 大小写、`\\?\` 与普通写法、相对写法、普通写法的 `.` / `..` 都认得出（peer W6 r6 P1-02），不按字符串前缀。
    ///
    /// 数据根以下的部分原样接在真实位置后面（按 `\` 拼字符串，不经 `PathBuf::push`：它在 `\\?\` 写法上会把
    /// `.`、`..` 归一掉，peer W6 r7 P1-02）。所以 `\\?\` 写法里 Windows 本来不解释的 `.`、`..`、`/`，换算后
    /// 仍是名字：原来打不开的路径换算后照样打不开，不会变成兄弟目录。
    ///
    /// `\\?\` 写法中间有空段（连续的 `\`）的，不论在不在数据根下都拒绝：Windows 打不开它，而之后按
    /// `std::path` 拆父目录与名字时空段会被并掉、变成一个打得开的位置（peer W6 r8 P1-02）。
    pub(crate) fn rebase(&self, literal: &Path) -> std::io::Result<PathBuf> {
        let key = Location::of(literal);
        if key.gaps {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!(
                    "{} has an empty segment in a \\\\?\\ path (Windows does not open it)",
                    literal.display()
                ),
            ));
        }
        if !key.supported() {
            return Err(unsupported_spelling(literal));
        }
        let Some(rest) = key.below(&self.literal_root) else {
            return Ok(literal.to_path_buf());
        };
        let mut s = self.root.path().as_os_str().to_owned();
        for c in rest {
            if !s.to_string_lossy().ends_with('\\') {
                s.push("\\");
            }
            s.push(c);
        }
        Ok(PathBuf::from(s))
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
        let job = Job {
            budget,
            run: Box::new(move |conn, b, stats| {
                let result = run_write(conn, b, stats, budget, f);
                *lock(&out.value) = Some(result);
                out.ready.notify_all();
            }),
        };
        self.enqueue(job)?;
        Ok(Ticket { slot })
    }

    /// 独占作业：在写线程上拿到整条写连接，不自动开事务。
    ///
    /// 只给需要在事务外做准备的维护操作用（例如按范围恢复要先 ATTACH 备份库，而 ATTACH 不能在事务里做）。
    /// 作业自己开、自己提交事务。预算只通过 progress handler 中断正在执行的 SQL，不做事后判定：
    /// 作业可能已经提交，没法再回滚。作业返回后，残留的事务一律回滚，ATTACH 的库一律 DETACH。
    ///
    /// **结果合同与 [`Store::submit`] 不同**：这里的 `Err` 不等于「什么都没提交」。作业提交之后再返回 `Err`，
    /// 已提交的内容照样在（W1 peer r4 P2-01，用例 `an_exclusive_job_that_fails_after_committing_stays_committed`）。
    /// 所以作业要把提交放在最后一步，提交之后不再做可能失败的事；需要「失败即回滚」的写入一律用 `submit`。
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
        let job = Job {
            budget,
            run: Box::new(move |conn, b, stats| {
                let result = run_exclusive(conn, b, stats, budget, f);
                *lock(&out.value) = Some(result);
                out.ready.notify_all();
            }),
        };
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

    /// 现在的写入标记：写线程执行完的作业数（提交与否都算）与 [`Store::wake_waiters`] 的次数。
    pub fn write_mark(&self) -> WriteMark {
        let done = lock(&self.shared.done);
        WriteMark {
            jobs: done.jobs,
            wakes: done.wakes,
        }
    }

    /// 等到标记与 `seen` 不同（又有作业执行完，或有人调了 [`Store::wake_waiters`]）或到了 `limit`，返回当时的标记；
    /// 写线程已经结束（关闭）返回 `None`。`seen` 之后发生的变化都算，哪怕发生在调用之前。
    ///
    /// 给观察者（托盘计数、系统通知）当「可能有新数据」的信号用：标记变了只说明有作业执行过，不说明提交了什么，
    /// 观察者自己去读。调用方照常设兜底的 `limit`。
    pub fn wait_for_writes(&self, seen: WriteMark, limit: Duration) -> Option<WriteMark> {
        let deadline = Instant::now() + limit;
        let mut done = lock(&self.shared.done);
        loop {
            let now = WriteMark {
                jobs: done.jobs,
                wakes: done.wakes,
            };
            if done.closed {
                return None;
            }
            if now != seen {
                return Some(now);
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Some(now);
            }
            done = self
                .shared
                .done_changed
                .wait_timeout(done, left)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }

    /// 正在执行的写作业：`(已经跑了多久, 它的预算)`；空闲时 `None`。看门狗用它判断写线程是否卡住
    /// （超过自己的预算 SQL 会被中断；再过很久还没结束，就是卡在 Rust 或 FFI 里了）。
    pub fn current_job(&self) -> Option<(Duration, Duration)> {
        lock(&self.shared.running).map(|(started, budget)| (started.elapsed(), budget))
    }

    /// 改一下写入标记，让 [`Store::wait_for_writes`] 里等的线程（以及之后拿旧标记来等的）都返回。
    /// 观察者停下时用：它们自己再看停止标志。
    pub fn wake_waiters(&self) {
        lock(&self.shared.done).wakes += 1;
        self.shared.done_changed.notify_all();
    }

    /// 在一个只读事务里读。闭包里不要做网络、进程或文件 IO，也不要做长计算：快照在闭包返回前一直占着，
    /// 而预算只能当场中断 SQL（见 `Config::read_budget`）。
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
    let started = reader.budget.arm(limit);
    let out = catch_unwind(AssertUnwindSafe(|| f(&tx)));
    let tripped = reader.budget.disarm();
    drop(tx); // 只读事务：回滚即释放快照
    if tripped {
        Stats::bump(&stats.read_interrupts);
        return Err(ReadError::OverBudget);
    }
    // SQL 没被中断，但闭包在 Rust 里慢：同样超时，结果丢弃（W1 peer r4 P2-01）。
    if out.is_ok() && started.elapsed() > limit {
        Stats::bump(&stats.read_overruns);
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
    checkpointer: Checkpointer,
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
        let started = Instant::now();
        *lock(&shared.running) = Some((started, job.budget));
        (job.run)(&mut conn, &budget, &stats);
        *lock(&shared.running) = None;
        stats
            .job_max_us
            .fetch_max(micros(started), Ordering::SeqCst);
        lock(&shared.done).jobs += 1;
        shared.done_changed.notify_all();
        dirty = true;
        // 每个作业之后都请求：队列一直有积压时也要有 checkpoint（W1 peer r1 P1-02）。
        // 请求只是置位，checkpoint 线程合并并按 gap 限流。
        checkpointer.request();
        if checkpointer.restart_due() {
            restart(&conn, checkpointer.restart_wait, &stats);
        }
    }
    checkpointer.stop();
    if dirty {
        truncate(&conn, &stats);
    }
    lock(&shared.done).closed = true;
    shared.done_changed.notify_all();
}

fn checkpoint(conn: &Connection, mode: &str) -> rusqlite::Result<bool> {
    checkpoint_frames(conn, mode).map(|(done, _)| done)
}

/// 返回（是否做完，WAL 里的帧数）。PRAGMA 返回 (busy, log, checkpointed)；busy = 1 表示被挡住，没做完。
fn checkpoint_frames(conn: &Connection, mode: &str) -> rusqlite::Result<(bool, i64)> {
    conn.query_row(&format!("PRAGMA wal_checkpoint({mode})"), [], |r| {
        Ok((r.get::<_, i64>(0)? == 0, r.get::<_, i64>(1)?))
    })
}

/// checkpoint 线程：收到请求后做一次 PASSIVE，两次之间至少隔 `gap`；
/// WAL 超过软上限时置 `restart`，由写线程在两个作业之间做 RESTART。
struct Checkpointer {
    signal: Arc<(Mutex<Signal>, Condvar)>,
    thread: Option<JoinHandle<()>>,
    restart: Arc<AtomicBool>,
    restart_wait: Duration,
}

#[derive(Default)]
struct Signal {
    pending: bool,
    closed: bool,
}

impl Checkpointer {
    /// `path` 是打开的真实位置；`given` 是调用方给的写法，只用来认测试挂的 [`hold_next_passive`]。
    fn start(
        path: &Path,
        given: &Path,
        config: &Config,
        stats: Arc<Stats>,
    ) -> Result<Checkpointer, StoreError> {
        let conn = Connection::open(path)?;
        configure(&conn)?;
        conn.pragma_update(None, "wal_autocheckpoint", 0)?;
        let page: i64 = conn.query_row("PRAGMA page_size", [], |r| r.get(0))?;
        let restart = Arc::new(AtomicBool::new(false));
        let limit = Limit {
            gap: config.checkpoint_gap,
            restart_frames: (config.wal_soft_limit as i64 / page.max(1)).max(1),
            restart: restart.clone(),
        };
        let signal = Arc::new((Mutex::new(Signal::default()), Condvar::new()));
        let thread = {
            let signal = signal.clone();
            std::thread::Builder::new()
                .name("atm-store-checkpoint".into())
                .spawn({
                    let given = given.to_path_buf();
                    move || checkpointer_loop(conn, &given, &signal, limit, &stats)
                })
                .map_err(|e| StoreError::Io(e.to_string()))?
        };
        Ok(Checkpointer {
            signal,
            thread: Some(thread),
            restart,
            restart_wait: config.wal_restart_wait,
        })
    }

    /// WAL 超过了软上限、该做 RESTART 了。取走标志。
    fn restart_due(&self) -> bool {
        self.restart.swap(false, Ordering::SeqCst)
    }

    fn request(&self) {
        lock(&self.signal.0).pending = true;
        self.signal.1.notify_one();
    }

    /// 停下并等线程退出。之后不会再有 PASSIVE。
    fn stop(self) {}
}

impl Drop for Checkpointer {
    fn drop(&mut self) {
        lock(&self.signal.0).closed = true;
        self.signal.1.notify_one();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

struct Limit {
    gap: Duration,
    restart_frames: i64,
    restart: Arc<AtomicBool>,
}

fn checkpointer_loop(
    conn: Connection,
    path: &Path,
    signal: &(Mutex<Signal>, Condvar),
    limit: Limit,
    stats: &Stats,
) {
    let gap = limit.gap;
    let (state, wake) = signal;
    let mut last: Option<Instant> = None;
    loop {
        let mut st = lock(state);
        while !st.pending && !st.closed {
            st = wake.wait(st).unwrap_or_else(|e| e.into_inner());
        }
        // 限流：离上一次不足 gap 就等到 gap 满（关闭时立即退出）。
        while let Some(due) = last.map(|l| l + gap) {
            let left = due.saturating_duration_since(Instant::now());
            if left.is_zero() || st.closed {
                break;
            }
            st = wake
                .wait_timeout(st, left)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        if st.closed {
            return;
        }
        st.pending = false;
        drop(st);
        if passive(&conn, path, stats).is_some_and(|frames| frames >= limit.restart_frames) {
            limit.restart.store(true, Ordering::SeqCst);
        }
        last = Some(Instant::now());
    }
}

/// 返回 WAL 里的帧数。
fn passive(conn: &Connection, path: &Path, stats: &Stats) -> Option<i64> {
    stats.passive_running.store(1, Ordering::SeqCst);
    held_here(path);
    let started = Instant::now();
    let r = checkpoint_frames(conn, "PASSIVE").ok();
    stats.passive_running.store(0, Ordering::SeqCst);
    if r.is_some() {
        Stats::bump(&stats.passive_checkpoints);
    }
    let us = micros(started);
    stats.passive_max_us.fetch_max(us, Ordering::SeqCst);
    stats.passive_total_us.fetch_add(us, Ordering::SeqCst);
    r.map(|(_, frames)| frames)
}

/// 在写线程上、两个作业之间做 RESTART：等读者离开 WAL（最多 `wait`），做完后下一个写事务从头复用 WAL。
fn restart(conn: &Connection, wait: Duration, stats: &Stats) {
    let started = Instant::now();
    stats.restart_running.store(1, Ordering::SeqCst);
    let _ = conn.busy_timeout(wait);
    let done = matches!(checkpoint(conn, "RESTART"), Ok(true));
    let _ = conn.busy_timeout(Duration::from_secs(5));
    stats.restart_running.store(0, Ordering::SeqCst);
    stats
        .restart_max_us
        .fetch_max(micros(started), Ordering::SeqCst);
    Stats::bump(if done {
        &stats.restart_checkpoints
    } else {
        &stats.restart_busy
    });
}

/// Windows 上的一个位置。写法交给 Windows 自己换成 NT 路径（[`nt_path`]：`RtlDosPathNameToNtPathName_U_WithStatus`，
/// 与 `CreateFileW` 打开文件前做的是同一步，只按字面换算，不碰文件系统、不跟随链接）：普通写法、`\\.\` 写法照
/// Win32 规则补全当前目录、归一 `/`、`.`、`..`、连续分隔符与尾部的点和空格，`\\?\` 写法原样。之后只认两种命名
/// 空间——`\??\<盘符>:\…` 与 `\??\UNC\<服务器>\<共享>\…`。其余（`GLOBALROOT`、卷 GUID、设备对象……）不比较、
/// 不支持（peer W6 r9 P1-01）：[`Store::open`] 与 [`Store::rebase`] 都拒绝，不当成外部位置放行。
///
/// 盘符不按字母比，也不按 `QueryDosDeviceW` 给的字符串比（设备名可以带路径后缀、可以是别的设备对象的别名，
/// 字符串认不全，peer W6 r10 P1-01、r11 P1-01）。按下面的顺序认，每一步都要有确定的结论：
/// - subst（`QueryDosDeviceW` 指向 `\??\…`）：换成它指向的路径再认，至多 [`DOS_DEVICE_DEPTH`] 层，超过就不支持；
/// - 网络映射盘符：只认格式完全对得上的 LanmanRedirector（含经 Mup 的）目标，就是那个 UNC 位置；其余重定向器
///   （WebDAV……）或解析不了的，不支持；
/// - 其余：盘符必须是挂载管理器登记的卷的根——`GetVolumeNameForVolumeMountPointW("X:\")` 给出
///   `\\?\Volume{GUID}\`，位置是「这个卷 + 之下的各段」，同一个卷的两个盘符是同一个位置；给不出（目标带路径后缀、
///   不是卷、没有这个盘符、查询失败）就不支持。
///
/// 证明不了「是同一个位置」或「是另一个位置」的写法一律不支持，不按剩下的字面当外部位置。名字保留 UTF-16
/// 原样，比较见 [`same_name`]。
#[derive(Clone, Debug)]
pub(crate) struct Location {
    /// `None`：不支持的写法。
    kind: Option<Space>,
    /// 中间有空段（只会出现在 `\\?\` 写法里）：Windows 打不开这个路径。
    pub(crate) gaps: bool,
    parts: Vec<std::ffi::OsString>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Space {
    /// 挂载管理器给的卷名（ASCII 小写；`\\?\volume{…}\`）。
    Volume(Vec<u16>),
    Unc,
}

/// subst 套 subst 最多跟几层；再往下还是 subst 就不支持。
const DOS_DEVICE_DEPTH: u8 = 4;

/// 盘符的两种查询（用例换掉它们，造真的 subst、映射盘符要改本机的盘符映射）。
struct Drives<'a> {
    /// `QueryDosDeviceW`：盘符指向的目标。
    target: &'a dyn Fn(&[u16]) -> Option<Vec<u16>>,
    /// `GetVolumeNameForVolumeMountPointW`：盘符是卷的根时，那个卷的名字。
    volume: &'a dyn Fn(&[u16]) -> Option<Vec<u16>>,
}

impl Location {
    pub(crate) fn of(p: &Path) -> Location {
        let drives = Drives {
            target: &dos_device,
            volume: &volume_name,
        };
        match nt_path(p) {
            Some(nt) => Location::of_nt(&nt, 0, &drives),
            None => Location::unsupported(),
        }
    }

    fn unsupported() -> Location {
        Location {
            kind: None,
            gaps: false,
            parts: Vec::new(),
        }
    }

    /// 能比较、Windows 也打得开的写法。
    pub(crate) fn supported(&self) -> bool {
        self.kind.is_some() && !self.gaps
    }

    /// 用例换盘符的两种查询。
    #[cfg(test)]
    pub(crate) fn of_with(
        p: &Path,
        target: &dyn Fn(&[u16]) -> Option<Vec<u16>>,
        volume: &dyn Fn(&[u16]) -> Option<Vec<u16>>,
    ) -> Location {
        match nt_path(p) {
            Some(nt) => Location::of_nt(&nt, 0, &Drives { target, volume }),
            None => Location::unsupported(),
        }
    }

    fn of_nt(nt: &[u16], depth: u8, drives: &Drives<'_>) -> Location {
        let Some(rest) = strip_ascii_ci(nt, r"\??\") else {
            return Location::unsupported();
        };
        let (unc, rest) = match strip_ascii_ci(rest, r"UNC\") {
            Some(r) => (true, r),
            None if is_drive(rest) => (false, rest),
            None => return Location::unsupported(),
        };
        let mut segments: Vec<&[u16]> = rest.split(|u| *u == u16::from(b'\\')).collect();
        // 末尾的分隔符不算一段（目录带不带它都一样）。普通写法里连续的分隔符已由 Win32 归一；`\\?\` 写法里
        // 中间的空段 Windows 不归一、打不开，记下来由 [`Store::rebase`] 拒绝（peer W6 r8 P1-02）。
        if segments.last().is_some_and(|s| s.is_empty()) {
            segments.pop();
        }
        if segments.iter().any(|s| s.is_empty()) {
            // 在换算盘符之前就定下：换算会重新拼接、再去一次末尾分隔符，原来打不开的写法不能因此变得打得开
            // （peer W6 r10 P1-03）。
            return Location {
                kind: None,
                gaps: true,
                parts: Vec::new(),
            };
        }
        if unc {
            return Location {
                kind: Some(Space::Unc),
                gaps: false,
                parts: segments.into_iter().map(from_wide).collect(),
            };
        }
        let below = &segments[1..];
        let Some(target) = (drives.target)(segments[0]) else {
            return Location::unsupported();
        };
        if starts_ascii_ci(&target, r"\??\") {
            // subst：换成它指向的位置再认一次。指向卷根（`\??\C:\`）时不再多拼一个分隔符（peer W6 r10 P2-01）。
            if depth >= DOS_DEVICE_DEPTH {
                return Location::unsupported();
            }
            let mut joined = target;
            for s in below {
                if joined.last() != Some(&u16::from(b'\\')) {
                    joined.push(u16::from(b'\\'));
                }
                joined.extend_from_slice(s);
            }
            return Location::of_nt(&joined, depth + 1, drives);
        }
        if let Some(redirected) = redirected_share(&target) {
            // 网络映射盘符：格式对得上就是那个 UNC 位置；重定向器认不出、目标解析不了的不支持，也不再往下当卷
            // （peer W6 r11 P1-01）。
            let Some(share) = redirected else {
                return Location::unsupported();
            };
            return Location {
                kind: Some(Space::Unc),
                gaps: false,
                parts: share
                    .into_iter()
                    .chain(below.iter().map(|c| from_wide(c)))
                    .collect(),
            };
        }
        // 其余只认挂载管理器登记的卷的根（peer W6 r11 P1-01）。
        let Some(volume) = (drives.volume)(segments[0]) else {
            return Location::unsupported();
        };
        Location {
            kind: Some(Space::Volume(
                volume.iter().map(|u| ascii_lower(*u)).collect(),
            )),
            gaps: false,
            parts: below.iter().map(|c| from_wide(c)).collect(),
        }
    }

    /// UNC 写法（含映射到网络共享的盘符）。
    pub(crate) fn unc(&self) -> bool {
        self.kind == Some(Space::Unc) && !self.gaps
    }

    /// `self` 在 `base` 之下时，返回之下的那几段（`base` 自己是空切片）；不在之下是 `None`。不支持的写法不在任何
    /// 位置之下。
    pub(crate) fn below<'a>(&'a self, base: &Location) -> Option<&'a [std::ffi::OsString]> {
        let inside = self.supported()
            && base.supported()
            && self.kind == base.kind
            && self.parts.len() >= base.parts.len()
            && self
                .parts
                .iter()
                .zip(&base.parts)
                .all(|(a, b)| same_name(a, b));
        inside.then(|| &self.parts[base.parts.len()..])
    }
}

#[cfg(windows)]
fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    s.encode_wide().collect()
}

#[cfg(windows)]
fn from_wide(units: &[u16]) -> std::ffi::OsString {
    use std::os::windows::ffi::OsStringExt;
    std::ffi::OsString::from_wide(units)
}

#[cfg(not(windows))]
fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
    s.to_string_lossy()
        .replace('/', "\\")
        .encode_utf16()
        .collect()
}

#[cfg(not(windows))]
fn from_wide(units: &[u16]) -> std::ffi::OsString {
    String::from_utf16_lossy(units).into()
}

fn unsupported_spelling(p: &Path) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::InvalidInput,
        format!(
            "{} is not a drive or UNC path whose location can be compared with the data root (other Windows \
             namespaces, drive letters that do not resolve, and subst chains deeper than 4 are not supported here)",
            p.display()
        ),
    )
}

fn ascii_lower(u: u16) -> u16 {
    if (65..=90).contains(&u) { u + 32 } else { u }
}

fn starts_ascii_ci(units: &[u16], prefix: &str) -> bool {
    let p: Vec<u16> = prefix.encode_utf16().collect();
    units.len() >= p.len()
        && units
            .iter()
            .zip(&p)
            .all(|(a, b)| ascii_lower(*a) == ascii_lower(*b))
}

/// 去掉一个只含 ASCII 的前缀（不分大小写：`UNC`、`GLOBALROOT` 这类对象名不分大小写）。
fn strip_ascii_ci<'a>(units: &'a [u16], prefix: &str) -> Option<&'a [u16]> {
    starts_ascii_ci(units, prefix).then(|| &units[prefix.encode_utf16().count()..])
}

/// `X:` 开头（之后是结尾或分隔符）。
fn is_drive(units: &[u16]) -> bool {
    let letter = |u: u16| (65..=90).contains(&u) || (97..=122).contains(&u);
    units.len() >= 2
        && letter(units[0])
        && units[1] == u16::from(b':')
        && (units.len() == 2 || units[2] == u16::from(b'\\'))
}

/// 网络映射盘符的目标。`None`：不是重定向器下的目标；`Some(None)`：是，但认不出（交给调用方拒绝）；
/// `Some(Some(段))`：就是 UNC 的 `\<服务器>\<共享>…` 那几段。
///
/// 只认 LanmanRedirector 的两种格式，打头的重定向器段要恰好对得上（peer W6 r11 P1-01）：
/// - `\Device\LanmanRedirector\;Z:<登录会话>\<服务器>\<共享>…`
/// - `\Device\Mup\;LanmanRedirector\;Z:<登录会话>\<服务器>\<共享>…`
///
/// 服务器与共享之后的段原样保留，以 `;` 开头的目录名也是名字（peer W6 r10 P1-02）。其余重定向器（WebDAV 之类，
/// `\Device\…Redirector\`）、Mup 下的其他格式、中间有空段、服务器名以 `;` 开头的，都认不出。
fn redirected_share(target: &[u16]) -> Option<Option<Vec<std::ffi::OsString>>> {
    let (rest, lead) = if let Some(r) = strip_ascii_ci(target, r"\Device\LanmanRedirector\") {
        (r, &[][..])
    } else if let Some(r) = strip_ascii_ci(target, r"\Device\Mup\") {
        (r, &[";LanmanRedirector"][..])
    } else {
        let device = strip_ascii_ci(target, r"\Device\")?;
        let name = device.split(|u| *u == u16::from(b'\\')).next()?;
        let name = String::from_utf16_lossy(name);
        // 其余名字以 Redirector 结尾的设备也是重定向器（WebDAV、RDP 的客户端驱动……），认不出。
        return name
            .to_ascii_lowercase()
            .ends_with("redirector")
            .then_some(None);
    };
    let mut segments: Vec<&[u16]> = rest.split(|u| *u == u16::from(b'\\')).collect();
    if segments.last().is_some_and(|s| s.is_empty()) {
        segments.pop();
    }
    let semicolon = |c: &[u16]| c.first() == Some(&u16::from(b';'));
    let fixed = lead.len();
    let understood = segments.len() >= fixed + 3
        && lead
            .iter()
            .zip(&segments)
            .all(|(want, got)| String::from_utf16_lossy(got).eq_ignore_ascii_case(want))
        && semicolon(segments[fixed])
        && !semicolon(segments[fixed + 1])
        && segments.iter().all(|c| !c.is_empty());
    if !understood {
        return Some(None);
    }
    Some(Some(
        segments[fixed + 1..].iter().map(|c| from_wide(c)).collect(),
    ))
}

/// 按 Windows 自己的规则把写法换成 NT 路径（`RtlDosPathNameToNtPathName_U_WithStatus`：`CreateFileW` 打开之前
/// 做的就是这一步）。只按字面，不访问文件系统。
#[cfg(windows)]
fn nt_path(p: &Path) -> Option<Vec<u16>> {
    #[repr(C)]
    struct UnicodeString {
        length: u16,
        maximum_length: u16,
        buffer: *mut u16,
    }
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn RtlDosPathNameToNtPathName_U_WithStatus(
            dos: *const u16,
            nt: *mut UnicodeString,
            file_part: *mut *mut u16,
            relative: *mut std::ffi::c_void,
        ) -> i32;
        fn RtlFreeUnicodeString(s: *mut UnicodeString);
    }
    let mut dos = wide(p.as_os_str());
    if dos.is_empty() || dos.contains(&0) {
        return None;
    }
    dos.push(0);
    let mut nt = UnicodeString {
        length: 0,
        maximum_length: 0,
        buffer: std::ptr::null_mut(),
    };
    // SAFETY: `dos` 以 0 结尾、调用期间有效；`nt` 由函数填写，成功时缓冲由它分配、用 RtlFreeUnicodeString 释放。
    let status = unsafe {
        RtlDosPathNameToNtPathName_U_WithStatus(
            dos.as_ptr(),
            &mut nt,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if status < 0 || nt.buffer.is_null() {
        return None;
    }
    // SAFETY: 成功时 `buffer` 指向 `length` 字节的 UTF-16。
    let units =
        unsafe { std::slice::from_raw_parts(nt.buffer, usize::from(nt.length) / 2) }.to_vec();
    // SAFETY: 释放上面分配的缓冲，之后不再用它。
    unsafe { RtlFreeUnicodeString(&mut nt) };
    Some(units)
}

#[cfg(not(windows))]
fn nt_path(p: &Path) -> Option<Vec<u16>> {
    let abs = std::path::absolute(p).ok()?;
    let mut units: Vec<u16> = r"\??\".encode_utf16().collect();
    units.extend(wide(abs.as_os_str()));
    Some(units)
}

/// UNC 写法（含映射到网络共享的盘符）钉住的目录，证明不了不在本机就拒绝。
///
/// 经本机共享回到本机的写法（`\\localhost\C$\…`、本机名、映射到本机共享的盘符……）在字面上认不出是数据根的哪种
/// 写法，当成外部位置就会跟着它路径上的链接走，换向之后落到别处（与 peer W6 r9 的 `GLOBALROOT` 同一类）。服务器名
/// 的别名列举不完，所以不按名字判断，按打开之后句柄所在的卷判断。`volume` 是钉住的句柄的卷序列号；数据根与外部
/// 位置钉住时都过这一道。拒绝的两种情形：
/// - 卷序列号与本机某个卷相同（含没有盘符、挂在目录上的卷）：可能就是本机；序列号碰巧相同的远端共享也一并拒绝
///   （32 位序列号证明不了是同一台机器，peer W6 r11 P2-01）；
/// - 本机的卷没能全部读到（枚举失败、中途出错、某个卷读不到序列号）：证明不了不在本机（peer W6 r11 P1-02）。
pub(crate) fn refuse_loopback(spelled: &Path, volume: u32) -> std::io::Result<()> {
    if !Location::of(spelled).unc() {
        return Ok(());
    }
    let why = match local_volume_serials() {
        Err(why) => format!("the volumes of this machine could not all be read ({why})"),
        Ok(serials) if serials.contains(&volume) => {
            "its volume has the same serial number as a volume of this machine".to_owned()
        }
        Ok(_) => return Ok(()),
    };
    Err(std::io::Error::new(
        std::io::ErrorKind::InvalidInput,
        format!(
            "{} cannot be confirmed to be outside this machine: {why}. A network path back to this machine is \
             refused, and so is a remote share whose volume serial number cannot be told apart from a local one; \
             a directory on this machine has to be written with its drive path",
            spelled.display()
        ),
    ))
}

/// 本机所有卷（`FindFirstVolumeW` 列出的，含没有盘符的）的序列号。读不全就是 `Err`（说明哪一步、错误码）：
/// 枚举开始就失败、`FindNextVolumeW` 不是因为列完了（`ERROR_NO_MORE_FILES`）才停、某个卷读序列号失败。只有两种
/// 读不到不算：没插盘的可移动卷（`ERROR_NOT_READY`）与没有文件系统的卷（`ERROR_UNRECOGNIZED_VOLUME`），句柄不会
/// 落在它们上面。
pub(crate) fn local_volume_serials() -> Result<Vec<u32>, String> {
    #[cfg(test)]
    if let Some(given) = LOCAL_VOLUMES.with(|o| o.borrow().clone()) {
        return given;
    }
    volume_serials_with(&VolumeApi::REAL)
}

/// 枚举本机卷要用的几个调用（用例换掉它们，验每一种失败）。
#[derive(Clone, Copy)]
pub(crate) struct VolumeApi {
    /// `FindFirstVolumeW`：查找句柄，或错误码。
    pub(crate) first: fn(&mut [u16]) -> Result<isize, u32>,
    /// `FindNextVolumeW`：`Ok(true)` 又一个，`Ok(false)` 列完了，`Err` 错误码。
    pub(crate) next: fn(isize, &mut [u16]) -> Result<bool, u32>,
    /// `GetVolumeInformationW`：`Ok(Some)` 序列号，`Ok(None)` 不算的卷，`Err` 错误码。
    pub(crate) serial: fn(&[u16]) -> Result<Option<u32>, u32>,
    /// `FindVolumeClose`。
    pub(crate) close: fn(isize),
}

pub(crate) fn volume_serials_with(api: &VolumeApi) -> Result<Vec<u32>, String> {
    let mut name = vec![0u16; 1024];
    let find =
        (api.first)(&mut name).map_err(|e| format!("FindFirstVolumeW failed with error {e}"))?;
    let mut serials = Vec::new();
    let outcome = loop {
        match (api.serial)(&name) {
            Ok(Some(s)) => serials.push(s),
            Ok(None) => {}
            Err(e) => {
                let end = name.iter().position(|u| *u == 0).unwrap_or(name.len());
                break Err(format!(
                    "GetVolumeInformationW failed with error {e} on {}",
                    String::from_utf16_lossy(&name[..end])
                ));
            }
        }
        match (api.next)(find, &mut name) {
            Ok(true) => {}
            Ok(false) => break Ok(()),
            Err(e) => break Err(format!("FindNextVolumeW failed with error {e}")),
        }
    };
    (api.close)(find);
    outcome.map(|()| serials)
}

#[cfg(windows)]
mod volume_ffi {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn FindFirstVolumeW(name: *mut u16, len: u32) -> isize;
        fn FindNextVolumeW(find: isize, name: *mut u16, len: u32) -> i32;
        fn FindVolumeClose(find: isize) -> i32;
        fn GetVolumeInformationW(
            root: *const u16,
            name: *mut u16,
            name_len: u32,
            serial: *mut u32,
            max_component: *mut u32,
            flags: *mut u32,
            fs_name: *mut u16,
            fs_name_len: u32,
        ) -> i32;
    }

    const INVALID: isize = -1;
    const ERROR_NO_MORE_FILES: i32 = 18;
    const ERROR_NOT_READY: i32 = 21;
    const ERROR_UNRECOGNIZED_VOLUME: i32 = 1005;

    fn last_error() -> i32 {
        std::io::Error::last_os_error().raw_os_error().unwrap_or(-1)
    }

    pub(super) fn first(name: &mut [u16]) -> Result<isize, u32> {
        // SAFETY: 缓冲长度如实给出；返回的查找句柄由调用方用 `close` 关掉。
        let find = unsafe { FindFirstVolumeW(name.as_mut_ptr(), name.len() as u32) };
        if find == INVALID {
            return Err(last_error() as u32);
        }
        Ok(find)
    }

    pub(super) fn next(find: isize, name: &mut [u16]) -> Result<bool, u32> {
        // SAFETY: `find` 是 `first` 给的有效查找句柄；缓冲长度如实给出。
        if unsafe { FindNextVolumeW(find, name.as_mut_ptr(), name.len() as u32) } != 0 {
            return Ok(true);
        }
        match last_error() {
            ERROR_NO_MORE_FILES => Ok(false),
            e => Err(e as u32),
        }
    }

    pub(super) fn serial(name: &[u16]) -> Result<Option<u32>, u32> {
        let mut serial = 0u32;
        // SAFETY: `name` 是 FindFirstVolumeW / FindNextVolumeW 写下的、以 0 结尾的卷名（`\\?\Volume{…}\`）；
        // 不要的输出给空指针。
        let ok = unsafe {
            GetVolumeInformationW(
                name.as_ptr(),
                std::ptr::null_mut(),
                0,
                &mut serial,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0,
            )
        };
        if ok != 0 {
            return Ok(Some(serial));
        }
        match last_error() {
            ERROR_NOT_READY | ERROR_UNRECOGNIZED_VOLUME => Ok(None),
            e => Err(e as u32),
        }
    }

    pub(super) fn close(find: isize) {
        // SAFETY: `find` 是 `first` 给的有效查找句柄，只关一次。
        unsafe { FindVolumeClose(find) };
    }
}

#[cfg(windows)]
impl VolumeApi {
    pub(crate) const REAL: VolumeApi = VolumeApi {
        first: volume_ffi::first,
        next: volume_ffi::next,
        serial: volume_ffi::serial,
        close: volume_ffi::close,
    };
}

#[cfg(not(windows))]
impl VolumeApi {
    pub(crate) const REAL: VolumeApi = VolumeApi {
        first: |_| Err(0),
        next: |_, _| Ok(false),
        serial: |_| Ok(None),
        close: |_| {},
    };
}

// 用例换掉本线程读到的本机卷（经公开入口验读不全时的拒绝）。
#[cfg(test)]
thread_local! {
    pub(crate) static LOCAL_VOLUMES: std::cell::RefCell<Option<Result<Vec<u32>, String>>> =
        const { std::cell::RefCell::new(None) };
}

/// 盘符是挂载管理器登记的卷的根时，那个卷的名字（`GetVolumeNameForVolumeMountPointW("X:\")`：`\\?\Volume{…}\`）。
fn volume_name(drive: &[u16]) -> Option<Vec<u16>> {
    #[cfg(test)]
    if let Some(given) = VOLUME_NAMES.with(|o| o.borrow().as_ref().map(|f| f(drive))) {
        return given;
    }
    query_volume_name(drive)
}

#[cfg(test)]
type VolumeNames = Box<dyn Fn(&[u16]) -> Option<Vec<u16>>>;

// 用例换掉本线程的「盘符 → 卷名」（与 [`DOS_DEVICES`] 一起用）。
#[cfg(test)]
thread_local! {
    pub(crate) static VOLUME_NAMES: std::cell::RefCell<Option<VolumeNames>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(windows)]
pub(crate) fn query_volume_name(drive: &[u16]) -> Option<Vec<u16>> {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetVolumeNameForVolumeMountPointW(mount: *const u16, name: *mut u16, len: u32) -> i32;
    }
    let mut mount = drive.get(..2)?.to_vec();
    mount.extend([u16::from(b'\\'), 0]);
    let mut buf = vec![0u16; 260];
    // SAFETY: `mount` 以 0 结尾；`buf` 的长度如实给出，函数只在其中写、以 0 结尾。
    let ok = unsafe {
        GetVolumeNameForVolumeMountPointW(mount.as_ptr(), buf.as_mut_ptr(), buf.len() as u32)
    };
    if ok == 0 {
        return None;
    }
    let end = buf.iter().position(|u| *u == 0)?;
    buf.truncate(end);
    Some(buf)
}

#[cfg(not(windows))]
pub(crate) fn query_volume_name(drive: &[u16]) -> Option<Vec<u16>> {
    let mut d: Vec<u16> = r"\\?\Volume{".encode_utf16().collect();
    d.extend_from_slice(drive.get(..1)?);
    d.extend("}\\".encode_utf16());
    Some(d)
}

/// 盘符指向的目标（`QueryDosDeviceW`）：subst 是 `\??\…`，网络映射是重定向器下的路径，本地卷是 `\Device\…`。
fn dos_device(drive: &[u16]) -> Option<Vec<u16>> {
    #[cfg(test)]
    if let Some(given) = DOS_DEVICES.with(|o| o.borrow().as_ref().map(|f| f(drive))) {
        return given;
    }
    query_dos_device(drive)
}

/// 用例换掉本线程的盘符映射（经公开入口验 subst 与映射盘符；造真的要改本机的盘符映射）。
#[cfg(test)]
type DosDevices = Box<dyn Fn(&[u16]) -> Option<Vec<u16>>>;

#[cfg(test)]
thread_local! {
    pub(crate) static DOS_DEVICES: std::cell::RefCell<Option<DosDevices>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(windows)]
pub(crate) fn query_dos_device(drive: &[u16]) -> Option<Vec<u16>> {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn QueryDosDeviceW(device: *const u16, target: *mut u16, max: u32) -> u32;
    }
    let mut name = drive.get(..2)?.to_vec();
    name.push(0);
    let mut buf = vec![0u16; 4096];
    // SAFETY: `name` 以 0 结尾；`buf` 的长度如实给出，函数只在其中写。
    let n = unsafe { QueryDosDeviceW(name.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) };
    if n == 0 {
        return None;
    }
    // 结果是以两个 0 结尾的多串，只取第一个（当前生效的那个）。
    let end = buf.iter().position(|u| *u == 0).unwrap_or(n as usize);
    buf.truncate(end);
    Some(buf)
}

#[cfg(not(windows))]
pub(crate) fn query_dos_device(drive: &[u16]) -> Option<Vec<u16>> {
    let mut d: Vec<u16> = r"\Device\".encode_utf16().collect();
    d.extend_from_slice(drive.get(..2)?);
    Some(d)
}

/// 同一个名字：Windows 的序数比较、不分大小写（`CompareStringOrdinal(…, TRUE)`：用系统的大写表逐个 UTF-16 码元比，
/// 与 NTFS 判两个名字相同用的是同一种规则）。不做 Unicode 的多字符展开：`straße` 与 `STRASSE` 是两个名字
/// （peer W6 r7 P1-01）。
#[cfg(windows)]
pub(crate) fn same_name(a: &std::ffi::OsStr, b: &std::ffi::OsStr) -> bool {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CompareStringOrdinal(
            string1: *const u16,
            count1: i32,
            string2: *const u16,
            count2: i32,
            ignore_case: i32,
        ) -> i32;
    }
    const CSTR_EQUAL: i32 = 2;
    let (a, b) = (wide(a), wide(b));
    let (Ok(na), Ok(nb)) = (i32::try_from(a.len()), i32::try_from(b.len())) else {
        return false;
    };
    // SAFETY: 两个缓冲在调用期间有效，长度如实给出（不要求以 0 结尾）。
    unsafe { CompareStringOrdinal(a.as_ptr(), na, b.as_ptr(), nb, 1) == CSTR_EQUAL }
}

#[cfg(not(windows))]
pub(crate) fn same_name(a: &std::ffi::OsStr, b: &std::ffi::OsStr) -> bool {
    a == b
}
#[cfg(test)]
type AfterPin = Box<dyn FnOnce() + Send>;
#[cfg(test)]
static AFTER_PIN: Mutex<Vec<(PathBuf, AfterPin)>> = Mutex::new(Vec::new());

/// 测试用：从 `db_path` 打开 Store 时，钉住数据根之后、打开连接之前跑一次 `f`（peer W6 r5 P1-01 的窗口）。
#[cfg(test)]
pub(crate) fn on_next_open_after_pin(db_path: &Path, f: impl FnOnce() + Send + 'static) {
    lock(&AFTER_PIN).push((db_path.to_path_buf(), Box::new(f)));
}

#[cfg(test)]
fn after_pin(path: &Path) {
    let f = {
        let mut all = lock(&AFTER_PIN);
        match all.iter().position(|(p, _)| p == path) {
            Some(i) => all.remove(i).1,
            None => return,
        }
    };
    f();
}

type Hold = Arc<(Mutex<(bool, bool)>, Condvar)>;

static PASSIVE_HOLDS: Mutex<Vec<(PathBuf, Hold)>> = Mutex::new(Vec::new());

/// 测试用：让这个库的下一次 PASSIVE 停在开始处，直到 [`PassiveHold::release`]（W1 peer r4 P2-05，
/// 关闭发生在 checkpoint 进行中）。PASSIVE 不等读者，没有别的办法让它停在半路。
#[doc(hidden)]
pub struct PassiveHold(Hold);

impl PassiveHold {
    /// checkpoint 线程已经停在这里了。
    pub fn entered(&self) -> bool {
        lock(&self.0.0).0
    }

    pub fn release(&self) {
        lock(&self.0.0).1 = true;
        self.0.1.notify_all();
    }
}

#[doc(hidden)]
pub fn hold_next_passive(db_path: &Path) -> PassiveHold {
    let hold: Hold = Arc::new((Mutex::new((false, false)), Condvar::new()));
    lock(&PASSIVE_HOLDS).push((db_path.to_path_buf(), hold.clone()));
    PassiveHold(hold)
}

fn held_here(path: &Path) {
    let hold = {
        let mut holds = lock(&PASSIVE_HOLDS);
        match holds.iter().position(|(p, _)| p == path) {
            Some(i) => holds.remove(i).1,
            None => return,
        }
    };
    let mut st = lock(&hold.0);
    st.0 = true;
    while !st.1 {
        st = hold.1.wait(st).unwrap_or_else(|e| e.into_inner());
    }
}

fn micros(since: Instant) -> u64 {
    u64::try_from(since.elapsed().as_micros()).unwrap_or(u64::MAX)
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
