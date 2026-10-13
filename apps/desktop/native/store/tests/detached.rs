//! 不写源目录地读（`detached`）在源库正被别的连接写时的行为（W8 关口 peer r2 P1-01、P1-02、P2-01）。
//!
//! 写者都在另一条线程、用另一个连接：冻结按 SQLite 的字节锁协议挡住它们，读完才放行。每条都核对两件事：
//! 读到的是某一次提交后的状态，而且写者在读的这段时间里确实没有完成（不是碰巧没撞上）。

use atm_store::conversion as cv;
use atm_store::detached::{self, Error};
use rusqlite::{Connection, params};
use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

const G: &str = "01K0000000000000000000000G";
const AT: &str = "2026-10-12T00:00:00.000Z";

fn dir(name: &str) -> PathBuf {
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../target"));
    let d = target.join("store-tests").join("detached").join(name);
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

/// 源库放在 `d\src\` 里，暂存目录在它旁边（不许在源目录里）。
fn source(d: &Path, name: &str) -> PathBuf {
    let src = d.join("src");
    fs::create_dir_all(&src).unwrap();
    src.join(name)
}

/// 建一个目录联接（junction，不要特权）。
fn junction(link: &Path, target: &Path) {
    let r = std::process::Command::new("cmd")
        .arg("/c")
        .arg("mklink")
        .arg("/J")
        .arg(link)
        .arg(target)
        .output()
        .unwrap();
    assert!(r.status.success(), "{r:?}");
}

/// 是 junction / 符号链接（不跟进地看）。
fn is_link(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink())
}

/// 一个有未 checkpoint 帧的 WAL 库（读它要复制）；返回的连接开着，帧就一直在。
fn wal_source(db: &Path) -> Connection {
    let c = Connection::open(db).unwrap();
    c.execute_batch("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE marker(x); INSERT INTO marker VALUES (1);")
        .unwrap();
    assert!(detached::wal_has_frames(db));
    c
}

fn marker(c: &Connection) -> rusqlite::Result<i64> {
    c.query_row("SELECT x FROM marker", [], |r| r.get(0))
}

fn suffix(p: &Path, s: &str) -> PathBuf {
    PathBuf::from(format!("{}{s}", p.display()))
}

/// 给写者的那段时间：写者没被挡住的话，这段时间足够它做完。
const WINDOW: Duration = Duration::from_millis(400);

/// 写者用的连接：新开一个，或者一个早就开着、握着 SHARED 的（挪到另一条线程上用，peer r3）。
enum By {
    New,
    Open(Connection),
}

/// 在另一条线程上跑 `write`，返回「它做完了」的信号。
fn writer(
    db: &Path,
    by: By,
    write: impl FnOnce(&Connection) + Send + 'static,
) -> mpsc::Receiver<()> {
    let (done, finished) = mpsc::channel();
    let db = db.to_path_buf();
    thread::spawn(move || {
        let c = match by {
            By::New => Connection::open(&db).unwrap(),
            By::Open(c) => c,
        };
        c.busy_timeout(Duration::from_secs(30)).unwrap();
        write(&c);
        done.send(()).unwrap();
    });
    finished
}

fn blocked_for_the_window(finished: &mpsc::Receiver<()>) {
    thread::sleep(WINDOW);
    assert!(
        finished.try_recv().is_err(),
        "the writer finished while the source was being read"
    );
}

/// peer r2 P1-01：主文件里 generation 那一页可读却是错值，`-wal` 里同一页是对的。判定读的是 SQLite 正常打开时
/// 看到的已提交状态（连同 `-wal`），不是单独的主文件：不能把这个错值当成代际不符去隔离这一代。
#[test]
fn a_wrong_generation_in_the_main_file_is_overridden_by_the_valid_wal() {
    let d = dir("generation-in-wal");
    let layout = cv::Layout::new(d.join("n"));
    let m = cv::fresh_install(&layout, G, AT).unwrap();
    let db = layout.database();
    // 在旁边一份上写出 WAL（generation 那一页随之进 WAL），再连同 WAL 放回来，像服务被杀时那样。
    let side = d.join("side.sqlite");
    fs::copy(&db, &side).unwrap();
    let c = Connection::open(&side).unwrap();
    c.execute_batch(
        "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
         UPDATE app_meta SET instance_epoch = 'new-epoch';",
    )
    .unwrap();
    fs::copy(&side, &db).unwrap();
    fs::copy(suffix(&side, "-wal"), suffix(&db, "-wal")).unwrap();
    drop(c);
    let mut bytes = fs::read(&db).unwrap();
    let at = bytes
        .windows(G.len())
        .position(|w| w == G.as_bytes())
        .unwrap();
    bytes[at + G.len() - 1] = b'H';
    fs::write(&db, bytes).unwrap();
    assert!(detached::wal_has_frames(&db));

    let wal = fs::read(suffix(&db, "-wal")).unwrap();
    assert_eq!(cv::decide(&layout, false), cv::Startup::Published(m));
    // 判定也没动源：主文件仍是那个错值，WAL 原样。
    assert!(
        fs::read(&db)
            .unwrap()
            .windows(G.len())
            .all(|w| w != G.as_bytes())
    );
    assert_eq!(fs::read(suffix(&db, "-wal")).unwrap(), wal);
}

/// peer r2 P1-02（回滚日志模式）：读的时候另一个连接开写事务、小缓存把脏页溢写进库文件。冻结时它连 SHARED 都拿不到，
/// 读到的是已提交的 1；读完它才写完。
#[test]
fn a_rollback_journal_writer_waits_until_the_read_is_done() {
    let d = dir("rollback-writer");
    let db = source(&d, "source.sqlite");
    let c = Connection::open(&db).unwrap();
    c.execute_batch(
        "PRAGMA journal_mode = DELETE; CREATE TABLE marker(x); INSERT INTO marker VALUES (1);
         CREATE TABLE filler(x);",
    )
    .unwrap();
    drop(c);
    let finished = RefCell::new(None);
    let value = detached::read(&db, &d.join("scratch"), |reader| {
        *finished.borrow_mut() = Some(writer(&db, By::New, |w| {
            w.execute_batch("PRAGMA cache_size = 1; BEGIN IMMEDIATE; UPDATE marker SET x = 2;")
                .unwrap();
            for _ in 0..2000 {
                w.execute("INSERT INTO filler VALUES (?1)", params!["x".repeat(500)])
                    .unwrap();
            }
            w.execute_batch("COMMIT").unwrap();
        }));
        blocked_for_the_window(finished.borrow().as_ref().unwrap());
        reader.query_row("SELECT x FROM marker", [], |r| r.get::<_, i64>(0))
    });
    assert_eq!(value.unwrap(), 1);
    finished
        .into_inner()
        .unwrap()
        .recv_timeout(Duration::from_secs(30))
        .unwrap();
    let after: i64 = detached::read(&db, &d.join("scratch"), |c| {
        c.query_row("SELECT x FROM marker", [], |r| r.get(0))
    })
    .unwrap();
    assert_eq!(after, 2);
}

/// 一个事务里把两张表都改成 1，再 checkpoint 截掉 `-wal`。
const BOTH_TO_ONE: &str =
    "BEGIN; UPDATE left_value SET x = 1; UPDATE right_value SET x = 1; COMMIT;
                           PRAGMA wal_checkpoint(TRUNCATE);";

/// 同一条查询读两张表：中间另一个连接（`by`）跑 `write`、把两张表一起改掉。读到的必须是同一次提交的两个值。
fn two_tables_in_one_query(
    db: &Path,
    scratch: &Path,
    by: By,
    write: impl FnOnce(&Connection) + Send + 'static,
) -> (i64, i64) {
    let finished = RefCell::new(None);
    let job = RefCell::new(Some((by, write)));
    let pair = detached::read(db, scratch, |reader| {
        let mut stmt =
            reader.prepare("SELECT x FROM left_value UNION ALL SELECT x FROM right_value")?;
        let mut rows = stmt.query([])?;
        let left = rows.next()?.unwrap().get::<_, i64>(0)?;
        let (by, write) = job.borrow_mut().take().unwrap();
        *finished.borrow_mut() = Some(writer(db, by, write));
        blocked_for_the_window(finished.borrow().as_ref().unwrap());
        let right = rows.next()?.unwrap().get::<_, i64>(0)?;
        Ok::<_, rusqlite::Error>((left, right))
    })
    .unwrap();
    finished
        .into_inner()
        .unwrap()
        .recv_timeout(Duration::from_secs(30))
        .unwrap();
    pair
}

fn two_tables(db: &Path) -> Connection {
    let c = Connection::open(db).unwrap();
    c.execute_batch(
        "PRAGMA journal_mode = WAL; CREATE TABLE left_value(x); CREATE TABLE right_value(x);
         INSERT INTO left_value VALUES (0); INSERT INTO right_value VALUES (0);",
    )
    .unwrap();
    c
}

/// peer r2 P1-02（WAL，正常关闭、没有别的连接）：新连接拿不到 SHARED，追加与 checkpoint 都等读完。
#[test]
fn a_new_wal_connection_waits_until_the_query_is_done() {
    let d = dir("wal-new-connection");
    let db = source(&d, "source.sqlite");
    drop(two_tables(&db));
    assert!(!suffix(&db, "-shm").exists() && !detached::wal_has_frames(&db));
    assert_eq!(
        two_tables_in_one_query(&db, &d.join("scratch"), By::New, |w| w
            .execute_batch(BOTH_TO_ONE)
            .unwrap()),
        (0, 0)
    );
}

/// 两张表现在的值（新开一个连接读）。
fn both(db: &Path) -> (i64, i64) {
    Connection::open(db)
        .unwrap()
        .query_row(
            "SELECT (SELECT x FROM left_value), (SELECT x FROM right_value)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
}

/// 一个早就开着的 WAL 连接（握着 SHARED、`-shm` 在，`-wal` 刚 checkpoint 成空的）自己来写：它不必再拿 PENDING，
/// 挡住它的是 `-shm` 上的写锁与 checkpoint 锁（peer r3 指出原来的用例写者是新开的连接，量不到这一道）。
#[test]
fn a_wal_connection_already_open_waits_until_the_query_is_done() {
    let d = dir("wal-open-connection");
    let db = source(&d, "source.sqlite");
    let live = two_tables(&db);
    live.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .unwrap();
    assert!(suffix(&db, "-shm").exists() && !detached::wal_has_frames(&db));
    let pair = two_tables_in_one_query(&db, &d.join("scratch"), By::Open(live), |w| {
        w.execute_batch(BOTH_TO_ONE).unwrap()
    });
    assert_eq!(pair, (0, 0));
    assert_eq!(both(&db), (1, 1));
}

/// peer r3 P1-01：开着的连接切到 `locking_mode=EXCLUSIVE` 再写。它从 SHARED 直接要 EXCLUSIVE，不经过 PENDING，
/// 也不再用 `-shm` 的锁；挡住它的是冻结握着的 SHARED 区。
#[test]
fn a_wal_connection_switching_to_exclusive_locking_waits_until_the_query_is_done() {
    let d = dir("wal-exclusive-locking");
    let db = source(&d, "source.sqlite");
    let live = two_tables(&db);
    live.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .unwrap();
    let pair = two_tables_in_one_query(&db, &d.join("scratch"), By::Open(live), |w| {
        w.execute_batch(&format!("PRAGMA locking_mode = EXCLUSIVE; {BOTH_TO_ONE}"))
            .unwrap()
    });
    assert_eq!(pair, (0, 0));
    assert_eq!(both(&db), (1, 1));
}

/// 同上一类：开着的连接把库从 WAL 切回回滚日志模式再写（切换要 EXCLUSIVE）。冻结时切不过去（SQLite 对这一步
/// 不调 busy handler，直接报 busy），写者自己重试；读完才切得过去。
#[test]
fn a_connection_leaving_wal_mode_waits_until_the_query_is_done() {
    let d = dir("wal-to-delete");
    let db = source(&d, "source.sqlite");
    let live = two_tables(&db);
    live.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .unwrap();
    let pair = two_tables_in_one_query(&db, &d.join("scratch"), By::Open(live), |w| {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            let mode: Result<String, _> =
                w.query_row("PRAGMA journal_mode = DELETE", [], |r| r.get(0));
            if mode.as_deref() == Ok("delete") {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "{mode:?}");
            thread::sleep(Duration::from_millis(20));
        }
        w.execute_batch(
            "BEGIN; UPDATE left_value SET x = 1; UPDATE right_value SET x = 1; COMMIT;",
        )
        .unwrap();
    });
    assert_eq!(pair, (0, 0));
    assert_eq!(both(&db), (1, 1));
}

/// 开着的写事务一直不提交（WAL 的写锁一直被占着）：冻结不了，期限到了报 Busy，不读不确定的内容。
#[test]
fn a_writer_that_never_lets_go_is_reported_busy() {
    let d = dir("busy");
    let db = source(&d, "source.sqlite");
    let live = two_tables(&db);
    live.execute_batch("BEGIN IMMEDIATE; UPDATE left_value SET x = 7;")
        .unwrap();
    let r = detached::read_patiently(&db, &d.join("scratch"), Duration::from_millis(300), |c| {
        c.query_row("SELECT x FROM left_value", [], |r| r.get::<_, i64>(0))
    });
    assert!(matches!(r, Err(Error::Busy(_))), "{r:?}");
    live.execute_batch("COMMIT").unwrap();
    let r = detached::read_patiently(&db, &d.join("scratch"), Duration::from_millis(300), |c| {
        c.query_row("SELECT x FROM left_value", [], |r| r.get::<_, i64>(0))
    });
    assert_eq!(r.unwrap(), 7);

    // 回滚日志模式里握着 EXCLUSIVE 的写者同理。
    let db = source(&d, "rollback.sqlite");
    let c = Connection::open(&db).unwrap();
    c.execute_batch("PRAGMA journal_mode = DELETE; CREATE TABLE t(x); INSERT INTO t VALUES (1);")
        .unwrap();
    c.execute_batch("BEGIN EXCLUSIVE; UPDATE t SET x = 2;")
        .unwrap();
    let r = detached::read_patiently(&db, &d.join("scratch"), Duration::from_millis(300), |c| {
        c.query_row("SELECT x FROM t", [], |r| r.get::<_, i64>(0))
    });
    assert!(matches!(r, Err(Error::Busy(_))), "{r:?}");
    c.execute_batch("ROLLBACK").unwrap();
}

/// peer r2 P2-01：暂存目录还不存在、却落在源目录里，照样拒绝，也不在源目录里建任何东西；不存在而在源目录外的，
/// 按需建出来，读完连同新建的上级一起拿掉。
#[test]
fn a_scratch_inside_the_source_is_refused_even_before_it_exists() {
    let d = dir("scratch-location");
    let src = d.join("src");
    fs::create_dir_all(&src).unwrap();
    let db = src.join("source.sqlite");
    let c = Connection::open(&db).unwrap();
    c.execute_batch("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE marker(x); INSERT INTO marker VALUES (1);")
        .unwrap();
    let q = |c: &Connection| c.query_row("SELECT x FROM marker", [], |r| r.get::<_, i64>(0));

    for scratch in [
        src.join("new-parent").join("scratch"),
        src.join("scratch"),
        src.clone(),
        d.join("elsewhere").join("..").join("src").join("x"),
    ] {
        let r = detached::read(&db, &scratch, q);
        assert!(
            matches!(r, Err(Error::Open(_))),
            "{}: {r:?}",
            scratch.display()
        );
    }
    let mut left: Vec<_> = fs::read_dir(&src)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    left.sort();
    assert_eq!(
        left,
        ["source.sqlite", "source.sqlite-shm", "source.sqlite-wal"]
    );
    assert!(!d.join("elsewhere").exists());

    let outside = d.join("new-a").join("new-b").join("scratch");
    assert_eq!(detached::read(&db, &outside, q).unwrap(), 1);
    assert!(
        !d.join("new-a").exists(),
        "the directories made for the copy are removed"
    );
    drop(c);
}

/// 被杀的进程留在暂存目录里的副本，下一次读时清掉；活着的进程的留着。
#[test]
fn copies_left_by_a_dead_process_are_swept_on_the_next_read() {
    let d = dir("sweep");
    let db = source(&d, "source.sqlite");
    let c = Connection::open(&db).unwrap();
    c.execute_batch("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE marker(x); INSERT INTO marker VALUES (1);")
        .unwrap();
    let scratch = d.join("scratch");
    // 一个已经退出的进程的 pid。
    let mut child = std::process::Command::new("cmd")
        .args(["/c", "exit"])
        .spawn()
        .unwrap();
    let dead = child.id();
    child.wait().unwrap();
    // 一个还在跑的进程的 pid（读完就结束它）。
    let mut running = std::process::Command::new("ping")
        .args(["-n", "60", "127.0.0.1"])
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let left = scratch.join(format!("read-{dead}-0"));
    let alive = scratch.join(format!("read-{}-999", std::process::id()));
    let other = scratch.join(format!("read-{}-0", running.id()));
    // 名字不是 `read-<pid>-<序号>` 的、不是目录的，都不是这里起的，不碰（peer r3 P2-01）。
    let unmatched = scratch.join(format!("read-{dead}-not-a-sequence"));
    let not_a_copy = scratch.join(format!("read-{dead}"));
    for dir in [&left, &alive, &other, &unmatched, &not_a_copy] {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("db.sqlite"), b"left over").unwrap();
    }
    let plain_file = scratch.join(format!("read-{dead}-1"));
    fs::write(&plain_file, b"a file").unwrap();
    // 名字对得上的 junction 不跟进，也不删（peer r5）。
    let linked_target = d.join("linked-target");
    fs::create_dir_all(&linked_target).unwrap();
    fs::write(linked_target.join("db.sqlite"), b"not a copy").unwrap();
    let linked = scratch.join(format!("read-{dead}-2"));
    junction(&linked, &linked_target);
    // 遗留副本里有个和副本文件同名的 junction：不跟进，也不当文件删。
    let odd = scratch.join(format!("read-{dead}-4"));
    fs::create_dir_all(&odd).unwrap();
    fs::write(odd.join("db.sqlite"), b"left over").unwrap();
    junction(&odd.join("db.sqlite-shm"), &linked_target);
    // 遗留副本里多了别的东西：只删副本的文件，别的留着，目录也就留着。
    let more = scratch.join(format!("read-{dead}-3"));
    fs::create_dir_all(&more).unwrap();
    fs::write(more.join("db.sqlite"), b"left over").unwrap();
    fs::write(more.join("user-file.txt"), b"must remain").unwrap();
    let v = detached::read(&db, &scratch, |c| {
        c.query_row("SELECT x FROM marker", [], |r| r.get::<_, i64>(0))
    });
    assert_eq!(v.unwrap(), 1);
    assert!(!left.exists());
    assert!(alive.exists());
    assert!(other.join("db.sqlite").exists());
    running.kill().unwrap();
    running.wait().unwrap();
    assert!(unmatched.join("db.sqlite").exists() && not_a_copy.join("db.sqlite").exists());
    assert!(plain_file.is_file());
    assert!(is_link(&linked));
    assert!(!more.join("db.sqlite").exists());
    assert!(!odd.join("db.sqlite").exists());
    assert!(
        is_link(&odd.join("db.sqlite-shm")),
        "a link in a copy was removed"
    );
    assert_eq!(
        fs::read(more.join("user-file.txt")).unwrap(),
        b"must remain"
    );
    assert_eq!(
        fs::read(linked_target.join("db.sqlite")).unwrap(),
        b"not a copy"
    );
    drop(c);
}

/// peer r3 P2-02：暂存目录建到一半失败（第二层是 Windows 不认的名字），这次新建的上级也拿掉，再报错。
#[test]
fn a_scratch_that_cannot_be_made_leaves_no_parents_behind() {
    let d = dir("scratch-error");
    let db = source(&d, "source.sqlite");
    let c = Connection::open(&db).unwrap();
    c.execute_batch("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE marker(x); INSERT INTO marker VALUES (1);")
        .unwrap();
    let scratch = d
        .join("created-parent")
        .join("invalid<name")
        .join("scratch");
    let r = detached::read(&db, &scratch, |c| {
        c.query_row("SELECT x FROM marker", [], |r| r.get::<_, i64>(0))
    });
    assert!(matches!(r, Err(Error::Open(_))), "{r:?}");
    assert!(!d.join("created-parent").exists());
    drop(c);
}

/// 冻结也守 PENDING：一个写者已经拿着 PENDING、在等别的读者读完好提交，冻结让它先提交，而不是和读者一起把它
/// 再挡一会儿（多挡的那段可能就让它等过自己的 busy_timeout）。SHARED 区只管挡 EXCLUSIVE；守 PENDING 是为了不插队。
#[test]
fn a_writer_already_waiting_to_commit_goes_first() {
    let d = dir("pending-writer-first");
    let db = source(&d, "source.sqlite");
    let c = Connection::open(&db).unwrap();
    c.execute_batch(
        "PRAGMA journal_mode = DELETE; CREATE TABLE marker(x); INSERT INTO marker VALUES (1);",
    )
    .unwrap();
    drop(c);
    // 读者：开着读事务（握着 SHARED）800 ms。
    let reader_db = db.clone();
    let reader = thread::spawn(move || {
        let r = Connection::open(&reader_db).unwrap();
        r.execute_batch("BEGIN;").unwrap();
        let _: i64 = r
            .query_row("SELECT x FROM marker", [], |row| row.get(0))
            .unwrap();
        thread::sleep(Duration::from_millis(800));
        r.execute_batch("COMMIT;").unwrap();
    });
    thread::sleep(Duration::from_millis(100));
    // 写者：提交时拿到 PENDING，等读者放手。
    let finished = writer(&db, By::New, |w| {
        w.execute_batch("BEGIN IMMEDIATE; UPDATE marker SET x = 2; COMMIT;")
            .unwrap()
    });
    thread::sleep(Duration::from_millis(300));
    assert!(
        finished.try_recv().is_err(),
        "the writer should still be waiting for the reader"
    );
    let value = detached::read(&db, &d.join("scratch"), |c| {
        c.query_row("SELECT x FROM marker", [], |r| r.get::<_, i64>(0))
    })
    .unwrap();
    assert_eq!(
        value, 2,
        "the read went ahead of a writer that was waiting to commit"
    );
    finished.recv_timeout(Duration::from_secs(30)).unwrap();
    reader.join().unwrap();
}

/// peer r4 P1-01：暂存目录反过来包含源库（源库在 `scratch\read-<已退出的 pid>-1\` 下，看上去就像一个遗留副本），
/// 清扫会把它连同旁边的文件一起删掉。在清扫之前就拒绝：源库、旁边的文件、暂存目录里的东西都原样。
#[test]
fn a_scratch_that_holds_the_source_is_refused_before_anything_is_removed() {
    let d = dir("scratch-holds-source");
    let scratch = d.join("scratch");
    let root = scratch.join("read-4294967295-1");
    fs::create_dir_all(root.join("data")).unwrap();
    let db = root.join("data").join("atm.sqlite");
    let c = Connection::open(&db).unwrap();
    c.execute_batch("CREATE TABLE marker(x); INSERT INTO marker VALUES (1);")
        .unwrap();
    drop(c);
    fs::write(root.join("user-file.txt"), b"must remain").unwrap();
    let original = fs::read(&db).unwrap();
    for scratch in [scratch.clone(), root.clone(), root.join("data")] {
        let r = detached::read(&db, &scratch, |c| {
            c.query_row("SELECT x FROM marker", [], |r| r.get::<_, i64>(0))
        });
        assert!(
            matches!(&r, Err(Error::Open(e)) if e.contains("contains") || e.contains("inside")),
            "{}: {r:?}",
            scratch.display()
        );
        assert_eq!(fs::read(&db).unwrap(), original);
        assert!(root.join("user-file.txt").exists());
    }
    // 对照：同一个源库，换一个不包含它的暂存目录，读得到；暂存目录里已退出进程的遗留副本照常清掉。
    let elsewhere = d.join("elsewhere");
    let left = elsewhere.join("read-4294967295-0");
    fs::create_dir_all(&left).unwrap();
    let v = detached::read(&db, &elsewhere, |c| {
        c.query_row("SELECT x FROM marker", [], |r| r.get::<_, i64>(0))
    });
    assert_eq!(v.unwrap(), 1);
    assert!(!left.exists());
}

/// peer r5 P2-01：调用方原有的暂存目录读完还在——普通目录如此，指向别处的 junction 也如此，它指向的东西不动。
#[test]
fn a_scratch_that_was_already_there_is_kept_and_so_is_a_link() {
    let d = dir("scratch-kept");
    let db = source(&d, "source.sqlite");
    let c = wal_source(&db);
    let plain = d.join("plain");
    fs::create_dir_all(&plain).unwrap();
    assert_eq!(detached::read(&db, &plain, marker).unwrap(), 1);
    assert!(plain.is_dir());
    assert_eq!(fs::read_dir(&plain).unwrap().count(), 0, "the copy is left");
    let target = d.join("target");
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("user-file.txt"), b"must remain").unwrap();
    let linked = d.join("linked");
    junction(&linked, &target);
    assert_eq!(detached::read(&db, &linked, marker).unwrap(), 1);
    assert!(is_link(&linked), "the scratch junction was removed");
    let names: Vec<_> = fs::read_dir(&target)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(names, ["user-file.txt"]);
    assert_eq!(
        fs::read(target.join("user-file.txt")).unwrap(),
        b"must remain"
    );
    // 对照：暂存目录原来不在，就按需建出来、读完拿掉。
    let fresh = d.join("fresh").join("scratch");
    assert_eq!(detached::read(&db, &fresh, marker).unwrap(), 1);
    assert!(!d.join("fresh").exists());
    drop(c);
}

/// peer r5 P1-01：副本目录只用这次新建的。同名的已经在（这里是本进程 pid 加各个序号，都放着用户的 `db.sqlite`），
/// 就换下一个序号，不打开、不删它。
#[test]
fn a_copy_never_takes_over_a_directory_that_is_already_there() {
    let d = dir("copy-exclusive");
    let db = source(&d, "source.sqlite");
    let c = wal_source(&db);
    let scratch = d.join("scratch");
    let taken: Vec<PathBuf> = (0..300)
        .map(|n| scratch.join(format!("read-{}-{n}", std::process::id())))
        .collect();
    for dir in &taken {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("db.sqlite"), b"must remain").unwrap();
    }
    assert_eq!(detached::read(&db, &scratch, marker).unwrap(), 1);
    for dir in &taken {
        assert_eq!(fs::read(dir.join("db.sqlite")).unwrap(), b"must remain");
    }
    assert_eq!(fs::read_dir(&scratch).unwrap().count(), taken.len());
    drop(c);
}

/// peer r5 P1-01、r6 P1-01：读的时候暂存目录（一个 junction）被改指向别处，那里正好有个同名目录与 `db.sqlite`。
/// 副本按开头握住的句柄删：那里的文件原样，原来那个目录里的副本照样删掉。
#[test]
fn a_copy_whose_path_now_leads_elsewhere_is_not_removed() {
    let d = dir("copy-moved");
    let db = source(&d, "source.sqlite");
    let c = wal_source(&db);
    let first = d.join("first");
    let second = d.join("second");
    fs::create_dir_all(&first).unwrap();
    fs::create_dir_all(&second).unwrap();
    let scratch = d.join("scratch");
    junction(&scratch, &first);
    let moved = RefCell::new(None);
    // 先读，再改指向：读完到删副本之间，路径换成了别处。
    let v = detached::read(&db, &scratch, |c| {
        let v = marker(c);
        if moved.borrow().is_none() {
            let name = fs::read_dir(&first)
                .unwrap()
                .map(|e| e.unwrap().file_name())
                .find(|n| n.to_string_lossy().starts_with("read-"))
                .unwrap();
            fs::create_dir_all(second.join(&name)).unwrap();
            fs::write(second.join(&name).join("db.sqlite"), b"not a copy").unwrap();
            fs::remove_dir(&scratch).unwrap();
            junction(&scratch, &second);
            *moved.borrow_mut() = Some(name);
        }
        v
    });
    assert_eq!(v.unwrap(), 1);
    let name = moved.take().unwrap();
    assert_eq!(
        fs::read(second.join(&name).join("db.sqlite")).unwrap(),
        b"not a copy"
    );
    assert_eq!(fs::read_dir(&first).unwrap().count(), 0, "the copy is left");
    drop(c);
}

/// peer r5 P1-01（经公开接口）：读在等冻结时（有人握着 PENDING），原来不存在的暂存目录被建成指向源库上级的 junction。
/// 暂存目录绑在开头握住的上一级上，要建它时相对那一级新建，撞上的是那个链接：拒绝，源库与旁边的文件都原样。
#[test]
fn a_scratch_that_turns_into_a_link_while_the_read_waits_is_refused() {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY, LockFileEx, UnlockFileEx,
    };
    use windows_sys::Win32::System::IO::OVERLAPPED;
    let d = dir("late-link-waiting");
    let actual = d.join("actual");
    let src = actual.join(format!("read-{}-0", std::process::id()));
    fs::create_dir_all(&src).unwrap();
    let db = src.join("atm.sqlite");
    let c = wal_source(&db);
    fs::write(src.join("user-file.txt"), b"must remain").unwrap();
    let original = fs::read(&db).unwrap();
    let lock = fs::File::open(&db).unwrap();
    // SAFETY: 全零的 OVERLAPPED 是合法的；句柄在 `lock` 活着时有效。
    let mut o: OVERLAPPED = unsafe { std::mem::zeroed() };
    o.Anonymous.Anonymous.Offset = 0x4000_0000;
    let flags = LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY;
    assert_ne!(
        unsafe { LockFileEx(lock.as_raw_handle(), flags, 0, 1, 0, &mut o) },
        0
    );
    let scratch = d.join("late-scratch");
    let (path, at) = (db.clone(), scratch.clone());
    let reader = thread::spawn(move || detached::read(&path, &at, marker));
    thread::sleep(Duration::from_millis(300));
    assert!(!reader.is_finished(), "the read did not wait for PENDING");
    junction(&scratch, &actual);
    assert_ne!(
        unsafe { UnlockFileEx(lock.as_raw_handle(), 0, 1, 0, &mut o) },
        0
    );
    drop(lock);
    let r = reader.join().unwrap();
    assert!(
        matches!(&r, Err(Error::Open(e)) if e.contains("a link")),
        "{r:?}"
    );
    assert_eq!(fs::read(&db).unwrap(), original);
    assert_eq!(fs::read(src.join("user-file.txt")).unwrap(), b"must remain");
    assert!(is_link(&scratch));
    drop(c);
}

/// peer r6 P2-01：暂存目录原来不在，它的上级是个 junction；读的时候上级被改指向别处，那里正好有个同名的 junction（调用方的）。
/// 这次新建的那一级按开头握住的句柄删：调用方的 junction 与它指向的东西不动，这次建的照样删掉。
#[test]
fn a_parent_replaced_during_the_read_leaves_what_the_caller_had() {
    let d = dir("parent-replaced");
    let db = source(&d, "source.sqlite");
    let c = wal_source(&db);
    let (first, second, user) = (d.join("first"), d.join("second"), d.join("user"));
    for dir in [&first, &second, &user] {
        fs::create_dir_all(dir).unwrap();
    }
    fs::write(user.join("user-file.txt"), b"must remain").unwrap();
    junction(&second.join("scratch"), &user);
    let parent = d.join("parent");
    junction(&parent, &first);
    let scratch = parent.join("scratch");
    let moved = RefCell::new(false);
    let v = detached::read(&db, &scratch, |c| {
        let v = marker(c);
        if !*moved.borrow() {
            assert!(first.join("scratch").is_dir());
            fs::remove_dir(&parent).unwrap();
            junction(&parent, &second);
            *moved.borrow_mut() = true;
        }
        v
    });
    assert_eq!(v.unwrap(), 1);
    assert!(
        is_link(&second.join("scratch")),
        "the caller's junction was removed"
    );
    assert_eq!(
        fs::read(user.join("user-file.txt")).unwrap(),
        b"must remain"
    );
    assert_eq!(fs::read_dir(&user).unwrap().count(), 1);
    assert!(
        !first.join("scratch").exists(),
        "the directory made for the copy is left"
    );
    drop(c);
}
