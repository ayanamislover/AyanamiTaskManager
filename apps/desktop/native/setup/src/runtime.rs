//! The running service as setup may observe it: daemon.lock (lease), daemon.json
//! (published descriptor), the witness files, and whether the port accepts connections.
//! Setup never reads, keeps or logs the token: the descriptor struct has no field for it.

use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::time::Duration;

use serde::Deserialize;

use crate::procs;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Descriptor {
    pub endpoint: String,
    pub pid: u32,
    pub instance_id: String,
    pub version: String,
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
    let owner: LockOwner =
        crate::fsx::read_json_limited(&runtime_dir.join("daemon.lock"), 64 * 1024)
            .ok()
            .flatten()?;
    let proc = procs::find(owner.pid)?;
    let layout = layout_of(owner.layout.as_deref());
    match owner.process_identity {
        Some(identity) => {
            let ticks = procs::filetime_to_dotnet_ticks(proc.created).to_string();
            (ticks == identity.created_at_ticks).then_some((owner.pid, layout))
        }
        // Old locks without identity: a live pid is taken as the holder (conservative).
        // Only 2.x wrote such locks, so a `single` claim without identity is not believed.
        None => (layout == Layout::HostAndCore).then_some((owner.pid, layout)),
    }
}

pub fn port_open(endpoint: &str) -> bool {
    let Some(rest) = endpoint.strip_prefix("http://127.0.0.1:") else {
        return false;
    };
    let Ok(port) = rest.trim_end_matches('/').parse::<u16>() else {
        return false;
    };
    TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_secs(2),
    )
    .is_ok()
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
}

/// SERVICE_HEALTHY (§6): every field of the witness cross-checked against what setup can
/// see itself. `Err` carries the first mismatch, for the log.
pub fn service_healthy(
    health_dir: &Path,
    runtime_dir: &Path,
    txn: &str,
    version: &str,
    host: &atm_install_state::ProcessIdentity,
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
    match layout_of(witness.layout.as_deref()) {
        Layout::HostAndCore => {
            if procs::parent_of(core_pid) != Some(host.pid) || core_proc.created < host_proc.created
            {
                return Err("core is not a child of the host".into());
            }
        }
        // 3.x: the service runs inside the host. The witness must say so with the host's own
        // identity, and the lease must be held by that same process under the same layout.
        Layout::Single => {
            if core_pid != host.pid || core_proc.created != host_proc.created {
                return Err("single-process witness names another process".into());
            }
            if lease(runtime_dir) != Some((host.pid, Layout::Single)) {
                return Err("single-process lease is not held by the host".into());
            }
        }
    }
    let published = descriptor(runtime_dir).ok_or("daemon.json missing")?;
    if published.pid != core_pid
        || Some(&published.instance_id) != witness.core.instance_id.as_ref()
        || published.version != version
    {
        return Err("daemon.json does not match the witness".into());
    }
    if !port_open(&published.endpoint) {
        return Err("service port refuses connections".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    const INSTANCE: &str = "0123456789abcdef0123456789abcdef";

    /// This test process plays the 3.x single-process service: it is host, core and lease
    /// holder at once, with a real listening port.
    struct Fixture {
        dir: PathBuf,
        health: PathBuf,
        runtime: PathBuf,
        me: procs::Proc,
        _listener: std::net::TcpListener,
        endpoint: String,
    }

    impl Fixture {
        fn new(name: &str) -> Fixture {
            let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("target")
                .join("setup-tests")
                .join(name);
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let dir = std::path::absolute(dir).unwrap();
            let (health, runtime) = (dir.join("health"), dir.join("runtime"));
            std::fs::create_dir_all(&health).unwrap();
            std::fs::create_dir_all(&runtime).unwrap();
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let endpoint = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
            let me = procs::find(std::process::id()).unwrap();
            Fixture {
                dir,
                health,
                runtime,
                me,
                _listener: listener,
                endpoint,
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

        fn witness(&self, value: serde_json::Value) {
            Self::write(self.health.join("service-T1.json"), value);
        }

        fn witness_naming(&self, core: &procs::Proc, layout: Option<&str>) {
            let mut value = json!({
                "txnId": "T1",
                "version": "9.0.0",
                "host": { "pid": self.me.pid, "startedAtMs": self.me.started_at_ms() },
                "core": { "pid": core.pid, "startedAtMs": core.started_at_ms(), "instanceId": INSTANCE },
            });
            if let Some(layout) = layout {
                value["layout"] = json!(layout);
            }
            self.witness(value);
        }

        /// Every file consistent with one single-process service.
        fn single(&self) {
            let pid = self.me.pid;
            self.lock(json!({
                "pid": pid,
                "processIdentity": { "createdAtTicks": Self::ticks_of(&self.me) },
                "layout": "single",
            }));
            Self::write(
                self.runtime.join("daemon.json"),
                json!({ "endpoint": self.endpoint, "pid": pid, "instanceId": INSTANCE, "version": "9.0.0" }),
            );
            self.witness_naming(&self.me, Some("single"));
        }

        fn check(&self) -> Result<(), String> {
            service_healthy(
                &self.health,
                &self.runtime,
                "T1",
                "9.0.0",
                &self.me.identity(),
            )
        }

        /// Our parent (the test runner) is alive and older: a perfect impostor.
        fn parent(&self) -> procs::Proc {
            procs::find(procs::parent_of(self.me.pid).unwrap()).unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn a_single_process_service_is_healthy() {
        let f = Fixture::new("single-healthy");
        f.single();
        assert_eq!(f.check(), Ok(()));
        assert_eq!(lease(&f.runtime), Some((f.me.pid, Layout::Single)));
        assert_eq!(lease_holder(&f.runtime), Some(f.me.pid));
    }

    #[test]
    fn a_witness_without_the_layout_still_needs_a_core_child() {
        let f = Fixture::new("single-no-layout");
        f.single();
        f.witness_naming(&f.me, None);
        assert_eq!(f.check(), Err("core is not a child of the host".into()));
        // An unknown layout value is read as 2.x, not as single.
        f.witness_naming(&f.me, Some("Single"));
        assert_eq!(f.check(), Err("core is not a child of the host".into()));
    }

    #[test]
    fn a_single_witness_must_name_the_host_itself() {
        let f = Fixture::new("single-other-core");
        f.single();
        f.witness_naming(&f.parent(), Some("single"));
        assert_eq!(
            f.check(),
            Err("single-process witness names another process".into())
        );
    }

    #[test]
    fn a_single_witness_needs_a_single_lease_from_the_host() {
        let f = Fixture::new("single-lease");
        f.single();
        let pid = f.me.pid;
        let refused = Err::<(), String>("single-process lease is not held by the host".into());
        // 2.x-shaped lock (no layout) held by the same process.
        f.lock(json!({ "pid": pid, "processIdentity": { "createdAtTicks": Fixture::ticks_of(&f.me) } }));
        assert_eq!(f.check(), refused);
        // `single` without identity is not believed.
        f.lock(json!({ "pid": pid, "layout": "single" }));
        assert_eq!(lease(&f.runtime), None);
        assert_eq!(f.check(), refused);
        // `single` with a recycled-pid identity.
        f.lock(
            json!({ "pid": pid, "processIdentity": { "createdAtTicks": "1" }, "layout": "single" }),
        );
        assert_eq!(f.check(), refused);
        // `single` held by another live process.
        let parent = f.parent();
        f.lock(json!({
            "pid": parent.pid,
            "processIdentity": { "createdAtTicks": Fixture::ticks_of(&parent) },
            "layout": "single",
        }));
        assert_eq!(f.check(), refused);
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
        );
        assert_eq!(result, Ok(()));
        assert_eq!(lease(&runtime), Some((pid, Layout::Single)));
    }
}
