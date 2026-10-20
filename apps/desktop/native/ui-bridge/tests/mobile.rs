//! W7e：设置页的手机同步与 Claude 派单（#88–96，06 §2.6；2.x `apps/daemon/src/{dispatch,sync}-routes.ts`、
//! `apps/desktop/src/core-mobile.ts`）。
//!
//! - 宿主没有启用：404 `*_UNAVAILABLE`，界面安静地显示「不可用」；
//! - 还在启动：先等，等不到 503 `*_STARTING`（可重试，界面接着轮询）；起不来、正在退出：404；
//! - 起来之后：派单走真实的派单器（`DISPATCH_*` 原样回，含状态码与 details），同步走连接器的设置入口；
//! - Agent：九条都 403，派单器与连接器一次都没被调到（T-DENY 在界面这一侧）。

mod support;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use atm_dispatch::mobile::{self, Features, MakeSync, SyncSettings};
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::principal::Principal;
use atm_ui_bridge::{Reply, Request, Ui};
use serde_json::{Value, json};
use support::*;

/// 记下每次调用的假连接器。
#[derive(Default)]
struct FakeSync {
    calls: Mutex<Vec<(String, Value)>>,
    stops: AtomicUsize,
}

impl FakeSync {
    fn record(&self, what: &str, v: &Value) -> Result<Value, DomainError> {
        self.calls.lock().unwrap().push((what.into(), v.clone()));
        if v.get("relayUrl").and_then(Value::as_str) == Some("bad") {
            return Err(DomainError::new(
                ErrorCode::INVALID_ARGUMENT,
                "中继地址不合法",
            ));
        }
        Ok(json!({ "via": what, "got": v }))
    }
    fn count(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
}

impl SyncSettings for FakeSync {
    fn status(&self, _: &Principal) -> Result<Value, DomainError> {
        self.record("status", &Value::Null)
    }
    fn update_config(&self, _: &Principal, patch: &Value) -> Result<Value, DomainError> {
        self.record("update_config", patch)
    }
    fn test_relay(&self, _: &Principal, candidate: &Value) -> Result<Value, DomainError> {
        self.record("test_relay", candidate)
    }
    fn create_pairing(&self, _: &Principal) -> Result<Value, DomainError> {
        self.record("create_pairing", &Value::Null)
    }
    fn reset_space(&self, _: &Principal) -> Result<Value, DomainError> {
        self.record("reset_space", &Value::Null)
    }
    fn mark_dirty(&self, _: Option<&str>) {}
    fn stop(&self) {
        self.stops.fetch_add(1, Ordering::SeqCst);
    }
}

fn bridge(w: &World, features: Option<Arc<Features>>) -> Ui {
    let runtime: atm_ui_bridge::RuntimeStatus = Arc::new(|| json!({ "version": "3.0.0-test" }));
    let ui = Ui::new(w.svc.clone(), runtime, STARTED);
    match features {
        Some(f) => ui.with_mobile(f),
        None => ui,
    }
}

fn call(ui: &Ui, p: &Principal, method: &str, target: &str, body: Option<Value>) -> Reply {
    let bytes = body.map(|b| serde_json::to_vec(&b).unwrap());
    ui.dispatch(
        p,
        Request {
            method,
            target,
            body: bytes.as_deref(),
        },
    )
}

/// 九条路由：(编号, 方法, 路径, body)。
fn routes(code: &str, key: &str) -> Vec<(u16, &'static str, String, Option<Value>)> {
    vec![
        (88, "GET", "/api/v1/dispatch/status".into(), None),
        (
            89,
            "PUT",
            "/api/v1/dispatch/config".into(),
            Some(json!({ "maxConcurrent": 2 })),
        ),
        (
            90,
            "POST",
            format!("/api/v1/projects/{code}/ui/work-items/{key}/dispatch"),
            Some(json!({})),
        ),
        (
            91,
            "POST",
            "/api/v1/dispatch/runs/r-00000000/cancel".into(),
            Some(json!({})),
        ),
        (92, "GET", "/api/v1/sync/status".into(), None),
        (
            93,
            "PUT",
            "/api/v1/sync/config".into(),
            Some(json!({ "enabled": true })),
        ),
        (
            94,
            "POST",
            "/api/v1/sync/test".into(),
            Some(json!({ "relayUrl": "https://relay.test" })),
        ),
        (95, "POST", "/api/v1/sync/pairing".into(), Some(json!({}))),
        (96, "POST", "/api/v1/sync/reset".into(), Some(json!({}))),
    ]
}

fn feature_code(n: u16, suffix: &str) -> String {
    format!("{}_{suffix}", if n <= 91 { "DISPATCH" } else { "SYNC" })
}

/// 真实的派单器（找不到 claude），日志在世界目录下。
fn dispatch_options(w: &World) -> atm_dispatch::Options {
    use atm_dispatch::process::Native;
    atm_dispatch::Options {
        service: w.svc.clone(),
        logs: w.dir.join("dispatch").join("logs"),
        legacy_logs: None,
        resolve_claude: Arc::new(|| None),
        spawner: Arc::new(Native),
        probe: Arc::new(Native),
        runner: Arc::new(atm_dispatch::probe::ProcessRunner {
            comspec: None,
            probe: Arc::new(Native),
        }),
        base_env: Vec::new(),
        comspec: None,
        now: Arc::new(atm_sync::time::now_ms),
        log: Arc::new(atm_sync::host::NoLog),
        poll: Duration::from_millis(50),
        auth_timeout: Duration::from_secs(5),
    }
}

fn wait_ready(f: &Features) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if f.sync().is_ok() && f.dispatch().is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("手机功能没有起来");
}

/// 两个功能都起来：真实派单器 + 假连接器。
fn ready(w: &World) -> (Arc<Features>, Arc<FakeSync>) {
    let f = Features::new(Duration::from_millis(200));
    let fake = Arc::new(FakeSync::default());
    let given = fake.clone();
    let make: MakeSync = Box::new(move |port| {
        assert!(port.is_some(), "连接器拿到派单器的端口");
        Ok(given as Arc<dyn SyncSettings>)
    });
    mobile::start(
        &f,
        dispatch_options(w),
        make,
        Arc::new(atm_sync::host::NoLog),
    );
    wait_ready(&f);
    (f, fake)
}

#[test]
fn t_ui_without_the_features_every_route_answers_404_like_the_2x_daemon() {
    let w = world("mobile-absent");
    let ui = bridge(&w, None);
    for (n, method, target, body) in routes("ATM", "ATM-T-0001") {
        let r = call(&ui, &user(), method, &target, body);
        error(&r, 404, &feature_code(n, "UNAVAILABLE"));
        assert_eq!(r.body["error"]["retryable"], false);
        let message = r.body["error"]["message"].as_str().unwrap();
        assert!(
            message.starts_with("当前 ATM 宿主没有启用"),
            "#{n}: {message}"
        );
    }
}

#[test]
fn t_ui_starting_answers_503_failed_and_closing_answer_404() {
    let w = world("mobile-states");
    // 还没定下来：等满 200 ms 后 503，可重试。
    let f = Features::new(Duration::from_millis(200));
    let ui = bridge(&w, Some(f.clone()));
    for (n, method, target, body) in routes("ATM", "ATM-T-0001") {
        let started = Instant::now();
        let r = call(&ui, &user(), method, &target, body);
        error(&r, 503, &feature_code(n, "STARTING"));
        assert_eq!(r.body["error"]["retryable"], true);
        assert!(
            started.elapsed() >= Duration::from_millis(200),
            "#{n} 先等再回"
        );
    }
    // 起来途中有人在等：一起来就拿到，不等满上限。
    let f = Features::new(Duration::from_secs(10));
    let ui = Arc::new(bridge(&w, Some(f.clone())));
    let waiting = {
        let ui = ui.clone();
        std::thread::spawn(move || {
            let t = Instant::now();
            (
                call(&ui, &user(), "GET", "/api/v1/sync/status", None),
                t.elapsed(),
            )
        })
    };
    std::thread::sleep(Duration::from_millis(100));
    let fake = Arc::new(FakeSync::default());
    let given = fake.clone();
    let make: MakeSync = Box::new(move |_| Ok(given as Arc<dyn SyncSettings>));
    mobile::start(
        &f,
        dispatch_options(&w),
        make,
        Arc::new(atm_sync::host::NoLog),
    );
    let (r, took) = waiting.join().unwrap();
    assert_eq!(r.status, 200, "{}", r.body);
    assert!(took < Duration::from_secs(5), "{took:?}");
    // 起不来：404，提示重启。
    let f = Features::new(Duration::from_millis(200));
    let make: MakeSync = Box::new(|_| Err("中继客户端初始化失败".into()));
    mobile::start(
        &f,
        dispatch_options(&w),
        make,
        Arc::new(atm_sync::host::NoLog),
    );
    let deadline = Instant::now() + Duration::from_secs(20);
    let ui = bridge(&w, Some(f.clone()));
    let r = loop {
        let r = call(&ui, &user(), "GET", "/api/v1/sync/status", None);
        if r.status != 503 || Instant::now() > deadline {
            break r;
        }
    };
    error(&r, 404, "SYNC_UNAVAILABLE");
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("没能启动")
    );
    // 派单器照样起来：同步起不来不连累它。
    let r = call(&ui, &user(), "GET", "/api/v1/dispatch/status", None);
    assert_eq!(r.status, 200, "{}", r.body);
    // 收尾：九条都回「正在退出」。
    f.close();
    for (n, method, target, body) in routes("ATM", "ATM-T-0001") {
        let r = call(&ui, &user(), method, &target, body);
        error(&r, 404, &feature_code(n, "UNAVAILABLE"));
        assert!(
            r.body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("正在退出"),
            "#{n}: {}",
            r.body
        );
    }
}

#[test]
fn t_disp_the_dispatch_routes_reach_the_dispatcher_with_2x_errors() {
    let w = world("mobile-dispatch");
    let code = w.project("派单项目", "DSP");
    let objective = w.objective(&code, "目标");
    let key = w.task(&code, &objective, "交给 Claude");
    let (f, _) = ready(&w);
    let ui = bridge(&w, Some(f.clone()));
    let s = call(&ui, &user(), "GET", "/api/v1/dispatch/status", None);
    assert_eq!(s.status, 200, "{}", s.body);
    for k in [
        "enabled",
        "permissionMode",
        "maxConcurrent",
        "claude",
        "runs",
        "requestLedger",
    ] {
        assert!(s.body.get(k).is_some(), "status 缺 {k}: {}", s.body);
    }
    assert_eq!(s.body["enabled"], false);
    assert_eq!(s.body["claude"]["found"], false);
    // 改配置：回配置本身（2.x `updateConfig` 的返回）。
    let c = call(
        &ui,
        &user(),
        "PUT",
        "/api/v1/dispatch/config",
        Some(json!({ "enabled": true, "maxConcurrent": 2 })),
    );
    assert_eq!(c.status, 200, "{}", c.body);
    assert_eq!(c.body["maxConcurrent"], 2);
    assert_eq!(c.body["enabled"], true);
    // 不合法的配置：DISPATCH_INVALID_ARGUMENT 400，整个 patch 不生效。
    let bad = call(
        &ui,
        &user(),
        "PUT",
        "/api/v1/dispatch/config",
        Some(json!({ "maxConcurrent": 99 })),
    );
    error(&bad, 400, "DISPATCH_INVALID_ARGUMENT");
    assert_eq!(f.dispatch().unwrap().config().max_concurrent, 2);
    // 交给 Claude：找不到 claude，DISPATCH_CLAUDE_NOT_FOUND 原样回，不起任何会话。
    let e = call(
        &ui,
        &user(),
        "POST",
        &format!("/api/v1/projects/{code}/ui/work-items/{key}/dispatch"),
        Some(json!({})),
    );
    error(&e, 503, "DISPATCH_CLAUDE_NOT_FOUND");
    assert!(f.dispatch().unwrap().list_runs().is_empty());
    // 不存在的派单：404，details 带 run。
    let x = call(
        &ui,
        &user(),
        "POST",
        "/api/v1/dispatch/runs/zzz-00000000/cancel",
        Some(json!({})),
    );
    error(&x, 404, "DISPATCH_RUN_NOT_FOUND");
    assert_eq!(x.body["error"]["details"]["run"], "zzz-00000000");
    f.close();
}

#[test]
fn t_sync_the_sync_routes_reach_the_connector_entries() {
    let w = world("mobile-sync");
    let (f, fake) = ready(&w);
    let ui = bridge(&w, Some(f.clone()));
    let expect = [
        (92, "status"),
        (93, "update_config"),
        (94, "test_relay"),
        (95, "create_pairing"),
        (96, "reset_space"),
    ];
    for ((n, method, target, body), (m, via)) in routes("ATM", "ATM-T-0001")
        .into_iter()
        .filter(|r| r.0 >= 92)
        .zip(expect)
    {
        assert_eq!(n, m);
        let r = call(&ui, &user(), method, &target, body.clone());
        assert_eq!(r.status, 200, "#{n}: {}", r.body);
        assert_eq!(r.body["via"], via, "#{n}");
        if n == 93 || n == 94 {
            assert_eq!(r.body["got"], body.unwrap(), "#{n} 整个 body 交给连接器");
        }
    }
    // 连接器自己的错误按服务错误回（2.x 交给全局处理：INVALID_ARGUMENT 400）。
    let r = call(
        &ui,
        &user(),
        "POST",
        "/api/v1/sync/test",
        Some(json!({ "relayUrl": "bad" })),
    );
    error(&r, 400, "INVALID_ARGUMENT");
    // 收尾停连接器一次。
    f.close();
    assert_eq!(fake.stops.load(Ordering::SeqCst), 1);
}

#[test]
fn t_deny_agents_get_403_on_all_nine_and_nothing_is_called() {
    let w = world("mobile-deny");
    let code = w.project("派单项目", "DNY");
    let objective = w.objective(&code, "目标");
    let key = w.task(&code, &objective, "不许 Agent 派");
    let (f, fake) = ready(&w);
    let ui = bridge(&w, Some(f.clone()));
    let before = f.dispatch().unwrap().config();
    for (n, method, target, body) in routes(&code, &key) {
        let r = call(&ui, &agent(), method, &target, body);
        error(&r, 403, "USER_AUTHORIZATION_REQUIRED");
        assert_eq!(fake.count(), 0, "#{n} 调到了连接器");
    }
    assert_eq!(f.dispatch().unwrap().config(), before);
    assert!(f.dispatch().unwrap().list_runs().is_empty());
    assert_eq!(w.svc.dispatch_runs(&user()).unwrap().1.len(), 0);
    f.close();
}

/// 已登录的 claude（只回版本与登录状态）；拉起会话一律失败，用例不起任何进程。
struct LoggedIn;

impl atm_dispatch::probe::Runner for LoggedIn {
    fn run(
        &self,
        _: &std::path::Path,
        args: &[String],
        _: &[(std::ffi::OsString, std::ffi::OsString)],
        _: Duration,
    ) -> atm_dispatch::probe::ProbeOutput {
        let stdout = if args.iter().any(|a| a == "--version") {
            "9.9.9 (Claude Code)".to_owned()
        } else {
            r#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}"#.to_owned()
        };
        atm_dispatch::probe::ProbeOutput {
            stdout,
            timed_out: false,
            failed: false,
        }
    }
}

struct Refuse;

impl atm_dispatch::process::Spawner for Refuse {
    fn spawn(
        &self,
        _: &atm_dispatch::process::SpawnRequest<'_>,
    ) -> std::io::Result<Box<dyn atm_dispatch::process::Child>> {
        Err(std::io::Error::other("用例不拉起会话"))
    }
}

/// #90 交给 Claude 成功：201（2.x `reply.code(201)`），回的是这次派单。
#[test]
fn t_disp_handing_a_task_to_claude_answers_201_with_the_run() {
    let w = world("mobile-dispatch-created");
    let code = w.ok(
        "POST",
        "/api/v1/projects",
        Some(json!({ "name": "有目录的项目", "code": "DSQ", "sourcePath": w.dir.to_string_lossy(), "description": "", "coordinationMode": "SOLO" })),
        201,
    )["code"]
        .as_str()
        .unwrap()
        .to_owned();
    let objective = w.objective(&code, "目标");
    let key = w.task(&code, &objective, "交给 Claude");
    let claude = std::env::current_exe().unwrap();
    let f = Features::new(Duration::from_millis(200));
    let fake = Arc::new(FakeSync::default());
    let given = fake.clone();
    let make: MakeSync = Box::new(move |_| Ok(given as Arc<dyn SyncSettings>));
    mobile::start(
        &f,
        atm_dispatch::Options {
            resolve_claude: Arc::new(move || Some(claude.clone())),
            spawner: Arc::new(Refuse),
            runner: Arc::new(LoggedIn),
            ..dispatch_options(&w)
        },
        make,
        Arc::new(atm_sync::host::NoLog),
    );
    wait_ready(&f);
    let ui = bridge(&w, Some(f.clone()));
    let c = call(
        &ui,
        &user(),
        "PUT",
        "/api/v1/dispatch/config",
        Some(json!({ "enabled": true })),
    );
    assert_eq!(c.status, 200, "{}", c.body);
    let r = call(
        &ui,
        &user(),
        "POST",
        &format!("/api/v1/projects/{code}/ui/work-items/{key}/dispatch"),
        Some(json!({})),
    );
    assert_eq!(r.status, 201, "{}", r.body);
    let run = r.body["run"].as_str().unwrap();
    assert_eq!(r.body["key"], key.as_str(), "{}", r.body);
    assert!(
        f.dispatch()
            .unwrap()
            .list_runs()
            .iter()
            .any(|v| v["run"] == run)
    );
    f.close();
}
