//! TS→Rust：`tests/data/sync-vectors.json` 由 `sync-vectors.ts` 直接用手机 App 的 `packages/sync-protocol` 生成。
//! 每条都要与 TS 的结论一致：成功时结果相同，失败时错误码与提示文字一字不差。

use std::sync::OnceLock;

use atm_sync_protocol::envelope::{self, HeadEnvelope, SealedPart};
use atm_sync_protocol::keys::{self, ClassifiedKey, KeyKind};
use atm_sync_protocol::pairing::{self, PairingPayload};
use atm_sync_protocol::{SpaceKeys, SyncError, schema};
use serde_json::{Value, json};

fn v() -> &'static Value {
    static V: OnceLock<Value> = OnceLock::new();
    V.get_or_init(|| {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/sync-vectors.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    })
}

fn list(name: &str) -> &'static Vec<Value> {
    v()[name]
        .as_array()
        .unwrap_or_else(|| panic!("no {name} in the vectors"))
}

fn s(x: &Value) -> &str {
    x.as_str().unwrap()
}

/// TS 的失败：`{error, message}`。
fn expect_error(case: &Value, got: &SyncError, what: &str) {
    assert_eq!(got.code.as_str(), s(&case["error"]), "{what}: code");
    assert_eq!(got.message(), s(&case["message"]), "{what}: message");
}

fn parts_of(x: &Value) -> Vec<SealedPart> {
    x.as_array()
        .unwrap()
        .iter()
        .map(|p| SealedPart {
            key: s(&p["key"]).to_owned(),
            data: p["data"].clone(),
        })
        .collect()
}

fn open(keys: &SpaceKeys, logical_key: &str, parts: &[SealedPart]) -> Result<Value, SyncError> {
    let head = envelope::parse_head_envelope(&parts[0].data)?;
    envelope::open_object(keys, logical_key, &head, envelope::reader(parts))
}

#[test]
fn space_keys_derive_like_ts() {
    for k in list("keys") {
        let keys = SpaceKeys::derive(s(&k["secret"])).unwrap();
        assert_eq!(keys.kid, s(&k["kid"]));
        for (msg, mac) in k["hmac"].as_object().unwrap() {
            assert_eq!(keys.hmac_hex(msg), s(mac), "hmac {msg:?}");
        }
        for (code, hash) in k["projectHash"].as_object().unwrap() {
            assert_eq!(keys.project_hash(code), s(hash), "project {code:?}");
        }
    }
    for b in list("badSecrets") {
        let e = SpaceKeys::derive(s(&b["secret"])).unwrap_err();
        expect_error(b, &e, s(&b["secret"]));
    }
}

#[test]
fn objects_sealed_by_ts_open_in_rust() {
    let mut n = 0;
    for o in list("sealed").iter().chain([&v()["multi"]]) {
        let keys = SpaceKeys::derive(s(&o["secret"])).unwrap();
        let parts = parts_of(&o["parts"]);
        assert_eq!(
            open(&keys, s(&o["logicalKey"]), &parts).unwrap(),
            o["value"]
        );
        n += parts.len();
    }
    assert!(
        v()["multi"]["parts"].as_array().unwrap().len() == 2,
        "the multi-part vector has two parts"
    );
    assert!(n >= 6, "{n}");
}

#[test]
fn known_answer_seals_are_byte_identical_to_ts() {
    for k in list("knownAnswer") {
        let keys = SpaceKeys::derive(s(&k["secret"])).unwrap();
        let iv: [u8; 12] = (0..12)
            .map(|i| u8::from_str_radix(&s(&k["iv"])[i * 2..i * 2 + 2], 16).unwrap())
            .collect::<Vec<_>>()
            .try_into()
            .unwrap();
        let ours =
            envelope::seal_object_with_iv(&keys, s(&k["logicalKey"]), &k["value"], iv).unwrap();
        assert_eq!(ours, parts_of(&k["parts"]), "{}", k["value"]);
    }
}

/// `edits` 照 TS 的 `applyEdits` 改同一份多片分片。
fn edited_multi(edits: &Value) -> Vec<SealedPart> {
    let mut parts = parts_of(&v()["multi"]["parts"]);
    for e in edits.as_array().unwrap() {
        if let Some(i) = e["remove"].as_u64() {
            parts.remove(i as usize);
        } else if let Some(set) = e["set"].as_object() {
            let data = parts[e["part"].as_u64().unwrap() as usize]
                .data
                .as_object_mut()
                .unwrap();
            for (k, x) in set {
                data.insert(k.clone(), x.clone());
            }
        } else {
            parts[e["part"].as_u64().unwrap() as usize].data = e["replace"].clone();
        }
    }
    parts
}

#[test]
fn open_outcomes_match_ts() {
    let opens = list("opens");
    assert!(opens.len() >= 20);
    for o in opens {
        let name = s(&o["name"]);
        let keys = SpaceKeys::derive(s(&o["secret"])).unwrap();
        let parts = if o["base"] == "multi" {
            edited_multi(&o["edits"])
        } else {
            parts_of(&o["parts"])
        };
        let got = open(&keys, s(&o["logicalKey"]), &parts);
        match o.get("ok") {
            Some(ok) if ok == "<multi.value>" => {
                assert_eq!(got.unwrap(), v()["multi"]["value"], "{name}")
            }
            Some(ok) if ok.get("stringLength").is_some() => {
                let text = got.unwrap();
                let len: usize = text.as_str().unwrap().chars().map(char::len_utf16).sum();
                assert_eq!(len as u64, ok["stringLength"].as_u64().unwrap(), "{name}");
            }
            Some(ok) => assert_eq!(&got.unwrap(), ok, "{name}"),
            None => expect_error(o, &got.unwrap_err(), name),
        }
    }
}

/// `{ repeatA: n }` 是 n 个 "A"。
fn expand(x: &Value) -> Value {
    match x {
        Value::Object(o) if o.len() == 1 && o.contains_key("repeatA") => {
            Value::from("A".repeat(o["repeatA"].as_u64().unwrap() as usize))
        }
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), expand(x))).collect()),
        _ => x.clone(),
    }
}

fn head_json(h: &HeadEnvelope) -> Value {
    let mut j = h.to_json();
    if h.chunk.len() > 100 {
        j["c"] = Value::from(format!("<{}>", h.chunk.len()));
    }
    j
}

#[test]
fn head_envelopes_parse_like_ts() {
    for h in list("headCases") {
        let name = s(&h["name"]);
        let got = envelope::parse_head_envelope(&expand(&h["input"]));
        match h.get("ok") {
            Some(ok) => assert_eq!(&head_json(&got.unwrap()), ok, "{name}"),
            None => expect_error(h, &got.unwrap_err(), name),
        }
    }
}

type Format = (&'static str, fn(&str) -> bool);

#[test]
fn id_formats_match_the_ts_patterns() {
    let checks: [Format; 8] = [
        ("DOC_KEY", keys::is_doc_key),
        ("APP_ID", keys::is_app_id),
        ("SPACE_ID", keys::is_space_id),
        ("DEVICE_ID", keys::is_device_id),
        ("COMMAND_ID", keys::is_command_id),
        ("PROJECT_HASH", keys::is_project_hash),
        ("PROJECT_CODE", keys::is_project_code),
        ("TASK_KEY", keys::is_task_key),
    ];
    let cases = list("patternCases");
    for c in cases {
        for (name, f) in checks {
            assert_eq!(
                f(s(&c["s"])),
                c[name].as_bool().unwrap(),
                "{name} {:?}",
                c["s"]
            );
        }
    }
    // 每种格式至少有一个样本通过、一个不通过，否则这张表测不出什么。
    for (name, _) in checks {
        assert!(
            cases.iter().any(|c| c[name] == true) && cases.iter().any(|c| c[name] == false),
            "{name}"
        );
    }
}

#[test]
fn key_builders_match_ts() {
    for b in list("builders") {
        let a = b["args"].as_array().unwrap();
        let arg = |i: usize| s(&a[i]);
        let got = match s(&b["fn"]) {
            "spacePrefix" => keys::space_prefix(arg(0)),
            "headKey" => keys::head_key(arg(0)),
            "revokedKey" => keys::revoked_key(arg(0)),
            "projectKey" => keys::project_key(arg(0), arg(1)),
            "commandKey" => keys::command_key(arg(0), arg(1)),
            "ackKey" => keys::ack_key(arg(0), arg(1)),
            "deviceKey" => keys::device_key(arg(0), arg(1)),
            "partKey" => keys::part_key(arg(0), a[1].as_u64().unwrap() as usize),
            other => panic!("unknown builder {other}"),
        };
        match b.get("ok") {
            Some(ok) => assert_eq!(got.unwrap(), s(ok), "{b}"),
            None => expect_error(b, &got.unwrap_err(), &b.to_string()),
        }
    }
}

fn classified_json(c: &ClassifiedKey) -> Value {
    let (kind, extra) = match &c.kind {
        KeyKind::Head => ("head", None),
        KeyKind::Revoked => ("revoked", None),
        KeyKind::Project(h) => ("project", Some(("hash", h))),
        KeyKind::Command(id) => ("command", Some(("id", id))),
        KeyKind::Ack(id) => ("ack", Some(("id", id))),
        KeyKind::Device(id) => ("device", Some(("id", id))),
    };
    let mut j = json!({ "kind": kind, "logicalKey": c.logical_key, "part": c.part });
    if let Some((k, x)) = extra {
        j[k] = Value::from(x.as_str());
    }
    j
}

#[test]
fn keys_classify_like_ts() {
    let cases = list("classify");
    for c in cases {
        let got = keys::classify_key(s(&c["space"]), s(&c["key"])).map(|k| classified_json(&k));
        assert_eq!(got.unwrap_or(Value::Null), c["result"], "{}", c["key"]);
    }
    assert!(cases.iter().filter(|c| c["result"].is_null()).count() >= 5);
    assert!(cases.iter().filter(|c| !c["result"].is_null()).count() >= 10);
}

#[test]
fn command_timestamps_match_ts() {
    for t in list("timestamps") {
        let got = keys::command_timestamp(s(&t["id"]));
        match t["ms"].as_f64() {
            None => assert_eq!(got, None, "{}", t["id"]),
            Some(ms) if ms > u64::MAX as f64 => assert_eq!(got, Some(u64::MAX), "{}", t["id"]),
            Some(ms) => assert_eq!(got.map(|g| g as f64), Some(ms), "{}", t["id"]),
        }
    }
}

#[test]
fn relay_urls_normalize_like_ts() {
    for u in list("urls") {
        let got = pairing::normalize_relay_url(s(&u["input"]));
        match u.get("ok") {
            Some(ok) => assert_eq!(got.unwrap(), s(ok), "{:?}", u["input"]),
            None => expect_error(u, &got.unwrap_err(), s(&u["input"])),
        }
    }
}

fn payload(p: &Value) -> PairingPayload {
    PairingPayload {
        relay_url: s(&p["u"]).to_owned(),
        app_id: s(&p["a"]).to_owned(),
        relay_token: s(&p["t"]).to_owned(),
        space_id: s(&p["s"]).to_owned(),
        space_secret: s(&p["k"]).to_owned(),
        host_name: s(&p["n"]).to_owned(),
    }
}

#[test]
fn pairing_codes_encode_like_ts() {
    for c in list("encodeCases") {
        let name = s(&c["name"]);
        let got = pairing::encode_pairing_code(&payload(&c["payload"]));
        match c.get("ok") {
            Some(ok) => assert_eq!(got.unwrap(), s(ok), "{name}"),
            // zod 的错误：TS 也拒绝，只是不是协议错误；Rust 报配对码不合格。
            None if c["error"] == "ZodError" => {
                assert_eq!(
                    got.unwrap_err().code.as_str(),
                    "PAIRING_CODE_INVALID",
                    "{name}"
                )
            }
            None => expect_error(c, &got.unwrap_err(), name),
        }
    }
}

#[test]
fn pairing_codes_decode_like_ts() {
    for c in list("decodeCases") {
        let name = s(&c["name"]);
        let got = pairing::decode_pairing_code(s(&c["code"]));
        match c.get("ok") {
            Some(ok) => {
                let p = got.unwrap();
                assert_eq!(p, payload(ok), "{name}");
            }
            // TS 对 43 个非 base64url 字符抛 TypeError（没接住）；Rust 当配对码坏了。
            None if c["error"] == "TypeError" => {
                assert_eq!(
                    got.unwrap_err().code.as_str(),
                    "PAIRING_CODE_INVALID",
                    "{name}"
                )
            }
            None => expect_error(c, &got.unwrap_err(), name),
        }
    }
}

#[test]
fn document_schemas_match_zod() {
    let cases = list("schemas");
    for c in cases {
        let name = s(&c["schema"]);
        let table = schema::by_name(name).unwrap_or_else(|| panic!("no schema {name}"));
        let got = schema::check(table, &c["input"]).unwrap_or(Value::Null);
        assert_eq!(got, c["ok"], "{name} {}", c["input"]);
    }
    assert!(cases.iter().filter(|c| c["ok"].is_null()).count() >= 25);
    assert!(cases.iter().filter(|c| !c["ok"].is_null()).count() >= 20);
}
