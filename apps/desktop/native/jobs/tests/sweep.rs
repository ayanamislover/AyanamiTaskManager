//! 调度器的 session 扫描按客户端存活（S-012、R11 P1-3，W4i）：客户端进程还在的，30 min 没心跳也不收；
//! 退出了的立刻收；没有身份的按普通超时。

use atm_domain::principal::Principal;
use atm_install_state::procs;
use atm_service::session::BeginRequest;
use atm_service::write::Service;
use atm_store::{Config, Store};
use std::path::PathBuf;

/// 测试的可写目录：跟着 `CARGO_TARGET_DIR` 走（W2 r1 P2-02）。
fn dir(name: &str) -> PathBuf {
    let root = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("target")
        })
        .join("jobs-tests")
        .join(name);
    let d = std::path::absolute(root).unwrap();
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn begin(svc: &Service, client: Option<String>, op: &str) -> (String, String) {
    let agent = Principal::authenticated_agent(client);
    let mut req = BeginRequest::new("claude-code");
    req.title = Some("扫描".into());
    req.mode = Some("project".into());
    req.allow_project_create = true;
    req.op_id = Some(op.into());
    let begun = svc.begin(&agent, req).unwrap();
    (
        begun.result["project"]["id"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| {
                svc.project_id(&agent, begun.result["project"]["code"].as_str().unwrap())
                    .unwrap()
            }),
        begun.result["session"]["id"].as_str().unwrap().to_owned(),
    )
}

fn state(svc: &Service, session: &str) -> (String, Option<String>) {
    svc.store()
        .read({
            let session = session.to_owned();
            move |tx| {
                tx.query_row(
                    "SELECT connection_state, close_reason FROM agent_sessions WHERE id = ?1",
                    [&session],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
            }
        })
        .unwrap()
}

#[test]
fn the_sweep_respects_client_liveness() {
    let d = dir("sweep");
    let store = Store::open(&d.join("atm.sqlite"), Config::default()).unwrap();
    store
        .write(|tx| {
            tx.execute_batch(
                "INSERT INTO app_meta (singleton, schema_version, data_root_id, generation, instance_epoch, created_at, updated_at)
                 VALUES (1, 1, 'ROOT', 'G', 'EPOCH', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z')",
            )
        })
        .unwrap();
    let svc = Service::new(store);
    let me = procs::find(std::process::id()).unwrap();
    let (_, live) = begin(
        &svc,
        Some(format!("{}:{}@live", me.pid, me.created)),
        "b-live",
    );
    let (_, gone) = begin(
        &svc,
        Some(format!("{}:{}@gone", me.pid, me.created + 1)),
        "b-gone",
    );
    let (_, anonymous) = begin(&svc, None, "b-anon");
    // 三个 session 的心跳都停在 30 min 前。
    svc.store()
        .write(|tx| {
            tx.execute(
                "UPDATE agent_sessions SET heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes'),
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes')",
                [],
            )
        })
        .unwrap();

    let report = atm_jobs::sweep_once(&svc).unwrap();
    assert_eq!(report.closed.len(), 2, "{:?}", report.closed);
    assert_eq!(state(&svc, &live), ("ONLINE".into(), None));
    assert_eq!(
        state(&svc, &gone),
        ("CLOSED".into(), Some("CLIENT_EXITED".into()))
    );
    assert_eq!(
        state(&svc, &anonymous),
        ("CLOSED".into(), Some("HEARTBEAT_TIMEOUT".into()))
    );
}
