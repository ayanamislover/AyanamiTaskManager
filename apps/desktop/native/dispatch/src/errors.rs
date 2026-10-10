//! 派单的错误码（2.x `packages/agent-dispatch/src/errors.ts`）：码、HTTP 状态、能否重试一一照抄。
//! 派单是可选功能，错误只在派单路由与手机命令里出现，所以不进全局错误码表。

use atm_domain::error::DomainError;
use serde_json::{Map, Value, json};

macro_rules! codes {
    ($($name:ident => $status:literal, $retry:literal;)*) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        #[allow(non_camel_case_types)]
        pub enum Code { $($name,)* }

        impl Code {
            pub const ALL: &[Code] = &[$(Code::$name,)*];

            pub fn as_str(self) -> &'static str {
                match self { $(Code::$name => stringify!($name),)* }
            }

            pub fn http_status(self) -> u16 {
                match self { $(Code::$name => $status,)* }
            }

            pub fn retryable(self) -> bool {
                match self { $(Code::$name => $retry,)* }
            }

            pub fn parse(text: &str) -> Option<Code> {
                match text { $(stringify!($name) => Some(Code::$name),)* _ => None }
            }
        }
    };
}

codes! {
    DISPATCH_DISABLED => 409, false;
    DISPATCH_INVALID_ARGUMENT => 400, false;
    DISPATCH_PROJECT_NOT_FOUND => 404, false;
    DISPATCH_PROJECT_PATH_MISSING => 422, false;
    DISPATCH_TASK_NOT_FOUND => 404, false;
    DISPATCH_TASK_NOT_READY => 409, false;
    DISPATCH_ALREADY_ACTIVE => 409, false;
    DISPATCH_CLAUDE_NOT_FOUND => 503, false;
    DISPATCH_CLAUDE_NOT_LOGGED_IN => 503, false;
    DISPATCH_RUN_NOT_FOUND => 404, false;
    DISPATCH_RUN_NOT_ACTIVE => 409, false;
    // 取消时没能结束会话进程，或确认不了那个 PID 还是不是这次的会话：派单仍算运行中、名额不释放，可以重试。
    DISPATCH_CANCEL_FAILED => 500, true;
    // 保留期内的手机派单请求数到了账本上限，条目过期后自然恢复。
    DISPATCH_TOO_MANY_REQUESTS => 429, true;
    // 账本读不出来：无法判断命令是否执行过，手机派单暂停，下次重读。
    DISPATCH_LEDGER_UNAVAILABLE => 503, true;
    // 账本丢过数据，这条命令发出时间在水位线之前、账本里又查不到：同一条命令重试也不会变。
    DISPATCH_REQUEST_STATE_LOST => 409, false;
    // 宿主正在退出：不是对请求本身的判断，不记进账本；手机命令留到下次启动。
    DISPATCH_CLOSED => 503, true;
}

/// claude 没登录或登录过期时给用户看的话：派单被拒与会话因鉴权失败结束用同一句，原文另存在 summary.result。
pub const CLAUDE_LOGIN_REQUIRED_MESSAGE: &str =
    "Claude Code 未登录或登录已过期：在电脑终端运行 claude auth login 后再交给 Claude";

#[derive(Clone, Debug, PartialEq)]
pub struct DispatchError {
    pub code: Code,
    pub message: String,
    pub details: Option<Map<String, Value>>,
}

impl DispatchError {
    pub fn new(code: Code, message: impl Into<String>) -> DispatchError {
        DispatchError {
            code,
            message: message.into(),
            details: None,
        }
    }

    pub fn detail(mut self, key: &str, value: impl Into<Value>) -> DispatchError {
        self.details
            .get_or_insert_with(Map::new)
            .insert(key.to_owned(), value.into());
        self
    }

    pub fn retryable(&self) -> bool {
        self.code.retryable()
    }

    /// 2.x `toDto()`。
    pub fn to_json(&self) -> Value {
        let mut v = json!({
            "code": self.code.as_str(),
            "message": self.message,
            "retryable": self.retryable(),
        });
        if let Some(d) = &self.details {
            v["details"] = Value::Object(d.clone());
        }
        v
    }
}

impl std::fmt::Display for DispatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for DispatchError {}

/// 派单入口的全部失败：派单自己的拒绝，或服务报的错（判权被拒、库不可用）。
#[derive(Clone, Debug, PartialEq)]
pub enum Error {
    Dispatch(DispatchError),
    Domain(DomainError),
}

impl From<DispatchError> for Error {
    fn from(e: DispatchError) -> Error {
        Error::Dispatch(e)
    }
}

impl From<DomainError> for Error {
    fn from(e: DomainError) -> Error {
        Error::Domain(e)
    }
}

impl Error {
    pub fn code(&self) -> &str {
        match self {
            Error::Dispatch(e) => e.code.as_str(),
            Error::Domain(e) => e.code.as_str(),
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Error::Dispatch(e) => &e.message,
            Error::Domain(e) => &e.message,
        }
    }

    pub fn dispatch(&self) -> Option<&DispatchError> {
        match self {
            Error::Dispatch(e) => Some(e),
            Error::Domain(_) => None,
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code(), self.message())
    }
}

pub(crate) fn disabled() -> DispatchError {
    DispatchError::new(
        Code::DISPATCH_DISABLED,
        "派单未开启：请先在 ATM 设置里打开「交给 Claude」",
    )
}

pub(crate) fn closed() -> DispatchError {
    DispatchError::new(
        Code::DISPATCH_CLOSED,
        "ATM 正在退出，Claude 派单已停止：重新打开 ATM 后再试",
    )
}

pub(crate) fn invalid(message: impl Into<String>) -> DispatchError {
    DispatchError::new(Code::DISPATCH_INVALID_ARGUMENT, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_policy_table_is_the_2x_one() {
        let table: Vec<(&str, u16, bool)> = Code::ALL
            .iter()
            .map(|c| (c.as_str(), c.http_status(), c.retryable()))
            .collect();
        assert_eq!(
            table,
            [
                ("DISPATCH_DISABLED", 409, false),
                ("DISPATCH_INVALID_ARGUMENT", 400, false),
                ("DISPATCH_PROJECT_NOT_FOUND", 404, false),
                ("DISPATCH_PROJECT_PATH_MISSING", 422, false),
                ("DISPATCH_TASK_NOT_FOUND", 404, false),
                ("DISPATCH_TASK_NOT_READY", 409, false),
                ("DISPATCH_ALREADY_ACTIVE", 409, false),
                ("DISPATCH_CLAUDE_NOT_FOUND", 503, false),
                ("DISPATCH_CLAUDE_NOT_LOGGED_IN", 503, false),
                ("DISPATCH_RUN_NOT_FOUND", 404, false),
                ("DISPATCH_RUN_NOT_ACTIVE", 409, false),
                ("DISPATCH_CANCEL_FAILED", 500, true),
                ("DISPATCH_TOO_MANY_REQUESTS", 429, true),
                ("DISPATCH_LEDGER_UNAVAILABLE", 503, true),
                ("DISPATCH_REQUEST_STATE_LOST", 409, false),
                ("DISPATCH_CLOSED", 503, true),
            ]
        );
        for c in Code::ALL {
            assert_eq!(Code::parse(c.as_str()), Some(*c));
        }
        assert_eq!(Code::parse("DISPATCH_NOPE"), None);
    }

    #[test]
    fn the_dto_carries_details_only_when_there_are_some() {
        let plain = DispatchError::new(Code::DISPATCH_DISABLED, "关着");
        assert_eq!(
            plain.to_json(),
            json!({ "code": "DISPATCH_DISABLED", "message": "关着", "retryable": false })
        );
        let with = DispatchError::new(Code::DISPATCH_CLOSED, "退出").detail("requestId", "x");
        assert_eq!(with.to_json()["details"], json!({ "requestId": "x" }));
        assert_eq!(with.to_json()["retryable"], json!(true));
    }
}
