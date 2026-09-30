//! `--cli`, `--doctor`, `--mcp-stdio` and the Electron-as-node legacy command: run the
//! matching Node entry with inherited stdio and pass its exit code through (§3.1).
//! These entries only ever carry the Agent credential from daemon.json.

use std::fs::OpenOptions;
use std::process::{Command, Stdio};

use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
use windows_sys::Win32::System::Console::{
    ATTACH_PARENT_PROCESS, AttachConsole, GetStdHandle, STD_OUTPUT_HANDLE,
};

use crate::args::Headless;
use crate::core_process::scrub_environment;
use crate::paths::{CoreCommand, Layout};

/// A GUI-subsystem exe started from a terminal has no std handles; attach to the parent
/// console and hand the child explicit console handles so output is not lost.
fn console_stdio() -> Option<(Stdio, Stdio, Stdio)> {
    unsafe {
        let handle = GetStdHandle(STD_OUTPUT_HANDLE);
        if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
            return None;
        }
        if AttachConsole(ATTACH_PARENT_PROCESS) == 0 {
            return None;
        }
    }
    let output = OpenOptions::new().write(true).open("CONOUT$").ok()?;
    let error = output.try_clone().ok()?;
    let input = OpenOptions::new().read(true).open("CONIN$").ok()?;
    Some((Stdio::from(input), Stdio::from(output), Stdio::from(error)))
}

fn run_entry(entry: &CoreCommand, layout: &Layout, extra: &[String], console: bool) -> i32 {
    let mut command = Command::new(&entry.exe);
    command.args(&entry.args).args(extra);
    scrub_environment(&mut command);
    for (key, value) in &entry.env {
        command.env(key, value);
    }
    command.env("ATM_DATA_DIR", &layout.data_dir);
    if console && let Some((input, output, error)) = console_stdio() {
        command.stdin(input).stdout(output).stderr(error);
    }
    match command.status() {
        Ok(status) => status.code().unwrap_or(1),
        Err(error) => {
            eprintln!("ATM_NODE_ENTRY_FAILED: {error}");
            1
        }
    }
}

pub fn run(layout: &Layout, mode: &Headless) -> i32 {
    match mode {
        Headless::Cli(args) => run_entry(&layout.cli, layout, args, true),
        Headless::McpStdio(args) => {
            // The JS bridge wakes the desktop when no daemon is published. Under Electron it
            // ran as the desktop exe and used its own path; on the bundled Node it is told.
            let mut entry = layout.mcp_stdio.clone();
            entry.env.push((
                "ATM_DESKTOP_EXECUTABLE".into(),
                layout.host_exe.to_string_lossy().into_owned(),
            ));
            run_entry(&entry, layout, args, false)
        }
    }
}
