//! 离线整库恢复（W6b；03 §2.5 R3、R4，05 §6，A4）：核对备份、先封存后恢复、账本取并集或标记丢失、
//! 换新 instance_epoch、固定选中的备份、中断后续做、服务启动时收尾。

use atm_store::backup::create_backup;
use atm_store::conversion::{self as cv, Layout, ManifestState, Startup};
use atm_store::recover::{self, RecoverError, RecoverOptions, Step};
use atm_store::{Config, Store};
use rusqlite::Connection;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const T0: &str = "2026-10-01T00:00:00.000Z";
const T1: &str = "2026-10-02T00:00:00.000Z";
const T2: &str = "2026-10-03T00:00:00.000Z";
const PIN: &str = "2026-11-02T00:00:00.000Z";
const GEN: &str = "01J000000000000000000RECOV";

fn dir(name: &str) -> PathBuf {
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("target")
        });
    let dir = target.join("store-tests").join(format!("recover-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn options() -> RecoverOptions<'static> {
    RecoverOptions {
        at: T2,
        pin_until: PIN,
    }
}

struct World {
    layout: Layout,
    backup: String,
    epoch_before: String,
}

/// 一个发布了的 `N`：项目、知识库、手机同步与派单账本、一个附件；做一份整库备份，之后再写一些。
fn world(name: &str) -> World {
    let layout = Layout::new(dir(name));
    cv::fresh_install(&layout, GEN, T0).unwrap();
    let store = Store::open(&layout.database(), Config::default()).unwrap();
    store
        .write(|tx| {
            tx.execute_batch(&format!(
                "UPDATE app_meta SET scope_gen_counter = 2;
                 INSERT INTO scope_generations (gen, scope_kind, scope_id, reason, epoch, created_at) VALUES
                   (1, 'PROJECT', 'PA', 'CREATED', 'EA', '{T0}'), (2, 'KNOWLEDGE', 'KDB', 'CREATED', 'EK', '{T0}');
                 INSERT INTO projects (id, code, name, lifecycle, health, meta_version, scope_gen, epoch, created_at, updated_at)
                   VALUES ('PA', 'ATM', '任务管理', 'ACTIVE', 'ON_TRACK', 0, 1, 'EA', '{T0}', '{T0}');
                 INSERT INTO knowledge_meta (singleton, database_id, generation, sequence, scope_gen) VALUES (1, 'KDB', 'KG', 0, 2);
                 INSERT INTO sync_state (singleton, v, enabled, app_id, device_id, device_name, cursor, updated_at)
                   VALUES (1, 1, 1, 'app', 'dev', '电脑', 'C-before', '{T0}');
                 INSERT INTO sync_processed (ord, command_id) VALUES (1, 'cmd-1');
                 INSERT INTO dispatch_meta (singleton, requests_since, lost_before) VALUES (1, '{T0}', NULL);
                 INSERT INTO dispatch_requests (id, at, rejected_code, rejected_message) VALUES ('req-1', '{T0}', 'X', 'm');"
            ))
        })
        .unwrap();
    let artifacts = layout.data().join("artifacts").join("PA");
    std::fs::create_dir_all(&artifacts).unwrap();
    std::fs::write(artifacts.join("a.txt"), "v1").unwrap();
    let backup = create_backup(&store, &layout.root.join("backups"), "MANUAL", T1)
        .unwrap()
        .id;
    // 备份点之后：又处理了一条手机命令、收了一个派单请求、游标前进，附件也变了。
    store
        .write(|tx| {
            tx.execute_batch(&format!(
                "INSERT INTO sync_processed (ord, command_id) VALUES (2, 'cmd-2');
                 INSERT INTO dispatch_requests (id, at, rejected_code, rejected_message) VALUES ('req-2', '{T1}', 'X', 'm');
                 UPDATE sync_state SET cursor = 'C-after';
                 UPDATE dispatch_meta SET requests_since = '{T1}';"
            ))
        })
        .unwrap();
    std::fs::write(artifacts.join("a.txt"), "v2").unwrap();
    std::fs::write(artifacts.join("b.txt"), "new").unwrap();
    let epoch_before: String = store
        .read(|tx| tx.query_row("SELECT instance_epoch FROM app_meta", [], |r| r.get(0)))
        .unwrap();
    drop(store);
    World {
        layout,
        backup,
        epoch_before,
    }
}

fn open(layout: &Layout) -> Connection {
    Connection::open(layout.database()).unwrap()
}

fn strings(c: &Connection, sql: &str) -> Vec<String> {
    c.prepare(sql)
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn tree(root: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in entries {
            let p = e.unwrap().path();
            if p.is_dir() {
                stack.push(p);
            } else {
                out.insert(
                    p.strip_prefix(root).unwrap().to_string_lossy().into_owned(),
                    std::fs::read(&p).unwrap(),
                );
            }
        }
    }
    out
}

#[test]
fn a_readable_store_is_recovered_with_its_ledgers() {
    let w = world("readable");
    let before = tree(&w.layout.data());
    let r = recover::recover(&w.layout, &w.backup, options()).unwrap();
    assert!(!r.ledgers_lost);
    // 原来的整代（库、-wal 与附件）原样进了隔离区。-shm 是共享内存索引，只读打开也会改写，不算数据。
    let data_files = |t: BTreeMap<String, Vec<u8>>| -> BTreeMap<String, Vec<u8>> {
        t.into_iter()
            .filter(|(k, _)| !k.ends_with("-shm"))
            .collect()
    };
    assert_eq!(
        data_files(tree(&r.quarantine.join("data"))),
        data_files(before)
    );
    let data = w.layout.data();
    assert_eq!(
        std::fs::read_to_string(data.join("artifacts/PA/a.txt")).unwrap(),
        "v1"
    );
    assert!(!data.join("artifacts/PA/b.txt").exists());
    assert!(!w.layout.root.join("recover-staging").exists());
    assert!(!w.layout.runtime().join(recover::INTENT).exists());
    assert!(w.layout.runtime().join(recover::MARKER).is_file());

    let c = open(&w.layout);
    // 账本：已处理的命令与派单请求取并集，游标保留当前的，水位取较新的。
    assert_eq!(
        strings(&c, "SELECT command_id FROM sync_processed ORDER BY ord"),
        ["cmd-1", "cmd-2"]
    );
    assert_eq!(
        strings(&c, "SELECT id FROM dispatch_requests ORDER BY id"),
        ["req-1", "req-2"]
    );
    assert_eq!(strings(&c, "SELECT cursor FROM sync_state"), ["C-after"]);
    assert_eq!(
        strings(&c, "SELECT requests_since FROM dispatch_meta"),
        [T1]
    );
    // 所有游标失效；选中的备份登记并固定（A4）。
    let epoch: String = c
        .query_row("SELECT instance_epoch FROM app_meta", [], |r| r.get(0))
        .unwrap();
    assert_ne!(epoch, w.epoch_before);
    let pinned: (String, String) = c
        .query_row(
            "SELECT pinned_until, verified_at FROM backups WHERE id = ?1",
            [&w.backup],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(pinned, (PIN.to_owned(), T2.to_owned()));
    drop(c);

    // 启动判定照常发布（同一 generation），服务收尾一次。
    assert!(matches!(
        cv::decide(&w.layout, false),
        Startup::Published(_)
    ));
    let store = Store::open(&w.layout.database(), Config::default()).unwrap();
    assert_eq!(
        recover::settle(&store, &w.layout, "2026-10-04T00:00:00.000Z").unwrap(),
        Some(w.backup.clone())
    );
    assert!(!w.layout.runtime().join(recover::MARKER).exists());
    let (events, project_gen, knowledge_gen, restored): (i64, i64, i64, i64) = store
        .read(|tx| {
            tx.query_row(
                "SELECT (SELECT count(*) FROM global_feed WHERE type = 'database.recovered'),
                        (SELECT scope_gen FROM projects WHERE id = 'PA'),
                        (SELECT scope_gen FROM knowledge_meta),
                        (SELECT count(*) FROM scope_generations WHERE reason = 'RESTORED' AND backup_id = ?1)",
                [&w.backup],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
        })
        .unwrap();
    assert_eq!(events, 1);
    assert!(
        project_gen > 2 && knowledge_gen > 2,
        "{project_gen} {knowledge_gen}"
    );
    assert_eq!(restored, 2);
    assert_eq!(
        recover::settle(&store, &w.layout, "2026-10-05T00:00:00.000Z").unwrap(),
        None
    );
    // 收尾提交了、删标记之前进程没了：标记还在，下次启动不会再记一条、也不再推进世代。
    std::fs::write(
        w.layout.runtime().join(recover::MARKER),
        format!(
            "{{\"backupId\":\"{}\",\"at\":\"{T2}\",\"ledgersLost\":false}}",
            w.backup
        ),
    )
    .unwrap();
    assert_eq!(
        recover::settle(&store, &w.layout, "2026-10-06T00:00:00.000Z").unwrap(),
        Some(w.backup.clone())
    );
    let (events_again, project_gen_again): (i64, i64) = store
        .read(|tx| {
            tx.query_row(
                "SELECT (SELECT count(*) FROM global_feed WHERE type = 'database.recovered'),
                        (SELECT scope_gen FROM projects WHERE id = 'PA')",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap();
    assert_eq!((events_again, project_gen_again), (1, project_gen));
}

#[test]
fn a_corrupt_store_is_recovered_and_the_ledgers_are_marked_lost() {
    let w = world("corrupt");
    let db = w.layout.database();
    let mut bytes = std::fs::read(&db).unwrap();
    bytes[..100].fill(0x5a);
    std::fs::write(&db, &bytes).unwrap();
    // 宿主判定读不出时记下的损坏状态（W8h）：恢复完就不再成立。
    cv::enter_damaged(&w.layout, GEN, "file is not a database", T1).unwrap();
    let r = recover::recover(&w.layout, &w.backup, options()).unwrap();
    assert_eq!(
        cv::read_damaged(&w.layout),
        None,
        "recover clears the damaged state"
    );
    assert!(r.ledgers_lost);
    assert_eq!(
        std::fs::read(r.quarantine.join("data").join("atm.sqlite")).unwrap(),
        bytes,
        "the corrupt generation is kept as it was"
    );
    let c = open(&w.layout);
    assert_eq!(
        strings(&c, "SELECT command_id FROM sync_processed ORDER BY ord"),
        ["cmd-1"]
    );
    let cursor: Option<String> = c
        .query_row("SELECT cursor FROM sync_state", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        cursor, None,
        "the sync cursor is reset for the cursor rescue"
    );
    assert_eq!(strings(&c, "SELECT lost_before FROM dispatch_meta"), [T2]);
}

#[test]
fn unusable_backups_are_listed_with_the_reason_and_refused_without_changes() {
    let w = world("unusable");
    let backups = w.layout.root.join("backups");
    // 第二份：库文件被改了一个字节。
    let bad = "01J000000000000000000BADDB";
    copy_dir(&backups.join(&w.backup), &backups.join(bad));
    let manifest = std::fs::read_to_string(backups.join(bad).join("manifest.json")).unwrap();
    std::fs::write(
        backups.join(bad).join("manifest.json"),
        manifest.replace(&w.backup, bad),
    )
    .unwrap();
    let mut db = std::fs::read(backups.join(bad).join("atm.sqlite")).unwrap();
    let last = db.len() - 1;
    db[last] ^= 0xff;
    std::fs::write(backups.join(bad).join("atm.sqlite"), db).unwrap();
    // 第三份：manifest 说的是另一份备份。
    let alien = "01J00000000000000000ALIEN0";
    copy_dir(&backups.join(&w.backup), &backups.join(alien));

    let list = recover::candidates(&w.layout).unwrap();
    let problems: BTreeMap<String, Option<String>> = list
        .iter()
        .map(|c| (c.id.clone(), c.problem.clone()))
        .collect();
    assert_eq!(problems[&w.backup], None, "{list:?}");
    assert!(
        problems[bad]
            .as_deref()
            .unwrap()
            .contains("differs from the manifest"),
        "{list:?}"
    );
    assert!(
        problems[alien]
            .as_deref()
            .unwrap()
            .contains("does not describe"),
        "{list:?}"
    );

    let before = tree(&w.layout.root);
    for id in [bad, alien] {
        assert!(matches!(
            recover::recover(&w.layout, id, options()),
            Err(RecoverError::Unusable { .. })
        ));
    }
    assert!(matches!(
        recover::recover(&w.layout, "..", options()),
        Err(RecoverError::NoSuchBackup(_))
    ));
    assert_eq!(tree(&w.layout.root), before, "a refused recovery changed N");

    // 发布换了一代：同一份备份属于旧的一代，恢复过去会被启动判定整个隔离，所以不能用。
    let ManifestState::Present(mut m) = cv::read_manifest(&w.layout) else {
        panic!("no manifest")
    };
    m.generation = "01J0000000000000000OTHERGEN".into();
    cv::write_manifest(&w.layout, &m).unwrap();
    let list = recover::candidates(&w.layout).unwrap();
    let good = list.iter().find(|c| c.id == w.backup).unwrap();
    assert!(
        good.problem
            .as_deref()
            .unwrap()
            .contains("belongs to generation"),
        "{good:?}"
    );
}

#[test]
fn an_interrupted_recovery_resumes_with_the_same_backup() {
    for step in [Step::Staged, Step::Quarantined] {
        let w = world(&format!("resume-{step:?}"));
        let err =
            recover::recover_with(&w.layout, &w.backup, options(), &mut |s| s != step).unwrap_err();
        assert!(
            matches!(err, RecoverError::Interrupted(s) if s == step),
            "{err}"
        );
        assert_eq!(recover::interrupted(&w.layout), Some(w.backup.clone()));
        assert_eq!(
            recover::pending_backup(&w.layout).unwrap(),
            Some(w.backup.clone())
        );
        assert_eq!(w.layout.data().exists(), step == Step::Staged);
        // 换一份（同样可用的）备份续做：拒绝，先做完原来那次。
        let backups = w.layout.root.join("backups");
        let alias = "01J0000000000000000ALIAS00";
        copy_dir(&backups.join(&w.backup), &backups.join(alias));
        let manifest = std::fs::read_to_string(backups.join(alias).join("manifest.json")).unwrap();
        std::fs::write(
            backups.join(alias).join("manifest.json"),
            manifest.replace(&w.backup, alias),
        )
        .unwrap();
        let other = recover::recover(&w.layout, alias, options());
        assert!(
            matches!(&other, Err(RecoverError::Unusable { why, .. }) if why.contains("unfinished")),
            "{other:?}"
        );
        let r = recover::recover(&w.layout, &w.backup, options()).unwrap();
        // 账本在动当前库之前就采集好、记在意图里：续做时不会因为库已移走而当成丢失。
        assert!(!r.ledgers_lost, "{step:?}");
        assert_eq!(recover::interrupted(&w.layout), None);
        assert_eq!(
            std::fs::read_to_string(w.layout.data().join("artifacts/PA/a.txt")).unwrap(),
            "v1",
            "{step:?}"
        );
        assert!(r.quarantine.join("data").join("atm.sqlite").is_file());
        assert!(w.layout.runtime().join(recover::MARKER).is_file());
    }
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        let target = to.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            copy_dir(&e.path(), &target);
        } else {
            std::fs::copy(e.path(), target).unwrap();
        }
    }
}

/// W8h：`runtime\damaged.json` 的读写。同一 generation 再记保留最早的时间；换了 generation 重新计时；
/// 文件在却读不出或内容不对仍算损坏（原因写明），删掉之后才是没有；本来就没有时删也不算错。
#[test]
fn the_damaged_state_round_trips_and_a_broken_file_still_counts() {
    let layout = Layout::new(dir("damaged-state"));
    assert_eq!(cv::read_damaged(&layout), None);
    cv::clear_damaged(&layout).unwrap();
    let first = cv::enter_damaged(&layout, GEN, "file is not a database", T0).unwrap();
    assert_eq!(cv::read_damaged(&layout), Some(first.clone()));
    let again = cv::enter_damaged(&layout, GEN, "still unreadable", T1).unwrap();
    assert_eq!(
        (again.since.as_str(), again.reason.as_str()),
        (T0, "still unreadable")
    );
    let other = cv::enter_damaged(&layout, "01J000000000000000000OTHER", "x", T2).unwrap();
    assert_eq!(other.since, T2);
    let path = layout.runtime().join(cv::DAMAGED_STATE);
    for broken in [
        &b"{not json"[..],
        br#"{"state":"SOURCE_CONFLICT","since":"","generation":"","reason":""}"#,
    ] {
        std::fs::write(&path, broken).unwrap();
        assert_eq!(
            cv::read_damaged(&layout).map(|d| d.reason),
            Some("the damaged state is corrupt".to_owned())
        );
    }
    cv::clear_damaged(&layout).unwrap();
    assert_eq!(cv::read_damaged(&layout), None);
    // 损坏状态不进启动状态：store 与 CLI 把那里不认识的状态都当作数据源冲突。
    cv::enter_damaged(&layout, GEN, "x", T0).unwrap();
    assert_eq!(cv::read_startup_state(&layout), None);
}
