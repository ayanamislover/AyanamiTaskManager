//! 界面 API 的形状兼容（06 T-COMPAT）：React 界面不改读法，所以 ui-bridge 的每个应答都要是 2.0 TS daemon 的形状。
//!
//! `fixtures/ui-scenario.json` 是两边共用的场景；`fixtures/capture-2.0.ts` 在 2.0 daemon 上跑一遍，把每一步的
//! 状态码与形状骨架录进 `fixtures/ui-shapes-2.0.json`。这里在 ui-bridge 上跑同一份场景，逐步比：
//!
//! - 状态码相同；
//! - 骨架相同：对象的键集合一致（递归），叶子类型一致。一边是 `null`（这份数据下该字段空着）或空数组时不比类型；
//! - 错误应答比状态码、`error.code` 与信封的键；`error.details` 不比：界面只读 code 与 message
//!   （`packages/ui`、`packages/client` 都不读 details），details 是给 Agent 的出路，3.0 按 02 §4 重做了；
//! - 3.0 有意去掉的键只有 [`REMOVED`]，每条写明依据。其余任何差异都红。

mod support;

use atm_http::agent::Surface;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use support::{agent, world};

/// 3.0 有意去掉的键：`(步骤名前缀, 键)`，前缀为空表示所有步骤。
const REMOVED: &[(&str, &str, &str)] = &[
    (
        "",
        "projection",
        "投影随投影健康面板删除（00 §6）：写回执与总览不再带投影状态",
    ),
    ("", "projectionSummary", "同上（00 §6）"),
    ("", "projectionFailures", "同上（00 §6）"),
];

/// 3.0 有意加上的键：`(步骤名, 键, 依据)`。界面按键读，多出的键不影响 2.0 的读法。
const ADDED: &[(&str, &str, &str)] = &[
    (
        "status",
        "impl",
        "06 #1：status 改为单库健康与转换状态（07 §7）",
    ),
    ("status", "layout", "同上：单库（`single`）"),
    (
        "status",
        "conversion",
        "同上：转换阶段与发布物的 generation",
    ),
];

fn added(step: &str, key: &str) -> bool {
    ADDED.iter().any(|(s, k, _)| *k == key && step == *s)
}

fn fixtures() -> &'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures"))
}

fn load(name: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(fixtures().join(name)).unwrap()).unwrap()
}

/// 形状骨架，与 capture-2.0.ts 的 `skeleton` 一致。
fn skeleton(v: &Value) -> Value {
    match v {
        Value::Null => json!("null"),
        Value::Bool(_) => json!("boolean"),
        Value::Number(_) => json!("number"),
        Value::String(_) => json!("string"),
        Value::Array(items) if items.is_empty() => json!("[]"),
        Value::Array(items) => {
            let merged = items
                .iter()
                .map(skeleton)
                .reduce(|a, b| merge(&a, &b))
                .unwrap();
            json!({ "[]": merged })
        }
        Value::Object(m) => {
            let sorted: BTreeMap<&String, Value> =
                m.iter().map(|(k, v)| (k, skeleton(v))).collect();
            Value::Object(sorted.into_iter().map(|(k, v)| (k.clone(), v)).collect())
        }
    }
}

fn describe(s: &Value) -> String {
    match s {
        Value::String(t) => t.clone(),
        Value::Object(m) if m.contains_key("[]") => "array".into(),
        _ => "object".into(),
    }
}

fn is_array_skeleton(s: &Value) -> bool {
    s.as_object().is_some_and(|m| m.contains_key("[]"))
}

/// 数组元素的骨架合并，与 capture-2.0.ts 的 `merge` 一致。
fn merge(a: &Value, b: &Value) -> Value {
    if a == "null" {
        return b.clone();
    }
    if b == "null" {
        return a.clone();
    }
    if a.is_string() || b.is_string() {
        if a == "[]" && is_array_skeleton(b) {
            return b.clone();
        }
        if b == "[]" && is_array_skeleton(a) {
            return a.clone();
        }
        if a == b {
            return a.clone();
        }
        let names: BTreeSet<String> = describe(a)
            .split('|')
            .chain(describe(b).split('|'))
            .map(str::to_owned)
            .collect();
        return json!(names.into_iter().collect::<Vec<_>>().join("|"));
    }
    let (ma, mb) = (a.as_object().unwrap(), b.as_object().unwrap());
    let keys: BTreeSet<&String> = ma.keys().chain(mb.keys()).collect();
    let mut out = Map::new();
    for k in keys {
        let v = match (ma.get(k), mb.get(k)) {
            (Some(l), Some(r)) => merge(l, r),
            (Some(l), None) => l.clone(),
            (None, Some(r)) => r.clone(),
            (None, None) => unreachable!(),
        };
        out.insert(k.clone(), v);
    }
    Value::Object(out)
}

fn removed(step: &str, key: &str) -> bool {
    REMOVED
        .iter()
        .any(|(prefix, k, _)| *k == key && step.starts_with(prefix))
}

/// 比两份骨架，把差异按路径记下来。
fn compare(step: &str, path: &str, expected: &Value, actual: &Value, diffs: &mut Vec<String>) {
    if expected == "null" || actual == "null" || path == "$.error.details" {
        return;
    }
    if (expected == "[]" && (actual == "[]" || is_array_skeleton(actual)))
        || (actual == "[]" && is_array_skeleton(expected))
    {
        return;
    }
    match (expected, actual) {
        (Value::Object(e), Value::Object(a)) if e.contains_key("[]") && a.contains_key("[]") => {
            compare(step, &format!("{path}[]"), &e["[]"], &a["[]"], diffs);
        }
        (Value::Object(e), Value::Object(a)) if !e.contains_key("[]") && !a.contains_key("[]") => {
            for (k, ev) in e {
                match a.get(k) {
                    Some(av) => compare(step, &format!("{path}.{k}"), ev, av, diffs),
                    None if removed(step, k) => {}
                    None => diffs.push(format!("{step}: {path}.{k} 缺失（2.0 是 {ev}）")),
                }
            }
            for k in a
                .keys()
                .filter(|k| !e.contains_key(*k) && !(path == "$" && added(step, k)))
            {
                diffs.push(format!("{step}: {path}.{k} 多出（{}）", a[k]));
            }
        }
        (Value::String(e), Value::String(a)) => {
            let es: BTreeSet<&str> = e.split('|').collect();
            if !a.split('|').all(|t| es.contains(t)) {
                diffs.push(format!("{step}: {path} 类型是 {a}，2.0 是 {e}"));
            }
        }
        _ => diffs.push(format!(
            "{step}: {path} 是 {}，2.0 是 {}",
            describe(actual),
            describe(expected)
        )),
    }
}

/// JSON Pointer，外加 `k=v` 段，与 capture-2.0.ts 的 `pointer` 一致。
fn pointer<'a>(v: &'a Value, path: &str) -> Option<&'a Value> {
    let mut at = v;
    for raw in path.split('/').skip(1) {
        let seg = raw.replace("~1", "/").replace("~0", "~");
        at = match (at, seg.split_once('=')) {
            (Value::Array(items), Some((k, want))) => items.iter().find(|i| match &i[k] {
                Value::String(s) => s == want,
                other => other.as_i64().map(|n| n.to_string()).as_deref() == Some(want),
            })?,
            (Value::Array(items), None) => items.get(seg.parse::<usize>().ok()?)?,
            (Value::Object(m), _) => m.get(&seg)?,
            _ => return None,
        };
    }
    Some(at)
}

fn fill(v: &Value, saved: &BTreeMap<String, Value>) -> Value {
    match v {
        Value::String(s) => {
            if let Some(name) = s
                .strip_prefix("{{")
                .and_then(|r| r.strip_suffix("}}"))
                .filter(|n| !n.contains('{'))
            {
                return saved
                    .get(name)
                    .unwrap_or_else(|| panic!("场景引用了还没存下的 {name}"))
                    .clone();
            }
            let mut out = s.clone();
            for (name, value) in saved {
                let text = match value {
                    Value::String(t) => t.clone(),
                    other => other.to_string(),
                };
                out = out.replace(&format!("{{{{{name}}}}}"), &text);
            }
            assert!(!out.contains("{{"), "场景引用了还没存下的值：{out}");
            json!(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(|i| fill(i, saved)).collect()),
        Value::Object(m) => {
            Value::Object(m.iter().map(|(k, v)| (k.clone(), fill(v, saved))).collect())
        }
        other => other.clone(),
    }
}

#[test]
fn every_ui_route_answers_in_the_2_0_shape() {
    let scenario = load("ui-scenario.json");
    let shapes = load("ui-shapes-2.0.json");
    let w = world("compat");
    let surface = Surface::new(w.svc.clone());
    let mut saved = BTreeMap::new();
    let mut diffs = Vec::new();
    let mut compared = 0;
    for step in scenario["steps"].as_array().unwrap() {
        let name = step["name"].as_str().unwrap();
        let body = if let Some(tool) = step["agent"].as_str() {
            let args = fill(&step["args"], &saved).as_object().unwrap().clone();
            atm_http::rest::call_tool_as(&surface, &agent(), tool, args, &[])
                .unwrap_or_else(|e| panic!("{name}: {e:?}"))
        } else {
            let method = step["method"].as_str().unwrap();
            let target = fill(&step["path"], &saved);
            let input = step.get("body").map(|b| fill(b, &saved));
            let reply = w.call(method, target.as_str().unwrap(), input);
            let expected = &shapes[name];
            assert!(
                expected.is_object(),
                "{name} 没有 2.0 的录制；重跑 capture-2.0.ts"
            );
            if reply.status != expected["status"].as_u64().unwrap() as u16 {
                diffs.push(format!(
                    "{name}: 状态 {}，2.0 是 {}：{}",
                    reply.status, expected["status"], reply.body
                ));
            } else if expected.get("code").is_some()
                && reply.body["error"]["code"] != expected["code"]
            {
                diffs.push(format!(
                    "{name}: 错误码 {}，2.0 是 {}",
                    reply.body["error"]["code"], expected["code"]
                ));
            } else {
                compare(
                    name,
                    "$",
                    &expected["shape"],
                    &skeleton(&reply.body),
                    &mut diffs,
                );
            }
            compared += 1;
            reply.body
        };
        if let Some(save) = step["save"].as_object() {
            for (key, path) in save {
                match pointer(&body, path.as_str().unwrap()) {
                    Some(v) => {
                        saved.insert(key.clone(), v.clone());
                    }
                    None => panic!(
                        "{name}: {path} 不在应答里：{body}\n已有的差异：\n{}",
                        diffs.join("\n")
                    ),
                }
            }
        }
    }
    assert_eq!(
        compared,
        shapes.as_object().unwrap().len(),
        "场景与录制的步数对不上"
    );
    assert!(
        diffs.is_empty(),
        "{} 处与 2.0 不同：\n{}",
        diffs.len(),
        diffs.join("\n")
    );
}

#[test]
fn the_comparison_catches_shape_drift() {
    let base = json!({ "id": "x", "items": [{ "a": 1, "b": null }], "n": 1 });
    let mut diffs = Vec::new();
    compare("t", "$", &skeleton(&base), &skeleton(&base), &mut diffs);
    assert!(diffs.is_empty(), "{diffs:?}");
    for drifted in [
        json!({ "id": "x", "items": [{ "a": 1, "b": null }] }),
        json!({ "id": "x", "items": [{ "a": 1, "b": null }], "n": 1, "extra": 0 }),
        json!({ "id": "x", "items": [{ "a": "1", "b": null }], "n": 1 }),
        json!({ "id": "x", "items": [{ "A": 1, "b": null }], "n": 1 }),
        json!({ "id": "x", "items": { "a": 1 }, "n": 1 }),
    ] {
        let mut diffs = Vec::new();
        compare("t", "$", &skeleton(&base), &skeleton(&drifted), &mut diffs);
        assert!(!diffs.is_empty(), "{drifted} 没被发现");
    }
    // 只有登记过的键可以缺。
    let mut diffs = Vec::new();
    compare(
        "t",
        "$",
        &skeleton(&json!({ "id": 1, "projection": {} })),
        &skeleton(&json!({ "id": 1 })),
        &mut diffs,
    );
    assert!(diffs.is_empty(), "{diffs:?}");
    // 只有登记过的步骤、登记过的键、在顶层，才可以多出。
    let status = |step: &str, actual: Value| {
        let mut diffs = Vec::new();
        compare(
            step,
            "$",
            &skeleton(&json!({ "ok": true, "sqlite": { "ok": true } })),
            &skeleton(&actual),
            &mut diffs,
        );
        diffs
    };
    let with_conversion = json!({ "ok": true, "sqlite": { "ok": true }, "conversion": {} });
    assert!(status("status", with_conversion.clone()).is_empty());
    assert!(!status("overview", with_conversion).is_empty());
    assert!(
        !status(
            "status",
            json!({ "ok": true, "sqlite": { "ok": true, "layout": "x" } })
        )
        .is_empty()
    );
    assert!(
        !status(
            "status",
            json!({ "ok": true, "sqlite": { "ok": true }, "extra": 0 })
        )
        .is_empty()
    );
}
