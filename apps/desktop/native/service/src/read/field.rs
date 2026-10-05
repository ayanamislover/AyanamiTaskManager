//! 精确读取的字段级续读（02 §4.5；00 02 C-19）与 field_mask 的公共部分（2.x `paging/field.ts`）。
//!
//! 整体超预算时，按 `[1000, 512, 256, 128, 64, 0]` 逐级把长字符串截到前 N 个 UTF-16 码元，每个被截的字段
//! 给一个 `f3` 游标。续读时项目、实体、类型、mask 必须相同（`TARGET_MISMATCH`），实体版本与字段内容都没变
//! （否则 `STALE`），再二分找出放得下的最长切片。偏移按 UTF-16 计，但只落在 code point 边界上（C-19）。

use super::codec::{b64, js_len, jsify, sha256, utf16_len, utf16_prefix, utf16_suffix};
use super::cursor::{self, FIELD};
use super::{Ctx, too_large};
use atm_domain::error::DomainError;
use serde_json::{Map, Value, json};

const TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// 续读的目标：实体、类型、mask（含 `@view:` 这类伪项）与整个实体的版本哈希。
#[derive(Clone, Debug)]
pub(crate) struct Target {
    pub entity: String,
    pub entity_type: String,
    pub mask: Vec<String>,
    pub version: String,
}

fn hash16(text: &str) -> String {
    b64(&sha256(text.as_bytes())[..16])
}

/// 整个实体 JSON 的 sha256 前 16 字节。
pub(crate) fn target_version(v: &Value) -> String {
    hash16(&super::codec::js_text(v))
}

fn mask_hash(mask: &[String]) -> String {
    b64(&sha256(super::codec::js_text(&json!(mask)).as_bytes())[..12])
}

/// field_mask 里这个视图给不出的字段（2.x `ignoredFields`）。
pub(crate) fn ignored(value: &Map<String, Value>, mask: &[String]) -> Vec<String> {
    if mask.is_empty() || mask.iter().any(|m| m == "*") {
        return Vec::new();
    }
    mask.iter()
        .filter(|m| !value.contains_key(m.as_str()))
        .cloned()
        .collect()
}

/// 回显最多占一半预算，列不下的名字换成计数（2.x `fitIgnoredFields`）。返回 `(回显, 占用)`。
pub(crate) fn fit_ignored(ignored: &[String], max_chars: usize) -> (Map<String, Value>, usize) {
    if ignored.is_empty() {
        return (Map::new(), 0);
    }
    let budget = max_chars / 2;
    for kept in (0..=ignored.len()).rev() {
        let omitted = ignored.len() - kept;
        let mut echo = Map::new();
        echo.insert("ignored_fields".into(), json!(&ignored[..kept]));
        if omitted > 0 {
            echo.insert("ignored_fields_omitted".into(), json!(omitted));
        }
        let cost = js_len(&Value::Object(echo.clone()));
        if cost <= budget {
            return (echo, cost);
        }
    }
    (Map::new(), 0)
}

/// 在视图已有的字段内按 mask 过滤，保持 mask 的顺序（2.x `selectFields`）。
pub(crate) fn select(value: Map<String, Value>, mask: &[String]) -> Map<String, Value> {
    if mask.is_empty() || mask.iter().any(|m| m == "*") {
        return value;
    }
    let mut out = Map::new();
    for m in mask {
        if let Some(v) = value.get(m) {
            out.insert(m.clone(), v.clone());
        }
    }
    out
}

#[derive(Clone, Debug)]
enum Step {
    Key(String),
    Index(usize),
}

fn path_text(path: &[Step]) -> String {
    let mut out = String::new();
    for step in path {
        match step {
            Step::Index(i) => out.push_str(&format!("[{i}]")),
            Step::Key(k) if out.is_empty() => out.push_str(k),
            Step::Key(k) => {
                out.push('.');
                out.push_str(k);
            }
        }
    }
    out
}

fn path_json(path: &[Step]) -> Value {
    Value::Array(
        path.iter()
            .map(|s| match s {
                Step::Key(k) => json!(k),
                Step::Index(i) => json!(i),
            })
            .collect(),
    )
}

fn path_from(v: &Value) -> Option<Vec<Step>> {
    let items = v.as_array()?;
    if items.is_empty() || items.len() > 64 {
        return None;
    }
    items
        .iter()
        .map(|s| match s {
            Value::String(k) => Some(Step::Key(k.clone())),
            Value::Number(n) => n.as_u64().map(|i| Step::Index(i as usize)),
            _ => None,
        })
        .collect()
}

fn at<'v>(v: &'v Value, path: &[Step]) -> Option<&'v Value> {
    let mut cur = v;
    for step in path {
        cur = match step {
            Step::Key(k) => cur.as_object()?.get(k)?,
            Step::Index(i) => cur.as_array()?.get(*i)?,
        };
    }
    Some(cur)
}

fn expiry(now_ms: i64) -> i64 {
    (now_ms.div_euclid(TTL_MS) + 2) * TTL_MS
}

struct Cut {
    path: String,
    original: usize,
    returned: usize,
    cursor: String,
}

fn shrink(
    cx: &Ctx<'_>,
    v: &Value,
    max: usize,
    path: &mut Vec<Step>,
    target: &Target,
    expires: i64,
    cuts: &mut Vec<Cut>,
) -> Value {
    match v {
        Value::String(s) if utf16_len(s) > max => {
            let head = utf16_prefix(s, max);
            let returned = utf16_len(head);
            let mut payload = Map::new();
            payload.insert("e".into(), json!(target.entity));
            payload.insert("t".into(), json!(target.entity_type));
            payload.insert("m".into(), json!(mask_hash(&target.mask)));
            payload.insert("path".into(), path_json(path));
            payload.insert("h".into(), json!(hash16(s)));
            payload.insert("v".into(), json!(target.version));
            payload.insert("x".into(), json!(expires));
            payload.insert("o".into(), json!(returned));
            cuts.push(Cut {
                path: path_text(path),
                original: utf16_len(s),
                returned,
                cursor: cursor::seal(&cx.key, FIELD, &cx.p, payload),
            });
            json!(head)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .enumerate()
                .map(|(i, item)| {
                    path.push(Step::Index(i));
                    let out = shrink(cx, item, max, path, target, expires, cuts);
                    path.pop();
                    out
                })
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, item)| {
                    path.push(Step::Key(k.clone()));
                    let out = shrink(cx, item, max, path, target, expires, cuts);
                    path.pop();
                    (k.clone(), out)
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

/// 精确读取的预算：放得下原样返回；否则逐级截断长字符串并给出续读游标；都放不下退到 [`bounded`]。
pub(crate) fn fit(
    cx: &Ctx<'_>,
    source: Value,
    max_chars: usize,
    tool: &str,
    target: &Target,
    cursor_token: Option<&str>,
) -> Result<Value, DomainError> {
    let source = jsify(source);
    if let Some(token) = cursor_token {
        return continue_field(cx, &source, token, max_chars, target);
    }
    if js_len(&source) <= max_chars {
        return Ok(source);
    }
    let expires = expiry(cx.now.millis());
    for max in [1000, 512, 256, 128, 64, 0] {
        let mut cuts = Vec::new();
        let projected = shrink(
            cx,
            &source,
            max,
            &mut Vec::new(),
            target,
            expires,
            &mut cuts,
        );
        let mut out = match projected {
            Value::Object(m) => m,
            other => {
                let mut m = Map::new();
                m.insert("value".into(), other);
                m
            }
        };
        out.insert("truncated".into(), json!(true));
        out.insert(
            "truncated_fields".into(),
            Value::Array(
                cuts.into_iter()
                    .map(|c| {
                        json!({
                            "path": c.path,
                            "original_chars": c.original,
                            "returned_chars": c.returned,
                            "continuation": { "tool": tool, "cursor": c.cursor },
                        })
                    })
                    .collect(),
            ),
        );
        let candidate = Value::Object(out);
        if js_len(&candidate) <= max_chars {
            return Ok(candidate);
        }
    }
    Ok(bounded(source, max_chars))
}

fn continue_field(
    cx: &Ctx<'_>,
    source: &Value,
    token: &str,
    max_chars: usize,
    target: &Target,
) -> Result<Value, DomainError> {
    let c = cursor::open(&cx.key, FIELD, &cx.p, token)?;
    cursor::exact_keys(&c, &["e", "t", "m", "path", "h", "v", "x", "o"])?;
    let path = c
        .get("path")
        .and_then(path_from)
        .ok_or_else(cursor::tampered)?;
    let offset = usize::try_from(cursor::int_of(&c, "o")?).map_err(|_| cursor::tampered())?;
    let expires = cursor::int_of(&c, "x")?;
    if expires <= cx.now.millis() {
        return Err(cursor::invalid("EXPIRED"));
    }
    if cursor::str_of(&c, "e")? != target.entity
        || cursor::str_of(&c, "t")? != target.entity_type
        || cursor::str_of(&c, "m")? != mask_hash(&target.mask)
    {
        return Err(cursor::target_mismatch("field"));
    }
    if cursor::str_of(&c, "v")? != target.version {
        return Err(cursor::stale(
            "字段续读的目标实体已经变化：去掉 cursor 重新读取",
        ));
    }
    let field = match at(source, &path) {
        Some(Value::String(s))
            if offset <= utf16_len(s) && hash16(s) == cursor::str_of(&c, "h")? =>
        {
            s
        }
        _ => {
            return Err(cursor::stale(
                "字段续读的内容已经变化：去掉 cursor 重新读取",
            ));
        }
    };
    let total = utf16_len(field);
    let rest = utf16_suffix(field, offset);
    let mut identity = Map::new();
    if let Some(key) = source.get("key").and_then(Value::as_str) {
        identity.insert("key".into(), json!(key));
    }
    identity.insert("field".into(), json!(path_text(&path)));
    identity.insert("offset".into(), json!(offset));
    identity.insert("original_chars".into(), json!(total));
    let candidate = |length: usize| -> Value {
        let slice = utf16_prefix(rest, length);
        let returned = utf16_len(slice);
        let next = offset + returned;
        let done = next >= total;
        let mut m = identity.clone();
        m.insert("value".into(), json!(slice));
        m.insert("returned_chars".into(), json!(returned));
        m.insert("done".into(), json!(done));
        let next_cursor = if done {
            Value::Null
        } else {
            let mut payload = c.clone();
            payload.insert("o".into(), json!(next));
            json!(cursor::seal(&cx.key, FIELD, &cx.p, payload))
        };
        m.insert("next_cursor".into(), next_cursor);
        Value::Object(m)
    };
    let (mut low, mut high) = (0usize, utf16_len(rest));
    let mut best: Option<Value> = None;
    while low <= high {
        let length = (low + high) / 2;
        let v = candidate(length);
        if js_len(&v) <= max_chars {
            best = Some(v);
            low = length + 1;
        } else if length == 0 {
            break;
        } else {
            high = length - 1;
        }
    }
    match best {
        Some(v) if v["returned_chars"].as_u64().unwrap_or(0) > 0 => Ok(v),
        _ => Err(too_large(
            format!("max_chars={max_chars} 放不下字段续读的回执"),
            json!({ "max_chars": max_chars, "recovery": { "action": "increase_max_chars", "preserve_cursor": true } }),
        )),
    }
}

/// 2.x `bounded`：逐级截断所有字符串与数组，最后退到 RESULT_TOO_LARGE 回执（不抛错）。
pub(crate) fn bounded(value: Value, max_chars: usize) -> Value {
    let value = match jsify(value) {
        Value::Object(m) => Value::Object(m),
        other => json!({ "value": other }),
    };
    if js_len(&value) <= max_chars {
        return value;
    }
    for (max_string, max_array) in [(512usize, 20usize), (180, 10), (120, 8), (80, 5), (48, 3)] {
        let mut fields = Vec::new();
        let mut collections = Vec::new();
        let shrunk = shrink_all(
            &value,
            "",
            max_string,
            max_array,
            &mut fields,
            &mut collections,
        );
        let mut out = match shrunk {
            Value::Object(m) => m,
            _ => Map::new(),
        };
        out.insert("truncated".into(), json!(true));
        if !fields.is_empty() {
            out.insert("truncated_fields".into(), Value::Array(fields));
        }
        if !collections.is_empty() {
            out.insert("truncated_collections".into(), Value::Array(collections));
        }
        let candidate = Value::Object(out);
        if js_len(&candidate) <= max_chars {
            return candidate;
        }
    }
    json!({
        "truncated": true,
        "code": "RESULT_TOO_LARGE",
        "hint": "使用该工具的 max_chars、cursor、field_mask、limit 或 include 缩小读取范围",
    })
}

fn shrink_all(
    v: &Value,
    path: &str,
    max_string: usize,
    max_array: usize,
    fields: &mut Vec<Value>,
    collections: &mut Vec<Value>,
) -> Value {
    match v {
        Value::String(s) if utf16_len(s) > max_string => {
            let head = utf16_prefix(s, max_string.saturating_sub(1));
            let returned = format!("{head}…");
            fields.push(json!({
                "path": path,
                "original_chars": utf16_len(s),
                "returned_chars": utf16_len(&returned),
            }));
            json!(returned)
        }
        Value::Array(items) => {
            if items.len() > max_array {
                collections.push(json!({
                    "path": path,
                    "original_items": items.len(),
                    "returned_items": max_array,
                }));
            }
            Value::Array(
                items
                    .iter()
                    .take(max_array)
                    .enumerate()
                    .map(|(i, item)| {
                        shrink_all(
                            item,
                            &format!("{path}[{i}]"),
                            max_string,
                            max_array,
                            fields,
                            collections,
                        )
                    })
                    .collect(),
            )
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, item)| {
                    let child = if path.is_empty() {
                        k.clone()
                    } else {
                        format!("{path}.{k}")
                    };
                    (
                        k.clone(),
                        shrink_all(item, &child, max_string, max_array, fields, collections),
                    )
                })
                .collect(),
        ),
        other => other.clone(),
    }
}
