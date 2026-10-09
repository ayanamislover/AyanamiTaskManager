//! 开发用的无头运行时（W4i）：端到端交接用例与本机联调拉起它。不进安装包；正式宿主（atm-host，W5a 起）链接同一个库。
//!
//! ```text
//! atm-runtime --n <新根> --legacy <旧根> [--version 3.0.0-dev]
//!             [--txn-start <txn> --install-root <安装根>] [--background]
//!             [--drill-pace-ms <n>] [--drill-hold-at <阶段>]
//! ```
//!
//! 两个根都必须显式给出，并且不能与真实的数据根、安装根重叠（[`atm_runtime::guard`]）：开发二进制不碰真实数据。
//!
//! 退出码：2 参数不对；3 另一个实例持有准入；4 旧版未静止；5 启动失败。入口开着或处于数据源冲突时一直运行。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use atm_runtime::{Background, BootError, Drill, Event, Handoff, Options, Started};
use atm_store::conversion::Quiesce;

fn usage(why: &str) -> ! {
    eprintln!("atm-runtime: {why}");
    std::process::exit(2);
}

fn main() {
    let mut args = std::env::args().skip(1);
    let (mut n, mut legacy, mut txn, mut install_root) = (None, None, None, None);
    let mut version = "3.0.0-dev".to_string();
    let mut drill = Drill::default();
    while let Some(arg) = args.next() {
        let mut value = || {
            args.next()
                .unwrap_or_else(|| usage(&format!("{arg} needs a value")))
        };
        match arg.as_str() {
            "--n" => n = Some(PathBuf::from(value())),
            "--legacy" => legacy = Some(PathBuf::from(value())),
            "--version" => version = value(),
            "--txn-start" => txn = Some(value()),
            "--install-root" => install_root = Some(PathBuf::from(value())),
            "--background" => {}
            "--drill-pace-ms" => {
                let ms: u64 = value()
                    .parse()
                    .unwrap_or_else(|_| usage("bad --drill-pace-ms"));
                drill.pace = Some(Duration::from_millis(ms));
            }
            "--drill-hold-at" => drill.hold_at = Some(value()),
            other => usage(&format!("unknown argument {other}")),
        }
    }
    let n = n.unwrap_or_else(|| usage("--n is required"));
    let legacy = legacy.unwrap_or_else(|| usage("--legacy is required"));
    // 在任何文件系统写入之前：三个根都不能碰到真实的根，彼此也不能重叠（W4i peer r1 P1-01）；
    // 根里已有的树也不能有链接，否则写入会经它离开比较过的位置（peer r2 P1-01）。
    let mut given: Vec<(&str, &std::path::Path)> = vec![("--n", &n), ("--legacy", &legacy)];
    if let Some(root) = &install_root {
        given.push(("--install-root", root));
    }
    if let Err(why) =
        atm_runtime::guard::refuse_overlaps(&given, &atm_runtime::guard::protected_roots())
            .and_then(|()| atm_runtime::guard::refuse_links(&given))
    {
        usage(&why);
    }
    // txn 拼进见证的文件名：只能是单独一层（W4i peer r3 P1-01）。
    if txn
        .as_deref()
        .is_some_and(|t| !atm_install_state::is_path_name(t))
    {
        usage("refusing --txn-start: it is not a transaction id");
    }
    let handoff = match (txn, install_root) {
        (Some(txn), Some(install_root)) => Some(Handoff { txn, install_root }),
        (None, None) => None,
        _ => usage("--txn-start and --install-root go together"),
    };
    let observe: Arc<dyn Fn(Event) + Send + Sync> = Arc::new(|e| eprintln!("atm-runtime: {e:?}"));
    let options = Options {
        n,
        legacy,
        version,
        handoff,
        // 联调里旧版由用例自己控制：旧根里没有存活的 lease 就算静止。
        quiesce: Box::new(|| Quiesce::Quiet),
        allow_real_data_root: false,
        real_data_root: None,
        secrets_check: Some(atm_runtime::secrets::check),
        sweep_every: Duration::from_secs(60),
        drill,
        observe: observe.clone(),
        notify: None,
        maintenance: false,
        metrics_capture: false,
    };
    let started = match atm_runtime::start(&options) {
        Ok(started) => started,
        Err(e) => {
            eprintln!("atm-runtime: {e}");
            std::process::exit(match e {
                BootError::AlreadyRunning => 3,
                BootError::WaitLegacyQuiesce(_) => 4,
                BootError::Failed(_) => 5,
            });
        }
    };
    match started {
        Started::Serving(serving) => {
            eprintln!("atm-runtime: serving on 127.0.0.1:{}", serving.port());
            if let Some(outcome) = serving.background(Duration::MAX) {
                match outcome {
                    Background::Unchanged => {}
                    Background::Conflict(state) => {
                        eprintln!("atm-runtime: SOURCE_CONFLICT: {}", state.reason)
                    }
                    Background::Failed(e) => eprintln!("atm-runtime: {e}"),
                }
            }
            park(serving);
        }
        Started::Conflict(conflicted) => {
            eprintln!("atm-runtime: SOURCE_CONFLICT: {}", conflicted.state.reason);
            park(conflicted);
        }
    }
}

/// 一直运行，持有准入（由 setup 或用例按身份结束）。
fn park<T>(_held: T) -> ! {
    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}
