//! 安装探测的真实进程（W8a，方案 §6 PROBE；替代 2.x 的 core-probe-process 用例）。
//!
//! 合成的安装根：`app-9.9.9\AyanamiTaskManager.exe`（本次构建的宿主）、`resources\atm.exe`（打包标记）、
//! `app.json`、`state\install.json`；「setup」就是本测试进程，以独占方式打开 `state\install.lock` 持锁。
//!
//! - 绑定的 PROBE 事务：宿主在进程内检查数据，报告写到 `state\health\probe-<txn>.json`，两个数据根一个字节、
//!   一个 mtime 都不变，`N` 不会被建出来。
//! - 数据过不了（更新的 2.x 写过的迁移、这个账户解不开的同步密文）：退出码 4，报告 `ok:false` 带错误码与位置。
//! - 没绑定（没人持锁、事务 id 不对、不在 PROBE、目标不是本版本）：参数不授予任何能力，退出码 3，什么都不写。

use std::collections::BTreeMap;
use std::fs;
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use rusqlite::{Connection, params};
use serde_json::Value;
use sha2::Digest;

const HOST: &str = env!("CARGO_BIN_EXE_AyanamiTaskManager");
const VERSION: &str = "9.9.9";
const T: &str = "2026-09-01T00:00:00.000Z";

struct Install {
    root: PathBuf,
}

impl Install {
    fn new(name: &str) -> Install {
        let root = Path::new(env!("CARGO_TARGET_TMPDIR"))
            .join("host-probe")
            .join(format!("{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let app = root.join("install").join(format!("app-{VERSION}"));
        fs::create_dir_all(app.join("resources")).unwrap();
        let host = app.join("AyanamiTaskManager.exe");
        if fs::hard_link(HOST, &host).is_err() {
            fs::copy(HOST, &host).unwrap();
        }
        fs::write(app.join("resources").join("atm.exe"), b"").unwrap();
        fs::create_dir_all(root.join("install").join("state")).unwrap();
        fs::write(
            root.join("install").join("app.json"),
            r#"{"current":"1.0.0"}"#,
        )
        .unwrap();
        Install { root }
    }
    fn install_root(&self) -> PathBuf {
        self.root.join("install")
    }
    fn legacy(&self) -> PathBuf {
        self.root.join("l")
    }
    fn n(&self) -> PathBuf {
        self.root.join("n")
    }
    fn journal(&self, id: &str, to: &str, state: &str) {
        let body = serde_json::json!({ "id": id, "from": "1.0.0", "to": to, "state": state });
        fs::write(
            self.install_root().join("state").join("install.json"),
            body.to_string(),
        )
        .unwrap();
    }
    /// setup 持锁的方式：独占打开（share mode 0），句柄在锁就在。
    fn hold_lock(&self) -> fs::File {
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .share_mode(0)
            .open(self.install_root().join("state").join("install.lock"))
            .unwrap()
    }
    fn report(&self, txn: &str) -> Option<Value> {
        let path = self
            .install_root()
            .join("state")
            .join("health")
            .join(format!("probe-{txn}.json"));
        let text = fs::read_to_string(path).ok()?;
        Some(serde_json::from_str(&text).unwrap())
    }
    /// 跑一次探测，核对两个数据根没被动过，返回退出码。
    fn probe(&self, txn: &str) -> i32 {
        let before = fingerprint(&[&self.legacy(), &self.n()]);
        let status = Command::new(
            self.install_root()
                .join(format!("app-{VERSION}"))
                .join("AyanamiTaskManager.exe"),
        )
        .args(["--health-probe", "--txn", txn])
        .env("ATM_DATA_DIR", self.legacy())
        .env("ATM3_DATA_DIR", self.n())
        .env_remove("AYANAMI_TASK_DATA_DIR")
        .env_remove("ATM_DEV_REPOSITORY_ROOT")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("run the probe");
        assert_eq!(
            fingerprint(&[&self.legacy(), &self.n()]),
            before,
            "the probe wrote to a data root"
        );
        status.code().expect("an exit code")
    }
}

impl Drop for Install {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// 根下每个文件：大小、修改时间、内容哈希。根不在就是空。
fn fingerprint(roots: &[&Path]) -> BTreeMap<PathBuf, (u64, std::time::SystemTime, Vec<u8>)> {
    let mut out = BTreeMap::new();
    for root in roots {
        let mut stack = vec![root.to_path_buf()];
        while let Some(d) = stack.pop() {
            let Ok(entries) = fs::read_dir(&d) else {
                continue;
            };
            for e in entries {
                let e = e.unwrap();
                let meta = e.metadata().unwrap();
                if meta.is_dir() {
                    stack.push(e.path());
                } else {
                    let hash = sha2::Sha256::digest(fs::read(e.path()).unwrap()).to_vec();
                    out.insert(e.path(), (meta.len(), meta.modified().unwrap(), hash));
                }
            }
        }
    }
    out
}

/// 按仓库里 2.x 自己的迁移文件建库并登记（同 store 的 `tests/probe.rs`）。
fn legacy_db(path: &Path, kind: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../migrations")
        .join(kind);
    let mut files: Vec<PathBuf> = fs::read_dir(&root)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    files.sort();
    let c = Connection::open(path).unwrap();
    c.execute_batch(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL,
           content_sha256 TEXT NOT NULL, hash_origin TEXT NOT NULL CHECK(hash_origin IN ('APPLIED','LEGACY_BASELINE_UNVERIFIED')))",
    )
    .unwrap();
    for f in files {
        let name = f.file_name().unwrap().to_string_lossy().into_owned();
        let version: i64 = name[..4].parse().unwrap();
        let sql = fs::read(&f).unwrap();
        let sha: String = sha2::Sha256::digest(&sql)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        c.execute_batch(std::str::from_utf8(&sql).unwrap()).unwrap();
        c.execute(
            "INSERT INTO schema_migrations VALUES (?1, ?2, ?3, ?4, 'APPLIED')",
            params![version, name, T, sha],
        )
        .unwrap();
    }
}

/// 标准 base64（带补位），同步密文文件里的写法。
fn base64(bytes: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(A[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn legacy_root(l: &Path) {
    legacy_db(&l.join("registry").join("registry.sqlite"), "registry");
    legacy_db(&l.join("knowledge").join("knowledge.sqlite"), "knowledge");
    legacy_db(
        &l.join("projects").join("P1").join("project.sqlite"),
        "project",
    );
}

#[test]
fn a_bound_probe_checks_the_2x_root_in_process_and_writes_only_its_report() {
    let install = Install::new("ok");
    legacy_root(&install.legacy());
    install.journal("txn-1", VERSION, "PROBE");
    let lock = install.hold_lock();
    assert_eq!(install.probe("txn-1"), 0);
    drop(lock);
    let report = install.report("txn-1").expect("the report");
    assert_eq!(
        (&report["ok"], &report["code"], &report["txnId"], &report["version"]),
        (&Value::Bool(true), &Value::Null, &Value::from("txn-1"), &Value::from(VERSION)),
        "{report}"
    );
    assert_eq!(report["startup"], "FIRST_CONVERSION");
    let scopes: Vec<&str> = report["databases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["scope"].as_str().unwrap())
        .collect();
    assert_eq!(scopes, ["registry", "knowledge", "project"]);
    assert!(!install.n().exists(), "the probe created N");
    // 安装根里除了报告也没多出东西（没有日志、没有租约）。
    let state: Vec<String> = fs::read_dir(install.install_root().join("state"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(state.len(), 3, "{state:?}");
}

#[test]
fn data_this_version_cannot_open_fails_the_probe_with_a_code_and_a_scope() {
    let install = Install::new("future");
    legacy_root(&install.legacy());
    Connection::open(install.legacy().join("registry").join("registry.sqlite"))
        .unwrap()
        .execute(
            "INSERT INTO schema_migrations VALUES (99, '0099_from_the_future.sql', ?1, 'ab', 'APPLIED')",
            [T],
        )
        .unwrap();
    install.journal("txn-1", VERSION, "PROBE");
    let lock = install.hold_lock();
    assert_eq!(install.probe("txn-1"), 4);
    drop(lock);
    let report = install.report("txn-1").expect("the report");
    assert_eq!(
        (&report["ok"], &report["code"], &report["scope"]),
        (
            &Value::Bool(false),
            &Value::from("LEGACY_SCHEMA_UNKNOWN"),
            &Value::from("registry")
        ),
        "{report}"
    );

    // 同步密文用的是这个 Windows 账户真实的 DPAPI 自检：这个账户封的放行，解不开的拒绝。
    let install = Install::new("secrets");
    legacy_root(&install.legacy());
    fs::create_dir_all(install.legacy().join("sync")).unwrap();
    let secrets = install.legacy().join("sync").join("secrets.dpapi.json");
    let sealed = base64(&atm_sync::dpapi::protect(b"relay token").unwrap());
    fs::write(&secrets, serde_json::json!({ "relayToken": sealed }).to_string()).unwrap();
    install.journal("txn-2", VERSION, "PROBE");
    let lock = install.hold_lock();
    assert_eq!(install.probe("txn-2"), 0, "{:?}", install.report("txn-2"));
    let other = base64(b"not sealed by this account");
    fs::write(
        &secrets,
        serde_json::json!({ "relayToken": sealed, "deviceKey": other }).to_string(),
    )
    .unwrap();
    assert_eq!(install.probe("txn-2"), 4);
    drop(lock);
    let report = install.report("txn-2").expect("the report");
    assert_eq!(
        (&report["code"], &report["scope"]),
        (
            &Value::from("SYNC_SECRETS_UNREADABLE"),
            &Value::from("sync")
        ),
        "{report}"
    );
}

#[test]
fn an_unbound_probe_is_refused_without_writing_anything() {
    let cases: [(&str, &str, &str, &str, bool); 4] = [
        ("no-lock", "txn-1", VERSION, "PROBE", false),
        ("other-txn", "txn-other", VERSION, "PROBE", true),
        ("not-probe", "txn-1", VERSION, "START", true),
        ("other-version", "txn-1", "8.8.8", "PROBE", true),
    ];
    for (name, id, to, state, locked) in cases {
        let install = Install::new(name);
        legacy_root(&install.legacy());
        install.journal(id, to, state);
        let lock = locked.then(|| install.hold_lock());
        assert_eq!(install.probe("txn-1"), 3, "{name}");
        drop(lock);
        assert!(install.report("txn-1").is_none(), "{name}");
        assert!(
            !install.install_root().join("state").join("health").exists(),
            "{name}"
        );
        assert!(!install.n().exists(), "{name}");
    }
}
