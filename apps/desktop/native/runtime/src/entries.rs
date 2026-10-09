//! 发布 Agent 入口（07 §2 第 3 条之后、§6 判定放行之后）：lease 记录 → HTTP → daemon.json → 见证 → 调度器。
//! 撤下（后台比较发现数据源冲突，07 §6 末行）按相反的顺序：先停调度器与 HTTP，再撤 daemon.json，
//! 之后才由调用方写启动状态；撤下之后不会再有任何业务写入。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use atm_http::agent::Surface;
use atm_http::mcp::routes;
use atm_http::tools::PROFILES;
use atm_http::{AppState, Calls, Token, app, bind, serve};
use atm_install_state::durable;
use atm_service::write::Service;
use atm_store::conversion::Layout;
use atm_store::{Config, Store};
use serde_json::{Value, json};

use crate::{Event, Handoff, Me};

pub const DESCRIPTOR: &str = "daemon.json";
pub const LEASE: &str = "daemon.lock";

pub struct Publish<'a> {
    pub layout: &'a Layout,
    pub version: &'a str,
    /// 发布物的 generation（`M.generation`），给 `/api/v1/system/status`。
    pub generation: &'a str,
    pub handoff: Option<&'a Handoff>,
    pub me: &'a Me,
    pub sweep_every: Duration,
    pub observe: &'a (dyn Fn(Event) + Send + Sync),
}

/// 开着的入口。丢弃时与 [`Entries::withdraw`] 一样撤下（只是不报 `Withdrawn`）：发布到一半出错或 panic
/// 时，已经开起来的 HTTP 与写下的 daemon.json 不会留给下一个实例（W4i peer r2 补查）。
pub struct Entries {
    /// 已经撤下：`withdraw` 之后的丢弃什么也不做。
    closed: bool,
    rt: tokio::runtime::Runtime,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    server: Option<tokio::task::JoinHandle<std::io::Result<()>>>,
    scheduler: Option<atm_jobs::Scheduler>,
    runtime_dir: PathBuf,
    instance_id: String,
    lease_generation: u64,
    port: u16,
    svc: Arc<Service>,
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    durable::write_atomic(path, value.to_string().as_bytes())
        .map_err(|e| format!("write {}: {e}", path.display()))
}

/// 这一次 lease 的序号：上一次记录的加一。setup 核对 lease、daemon.json、见证与 `/health` 是同一个。
fn next_lease_generation(runtime_dir: &Path) -> u64 {
    let previous: Option<Value> =
        atm_install_state::read_json_limited(&runtime_dir.join(LEASE), 64 * 1024)
            .ok()
            .flatten();
    previous
        .as_ref()
        .and_then(|v| v.get("generation"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .saturating_add(1)
}

pub fn publish(p: &Publish<'_>) -> Result<Entries, String> {
    let runtime_dir = p.layout.runtime();
    std::fs::create_dir_all(&runtime_dir).map_err(|e| e.to_string())?;
    let store = Store::open(&p.layout.database(), Config::default())
        .map_err(|e| format!("open {}: {e}", p.layout.database().display()))?;
    let svc = Arc::new(
        Service::new(store)
            .with_backups_root(p.layout.root.join("backups"))
            .with_liveness(Arc::new(atm_jobs::liveness::alive)),
    );
    let token = crate::rng::hex(32);
    let instance_id = crate::rng::hex(16);
    let lease_generation = next_lease_generation(&runtime_dir);

    // 1. lease 记录：持有 `service.lock` 的就是本进程（单进程布局，没有 core 子进程）。
    write_json(
        &runtime_dir.join(LEASE),
        &json!({
            "pid": p.me.pid,
            "processIdentity": {"createdAtTicks": p.me.created_ticks.to_string()},
            "layout": "single",
            "nonce": instance_id,
            "generation": lease_generation,
        }),
    )?;
    (p.observe)(Event::Lease);

    // 2. HTTP。
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("atm-http")
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    let surface = Surface::new(svc.clone());
    let (pid, version, generation) = (p.me.pid, p.version.to_string(), p.generation.to_string());
    // 不要令牌的 `/health` 只答 setup 交叉核对用的三项：pid、实例 id、lease 序号（peer W4 r1 P2-01）。
    // 版本与别的运行状态在要令牌的 `/api/v1/system/status`。
    let health = {
        let instance_id = instance_id.clone();
        move || {
            json!({
                "pid": pid,
                "instanceId": instance_id,
                "generation": lease_generation,
            })
        }
    };
    let status: atm_http::rest::RuntimeStatus = Arc::new(move || {
        json!({
            "version": version,
            "impl": "rust",
            "conversion": {"phase": "PUBLISHED", "generation": generation},
        })
    });
    let token = Token::new(token.clone()).map(|t| (t, token))?;
    let (listener, port) = rt
        .block_on(async {
            let listener = bind().await?;
            let port = listener.local_addr()?.port();
            Ok::<_, std::io::Error>((listener, port))
        })
        .map_err(|e| format!("bind 127.0.0.1: {e}"))?;
    let state = AppState::new(
        &listener,
        token.0,
        Calls::new(8, Duration::from_secs(5)),
        health,
    )
    .map_err(|e| e.to_string())?;
    let router = app(
        state,
        routes(&PROFILES, surface.handler())
            .merge(surface.resolve_routes())
            .merge(surface.rest_routes(surface.handler(), status)),
    );
    let (shutdown, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = rt.spawn(serve(listener, router, async move {
        let _ = stopped.await;
    }));
    // 从这里起入口归 `entries` 管：后面任何一步出错（`?`）或 panic，丢弃它就撤下 HTTP 与 daemon.json。
    let mut entries = Entries {
        closed: false,
        rt,
        shutdown: Some(shutdown),
        server: Some(server),
        scheduler: None,
        runtime_dir,
        instance_id,
        lease_generation,
        port,
        svc,
    };
    (p.observe)(Event::Http);

    // 3. daemon.json：atm-mcp 桥从这里找到端口与令牌。
    write_json(
        &entries.runtime_dir.join(DESCRIPTOR),
        &json!({
            "endpoint": format!("http://127.0.0.1:{port}"),
            "token": token.1,
            "pid": p.me.pid,
            "instanceId": entries.instance_id,
            "version": p.version,
            "startedAt": atm_install_state::startup::iso_utc(p.me.started_at_ms),
            "layout": "single",
            "generation": lease_generation,
        }),
    )?;
    (p.observe)(Event::Descriptor);

    // 4. 见证（setup 拉起时）：SERVICE_HEALTHY 只认它与 lease、daemon.json、`/health` 的交叉核对。
    if let Some(h) = p.handoff {
        let dir = h
            .install_root
            .join(atm_install_state::STATE_DIR)
            .join("health");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        write_json(
            &dir.join(format!("service-{}.json", h.txn)),
            &json!({
                "txnId": h.txn,
                "version": p.version,
                "host": {"pid": p.me.pid, "startedAtMs": p.me.started_at_ms, "runId": entries.instance_id},
                "core": {"pid": p.me.pid, "startedAtMs": p.me.started_at_ms, "instanceId": entries.instance_id},
                "layout": "single",
                "generation": lease_generation,
            }),
        )?;
        (p.observe)(Event::Witness);
    }

    // 5. 调度器。
    entries.scheduler = Some(atm_jobs::Scheduler::start(
        entries.svc.clone(),
        p.sweep_every,
    ));
    (p.observe)(Event::Scheduler);

    Ok(entries)
}

impl Entries {
    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }

    pub fn lease_generation(&self) -> u64 {
        self.lease_generation
    }

    pub fn service(&self) -> &Arc<Service> {
        &self.svc
    }

    /// 撤下全部入口：停调度器（等当前一轮结束）→ 停 HTTP（等进行中的请求结束）→ 撤 daemon.json。
    /// lease 记录留着：进程还活着、还持有准入，setup 要能找到它。
    pub fn withdraw(mut self, observe: &(dyn Fn(Event) + Send + Sync)) {
        self.close();
        observe(Event::Withdrawn);
    }

    fn close(&mut self) {
        if std::mem::replace(&mut self.closed, true) {
            return;
        }
        if let Some(s) = self.scheduler.take() {
            s.stop();
        }
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(server) = self.server.take() {
            let _ = self
                .rt
                .block_on(async { tokio::time::timeout(Duration::from_secs(30), server).await });
        }
        let descriptor = self.runtime_dir.join(DESCRIPTOR);
        let ours = atm_install_state::read_json_limited::<Value>(&descriptor, 64 * 1024)
            .ok()
            .flatten()
            .and_then(|v| {
                v.get("instanceId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .is_some_and(|id| id == self.instance_id);
        if ours {
            let _ = std::fs::remove_file(&descriptor);
        }
    }
}

impl Drop for Entries {
    fn drop(&mut self) {
        self.close();
    }
}
