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
    let owner: LockOwner =
        crate::fsx::read_json_limited(&runtime_dir.join("daemon.lock"), 64 * 1024)
            .ok()
            .flatten()?;
    let proc = procs::find(owner.pid)?;
    match owner.process_identity {
        Some(identity) => {
            let ticks = procs::filetime_to_dotnet_ticks(proc.created).to_string();
            (ticks == identity.created_at_ticks).then_some(owner.pid)
        }
        // Old locks without identity: a live pid is taken as the holder (conservative).
        None => Some(owner.pid),
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
    if procs::parent_of(core_pid) != Some(host.pid) || core_proc.created < host_proc.created {
        return Err("core is not a child of the host".into());
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
