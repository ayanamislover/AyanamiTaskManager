//! Discovery of the running daemon through `runtime/daemon.json`.
//!
//! The error categories mirror the JavaScript bridge, because they decide what the
//! caller does next: `DescriptorInvalid` fails the request at once, everything else
//! means "not up yet" and is waited out (with one wake attempt).

use serde_json::Value;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Runtime {
    pub port: u16,
    pub token: String,
    pub pid: u32,
    pub instance_id: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RuntimeError {
    /// A descriptor exists but fails validation. Never waited out.
    DescriptorInvalid,
    /// No data directory, no descriptor, or a descriptor that is not yet usable.
    NotReady,
}

pub fn data_directory() -> Option<PathBuf> {
    // Empty values are falsy in the old bridge and fall through, so they do here too.
    if let Some(dir) = std::env::var_os("ATM_DATA_DIR").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    let base = std::env::var_os("LOCALAPPDATA").filter(|v| !v.is_empty())?;
    Some(PathBuf::from(base).join("AyanamiTaskManager"))
}

pub fn load() -> Result<Runtime, RuntimeError> {
    let dir = data_directory().ok_or(RuntimeError::NotReady)?;
    let path = dir.join("runtime").join("daemon.json");
    if !path.exists() {
        return Err(RuntimeError::NotReady);
    }
    let bytes = std::fs::read(&path).map_err(|_| RuntimeError::DescriptorInvalid)?;
    let text = String::from_utf8_lossy(&bytes);
    let value: Value = serde_json::from_str(&text).map_err(|_| RuntimeError::DescriptorInvalid)?;
    parse(&value)
}

pub fn parse(value: &Value) -> Result<Runtime, RuntimeError> {
    // `new URL(current.endpoint)` throws a TypeError (not the descriptor error) when the
    // descriptor is not an object or the endpoint is not a URL at all.
    let endpoint = value
        .as_object()
        .and_then(|map| map.get("endpoint"))
        .and_then(Value::as_str)
        .ok_or(RuntimeError::NotReady)?;
    let port = match parse_endpoint(endpoint) {
        Endpoint::Loopback(port) => port,
        Endpoint::NotAUrl => return Err(RuntimeError::NotReady),
        Endpoint::Rejected => return Err(RuntimeError::DescriptorInvalid),
    };
    let map = value.as_object().ok_or(RuntimeError::NotReady)?;
    let invalid = RuntimeError::DescriptorInvalid;

    let token = map
        .get("token")
        .and_then(Value::as_str)
        .ok_or(RuntimeError::DescriptorInvalid)?;
    // Length is counted in UTF-16 units like `token.length`. Control characters are
    // refused outright: this value is written into an HTTP header.
    if token.is_empty()
        || token.encode_utf16().count() > 512
        || token.chars().any(|c| c.is_control())
    {
        return Err(invalid);
    }

    let pid = map
        .get("pid")
        .and_then(safe_positive_integer)
        .ok_or(RuntimeError::DescriptorInvalid)?;
    let pid = u32::try_from(pid).map_err(|_| RuntimeError::DescriptorInvalid)?;

    let instance_id = map
        .get("instanceId")
        .and_then(Value::as_str)
        .filter(|id| id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
        .ok_or(RuntimeError::DescriptorInvalid)?;

    let version_ok = map
        .get("version")
        .and_then(Value::as_str)
        .is_some_and(|v| !v.is_empty());
    let started_ok = map
        .get("startedAt")
        .and_then(Value::as_str)
        .is_some_and(parses_as_date);
    if !version_ok || !started_ok {
        return Err(invalid);
    }

    Ok(Runtime {
        port,
        token: token.to_owned(),
        pid,
        instance_id: instance_id.to_owned(),
    })
}

/// `Number.isSafeInteger(x) && x > 0`.
fn safe_positive_integer(value: &Value) -> Option<u64> {
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    let number = value.as_f64()?;
    (number.fract() == 0.0 && number > 0.0 && number <= MAX_SAFE).then_some(number as u64)
}

#[derive(Debug, PartialEq, Eq)]
pub enum Endpoint {
    Loopback(u16),
    /// `new URL()` would throw.
    NotAUrl,
    /// A URL, but not `http://127.0.0.1[:port]/` with nothing else.
    Rejected,
}

/// Accepts exactly the shape the daemon publishes, `http://127.0.0.1:<port>` with an
/// optional trailing slash. Deliberately narrower than WHATWG URL parsing (which would
/// also normalise `127.1` or `0x7f.0.0.1` to loopback): this decides where a bearer
/// token is sent.
pub fn parse_endpoint(raw: &str) -> Endpoint {
    let text = raw.trim_matches(|c: char| c <= ' ');
    let Some(scheme_end) = text.find(':') else {
        return Endpoint::NotAUrl;
    };
    let scheme = &text[..scheme_end];
    let is_scheme = scheme
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    if !is_scheme {
        return Endpoint::NotAUrl;
    }
    if !scheme.eq_ignore_ascii_case("http") {
        return Endpoint::Rejected;
    }
    let Some(rest) = text[scheme_end + 1..].strip_prefix("//") else {
        return Endpoint::Rejected;
    };
    let authority_end = rest.find(['/', '?', '#', '\\']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(authority_end);
    if authority.is_empty() {
        return Endpoint::NotAUrl;
    }
    if authority.contains('@') {
        return Endpoint::Rejected;
    }
    let (host, port) = match authority.rfind(':') {
        Some(at) => (&authority[..at], Some(&authority[at + 1..])),
        None => (authority, None),
    };
    let port = match port {
        None | Some("") => 80,
        Some(digits) if digits.bytes().all(|b| b.is_ascii_digit()) => match digits.parse::<u32>() {
            Ok(p) if p <= 65_535 => p as u16,
            _ => return Endpoint::NotAUrl,
        },
        Some(_) => return Endpoint::NotAUrl,
    };
    if host != "127.0.0.1" || !(tail.is_empty() || tail == "/") {
        return Endpoint::Rejected;
    }
    Endpoint::Loopback(port)
}

/// `Number.isFinite(Date.parse(text))` for the ISO 8601 forms `Date.parse` guarantees.
/// The daemon writes `toISOString()`; the informal fallbacks V8 also accepts are not
/// reproduced.
fn parses_as_date(text: &str) -> bool {
    let b = text.as_bytes();
    let digits = |from: usize, len: usize| -> Option<u32> {
        let slice = b.get(from..from + len)?;
        slice.iter().all(u8::is_ascii_digit).then(|| {
            slice
                .iter()
                .fold(0u32, |acc, d| acc * 10 + u32::from(d - b'0'))
        })
    };
    let (Some(_year), Some(month), Some(day)) = (digits(0, 4), digits(5, 2), digits(8, 2)) else {
        return false;
    };
    if b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') {
        return false;
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return false;
    }
    if b.len() == 10 {
        return true;
    }
    if b.get(10) != Some(&b'T') {
        return false;
    }
    let (Some(hour), Some(minute)) = (digits(11, 2), digits(14, 2)) else {
        return false;
    };
    if b.get(13) != Some(&b':') || hour > 24 || minute > 59 {
        return false;
    }
    let mut at = 16;
    if b.get(at) == Some(&b':') {
        match digits(at + 1, 2) {
            Some(second) if second <= 59 => at += 3,
            _ => return false,
        }
        if b.get(at) == Some(&b'.') {
            let start = at + 1;
            at = start;
            while b.get(at).is_some_and(u8::is_ascii_digit) {
                at += 1;
            }
            if at == start {
                return false;
            }
        }
    }
    match &b[at..] {
        [] | [b'Z'] => true,
        [b'+' | b'-', ..] => {
            b.len() == at + 6
                && digits(at + 1, 2).is_some_and(|h| h <= 23)
                && b[at + 3] == b':'
                && digits(at + 4, 2).is_some_and(|m| m <= 59)
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn descriptor() -> Value {
        json!({
            "endpoint": "http://127.0.0.1:60092",
            "token": "t0ken",
            "pid": 4242,
            "instanceId": "0123456789abcdef0123456789abcdef",
            "version": "1.1.5",
            "startedAt": "2026-09-24T03:29:45.577Z"
        })
    }

    fn with(key: &str, value: Value) -> Value {
        let mut d = descriptor();
        d[key] = value;
        d
    }

    #[test]
    fn accepts_what_the_daemon_publishes() {
        assert_eq!(
            parse(&descriptor()),
            Ok(Runtime {
                port: 60092,
                token: "t0ken".into(),
                pid: 4242,
                instance_id: "0123456789abcdef0123456789abcdef".into()
            })
        );
        assert!(parse(&with("endpoint", json!("http://127.0.0.1:60092/"))).is_ok());
    }

    #[test]
    fn endpoint_only_ever_points_at_loopback_http() {
        use Endpoint::*;
        assert_eq!(parse_endpoint("http://127.0.0.1:1"), Loopback(1));
        assert_eq!(parse_endpoint("HTTP://127.0.0.1:1/"), Loopback(1));
        assert_eq!(parse_endpoint("http://127.0.0.1"), Loopback(80));
        for rejected in [
            "https://127.0.0.1:1",
            "http://localhost:1",
            "http://127.0.0.2:1",
            "http://evil.example:1",
            "http://user:pw@127.0.0.1:1",
            "http://127.0.0.1:1/mcp",
            "http://127.0.0.1:1/?q",
            "http://127.0.0.1:1#h",
            "http://127.1:1",
            "file:///C:/x",
        ] {
            assert_eq!(parse_endpoint(rejected), Rejected, "{rejected}");
        }
        for not_url in [
            "",
            "127.0.0.1:1",
            "http://",
            "http://127.0.0.1:99999",
            "http://127.0.0.1:x",
        ] {
            assert_eq!(parse_endpoint(not_url), NotAUrl, "{not_url}");
        }
    }

    #[test]
    fn a_malformed_descriptor_fails_fast_but_a_missing_url_is_waited_out() {
        use RuntimeError::*;
        assert_eq!(parse(&json!(null)), Err(NotReady));
        assert_eq!(parse(&json!([])), Err(NotReady));
        assert_eq!(parse(&with("endpoint", json!(5))), Err(NotReady));
        assert_eq!(parse(&with("endpoint", json!("nonsense"))), Err(NotReady));
        assert_eq!(
            parse(&with("endpoint", json!("https://127.0.0.1:1"))),
            Err(DescriptorInvalid)
        );
    }

    #[test]
    fn every_field_is_validated_like_the_javascript_bridge() {
        use RuntimeError::DescriptorInvalid;
        let long = "x".repeat(513);
        let cases = [
            ("token", json!("")),
            ("token", json!(long)),
            ("token", json!("a\r\nInjected: 1")),
            ("token", json!(7)),
            ("pid", json!(0)),
            ("pid", json!(-1)),
            ("pid", json!(1.5)),
            ("pid", json!(9_007_199_254_740_992_u64)),
            ("pid", json!("42")),
            ("instanceId", json!("0123456789ABCDEF0123456789ABCDEF")),
            ("instanceId", json!("0123")),
            ("version", json!("")),
            ("startedAt", json!("yesterday")),
            ("startedAt", json!("2026-13-01T00:00:00Z")),
        ];
        for (key, value) in cases {
            assert_eq!(
                parse(&with(key, value.clone())),
                Err(DescriptorInvalid),
                "{key}={value}"
            );
        }
        // 512 UTF-16 units is still fine; a non-BMP char counts twice.
        assert!(parse(&with("token", json!("x".repeat(512)))).is_ok());
        assert!(parse(&with("token", json!("😀".repeat(257)))).is_err());
        assert!(parse(&with("pid", json!(42.0))).is_ok());
    }

    #[test]
    fn dates_in_the_iso_forms_date_parse_accepts() {
        for ok in [
            "2026-09-24",
            "2026-09-24T03:29",
            "2026-09-24T03:29:45",
            "2026-09-24T03:29:45.5Z",
            "2026-09-24T03:29:45.577+01:00",
        ] {
            assert!(parses_as_date(ok), "{ok}");
        }
        for bad in [
            "",
            "2026-9-24",
            "2026-09-24 03:29:45",
            "2026-09-24T25:00Z",
            "2026-09-24T03:29:45.Z",
        ] {
            assert!(!parses_as_date(bad), "{bad}");
        }
    }
}
