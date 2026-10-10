//! `doctor --offline`（06 §6：不依赖服务、只读）与服务不可用时的诊断（W6a B2：没有 HTTP 时从不含凭据的
//! 启动状态读出原因）。

mod support;

use atm_store::conversion::StartupState;
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
    std::fs::write(root.join("backups").join("a.atmbak"), b"x").unwrap();
    let before = tree(&root);

    let run = atm_in(&root, &["--json", "doctor", "--offline"]);
    assert_eq!(run.code, 0, "{}{}", run.stdout, run.stderr);
    let v = run.json();
    assert_eq!(v["mode"], "offline");
    assert_eq!(v["healthy"], true, "{v}");
    assert_eq!(v["problems"], json!([]));
    assert_eq!(v["database"]["projects"], 0, "{v}");
    assert_eq!(v["database"]["schema_version"], 1, "{v}");
    assert_eq!(v["database"]["quick_check"], "ok", "{v}");
    assert_eq!(v["database"]["wal_bytes"], Value::Null, "{v}");
    assert_eq!(v["service"]["descriptor"], "PRESENT", "{v}");
    assert_eq!(v["service"]["pid_alive"], true, "{v}");
    assert_eq!(v["backups"]["files"], 1, "{v}");
    assert_eq!(v["conversion"]["state"], "MISSING", "{v}");
    assert_eq!(v["startup_state"], Value::Null);

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
