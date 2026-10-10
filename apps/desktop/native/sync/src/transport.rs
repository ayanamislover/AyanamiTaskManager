//! 中继请求的传输层：一次 HTTP 往返，外加可以从别的线程掐断的取消令牌。
//!
//! 客户端（[`crate::relay`]）只经 [`Transport`] 发请求：正式构建用 WinHTTP（[`crate::winhttp`]），
//! 用例用内存中继。取消有两层，与 2.x 的 `AbortSignal` 对应：
//!
//! - 会话的生命周期（[`RelayClient`](crate::relay::RelayClient) 构造时给）：停下时掐断这个会话的全部请求；
//! - 单次调用的（变更流的长轮询、退避等待）：只中断这一次。

use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// 一次请求。`url` 已经拼好查询串；`headers` 原样发出。
#[derive(Debug, Clone)]
pub struct HttpRequest {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: Option<Vec<u8>>,
    /// 整个往返（连接、发送、等响应、读正文）的上限。
    pub timeout: Duration,
}

impl HttpRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

#[derive(Debug, Clone, Default)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// 网络层失败。只带「是不是超时」和一个系统错误码名：系统给的报错文字可能夹带对端可控的内容
/// （例如证书错误里对方证书的名字），一律不取（2.x `relay-client.ts` 的 `networkError`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NetFailure {
    Timeout,
    /// 取消令牌已触发。
    Cancelled,
    /// 其它失败；`code` 是形如 `ERROR_WINHTTP_CANNOT_CONNECT` 的名字，认不出就是 `None`。
    Failed {
        code: Option<String>,
    },
}

pub trait Transport: Send + Sync {
    /// 发一个请求。`cancel` 里任一令牌触发时尽快返回 [`NetFailure::Cancelled`]。
    fn send(&self, request: &HttpRequest, cancel: &[&Cancel]) -> Result<HttpResponse, NetFailure>;
}

#[derive(Default)]
struct CancelState {
    cancelled: Mutex<bool>,
    changed: Condvar,
}

/// 取消令牌：克隆共享同一个状态，[`Cancel::cancel`] 之后永远是已取消。
#[derive(Clone, Default)]
pub struct Cancel(Arc<CancelState>);

impl std::fmt::Debug for Cancel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("Cancel").field(&self.is_cancelled()).finish()
    }
}

impl Cancel {
    pub fn new() -> Cancel {
        Cancel::default()
    }

    pub fn cancel(&self) {
        *self.0.cancelled.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.0.changed.notify_all();
    }

    pub fn is_cancelled(&self) -> bool {
        *self.0.cancelled.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 睡 `duration`；中途被取消返回 `false`。
    pub fn sleep(&self, duration: Duration) -> bool {
        let deadline = Instant::now() + duration;
        let mut cancelled = self.0.cancelled.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if *cancelled {
                return false;
            }
            let now = Instant::now();
            if now >= deadline {
                return true;
            }
            cancelled = self
                .0
                .changed
                .wait_timeout(cancelled, deadline - now)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }
}

/// 可替换的等待：睡 `duration`，被打断时返回 `false`。用例换成只记账、不真睡的实现。
pub type Sleeper = Arc<dyn Fn(Duration) -> bool + Send + Sync>;

/// 默认的等待：有令牌就可以被它打断。
pub fn sleeper(lifetime: Option<Cancel>) -> Sleeper {
    Arc::new(move |d| match &lifetime {
        Some(c) => c.sleep(d),
        None => {
            std::thread::sleep(d);
            true
        }
    })
}

/// 一组令牌里有没有已经取消的。
pub fn any_cancelled(cancel: &[&Cancel]) -> bool {
    cancel.iter().any(|c| c.is_cancelled())
}

/// 在另一个线程上跑一个阻塞的往返，本线程每 `TICK` 看一次取消令牌。取消（或过了 `deadline`）时立即返回，
/// 留下的线程由请求自己的超时收尾（它只持有自己建的句柄，与调用方不共享任何东西）。
pub fn run_cancellable<F>(
    cancel: &[&Cancel],
    deadline: Option<Duration>,
    job: F,
) -> Result<HttpResponse, NetFailure>
where
    F: FnOnce() -> Result<HttpResponse, NetFailure> + Send + 'static,
{
    const TICK: Duration = Duration::from_millis(25);
    if any_cancelled(cancel) {
        return Err(NetFailure::Cancelled);
    }
    let until = deadline.map(|d| Instant::now() + d);
    type Slot = (Mutex<Option<Result<HttpResponse, NetFailure>>>, Condvar);
    let slot: Arc<Slot> = Arc::new((Mutex::new(None), Condvar::new()));
    let filled = slot.clone();
    let spawned = std::thread::Builder::new()
        .name("atm-sync-http".into())
        .spawn(move || {
            let result = job();
            *filled.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(result);
            filled.1.notify_all();
        });
    if spawned.is_err() {
        return Err(NetFailure::Failed { code: None });
    }
    let mut result = slot.0.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        if let Some(done) = result.take() {
            return done;
        }
        if any_cancelled(cancel) {
            return Err(NetFailure::Cancelled);
        }
        if until.is_some_and(|u| Instant::now() >= u) {
            return Err(NetFailure::Timeout);
        }
        result = slot
            .1
            .wait_timeout(result, TICK)
            .unwrap_or_else(|e| e.into_inner())
            .0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cancelled_sleep_returns_early() {
        let c = Cancel::new();
        let other = c.clone();
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            other.cancel();
        });
        let started = Instant::now();
        assert!(!c.sleep(Duration::from_secs(30)));
        assert!(started.elapsed() < Duration::from_secs(5));
        t.join().unwrap();
        assert!(c.is_cancelled());
        assert!(!c.sleep(Duration::from_millis(1)));
    }

    #[test]
    fn a_cancelled_round_trip_does_not_wait_for_the_worker() {
        let c = Cancel::new();
        let other = c.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            other.cancel();
        });
        let started = Instant::now();
        let got = run_cancellable(&[&c], None, || {
            std::thread::sleep(Duration::from_secs(3));
            Ok(HttpResponse::default())
        });
        assert_eq!(got.unwrap_err(), NetFailure::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(2));
        let late = run_cancellable(&[], Some(Duration::from_millis(50)), || {
            std::thread::sleep(Duration::from_secs(3));
            Ok(HttpResponse::default())
        });
        assert_eq!(late.unwrap_err(), NetFailure::Timeout);
        let done = run_cancellable(&[], None, || {
            Ok(HttpResponse {
                status: 204,
                ..Default::default()
            })
        });
        assert_eq!(done.unwrap().status, 204);
    }
}
