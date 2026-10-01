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
    ShowItemInFolder,
    CopyText,
    MinimizeWindow,
    ToggleMaximizeWindow,
    IsWindowMaximized,
    CloseWindow,
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
        "showItemInFolder" => Method::Local(Local::ShowItemInFolder),
        "copyText" => Method::Local(Local::CopyText),
        "minimizeWindow" => Method::Local(Local::MinimizeWindow),
        "toggleMaximizeWindow" => Method::Local(Local::ToggleMaximizeWindow),
        "isWindowMaximized" => Method::Local(Local::IsWindowMaximized),
        "closeWindow" => Method::Local(Local::CloseWindow),
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
        Method::Local(Local::SetAutoLaunch | Local::ShowItemInFolder | Local::CopyText) => 1,
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
        Method::Local(Local::ShowItemInFolder) => {
            args[0].as_str().is_some_and(|path| path.len() <= 4096)
        }
        Method::Local(Local::CopyText) => {
            args[0].as_str().is_some_and(|text| text.len() <= 1 << 20)
        }
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
  const listeners = { maximized: new Set(), navigate: new Set() };
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
        const set = message.event === "maximized" ? listeners.maximized : message.event === "navigate" ? listeners.navigate : null;
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
    showItemInFolder: (path) => call("showItemInFolder", [path]),
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

    #[test]
    fn responses_cannot_break_out_of_the_script() {
        let script = resolve_script(&ok(1, json!("\"); alert(1); (\" \u{2028}")));
        assert!(script.starts_with("window.__atmBridge&&window.__atmBridge.resolve({"));
        assert!(!script.contains('\u{2028}'));
        assert!(script.contains(r#"\"); alert(1); (\""#));
    }
}
