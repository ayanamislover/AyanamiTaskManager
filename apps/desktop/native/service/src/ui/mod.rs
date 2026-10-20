//! 界面的读（W5c）：React 界面消费的 2.0 形状（06 T-COMPAT）。
//!
//! Agent 的 MCP / REST 读给的是 snake_case 并按预算裁剪的回执；界面要的是 2.0 TS daemon 的原样形状：
//! camelCase、不裁剪、列表多是裸数组、分页是 `{items, nextCursor, hasMore}`。这里只做读，写入走与 Agent
//! 同一套服务入口（主体换成 User），回执的界面形状由 ui-bridge 组装。
//!
//! 能力检查与 Agent 读同一套（`Capability::*Read`）；User 都有。

mod lists;
mod projects;
mod work;

pub use work::WorkItemFilter;
pub(crate) use work::hydrated;

use atm_domain::error::DomainError;
use serde_json::{Map, Value, json};

/// `{items, nextCursor, hasMore}`：多取一条判断有没有下一页，`next` 由最后一条签发游标。
pub(crate) fn cursor_page(
    mut items: Vec<Value>,
    limit: usize,
    next: impl FnOnce(&Value) -> Result<String, DomainError>,
) -> Result<Value, DomainError> {
    let has_more = items.len() > limit;
    items.truncate(limit);
    let next_cursor = match (has_more, items.last()) {
        (true, Some(last)) => Value::String(next(last)?),
        _ => Value::Null,
    };
    Ok(json!({ "items": items, "nextCursor": next_cursor, "hasMore": has_more }))
}

/// `snake_case` 键 → `camelCase`。只改全是小写字母、数字、下划线的键（`LEASE_EXPIRED_ONLINE` 这类
/// 计数键原样保留）；`depth` 层以内的嵌套对象一起改，再往下（用户数据，如 saved view 的 query）不动。
/// 项目更新的写回执（#39 起草、#40 发布）：2.0 是 camelCase 的 `ProjectUpdateView` 加上 `seq`。
pub fn project_update_receipt(v: Value) -> Value {
    let mut v = camel(v, 1);
    if let Value::Object(m) = &mut v
        && let Some(seq) = m.remove("sequence")
    {
        m.insert("seq".into(), seq);
    }
    v
}

pub(crate) fn camel(v: Value, depth: usize) -> Value {
    match v {
        Value::Object(m) => Value::Object(
            m.into_iter()
                .map(|(k, v)| {
                    let v = if depth > 1 { camel(v, depth - 1) } else { v };
                    (camel_key(&k), v)
                })
                .collect::<Map<String, Value>>(),
        ),
        Value::Array(items) if depth > 0 => {
            Value::Array(items.into_iter().map(|v| camel(v, depth)).collect())
        }
        other => other,
    }
}

fn camel_key(key: &str) -> String {
    if !key
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    {
        return key.to_owned();
    }
    let mut out = String::with_capacity(key.len());
    let mut upper = false;
    for c in key.chars() {
        if c == '_' {
            upper = true;
        } else if upper {
            out.push(c.to_ascii_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn camel_keys_only_where_asked() {
        let v = json!({
            "agent_id": "a",
            "git": { "repo_root": "r", "is_linked_worktree": true },
            "counts": { "LEASE_EXPIRED_ONLINE": 1 },
            "items": [{ "task_key": "T", "query": { "a_b": 1 } }],
        });
        assert_eq!(
            camel(v, 2),
            json!({
                "agentId": "a",
                "git": { "repoRoot": "r", "isLinkedWorktree": true },
                "counts": { "LEASE_EXPIRED_ONLINE": 1 },
                "items": [{ "taskKey": "T", "query": { "a_b": 1 } }],
            })
        );
    }
}
