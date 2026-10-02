//! Fault injection for the migration/rollback drills (feature `drill` only).
//!
//! `ATM_SETUP_DIE_AFTER=<STATE>[:<undo step>]` exits the process right after that state is
//! persisted, as if setup had been killed there; `ATM_SETUP_DIE_AFTER=SPAWNED:<STATE>` right
//! after a START / ROLLBACK_START host was spawned and recorded, `PRIMARY:<STATE>` once that
//! host is the primary instance but holds no lease yet, `LEASED:<STATE>` once its core holds
//! the lease but before setup has checked the witness. `ATM_SETUP_FAIL_AT=<STATE>`
//! makes that step report failure, `ATM_SETUP_FAIL_UNDO=<step>` an undo step (both tries).
//! `ATM_SETUP_SQUIRREL_ADDS=<name>` plays Squirrel's updater producing an Electron version
//! directory after the SNAPSHOT. `ATM_SETUP_PAUSE_UNLOCKED=<dir>` holds a finishing
//! uninstall right after it released the install lock (writes `<dir>\paused`, waits for
//! `<dir>\resume`), so a drill can run another setup in that gap. Release builds compile all
//! of them to nothing.
//!
//! The variables are taken out of the environment at startup ([`capture`]): they are meant
//! for the one setup the drill runs. Left in place they reach the host setup starts, and from
//! there the `--recover` that host starts — which then dies at the same point, starts another
//! host, and so on.

use atm_install_state::TxnState;

#[cfg(feature = "drill")]
const VARIABLES: [&str; 5] = [
    "ATM_SETUP_DIE_AFTER",
    "ATM_SETUP_FAIL_AT",
    "ATM_SETUP_FAIL_UNDO",
    "ATM_SETUP_SQUIRREL_ADDS",
    "ATM_SETUP_PAUSE_UNLOCKED",
];

#[cfg(feature = "drill")]
static CAPTURED: std::sync::OnceLock<std::collections::HashMap<&'static str, String>> =
    std::sync::OnceLock::new();

/// Read the fault variables once and remove them from this process's environment, so no
/// child inherits them. Call first thing in `main`, before any thread exists.
#[cfg(feature = "drill")]
pub fn capture() {
    let mut captured = std::collections::HashMap::new();
    for name in VARIABLES {
        if let Ok(value) = std::env::var(name) {
            captured.insert(name, value);
        }
        // SAFETY: called at the top of main, single-threaded.
        unsafe { std::env::remove_var(name) };
    }
    let _ = CAPTURED.set(captured);
}

#[cfg(not(feature = "drill"))]
pub fn capture() {}

#[cfg(feature = "drill")]
fn var(name: &str) -> Option<&'static str> {
    CAPTURED.get()?.get(name).map(String::as_str)
}

#[cfg(feature = "drill")]
fn state_name(state: TxnState) -> String {
    serde_json::to_value(state)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default()
}

#[cfg(feature = "drill")]
pub fn after_persist(state: TxnState, step: Option<u8>) {
    let Some(target) = var("ATM_SETUP_DIE_AFTER") else {
        return;
    };
    let here = match step {
        Some(step) => format!("{}:{step}", state_name(state)),
        None => state_name(state),
    };
    if target == here || (step.is_none() && target == state_name(state)) {
        eprintln!("ATM_SETUP_DRILL_DIE {here}");
        std::process::exit(99);
    }
}

#[cfg(not(feature = "drill"))]
pub fn after_persist(_state: TxnState, _step: Option<u8>) {}

#[cfg(feature = "drill")]
pub fn fail_at(state: TxnState) -> bool {
    var("ATM_SETUP_FAIL_AT").is_some_and(|target| target == state_name(state))
}

#[cfg(not(feature = "drill"))]
pub fn fail_at(_state: TxnState) -> bool {
    false
}

/// Where a START / ROLLBACK_START host can be when setup dies: `SPAWNED` right after it was
/// spawned and recorded; `PRIMARY` once it holds the single-instance lock (admitted with its
/// `--txn-start`) but before any lease; `LEASED` once its core holds the lease, before setup
/// has seen the witness. The log line says what was actually observed, so a drill can tell
/// a point that was missed from one that was hit.
#[cfg(feature = "drill")]
pub fn after_spawn(
    state: TxnState,
    env: &crate::env::Env,
    host: &atm_install_state::ProcessIdentity,
) {
    use std::time::{Duration, Instant};
    let Some(target) = var("ATM_SETUP_DIE_AFTER") else {
        return;
    };
    let state = state_name(state);
    let Some(point) = ["SPAWNED", "PRIMARY", "LEASED"]
        .into_iter()
        .find(|point| target == format!("{point}:{state}"))
    else {
        return;
    };
    let lease = || {
        crate::runtime::lease_holder(&env.runtime_dir())
            .is_some_and(|pid| crate::procs::parent_of(pid) == Some(host.pid))
    };
    let primary = || {
        atm_install_state::ipc::read_host_record(&env.data_dir)
            .is_some_and(|record| record.pid == host.pid)
    };
    let deadline = Instant::now() + Duration::from_secs(30);
    let reached = loop {
        let reached = match point {
            "SPAWNED" => true,
            "PRIMARY" => primary(),
            _ => lease(),
        };
        if reached || Instant::now() >= deadline || !crate::procs::alive(host) {
            break reached;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    say!(
        "ATM_SETUP_DRILL_DIE {point}:{state} reached={reached} primary={} lease={}",
        primary(),
        lease()
    );
    std::process::exit(99);
}

#[cfg(not(feature = "drill"))]
pub fn after_spawn(
    _state: TxnState,
    _env: &crate::env::Env,
    _host: &atm_install_state::ProcessIdentity,
) {
}

#[cfg(feature = "drill")]
pub fn fail_undo(step: u8) -> bool {
    var("ATM_SETUP_FAIL_UNDO").is_some_and(|target| target == step.to_string())
}

#[cfg(not(feature = "drill"))]
pub fn fail_undo(_step: u8) -> bool {
    false
}

#[cfg(feature = "drill")]
pub fn squirrel_adds(install_root: &std::path::Path) {
    if let Some(name) = var("ATM_SETUP_SQUIRREL_ADDS") {
        let resources = install_root.join(name).join("resources");
        let _ = std::fs::create_dir_all(&resources);
        let _ = std::fs::write(resources.join("app.asar"), b"drill");
        eprintln!("ATM_SETUP_DRILL_SQUIRREL_ADDS {name}");
    }
}

#[cfg(not(feature = "drill"))]
pub fn squirrel_adds(_install_root: &std::path::Path) {}

/// Stderr only: the log lives in the `state\` the uninstall is about to remove.
#[cfg(feature = "drill")]
pub fn pause_unlocked() {
    use std::time::{Duration, Instant};
    let Some(dir) = var("ATM_SETUP_PAUSE_UNLOCKED") else {
        return;
    };
    let dir = std::path::Path::new(dir);
    let _ = std::fs::create_dir_all(dir);
    let _ = std::fs::write(dir.join("paused"), b"drill");
    eprintln!("ATM_SETUP_DRILL_PAUSE_UNLOCKED");
    let deadline = Instant::now() + Duration::from_secs(180);
    while !dir.join("resume").exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(not(feature = "drill"))]
pub fn pause_unlocked() {}
