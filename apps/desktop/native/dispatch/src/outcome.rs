//! 按日志判定一次派单的结局（2.x `result.ts`）：stream-json 日志末尾的 `{"type":"result"}` 行，与 stderr 的末尾。

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde_json::{Map, Number, Value, json};

use crate::errors::CLAUDE_LOGIN_REQUIRED_MESSAGE;
use crate::prompt::js_trim;

const RESULT_LIMIT: usize = 500;
const ERROR_LIMIT: usize = 300;
/// 读 stdout 日志末尾这么多字节找 result 行。
pub const STDOUT_TAIL: u64 = 1024 * 1024;
const STDERR_TAIL: u64 = 16 * 1024;

/// 会话结束时从 result 行摘出的摘要。数字保留原样（整数还是整数）。
#[derive(Clone, Debug, PartialEq)]
pub struct Summary {
    pub num_turns: Option<Number>,
    pub duration_ms: Option<Number>,
    pub total_cost_usd: Option<Number>,
    /// 截断到 500 个码点。
    pub result: String,
}

impl Summary {
    pub fn to_json(&self) -> Value {
        json!({
            "numTurns": self.num_turns,
            "durationMs": self.duration_ms,
            "totalCostUsd": self.total_cost_usd,
            "result": self.result,
        })
    }

    /// 读回存着的摘要；形状不对是 `None`（2.x 的 SummarySchema）。
    pub fn from_json(v: &Value) -> Option<Summary> {
        let o = v.as_object()?;
        let num = |k: &str| match o.get(k)? {
            Value::Null => Some(None),
            Value::Number(n) => Some(Some(n.clone())),
            _ => None,
        };
        Some(Summary {
            num_turns: num("numTurns")?,
            duration_ms: num("durationMs")?,
            total_cost_usd: num("totalCostUsd")?,
            result: o.get("result")?.as_str()?.to_owned(),
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Outcome {
    /// `succeeded` 或 `failed`。
    pub succeeded: bool,
    pub summary: Option<Summary>,
    pub error: Option<String>,
    /// 失败原因是 claude 没登录或登录过期：调用方据此让登录状态缓存失效。
    pub auth_failure: bool,
}

/// 按码点截断，截断时最后一位换成「…」。
pub(crate) fn truncate(value: &str, limit: usize) -> String {
    let points: Vec<char> = value.chars().collect();
    if points.len() <= limit {
        value.to_owned()
    } else {
        let mut s: String = points[..limit - 1].iter().collect();
        s.push('…');
        s
    }
}

/// 文件末尾至多 `max` 字节，按 UTF-8 解码（坏字节换成 U+FFFD）；文件不存在或读不出是空串。
pub fn read_tail(path: &Path, max: u64) -> String {
    let Ok(mut file) = std::fs::File::open(path) else {
        return String::new();
    };
    let Ok(size) = file.metadata().map(|m| m.len()) else {
        return String::new();
    };
    let length = size.min(max);
    let mut buffer = Vec::with_capacity(length as usize);
    if file.seek(SeekFrom::Start(size - length)).is_err()
        || file.take(length).read_to_end(&mut buffer).is_err()
    {
        return String::new();
    }
    String::from_utf8_lossy(&buffer).into_owned()
}

/// 从 stream-json 日志里由后往前找最后一行 `{"type":"result",...}`。
pub fn find_result_line(text: &str) -> Option<Map<String, Value>> {
    for line in text.split('\n').rev() {
        let line = js_trim(line.strip_suffix('\r').unwrap_or(line));
        if !line.starts_with('{') || !line.contains("\"result\"") {
            continue;
        }
        if let Ok(Value::Object(o)) = serde_json::from_str::<Value>(line)
            && o.get("type").and_then(Value::as_str) == Some("result")
        {
            return Some(o);
        }
    }
    None
}

pub fn log_has_result(stdout_log: &Path) -> bool {
    find_result_line(&read_tail(stdout_log, STDOUT_TAIL)).is_some()
}

fn ascii_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `/\boauth\b[^\n]{0,80}\b(?:expired|revoked|invalid|refresh)/iu`：OAuth 单独出现不算（stderr 里常有「某个
/// MCP 服务器需要 OAuth 授权」这类与 claude 本身登录无关的提示），后面要跟着过期、吊销、无效或刷新。
fn oauth_trouble(text: &str) -> bool {
    let chars: Vec<char> = text.chars().map(|c| c.to_ascii_lowercase()).collect();
    let word = |at: usize, w: &str| {
        w.chars()
            .enumerate()
            .all(|(i, c)| chars.get(at + i) == Some(&c))
    };
    for start in 0..chars.len() {
        if !word(start, "oauth") {
            continue;
        }
        let end = start + 5;
        let before = start == 0 || !ascii_word(chars[start - 1]);
        let after = chars.get(end).is_none_or(|c| !ascii_word(*c));
        if !(before && after) {
            continue;
        }
        for k in 0..=80 {
            let at = end + k;
            if k > 0 && chars.get(at - 1) == Some(&'\n') {
                break;
            }
            if at > chars.len() {
                break;
            }
            let boundary = (at == 0 || !ascii_word(chars[at - 1]))
                && chars.get(at).is_some_and(|c| ascii_word(*c));
            if boundary
                && ["expired", "revoked", "invalid", "refresh"]
                    .iter()
                    .any(|w| word(at, w))
            {
                return true;
            }
        }
    }
    false
}

/// 鉴权失败的特征（大小写不敏感），只对已判定失败的会话使用。
pub fn is_auth_failure(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    [
        "failed to authenticate",
        "not logged in",
        "invalid api key",
        "please run /login",
        "authentication_error",
    ]
    .iter()
    .any(|p| lower.contains(p))
        || oauth_trouble(text)
}

fn number(v: Option<&Value>) -> Option<Number> {
    match v {
        Some(Value::Number(n)) if n.as_f64().is_some_and(f64::is_finite) => Some(n.clone()),
        _ => None,
    }
}

pub fn summarize(result: &Map<String, Value>) -> Summary {
    Summary {
        num_turns: number(result.get("num_turns")),
        duration_ms: number(result.get("duration_ms")),
        total_cost_usd: number(result.get("total_cost_usd")),
        result: truncate(
            result.get("result").and_then(Value::as_str).unwrap_or(""),
            RESULT_LIMIT,
        ),
    }
}

/// 2.x `judgeOutcome`。`subtype` 为 success 但 `is_error` 为真的情况真实存在（登录态过期时
/// `{"subtype":"success","is_error":true,"result":"Failed to authenticate…"}`），所以两个条件都要看。
/// 鉴权失败的 `error` 换成能照着做的中文，原文留在 `summary.result`。
pub fn judge(stdout_log: &Path, stderr_log: &Path, exit_code: Option<i64>) -> Outcome {
    let result = find_result_line(&read_tail(stdout_log, STDOUT_TAIL));
    let stderr_tail = read_tail(stderr_log, STDERR_TAIL);
    if let Some(result) = result {
        let summary = summarize(&result);
        if result.get("subtype").and_then(Value::as_str) == Some("success")
            && result.get("is_error") != Some(&Value::Bool(true))
        {
            return Outcome {
                succeeded: true,
                summary: Some(summary),
                error: None,
                auth_failure: false,
            };
        }
        let text = result.get("result").and_then(Value::as_str).unwrap_or("");
        if is_auth_failure(text) || is_auth_failure(&stderr_tail) {
            return Outcome {
                succeeded: false,
                summary: Some(summary),
                error: Some(CLAUDE_LOGIN_REQUIRED_MESSAGE.into()),
                auth_failure: true,
            };
        }
        let reason = if summary.result.is_empty() {
            result
                .get("subtype")
                .and_then(Value::as_str)
                .unwrap_or("未知错误")
                .to_owned()
        } else {
            summary.result.clone()
        };
        return Outcome {
            succeeded: false,
            summary: Some(summary),
            error: Some(truncate(&reason, ERROR_LIMIT)),
            auth_failure: false,
        };
    }
    let lines: Vec<&str> = stderr_tail
        .split('\n')
        .map(|l| js_trim(l.strip_suffix('\r').unwrap_or(l)))
        .filter(|l| !l.is_empty())
        .collect();
    let stderr = lines[lines.len().saturating_sub(3)..].join(" | ");
    if is_auth_failure(&stderr_tail) {
        return Outcome {
            succeeded: false,
            summary: Some(Summary {
                num_turns: None,
                duration_ms: None,
                total_cost_usd: None,
                result: truncate(&stderr, RESULT_LIMIT),
            }),
            error: Some(CLAUDE_LOGIN_REQUIRED_MESSAGE.into()),
            auth_failure: true,
        };
    }
    let exit = match exit_code {
        None => "进程已结束".to_owned(),
        Some(code) => format!("进程退出（exit code {code}）"),
    };
    let error = if stderr.is_empty() {
        format!("{exit}，日志里没有 result 行")
    } else {
        format!("{exit}：{stderr}")
    };
    Outcome {
        succeeded: false,
        summary: None,
        error: Some(truncate(&error, ERROR_LIMIT)),
        auth_failure: false,
    }
}

/// 确认不了 PID 归属时停止跟踪的说明：不接管、不结束，告诉用户怎么自己处理。
pub fn identity_lost_message(pid: Option<u32>, when: &str) -> String {
    let which = pid.map(|p| format!("（PID {p}）")).unwrap_or_default();
    format!(
        "{when}无法确认 Claude 进程身份{which}，已停止跟踪，没有结束该进程；如仍在运行可在任务管理器里手动结束"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Dir(PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// 用例目录在 CARGO_TARGET_DIR 下（不进 %TEMP%）。
    fn dir(name: &str) -> Dir {
        let base = std::env::var_os("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target"));
        let d = base.join("dispatch-unit").join(name);
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        Dir(d)
    }

    fn write(path: &Path, text: &str) {
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn success_needs_subtype_success_and_no_is_error() {
        let d = dir("judge");
        let (out, err) = (d.0.join("out.jsonl"), d.0.join("err.log"));
        let put = |v: Value| write(&out, &format!("{{\"type\":\"system\"}}\n截断的噪声\n{v}\n"));
        put(
            json!({ "type": "result", "subtype": "success", "is_error": false, "num_turns": 2, "result": "好" }),
        );
        let o = judge(&out, &err, Some(0));
        assert!(o.succeeded);
        assert_eq!(
            o.summary.unwrap().to_json(),
            json!({ "numTurns": 2, "durationMs": null, "totalCostUsd": null, "result": "好" })
        );
        put(
            json!({ "type": "result", "subtype": "success", "is_error": true, "result": "API Error: 529" }),
        );
        let o = judge(&out, &err, Some(1));
        assert!(!o.succeeded);
        assert_eq!(o.error.as_deref(), Some("API Error: 529"));
        put(json!({ "type": "result", "subtype": "error_max_turns", "is_error": true }));
        assert_eq!(
            judge(&out, &err, Some(1)).error.as_deref(),
            Some("error_max_turns")
        );
        write(&out, "{\"type\":\"assistant\"}\n");
        write(&err, "line1\r\nline2\n");
        let o = judge(&out, &err, Some(3));
        assert_eq!(
            o.error.as_deref(),
            Some("进程退出（exit code 3）：line1 | line2")
        );
        assert_eq!(o.summary, None);
        let o = judge(&d.0.join("none"), &d.0.join("none2"), None);
        assert_eq!(o.error.as_deref(), Some("进程已结束，日志里没有 result 行"));
    }

    #[test]
    fn auth_failures_become_actionable_chinese_and_keep_the_original() {
        let d = dir("auth");
        let (out, err) = (d.0.join("out.jsonl"), d.0.join("err.log"));
        let fail_with = |text: &str| {
            write(
                &out,
                &format!(
                    "{}\n",
                    json!({ "type": "result", "subtype": "success", "is_error": true, "num_turns": 1, "result": text })
                ),
            )
        };
        write(&err, "");
        for text in [
            "Failed to authenticate: OAuth session expired and could not be refreshed",
            "FAILED TO AUTHENTICATE",
            "OAuth token has expired. Please obtain a new token",
            "Not logged in · Please run /login",
            "Invalid API key · Fix external API key",
            r#"API Error: 401 {"type":"error","error":{"type":"authentication_error"}}"#,
        ] {
            fail_with(text);
            let o = judge(&out, &err, Some(1));
            assert!(o.auth_failure, "{text}");
            assert_eq!(o.error.as_deref(), Some(CLAUDE_LOGIN_REQUIRED_MESSAGE));
            assert_eq!(o.summary.unwrap().result, text);
        }
        write(&out, "{\"type\":\"system\"}\n");
        write(&err, "Invalid API key · Please run /login\n");
        let o = judge(&out, &err, Some(1));
        assert!(o.auth_failure);
        assert_eq!(
            o.summary.unwrap().result,
            "Invalid API key · Please run /login"
        );
        fail_with("Execution error");
        assert_eq!(
            judge(&out, &err, Some(1)).error.as_deref(),
            Some(CLAUDE_LOGIN_REQUIRED_MESSAGE)
        );
        // MCP 服务器要 OAuth 授权的提示不是 claude 本身没登录。
        write(&err, "MCP server \"figma\" requires OAuth authorization\n");
        fail_with("API Error: 529 overloaded_error");
        let o = judge(&out, &err, Some(1));
        assert!(!o.auth_failure);
        assert_eq!(o.error.as_deref(), Some("API Error: 529 overloaded_error"));
        // 成功的会话不看这些特征。
        write(
            &out,
            &format!(
                "{}\n",
                json!({ "type": "result", "subtype": "success", "is_error": false, "result": "修好了 Invalid API key 的提示" })
            ),
        );
        assert!(judge(&out, &err, Some(0)).succeeded);
    }

    #[test]
    fn the_oauth_pattern_needs_word_boundaries_and_a_trouble_word() {
        assert!(is_auth_failure("OAuth token expired"));
        assert!(is_auth_failure("oauth: refreshed failed"));
        assert!(is_auth_failure("OAuth  invalid"));
        assert!(!is_auth_failure("OAuthorization expired"));
        assert!(!is_auth_failure("myoauth expired"));
        assert!(!is_auth_failure("OAuth\nexpired"));
        assert!(!is_auth_failure("OAuth tokenexpired"));
        assert!(!is_auth_failure(&format!(
            "OAuth {} expired",
            "x".repeat(80)
        )));
        assert!(is_auth_failure(&format!(
            "OAuth {} expired",
            "x".repeat(78)
        )));
        assert!(!is_auth_failure("requires OAuth authorization"));
    }

    #[test]
    fn long_text_is_clipped_and_tails_are_bounded() {
        let d = dir("tail");
        let out = d.0.join("out.jsonl");
        let long = "长".repeat(600);
        write(
            &out,
            &format!(
                "{}\n{}\n",
                "x".repeat(2 * 1024 * 1024),
                json!({ "type": "result", "subtype": "error", "result": long })
            ),
        );
        let o = judge(&out, &d.0.join("err"), Some(1));
        let s = o.summary.unwrap();
        assert_eq!(s.result.chars().count(), 500);
        assert!(s.result.ends_with('…'));
        assert_eq!(o.error.unwrap().chars().count(), 300);
        assert!(log_has_result(&out));
        assert_eq!(
            identity_lost_message(Some(42), "宿主重启后"),
            "宿主重启后无法确认 Claude 进程身份（PID 42），已停止跟踪，没有结束该进程；如仍在运行可在任务管理器里手动结束"
        );
    }
}
