//! 中继客户端（2.x `packages/sync-protocol/src/relay-client.ts`）：AyanamiCloud「应用数据」子集的 6 个接口，
//! atm-relay 与 AyanamiCloud 共用。见 docs/mobile-sync.md §3。
//!
//! **中继不可信。** 它本来就看得到请求里的 Authorization：只要回一个 `error.message = <收到的 token>` 的 500，
//! 把原文带进错误的实现就会让 token 进到连接器状态与日志（2.x peer R1-01）。所以 [`RelayError`] 的码只取
//! 白名单（而且要与 HTTP 状态配对），文字只用这里写死的中文；中继返回的码与文字原文不进任何会被打印、
//! 序列化或返回的字段。网络层报错的文字同理不取（证书错误会列出对方证书的名字）。

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use atm_sync_protocol::encoding::js_trim;
use atm_sync_protocol::keys::{is_app_id, is_doc_key};
use atm_sync_protocol::pairing::normalize_relay_url;
use serde_json::{Map, Value, json};

use crate::transport::{Cancel, HttpRequest, HttpResponse, NetFailure, Transport};

/// 错误码。前 13 个是中继会返回的（atm-relay 与 AyanamiCloud 实测一致的那些），各绑定唯一合法的 HTTP 状态；
/// 之后是客户端自己判定的（status 0）；对不上白名单的一律 [`RelayErrorCode::RelayError`]。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayErrorCode {
    BadRequest,
    InvalidArgument,
    Unauthorized,
    Forbidden,
    NotFound,
    MethodNotAllowed,
    RevisionConflict,
    CursorExpired,
    PayloadTooLarge,
    RateLimited,
    TooManyWaiters,
    Internal,
    InsufficientStorage,
    Network,
    KeyInvalid,
    AppIdInvalid,
    AppMismatch,
    EmptyResponse,
    RelayError,
    /// 会话或这一次调用被取消（2.x 里是原样抛出的 `AbortSignal.reason`）。不是中继的结论，调用方只管退出。
    Aborted,
}

const REMOTE: &[(RelayErrorCode, &str, u16, &str)] = &[
    (
        RelayErrorCode::BadRequest,
        "BAD_REQUEST",
        400,
        "中继读不懂这个请求",
    ),
    (
        RelayErrorCode::InvalidArgument,
        "INVALID_ARGUMENT",
        400,
        "中继认为请求参数不合法",
    ),
    (
        RelayErrorCode::Unauthorized,
        "UNAUTHORIZED",
        401,
        "中继不认这个 token（没带、填错或已吊销）",
    ),
    (
        RelayErrorCode::Forbidden,
        "FORBIDDEN",
        403,
        "这个 token 无权访问该应用",
    ),
    (
        RelayErrorCode::NotFound,
        "NOT_FOUND",
        404,
        "中继上没有请求的内容",
    ),
    (
        RelayErrorCode::MethodNotAllowed,
        "METHOD_NOT_ALLOWED",
        405,
        "中继不支持这个请求方法",
    ),
    (
        RelayErrorCode::RevisionConflict,
        "REVISION_CONFLICT",
        409,
        "文档已被其它设备修改",
    ),
    (
        RelayErrorCode::CursorExpired,
        "CURSOR_EXPIRED",
        410,
        "增量游标已过期，需要全量重新同步",
    ),
    (
        RelayErrorCode::PayloadTooLarge,
        "PAYLOAD_TOO_LARGE",
        413,
        "内容超过中继允许的大小",
    ),
    (
        RelayErrorCode::RateLimited,
        "RATE_LIMITED",
        429,
        "请求过于频繁，中继要求稍后再试",
    ),
    (
        RelayErrorCode::TooManyWaiters,
        "TOO_MANY_WAITERS",
        429,
        "中继上挂起的长轮询太多，稍后再试",
    ),
    (RelayErrorCode::Internal, "INTERNAL", 500, "中继内部出错"),
    (
        RelayErrorCode::InsufficientStorage,
        "INSUFFICIENT_STORAGE",
        507,
        "中继的存储空间已满",
    ),
];

const LOCAL: &[(RelayErrorCode, &str, &str)] = &[
    (RelayErrorCode::Network, "NETWORK", "连不上中继"),
    (RelayErrorCode::KeyInvalid, "KEY_INVALID", "文档键不合法"),
    (
        RelayErrorCode::AppIdInvalid,
        "APP_ID_INVALID",
        "应用 ID 只能是小写字母、数字、- 和 _",
    ),
    (
        RelayErrorCode::AppMismatch,
        "APP_MISMATCH",
        "中继返回的应用与配置不一致",
    ),
    (
        RelayErrorCode::EmptyResponse,
        "EMPTY_RESPONSE",
        "中继没有返回文档",
    ),
    (RelayErrorCode::Aborted, "ABORTED", "同步已停止"),
];

impl RelayErrorCode {
    pub fn as_str(self) -> &'static str {
        if self == RelayErrorCode::RelayError {
            return "RELAY_ERROR";
        }
        REMOTE
            .iter()
            .find(|r| r.0 == self)
            .map(|r| r.1)
            .or_else(|| LOCAL.iter().find(|l| l.0 == self).map(|l| l.1))
            .unwrap_or("RELAY_ERROR")
    }
}

/// 中继要求的等待（秒）的上限；连接器自己另有 60 s 上限。
const MAX_RETRY_AFTER_SECONDS: f64 = 600.0;

/// 409 时中继返回的当前版本里，协议只用得上这几个数字；字符串与 `data` 一概不留。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ConflictCurrent {
    pub revision: f64,
    pub schema_version: f64,
    pub size_bytes: f64,
}

/// 中继错误。`status` 为 0 表示本地判定。`message` 是本地写死的中文，不含中继返回的任何原文。
#[derive(Debug, Clone, PartialEq)]
pub struct RelayError {
    pub status: u16,
    pub code: RelayErrorCode,
    pub message: String,
    pub retry_after: Option<f64>,
    pub current: Option<ConflictCurrent>,
}

impl fmt::Display for RelayError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for RelayError {}

impl RelayError {
    /// HTTP 错误：`code` 不在白名单、或与 `status` 对不上时归为 `RELAY_ERROR`。文字一律用白名单里的。
    pub fn http(status: u16, code: &str) -> RelayError {
        let (code, message) = match REMOTE.iter().find(|r| r.1 == code) {
            Some(r) if r.2 == status => (r.0, r.3),
            _ if status >= 500 => (RelayErrorCode::RelayError, "中继暂时不可用"),
            _ => (RelayErrorCode::RelayError, "中继拒绝了这个请求"),
        };
        RelayError {
            status,
            code,
            message: message.to_owned(),
            retry_after: None,
            current: None,
        }
    }

    /// 本地判定的错误，用固定文字。
    pub fn local(code: RelayErrorCode) -> RelayError {
        let message = LOCAL
            .iter()
            .find(|l| l.0 == code)
            .map_or("中继请求失败", |l| l.2);
        RelayError::local_with(code, message.to_owned())
    }

    /// 本地判定的错误，文字由调用方给（只能是本地写死的文字）。
    fn local_with(code: RelayErrorCode, message: String) -> RelayError {
        RelayError {
            status: 0,
            code,
            message,
            retry_after: None,
            current: None,
        }
    }

    pub fn aborted() -> RelayError {
        RelayError::local(RelayErrorCode::Aborted)
    }

    pub fn is_aborted(&self) -> bool {
        self.code == RelayErrorCode::Aborted
    }

    /// token 无效、被撤销或无权访问该应用：重试没有意义。
    pub fn is_auth_failure(&self) -> bool {
        self.status == 401 || self.status == 403
    }
}

/// 只认非负的有限数，向上取整，最多 600。
fn retry_after_seconds(value: Option<f64>) -> Option<f64> {
    value
        .filter(|v| v.is_finite() && *v >= 0.0)
        .map(|v| v.ceil().min(MAX_RETRY_AFTER_SECONDS))
}

/// 系统错误码名：`^[A-Z][A-Z0-9_]{2,47}$`。
fn is_system_code(code: &str) -> bool {
    let b = code.as_bytes();
    (3..=48).contains(&b.len())
        && b[0].is_ascii_uppercase()
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == b'_')
}

fn network_error(failure: NetFailure) -> RelayError {
    match failure {
        NetFailure::Cancelled => RelayError::aborted(),
        NetFailure::Timeout => {
            RelayError::local_with(RelayErrorCode::Network, "连接中继超时".to_owned())
        }
        NetFailure::Failed { code } => {
            let detail = code
                .filter(|c| is_system_code(c))
                .map(|c| format!("（{c}）"))
                .unwrap_or_default();
            RelayError::local_with(RelayErrorCode::Network, format!("连不上中继{detail}"))
        }
    }
}

// ─── 中继返回的结构 ───

#[derive(Debug, Clone, PartialEq)]
pub struct DocumentMeta {
    pub key: String,
    pub revision: f64,
    pub schema_version: f64,
    pub updated_at: String,
    pub updated_by_device: Option<String>,
    pub size_bytes: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Document {
    pub meta: DocumentMeta,
    /// 缺了是 `None`（2.x 的 `undefined`），与 `null` 区分开。
    pub data: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeOp {
    Put,
    Delete,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    pub seq: f64,
    pub key: String,
    pub revision: f64,
    pub op: ChangeOp,
    pub device_id: Option<String>,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChangesPage {
    pub changes: Vec<Change>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Probe {
    pub app_id: String,
    /// 服务端支持 `changes?wait=` 长轮询（atm-relay 扩展）。
    pub long_poll: bool,
    pub max_wait: f64,
    pub server: String,
    pub version: Option<String>,
}

/// JS 的 `typeof x === "number" && Number.isFinite(x) ? x : fallback`。
fn num(value: Option<&Value>, fallback: f64) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .unwrap_or(fallback)
}

fn text(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_owned)
}

/// JS 的 `String(raw ?? "")`。
fn js_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => js_number_text(n.as_f64().unwrap_or(0.0)),
        Some(Value::Array(_)) | Some(Value::Object(_)) => "[object Object]".to_owned(),
    }
}

/// 数在 JSON 与查询串里按 JS 的写法（`String(n)`）。
use crate::snapshot::js_number_text;

fn js_number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 {
        Value::from(n as i64)
    } else {
        serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
    }
}

/// 非负安全整数，否则取 fallback。
fn count(value: Option<&Value>, fallback: f64) -> f64 {
    match value.and_then(Value::as_f64) {
        Some(n) if n.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&n) => n,
        _ => fallback,
    }
}

/// 中继自报的名字与版本只当标签：`^[A-Za-z0-9][A-Za-z0-9.+-]{0,31}$`，不合就丢掉。
fn label(value: Option<&Value>) -> Option<String> {
    let s = value?.as_str()?;
    let b = s.as_bytes();
    ((1..=32).contains(&b.len())
        && b[0].is_ascii_alphanumeric()
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_alphanumeric() || b".+-".contains(c)))
    .then(|| s.to_owned())
}

/// 2.x `parseObject`：空正文或不是 JSON 是 `None`；数组与对象都算「对象」（`typeof` 都是 object），
/// 数组上取不到任何字段，这里当作空对象。
fn parse_object(body: &[u8]) -> Option<Map<String, Value>> {
    if body.is_empty() {
        return None;
    }
    let text = String::from_utf8_lossy(body);
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(&text);
    match serde_json::from_str::<Value>(text).ok()? {
        Value::Object(m) => Some(m),
        Value::Array(_) => Some(Map::new()),
        _ => None,
    }
}

fn as_object(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn to_meta(raw: &Map<String, Value>) -> DocumentMeta {
    DocumentMeta {
        key: js_string(raw.get("key")),
        revision: num(raw.get("revision"), 0.0),
        schema_version: num(raw.get("schema_version"), 1.0),
        updated_at: text(raw.get("updated_at")).unwrap_or_default(),
        updated_by_device: text(raw.get("updated_by_device")),
        size_bytes: num(raw.get("size_bytes"), 0.0),
    }
}

fn to_document(raw: &Map<String, Value>) -> Document {
    Document {
        meta: to_meta(raw),
        data: raw.get("data").cloned(),
    }
}

fn to_change(raw: &Value) -> Change {
    let empty = Map::new();
    let raw = raw.as_object().unwrap_or(&empty);
    Change {
        seq: num(raw.get("seq"), 0.0),
        key: js_string(raw.get("key")),
        revision: num(raw.get("revision"), 0.0),
        op: if raw.get("op").and_then(Value::as_str) == Some("delete") {
            ChangeOp::Delete
        } else {
            ChangeOp::Put
        },
        device_id: text(raw.get("device_id")),
        at: text(raw.get("at")).unwrap_or_default(),
    }
}

/// 数组里的每一项；不是数组就是空。数组里不是对象的项照 2.x 当作空对象处理。
fn items(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// HTTP 错误响应 → RelayError。只读三样结构化数据：错误码（交给白名单）、等待秒数（只认数字）、
/// 409 的当前修订号等数字。
fn error_from_response(response: &HttpResponse, body: Option<&Map<String, Value>>) -> RelayError {
    let empty = Map::new();
    let detail = body
        .and_then(|b| b.get("error"))
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let code = detail
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("RELAY_ERROR");
    let mut error = RelayError::http(response.status, code);
    let header = js_trim(response.header("Retry-After").unwrap_or(""));
    let retry = match detail.get("retry_after") {
        Some(Value::Number(n)) => n.as_f64(),
        _ if (1..=6).contains(&header.len()) && header.bytes().all(|b| b.is_ascii_digit()) => {
            header.parse::<f64>().ok()
        }
        _ => None,
    };
    error.retry_after = retry_after_seconds(retry);
    if response.status == 409
        && let Some(current) = as_object(body.and_then(|b| b.get("current")))
    {
        error.current = Some(ConflictCurrent {
            revision: count(current.get("revision"), 0.0),
            schema_version: count(current.get("schema_version"), 1.0),
            size_bytes: count(current.get("size_bytes"), 0.0),
        });
    }
    error
}

/// `encodeURIComponent`。
pub fn encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn assert_key(key: &str) -> Result<(), RelayError> {
    // 键可能来自中继的变更流或列表，不把它拼进错误文字。
    if is_doc_key(key) {
        Ok(())
    } else {
        Err(RelayError::local(RelayErrorCode::KeyInvalid))
    }
}

const MAX_LIST_PAGES: usize = 100;
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(20);

/// 一个中继、一个应用、一枚 token。`Debug` 不打印 token。
#[derive(Clone)]
pub struct RelayClient {
    base_url: String,
    app_id: String,
    token: String,
    transport: Arc<dyn Transport>,
    timeout: Duration,
    lifetime: Option<Cancel>,
}

impl fmt::Debug for RelayClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RelayClient")
            .field("base_url", &self.base_url)
            .field("app_id", &self.app_id)
            .finish_non_exhaustive()
    }
}

pub struct RelayClientOptions {
    pub base_url: String,
    pub app_id: String,
    pub token: String,
    pub transport: Arc<dyn Transport>,
    /// 普通请求超时，默认 20 s。长轮询在 wait 之上再加 15 s。
    pub timeout: Option<Duration>,
    /// 会话的生命周期：取消后在途与之后的请求都立即失败。
    pub lifetime: Option<Cancel>,
}

struct Reply {
    body: Option<Map<String, Value>>,
}

impl RelayClient {
    /// 地址不合法时返回协议层的 `RELAY_URL_INVALID`，应用 ID 不合法时返回 `APP_ID_INVALID`。
    pub fn new(options: RelayClientOptions) -> Result<RelayClient, ClientError> {
        let base_url = normalize_relay_url(&options.base_url).map_err(ClientError::Url)?;
        if !is_app_id(&options.app_id) {
            return Err(ClientError::Relay(RelayError::local(
                RelayErrorCode::AppIdInvalid,
            )));
        }
        Ok(RelayClient {
            base_url,
            app_id: options.app_id,
            token: options.token,
            transport: options.transport,
            timeout: options.timeout.unwrap_or(DEFAULT_TIMEOUT),
            lifetime: options.lifetime,
        })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn app_id(&self) -> &str {
        &self.app_id
    }

    fn url(&self, path: &str, query: &[(&str, Option<String>)]) -> String {
        let url = format!(
            "{}/v1/apps/{}{path}",
            self.base_url,
            encode_component(&self.app_id)
        );
        let params: Vec<String> = query
            .iter()
            .filter_map(|(name, value)| {
                value
                    .as_deref()
                    .filter(|v| !v.is_empty())
                    .map(|v| format!("{}={}", encode_component(name), encode_component(v)))
            })
            .collect();
        if params.is_empty() {
            url
        } else {
            format!("{url}?{}", params.join("&"))
        }
    }

    fn request(
        &self,
        method: &'static str,
        url: String,
        body: Option<Value>,
        timeout: Option<Duration>,
        cancel: Option<&Cancel>,
    ) -> Result<Reply, RelayError> {
        let mut headers = vec![
            ("Authorization", format!("Bearer {}", self.token)),
            ("Accept", "application/json".to_owned()),
        ];
        let body = body.map(|b| {
            headers.push(("Content-Type", "application/json".to_owned()));
            serde_json::to_vec(&b).unwrap_or_default()
        });
        let request = HttpRequest {
            method,
            url,
            headers,
            body,
            timeout: timeout.unwrap_or(self.timeout),
        };
        let mut tokens: Vec<&Cancel> = Vec::with_capacity(2);
        if let Some(c) = cancel {
            tokens.push(c);
        }
        if let Some(c) = &self.lifetime {
            tokens.push(c);
        }
        let response = self
            .transport
            .send(&request, &tokens)
            .map_err(network_error)?;
        let parsed = parse_object(&response.body);
        if response.status >= 400 {
            return Err(error_from_response(&response, parsed.as_ref()));
        }
        Ok(Reply { body: parsed })
    }

    pub fn probe(&self) -> Result<Probe, RelayError> {
        let reply = self.request("GET", self.url("", &[]), None, None, None)?;
        let body = reply
            .body
            .filter(|b| b.get("id").and_then(Value::as_str) == Some(self.app_id.as_str()))
            .ok_or_else(|| RelayError::local(RelayErrorCode::AppMismatch))?;
        let relay = as_object(body.get("relay"));
        let field = |name: &str| relay.and_then(|r| r.get(name));
        Ok(Probe {
            app_id: self.app_id.clone(),
            long_poll: field("long_poll") == Some(&Value::Bool(true)),
            max_wait: num(field("max_wait"), 0.0).clamp(0.0, 25.0),
            server: label(field("name")).unwrap_or_else(|| "app-data".to_owned()),
            version: label(field("version")),
        })
    }

    pub fn get_document(
        &self,
        key: &str,
        cancel: Option<&Cancel>,
    ) -> Result<Option<Document>, RelayError> {
        assert_key(key)?;
        let url = self.url(&format!("/documents/{}", encode_component(key)), &[]);
        match self.request("GET", url, None, None, cancel) {
            Ok(reply) => Ok(reply.body.as_ref().map(to_document)),
            Err(e) if e.status == 404 => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// `expected_revision` 为 0 表示新建。修订号不符时是 409，`current` 带当前版本（若存在）。
    pub fn put_document(
        &self,
        key: &str,
        expected_revision: f64,
        data: &Value,
    ) -> Result<Document, RelayError> {
        assert_key(key)?;
        let url = self.url(&format!("/documents/{}", encode_component(key)), &[]);
        let body = json!({ "expected_revision": js_number(expected_revision), "data": data });
        let reply = self.request("PUT", url, Some(body), None, None)?;
        reply
            .body
            .as_ref()
            .map(to_document)
            .ok_or_else(|| RelayError::local(RelayErrorCode::EmptyResponse))
    }

    /// 已经不存在时返回 `false`。
    pub fn delete_document(&self, key: &str, expected_revision: f64) -> Result<bool, RelayError> {
        assert_key(key)?;
        let url = self.url(
            &format!("/documents/{}", encode_component(key)),
            &[("expected_revision", Some(js_number_text(expected_revision)))],
        );
        match self.request("DELETE", url, None, None, None) {
            Ok(_) => Ok(true),
            Err(e) if e.status == 404 => Ok(false),
            Err(e) => Err(e),
        }
    }

    pub fn list_documents(&self, prefix: &str) -> Result<Vec<DocumentMeta>, RelayError> {
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MAX_LIST_PAGES {
            let url = self.url(
                "/documents",
                &[
                    ("prefix", Some(prefix.to_owned())),
                    ("cursor", cursor.clone()),
                    ("limit", Some("500".to_owned())),
                ],
            );
            let reply = self.request("GET", url, None, None, None)?;
            let body = reply.body.unwrap_or_default();
            let documents = items(body.get("documents"));
            let empty = Map::new();
            out.extend(
                documents
                    .iter()
                    .map(|d| to_meta(d.as_object().unwrap_or(&empty))),
            );
            cursor = text(body.get("next_cursor"));
            if cursor.as_deref().is_none_or(str::is_empty) || documents.is_empty() {
                return Ok(out);
            }
        }
        Ok(out)
    }

    /// 变更流的一页。`wait > 0` 时长轮询（最多 25 s，请求超时在它之上再加 15 s）。
    pub fn changes(
        &self,
        cursor: Option<&str>,
        limit: Option<u32>,
        wait: f64,
        cancel: Option<&Cancel>,
    ) -> Result<ChangesPage, RelayError> {
        let wait = if wait > 0.0 {
            wait.floor().min(25.0)
        } else {
            0.0
        };
        let timeout = if wait > 0.0 {
            Duration::from_secs_f64(wait + 15.0)
        } else {
            self.timeout
        };
        let url = self.url(
            "/changes",
            &[
                ("cursor", cursor.map(str::to_owned)),
                ("limit", Some(limit.unwrap_or(500).to_string())),
                ("wait", (wait > 0.0).then(|| js_number_text(wait))),
            ],
        );
        let reply = self.request("GET", url, None, Some(timeout), cancel)?;
        let body = reply.body.unwrap_or_default();
        Ok(ChangesPage {
            changes: items(body.get("changes")).iter().map(to_change).collect(),
            // 没有新变更时 AyanamiCloud 原样返回游标；从头拉且为空时返回 null。
            next_cursor: text(body.get("next_cursor")).or_else(|| cursor.map(str::to_owned)),
            has_more: body.get("has_more") == Some(&Value::Bool(true)),
        })
    }
}

/// 构造客户端时的错误：地址不合法是协议层的错误，应用 ID 不合法是中继客户端的。
#[derive(Debug, Clone, PartialEq)]
pub enum ClientError {
    Url(atm_sync_protocol::SyncError),
    Relay(RelayError),
}

impl fmt::Display for ClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ClientError::Url(e) => f.write_str(&e.message()),
            ClientError::Relay(e) => f.write_str(&e.message),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_bound_to_one_status() {
        assert_eq!(
            RelayError::http(409, "REVISION_CONFLICT").code,
            RelayErrorCode::RevisionConflict
        );
        let wrong = RelayError::http(500, "REVISION_CONFLICT");
        assert_eq!(
            (wrong.code, wrong.message.as_str()),
            (RelayErrorCode::RelayError, "中继暂时不可用")
        );
        for code in [
            "constructor",
            "__proto__",
            "NETWORK",
            "ABORTED",
            "RELAY_ERROR",
        ] {
            let e = RelayError::http(400, code);
            assert_eq!(
                (e.code, e.message.as_str()),
                (RelayErrorCode::RelayError, "中继拒绝了这个请求")
            );
        }
        for (code, name, status, _) in REMOTE {
            assert_eq!(RelayError::http(*status, name).code, *code);
            assert_eq!(code.as_str(), *name);
        }
    }

    #[test]
    fn retry_after_is_clamped_and_rounded_up() {
        assert_eq!(retry_after_seconds(Some(2.1)), Some(3.0));
        assert_eq!(retry_after_seconds(Some(1e9)), Some(600.0));
        assert_eq!(retry_after_seconds(Some(-1.0)), None);
        assert_eq!(retry_after_seconds(None), None);
    }

    #[test]
    fn components_are_encoded_like_encode_uri_component() {
        assert_eq!(
            encode_component("atm1/a.b_c-d~e*f'(g)!"),
            "atm1%2Fa.b_c-d~e*f'(g)!"
        );
        assert_eq!(encode_component("空 &="), "%E7%A9%BA%20%26%3D");
    }

    #[test]
    fn numbers_render_like_javascript() {
        assert_eq!(js_number_text(3.0), "3");
        assert_eq!(js_number_text(1.5), "1.5");
        assert_eq!(js_number(7.0), json!(7));
        assert_eq!(js_string(Some(&json!(12))), "12");
        assert_eq!(js_string(Some(&json!(true))), "true");
        assert_eq!(js_string(None), "");
    }
}
