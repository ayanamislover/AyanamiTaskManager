//! 正式构建的 [`Transport`]：系统的 WinHTTP（同步模式），代理按系统设置自动发现。
//!
//! - 每个请求在自己的线程上跑、只用自己建的句柄；取消时调用方立即返回，留下的线程由超时收尾
//!   （[`run_cancellable`]）。这样不需要从别的线程关句柄，也就没有句柄被复用的竞态。
//! - 不跟随重定向、不存 Cookie、不做自动身份验证：Authorization 是我们自己加的头，跟着重定向发到别的主机
//!   就是把 token 交出去（2.x 用 fetch，跨源重定向时 fetch 会去掉它；这里直接不跟随，3xx 当作普通响应）。
//! - 正文最多读 [`MAX_BODY`]，超过算失败（中继的单个文档远小于它）。

use std::time::Duration;

use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::Networking::WinHttp::*;

use crate::transport::{Cancel, HttpRequest, HttpResponse, NetFailure, Transport, run_cancellable};

/// 一次响应正文的上限。
pub const MAX_BODY: usize = 32 * 1024 * 1024;

pub struct WinHttp {
    user_agent: String,
}

impl WinHttp {
    pub fn new(user_agent: impl Into<String>) -> WinHttp {
        WinHttp {
            user_agent: user_agent.into(),
        }
    }
}

impl Transport for WinHttp {
    fn send(&self, request: &HttpRequest, cancel: &[&Cancel]) -> Result<HttpResponse, NetFailure> {
        let request = request.clone();
        let agent = self.user_agent.clone();
        // 每一步都有 WinHTTP 自己的超时；整体再给调用方一个上限，免得卡在某一步迟迟不返回。
        let deadline = request.timeout + Duration::from_secs(5);
        run_cancellable(cancel, Some(deadline), move || round_trip(&agent, &request))
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 关掉的顺序与打开相反（request → connect → session），由 drop 顺序保证。
struct Handle(*mut core::ffi::c_void);

impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: 句柄由本线程打开、只关这一次。
            unsafe { WinHttpCloseHandle(self.0) };
        }
    }
}

fn last_failure() -> NetFailure {
    // SAFETY: 只读本线程的错误码。
    let code = unsafe { GetLastError() };
    failure_of(code)
}

fn failure_of(code: u32) -> NetFailure {
    let name = match code {
        ERROR_WINHTTP_TIMEOUT => return NetFailure::Timeout,
        12001 => "OUT_OF_HANDLES",
        12004 => "INTERNAL_ERROR",
        12005 => "INVALID_URL",
        12006 => "UNRECOGNIZED_SCHEME",
        12007 => "NAME_NOT_RESOLVED",
        12017 => "OPERATION_CANCELLED",
        ERROR_WINHTTP_CANNOT_CONNECT => "CANNOT_CONNECT",
        12030 => "CONNECTION_ERROR",
        12037 => "SECURE_CERT_DATE_INVALID",
        12038 => "SECURE_CERT_CN_INVALID",
        12044 => "CLIENT_AUTH_CERT_NEEDED",
        12045 => "SECURE_INVALID_CA",
        12057 => "SECURE_CERT_REV_FAILED",
        12152 => "INVALID_SERVER_RESPONSE",
        12157 => "SECURE_CHANNEL_ERROR",
        12166 => "BAD_AUTO_PROXY_SCRIPT",
        12167 => "UNABLE_TO_DOWNLOAD_SCRIPT",
        12169 => "SECURE_INVALID_CERT",
        12170 => "SECURE_CERT_REVOKED",
        12175 => "SECURE_FAILURE",
        12178 => "AUTO_PROXY_SERVICE_ERROR",
        12180 => "AUTODETECTION_FAILED",
        other => {
            return NetFailure::Failed {
                code: Some(format!("WIN32_{other}")),
            };
        }
    };
    NetFailure::Failed {
        code: Some(format!("ERROR_WINHTTP_{name}")),
    }
}

fn failed() -> NetFailure {
    NetFailure::Failed { code: None }
}

fn millis(d: Duration) -> i32 {
    i32::try_from(d.as_millis()).unwrap_or(i32::MAX).max(1)
}

fn round_trip(agent: &str, request: &HttpRequest) -> Result<HttpResponse, NetFailure> {
    let url = url::Url::parse(&request.url).map_err(|_| failed())?;
    let secure = match url.scheme() {
        "https" => true,
        "http" => false,
        _ => return Err(failed()),
    };
    let host = url.host_str().ok_or_else(failed)?;
    // `[::1]` 在 URL 里带方括号，WinHttpConnect 要的是不带的。
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let port = url.port_or_known_default().ok_or_else(failed)?;
    let object = &url[url::Position::BeforePath..url::Position::AfterQuery];
    let mut head = String::new();
    for (name, value) in &request.headers {
        if value.contains(['\r', '\n']) || name.contains(['\r', '\n', ':']) {
            return Err(failed());
        }
        head.push_str(&format!("{name}: {value}\r\n"));
    }

    let agent = wide(agent);
    // SAFETY: 参数都是以 0 结尾的 UTF-16 或空指针。
    let mut session = Handle(unsafe {
        WinHttpOpen(
            agent.as_ptr(),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            std::ptr::null(),
            std::ptr::null(),
            0,
        )
    });
    if session.0.is_null() {
        // 早于 Windows 8.1 没有自动代理；退回系统默认的代理设置。
        // SAFETY: 同上。
        session = Handle(unsafe {
            WinHttpOpen(
                agent.as_ptr(),
                WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                std::ptr::null(),
                std::ptr::null(),
                0,
            )
        });
    }
    if session.0.is_null() {
        return Err(last_failure());
    }
    let t = millis(request.timeout);
    // SAFETY: session 是有效句柄。
    if unsafe { WinHttpSetTimeouts(session.0, t, t, t, t) } == 0 {
        return Err(last_failure());
    }
    let host_w = wide(host);
    // SAFETY: session 有效，主机名以 0 结尾。
    let connect = Handle(unsafe { WinHttpConnect(session.0, host_w.as_ptr(), port, 0) });
    if connect.0.is_null() {
        return Err(last_failure());
    }
    let verb = wide(request.method);
    let object_w = wide(object);
    let mut flags = WINHTTP_FLAG_ESCAPE_DISABLE | WINHTTP_FLAG_ESCAPE_DISABLE_QUERY;
    if secure {
        flags |= WINHTTP_FLAG_SECURE;
    }
    // SAFETY: connect 有效；版本、引用页、接受类型用默认（空指针）。
    let req = Handle(unsafe {
        WinHttpOpenRequest(
            connect.0,
            verb.as_ptr(),
            object_w.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            flags,
        )
    });
    if req.0.is_null() {
        return Err(last_failure());
    }
    let disable: u32 =
        WINHTTP_DISABLE_COOKIES | WINHTTP_DISABLE_REDIRECTS | WINHTTP_DISABLE_AUTHENTICATION;
    // SAFETY: req 有效，缓冲区是一个 u32。
    if unsafe {
        WinHttpSetOption(
            req.0,
            WINHTTP_OPTION_DISABLE_FEATURE,
            (&disable as *const u32).cast(),
            4,
        )
    } == 0
    {
        return Err(last_failure());
    }
    let head_w: Vec<u16> = head.encode_utf16().collect();
    let body = request.body.as_deref().unwrap_or(&[]);
    let body_len = u32::try_from(body.len()).map_err(|_| failed())?;
    let head_len = u32::try_from(head_w.len()).map_err(|_| failed())?;
    // SAFETY: 头与正文的长度与缓冲区一致，调用期间缓冲区一直有效。
    let sent = unsafe {
        WinHttpSendRequest(
            req.0,
            if head_w.is_empty() {
                std::ptr::null()
            } else {
                head_w.as_ptr()
            },
            head_len,
            if body.is_empty() {
                std::ptr::null()
            } else {
                body.as_ptr().cast()
            },
            body_len,
            body_len,
            0,
        )
    };
    if sent == 0 {
        return Err(last_failure());
    }
    // SAFETY: req 有效。
    if unsafe { WinHttpReceiveResponse(req.0, std::ptr::null_mut()) } == 0 {
        return Err(last_failure());
    }
    let mut status: u32 = 0;
    let mut size: u32 = 4;
    // SAFETY: 缓冲区是一个 u32，长度如实给出。
    if unsafe {
        WinHttpQueryHeaders(
            req.0,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            std::ptr::null(),
            (&mut status as *mut u32).cast(),
            &mut size,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(last_failure());
    }
    let mut headers = Vec::new();
    if let Some(v) = query_text(&req, WINHTTP_QUERY_RETRY_AFTER) {
        headers.push(("Retry-After".to_owned(), v));
    }
    let mut out = Vec::new();
    loop {
        let mut available: u32 = 0;
        // SAFETY: req 有效。
        if unsafe { WinHttpQueryDataAvailable(req.0, &mut available) } == 0 {
            return Err(last_failure());
        }
        if available == 0 {
            break;
        }
        if out.len() + available as usize > MAX_BODY {
            return Err(NetFailure::Failed {
                code: Some("RESPONSE_TOO_LARGE".to_owned()),
            });
        }
        let start = out.len();
        out.resize(start + available as usize, 0);
        let mut read: u32 = 0;
        // SAFETY: 目标区间是刚扩出来的 `available` 字节。
        if unsafe {
            WinHttpReadData(
                req.0,
                out[start..].as_mut_ptr().cast(),
                available,
                &mut read,
            )
        } == 0
        {
            return Err(last_failure());
        }
        out.truncate(start + read as usize);
        if read == 0 {
            break;
        }
    }
    Ok(HttpResponse {
        status: u16::try_from(status).map_err(|_| failed())?,
        headers,
        body: out,
    })
}

/// 一个响应头的文本；没有就是 `None`。
fn query_text(req: &Handle, level: u32) -> Option<String> {
    let mut size: u32 = 0;
    // SAFETY: 第一次只问长度（缓冲区为空）。
    unsafe {
        WinHttpQueryHeaders(
            req.0,
            level,
            std::ptr::null(),
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
        )
    };
    if size == 0 || size > 64 * 1024 {
        return None;
    }
    let mut buf = vec![0u16; (size as usize).div_ceil(2)];
    // SAFETY: 缓冲区大小就是上一步给出的字节数。
    let ok = unsafe {
        WinHttpQueryHeaders(
            req.0,
            level,
            std::ptr::null(),
            buf.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return None;
    }
    buf.truncate(size as usize / 2);
    Some(String::from_utf16_lossy(&buf))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failures_carry_only_a_code_name() {
        assert_eq!(failure_of(ERROR_WINHTTP_TIMEOUT), NetFailure::Timeout);
        assert_eq!(
            failure_of(12029),
            NetFailure::Failed {
                code: Some("ERROR_WINHTTP_CANNOT_CONNECT".into())
            }
        );
        assert_eq!(
            failure_of(5),
            NetFailure::Failed {
                code: Some("WIN32_5".into())
            }
        );
    }

    #[test]
    fn header_injection_is_refused_before_any_connection() {
        let request = HttpRequest {
            method: "GET",
            url: "http://127.0.0.1:9/v1/apps/atm".into(),
            headers: vec![("Authorization", "Bearer a\r\nX-Evil: 1".into())],
            body: None,
            timeout: Duration::from_secs(1),
        };
        assert_eq!(
            round_trip("t", &request).unwrap_err(),
            NetFailure::Failed { code: None }
        );
    }
}
