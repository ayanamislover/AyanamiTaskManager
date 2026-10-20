//! 指纹与 node 对照逐条一致（W2b 验收：fp_v1 / fp_v2 与 2.0 运行时生成的向量一致；02 S-040、S-041）。
//! 对照由 `tests/data/fp-vectors.mjs` 生成，照抄 2.x 原码，不经过本 crate。

use atm_service::fp::{
    JsValue, UnsupportedKey, canon_v2, canonical_kernel_v1, canonical_v2, kernel_v1,
    knowledge_agent_legacy_key, knowledge_v1,
};
use serde_json::Value;

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/fp-vectors.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// 带类型标签的编码 → JsValue（见生成器开头的说明）。
fn decode(v: &Value) -> JsValue {
    let tag = v[0].as_str().unwrap();
    match tag {
        "u" => JsValue::Undefined,
        "z" => JsValue::Null,
        "b" => JsValue::Bool(v[1].as_bool().unwrap()),
        "n" => JsValue::Number(f64::from_bits(
            u64::from_str_radix(v[1].as_str().unwrap(), 16).unwrap(),
        )),
        "s" => JsValue::String(v[1].as_str().unwrap().to_owned()),
        "a" => JsValue::Array(v[1].as_array().unwrap().iter().map(decode).collect()),
        "o" => JsValue::Object(
            v[1].as_array()
                .unwrap()
                .iter()
                .map(|e| (e[0].as_str().unwrap().to_owned(), decode(&e[1])))
                .collect(),
        ),
        other => panic!("unknown tag {other}"),
    }
}

#[test]
fn kernel_v1_matches_the_2x_runtime() {
    let v = vectors();
    let list = v["kernel"].as_array().unwrap();
    assert!(list.len() > 400);
    for case in list {
        let name = case["name"].as_str().unwrap();
        let input = decode(&case["input"]);
        assert_eq!(
            canonical_kernel_v1(&input).unwrap().as_deref(),
            case["canonical"].as_str(),
            "{name}"
        );
        assert_eq!(
            kernel_v1(&input).unwrap(),
            case["fp"].as_str().unwrap(),
            "{name}"
        );
    }
}

#[test]
fn kernel_v1_refuses_keys_it_cannot_reproduce() {
    let v = vectors();
    for case in v["unsupported"].as_array().unwrap() {
        let input = decode(&case["input"]);
        assert_eq!(
            kernel_v1(&input),
            Err(UnsupportedKey {
                key: case["key"].as_str().unwrap().to_owned()
            }),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn knowledge_v1_matches_the_2x_runtime() {
    let v = vectors();
    for case in v["knowledge"].as_array().unwrap() {
        let input = decode(&case["input"]);
        assert_eq!(
            knowledge_v1(&input),
            case["fp"].as_str().unwrap(),
            "{}",
            case["name"]
        );
    }
    for case in v["agentKeys"].as_array().unwrap() {
        assert_eq!(
            knowledge_agent_legacy_key(
                case["project"].as_str().unwrap(),
                case["session"].as_str().unwrap(),
                case["op"].as_str().unwrap()
            ),
            case["key"].as_str().unwrap()
        );
    }
}

#[test]
fn canon_v2_is_jcs() {
    let v = vectors();
    let list = v["v2"].as_array().unwrap();
    assert!(list.len() > 300);
    for case in list {
        let name = case["name"].as_str().unwrap();
        let input = decode(&case["input"]);
        if let Some(canonical) = case["canonical"].as_str() {
            assert_eq!(canonical_v2(&input), canonical, "{name}");
        }
        assert_eq!(canon_v2(&input), case["fp"].as_str().unwrap(), "{name}");
    }
}

/// 02 §3.4：「缺失」与「显式 null」指纹不同；顶层 undefined 与 null 相同。
#[test]
fn missing_and_null_are_different_requests() {
    let missing = JsValue::object([("a", JsValue::Number(1.0)), ("b", JsValue::Undefined)]);
    let null = JsValue::object([("a", JsValue::Number(1.0)), ("b", JsValue::Null)]);
    assert_ne!(kernel_v1(&missing).unwrap(), kernel_v1(&null).unwrap());
    assert_ne!(canon_v2(&missing), canon_v2(&null));
    assert_eq!(
        kernel_v1(&JsValue::Undefined).unwrap(),
        kernel_v1(&JsValue::Null).unwrap()
    );
}
