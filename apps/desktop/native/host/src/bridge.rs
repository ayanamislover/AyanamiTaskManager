//! Renderer bridge (§5): `window.ayanamiDesktop` with the same methods the Electron
//! preload exposed, carried over WebView2 web messages. The host accepts messages only
//! from the entry document, only for listed methods, with typed arguments.

use serde_json::{Value, json};

use crate::assets::ipc_source_trusted;

/// Largest renderer → host message (the runtimeRequest body itself is capped at 2 MiB
/// by the core; this leaves room for JSON escaping).
pub const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Local {
    NotifyRendererReady,
    GetAutoLaunch,
    SetAutoLaunch,
    CopyText,
    MinimizeWindow,
    ToggleMaximizeWindow,
    IsWindowMaximized,
    CloseWindow,
    /// 窗口外框归谁画："native"（系统的缩放边）或 "client"（Windows 10：界面贴边的把手发起缩放，frame.rs）。
    GetWindowFrame,
    /// 界面贴边的把手按下：交给系统的缩放循环。参数是固定的几个边名（frame::resize_direction）。
    StartWindowResize,
    /// 服务处在哪一步，数据源冲突时带上原因（07 §7）。服务没开也答得了。
    GetDataSource,
    /// 用户对数据源冲突的选择（`KEEP_V3` / `RECONVERT`）。只有这个可信的 WebView 能发（B2）。
    ChooseDataSource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Method {
    Local(Local),
    /// Forwarded to the core under this protocol name (host-protocol.ts CORE_METHODS).
    Core(&'static str),
}

fn method(name: &str) -> Option<Method> {
    Some(match name {
        "notifyRendererReady" => Method::Local(Local::NotifyRendererReady),
        "getAutoLaunch" => Method::Local(Local::GetAutoLaunch),
        "setAutoLaunch" => Method::Local(Local::SetAutoLaunch),
        "copyText" => Method::Local(Local::CopyText),
        "minimizeWindow" => Method::Local(Local::MinimizeWindow),
        "toggleMaximizeWindow" => Method::Local(Local::ToggleMaximizeWindow),
        "isWindowMaximized" => Method::Local(Local::IsWindowMaximized),
        "closeWindow" => Method::Local(Local::CloseWindow),
        "getWindowFrame" => Method::Local(Local::GetWindowFrame),
        "startWindowResize" => Method::Local(Local::StartWindowResize),
        "getDataSource" => Method::Local(Local::GetDataSource),
        "chooseDataSource" => Method::Local(Local::ChooseDataSource),
        "runtimeRequest" => Method::Core("runtimeRequest"),
        "getUpdateStatus" => Method::Core("getUpdateStatus"),
        "checkForUpdates" => Method::Core("checkForUpdates"),
        "applyUpdate" => Method::Core("applyUpdate"),
        "getMcpConfigs" => Method::Core("getMcpConfigs"),
        "getMcpBridges" => Method::Core("getMcpBridges"),
        "getMemoryProfile" => Method::Core("getMemoryProfile"),
        "setMemoryProfile" => Method::Core("setMemoryProfile"),
        "installMcp" => Method::Core("installMcp"),
        "getAgentIntegrations" => Method::Core("getAgentIntegrations"),
        "manageAgentIntegration" => Method::Core("manageAgentIntegration"),
        _ => return None,
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct Call {
    pub id: u64,
    pub method: Method,
    pub args: Vec<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rejected {
    Source,
    TooLarge,
    Malformed,
    UnknownMethod,
    Arguments,
}

fn arity(method: &Method) -> usize {
    match method {
        Method::Local(
            Local::SetAutoLaunch
            | Local::CopyText
            | Local::ChooseDataSource
            | Local::StartWindowResize,
        ) => 1,
        Method::Core("runtimeRequest" | "setMemoryProfile" | "installMcp") => 1,
        Method::Core("manageAgentIntegration") => 2,
        _ => 0,
    }
}

/// Local arguments are checked here; core arguments are checked again by the core.
fn arguments_valid(method: &Method, args: &[Value]) -> bool {
    if args.len() != arity(method) {
        return false;
    }
    match method {
        Method::Local(Local::SetAutoLaunch) => args[0].is_boolean(),
        Method::Local(Local::CopyText) => {
            args[0].as_str().is_some_and(|text| text.len() <= 1 << 20)
        }
        Method::Local(Local::ChooseDataSource) => {
            matches!(args[0].as_str(), Some("KEEP_V3" | "RECONVERT"))
        }
        Method::Local(Local::StartWindowResize) => args[0]
            .as_str()
            .is_some_and(|edge| crate::frame::resize_direction(edge).is_some()),
        Method::Core("runtimeRequest") => args[0].is_object(),
        Method::Core("setMemoryProfile") => args[0].is_boolean(),
        Method::Core("installMcp") => args[0].is_string(),
        Method::Core("manageAgentIntegration") => args[0].is_string() && args[1].is_string(),
        _ => true,
    }
}

pub fn parse(source: &str, body: &str) -> Result<Call, Rejected> {
    if !ipc_source_trusted(source) {
        return Err(Rejected::Source);
    }
    if body.len() > MAX_MESSAGE_BYTES {
        return Err(Rejected::TooLarge);
    }
    let value: Value = serde_json::from_str(body).map_err(|_| Rejected::Malformed)?;
    let id = value
        .get("id")
        .and_then(Value::as_u64)
        .ok_or(Rejected::Malformed)?;
    let name = value
        .get("method")
        .and_then(Value::as_str)
        .ok_or(Rejected::Malformed)?;
    let args = value
        .get("args")
        .and_then(Value::as_array)
        .ok_or(Rejected::Malformed)?
        .clone();
    let method = method(name).ok_or(Rejected::UnknownMethod)?;
    if !arguments_valid(&method, &args) {
        return Err(Rejected::Arguments);
    }
    Ok(Call { id, method, args })
}

/// JavaScript that settles one renderer promise. The whole payload goes through
/// serde_json, so task text inside a response can never break out of the literal.
pub fn resolve_script(frame: &Value) -> String {
    call_script("resolve", frame)
}

fn call_script(function: &str, payload: &Value) -> String {
    let json = serde_json::to_string(payload)
        .unwrap_or_else(|_| "{}".into())
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    format!("window.__atmBridge&&window.__atmBridge.{function}({json})")
}

pub fn ok(id: u64, value: Value) -> Value {
    json!({ "id": id, "ok": true, "value": value })
}

pub fn error(id: u64, code: &str, message: &str) -> Value {
    json!({ "id": id, "ok": false, "error": { "code": code, "message": message } })
}

/// 带细节的错误（切换 memory profile 失败时的整份报告）。
pub fn error_with(id: u64, code: &str, message: &str, details: Option<Value>) -> Value {
    let mut frame = error(id, code, message);
    if let Some(details) = details {
        frame["error"]["details"] = details;
    }
    frame
}

pub fn emit_script(name: &str, value: Value) -> String {
    call_script("emit", &json!({ "event": name, "value": value }))
}

/// Injected before any page script runs. Only the top document gets a working bridge;
/// frames are forbidden by CSP and the host, and their messages never reach the handler.
pub const INIT_SCRIPT: &str = r#"(() => {
  if (window.top !== window || window.ayanamiDesktop) return;
  const post = (message) => window.ipc.postMessage(JSON.stringify(message));
  const pending = new Map();
  let next = 1;
  const call = (method, args) => new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    post({ id, method, args });
  });
  const listeners = { maximized: new Set(), navigate: new Set(), dataSource: new Set() };
  const subscribe = (set) => (listener) => {
    set.add(listener);
    return () => set.delete(listener);
  };
  Object.defineProperty(window, "__atmBridge", {
    value: Object.freeze({
      resolve(message) {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (message.ok) entry.resolve(message.value);
        else {
          const failure = new Error((message.error && message.error.message) || "ATM_BRIDGE_FAILED");
          failure.code = message.error && message.error.code;
          if (message.error && message.error.details !== undefined) failure.details = message.error.details;
          entry.reject(failure);
        }
      },
      emit(message) {
        const set = message.event === "maximized" ? listeners.maximized : message.event === "navigate" ? listeners.navigate : message.event === "dataSource" ? listeners.dataSource : null;
        if (set) for (const listener of set) listener(message.value);
      },
    }),
  });
  const bridge = {
    notifyRendererReady: () => post({ id: 0, method: "notifyRendererReady", args: [] }),
    runtimeRequest: (input) => call("runtimeRequest", [input]),
    setAutoLaunch: (enabled) => call("setAutoLaunch", [enabled]),
    getAutoLaunch: () => call("getAutoLaunch", []),
    getUpdateStatus: () => call("getUpdateStatus", []),
    checkForUpdates: () => call("checkForUpdates", []),
    applyUpdate: () => call("applyUpdate", []),
    getMcpConfigs: () => call("getMcpConfigs", []),
    getMcpBridges: () => call("getMcpBridges", []),
    getMemoryProfile: () => call("getMemoryProfile", []),
    setMemoryProfile: (enabled) => call("setMemoryProfile", [enabled]),
    installMcp: (client) => call("installMcp", [client]),
    getAgentIntegrations: () => call("getAgentIntegrations", []),
    manageAgentIntegration: (client, action) => call("manageAgentIntegration", [client, action]),
    copyText: (text) => call("copyText", [text]),
    minimizeWindow: () => call("minimizeWindow", []),
    toggleMaximizeWindow: () => call("toggleMaximizeWindow", []),
    isWindowMaximized: () => call("isWindowMaximized", []),
    closeWindow: () => call("closeWindow", []),
    getWindowFrame: () => call("getWindowFrame", []),
    startWindowResize: (edge) => call("startWindowResize", [edge]),
    getDataSource: () => call("getDataSource", []),
    chooseDataSource: (choice) => call("chooseDataSource", [choice]),
    onDataSourceChange: subscribe(listeners.dataSource),
    onWindowMaximizedChange: subscribe(listeners.maximized),
    onNavigate: subscribe(listeners.navigate),
  };
  Object.defineProperty(window, "ayanamiDesktop", { value: Object.freeze(bridge) });
})();"#;

#[cfg(test)]
mod tests {
    use super::*;

    const SOURCE: &str = "https://atm.localhost/index.html";

    #[test]
    fn source_method_and_arguments_are_checked() {
        let call = parse(SOURCE, r#"{"id":3,"method":"setAutoLaunch","args":[true]}"#).unwrap();
        assert_eq!(call.method, Method::Local(Local::SetAutoLaunch));
        assert_eq!(
            parse(
                "https://evil/index.html",
                r#"{"id":1,"method":"getAutoLaunch","args":[]}"#
            ),
            Err(Rejected::Source)
        );
        assert_eq!(
            parse(SOURCE, r#"{"id":1,"method":"eval","args":[]}"#),
            Err(Rejected::UnknownMethod)
        );
        assert_eq!(
            parse(
                SOURCE,
                r#"{"id":1,"method":"setAutoLaunch","args":["yes"]}"#
            ),
            Err(Rejected::Arguments)
        );
        assert_eq!(
            parse(SOURCE, r#"{"id":1,"method":"getAutoLaunch","args":[1]}"#),
            Err(Rejected::Arguments)
        );
        assert_eq!(
            parse(SOURCE, r#"{"id":-1,"method":"getAutoLaunch","args":[]}"#),
            Err(Rejected::Malformed)
        );
        assert_eq!(
            parse(SOURCE, &"x".repeat(MAX_MESSAGE_BYTES + 1)),
            Err(Rejected::TooLarge)
        );
        assert_eq!(
            parse(
                SOURCE,
                r#"{"id":2,"method":"runtimeRequest","args":[{"path":"/api/v1/overview"}]}"#
            )
            .unwrap()
            .method,
            Method::Core("runtimeRequest")
        );
    }

    /// W8h：选数据来源只收两个取值；别的（含大小写不同、数组、对象）在桥上就被拒，到不了宿主。
    #[test]
    fn the_data_source_choice_takes_one_of_two_values() {
        for choice in ["KEEP_V3", "RECONVERT"] {
            let call = parse(
                SOURCE,
                &format!(r#"{{"id":4,"method":"chooseDataSource","args":["{choice}"]}}"#),
            )
            .unwrap();
            assert_eq!(call.method, Method::Local(Local::ChooseDataSource));
        }
        for args in [
            r#"["keep_v3"]"#,
            r#"["V3"]"#,
            r#"[1]"#,
            r#"[]"#,
            r#"["KEEP_V3","RECONVERT"]"#,
        ] {
            assert_eq!(
                parse(
                    SOURCE,
                    &format!(r#"{{"id":4,"method":"chooseDataSource","args":{args}}}"#)
                ),
                Err(Rejected::Arguments),
                "{args}"
            );
        }
        assert_eq!(
            parse(SOURCE, r#"{"id":5,"method":"getDataSource","args":[]}"#)
                .unwrap()
                .method,
            Method::Local(Local::GetDataSource)
        );
    }

    /// §9 负例「超大消息」：合法 JSON、白名单方法、类型正确的参数，只因体积超限就被拒。
    /// 上面那条用的是非 JSON 的填充，去掉体积检查也会以 Malformed 被拒，证明不了上限本身。
    #[test]
    fn oversized_but_well_formed_messages_are_rejected() {
        let message = |padding: usize| {
            format!(
                r#"{{"id":1,"method":"runtimeRequest","args":[{{"method":"PUT","path":"/api/v1/settings/x","body":"{}"}}]}}"#,
                "x".repeat(padding)
            )
        };
        let overhead = message(0).len();
        let at_limit = message(MAX_MESSAGE_BYTES - overhead);
        assert_eq!(at_limit.len(), MAX_MESSAGE_BYTES);
        assert!(parse(SOURCE, &at_limit).is_ok());
        let over = message(MAX_MESSAGE_BYTES - overhead + 1);
        assert_eq!(parse(SOURCE, &over), Err(Rejected::TooLarge));
        // 体积先于来源以外的一切检查：不解析超大消息。
        assert_eq!(
            parse(SOURCE, &message(8 * MAX_MESSAGE_BYTES)),
            Err(Rejected::TooLarge)
        );
    }

    /// §9 负例「伪造 origin」：只认 WebView2 报告的 Source，消息体里自报的来源一概不看；
    /// frame 与非顶层文档能报出来的各种 Source 都不等于入口文档。
    #[test]
    fn forged_origins_are_rejected_whatever_the_payload_claims() {
        let body = r#"{"id":1,"origin":"https://atm.localhost","source":"https://atm.localhost/index.html","method":"setAutoLaunch","args":[true]}"#;
        assert!(parse(SOURCE, body).is_ok());
        for forged in [
            "",
            "null",
            "about:blank",
            "about:srcdoc",
            "data:text/html,<script>1</script>",
            "blob:https://atm.localhost/0b1c2d3e-0000-4000-8000-000000000000",
            "https://atm.localhost",
            "https://atm.localhost/",
            "https://atm.localhost/index.html?x=1",
            "https://atm.localhost/assets/index.html",
            "https://atm.localhost./index.html",
            "https://ATM.LOCALHOST/index.html",
            "https://atm.localhost.evil.example/index.html",
            "https://evil.example/https://atm.localhost/index.html",
            "https://atm.localhost:443/index.html",
            "https://atm.localhost@evil.example/index.html",
            "atm://localhost/index.html",
            "file:///C:/renderer/index.html",
        ] {
            assert_eq!(parse(forged, body), Err(Rejected::Source), "{forged}");
        }
    }

    /// P-015：剪贴板只收 1 MiB 以内的文本；超出的整条拒掉，不截断。
    #[test]
    fn p015_copy_text_is_limited_to_one_mib() {
        let message = |len: usize| {
            format!(
                r#"{{"id":4,"method":"copyText","args":["{}"]}}"#,
                "x".repeat(len)
            )
        };
        let call = parse(SOURCE, &message(1 << 20)).unwrap();
        assert_eq!(call.method, Method::Local(Local::CopyText));
        // 反例：多一个字节就拒，整条消息仍远在 MAX_MESSAGE_BYTES 以内，拒它的是 copyText 自己的上限。
        assert_eq!(
            parse(SOURCE, &message((1 << 20) + 1)),
            Err(Rejected::Arguments)
        );
        assert_eq!(
            parse(SOURCE, r#"{"id":4,"method":"copyText","args":[7]}"#),
            Err(Rejected::Arguments)
        );
        // 2.x 宿主的 showItemInFolder / setNotificationMode 在 3.0 不是桥方法（通知方式只走托盘菜单的固定几项）：
        // 页面送来的路径和任意字符串根本到不了宿主。
        for name in ["showItemInFolder", "setNotificationMode", "openPath"] {
            assert_eq!(
                parse(
                    SOURCE,
                    &format!(r#"{{"id":5,"method":"{name}","args":["..\\x"]}}"#)
                ),
                Err(Rejected::UnknownMethod),
                "{name}"
            );
        }
    }

    /// 缩放把手只收固定的几个边名；顶边、大小写不同、数组、数字一律在桥上被拒。
    #[test]
    fn window_resize_takes_one_of_the_handle_edges() {
        for edge in [
            "left",
            "right",
            "bottom",
            "bottomLeft",
            "bottomRight",
            "topLeft",
            "topRight",
        ] {
            let call = parse(
                SOURCE,
                &format!(r#"{{"id":6,"method":"startWindowResize","args":["{edge}"]}}"#),
            )
            .unwrap();
            assert_eq!(call.method, Method::Local(Local::StartWindowResize));
        }
        for args in [
            r#"["top"]"#,
            r#"["Left"]"#,
            r#"["bottom-left"]"#,
            r#"[3]"#,
            r#"[]"#,
            r#"["left","right"]"#,
        ] {
            assert_eq!(
                parse(
                    SOURCE,
                    &format!(r#"{{"id":6,"method":"startWindowResize","args":{args}}}"#)
                ),
                Err(Rejected::Arguments),
                "{args}"
            );
        }
        assert_eq!(
            parse(SOURCE, r#"{"id":7,"method":"getWindowFrame","args":[]}"#)
                .unwrap()
                .method,
            Method::Local(Local::GetWindowFrame)
        );
    }

    #[test]
    fn responses_cannot_break_out_of_the_script() {
        let script = resolve_script(&ok(1, json!("\"); alert(1); (\" \u{2028}")));
        assert!(script.starts_with("window.__atmBridge&&window.__atmBridge.resolve({"));
        assert!(!script.contains('\u{2028}'));
        assert!(script.contains(r#"\"); alert(1); (\""#));
    }
}
