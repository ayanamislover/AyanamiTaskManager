//! 协议层的错误（`packages/sync-protocol/src/errors.ts`）：错误码与给用户看的中文逐字相同。

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncErrorCode {
    PairingCodeInvalid,
    RelayUrlInvalid,
    KeyInvalid,
    KeyMismatch,
    DecryptFailed,
    ObjectIncomplete,
    ObjectTooLarge,
    SchemaInvalid,
}

impl SyncErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PairingCodeInvalid => "PAIRING_CODE_INVALID",
            Self::RelayUrlInvalid => "RELAY_URL_INVALID",
            Self::KeyInvalid => "KEY_INVALID",
            Self::KeyMismatch => "KEY_MISMATCH",
            Self::DecryptFailed => "DECRYPT_FAILED",
            Self::ObjectIncomplete => "OBJECT_INCOMPLETE",
            Self::ObjectTooLarge => "OBJECT_TOO_LARGE",
            Self::SchemaInvalid => "SCHEMA_INVALID",
        }
    }

    fn message(self) -> &'static str {
        match self {
            Self::PairingCodeInvalid => "配对码无法识别，请重新扫码或完整复制电脑上的配对码",
            Self::RelayUrlInvalid => {
                "中继地址必须是 https；只有本机调试地址（127.0.0.1 / localhost）允许 http"
            }
            Self::KeyInvalid => "文档键不合法",
            Self::KeyMismatch => "配对密钥已更换，请在电脑上重新获取配对码",
            Self::DecryptFailed => "内容校验失败：可能被篡改，或不是这个配对空间写入的",
            Self::ObjectIncomplete => "内容正在更新，稍后再试",
            Self::ObjectTooLarge => "内容超过同步上限",
            Self::SchemaInvalid => "内容格式不符合同步协议",
        }
    }
}

/// `message` 可以直接给用户看；带细节时写成 `<说明>（<细节>）`，与 TS 一样。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncError {
    pub code: SyncErrorCode,
    pub detail: Option<String>,
}

impl SyncError {
    pub fn new(code: SyncErrorCode) -> SyncError {
        SyncError { code, detail: None }
    }

    pub fn with(code: SyncErrorCode, detail: impl Into<String>) -> SyncError {
        SyncError {
            code,
            detail: Some(detail.into()),
        }
    }

    pub fn message(&self) -> String {
        match &self.detail {
            Some(d) => format!("{}（{d}）", self.code.message()),
            None => self.code.message().to_owned(),
        }
    }
}

impl fmt::Display for SyncError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message())
    }
}

impl std::error::Error for SyncError {}
