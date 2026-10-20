//! 托盘计数与系统通知（W5f，job `notify.observe`；2.0 `desktop-observer.ts`、`notification-policy.ts`）。
//!
//! 观察器常驻在入口里，与窗口无关：关窗（WebView 整个销毁）之后照样追事件、发通知、刷托盘。
//! 这里只决定「发什么」，弹 toast、画菜单由宿主做（[`Observation`] 交给宿主给的回调）。
//!
//! 规则与 2.0 相同：
//! - 方式（`notification.mode`）：OFF 什么都不发；ALL 发全部五种；CRITICAL 只发 `work.blocked`、
//!   `agent.recovered_stale`、`backup.failed`。
//! - 项目事件只看 ACTIVE 项目；同一项目、同一种事件、同一个 key 10 分钟内只发一次，去重表留 1 小时。
//! - 全局事件只看 `backup.failed`，同一个 key 在去重表里还在就不再发。
//! - 启动前发生的事不补发；托盘快照没变就不推。
//!
//! 唤醒靠存储写线程的作业计数（[`atm_store::Store::wait_for_writes`]），不轮询；另有一个长的兜底周期。

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use atm_domain::principal::{JobId, Principal};
use atm_service::observe::{FeedEvent, OBSERVE_MAX};
use atm_service::write::Service;

/// 同一项目、同一种事件、同一个 key 的通知间隔。
pub const PROJECT_DEDUP: Duration = Duration::from_secs(10 * 60);
/// 去重表里的条目留多久。
pub const DEDUP_RETENTION: Duration = Duration::from_secs(60 * 60);
/// 一轮最多读几页（每页 [`OBSERVE_MAX`] 条）；读不完的下一轮立刻接着读。
const PAGES_PER_STEP: usize = 20;

const SUPPORTED: [&str; 5] = [
    "work.waiting",
    "work.blocked",
    "work.completed",
    "agent.recovered_stale",
    "backup.failed",
];
const CRITICAL: [&str; 3] = ["work.blocked", "agent.recovered_stale", "backup.failed"];

/// 2.0 `shouldNotify`。
pub fn should_notify(mode: &str, kind: &str) -> bool {
    if mode == "OFF" || !SUPPORTED.contains(&kind) {
        return false;
    }
    mode == "ALL" || CRITICAL.contains(&kind)
}

fn project_title(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "work.waiting" => "任务正在等待",
        "work.blocked" => "任务受阻",
        "work.completed" => "任务已完成",
        "agent.recovered_stale" => "Agent 异常退出",
        _ => return None,
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Notice {
    pub title: String,
    pub body: String,
}

/// 托盘要画的那部分（待安装的更新由宿主自己补）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrayCounts {
    pub blocked: u64,
    pub waiting: u64,
    pub mode: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Observation {
    Notice(Notice),
    Tray(TrayCounts),
    /// 这一轮读失败了（下一轮照常重试）。只有错误码与说明，没有任务内容。
    Failed(String),
}

/// 观察器的状态：读到哪了、去重表、上次推给托盘的快照。与线程无关，测试直接驱动 [`Observer::step`]。
#[derive(Default)]
pub struct Observer {
    since: Option<i64>,
    dedup: HashMap<String, u64>,
    last: Option<TrayCounts>,
}

/// 一轮的结果。
pub struct Step {
    pub observations: Vec<Observation>,
    /// 还有没读完的事件：调用方不必等下一次唤醒。
    pub more: bool,
}

impl Observer {
    pub fn new() -> Self {
        Observer::default()
    }

    /// 读一轮：第一轮只记下当前末尾并推一次托盘；之后读新事件，按方式与去重决定发哪些通知，托盘快照变了才推。
    /// `now_ms` 是去重用的时钟（毫秒）。
    pub fn step(&mut self, svc: &Service, now_ms: u64) -> Step {
        let principal = Principal::system_job(JobId::NotifyObserve);
        let mut out = Vec::new();
        let mut tray = None;
        let mut more = false;
        for page in 0..PAGES_PER_STEP {
            let observed = match svc.observe(&principal, self.since, OBSERVE_MAX) {
                Ok(observed) => observed,
                Err(e) => {
                    out.push(Observation::Failed(format!(
                        "{}: {}",
                        e.code.as_str(),
                        e.message
                    )));
                    return Step {
                        observations: out,
                        more: false,
                    };
                }
            };
            // 第一轮（since 为 None）服务只给当前末尾、不给事件：启动前的事不补发。
            for event in &observed.events {
                if let Some(notice) = self.decide(observed.mode, event, now_ms) {
                    out.push(Observation::Notice(notice));
                }
            }
            self.since = Some(observed.next_seq);
            tray = Some(TrayCounts {
                blocked: observed.blocked,
                waiting: observed.waiting,
                mode: observed.mode,
            });
            if !observed.has_more {
                break;
            }
            more = page + 1 == PAGES_PER_STEP;
        }
        if let Some(tray) = tray
            && self.last.as_ref() != Some(&tray)
        {
            self.last = Some(tray.clone());
            out.push(Observation::Tray(tray));
        }
        Step {
            observations: out,
            more,
        }
    }

    fn decide(&mut self, mode: &str, event: &FeedEvent, now_ms: u64) -> Option<Notice> {
        match &event.project {
            None => {
                if event.kind != "backup.failed" || !should_notify(mode, &event.kind) {
                    return None;
                }
                let key = format!(
                    "global:{}:{}",
                    event.kind,
                    event.key.as_deref().unwrap_or_default()
                );
                if self.dedup.contains_key(&key) {
                    return None;
                }
                self.dedup.insert(key, now_ms);
                Some(Notice {
                    title: "备份失败".into(),
                    body: event.summary.clone(),
                })
            }
            Some(project) => {
                if !project.active {
                    return None;
                }
                let title = project_title(&event.kind)?;
                if !should_notify(mode, &event.kind) {
                    return None;
                }
                let key = format!(
                    "{}:{}:{}",
                    project.code,
                    event.kind,
                    event.key.as_deref().unwrap_or_default()
                );
                let window = PROJECT_DEDUP.as_millis() as u64;
                if self
                    .dedup
                    .get(&key)
                    .is_some_and(|at| *at > now_ms.saturating_sub(window))
                {
                    return None;
                }
                self.dedup.insert(key, now_ms);
                let retention = DEDUP_RETENTION.as_millis() as u64;
                self.dedup
                    .retain(|_, at| *at >= now_ms.saturating_sub(retention));
                let body = if !event.summary.is_empty() {
                    event.summary.clone()
                } else {
                    event.key.clone().unwrap_or_else(|| title.to_owned())
                };
                Some(Notice {
                    title: format!("{} · {title}", project.code),
                    body,
                })
            }
        }
    }
}

/// 交给宿主的回调。在观察器线程上调用，宿主自己转到 UI 线程。
pub type Sink = Arc<dyn Fn(Observation) + Send + Sync>;

/// 常驻的观察器线程。
pub struct Notifier {
    stop: Arc<AtomicBool>,
    svc: Arc<Service>,
    thread: JoinHandle<()>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

impl Notifier {
    /// 立刻读一轮（推一次托盘），之后每次有写作业执行完就读一轮；`fallback` 没有写入时也读一轮。
    pub fn start(svc: Arc<Service>, sink: Sink, fallback: Duration) -> Notifier {
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let (svc, stop) = (svc.clone(), stop.clone());
            std::thread::Builder::new()
                .name("atm-notify".into())
                .spawn(move || {
                    let mut observer = Observer::new();
                    loop {
                        // 先记下标记再读：读的过程中执行完的写入、以及停下时的叫醒，都会让下面的等待立刻返回。
                        let seen = svc.store().write_mark();
                        let step = observer.step(&svc, now_ms());
                        if stop.load(Ordering::SeqCst) {
                            break;
                        }
                        for observation in step.observations {
                            sink(observation);
                        }
                        if step.more {
                            continue;
                        }
                        if svc.store().wait_for_writes(seen, fallback).is_none()
                            || stop.load(Ordering::SeqCst)
                        {
                            break;
                        }
                    }
                })
                .expect("spawn the notify thread")
        };
        Notifier { stop, svc, thread }
    }

    /// 停下并等线程结束：返回之后不会再调用回调。
    pub fn stop(self) {
        self.stop.store(true, Ordering::SeqCst);
        self.svc.store().wake_waiters();
        let _ = self.thread.join();
    }
}
