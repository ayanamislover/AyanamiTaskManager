//! 设置页操作的纯逻辑（2.x `packages/sync/src/settings.ts`）：配置补丁校验、中继探测、旧空间清理。

use std::time::Instant;

use atm_domain::error::{DomainError, ErrorCode};
use atm_sync_protocol::SpaceKeys;
use atm_sync_protocol::encoding::{js_is_whitespace, js_trim};
use atm_sync_protocol::keys::{is_app_id, space_prefix};
use atm_sync_protocol::pairing::normalize_relay_url;
use serde_json::{Value, json};

use crate::config::{DEVICE_NAME_MAX, SyncConfig};
use crate::errors::{Failure, describe, redact};
use crate::relay::RelayClient;
use crate::space::{SpaceStore, SpaceStoreOptions};
use crate::text::js_len;

fn invalid(message: impl Into<String>, field: &str) -> DomainError {
    DomainError::new(ErrorCode::INVALID_ARGUMENT, message).detail("field", field)
}

/// 补丁里的一项：缺了是 `None`。
#[derive(Debug, Clone, Default, PartialEq)]
struct Patch {
    enabled: Option<bool>,
    /// 外层 None：没给；`Some(None)`：给了 null。
    relay_url: Option<Option<String>>,
    app_id: Option<String>,
    token: Option<String>,
    device_name: Option<String>,
}

/// zod 的 strict 对象：只认这几个字段，各自类型与长度。
fn parse_patch(patch: &Value) -> Option<Patch> {
    let empty = serde_json::Map::new();
    let map = match patch {
        Value::Null => &empty,
        Value::Object(m) => m,
        _ => return None,
    };
    let text = |v: &Value, max: usize| v.as_str().filter(|s| js_len(s) <= max).map(str::to_owned);
    let mut out = Patch::default();
    for (k, v) in map {
        match k.as_str() {
            "enabled" => out.enabled = Some(v.as_bool()?),
            "relayUrl" => {
                out.relay_url = Some(match v {
                    Value::Null => None,
                    v => Some(text(v, 512)?),
                })
            }
            "appId" => out.app_id = Some(text(v, 64)?),
            "token" => out.token = Some(text(v, 512)?),
            "deviceName" => out.device_name = Some(text(v, 256)?),
            _ => return None,
        }
    }
    Some(out)
}

#[derive(Debug, Clone, PartialEq)]
pub struct ConfigChange {
    pub next: SyncConfig,
    /// `None`：不动 token；`Some(None)`：清除；`Some(Some(t))`：保存新 token。
    pub token: Option<Option<String>>,
    /// 开关、中继地址、应用 ID 或 token 变了：要重建客户端并重新探测。
    pub reconnect: bool,
    pub name_changed: bool,
}

/// 校验 `PUT /api/v1/sync/config` 的补丁并算出新配置；全部校验通过前不产生任何副作用。
pub fn plan_config_change(
    current: &SyncConfig,
    current_token: Option<&str>,
    patch: &Value,
) -> Result<ConfigChange, DomainError> {
    let input = parse_patch(patch).ok_or_else(|| {
        invalid(
            "同步配置不合法：只接受 enabled、relayUrl、appId、token、deviceName",
            "body",
        )
    })?;
    let mut next = current.clone();
    let mut relay_moved = false;
    if let Some(raw) = &input.relay_url {
        let raw = raw.as_deref().map(js_trim).unwrap_or("");
        let url = if raw.is_empty() {
            None
        } else {
            Some(normalize_relay_url(raw).map_err(|_| {
                invalid(
                    "中继地址必须是 https；只有本机调试地址（127.0.0.1 / localhost）允许 http",
                    "relayUrl",
                )
            })?)
        };
        relay_moved |= url != next.relay_url;
        next.relay_url = url;
    }
    if let Some(app) = &input.app_id {
        let app = js_trim(app);
        if !is_app_id(app) {
            return Err(invalid(
                "应用 ID 只能是小写字母、数字、- 和 _（2–32 位）",
                "appId",
            ));
        }
        relay_moved |= app != next.app_id;
        next.app_id = app.to_owned();
    }
    let mut name_changed = false;
    if let Some(name) = &input.device_name {
        let name = js_trim(name);
        if name.is_empty() || js_len(name) > DEVICE_NAME_MAX {
            return Err(invalid(
                format!("设备名不能为空，且不超过 {DEVICE_NAME_MAX} 个字符"),
                "deviceName",
            ));
        }
        name_changed = name != next.device_name;
        next.device_name = name.to_owned();
    }
    let trimmed = input.token.as_deref().map(js_trim);
    if let Some(t) = trimmed
        && !t.is_empty()
        && (js_len(t) < 8 || t.chars().any(js_is_whitespace))
    {
        return Err(invalid("token 至少 8 个字符，且不能包含空白", "token"));
    }
    let token = match trimmed {
        None => None,
        Some(t) if t == current_token.unwrap_or("") => None,
        Some("") => Some(None),
        Some(t) => Some(Some(t.to_owned())),
    };
    let mut reconnect = token.is_some();
    if let Some(enabled) = input.enabled
        && enabled != next.enabled
    {
        next.enabled = enabled;
        reconnect = true;
    }
    if relay_moved {
        // 换了中继：那边什么都没有，游标与已发布摘要都作废。
        next.cursor = None;
        next.published.clear();
        next.head_digest = None;
        reconnect = true;
    }
    Ok(ConfigChange {
        next,
        token,
        reconnect,
        name_changed,
    })
}

/// `POST /api/v1/sync/test` 的候选配置：缺的项用已保存的补上。不合法返回 `None`。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RelayCandidate {
    pub relay_url: Option<String>,
    pub app_id: Option<String>,
    pub token: Option<String>,
}

pub fn parse_relay_candidate(candidate: &Value) -> Option<RelayCandidate> {
    let empty = serde_json::Map::new();
    let map = match candidate {
        Value::Null => &empty,
        Value::Object(m) => m,
        _ => return None,
    };
    let mut out = RelayCandidate::default();
    for (k, v) in map {
        let max = match k.as_str() {
            "relayUrl" => 512,
            "appId" => 64,
            "token" => 512,
            _ => return None,
        };
        let s = v.as_str().filter(|s| js_len(s) <= max)?;
        let picked = Some(js_trim(s).to_owned()).filter(|s| !s.is_empty());
        match k.as_str() {
            "relayUrl" => out.relay_url = picked,
            "appId" => out.app_id = picked,
            _ => out.token = picked,
        }
    }
    Some(out)
}

/// 探测结果（`RelayTestResult`）。`error` 只来自 [`describe`]，`server` 是按字符集筛过的标签。
pub fn probe_result(
    make_client: impl FnOnce() -> Result<RelayClient, Failure>,
    secrets: &[&str],
) -> Value {
    let started = Instant::now();
    let elapsed = || started.elapsed().as_millis() as u64;
    match make_client().and_then(|c| c.probe().map_err(Failure::Relay)) {
        Ok(probe) => {
            let server = match &probe.version {
                Some(v) => format!("{} {v}", probe.server),
                None => probe.server.clone(),
            };
            json!({
                "ok": true,
                "latencyMs": elapsed(),
                "longPoll": probe.long_poll,
                "server": redact(&server, secrets),
            })
        }
        Err(e) => json!({
            "ok": false,
            "latencyMs": elapsed(),
            "longPoll": false,
            "error": redact(&describe(&e), secrets),
        }),
    }
}

/// 删掉一个空间前缀下的全部文档（含分片）；返回删掉的个数。
pub fn purge_space(client: &RelayClient, space_id: &str) -> Result<u64, Failure> {
    let mut removed = 0;
    for meta in client.list_documents(&space_prefix(space_id)?)? {
        match client.delete_document(&meta.key, meta.revision) {
            Ok(true) => removed += 1,
            Ok(false) => {}
            Err(e) if e.status == 409 => {
                if let Some(current) = client.get_document(&meta.key, None)?
                    && client.delete_document(&meta.key, current.meta.revision)?
                {
                    removed += 1;
                }
            }
            Err(e) => return Err(e.into()),
        }
    }
    Ok(removed)
}

/// 在（已清空的）旧空间里留撤销标记，用旧空间的密钥加密：旧手机读到就回到「需要重新配对」，
/// 而不是一直当成「电脑还没发布」，把新任务发进一个没人读的空间。
pub fn revoke_space(
    client: &RelayClient,
    space_id: &str,
    secret: &str,
    host: (&str, &str),
    at: &str,
) -> Result<(), Failure> {
    let store = SpaceStore::new(SpaceStoreOptions {
        client: client.clone(),
        keys: SpaceKeys::derive(secret)?,
        space_id: space_id.to_owned(),
        retry_delay: None,
        lifetime: None,
        sleep: None,
    })?;
    store.write_revoked(&json!({ "v": 1, "at": at, "host": { "id": host.0, "name": host.1 } }))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::default_config;

    fn base() -> SyncConfig {
        default_config("工作站").unwrap()
    }

    #[test]
    fn patches_are_strict_and_validated_before_any_change() {
        let c = base();
        for bad in [
            json!({"extra": 1}),
            json!({"enabled": "yes"}),
            json!({"relayUrl": 5}),
            json!([1]),
            json!({"token": "x".repeat(513)}),
        ] {
            let e = plan_config_change(&c, None, &bad).unwrap_err();
            assert_eq!(e.details["field"], "body", "{bad}");
        }
        let field =
            |p: Value| plan_config_change(&c, None, &p).unwrap_err().details["field"].clone();
        assert_eq!(
            field(json!({"relayUrl": "http://relay.example.com"})),
            "relayUrl"
        );
        assert_eq!(field(json!({"appId": "ATM"})), "appId");
        assert_eq!(field(json!({"deviceName": "  "})), "deviceName");
        assert_eq!(field(json!({"token": "short"})), "token");
        assert_eq!(field(json!({"token": "has space inside"})), "token");
    }

    #[test]
    fn moving_the_relay_drops_the_cursor_and_the_publish_cache() {
        let mut c = base();
        c.relay_url = Some("https://a.example.com".into());
        c.cursor = Some("9".into());
        c.head_digest = Some("d".into());
        let change = plan_config_change(
            &c,
            Some("token-1234"),
            &json!({"relayUrl": " https://b.example.com/ "}),
        )
        .unwrap();
        assert_eq!(
            change.next.relay_url.as_deref(),
            Some("https://b.example.com")
        );
        assert_eq!(
            (change.next.cursor.clone(), change.next.head_digest.clone()),
            (None, None)
        );
        assert!(change.reconnect);
        assert_eq!(change.token, None);
        let same = plan_config_change(
            &c,
            Some("token-1234"),
            &json!({"relayUrl": "https://a.example.com", "token": " token-1234 "}),
        )
        .unwrap();
        assert!(!same.reconnect);
        assert_eq!(same.next.cursor.as_deref(), Some("9"));
        let cleared = plan_config_change(&c, Some("token-1234"), &json!({"token": ""})).unwrap();
        assert_eq!(cleared.token, Some(None));
        let renamed = plan_config_change(&c, None, &json!({"deviceName": " 新名字 "})).unwrap();
        assert!(renamed.name_changed && !renamed.reconnect);
        assert!(plan_config_change(&c, None, &Value::Null).is_ok());
    }

    #[test]
    fn relay_candidates_take_only_three_strings() {
        assert_eq!(
            parse_relay_candidate(&Value::Null),
            Some(RelayCandidate::default())
        );
        let c = parse_relay_candidate(&json!({"relayUrl": " https://r ", "token": "  "})).unwrap();
        assert_eq!((c.relay_url.as_deref(), c.token), (Some("https://r"), None));
        assert_eq!(parse_relay_candidate(&json!({"other": "x"})), None);
        assert_eq!(parse_relay_candidate(&json!({"token": 5})), None);
    }
}
