//! 写线程、读连接池与 checkpoint 的验收（W1b）。
//!
//! 可能卡死的操作（变异后读不返回、写线程被占住）都放在子线程里跑，主线程限时等结果；
//! 子线程持有 `Arc<Store>`，超时 panic 时不会在主线程里 join 一个停不下来的写线程。

use atm_store::{Config, ReadError, Stats, Store, Waited, WriteError, hold_next_passive, open};
use rusqlite::{Connection, ErrorCode, OpenFlags, Transaction};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::channel;
use std::thread;
use std::time::{Duration, Instant};

fn db_path(name: &str) -> PathBuf {
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("target")
        });
    let dir = target.join("store-tests").join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("atm.sqlite")
}

/// 测试用的短时限。各用例只改自己关心的那一项。
fn fast() -> Config {
    Config {
        queue_capacity: 256,
        admit_wait: Duration::from_millis(200),
        write_budget: Duration::from_secs(30),
        readers: 4,
        read_wait: Duration::from_millis(200),
        read_budget: Duration::from_secs(30),
        idle_checkpoint: Duration::from_secs(60),
        ..Config::default()
    }
}

const MS: fn(u64) -> Duration = Duration::from_millis;
/// 永不结束的递归 CTE，只占 VM，不占内存。
const SPIN: &str =
    "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT max(x) FROM c";

fn put(tx: &Transaction<'_>, key: &str) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO settings (key, value_json, updated_at) VALUES (?1, '1', 'T')",
        [key],
    )
    .map(|_| ())
}

fn has(store: &Store, key: &str) -> bool {
    store
        .read(|tx| {
            tx.query_row("SELECT count(*) FROM settings WHERE key = ?1", [key], |r| {
                r.get::<_, i64>(0)
            })
        })
        .unwrap()
        == 1
}

fn wal_len(path: &Path) -> u64 {
    std::fs::metadata(format!("{}-wal", path.display()))
        .map(|m| m.len())
        .unwrap_or(0)
}

/// 等一个终将成立的条件：成立就立刻返回，期限只防挂死。并行跑变异、几条 cargo 同时编译时，
/// 后台线程几秒才轮到一次，所以给足 30 s（原来 2–5 s，在高负载下误报过）。
const HANG_GUARD: Duration = Duration::from_secs(30);

fn eventually(limit: Duration, mut ok: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if ok() {
            return true;
        }
        thread::sleep(MS(20));
    }
    ok()
}

#[test]
fn a_write_commits_with_the_writer_settings_and_readers_see_it() {
    let store = Store::open(
        &db_path("engine-basic"),
        Config {
            cache_kib: 3000,
            wal_soft_limit: 5 << 20,
            ..fast()
        },
    )
    .unwrap();
    let pragma = |tx: &Transaction<'_>, name: &str| {
        tx.query_row(&format!("PRAGMA {name}"), [], |r| r.get::<_, i64>(0))
    };
    let (fk, ac, mode, cache, limit) = store
        .write(move |tx| {
            put(tx, "k")?;
            Ok::<_, rusqlite::Error>((
                pragma(tx, "foreign_keys")?,
                pragma(tx, "wal_autocheckpoint")?,
                tx.query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0))?,
                pragma(tx, "cache_size")?,
                pragma(tx, "journal_size_limit")?,
            ))
        })
        .unwrap();
    assert_eq!(
        (fk, ac, mode.as_str(), cache, limit),
        (1, 0, "wal", -3000, 5 << 20),
        "writer: foreign keys on, no auto checkpoint, WAL, page cache in KiB, WAL size limit"
    );
    assert_eq!(
        store.read(move |tx| pragma(tx, "cache_size")).unwrap(),
        -3000,
        "readers get the same page cache limit"
    );
    assert!(has(&store, "k"));
    assert_eq!(Stats::get(&store.stats().commits), 1);
}

#[test]
fn admission_timeout_is_store_busy_and_the_job_never_runs() {
    let store = Arc::new(
        Store::open(
            &db_path("engine-busy"),
            Config {
                queue_capacity: 1,
                ..fast()
            },
        )
        .unwrap(),
    );
    let (started_tx, started_rx) = channel();
    let (gate_tx, gate_rx) = channel::<()>();
    let a = store
        .submit(move |tx| {
            started_tx.send(()).unwrap();
            let _ = gate_rx.recv_timeout(Duration::from_secs(10));
            put(tx, "a")
        })
        .unwrap();
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let b = store.submit(|tx| put(tx, "b")).unwrap(); // 队列满了（容量 1，a 在执行中不占位）

    let ran = Arc::new(AtomicBool::new(false));
    let (res_tx, res_rx) = channel();
    {
        let (store, ran) = (store.clone(), ran.clone());
        thread::spawn(move || {
            let t0 = Instant::now();
            let r = store
                .submit(move |tx| {
                    ran.store(true, Ordering::SeqCst);
                    put(tx, "c")
                })
                .map(|_| ())
                .map_err(|e| (e.admitted(), e.code()));
            res_tx.send((r, t0.elapsed())).unwrap();
        });
    }
    let got = res_rx.recv_timeout(Duration::from_secs(3));
    gate_tx.send(()).unwrap();
    let (r, took) = got.expect("submit must give up within the admission wait");
    assert_eq!(r, Err((false, Some("STORE_BUSY"))));
    assert!(
        took >= MS(200) && took < Duration::from_secs(2),
        "took {took:?}"
    );

    a.wait().unwrap();
    b.wait().unwrap();
    store.shutdown();
    assert!(
        !ran.load(Ordering::SeqCst),
        "a job refused at admission must never run"
    );
    assert!(has(&store, "a") && has(&store, "b") && !has(&store, "c"));
    assert_eq!(Stats::get(&store.stats().busy), 1);
}

#[test]
fn an_admitted_write_completes_after_the_caller_stops_waiting() {
    let store = Store::open(&db_path("engine-pending"), fast()).unwrap();
    let t = store
        .submit(|tx| {
            thread::sleep(MS(300));
            put(tx, "slow")
        })
        .unwrap();
    match t.wait_timeout(MS(50)) {
        Waited::Pending(t) => drop(t), // 不再等：作业照样执行
        Waited::Done(_) => panic!("the job sleeps 300 ms; 50 ms later it cannot be done"),
    }
    assert!(eventually(HANG_GUARD, || has(&store, "slow")));
}

#[test]
fn a_rejected_or_panicking_write_rolls_back_and_the_writer_survives() {
    let store = Store::open(&db_path("engine-rollback"), fast()).unwrap();
    let e = store
        .write(|tx| {
            put(tx, "r")?;
            Err::<(), _>(rusqlite::Error::InvalidQuery)
        })
        .unwrap_err();
    assert!(matches!(e, WriteError::Rejected(_)) && e.admitted());
    assert_eq!(e.code(), None, "a job's own error is mapped by the caller");
    assert!(!has(&store, "r"));

    // 限时等：写线程要是被 panic 带走，结果永远不会来。
    let done =
        |t: atm_store::Ticket<(), rusqlite::Error>| match t.wait_timeout(Duration::from_secs(5)) {
            Waited::Done(r) => r,
            Waited::Pending(_) => panic!("the writer stopped answering"),
        };
    let e = done(
        store
            .submit(|tx| -> rusqlite::Result<()> {
                put(tx, "p")?;
                panic!("job panics on purpose")
            })
            .unwrap(),
    )
    .unwrap_err();
    assert!(matches!(e, WriteError::Panicked));
    assert_eq!(e.code(), Some("INTERNAL_ERROR"));
    assert!(!has(&store, "p"));

    done(store.submit(|tx| put(tx, "after")).unwrap()).unwrap();
    assert!(has(&store, "after"));
    assert_eq!(
        (
            Stats::get(&store.stats().commits),
            Stats::get(&store.stats().rollbacks)
        ),
        (1, 2)
    );
}

#[test]
fn a_write_over_budget_rolls_back() {
    let store = Arc::new(
        Store::open(
            &db_path("engine-budget"),
            Config {
                write_budget: MS(150),
                ..fast()
            },
        )
        .unwrap(),
    );
    let (tx_, rx) = channel();
    {
        let store = store.clone();
        thread::spawn(move || {
            let t0 = Instant::now();
            // 一直跑 SQL：由 progress handler 中断。
            let spin = store.write(|tx| {
                put(tx, "spin")?;
                tx.query_row(SPIN, [], |r| r.get::<_, i64>(0)).map(|_| ())
            });
            let spin = (matches!(spin, Err(WriteError::OverBudget)), t0.elapsed());
            // 不跑 SQL、只是慢：结束时按耗时判定。
            let sleepy = store.write(|tx| {
                put(tx, "sleepy")?;
                thread::sleep(MS(300));
                Ok::<_, rusqlite::Error>(())
            });
            tx_.send((spin, matches!(sleepy, Err(WriteError::OverBudget))))
                .unwrap();
        });
    }
    let ((spin_over, spin_took), sleepy_over) = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("a write over budget must be cut off");
    assert!(
        spin_over && spin_took < Duration::from_secs(3),
        "spin: over={spin_over} took={spin_took:?}"
    );
    assert!(sleepy_over);
    assert!(!has(&store, "spin") && !has(&store, "sleepy"));
    assert_eq!(Stats::get(&store.stats().over_budget), 2);

    // 预算内的写入不受影响；大事务可以单独给预算。
    store.write(|tx| put(tx, "quick")).unwrap();
    store
        .submit_with(Duration::from_secs(5), |tx| {
            put(tx, "big")?;
            thread::sleep(MS(300));
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap()
        .wait()
        .unwrap();
    assert!(has(&store, "quick") && has(&store, "big"));
}

#[test]
fn shutdown_finishes_admitted_writes_and_refuses_new_ones() {
    let store = Arc::new(Store::open(&db_path("engine-drain"), fast()).unwrap());
    let (started_tx, started_rx) = channel();
    let (gate_tx, gate_rx) = channel::<()>();
    let a = store
        .submit(move |tx| {
            started_tx.send(()).unwrap();
            let _ = gate_rx.recv_timeout(Duration::from_secs(10));
            put(tx, "a")
        })
        .unwrap();
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let queued: Vec<_> = (1..=3)
        .map(|i| store.submit(move |tx| put(tx, &format!("q{i}"))).unwrap())
        .collect();

    let closer = {
        let store = store.clone();
        thread::spawn(move || store.shutdown())
    };
    thread::sleep(MS(200));
    let late = Arc::new(AtomicBool::new(false));
    let refused = {
        let late = late.clone();
        store.submit(move |tx| {
            late.store(true, Ordering::SeqCst);
            put(tx, "late")
        })
    };
    assert!(matches!(refused, Err(WriteError::Closed)));
    gate_tx.send(()).unwrap();

    assert!(matches!(
        a.wait_timeout(Duration::from_secs(5)),
        Waited::Done(Ok(()))
    ));
    for t in queued {
        assert!(
            matches!(t.wait_timeout(Duration::from_secs(5)), Waited::Done(Ok(()))),
            "queued write dropped"
        );
    }
    closer.join().unwrap();
    assert!((1..=3).all(|i| has(&store, &format!("q{i}"))));
    assert!(!late.load(Ordering::SeqCst) && !has(&store, "late"));
}

#[test]
fn readers_are_read_only_and_bounded() {
    let store = Arc::new(
        Store::open(
            &db_path("engine-readers"),
            Config {
                readers: 2,
                ..fast()
            },
        )
        .unwrap(),
    );
    let e = store.read(|tx| put(tx, "x")).unwrap_err();
    assert!(
        matches!(&e, ReadError::Rejected(rusqlite::Error::SqliteFailure(f, _)) if f.code == ErrorCode::ReadOnly),
        "{e:?}"
    );

    let (held_tx, held_rx) = channel();
    let mut releases = Vec::new();
    let mut holders = Vec::new();
    for _ in 0..2 {
        let (rel_tx, rel_rx) = channel::<()>();
        releases.push(rel_tx);
        let (store, held_tx) = (store.clone(), held_tx.clone());
        holders.push(thread::spawn(move || {
            store
                .read(|tx| {
                    tx.query_row("SELECT count(*) FROM settings", [], |r| r.get::<_, i64>(0))?;
                    held_tx.send(()).unwrap();
                    let _ = rel_rx.recv_timeout(Duration::from_secs(10));
                    Ok::<_, rusqlite::Error>(())
                })
                .unwrap()
        }));
    }
    for _ in 0..2 {
        held_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    }
    let t0 = Instant::now();
    let third = store.read(|tx| tx.query_row("SELECT 1", [], |r| r.get::<_, i64>(0)));
    let took = t0.elapsed();
    for r in releases {
        r.send(()).unwrap();
    }
    for h in holders {
        h.join().unwrap();
    }
    assert!(
        matches!(third, Err(ReadError::Busy)),
        "a third reader must wait, then give up"
    );
    assert!(
        took >= MS(200),
        "gave up after {took:?}, before the read wait"
    );
    assert!(!has(&store, "x"));
}

#[test]
fn a_long_read_is_cut_off_and_truncate_then_proceeds() {
    let path = db_path("engine-long-read");
    let store = Arc::new(
        Store::open(
            &path,
            Config {
                read_budget: MS(1500),
                idle_checkpoint: MS(100),
                ..fast()
            },
        )
        .unwrap(),
    );
    store.write(|tx| put(tx, "seed")).unwrap();

    let (in_tx, in_rx) = channel();
    let (done_tx, done_rx) = channel();
    {
        let store = store.clone();
        thread::spawn(move || {
            let t0 = Instant::now();
            let r = store.read(|tx| {
                tx.query_row("SELECT count(*) FROM settings", [], |r| r.get::<_, i64>(0))?; // 拿到快照
                in_tx.send(()).unwrap();
                tx.query_row(SPIN, [], |r| r.get::<_, i64>(0))
            });
            done_tx
                .send((matches!(r, Err(ReadError::OverBudget)), t0.elapsed()))
                .unwrap();
        });
    }
    in_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    for i in 0..20 {
        store.write(move |tx| put(tx, &format!("k{i}"))).unwrap();
    }

    let (over, took) = done_rx
        .recv_timeout(Duration::from_secs(6))
        .expect("the long read must be cut off");
    assert!(over, "the read must end as OverBudget");
    assert!(
        took >= MS(1400) && took < Duration::from_secs(5),
        "took {took:?}"
    );
    assert!(
        Stats::get(&store.stats().truncate_busy) >= 1,
        "the reader should have held truncate off first"
    );
    assert!(
        eventually(HANG_GUARD, || wal_len(&path) == 0),
        "once the reader is gone the WAL must be truncated"
    );
    assert_eq!(Stats::get(&store.stats().read_interrupts), 1);
}

/// W1 peer r4 P2-01：progress handler 只在 SQL 执行时跑。短 SQL 加长时间的 Rust 计算中断不了，
/// 但闭包返回时按耗时判为超时，结果丢弃；这和 SQL 被中断是两个不同的计数。
#[test]
fn a_read_that_is_slow_in_rust_is_over_budget() {
    let store = Arc::new(
        Store::open(
            &db_path("engine-slow-read"),
            Config {
                read_budget: MS(100),
                ..fast()
            },
        )
        .unwrap(),
    );
    store.write(|tx| put(tx, "seed")).unwrap();
    let (done_tx, done_rx) = channel();
    {
        let store = store.clone();
        thread::spawn(move || {
            let r = store.read(|tx| {
                let n =
                    tx.query_row("SELECT count(*) FROM settings", [], |r| r.get::<_, i64>(0))?;
                thread::sleep(MS(300));
                Ok::<_, rusqlite::Error>(n)
            });
            done_tx
                .send(matches!(r, Err(ReadError::OverBudget)))
                .unwrap();
        });
    }
    let over = done_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("the read must return");
    assert!(
        over,
        "a read that overran in Rust must not return its result"
    );
    assert_eq!(Stats::get(&store.stats().read_overruns), 1);
    assert_eq!(Stats::get(&store.stats().read_interrupts), 0);
    // 预算内的读不受影响。
    assert!(has(&store, "seed"));
}

/// W1 peer r4 P2-01：写预算从 BEGIN 成功开始计。等别的连接放开写锁的时间不算，
/// 所以它不是端到端时延的上限；作业本身很快时照常提交。
#[test]
fn the_write_budget_does_not_count_the_wait_for_begin() {
    let path = db_path("engine-begin-wait");
    let store = Arc::new(
        Store::open(
            &path,
            Config {
                write_budget: MS(150),
                ..fast()
            },
        )
        .unwrap(),
    );
    let (held_tx, held_rx) = channel();
    let holder = {
        let path = path.clone();
        thread::spawn(move || {
            let c = Connection::open(&path).unwrap();
            c.execute_batch("BEGIN IMMEDIATE").unwrap();
            held_tx.send(()).unwrap();
            thread::sleep(MS(500));
            c.execute_batch("COMMIT").unwrap();
        })
    };
    held_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (done_tx, done_rx) = channel();
    {
        let store = store.clone();
        thread::spawn(move || {
            let t0 = Instant::now();
            let r = store.write(|tx| put(tx, "after-wait"));
            done_tx.send((r.is_ok(), t0.elapsed())).unwrap();
        });
    }
    let (ok, took) = done_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("the write must finish once the lock is released");
    holder.join().unwrap();
    assert!(ok, "waiting for BEGIN is outside the write budget");
    assert!(
        took >= MS(300),
        "the write really waited for the lock ({took:?})"
    );
    assert!(has(&store, "after-wait"));
    assert_eq!(Stats::get(&store.stats().over_budget), 0);
}

/// W1 peer r4 P2-01：独占作业自己提交事务，之后返回的 Err 不会撤销已提交的内容。
/// 这条用例把这个合同钉住：谁要「失败即回滚」，就该用普通写作业。
#[test]
fn an_exclusive_job_that_fails_after_committing_stays_committed() {
    let store = Store::open(&db_path("engine-exclusive-result"), fast()).unwrap();
    let r = store
        .submit_exclusive(Duration::from_secs(5), |conn| {
            let tx = conn.transaction()?;
            put(&tx, "committed-then-failed")?;
            tx.commit()?;
            Err::<(), _>(rusqlite::Error::InvalidQuery)
        })
        .unwrap()
        .wait();
    assert!(matches!(r, Err(WriteError::Rejected(_))));
    assert!(
        has(&store, "committed-then-failed"),
        "an exclusive job's Err does not roll back what it already committed"
    );
    // 对照：普通写作业返回 Err 就是回滚。
    let r = store.write(|tx| {
        put(tx, "rolled-back")?;
        Err::<(), _>(rusqlite::Error::InvalidQuery)
    });
    assert!(matches!(r, Err(WriteError::Rejected(_))));
    assert!(!has(&store, "rolled-back"));
}

#[test]
fn writes_are_passively_checkpointed_when_the_queue_drains() {
    let path = db_path("engine-passive");
    let store = Store::open(&path, fast()).unwrap();
    store.write(|tx| put(tx, "k")).unwrap();
    assert!(eventually(HANG_GUARD, || Stats::get(
        &store.stats().passive_checkpoints
    ) >= 1));
    // PASSIVE 不截断 WAL；截断留给空闲或关闭。
    assert!(wal_len(&path) > 0);
    assert_eq!(Stats::get(&store.stats().truncate_checkpoints), 0);
}

#[test]
fn passive_checkpoints_keep_a_minimum_gap() {
    let gap = Duration::from_secs(1);
    let store = Store::open(
        &db_path("engine-gap"),
        Config {
            checkpoint_gap: gap,
            ..fast()
        },
    )
    .unwrap();
    let started = Instant::now();
    // 每次写完队列都空了，每次都会请求；停 5 ms 让不限流时每个请求都来得及单独做一次。
    for i in 0..40 {
        let k = format!("k{i}");
        store.write(move |tx| put(tx, &k)).unwrap();
        thread::sleep(MS(5));
    }
    // 限流后每个 gap 里最多做一次。
    let elapsed = started.elapsed().as_millis() as u64;
    let done = Stats::get(&store.stats().passive_checkpoints);
    assert!(
        done <= 1 + elapsed / 1000,
        "{done} passive checkpoints in {elapsed} ms"
    );
    // 被限流的请求不丢：gap 满了之后照样做。
    assert!(eventually(HANG_GUARD, || {
        Stats::get(&store.stats().passive_checkpoints) > done
    }));
}

#[test]
fn readers_that_never_let_go_cannot_grow_the_wal_past_its_soft_limit() {
    let path = db_path("engine-wal-limit");
    let store = Arc::new(
        Store::open(
            &path,
            Config {
                checkpoint_gap: MS(0),
                wal_soft_limit: 256 << 10,
                // 成功的 RESTART 约 30 ms。读者重叠时偶尔总有一个占着同一个 read mark，
                // 这时 RESTART 会等满这个时长后放弃（下次再试），所以不设太长：只拖慢测试，不改变结论。
                wal_restart_wait: MS(300),
                ..fast()
            },
        )
        .unwrap(),
    );
    // 两条只读连接接力：一条开了新快照，另一条才提交。任何时刻都有读者占着 WAL，与线程调度无关
    // （原先两个读者线程按时间错开，机器忙时会出现没有读者的空档，WAL 自然复用，用例偶发失败）。
    // PASSIVE 因此永远追不平，WAL 不会自己复用；没有 RESTART 时它只增不减。
    let stop = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = channel();
    let relay = {
        let (path, stop) = (path.clone(), stop.clone());
        thread::spawn(move || {
            let reader = || {
                let c =
                    Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
                c.busy_timeout(Duration::from_secs(10)).unwrap();
                c
            };
            let snapshot = |c: &Connection| {
                c.execute_batch("BEGIN").unwrap();
                c.query_row("SELECT count(*) FROM settings", [], |r| r.get::<_, i64>(0))
                    .unwrap();
            };
            let (mut holding, mut next) = (reader(), reader());
            snapshot(&holding);
            ready_tx.send(()).unwrap();
            let mut handoffs = 0u64;
            while !stop.load(Ordering::Relaxed) {
                snapshot(&next);
                holding.execute_batch("COMMIT").unwrap();
                std::mem::swap(&mut holding, &mut next);
                handoffs += 1;
                thread::sleep(MS(2));
            }
            holding.execute_batch("COMMIT").unwrap();
            handoffs
        })
    };
    // 第一个快照就位后才开始写。
    ready_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    // 不看峰值（取决于机器忙不忙，软上限也不是硬上限），看机制：RESTART 发生过，
    // 而且 WAL 被复用、按 journal_size_limit 截短过——不做 RESTART 时 WAL 一点不复用，文件只会变长。
    // 不按固定写入条数下结论：机器忙时（整包并发跑）第一次 PASSIVE 的复制与 fsync 可能比 600 条写入还慢。
    // 所以一直写到机制出现为止；600 条之后每条间隔 5 ms 让 checkpoint 线程追上，20 s 截止。
    let (mut previous, mut shrank) = (0, false);
    let deadline = Instant::now() + Duration::from_secs(20);
    for i in 0.. {
        if shrank && Stats::get(&store.stats().restart_checkpoints) >= 1
            || Instant::now() > deadline
        {
            break;
        }
        if i >= 600 {
            thread::sleep(MS(5));
        }
        let k = format!("k{i}");
        store
            .write(move |tx| {
                tx.execute(
                    "INSERT INTO settings (key, value_json, updated_at) VALUES (?1, json_quote(?2), 'T')",
                    [k, "x".repeat(3000)],
                )
                .map(|_| ())
            })
            .unwrap();
        let now = wal_len(&path);
        shrank |= now < previous;
        previous = now;
    }
    stop.store(true, Ordering::Relaxed);
    let handoffs = relay.join().unwrap();
    let (restarts, busy) = (
        Stats::get(&store.stats().restart_checkpoints),
        Stats::get(&store.stats().restart_busy),
    );
    let st = store.stats();
    let detail = format!(
        "{busy} busy, {} passive (max {} us), restart max {} us, job max {} us, wal {} bytes, {handoffs} handoffs",
        Stats::get(&st.passive_checkpoints),
        Stats::get(&st.passive_max_us),
        Stats::get(&st.restart_max_us),
        Stats::get(&st.job_max_us),
        wal_len(&path)
    );
    assert!(restarts >= 1, "no RESTART ({detail})");
    assert!(
        shrank,
        "the WAL was never reused and cut back ({restarts} restarts)"
    );
}

/// 队列一直有积压（从不排空）时，checkpoint 也照常进行，WAL 软上限照样生效。
#[test]
fn a_queue_that_never_drains_still_gets_checkpoints() {
    let path = db_path("engine-backlog");
    let store = Arc::new(
        Store::open(
            &path,
            Config {
                checkpoint_gap: MS(20),
                wal_soft_limit: 64 << 10,
                wal_restart_wait: Duration::from_secs(5),
                ..fast()
            },
        )
        .unwrap(),
    );
    // 闸门先占住写线程，把 180 个作业全排进队列，再一起放行。
    let (gate_tx, gate_rx) = channel::<()>();
    let gate = store
        .submit(move |tx| {
            let _ = gate_rx.recv_timeout(Duration::from_secs(10));
            put(tx, "gate")
        })
        .unwrap();
    let remaining = Arc::new(std::sync::atomic::AtomicUsize::new(180));
    let mut tickets = Vec::new();
    for i in 0..180 {
        let remaining = remaining.clone();
        tickets.push(
            store
                .submit(move |tx| {
                    tx.execute(
                        "INSERT INTO settings (key, value_json, updated_at) VALUES (?1, json_quote(?2), 'T')",
                        [format!("k{i}"), "x".repeat(32 << 10)],
                    )?;
                    thread::sleep(MS(5));
                    remaining.fetch_sub(1, Ordering::SeqCst);
                    Ok::<_, rusqlite::Error>(())
                })
                .unwrap(),
        );
    }
    gate_tx.send(()).unwrap();
    // 还剩 20 个以上作业在排队时，PASSIVE 与 RESTART 都已经发生过。
    let (mut passive, mut restart) = (0, 0);
    while remaining.load(Ordering::SeqCst) > 20 {
        passive = Stats::get(&store.stats().passive_checkpoints);
        restart = Stats::get(&store.stats().restart_checkpoints);
        thread::sleep(MS(5));
    }
    gate.wait().unwrap();
    for t in tickets {
        t.wait().unwrap();
    }
    assert!(passive >= 1, "no PASSIVE while the queue was backed up");
    assert!(
        restart >= 1,
        "no RESTART while the queue was backed up ({} busy, WAL {} bytes)",
        Stats::get(&store.stats().restart_busy),
        wal_len(&path)
    );
}

/// W1 peer r4 P2-05：关闭发生在 PASSIVE 进行中。已受理的写入照样执行完，新写入被拒；
/// PASSIVE 没结束之前关闭不返回（不会丢下 checkpoint 线程，也不会和它同时做最后的 TRUNCATE），
/// 结束之后照常收尾。
#[test]
fn shutdown_during_a_passive_checkpoint_waits_for_it() {
    let path = db_path("engine-shutdown-passive");
    let store = Arc::new(
        Store::open(
            &path,
            Config {
                checkpoint_gap: MS(10),
                ..fast()
            },
        )
        .unwrap(),
    );
    let hold = hold_next_passive(store.path());
    store.write(|tx| put(tx, "first")).unwrap();
    assert!(
        eventually(HANG_GUARD, || hold.entered()),
        "the checkpoint thread never started a PASSIVE"
    );
    assert_eq!(Stats::get(&store.stats().passive_running), 1);

    let tickets: Vec<_> = (0..5)
        .map(|i| {
            store
                .submit(move |tx| put(tx, &format!("queued-{i}")))
                .unwrap()
        })
        .collect();
    let (done_tx, done_rx) = channel();
    {
        let store = store.clone();
        thread::spawn(move || {
            store.shutdown();
            done_tx.send(()).unwrap();
        });
    }
    for t in tickets {
        match t.wait_timeout(Duration::from_secs(10)) {
            Waited::Done(r) => r.expect("writes admitted before shutdown still commit"),
            Waited::Pending(_) => panic!("a write admitted before shutdown was never executed"),
        }
    }
    assert!(
        done_rx.recv_timeout(MS(400)).is_err(),
        "shutdown returned while a PASSIVE was still running"
    );
    assert!(matches!(
        store.write(|tx| put(tx, "late")),
        Err(WriteError::Closed)
    ));

    assert_eq!(
        Stats::get(&store.stats().truncate_checkpoints),
        0,
        "the final TRUNCATE must wait for the checkpoint thread to stop"
    );
    hold.release();
    done_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("shutdown must finish once the PASSIVE does");
    assert_eq!(Stats::get(&store.stats().passive_running), 0);
    assert!(Stats::get(&store.stats().passive_checkpoints) >= 1);
    assert!(Stats::get(&store.stats().truncate_checkpoints) >= 1);
    assert_eq!(
        wal_len(&path),
        0,
        "the final TRUNCATE ran after the PASSIVE"
    );

    let c = open(&path).unwrap();
    let n: i64 = c
        .query_row(
            "SELECT count(*) FROM settings WHERE key LIKE 'queued-%' OR key = 'first'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 6);
    assert!(
        !c.query_row(
            "SELECT EXISTS (SELECT 1 FROM settings WHERE key = 'late')",
            [],
            |r| r.get::<_, bool>(0)
        )
        .unwrap()
    );
}

/// W1 peer r4 P2-05：关闭发生在 RESTART 进行中——一个读者一直占着快照，RESTART 在 SQLite 里等它。
/// 关闭要等 RESTART 等满时限，再执行完排队的写入；最后的 TRUNCATE 被同一个读者挡住，报 busy，
/// 关闭照样返回，不会挂住。读者离开后重开，数据完整。
#[test]
fn shutdown_during_a_restart_waits_it_out_and_truncate_reports_the_reader() {
    let path = db_path("engine-shutdown-restart");
    let store = Arc::new(
        Store::open(
            &path,
            Config {
                checkpoint_gap: MS(10),
                wal_soft_limit: 64 << 10,
                wal_restart_wait: Duration::from_secs(2),
                ..fast()
            },
        )
        .unwrap(),
    );
    store.write(|tx| put(tx, "seed")).unwrap();
    let reader = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    reader.execute_batch("BEGIN").unwrap();
    let _: i64 = reader
        .query_row("SELECT count(*) FROM settings", [], |r| r.get(0))
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut i = 0;
    loop {
        assert!(Instant::now() < deadline, "no RESTART started");
        store
            .write(move |tx| {
                tx.execute(
                    "INSERT INTO settings (key, value_json, updated_at) VALUES (?1, json_quote(?2), 'T')",
                    [format!("big-{i}"), "x".repeat(32 << 10)],
                )
                .map(|_| ())
            })
            .unwrap();
        i += 1;
        if eventually(MS(60), || Stats::get(&store.stats().restart_running) == 1) {
            break;
        }
    }

    let tickets: Vec<_> = (0..3)
        .map(|k| {
            store
                .submit(move |tx| put(tx, &format!("queued-{k}")))
                .unwrap()
        })
        .collect();
    let (done_tx, done_rx) = channel();
    {
        let store = store.clone();
        thread::spawn(move || {
            store.shutdown();
            done_tx.send(()).unwrap();
        });
    }
    assert!(
        done_rx.recv_timeout(MS(300)).is_err(),
        "shutdown returned while the RESTART was still waiting for the reader"
    );
    done_rx
        .recv_timeout(Duration::from_secs(15))
        .expect("shutdown must not hang behind a reader");
    for t in tickets {
        match t.wait_timeout(Duration::from_secs(10)) {
            Waited::Done(r) => r.expect("writes admitted before shutdown still commit"),
            Waited::Pending(_) => panic!("a write admitted before shutdown was never executed"),
        }
    }
    assert!(
        Stats::get(&store.stats().restart_busy) >= 1,
        "the reader held the RESTART off"
    );
    assert!(
        Stats::get(&store.stats().truncate_busy) >= 1,
        "the final TRUNCATE must report the reader, not wait for it"
    );
    assert!(wal_len(&path) > 0);
    drop(reader);

    let c = open(&path).unwrap();
    let ok: String = c
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .unwrap();
    assert_eq!(ok, "ok");
    let n: i64 = c
        .query_row(
            "SELECT count(*) FROM settings WHERE key LIKE 'queued-%' OR key LIKE 'big-%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 3 + i);
}

#[test]
fn an_idle_writer_truncates_the_wal_and_so_does_shutdown() {
    let path = db_path("engine-idle");
    let store = Store::open(
        &path,
        Config {
            idle_checkpoint: MS(100),
            ..fast()
        },
    )
    .unwrap();
    store.write(|tx| put(tx, "k")).unwrap();
    // WAL 先被截成 0、计数随后才加：两者一起等，不在中间读计数。
    assert!(eventually(HANG_GUARD, || {
        wal_len(&path) == 0 && Stats::get(&store.stats().truncate_checkpoints) >= 1
    }));

    let path = db_path("engine-close");
    let store = Store::open(&path, fast()).unwrap(); // 空闲 60 s，等不到
    store.write(|tx| put(tx, "k")).unwrap();
    assert!(wal_len(&path) > 0);
    store.shutdown(); // 读连接还开着，SQLite 自己不会收 WAL
    assert_eq!(wal_len(&path), 0);
    assert_eq!(Stats::get(&store.stats().truncate_checkpoints), 1);
}

const CRASH_DB: &str = "ATM_STORE_CRASH_DB";
const CRASH_MARKER: &str = "ATM_STORE_CRASH_MARKER";

#[test]
fn a_writer_killed_mid_transaction_leaves_a_consistent_database() {
    let path = db_path("engine-crash");
    let marker = path.with_file_name("in-tx");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "crash_child",
            "--exact",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CRASH_DB, &path)
        .env(CRASH_MARKER, &marker)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let reached = eventually(Duration::from_secs(30), || marker.exists());
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(
        reached,
        "the child never reached the middle of its transaction"
    );

    let c = open(&path).unwrap();
    let integrity: String = c
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .unwrap();
    assert_eq!(integrity, "ok");
    let fk: i64 = c
        .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(fk, 0);
    let count = |sql: &str| c.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
    assert_eq!(
        count("SELECT count(*) FROM settings WHERE key = 'committed'"),
        1
    );
    assert_eq!(
        count("SELECT count(*) FROM settings WHERE key LIKE 'pending-%'"),
        0,
        "uncommitted rows survived"
    );
}

/// 上一条用例的子进程：提交一行，再在第二个写事务中途停住，等父进程杀掉。
#[test]
#[ignore = "run as a child process by a_writer_killed_mid_transaction_leaves_a_consistent_database"]
fn crash_child() {
    let (Some(path), Some(marker)) = (std::env::var_os(CRASH_DB), std::env::var_os(CRASH_MARKER))
    else {
        return;
    };
    let store = Store::open(Path::new(&path), fast()).unwrap();
    store.write(|tx| put(tx, "committed")).unwrap();
    let _pending = store
        .submit(move |tx| {
            for i in 0..500 {
                put(tx, &format!("pending-{i}"))?;
            }
            std::fs::write(&marker, b"in-tx").unwrap();
            thread::sleep(Duration::from_secs(120));
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    thread::sleep(Duration::from_secs(120));
}

#[test]
fn observers_wake_on_each_finished_job_and_on_shutdown() {
    let store = Arc::new(Store::open(&db_path("wait-for-writes"), fast()).unwrap());
    let seen = store.write_mark();
    // 没有作业：等满时限，标记不变。
    let started = Instant::now();
    assert_eq!(store.wait_for_writes(seen, MS(150)), Some(seen));
    assert!(started.elapsed() >= MS(150));

    // 一个等着的观察者，被另一条线程的写入叫醒（不是等满时限）。
    let (tx, rx) = channel();
    let waiter = {
        let store = store.clone();
        thread::spawn(move || {
            let started = Instant::now();
            tx.send((
                store.wait_for_writes(seen, Duration::from_secs(20)),
                started.elapsed(),
            ))
            .unwrap();
        })
    };
    thread::sleep(MS(100));
    store.write(|tx| put(tx, "a")).unwrap();
    let (woke, after) = rx.recv_timeout(Duration::from_secs(10)).unwrap();
    waiter.join().unwrap();
    assert_eq!(woke.map(|m| m.jobs), Some(seen.jobs + 1));
    assert!(after < Duration::from_secs(10), "{after:?}");

    // 失败回滚的作业也算执行完；拿旧标记来等，立刻返回。
    let _ = store.write(|_| Err::<(), _>("no"));
    assert_eq!(store.write_mark().jobs, seen.jobs + 2);
    let started = Instant::now();
    assert_eq!(
        store.wait_for_writes(seen, Duration::from_secs(20)),
        Some(store.write_mark())
    );
    assert!(started.elapsed() < Duration::from_secs(10));

    // 叫醒在等之前发生也算：观察者记下标记之后、进入等待之前被叫停，不会白等一个时限。
    let before = store.write_mark();
    store.wake_waiters();
    let started = Instant::now();
    let after = store
        .wait_for_writes(before, Duration::from_secs(20))
        .unwrap();
    assert!(started.elapsed() < Duration::from_secs(10));
    assert_eq!((after.jobs, after.wakes), (before.jobs, before.wakes + 1));

    // 叫醒正在等的线程。
    let current = store.write_mark();
    let (tx, rx) = channel();
    let waiter = {
        let store = store.clone();
        thread::spawn(move || {
            tx.send(store.wait_for_writes(current, Duration::from_secs(20)))
                .unwrap();
        })
    };
    thread::sleep(MS(100));
    store.wake_waiters();
    let woke = rx.recv_timeout(Duration::from_secs(10)).unwrap().unwrap();
    waiter.join().unwrap();
    assert_eq!(woke.jobs, current.jobs);

    // 关闭叫醒等着的观察者，之后的等待立刻返回 None。
    let current = store.write_mark();
    let (tx, rx) = channel();
    let waiter = {
        let store = store.clone();
        thread::spawn(move || {
            tx.send(store.wait_for_writes(current, Duration::from_secs(20)))
                .unwrap();
        })
    };
    thread::sleep(MS(100));
    store.shutdown();
    assert_eq!(rx.recv_timeout(Duration::from_secs(10)).unwrap(), None);
    waiter.join().unwrap();
    assert_eq!(
        store.wait_for_writes(current, Duration::from_secs(20)),
        None
    );
}
