//! Rust→TS：`tests/data/rust-sealed.json` 是本 crate 用固定 IV、固定随机后缀写出来的东西（加密对象含压缩与多片、
//! 配对码、各种键、命令 ID）。仓库里的文件必须与当前代码的输出逐字节一致（不一致就红，`ATM_SYNC_BLESS=1` 重写）；
//! TS 那边的 `packages/sync-protocol/test/rust-vectors.test.ts` 用手机 App 的代码逐条打开、解码、核对。

use atm_sync_protocol::SpaceKeys;
use atm_sync_protocol::encoding::to_base64url;
use atm_sync_protocol::envelope::seal_object_with_iv;
use atm_sync_protocol::keys;
use atm_sync_protocol::pairing::{PairingPayload, encode_pairing_code};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const BLESS: &str = "ATM_SYNC_BLESS";
const SPACE: &str = "fedcba9876543210fedcba98";

fn secret(seed: u8) -> String {
    let bytes: Vec<u8> = (0..32u8)
        .map(|i| i.wrapping_mul(29).wrapping_add(seed))
        .collect();
    to_base64url(&bytes)
}

/// 不可压缩的 base64url 串（逐段 sha256）。
fn random64(n: usize, seed: u32) -> String {
    let mut bytes = Vec::new();
    let mut i = 0u32;
    while bytes.len() * 4 < n * 3 + 4 {
        bytes.extend_from_slice(&Sha256::digest(format!("{seed}:{i}").as_bytes()));
        i += 1;
    }
    to_base64url(&bytes)[..n].to_owned()
}

fn golden() -> Value {
    let secrets: Vec<Value> = [1u8, 77, 200]
        .iter()
        .map(|seed| {
            let s = secret(*seed);
            let k = SpaceKeys::derive(&s).unwrap();
            json!({
                "secret": s,
                "kid": k.kid,
                "projectHash": { "ATM": k.project_hash("ATM"), "Z9_-X": k.project_hash("Z9_-X") },
            })
        })
        .collect();

    let secret0 = secret(1);
    let keys0 = SpaceKeys::derive(&secret0).unwrap();
    let project = keys::project_key(SPACE, &keys0.project_hash("ATM")).unwrap();
    let values = [
        (
            "small",
            keys::head_key(SPACE).unwrap(),
            json!({ "v": 1, "text": "你好 😀", "n": [1, 2, 3], "f": 2.5, "b": false, "z": null }),
        ),
        (
            "threshold",
            project.clone(),
            json!({ "s": "y".repeat(1016) }),
        ),
        (
            "compressed",
            project.clone(),
            json!({ "v": 1, "text": "ATM ".repeat(3000) }),
        ),
        (
            "multiPart",
            project,
            json!({ "v": 1, "blob": random64(170_000, 7) }),
        ),
    ];
    let sealed: Vec<Value> = values
        .iter()
        .enumerate()
        .map(|(i, (name, logical_key, value))| {
            let parts = seal_object_with_iv(&keys0, logical_key, value, [i as u8 + 0x41; 12]).unwrap();
            json!({
                "name": name,
                "secret": secret0,
                "logicalKey": logical_key,
                "value": value,
                "parts": parts.iter().map(|p| json!({ "key": p.key, "data": p.data })).collect::<Vec<_>>(),
            })
        })
        .collect();
    let compressed = &sealed[2]["parts"][0]["data"]["z"];
    assert_eq!(compressed, 1, "the compressed vector is compressed");
    assert!(
        sealed[3]["parts"].as_array().unwrap().len() >= 2,
        "the multi-part vector has parts"
    );

    let payloads = [
        (
            "https://Relay.Example.com:443/api/",
            "atm",
            "relay-token-1",
            "我的电脑",
        ),
        ("http://127.0.0.1:8787", "atm-dev", "12345678", ""),
    ];
    let pairing: Vec<Value> = payloads
        .iter()
        .map(|(u, a, t, n)| {
            let p = PairingPayload {
                relay_url: (*u).to_owned(),
                app_id: (*a).to_owned(),
                relay_token: (*t).to_owned(),
                space_id: SPACE.to_owned(),
                space_secret: secret(9),
                host_name: (*n).to_owned(),
            };
            json!({
                "payload": { "u": u, "a": a, "t": t, "s": SPACE, "k": secret(9), "n": n },
                "code": encode_pairing_code(&p).unwrap(),
            })
        })
        .collect();

    let cmd = keys::command_id(
        "m-00aa11bb22cc",
        1_760_000_000_000,
        [0xde, 0xad, 0xbe, 0xef],
    )
    .unwrap();
    let command_ids: Vec<Value> = [
        ("pc-0123456789ab", 0u64, [0u8; 4]),
        ("m-00aa11bb22cc", 1_760_000_000_000, [0xde, 0xad, 0xbe, 0xef]),
        ("pc-ffffffffffff", 4_000_000_000_000, [1, 2, 3, 4]),
    ]
    .iter()
    .map(|(device, now, suffix)| {
        json!({ "device": device, "nowMs": now, "id": keys::command_id(device, *now, *suffix).unwrap() })
    })
    .collect();
    let built = json!({
        "space": SPACE,
        "command": cmd,
        "spacePrefix": keys::space_prefix(SPACE).unwrap(),
        "headKey": keys::head_key(SPACE).unwrap(),
        "revokedKey": keys::revoked_key(SPACE).unwrap(),
        "projectKey": keys::project_key(SPACE, "0123456789abcdef0123").unwrap(),
        "commandKey": keys::command_key(SPACE, &cmd).unwrap(),
        "ackKey": keys::ack_key(SPACE, &cmd).unwrap(),
        "deviceKey": keys::device_key(SPACE, "m-00aa11bb22cc").unwrap(),
        "partKey": keys::part_key(&keys::head_key(SPACE).unwrap(), 7).unwrap(),
    });

    json!({
        "note": "Generated by atm-sync-protocol tests/rust_sealed.rs (ATM_SYNC_BLESS=1 cargo test -p atm-sync-protocol --test rust_sealed); do not edit by hand.",
        "secrets": secrets,
        "sealed": sealed,
        "pairing": pairing,
        "commandIds": command_ids,
        "keys": built,
    })
}

#[test]
fn the_rust_output_file_is_current() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/rust-sealed.json");
    let text = format!("{}\n", serde_json::to_string(&golden()).unwrap());
    if std::env::var_os(BLESS).is_some() {
        std::fs::write(path, &text).unwrap();
        return;
    }
    let on_disk = std::fs::read_to_string(path).unwrap_or_default();
    assert!(
        on_disk == text,
        "tests/data/rust-sealed.json is stale: run `{BLESS}=1 cargo test -p atm-sync-protocol --test rust_sealed`, \
         then check it opens in TS (`pnpm exec vitest run packages/sync-protocol/test/rust-vectors.test.ts`)"
    );
}

/// 同一份输入两次加密结果相同（固定 IV），不同 IV 不同：golden 文件确实由 IV 决定，没有混进别的随机数。
#[test]
fn sealing_with_a_fixed_iv_is_deterministic() {
    let k = SpaceKeys::derive(&secret(1)).unwrap();
    let value = json!({ "a": "ATM ".repeat(500) });
    let a = seal_object_with_iv(&k, "atm1/x", &value, [1; 12]).unwrap();
    assert_eq!(
        a,
        seal_object_with_iv(&k, "atm1/x", &value, [1; 12]).unwrap()
    );
    assert_ne!(
        a,
        seal_object_with_iv(&k, "atm1/x", &value, [2; 12]).unwrap()
    );
}
