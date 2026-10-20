//! 同步的错误与给用户看的话（2.x `packages/sync/src/errors.ts`）。
//!
//! **中继不可信**：它看得到 Authorization，能把 token 写进错误正文反射回来。所以给人看的话只拼 HTTP 状态、
//! 白名单里的错误码和本地固定文案（[`RelayError`] 保证码与文字都不含中继返回的原文），不拼请求头、URL 或
//! 查询串。[`redact`] 再把已知密钥的字面量抹掉一遍，只是纵深防御。

use std::fmt;

use atm_domain::error::DomainError;
use atm_sync_protocol::SyncError;

use crate::relay::{RelayError, RelayErrorCode, encode_component};
use crate::space::StoreError;
use crate::text::clip_text;

/// 中继拒绝 token 时状态里显示的话。
pub const RELAY_REJECTED_MESSAGE: &str =
    "中继拒绝了 token：请检查 token 是否填错、是否已被吊销，改好后重新保存";

/// 同步路上会遇到的失败。
#[derive(Debug, Clone, PartialEq)]
pub enum Failure {
    Relay(RelayError),
    /// 协议层：密钥不对、内容不完整、格式不对。
    Protocol(SyncError),
    /// 连接器自己的判断（2.x `SyncCommandError`）：`COMMAND_INVALID`、`PROJECT_NOT_FOUND`、透传的 `DISPATCH_*` 等。
    Command {
        code: String,
        message: String,
    },
    /// ATM 服务报的错。
    Domain(DomainError),
    /// 派单层拒绝（带 SCREAMING_SNAKE 的码与中文说明）。
    Dispatch {
        code: String,
        message: String,
    },
    /// 其它（本地 I/O 等）。
    Other(String),
}

impl Failure {
    pub fn command(code: &str, message: impl Into<String>) -> Failure {
        Failure::Command {
            code: code.to_owned(),
            message: message.into(),
        }
    }

    pub fn relay(&self) -> Option<&RelayError> {
        match self {
            Failure::Relay(e) => Some(e),
            _ => None,
        }
    }

    /// token 无效、被撤销或无权访问该应用。
    pub fn is_auth_failure(&self) -> bool {
        self.relay().is_some_and(RelayError::is_auth_failure)
    }

    /// 会话已经停下（请求被掐断）。
    pub fn is_aborted(&self) -> bool {
        self.relay().is_some_and(RelayError::is_aborted)
    }

    /// ATM 自己标了可重试的错误（例如存储繁忙）：不写失败 ack，稍后再处理（有次数上限）。
    pub fn is_retryable(&self) -> bool {
        match self {
            Failure::Domain(e) => e
                .details
                .get("retryable")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or_else(|| e.code.retryable()),
            _ => false,
        }
    }

    /// 派单器已随宿主退出关闭：不是命令的结局，命令留在中继上，下次启动再处理。
    pub fn is_deferred(&self) -> bool {
        matches!(self, Failure::Dispatch { code, .. } if code == "DISPATCH_CLOSED")
    }

    pub fn code(&self) -> Option<&str> {
        match self {
            Failure::Command { code, .. } | Failure::Dispatch { code, .. } => Some(code),
            Failure::Domain(e) => Some(e.code.as_str()),
            Failure::Relay(e) => Some(e.code.as_str()),
            Failure::Protocol(e) => Some(e.code.as_str()),
            Failure::Other(_) => None,
        }
    }
}

impl From<RelayError> for Failure {
    fn from(e: RelayError) -> Self {
        Failure::Relay(e)
    }
}

impl From<SyncError> for Failure {
    fn from(e: SyncError) -> Self {
        Failure::Protocol(e)
    }
}

impl From<StoreError> for Failure {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::Relay(e) => Failure::Relay(e),
            StoreError::Protocol(e) => Failure::Protocol(e),
        }
    }
}

impl From<DomainError> for Failure {
    fn from(e: DomainError) -> Self {
        Failure::Domain(e)
    }
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&describe(self))
    }
}

/// 截到 500 个码元（2.x `clip`）。
pub fn clip(text: &str) -> String {
    clip_text(text, 500)
}

fn describe_relay(e: &RelayError) -> String {
    if e.is_auth_failure() {
        return format!("{RELAY_REJECTED_MESSAGE}（HTTP {}）", e.status);
    }
    match e.status {
        0 => clip(&e.message),
        404 => "中继上找不到请求的内容（HTTP 404）：请检查地址与应用 ID".to_owned(),
        429 => "中继限流，稍后会自动重试".to_owned(),
        status => {
            let code = if e.code == RelayErrorCode::RelayError {
                String::new()
            } else {
                format!("，{}", e.code.as_str())
            };
            clip(&format!("{}（HTTP {status}{code}）", e.message))
        }
    }
}

/// 把任意错误翻成给用户看的中文一句话。
pub fn describe(e: &Failure) -> String {
    match e {
        Failure::Relay(e) => describe_relay(e),
        Failure::Protocol(e) => clip(&e.message()),
        Failure::Command { message, .. } => clip(message),
        Failure::Domain(e) => clip(&e.message),
        Failure::Dispatch { message, .. } => clip(&format!("同步出错：{message}")),
        Failure::Other(message) => clip(&format!("同步出错：{message}")),
    }
}

/// `^[A-Z][A-Z0-9_]{1,63}$`。
fn is_ack_code(code: &str) -> bool {
    let b = code.as_bytes();
    (2..=64).contains(&b.len())
        && b[0].is_ascii_uppercase()
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == b'_')
}

/// 写进 ack 的 `{code, message}`，长度按协议截断。
pub fn ack_error(e: &Failure) -> (String, String) {
    match e {
        Failure::Command { code, message } => (crate::text::clip_units(code, 64), clip(message)),
        Failure::Domain(d) => (d.code.as_str().chars().take(64).collect(), clip(&d.message)),
        Failure::Dispatch { code, message } if is_ack_code(code) => (code.clone(), clip(message)),
        _ => ("COMMAND_FAILED".to_owned(), describe(e)),
    }
}

/// [`redact`] 换上的占位。
pub const REDACTED: &str = "[已隐藏]";
/// 太短的值不替换：会把正常文字切碎，而 token 至少 8 位、空间 secret 43 位。
const MIN_REDACT_LENGTH: usize = 4;

/// 纵深防御：把已知密钥（中继 token、空间 secret）的字面量及其 URL 编码形式从要外显的文字里抹掉。
pub fn redact(text: &str, secrets: &[&str]) -> String {
    let mut out = text.to_owned();
    for secret in secrets {
        if crate::text::js_len(secret) < MIN_REDACT_LENGTH {
            continue;
        }
        let encoded = encode_component(secret);
        for form in [secret.to_string(), encoded] {
            if !form.is_empty() {
                out = out.replace(&form, REDACTED);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use atm_domain::error::ErrorCode;

    #[test]
    fn relay_failures_are_described_from_local_text() {
        let auth = Failure::Relay(RelayError::http(401, "UNAUTHORIZED"));
        assert_eq!(
            describe(&auth),
            format!("{RELAY_REJECTED_MESSAGE}（HTTP 401）")
        );
        let missing = Failure::Relay(RelayError::http(404, "NOT_FOUND"));
        assert!(describe(&missing).contains("请检查地址与应用 ID"));
        let busy = Failure::Relay(RelayError::http(503, "x"));
        assert_eq!(describe(&busy), "中继暂时不可用（HTTP 503）");
        let full = Failure::Relay(RelayError::http(507, "INSUFFICIENT_STORAGE"));
        assert_eq!(
            describe(&full),
            "中继的存储空间已满（HTTP 507，INSUFFICIENT_STORAGE）"
        );
        let limited = Failure::Relay(RelayError::http(429, "RATE_LIMITED"));
        assert_eq!(describe(&limited), "中继限流，稍后会自动重试");
    }

    #[test]
    fn ack_errors_pass_known_codes_through() {
        let cmd = Failure::command("COMMAND_EXPIRED", "命令发出已超过 7 天，电脑不再执行");
        assert_eq!(ack_error(&cmd).0, "COMMAND_EXPIRED");
        let domain = Failure::Domain(DomainError::new(ErrorCode::VALIDATION_ERROR, "标题太长"));
        assert_eq!(
            ack_error(&domain),
            ("VALIDATION_ERROR".into(), "标题太长".into())
        );
        let dispatch = Failure::Dispatch {
            code: "DISPATCH_DISABLED".into(),
            message: "派单已关闭".into(),
        };
        assert_eq!(ack_error(&dispatch).0, "DISPATCH_DISABLED");
        let odd = Failure::Dispatch {
            code: "lower".into(),
            message: "x".into(),
        };
        assert_eq!(ack_error(&odd).0, "COMMAND_FAILED");
        let relay = Failure::Relay(RelayError::http(500, "INTERNAL"));
        assert_eq!(ack_error(&relay).0, "COMMAND_FAILED");
    }

    #[test]
    fn known_secrets_are_redacted_in_both_forms() {
        let out = redact("a tok/en+1 b tok%2Fen%2B1 c ab", &["tok/en+1", "ab"]);
        assert_eq!(out, "a [已隐藏] b [已隐藏] c ab");
        let retry = Failure::Domain(DomainError::new(ErrorCode::STORE_BUSY, "busy"));
        assert!(retry.is_retryable());
        let deferred = Failure::Dispatch {
            code: "DISPATCH_CLOSED".into(),
            message: "x".into(),
        };
        assert!(deferred.is_deferred());
    }
}
