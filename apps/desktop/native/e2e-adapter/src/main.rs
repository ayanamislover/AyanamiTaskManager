//! e2e 适配器（W5d，09 §2）：Playwright 用例里，浏览器中的界面经它进 ui-bridge。只在 `e2e` feature 下构建，不进安装包。
//!
//! ```text
//! atm-core-e2e --n <新根> --legacy <旧根> --port <端口> --origin <界面的 origin> --user-token <令牌>
//! ```
//!
//! - 服务与正式宿主同一个运行时库（[`atm_runtime::start`]）：Agent HTTP、daemon.json、调度器都是真的。
//!   用例里的 Agent 照真实 Agent 的做法从 `N\runtime\daemon.json` 读端点与令牌。
//! - 界面的请求经 `--port` 进来：只认 `Bearer <--user-token>`，主体是 User/E2eTest，交给 [`atm_ui_bridge::Ui::dispatch`]，
//!   与宿主的 WebView 是同一个分发（10 R8 的核对都在那里）。端口、origin、令牌都由调用方显式给出，不猜。
//! - 只监听 127.0.0.1；Host 必须是 `127.0.0.1:<端口>`；带 Origin 的请求只认 `--origin`（CORS 也只对它开）。
//!
//! 两个根都不能碰到真实的数据根、安装根（与开发运行时同一个守卫）。退出码：2 参数不对；3 另一个实例持有准入；
//! 5 启动失败；6 端口绑不上。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use atm_domain::principal::{Principal, UiSurface};
use atm_runtime::{BootError, Drill, Event, Options, Started};
use atm_store::conversion::Quiesce;
use atm_ui_bridge::{MAX_BODY_BYTES, Request as UiRequest, RuntimeStatus, Ui};
use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

fn usage(why: &str) -> ! {
    eprintln!("atm-core-e2e: {why}");
    std::process::exit(2);
}

struct Config {
    n: PathBuf,
    legacy: PathBuf,
    port: u16,
    origin: String,
    user_token: String,
}

fn config() -> Config {
    let mut args = std::env::args().skip(1);
    let (mut n, mut legacy, mut port, mut origin, mut token) = (None, None, None, None, None);
    while let Some(arg) = args.next() {
        let mut value = || {
            args.next()
                .unwrap_or_else(|| usage(&format!("{arg} needs a value")))
        };
        match arg.as_str() {
            "--n" => n = Some(PathBuf::from(value())),
            "--legacy" => legacy = Some(PathBuf::from(value())),
            "--port" => {
                port = Some(
                    value()
                        .parse::<u16>()
                        .ok()
                        .filter(|p| *p != 0)
                        .unwrap_or_else(|| usage("--port must be 1..=65535")),
                )
            }
            "--origin" => origin = Some(value()),
            "--user-token" => token = Some(value()),
            other => usage(&format!("unknown argument {other}")),
        }
    }
    let user_token = token.unwrap_or_else(|| usage("--user-token is required"));
    if user_token.is_empty() || !user_token.bytes().all(|b| b.is_ascii_graphic()) {
        usage("--user-token must be visible ASCII");
    }
    Config {
        n: n.unwrap_or_else(|| usage("--n is required")),
        legacy: legacy.unwrap_or_else(|| usage("--legacy is required")),
        port: port.unwrap_or_else(|| usage("--port is required")),
        origin: origin.unwrap_or_else(|| usage("--origin is required")),
        user_token,
    }
}

#[derive(Clone)]
struct Adapter {
    ui: Arc<Ui>,
    host: Arc<str>,
    origin: Arc<str>,
    bearer: Arc<str>,
}

fn main() {
    let c = config();
    let given: Vec<(&str, &std::path::Path)> = vec![("--n", &c.n), ("--legacy", &c.legacy)];
    if let Err(why) =
        atm_runtime::guard::refuse_overlaps(&given, &atm_runtime::guard::protected_roots())
            .and_then(|()| atm_runtime::guard::refuse_links(&given))
    {
        usage(&why);
    }
    let observe: Arc<dyn Fn(Event) + Send + Sync> = Arc::new(|e| eprintln!("atm-core-e2e: {e:?}"));
    let options = Options {
        n: c.n.clone(),
        legacy: c.legacy.clone(),
        version: "3.0.0-e2e".into(),
        handoff: None,
        // 旧根由用例控制（一般不存在）：没有存活的 lease 就算静止。
        quiesce: Box::new(|| Quiesce::Quiet),
        allow_real_data_root: false,
        real_data_root: None,
        secrets_check: Some(atm_runtime::secrets::check),
        sweep_every: Duration::from_secs(60),
        drill: Drill::default(),
        observe,
        notify: None,
        maintenance: false,
        metrics_capture: false,
        may_open: None,
    };
    let serving = match atm_runtime::start(&options) {
        Ok(Started::Serving(serving)) => serving,
        Ok(Started::Conflict(conflicted)) => {
            eprintln!("atm-core-e2e: SOURCE_CONFLICT: {}", conflicted.state.reason);
            std::process::exit(5);
        }
        Err(e) => {
            eprintln!("atm-core-e2e: {e}");
            std::process::exit(match e {
                BootError::AlreadyRunning => 3,
                _ => 5,
            });
        }
    };
    let Some((svc, handle)) = serving.service() else {
        eprintln!("atm-core-e2e: the service is not running");
        std::process::exit(5);
    };
    // 进度条（#61）的 since：本次服务启动的时间，与宿主一样取进程启动时刻。
    let started_at = atm_install_state::startup::iso_utc(atm_runtime::Me::current().started_at_ms);
    let runtime: RuntimeStatus = Arc::new(|| json!({ "version": "3.0.0-e2e" }));
    let adapter = Adapter {
        ui: Arc::new(Ui::new(svc, runtime, started_at)),
        host: format!("127.0.0.1:{}", c.port).into(),
        origin: c.origin.into(),
        bearer: format!("Bearer {}", c.user_token).into(),
    };
    let port = c.port;
    let served = handle.block_on(async move {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
        eprintln!(
            "atm-core-e2e: the UI API is on 127.0.0.1:{port}, the Agent HTTP on 127.0.0.1:{}",
            serving.port()
        );
        let app = Router::new().fallback(ui).with_state(adapter);
        // 一直服务到进程被结束（Playwright 的 webServer 结束它）；`serving` 持有准入与 Agent 入口。
        let result = axum::serve(listener, app).await;
        drop(serving);
        result
    });
    if let Err(e) = served {
        eprintln!("atm-core-e2e: 127.0.0.1:{port}: {e}");
        std::process::exit(6);
    }
}

/// 适配器自己拒绝时的 2.0 信封（与 ui-bridge 的同形）。
fn envelope(code: &str, message: &str) -> Value {
    json!({
        "error": { "code": code, "message": message, "retryable": false },
        "request_id": "e2e-adapter",
    })
}

fn answer(a: &Adapter, status: StatusCode, body: &Value, cors: bool) -> Response {
    let mut response = (status, body.to_string()).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    if cors && let Ok(origin) = HeaderValue::from_str(&a.origin) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    }
    response
}

fn refuse(a: &Adapter, status: StatusCode, code: &str, message: &str, cors: bool) -> Response {
    answer(a, status, &envelope(code, message), cors)
}

/// 带 Origin 的只认界面的 origin；不带 Origin 的（用例里的 Playwright request）照常。返回是否回 CORS 头。
fn origin_ok(a: &Adapter, headers: &HeaderMap) -> Result<bool, ()> {
    match headers.get(header::ORIGIN) {
        None => Ok(false),
        Some(o) if o.as_bytes() == a.origin.as_bytes() => Ok(true),
        Some(_) => Err(()),
    }
}

async fn ui(State(a): State<Adapter>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let host_ok = parts.headers.get(header::HOST).map(|h| h.as_bytes()) == Some(a.host.as_bytes());
    let Ok(cors) = origin_ok(&a, &parts.headers) else {
        return refuse(
            &a,
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
            "不接受这个 origin 的请求",
            false,
        );
    };
    if !host_ok {
        return refuse(
            &a,
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
            "Host 不是本服务的回环地址",
            cors,
        );
    }
    // CORS 预检：只对界面的 origin 开，只放行界面会带的两个头。
    if parts.method == Method::OPTIONS {
        if !cors {
            return refuse(
                &a,
                StatusCode::FORBIDDEN,
                "FORBIDDEN",
                "预检只对界面的 origin 开放",
                false,
            );
        }
        let mut response = answer(&a, StatusCode::NO_CONTENT, &Value::Null, true);
        *response.body_mut() = Body::empty();
        let h = response.headers_mut();
        h.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE"),
        );
        h.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("authorization, content-type"),
        );
        h.insert(
            header::ACCESS_CONTROL_MAX_AGE,
            HeaderValue::from_static("600"),
        );
        return response;
    }
    let presented = parts
        .headers
        .get(header::AUTHORIZATION)
        .map(|v| v.as_bytes());
    if presented != Some(a.bearer.as_bytes()) {
        return refuse(
            &a,
            StatusCode::UNAUTHORIZED,
            "UNAUTHORIZED",
            "界面令牌不对",
            cors,
        );
    }
    let Ok(bytes) = to_bytes(body, MAX_BODY_BYTES + 1).await else {
        return refuse(
            &a,
            StatusCode::PAYLOAD_TOO_LARGE,
            "INVALID_ARGUMENT",
            "请求体超过 2 MiB",
            cors,
        );
    };
    let method = parts.method.as_str().to_owned();
    let target = parts
        .uri
        .path_and_query()
        .map_or_else(|| parts.uri.path().to_owned(), |pq| pq.as_str().to_owned());
    let ui = a.ui.clone();
    let reply = tokio::task::spawn_blocking(move || {
        let principal = Principal::trusted_ui(UiSurface::E2eTest);
        ui.dispatch(
            &principal,
            UiRequest {
                method: &method,
                target: &target,
                body: (!bytes.is_empty()).then_some(&bytes[..]),
            },
        )
    })
    .await;
    match reply {
        Ok(r) => answer(
            &a,
            StatusCode::from_u16(r.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            &r.body,
            cors,
        ),
        Err(_) => refuse(
            &a,
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL_ERROR",
            "界面请求处理失败",
            cors,
        ),
    }
}
