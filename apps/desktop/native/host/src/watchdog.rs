//! 看门狗与心跳（W5g；方案 §5「挂住检测」，06 T-LIFE）。
//!
//! 单进程不做进程内重启：挂住就记一条 `watchdog.stall` 再结束进程，交给入口（开始菜单、登录、
//! agent-wake、保活计划任务）重新拉起；下次启动报 `previous.unclean`，`previousEvent` 是 `watchdog.stall`。
//!
//! 看两样：
//! - **事件循环**：每 `tick` 往事件循环发一个 ping，事件循环处理它时记下当时的时刻；超过阈值没有
//!   记下新的，就是事件循环挂住了。
//! - **写线程**：正在执行的写作业已经跑了多久。作业有自己的预算（超了 SQL 会被当场中断），所以判定是
//!   「超过它自己的预算再加阈值还没结束」——那是卡在 Rust 或 FFI 里了，中断也救不回来。
//!
//! 每分钟记一次心跳（带工作集大小），这样 lifecycle 状态最多一分钟就会被刷新。

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::json;

use crate::lifecycle::{Event, Lifecycle};

pub const TICK: Duration = Duration::from_secs(10);
pub const HEARTBEAT: Duration = Duration::from_secs(60);
pub const THRESHOLD: Duration = Duration::from_secs(120);
/// 看门狗结束进程用的退出码（与 abort 一样表示异常结束）。
pub const STALL_EXIT_CODE: u32 = 3;

/// 事件循环的脉搏：事件循环处理 ping 时调 [`Pulse::beat`]。
pub struct Pulse {
    base: Instant,
    last_ms: AtomicU64,
}

impl Pulse {
    pub fn new() -> Arc<Pulse> {
        Arc::new(Pulse {
            base: Instant::now(),
            last_ms: AtomicU64::new(0),
        })
    }

    pub fn beat(&self) {
        self.last_ms
            .store(self.base.elapsed().as_millis() as u64, Ordering::SeqCst);
    }

    fn since_last(&self) -> Duration {
        let now = self.base.elapsed().as_millis() as u64;
        Duration::from_millis(now.saturating_sub(self.last_ms.load(Ordering::SeqCst)))
    }
}

/// 判定：`(哪一样, 挂了多久)`；都没挂住是 `None`。`writer` 是正在执行的写作业 `(已跑的时间, 它的预算)`。
pub fn verdict(
    since_pong: Duration,
    writer: Option<(Duration, Duration)>,
    threshold: Duration,
) -> Option<(&'static str, Duration)> {
    if since_pong > threshold {
        return Some(("event-loop", since_pong));
    }
    match writer {
        Some((elapsed, budget)) if elapsed > budget + threshold => Some(("writer", elapsed)),
        _ => None,
    }
}

/// 工作集大小（字节）。读不到是 `None`。
pub fn working_set() -> Option<u64> {
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    let mut counters: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
    counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    let ok = unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) };
    (ok != 0).then_some(counters.WorkingSetSize as u64)
}

pub struct Config {
    pub tick: Duration,
    pub heartbeat: Duration,
    pub threshold: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            tick: TICK,
            heartbeat: HEARTBEAT,
            threshold: THRESHOLD,
        }
    }
}

/// 看门狗要的外部输入。
pub struct Probes {
    /// 往事件循环发一个 ping（事件循环处理时调 `pulse.beat()`）。
    pub ping: Box<dyn Fn() + Send>,
    pub pulse: Arc<Pulse>,
    /// 正在执行的写作业 `(已跑的时间, 预算)`；服务不在或空闲时 `None`。
    pub writer: Box<dyn Fn() -> Option<(Duration, Duration)> + Send>,
    /// 判定挂住之后做什么（正式运行：记下诊断后结束进程）。
    pub on_stall: Box<dyn Fn(&'static str, Duration) + Send>,
}

pub struct Watchdog {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Watchdog {
    pub fn start(lifecycle: &'static Lifecycle, probes: Probes, config: Config) -> Watchdog {
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let stop = stop.clone();
            std::thread::Builder::new()
                .name("atm-watchdog".into())
                .spawn(move || {
                    probes.pulse.beat();
                    let mut last_heartbeat = Instant::now();
                    loop {
                        (probes.ping)();
                        let deadline = Instant::now() + config.tick;
                        while Instant::now() < deadline {
                            if stop.load(Ordering::SeqCst) {
                                return;
                            }
                            std::thread::sleep(Duration::from_millis(100).min(config.tick));
                        }
                        if let Some((what, stalled)) = verdict(
                            probes.pulse.since_last(),
                            (probes.writer)(),
                            config.threshold,
                        ) {
                            lifecycle.record(
                                Event::WatchdogStall,
                                &[
                                    ("reason", json!(what)),
                                    ("stalledMs", json!(stalled.as_millis() as u64)),
                                ],
                            );
                            (probes.on_stall)(what, stalled);
                            return;
                        }
                        if last_heartbeat.elapsed() >= config.heartbeat {
                            last_heartbeat = Instant::now();
                            let rss = working_set().map(|r| json!(r)).unwrap_or(json!(0));
                            lifecycle.record(Event::Heartbeat, &[("rss", rss)]);
                        }
                    }
                })
                .expect("spawn the watchdog thread")
        };
        Watchdog {
            stop,
            thread: Some(thread),
        }
    }

    pub fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// 正式的挂住处理：诊断已经记下，立刻结束进程（不跑析构：卡住的线程可能正拿着锁）。
pub fn terminate(_: &'static str, _: Duration) {
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, TerminateProcess};
    unsafe {
        TerminateProcess(GetCurrentProcess(), STALL_EXIT_CODE);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: fn(u64) -> Duration = Duration::from_secs;

    #[test]
    fn the_verdict_follows_the_threshold_and_the_job_budget() {
        let t = S(120);
        assert_eq!(verdict(S(10), None, t), None);
        assert_eq!(verdict(S(120), None, t), None);
        assert_eq!(verdict(S(121), None, t), Some(("event-loop", S(121))));
        // 写作业：自己的预算之外再给一个阈值。
        assert_eq!(verdict(S(1), Some((S(100), S(2))), t), None);
        assert_eq!(verdict(S(1), Some((S(122), S(2))), t), None);
        assert_eq!(
            verdict(S(1), Some((S(123), S(2))), t),
            Some(("writer", S(123)))
        );
        // 恢复这类大事务预算长，跑得久不算挂住。
        assert_eq!(verdict(S(1), Some((S(600), S(900))), t), None);
        // 两样都挂住时先报事件循环。
        assert_eq!(
            verdict(S(200), Some((S(500), S(2))), t),
            Some(("event-loop", S(200)))
        );
    }

    #[test]
    fn the_working_set_is_readable() {
        assert!(working_set().is_some_and(|r| r > 1024 * 1024));
    }
}
