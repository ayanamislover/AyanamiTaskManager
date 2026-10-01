//! Drill helper: run a command inside a kill-on-close job, the way an Agent's terminal holds
//! the processes it starts. When this process exits the last job handle closes and Windows
//! ends everything still in the job.
//!
//!   job-runner [--no-breakaway] -- <exe> [args...]
//!
//! `--no-breakaway` leaves out JOB_OBJECT_LIMIT_BREAKAWAY_OK, so children cannot leave.
//! The exit code is the command's.

use std::process::Command;

use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectExtendedLimitInformation, SetInformationJobObject,
};
use windows_sys::Win32::System::Threading::GetCurrentProcess;

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let breakaway = !argv.iter().any(|arg| arg == "--no-breakaway");
    let Some(split) = argv.iter().position(|arg| arg == "--") else {
        eprintln!("usage: job-runner [--no-breakaway] -- <exe> [args...]");
        std::process::exit(2);
    };
    let command = &argv[split + 1..];
    let Some((exe, args)) = command.split_first() else {
        std::process::exit(2);
    };
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            eprintln!("CreateJobObjectW failed");
            std::process::exit(2);
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | if breakaway {
                JOB_OBJECT_LIMIT_BREAKAWAY_OK
            } else {
                0
            };
        let configured = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if configured == 0 || AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
            eprintln!("job setup failed");
            std::process::exit(2);
        }
        // The job handle is deliberately kept until exit: closing it is what kills the rest.
    }
    let status = Command::new(exe).args(args).status();
    std::process::exit(match status {
        Ok(status) => status.code().unwrap_or(1),
        Err(error) => {
            eprintln!("job-runner: {error}");
            2
        }
    });
}
