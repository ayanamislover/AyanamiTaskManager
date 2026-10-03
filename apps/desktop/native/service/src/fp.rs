//! 幂等指纹（02 §3.4、§9.3、§9.4；10 R3、R3′）。
//!
//! 三个族，按回执行的 `fp_family` 选：
//! - `kernel-v1`：2.x 项目写入与原子 begin。键按 `localeCompare` 排序后 `JSON.stringify`，再 sha256。
//!   ICU 的排序没法一般地复现，所以只支持键形 `^[A-Za-z][A-Za-z0-9]*$`，用 02 §3.4 的「ASCII 比较器」；
//!   出现别的键就无法证明与旧指纹同算法，返回 [`UnsupportedKey`]（服务报
//!   `IDEMPOTENCY_CONFLICT` / `FP_V1_UNSUPPORTED_KEY`，零写入，§9.4）。
//! - `knowledge-v1`：2.x 知识库。`JSON.stringify(payload)` 直接哈希，**不排序**，键序就是调用方给的顺序。
//! - `canon-v2`：3.0 新写入。RFC 8785（JCS）：键按 UTF-16 码元排序，数字与字符串按 `JSON.stringify`。
//!
//! 输入是 [`JsValue`]：保留 undefined 与 null 的区别（「缺失」和「显式 null」指纹不同，§3.4），
//! 对象保留属性顺序。字符串是 Rust `String`，没有落单的代理项（入参层按 00 §2 C-18 先拒绝）。

use atm_store::jsjson::number_to_string;
use sha2::{Digest, Sha256};
use std::cmp::Ordering;

/// JS 值。对象是有序的 `(键, 值)` 列表，键不重复（构造方保证）。
#[derive(Clone, Debug, PartialEq)]
pub enum JsValue {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<JsValue>),
    Object(Vec<(String, JsValue)>),
}

impl JsValue {
    pub fn str(s: impl Into<String>) -> Self {
        JsValue::String(s.into())
    }

    /// 由 `(键, 值)` 列表建对象。
    pub fn object<K: Into<String>>(entries: impl IntoIterator<Item = (K, JsValue)>) -> Self {
        JsValue::Object(entries.into_iter().map(|(k, v)| (k.into(), v)).collect())
    }

    /// `Option` 的约定：`None` 是 undefined（键被省略）。
    pub fn opt(v: Option<JsValue>) -> Self {
        v.unwrap_or(JsValue::Undefined)
    }
}

/// kernel-v1 遇到无法复现的键。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnsupportedKey {
    pub key: String,
}

fn sha256_hex(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push(char::from(HEX[usize::from(b >> 4)]));
        out.push(char::from(HEX[usize::from(b & 15)]));
    }
    out
}

const HEX: &[u8; 16] = b"0123456789abcdef";
const BACKSLASH: char = 0x5c_u8 as char;

/// `kernel-v1`：`sha256(JSON.stringify(canonicalize(v)) ?? "null")`。
pub fn kernel_v1(value: &JsValue) -> Result<String, UnsupportedKey> {
    check_keys(value)?;
    let mut out = String::new();
    if !write_value(&mut out, value, KeyOrder::Ascii) {
        out.push_str("null");
    }
    Ok(sha256_hex(&out))
}

/// `knowledge-v1`：`sha256(JSON.stringify(payload))`，键序不动。
pub fn knowledge_v1(payload: &JsValue) -> String {
    let mut out = String::new();
    if !write_value(&mut out, payload, KeyOrder::Insertion) {
        out.push_str("null");
    }
    sha256_hex(&out)
}

/// 2.x 知识库 Agent 保存的旧键：`"agent:" + sha256(JSON.stringify([projectId, sessionId, opId]))`。
pub fn knowledge_agent_legacy_key(project_id: &str, session_id: &str, op_id: &str) -> String {
    let mut out = String::from("[");
    for (i, s) in [project_id, session_id, op_id].into_iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        write_string(&mut out, s);
    }
    out.push(']');
    format!("agent:{}", sha256_hex(&out))
}

/// `canon-v2`：JCS 规范串的 sha256。
pub fn canon_v2(value: &JsValue) -> String {
    sha256_hex(&canonical_v2(value))
}

/// JCS 规范串（顶层 undefined 记作 `null`）。供诊断与对照用。
pub fn canonical_v2(value: &JsValue) -> String {
    let mut out = String::new();
    if !write_value(&mut out, value, KeyOrder::Utf16) {
        out.push_str("null");
    }
    out
}

/// kernel-v1 的规范串（键已按 ASCII 比较器排序）。供诊断与对照用。
pub fn canonical_kernel_v1(value: &JsValue) -> Result<Option<String>, UnsupportedKey> {
    check_keys(value)?;
    let mut out = String::new();
    Ok(write_value(&mut out, value, KeyOrder::Ascii).then_some(out))
}

/// 02 §3.4 唯一允许的键形。
fn kernel_key_ok(key: &str) -> bool {
    let mut bytes = key.bytes();
    bytes.next().is_some_and(|b| b.is_ascii_alphabetic())
        && bytes.all(|b| b.is_ascii_alphanumeric())
}

fn check_keys(value: &JsValue) -> Result<(), UnsupportedKey> {
    match value {
        JsValue::Array(items) => items.iter().try_for_each(check_keys),
        JsValue::Object(entries) => entries.iter().try_for_each(|(k, v)| {
            // undefined 的键在 canonicalize 里先被丢掉，不参与排序，也就不影响能否复现。
            if matches!(v, JsValue::Undefined) {
                return Ok(());
            }
            if !kernel_key_ok(k) {
                return Err(UnsupportedKey { key: k.clone() });
            }
            check_keys(v)
        }),
        _ => Ok(()),
    }
}

/// 02 §3.4 的 ASCII 比较器（只用于满足 `kernel_key_ok` 的键）：
/// 第一层逐字符比较小写化后的字符，数字在字母之前，短的前缀在前；
/// 第一层完全相同时，从左找第一个大小写不同的位置，小写在前。
pub fn ascii_compare(a: &str, b: &str) -> Ordering {
    let rank = |c: u8| -> u16 {
        let lower = c.to_ascii_lowercase();
        if lower.is_ascii_digit() {
            u16::from(lower)
        } else {
            256 + u16::from(lower)
        }
    };
    let first = a.bytes().map(rank).cmp(b.bytes().map(rank));
    if first != Ordering::Equal {
        return first;
    }
    for (x, y) in a.bytes().zip(b.bytes()) {
        if x != y {
            return if x.is_ascii_lowercase() {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        }
    }
    Ordering::Equal
}

#[derive(Clone, Copy)]
enum KeyOrder {
    /// kernel-v1：ASCII 比较器。
    Ascii,
    /// knowledge-v1：`JSON.stringify` 的属性顺序（数组下标形状的键升序在前，其余按插入顺序）。
    Insertion,
    /// canon-v2：UTF-16 码元序。
    Utf16,
}

/// `JSON.stringify` 的一个值。返回 false 表示这个值被省略（undefined）。
fn write_value(out: &mut String, value: &JsValue, order: KeyOrder) -> bool {
    match value {
        JsValue::Undefined => return false,
        JsValue::Null => out.push_str("null"),
        JsValue::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        JsValue::Number(x) if x.is_finite() => out.push_str(&number_to_string(*x)),
        JsValue::Number(_) => out.push_str("null"),
        JsValue::String(s) => write_string(out, s),
        JsValue::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                if !write_value(out, item, order) {
                    out.push_str("null");
                }
            }
            out.push(']');
        }
        JsValue::Object(entries) => {
            let mut present: Vec<&(String, JsValue)> = entries
                .iter()
                .filter(|(_, v)| !matches!(v, JsValue::Undefined))
                .collect();
            match order {
                KeyOrder::Ascii => present.sort_by(|a, b| ascii_compare(&a.0, &b.0)),
                KeyOrder::Utf16 => {
                    present.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()))
                }
                KeyOrder::Insertion => {
                    // 稳定排序：下标形状的键按数值升序挪到最前，其余保持原顺序。
                    present.sort_by_key(|(k, _)| array_index(k).map_or((1, 0), |n| (0, n)));
                }
            }
            out.push('{');
            let mut first = true;
            for (k, v) in present {
                let mark = out.len();
                if !first {
                    out.push(',');
                }
                write_string(out, k);
                out.push(':');
                if write_value(out, v, order) {
                    first = false;
                } else {
                    out.truncate(mark);
                }
            }
            out.push('}');
        }
    }
    true
}

/// ECMAScript 的数组下标：0..=2^32-2 的规范十进制写法（无前导零）。
fn array_index(key: &str) -> Option<u64> {
    if key.is_empty() || key.len() > 10 || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    if !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u64>().ok().filter(|n| *n <= 4_294_967_294)
}

/// `QuoteJSONString`：`"`、反斜杠、`\b\f\n\r\t` 用短转义，其余小于 0x20 的用小写 `\u00xx`，其他原样。
fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        let short = match c as u32 {
            0x22 => Some('"'),
            0x5c => Some(BACKSLASH),
            0x08 => Some('b'),
            0x0c => Some('f'),
            0x0a => Some('n'),
            0x0d => Some('r'),
            0x09 => Some('t'),
            _ => None,
        };
        match short {
            Some(e) => {
                out.push(BACKSLASH);
                out.push(e);
            }
            None if (c as u32) < 0x20 => {
                out.push(BACKSLASH);
                out.push_str("u00");
                out.push(char::from(HEX[(c as usize) >> 4]));
                out.push(char::from(HEX[(c as usize) & 15]));
            }
            None => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_comparator_puts_digits_first_and_lowercase_before_uppercase() {
        let mut keys = vec![
            "b", "B", "a", "A", "a0", "aB", "ab", "Ab", "AB", "a9", "aa", "z", "Z0",
        ];
        keys.sort_by(|a, b| ascii_compare(a, b));
        assert_eq!(
            keys,
            [
                "a", "A", "a0", "a9", "aa", "ab", "aB", "Ab", "AB", "b", "B", "z", "Z0"
            ]
        );
        assert_eq!(ascii_compare("operation", "opId"), Ordering::Less);
        assert_eq!(
            ascii_compare("reviewedHashes", "reviewTaskKey"),
            Ordering::Less
        );
    }

    #[test]
    fn kernel_keys_outside_the_ascii_shape_are_unsupported() {
        for key in ["1a", "a_b", "a-b", "中文", "", "10", "a b"] {
            let v = JsValue::object([(key, JsValue::Null)]);
            assert_eq!(
                kernel_v1(&v),
                Err(UnsupportedKey {
                    key: key.to_owned()
                }),
                "{key:?}"
            );
        }
        let undefined_only = JsValue::object([("a_b", JsValue::Undefined), ("ok", JsValue::Null)]);
        assert!(kernel_v1(&undefined_only).is_ok());
    }
}
