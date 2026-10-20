//! `doctor --offline`（06 §6：不依赖服务、只读）与服务不可用时的诊断（W6a B2：没有 HTTP 时从不含凭据的
//! 启动状态读出原因）。

mod support;

use atm_store::conversion::{DamagedState, Layout, StartupState, enter_damaged};
use serde_json::{Value, json};
use std::path::Path;
use std::time::{Duration, Instant};
use support::*;

fn cursor_key(root: &Path) -> String {
    let conn = rusqlite::Connection::open(root.join("data").join("atm.sqlite")).unwrap();
    conn.query_row("SELECT cursor_key FROM app_meta", [], |r| r.get(0))
        .unwrap()
}

fn write_conflict(root: &Path, reason: &str) {
    std::fs::create_dir_all(root.join("runtime")).unwrap();
    let state = StartupState {
        state: "SOURCE_CONFLICT".into(),
        since: "2026-10-10T00:00:00.000Z".into(),
        generation: "G".into(),
        reason: reason.into(),
    };
    std::fs::write(
        root.join("runtime").join("startup-state.json"),
        state.to_json(),
    )
    .unwrap();
}

#[test]
fn doctor_offline_reads_files_only() {
    let root = bare_root("cli-doctor-offline");
    let key = cursor_key(&root);
    let mock = Mock::start();
    write_descriptor(&root, mock.port, TOKEN);
    std::fs::create_dir_all(root.join("backups")).unwrap();
    // 一份整库备份是一个目录；`.` 开头的（正在建、待清理）与零散文件都不算。
    std::fs::create_dir_all(root.join("backups").join("01BACKUP")).unwrap();
    std::fs::create_dir_all(root.join("backups").join("02BACKUP")).unwrap();
    std::fs::create_dir_all(root.join("backups").join(".creating-01X")).unwrap();
    std::fs::write(root.join("backups").join("stray.txt"), b"x").unwrap();
    // A tripped keepalive breaker is reported, never a problem: the stop is deliberate.
    std::fs::write(
        root.join("runtime").join("keepalive.json"),
        br#"{"exits":[],"trippedAtMs":1}"#,
    )
    .unwrap();
    let before = tree(&root);

    let run = atm_in(&root, &["--json", "doctor", "--offline"]);
    assert_eq!(run.code, 0, "{}{}", run.stdout, run.stderr);
    let v = run.json();
    assert_eq!(v["mode"], "offline");
    assert_eq!(v["healthy"], true, "{v}");
    // The test binary is not an installed copy: no auto recovery is claimed.
    assert_eq!(v["keepalive"]["auto_recovery"], false, "{v}");
    assert_eq!(v["keepalive"]["registered"], false, "{v}");
    assert_eq!(v["keepalive"]["breaker_tripped"], true, "{v}");
    assert_eq!(v["problems"], json!([]));
    assert_eq!(v["database"]["projects"], 0, "{v}");
    assert_eq!(v["database"]["schema_version"], 1, "{v}");
    assert_eq!(v["database"]["quick_check"], "ok", "{v}");
    assert_eq!(v["database"]["wal_bytes"], Value::Null, "{v}");
    assert_eq!(v["service"]["descriptor"], "PRESENT", "{v}");
    assert_eq!(v["service"]["pid_alive"], true, "{v}");
    assert_eq!(v["backups"]["count"], 2, "{v}");
    assert_eq!(v["conversion"]["state"], "MISSING", "{v}");
    assert_eq!(v["startup_state"], Value::Null);
    assert_eq!(v["damaged"], Value::Null);

    // 不连服务、不改任何文件（也没有留下 -wal / -shm），令牌与游标密钥不出现在输出里。
    assert_eq!(mock.hits(), 0, "doctor --offline reached the service");
    assert_eq!(
        tree(&root),
        before,
        "doctor --offline changed the data root"
    );
    for secret in [TOKEN, key.as_str()] {
        assert!(!run.stdout.contains(secret) && !run.stderr.contains(secret));
    }
    let human = atm_in(&root, &["doctor", "--offline"]);
    assert_eq!(human.code, 0);
    assert!(human.stdout.contains("healthy: true\n"), "{}", human.stdout);
}

/// 上次写到一半被杀、留下热回滚日志：诊断不能拿 `immutable` 读半截的页，也不能把它说成库坏了，
/// 而且不动它（回滚是下次正常启动的事）。读的是副本回滚之后、被杀前已提交的状态。
#[test]
fn doctor_offline_reads_past_an_unrolled_journal_and_leaves_it() {
    let root = bare_root("cli-doctor-hot-journal");
    let db = root.join("data").join("atm.sqlite");
    let side = root.join("side.sqlite");
    std::fs::copy(&db, &side).unwrap();
    let _ = std::fs::remove_file(root.join("data").join("atm.sqlite-wal"));
    let _ = std::fs::remove_file(root.join("data").join("atm.sqlite-shm"));
    let c = rusqlite::Connection::open(&side).unwrap();
    c.execute_batch(
        "PRAGMA journal_mode = DELETE; CREATE TABLE hot_journal_probe(x);
         PRAGMA cache_size = 1; BEGIN IMMEDIATE; UPDATE app_meta SET generation = 'NOT-COMMITTED';",
    )
    .unwrap();
    for _ in 0..2000 {
        c.execute(
            "INSERT INTO hot_journal_probe VALUES (?1)",
            [&"y".repeat(500)],
        )
        .unwrap();
    }
    std::fs::copy(&side, &db).unwrap();
    std::fs::copy(
        root.join("side.sqlite-journal"),
        root.join("data").join("atm.sqlite-journal"),
    )
    .unwrap();
    drop(c);
    let _ = std::fs::remove_file(&side);
    let _ = std::fs::remove_file(root.join("side.sqlite-journal"));
    let before = tree(&root);

    let run = atm_in(&root, &["--json", "doctor", "--offline"]);
    assert_eq!(run.code, 0, "{}{}", run.stdout, run.stderr);
    let v = run.json();
    assert_eq!(v["database"]["generation"], "G", "{v}");
    assert_eq!(v["database"]["quick_check"], "ok", "{v}");
    assert_eq!(v["database"]["interrupted_write"], true, "{v}");
    assert_eq!(v["problems"], json!([]), "{v}");
    assert_eq!(tree(&root), before, "doctor --offline touched the journal");

    // 空的（冷的）日志不是中断的写入：不报 interrupted_write，也不动它。
    let cold = bare_root("cli-doctor-cold-journal");
    std::fs::write(cold.join("data").join("atm.sqlite-journal"), b"").unwrap();
    let before = tree(&cold);
    let run = atm_in(&cold, &["--json", "doctor", "--offline"]);
    assert_eq!(run.code, 0, "{}{}", run.stdout, run.stderr);
    assert_eq!(run.json()["database"]["interrupted_write"], false);
    assert_eq!(tree(&cold), before);
}

/// 服务被杀、`-wal` 里留着已提交的帧、没有 `-shm`：诊断读得到这些帧（generation 是 WAL 里的新值），
/// 而且不建 `-shm`、不改任何文件（W8 关口 peer r1 P1-01：只读连接会建 `-shm`）。
#[test]
fn doctor_offline_reads_the_wal_of_a_killed_service_without_touching_it() {
    let root = bare_root("cli-doctor-killed-wal");
    let data = root.join("data");
    let db = data.join("atm.sqlite");
    // 中转目录放在根外：比较的是根里的树，用完不必在比较前删掉它（刚移走文件的目录偶尔一时删不掉）。
    let side = test_dir("cli-doctor-killed-wal-side");
    let _ = std::fs::remove_dir_all(&side);
    std::fs::create_dir_all(&side).unwrap();
    let c = rusqlite::Connection::open(&db).unwrap();
    c.execute_batch(
        "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
         UPDATE app_meta SET generation = 'G-IN-THE-WAL';",
    )
    .unwrap();
    std::fs::copy(&db, side.join("db")).unwrap();
    std::fs::copy(data.join("atm.sqlite-wal"), side.join("wal")).unwrap();
    drop(c);
    for f in ["atm.sqlite", "atm.sqlite-wal", "atm.sqlite-shm"] {
        let _ = std::fs::remove_file(data.join(f));
    }
    std::fs::rename(side.join("db"), &db).unwrap();
    std::fs::rename(side.join("wal"), data.join("atm.sqlite-wal")).unwrap();
    let _ = std::fs::remove_dir(&side);
    // 删掉 `-shm` 之后，别的程序偶尔在库旁短暂建一个锁着的 `ATM.SQLITE-SHM.tmp`：等它走了再拍「之前」。
    let before = settled_tree(&root);

    let run = atm_in(&root, &["--json", "doctor", "--offline"]);
    assert_eq!(run.code, 0, "{}{}", run.stdout, run.stderr);
    let v = run.json();
    assert_eq!(v["database"]["generation"], "G-IN-THE-WAL", "{v}");
    assert_eq!(v["database"]["interrupted_write"], false, "{v}");
    let after = tree(&root);
    assert!(
        after == before,
        "doctor --offline wrote beside the database: {}",
        tree_diff(&before, &after)
    );
    assert!(!data.join("atm.sqlite-shm").exists());
}

/// 服务在跑（库开着、有 `-wal`）时照样能诊断，读得到已提交的内容。
#[test]
fn doctor_offline_works_beside_a_running_service() {
    let w = world("cli-doctor-running");
    let run = w.atm(&["--json", "doctor", "--offline"]);
    assert_eq!(run.code, 0, "{}{}", run.stdout, run.stderr);
    let v = run.json();
    assert_eq!(v["database"]["projects"], 1, "{v}");
    assert_eq!(v["database"]["quick_check"], "ok", "{v}");
    // 服务照常可用。
    assert_eq!(w.ok(&["project", "list"])["projects"][0]["code"], w.project);
}

#[test]
fn doctor_offline_reports_problems_with_exit_code_1() {
    let missing = test_dir("cli-doctor-missing");
    let _ = std::fs::remove_dir_all(&missing);
    std::fs::create_dir_all(missing.parent().unwrap()).unwrap();
    let run = atm_with(
        missing.parent().unwrap(),
        &["--json", "doctor", "--offline"],
        &[("ATM3_DATA_DIR", missing.to_str().unwrap())],
    );
    assert_eq!(run.code, 1, "{}{}", run.stdout, run.stderr);
    let v = run.json();
    assert_eq!(v["exists"], false);
    assert!(
        v["problems"][0]
            .as_str()
            .unwrap()
            .contains("数据目录不存在"),
        "{v}"
    );

    let root = bare_root("cli-doctor-conflict");
    write_conflict(&root, "2.x 有新的修改");
    std::fs::create_dir_all(root.join("runtime")).unwrap();
    std::fs::write(root.join("runtime").join("daemon.json"), b"{not json").unwrap();
    let run = atm_in(&root, &["--json", "doctor", "--offline"]);
    assert_eq!(run.code, 1);
    let v = run.json();
    assert_eq!(v["startup_state"]["reason"], "2.x 有新的修改", "{v}");
    assert_eq!(v["service"]["descriptor"], "INVALID", "{v}");
    assert_eq!(v["problems"].as_array().unwrap().len(), 2, "{v}");
}

/// 没有服务：立刻（不等 45 s，开发构建不拉起桌面端）以退出码 4 报出来；status / doctor 附上离线诊断。
#[test]
fn an_absent_service_is_reported_with_the_startup_state() {
    let root = bare_root("cli-unavailable");
    let started = Instant::now();
    let run = atm_in(&root, &["--json", "status"]);
    assert!(started.elapsed() < Duration::from_secs(10));
    assert_eq!(run.code, 4, "{}{}", run.stdout, run.stderr);
    let v = run.json();
    assert_eq!(v["error"]["code"], "ATM_RUNTIME_UNAVAILABLE", "{v}");
    assert_eq!(v["error"]["startup_state"], Value::Null);
    assert_eq!(v["error"]["local"]["database"]["quick_check"], "ok", "{v}");
    let human = atm_in(&root, &["project", "list"]);
    assert_eq!(human.code, 4);
    assert!(human.stderr.contains("服务未运行"), "{}", human.stderr);

    // 描述还在、端口已经没人听（服务崩了）：同样是服务未运行。
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = closed.local_addr().unwrap().port();
    drop(closed);
    write_descriptor(&root, port, TOKEN);
    let run = atm_in(&root, &["--json", "brief", "ATM"]);
    assert_eq!(run.code, 4);
    assert_eq!(run.json()["error"]["code"], "ATM_RUNTIME_UNAVAILABLE");

    // 描述坏了：描述无效，不是「再等等」。
    std::fs::write(root.join("runtime").join("daemon.json"), b"{not json").unwrap();
    let run = atm_in(&root, &["--json", "project", "list"]);
    assert_eq!(run.code, 4);
    assert_eq!(
        run.json()["error"]["code"],
        "ATM_RUNTIME_DESCRIPTOR_INVALID"
    );
    std::fs::remove_file(root.join("runtime").join("daemon.json")).unwrap();

    // 在等用户选数据来源：从启动状态读出原因（不含凭据），任何在线命令都这样报。
    write_conflict(&root, "2.x 有新的修改");
    for args in [
        &["--json", "status"][..],
        &["--json", "task", "list", "ATM"][..],
    ] {
        let run = atm_in(&root, args);
        assert_eq!(run.code, 4, "{args:?}");
        let v = run.json();
        assert_eq!(v["error"]["code"], "ATM_SOURCE_CONFLICT", "{v}");
        assert!(
            v["error"]["message"]
                .as_str()
                .unwrap()
                .contains("2.x 有新的修改"),
            "{v}"
        );
        assert_eq!(
            v["error"]["startup_state"]["state"], "SOURCE_CONFLICT",
            "{v}"
        );
    }
    let doctor = atm_in(&root, &["doctor"]);
    assert_eq!(doctor.code, 4);
    assert!(
        doctor.stderr.contains("ATM_SOURCE_CONFLICT"),
        "{}",
        doctor.stderr
    );
    assert!(
        doctor.stderr.contains("healthy: false"),
        "{}",
        doctor.stderr
    );
}

/// W8h：宿主判定库读不出、写了 `runtime\damaged.json` 后，在线命令立刻报 ATM_DATABASE_DAMAGED（不等 45 s），
/// 附上不含凭据的损坏状态；`doctor --offline` 把它列为问题。文件坏了也当作损坏，不变成「再等等」。
#[test]
fn a_damaged_database_is_reported_at_once() {
    let root = bare_root("cli-damaged");
    let at = "2026-10-14T00:00:00.000Z";
    let first: DamagedState =
        enter_damaged(&Layout::new(&root), "G", "file is not a database", at, None).unwrap();
    // 同一 generation 再记一次：保留第一次的时间。
    let again = enter_damaged(
        &Layout::new(&root),
        "G",
        "still unreadable",
        "2026-10-14T01:00:00.000Z",
        None,
    )
    .unwrap();
    assert_eq!(again.since, first.since);
    for args in [
        &["--json", "status"][..],
        &["--json", "task", "list", "ATM"][..],
    ] {
        let started = Instant::now();
        let run = atm_in(&root, args);
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_eq!(run.code, 4, "{args:?}");
        let v = run.json();
        assert_eq!(v["error"]["code"], "ATM_DATABASE_DAMAGED", "{v}");
        assert!(
            v["error"]["message"]
                .as_str()
                .unwrap()
                .contains("still unreadable")
                && v["error"]["message"]
                    .as_str()
                    .unwrap()
                    .contains("recover --offline"),
            "{v}"
        );
        assert_eq!(v["error"]["damaged"]["since"], at, "{v}");
        assert_eq!(v["error"]["startup_state"], Value::Null, "{v}");
    }
    let run = atm_in(&root, &["--json", "doctor", "--offline"]);
    assert_eq!(run.code, 1);
    let v = run.json();
    assert_eq!(v["damaged"]["reason"], "still unreadable", "{v}");
    assert_eq!(v["healthy"], false, "{v}");

    std::fs::write(root.join("runtime").join("damaged.json"), b"{not json").unwrap();
    let run = atm_in(&root, &["--json", "status"]);
    assert_eq!(run.json()["error"]["code"], "ATM_DATABASE_DAMAGED");
    assert_eq!(
        run.json()["error"]["damaged"]["reason"],
        "the damaged state is corrupt"
    );

    // 恢复之后（宿主或 recover 删掉了它）：回到服务未运行。
    std::fs::remove_file(root.join("runtime").join("damaged.json")).unwrap();
    let run = atm_in(&root, &["--json", "status"]);
    assert_eq!(run.json()["error"]["code"], "ATM_RUNTIME_UNAVAILABLE");
}

/// W8 r9 P2-01a：atm.exe 在安装布局里、旁边的桌面端却拉不起来（这里是个空文件，CreateProcess 失败），
/// 留着上一次运行的损坏状态：立刻报，不等满 45 s。
#[test]
fn a_desktop_that_cannot_start_does_not_make_the_cli_wait() {
    let root = bare_root("cli-damaged-unstartable");
    enter_damaged(
        &Layout::new(&root),
        "G",
        "left by an earlier run",
        "2026-10-14T00:00:00.000Z",
        None,
    )
    .unwrap();
    let install = root
        .parent()
        .unwrap()
        .join("cli-damaged-unstartable-install");
    let _ = std::fs::remove_dir_all(&install);
    let resources = install.join("resources");
    std::fs::create_dir_all(&resources).unwrap();
    std::fs::write(install.join("AyanamiTaskManager.exe"), b"").unwrap();
    let exe = resources.join("atm.exe");
    std::fs::copy(env!("CARGO_BIN_EXE_atm"), &exe).unwrap();
    let started = Instant::now();
    let run = atm_full(&exe, &root, &["--json", "status"], &[], None);
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(run.code, 4, "{}{}", run.stdout, run.stderr);
    assert_eq!(run.json()["error"]["code"], "ATM_DATABASE_DAMAGED");
    let _ = std::fs::remove_dir_all(&install);
}

/// peer r4 P1-01：`doctor --offline` 的暂存目录是 `%TEMP%\atm-doctor-read\`。数据根恰好在它下面一个像遗留副本的
/// 目录里（`read-<已退出的 pid>-1`）时，清扫会把整个数据根删掉。诊断拒绝读、如实报告，数据根一个字节不动；
/// 对照：同一个数据根、换一个无关的 TEMP，照常健康。
#[test]
fn doctor_offline_never_sweeps_the_data_root_it_is_reading() {
    let root = bare_root("doctor-scratch/atm-doctor-read/read-4294967295-1");
    let temp = root.parent().unwrap().parent().unwrap().to_path_buf();
    std::fs::write(root.join("user-file.txt"), b"must remain").unwrap();
    let before = tree(&root);

    let control_temp = temp.parent().unwrap().join("doctor-scratch-control-temp");
    std::fs::create_dir_all(&control_temp).unwrap();
    let control_temp = control_temp.display().to_string();
    let control = atm_with(
        &root,
        &["--json", "doctor", "--offline"],
        &[("TEMP", &control_temp), ("TMP", &control_temp)],
    );
    assert_eq!(control.code, 0, "{}{}", control.stdout, control.stderr);
    assert_eq!(tree(&root), before);

    let temp = temp.display().to_string();
    let run = atm_with(
        &root,
        &["--json", "doctor", "--offline"],
        &[("TEMP", &temp), ("TMP", &temp)],
    );
    assert_eq!(
        tree(&root),
        before,
        "doctor --offline removed or changed the data root"
    );
    assert_ne!(run.code, 0, "{}{}", run.stdout, run.stderr);
    let v = run.json();
    assert_eq!(v["healthy"], false, "{v}");
    assert!(
        v["database"]["error"]
            .as_str()
            .is_some_and(|e| e.contains("contains")),
        "{v}"
    );
}
