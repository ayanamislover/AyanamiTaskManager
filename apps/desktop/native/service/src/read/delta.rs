//! 增量变化（02 §4.3，D26；00 02 C-04）。
//!
//! - 给 `since_seq`：`seq > since` 升序，`limit` 夹到 1–100，多取一条判断 `has_more`；
//! - 不给：最近 `limit` 条（升序返回），`since_seq` 换算成首条 −1，带 `window:"latest"`；
//! - 预算按实际返回推进 `next_seq`（不是 `current_sequence`，S-063）；单条放不下时越过它并给出 REST 回取路径（S-064）；
//! - 续读参数带上 `types`（C-04）。

use super::codec::{js_len, jsify};
use super::present::present;
use super::views::parse_json;
use super::{Ctx, db};
use crate::write::Service;
use atm_domain::capability::Capability;
use atm_domain::error::DomainError;
use atm_domain::principal::Principal;
use rusqlite::params_from_iter;
use rusqlite::types::Value as Sql;
use serde_json::{Map, Value, json};

#[derive(Clone, Debug)]
pub struct DeltaRequest {
    pub since_seq: Option<i64>,
    pub limit: usize,
    pub types: Vec<String>,
    pub max_chars: usize,
}

impl Default for DeltaRequest {
    fn default() -> Self {
        DeltaRequest {
            since_seq: None,
            limit: 50,
            types: Vec::new(),
            max_chars: 12_000,
        }
    }
}

/// 服务层的一页事件（呈现之后）。
pub(crate) struct Events {
    pub events: Vec<Value>,
    pub has_more: bool,
}

/// seq、type、aggregate_id、actor_id、payload_json、created_at、op_id。
type EventRow = (
    i64,
    String,
    String,
    String,
    Option<String>,
    String,
    Option<String>,
);

/// 2.x `ProjectActivityReadModel.delta`。
pub(crate) fn events(
    cx: &Ctx<'_>,
    since: Option<i64>,
    limit: usize,
    types: &[String],
) -> Result<Events, DomainError> {
    let bounded = limit.clamp(1, 100);
    let mut sql = String::from(
        "SELECT seq, type, aggregate_id, actor_id, payload_json, created_at, op_id FROM events WHERE project_id = ?",
    );
    let mut args = vec![Sql::Text(cx.p.id.clone())];
    if let Some(s) = since {
        sql.push_str(" AND seq > ?");
        args.push(Sql::Integer(s));
    }
    if !types.is_empty() {
        sql.push_str(&format!(
            " AND type IN ({})",
            vec!["?"; types.len()].join(", ")
        ));
        args.extend(types.iter().cloned().map(Sql::Text));
    }
    let take = if since.is_some() {
        bounded + 1
    } else {
        bounded
    };
    sql.push_str(if since.is_some() {
        " ORDER BY seq ASC LIMIT ?"
    } else {
        " ORDER BY seq DESC LIMIT ?"
    });
    args.push(Sql::Integer(take as i64));
    let mut rows: Vec<EventRow> = cx
        .tx
        .prepare(&sql)
        .map_err(db)?
        .query_map(params_from_iter(args), |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
            ))
        })
        .map_err(db)?
        .collect::<rusqlite::Result<_>>()
        .map_err(db)?;
    if since.is_none() {
        rows.reverse();
    }
    let has_more = rows.len() > bounded;
    let events = rows
        .into_iter()
        .take(bounded)
        .map(|(seq, kind, aggregate, actor, payload, at, op_id)| {
            let payload = match parse_json(payload, json!({})) {
                Value::Object(m) => m,
                _ => Map::new(),
            };
            let shown = present(&kind, Some(&aggregate), Some(&actor), &payload);
            let mut e = Map::new();
            e.insert("seq".into(), json!(seq));
            e.insert("type".into(), json!(kind));
            e.insert("key".into(), json!(shown.key));
            e.insert("summary".into(), json!(shown.detail));
            e.insert("actor".into(), json!(shown.actor));
            e.insert("title".into(), json!(shown.title));
            e.insert("detail".into(), json!(shown.detail));
            if let Some(changes @ Value::Object(_)) = payload.get("changes") {
                e.insert("changes".into(), changes.clone());
            }
            e.insert("op_id".into(), json!(op_id));
            e.insert("at".into(), json!(at));
            jsify(Value::Object(e))
        })
        .collect();
    Ok(Events { events, has_more })
}

fn rest_path(code: &str, seq: i64) -> String {
    format!(
        "/api/v1/projects/{code}/events?since={}&limit=1",
        (seq - 1).max(0)
    )
}

/// 2.x `fitDelta`。
pub(crate) fn fit(
    cx: &Ctx<'_>,
    since: i64,
    r: &DeltaRequest,
    max_chars: usize,
    page: &Events,
) -> Value {
    let events = &page.events;
    let project = if events.is_empty() {
        json!({ "code": cx.p.code })
    } else {
        json!({ "code": cx.p.code, "name": cx.p.name })
    };
    let continuation = |next: i64| {
        let mut args = Map::new();
        args.insert("project".into(), json!(cx.p.code));
        args.insert("since_seq".into(), json!(next));
        args.insert("limit".into(), json!(r.limit));
        args.insert("max_chars".into(), json!(r.max_chars));
        if !r.types.is_empty() {
            args.insert("types".into(), json!(r.types));
        }
        json!({ "tool": "atm_delta", "arguments": args })
    };
    for count in (0..=events.len()).rev() {
        let returned = &events[..count];
        let next_seq = returned
            .last()
            .and_then(|e| e["seq"].as_i64())
            .unwrap_or(since);
        let budget_truncated = count < events.len();
        let has_more = budget_truncated || page.has_more;
        let mut c = Map::new();
        c.insert("project".into(), project.clone());
        c.insert("since_seq".into(), json!(since));
        c.insert("requested_limit".into(), json!(r.limit));
        c.insert("returned_count".into(), json!(count));
        c.insert("events".into(), Value::Array(returned.to_vec()));
        c.insert("current_sequence".into(), json!(cx.p.seq));
        c.insert("next_seq".into(), json!(next_seq));
        c.insert("has_more".into(), json!(has_more));
        c.insert("truncated".into(), json!(budget_truncated));
        if budget_truncated {
            c.insert(
                "truncated_collections".into(),
                json!([{ "path": "events", "original_items": events.len(), "returned_items": count }]),
            );
        }
        if has_more {
            c.insert("continuation".into(), continuation(next_seq));
        }
        if count == 0 && !events.is_empty() {
            let first = &events[0];
            let seq = first["seq"].as_i64().unwrap_or(since);
            let following = events.len() > 1 || page.has_more;
            c.insert("next_seq".into(), json!(seq));
            c.insert("has_more".into(), json!(following));
            c.insert(
                "oversized_event".into(),
                json!({
                    "seq": seq,
                    "type": first["type"],
                    "key": first["key"],
                    "op_id": first["op_id"],
                    "chars": js_len(first),
                    "continuation": {
                        "transport": "REST", "method": "GET", "authentication": "daemon_bearer",
                        "path": rest_path(&cx.p.code, seq),
                    },
                }),
            );
            if following {
                c.insert("continuation".into(), continuation(seq));
            } else {
                c.remove("continuation");
            }
        }
        let candidate = Value::Object(c);
        if js_len(&candidate) <= max_chars {
            return candidate;
        }
    }
    let first = events.first();
    let mut m = Map::new();
    m.insert("project".into(), project);
    m.insert("since_seq".into(), json!(since));
    m.insert("requested_limit".into(), json!(r.limit));
    m.insert("returned_count".into(), json!(0));
    m.insert("events".into(), json!([]));
    m.insert("current_sequence".into(), json!(cx.p.seq));
    m.insert(
        "next_seq".into(),
        json!(first.and_then(|e| e["seq"].as_i64()).unwrap_or(since)),
    );
    m.insert(
        "has_more".into(),
        json!(if first.is_none() {
            page.has_more
        } else {
            events.len() > 1 || page.has_more
        }),
    );
    m.insert("truncated".into(), json!(!events.is_empty()));
    if let Some(e) = first {
        let seq = e["seq"].as_i64().unwrap_or(since);
        m.insert(
            "oversized_event".into(),
            json!({
                "seq": seq,
                "continuation": {
                    "transport": "REST", "method": "GET", "authentication": "daemon_bearer",
                    "path": rest_path(&cx.p.code, seq),
                },
            }),
        );
    }
    Value::Object(m)
}

impl Service {
    /// atm_delta（S-061～S-064；00 02 C-04）。
    pub fn delta(
        &self,
        principal: &Principal,
        project: &str,
        r: &DeltaRequest,
    ) -> Result<Value, DomainError> {
        self.read_project(principal, Capability::EventsRead, project, |cx| {
            let max_chars = r.max_chars.clamp(1000, 50_000);
            let page = events(cx, r.since_seq, r.limit, &r.types)?;
            if let Some(since) = r.since_seq {
                return Ok(fit(cx, since, r, max_chars, &page));
            }
            // 最新窗口：起点换算成等价的 since_seq，之后与带 since_seq 的请求同构。
            let window_start = page
                .events
                .first()
                .and_then(|e| e["seq"].as_i64())
                .map_or(cx.p.seq, |s| (s - 1).max(0));
            // 追加的 `,"window":"latest"` 占 18 个字符。
            let mut out = fit(cx, window_start, r, max_chars.saturating_sub(18), &page);
            if let Value::Object(m) = &mut out {
                m.insert("window".into(), json!("latest"));
            }
            Ok(out)
        })
    }
}
