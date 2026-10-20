//! 中继客户端、变更流与加密空间存储（2.x `packages/sync-protocol/test` 的 relay-errors、relay-lifetime、
//! space-store 三组用例）。

mod support;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use atm_sync::feed::{ChangeFeed, ChangeFeedOptions};
use atm_sync::relay::{RelayClient, RelayClientOptions, RelayError, RelayErrorCode};
use atm_sync::space::{DeviceRef, SpaceStore, SpaceStoreOptions, StoreError};
use atm_sync::transport::{Cancel, HttpRequest, HttpResponse, NetFailure, Sleeper, Transport};
use atm_sync_protocol::SpaceKeys;
use atm_sync_protocol::encoding::{random_bytes, to_base64url};
use atm_sync_protocol::envelope::{PART_CHARS, seal_object};
use atm_sync_protocol::error::SyncErrorCode;
use atm_sync_protocol::pairing::generate_space;
use serde_json::{Value, json};
use support::{MemoryRelay, TOKEN};

// ─── 恶意中继：每个请求都把 Authorization 交给 `answer` 反射回来 ───

const HOSTILE_TOKEN: &str = "dummy-review-token-5f3a91";

type Answer = Box<dyn Fn(&str) -> Result<HttpResponse, NetFailure> + Send + Sync>;

struct Hostile(Answer);

impl Transport for Hostile {
    fn send(&self, request: &HttpRequest, _: &[&Cancel]) -> Result<HttpResponse, NetFailure> {
        (self.0)(request.header("Authorization").unwrap_or(""))
    }
}

fn hostile(
    answer: impl Fn(&str) -> Result<HttpResponse, NetFailure> + Send + Sync + 'static,
) -> RelayClient {
    RelayClient::new(RelayClientOptions {
        base_url: "https://relay.example.com".into(),
        app_id: "atm".into(),
        token: HOSTILE_TOKEN.into(),
        transport: Arc::new(Hostile(Box::new(answer))),
        timeout: None,
        lifetime: None,
    })
    .unwrap()
}

fn raw(status: u16, text: &str, headers: &[(&str, &str)]) -> Result<HttpResponse, NetFailure> {
    Ok(HttpResponse {
        status,
        headers: headers
            .iter()
            .map(|(n, v)| (n.to_string(), v.to_string()))
            .collect(),
        body: text.as_bytes().to_vec(),
    })
}

fn body(status: u16, value: Value) -> Result<HttpResponse, NetFailure> {
    raw(status, &value.to_string(), &[])
}

fn failure(
    answer: impl Fn(&str) -> Result<HttpResponse, NetFailure> + Send + Sync + 'static,
) -> RelayError {
    hostile(answer).changes(None, None, 0.0, None).unwrap_err()
}

/// 所有可能被打印、序列化或返回的形态里都不能有 token。
fn no_token(e: &RelayError) {
    for text in [
        e.message.clone(),
        e.code.as_str().to_owned(),
        e.to_string(),
        format!("{e:?}"),
    ] {
        assert!(!text.contains(HOSTILE_TOKEN), "{text}");
    }
}

#[test]
fn relay_errors_do_not_reflect_relay_text() {
    type Case = (
        &'static str,
        Box<dyn Fn(&str) -> Result<HttpResponse, NetFailure> + Send + Sync>,
        (u16, &'static str, &'static str),
    );
    let cases: Vec<Case> = vec![
        (
            "5xx：token 在 error.message",
            Box::new(|a: &str| body(500, json!({"error": {"code": "INTERNAL", "message": a}}))),
            (500, "INTERNAL", "中继内部出错"),
        ),
        (
            "5xx：token 在 error.code",
            Box::new(|a: &str| body(503, json!({"error": {"code": a, "message": "x"}}))),
            (503, "RELAY_ERROR", "中继暂时不可用"),
        ),
        (
            "5xx：正文不是 JSON",
            Box::new(|a: &str| raw(502, &format!("upstream said: {a}"), &[])),
            (502, "RELAY_ERROR", "中继暂时不可用"),
        ),
        (
            "4xx：token 在 error.message",
            Box::new(|a: &str| {
                body(
                    413,
                    json!({"error": {"code": "PAYLOAD_TOO_LARGE", "message": a}}),
                )
            }),
            (413, "PAYLOAD_TOO_LARGE", "内容超过中继允许的大小"),
        ),
        (
            "4xx：token 在 error.code",
            Box::new(|a: &str| body(400, json!({"error": {"code": a, "message": "x"}}))),
            (400, "RELAY_ERROR", "中继拒绝了这个请求"),
        ),
        (
            "4xx：正文不是 JSON",
            Box::new(|a: &str| raw(418, a, &[])),
            (418, "RELAY_ERROR", "中继拒绝了这个请求"),
        ),
        (
            "401：文字是本地的",
            Box::new(|a: &str| {
                body(
                    401,
                    json!({"error": {"code": "UNAUTHORIZED", "message": format!("bad {a}")}}),
                )
            }),
            (
                401,
                "UNAUTHORIZED",
                "中继不认这个 token（没带、填错或已吊销）",
            ),
        ),
    ];
    for (name, answer, (status, code, message)) in cases {
        let e = failure(answer);
        assert_eq!(
            (e.status, e.code.as_str(), e.message.as_str()),
            (status, code, message),
            "{name}"
        );
        no_token(&e);
    }
    let auth = failure(|_| body(403, json!({"error": {"code": "FORBIDDEN"}})));
    assert!(auth.is_auth_failure());
}

#[test]
fn whitelisted_codes_need_their_status_and_prototype_names_are_unknown() {
    let mismatched = failure(|_| body(500, json!({"error": {"code": "REVISION_CONFLICT"}})));
    assert_eq!(mismatched.code, RelayErrorCode::RelayError);
    for code in [
        "constructor",
        "__proto__",
        "toString",
        "hasOwnProperty",
        "NETWORK",
        "ABORTED",
    ] {
        let e = failure(move |_| body(400, json!({"error": {"code": code}})));
        assert_eq!(
            (e.code, e.message.as_str()),
            (RelayErrorCode::RelayError, "中继拒绝了这个请求")
        );
    }
    // 数组形式的 error、缺 code：都按 RELAY_ERROR。
    let array = failure(|_| body(429, json!({"error": ["RATE_LIMITED"]})));
    assert_eq!(array.code, RelayErrorCode::RelayError);
}

#[test]
fn a_conflict_keeps_only_the_numbers_of_the_current_version() {
    let e = hostile(|a| {
        body(409, json!({
            "error": {"code": "REVISION_CONFLICT", "message": a},
            "current": {"key": a, "revision": 7, "schema_version": 2, "updated_at": a, "updated_by_device": a, "size_bytes": 12, "data": {"leak": a}},
        }))
    })
    .put_document("atm1/k", 3.0, &json!({"x": 1}))
    .unwrap_err();
    assert_eq!(e.code, RelayErrorCode::RevisionConflict);
    let c = e.current.unwrap();
    assert_eq!(
        (c.revision, c.schema_version, c.size_bytes),
        (7.0, 2.0, 12.0)
    );
    no_token(&e);
    for revision in [
        json!(-1),
        json!(1.5),
        json!("7"),
        json!(9_007_199_254_740_993u64),
    ] {
        let e = hostile(move |_| {
            body(
                409,
                json!({"error": {"code": "REVISION_CONFLICT"}, "current": {"revision": revision}}),
            )
        })
        .put_document("atm1/k", 3.0, &json!({"x": 1}))
        .unwrap_err();
        assert_eq!(e.current.unwrap().revision, 0.0);
    }
    // current 是数组或缺失：不记。
    let e = hostile(|_| {
        body(
            409,
            json!({"error": {"code": "REVISION_CONFLICT"}, "current": [1]}),
        )
    })
    .put_document("atm1/k", 3.0, &json!({}))
    .unwrap_err();
    assert_eq!(e.current, None);
}

#[test]
fn retry_after_is_read_only_from_numbers() {
    let after = |answer: Answer| failure(answer).retry_after;
    assert_eq!(
        after(Box::new(|_| body(
            429,
            json!({"error": {"code": "RATE_LIMITED", "retry_after": 3}})
        ))),
        Some(3.0)
    );
    assert_eq!(
        after(Box::new(|_| raw(
            429,
            r#"{"error":{"code":"RATE_LIMITED"}}"#,
            &[("Retry-After", " 7 ")]
        ))),
        Some(7.0)
    );
    assert_eq!(
        after(Box::new(|_| body(
            429,
            json!({"error": {"code": "RATE_LIMITED", "retry_after": "5"}})
        ))),
        None
    );
    assert_eq!(
        after(Box::new(|a| raw(
            429,
            r#"{"error":{"code":"RATE_LIMITED"}}"#,
            &[("Retry-After", a)]
        ))),
        None
    );
    assert_eq!(
        after(Box::new(|_| raw(
            429,
            r#"{"error":{"code":"RATE_LIMITED"}}"#,
            &[("Retry-After", "Wed, 21 Oct 2026 07:28:00 GMT")]
        ))),
        None
    );
    assert_eq!(
        after(Box::new(|_| body(
            429,
            json!({"error": {"code": "RATE_LIMITED", "retry_after": -2}})
        ))),
        None
    );
    assert_eq!(
        after(Box::new(|_| body(
            429,
            json!({"error": {"code": "RATE_LIMITED", "retry_after": 1e9}})
        ))),
        Some(600.0)
    );
    assert_eq!(
        after(Box::new(|_| raw(
            429,
            r#"{"error":{"code":"RATE_LIMITED"}}"#,
            &[("Retry-After", "1234567")]
        ))),
        None
    );
}

#[test]
fn network_failures_carry_no_peer_text() {
    let net = |f: NetFailure| failure(move |_| Err(f.clone()));
    let plain = net(NetFailure::Failed { code: None });
    assert_eq!(
        (plain.status, plain.code, plain.message.as_str()),
        (0, RelayErrorCode::Network, "连不上中继")
    );
    let refused = net(NetFailure::Failed {
        code: Some("ERROR_WINHTTP_CANNOT_CONNECT".into()),
    });
    assert_eq!(
        refused.message,
        "连不上中继（ERROR_WINHTTP_CANNOT_CONNECT）"
    );
    let odd = net(NetFailure::Failed {
        code: Some(format!("Bearer {HOSTILE_TOKEN}")),
    });
    assert_eq!(odd.message, "连不上中继");
    let lower = net(NetFailure::Failed {
        code: Some("econnrefused".into()),
    });
    assert_eq!(lower.message, "连不上中继");
    let timeout = net(NetFailure::Timeout);
    assert_eq!(timeout.message, "连接中继超时");
    let cancelled = net(NetFailure::Cancelled);
    assert!(cancelled.is_aborted());
    for e in [plain, refused, odd, timeout] {
        no_token(&e);
    }
}

#[test]
fn invalid_keys_are_not_spelled_into_the_error() {
    let client = hostile(|_| body(200, json!({})));
    let e = client
        .get_document(&format!("atm1/Bearer {HOSTILE_TOKEN}"), None)
        .unwrap_err();
    assert_eq!(
        (e.status, e.code, e.message.as_str()),
        (0, RelayErrorCode::KeyInvalid, "文档键不合法")
    );
    no_token(&e);
}

#[test]
fn probe_labels_are_filtered_by_character_set() {
    let probe = hostile(|a| body(200, json!({"id": "atm", "relay": {"name": a, "version": format!("1.0 {a}"), "long_poll": true}}))).probe().unwrap();
    assert_eq!(
        (
            probe.server.as_str(),
            probe.version.as_deref(),
            probe.long_poll
        ),
        ("app-data", None, true)
    );
    let fine = hostile(|_| body(200, json!({"id": "atm", "relay": {"name": "atm-relay", "version": "1.2.0-rc.1", "max_wait": 99}}))).probe().unwrap();
    assert_eq!(
        (fine.server.as_str(), fine.version.as_deref(), fine.max_wait),
        ("atm-relay", Some("1.2.0-rc.1"), 25.0)
    );
    let other = hostile(|_| body(200, json!({"id": "other"})))
        .probe()
        .unwrap_err();
    assert_eq!(other.code, RelayErrorCode::AppMismatch);
    let empty = hostile(|_| raw(200, "", &[])).probe().unwrap_err();
    assert_eq!(empty.code, RelayErrorCode::AppMismatch);
}

#[test]
fn the_client_refuses_bad_urls_and_app_ids_and_hides_the_token_in_debug() {
    let make = |url: &str, app: &str| {
        RelayClient::new(RelayClientOptions {
            base_url: url.into(),
            app_id: app.into(),
            token: HOSTILE_TOKEN.into(),
            transport: Arc::new(Hostile(Box::new(|_| raw(200, "", &[])))),
            timeout: None,
            lifetime: None,
        })
    };
    assert!(make("http://relay.example.com", "atm").is_err());
    assert!(make("https://relay.example.com", "ATM").is_err());
    let ok = make("https://relay.example.com/base/", "atm").unwrap();
    assert_eq!(ok.base_url(), "https://relay.example.com/base");
    assert!(!format!("{ok:?}").contains(HOSTILE_TOKEN));
}

// ─── 生命周期 ───

/// 一直不回的中继：只在令牌取消时失败，并记下收到请求的次数。
struct Silent(Arc<Mutex<usize>>);

impl Transport for Silent {
    fn send(&self, _: &HttpRequest, cancel: &[&Cancel]) -> Result<HttpResponse, NetFailure> {
        *self.0.lock().unwrap() += 1;
        atm_sync::transport::run_cancellable(cancel, Some(Duration::from_millis(200)), || {
            std::thread::sleep(Duration::from_secs(5));
            Ok(HttpResponse::default())
        })
    }
}

#[test]
fn the_lifetime_cancels_requests_in_flight_and_after() {
    let seen = Arc::new(Mutex::new(0));
    let lifetime = Cancel::new();
    let client = RelayClient::new(RelayClientOptions {
        base_url: "https://relay.example.com".into(),
        app_id: "atm".into(),
        token: "lifetime-test-token".into(),
        transport: Arc::new(Silent(seen.clone())),
        timeout: None,
        lifetime: Some(lifetime.clone()),
    })
    .unwrap();
    let a = client.clone();
    let b = client.clone();
    let probing = std::thread::spawn(move || a.probe());
    let getting =
        std::thread::spawn(move || b.get_document("atm1/0123456789abcdef01234567/head", None));
    std::thread::sleep(Duration::from_millis(50));
    lifetime.cancel();
    assert!(probing.join().unwrap().unwrap_err().is_aborted());
    assert!(getting.join().unwrap().unwrap_err().is_aborted());
    let began = Instant::now();
    assert!(client.probe().unwrap_err().is_aborted());
    assert!(began.elapsed() < Duration::from_millis(100));
    assert!(*seen.lock().unwrap() >= 2);

    // 没有生命周期时只受单次超时约束（这里的传输层 200 ms 就超时）。
    let plain = RelayClient::new(RelayClientOptions {
        base_url: "https://relay.example.com".into(),
        app_id: "atm".into(),
        token: "lifetime-test-token".into(),
        transport: Arc::new(Silent(seen)),
        timeout: Some(Duration::from_millis(50)),
        lifetime: None,
    })
    .unwrap();
    assert_eq!(plain.probe().unwrap_err().message, "连接中继超时");
    // 单次调用的令牌只中断这一次。
    let once = Cancel::new();
    once.cancel();
    assert!(
        plain
            .changes(Some("1"), None, 25.0, Some(&once))
            .unwrap_err()
            .is_aborted()
    );
}

// ─── SpaceStore 与 ChangeFeed ───

struct Setup {
    relay: MemoryRelay,
    space_id: String,
    secret: String,
    client: RelayClient,
    store: SpaceStore,
    sleeps: Arc<Mutex<Vec<Duration>>>,
}

fn recording(sleeps: &Arc<Mutex<Vec<Duration>>>) -> Sleeper {
    let sleeps = sleeps.clone();
    Arc::new(move |d| {
        sleeps.lock().unwrap().push(d);
        true
    })
}

fn store_for(
    client: &RelayClient,
    secret: &str,
    space_id: &str,
    sleep: Option<Sleeper>,
) -> SpaceStore {
    SpaceStore::new(SpaceStoreOptions {
        client: client.clone(),
        keys: SpaceKeys::derive(secret).unwrap(),
        space_id: space_id.into(),
        retry_delay: None,
        lifetime: None,
        sleep,
    })
    .unwrap()
}

fn setup(long_poll: bool) -> Setup {
    let relay = MemoryRelay::new(long_poll);
    let (space_id, secret) = generate_space().unwrap();
    let client = relay.client(TOKEN, None);
    let sleeps = Arc::new(Mutex::new(Vec::new()));
    let store = store_for(&client, &secret, &space_id, Some(recording(&sleeps)));
    Setup {
        relay,
        space_id,
        secret,
        client,
        store,
        sleeps,
    }
}

fn head(at: &str) -> Value {
    json!({
        "v": 1,
        "host": {"id": "pc-0123456789ab", "name": "工作站", "app": "1.3.0"},
        "at": at,
        "dispatch": {"enabled": true, "mode": "auto", "running": 0},
        "projects": [],
    })
}

fn random_text(len: usize) -> String {
    let mut out = String::new();
    while out.len() < len {
        out.push_str(&to_base64url(&random_bytes::<48>().unwrap()));
    }
    out.truncate(len);
    out
}

/// 描述用随机内容，压不下去，保证会分成多片。
fn big_project(extra: u32) -> Value {
    let tasks: Vec<Value> = (0..300)
        .map(|i| {
            json!({
                "key": format!("ATM-T-{:04}", i + 1),
                "title": format!("任务 {i} 版本 {extra}"),
                "type": "TASK", "status": "READY", "priority": "NORMAL", "progress": 0,
                "updatedAt": "1970-01-01T00:00:00.000Z",
                "desc": random_text(1500),
            })
        })
        .collect();
    json!({"v": 1, "code": "ATM", "name": "ATM", "at": "2026-10-10T00:00:00.000Z", "tasks": tasks})
}

#[test]
fn only_ciphertext_reaches_the_relay_and_reads_back_equal() {
    let s = setup(false);
    let written = head("2026-10-10T00:00:00.000Z");
    s.store.write_head(&written).unwrap();
    let docs: Vec<Value> = s
        .relay
        .state()
        .docs
        .values()
        .map(|d| d.data.clone())
        .collect();
    assert_eq!(docs.len(), 1);
    assert!(!docs[0].to_string().contains("工作站"));
    assert_eq!(s.store.read_head().unwrap(), Some(written));
}

#[test]
fn a_stale_revision_cache_retries_once_with_the_conflicts_current() {
    let s = setup(false);
    s.store
        .write_head(&head("2026-10-10T00:00:00.000Z"))
        .unwrap();
    let fresh = store_for(&s.client, &s.secret, &s.space_id, None);
    fresh.write_head(&head("2030-01-01T00:00:00.000Z")).unwrap();
    assert_eq!(
        s.store.read_head().unwrap().unwrap()["at"],
        "2030-01-01T00:00:00.000Z"
    );
}

#[test]
fn large_objects_write_the_other_parts_first_and_trim_leftovers() {
    let s = setup(false);
    let hash = s.store.project_hash("ATM");
    s.store.write_project(&hash, &big_project(0)).unwrap();
    let puts = s.relay.puts_since(0);
    assert!(puts.len() > 1);
    assert!(puts.last().unwrap().ends_with(&format!("/p/{hash}")));
    assert_eq!(
        s.store.read_project(&hash).unwrap().unwrap()["tasks"]
            .as_array()
            .unwrap()
            .len(),
        300
    );

    let mut empty = big_project(0);
    empty["tasks"] = json!([]);
    s.store.write_project(&hash, &empty).unwrap();
    let left: Vec<String> = s
        .relay
        .keys()
        .into_iter()
        .filter(|k| k.contains(&format!("/p/{hash}")))
        .collect();
    assert_eq!(left, [format!("atm1/{}/p/{hash}", s.space_id)]);
    assert_eq!(
        s.store.read_project(&hash).unwrap().unwrap()["tasks"],
        json!([])
    );
}

#[test]
fn a_half_written_object_is_read_again_after_a_wait() {
    let s = setup(false);
    let keys = SpaceKeys::derive(&s.secret).unwrap();
    let hash = s.store.project_hash("ATM");
    s.store.write_project(&hash, &big_project(0)).unwrap();
    // 写入方刚写完新版本的其余片、还没写第 0 片。
    let logical = format!("atm1/{}/p/{hash}", s.space_id);
    let next_doc = big_project(1);
    let next = seal_object(&keys, &logical, &next_doc).unwrap();
    for part in &next[1..] {
        let current = s
            .relay
            .state()
            .docs
            .get(&part.key)
            .map_or(0, |d| d.revision);
        s.client
            .put_document(&part.key, current as f64, &part.data)
            .unwrap();
    }
    let finished = Arc::new(Mutex::new(false));
    let (flag, client, relay, head_part) = (
        finished.clone(),
        s.client.clone(),
        s.relay.clone(),
        next[0].clone(),
    );
    let reader = store_for(
        &s.client,
        &s.secret,
        &s.space_id,
        Some(Arc::new(move |_| {
            let mut done = flag.lock().unwrap();
            if !*done {
                *done = true;
                let current = relay
                    .state()
                    .docs
                    .get(&head_part.key)
                    .map_or(0, |d| d.revision);
                client
                    .put_document(&head_part.key, current as f64, &head_part.data)
                    .unwrap();
            }
            true
        })),
    );
    let doc = reader.read_project(&hash).unwrap().unwrap();
    assert!(*finished.lock().unwrap());
    assert_eq!(doc["tasks"][0]["title"], next_doc["tasks"][0]["title"]);
}

#[test]
fn reading_gives_up_after_four_attempts_with_growing_waits() {
    let s = setup(false);
    let keys = SpaceKeys::derive(&s.secret).unwrap();
    let hash = s.store.project_hash("ATM");
    let logical = format!("atm1/{}/p/{hash}", s.space_id);
    let parts = seal_object(&keys, &logical, &big_project(0)).unwrap();
    // 只有第 0 片：其余片永远读不到。
    s.client
        .put_document(&parts[0].key, 0.0, &parts[0].data)
        .unwrap();
    let e = s.store.read_project(&hash).unwrap_err();
    assert!(e.is_incomplete(), "{e:?}");
    assert_eq!(
        *s.sleeps.lock().unwrap(),
        [400, 800, 1200].map(Duration::from_millis)
    );
}

#[test]
fn commands_are_fresh_writes_and_acks_round_trip() {
    let s = setup(false);
    let device = DeviceRef {
        id: "m-0123456789ab".into(),
        name: "OnePlus 9".into(),
    };
    let now = 1_791_000_000_000u64;
    let command = s
        .store
        .send_command(&device, &json!({"type": "task.create", "body": {"project": "ATM", "title": "修一下登录页", "dispatch": true}}), now, "2026-10-03T03:20:00.000Z")
        .unwrap();
    let id = command["id"].as_str().unwrap().to_owned();
    assert_eq!(
        s.store.read_command(&id).unwrap().unwrap()["body"]["title"],
        "修一下登录页"
    );
    s.store
        .write_ack(&json!({"v": 1, "id": id, "at": "2026-10-03T03:20:01.000Z", "ok": true, "result": {"project": "ATM", "key": "ATM-T-0600"}}))
        .unwrap();
    s.store.delete_command(&id).unwrap();
    assert_eq!(s.store.read_command(&id).unwrap(), None);
    assert_eq!(s.store.read_ack(&id).unwrap().unwrap()["ok"], true);
    assert_eq!(s.store.list_keys("ack").unwrap().len(), 1);
    // 命令与回执都按「新建」写：没有列举旧分片的请求。
    assert!(
        !s.relay
            .state()
            .requests
            .iter()
            .any(|r| r.url.contains("prefix=") && r.url.contains("%2Fcmd%2F"))
    );
}

#[test]
fn recreating_after_a_delete_uses_monotonic_revisions() {
    let s = setup(false);
    let doc = json!({"v": 1, "id": "m-0123456789ab", "name": "手机", "kind": "android", "role": "client", "app": "1.0.0", "at": "2026-10-10T00:00:00.000Z", "state": "online"});
    s.store.write_device(&doc).unwrap();
    s.store.delete_device("m-0123456789ab").unwrap();
    let mut offline = doc.clone();
    offline["state"] = json!("offline");
    s.store.write_device(&offline).unwrap();
    assert_eq!(
        s.store.read_device("m-0123456789ab").unwrap().unwrap()["state"],
        "offline"
    );
    let revisions: Vec<u64> = s
        .relay
        .state()
        .changes
        .iter()
        .filter(|c| c.key.ends_with("m-0123456789ab"))
        .map(|c| c.revision)
        .collect();
    assert_eq!(revisions, [1, 2, 3]);
}

#[test]
fn a_wrong_token_is_an_auth_failure() {
    let s = setup(false);
    let client = s.relay.client("wrong-token", None);
    let store = store_for(&client, &s.secret, &s.space_id, None);
    match store.read_head().unwrap_err() {
        StoreError::Relay(e) => assert!(e.is_auth_failure()),
        other => panic!("{other:?}"),
    }
}

#[test]
fn documents_that_do_not_open_are_protocol_errors() {
    let s = setup(false);
    let key = format!("atm1/{}/head", s.space_id);
    s.relay.put_raw(&key, json!({"v": 1, "kid": "00000000", "iv": "AAAAAAAAAAAAAAAA", "z": 0, "n": 1, "d": "0000000000000000", "c": "AAAA"}));
    match s.store.read_head().unwrap_err() {
        StoreError::Protocol(e) => assert_eq!(e.code, SyncErrorCode::KeyMismatch),
        other => panic!("{other:?}"),
    }
    s.relay.put_raw(&key, json!("not an envelope"));
    assert!(matches!(
        s.store.read_head().unwrap_err(),
        StoreError::Protocol(_)
    ));
    // 写入前也按协议校验。
    assert!(
        matches!(s.store.write_head(&json!({"v": 2})).unwrap_err(), StoreError::Protocol(e) if e.code == SyncErrorCode::SchemaInvalid)
    );
}

fn feed(
    s: &Setup,
    cursor: Option<&str>,
    long_poll: bool,
    max_wait: Option<f64>,
    naps: &Arc<Mutex<Vec<Duration>>>,
) -> ChangeFeed {
    ChangeFeed::new(ChangeFeedOptions {
        client: s.client.clone(),
        space_id: s.space_id.clone(),
        cursor: cursor.map(str::to_owned),
        long_poll,
        max_wait,
        interval: Duration::from_millis(3000),
        sleep: Some(recording(naps)),
    })
    .unwrap()
}

#[test]
fn the_feed_bootstraps_then_gives_only_this_space_and_waits_after_an_empty_batch() {
    let s = setup(false);
    s.store
        .write_head(&head("2026-10-10T00:00:00.000Z"))
        .unwrap();
    let naps = Arc::new(Mutex::new(Vec::new()));
    let mut f = feed(&s, None, false, None, &naps);
    let first = f.next(None).unwrap();
    assert!(first.reset && first.changes.is_empty());
    assert_eq!(f.cursor(), Some(s.relay.state().seq.to_string().as_str()));

    s.client
        .put_document(
            "atm1/ffffffffffffffffffffffff/head",
            0.0,
            &json!({"foreign": true}),
        )
        .unwrap();
    s.store
        .write_head(&head("2031-01-01T00:00:00.000Z"))
        .unwrap();
    let batch = f.next(None).unwrap();
    assert!(!batch.reset);
    assert_eq!(
        batch
            .changes
            .iter()
            .map(|c| c.key.clone())
            .collect::<Vec<_>>(),
        [format!("atm1/{}/head", s.space_id)]
    );
    assert!(naps.lock().unwrap().is_empty());
    assert!(f.next(None).unwrap().changes.is_empty());
    assert!(naps.lock().unwrap().is_empty());
    f.next(None).unwrap();
    assert_eq!(*naps.lock().unwrap(), [Duration::from_millis(3000)]);
    // poke：下一次不等。
    f.poke();
    f.next(None).unwrap();
    assert_eq!(naps.lock().unwrap().len(), 1);
}

#[test]
fn an_expired_cursor_rebuilds_the_feed_and_asks_for_a_full_listing() {
    let s = setup(false);
    s.store
        .write_head(&head("2026-10-10T00:00:00.000Z"))
        .unwrap();
    let naps = Arc::new(Mutex::new(Vec::new()));
    let mut f = feed(&s, Some("1"), false, None, &naps);
    for i in 0..5 {
        s.store
            .write_head(&head(&format!("2031-01-0{}T00:00:00.000Z", i + 1)))
            .unwrap();
    }
    s.relay.prune(2);
    let batch = f.next(None).unwrap();
    assert!(batch.reset);
    assert_eq!(f.cursor(), Some(s.relay.state().seq.to_string().as_str()));
}

#[test]
fn long_polling_sends_wait_and_never_sleeps_locally() {
    let s = setup(true);
    let probe = s.client.probe().unwrap();
    assert!(probe.long_poll);
    let naps = Arc::new(Mutex::new(Vec::new()));
    let mut f = feed(&s, Some("0"), probe.long_poll, Some(probe.max_wait), &naps);
    f.next(None).unwrap();
    f.next(None).unwrap();
    let urls: Vec<String> = s
        .relay
        .state()
        .requests
        .iter()
        .filter(|r| r.url.contains("/changes"))
        .map(|r| r.url.clone())
        .collect();
    assert_eq!(urls.len(), 2);
    assert!(urls.iter().all(|u| u.contains("wait=25")), "{urls:?}");
    assert!(naps.lock().unwrap().is_empty());
}

#[test]
fn a_cancelled_feed_wait_stops_the_loop() {
    let s = setup(false);
    let mut f = ChangeFeed::new(ChangeFeedOptions {
        client: s.client.clone(),
        space_id: s.space_id.clone(),
        cursor: Some("0".into()),
        long_poll: false,
        max_wait: None,
        interval: Duration::from_secs(30),
        sleep: None,
    })
    .unwrap();
    let stop = Cancel::new();
    f.next(Some(&stop)).unwrap();
    let other = stop.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(30));
        other.cancel();
    });
    let began = Instant::now();
    assert!(f.next(Some(&stop)).unwrap_err().is_aborted());
    assert!(began.elapsed() < Duration::from_secs(5));
}

#[test]
fn an_oversized_object_is_refused_before_anything_is_written() {
    let s = setup(false);
    let hash = s.store.project_hash("HUGE");
    let mut bytes = Vec::with_capacity(8 * 1024 * 1024);
    while bytes.len() < 8 * 1024 * 1024 {
        bytes.extend_from_slice(&random_bytes::<4096>().unwrap());
    }
    let noise = to_base64url(&bytes);
    assert!(noise.len() > 64 * PART_CHARS);
    let e = s
        .store
        .write_object(
            &format!("atm1/{}/p/{hash}", s.space_id),
            &json!({"noise": noise}),
            false,
        )
        .unwrap_err();
    assert!(matches!(e, StoreError::Protocol(e) if e.code == SyncErrorCode::ObjectTooLarge));
    assert!(s.relay.state().docs.is_empty());
}
