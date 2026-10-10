//! P-011（03 §2.5，A6）：`atm recover --offline` 只在独占准入下工作，不能成为绕过 USER_ONLY 的旁路。
//! 成功例：ATM 不在跑时从最新的可用整库备份恢复、写下标记与 lifecycle 记录；要在控制台输入备份 ID 确认。
//! 反例：宿主的单实例互斥被占、服务准入锁被占（挂住的服务）、安装事务在进行——退出码 5，数据根零变化；
//! HTTP 与 MCP 上没有恢复入口（静态扫描 + 实际请求）。

mod support;

use atm_store::backup::create_backup;
use atm_store::conversion::{self as cv, Layout};
use atm_store::{Config, Store};
use serde_json::Value;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use support::*;

const GEN: &str = "01J0000000000000000CLIREC0";

struct Fixture {
    root: PathBuf,
    backup: String,
}

/// 发布了的 `N`：一个项目行，做一份备份，之后再改项目名（恢复后应当回到备份时的名字）。
fn fixture(name: &str) -> Fixture {
    let root = test_dir(name);
    let _ = std::fs::remove_dir_all(&root);
    let layout = Layout::new(&root);
    cv::fresh_install(&layout, GEN, "2026-10-01T00:00:00.000Z").unwrap();
    let store = Store::open(&layout.database(), Config::default()).unwrap();
    store
        .write(|tx| {
            tx.execute_batch(
                "UPDATE app_meta SET scope_gen_counter = 1;
                 INSERT INTO scope_generations (gen, scope_kind, scope_id, reason, epoch, created_at)
                   VALUES (1, 'PROJECT', 'PA', 'CREATED', 'EA', '2026-10-01T00:00:00.000Z');
                 INSERT INTO projects (id, code, name, lifecycle, health, meta_version, scope_gen, epoch, created_at, updated_at)
                   VALUES ('PA', 'ATM', '备份时的名字', 'ACTIVE', 'ON_TRACK', 0, 1, 'EA',
                           '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');",
            )
        })
        .unwrap();
    let backup = create_backup(
        &store,
        &root.join("backups"),
        "MANUAL",
        "2026-10-02T00:00:00.000Z",
    )
    .unwrap()
    .id;
    store
        .write(|tx| tx.execute_batch("UPDATE projects SET name = '之后改的名字' WHERE id = 'PA'"))
        .unwrap();
    drop(store);
    Fixture { root, backup }
}

fn project_name(root: &Path) -> String {
    let c = rusqlite::Connection::open(root.join("data").join("atm.sqlite")).unwrap();
    c.query_row("SELECT name FROM projects WHERE id = 'PA'", [], |r| {
        r.get(0)
    })
    .unwrap()
}

const TEST_MODE: (&str, &str) = ("ATM_TEST_MODE", "1");

#[test]
fn recover_restores_the_newest_usable_backup_after_confirmation() {
    let f = fixture("cli-recover-ok");
    // 不在测试模式：--yes 无效，什么都没改。
    let before = tree(&f.root);
    let run = atm_with(&f.root, &["recover", "--offline", "--yes"], &[]);
    assert_eq!(run.code, 2, "{}", run.stderr);
    assert!(run.stderr.contains("--yes 只在测试模式"), "{}", run.stderr);
    // 输错 ID、或者没有输入：不确认，什么都没改。
    for input in [Some("01J0000000000000000WRONG00\n"), None] {
        let exe = Path::new(env!("CARGO_BIN_EXE_atm"));
        let run = atm_full(exe, &f.root, &["recover", "--offline"], &[], input);
        assert_eq!(run.code, 1, "{input:?}: {}", run.stderr);
        assert!(
            run.stderr.contains("没有确认，什么都没改"),
            "{}",
            run.stderr
        );
        assert!(
            run.stderr.contains(&f.backup),
            "the prompt names the backup: {}",
            run.stderr
        );
    }
    let after = tree(&f.root);
    assert_eq!(
        after
            .keys()
            .filter(|k| !k.contains("runtime"))
            .collect::<Vec<_>>(),
        before
            .keys()
            .filter(|k| !k.contains("runtime"))
            .collect::<Vec<_>>(),
        "an unconfirmed recovery changed N"
    );
    assert_eq!(project_name(&f.root), "之后改的名字");

    // 输入正确的 ID：恢复。
    let exe = Path::new(env!("CARGO_BIN_EXE_atm"));
    let run = atm_full(
        exe,
        &f.root,
        &["--json", "recover", "--offline"],
        &[],
        Some(&format!("{}\n", f.backup)),
    );
    assert_eq!(run.code, 0, "{}{}", run.stdout, run.stderr);
    let v = run.json();
    assert_eq!(v["backup_id"], f.backup.as_str(), "{v}");
    assert_eq!(v["ledgers_lost"], false, "{v}");
    assert_eq!(project_name(&f.root), "备份时的名字");
    assert!(f.root.join("runtime").join("recovered.json").is_file());
    let quarantine = PathBuf::from(v["quarantine"].as_str().unwrap());
    assert!(quarantine.starts_with(f.root.join("quarantine")), "{v}");
    let log = std::fs::read_to_string(f.root.join("logs").join("lifecycle.ndjson")).unwrap();
    let line: Value = serde_json::from_str(log.lines().last().unwrap()).unwrap();
    assert_eq!(line["event"], "offline.recover");
    assert_eq!(line["backupId"], f.backup.as_str());

    // 测试模式下 --yes 也行；--from 点名一份。
    let again = fixture("cli-recover-yes");
    let run = atm_with(
        &again.root,
        &[
            "--json",
            "recover",
            "--offline",
            "--yes",
            "--from",
            &again.backup,
        ],
        &[TEST_MODE],
    );
    assert_eq!(run.code, 0, "{}{}", run.stdout, run.stderr);
    assert_eq!(project_name(&again.root), "备份时的名字");
}

#[test]
fn recover_without_offline_or_with_a_bad_backup_changes_nothing() {
    let f = fixture("cli-recover-bad");
    let before = tree(&f.root);
    let run = atm_with(&f.root, &["recover"], &[TEST_MODE]);
    assert_eq!(run.code, 2);
    assert!(
        run.stderr.contains("recover 只有离线形式"),
        "{}",
        run.stderr
    );
    let run = atm_with(
        &f.root,
        &[
            "--json",
            "recover",
            "--offline",
            "--yes",
            "--from",
            "01J0000000000000000NOSUCH0",
        ],
        &[TEST_MODE],
    );
    assert_eq!(run.code, 1, "{}", run.stdout);
    assert_eq!(run.json()["error"]["code"], "ATM_RECOVER_NO_BACKUP");
    // 备份被改过：列表说明原因，恢复拒绝。
    let db = f.root.join("backups").join(&f.backup).join("atm.sqlite");
    let mut bytes = std::fs::read(&db).unwrap();
    let last = bytes.len() - 1;
    bytes[last] ^= 0xff;
    std::fs::write(&db, bytes).unwrap();
    let list = atm_with(&f.root, &["--json", "recover", "--offline", "--list"], &[]);
    assert_eq!(list.code, 0);
    let v = list.json();
    assert_eq!(v["backups"][0]["status"], "UNUSABLE", "{v}");
    assert!(
        v["backups"][0]["problem"]
            .as_str()
            .unwrap()
            .contains("differs"),
        "{v}"
    );
    let run = atm_with(
        &f.root,
        &["--json", "recover", "--offline", "--yes"],
        &[TEST_MODE],
    );
    assert_eq!(run.code, 1);
    assert_eq!(run.json()["error"]["code"], "ATM_RECOVER_NO_BACKUP");
    let mut expected = before;
    expected.insert(
        format!("backups\\{}\\atm.sqlite", f.backup),
        std::fs::read(&db).unwrap(),
    );
    let now: std::collections::BTreeMap<_, _> = tree(&f.root)
        .into_iter()
        .filter(|(k, _)| !k.starts_with("runtime"))
        .collect();
    let expected: std::collections::BTreeMap<_, _> = expected
        .into_iter()
        .filter(|(k, _)| !k.starts_with("runtime"))
        .collect();
    assert_eq!(now, expected, "a refused recovery changed N");
    assert_eq!(project_name(&f.root), "之后改的名字");
}

/// R1：ATM 在跑（宿主的单实例互斥）、服务挂住（准入锁还被占着）、安装事务在进行——都拒绝，退出码 5，零变化。
#[test]
fn recover_is_refused_while_anything_holds_the_admission() {
    let f = fixture("cli-recover-busy");
    let args = ["--json", "recover", "--offline", "--yes"];

    // 1. 服务挂住：进程还在，`N\runtime\service.lock` 仍被它锁着。
    std::fs::create_dir_all(f.root.join("runtime")).unwrap();
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(f.root.join("runtime").join("service.lock"))
        .unwrap();
    lock.try_lock().unwrap();
    let held = tree(&f.root);
    let run = atm_with(&f.root, &args, &[TEST_MODE]);
    assert_eq!(run.code, 5, "{}{}", run.stdout, run.stderr);
    assert!(run.stdout.contains("挂住"), "{}", run.stdout);
    assert_eq!(tree(&f.root), held);
    drop(lock);

    // 2. 安装事务：atm.exe 在安装布局里，setup 的事务日志在。
    let install = f.root.parent().unwrap().join("cli-recover-busy-install");
    let _ = std::fs::remove_dir_all(&install);
    let resources = install.join("app-3.0.0").join("resources");
    std::fs::create_dir_all(&resources).unwrap();
    std::fs::create_dir_all(install.join("state")).unwrap();
    std::fs::write(install.join("app.json"), "{}").unwrap();
    std::fs::write(install.join("state").join("install.json"), "{}").unwrap();
    let exe = resources.join("atm.exe");
    std::fs::copy(env!("CARGO_BIN_EXE_atm"), &exe).unwrap();
    let held = tree(&f.root);
    let run = atm_full(&exe, &f.root, &args, &[TEST_MODE], None);
    assert_eq!(run.code, 5, "{}{}", run.stdout, run.stderr);
    assert!(run.stdout.contains("正在安装或更新"), "{}", run.stdout);
    assert_eq!(tree(&f.root), held);
    // 阳性对照：事务结束后同一个 atm.exe 能恢复。
    std::fs::remove_file(install.join("state").join("install.json")).unwrap();
    let run = atm_full(&exe, &f.root, &args, &[TEST_MODE], None);
    assert_eq!(run.code, 0, "{}{}", run.stdout, run.stderr);
    assert_eq!(project_name(&f.root), "备份时的名字");
    let _ = std::fs::remove_dir_all(&install);

    // 3. 宿主在跑：同一个 2.x 根 L 起名的单实例互斥。放在最后：这个进程拿到的互斥要到进程结束才放掉。
    let f = fixture("cli-recover-host");
    let before = tree(&f.root);
    let legacy = f.root.join("localappdata").join("AyanamiTaskManager");
    {
        let _host = atm_install_state::ipc::acquire(&legacy).expect("take the host mutex");
        let run = atm_with(&f.root, &args, &[TEST_MODE]);
        assert_eq!(run.code, 5, "{}{}", run.stdout, run.stderr);
        assert_eq!(run.json()["error"]["code"], "ATM_ADMISSION_CONFLICT");
        assert!(run.stdout.contains("请先在托盘退出 ATM"), "{}", run.stdout);
        // --list 只读，不取准入：照样能看。
        let list = atm_with(&f.root, &["--json", "recover", "--offline", "--list"], &[]);
        assert_eq!(list.code, 0, "{}", list.stderr);
    }
    assert_eq!(tree(&f.root), before);
}

/// R2 / T-GONE：Agent HTTP、MCP、ui-bridge、e2e 适配器、服务层、调度器的源码里没有恢复的调用；
/// 运行中的 Agent HTTP 上，恢复相关的路径都是 404，三个 MCP 档位的工具里也没有恢复。
#[test]
fn no_remote_entry_reaches_the_offline_recovery() {
    let native = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let needles = ["recover::", "atm_store::recover", "recover_with("];
    let hits = |dir: &Path| -> Vec<String> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).unwrap() {
                let p = e.unwrap().path();
                if p.is_dir() {
                    stack.push(p);
                } else if p.extension().is_some_and(|x| x == "rs") {
                    let text = std::fs::read_to_string(&p).unwrap();
                    if needles.iter().any(|n| text.contains(n)) {
                        out.push(p.display().to_string());
                    }
                }
            }
        }
        out
    };
    for adapter in ["http", "ui-bridge", "e2e-adapter", "service", "jobs"] {
        assert_eq!(
            hits(&native.join(adapter).join("src")),
            Vec::<String>::new(),
            "{adapter}"
        );
    }
    // 阳性对照：扫描器认得出真正的调用方。
    assert!(!hits(&native.join("cli").join("src")).is_empty());
    assert!(!hits(&native.join("runtime").join("src")).is_empty());

    let w = world("cli-recover-gone");
    for (method, path) in [
        ("POST", "/api/v1/recover"),
        ("POST", "/api/v1/system/recover"),
        ("POST", "/api/v1/backups/x/recover"),
        ("POST", "/api/v1/recover/offline"),
    ] {
        assert_eq!(raw(w.port, method, path, "{}").0, 404, "{method} {path}");
    }
    for profile in ["core", "memory", "actions"] {
        let (status, body) = raw(
            w.port,
            "POST",
            &format!("/mcp/{profile}"),
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#,
        );
        assert_eq!(status, 200, "{body}");
        let v: Value = serde_json::from_str(&body).unwrap();
        let names: Vec<&str> = v["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert!(!names.is_empty(), "{profile}");
        assert!(
            names.iter().all(|n| !n.contains("recover")),
            "{profile}: {names:?}"
        );
    }
}

fn raw(port: u16, method: &str, path: &str, body: &str) -> (u16, String) {
    let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(std::time::Duration::from_secs(30)))
        .unwrap();
    let req = format!(
        "{method} {path} HTTP/1.1\r\nConnection: close\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {TOKEN}\r\n\
         Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    s.write_all(req.as_bytes()).unwrap();
    let mut out = Vec::new();
    let _ = s.read_to_end(&mut out);
    let text = String::from_utf8_lossy(&out).into_owned();
    let status = text
        .split(' ')
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    (
        status,
        text.split("\r\n\r\n").nth(1).unwrap_or_default().to_owned(),
    )
}
