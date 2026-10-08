//! 运行时用例的共用夹具：最小的 2.x 数据根、选项、事件记录。
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use atm_runtime::{Drill, Event, Options};
use atm_store::conversion::Quiesce;
use rusqlite::{Connection, params};

pub const T: &str = "2026-10-01T00:00:00.000Z";

/// 测试的可写目录：跟着 `CARGO_TARGET_DIR` 走（W2 r1 P2-02）。
pub fn test_root() -> PathBuf {
    let root = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("target")
        })
        .join("runtime-tests");
    // 相对的 CARGO_TARGET_DIR 是相对于调用方的工作目录；子进程与 SQLite 的 URI 都要绝对路径。
    std::path::absolute(root).unwrap()
}

pub fn dir(name: &str) -> PathBuf {
    let d = test_root().join(name);
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn migrations(kind: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../migrations")
        .join(kind)
}

/// 按 2.x 的迁移文件建库，并像 2.0 的迁移执行器那样登记 schema_migrations。
fn legacy_db(path: &Path, kind: &str) -> Connection {
    use sha2::Digest;
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut files: Vec<PathBuf> = std::fs::read_dir(migrations(kind))
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
        let sql = std::fs::read(&f).unwrap();
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
    c
}

/// 最小的 2.x 数据根：注册库、知识库、一个项目。返回 `L`。
pub fn legacy_root(base: &Path) -> PathBuf {
    let root = base.join("L");
    let reg = legacy_db(&root.join("registry/registry.sqlite"), "registry");
    reg.execute_batch(&format!(
        "INSERT INTO app_meta (singleton, current_sequence, data_version, created_at, updated_at) VALUES (1, 1, 1, '{T}', '{T}');
         INSERT INTO projects (id, code, name, description, db_path, lifecycle, coordination_mode, version, created_at, updated_at)
           VALUES ('P1', 'AAA', 'Alpha', '', NULL, 'ACTIVE', 'AUTO', 1, '{T}', '{T}');
         INSERT INTO global_events (sequence, type, aggregate_id, actor, payload_json, created_at, dedupe_key)
           VALUES (1, 'project.created', 'P1', 'USER', '{{}}', '{T}', NULL);"
    ))
    .unwrap();
    drop(reg);
    let k = legacy_db(&root.join("knowledge/knowledge.sqlite"), "knowledge");
    k.execute_batch(
        "INSERT INTO knowledge_meta (singleton, database_id, generation, sequence) VALUES (1, 'KDB', 'KG1', 0);",
    )
    .unwrap();
    drop(k);
    let p = legacy_db(&root.join("projects/P1/project.sqlite"), "project");
    p.execute_batch(&format!(
        "INSERT INTO project_meta (singleton, project_id, project_code, name, description, lifecycle, coordination_mode, health,
                                   current_sequence, schema_version, version, created_at, updated_at)
           VALUES (1, 'P1', 'AAA', 'Alpha', '', 'ACTIVE', 'AUTO', 'ON_TRACK', 0, 18, 1, '{T}', '{T}');"
    ))
    .unwrap();
    drop(p);
    std::fs::write(
        root.join("projects/P1/manifest.json"),
        "{\n  \"schema_version\": 1,\n  \"project_id\": \"P1\",\n  \"project_code\": \"AAA\",\n  \"name\": \"Alpha\"\n}\n",
    )
    .unwrap();
    root
}

/// 在 2.x 里加一条业务数据（一条快速任务）：比较应当判「变了」。
pub fn touch_legacy(root: &Path) {
    let c = Connection::open(root.join("registry/registry.sqlite")).unwrap();
    c.execute(
        "INSERT INTO quick_tasks (id, local_no, title, status, actor, created_at, updated_at)
         VALUES ('Q9', 9, 'written in 2.x', 'OPEN', 'USER', ?1, ?1)",
        [T],
    )
    .unwrap();
}

/// 递归复制一棵目录（把 `L` 搬到另一个路径，内容不变）。
pub fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        let target = to.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            copy_tree(&e.path(), &target);
        } else {
            std::fs::copy(e.path(), target).unwrap();
        }
    }
}

#[derive(Clone, Default)]
pub struct Events(Arc<Mutex<Vec<Event>>>);

impl Events {
    pub fn observer(&self) -> Arc<dyn Fn(Event) + Send + Sync> {
        let me = self.0.clone();
        Arc::new(move |e| me.lock().unwrap().push(e))
    }
    pub fn take(&self) -> Vec<Event> {
        std::mem::take(&mut self.0.lock().unwrap())
    }
    pub fn seen(&self) -> Vec<Event> {
        self.0.lock().unwrap().clone()
    }
}

pub fn options(n: &Path, legacy: &Path, events: &Events) -> Options {
    Options {
        n: n.to_path_buf(),
        legacy: legacy.to_path_buf(),
        version: "3.0.0-test".into(),
        handoff: None,
        quiesce: Box::new(|| Quiesce::Quiet),
        allow_real_data_root: false,
        real_data_root: None,
        secrets_check: Some(atm_runtime::secrets::check),
        sweep_every: Duration::from_secs(3600),
        drill: Drill::default(),
        observe: events.observer(),
    }
}

/// `N\runtime` 里的文件名（排序）。
pub fn runtime_files(n: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(n.join("runtime"))
        .map(|d| {
            d.map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

/// 原始 HTTP GET（不带令牌）：返回 (状态码, body)。连不上返回 `None`。
pub fn get(port: u16, path: &str) -> Option<(u16, String)> {
    use std::io::{Read, Write};
    let mut s = std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_secs(2),
    )
    .ok()?;
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes()).ok()?;
    let mut out = Vec::new();
    let _ = s.read_to_end(&mut out);
    let text = String::from_utf8_lossy(&out).into_owned();
    let status = text.split(' ').nth(1)?.parse().ok()?;
    Some((status, text.split("\r\n\r\n").nth(1).unwrap_or_default().to_owned()))
}
