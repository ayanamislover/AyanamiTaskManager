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
use atm_domain::text::utf16_len;
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
