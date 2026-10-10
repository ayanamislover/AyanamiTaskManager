//! 手机同步与 Claude 派单归入口管（W7e；07 §2、§7；2.x `apps/desktop/src/core-mobile.ts`）：入口发布之后才起，
//! 撤下入口时先停；数据源冲突时不消费手机命令（07 §7 :97：不写 ACK、不推进 processed / cursor，命令留在中继）。
//! 连接器连的是内存中继（`sync/tests/support` 的同一份），手机一侧用配对码里的密钥读写同一个空间。

mod support;

#[path = "../../sync/tests/support/mod.rs"]
mod relay;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use atm_domain::principal::{Principal, UiSurface};
use atm_runtime::{Background, Event, Started};
use relay::MemoryRelay;
use relay::world::{RELAY_URL, phone_for, wait_for};
use serde_json::{Value, json};
use support::*;

fn user() -> Principal {
    Principal::trusted_ui(UiSurface::WebView {
        generation: 1,
        epoch: 1,
    })
}

fn mobile(relay: &MemoryRelay) -> atm_runtime::entries::Mobile {
    with_transport(Arc::new(MemoryRelay(relay.0.clone())))
}

fn with_transport(
    transport: Arc<dyn atm_runtime::sync::transport::Transport>,
) -> atm_runtime::entries::Mobile {
    atm_runtime::entries::Mobile {
        resolve_claude: Arc::new(|| None),
        transport,
        log: Arc::new(atm_runtime::sync::host::NoLog),
        base_env: Vec::new(),
        comspec: None,
        device_name: Some("测试电脑".into()),
        feature_wait: atm_runtime::dispatch::mobile::FEATURE_WAIT,
        track_every: Duration::from_millis(50),
    }
}

fn serving(started: Started) -> atm_runtime::Serving {
    match started {
        Started::Serving(s) => s,
        Started::Conflict(c) => panic!("conflict: {}", c.state.reason),
    }
}

fn sync_status(s: &atm_runtime::Serving) -> Value {
    s.mobile().unwrap().sync().unwrap().status(&user()).unwrap()
}

/// 启用 + 配置中继 + 配对，等到在线；返回配对码。
fn connect(s: &atm_runtime::Serving) -> String {
    let sync = s.mobile().unwrap().sync().unwrap();
    sync.update_config(
        &user(),
        &json!({ "enabled": true, "relayUrl": RELAY_URL, "token": relay::TOKEN }),
    )
    .unwrap();
    let pairing = sync.create_pairing(&user()).unwrap();
    wait_for(|| sync_status(s)["state"] == "online", "连接器上线");
    pairing["pairingCode"].as_str().unwrap().to_owned()
}

/// T-SYNC：入口发布之后两个功能都起来；手机建的任务经真实的运行时落进库；停止在预算内写出离线状态。
#[test]
fn t_sync_the_runtime_handles_phone_commands_and_stops_within_the_budget() {
    let d = dir("mobile-runtime");
    let (n, l) = (d.join("N"), legacy_root(&d));
    let relay = MemoryRelay::new(true);
    let events = Events::default();
    let mut o = options(&n, &l, &events);
    o.mobile = Some(mobile(&relay));
    let s = serving(atm_runtime::start(&o).unwrap());
    assert_eq!(
        s.background(Duration::from_secs(120)),
        Some(Background::Unchanged)
    );
    let features = s.mobile().expect("入口发布之后起了手机功能");
    let dispatch = features.dispatch().unwrap();
    assert_eq!(dispatch.config().enabled, false, "派单默认关闭");
    assert_eq!(sync_status(&s)["state"], "disabled", "同步默认关闭");
    assert_eq!(relay.request_count(), 0, "默认关闭：一个请求都不发");

    // 夹具里的 2.x 项目只有元数据、没有编号计数器；手机建任务用一个经服务新建的项目。
    let (svc, _) = s.service().unwrap();
    svc.create_project(
        &user(),
        atm_service::project::CreateProjectRequest {
            code: Some("MOB".into()),
            ..atm_service::project::CreateProjectRequest::new("Mobile")
        },
    )
    .unwrap();
    drop(svc);
    let pairing = connect(&s);
    let phone = phone_for(&relay, &pairing);
    let id = phone.send(json!({
        "type": "task.create",
        "body": { "project": "MOB", "title": "手机建的任务" },
    }));
    let ack = phone.await_ack(&id);
    assert_eq!(ack["ok"], true, "{ack}");
    let key = ack["result"]["key"].as_str().unwrap().to_owned();
    let (svc, _) = s.service().unwrap();
    assert_eq!(
        svc.ui_work_item(&user(), "MOB", &key).unwrap()["title"],
        "手机建的任务"
    );
    drop(svc);

    // 停止：在 3 s 预算（加掐断后的短暂收尾）之内，离线状态写到中继（电脑一侧的设备文档 `dev/<id>`）。
    let presence = relay.request_count();
    let started = Instant::now();
    s.stop(&|_| {});
    let took = started.elapsed();
    assert!(took < Duration::from_secs(5), "停止用了 {took:?}");
    let written = relay.puts_since(presence);
    let device = written
        .iter()
        .find_map(|k| k.split_once("/dev/").map(|(_, id)| id.to_owned()))
        .unwrap_or_else(|| panic!("停止时写出在线状态：{written:?}"));
    let doc = phone.store.read_device(&device).unwrap().unwrap();
    assert_eq!(doc["state"], "offline", "{doc}");
    assert_eq!(doc["role"], "host", "{doc}");
    // 派单器随之关闭：再入队是 DISPATCH_CLOSED。
    let e = dispatch
        .enqueue(
            &user(),
            &atm_runtime::dispatch::Enqueue {
                project: "MOB".into(),
                key,
                mobile: false,
                requested_by: None,
                request_id: None,
            },
        )
        .unwrap_err();
    assert_eq!(e.code(), "DISPATCH_CLOSED");
    // 撤下之后状态槽回「正在退出」。
    assert_eq!(features.sync().err().unwrap().code, "SYNC_UNAVAILABLE");
}

/// 07 §7 :97：后台比较发现数据源冲突，入口撤下时手机同步一起停；之后手机发的命令不被消费——没有回执，
/// 命令留在中继，库里也没有它建的任务。
#[test]
fn a_source_conflict_stops_consuming_phone_commands() {
    let d = dir("mobile-conflict");
    let (n, l) = (d.join("N"), legacy_root(&d));
    let relay = MemoryRelay::new(true);
    let events = Events::default();
    let mut o = options(&n, &l, &events);
    o.mobile = Some(mobile(&relay));
    let s = serving(atm_runtime::start(&o).unwrap());
    assert_eq!(
        s.background(Duration::from_secs(120)),
        Some(Background::Unchanged)
    );
    let pairing = connect(&s);
    s.stop(&|_| {});

    // 2.x 那边又写了东西：下一次启动照常开放入口（A=v3），后台比较判冲突。
    touch_legacy(&l);
    events.take();
    let s = serving(atm_runtime::start(&o).unwrap());
    let features = s.mobile().unwrap();
    // 配置是启用的：这一次也上线了（冲突是之后才发现的）。
    let outcome = s.background(Duration::from_secs(120)).unwrap();
    assert!(matches!(outcome, Background::Conflict(_)), "{outcome:?}");
    assert!(events.seen().contains(&Event::Withdrawn));
    assert!(s.mobile().is_none(), "入口撤下，手机功能随之撤下");
    assert_eq!(
        features.sync().err().unwrap().message,
        "ATM 正在退出，手机同步已停止"
    );

    let phone = phone_for(&relay, &pairing);
    let id = phone.send(json!({
        "type": "task.create",
        "body": { "project": "AAA", "title": "冲突期间发的" },
    }));
    // 手机和电脑用同一个中继令牌，按时间段分：手机发完命令之后、自己再去读回执之前，中继收到的请求只可能来自电脑。
    // 在线的连接器会立刻收到变化（长轮询）；等足够久，确认没有人碰它。
    let sent = relay.request_count();
    std::thread::sleep(Duration::from_secs(2));
    let quiet: Vec<_> = relay.state().requests[sent..]
        .iter()
        .map(|r| format!("{} {}", r.method, r.url))
        .collect();
    assert!(quiet.is_empty(), "冲突后电脑一侧还在访问中继：{quiet:?}");
    assert!(
        phone.store.read_ack(&id).unwrap().is_none(),
        "冲突时不写回执"
    );
    assert!(
        relay.keys().iter().any(|k| k.contains(&id)),
        "命令留在中继：{:?}",
        relay.keys()
    );
    drop(s);
}

/// 中继卡住：`stall` 打开之后的每个写入都一直不回（只有取消能掐断它）。
struct Stalling {
    inner: MemoryRelay,
    stall: AtomicBool,
}

impl atm_runtime::sync::transport::Transport for Stalling {
    fn send(
        &self,
        r: &atm_runtime::sync::transport::HttpRequest,
        cancel: &[&atm_runtime::sync::transport::Cancel],
    ) -> Result<atm_runtime::sync::transport::HttpResponse, atm_runtime::sync::transport::NetFailure>
    {
        if r.method == "PUT" && self.stall.load(Ordering::SeqCst) {
            return atm_runtime::sync::transport::run_cancellable(cancel, None, || {
                std::thread::sleep(Duration::from_secs(30));
                Err(atm_runtime::sync::transport::NetFailure::Timeout)
            });
        }
        self.inner.send(r, cancel)
    }
}

/// 退出时中继卡住：连接器按 3 s 的预算（SYNC_STOP_BUDGET）掐断，宿主的退出不被拖住。
#[test]
fn a_stuck_relay_does_not_hold_the_exit_beyond_the_stop_budget() {
    let d = dir("mobile-stuck-exit");
    let (n, l) = (d.join("N"), legacy_root(&d));
    let relay = MemoryRelay::new(true);
    let stalling = Arc::new(Stalling {
        inner: MemoryRelay(relay.0.clone()),
        stall: AtomicBool::new(false),
    });
    let events = Events::default();
    let mut o = options(&n, &l, &events);
    o.mobile = Some(with_transport(stalling.clone()));
    let s = serving(atm_runtime::start(&o).unwrap());
    assert_eq!(
        s.background(Duration::from_secs(120)),
        Some(Background::Unchanged)
    );
    connect(&s);
    stalling.stall.store(true, Ordering::SeqCst);
    let started = Instant::now();
    s.stop(&|_| {});
    let took = started.elapsed();
    // 单独跑约 3.5 s（预算 3 s 加掐断后的收尾）；与别的用例并行时机器忙，留到 6 s。没有预算是 30 s。
    assert!(took < Duration::from_secs(6), "停止用了 {took:?}");
}
