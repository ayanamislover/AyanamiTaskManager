//! 快照（2.x `packages/sync/src/snapshot.ts`）：把 ATM 的项目与任务映射成 docs/mobile-sync.md §5 的
//! `ProjectDoc` / `ProjectHead`。读用 System `sync.loop` 主体，经界面同一套读接口（形状与 2.x 的
//! `WorkItemView` 相同）。
//!
//! 摘要是规范化 JSON（键按字典序、数按 JS 的写法）的 sha256：同样的内容永远得到同样的摘要，摘要没变就不写。

use std::cmp::Ordering;

use atm_domain::error::ErrorCode;
use atm_domain::principal::{JobId, Principal};
use atm_domain::time::Timestamp;
use atm_service::ui::WorkItemFilter;
use atm_sync_protocol::crypto::sha256_hex;
use atm_sync_protocol::encoding::js_trim;
use atm_sync_protocol::keys::is_task_key;
use atm_sync_protocol::schema::{TASK_PRIORITIES, TASK_STATUSES, TASK_TYPES};
use serde_json::{Map, Value, json};

use crate::dispatch::{DispatchPort, DispatchRun};
use crate::errors::Failure;
use crate::host::Host;
use crate::text::clip_text;

/// 已关闭任务只带最近 14 天内的，至多 30 个，且不带详情字段（派单结果照带）。
pub const CLOSED_WINDOW_MS: i64 = 14 * 24 * 60 * 60 * 1000;
pub const CLOSED_LIMIT: usize = 30;
/// 协议上限 5000 张卡片，给已关闭的留出余量。
pub const OPEN_TASK_LIMIT: usize = 4900;

const TITLE: usize = 500;
const PROJECT_NAME: usize = 200;
const DESC: usize = 2000;
const ACCEPTANCE: usize = 12;
const ACCEPTANCE_ITEM: usize = 500;
const REASON: usize = 500;
const AGENT: usize = 128;
const RECENT: i64 = 3;
const SUMMARY: usize = 500;
const DISPATCH_ERROR: usize = 200;

pub fn reader() -> Principal {
    Principal::system_job(JobId::SyncLoop)
}

// ─── 规范化 JSON ───

/// JS `Number.prototype.toString`（JSON.stringify 的数）。
pub fn js_number_text(n: f64) -> String {
    if !n.is_finite() {
        return "null".to_owned();
    }
    if n == 0.0 {
        return "0".to_owned();
    }
    // 安全整数照原样；更大的整数 JS 也是最短的有效数字再补零（下面的一般情形）。
    if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 {
        return format!("{}", n as i64);
    }
    // `{:e}` 给出最短的往返数字：`d.ddde±x`。
    let exp_form = format!("{:e}", n.abs());
    let (mantissa, exp) = exp_form.split_once('e').unwrap_or((&exp_form, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let e: i32 = exp.parse().unwrap_or(0);
    let k = digits.len() as i32;
    let point = e + 1;
    let sign = if n < 0.0 { "-" } else { "" };
    let body = if k <= point && point <= 21 {
        format!("{digits}{}", "0".repeat((point - k) as usize))
    } else if 0 < point && point <= 21 {
        format!(
            "{}.{}",
            &digits[..point as usize],
            &digits[point as usize..]
        )
    } else if -6 < point && point <= 0 {
        format!("0.{}{digits}", "0".repeat((-point) as usize))
    } else {
        let tail = if k > 1 {
            format!(".{}", &digits[1..])
        } else {
            String::new()
        };
        let sign_e = if point > 0 { "+" } else { "-" };
        format!("{}{tail}e{sign_e}{}", &digits[..1], (point - 1).abs())
    };
    format!("{sign}{body}")
}

/// JS 的字符串比较（`<`）：按 UTF-16 码元。
fn utf16_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

fn write_canonical(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&js_number_text(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => out.push_str(&serde_json::to_string(s).unwrap_or_default()),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| utf16_cmp(a, b));
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).unwrap_or_default());
                out.push(':');
                write_canonical(&map[k.as_str()], out);
            }
            out.push('}');
        }
    }
}

/// 规范化 JSON：键按字典序（UTF-16），数按 JS 的写法。同样的内容永远得到同样的字符串。
pub fn canonical_json(v: &Value) -> String {
    let mut out = String::new();
    write_canonical(v, &mut out);
    out
}

pub fn content_digest(v: &Value) -> String {
    sha256_hex(canonical_json(v).as_bytes())
}

/// 2.x `localeCompare` 给项目码排序：项目码只有 `A-Z 0-9 _ -`，ICU 的根排序里是 `_` < `-` < 数字 < 字母。
pub fn code_order(a: &str, b: &str) -> Ordering {
    let weight = |c: u8| -> u16 {
        match c {
            b'_' => 0,
            b'-' => 1,
            b'0'..=b'9' => 2 + u16::from(c - b'0'),
            _ => 100 + u16::from(c),
        }
    };
    a.bytes().map(weight).cmp(b.bytes().map(weight))
}

/// JS 数：整数值写成整数（`progress` 这类字段从库里读出来是浮点）。
pub fn js_value(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 {
        Value::from(n as i64)
    } else {
        serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
    }
}

// ─── 卡片 ───

fn one_of(values: &[&str], value: Option<&str>, fallback: &str) -> String {
    match value {
        Some(v) if values.contains(&v) => v.to_owned(),
        _ => fallback.to_owned(),
    }
}

fn str_field<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

/// JS 的「真值字符串」：存在且非空。
fn truthy<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    str_field(v, k).filter(|s| !s.is_empty())
}

const IN_PROGRESS: [&str; 3] = ["CLAIMED", "IN_PROGRESS", "VERIFYING"];

fn base_card(item: &Value) -> Map<String, Value> {
    let status = one_of(TASK_STATUSES, str_field(item, "status"), "BACKLOG");
    let progress = item
        .get("progress")
        .and_then(Value::as_f64)
        .filter(|p| p.is_finite())
        .unwrap_or(0.0)
        .clamp(0.0, 100.0);
    let mut card = Map::new();
    card.insert(
        "key".into(),
        json!(str_field(item, "key").unwrap_or_default()),
    );
    card.insert(
        "title".into(),
        json!(clip_text(
            str_field(item, "title").unwrap_or_default(),
            TITLE
        )),
    );
    card.insert(
        "type".into(),
        json!(one_of(TASK_TYPES, str_field(item, "type"), "TASK")),
    );
    card.insert("status".into(), json!(status));
    card.insert(
        "priority".into(),
        json!(one_of(
            TASK_PRIORITIES,
            str_field(item, "priority"),
            "NORMAL"
        )),
    );
    card.insert("progress".into(), js_value(progress));
    card.insert(
        "updatedAt".into(),
        json!(str_field(item, "updatedAt").unwrap_or_default()),
    );
    if let Some(parent) = truthy(item, "parentKey").filter(|p| is_task_key(p)) {
        card.insert("parent".into(), json!(parent));
    }
    if matches!(status.as_str(), "WAITING_USER" | "WAITING_AGENT")
        && let Some(w) = truthy(item, "waitingFor")
    {
        card.insert("waiting".into(), json!(clip_text(w, REASON)));
    }
    if status == "BLOCKED" {
        // `blockedReason ?? progressBreakdown.blocker`：null 才退到第二个，空串照样算有（然后被真值判断挡掉）。
        let reason = match item.get("blockedReason") {
            Some(Value::String(s)) => Some(s.as_str()),
            _ => item
                .get("progressBreakdown")
                .and_then(|b| b.get("blocker"))
                .and_then(Value::as_str),
        };
        if let Some(r) = reason.filter(|r| !r.is_empty()) {
            card.insert("blocked".into(), json!(clip_text(r, REASON)));
        }
    }
    card
}

/// 只有失败的派单带原因（例如「Claude Code 未登录…」），截到 200；其它状态不带。
fn dispatch_card(run: &DispatchRun) -> Value {
    let mut out = Map::new();
    out.insert("state".into(), json!(run.state));
    out.insert("at".into(), json!(run.at));
    out.insert("run".into(), json!(clip_text(&run.run, 64)));
    if run.state == "failed"
        && let Some(e) = run.error.as_deref().map(js_trim).filter(|e| !e.is_empty())
    {
        out.insert("error".into(), json!(clip_text(e, DISPATCH_ERROR)));
    }
    Value::Object(out)
}

fn with_dispatch(
    mut card: Map<String, Value>,
    code: &str,
    dispatch: Option<&dyn DispatchPort>,
) -> Value {
    let key = card
        .get("key")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if let Some(run) = dispatch.and_then(|d| d.run_for_task(code, &key)) {
        card.insert("dispatch".into(), dispatch_card(&run));
    }
    Value::Object(card)
}

fn open_card(host: &Host, code: &str, item: &Value) -> Result<Value, Failure> {
    let mut card = base_card(item);
    let key = str_field(item, "key").unwrap_or_default();
    let detail = match host.service()?.ui_work_item(&reader(), code, key) {
        Ok(d) => d,
        // 列表与详情之间任务被归档了：只发基本卡片，下一次变化事件会再重建。
        Err(e) if e.code == ErrorCode::WORK_ITEM_NOT_FOUND => return Ok(Value::Object(card)),
        Err(e) => return Err(e.into()),
    };
    if truthy(&detail, "claimedBySessionId").is_some() {
        let agent = detail
            .get("executionSession")
            .and_then(|s| truthy(s, "agent_id"))
            .unwrap_or("未知 Agent");
        let since = match detail.get("lastStartedAt") {
            Some(Value::String(s)) => Some(s.as_str()),
            _ => str_field(&detail, "everClaimedAt"),
        };
        let mut claim = Map::new();
        claim.insert("agent".into(), json!(clip_text(agent, AGENT)));
        if let Some(s) = since.filter(|s| !s.is_empty()) {
            claim.insert("since".into(), json!(s));
        }
        card.insert("claim".into(), Value::Object(claim));
    }
    let description = str_field(&detail, "description").unwrap_or_default();
    if !js_trim(description).is_empty() {
        card.insert("desc".into(), json!(clip_text(description, DESC)));
    }
    let acceptance: Vec<Value> = detail
        .get("acceptance")
        .and_then(Value::as_array)
        .map(|a| a.as_slice())
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .filter(|a| !js_trim(a).is_empty())
        .take(ACCEPTANCE)
        .map(|a| json!(clip_text(a, ACCEPTANCE_ITEM)))
        .collect();
    if !acceptance.is_empty() {
        card.insert("acceptance".into(), Value::Array(acceptance));
    }
    let counted: Vec<&str> = detail
        .get("checklist")
        .and_then(Value::as_array)
        .map(|a| a.as_slice())
        .unwrap_or_default()
        .iter()
        .filter_map(|c| str_field(c, "status"))
        .filter(|s| *s != "SKIPPED")
        .collect();
    if !counted.is_empty() {
        let done = counted.iter().filter(|s| **s == "DONE").count();
        card.insert(
            "checklist".into(),
            json!({ "done": done, "total": counted.len() }),
        );
    }
    let recent = host
        .service()?
        .ui_recent_progress(&reader(), code, key, RECENT)?;
    if !recent.is_empty() {
        let entries: Vec<Value> = recent
            .iter()
            .take(RECENT as usize)
            .map(|p| {
                let mut e = Map::new();
                e.insert(
                    "at".into(),
                    json!(str_field(p, "created_at").unwrap_or_default()),
                );
                e.insert(
                    "summary".into(),
                    json!(clip_text(
                        str_field(p, "summary").unwrap_or_default(),
                        SUMMARY
                    )),
                );
                if let Some(pct) = p.get("percent").and_then(Value::as_f64) {
                    e.insert("percent".into(), js_value(pct.clamp(0.0, 100.0)));
                }
                Value::Object(e)
            })
            .collect();
        card.insert("recent".into(), Value::Array(entries));
    }
    Ok(with_dispatch(card, code, host.dispatch()?))
}

/// 一个项目的快照。`body` 是项目文档里除 `at` 以外的部分，摘要就按它算。
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectSnapshot {
    pub body: Value,
    pub digest: String,
    pub counts: Value,
    /// 最近一次任务变化时间；项目里一个任务都没有时为 `None`。
    pub updated_at: Option<String>,
}

fn all_open(host: &Host, code: &str) -> Result<Vec<Value>, Failure> {
    let mut out = Vec::new();
    let mut cursor = None;
    loop {
        let filter = WorkItemFilter {
            closed: Some(false),
            limit: Some(100),
            cursor: cursor.take(),
            ..Default::default()
        };
        let page = host.service()?.ui_work_items(&reader(), code, &filter)?;
        out.extend(page["items"].as_array().cloned().unwrap_or_default());
        if out.len() >= OPEN_TASK_LIMIT || page["hasMore"] != Value::Bool(true) {
            break;
        }
        cursor = page["nextCursor"].as_str().map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    out.truncate(OPEN_TASK_LIMIT);
    Ok(out)
}

/// 读一个项目：全部未关闭任务（带详情）+ 14 天内关闭的至多 30 个（不带详情，只带派单结果）。
pub fn build_project_snapshot(
    host: &Host,
    code: &str,
    name: &str,
    now_ms: i64,
) -> Result<ProjectSnapshot, Failure> {
    let open = all_open(host, code)?;
    let closed_page =
        host.service()?
            .ui_closed_work_items(&reader(), code, Some(CLOSED_LIMIT), None)?;
    let cutoff = now_ms - CLOSED_WINDOW_MS;
    let closed: Vec<Value> = closed_page["items"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|item| {
            str_field(item, "updatedAt")
                .and_then(Timestamp::parse)
                .is_some_and(|t| t.millis() >= cutoff)
        })
        .collect();
    let mut tasks = Vec::with_capacity(open.len() + closed.len());
    for item in &open {
        tasks.push(open_card(host, code, item)?);
    }
    let dispatch = host.dispatch()?;
    for item in &closed {
        tasks.push(with_dispatch(base_card(item), code, dispatch));
    }
    let status_count = |items: &[Value], f: &dyn Fn(&str) -> bool| {
        items
            .iter()
            .filter(|i| str_field(i, "status").is_some_and(f))
            .count()
    };
    let counts = json!({
        "active": open.len(),
        "ready": status_count(&open, &|s| s == "READY"),
        "inProgress": status_count(&open, &|s| IN_PROGRESS.contains(&s)),
        "blocked": status_count(&open, &|s| s == "BLOCKED"),
        "waitingUser": status_count(&open, &|s| s == "WAITING_USER"),
        "doneRecent": status_count(&closed, &|s| s == "DONE"),
    });
    let updated_at = tasks
        .iter()
        .filter_map(|t| str_field(t, "updatedAt"))
        .max_by(|a, b| utf16_cmp(a, b))
        .map(str::to_owned);
    let body = json!({
        "v": 1,
        "code": code,
        "name": clip_text(name, PROJECT_NAME),
        "tasks": tasks,
    });
    Ok(ProjectSnapshot {
        digest: content_digest(&body),
        body,
        counts,
        updated_at,
    })
}

pub fn project_head_of(snapshot: &ProjectSnapshot, hash: &str, fallback_at: &str) -> Value {
    json!({
        "code": snapshot.body["code"],
        "name": snapshot.body["name"],
        "h": hash,
        "d": snapshot.digest,
        "counts": snapshot.counts,
        "updatedAt": snapshot.updated_at.as_deref().unwrap_or(fallback_at),
    })
}

/// head 除 `at` 以外的部分与它的摘要。项目按项目码排序，摘要不受发布顺序影响。
pub fn build_head_body(host: Value, dispatch: Value, mut projects: Vec<Value>) -> (Value, String) {
    projects.sort_by(|a, b| {
        code_order(
            a["code"].as_str().unwrap_or_default(),
            b["code"].as_str().unwrap_or_default(),
        )
    });
    let body = json!({ "v": 1, "host": host, "dispatch": dispatch, "projects": projects });
    let digest = content_digest(&body);
    (body, digest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_like_javascript() {
        let cases = [
            (0.0, "0"),
            (-0.0, "0"),
            (50.0, "50"),
            (33.333333333333336, "33.333333333333336"),
            (0.1, "0.1"),
            (1e21, "1e+21"),
            (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"),
            (123456789012345680000.0, "123456789012345680000"),
            (-2.5, "-2.5"),
            (f64::NAN, "null"),
        ];
        for (n, want) in cases {
            assert_eq!(js_number_text(n), want, "{n}");
        }
    }

    #[test]
    fn canonical_json_sorts_keys_and_skips_nothing_else() {
        let v = json!({"b": 1.0, "a": [true, null, {"d": "x\n", "c": 2.5}], "é": 0});
        assert_eq!(
            canonical_json(&v),
            r#"{"a":[true,null,{"c":2.5,"d":"x\n"}],"b":1,"é":0}"#
        );
    }

    #[test]
    fn codes_sort_like_icu() {
        let mut codes = vec!["B", "A1", "A-B", "A_B", "AB", "A"];
        codes.sort_by(|a, b| code_order(a, b));
        assert_eq!(codes, ["A", "A_B", "A-B", "A1", "AB", "B"]);
    }

    #[test]
    fn base_cards_follow_the_2x_mapping() {
        let item = json!({
            "key": "ATM-T-0001", "title": "t", "type": "WEIRD", "status": "BLOCKED", "priority": "HIGH",
            "progress": 150.0, "updatedAt": "2026-10-10T00:00:00.000Z", "parentKey": "nope",
            "blockedReason": null, "progressBreakdown": {"blocker": "等审批"},
        });
        let card = Value::Object(base_card(&item));
        assert_eq!(card["type"], "TASK");
        assert_eq!(card["progress"], json!(100));
        assert_eq!(card["blocked"], "等审批");
        assert!(card.get("parent").is_none());
        let empty_reason = json!({"key": "ATM-T-0001", "status": "BLOCKED", "blockedReason": "", "progressBreakdown": {"blocker": "x"}});
        assert!(
            Value::Object(base_card(&empty_reason))
                .get("blocked")
                .is_none()
        );
    }
}
