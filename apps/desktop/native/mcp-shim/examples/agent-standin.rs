//! Test double for an Agent process (Claude Code, Codex) in bridge fixtures.
//!
//! Starts the program named by its first argument with the remaining arguments, with
//! inherited stdio, and waits for it. The bridge started this way sees this process as
//! its client (`X-ATM-Client`), so a fixture can play "the Agent crashed and a new one
//! started" by killing one stand-in and starting another. Built only by
//! `cargo build --examples`; never packaged.

use std::process::Command;

fn main() {
    let mut args = std::env::args_os().skip(1);
    let Some(program) = args.next() else {
        std::process::exit(2);
    };
    let status = Command::new(program)
        .args(args)
        .status()
        .expect("start the program");
    std::process::exit(status.code().unwrap_or(1));
}
