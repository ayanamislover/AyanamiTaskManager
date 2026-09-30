//! Fault injection for the migration/rollback drills (feature `drill` only).
//!
//! `ATM_SETUP_DIE_AFTER=<STATE>[:<undo step>]` exits the process right after that state is
//! persisted, as if setup had been killed there; `ATM_SETUP_FAIL_AT=<STATE>` makes that
//! step report failure. Release builds compile both to nothing.

use atm_install_state::TxnState;

#[cfg(feature = "drill")]
fn state_name(state: TxnState) -> String {
    serde_json::to_value(state)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default()
}

#[cfg(feature = "drill")]
pub fn after_persist(state: TxnState, step: Option<u8>) {
    let Ok(target) = std::env::var("ATM_SETUP_DIE_AFTER") else {
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
    std::env::var("ATM_SETUP_FAIL_AT").is_ok_and(|target| target == state_name(state))
}

#[cfg(not(feature = "drill"))]
pub fn fail_at(_state: TxnState) -> bool {
    false
}
