//! Stand-in for Electron 1.x in migration drills (never packaged).
//!
//! A real Electron 1.2.2 in a sandbox would share the user's real userData and its
//! single-instance lock with the ATM they are running. This behaves like the old app where
//! setup can observe it: an `AyanamiTaskManager.exe` inside `app-1.x` that takes the daemon
//! lease in `<ATM_DATA_DIR>\runtime` in the 1.2.2 format, publishes daemon.json, serves a
//! port, has a helper child (like a renderer), and — as the old `installMcpRuntimeLink`
//! did — points `<dataDir>\current` at its own directory on start.

use std::fs;
use std::io::Write;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

fn creation_ticks() -> (u64, u64) {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
    let zero = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
    unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )
    };
    let filetime = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
    (
        filetime + 504_911_232_000_000_000,
        (filetime / 10_000).saturating_sub(11_644_473_600_000),
    )
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--type=renderer") {
        loop {
            std::thread::sleep(Duration::from_secs(3600));
        }
    }
    let data = PathBuf::from(std::env::var_os("ATM_DATA_DIR").expect("ATM_DATA_DIR"));
    let me = std::env::current_exe().expect("exe");
    let app_dir = me.parent().expect("app dir").to_path_buf();
    // The old app's installMcpRuntimeLink: current → its own app directory.
    let link = data.join("current");
    let _ = fs::remove_dir(&link);
    let _ = Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&link)
        .arg(&app_dir)
        .output();
    let runtime = data.join("runtime");
    fs::create_dir_all(&runtime).expect("runtime dir");
    let (ticks, started_ms) = creation_ticks();
    let pid = std::process::id();
    let nonce = format!("{:032x}", u128::from(now_ms()) << 20 | u128::from(pid));
    let lock = runtime.join("daemon.lock");
    let lease = format!(
        "{{\"pid\":{pid},\"nonce\":\"{nonce}\",\"processIdentity\":{{\"createdAtTicks\":\"{ticks}\",\"startedAtMs\":{started_ms}}}}}\n"
    );
    match fs::OpenOptions::new().write(true).create_new(true).open(&lock) {
        Ok(mut file) => file.write_all(lease.as_bytes()).expect("write lease"),
        Err(_) => {
            fs::write(&lock, lease.as_bytes()).expect("take stale lease");
        }
    }
    let listener = TcpListener::bind("127.0.0.1:0").expect("listen");
    let port = listener.local_addr().expect("addr").port();
    let version = app_dir
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix("app-"))
        .unwrap_or("1.0.0")
        .to_owned();
    let descriptor = format!(
        "{{\"endpoint\":\"http://127.0.0.1:{port}\",\"token\":\"drill-not-a-secret\",\"pid\":{pid},\"instanceId\":\"{nonce}\",\"version\":\"{version}\",\"startedAt\":\"{started_ms}\"}}"
    );
    fs::write(runtime.join("daemon.json"), descriptor).expect("publish");
    let _helper = Command::new(&me).arg("--type=renderer").spawn();
    for stream in listener.incoming() {
        drop(stream);
    }
}
