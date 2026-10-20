//! 派单用例的夹具（2.x `packages/agent-dispatch/test/support.ts`）：真实的服务（空库加一个项目）、项目的工作目录、
//! 当作 claude 真的拉起的 `atm-fake-claude.exe`。目录都在 `CARGO_TARGET_DIR`（没设就是工作区的 target）下。
#![allow(dead_code)]

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use atm_dispatch::dispatcher::{Dispatcher, Enqueue, Options};
use atm_dispatch::probe::{ProbeOutput, ProcessRunner, Runner};
use atm_dispatch::process::{Child, Held, Hold, KillResult, Native, Probe, SpawnRequest, Spawner};
use atm_domain::principal::{JobId, Principal, UiSurface};
use atm_service::write::Service;
use atm_store::{Config, Store};
use atm_sync::host::Log;
use rusqlite::{Connection, params};
use serde_json::{Value, json};

pub const T0: &str = "2026-10-01T00:00:00.000Z";
pub const FAKE_CLAUDE: &str = env!("CARGO_BIN_EXE_atm-fake-claude");

pub fn test_root() -> PathBuf {
    std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("target")
        })
        .join("dispatch-tests")
}

pub fn user() -> Principal {
    Principal::trusted_ui(UiSurface::WebView {
        generation: 1,
        epoch: 1,
    })
}

pub fn agent() -> Principal {
    Principal::authenticated_agent(None)
}

pub fn phone(command: &str) -> Principal {
    Principal::verified_phone("space".into(), "m-0123456789ab".into(), command.into())
}

/// 记日志的替身：消息按级别收集。
#[derive(Default)]
pub struct Logs(pub Mutex<Vec<(String, String, Value)>>);

impl Log for Logs {
    fn info(&self, m: &str, v: &Value) {
        self.0
            .lock()
            .unwrap()
            .push(("info".into(), m.into(), v.clone()));
    }
    fn warn(&self, m: &str, v: &Value) {
        self.0
            .lock()
            .unwrap()
            .push(("warn".into(), m.into(), v.clone()));
    }
    fn error(&self, m: &str, v: &Value) {
        self.0
            .lock()
            .unwrap()
            .push(("error".into(), m.into(), v.clone()));
    }
}

impl Logs {
    pub fn has(&self, message: &str) -> bool {
        self.0.lock().unwrap().iter().any(|(_, m, _)| m == message)
    }
}

/// 数次数的拉起：真的拉起，同时记下每次的命令行与工作目录。
#[derive(Default)]
pub struct Counting {
    pub spawns: AtomicUsize,
    pub lines: Mutex<Vec<String>>,
    /// 下一次拉起直接报这个错（模拟 CreateProcess 失败）。
    pub fail_next: Mutex<Option<String>>,
}

impl Spawner for Counting {
    fn spawn(&self, r: &SpawnRequest<'_>) -> std::io::Result<Box<dyn Child>> {
        if let Some(message) = self.fail_next.lock().unwrap().take() {
            return Err(std::io::Error::other(message));
        }
        self.spawns.fetch_add(1, Ordering::SeqCst);
        self.lines.lock().unwrap().push(r.command.command_line());
        Native.spawn(r)
    }
}

/// 进程探针：默认走真实系统；可以改写某个 PID 的出生标识、让结束失败。
#[derive(Default)]
pub struct Probing {
    pub identity_override: Mutex<Option<(u32, Option<String>)>>,
    pub kill_fails: Mutex<Option<String>>,
    pub kills: Mutex<Vec<u32>>,
}

impl Probe for Probing {
    fn is_alive(&self, pid: u32) -> bool {
        Native.is_alive(pid)
    }
    fn identity(&self, pid: u32) -> Option<String> {
        if let Some((p, id)) = self.identity_override.lock().unwrap().clone()
            && p == pid
        {
            return id;
        }
        Native.identity(pid)
    }
    fn kill_tree(&self, pid: u32) -> KillResult {
        self.kills.lock().unwrap().push(pid);
        if let Some(reason) = self.kill_fails.lock().unwrap().clone() {
            return KillResult::Failed(reason);
        }
        Native.kill_tree(pid)
    }
    fn hold(&self, pid: u32) -> Hold<'_> {
        static NATIVE: Native = Native;
        let over = self
            .identity_override
            .lock()
            .unwrap()
            .clone()
            .filter(|(p, _)| *p == pid)
            .map(|(_, id)| id);
        match NATIVE.hold(pid) {
            Hold::Held(inner) => Hold::Held(Box::new(Overridden { inner, over })),
            other => other,
        }
    }
}

/// 真实持有的进程，出生标识按 `identity_override` 改写。
struct Overridden {
    inner: Box<dyn Held>,
    over: Option<Option<String>>,
}

impl Held for Overridden {
    fn alive(&self) -> bool {
        self.inner.alive()
    }
    fn identity(&self) -> Option<String> {
        match &self.over {
            Some(id) => id.clone(),
            None => self.inner.identity(),
        }
    }
}

/// 数 `auth status` 的探测，其余照真的跑。
pub struct CountingRunner {
    pub inner: ProcessRunner,
    pub calls: AtomicUsize,
}

impl Runner for CountingRunner {
    fn run(&self, c: &Path, a: &[String], e: &[(OsString, OsString)], t: Duration) -> ProbeOutput {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.inner.run(c, a, e, t)
    }
}

pub struct World {
    pub dir: PathBuf,
    pub db: PathBuf,
    pub service: Arc<Service>,
    /// 项目 ATM 的工作目录（假 claude 在这里读行为、写 dump）。
    pub work: PathBuf,
    pub logs: PathBuf,
    pub spawner: Arc<Counting>,
    pub probe: Arc<Probing>,
    pub log: Arc<Logs>,
    pub claude: Arc<Mutex<Option<PathBuf>>>,
    /// 这个世界里的假 claude（`FAKE_CLAUDE` 的副本）。
    pub fake: PathBuf,
    pub auth_file: PathBuf,
}

pub fn world(name: &str) -> World {
    let dir = test_root().join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("atm.sqlite");
    let store = Store::open(
        &db,
        Config {
            idle_checkpoint: Duration::from_secs(3600),
            ..Config::default()
        },
    )
    .unwrap();
    let work = dir.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let work_text = work.to_string_lossy().into_owned();
    store
        .write(move |tx| {
            tx.execute(
                "INSERT INTO app_meta (singleton, schema_version, data_root_id, generation, instance_epoch, scope_gen_counter, created_at, updated_at)
                 VALUES (1, 1, 'ROOT', 'G', 'EPOCH-1', 2, ?1, ?1)",
                [T0],
            )?;
            for (n, (id, code)) in [("P1", "ATM"), ("P2", "OTHER")].iter().enumerate() {
                let epoch = format!("E{id}");
                tx.execute(
                    "INSERT INTO scope_generations (gen, scope_kind, scope_id, reason, epoch, created_at) VALUES (?1, 'PROJECT', ?2, 'CREATED', ?3, ?4)",
                    params![n as i64 + 1, id, epoch, T0],
                )?;
                tx.execute(
                    "INSERT INTO projects (id, code, name, lifecycle, health, meta_version, scope_gen, epoch, created_at, updated_at)
                     VALUES (?1, ?2, ?3, 'ACTIVE', 'ON_TRACK', 0, ?4, ?5, ?6, ?6)",
                    params![id, code, format!("项目 {code}"), n as i64 + 1, epoch, T0],
                )?;
                tx.execute(
                    "INSERT INTO objectives (project_id, id, local_no, title, status, created_at, updated_at) VALUES (?1, ?2, 1, ?3, 'ACTIVE', ?4, ?4)",
                    params![id, format!("O-{id}"), format!("{code} 目标"), T0],
                )?;
                for (counter, next) in [("work_item", 1), ("blocker", 1), ("objective", 2), ("milestone", 1), ("record", 1), ("review_request", 1), ("review_submission", 1)] {
                    tx.execute(
                        "INSERT INTO counters (project_id, name, next_value) VALUES (?1, ?2, ?3)",
                        params![id, counter, next],
                    )?;
                }
            }
            tx.execute(
                "INSERT INTO project_paths (id, project_id, path_key, canonical_path, git_common_dir, is_primary, last_seen_at)
                 VALUES ('PP1', 'P1', ?1, ?2, NULL, 1, ?3)",
                params![work_text.to_lowercase(), work_text, T0],
            )?;
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    let auth_file = dir.join("auth.json");
    // 用例拉起的是这一份副本：变异里没结束干净、还睡着的假 claude 只锁住它，锁不住 cargo 要重写的那个 exe。
    let fake = dir.join(format!("claude-{}.exe", std::process::id()));
    std::fs::copy(FAKE_CLAUDE, &fake).unwrap();
    World {
        logs: dir.join("data").join("dispatch").join("logs"),
        db,
        service: Arc::new(Service::new(store)),
        work,
        dir,
        spawner: Arc::new(Counting::default()),
        probe: Arc::new(Probing::default()),
        log: Arc::new(Logs::default()),
        claude: Arc::new(Mutex::new(Some(fake.clone()))),
        fake,
        auth_file,
    }
}

impl World {
    /// 宿主环境：只给假 claude 用得上的几个，外加两个必须被剥离的宿主会话变量。
    pub fn base_env(&self) -> Vec<(OsString, OsString)> {
        let mut env: Vec<(OsString, OsString)> =
            ["SystemRoot", "SYSTEMDRIVE", "TEMP", "TMP", "PATH"]
                .iter()
                .filter_map(|k| std::env::var_os(k).map(|v| (OsString::from(k), v)))
                .collect();
        env.extend([
            ("CLAUDECODE".into(), "1".into()),
            ("claude_code_entrypoint".into(), "sdk-ts".into()),
            ("KEEP_DISPATCH_VALUE".into(), "kept".into()),
            (
                "FAKE_CLAUDE_AUTH_FILE".into(),
                self.auth_file.clone().into_os_string(),
            ),
        ]);
        env
    }

    pub fn options(&self) -> Options {
        let claude = self.claude.clone();
        Options {
            service: self.service.clone(),
            logs: self.logs.clone(),
            legacy_logs: Some(self.dir.join("legacy").join("dispatch").join("logs")),
            resolve_claude: Arc::new(move || claude.lock().unwrap().clone()),
            spawner: self.spawner.clone(),
            probe: self.probe.clone(),
            runner: Arc::new(ProcessRunner {
                comspec: None,
                probe: self.probe.clone(),
            }),
            base_env: self.base_env(),
            comspec: None,
            now: Arc::new(atm_sync::time::now_ms),
            log: self.log.clone(),
            poll: Duration::from_millis(50),
            auth_timeout: Duration::from_secs(5),
        }
    }

    pub fn dispatcher(&self) -> Dispatcher {
        self.dispatcher_with(self.options())
    }

    pub fn dispatcher_with(&self, o: Options) -> Dispatcher {
        let d = Dispatcher::new(o).unwrap();
        d.start();
        d
    }

    /// 打开派单（用户在设置页）。
    pub fn enable(&self, d: &Dispatcher, extra: Value) {
        let mut patch = json!({ "enabled": true });
        for (k, v) in extra.as_object().unwrap() {
            patch[k] = v.clone();
        }
        d.update_config(&user(), &patch).unwrap();
    }

    /// 假 claude 这一次的行为（写进工作目录的 fake-claude.json）。
    pub fn behave(&self, v: Value) {
        std::fs::write(self.work.join("fake-claude.json"), v.to_string()).unwrap();
    }

    pub fn auth(&self, mode: &str) {
        std::fs::write(&self.auth_file, json!({ "mode": mode }).to_string()).unwrap();
    }

    pub fn auth_probes(&self) -> usize {
        std::fs::read_to_string(format!("{}.count", self.auth_file.display()))
            .map(|t| t.lines().count())
            .unwrap_or(0)
    }

    pub fn seed_task(&self, code: &str, title: &str) -> String {
        let id = self.service.ui_project(&user(), code).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let target = atm_service::work::Target::new(id, None, format!("seed-{code}-{title}"));
        let objective = self.service.ui_objectives(&user(), code).unwrap()[0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let item = atm_service::work::CreateItem {
            objective_id: Some(objective),
            title: title.into(),
            ..Default::default()
        };
        let w = self
            .service
            .create_work_items(&user(), &target, vec![item])
            .unwrap();
        w.result["items"][0]["key"].as_str().unwrap().to_owned()
    }

    /// 绕过服务直接改库（模拟别的会话领取、按范围恢复撤销等）。
    pub fn sql(&self, sql: &str, args: &[&dyn rusqlite::ToSql]) {
        let c = Connection::open(&self.db).unwrap();
        c.busy_timeout(Duration::from_secs(5)).unwrap();
        c.execute(sql, args).unwrap();
    }

    pub fn sql_batch(&self, sql: &str) {
        let c = Connection::open(&self.db).unwrap();
        c.busy_timeout(Duration::from_secs(5)).unwrap();
        c.execute_batch(sql).unwrap();
    }

    pub fn count(&self, sql: &str) -> i64 {
        let c = Connection::open(&self.db).unwrap();
        c.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    pub fn dump(&self, run: &str) -> Value {
        let path = self.work.join(format!("fake-claude-dump-{run}.json"));
        wait_for(|| path.exists(), "假 claude 写出 dump");
        let mut text = String::new();
        wait_for(
            || {
                text = std::fs::read_to_string(&path).unwrap_or_default();
                serde_json::from_str::<Value>(&text).is_ok()
            },
            "dump 写完",
        );
        serde_json::from_str(&text).unwrap()
    }

    pub fn spawns(&self) -> usize {
        self.spawner.spawns.load(Ordering::SeqCst)
    }
}

pub fn desktop(key: &str) -> Enqueue {
    Enqueue {
        project: "ATM".into(),
        key: key.into(),
        mobile: false,
        requested_by: None,
        request_id: None,
    }
}

pub fn mobile(key: &str, request: &str) -> Enqueue {
    Enqueue {
        project: "ATM".into(),
        key: key.into(),
        mobile: true,
        requested_by: Some("Pixel 9".into()),
        request_id: Some(request.into()),
    }
}

/// 手机命令 ID：`m-0123456789ab.<13 位 base36 毫秒时间><8 位 hex>`。
pub fn command_id(at_ms: i64, salt: u32) -> String {
    let mut stamp = String::new();
    let mut n = at_ms as u64;
    while n > 0 {
        let d = (n % 36) as u8;
        stamp.insert(0, char::from(if d < 10 { b'0' + d } else { b'a' + d - 10 }));
        n /= 36;
    }
    format!("m-0123456789ab.{stamp:0>13}{salt:08x}")
}

pub fn wait_for(mut check: impl FnMut() -> bool, what: &str) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if check() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("等待超时：{what}");
}

/// 等某次派单进入某个状态，返回它的视图。
pub fn wait_state(d: &Dispatcher, run: &str, state: &str) -> serde_json::Map<String, Value> {
    let mut view = None;
    wait_for(
        || {
            view = d.list_runs().into_iter().find(|v| v["run"] == run);
            view.as_ref().is_some_and(|v| v["state"] == state)
        },
        &format!("{run} → {state}"),
    );
    view.unwrap()
}

pub fn tracker() -> Principal {
    Principal::system_job(JobId::DispatchTrack)
}

/// 用例结束时结束还活着的假 claude（只结束用例自己拉起的）。
pub struct Reap(pub Vec<u32>);

impl Drop for Reap {
    fn drop(&mut self) {
        for pid in &self.0 {
            if Native.is_alive(*pid) {
                let _ = Native.kill_tree(*pid);
            }
        }
    }
}
