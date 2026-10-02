//! The running service as setup may observe it: daemon.lock (lease), daemon.json
//! (published descriptor), the witness files, and whether the port accepts connections.
//! Setup never reads, keeps or logs the token: the descriptor struct has no field for it.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::procs;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Descriptor {
    pub endpoint: String,
    pub pid: u32,
    pub instance_id: String,
    pub version: String,
    /// 3.x only, like the two below.
    #[serde(default)]
    pub layout: Option<String>,
    #[serde(default)]
    pub generation: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LockOwner {
    pid: u32,
    #[serde(default)]
    process_identity: Option<LockIdentity>,
    /// 3.x writes `"single"`: the lease holder is the host process itself (no core child).
    /// 2.x locks have no such field.
    #[serde(default)]
    layout: Option<String>,
    /// The holder's instance id (3.x: equal to daemon.json `instanceId`).
    #[serde(default)]
    nonce: Option<String>,
    #[serde(default)]
    generation: Option<u64>,
}

/// Process layout of a running service, as its lease and witness declare it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layout {
    /// 2.x: host `AyanamiTaskManager.exe` + core child `atm-core.exe`.
    HostAndCore,
    /// 3.x: one `AyanamiTaskManager.exe` that is both host and service.
    Single,
}

pub const LAYOUT_SINGLE: &str = "single";

fn layout_of(field: Option<&str>) -> Layout {
    if field == Some(LAYOUT_SINGLE) {
        Layout::Single
    } else {
        Layout::HostAndCore
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LockIdentity {
    created_at_ticks: String,
}

pub fn descriptor(runtime_dir: &Path) -> Option<Descriptor> {
    crate::fsx::read_json_limited(&runtime_dir.join("daemon.json"), 64 * 1024)
        .ok()
        .flatten()
}

/// The pid holding the service lease, if that process is still the one that took it.
/// Same rule as `acquireDaemonRuntime`: a live pid whose birth differs from the recorded
/// `createdAtTicks` is a recycled pid, i.e. a stale lease.
pub fn lease_holder(runtime_dir: &Path) -> Option<u32> {
    lease(runtime_dir).map(|(pid, _)| pid)
}

/// The lease holder together with the layout its lock declares.
pub fn lease(runtime_dir: &Path) -> Option<(u32, Layout)> {
    held_lock(runtime_dir).map(|owner| (owner.pid, layout_of(owner.layout.as_deref())))
}

/// The lock, only if its holder is alive and is the process that took it.
fn held_lock(runtime_dir: &Path) -> Option<LockOwner> {
    let owner: LockOwner =
        crate::fsx::read_json_limited(&runtime_dir.join("daemon.lock"), 64 * 1024)
            .ok()
            .flatten()?;
    let proc = procs::find(owner.pid)?;
    let layout = layout_of(owner.layout.as_deref());
    let believed = match &owner.process_identity {
        Some(identity) => {
            procs::filetime_to_dotnet_ticks(proc.created).to_string() == identity.created_at_ticks
        }
        // Old locks without identity: a live pid is taken as the holder (conservative).
        // Only 2.x wrote such locks, so a `single` claim without identity is not believed.
        None => layout == Layout::HostAndCore,
    };
    believed.then_some(owner)
}

fn endpoint_port(endpoint: &str) -> Option<u16> {
    endpoint
        .strip_prefix("http://127.0.0.1:")?
        .trim_end_matches('/')
        .parse()
        .ok()
}

pub fn port_open(endpoint: &str) -> bool {
    let Some(port) = endpoint_port(endpoint) else {
        return false;
    };
    TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_secs(2),
    )
    .is_ok()
}

/// The pid owning the IPv4 listening socket on `127.0.0.1:port` (or `0.0.0.0:port`).
pub fn port_owner(port: u16) -> Option<u32> {
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
    };
    const AF_INET: u32 = 2;
    let mut size = 0u32;
    // First call sizes the buffer; the table can grow between calls, so retry a few times.
    for _ in 0..4 {
        let mut buffer = vec![0u8; size as usize + 4096];
        size = buffer.len() as u32;
        let status = unsafe {
            GetExtendedTcpTable(
                buffer.as_mut_ptr().cast(),
                &mut size,
                0,
                AF_INET,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        if status != 0 {
            continue;
        }
        let count = u32::from_ne_bytes(buffer[..4].try_into().ok()?) as usize;
        let row_size = std::mem::size_of::<MIB_TCPROW_OWNER_PID>();
        // The rows follow the 4-byte count, aligned to 4.
        for index in 0..count {
            let offset = 4 + index * row_size;
            let bytes = buffer.get(offset..offset + row_size)?;
            let row: MIB_TCPROW_OWNER_PID =
                unsafe { std::ptr::read_unaligned(bytes.as_ptr().cast()) };
            let local_port = u16::from_be(row.dwLocalPort as u16);
            let local_addr = u32::from_be(row.dwLocalAddr);
            if local_port == port && (local_addr == 0x7f00_0001 || local_addr == 0) {
                return Some(row.dwOwningPid);
            }
        }
        return None;
    }
    None
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HealthAnswer {
    pid: u32,
    instance_id: String,
    #[serde(default)]
    generation: Option<u64>,
}

/// Own budget of one `/health` request; the caller's deadline caps it further.
const HEALTH_BUDGET: Duration = Duration::from_secs(4);
const HEALTH_MAX_BYTES: usize = 64 * 1024;

/// A complete HTTP response in `raw`: (status, body) once the headers and the whole
/// `Content-Length` body have arrived. Without a Content-Length only EOF completes it.
fn complete_response(raw: &[u8], eof: bool) -> Option<(u16, &[u8])> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&raw[..split]).ok()?;
    let body = &raw[split + 4..];
    let status = head.split_whitespace().nth(1)?.parse().ok()?;
    let length = head.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<usize>().ok())
            .flatten()
    });
    match length {
        Some(length) if body.len() >= length => Some((status, &body[..length])),
        Some(_) => None,
        None => eof.then_some((status, body)),
    }
}

/// One `GET /health` (no token: the health route carries none). Every step — connect,
/// write, each read — runs on what is left of one monotonic deadline: the earlier of the
/// caller's and `HEALTH_BUDGET`. A server that trickles bytes cannot stretch it.
/// Because every blocking step waits at most for what is left, the whole call returns by
/// the deadline (plus scheduling); the tests assert the elapsed time, not a final re-check.
fn health_answer(port: u16, deadline: Instant) -> Result<HealthAnswer, String> {
    let until = deadline.min(Instant::now() + HEALTH_BUDGET);
    let left = || {
        until
            .checked_duration_since(Instant::now())
            .filter(|left| !left.is_zero())
            .ok_or_else(|| "service did not answer /health in time".to_string())
    };
    let mut stream = TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), left()?)
        .map_err(|_| "service did not answer /health")?;
    stream
        .set_write_timeout(Some(left()?))
        .map_err(|_| "service did not answer /health")?;
    stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .map_err(|_| "service did not answer /health")?;
    let mut raw: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    let (status, body) = loop {
        if let Some((status, body)) = complete_response(&raw, false) {
            break (status, body.to_vec());
        }
        if raw.len() >= HEALTH_MAX_BYTES {
            return Err("service did not answer /health".into());
        }
        stream
            .set_read_timeout(Some(left()?))
            .map_err(|_| "service did not answer /health")?;
        match stream.read(&mut chunk) {
            Ok(0) => match complete_response(&raw, true) {
                Some((status, body)) => break (status, body.to_vec()),
                None => return Err("service did not answer /health".into()),
            },
            Ok(n) => raw.extend_from_slice(&chunk[..n]),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) =>
            {
                return Err("service did not answer /health in time".into());
            }
            Err(_) => return Err("service did not answer /health".into()),
        }
    };
    if status != 200 {
        return Err("service did not answer /health".into());
    }
    serde_json::from_slice(&body).map_err(|_| "service did not answer /health".into())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WitnessHost {
    pub pid: u32,
    pub started_at_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WitnessCore {
    pub pid: Option<u32>,
    pub started_at_ms: Option<u64>,
    pub instance_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Witness {
    pub txn_id: String,
    pub version: String,
    pub host: WitnessHost,
    pub core: WitnessCore,
    /// `"single"` from 3.x; absent from 2.x.
    #[serde(default)]
    pub layout: Option<String>,
    #[serde(default)]
    pub generation: Option<u64>,
}

/// SERVICE_HEALTHY (§6): every field of the witness cross-checked against what setup can
/// see itself. `Err` carries the first mismatch, for the log.
///
/// Trust boundary: these checks reject stale, inconsistent or half-written state and a
/// port that is not served by the host. They do not defend against another process of the
/// same user that rewrites the data directory *and* runs an imitation server — such a
/// process can already replace the install itself.
pub fn service_healthy(
    health_dir: &Path,
    runtime_dir: &Path,
    txn: &str,
    version: &str,
    host: &atm_install_state::ProcessIdentity,
    deadline: Instant,
) -> Result<(), String> {
    let witness: Witness =
        crate::fsx::read_json_limited(&health_dir.join(format!("service-{txn}.json")), 64 * 1024)
            .map_err(|error| error.to_string())?
            .ok_or("witness not written yet")?;
    if witness.txn_id != txn || witness.version != version {
        return Err("witness for another transaction or version".into());
    }
    if witness.host.pid != host.pid || !procs::alive(host) {
        return Err("host is not the process setup started".into());
    }
    let host_proc = procs::find(host.pid).ok_or("host gone")?;
    if host_proc.started_at_ms() != witness.host.started_at_ms {
        return Err("host start time differs".into());
    }
    let core_pid = witness.core.pid.ok_or("core pid missing")?;
    let core_proc = procs::find(core_pid).ok_or("core gone")?;
    if Some(core_proc.started_at_ms()) != witness.core.started_at_ms {
        return Err("core start time differs".into());
    }
    let layout = layout_of(witness.layout.as_deref());
    let published = descriptor(runtime_dir).ok_or("daemon.json missing")?;
    match layout {
        Layout::HostAndCore => {
            if procs::parent_of(core_pid) != Some(host.pid) || core_proc.created < host_proc.created
            {
                return Err("core is not a child of the host".into());
            }
        }
        // 3.x: the service runs inside the host. Lease, daemon.json and witness must all name
        // this one process, one instance and one generation.
        Layout::Single => {
            if core_pid != host.pid || core_proc.created != host_proc.created {
                return Err("single-process witness names another process".into());
            }
            let lock = held_lock(runtime_dir)
                .filter(|lock| {
                    lock.pid == host.pid && layout_of(lock.layout.as_deref()) == Layout::Single
                })
                .ok_or("single-process lease is not held by the host")?;
            if lock.nonce.is_none() || lock.nonce != witness.core.instance_id {
                return Err("single-process lease belongs to another instance".into());
            }
            if layout_of(published.layout.as_deref()) != Layout::Single {
                return Err("daemon.json is not a single-process descriptor".into());
            }
            let generation = witness.generation;
            if generation.is_none()
                || lock.generation != generation
                || published.generation != generation
            {
                return Err("generation differs across lease, daemon.json and witness".into());
            }
        }
    }
    if published.pid != core_pid
        || Some(&published.instance_id) != witness.core.instance_id.as_ref()
        || published.version != version
    {
        return Err("daemon.json does not match the witness".into());
    }
    match layout {
        Layout::HostAndCore => {
            if !port_open(&published.endpoint) {
                return Err("service port refuses connections".into());
            }
        }
        Layout::Single => {
            let port = endpoint_port(&published.endpoint).ok_or("endpoint is not loopback")?;
            if port_owner(port) != Some(host.pid) {
                return Err("service port is not held by the host".into());
            }
            let answer = health_answer(port, deadline)?;
            if answer.pid != host.pid
                || Some(&answer.instance_id) != witness.core.instance_id.as_ref()
                || answer.generation != witness.generation
            {
                return Err("/health names another instance".into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    const INSTANCE: &str = "0123456789abcdef0123456789abcdef";
    const GENERATION: u64 = 7;

    /// This test process plays the 3.x single-process service: it is host, core and lease
    /// holder at once, and serves `/health` from a listener it owns.
    struct Fixture {
        dir: PathBuf,
        health: PathBuf,
        runtime: PathBuf,
        me: procs::Proc,
        endpoint: String,
        port: u16,
        /// What `/health` answers; `None` = accept and close without answering.
        answer: Arc<Mutex<Option<serde_json::Value>>>,
        /// The HTTP status `/health` answers with.
        status: Arc<Mutex<u16>>,
        /// How the answer is delivered.
        delivery: Arc<Mutex<Delivery>>,
    }

    #[derive(Clone, Copy, Debug)]
    enum Delivery {
        Whole,
        /// Accept, read the request, then hold the connection open without answering.
        Hang,
        /// Headers at once, then `pad` leading spaces of the body one per `every_ms`.
        Trickle {
            pad: usize,
            every_ms: u64,
        },
        /// Declare a longer body than is sent, then close.
        Truncated,
    }

    impl Fixture {
        fn new(name: &str) -> Fixture {
            // Under CARGO_TARGET_DIR when one is set, so a sandboxed run stays inside it.
            let target = std::env::var_os("CARGO_TARGET_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("..")
                        .join("target")
                });
            let dir = target.join("setup-tests").join(name);
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let dir = std::path::absolute(dir).unwrap();
            let (health, runtime) = (dir.join("health"), dir.join("runtime"));
            std::fs::create_dir_all(&health).unwrap();
            std::fs::create_dir_all(&runtime).unwrap();
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let me = procs::find(std::process::id()).unwrap();
            let answer = Arc::new(Mutex::new(Some(
                json!({ "ok": true, "pid": me.pid, "instanceId": INSTANCE, "generation": GENERATION }),
            )));
            let served = answer.clone();
            let status = Arc::new(Mutex::new(200u16));
            let served_status = status.clone();
            let delivery = Arc::new(Mutex::new(Delivery::Whole));
            let served_delivery = delivery.clone();
            std::thread::spawn(move || {
                for mut stream in listener.incoming().flatten() {
                    let body = served.lock().unwrap().clone();
                    let status = *served_status.lock().unwrap();
                    let delivery = *served_delivery.lock().unwrap();
                    // One thread per connection: a hanging answer never blocks the next one.
                    std::thread::spawn(move || {
                        let mut buffer = [0u8; 1024];
                        let _ = stream.read(&mut buffer);
                        let Some(body) = body else { return };
                        let body = body.to_string();
                        let head = |length: usize| {
                            format!(
                                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n"
                            )
                        };
                        match delivery {
                            Delivery::Whole => {
                                let _ = write!(stream, "{}{body}", head(body.len()));
                            }
                            Delivery::Hang => std::thread::sleep(Duration::from_secs(15)),
                            Delivery::Trickle { pad, every_ms } => {
                                let _ = write!(stream, "{}", head(pad + body.len()));
                                for _ in 0..pad {
                                    std::thread::sleep(Duration::from_millis(every_ms));
                                    if stream.write_all(b" ").is_err() {
                                        return;
                                    }
                                }
                                let _ = stream.write_all(body.as_bytes());
                            }
                            Delivery::Truncated => {
                                let _ = write!(stream, "{}{}", head(body.len() + 10), body);
                            }
                        }
                    });
                }
            });
            Fixture {
                dir,
                health,
                runtime,
                me,
                endpoint: format!("http://127.0.0.1:{port}"),
                port,
                answer,
                status,
                delivery,
            }
        }

        fn ticks_of(proc: &procs::Proc) -> String {
            procs::filetime_to_dotnet_ticks(proc.created).to_string()
        }

        fn write(path: PathBuf, value: serde_json::Value) {
            std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
        }

        fn lock(&self, value: serde_json::Value) {
            Self::write(self.runtime.join("daemon.lock"), value);
        }

        fn single_lock(&self) -> serde_json::Value {
            json!({
                "pid": self.me.pid,
                "nonce": INSTANCE,
                "processIdentity": { "createdAtTicks": Self::ticks_of(&self.me) },
                "layout": "single",
                "generation": GENERATION,
            })
        }

        fn single_descriptor(&self) -> serde_json::Value {
            json!({
                "endpoint": self.endpoint,
                "pid": self.me.pid,
                "instanceId": INSTANCE,
                "version": "9.0.0",
                "layout": "single",
                "generation": GENERATION,
            })
        }

        fn descriptor(&self, value: serde_json::Value) {
            Self::write(self.runtime.join("daemon.json"), value);
        }

        fn witness(&self, value: serde_json::Value) {
            Self::write(self.health.join("service-T1.json"), value);
        }

        fn single_witness(&self, core: &procs::Proc) -> serde_json::Value {
            json!({
                "txnId": "T1",
                "version": "9.0.0",
                "host": { "pid": self.me.pid, "startedAtMs": self.me.started_at_ms() },
                "core": { "pid": core.pid, "startedAtMs": core.started_at_ms(), "instanceId": INSTANCE },
                "layout": "single",
                "generation": GENERATION,
            })
        }

        /// Every file consistent with one single-process service.
        fn single(&self) {
            self.lock(self.single_lock());
            self.descriptor(self.single_descriptor());
            self.witness(self.single_witness(&self.me));
        }

        fn check(&self) -> Result<(), String> {
            self.check_by(Instant::now() + Duration::from_secs(10))
        }

        fn check_by(&self, deadline: Instant) -> Result<(), String> {
            service_healthy(
                &self.health,
                &self.runtime,
                "T1",
                "9.0.0",
                &self.me.identity(),
                deadline,
            )
        }

        fn deliver(&self, delivery: Delivery) {
            *self.delivery.lock().unwrap() = delivery;
        }

        /// Our parent (the test runner) is alive and older: a perfect impostor.
        fn parent(&self) -> procs::Proc {
            procs::find(procs::parent_of(self.me.pid).unwrap()).unwrap()
        }

        fn answer(&self, value: Option<serde_json::Value>) {
            *self.answer.lock().unwrap() = value;
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn with(
        mut base: serde_json::Value,
        path: &[&str],
        value: serde_json::Value,
    ) -> serde_json::Value {
        let mut slot = &mut base;
        for key in &path[..path.len() - 1] {
            slot = &mut slot[*key];
        }
        let last = path[path.len() - 1];
        if value.is_null() {
            slot.as_object_mut().unwrap().remove(last);
        } else {
            slot[last] = value;
        }
        base
    }

    #[test]
    fn a_single_process_service_is_healthy() {
        let f = Fixture::new("single-healthy");
        f.single();
        assert_eq!(f.check(), Ok(()));
        assert_eq!(lease(&f.runtime), Some((f.me.pid, Layout::Single)));
        assert_eq!(lease_holder(&f.runtime), Some(f.me.pid));
        assert_eq!(port_owner(f.port), Some(f.me.pid));
    }

    #[test]
    fn a_witness_without_the_layout_still_needs_a_core_child() {
        let f = Fixture::new("single-no-layout");
        f.single();
        f.witness(with(f.single_witness(&f.me), &["layout"], json!(null)));
        assert_eq!(f.check(), Err("core is not a child of the host".into()));
        // An unknown layout value is read as 2.x, not as single.
        f.witness(with(f.single_witness(&f.me), &["layout"], json!("Single")));
        assert_eq!(f.check(), Err("core is not a child of the host".into()));
    }

    #[test]
    fn a_single_witness_must_name_the_host_itself() {
        let f = Fixture::new("single-other-core");
        f.single();
        f.witness(f.single_witness(&f.parent()));
        assert_eq!(
            f.check(),
            Err("single-process witness names another process".into())
        );
    }

    #[test]
    fn a_single_witness_needs_a_single_lease_from_the_host() {
        let f = Fixture::new("single-lease");
        f.single();
        let refused = Err::<(), String>("single-process lease is not held by the host".into());
        // 2.x-shaped lock (no layout) held by the same process.
        f.lock(with(f.single_lock(), &["layout"], json!(null)));
        assert_eq!(f.check(), refused);
        // `single` without identity is not believed.
        f.lock(with(f.single_lock(), &["processIdentity"], json!(null)));
        assert_eq!(lease(&f.runtime), None);
        assert_eq!(f.check(), refused);
        // `single` with a recycled-pid identity.
        f.lock(with(
            f.single_lock(),
            &["processIdentity", "createdAtTicks"],
            json!("1"),
        ));
        assert_eq!(f.check(), refused);
        // `single` held by another live process.
        let parent = f.parent();
        let other = with(f.single_lock(), &["pid"], json!(parent.pid));
        f.lock(with(
            other,
            &["processIdentity", "createdAtTicks"],
            json!(Fixture::ticks_of(&parent)),
        ));
        assert_eq!(f.check(), refused);
    }

    #[test]
    fn lease_daemon_and_witness_must_name_one_instance_and_generation() {
        let f = Fixture::new("single-cross-check");
        f.single();
        let other_instance =
            Err::<(), String>("single-process lease belongs to another instance".into());
        f.lock(with(f.single_lock(), &["nonce"], json!("wrong-instance")));
        assert_eq!(f.check(), other_instance);
        f.lock(with(f.single_lock(), &["nonce"], json!(null)));
        assert_eq!(f.check(), other_instance);
        f.lock(f.single_lock());

        let generation =
            Err::<(), String>("generation differs across lease, daemon.json and witness".into());
        f.lock(with(
            f.single_lock(),
            &["generation"],
            json!(GENERATION + 1),
        ));
        assert_eq!(f.check(), generation);
        f.lock(f.single_lock());
        f.descriptor(with(
            f.single_descriptor(),
            &["generation"],
            json!(GENERATION + 1),
        ));
        assert_eq!(f.check(), generation);
        f.descriptor(f.single_descriptor());
        f.witness(with(f.single_witness(&f.me), &["generation"], json!(null)));
        assert_eq!(f.check(), generation);
        f.witness(f.single_witness(&f.me));

        f.descriptor(with(f.single_descriptor(), &["layout"], json!("nonsense")));
        assert_eq!(
            f.check(),
            Err("daemon.json is not a single-process descriptor".into())
        );
        f.descriptor(f.single_descriptor());
        assert_eq!(f.check(), Ok(()));

        // All three without a generation agree vacuously; still refused.
        f.lock(with(f.single_lock(), &["generation"], json!(null)));
        f.descriptor(with(f.single_descriptor(), &["generation"], json!(null)));
        f.witness(with(f.single_witness(&f.me), &["generation"], json!(null)));
        f.answer(Some(
            json!({ "ok": true, "pid": f.me.pid, "instanceId": INSTANCE }),
        ));
        assert_eq!(f.check(), generation);
    }

    #[test]
    fn the_port_must_be_served_by_the_host_and_answer_health() {
        let f = Fixture::new("single-health");
        f.single();
        // A listener that accepts but never answers (r1's impostor).
        f.answer(None);
        assert_eq!(f.check(), Err("service did not answer /health".into()));
        // Answers, but for another instance, pid or generation.
        for (key, value) in [
            ("instanceId", json!("ffffffffffffffffffffffffffffffff")),
            ("pid", json!(f.parent().pid)),
            ("generation", json!(GENERATION + 1)),
        ] {
            let answer = json!({ "ok": true, "pid": f.me.pid, "instanceId": INSTANCE, "generation": GENERATION });
            f.answer(Some(with(answer, &[key], value)));
            assert_eq!(
                f.check(),
                Err("/health names another instance".into()),
                "{key}"
            );
        }
        f.answer(Some(
            json!({ "ok": true, "pid": f.me.pid, "instanceId": INSTANCE, "generation": GENERATION }),
        ));
        assert_eq!(f.check(), Ok(()));
        // The right body under a non-200 status is not a health answer.
        *f.status.lock().unwrap() = 503;
        assert_eq!(f.check(), Err("service did not answer /health".into()));
        *f.status.lock().unwrap() = 200;
        assert_eq!(f.check(), Ok(()));
        // An endpoint nobody listens on is not the host's port.
        let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let unused = free.local_addr().unwrap().port();
        drop(free);
        f.descriptor(with(
            f.single_descriptor(),
            &["endpoint"],
            json!(format!("http://127.0.0.1:{unused}")),
        ));
        assert_eq!(
            f.check(),
            Err("service port is not held by the host".into())
        );
    }

    #[test]
    fn health_is_bounded_by_one_deadline_not_per_read() {
        let f = Fixture::new("single-health-deadline");
        f.single();
        let timed = |deadline_ms: u64| {
            let t0 = Instant::now();
            let result = f.check_by(Instant::now() + Duration::from_millis(deadline_ms));
            (result, t0.elapsed())
        };
        // A normal answer is quick.
        let (ok, took) = timed(10_000);
        assert_eq!(ok, Ok(()));
        assert!(took < Duration::from_secs(1), "{took:?}");
        // Whitespace before the JSON is fine when it arrives in time.
        f.deliver(Delivery::Trickle {
            pad: 3,
            every_ms: 100,
        });
        assert_eq!(timed(3_000).0, Ok(()));
        // Never answers: refused at the caller's deadline.
        f.deliver(Delivery::Hang);
        let (refused, took) = timed(1_500);
        assert_eq!(
            refused,
            Err("service did not answer /health in time".into())
        );
        assert!(took < Duration::from_millis(2_100), "{took:?}");
        // Trickles past the caller's deadline (W0-S peer r2 P1-02): each read is quick,
        // the whole answer is not.
        f.deliver(Delivery::Trickle {
            pad: 10,
            every_ms: 300,
        });
        let (refused, took) = timed(1_500);
        assert_eq!(
            refused,
            Err("service did not answer /health in time".into())
        );
        assert!(took < Duration::from_millis(2_100), "{took:?}");
        // Trickles past the request's own budget even with a far caller deadline.
        f.deliver(Delivery::Trickle {
            pad: 12,
            every_ms: 450,
        });
        let (refused, took) = timed(30_000);
        assert_eq!(
            refused,
            Err("service did not answer /health in time".into())
        );
        assert!(
            took < HEALTH_BUDGET + Duration::from_millis(700),
            "{took:?}"
        );
        // A body shorter than its Content-Length is not an answer.
        f.deliver(Delivery::Truncated);
        assert_eq!(timed(3_000).0, Err("service did not answer /health".into()));
        // An already-passed deadline refuses at once.
        f.deliver(Delivery::Whole);
        let (refused, took) = timed(0);
        assert!(refused.is_err());
        assert!(took < Duration::from_millis(300), "{took:?}");
    }

    #[test]
    fn complete_response_needs_the_whole_declared_body() {
        let full = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}";
        assert_eq!(complete_response(full, false), Some((200, &b"{}"[..])));
        assert_eq!(complete_response(&full[..full.len() - 1], false), None);
        assert_eq!(complete_response(&full[..full.len() - 1], true), None);
        let open = b"HTTP/1.1 200 OK\r\n\r\n{}";
        assert_eq!(complete_response(open, false), None);
        assert_eq!(complete_response(open, true), Some((200, &b"{}"[..])));
        assert_eq!(
            complete_response(b"HTTP/1.1 200 OK\r\nContent-", true),
            None
        );
    }

    #[test]
    fn r1_impostor_fixture_is_refused() {
        // W0-S peer r1 P1-03: wrong nonce, three different generations, nonsense daemon
        // layout, and a plain listener. Each mismatch alone is refused above; together too.
        let f = Fixture::new("single-r1-impostor");
        f.single();
        f.lock(with(
            with(f.single_lock(), &["nonce"], json!("wrong-instance")),
            &["generation"],
            json!(1),
        ));
        f.descriptor(with(
            with(f.single_descriptor(), &["generation"], json!(2)),
            &["layout"],
            json!("nonsense"),
        ));
        f.witness(with(f.single_witness(&f.me), &["generation"], json!(99)));
        f.answer(None);
        assert!(f.check().is_err());
    }

    /// W0-S: the real check against a live single-process spike; not in the normal suite.
    /// Env: ATM_W0S_HEALTH_DIR, ATM_W0S_RUNTIME_DIR, ATM_W0S_TXN, ATM_W0S_VERSION, ATM_W0S_PID.
    #[test]
    #[ignore]
    fn w0s_external_single_process_witness() {
        let var = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("{name} not set"));
        let pid: u32 = var("ATM_W0S_PID").parse().unwrap();
        let host = procs::find(pid).expect("spike not running").identity();
        let runtime = PathBuf::from(var("ATM_W0S_RUNTIME_DIR"));
        let result = service_healthy(
            &PathBuf::from(var("ATM_W0S_HEALTH_DIR")),
            &runtime,
            &var("ATM_W0S_TXN"),
            &var("ATM_W0S_VERSION"),
            &host,
            Instant::now() + Duration::from_secs(10),
        );
        assert_eq!(result, Ok(()));
        assert_eq!(lease(&runtime), Some((pid, Layout::Single)));
    }
}
