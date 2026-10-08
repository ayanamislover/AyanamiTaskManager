//! Processes by pid *and* creation time: shared with the 3.x runtime through
//! `atm_install_state::procs` (W4i), so both sides read identities the same way.

use std::path::Path;

pub use atm_install_state::procs::*;

/// Processes whose image lies inside `dir` (case-insensitive, textual).
pub fn under(dir: &Path) -> Vec<Proc> {
    snapshot()
        .into_iter()
        .filter(|proc| {
            proc.image
                .as_ref()
                .is_some_and(|image| crate::fsx::is_within(image, dir))
        })
        .collect()
}

