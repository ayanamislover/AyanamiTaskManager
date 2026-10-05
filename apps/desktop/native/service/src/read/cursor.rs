//! 读游标（02 §9.5；00 02 Q-01、C-L12）。
//!
//! - 新游标：`<前缀>.<base64url(JSON)>.<签名>`，签名是库内密钥对 `<前缀>.<载荷>` 的 HMAC-SHA256 前 16 字节。
//!   载荷带项目 id（`p`）与范围世代（`g`）：别的项目的游标是 `INVALID_OR_TAMPERED`，按范围恢复之后的旧游标是
//!   `SCOPE_RESTORED`，两者都让调用方重新读首页。brief 为了省预算用点分格式，见 `brief.rs`。
//! - 2.x 的前缀（`b3`、`tl1`、`rc1`、`rl1`、`sl1`、`s1`、`f2`）一律 `INVALID_CURSOR` + `FORMAT_RETIRED`，
//!   不新增错误码（Q-01）。

use super::Proj;
use super::codec::{b64, hmac, js_text, same, unb64};
use atm_domain::error::{DomainError, ErrorCode};
use serde_json::{Map, Value, json};

/// 2.x 的游标前缀。
pub(crate) const RETIRED: [&str; 7] = ["b3", "tl1", "rc1", "rl1", "sl1", "s1", "f2"];

pub(crate) const BRIEF: &str = "b4";
pub(crate) const TASK_LIST: &str = "tl2";
pub(crate) const RECORD_LIST: &str = "rl2";
pub(crate) const SESSION_LIST: &str = "sl2";
pub(crate) const SEARCH: &str = "s2";
pub(crate) const FIELD: &str = "f3";

fn restart() -> Value {
    json!({ "action": "restart_read", "omit_cursor": true })
}

pub(crate) fn invalid(reason: &str) -> DomainError {
    let message = match reason {
        "FORMAT_RETIRED" => "这是升级前的游标，已不再有效：去掉 cursor 重新读取首页",
        "EXPIRED" => "游标已过期：去掉 cursor 重新读取",
        "SCOPE_RESTORED" => "项目在这个游标签发之后被恢复过：去掉 cursor 重新读取",
        _ => "游标无效、已损坏或不属于这次请求：去掉 cursor 重新读取",
    };
    DomainError::new(ErrorCode::INVALID_CURSOR, message)
        .detail("reason", reason)
        .detail("recovery", restart())
}

pub(crate) fn tampered() -> DomainError {
    invalid("INVALID_OR_TAMPERED")
}

pub(crate) fn target_mismatch(what: &str) -> DomainError {
    DomainError::new(
        ErrorCode::CONTINUATION_CONFLICT,
        format!("{what} 续读的请求参数与首页不同：用首页的参数原样重发"),
    )
    .detail("reason", "TARGET_MISMATCH")
    .detail(
        "recovery",
        json!({ "action": "retry_original_target", "preserve_cursor": true }),
    )
}

pub(crate) fn stale(message: impl Into<String>) -> DomainError {
    DomainError::new(ErrorCode::CONTINUATION_CONFLICT, message)
        .detail("reason", "STALE")
        .detail("recovery", restart())
}

/// 2.x 的前缀 → FORMAT_RETIRED；其他陌生前缀 → INVALID_OR_TAMPERED。
pub(crate) fn foreign(token: &str) -> DomainError {
    let prefix = token.split('.').next().unwrap_or_default();
    if RETIRED.contains(&prefix) {
        invalid("FORMAT_RETIRED")
    } else {
        tampered()
    }
}

/// 签名：HMAC 前 16 字节的 base64url（22 字符）。
pub(crate) fn sign(key: &[u8], body: &str) -> String {
    b64(&hmac(key, body.as_bytes())[..16])
}

pub(crate) fn verify(key: &[u8], body: &str, signature: &str) -> bool {
    match unb64(signature) {
        Some(bytes) => same(&bytes, &hmac(key, body.as_bytes())[..16]),
        None => false,
    }
}

/// 封装一个 JSON 载荷（自动加 `p`、`g`）。
pub(crate) fn seal(key: &[u8], prefix: &str, p: &Proj, mut payload: Map<String, Value>) -> String {
    payload.insert("p".into(), json!(p.id));
    payload.insert("g".into(), json!(p.generation));
    let body = format!(
        "{prefix}.{}",
        b64(js_text(&Value::Object(payload)).as_bytes())
    );
    let sig = sign(key, &body);
    format!("{body}.{sig}")
}

/// 打开一个 JSON 载荷：形状、签名、项目、世代都核对，返回去掉 `p`、`g` 之后的对象。
pub(crate) fn open(
    key: &[u8],
    prefix: &str,
    p: &Proj,
    token: &str,
) -> Result<Map<String, Value>, DomainError> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.first() != Some(&prefix) {
        return Err(foreign(token));
    }
    let [_, payload, sig] = parts.as_slice() else {
        return Err(tampered());
    };
    let body = format!("{prefix}.{payload}");
    if !verify(key, &body, sig) {
        return Err(tampered());
    }
    let bytes = unb64(payload).ok_or_else(tampered)?;
    let Ok(Value::Object(mut map)) = serde_json::from_slice::<Value>(&bytes) else {
        return Err(tampered());
    };
    if map.remove("p").as_ref().and_then(Value::as_str) != Some(p.id.as_str()) {
        return Err(tampered());
    }
    match map.remove("g").as_ref().and_then(Value::as_i64) {
        Some(g) if g == p.generation => Ok(map),
        Some(_) => Err(invalid("SCOPE_RESTORED")),
        None => Err(tampered()),
    }
}

/// 不绑定项目的游标（全局搜索）：载荷原样封装。
pub(crate) fn seal_plain(key: &[u8], prefix: &str, payload: Map<String, Value>) -> String {
    let body = format!(
        "{prefix}.{}",
        b64(js_text(&Value::Object(payload)).as_bytes())
    );
    let sig = sign(key, &body);
    format!("{body}.{sig}")
}

pub(crate) fn open_plain(
    key: &[u8],
    prefix: &str,
    token: &str,
) -> Result<Map<String, Value>, DomainError> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.first() != Some(&prefix) {
        return Err(foreign(token));
    }
    let [_, payload, sig] = parts.as_slice() else {
        return Err(tampered());
    };
    if !verify(key, &format!("{prefix}.{payload}"), sig) {
        return Err(tampered());
    }
    let bytes = unb64(payload).ok_or_else(tampered)?;
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Object(map)) => Ok(map),
        _ => Err(tampered()),
    }
}

/// 精确的键集合（2.x：JSON 键集合不精确也算篡改）。
pub(crate) fn exact_keys(map: &Map<String, Value>, keys: &[&str]) -> Result<(), DomainError> {
    if map.len() == keys.len() && keys.iter().all(|k| map.contains_key(*k)) {
        Ok(())
    } else {
        Err(tampered())
    }
}

pub(crate) fn str_of<'a>(map: &'a Map<String, Value>, key: &str) -> Result<&'a str, DomainError> {
    map.get(key).and_then(Value::as_str).ok_or_else(tampered)
}

pub(crate) fn int_of(map: &Map<String, Value>, key: &str) -> Result<i64, DomainError> {
    map.get(key).and_then(Value::as_i64).ok_or_else(tampered)
}
