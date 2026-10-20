//! 配对码与中继地址（`pairing.ts`）：`atm1:` + base64url(JSON)，字段 `v u a t s k n` 按这个顺序写，与 TS 逐字节相同。

use serde_json::{Value, json};

use crate::Result;
use crate::crypto::{SPACE_SECRET_BYTES, decode_space_secret};
use crate::encoding::{
    from_base64url, from_utf8_js, js_is_whitespace, js_trim, random_bytes, to_base64url,
};
use crate::error::{SyncError, SyncErrorCode as C};
use crate::keys::new_space_id;
use crate::schema::{Fields, PAIRING_PAYLOAD, check};

pub const PAIRING_PREFIX: &str = "atm1:";

/// `normalizeRelayUrl`：只认 https；http 只给本机调试（`adb reverse` 后手机访问 127.0.0.1）。不许带账号、
/// 查询串或锚点。返回 origin + 去掉末尾斜杠的路径。解析用 WHATWG URL（与 `new URL()` 同一套规则）。
pub fn normalize_relay_url(value: &str) -> Result<String> {
    let url = url::Url::parse(js_trim(value)).map_err(|_| SyncError::new(C::RelayUrlInvalid))?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback)) {
        return Err(SyncError::new(C::RelayUrlInvalid));
    }
    // JS 的 `search` / `hash` 对只有 `?` / `#` 的地址是空串。
    if !url.username().is_empty()
        || url.password().is_some_and(|p| !p.is_empty())
        || url.query().is_some_and(|q| !q.is_empty())
        || url.fragment().is_some_and(|f| !f.is_empty())
    {
        return Err(SyncError::with(
            C::RelayUrlInvalid,
            "地址里不能带账号、查询串或锚点",
        ));
    }
    Ok(format!(
        "{}{}",
        url.origin().ascii_serialization(),
        url.path().trim_end_matches('/')
    ))
}

/// 配对码里的内容。`t`（中继令牌）与 `k`（空间密钥）是秘密，`Debug` 不打印。
#[derive(Clone, PartialEq, Eq)]
pub struct PairingPayload {
    /// 中继地址（规范形式）。
    pub relay_url: String,
    /// 中继上的应用 ID。
    pub app_id: String,
    pub relay_token: String,
    pub space_id: String,
    /// 空间密钥，base64url 的 32 字节。
    pub space_secret: String,
    /// 电脑名。
    pub host_name: String,
}

impl std::fmt::Debug for PairingPayload {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairingPayload")
            .field("relay_url", &self.relay_url)
            .field("app_id", &self.app_id)
            .field("space_id", &self.space_id)
            .field("host_name", &self.host_name)
            .finish_non_exhaustive()
    }
}

impl PairingPayload {
    fn to_json(&self) -> Value {
        json!({
            "v": 1,
            "u": self.relay_url,
            "a": self.app_id,
            "t": self.relay_token,
            "s": self.space_id,
            "k": self.space_secret,
            "n": self.host_name,
        })
    }
}

/// `encodePairingCode`。字段不合格时报 PAIRING_CODE_INVALID（TS 在这里抛的是 zod 的错误，同样拒绝）。
pub fn encode_pairing_code(payload: &PairingPayload) -> Result<String> {
    let mut p = payload.clone();
    p.relay_url = normalize_relay_url(&p.relay_url)?;
    let value = p.to_json();
    if check(&PAIRING_PAYLOAD, &value).is_none() {
        return Err(SyncError::with(C::PairingCodeInvalid, "字段不全或格式不对"));
    }
    let text = serde_json::to_string(&value).map_err(|_| SyncError::new(C::PairingCodeInvalid))?;
    Ok(format!("{PAIRING_PREFIX}{}", to_base64url(text.as_bytes())))
}

/// `decodePairingCode`：容忍复制时带进来的空白与换行（JS `\s`）。
pub fn decode_pairing_code(code: &str) -> Result<PairingPayload> {
    let compact: String = code.chars().filter(|c| !js_is_whitespace(*c)).collect();
    let Some(body) = compact.strip_prefix(PAIRING_PREFIX) else {
        return Err(SyncError::with(C::PairingCodeInvalid, "应以 atm1: 开头"));
    };
    let parsed = from_base64url(body)
        .and_then(|bytes| from_utf8_js(&bytes).and_then(|s| serde_json::from_str::<Value>(s).ok()))
        .ok_or_else(|| SyncError::with(C::PairingCodeInvalid, "内容不完整"))?;
    let checked = check(&PAIRING_PAYLOAD, &parsed)
        .ok_or_else(|| SyncError::with(C::PairingCodeInvalid, "字段不全或格式不对"))?;
    let f = Fields::of(&checked).ok_or_else(|| SyncError::new(C::PairingCodeInvalid))?;
    let field = |k: &str| f.str(k).unwrap_or_default().to_owned();
    // TS 在这里对 43 个非 base64url 字符会抛 TypeError；这里一律当配对码坏了。
    decode_space_secret(&field("k"))
        .map_err(|_| SyncError::with(C::PairingCodeInvalid, "空间密钥长度不对"))?;
    Ok(PairingPayload {
        relay_url: normalize_relay_url(&field("u"))?,
        app_id: field("a"),
        relay_token: field("t"),
        space_id: field("s"),
        space_secret: field("k"),
        host_name: field("n"),
    })
}

/// `generateSpace`：新空间 ID 与空间密钥。系统随机数取不到时 `None`。
pub fn generate_space() -> Option<(String, String)> {
    let secret = random_bytes::<SPACE_SECRET_BYTES>()?;
    Some((new_space_id()?, to_base64url(&secret)))
}
