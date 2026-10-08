//! The running service as setup may observe it. The checks live in
//! `atm_install_state::service` so the 3.x runtime's end-to-end handoff tests run the very
//! code setup runs (W4i, W3 peer r1 P2-02).

pub use atm_install_state::service::*;
