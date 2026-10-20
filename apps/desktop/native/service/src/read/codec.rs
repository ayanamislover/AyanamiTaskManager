//! 读侧的小工具：base64url、HMAC-SHA256、按 JS 规则计长度与数字。
//!
//! 预算（max_chars）照 surface v5 用 `JSON.stringify(x).length`，即 UTF-16 码元数（02 §9.5）。
//! serde_json 的紧凑输出与 `JSON.stringify` 只在数字上不同：f64 的整数值会写成 `40.0`。
//! 读模型输出前统一过一遍 [`jsify`]，两边的文本与长度就一致了。

use serde_json::Value;
use sha2::{Digest, Sha256};

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// 无填充的 base64url。
pub(crate) fn b64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        let take = chunk.len() + 1;
        for i in 0..take {
            out.push(B64[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

/// 严格解码：只接受规范形式（`b64(decode(x)) == x`），与 2.x 的「重编码比对」一致。
pub(crate) fn unb64(text: &str) -> Option<Vec<u8>> {
    if text.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for c in text.bytes() {
        let v = B64.iter().position(|&b| b == c)? as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    (b64(&out) == text).then_some(out)
}

pub(crate) fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// RFC 2104。
pub(crate) fn hmac(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut block = [0u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&sha256(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|b| b ^ 0x36));
    inner.update(message);
    let mut outer = Sha256::new();
    outer.update(block.map(|b| b ^ 0x5c));
    outer.update(inner.finalize());
    outer.finalize().into()
}

/// 定长比较。
pub(crate) fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// 整数值的 f64 改写成整数，使输出与 `JSON.stringify` 一致。
pub(crate) fn jsify(v: Value) -> Value {
    match v {
        Value::Number(n) => match n.as_f64() {
            Some(f) if n.is_f64() && f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0 =>
            {
                #[allow(clippy::cast_possible_truncation)]
                Value::from(f as i64)
            }
            _ => Value::Number(n),
        },
        Value::Array(items) => Value::Array(items.into_iter().map(jsify).collect()),
        Value::Object(map) => Value::Object(map.into_iter().map(|(k, v)| (k, jsify(v))).collect()),
        other => other,
    }
}

/// `JSON.stringify(v)`（v 已经过 [`jsify`]）。
pub(crate) fn js_text(v: &Value) -> String {
    serde_json::to_string(v).unwrap_or_default()
}

/// `JSON.stringify(v).length`：UTF-16 码元数。
pub(crate) fn js_len(v: &Value) -> usize {
    js_text(v).encode_utf16().count()
}

pub(crate) fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// 前 `units` 个 UTF-16 码元；落在代理对中间时退到它之前（00 02 C-19：不切开代理对）。
pub(crate) fn utf16_prefix(s: &str, units: usize) -> &str {
    let mut used = 0;
    for (i, c) in s.char_indices() {
        let w = c.len_utf16();
        if used + w > units {
            return &s[..i];
        }
        used += w;
    }
    s
}

/// 从第 `from` 个 UTF-16 码元起的后缀；`from` 必须落在 code point 边界上（调用方保证）。
pub(crate) fn utf16_suffix(s: &str, from: usize) -> &str {
    let head = utf16_prefix(s, from);
    &s[head.len()..]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn base64url_round_trip_and_canonical_form() {
        for bytes in [&b""[..], b"f", b"fo", b"foo", b"foob", b"fooba", b"foobar"] {
            assert_eq!(unb64(&b64(bytes)).unwrap(), bytes);
        }
        assert_eq!(b64(b"foobar"), "Zm9vYmFy");
        assert_eq!(b64(&[0xfb, 0xff]), "-_8");
        // 非规范的尾位、非法字符、填充都拒绝。
        assert!(unb64("-_9").is_none());
        assert!(unb64("Zm9v=").is_none());
        assert!(unb64("Z").is_none());
    }

    #[test]
    fn hmac_matches_rfc_4231_case_2() {
        let mac = hmac(b"Jefe", b"what do ya want for nothing?");
        let hex: String = mac.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            hex,
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn js_numbers_and_lengths() {
        let v = jsify(json!({ "a": 40.0, "b": 66.7, "c": [1.0, -2.0], "d": "中\u{1F600}" }));
        assert_eq!(
            js_text(&v),
            "{\"a\":40,\"b\":66.7,\"c\":[1,-2],\"d\":\"中\u{1F600}\"}"
        );
        assert_eq!(js_len(&v), js_text(&v).chars().count() + 1);
        assert_eq!(utf16_prefix("a\u{1F600}b", 2), "a");
        assert_eq!(utf16_prefix("a\u{1F600}b", 3), "a\u{1F600}");
        assert_eq!(utf16_suffix("a\u{1F600}b", 3), "b");
    }
}
