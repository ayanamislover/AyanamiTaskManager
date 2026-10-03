//! W1g 负载基准（不是用例，不进 `cargo test`）。
//!
//! 样本库照 08 §1 / `scripts/budget-measure.ts`：100 个项目、主项目 1 万条任务、4 万条检索文档；
//! 另给每个项目补一段事件历史（带全局镜像与回执），让单库文件到约 104 MiB，和 2.0 样本库落盘大小同量级。
//! 负载：跨项目写入、全局与项目搜索、项目概览、整项目大查询、整库备份同时进行；
//! 每 100 ms 采一次 WAL、临时目录、备份目录、进程内存与 SQLite 堆。
//!
//! ```text
//! cargo run --release -p atm-store --example load_bench -- seed <seed-dir>
//! cargo run --release -p atm-store --example load_bench -- amplify <seed-dir> <run-dir>
//! cargo run --release -p atm-store --example load_bench -- run <seed-dir> <run-dir> [cache=KiB] [gap=ms] [wal=MiB] [rwait=ms] [secs=N] [profile=stress|agent] [backup=1|0]
//! ```
//!
//! `run` 每次从种子复制一份，结果写到 `<run-dir>/result.json`。每个 page cache 取值单独起一个进程，
//! 内存读数互不污染。

use atm_store::backup::{create_backup, verify_backup};
use atm_store::events::{NewEvent, append_event, next_number};
use atm_store::search::{Doc, Scope, match_docs, terms, upsert_doc};
use atm_store::{Config, ReadError, Stats, Store, WriteError};
use rusqlite::{Transaction, params};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const AT: &str = "2026-10-03T00:00:00.000Z";
const PROJECTS: usize = 100;
const PRIMARY: &str = "PFM";
const PRIMARY_WORK: usize = 10_000;
const PRIMARY_DOCS: usize = 40_000;
const OTHER_WORK: usize = 20;
const EVENTS_PER_PROJECT: usize = 285;
const EVENT_NOTE_CHARS: usize = 300;

const WRITERS: usize = 8;
const SEARCHERS: usize = 3;
const BACKUP_EVERY: Duration = Duration::from_secs(15);
const EXPORT_EVERY: Duration = Duration::from_secs(10);
const SAMPLE_EVERY: Duration = Duration::from_millis(100);
const IDLE_CHECKPOINT: Duration = Duration::from_secs(5);

const WORDS: &[&str] = &[
    "预算",
    "任务管理",
    "本地优先",
    "验证",
    "关键词",
    "样本",
    "迁移",
    "备份",
    "恢复",
    "检索",
    "会话",
    "交接",
    "评审",
    "证据",
    "进度",
    "阻塞",
    "里程碑",
    "目标",
    "schema",
    "checkpoint",
    "receipt",
    "writer",
    "reader",
    "budget",
    "sqlite",
    "agent",
];
const QUERIES: &[&str] = &[
    "预算",
    "任务管理",
    "本地优先 验证",
    "第 1234 条",
    "DOC-777",
    "PFM-T-00",
    "checkpoint",
    "样本任务 迁移",
    "不存在的词组",
];

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn sentence(&mut self, chars: usize) -> String {
        let mut s = String::new();
        while s.chars().count() < chars {
            s.push_str(WORDS[self.below(WORDS.len())]);
            s.push(' ');
        }
        s
    }
}

fn project_id(i: usize) -> String {
    if i == 0 {
        PRIMARY.to_string()
    } else {
        format!("P{i:03}")
    }
}

fn work_count(p: &str) -> usize {
    if p == PRIMARY {
        PRIMARY_WORK
    } else {
        OTHER_WORK
    }
}

fn s<T, E: std::fmt::Display>(r: Result<T, E>) -> Result<T, String> {
    r.map_err(|e| e.to_string())
}

fn insert_work(
    tx: &Transaction<'_>,
    project: &str,
    title: &str,
    desc: &str,
    at: &str,
) -> Result<String, String> {
    let no = s(next_number(tx, project, "work_item"))?;
    let id = format!("{project}-W{no}");
    s(tx.execute(
        "INSERT INTO work_items (project_id, id, local_no, objective_id, type, title, description, status, priority, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'OBJ', 'TASK', ?4, ?5, 'READY', 'NORMAL', ?6, ?6)",
        params![project, id, no, title, desc, at],
    ))?;
    s(upsert_doc(
        tx,
        &Doc {
            project_id: project,
            entity_type: "WORK_ITEM",
            entity_id: &id,
            entity_key: &format!("{project}-T-{no:04}"),
            title,
            body: desc,
            updated_at: at,
        },
    ))?;
    Ok(id)
}

#[allow(clippy::too_many_arguments)]
fn event(
    tx: &Transaction<'_>,
    project: &str,
    kind: &str,
    session: &str,
    aggregate: &str,
    op: &str,
    payload: &str,
    at: &str,
) -> Result<(), String> {
    s(append_event(
        tx,
        &NewEvent {
            project_id: project,
            kind,
            actor_type: "AGENT",
            actor_id: "claude",
            session_id: Some(session),
            aggregate_type: "WORK_ITEM",
            aggregate_id: aggregate,
            correlation_id: None,
            op_id: Some(op),
            payload_json: payload,
            at,
        },
    ))
    .map(|_| ())
}

fn receipt(
    tx: &Transaction<'_>,
    project: &str,
    session: &str,
    op: &str,
    operation: &str,
    body: &str,
    at: &str,
) -> Result<(), String> {
    s(tx.execute(
        "INSERT INTO idempotency_receipts (scope_kind, scope_id, ns_kind, ns_id, op_id, operation, fp_v, fp_family, fingerprint,
                                           receipt_json, scope_generation, created_at)
         VALUES ('PROJECT', ?1, 'SESSION', ?2, ?3, ?4, 2, 'canon-v2', ?5, ?6, (SELECT scope_gen FROM projects WHERE id = ?1), ?7)",
        params![project, session, op, operation, format!("fp-{op}"), body, at],
    ))
    .map(|_| ())
}

fn payload(note: &str) -> String {
    format!(r#"{{"note":"{note}","status":"IN_PROGRESS"}}"#)
}

// ---------- 种子 ----------

fn seed(dir: &Path) -> Result<(), String> {
    let _ = fs::remove_dir_all(dir);
    s(fs::create_dir_all(dir))?;
    let path = dir.join("atm.sqlite");
    let started = Instant::now();
    let mut conn = s(atm_store::open(&path))?;
    let tx = s(conn.transaction())?;
    let mut rng = Rng(0x5EED_0000_0000_0001);
    s(tx.execute(
        "INSERT INTO app_meta (singleton, schema_version, data_root_id, generation, instance_epoch, scope_gen_counter, created_at, updated_at)
         VALUES (1, 1, 'BENCH-ROOT', 'G', 'EPOCH-1', ?1, ?2, ?2)",
        params![PROJECTS as i64 + 1, AT],
    ))?;
    for i in 0..PROJECTS {
        let p = project_id(i);
        let name = if i == 0 {
            "预算基准".to_string()
        } else {
            format!("预算项目 {i}")
        };
        s(tx.execute_batch(&format!(
            "INSERT INTO scope_generations (gen, scope_kind, scope_id, reason, epoch, created_at) VALUES ({g}, 'PROJECT', '{p}', 'CREATED', 'E-{p}', '{AT}');
             INSERT INTO projects (id, code, name, lifecycle, health, scope_gen, epoch, created_at, updated_at)
               VALUES ('{p}', '{p}', '{name}', 'ACTIVE', 'ON_TRACK', {g}, 'E-{p}', '{AT}', '{AT}');
             INSERT INTO objectives (project_id, id, local_no, title, status, created_at, updated_at) VALUES ('{p}', 'OBJ', 1, '预算基准目标', 'ACTIVE', '{AT}', '{AT}');
             INSERT INTO counters (project_id, name, next_value) VALUES ('{p}', 'work_item', 1);
             INSERT INTO agents (project_id, id, display_name, client_kind, created_at, updated_at) VALUES ('{p}', 'claude', 'Claude', 'cli', '{AT}', '{AT}');
             INSERT INTO agent_sessions (project_id, id, agent_id, role, work_state, connection_state, started_at, updated_at)
               VALUES ('{p}', 'S-{p}', 'claude', 'PRIMARY', 'IDLE', 'ONLINE', '{AT}', '{AT}');",
            g = i + 1
        )))?;
    }
    let k = PROJECTS + 1;
    s(tx.execute_batch(&format!(
        "INSERT INTO scope_generations (gen, scope_kind, scope_id, reason, epoch, created_at) VALUES ({k}, 'KNOWLEDGE', 'KDB', 'CREATED', 'E-K', '{AT}');
         INSERT INTO knowledge_meta (singleton, database_id, generation, sequence, scope_gen) VALUES (1, 'KDB', 'KG0', 0, {k});"
    )))?;

    let mut ops = 0u64;
    for i in 0..PROJECTS {
        let p = project_id(i);
        for n in 0..work_count(&p) {
            let id = insert_work(
                &tx,
                &p,
                &format!("预算任务 {n:05}"),
                &format!("真实规模样本任务 {n}"),
                AT,
            )?;
            ops += 1;
            let op = format!("seed-{ops}");
            receipt(
                &tx,
                &p,
                &format!("S-{p}"),
                &op,
                "work.create",
                &format!(r#"{{"id":"{id}"}}"#),
                AT,
            )?;
        }
    }
    for n in 0..PRIMARY_DOCS {
        s(upsert_doc(
            &tx,
            &Doc {
                project_id: PRIMARY,
                entity_type: "RECORD",
                entity_id: &format!("budget-document-{n}"),
                entity_key: &format!("DOC-{n}"),
                title: &format!("中文预算文档 {n}"),
                body: &format!("项目验证关键词 任务管理 本地优先 第 {n} 条"),
                updated_at: AT,
            },
        ))?;
    }
    for i in 0..PROJECTS {
        let p = project_id(i);
        let sess = format!("S-{p}");
        for _ in 0..EVENTS_PER_PROJECT {
            ops += 1;
            let op = format!("seed-{ops}");
            let target = format!("{p}-W{}", 1 + rng.below(work_count(&p)));
            let body = payload(&rng.sentence(EVENT_NOTE_CHARS));
            event(&tx, &p, "work.progress", &sess, &target, &op, &body, AT)?;
            receipt(&tx, &p, &sess, &op, "progress.add", &body, AT)?;
        }
    }
    s(tx.commit())?;
    s(conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(())))?;
    let counts: Value = {
        let q = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
        json!({
            "projects": q("SELECT count(*) FROM projects"),
            "workItems": q("SELECT count(*) FROM work_items"),
            "searchDocs": q("SELECT count(*) FROM search_docs"),
            "events": q("SELECT count(*) FROM events"),
            "globalFeed": q("SELECT count(*) FROM global_feed"),
            "receipts": q("SELECT count(*) FROM idempotency_receipts"),
            "pageSize": q("PRAGMA page_size"),
            "pages": q("PRAGMA page_count"),
        })
    };
    drop(conn);
    let bytes = s(fs::metadata(&path))?.len();
    let report = json!({
        "seededMs": started.elapsed().as_millis() as u64,
        "bytes": bytes,
        "mib": bytes as f64 / 1048576.0,
        "counts": counts,
    });
    s(fs::write(
        dir.join("seed.json"),
        serde_json::to_string_pretty(&report).unwrap(),
    ))?;
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
    Ok(())
}

// ---------- 采样 ----------

#[cfg(windows)]
fn process_memory() -> (u64, u64) {
    use std::ffi::c_void;
    #[repr(C)]
    #[derive(Default)]
    struct Counters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set: usize,
        working_set: usize,
        quota_peak_paged: usize,
        quota_paged: usize,
        quota_peak_non_paged: usize,
        quota_non_paged: usize,
        pagefile: usize,
        peak_pagefile: usize,
        private: usize,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn K32GetProcessMemoryInfo(process: *mut c_void, counters: *mut Counters, cb: u32) -> i32;
    }
    let mut c = Counters {
        cb: size_of::<Counters>() as u32,
        ..Default::default()
    };
    // SAFETY: 伪句柄不需要关闭；结构体按 PROCESS_MEMORY_COUNTERS_EX 布局，cb 给出其大小。
    let ok = unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb) };
    if ok == 0 {
        (0, 0)
    } else {
        (c.private as u64, c.working_set as u64)
    }
}

#[cfg(not(windows))]
fn process_memory() -> (u64, u64) {
    (0, 0)
}

fn sqlite_heap() -> (u64, u64) {
    // SAFETY: 两个函数只读全局计数器。
    unsafe {
        (
            rusqlite::ffi::sqlite3_memory_used() as u64,
            rusqlite::ffi::sqlite3_memory_highwater(0) as u64,
        )
    }
}

fn tree_bytes(dir: &Path) -> u64 {
    let Ok(rd) = fs::read_dir(dir) else { return 0 };
    rd.flatten()
        .map(|e| match e.metadata() {
            Ok(m) if m.is_dir() => tree_bytes(&e.path()),
            Ok(m) => m.len(),
            Err(_) => 0,
        })
        .sum()
}

fn file_bytes(p: &Path) -> u64 {
    fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

#[derive(Clone, Copy, Default)]
struct Sample {
    t_ms: u64,
    wal: u64,
    tmp: u64,
    backups: u64,
    private: u64,
    working_set: u64,
    sqlite_heap: u64,
}

fn sample(t0: Instant, run: &Path) -> Sample {
    let (private, working_set) = process_memory();
    Sample {
        t_ms: t0.elapsed().as_millis() as u64,
        wal: file_bytes(&run.join("atm.sqlite-wal")),
        tmp: tree_bytes(&run.join("tmp")),
        backups: tree_bytes(&run.join("backups")),
        private,
        working_set,
        sqlite_heap: sqlite_heap().0,
    }
}

fn sample_json(s: &Sample) -> Value {
    json!({
        "tMs": s.t_ms, "walBytes": s.wal, "tmpBytes": s.tmp, "backupsBytes": s.backups,
        "privateBytes": s.private, "workingSetBytes": s.working_set, "sqliteHeapBytes": s.sqlite_heap,
    })
}

// ---------- 负载 ----------

/// (种类, 开始时刻 ms, 时长 µs)
type Lat = (&'static str, u64, u64);

struct Shared {
    store: Store,
    stop: AtomicBool,
    t0: Instant,
    errors: Mutex<BTreeMap<String, u64>>,
    backups: Mutex<Vec<(u64, u64)>>,
    run: PathBuf,
    think: Think,
}

/// 各类客户端两次操作之间的间隔（ms，均匀分布在区间内）。
#[derive(Clone, Copy)]
struct Think {
    writer: (u64, u64),
    search: (u64, u64),
    overview: (u64, u64),
}

impl Think {
    /// 压力档：8 个写入方各自 5～25 ms 一次。实测写入速率约为 Agent 档的 14 倍，用来看上界和退化方式。
    const STRESS: Think = Think {
        writer: (5, 25),
        search: (20, 50),
        overview: (30, 70),
    };
    /// Agent 档：8 个 Agent 各自 100～400 ms 一次写入，界面与 Agent 读取同样放缓。
    const AGENT: Think = Think {
        writer: (100, 400),
        search: (200, 600),
        overview: (300, 800),
    };
}

fn pause(rng: &mut Rng, (lo, hi): (u64, u64)) {
    std::thread::sleep(Duration::from_millis(
        lo + rng.below((hi - lo + 1) as usize) as u64,
    ));
}

impl Shared {
    fn err(&self, kind: &str, code: &str) {
        *self
            .errors
            .lock()
            .unwrap()
            .entry(format!("{kind}:{code}"))
            .or_default() += 1;
    }
    fn now_ms(&self) -> u64 {
        self.t0.elapsed().as_millis() as u64
    }
}

fn write_code<E: std::fmt::Display>(e: &WriteError<E>) -> String {
    match e {
        WriteError::Rejected(m) => format!("REJECTED({m})"),
        other => other.code().unwrap_or("OTHER").to_string(),
    }
}

fn read_code<E: std::fmt::Debug>(e: &ReadError<E>) -> String {
    let d = format!("{e:?}");
    d.split(['(', ' ', '{'])
        .next()
        .unwrap_or("OTHER")
        .to_string()
}

fn pick_project(rng: &mut Rng) -> String {
    // 三成落在主项目，其余均匀落在另外 99 个项目。
    if rng.below(10) < 3 {
        PRIMARY.to_string()
    } else {
        project_id(1 + rng.below(PROJECTS - 1))
    }
}

fn writer(sh: Arc<Shared>, seat: usize) -> Vec<Lat> {
    let mut rng = Rng(0xA11CE + seat as u64 * 7919);
    let mut out = Vec::new();
    let mut n = 0u64;
    while !sh.stop.load(Ordering::Relaxed) {
        n += 1;
        let p = pick_project(&mut rng);
        let sess = format!("S-{p}");
        let op = format!("w{seat}-{n}");
        let note = rng.sentence(200);
        let create = rng.below(10) < 4;
        let target = format!("{p}-W{}", 1 + rng.below(work_count(&p)));
        let start = sh.now_ms();
        let t = Instant::now();
        let kind = if create {
            "write.create"
        } else {
            "write.update"
        };
        let r = if create {
            sh.store.write(move |tx| {
                let at = AT;
                let id = insert_work(tx, &p, &format!("负载任务 {op}"), &note, at)?;
                let body = payload(&note);
                event(tx, &p, "work.created", &sess, &id, &op, &body, at)?;
                receipt(tx, &p, &sess, &op, "work.create", &body, at)
            })
        } else {
            sh.store.write(move |tx| {
                let at = AT;
                let (no, title): (i64, String) = s(tx.query_row(
                    "UPDATE work_items SET status = 'IN_PROGRESS', phase = 'IN_PROGRESS', version = version + 1, updated_at = ?3
                     WHERE project_id = ?1 AND id = ?2 RETURNING local_no, title",
                    params![p, target, at],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                ))?;
                s(tx.execute(
                    "INSERT INTO progress_updates (project_id, id, work_item_id, percent, summary, summary_hash, actor, session_id, created_at, op_id)
                     VALUES (?1, ?2, ?3, 50, ?4, ?5, 'claude', ?6, ?7, ?8)",
                    params![p, format!("PG-{op}"), target, note, format!("h-{op}"), sess, at, op],
                ))?;
                let body = payload(&note);
                event(tx, &p, "work.progress", &sess, &target, &op, &body, at)?;
                s(upsert_doc(
                    tx,
                    &Doc {
                        project_id: &p,
                        entity_type: "WORK_ITEM",
                        entity_id: &target,
                        entity_key: &format!("{p}-T-{no:04}"),
                        title: &title,
                        body: &note,
                        updated_at: at,
                    },
                ))?;
                receipt(tx, &p, &sess, &op, "progress.add", &body, at)
            })
        };
        match r {
            Ok(()) => out.push((kind, start, t.elapsed().as_micros() as u64)),
            Err(e) => sh.err(kind, &write_code(&e)),
        }
        pause(&mut rng, sh.think.writer);
    }
    out
}

fn searcher(sh: Arc<Shared>, seat: usize) -> Vec<Lat> {
    let mut rng = Rng(0xBEE5 + seat as u64 * 104729);
    let mut out = Vec::new();
    while !sh.stop.load(Ordering::Relaxed) {
        let q = QUERIES[rng.below(QUERIES.len())];
        let t_terms = terms(q).unwrap_or_default();
        let global = rng.below(10) < 6;
        let p = pick_project(&mut rng);
        let kind = if global {
            "search.global"
        } else {
            "search.project"
        };
        let start = sh.now_ms();
        let t = Instant::now();
        let r = sh.store.read(move |tx| {
            let scope = if global {
                Scope::Global {
                    lifecycles: &["ACTIVE"],
                }
            } else {
                Scope::Project(&p)
            };
            match_docs(tx, &t_terms, &scope, 50).map(|h| h.len())
        });
        match r {
            Ok(_) => out.push((kind, start, t.elapsed().as_micros() as u64)),
            Err(e) => sh.err(kind, &read_code(&e)),
        }
        pause(&mut rng, sh.think.search);
    }
    out
}

fn overview(sh: Arc<Shared>) -> Vec<Lat> {
    let mut rng = Rng(0x0FE2);
    let mut out = Vec::new();
    while !sh.stop.load(Ordering::Relaxed) {
        let p = pick_project(&mut rng);
        let start = sh.now_ms();
        let t = Instant::now();
        let r = sh.store.read(move |tx| {
            let mut n = 0usize;
            let mut st = tx.prepare_cached(
                "SELECT status, count(*) FROM work_items WHERE project_id = ?1 GROUP BY status",
            )?;
            n += st.query_map([&p], |_| Ok(()))?.collect::<rusqlite::Result<Vec<_>>>()?.len();
            let mut st = tx.prepare_cached(
                "SELECT id, title, status FROM work_items WHERE project_id = ?1 AND archived_at IS NULL
                 ORDER BY (CASE priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END), sort_key, created_at, local_no
                 LIMIT 50",
            )?;
            n += st.query_map([&p], |_| Ok(()))?.collect::<rusqlite::Result<Vec<_>>>()?.len();
            let mut st = tx.prepare_cached(
                "SELECT seq, type, payload_json FROM events WHERE project_id = ?1 ORDER BY seq DESC LIMIT 20",
            )?;
            n += st.query_map([&p], |_| Ok(()))?.collect::<rusqlite::Result<Vec<_>>>()?.len();
            let mut st = tx.prepare_cached(
                "SELECT global_seq, payload_json FROM global_feed ORDER BY global_seq DESC LIMIT 20",
            )?;
            n += st.query_map([], |_| Ok(()))?.collect::<rusqlite::Result<Vec<_>>>()?.len();
            Ok::<_, rusqlite::Error>(n)
        });
        match r {
            Ok(_) => out.push(("read.overview", start, t.elapsed().as_micros() as u64)),
            Err(e) => sh.err("read.overview", &read_code(&e)),
        }
        pause(&mut rng, sh.think.overview);
    }
    out
}

/// 整项目大查询：一次读事务里扫完主项目的全部任务与事件（导出的读取部分）。
fn export(sh: Arc<Shared>) -> Vec<Lat> {
    let mut out = Vec::new();
    let mut next = Instant::now() + Duration::from_secs(3);
    while !sh.stop.load(Ordering::Relaxed) {
        if Instant::now() < next {
            std::thread::sleep(Duration::from_millis(50));
            continue;
        }
        next += EXPORT_EVERY;
        let start = sh.now_ms();
        let t = Instant::now();
        let r = sh.store.read(|tx| {
            let mut bytes = 0usize;
            for sql in [
                "SELECT title || description || acceptance_json FROM work_items WHERE project_id = 'PFM' ORDER BY local_no",
                "SELECT payload_json FROM events WHERE project_id = 'PFM' ORDER BY seq",
                "SELECT summary FROM progress_updates WHERE project_id = 'PFM' ORDER BY created_at",
                "SELECT title || body FROM search_docs WHERE project_id = 'PFM'",
            ] {
                let mut st = tx.prepare(sql)?;
                let mut rows = st.query([])?;
                while let Some(r) = rows.next()? {
                    bytes += r.get_ref(0)?.as_str().map(str::len).unwrap_or(0);
                }
            }
            Ok::<_, rusqlite::Error>(bytes)
        });
        match r {
            Ok(_) => out.push(("read.export", start, t.elapsed().as_micros() as u64)),
            Err(e) => sh.err("read.export", &read_code(&e)),
        }
    }
    out
}

fn backup(sh: Arc<Shared>) -> Vec<Lat> {
    let mut out = Vec::new();
    let root = sh.run.join("backups");
    let mut next = Instant::now() + Duration::from_secs(5);
    while !sh.stop.load(Ordering::Relaxed) {
        if Instant::now() < next {
            std::thread::sleep(Duration::from_millis(50));
            continue;
        }
        next += BACKUP_EVERY;
        let start = sh.now_ms();
        let t = Instant::now();
        match create_backup(&sh.store, &root, "MANUAL", AT) {
            Ok(info) => {
                out.push(("backup", start, t.elapsed().as_micros() as u64));
                // 恢复前要做的完整校验（文件 sha、manifest、附件、quick_check、迁移、时间线）也算进备份窗口。
                let v = Instant::now();
                if let Err(e) = verify_backup(&sh.store, &info.id) {
                    sh.err(
                        "backup.verify",
                        &format!("{e:?}").chars().take(80).collect::<String>(),
                    );
                }
                out.push(("backup.verify", sh.now_ms(), v.elapsed().as_micros() as u64));
                let end = sh.now_ms();
                sh.backups.lock().unwrap().push((start, end));
                // 只量写入时的影响；保留文件会让后面的轮次多占盘，这里量完就删。
                let _ = fs::remove_dir_all(&info.dir);
            }
            Err(e) => sh.err(
                "backup",
                &format!("{e:?}").chars().take(80).collect::<String>(),
            ),
        }
    }
    out
}

fn pct(sorted: &[u64], p: f64) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    // nearest-rank
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    sorted[rank.clamp(1, sorted.len()) - 1]
}

fn summarize(mut v: Vec<u64>) -> Value {
    v.sort_unstable();
    let ms = |us: u64| us as f64 / 1000.0;
    json!({
        "samples": v.len(),
        "p50Ms": ms(pct(&v, 50.0)),
        "p95Ms": ms(pct(&v, 95.0)),
        "p99Ms": ms(pct(&v, 99.0)),
        "maxMs": ms(v.last().copied().unwrap_or(0)),
    })
}

struct RunArgs {
    cache_kib: u32,
    gap_ms: u64,
    wal_mib: u64,
    restart_wait_ms: u64,
    secs: u64,
    profile: String,
    backup: bool,
}

impl RunArgs {
    fn parse(kv: &[String]) -> Result<RunArgs, String> {
        let d = Config::default();
        let mut a = RunArgs {
            cache_kib: d.cache_kib,
            gap_ms: d.checkpoint_gap.as_millis() as u64,
            wal_mib: d.wal_soft_limit >> 20,
            restart_wait_ms: d.wal_restart_wait.as_millis() as u64,
            secs: 60,
            profile: "stress".into(),
            backup: true,
        };
        for arg in kv {
            let (k, v) = arg
                .split_once('=')
                .ok_or(format!("expected key=value: {arg}"))?;
            let n = || v.parse::<u64>().map_err(|e| format!("{k}: {e}"));
            match k {
                "cache" => a.cache_kib = n()? as u32,
                "gap" => a.gap_ms = n()?,
                "wal" => a.wal_mib = n()?,
                "rwait" => a.restart_wait_ms = n()?,
                "secs" => a.secs = n()?,
                "profile" if v == "stress" || v == "agent" => a.profile = v.into(),
                "backup" => a.backup = n()? != 0,
                _ => return Err(format!("unknown argument {arg}")),
            }
        }
        Ok(a)
    }
}

fn run(seed_dir: &Path, run: &Path, a: &RunArgs) -> Result<(), String> {
    let &RunArgs {
        cache_kib,
        gap_ms,
        wal_mib,
        restart_wait_ms,
        secs,
        ..
    } = a;
    let think = if a.profile == "agent" {
        Think::AGENT
    } else {
        Think::STRESS
    };
    let _ = fs::remove_dir_all(run);
    s(fs::create_dir_all(run.join("tmp")))?;
    s(fs::copy(
        seed_dir.join("atm.sqlite"),
        run.join("atm.sqlite"),
    ))?;
    // SQLite 的临时文件（排序、VACUUM INTO 的中间结果）落到运行目录，好量峰值，也不往 %TEMP% 堆。
    // SAFETY: 此时还没有起任何线程。
    unsafe {
        std::env::set_var("TMP", run.join("tmp"));
        std::env::set_var("TEMP", run.join("tmp"));
    }
    let t0 = Instant::now();
    let before_open = sample(t0, run);
    let store = s(Store::open(
        &run.join("atm.sqlite"),
        Config {
            cache_kib,
            checkpoint_gap: Duration::from_millis(gap_ms),
            wal_soft_limit: wal_mib << 20,
            wal_restart_wait: Duration::from_millis(restart_wait_ms),
            idle_checkpoint: IDLE_CHECKPOINT,
            ..Config::default()
        },
    ))?;
    let after_open = sample(t0, run);
    let sh = Arc::new(Shared {
        store,
        stop: AtomicBool::new(false),
        t0,
        errors: Mutex::new(BTreeMap::new()),
        backups: Mutex::new(Vec::new()),
        run: run.to_path_buf(),
        think,
    });

    let samples = Arc::new(Mutex::new(Vec::<Sample>::new()));
    let sampler_stop = Arc::new(AtomicBool::new(false));
    let sampler = {
        let (samples, stop, run) = (samples.clone(), sampler_stop.clone(), run.to_path_buf());
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                let s = sample(t0, &run);
                samples.lock().unwrap().push(s);
                std::thread::sleep(SAMPLE_EVERY);
            }
        })
    };

    let load_start = sh.now_ms();
    let mut workers = Vec::new();
    for seat in 0..WRITERS {
        let sh = sh.clone();
        workers.push(std::thread::spawn(move || writer(sh, seat)));
    }
    for seat in 0..SEARCHERS {
        let sh = sh.clone();
        workers.push(std::thread::spawn(move || searcher(sh, seat)));
    }
    let mut clients: Vec<fn(Arc<Shared>) -> Vec<Lat>> = vec![overview, export];
    if a.backup {
        clients.push(backup);
    }
    for f in clients {
        let sh = sh.clone();
        workers.push(std::thread::spawn(move || f(sh)));
    }
    std::thread::sleep(Duration::from_secs(secs));
    sh.stop.store(true, Ordering::Relaxed);
    let lats: Vec<Lat> = workers
        .into_iter()
        .flat_map(|h| h.join().unwrap())
        .collect();
    let load_end = sh.now_ms();
    let after_load = sample(t0, run);
    // 等写线程空闲满 IDLE_CHECKPOINT 做 TRUNCATE，再多等一会儿。
    std::thread::sleep(IDLE_CHECKPOINT + Duration::from_secs(3));
    let idle = sample(t0, run);
    let stats = sh.store.stats();
    let stats_json = json!({
        "admitted": Stats::get(&stats.admitted),
        "busy": Stats::get(&stats.busy),
        "queueHighWater": Stats::get(&stats.queue_high_water),
        "commits": Stats::get(&stats.commits),
        "rollbacks": Stats::get(&stats.rollbacks),
        "overBudget": Stats::get(&stats.over_budget),
        "passiveCheckpoints": Stats::get(&stats.passive_checkpoints),
        "truncateCheckpoints": Stats::get(&stats.truncate_checkpoints),
        "truncateBusy": Stats::get(&stats.truncate_busy),
        "passiveMaxMs": Stats::get(&stats.passive_max_us) as f64 / 1000.0,
        "passiveTotalMs": Stats::get(&stats.passive_total_us) as f64 / 1000.0,
        "jobMaxMs": Stats::get(&stats.job_max_us) as f64 / 1000.0,
        "restartCheckpoints": Stats::get(&stats.restart_checkpoints),
        "restartBusy": Stats::get(&stats.restart_busy),
        "restartMaxMs": Stats::get(&stats.restart_max_us) as f64 / 1000.0,
        "reads": Stats::get(&stats.reads),
        "readInterrupts": Stats::get(&stats.read_interrupts),
    });
    sh.store.shutdown();
    sampler_stop.store(true, Ordering::Relaxed);
    sampler.join().unwrap();
    let closed = {
        let sh = Arc::try_unwrap(sh).map_err(|_| "store still shared".to_string())?;
        let errors = sh.errors.into_inner().unwrap();
        let windows = sh.backups.into_inner().unwrap();
        drop(sh.store);
        (sample(t0, run), errors, windows)
    };
    let (closed, errors, windows) = closed;

    let mut by_kind: BTreeMap<&str, Vec<u64>> = BTreeMap::new();
    let mut writes_all = Vec::new();
    let mut writes_in_backup = Vec::new();
    for &(kind, start, us) in &lats {
        by_kind.entry(kind).or_default().push(us);
        if kind.starts_with("write.") {
            writes_all.push(us);
            if windows.iter().any(|&(a, b)| start >= a && start <= b) {
                writes_in_backup.push(us);
            }
        }
    }
    let mut slowest: Vec<Lat> = lats.clone();
    slowest.sort_unstable_by_key(|l| std::cmp::Reverse(l.2));
    slowest.truncate(10);
    let samples = samples.lock().unwrap().clone();
    let load: Vec<&Sample> = samples
        .iter()
        .filter(|s| s.t_ms >= load_start && s.t_ms <= load_end)
        .collect();
    let peak = |f: fn(&Sample) -> u64| samples.iter().map(f).max().unwrap_or(0);
    let mut load_private: Vec<u64> = load.iter().map(|s| s.private).collect();
    load_private.sort_unstable();
    let secs_f = (load_end - load_start) as f64 / 1000.0;
    let result = json!({
        "profile": a.profile,
        "backups": a.backup,
        "cacheKib": cache_kib,
        "checkpointGapMs": gap_ms,
        "walSoftLimitMib": wal_mib,
        "restartWaitMs": restart_wait_ms,
        "loadSeconds": secs_f,
        "threads": { "writers": WRITERS, "searchers": SEARCHERS, "overview": 1, "export": 1, "backup": 1 },
        "throughput": {
            "writesPerSec": writes_all.len() as f64 / secs_f,
        },
        "latency": by_kind.into_iter().map(|(k, v)| (k.to_string(), summarize(v))).collect::<serde_json::Map<_, _>>(),
        "writesAll": summarize(writes_all),
        "writesDuringBackup": summarize(writes_in_backup),
        "backupWindowsMs": windows,
        "slowest": slowest.iter().map(|(k, start, us)| json!({ "kind": k, "startMs": start, "ms": *us as f64 / 1000.0 })).collect::<Vec<_>>(),
        "errors": errors,
        "store": stats_json,
        "peaks": {
            "walBytes": peak(|s| s.wal),
            "tmpBytes": peak(|s| s.tmp),
            "backupsBytes": peak(|s| s.backups),
            "privateBytes": peak(|s| s.private),
            "workingSetBytes": peak(|s| s.working_set),
            "sqliteHeapBytes": peak(|s| s.sqlite_heap),
            "sqliteHeapHighWater": sqlite_heap().1,
        },
        "privateDuringLoad": { "samples": load_private.len(), "p50": pct(&load_private, 50.0), "p95": pct(&load_private, 95.0) },
        "points": {
            "beforeOpen": sample_json(&before_open),
            "afterOpen": sample_json(&after_open),
            "afterLoad": sample_json(&after_load),
            "idleAfterTruncate": sample_json(&idle),
            "afterClose": sample_json(&closed),
        },
        "sampleCount": samples.len(),
        "sampleEveryMs": SAMPLE_EVERY.as_millis() as u64,
    });
    let text = serde_json::to_string_pretty(&result).unwrap();
    s(fs::write(run.join("result.json"), &text))?;
    println!("{text}");
    Ok(())
}

/// 写放大：每种写入单独跑 N 个事务，看 WAL 涨了多少帧（页）。
fn amplify(seed_dir: &Path, run: &Path) -> Result<(), String> {
    let _ = fs::remove_dir_all(run);
    s(fs::create_dir_all(run))?;
    s(fs::copy(
        seed_dir.join("atm.sqlite"),
        run.join("atm.sqlite"),
    ))?;
    let mut conn = s(atm_store::open(&run.join("atm.sqlite")))?;
    s(conn.pragma_update(None, "wal_autocheckpoint", 0))?;
    const N: usize = 200;
    let mut rng = Rng(0xA3F);
    let mut out = serde_json::Map::new();
    type Op = fn(&Transaction<'_>, usize, &mut Rng) -> Result<(), String>;
    let ops: [(&str, Op); 8] = [
        ("work_item_row", |tx, i, _| {
            s(tx.execute(
                "INSERT INTO work_items (project_id, id, local_no, objective_id, type, title, status, priority, created_at, updated_at)
                 VALUES ('P001', ?1, ?2, 'OBJ', 'TASK', 't', 'READY', 'NORMAL', ?3, ?3)",
                params![format!("AMP-{i}"), 100_000 + i as i64, AT],
            ))
            .map(|_| ())
        }),
        ("search_doc_insert", |tx, i, rng| {
            s(upsert_doc(
                tx,
                &Doc {
                    project_id: "P001",
                    entity_type: "RECORD",
                    entity_id: &format!("amp-{i}"),
                    entity_key: &format!("AMP-{i}"),
                    title: "负载",
                    body: &rng.sentence(200),
                    updated_at: AT,
                },
            ))
        }),
        ("search_doc_update", |tx, i, rng| {
            s(upsert_doc(
                tx,
                &Doc {
                    project_id: "PFM",
                    entity_type: "WORK_ITEM",
                    entity_id: &format!("PFM-W{}", 1 + i * 37 % PRIMARY_WORK),
                    entity_key: "K",
                    title: "负载",
                    body: &rng.sentence(200),
                    updated_at: AT,
                },
            ))
        }),
        ("event_with_mirror", |tx, i, rng| {
            event(
                tx,
                "P001",
                "work.progress",
                "S-P001",
                "P001-W1",
                &format!("amp-ev-{i}"),
                &payload(&rng.sentence(200)),
                AT,
            )
        }),
        ("receipt", |tx, i, rng| {
            receipt(
                tx,
                "P001",
                "S-P001",
                &format!("amp-rc-{i}"),
                "progress.add",
                &payload(&rng.sentence(200)),
                AT,
            )
        }),
        ("progress_row", |tx, i, rng| {
            s(tx.execute(
                "INSERT INTO progress_updates (project_id, id, work_item_id, percent, summary, summary_hash, actor, created_at)
                 VALUES ('P001', ?1, 'P001-W1', 50, ?2, 'h', 'claude', ?3)",
                params![format!("amp-pg-{i}"), rng.sentence(200), AT],
            ))
            .map(|_| ())
        }),
        ("work_item_update", |tx, i, _| {
            s(tx.execute(
                "UPDATE work_items SET status = 'IN_PROGRESS', phase = 'IN_PROGRESS', version = version + 1, updated_at = ?2 WHERE project_id = 'PFM' AND id = ?1",
                params![format!("PFM-W{}", 1 + i * 53 % PRIMARY_WORK), AT],
            ))
            .map(|_| ())
        }),
        ("empty_commit", |_, _, _| Ok(())),
    ];
    for (name, op) in ops {
        s(conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(())))?;
        for i in 0..N {
            let tx = s(conn.transaction())?;
            // 空事务不写 WAL；用一行 app_meta 更新当作基线。
            s(tx.execute("UPDATE app_meta SET updated_at = updated_at", []))?;
            op(&tx, i, &mut rng)?;
            s(tx.commit())?;
        }
        let frames: i64 = s(conn.query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |r| r.get(1)))?;
        out.insert(name.to_string(), json!(frames as f64 / N as f64));
    }
    let text = serde_json::to_string_pretty(&Value::Object(out)).unwrap();
    s(fs::write(run.join("amplify.json"), &text))?;
    println!("{text}");
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let r = match args.get(1).map(String::as_str) {
        Some("seed") if args.len() == 3 => seed(Path::new(&args[2])),
        Some("amplify") if args.len() == 4 => amplify(Path::new(&args[2]), Path::new(&args[3])),
        Some("run") if args.len() >= 4 => RunArgs::parse(&args[4..])
            .and_then(|a| run(Path::new(&args[2]), Path::new(&args[3]), &a)),
        _ => Err(
            "usage: load_bench seed <dir> | amplify <seed-dir> <run-dir> | run <seed-dir> <run-dir> [cache=KiB] [gap=ms] [wal=MiB] [rwait=ms] [secs=N] [profile=stress|agent] [backup=1|0]"
                .into(),
        ),
    };
    if let Err(e) = r {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
