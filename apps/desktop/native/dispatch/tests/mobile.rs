//! 手机功能的起停（W7e，`mobile::Features` / `mobile::start`；2.x `apps/desktop/src/core-mobile.ts`）：
//! 收尾停连接器、关派单器，可重复；收尾等后台启动做完，启动途中收尾时起好的连接器也被停掉；启动线程半路 panic
//! 不会让界面一直等到 503；派单状态变化交给连接器重新发布；派单器起不来时同步照样起，只是拿不到派单的端口。
//! 界面一侧的状态码（503 / 404）见 `ui-bridge/tests/mobile.rs`。

mod support;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use atm_dispatch::mobile::{self, Features, MakeSync, SyncSettings};
use atm_domain::error::DomainError;
use atm_domain::principal::Principal;
use serde_json::{Value, json};
use support::*;

/// 记下停了几次、收到哪些重新发布请求的假连接器。
#[derive(Default)]
struct FakeSync {
    stops: AtomicUsize,
    dirty: Mutex<Vec<Option<String>>>,
}

impl SyncSettings for FakeSync {
    fn status(&self, _: &Principal) -> Result<Value, DomainError> {
        Ok(json!({ "state": "disabled" }))
    }
    fn update_config(&self, _: &Principal, _: &Value) -> Result<Value, DomainError> {
        Ok(Value::Null)
    }
    fn test_relay(&self, _: &Principal, _: &Value) -> Result<Value, DomainError> {
        Ok(Value::Null)
    }
    fn create_pairing(&self, _: &Principal) -> Result<Value, DomainError> {
        Ok(Value::Null)
    }
    fn reset_space(&self, _: &Principal) -> Result<Value, DomainError> {
        Ok(Value::Null)
    }
    fn mark_dirty(&self, project: Option<&str>) {
        self.dirty.lock().unwrap().push(project.map(str::to_owned));
    }
    fn stop(&self) {
        self.stops.fetch_add(1, Ordering::SeqCst);
    }
}

fn no_log() -> Arc<dyn atm_sync::host::Log> {
    Arc::new(atm_sync::host::NoLog)
}

fn given(fake: &Arc<FakeSync>) -> MakeSync {
    let fake = fake.clone();
    Box::new(move |_| Ok(fake as Arc<dyn SyncSettings>))
}

fn ready(f: &Features) {
    wait_for(
        || f.sync().is_ok() && f.dispatch().is_ok(),
        "两个功能都起来",
    );
}

#[test]
fn closing_stops_the_connector_and_closes_the_dispatcher_once() {
    let w = world("mobile-close");
    let key = w.seed_task("ATM", "t");
    let f = Features::new(Duration::from_millis(200));
    let fake = Arc::new(FakeSync::default());
    mobile::start(&f, w.options(), given(&fake), no_log());
    ready(&f);
    let d = f.dispatch().unwrap();
    w.enable(&d, json!({}));
    f.close();
    assert_eq!(fake.stops.load(Ordering::SeqCst), 1, "收尾停了连接器");
    assert_eq!(
        d.enqueue(&user(), &desktop(&key)).unwrap_err().code(),
        "DISPATCH_CLOSED",
        "收尾关了派单器"
    );
    assert_eq!(f.sync().err().unwrap().code, "SYNC_UNAVAILABLE");
    assert_eq!(
        f.dispatch().err().unwrap().message,
        "ATM 正在退出，Claude 派单已停止"
    );
    // 可重复：不再停第二次。
    f.close();
    assert_eq!(fake.stops.load(Ordering::SeqCst), 1);
}

#[test]
fn closing_waits_for_the_start_and_stops_a_connector_made_meanwhile() {
    let w = world("mobile-close-starting");
    let f = Features::new(Duration::from_millis(200));
    let fake = Arc::new(FakeSync::default());
    let (entered, wait_entered) = mpsc::channel();
    let (release, released) = mpsc::channel::<()>();
    let made = Arc::new(AtomicBool::new(false));
    let make: MakeSync = {
        let (fake, made) = (fake.clone(), made.clone());
        Box::new(move |_| {
            entered.send(()).unwrap();
            released.recv().unwrap();
            made.store(true, Ordering::SeqCst);
            Ok(fake as Arc<dyn SyncSettings>)
        })
    };
    mobile::start(&f, w.options(), make, no_log());
    wait_entered.recv_timeout(Duration::from_secs(20)).unwrap();
    // 连接器正在造：收尾开始，之后才放它造完。
    let closer = {
        let f = f.clone();
        std::thread::spawn(move || f.close())
    };
    std::thread::sleep(Duration::from_millis(200));
    assert!(!closer.is_finished(), "收尾等着后台启动做完");
    release.send(()).unwrap();
    closer.join().unwrap();
    assert!(made.load(Ordering::SeqCst));
    assert_eq!(
        fake.stops.load(Ordering::SeqCst),
        1,
        "收尾途中起好的连接器被停掉，没人管的连接器不留下"
    );
    assert_eq!(
        f.sync().err().unwrap().message,
        "ATM 正在退出，手机同步已停止"
    );
}

#[test]
fn a_start_that_panics_settles_as_unavailable_instead_of_starting_forever() {
    let w = world("mobile-panic");
    let f = Features::new(Duration::from_millis(100));
    let make: MakeSync = Box::new(|_| panic!("连接器初始化途中出错"));
    mobile::start(&f, w.options(), make, no_log());
    wait_for(|| f.sync().is_err_and(|u| u.status != 503), "同步定下来");
    let u = f.sync().err().unwrap();
    assert_eq!((u.code, u.status), ("SYNC_UNAVAILABLE", 404));
    assert!(u.message.contains("没能启动"), "{}", u.message);
    // 派单器在 panic 之前已经起来，不受影响。
    assert!(f.dispatch().is_ok());
    f.close();
}

#[test]
fn dispatch_changes_ask_the_connector_to_republish_the_project() {
    let w = world("mobile-dirty");
    let key = w.seed_task("ATM", "t");
    let f = Features::new(Duration::from_millis(200));
    let fake = Arc::new(FakeSync::default());
    mobile::start(&f, w.options(), given(&fake), no_log());
    ready(&f);
    let d = f.dispatch().unwrap();
    w.enable(&d, json!({}));
    w.behave(json!({ "mode": "success" }));
    let run = d.enqueue(&user(), &desktop(&key)).unwrap()["run"]
        .as_str()
        .unwrap()
        .to_owned();
    wait_state(&d, &run, "succeeded");
    wait_for(
        || {
            fake.dirty
                .lock()
                .unwrap()
                .iter()
                .any(|p| p.as_deref() == Some("ATM"))
        },
        "派单状态变化交给连接器",
    );
    f.close();
}

#[test]
fn sync_still_starts_without_a_dispatch_port_when_the_dispatcher_cannot() {
    let w = world("mobile-no-dispatcher");
    // 派单器读不到自己的历史：起不来。
    w.sql_batch("DROP TABLE dispatch_runs");
    let f = Features::new(Duration::from_millis(200));
    let fake = Arc::new(FakeSync::default());
    let port = Arc::new(Mutex::new(None));
    let make: MakeSync = {
        let (fake, port) = (fake.clone(), port.clone());
        Box::new(move |p| {
            *port.lock().unwrap() = Some(p.is_some());
            Ok(fake as Arc<dyn SyncSettings>)
        })
    };
    mobile::start(&f, w.options(), make, no_log());
    wait_for(|| f.sync().is_ok(), "同步起来");
    assert_eq!(*port.lock().unwrap(), Some(false), "没有派单的端口");
    let u = f.dispatch().err().unwrap();
    assert_eq!((u.code, u.status), ("DISPATCH_UNAVAILABLE", 404));
    assert!(u.message.contains("没能启动"), "{}", u.message);
    f.close();
    assert_eq!(fake.stops.load(Ordering::SeqCst), 1);
}
