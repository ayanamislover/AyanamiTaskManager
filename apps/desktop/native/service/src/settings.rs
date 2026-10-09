//! 设置（04 §4.3、L-017；03 C-06 / C-L10）。
//!
//! 通用写入只接受白名单里的纯界面偏好，各自按 schema 校验；带语义的 key 只能走专用入口：
//! `notification.mode` 走 [`Service::set_notification_mode`]，`backup.policy` 走 [`Service::set_backup_policy`]，
//! `mcp.memory-profile-enabled` 走 Agent 集成的 profile 开关（W5）。版本规则保持 2.x：不存在的 key 读出来是 -1；
//! 带 expected_version 就做 CAS，不带就是 last-write-wins。回执落在 GLOBAL。

use crate::project::{db, dom_read_error, fixed_fp, invalid};
use crate::receipts::ReceiptScope;
use crate::write::{Rebind, Service, WriteRequest, Written};
use atm_domain::capability::{self, Capability};
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::principal::Principal;
use atm_domain::text::{js_trim, utf16_len};
use atm_store::events as store_events;
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Value, json};

pub const SET_OPERATION: &str = "setting.set";
pub const NOTIFICATION_MODE_OPERATION: &str = "notification.mode-set";
pub const BACKUP_POLICY_OPERATION: &str = "backup.policy-set";

pub const PROJECT_ORDER: &str = "projects.order";
pub const SESSION_TIMEOUT: &str = "recovery.sessionTimeoutMinutes";
pub const NOTIFICATION_MODE: &str = "notification.mode";
pub const BACKUP_POLICY: &str = "backup.policy";

/// 通用写入接受的 key。
pub const WRITABLE_KEYS: [&str; 2] = [PROJECT_ORDER, SESSION_TIMEOUT];

const NOTIFICATION_MODES: [&str; 3] = ["ALL", "CRITICAL", "OFF"];
const MAX_ORDER_IDS: usize = 10_000;

/// 备份保留策略（2.x `backup.policy` 的形状；默认每种 2 份）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BackupPolicy {
    pub enabled: bool,
    /// 1～90。
    pub daily_keep: i64,
    /// 1～52。
    pub weekly_keep: i64,
    /// 1～20。
    pub other_keep: i64,
}

impl Default for BackupPolicy {
    fn default() -> Self {
        BackupPolicy {
            enabled: true,
            daily_keep: 2,
            weekly_keep: 2,
            other_keep: 2,
        }
    }
}

/// 2.x 的 key 规则：`^[a-z0-9][A-Za-z0-9._-]{0,79}$`。
fn key_shape_ok(key: &str) -> bool {
    let b = key.as_bytes();
    !b.is_empty()
        && b.len() <= 80
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

fn key_invalid(key: &str, message: impl Into<String>) -> DomainError {
    DomainError::new(ErrorCode::SETTING_KEY_INVALID, message).detail("key", key)
}

/// 通用写入的 key 判定：形状、专用入口、白名单。
fn check_key(key: &str) -> Result<(), DomainError> {
    if !key_shape_ok(key) {
        return Err(key_invalid(key, "设置项 key 无效"));
    }
    let dedicated = match key {
        NOTIFICATION_MODE | "notification.enabled" => Some((
            "notification.mode_set",
            "通知方式要用通知设置的开关改（ALL / CRITICAL / OFF），notification.enabled 已并入 notification.mode",
        )),
        BACKUP_POLICY => Some((
            "backup.policy_set",
            "备份保留策略要用备份设置改，那里会校验每种备份的份数",
        )),
        "mcp.memory-profile-enabled" => Some((
            "agents.profile_switch",
            "memory profile 要用 Agent 集成里的开关切换，那里会同步客户端配置并在失败时回滚",
        )),
        _ => None,
    };
    if let Some((use_instead, message)) = dedicated {
        return Err(key_invalid(key, message)
            .detail("reason", "DEDICATED_CAPABILITY")
            .detail("use", use_instead));
    }
    if !WRITABLE_KEYS.contains(&key) {
        return Err(key_invalid(key, format!("设置项 {key} 不在可写白名单里"))
            .detail("reason", "NOT_WRITABLE")
            .detail("allowed", json!(WRITABLE_KEYS)));
    }
    Ok(())
}

/// 白名单 key 的 schema。
fn check_value(key: &str, value: &Value) -> Result<(), DomainError> {
    match key {
        PROJECT_ORDER => {
            let ids = value
                .as_object()
                .filter(|o| o.len() == 1)
                .and_then(|o| o.get("ids"))
                .and_then(Value::as_array)
                .ok_or_else(|| invalid("value", "projects.order 的值是 {\"ids\": [项目 id…]}"))?;
            if ids.len() > MAX_ORDER_IDS {
                return Err(invalid(
                    "value",
                    format!("projects.order 最多 {MAX_ORDER_IDS} 个项目"),
                ));
            }
            if let Some(i) = ids.iter().position(|id| {
                id.as_str()
                    .is_none_or(|s| s.is_empty() || utf16_len(s) > 128)
            }) {
                return Err(
                    invalid("value", "projects.order 的 ids 必须是非空字符串").detail("index", i)
                );
            }
            Ok(())
        }
        SESSION_TIMEOUT => match value.as_i64() {
            Some(m) if (1..=1440).contains(&m) => Ok(()),
            _ => Err(invalid(
                "value",
                "recovery.sessionTimeoutMinutes 必须是 1～1440 的整数",
            )
            .detail("got", value.clone())),
        },
        _ => Err(key_invalid(key, "设置项 key 无效")),
    }
}

fn row(tx: &Transaction<'_>, key: &str) -> Result<Option<(Value, i64, String)>, DomainError> {
    tx.query_row(
        "SELECT value_json, version, updated_at FROM settings WHERE key = ?1",
        [key],
        |r| {
            let v: String = r.get(0)?;
            Ok((
                serde_json::from_str(&v).unwrap_or(Value::Null),
                r.get(1)?,
                r.get(2)?,
            ))
        },
    )
    .optional()
    .map_err(db)
}

/// 存着的保留策略（W5h 维护作业用）。2.x 的读法（`backup-retention.ts` `bounded`）：
/// `Number(value ?? fallback)`，不是有限数就用默认，否则取整后夹到 1～上限；`enabled` 只有明确是 false 才关。
/// 存着的值是 2.x 原样转换来的（不经校验），`"20"`、`""`、`true` 这类值要和 2.x 读出同一个数（peer W5 r1 P1-01）。
pub(crate) fn stored_backup_policy(tx: &Transaction<'_>) -> Result<BackupPolicy, DomainError> {
    let value = row(tx, BACKUP_POLICY)?
        .map(|(v, _, _)| v)
        .unwrap_or(Value::Null);
    let default = BackupPolicy::default();
    let bounded = |key: &str, fallback: i64, max: i64| -> i64 {
        match value.get(key) {
            // `??`：缺了与 null 都换成默认值。
            None | Some(Value::Null) => fallback,
            Some(v) => match js_number(v).filter(|f| f.is_finite()) {
                Some(f) => (f.trunc().max(1.0).min(max as f64)) as i64,
                None => fallback,
            },
        }
    };
    Ok(BackupPolicy {
        enabled: value.get("enabled") != Some(&Value::Bool(false)),
        daily_keep: bounded("dailyKeep", default.daily_keep, 90),
        weekly_keep: bounded("weeklyKeep", default.weekly_keep, 52),
        other_keep: bounded("otherKeep", default.other_keep, 20),
    })
}

/// 存着的会话超时，毫秒。2.x（`startup-recovery.ts` `recoverProjectSessions`）：
/// `Math.min(1440, Math.max(1, Number(value ?? 5)))` 分钟，不取整；2.x 原样转来的 `"30"` 照样是 30 分钟。
/// 不是数时 2.x 的截止时间是 Invalid Date、整轮恢复抛错；这里退回默认 5 分钟，扫描照常进行。
/// 截止时间在 2.x 是 `new Date(now - m * 60000)`，Date 取整后等于减去向上取整的毫秒数。
pub(crate) fn stored_session_timeout_ms(tx: &Transaction<'_>) -> Result<i64, DomainError> {
    let minutes = match row(tx, SESSION_TIMEOUT)?.map(|(v, _, _)| v) {
        None | Some(Value::Null) => 5.0,
        Some(v) => js_number(&v).filter(|m| !m.is_nan()).unwrap_or(5.0),
    };
    Ok((minutes.clamp(1.0, 1440.0) * 60_000.0).ceil() as i64)
}

/// JS 的 `Number(value)`：`None` 是 NaN。数组先按 `Array.prototype.join` 变成字符串，对象是 NaN。
fn js_number(v: &Value) -> Option<f64> {
    match v {
        Value::Null => Some(0.0),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::Number(n) => n.as_f64(),
        Value::String(s) => js_string_number(s),
        Value::Array(_) => js_string_number(&js_join(v)),
        Value::Object(_) => None,
    }
}

/// `String(value)`，只用于数组元素：null 是空串，嵌套数组递归 join，对象是 `[object Object]`。
fn js_join(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        Value::Array(items) => items.iter().map(js_join).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// 字符串转数（ECMAScript StringNumericLiteral）：去掉首尾空白，空串是 0；`Infinity` 带可选符号；
/// `0x` / `0o` / `0b` 不带符号；十进制允许符号、小数点与指数。其余（包括 Rust 认的 `inf`、`nan`、`1_0`）是 NaN。
fn js_string_number(s: &str) -> Option<f64> {
    let t = js_trim(s);
    if t.is_empty() {
        return Some(0.0);
    }
    let (sign, body) = match t.as_bytes()[0] {
        b'+' => (1.0, &t[1..]),
        b'-' => (-1.0, &t[1..]),
        _ => (1.0, t),
    };
    if body == "Infinity" {
        return Some(sign * f64::INFINITY);
    }
    let radix = match body.get(..2) {
        Some("0x" | "0X") => Some(16),
        Some("0o" | "0O") => Some(8),
        Some("0b" | "0B") => Some(2),
        _ => None,
    };
    if let Some(radix) = radix {
        // 带进制前缀的不许有符号。
        if body.len() != t.len() || body.len() == 2 {
            return None;
        }
        return body[2..].chars().try_fold(0.0_f64, |acc, c| {
            c.to_digit(radix)
                .map(|d| acc * f64::from(radix) + f64::from(d))
        });
    }
    let bytes = body.as_bytes();
    let mut i = 0;
    let digits = |i: &mut usize| {
        let start = *i;
        while *i < bytes.len() && bytes[*i].is_ascii_digit() {
            *i += 1;
        }
        *i - start
    };
    let whole = digits(&mut i);
    let mut fraction = 0;
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        fraction = digits(&mut i);
    }
    if whole + fraction == 0 {
        return None;
    }
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        i += 1;
        if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
            i += 1;
        }
        if digits(&mut i) == 0 {
            return None;
        }
    }
    if i != bytes.len() {
        return None;
    }
    body.parse::<f64>().ok().map(|f| sign * f)
}

fn setting_view(key: &str, row: Option<(Value, i64, String)>) -> Value {
    match row {
        Some((value, version, at)) => {
            json!({ "key": key, "value": value, "version": version, "updatedAt": at })
        }
        None => json!({ "key": key, "value": null, "version": -1, "updatedAt": null }),
    }
}

/// 2.x `setSetting` 的版本规则与事件。
fn put(
    tx: &Transaction<'_>,
    key: &str,
    value: &Value,
    expected: Option<i64>,
    at: &str,
) -> Result<Value, DomainError> {
    let actual = row(tx, key)?.map_or(-1, |r| r.1);
    if let Some(e) = expected
        && e != actual
    {
        return Err(DomainError::new(
            ErrorCode::VERSION_CONFLICT,
            if actual == -1 {
                "设置项尚不存在：expected_version 用 -1 或不传"
            } else {
                "设置项版本已变化：重新读取后再改"
            },
        )
        .detail("entity", "SETTING")
        .detail("key", key)
        .detail("expected", e)
        .detail("actual", actual));
    }
    if actual == -1 {
        tx.execute(
            "INSERT INTO settings (key, value_json, version, updated_at) VALUES (?1, ?2, 0, ?3)",
            params![key, value.to_string(), at],
        )
    } else {
        tx.execute(
            "UPDATE settings SET value_json = ?2, version = version + 1, updated_at = ?3 WHERE key = ?1",
            params![key, value.to_string(), at],
        )
    }
    .map_err(db)?;
    store_events::append_global(tx, "setting.updated", key, "USER", "{}", None, at)
        .map_err(|e| crate::write::internal(format!("{e:?}")))?;
    Ok(json!({ "setting": setting_view(key, row(tx, key)?) }))
}

/// 一个设置写入口：能力、operation 名与它写的 key。
struct Slot {
    capability: Capability,
    operation: &'static str,
    key: &'static str,
}

impl Service {
    fn put_setting(
        &self,
        principal: &Principal,
        Slot {
            capability,
            operation,
            key,
        }: Slot,
        value: Value,
        expected_version: Option<i64>,
        op_id: &str,
    ) -> Result<Written, DomainError> {
        let fp = json!({ "key": key, "value": value, "expected_version": expected_version });
        self.write(
            principal,
            WriteRequest {
                capability,
                operation,
                op_id: op_id.to_owned(),
                scope: ReceiptScope::global(),
                session: None,
                actor: None,
                expected_generation: None,
                fingerprint: fixed_fp(fp),
                compat_v1: None,
                replay_guard: None,
                prepare: None,
                rebind: Rebind::Create,
            },
            move |tx, ctx| put(tx, key, &value, expected_version, &ctx.now.to_string()),
        )
    }

    /// 通用设置写入（User；L-017）：只接受 [`WRITABLE_KEYS`]，按 schema 校验。
    pub fn set_setting(
        &self,
        principal: &Principal,
        key: &str,
        value: Value,
        expected_version: Option<i64>,
        op_id: &str,
    ) -> Result<Written, DomainError> {
        capability::require(principal, Capability::SettingsWrite)?;
        check_key(key)?;
        check_value(key, &value)?;
        let key = WRITABLE_KEYS
            .into_iter()
            .find(|k| *k == key)
            .ok_or_else(|| key_invalid(key, "设置项 key 无效"))?;
        self.put_setting(
            principal,
            Slot {
                capability: Capability::SettingsWrite,
                operation: SET_OPERATION,
                key,
            },
            value,
            expected_version,
            op_id,
        )
    }

    /// 通知方式（User；03 C-06）：ALL / CRITICAL / OFF。
    pub fn set_notification_mode(
        &self,
        principal: &Principal,
        mode: &str,
        expected_version: Option<i64>,
        op_id: &str,
    ) -> Result<Written, DomainError> {
        capability::require(principal, Capability::NotificationModeSet)?;
        if !NOTIFICATION_MODES.contains(&mode) {
            return Err(DomainError::new(
                ErrorCode::NOTIFICATION_MODE_INVALID,
                "通知方式只能是 ALL、CRITICAL 或 OFF",
            )
            .detail("got", mode));
        }
        self.put_setting(
            principal,
            Slot {
                capability: Capability::NotificationModeSet,
                operation: NOTIFICATION_MODE_OPERATION,
                key: NOTIFICATION_MODE,
            },
            json!(mode),
            expected_version,
            op_id,
        )
    }

    /// 备份保留策略（User；L-017）：每种备份的份数有上下限，越界直接拒绝（2.x 会接受、读时再回落）。
    /// 权限沿用 settings.write：能力表里没有单列的 backup.policy_set。
    pub fn set_backup_policy(
        &self,
        principal: &Principal,
        policy: BackupPolicy,
        expected_version: Option<i64>,
        op_id: &str,
    ) -> Result<Written, DomainError> {
        capability::require(principal, Capability::SettingsWrite)?;
        for (field, v, max) in [
            ("daily_keep", policy.daily_keep, 90),
            ("weekly_keep", policy.weekly_keep, 52),
            ("other_keep", policy.other_keep, 20),
        ] {
            if !(1..=max).contains(&v) {
                return Err(
                    invalid(field, format!("{field} 必须在 1～{max} 之间")).detail("got", v)
                );
            }
        }
        let value = json!({
            "enabled": policy.enabled,
            "dailyKeep": policy.daily_keep,
            "weeklyKeep": policy.weekly_keep,
            "otherKeep": policy.other_keep,
        });
        self.put_setting(
            principal,
            Slot {
                capability: Capability::SettingsWrite,
                operation: BACKUP_POLICY_OPERATION,
                key: BACKUP_POLICY,
            },
            value,
            expected_version,
            op_id,
        )
    }

    /// 读一个设置；不存在时 version 为 -1、value 为 null。
    pub fn get_setting(&self, principal: &Principal, key: &str) -> Result<Value, DomainError> {
        capability::require(principal, Capability::SettingsRead)?;
        let key = key.to_owned();
        self.store()
            .read(move |tx| Ok(setting_view(&key, row(tx, &key)?)))
            .map_err(dom_read_error)
    }

    /// 全部设置，按 key 排序。
    pub fn list_settings(&self, principal: &Principal) -> Result<Value, DomainError> {
        capability::require(principal, Capability::SettingsRead)?;
        self.store()
            .read(|tx| {
                let keys: Vec<String> = {
                    let mut st = tx
                        .prepare("SELECT key FROM settings ORDER BY key")
                        .map_err(db)?;
                    st.query_map([], |r| r.get(0))
                        .map_err(db)?
                        .collect::<Result<_, _>>()
                        .map_err(db)?
                };
                let list = keys
                    .iter()
                    .map(|k| Ok(setting_view(k, row(tx, k)?)))
                    .collect::<Result<Vec<_>, DomainError>>()?;
                Ok(json!({ "settings": list }))
            })
            .map_err(dom_read_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 与 JS `Number(x)` 逐条对照（期望值是在 Node 里求出来的）。
    #[test]
    fn numbers_are_read_like_javascript() {
        let nan = None::<f64>;
        for (input, expected) in [
            ("20", Some(20.0)),
            (" 3.9\n", Some(3.9)),
            ("", Some(0.0)),
            ("\u{feff}\u{a0} 7 \t", Some(7.0)),
            ("+5", Some(5.0)),
            ("-4", Some(-4.0)),
            (".5", Some(0.5)),
            ("5.", Some(5.0)),
            ("1e3", Some(1000.0)),
            ("1E+2", Some(100.0)),
            ("0x10", Some(16.0)),
            ("0o17", Some(15.0)),
            ("0b101", Some(5.0)),
            ("Infinity", Some(f64::INFINITY)),
            ("-Infinity", Some(f64::NEG_INFINITY)),
            ("x", nan),
            ("20 days", nan),
            ("1_0", nan),
            ("inf", nan),
            ("NaN", nan),
            ("infinity", nan),
            ("-0x10", nan),
            ("0x", nan),
            (".", nan),
            ("1e", nan),
            ("\u{85}5", nan),
        ] {
            assert_eq!(js_string_number(input), expected, "{input:?}");
        }
        for (input, expected) in [
            // 2.x 原样转来的字符串值走的是这一支（peer W5 r1 P1-01 的 `"20"`）。
            (json!("20"), Some(20.0)),
            (json!(" 3.9 "), Some(3.9)),
            (json!(""), Some(0.0)),
            (json!("x"), nan),
            (json!(true), Some(1.0)),
            (json!(false), Some(0.0)),
            (json!(null), Some(0.0)),
            (json!(12.5), Some(12.5)),
            (json!([]), Some(0.0)),
            (json!(["6"]), Some(6.0)),
            (json!([[8]]), Some(8.0)),
            (json!([null]), Some(0.0)),
            (json!([1, 2]), nan),
            (json!([true]), nan),
            (json!({}), nan),
            (json!({"n": 3}), nan),
        ] {
            assert_eq!(js_number(&input), expected, "{input}");
        }
    }

    #[test]
    fn key_shape_follows_2x() {
        for ok in [
            "a",
            "projects.order",
            "0x",
            "a-b_c.D9",
            &format!("a{}", "b".repeat(79)),
        ] {
            assert!(key_shape_ok(ok), "{ok}");
        }
        for bad in [
            "",
            "A",
            ".a",
            "_a",
            "a b",
            "a/b",
            "é",
            &format!("a{}", "b".repeat(80)),
        ] {
            assert!(!key_shape_ok(bad), "{bad}");
        }
    }
}
