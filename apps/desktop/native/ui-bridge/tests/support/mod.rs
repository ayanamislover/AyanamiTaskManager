//! ui-bridge 用例的夹具：一个空库（只有 `app_meta`），经界面 API 自己建项目、目标、任务。
#![allow(dead_code)]

use atm_domain::principal::{Principal, UiSurface};
use atm_service::write::Service;
use atm_store::{Config, Store};
use atm_ui_bridge::{Reply, Request, Ui};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

pub const T0: &str = "2026-10-05T00:00:00.000Z";
pub const STARTED: &str = "2026-10-05T00:00:00.000Z";

pub struct World {
    pub ui: Ui,
    pub svc: Arc<Service>,
    pub dir: PathBuf,
}

pub fn test_root() -> PathBuf {
    std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("target")
        })
        .join("ui-bridge-tests")
}

pub fn world(name: &str) -> World {
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
    store
        .write(|tx| {
            tx.execute(
                "INSERT INTO app_meta (singleton, schema_version, data_root_id, generation, instance_epoch, created_at, updated_at)
                 VALUES (1, 1, 'ROOT', 'G', 'EPOCH-1', ?1, ?1)",
                [T0],
            )
        })
        .unwrap();
    let svc = Arc::new(
        Service::new(store)
            .with_backups_root(dir.join("backups"))
            .with_exchange(atm_service::exchange::ExchangeConfig {
                exports: dir.join("exports"),
                legacy_exports: Some(dir.join("L").join("exports")),
                app_version: "3.0.0-test".into(),
            }),
    );
    let runtime: atm_ui_bridge::RuntimeStatus =
        Arc::new(|| json!({ "version": "3.0.0-test", "conversion": { "phase": "PUBLISHED" } }));
    World {
        ui: Ui::new(svc.clone(), runtime, STARTED),
        svc,
        dir,
    }
}

pub fn user() -> Principal {
    Principal::trusted_ui(UiSurface::Tray)
}

pub fn agent() -> Principal {
    Principal::authenticated_agent(None)
}

impl World {
    pub fn call_as(&self, p: &Principal, method: &str, target: &str, body: Option<Value>) -> Reply {
        let bytes = body.map(|b| serde_json::to_vec(&b).unwrap());
        self.ui.dispatch(
            p,
            Request {
                method,
                target,
                body: bytes.as_deref(),
            },
        )
    }

    pub fn call(&self, method: &str, target: &str, body: Option<Value>) -> Reply {
        self.call_as(&user(), method, target, body)
    }

    /// 成功的调用：状态码对得上，返回 body。
    pub fn ok(&self, method: &str, target: &str, body: Option<Value>, status: u16) -> Value {
        let r = self.call(method, target, body);
        assert_eq!(r.status, status, "{method} {target}: {}", r.body);
        r.body
    }

    pub fn get(&self, target: &str) -> Value {
        self.ok("GET", target, None, 200)
    }

    /// 建一个项目（界面的 POST /projects），返回项目代码。
    pub fn project(&self, name: &str, code: &str) -> String {
        let v = self.ok(
            "POST",
            "/api/v1/projects",
            Some(json!({ "name": name, "code": code, "sourcePath": null, "description": "说明", "coordinationMode": "SOLO" })),
            201,
        );
        v["code"].as_str().unwrap().to_owned()
    }

    /// 建一个目标，返回 id。
    pub fn objective(&self, code: &str, title: &str) -> String {
        let v = self.ok(
            "POST",
            &format!("/api/v1/projects/{code}/ui/objectives"),
            Some(json!({ "opId": format!("obj-{title}"), "title": title, "description": "", "definitionOfDone": [] })),
            201,
        );
        v["id"].as_str().unwrap().to_owned()
    }

    /// 建一个任务（界面的 POST ui/work-items），返回 key。
    pub fn task(&self, code: &str, objective: &str, title: &str) -> String {
        let v = self.ok(
            "POST",
            &format!("/api/v1/projects/{code}/ui/work-items"),
            Some(json!({
                "opId": format!("task-{title}"),
                "items": [{
                    "clientRef": "a", "objectiveId": objective, "title": title, "description": "描述",
                    "type": "TASK", "priority": "NORMAL", "status": "READY", "acceptance": ["做完"],
                    "checklist": [{ "title": "检查一", "evidenceRequired": false }], "dependsOn": [], "dependsOnRefs": [],
                    "weight": 1, "verificationRequired": false
                }]
            })),
            201,
        );
        let key = v["items"][0]["key"]
            .as_str()
            .or_else(|| v["result"]["items"][0]["key"].as_str())
            .or_else(|| v["created"][0]["key"].as_str())
            .unwrap_or_else(|| panic!("no task key in {v}"));
        key.to_owned()
    }
}

/// 对象的键集合（排好序）。
pub fn keys(v: &Value) -> Vec<String> {
    let mut k: Vec<String> = v
        .as_object()
        .unwrap_or_else(|| panic!("not an object: {v}"))
        .keys()
        .cloned()
        .collect();
    k.sort();
    k
}

/// 断言键集合恰好是这些（2.0 的形状）。
pub fn shape(v: &Value, expected: &[&str]) {
    let mut e: Vec<String> = expected.iter().map(|s| (*s).to_owned()).collect();
    e.sort();
    assert_eq!(keys(v), e, "shape of {v}");
}

/// 2.0 的错误信封。
pub fn error(r: &Reply, status: u16, code: &str) {
    assert_eq!(r.status, status, "{}", r.body);
    assert_eq!(r.body["error"]["code"], code, "{}", r.body);
    assert!(r.body["error"]["message"].is_string(), "{}", r.body);
    assert!(r.body["error"]["retryable"].is_boolean(), "{}", r.body);
    assert!(r.body["request_id"].is_string(), "{}", r.body);
}
