//! 快照去抖（2.x `packages/sync/src/publish-scheduler.ts`）：项目有变化就标脏，1.5 s 去抖（持续变化时最多攒
//! 10 s）后只重建脏项目。没连上（包括默认的未启用）时只记一笔、不起计时器，连上后的首次同步会全量发布。
//!
//! 变化从哪来：存储写线程每执行完一个作业就动一下标记（[`atm_store::Store::wait_for_writes`]），观察线程醒来
//! 读全局流（3.0 的项目事件在同一个写事务里镜像进 `global_feed`），按事件所属的项目标脏；全局事件只影响
//! 项目列表或 head。派单的变化由派单层调用连接器的 `mark_dirty`。

use std::collections::BTreeSet;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use atm_domain::principal::{JobId, Principal};
use atm_service::observe::OBSERVE_MAX;
use atm_service::write::Service;

use crate::errors::Failure;

pub struct SchedulerHooks {
    /// 现在能不能发布（已连上且首次同步完成）。不能时只记下变化。
    pub ready: Box<dyn Fn() -> bool + Send + Sync>,
    /// 重建这些项目（顺带处理项目增删与 head）。
    pub publish: Box<dyn Fn(BTreeSet<String>) -> Result<(), Failure> + Send + Sync>,
    /// 发布失败时调用；返回 `true` 表示稍后重试。
    pub failed: Box<dyn Fn(&Failure) -> bool + Send + Sync>,
}

#[derive(Default)]
struct State {
    dirty: BTreeSet<String>,
    since: Option<Instant>,
    deadline: Option<Instant>,
    active: bool,
    /// 计时线程该退出了（连接器销毁）。
    closed: bool,
}

pub struct Scheduler {
    debounce: Duration,
    max_delay: Duration,
    retry: Duration,
    hooks: SchedulerHooks,
    state: Mutex<State>,
    changed: Condvar,
    /// 同一时刻只有一次 flush 在跑。
    flushing: Mutex<()>,
}

impl Scheduler {
    pub fn new(
        debounce: Duration,
        max_delay: Duration,
        retry: Duration,
        hooks: SchedulerHooks,
    ) -> Arc<Scheduler> {
        Arc::new(Scheduler {
            debounce,
            max_delay,
            retry,
            hooks,
            state: Mutex::new(State::default()),
            changed: Condvar::new(),
            flushing: Mutex::new(()),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn activate(&self) {
        self.lock().active = true;
    }

    /// 停止计时器。
    pub fn stop(&self) {
        let mut s = self.lock();
        s.active = false;
        s.deadline = None;
        self.changed.notify_all();
    }

    /// 计时线程退出。
    pub fn close(&self) {
        let mut s = self.lock();
        s.closed = true;
        s.active = false;
        s.deadline = None;
        self.changed.notify_all();
    }

    fn schedule(&self, s: &mut State, delay: Duration) {
        s.deadline = Some(Instant::now() + delay);
        self.changed.notify_all();
    }

    /// `project` 为 `None` 表示只影响项目列表或 head（例如全局事件、派单开关）。
    pub fn mark_dirty(&self, project: Option<&str>) {
        let mut s = self.lock();
        if let Some(code) = project {
            s.dirty.insert(code.to_uppercase());
        }
        if !s.active || !(self.hooks.ready)() {
            return;
        }
        let since = *s.since.get_or_insert_with(Instant::now);
        let waited = since.elapsed();
        let delay = self.debounce.min(self.max_delay.saturating_sub(waited));
        self.schedule(&mut s, delay);
    }

    /// 首次同步要全量发布：之前攒的变化作废。
    pub fn begin_full_publish(&self) {
        let mut s = self.lock();
        s.dirty.clear();
        s.since = None;
    }

    /// 首次同步完成：期间只记了一笔的变化补一次去抖发布。
    pub fn after_full_publish(&self) {
        let pending = !self.lock().dirty.is_empty();
        if pending {
            self.mark_dirty(None);
        }
    }

    pub fn has_timer(&self) -> bool {
        self.lock().deadline.is_some()
    }

    pub fn dirty(&self) -> BTreeSet<String> {
        self.lock().dirty.clone()
    }

    pub fn flush(&self) {
        let _one = self.flushing.lock().unwrap_or_else(|e| e.into_inner());
        let dirty = {
            let mut s = self.lock();
            s.deadline = None;
            if !s.active || !(self.hooks.ready)() {
                return;
            }
            s.since = None;
            std::mem::take(&mut s.dirty)
        };
        if let Err(e) = (self.hooks.publish)(dirty.clone()) {
            let retry = (self.hooks.failed)(&e);
            let mut s = self.lock();
            s.dirty.extend(dirty);
            if retry && s.active {
                self.schedule(&mut s, self.retry);
            }
        }
    }

    /// 计时线程：到点就 flush。
    pub fn spawn_timer(self: &Arc<Self>) -> JoinHandle<()> {
        let me = self.clone();
        std::thread::Builder::new()
            .name("atm-sync-publish".into())
            .spawn(move || {
                loop {
                    {
                        let mut s = me.lock();
                        loop {
                            if s.closed {
                                return;
                            }
                            match s.deadline {
                                Some(d) if Instant::now() >= d => {
                                    s.deadline = None;
                                    break;
                                }
                                Some(d) => {
                                    let wait = d - Instant::now();
                                    s = me
                                        .changed
                                        .wait_timeout(s, wait)
                                        .unwrap_or_else(|e| e.into_inner())
                                        .0;
                                }
                                None => {
                                    s = me.changed.wait(s).unwrap_or_else(|e| e.into_inner());
                                }
                            }
                        }
                    }
                    me.flush();
                }
            })
            .expect("spawn publish timer")
    }
}

/// 存储变化的观察线程：醒来读全局流，按事件所属的项目标脏。`stop` 置位后在下一次醒来时退出。
pub struct Watcher {
    stop: Arc<std::sync::atomic::AtomicBool>,
    service: Arc<Service>,
    thread: Option<JoinHandle<()>>,
}

impl Watcher {
    pub fn spawn(
        service: Arc<Service>,
        mark: Arc<dyn Fn(Option<String>) + Send + Sync>,
    ) -> Watcher {
        use std::sync::atomic::{AtomicBool, Ordering};
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let svc = service.clone();
        let thread = std::thread::Builder::new()
            .name("atm-sync-watch".into())
            .spawn(move || {
                let principal = Principal::system_job(JobId::SyncLoop);
                let mut since: Option<i64> = None;
                let mut mark_seen = svc.store().write_mark();
                loop {
                    if flag.load(Ordering::SeqCst) {
                        return;
                    }
                    // 一轮最多读 20 页；读不完下一轮立刻接着读。
                    let mut more = false;
                    for _ in 0..20 {
                        match svc.observe(&principal, since, OBSERVE_MAX) {
                            Ok(o) => {
                                for e in &o.events {
                                    mark(e.project.as_ref().map(|p| p.code.clone()));
                                }
                                since = Some(o.next_seq);
                                more = o.has_more;
                                if !o.has_more {
                                    break;
                                }
                            }
                            Err(_) => break,
                        }
                    }
                    if more {
                        continue;
                    }
                    match svc
                        .store()
                        .wait_for_writes(mark_seen, Duration::from_secs(30))
                    {
                        Some(m) => mark_seen = m,
                        None => return,
                    }
                }
            })
            .expect("spawn sync watcher");
        Watcher {
            stop,
            service,
            thread: Some(thread),
        }
    }

    pub fn stop(mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        self.service.store().wake_waiters();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}
