//! 连接器用例的夹具（2.x `packages/sync/test/support/fixture.ts`）：一个真实的服务（空库加几个项目）、内存中继、
//! 快速计时的连接器，以及扮演手机的一侧。目录都在 `CARGO_TARGET_DIR`（没设就是工作区的 target）下。

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use atm_domain::principal::{Principal, UiSurface};
use atm_service::write::Service;
use atm_store::{Config, Store};
use atm_sync::connector::{Connector, ConnectorOptions, Timings};
use atm_sync::dispatch::{DispatchPort, DispatchRun, DispatchSummary, EnqueueInput};
use atm_sync::errors::Failure;
use atm_sync::secrets::{Dpapi, DpapiSecretStore};
use atm_sync::space::{DeviceRef, SpaceStore, SpaceStoreOptions};
use atm_sync::transport::{Sleeper, Transport};
use atm_sync_protocol::SpaceKeys;
use atm_sync_protocol::pairing::decode_pairing_code;
use rusqlite::params;
use serde_json::{Value, json};

use super::MemoryRelay;

pub const RELAY_URL: &str = "https://relay.example.com";
pub const T0: &str = "2026-10-01T00:00:00.000Z";

pub fn test_root() -> PathBuf {
    std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("target")
        })
        .join("sync-tests")
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

pub struct World {
    pub dir: PathBuf,
    pub service: Arc<Service>,
    pub relay: MemoryRelay,
}

/// 项目：(id, code, 有没有 ACTIVE 目标)。目标 id 是 `O-<id>`。
pub fn world(name: &str, projects: &[(&str, &str, bool)]) -> World {
    let dir = test_root().join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let store = Store::open(
        &dir.join("atm.sqlite"),
        Config {
            idle_checkpoint: Duration::from_secs(3600),
            ..Config::default()
        },
    )
    .unwrap();
    let projects: Vec<(String, String, bool)> = projects
        .iter()
        .map(|(i, c, o)| (i.to_string(), c.to_string(), *o))
        .collect();
    store
        .write(move |tx| {
            tx.execute(
                "INSERT INTO app_meta (singleton, schema_version, data_root_id, generation, instance_epoch, scope_gen_counter, created_at, updated_at)
                 VALUES (1, 1, 'ROOT', 'G', 'EPOCH-1', ?1, ?2, ?2)",
                params![projects.len() as i64, T0],
            )?;
            for (n, (id, code, objective)) in projects.iter().enumerate() {
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
                if *objective {
                    tx.execute(
                        "INSERT INTO objectives (project_id, id, local_no, title, status, created_at, updated_at) VALUES (?1, ?2, 1, ?3, 'ACTIVE', ?4, ?4)",
                        params![id, format!("O-{id}"), format!("{code} 目标"), T0],
                    )?;
                }
                for (counter, next) in [("work_item", 1), ("blocker", 1), ("objective", 2), ("milestone", 1), ("record", 1), ("review_request", 1), ("review_submission", 1)] {
                    tx.execute(
                        "INSERT INTO counters (project_id, name, next_value) VALUES (?1, ?2, ?3)",
                        params![id, counter, next],
                    )?;
                }
            }
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    World {
        dir,
        service: Arc::new(Service::new(store)),
        relay: MemoryRelay::new(false),
    }
}

/// 快速计时：去抖 5 ms、轮询 5 ms、退避与轮询的等待最多睡 5 ms。
pub fn fast() -> Timings {
    Timings {
        debounce: Duration::from_millis(5),
        max_delay: Duration::from_millis(50),
        presence: Duration::from_secs(60),
        poll_interval: Duration::from_millis(5),
        retry_publish: Duration::from_millis(20),
        stop_timeout: Duration::from_secs(1),
    }
}

pub fn quick_sleep() -> Sleeper {
    Arc::new(|d| {
        std::thread::sleep(d.min(Duration::from_millis(5)));
        true
    })
}

pub struct Opts {
    pub dispatch: Option<Arc<dyn DispatchPort>>,
    pub transport: Option<Arc<dyn Transport>>,
    pub timings: Timings,
    /// 连接器的等待（退避、轮询间隔）；默认最多睡 5 ms。
    pub sleep: Option<Sleeper>,
}

impl Default for Opts {
    fn default() -> Self {
        Opts {
            dispatch: None,
            transport: None,
            timings: fast(),
            sleep: None,
        }
    }
}

impl World {
    pub fn connector(&self) -> Connector {
        self.connector_with(Opts::default())
    }

    pub fn connector_with(&self, o: Opts) -> Connector {
        Connector::new(ConnectorOptions {
            service: self.service.clone(),
            secrets: DpapiSecretStore::open(&self.dir.join("sync"), Some(Dpapi)),
            app_version: "3.0.0-test".into(),
            dispatch: o.dispatch,
            transport: o.transport.unwrap_or_else(|| Arc::new(self.relay.clone())),
            log: None,
            now: None,
            device_name: Some("测试电脑".into()),
            timings: o.timings,
            sleep: Some(o.sleep.unwrap_or_else(quick_sleep)),
        })
        .unwrap()
    }

    /// 任务键，按 ATM 的界面顺序。
    pub fn task_keys(&self, code: &str) -> Vec<String> {
        let filter = atm_service::ui::WorkItemFilter {
            limit: Some(100),
            ..Default::default()
        };
        self.service.ui_work_items(&user(), code, &filter).unwrap()["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["key"].as_str().unwrap().to_owned())
            .collect()
    }

    pub fn task(&self, code: &str, key: &str) -> Value {
        self.service.ui_work_item(&user(), code, key).unwrap()
    }

    /// 直接在库里建一个任务（用户建的）。
    pub fn seed_task(&self, code: &str, title: &str) -> String {
        let id = self.service.ui_project(&user(), code).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let target = atm_service::work::Target::new(id, None, format!("seed-{title}"));
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
}

/// 启用 + 配置中继 + 启动 + 生成配对码，等到在线。
pub fn connect(c: &Connector, relay: &MemoryRelay) -> String {
    c.update_config(
        &user(),
        &json!({ "enabled": true, "relayUrl": RELAY_URL, "token": super::TOKEN }),
    )
    .unwrap();
    let _ = relay;
    c.start().unwrap();
    let pairing = c.create_pairing(&user()).unwrap();
    wait_for(
        || c.status(&user()).unwrap()["state"] == "online",
        "连接器上线",
    );
    pairing["pairingCode"].as_str().unwrap().to_owned()
}

pub fn wait_for(mut check: impl FnMut() -> bool, what: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if check() {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("等待超时：{what}");
}

/// 手机一侧：用配对码里的 token 与密钥读写同一个空间。
pub struct Phone {
    pub space_id: String,
    pub store: SpaceStore,
    pub device: DeviceRef,
}

pub fn phone_for(relay: &MemoryRelay, pairing: &str) -> Phone {
    let p = decode_pairing_code(pairing).unwrap();
    let client = relay.client(&p.relay_token, None);
    let store = SpaceStore::new(SpaceStoreOptions {
        client,
        keys: SpaceKeys::derive(&p.space_secret).unwrap(),
        space_id: p.space_id.clone(),
        retry_delay: Some(Duration::from_millis(1)),
        lifetime: None,
        sleep: None,
    })
    .unwrap();
    Phone {
        space_id: p.space_id,
        store,
        device: DeviceRef {
            id: "m-0123456789ab".into(),
            name: "测试手机".into(),
        },
    }
}

impl Phone {
    /// 现在发一条命令。
    pub fn send(&self, input: Value) -> String {
        self.send_at(input, atm_sync::time::now_ms())
    }

    pub fn send_at(&self, input: Value, at_ms: i64) -> String {
        let doc = self
            .store
            .send_command(
                &self.device,
                &input,
                at_ms as u64,
                &atm_sync::time::iso(at_ms),
            )
            .unwrap();
        doc["id"].as_str().unwrap().to_owned()
    }

    pub fn await_ack(&self, id: &str) -> Value {
        let mut ack = None;
        wait_for(
            || {
                ack = self.store.read_ack(id).unwrap();
                ack.is_some()
            },
            &format!("回执 {id}"),
        );
        ack.unwrap()
    }
}

/// 派单调用：入参，以及 Phone 主体的（空间、设备、命令）。
pub type DispatchCall = (EnqueueInput, Option<(String, String, String)>);

/// 记录调用的派单端口替身。
#[derive(Default)]
pub struct FakeDispatch {
    pub reject: Option<(String, String)>,
    pub calls: Mutex<Vec<DispatchCall>>,
    pub runs: Mutex<std::collections::HashMap<String, DispatchRun>>,
}

impl DispatchPort for FakeDispatch {
    fn summary(&self) -> DispatchSummary {
        DispatchSummary {
            enabled: self.reject.is_none(),
            mode: "auto".into(),
            running: 0,
        }
    }
    fn run_for_task(&self, project: &str, key: &str) -> Option<DispatchRun> {
        self.runs
            .lock()
            .unwrap()
            .get(&format!("{project}/{key}"))
            .cloned()
    }
    fn enqueue(&self, principal: &Principal, input: EnqueueInput) -> Result<DispatchRun, Failure> {
        let phone = principal
            .phone()
            .map(|(s, d, c)| (s.to_owned(), d.to_owned(), c.to_owned()));
        self.calls.lock().unwrap().push((input.clone(), phone));
        if let Some((code, message)) = &self.reject {
            return Err(Failure::Dispatch {
                code: code.clone(),
                message: message.clone(),
            });
        }
        let n = self.calls.lock().unwrap().len();
        let run = DispatchRun {
            run: format!("run-{n}"),
            state: "queued".into(),
            at: atm_sync::time::iso(atm_sync::time::now_ms()),
            error: None,
        };
        self.runs
            .lock()
            .unwrap()
            .insert(format!("{}/{}", input.project, input.key), run.clone());
        Ok(run)
    }
}

/// 中继上这个空间里键名片段（`/cmd/`、`/ack/`）的请求：方法与键。
pub fn requests_for(relay: &MemoryRelay, fragment: &str) -> Vec<(String, String)> {
    relay
        .state()
        .requests
        .iter()
        .filter_map(|r| {
            let key = r.key.clone()?;
            key.contains(fragment).then(|| (r.method.to_owned(), key))
        })
        .collect()
}
