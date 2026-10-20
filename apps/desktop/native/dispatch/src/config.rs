//! 派单配置（2.x `config.ts`）：`DispatchConfigSchema` 是 strict 的，补丁多一个键、类型不对都整份拒绝。

use crate::errors::{DispatchError, invalid};
use serde_json::{Value, json};

/// 无头会话可用的权限模式。`manual` 会停下来等人确认，`-p` 模式下没人回答，所以不开放。
pub const PERMISSION_MODES: &[&str] = &["auto", "acceptEdits", "bypassPermissions", "plan"];
pub const EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DispatchConfig {
    pub enabled: bool,
    pub permission_mode: String,
    /// 1–3。
    pub max_concurrent: u32,
    pub model: Option<String>,
    pub effort: Option<String>,
}

impl Default for DispatchConfig {
    fn default() -> Self {
        DispatchConfig {
            enabled: false,
            permission_mode: "auto".into(),
            max_concurrent: 1,
            model: None,
            effort: None,
        }
    }
}

/// model 会进命令行（npm 装法还要经 cmd.exe），只放行 `^[A-Za-z0-9._-]{1,64}$`。
pub fn model_ok(model: &str) -> bool {
    (1..=64).contains(&model.len())
        && model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

impl DispatchConfig {
    pub fn to_json(&self) -> Value {
        json!({
            "enabled": self.enabled,
            "permissionMode": self.permission_mode,
            "maxConcurrent": self.max_concurrent,
            "model": self.model,
            "effort": self.effort,
        })
    }

    /// 每个值都在取值范围里（库里读出来的行也过一遍：不合法就回退默认值）。
    pub fn is_valid(&self) -> bool {
        PERMISSION_MODES.contains(&self.permission_mode.as_str())
            && (1..=3).contains(&self.max_concurrent)
            && self.model.as_deref().is_none_or(model_ok)
            && self.effort.as_deref().is_none_or(|e| EFFORTS.contains(&e))
    }

    /// 2.x `mergeDispatchConfig`：补丁不合法时抛 DISPATCH_INVALID_ARGUMENT，带逐项问题（最多 20 条）。
    pub fn merge(&self, patch: &Value) -> Result<DispatchConfig, DispatchError> {
        let Some(fields) = patch.as_object() else {
            return Err(issues(vec![issue("", "补丁必须是对象")]));
        };
        let mut next = self.clone();
        let mut problems = Vec::new();
        for (name, value) in fields {
            match name.as_str() {
                "enabled" => match value.as_bool() {
                    Some(b) => next.enabled = b,
                    None => problems.push(issue(name, "必须是布尔值")),
                },
                "permissionMode" => match value.as_str() {
                    Some(m) if PERMISSION_MODES.contains(&m) => next.permission_mode = m.into(),
                    _ => problems.push(issue(
                        name,
                        "只能是 auto、acceptEdits、bypassPermissions 或 plan",
                    )),
                },
                "maxConcurrent" => match value.as_f64() {
                    Some(n) if n.fract() == 0.0 && (1.0..=3.0).contains(&n) => {
                        next.max_concurrent = n as u32
                    }
                    _ => problems.push(issue(name, "必须是 1 到 3 的整数")),
                },
                "model" => match value {
                    Value::Null => next.model = None,
                    Value::String(m) if model_ok(m) => next.model = Some(m.clone()),
                    _ => problems.push(issue(name, "只能包含字母、数字与 ._-，最长 64 个字符")),
                },
                "effort" => match value {
                    Value::Null => next.effort = None,
                    Value::String(e) if EFFORTS.contains(&e.as_str()) => {
                        next.effort = Some(e.clone())
                    }
                    _ => problems.push(issue(name, "只能是 low、medium、high、xhigh 或 max")),
                },
                _ => problems.push(issue(name, "未知字段")),
            }
        }
        if problems.is_empty() {
            Ok(next)
        } else {
            problems.truncate(20);
            Err(issues(problems))
        }
    }
}

fn issue(path: &str, message: &str) -> Value {
    json!({ "path": path, "message": message })
}

fn issues(list: Vec<Value>) -> DispatchError {
    invalid("派单配置不合法").detail("issues", Value::Array(list))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_is_off_auto_and_one_at_a_time() {
        let d = DispatchConfig::default();
        assert_eq!(
            d.to_json(),
            json!({ "enabled": false, "permissionMode": "auto", "maxConcurrent": 1, "model": null, "effort": null })
        );
        assert!(d.is_valid());
    }

    #[test]
    fn a_patch_is_merged_field_by_field() {
        let d = DispatchConfig::default();
        let next = d
            .merge(&json!({ "enabled": true, "maxConcurrent": 2, "model": "claude-opus-5-5", "effort": "max" }))
            .unwrap();
        assert!(next.enabled);
        assert_eq!(next.max_concurrent, 2);
        assert_eq!(next.model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(next.permission_mode, "auto");
        let cleared = next.merge(&json!({ "model": null })).unwrap();
        assert_eq!(cleared.model, None);
        assert_eq!(d.merge(&json!({})).unwrap(), d);
    }

    #[test]
    fn invalid_patches_are_refused_whole() {
        let d = DispatchConfig::default();
        for bad in [
            json!({ "maxConcurrent": 4 }),
            json!({ "maxConcurrent": 0 }),
            json!({ "maxConcurrent": 1.5 }),
            json!({ "maxConcurrent": "2" }),
            json!({ "permissionMode": "manual" }),
            json!({ "model": "a b" }),
            json!({ "model": "x & calc" }),
            json!({ "model": "" }),
            json!({ "model": "m".repeat(65) }),
            json!({ "effort": "huge" }),
            json!({ "enabled": "yes" }),
            json!({ "extra": 1 }),
            json!({ "enabled": true, "extra": 1 }),
            json!([1]),
        ] {
            let e = d.merge(&bad).unwrap_err();
            assert_eq!(
                e.code,
                crate::errors::Code::DISPATCH_INVALID_ARGUMENT,
                "{bad}"
            );
            assert!(
                e.to_json()["details"]["issues"]
                    .as_array()
                    .is_some_and(|i| !i.is_empty())
            );
        }
        let e = d
            .merge(&json!({ "maxConcurrent": 9, "extra": 1 }))
            .unwrap_err();
        assert_eq!(
            e.to_json()["details"]["issues"].as_array().unwrap().len(),
            2
        );
    }
}
