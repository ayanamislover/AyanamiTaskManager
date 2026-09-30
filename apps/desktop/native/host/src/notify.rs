//! Desktop notifications decided by the core (desktop-observer.ts). The toast itself is
//! implemented with the Windows notification API in ATM-T-0539; until then the event is
//! recorded so nothing is silently lost.

use std::path::Path;

pub fn show(data_dir: &Path, title: &str, body: &str) {
    crate::log(data_dir, &format!("notify: {title} — {body}"));
}
