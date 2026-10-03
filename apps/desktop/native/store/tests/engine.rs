//! 写线程、读连接池与 checkpoint 的验收（W1b）。
//!
//! 可能卡死的操作（变异后读不返回、写线程被占住）都放在子线程里跑，主线程限时等结果；
//! 子线程持有 `Arc<Store>`，超时 panic 时不会在主线程里 join 一个停不下来的写线程。

use atm_store::{Config, ReadError, Stats, Store, Waited, WriteError, open};
use rusqlite::{ErrorCode, Transaction};
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
    assert!(eventually(Duration::from_secs(5), || has(&store, "slow")));
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
        eventually(Duration::from_secs(5), || wal_len(&path) == 0),
        "once the reader is gone the WAL must be truncated"
    );
    assert_eq!(Stats::get(&store.stats().read_interrupts), 1);
}

#[test]
fn writes_are_passively_checkpointed_when_the_queue_drains() {
    let path = db_path("engine-passive");
    let store = Store::open(&path, fast()).unwrap();
    store.write(|tx| put(tx, "k")).unwrap();
    assert!(eventually(Duration::from_secs(2), || Stats::get(
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
    assert!(eventually(Duration::from_secs(3), || {
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
                // 成功的 RESTART 约 30 ms。两个读者重叠时总有一个占着同一个 read mark，
                // 这时 RESTART 会等满这个时长后放弃（下次再试），所以不设太长：只拖慢测试，不改变结论。
                wal_restart_wait: MS(300),
                ..fast()
            },
        )
        .unwrap(),
    );
    // 两个读者错开 3 ms、各自持有快照 6 ms：任何时刻都有读者占着 WAL，PASSIVE 永远追不平，
    // WAL 不会被复用。没有 RESTART 时它只增不减。
    let stop = Arc::new(AtomicBool::new(false));
    let readers: Vec<_> = (0..2)
        .map(|i| {
            let (store, stop) = (store.clone(), stop.clone());
            thread::spawn(move || {
                thread::sleep(MS(i * 3));
                while !stop.load(Ordering::Relaxed) {
                    let _ = store.read(|tx| {
                        tx.query_row("SELECT count(*) FROM settings", [], |r| r.get::<_, i64>(0))?;
                        thread::sleep(MS(6));
                        Ok::<_, rusqlite::Error>(())
                    });
                }
            })
        })
        .collect();
    // 不看峰值（取决于机器忙不忙，软上限也不是硬上限），看机制：RESTART 发生过，
    // 而且 WAL 被复用、按 journal_size_limit 截短过——不做 RESTART 时 WAL 一点不复用，文件只会变长。
    let (mut previous, mut shrank) = (0, false);
    for i in 0..600 {
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
    for r in readers {
        r.join().unwrap();
    }
    let (restarts, busy) = (
        Stats::get(&store.stats().restart_checkpoints),
        Stats::get(&store.stats().restart_busy),
    );
    assert!(restarts >= 1, "no RESTART ({busy} busy)");
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
    assert!(eventually(Duration::from_secs(3), || wal_len(&path) == 0));
    assert!(Stats::get(&store.stats().truncate_checkpoints) >= 1);

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
