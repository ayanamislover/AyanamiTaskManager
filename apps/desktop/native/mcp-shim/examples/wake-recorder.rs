//! Test double for AyanamiTaskManager.exe in wake-path fixtures.
//!
//! Appends one JSON line describing how it was started to the file named by
//! ATM_WAKE_RECORD, then exits. Built only by `cargo build --examples`; never packaged.

use std::fs::OpenOptions;
use std::io::Write;

fn main() {
    let Some(path) = std::env::var_os("ATM_WAKE_RECORD") else {
        return;
    };
    let text = |name: &str| std::env::var_os(name).map(|v| v.to_string_lossy().into_owned());
    let record = serde_json::json!({
        "args": std::env::args().skip(1).collect::<Vec<_>>(),
        "electronRunAsNode": text("ELECTRON_RUN_AS_NODE"),
        "dataDir": text("ATM_DATA_DIR"),
        "pid": std::process::id(),
    });
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .expect("open wake record");
    writeln!(file, "{record}").expect("write wake record");
}
