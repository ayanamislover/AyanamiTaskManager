//! 会话用到的宿主能力（2.x `SessionHost`）：服务、派单、配置、日志与时钟。
//!
//! 会话停下（作废）以后，core 随后就会关库、关派单：迟到的步骤每次取服务或派单时都直接失败，不去碰已关闭的
//! 对象（2.x `guardedPort`）。配置的修改也只对当前会话生效——换空间、停止之后旧会话迟到的写入被丢弃。

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use atm_service::write::Service;
use serde_json::Value;

use crate::config::SyncConfig;
use crate::dispatch::DispatchPort;
use crate::errors::Failure;

/// 日志。meta 是结构化的附加信息；连接器会先抹掉密钥字面量再交给它。
pub trait Log: Send + Sync {
    fn info(&self, message: &str, meta: &Value);
    fn warn(&self, message: &str, meta: &Value);
    fn error(&self, message: &str, meta: &Value);
}

/// 什么都不记。
pub struct NoLog;

impl Log for NoLog {
    fn info(&self, _: &str, _: &Value) {}
    fn warn(&self, _: &str, _: &Value) {}
    fn error(&self, _: &str, _: &Value) {}
}

pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// 一轮同步循环的状态出口：配置读写、设备列表、待处理计数。
pub trait LoopState: Send + Sync {
    fn config(&self) -> SyncConfig;
    /// 改配置并落库；`mutate` 返回 `None` 表示不用改。会话已被替换时什么都不做。
    fn commit(
        &self,
        mutate: &mut dyn FnMut(&SyncConfig) -> Option<SyncConfig>,
    ) -> Result<(), Failure>;
    fn on_devices(&self, devices: Vec<Value>);
    fn on_pending(&self, count: usize);
}

pub const RETIRED: &str = "SYNC_SESSION_RETIRED";

#[derive(Clone)]
pub struct Host {
    service: Arc<Service>,
    dispatch: Option<Arc<dyn DispatchPort>>,
    retired: Arc<AtomicBool>,
    pub app_version: String,
    pub log: Arc<dyn Log>,
    pub now: Clock,
    pub state: Arc<dyn LoopState>,
}

impl Host {
    pub fn new(
        service: Arc<Service>,
        dispatch: Option<Arc<dyn DispatchPort>>,
        retired: Arc<AtomicBool>,
        app_version: String,
        log: Arc<dyn Log>,
        now: Clock,
        state: Arc<dyn LoopState>,
    ) -> Host {
        Host {
            service,
            dispatch,
            retired,
            app_version,
            log,
            now,
            state,
        }
    }

    fn check(&self) -> Result<(), Failure> {
        if self.retired.load(Ordering::SeqCst) {
            Err(Failure::Other(RETIRED.to_owned()))
        } else {
            Ok(())
        }
    }

    /// 服务；会话已作废时失败。
    pub fn service(&self) -> Result<&Service, Failure> {
        self.check()?;
        Ok(&self.service)
    }

    /// 派单（没有就是 `None`）；会话已作废时失败。
    pub fn dispatch(&self) -> Result<Option<&dyn DispatchPort>, Failure> {
        self.check()?;
        Ok(self.dispatch.as_deref())
    }

    pub fn now_ms(&self) -> i64 {
        (self.now)()
    }

    pub fn config(&self) -> SyncConfig {
        self.state.config()
    }

    pub fn commit(
        &self,
        mut mutate: impl FnMut(&SyncConfig) -> Option<SyncConfig>,
    ) -> Result<(), Failure> {
        self.state.commit(&mut mutate)
    }
}
