//! 一次界面请求的输入：路径参数、query、body。界面的字段是 camelCase（2.0 REST 的写法）。

use crate::{Reply, error_reply};
use atm_domain::error::ErrorCode;
use serde_json::{Map, Value};

/// `%XX` 解码；`plus` 时把 `+` 当空格（query 的写法）。编码不合格或不是 UTF-8 时 `None`。
pub(crate) fn percent_decode(raw: &str, plus: bool) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                let hex = bytes.get(i + 1..i + 3)?;
                let hex = std::str::from_utf8(hex).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 3;
            }
            b'+' if plus => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

pub(crate) struct Input {
    params: Vec<(&'static str, String)>,
    query: Vec<(String, String)>,
    pub(crate) body: Map<String, Value>,
}

fn invalid(message: &str) -> Reply {
    error_reply(
        400,
        ErrorCode::INVALID_ARGUMENT.as_str(),
        message,
        false,
        None,
    )
}

impl Input {
    pub(crate) fn parse(
        params: Vec<(&'static str, String)>,
        query: Option<&str>,
        body: Option<&[u8]>,
        method: &str,
    ) -> Result<Input, Reply> {
        let mut pairs = Vec::new();
        for part in query
            .unwrap_or_default()
            .split('&')
            .filter(|p| !p.is_empty())
        {
            let (k, v) = part.split_once('=').unwrap_or((part, ""));
            let (Some(k), Some(v)) = (percent_decode(k, true), percent_decode(v, true)) else {
                return Err(invalid("query 的编码不合格"));
            };
            pairs.push((k, v));
        }
        let body = match body {
            // GET / DELETE 不读 body（2.0 也不读）。
            _ if method == "GET" || method == "DELETE" => Map::new(),
            None => Map::new(),
            Some(b) if b.iter().all(u8::is_ascii_whitespace) => Map::new(),
            Some(b) => match serde_json::from_slice::<Value>(b) {
                Ok(Value::Object(m)) => m,
                Ok(_) => return Err(invalid("请求体必须是 JSON 对象")),
                Err(_) => return Err(invalid("请求体不是合法的 JSON")),
            },
        };
        Ok(Input {
            params,
            query: pairs,
            body,
        })
    }

    /// 路径参数（表里登记了的名字一定在）。
    pub(crate) fn param(&self, name: &str) -> &str {
        self.params
            .iter()
            .find(|(n, _)| *n == name)
            .map_or("", |(_, v)| v.as_str())
    }

    /// query 里的值（重复时取最后一个）；空字符串当作没给（2.0 客户端不发空值）。
    pub(crate) fn q(&self, name: &str) -> Option<&str> {
        self.query
            .iter()
            .rev()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
            .filter(|v| !v.is_empty())
    }

    pub(crate) fn q_usize(&self, name: &str) -> Result<Option<usize>, Reply> {
        match self.q(name) {
            None => Ok(None),
            Some(v) => v
                .parse::<usize>()
                .map(Some)
                .map_err(|_| invalid(&format!("{name} 必须是非负整数"))),
        }
    }

    pub(crate) fn q_i64(&self, name: &str) -> Result<Option<i64>, Reply> {
        match self.q(name) {
            None => Ok(None),
            Some(v) => v
                .parse::<i64>()
                .map(Some)
                .map_err(|_| invalid(&format!("{name} 必须是整数"))),
        }
    }

    /// `1` / `true` 是真，`0` / `false` 是假，没给是 `None`。
    pub(crate) fn q_bool(&self, name: &str) -> Result<Option<bool>, Reply> {
        match self.q(name) {
            None => Ok(None),
            Some("1" | "true") => Ok(Some(true)),
            Some("0" | "false") => Ok(Some(false)),
            Some(_) => Err(invalid(&format!("{name} 只能是 1、0、true、false"))),
        }
    }

    pub(crate) fn get(&self, name: &str) -> Option<&Value> {
        self.body.get(name).filter(|v| !v.is_null())
    }

    pub(crate) fn str(&self, name: &str) -> Option<String> {
        match self.get(name)? {
            Value::String(s) => Some(s.clone()),
            _ => None,
        }
    }

    pub(crate) fn i64(&self, name: &str) -> Option<i64> {
        self.get(name).and_then(Value::as_i64)
    }

    pub(crate) fn bool(&self, name: &str) -> Option<bool> {
        self.get(name).and_then(Value::as_bool)
    }

    pub(crate) fn strs(&self, name: &str) -> Option<Vec<String>> {
        match self.get(name)? {
            Value::Array(items) => Some(
                items
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect(),
            ),
            _ => None,
        }
    }

    /// 要求的字段（缺了或类型不对是 INVALID_ARGUMENT，与 2.0 的 zod 报错同一个码）。
    pub(crate) fn need_str(&self, name: &str) -> Result<String, Reply> {
        self.str(name)
            .ok_or_else(|| invalid(&format!("缺少字段 {name}（字符串）")))
    }

    pub(crate) fn need_i64(&self, name: &str) -> Result<i64, Reply> {
        self.i64(name)
            .ok_or_else(|| invalid(&format!("缺少字段 {name}（整数）")))
    }
}

#[cfg(test)]
mod tests {
    use super::percent_decode;

    #[test]
    fn decoding() {
        assert_eq!(percent_decode("a%2Fb", false).as_deref(), Some("a/b"));
        assert_eq!(percent_decode("a+b", true).as_deref(), Some("a b"));
        assert_eq!(percent_decode("a+b", false).as_deref(), Some("a+b"));
        assert_eq!(percent_decode("%E4%B8%AD", false).as_deref(), Some("中"));
        assert_eq!(percent_decode("%zz", false), None);
        assert_eq!(percent_decode("%4", false), None);
        assert_eq!(percent_decode("%FF", false), None);
    }
}
