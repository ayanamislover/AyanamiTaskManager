//! 启动进度（07 §8）：转换与阻塞比较每推进一批，写一次 `N\runtime\startup-progress.json` 交给 setup。
//! 进度只说明「还在干活」，永远不是健康证明。

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use atm_install_state::startup::{self, Counter, StartupProgress};

/// 联调用的注入（只有开发用的无头二进制会设；正式宿主不设）。
#[derive(Clone, Debug, Default)]
pub struct Drill {
    /// 每报一次进度先睡这么久：把小样本的转换拉长，好验证接管与超时。
    pub pace: Option<Duration>,
    /// 进度报到这个阶段就不再报、也不再往下走（模拟卡住）。
    pub hold_at: Option<String>,
}

/// 同一阶段两次落盘的最小间隔：进度很密时不必每次都写。
const MIN_WRITE: Duration = Duration::from_millis(200);

pub struct Reporter {
    n: PathBuf,
    txn: String,
    pid: u32,
    created_ms: u64,
    drill: Drill,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    generation: Option<String>,
    phase: String,
    written: Option<Instant>,
}

impl Reporter {
    /// `txn` 是 setup 拉起本进程的事务（`--txn-start`）；没有就是空串，setup 不会接受它。
    pub fn new(n: PathBuf, txn: &str, created_ms: u64, drill: Drill) -> Reporter {
        Reporter {
            n,
            txn: txn.to_string(),
            pid: std::process::id(),
            created_ms,
            drill,
            state: Mutex::new(State::default()),
        }
    }

    pub fn set_generation(&self, generation: Option<&str>) {
        self.state.lock().unwrap().generation = generation.map(str::to_string);
    }

    /// 进入数据源冲突：告诉等着的 setup「在等用户选」（[`startup::AWAITING_USER`]），不是卡住。
    /// 不走联调注入，也不受落盘间隔限制：这是这个进程的最后一条进度。
    pub fn awaiting_user(&self) {
        let mut state = self.state.lock().unwrap();
        self.write(&state, startup::AWAITING_USER, 0, 0, 0);
        state.phase = startup::AWAITING_USER.to_string();
        state.written = Some(Instant::now());
    }

    fn write(&self, state: &State, phase: &str, done: usize, total: usize, work: u64) {
        let progress = StartupProgress {
            txn: self.txn.clone(),
            pid: self.pid,
            process_created_at: self.created_ms,
            generation: state.generation.clone(),
            phase: phase.to_string(),
            progress: Counter {
                done: done as u64,
                total: total as u64,
                work,
            },
            updated_at: atm_install_state::handoff::now_ms(),
        };
        // 写不下只是让 setup 少一条推进的证据；不能因此中断转换。
        let _ = startup::write_progress(&self.n, &progress);
    }

    /// 转换 / 比较的进度回调（`atm_store::progress::ProgressFn`）。
    pub fn report(&self, phase: &str, done: usize, total: usize, work: u64) {
        if self.drill.hold_at.as_deref() == Some(phase) {
            loop {
                std::thread::sleep(Duration::from_secs(3600));
            }
        }
        if let Some(pace) = self.drill.pace {
            std::thread::sleep(pace);
        }
        let mut state = self.state.lock().unwrap();
        let due = state.phase != phase || state.written.is_none_or(|t| t.elapsed() >= MIN_WRITE);
        if !due {
            return;
        }
        self.write(&state, phase, done, total, work);
        state.phase = phase.to_string();
        state.written = Some(Instant::now());
    }
}
