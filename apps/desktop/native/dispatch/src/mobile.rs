//! 手机同步与 Claude 派单在宿主里的起停（2.x `apps/desktop/src/core-mobile.ts`）。
//!
//! 两者是可选功能，在入口发布之后（07 §2）于后台起：派单器修正上次留下的会话要查进程身份，慢了也只是这两个
//! 功能晚到，ATM 本体照常就绪。派单器先起，连接器拿它的端口起；派单器起不来时同步照样起，只是不接手机派单。
//!
//! 设置页与任务抽屉经 [`Features`] 拿功能：还在启动就等一会儿（[`FEATURE_WAIT`]），还没起来回 503
//! `*_STARTING`（界面会自动重试）；起不来回 404 `*_UNAVAILABLE`；收尾一开始就回「正在退出」。拿到功能之后
//! 调用的结果归功能自己（例如在途时关闭，派单器回 `DISPATCH_CLOSED`），收尾不再改写它。
//!
//! 收尾（[`Features::close`]）：先标记正在退出、等后台的启动做完（它看到正在退出会把自己起到一半的停掉），
//! 再停连接器（写离线状态要在关库之前，预算 [`SYNC_STOP_BUDGET`]），最后关派单器。

use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use atm_domain::error::DomainError;
use atm_domain::principal::Principal;
use atm_sync::connector::Connector;
use atm_sync::dispatch::DispatchPort;
use atm_sync::host::Log;
use atm_sync::secrets::Cipher;
use serde_json::{Value, json};

use crate::dispatcher::{Dispatcher, Options};

/// 连接器停下（含写离线状态）的总预算（2.x `SYNC_STOP_BUDGET_MS`）。宿主退出时还要留给 HTTP 与数据库收尾。
pub const SYNC_STOP_BUDGET: Duration = Duration::from_secs(3);
/// 路由等功能起来的上限（2.x `FEATURE_WAIT_MS`）。正常几十毫秒就起来；更久回 503，界面会自动重试。
pub const FEATURE_WAIT: Duration = Duration::from_secs(5);

/// 设置页的手机同步入口（#92–96）。[`Connector`] 实现它；用例可以换成别的。
pub trait SyncSettings: Send + Sync {
    fn status(&self, p: &Principal) -> Result<Value, DomainError>;
    fn update_config(&self, p: &Principal, patch: &Value) -> Result<Value, DomainError>;
    fn test_relay(&self, p: &Principal, candidate: &Value) -> Result<Value, DomainError>;
    fn create_pairing(&self, p: &Principal) -> Result<Value, DomainError>;
    fn reset_space(&self, p: &Principal) -> Result<Value, DomainError>;
    /// 派单状态变了：去抖后重新发布那个项目。
    fn mark_dirty(&self, project: Option<&str>);
    /// 停下（有总预算，见 [`SYNC_STOP_BUDGET`]）。
    fn stop(&self);
}

impl<C: Cipher + Send + Sync + 'static> SyncSettings for Connector<C> {
    fn status(&self, p: &Principal) -> Result<Value, DomainError> {
        Connector::status(self, p)
    }
    fn update_config(&self, p: &Principal, patch: &Value) -> Result<Value, DomainError> {
        Connector::update_config(self, p, patch)
    }
    fn test_relay(&self, p: &Principal, candidate: &Value) -> Result<Value, DomainError> {
        Connector::test_relay(self, p, candidate)
    }
    fn create_pairing(&self, p: &Principal) -> Result<Value, DomainError> {
        Connector::create_pairing(self, p)
    }
    fn reset_space(&self, p: &Principal) -> Result<Value, DomainError> {
        Connector::reset_space(self, p)
    }
    fn mark_dirty(&self, project: Option<&str>) {
        Connector::mark_dirty(self, project)
    }
    fn stop(&self) {
        Connector::stop(self)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Feature {
    Sync,
    Dispatch,
}

/// 功能拿不到时回给界面的错误（2.x `FeatureError`）：码以 `SYNC_` / `DISPATCH_` 开头，状态码原样回。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unavailable {
    pub code: &'static str,
    pub status: u16,
    pub retryable: bool,
    pub message: &'static str,
}

impl Feature {
    fn starting(self) -> Unavailable {
        match self {
            Feature::Sync => Unavailable {
                code: "SYNC_STARTING",
                status: 503,
                retryable: true,
                message: "手机同步正在启动，请稍后再试",
            },
            Feature::Dispatch => Unavailable {
                code: "DISPATCH_STARTING",
                status: 503,
                retryable: true,
                message: "Claude 派单正在启动，请稍后再试",
            },
        }
    }
    fn closing(self) -> Unavailable {
        match self {
            Feature::Sync => Unavailable {
                code: "SYNC_UNAVAILABLE",
                status: 404,
                retryable: false,
                message: "ATM 正在退出，手机同步已停止",
            },
            Feature::Dispatch => Unavailable {
                code: "DISPATCH_UNAVAILABLE",
                status: 404,
                retryable: false,
                message: "ATM 正在退出，Claude 派单已停止",
            },
        }
    }
    fn failed(self) -> Unavailable {
        match self {
            Feature::Sync => Unavailable {
                code: "SYNC_UNAVAILABLE",
                status: 404,
                retryable: false,
                message: "手机同步没能启动（原因见日志），重启 ATM 后再试",
            },
            Feature::Dispatch => Unavailable {
                code: "DISPATCH_UNAVAILABLE",
                status: 404,
                retryable: false,
                message: "Claude 派单没能启动（原因见日志），重启 ATM 后再试",
            },
        }
    }
}

enum Slot<T> {
    Starting,
    Ready(T),
    Failed,
}

impl<T: Clone> Slot<T> {
    fn get(&self) -> Option<Result<T, ()>> {
        match self {
            Slot::Starting => None,
            Slot::Ready(t) => Some(Ok(t.clone())),
            Slot::Failed => Some(Err(())),
        }
    }
}

struct State {
    sync: Slot<Arc<dyn SyncSettings>>,
    dispatch: Slot<Dispatcher>,
    closing: bool,
}

/// 两个功能的状态槽：设置页、任务抽屉与收尾共用。
pub struct Features {
    state: Mutex<State>,
    changed: Condvar,
    wait: Duration,
    /// 后台启动线程：收尾时等它做完（它碰服务，撤下入口之后不能再有业务写入）。
    starter: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl Features {
    /// 两个功能都在启动中。`wait` 是路由等功能起来的上限（正式是 [`FEATURE_WAIT`]）。
    pub fn new(wait: Duration) -> Arc<Features> {
        Arc::new(Features {
            state: Mutex::new(State {
                sync: Slot::Starting,
                dispatch: Slot::Starting,
                closing: false,
            }),
            changed: Condvar::new(),
            wait,
            starter: Mutex::new(None),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 正在退出就不要了（返回 false，调用方自己停掉）。
    fn settle_dispatch(&self, d: Option<Dispatcher>) -> bool {
        let mut s = self.lock();
        if s.closing {
            return false;
        }
        s.dispatch = d.map_or(Slot::Failed, Slot::Ready);
        self.changed.notify_all();
        true
    }

    fn settle_sync(&self, c: Option<Arc<dyn SyncSettings>>) -> bool {
        let mut s = self.lock();
        if s.closing {
            return false;
        }
        s.sync = c.map_or(Slot::Failed, Slot::Ready);
        self.changed.notify_all();
        true
    }

    fn closing(&self) -> bool {
        self.lock().closing
    }

    fn take<T: Clone>(
        &self,
        feature: Feature,
        pick: impl Fn(&State) -> Option<Result<T, ()>>,
    ) -> Result<T, Unavailable> {
        let deadline = Instant::now() + self.wait;
        let mut s = self.lock();
        loop {
            if s.closing {
                return Err(feature.closing());
            }
            match pick(&s) {
                Some(Ok(t)) => return Ok(t),
                Some(Err(())) => return Err(feature.failed()),
                None => {}
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(feature.starting());
            }
            s = self
                .changed
                .wait_timeout(s, deadline - now)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }

    /// 设置页的手机同步：起来了就交出；还在启动先等，等不到回 503；起不来、正在退出回 404。
    pub fn sync(&self) -> Result<Arc<dyn SyncSettings>, Unavailable> {
        self.take(Feature::Sync, |s| s.sync.get())
    }

    /// 派单器（设置页与任务抽屉）。
    pub fn dispatch(&self) -> Result<Dispatcher, Unavailable> {
        self.take(Feature::Dispatch, |s| s.dispatch.get())
    }

    /// 收尾：之后的调用一律回「正在退出」；等后台启动做完，停连接器（写离线状态），关派单器。可重复调用。
    pub fn close(&self) {
        let (sync, dispatch) = {
            let mut s = self.lock();
            s.closing = true;
            self.changed.notify_all();
            (
                std::mem::replace(&mut s.sync, Slot::Failed),
                std::mem::replace(&mut s.dispatch, Slot::Failed),
            )
        };
        let starter = self
            .starter
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(t) = starter {
            let _ = t.join();
        }
        if let Slot::Ready(c) = sync {
            c.stop();
        }
        if let Slot::Ready(d) = dispatch {
            d.close();
        }
    }
}

/// 后台启动线程退出时还没定下来的功能一律记为起不来（例如启动途中 panic）：界面不会一直等到 503。
struct SettleOnExit(Arc<Features>);

impl Drop for SettleOnExit {
    fn drop(&mut self) {
        let mut s = self.0.lock();
        if matches!(s.sync, Slot::Starting) {
            s.sync = Slot::Failed;
        }
        if matches!(s.dispatch, Slot::Starting) {
            s.dispatch = Slot::Failed;
        }
        self.0.changed.notify_all();
    }
}

/// 造并启动连接器：拿到派单器的端口（派单器起不来时是 `None`）。返回已经 `start` 过的连接器。
pub type MakeSync =
    Box<dyn FnOnce(Option<Arc<dyn DispatchPort>>) -> Result<Arc<dyn SyncSettings>, String> + Send>;

/// 在后台起两个功能（派单器先起，连接器拿它的端口），起好的放进 `features`。
pub fn start(features: &Arc<Features>, dispatch: Options, make_sync: MakeSync, log: Arc<dyn Log>) {
    let f = features.clone();
    let thread_log = log.clone();
    let spawned = std::thread::Builder::new()
        .name("atm-mobile-start".into())
        .spawn(move || {
            let _settle = SettleOnExit(f.clone());
            let dispatcher = match Dispatcher::new(dispatch) {
                Ok(d) => {
                    d.start();
                    if f.settle_dispatch(Some(d.clone())) {
                        Some(d)
                    } else {
                        // 起来时宿主已经在收尾：直接关掉，不留给没人管的派单器。
                        d.close();
                        return;
                    }
                }
                Err(e) => {
                    thread_log.error("Claude 派单没有启动", &json!({ "error": e.to_string() }));
                    f.settle_dispatch(None);
                    None
                }
            };
            if f.closing() {
                return;
            }
            let port = dispatcher
                .clone()
                .map(|d| Arc::new(d) as Arc<dyn DispatchPort>);
            match make_sync(port) {
                Ok(c) => {
                    if let Some(d) = &dispatcher {
                        let weak = Arc::downgrade(&c);
                        d.on_change(Arc::new(move |project: Option<&str>| {
                            if let Some(c) = weak.upgrade() {
                                c.mark_dirty(project);
                            }
                        }));
                    }
                    if !f.settle_sync(Some(c.clone())) {
                        c.stop();
                    }
                }
                Err(e) => {
                    thread_log.error("手机同步没有启动", &json!({ "error": e }));
                    f.settle_sync(None);
                }
            }
        });
    match spawned {
        Ok(t) => *features.starter.lock().unwrap_or_else(|e| e.into_inner()) = Some(t),
        Err(e) => {
            log.error(
                "起不了手机功能的启动线程",
                &json!({ "error": e.to_string() }),
            );
            features.settle_dispatch(None);
            features.settle_sync(None);
        }
    }
}
