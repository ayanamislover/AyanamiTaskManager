//! W8g（W2 peer r3 P2-01）：清扫在附件锁里跑，一轮的时长与读库次数都要有上限。
//!
//! - 时长用完时，先轮到的是仍登记、暂在隔离区的备份（放回只是一次改名），没登记的残留留到下一轮；
//! - 读池占满时，一批条目只等一次读连接（不是每条各等一次 `read_wait`）。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::backup::{
    BackupsRoot, SWEEP_MAX_ENTRIES, WITHDRAWN_DIR, attachments_lock, create_backup, sweep_within,
};
use crate::{Config, Store};

fn base(name: &str) -> PathBuf {
    let d = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("target")
        })
        .join("store-unit")
        .join(format!("sweep-{name}"));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

fn open(dir: &Path, config: Config) -> Store {
    let store = Store::open(&dir.join("atm.sqlite"), config).unwrap();
    store
        .write(|tx| {
            tx.execute_batch(
                "INSERT INTO app_meta (singleton, schema_version, data_root_id, generation, instance_epoch, scope_gen_counter, created_at, updated_at)
                   VALUES (1, 1, 'ROOT', 'G', 'EPOCH-1', 0, '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')",
            )
        })
        .unwrap();
    store
}

#[test]
fn when_the_time_is_up_registered_backups_have_been_put_back_first() {
    let dir = base("registered-first");
    let store = open(&dir, Config::default());
    let root = dir.join("backups");
    let b = create_backup(&store, &root, "MANUAL", "2026-10-11T01:00:00.000Z").unwrap();
    let quarantine = root.join(WITHDRAWN_DIR);
    // 孤儿的名字排在前面：只按枚举顺序处理的话，时长为 0 的这一轮只会删掉它。
    fs::create_dir_all(quarantine.join("00ORPHAN")).unwrap();
    fs::rename(&b.dir, quarantine.join(&b.id)).unwrap();

    let _lock = attachments_lock(&store, "sweep_budget").unwrap();
    let mut pinned = BackupsRoot::pin(&root).unwrap();
    let round = sweep_within(&store, &mut pinned, SWEEP_MAX_ENTRIES, Duration::ZERO);
    assert_eq!((round.left, round.more), (0, true), "{round:?}");
    assert!(
        b.dir.join("atm.sqlite").is_file(),
        "the registered backup is back"
    );
    assert!(
        quarantine.join("00ORPHAN").is_dir(),
        "the orphan waits for the next round"
    );

    let round = sweep_within(
        &store,
        &mut pinned,
        SWEEP_MAX_ENTRIES,
        Duration::from_secs(60),
    );
    assert!(round.clean(), "{round:?}");
    assert!(!quarantine.exists());
}

#[test]
fn a_busy_read_pool_costs_one_wait_per_round_not_one_per_entry() {
    let dir = base("busy-readers");
    let wait = Duration::from_millis(300);
    let store = open(
        &dir,
        Config {
            readers: 1,
            read_wait: wait,
            read_budget: Duration::from_secs(60),
            ..Config::default()
        },
    );
    let root = dir.join("backups");
    let quarantine = root.join(WITHDRAWN_DIR);
    for i in 0..SWEEP_MAX_ENTRIES {
        fs::create_dir_all(quarantine.join(format!("00ORPHAN{i:03}"))).unwrap();
    }
    let _lock = attachments_lock(&store, "sweep_budget").unwrap();
    let mut pinned = BackupsRoot::pin(&root).unwrap();

    // 占住唯一的读连接，直到这一轮清扫结束。
    let (held, release) = (
        std::sync::mpsc::channel::<()>(),
        std::sync::mpsc::channel::<()>(),
    );
    let (held_tx, held_rx) = held;
    let (release_tx, release_rx) = release;
    std::thread::scope(|s| {
        s.spawn(|| {
            store
                .read(move |_| {
                    held_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok::<(), rusqlite::Error>(())
                })
                .unwrap();
        });
        held_rx.recv().unwrap();
        let started = Instant::now();
        let round = sweep_within(
            &store,
            &mut pinned,
            SWEEP_MAX_ENTRIES,
            Duration::from_secs(60),
        );
        let took = started.elapsed();
        release_tx.send(()).unwrap();
        // 查不了登记就一条都不删（不知道它们登记没登记），也不放回。
        assert_eq!(
            (round.left, round.more),
            (SWEEP_MAX_ENTRIES, false),
            "{round:?}"
        );
        assert!(
            took < wait * 4,
            "{} entries waited {took:?}; one wait is {wait:?}",
            SWEEP_MAX_ENTRIES
        );
    });
    assert_eq!(
        fs::read_dir(&quarantine).unwrap().count(),
        SWEEP_MAX_ENTRIES
    );
    let round = sweep_within(
        &store,
        &mut pinned,
        SWEEP_MAX_ENTRIES,
        Duration::from_secs(60),
    );
    assert!(round.clean(), "{round:?}");
}
