//! 写入的固定形状回执（02 §4.7；00 02 C-05、Q-05；R11 A3）。
//!
//! `{ok, op_id, project, session, session_rebound, replayed, entities, entity_count, entities_truncated, details_cursor}`：
//! - 去掉 2.x 的 `projection`（单库没有异步投影，Q-05）；
//! - `session` 与 `details_cursor.session` 用**回执所属**的 session（C-05）：rebind 时是后继，lineage 上的重放是
//!   写下回执的那个 session，所以 details_cursor 原样调用总能查到（修掉 X-10）；
//! - 实体按批次结束时的版本报，同一实体出现多次时取最后一个非 null 版本；预览最多 12 项、1800 字符。

use super::codec::{js_len, jsify};
use crate::write::{Service, Written};
use atm_domain::error::DomainError;
use rusqlite::OptionalExtension;
use serde_json::{Map, Value, json};

const PREVIEW_ITEMS: usize = 12;
const PREVIEW_CHARS: usize = 1800;

fn add(
    out: &mut Vec<Map<String, Value>>,
    entity_type: &str,
    key: &Value,
    version: &Value,
    state: Option<&Value>,
) {
    let Some(key) = key.as_str().filter(|k| !k.trim().is_empty()) else {
        return;
    };
    let mut m = Map::new();
    m.insert("entity_type".into(), json!(entity_type));
    m.insert("key".into(), json!(key));
    m.insert(
        "version".into(),
        version.as_i64().map_or(Value::Null, Value::from),
    );
    if let Some(state) = state.and_then(Value::as_object) {
        if let Some(s) = state.get("status").and_then(Value::as_str) {
            m.insert("status".into(), json!(s));
        }
        for (from, to) in [
            ("waitingOn", "waiting_on"),
            ("claimedBySessionId", "claimed_by_session_id"),
            ("claimLeaseUntil", "claim_lease_until"),
        ] {
            if let Some(v) = state.get(from).filter(|v| v.is_null() || v.is_string()) {
                m.insert(to.into(), v.clone());
            }
        }
    }
    out.push(m);
}

/// 从写入结果里取出被改动的实体（按 3.0 服务层的回执形状）。
pub(crate) fn entities(operation: &str, r: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    let null = Value::Null;
    match operation {
        "work.create.batch" | "work.patch.batch" => {
            for item in r["items"].as_array().into_iter().flatten() {
                add(
                    &mut out,
                    "WORK_ITEM",
                    &item["key"],
                    &item["version"],
                    Some(item),
                );
            }
        }
        "work.verify-and-complete" => {
            add(
                &mut out,
                "WORK_ITEM",
                &r["taskKey"],
                &r["taskVersion"],
                Some(&r["item"]),
            );
        }
        "review.request.create" => {
            let q = &r["request"];
            add(&mut out, "REVIEW_REQUEST", &q["key"], &null, None);
            add(&mut out, "WORK_ITEM", &q["reviewTaskKey"], &null, None);
            add(&mut out, "WORK_ITEM", &q["parentTaskKey"], &null, None);
            add(
                &mut out,
                "CHECKLIST",
                &q["parentChecklistId"],
                &q["parentChecklistVersion"],
                None,
            );
        }
        "review.submit" => {
            add(&mut out, "REVIEW_REQUEST", &r["requestKey"], &null, None);
            add(
                &mut out,
                "REVIEW_SUBMISSION",
                &r["submissionKey"],
                &null,
                None,
            );
            add(&mut out, "RECORD", &r["recordKey"], &null, None);
            add(
                &mut out,
                "WORK_ITEM",
                &r["reviewTask"]["key"],
                &r["reviewTask"]["version"],
                Some(&r["reviewTask"]),
            );
            add(
                &mut out,
                "CHECKLIST",
                &r["parentChecklist"]["id"],
                &r["parentChecklist"]["version"],
                None,
            );
            add(
                &mut out,
                "WORK_ITEM",
                &r["parentTask"]["key"],
                &r["parentTask"]["version"],
                Some(&r["parentTask"]),
            );
        }
        "checklist.update" => {
            add(
                &mut out,
                "WORK_ITEM",
                &r["taskKey"],
                &r["taskVersion"],
                None,
            );
            add(
                &mut out,
                "CHECKLIST",
                &r["checklist"]["id"],
                &r["checklist"]["version"],
                None,
            );
        }
        "checklist.update.batch" => {
            add(
                &mut out,
                "WORK_ITEM",
                &r["taskKey"],
                &r["taskVersion"],
                None,
            );
            for c in r["checklist"].as_array().into_iter().flatten() {
                add(&mut out, "CHECKLIST", &c["id"], &c["version"], None);
            }
        }
        "work.progress" => {
            add(
                &mut out,
                "WORK_ITEM",
                &r["taskKey"],
                &r["taskVersion"],
                Some(&r["state"]),
            );
            add(&mut out, "PROGRESS", &r["progressId"], &null, None);
        }
        "project-update.publish" => {
            add(
                &mut out,
                "PROJECT_UPDATE",
                &r["projectUpdateId"],
                &null,
                None,
            );
        }
        "record.create" => {
            add(
                &mut out,
                "RECORD",
                &r["record"]["key"],
                &r["record"]["version"],
                None,
            );
        }
        "session.end" => {
            add(&mut out, "SESSION", &r["session"], &null, None);
            for item in r["releasedItems"].as_array().into_iter().flatten() {
                add(&mut out, "WORK_ITEM", &item["key"], &item["version"], None);
            }
        }
        "quick.create" | "quick.update" => {
            add(
                &mut out,
                "QUICK_TASK",
                &r["quick"]["key"],
                &r["quick"]["version"],
                None,
            );
        }
        "quick.promote" => {
            add(
                &mut out,
                "QUICK_TASK",
                &r["quick"]["key"],
                &r["quick"]["version"],
                None,
            );
            add(
                &mut out,
                "WORK_ITEM",
                &r["quick"]["promotedWorkItemKey"],
                &null,
                None,
            );
        }
        _ => {}
    }
    unique(out)
}

/// 同一实体只留一条：位置取首次出现，版本取最后一个非 null。
fn unique(list: Vec<Map<String, Value>>) -> Vec<Value> {
    let mut out: Vec<Map<String, Value>> = Vec::new();
    for e in list {
        match out
            .iter_mut()
            .find(|o| o["entity_type"] == e["entity_type"] && o["key"] == e["key"])
        {
            Some(prev) => {
                if !e["version"].is_null() {
                    *prev = e;
                }
            }
            None => out.push(e),
        }
    }
    out.into_iter().map(Value::Object).collect()
}

fn preview(list: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    let mut chars = 2;
    for e in list {
        if out.len() >= PREVIEW_ITEMS {
            break;
        }
        let cost = js_len(e) + usize::from(!out.is_empty());
        if chars + cost > PREVIEW_CHARS {
            break;
        }
        out.push(e.clone());
        chars += cost;
    }
    out
}

impl Service {
    /// 写入的固定形状回执。`requested_session` 是请求里的 session（没有回执所属 session 时用它）。
    pub fn mutation_ack(
        &self,
        project_code: &str,
        operation: &str,
        op_id: &str,
        requested_session: Option<&str>,
        written: &Written,
    ) -> Result<Value, DomainError> {
        let receipt_session: Option<String> = if written.receipt_id > 0 {
            let id = written.receipt_id;
            self.store()
                .read(move |tx| {
                    tx.query_row(
                        "SELECT COALESCE(author_session, CASE WHEN ns_kind = 'SESSION' THEN ns_id END, actor_session_id)
                         FROM idempotency_receipts WHERE receipt_id = ?1",
                        [id],
                        |r| r.get::<_, Option<String>>(0),
                    )
                    .optional()
                    .map(Option::flatten)
                })
                .map_err(|e| crate::write::internal(format!("{e:?}")))?
        } else {
            None
        };
        let session = written
            .rebound_to
            .clone()
            .or(receipt_session)
            .or_else(|| requested_session.map(str::to_owned));
        let project = atm_domain::keys::normalize(project_code);
        let all = entities(operation, &written.result);
        let shown = preview(&all);
        Ok(jsify(json!({
            "ok": true,
            "op_id": op_id,
            "project": project,
            "session": session,
            "session_rebound": written.rebound_to.is_some(),
            "replayed": written.replayed,
            "entities": shown,
            "entity_count": all.len(),
            "entities_truncated": shown.len() < all.len(),
            "details_cursor": {
                "name": "atm_search",
                "arguments": {
                    "project": project,
                    "op_id": op_id,
                    "session": session,
                    "field_mask": ["op_id", "entities"],
                    "max_chars": 50_000,
                },
            },
        })))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique_keeps_the_first_position_and_the_last_version() {
        let r = json!({ "items": [
            { "key": "ATM-T-0001", "version": 1, "status": "CLAIMED" },
            { "key": "ATM-T-0002", "version": 4 },
            { "key": "ATM-T-0001", "version": 2, "status": "IN_PROGRESS" },
        ]});
        let e = entities("work.patch.batch", &r);
        assert_eq!(e.len(), 2);
        assert_eq!(
            (e[0]["key"].clone(), e[0]["version"].clone()),
            (json!("ATM-T-0001"), json!(2))
        );
        assert_eq!(e[0]["status"], "IN_PROGRESS");
        // 后来的 null 版本不覆盖已有的版本。
        let r = json!({ "request": { "key": "ATM-RV-1", "reviewTaskKey": "ATM-T-0003" },
                        "items": [] });
        let e = entities("review.request.create", &r);
        assert_eq!(e[1]["version"], Value::Null);
    }

    #[test]
    fn quick_operations_name_their_entities() {
        let q = json!({ "quick": { "key": "Q-0003", "version": 2, "promotedWorkItemKey": "ATM-T-0009" } });
        for op in ["quick.create", "quick.update"] {
            let e = entities(op, &q);
            assert_eq!(e.len(), 1, "{op}");
            assert_eq!(
                (&e[0]["entity_type"], &e[0]["key"], &e[0]["version"]),
                (&json!("QUICK_TASK"), &json!("Q-0003"), &json!(2))
            );
        }
        let e = entities("quick.promote", &q);
        assert_eq!(e.len(), 2);
        assert_eq!(e[1]["entity_type"], "WORK_ITEM");
        assert_eq!(e[1]["key"], "ATM-T-0009");
    }

    #[test]
    fn preview_is_bounded_by_items_and_chars() {
        let small: Vec<Value> = (0..20).map(|i| json!({ "k": i })).collect();
        assert_eq!(preview(&small).len(), 12);
        let big: Vec<Value> = (0..5).map(|_| json!({ "k": "x".repeat(700) })).collect();
        assert_eq!(preview(&big).len(), 2);
    }
}
