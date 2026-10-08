//! ATM 3 的无头运行时（W4i）：准入 → 启动判定 / 转换 → 权威判定 → 发布入口 → 调度。
//!
//! 顺序是硬约束（07 §2–§7）：
//! - 拿到准入（`N\runtime\service.lock` + 旧版已静止）之前什么都不做；
//! - 走到 PUBLISHED、并且权威判定放行之前不起任何入口：不起 HTTP、不写 daemon.json、不起调度器；
//! - `A` 不是与 `M` 对得上的 v3，或这次的 `L` 不是 `M` 记下的转换源，先阻塞比较，再决定开不开入口；
//! - 数据源冲突时只写 `N\runtime\startup-state.json`，入口一个都不开；后台比较发现冲突时先撤下入口，再写它。
//!
//! 转换与阻塞比较期间把进度写给 setup（[`progress::Reporter`]）；健康只认 SERVICE_HEALTHY 见证（[`entries`]）。

pub mod entries;
pub mod jobs;
pub mod liveness;
pub mod progress;
pub mod rng;
pub mod secrets;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use atm_install_state::procs;
use atm_store::conversion::{
    self as cv, AdmitError, Admission, AuthorityState, Comparison, CompareOptions, Layout,
    Manifest, Quiesce, RunOptions, Seal, Startup, StartupState, Verdict,
};

pub use progress::Drill;

/// setup 拉起本进程时给的交接信息（`--txn-start`）。
#[derive(Clone, Debug)]
pub struct Handoff {
    pub txn: String,
    /// 安装根：见证写在 `<installRoot>\state\health\service-<txn>.json`。
    pub install_root: PathBuf,
}

/// 本进程的身份，按 setup 读回来的同一口径。
#[derive(Clone, Debug)]
pub struct Me {
    pub pid: u32,
    /// .NET 刻度（lease 的 `createdAtTicks`）。
    pub created_ticks: u64,
    /// Unix 毫秒（见证与进度的 `startedAtMs` / `process_created_at`）。
    pub started_at_ms: u64,
}

impl Me {
    pub fn current() -> Me {
        let me = procs::find(std::process::id()).expect("this process is visible to itself");
        Me {
            pid: me.pid,
            created_ticks: procs::filetime_to_dotnet_ticks(me.created),
            started_at_ms: me.started_at_ms(),
        }
    }
}

/// 启动过程中可观察的节点，按发生顺序报给 [`Options::observe`]。用例用它核对顺序。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    Admitted,
    /// 一次转换走到了 PUBLISHED（含全新安装与补写 PUBLISHED）。
    Published,
    /// 开放入口之前的阻塞比较开始。
    BlockingCompare,
    /// 入口开放之后的后台比较开始。
    BackgroundCompare,
    Lease,
    Http,
    Descriptor,
    Witness,
    Scheduler,
    /// 入口全部撤下（后台比较发现冲突）。
    Withdrawn,
    /// 写下了数据源冲突的启动状态。
    Conflict,
}

pub struct Options {
    /// 新根 `N`。
    pub n: PathBuf,
    /// 旧根 `L`。
    pub legacy: PathBuf,
    pub version: String,
    pub handoff: Option<Handoff>,
    /// 旧版是否静止（07 §2 第 2 条）。
    pub quiesce: Box<dyn Fn() -> Quiesce + Send + Sync>,
    pub allow_real_data_root: bool,
    pub real_data_root: Option<PathBuf>,
    pub secrets_check: Option<fn(&[u8]) -> bool>,
    pub sweep_every: Duration,
    pub drill: Drill,
    pub observe: Arc<dyn Fn(Event) + Send + Sync>,
}

#[derive(Debug)]
pub enum BootError {
    /// 另一个实例持有准入（F7）。
    AlreadyRunning,
    /// 旧版还没静止：不转换、不发布。
    WaitLegacyQuiesce(String),
    Failed(String),
}

impl std::fmt::Display for BootError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BootError::AlreadyRunning => write!(f, "another instance holds the admission"),
            BootError::WaitLegacyQuiesce(why) => write!(f, "WAIT_LEGACY_QUIESCE: {why}"),
            BootError::Failed(why) => write!(f, "{why}"),
        }
    }
}

fn failed(e: impl std::fmt::Display) -> BootError {
    BootError::Failed(e.to_string())
}

/// 后台比较的结论。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Background {
    /// 不变（或 `L` 不在了）：照常服务。
    Unchanged,
    /// 变了或 UNKNOWN：入口已撤下，启动状态已写。
    Conflict(StartupState),
    /// 撤下入口之后写启动状态失败。
    Failed(String),
}

/// 入口开着。持有准入直到被丢弃。
pub struct Serving {
    _admission: Admission,
    entries: Arc<Mutex<Option<entries::Entries>>>,
    background: Option<mpsc::Receiver<Background>>,
    /// 后台比较线程与它的取消标志：停下时先让它不再动手，等它结束，再撤入口。
    compare: Option<(std::thread::JoinHandle<()>, Arc<AtomicBool>)>,
    port: u16,
    instance_id: String,
    lease_generation: u64,
    generation: String,
}

/// 数据源冲突：入口一个都没开，持有准入，等用户在窗口里选（W5/W6 接界面）。
pub struct Conflicted {
    _admission: Admission,
    pub state: StartupState,
}

pub enum Started {
    Serving(Serving),
    Conflict(Conflicted),
}

impl Serving {
    pub fn port(&self) -> u16 {
        self.port
    }
    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }
    pub fn lease_generation(&self) -> u64 {
        self.lease_generation
    }
    /// 发布物的 generation（`M.generation`）。
    pub fn generation(&self) -> &str {
        &self.generation
    }

    /// 后台比较的结论；没有后台比较（启动时已经阻塞比较过）或等不到时 `None`。
    pub fn background(&self, timeout: Duration) -> Option<Background> {
        self.background.as_ref()?.recv_timeout(timeout).ok()
    }

    /// 撤下入口（测试与正常退出用）。
    pub fn stop(mut self, observe: &(dyn Fn(Event) + Send + Sync)) {
        if let Some((thread, cancel)) = self.compare.take() {
            cancel.store(true, Ordering::SeqCst);
            let _ = thread.join();
        }
        if let Some(e) = self.entries.lock().unwrap().take() {
            e.withdraw(observe);
        }
    }
}

fn now_iso() -> String {
    atm_install_state::startup::iso_utc(atm_install_state::handoff::now_ms())
}

/// 启动到「入口开着」或「数据源冲突」为止。判定最多绕 8 圈（封存 → 重转 → 再判定），绕不完就是有缺陷，报失败。
pub fn start(o: &Options) -> Result<Started, BootError> {
    let layout = Layout::new(&o.n);
    let admission = cv::admit(&layout, || (o.quiesce)()).map_err(|e| match e {
        AdmitError::AlreadyRunning => BootError::AlreadyRunning,
        AdmitError::WaitLegacyQuiesce(why) => BootError::WaitLegacyQuiesce(why),
        AdmitError::Io(e) => failed(e),
    })?;
    (o.observe)(Event::Admitted);
    let me = Me::current();
    let txn = o.handoff.as_ref().map_or("", |h| h.txn.as_str());
    let reporter = progress::Reporter::new(o.n.clone(), txn, me.started_at_ms, o.drill.clone());
    let report = |phase: &str, done: usize, total: usize, work: u64| {
        reporter.report(phase, done, total, work)
    };
    for _ in 0..8 {
        let at = now_iso();
        let legacy_exists = std::fs::symlink_metadata(&o.legacy).is_ok();
        let m = match cv::decide(&layout, legacy_exists) {
            Startup::ResumeSeal => {
                // 续做时以意图文件里记下的种类为准，这里给的种类不用。
                cv::seal(&layout, Seal::Quarantine, &at).map_err(failed)?;
                continue;
            }
            Startup::Quarantine { reason } => {
                eprintln!("atm-runtime: quarantining the publication: {reason}");
                cv::seal(&layout, Seal::Quarantine, &at).map_err(failed)?;
                continue;
            }
            Startup::FreshInstall => {
                let g = rng::ulid();
                reporter.set_generation(Some(&g));
                cv::fresh_install(&layout, &g, &at).map_err(failed)?;
                (o.observe)(Event::Published);
                continue;
            }
            Startup::FinishPublishing { generation } => {
                reporter.set_generation(Some(&generation));
                cv::finish_publishing(&layout, &at).map_err(failed)?;
                (o.observe)(Event::Published);
                continue;
            }
            step @ (Startup::FirstConversion | Startup::Restart { .. }) => {
                if let Startup::Restart { generation } = step {
                    cv::discard_attempt(&layout, &generation).map_err(failed)?;
                }
                let g = rng::ulid();
                reporter.set_generation(Some(&g));
                cv::run(
                    &layout,
                    RunOptions {
                        at: &at,
                        generation: &g,
                        legacy_root: &o.legacy,
                        allow_real_data_root: o.allow_real_data_root,
                        real_data_root: o.real_data_root.as_deref(),
                        secrets_check: o.secrets_check,
                        accept_unconvertible: &[],
                        hook: &mut |_| true,
                        progress: Some(&report),
                    },
                )
                .map_err(failed)?;
                (o.observe)(Event::Published);
                continue;
            }
            Startup::SourceConflict(state) => {
                (o.observe)(Event::Conflict);
                return Ok(Started::Conflict(Conflicted {
                    _admission: admission,
                    state,
                }));
            }
            Startup::Published(m) => m,
        };
        reporter.set_generation(Some(&m.generation));
        let a = cv::read_authority(&layout);
        if !cv::must_compare_before_serving(&a, &m, &o.legacy) {
            return serve(o, layout, admission, me, m, Some(a));
        }
        (o.observe)(Event::BlockingCompare);
        let cmp = compare(&layout, &m, &a, o, Some(&report));
        match cv::judge(&a, &m, &o.legacy, &cmp) {
            Verdict::Serve => {}
            Verdict::ResumeAfterRollback => {
                let AuthorityState::Present(prev) = &a else {
                    return Err(failed("resume after rollback without an authority record"));
                };
                cv::resume_after_rollback(&layout, prev, &at).map_err(failed)?;
            }
            Verdict::Reconvert => {
                cv::choose_legacy(&layout, &at).map_err(failed)?;
                continue;
            }
            Verdict::Conflict(why) => {
                let state = cv::enter_conflict(&layout, &m, &why, &at).map_err(failed)?;
                (o.observe)(Event::Conflict);
                return Ok(Started::Conflict(Conflicted {
                    _admission: admission,
                    state,
                }));
            }
        }
        return serve(o, layout, admission, me, m, None);
    }
    Err(failed("the startup decision did not settle after 8 rounds"))
}

fn compare(
    layout: &Layout,
    m: &Manifest,
    a: &AuthorityState,
    o: &Options,
    progress: Option<cv::ProgressFn<'_>>,
) -> Comparison {
    let prev = match a {
        AuthorityState::Present(a) => Some(a),
        _ => None,
    };
    cv::compare(
        layout,
        m,
        cv::baseline(m, prev),
        &CompareOptions {
            legacy_root: &o.legacy,
            allow_real_data_root: o.allow_real_data_root,
            real_data_root: o.real_data_root.as_deref(),
            secrets_check: o.secrets_check,
            progress,
        },
    )
}

/// 开放入口。`background` 是要在后台比较时用的 `A`（启动时已经阻塞比较过就是 `None`）。
fn serve(
    o: &Options,
    layout: Layout,
    admission: Admission,
    me: Me,
    m: Manifest,
    background: Option<AuthorityState>,
) -> Result<Started, BootError> {
    let opened = entries::publish(&entries::Publish {
        layout: &layout,
        version: &o.version,
        generation: &m.generation,
        handoff: o.handoff.as_ref(),
        me: &me,
        sweep_every: o.sweep_every,
        observe: &*o.observe,
    })
    .map_err(BootError::Failed)?;
    let (port, instance_id, lease_generation) = (
        opened.port(),
        opened.instance_id().to_string(),
        opened.lease_generation(),
    );
    let entries = Arc::new(Mutex::new(Some(opened)));
    let mut compare_thread = None;
    let receiver = background.map(|a| {
        let (tx, rx) = mpsc::channel();
        let cancel = Arc::new(AtomicBool::new(false));
        let cancelled = cancel.clone();
        let entries = entries.clone();
        let observe = o.observe.clone();
        let opts = Options {
            n: o.n.clone(),
            legacy: o.legacy.clone(),
            version: o.version.clone(),
            handoff: None,
            quiesce: Box::new(|| Quiesce::Quiet),
            allow_real_data_root: o.allow_real_data_root,
            real_data_root: o.real_data_root.clone(),
            secrets_check: o.secrets_check,
            sweep_every: o.sweep_every,
            drill: Drill::default(),
            observe: o.observe.clone(),
        };
        let m = m.clone();
        let thread = std::thread::Builder::new()
            .name("atm-compare".into())
            .spawn(move || {
                observe(Event::BackgroundCompare);
                let layout = Layout::new(&opts.n);
                let cmp = compare(&layout, &m, &a, &opts, None);
                if cancelled.load(Ordering::SeqCst) {
                    return;
                }
                let outcome = match cv::judge(&a, &m, &opts.legacy, &cmp) {
                    Verdict::Conflict(why) => {
                        // 先撤下入口（之后不再有业务写入），再写启动状态；发现之前写进 3.0 的数据留在 3.0 这一边。
                        if let Some(e) = entries.lock().unwrap().take() {
                            e.withdraw(&*observe);
                        }
                        match cv::enter_conflict(&layout, &m, &why, &now_iso()) {
                            Ok(state) => {
                                observe(Event::Conflict);
                                Background::Conflict(state)
                            }
                            Err(e) => Background::Failed(e.to_string()),
                        }
                    }
                    _ => Background::Unchanged,
                };
                let _ = tx.send(outcome);
            })
            .expect("spawn the compare thread");
        compare_thread = Some((thread, cancel));
        rx
    });
    Ok(Started::Serving(Serving {
        _admission: admission,
        entries,
        background: receiver,
        compare: compare_thread,
        port,
        instance_id,
        lease_generation,
        generation: m.generation,
    }))
}
