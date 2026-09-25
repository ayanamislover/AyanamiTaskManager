//! JSON-RPC framing helpers that must behave exactly like the JavaScript bridge.

use serde_json::Value;

/// `String.prototype.trim` whitespace: ECMAScript WhiteSpace plus LineTerminator.
///
/// Not `char::is_whitespace`: that includes U+0085 and excludes U+FEFF, while
/// JavaScript does the opposite, so a BOM-only line would be forwarded here and
/// skipped by the old bridge.
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// Removes insignificant whitespace from text that is already known to be valid JSON.
///
/// The old bridge wrote `JSON.stringify(JSON.parse(text))`. Re-serialising through a
/// parser would reorder keys or reformat numbers; stripping whitespace outside strings
/// gives the same single line for everything the daemon emits and keeps every literal
/// byte-for-byte.
pub fn compact(valid_json: &str) -> String {
    let mut out = String::with_capacity(valid_json.len());
    let mut in_string = false;
    let mut escaped = false;
    for c in valid_json.chars() {
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
        } else if c == '"' {
            in_string = true;
            out.push(c);
        } else if !matches!(c, ' ' | '\t' | '\n' | '\r') {
            out.push(c);
        }
    }
    out
}

/// The id an error response must carry: `"id" in message ? message.id ?? null : null`.
pub fn request_id(message: &Value) -> String {
    match message {
        Value::Object(map) => match map.get("id") {
            None | Some(Value::Null) => "null".to_owned(),
            Some(id) => serde_json::to_string(id).unwrap_or_else(|_| "null".to_owned()),
        },
        _ => "null".to_owned(),
    }
}

pub fn error_line(code: i64, message: &str, id: &str) -> String {
    let message = serde_json::to_string(message).unwrap_or_else(|_| "\"MCP proxy error\"".into());
    format!(r#"{{"jsonrpc":"2.0","error":{{"code":{code},"message":{message}}},"id":{id}}}"#)
}

pub const PARSE_ERROR_LINE: &str =
    r#"{"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error"},"id":null}"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_like_javascript_not_like_rust() {
        assert_eq!(js_trim("\u{FEFF} x \u{3000}"), "x");
        // U+0085 is Unicode White_Space but not ECMAScript whitespace.
        assert_eq!(js_trim("\u{0085}x"), "\u{0085}x");
        assert_eq!(js_trim("\u{2028}\u{2029}"), "");
    }

    #[test]
    fn compaction_only_touches_whitespace_outside_strings() {
        let text = "{\n  \"a\" : [ 1.0 , 2e3 ],\n  \"s\": \"x \\\" y\\\\\" , \"t\":\"\\n \"\n}";
        assert_eq!(
            compact(text),
            "{\"a\":[1.0,2e3],\"s\":\"x \\\" y\\\\\",\"t\":\"\\n \"}"
        );
        assert_eq!(compact("{\"k\":\"中 文\"}"), "{\"k\":\"中 文\"}");
    }

    #[test]
    fn id_follows_the_javascript_expression() {
        let id = |text: &str| request_id(&serde_json::from_str(text).unwrap());
        assert_eq!(id(r#"{"id":7}"#), "7");
        assert_eq!(id(r#"{"id":"a\"b"}"#), r#""a\"b""#);
        assert_eq!(id(r#"{"id":null}"#), "null");
        assert_eq!(id(r#"{"method":"x"}"#), "null");
        assert_eq!(id(r#"[{"id":1}]"#), "null");
        assert_eq!(id("42"), "null");
        // Literal kept verbatim (JavaScript would print 1 and lose digits past 2^53).
        assert_eq!(id(r#"{"id":1.0}"#), "1.0");
        assert_eq!(id(r#"{"id":12345678901234567890}"#), "12345678901234567890");
    }

    #[test]
    fn error_lines_match_the_javascript_bridge_byte_for_byte() {
        assert_eq!(
            error_line(-32000, "ATM_RUNTIME_UNAVAILABLE", "3"),
            r#"{"jsonrpc":"2.0","error":{"code":-32000,"message":"ATM_RUNTIME_UNAVAILABLE"},"id":3}"#
        );
        assert_eq!(
            error_line(-32000, "引号\"与\n换行", "null"),
            r#"{"jsonrpc":"2.0","error":{"code":-32000,"message":"引号\"与\n换行"},"id":null}"#
        );
    }
}
