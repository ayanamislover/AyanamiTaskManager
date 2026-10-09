//! `runtimeRequest`（W5e，03 §2.1、10 R8）：WebView 发来的界面请求在进程内交给 [`atm_ui_bridge::Ui::dispatch`]，
//! 不再经 HTTP 转给 Node core。入参与应答的形状与 2.0 宿主（`runtime-request.ts`）一致，渲染端不改。
//!
//! 这里只做 JSON 层面的字段检查（类型、长度）。目标、方法、大小、路由的核对都在 ui-bridge 里，
//! 与 e2e 适配器走的是同一份（R8）。请求头只认 `accept` 与 `content-type`，而且都不影响分发：
//! 界面 API 只说 JSON。

use atm_ui_bridge::Reply;
use serde_json::{Value, json};

/// 目标（路径加 query）的上限，与 2.0 宿主一致；ui-bridge 再核对一次。
const MAX_PATH_BYTES: usize = 4096;
/// body 的上限放到 ui-bridge 判（413 由它回）；这里只挡明显越界的消息（桥的单帧上限已经更早挡过）。
const MAX_BODY_BYTES: usize = atm_ui_bridge::MAX_BODY_BYTES + 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UiCall {
    pub method: String,
    pub target: String,
    pub body: Option<Vec<u8>>,
}

/// 渲染端的 `{path, method?, headers?, body?}`。不合格回 2.0 宿主同名的错误码。
pub fn parse(value: &Value) -> Result<UiCall, &'static str> {
    let Some(record) = value.as_object() else {
        return Err("ATM_RENDERER_REQUEST_REJECTED");
    };
    let path = record
        .get("path")
        .and_then(Value::as_str)
        .filter(|p| p.len() <= MAX_PATH_BYTES)
        .ok_or("ATM_RENDERER_PATH_REJECTED")?;
    let method = match record.get("method") {
        None => "GET".to_owned(),
        Some(Value::String(m)) => m.to_ascii_uppercase(),
        Some(_) => return Err("ATM_RENDERER_METHOD_REJECTED"),
    };
    let body = match record.get("body") {
        None => None,
        Some(Value::String(b)) if b.len() <= MAX_BODY_BYTES => Some(b.as_bytes().to_vec()),
        Some(Value::String(_)) => return Err("ATM_RENDERER_BODY_TOO_LARGE"),
        Some(_) => return Err("ATM_RENDERER_BODY_REJECTED"),
    };
    match record.get("headers") {
        None => {}
        Some(Value::Object(headers)) => {
            for (name, header) in headers {
                let name = name.to_ascii_lowercase();
                if (name == "accept" || name == "content-type")
                    && !header.as_str().is_some_and(|h| h.len() <= 256)
                {
                    return Err("ATM_RENDERER_HEADERS_REJECTED");
                }
            }
        }
        Some(_) => return Err("ATM_RENDERER_HEADERS_REJECTED"),
    }
    Ok(UiCall {
        method,
        target: path.to_owned(),
        body,
    })
}

/// 2.0 的 `RuntimeRequestOutput`：`{status, statusText, headers, body}`，body 是 JSON 文本。
pub fn response(reply: &Reply) -> Value {
    json!({
        "status": reply.status,
        "statusText": status_text(reply.status),
        "headers": { "content-type": "application/json; charset=utf-8" },
        "body": reply.body.to_string(),
    })
}

/// 烟测专用（只在 smoke 构建里）：`/__smoke/hold?ms=<n>&marker=<s>` 不进 ui-bridge，在工作线程上停 n 毫秒，
/// 然后回 `{"held": <s>}`。导航竞态与在途上限的烟测靠它让一条请求确定地晚回来（3.0 没有可以挂起的 core 进程）。
#[cfg(feature = "smoke")]
pub fn smoke_hold(target: &str) -> Option<(std::time::Duration, String)> {
    let query = target.strip_prefix("/__smoke/hold?")?;
    let (mut ms, mut marker) = (None, None);
    for pair in query.split('&') {
        match pair.split_once('=') {
            Some(("ms", v)) => ms = v.parse::<u64>().ok().filter(|ms| *ms <= 30_000),
            Some(("marker", v)) if v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') => {
                marker = Some(v.to_owned())
            }
            _ => return None,
        }
    }
    Some((std::time::Duration::from_millis(ms?), marker?))
}

fn status_text(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        422 => "Unprocessable Entity",
        423 => "Locked",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renderer_requests_are_parsed_like_the_2_0_host() {
        assert_eq!(
            parse(&json!({ "path": "/api/v1/overview" })),
            Ok(UiCall {
                method: "GET".into(),
                target: "/api/v1/overview".into(),
                body: None
            })
        );
        let call = parse(&json!({
            "path": "/api/v1/projects", "method": "post", "body": "{\"name\":\"x\"}",
            "headers": { "Content-Type": "application/json", "authorization": "ignored" }
        }))
        .unwrap();
        assert_eq!(
            (call.method.as_str(), call.body.as_deref()),
            ("POST", Some(&b"{\"name\":\"x\"}"[..]))
        );
        for (bad, code) in [
            (json!([]), "ATM_RENDERER_REQUEST_REJECTED"),
            (json!({}), "ATM_RENDERER_PATH_REJECTED"),
            (json!({ "path": 1 }), "ATM_RENDERER_PATH_REJECTED"),
            (
                json!({ "path": format!("/api/v1/{}", "x".repeat(MAX_PATH_BYTES)) }),
                "ATM_RENDERER_PATH_REJECTED",
            ),
            (
                json!({ "path": "/api/v1/x", "method": 1 }),
                "ATM_RENDERER_METHOD_REJECTED",
            ),
            (
                json!({ "path": "/api/v1/x", "body": {} }),
                "ATM_RENDERER_BODY_REJECTED",
            ),
            (
                json!({ "path": "/api/v1/x", "body": "x".repeat(MAX_BODY_BYTES + 1) }),
                "ATM_RENDERER_BODY_TOO_LARGE",
            ),
            (
                json!({ "path": "/api/v1/x", "headers": [] }),
                "ATM_RENDERER_HEADERS_REJECTED",
            ),
            (
                json!({ "path": "/api/v1/x", "headers": { "accept": 1 } }),
                "ATM_RENDERER_HEADERS_REJECTED",
            ),
        ] {
            assert_eq!(parse(&bad), Err(code), "{bad}");
        }
    }

    #[test]
    fn replies_keep_the_2_0_output_shape() {
        let out = response(&Reply {
            status: 404,
            body: json!({ "error": { "code": "NOT_FOUND" } }),
        });
        assert_eq!(out["status"], 404);
        assert_eq!(out["statusText"], "Not Found");
        assert_eq!(
            out["headers"]["content-type"],
            "application/json; charset=utf-8"
        );
        let body: Value = serde_json::from_str(out["body"].as_str().unwrap()).unwrap();
        assert_eq!(body["error"]["code"], "NOT_FOUND");
    }
}
