//! brief：精选工作集（02 §4.1–4.2，D24、D25、D27；00 02 C-10、C-12、C-16、C-17；10 R2、R4′）。
//!
//! 快照全部是读，无副作用。与 2.x 的差异（都是裁决过的）：
//! - milestone 取活动 objective 下的活动 milestone（C-10）；
//! - 「自己的」任务与 currentTask 按 session 的 lineage 判断（R2：领取属于 lineage）；
//! - 交接除了「唯一同四元组的已关闭来源」，也展示 lineage 里祖先发出、仍待确认的交接（R4′）；
//! - 记录版本哈希不含 relatedRecords（C-12）；游标改为 `b4`，带范围世代并用库内密钥签名；
//! - 连身份都放不下时报 `RESULT_TOO_LARGE`，begin 例外（C-16）。

use super::codec::{b64, js_len, js_text, jsify, sha256};
use super::cursor::{self, BRIEF};
use super::delta;
use super::lists::READY_SQL;
use super::views::{self, TaskView};
use super::{Ctx, db, too_large};
use crate::write::{Service, Written};
use atm_domain::capability::Capability;
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::keys;
use atm_domain::principal::Principal;
use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value, json};

/// 分节名 → 载荷字段（2.x `briefSections`）。顺序也是 include 掩码的位序。
const SECTIONS: [(&str, &[&str]); 11] = [
    ("objective", &["objective", "milestone"]),
    (
        "counts",
        &["active", "blocked", "waitingUser", "waitingAgent"],
    ),
    ("own", &["own"]),
    ("next", &["next"]),
    ("records", &["records"]),
    ("current", &["currentTask"]),
    ("handoff", &["handoff"]),
    ("progress", &["recentProgress"]),
    ("artifacts", &["artifacts"]),
    ("task", &["task"]),
    ("delta", &["delta"]),
];

/// 装不下时的丢弃顺序（越靠前越先丢）。
const DROP_ORDER: [&str; 11] = [
    "artifacts",
    "records",
    "own",
    "counts",
    "objective",
    "next",
    "progress",
    "delta",
    "task",
    "current",
    "handoff",
];

const ALWAYS: [&str; 3] = ["truncated", "project", "seq"];
const TTL_MS: i64 = 30 * 60 * 1000;
const COMPACT_TASK: [&str; 15] = [
    "key",
    "title",
    "type",
    "status",
    "priority",
    "progress",
    "version",
    "description",
    "acceptance",
    "checklist",
    "dependencies",
    "blockedReason",
    "waitingFor",
    "discoveredFrom",
    "discovered",
];
const ESSENTIAL_TASK: [&str; 10] = [
    "key",
    "title",
    "type",
    "status",
    "priority",
    "progress",
    "version",
    "blockedReason",
    "waitingFor",
    "dependencies",
];

fn section_keys(name: &str) -> &'static [&'static str] {
    SECTIONS
        .iter()
        .find(|(n, _)| *n == name)
        .map_or(&[], |(_, keys)| keys)
}

/// atm_brief 的入参（02 §4.2）。
#[derive(Clone, Debug)]
pub struct BriefRequest {
    pub session: Option<String>,
    pub task_key: Option<String>,
    pub since_seq: Option<i64>,
    pub cursor: Option<String>,
    pub max_chars: usize,
    pub include: Vec<String>,
}

impl Default for BriefRequest {
    fn default() -> Self {
        BriefRequest {
            session: None,
            task_key: None,
            since_seq: None,
            cursor: None,
            max_chars: 1200,
            include: Vec::new(),
        }
    }
}

/// begin 附带的 brief 规模（02 S-060）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BeginBrief {
    None,
    Minimal,
    Full,
}

impl BeginBrief {
    pub fn parse(text: &str) -> Option<Self> {
        match text.trim().to_ascii_lowercase().as_str() {
            "none" => Some(BeginBrief::None),
            "minimal" => Some(BeginBrief::Minimal),
            "full" => Some(BeginBrief::Full),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            BeginBrief::None => "none",
            BeginBrief::Minimal => "minimal",
            BeginBrief::Full => "full",
        }
    }
}

fn parse_include(include: &[String]) -> Result<Vec<&'static str>, DomainError> {
    let mut out = Vec::new();
    for name in include {
        let t = name.trim().to_ascii_lowercase();
        let Some((n, _)) = SECTIONS.iter().find(|(n, _)| *n == t) else {
            return Err(DomainError::new(
                ErrorCode::INVALID_ARGUMENT,
                format!(
                    "include 只能是 {}",
                    SECTIONS
                        .iter()
                        .map(|(n, _)| *n)
                        .collect::<Vec<_>>()
                        .join(" / ")
                ),
            )
            .detail("field", "include")
            .detail("got", name.as_str()));
        };
        if !out.contains(n) {
            out.push(*n);
        }
    }
    Ok(out)
}

fn mask(include: &[&str]) -> i64 {
    SECTIONS
        .iter()
        .enumerate()
        .filter(|(_, (n, _))| include.is_empty() || include.contains(n))
        .fold(0, |m, (i, _)| m | (1 << i))
}

// ---------- 快照 ----------

struct Who {
    id: String,
    agent: Option<String>,
    role: Option<String>,
    cwd: Option<String>,
    thread: Option<String>,
    state: Option<String>,
    lineage: Vec<String>,
}

/// agent、role、cwd、thread、connection_state。
type SessionRow = (String, String, Option<String>, Option<String>, String);

fn who(cx: &Ctx<'_>, session: &str) -> Result<Who, DomainError> {
    let row: Option<SessionRow> = cx
        .tx
        .query_row(
            "SELECT agent_id, role, cwd, thread_id, connection_state FROM agent_sessions WHERE project_id = ?1 AND id = ?2",
            params![cx.p.id, session],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .map_err(db)?;
    // session 给了但不存在：不报错，按「无 session 身份」退化（02 §4.1）。
    let Some((agent, role, cwd, thread, state)) = row else {
        return Ok(Who {
            id: session.to_owned(),
            agent: None,
            role: None,
            cwd: None,
            thread: None,
            state: None,
            lineage: vec![session.to_owned()],
        });
    };
    let lineage = crate::lineage::lineage(cx.tx, &cx.p.id, session).map_err(db)?;
    Ok(Who {
        id: session.to_owned(),
        agent: Some(agent),
        role: Some(role),
        cwd,
        thread,
        state: Some(state),
        lineage,
    })
}

fn in_list(n: usize) -> String {
    vec!["?"; n].join(", ")
}

/// 可以把待确认交接展示给这个 session 的来源：lineage 里的其他 session（R4′），加上唯一一个同四元组的已关闭来源（2.x）。
fn pending_sources(cx: &Ctx<'_>, w: &Who) -> Result<Vec<String>, DomainError> {
    let Some(agent) = &w.agent else {
        return Ok(Vec::new());
    };
    let quad: Vec<String> = cx
        .tx
        .prepare_cached(
            "SELECT DISTINCT s.id FROM handoffs h
             JOIN agent_sessions s ON s.project_id = h.project_id AND s.id = h.from_session_id
             JOIN work_items i ON i.project_id = h.project_id AND i.id = h.work_item_id
             WHERE h.project_id = ?1 AND h.to_session_id IS NULL AND h.acknowledged_at IS NULL
               AND h.to_agent_id = ?2 AND s.agent_id = ?2 AND s.connection_state = 'CLOSED'
               AND s.cwd IS ?3 AND s.thread_id IS ?4 AND s.role = ?5
               AND i.status NOT IN ('DONE', 'CANCELLED')
             LIMIT 2",
        )
        .map_err(db)?
        .query_map(params![cx.p.id, agent, w.cwd, w.thread, w.role], |r| {
            r.get(0)
        })
        .map_err(db)?
        .collect::<rusqlite::Result<_>>()
        .map_err(db)?;
    let mut sources: Vec<String> = w.lineage.iter().filter(|s| **s != w.id).cloned().collect();
    if let [one] = quad.as_slice()
        && !sources.contains(one)
    {
        sources.push(one.clone());
    }
    Ok(sources)
}

/// 快照载荷（camelCase，2.x `BriefSnapshot`）与记录 key 列表。
fn snapshot(cx: &Ctx<'_>, session: Option<&str>) -> Result<Map<String, Value>, DomainError> {
    let tx = cx.tx;
    let pid = &cx.p.id;
    let objective: Option<(String, String)> = tx
        .query_row(
            "SELECT id, title FROM objectives WHERE project_id = ?1 AND status = 'ACTIVE' ORDER BY updated_at DESC, local_no DESC LIMIT 1",
            [pid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(db)?;
    let milestone: Option<String> = match &objective {
        Some((oid, _)) => tx
            .query_row(
                "SELECT title FROM milestones WHERE project_id = ?1 AND objective_id = ?2 AND status = 'ACTIVE'
                 ORDER BY sort_key, local_no LIMIT 1",
                params![pid, oid],
                |r| r.get(0),
            )
            .optional()
            .map_err(db)?,
        None => None,
    };
    let counts: (i64, i64, i64, i64) = tx
        .query_row(
            "SELECT COALESCE(SUM(status IN ('CLAIMED','IN_PROGRESS','VERIFYING')), 0),
                    COALESCE(SUM(status = 'BLOCKED'), 0), COALESCE(SUM(status = 'WAITING_USER'), 0),
                    COALESCE(SUM(status = 'WAITING_AGENT'), 0)
             FROM work_items WHERE project_id = ?1",
            [pid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(db)?;
    let ready: Vec<String> = tx
        .prepare_cached(&format!(
            "SELECT w.local_no FROM work_items w WHERE w.project_id = ?1 AND {READY_SQL}
             ORDER BY CASE w.priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END,
                      w.sort_key, w.created_at, w.local_no LIMIT 3"
        ))
        .map_err(db)?
        .query_map([pid], |r| r.get::<_, i64>(0))
        .map_err(db)?
        .map(|n| n.map(|n| views::task_key(cx, n)))
        .collect::<rusqlite::Result<_>>()
        .map_err(db)?;

    let who = match session {
        Some(s) => Some(who(cx, s)?),
        None => None,
    };
    let own: Vec<String> = match &who {
        Some(w) => {
            let sql = format!(
                "SELECT local_no FROM work_items WHERE project_id = ? AND claimed_by_session_id IN ({})
                 AND status NOT IN ('DONE','CANCELLED') ORDER BY updated_at DESC, local_no DESC LIMIT 5",
                in_list(w.lineage.len())
            );
            let mut args: Vec<&dyn rusqlite::ToSql> = vec![pid];
            args.extend(w.lineage.iter().map(|s| s as &dyn rusqlite::ToSql));
            tx.prepare(&sql)
                .map_err(db)?
                .query_map(args.as_slice(), |r| r.get::<_, i64>(0))
                .map_err(db)?
                .map(|n| n.map(|n| views::task_key(cx, n)))
                .collect::<rusqlite::Result<_>>()
                .map_err(db)?
        }
        None => Vec::new(),
    };

    // currentTask：本 lineage 领的 → 有发给本 session 的交接 → 有来自可展示来源的待确认交接 → 其他；再按更新时间。
    let (current, handoff) = match &who {
        Some(w) => {
            let sources = pending_sources(cx, w)?;
            let agent = w.agent.clone().unwrap_or_default();
            let sql = format!(
                "SELECT {} FROM work_items w WHERE w.project_id = ? AND w.status NOT IN ('DONE','CANCELLED')
                   AND (w.claimed_by_session_id IN ({lin}) OR w.assignee_agent_id = ?)
                 ORDER BY CASE
                   WHEN w.claimed_by_session_id IN ({lin}) THEN 0
                   WHEN EXISTS (SELECT 1 FROM handoffs h WHERE h.project_id = w.project_id AND h.work_item_id = w.id
                                AND h.to_session_id = ?) THEN 1
                   WHEN EXISTS (SELECT 1 FROM handoffs h WHERE h.project_id = w.project_id AND h.work_item_id = w.id
                                AND h.from_session_id IN ({src}) AND h.to_session_id IS NULL
                                AND h.acknowledged_at IS NULL AND h.to_agent_id = ?) THEN 2
                   ELSE 3 END, w.updated_at DESC, w.local_no DESC LIMIT 1",
                views::TASK_COLS
                    .split(',')
                    .map(|c| format!("w.{}", c.trim()))
                    .collect::<Vec<_>>()
                    .join(", "),
                lin = in_list(w.lineage.len()),
                src = if sources.is_empty() {
                    "NULL".to_owned()
                } else {
                    in_list(sources.len())
                },
            );
            let mut args: Vec<&dyn rusqlite::ToSql> = vec![pid];
            args.extend(w.lineage.iter().map(|s| s as &dyn rusqlite::ToSql));
            args.push(&agent);
            args.extend(w.lineage.iter().map(|s| s as &dyn rusqlite::ToSql));
            args.push(&w.id);
            args.extend(sources.iter().map(|s| s as &dyn rusqlite::ToSql));
            args.push(&agent);
            let row = tx
                .query_row(&sql, args.as_slice(), views::TaskRow::from_row)
                .optional()
                .map_err(db)?;
            let handoff = match (&row, &w.agent) {
                (Some(t), Some(agent)) => {
                    let sql = format!(
                        "SELECT h.summary, h.next_action, h.checkpoint_sequence FROM handoffs h
                         JOIN agent_sessions s ON s.project_id = h.project_id AND s.id = h.from_session_id
                         WHERE h.project_id = ? AND h.work_item_id = ?
                           AND (h.to_session_id = ? OR (h.to_session_id IS NULL AND h.acknowledged_at IS NULL
                                AND h.from_session_id IN ({src}) AND h.to_agent_id = ?))
                           AND s.agent_id = ? AND s.role = ?
                         ORDER BY CASE WHEN h.to_session_id IS NOT NULL THEN 0 ELSE 1 END,
                                  h.checkpoint_sequence DESC, h.created_at DESC LIMIT 1",
                        src = if sources.is_empty() {
                            "NULL".to_owned()
                        } else {
                            in_list(sources.len())
                        },
                    );
                    let role = w.role.clone().unwrap_or_default();
                    let mut args: Vec<&dyn rusqlite::ToSql> = vec![pid, &t.id, &w.id];
                    args.extend(sources.iter().map(|s| s as &dyn rusqlite::ToSql));
                    args.push(agent);
                    args.push(agent);
                    args.push(&role);
                    tx.query_row(&sql, args.as_slice(), |r| {
                        Ok(json!({
                            "summary": r.get::<_, String>(0)?,
                            "nextAction": r.get::<_, String>(1)?,
                            "checkpointSequence": r.get::<_, i64>(2)?,
                        }))
                    })
                    .optional()
                    .map_err(db)?
                }
                _ => None,
            };
            (row, handoff)
        }
        None => (None, None),
    };

    let records: Vec<Value> = tx
        .prepare_cached(
            "SELECT local_no, kind, summary, importance, source_type FROM records
             WHERE project_id = ?1 AND status = 'ACTIVE' AND scope NOT IN ('ATM_FEEDBACK')
               AND ((kind = 'CONSTRAINT' AND source_type = 'USER')
                 OR (kind IN ('DECISION','CONSTRAINT','FACT','RISK') AND importance IN ('HIGH','CRITICAL')))
             ORDER BY CASE WHEN source_type = 'USER' AND kind = 'CONSTRAINT' THEN 0 ELSE 1 END,
                      CASE importance WHEN 'CRITICAL' THEN 0 ELSE 1 END, updated_at DESC, local_no DESC
             LIMIT 8",
        )
        .map_err(db)?
        .query_map([pid], |r| {
            let kind: String = r.get(1)?;
            Ok(json!({
                "key": keys::record_key(&cx.p.code, views::record_letter(&kind), r.get(0)?),
                "kind": kind,
                "summary": r.get::<_, String>(2)?,
                "importance": r.get::<_, String>(3)?,
                "source_type": r.get::<_, String>(4)?,
            }))
        })
        .map_err(db)?
        .collect::<rusqlite::Result<_>>()
        .map_err(db)?;

    let (current_task, recent, artifacts) = match &current {
        Some(t) => {
            let claim = t.claimed_by.as_ref().map_or(
                Value::Null,
                |s| json!({ "session": s, "leaseUntil": t.lease }),
            );
            let task = json!({
                "key": views::task_key(cx, t.local_no),
                "title": t.title,
                "status": t.status,
                "version": t.version,
                "acceptance": serde_json::from_str::<Value>(&t.acceptance_json).unwrap_or(json!([])),
                "blockedReason": t.blocked_reason,
                "waitingFor": t.waiting_for,
                "dependencies": views::dependencies(cx, &t.id)?,
                "claim": claim,
            });
            let recent: Option<String> = tx
                .query_row(
                    "SELECT summary FROM progress_updates WHERE project_id = ?1 AND work_item_id = ?2
                     ORDER BY created_at DESC, id DESC LIMIT 1",
                    params![pid, t.id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(db)?;
            let artifacts: Vec<Value> = tx
                .prepare_cached(
                    "SELECT name, COALESCE(local_path, external_ref) FROM artifacts
                     WHERE project_id = ?1 AND work_item_id = ?2 ORDER BY created_at DESC, id DESC LIMIT 3",
                )
                .map_err(db)?
                .query_map(params![pid, t.id], |r| {
                    Ok(json!({ "name": r.get::<_, String>(0)?, "ref": r.get::<_, Option<String>>(1)? }))
                })
                .map_err(db)?
                .collect::<rusqlite::Result<_>>()
                .map_err(db)?;
            (task, recent, artifacts)
        }
        None => (Value::Null, None, Vec::new()),
    };

    let mut next: Vec<String> = Vec::new();
    if let Some(action) = handoff.as_ref().and_then(|h| h["nextAction"].as_str())
        && !action.is_empty()
    {
        next.push(action.to_owned());
    }
    for k in ready {
        if !next.contains(&k) {
            next.push(k);
        }
    }
    next.truncate(3);

    let mut m = Map::new();
    m.insert("truncated".into(), json!(false));
    m.insert("project".into(), json!(cx.p.code));
    m.insert("seq".into(), json!(cx.p.seq));
    m.insert("objective".into(), json!(objective.map(|(_, t)| t)));
    m.insert("milestone".into(), json!(milestone));
    m.insert("active".into(), json!(counts.0));
    m.insert("blocked".into(), json!(counts.1));
    m.insert("waitingUser".into(), json!(counts.2));
    m.insert("waitingAgent".into(), json!(counts.3));
    m.insert("own".into(), json!(own));
    m.insert("next".into(), json!(next));
    m.insert("records".into(), Value::Array(records));
    m.insert("currentTask".into(), current_task);
    m.insert("handoff".into(), handoff.unwrap_or(Value::Null));
    m.insert("recentProgress".into(), json!(recent));
    m.insert("artifacts".into(), Value::Array(artifacts));
    Ok(m)
}

/// 记录版本：紧凑记录去掉 related_records（C-12）后的 sha256 前 6 字节。
fn record_version(cx: &Ctx<'_>, key: &str) -> Result<Option<String>, DomainError> {
    let id = match views::record_id(cx, key) {
        Ok(id) => id,
        Err(e) if e.code == ErrorCode::RECORD_NOT_FOUND => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut v = jsify(views::record(cx, &id)?);
    if let Value::Object(m) = &mut v {
        m.remove("related_records");
    }
    Ok(Some(b64(&sha256(js_text(&v).as_bytes())[..6])))
}

fn record_keys(payload: &Map<String, Value>) -> Vec<String> {
    payload
        .get("records")
        .and_then(Value::as_array)
        .map(|rs| {
            rs.iter()
                .filter_map(|r| {
                    r["key"]
                        .as_str()
                        .filter(|k| !k.is_empty())
                        .map(str::to_owned)
                })
                .collect()
        })
        .unwrap_or_default()
}

// ---------- 游标 ----------

struct Target<'a> {
    session: Option<&'a str>,
    mask: i64,
    task_key: Option<&'a str>,
    since_seq: Option<i64>,
}

fn target_hash(cx: &Ctx<'_>, t: &Target<'_>) -> String {
    let v = json!([
        cx.p.id,
        t.session.unwrap_or(""),
        t.mask,
        t.task_key,
        t.since_seq
    ]);
    b64(&sha256(js_text(&v).as_bytes())[..8])
}

fn short_key(code: &str, key: &str) -> String {
    key.strip_prefix(&format!("{code}-"))
        .unwrap_or(key)
        .to_owned()
}

fn full_key(code: &str, short: &str) -> String {
    let b = short.as_bytes();
    if b.len() >= 3
        && b[0].is_ascii_uppercase()
        && b[1] == b'-'
        && b[2..].iter().all(u8::is_ascii_digit)
    {
        format!("{code}-{short}")
    } else {
        short.to_owned()
    }
}

struct Cursor {
    target: String,
    offset: usize,
    records: Vec<(String, String)>,
    seq: i64,
    expires: i64,
}

fn expiry(now_ms: i64) -> i64 {
    (now_ms.div_euclid(TTL_MS) + 2) * TTL_MS
}

/// `b4.<世代>.<目标>.<偏移>.<seq>.<过期>.<记录>.<签名>`。
fn encode(cx: &Ctx<'_>, c: &Cursor) -> String {
    let records = c
        .records
        .iter()
        .map(|(k, v)| format!("{}:{v}", short_key(&cx.p.code, k)))
        .collect::<Vec<_>>()
        .join(",");
    let body = format!(
        "{BRIEF}.{}.{}.{}.{}.{}.{records}",
        cx.p.generation, c.target, c.offset, c.seq, c.expires
    );
    let sig = cursor::sign(&cx.key, &body);
    format!("{body}.{sig}")
}

fn decimal(text: &str) -> Option<i64> {
    let ok = text == "0"
        || (!text.is_empty()
            && text.len() <= 16
            && !text.starts_with('0')
            && text.bytes().all(|b| b.is_ascii_digit()));
    ok.then(|| text.parse().ok()).flatten()
}

fn decode(cx: &Ctx<'_>, token: &str) -> Result<Cursor, DomainError> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.first() != Some(&BRIEF) {
        return Err(cursor::foreign(token));
    }
    if parts.len() != 8 {
        return Err(cursor::tampered());
    }
    if !cursor::verify(&cx.key, &parts[..7].join("."), parts[7]) {
        return Err(cursor::tampered());
    }
    let generation = decimal(parts[1]).ok_or_else(cursor::tampered)?;
    let target = parts[2];
    let offset = decimal(parts[3]).ok_or_else(cursor::tampered)?;
    let seq = decimal(parts[4]).ok_or_else(cursor::tampered)?;
    let expires = decimal(parts[5]).ok_or_else(cursor::tampered)?;
    let mut records = Vec::new();
    if !parts[6].is_empty() {
        for entry in parts[6].split(',') {
            let mut it = entry.split(':');
            let (Some(k), Some(v), None) = (it.next(), it.next(), it.next()) else {
                return Err(cursor::tampered());
            };
            let key_ok = !k.is_empty()
                && k.bytes()
                    .next()
                    .is_some_and(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
                && k.bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'-');
            let ver_ok = v.len() == 8
                && v.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
            if !key_ok || !ver_ok {
                return Err(cursor::tampered());
            }
            records.push((full_key(&cx.p.code, k), v.to_owned()));
        }
    }
    if target.len() != 11 || records.len() > 8 || offset as usize > records.len() || expires <= 0 {
        return Err(cursor::tampered());
    }
    if generation != cx.p.generation {
        return Err(cursor::invalid("SCOPE_RESTORED"));
    }
    if cx.now.millis() > expires {
        return Err(cursor::invalid("EXPIRED"));
    }
    Ok(Cursor {
        target: target.to_owned(),
        offset: offset as usize,
        records,
        seq,
        expires,
    })
}

// ---------- 预算 ----------

fn record_view(record: &Value) -> Value {
    let mut r = record.as_object().cloned().unwrap_or_default();
    for k in ["source_actor_id", "source_session_id", "source_ref"] {
        r.remove(k);
    }
    Value::Object(r)
}

fn pick(payload: &Map<String, Value>, include: &[&str]) -> Map<String, Value> {
    if include.is_empty() {
        return payload.clone();
    }
    let keep: Vec<&str> = ALWAYS
        .iter()
        .copied()
        .chain(include.iter().flat_map(|n| section_keys(n).iter().copied()))
        .collect();
    payload
        .iter()
        .filter(|(k, _)| keep.contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

struct Fit<'a> {
    include: &'a [&'static str],
    max_chars: usize,
    identity: Map<String, Value>,
    target: Target<'a>,
    begin: Option<BeginBrief>,
    snapshot: Vec<(String, String)>,
}

#[allow(clippy::too_many_arguments)]
fn candidate(
    source: &Map<String, Value>,
    identity: &Map<String, Value>,
    dropped: &[&str],
    omitted_fields: &[(String, Vec<String>)],
    count: usize,
    total: usize,
    cursor: Option<&str>,
    begin: Option<BeginBrief>,
) -> Value {
    let dropped_keys: Vec<&str> = dropped
        .iter()
        .flat_map(|s| section_keys(s).iter().copied())
        .collect();
    let mut out = identity.clone();
    out.insert(
        "project".into(),
        source.get("project").cloned().unwrap_or(Value::Null),
    );
    out.insert(
        "seq".into(),
        source.get("seq").cloned().unwrap_or(Value::Null),
    );
    for (k, v) in source {
        if ALWAYS.contains(&k.as_str())
            || dropped_keys.contains(&k.as_str())
            || identity.contains_key(k)
        {
            continue;
        }
        let v = if k == "records" {
            Value::Array(
                v.as_array()
                    .map(|rs| rs.iter().take(count).map(record_view).collect())
                    .unwrap_or_default(),
            )
        } else {
            v.clone()
        };
        out.insert(k.clone(), v);
    }
    let omitted_records = count < total;
    let truncated = !dropped.is_empty()
        || !omitted_fields.is_empty()
        || omitted_records
        || source.get("truncated") == Some(&json!(true));
    out.insert("truncated".into(), json!(truncated));
    if let Some(mode) = begin {
        out.insert("brief_mode".into(), json!(mode.as_str()));
        out.insert("brief_truncated".into(), json!(truncated));
    }
    if !dropped.is_empty() {
        out.insert("omitted_sections".into(), json!(dropped));
    }
    if !omitted_fields.is_empty() {
        out.insert(
            "omitted_fields".into(),
            Value::Array(
                omitted_fields
                    .iter()
                    .map(|(s, f)| json!({ "section": s, "fields": f }))
                    .collect(),
            ),
        );
    }
    if omitted_records {
        out.insert(
            "omitted_collections".into(),
            json!([{ "section": "records", "total_items": total, "returned_items": count, "omitted_items": total - count }]),
        );
        match cursor {
            Some(c) => {
                out.insert(
                    "continuation".into(),
                    json!({ "tool": "atm_brief", "cursor": c }),
                );
            }
            None => {
                out.insert("continuation_omitted".into(), json!(true));
            }
        }
    }
    Value::Object(out)
}

/// 2.x `fitWholeBrief`：按分节丢弃、records 整条分页、不截断字符串。
fn fit_whole(cx: &Ctx<'_>, payload: &Map<String, Value>, f: Fit<'_>) -> Result<Value, DomainError> {
    let mut source = pick(payload, f.include);
    let total = source
        .get("records")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    if total > 0 && total != f.snapshot.len() {
        return Err(DomainError::new(
            ErrorCode::INVALID_RESPONSE,
            "brief 的记录快照与返回集合不一致",
        )
        .detail("records", total)
        .detail("versions", f.snapshot.len()));
    }
    let seq = source.get("seq").and_then(Value::as_i64).unwrap_or(0);
    let mut count = total;
    let mut dropped: Vec<&str> = Vec::new();
    let mut omitted_fields: Vec<(String, Vec<String>)> = Vec::new();
    let mut actions: Vec<&str> = DROP_ORDER
        .iter()
        .copied()
        .filter(|s| section_keys(s).iter().any(|k| source.contains_key(*k)))
        .collect();
    let target = target_hash(cx, &f.target);
    let expires = expiry(cx.now.millis());
    loop {
        let token = (count < total).then(|| {
            encode(
                cx,
                &Cursor {
                    target: target.clone(),
                    offset: count,
                    records: f.snapshot.clone(),
                    seq,
                    expires,
                },
            )
        });
        let c = candidate(
            &source,
            &f.identity,
            &dropped,
            &omitted_fields,
            count,
            total,
            token.as_deref(),
            f.begin,
        );
        if js_len(&c) <= f.max_chars {
            return Ok(c);
        }
        if !actions.is_empty() {
            let victim = actions.remove(0);
            if victim == "records" {
                if count > 0 {
                    count -= 1;
                    actions.insert(0, "records");
                }
                continue;
            }
            if victim == "task"
                && let Some(Value::Object(task)) = source.get("task")
            {
                let compact: Map<String, Value> = ESSENTIAL_TASK
                    .iter()
                    .filter_map(|k| task.get(*k).map(|v| ((*k).to_owned(), v.clone())))
                    .collect();
                let omitted: Vec<String> = task
                    .keys()
                    .filter(|k| !compact.contains_key(*k))
                    .cloned()
                    .collect();
                if !omitted.is_empty() {
                    source.insert("task".into(), Value::Object(compact));
                    omitted_fields.push(("task".into(), omitted));
                    actions.insert(0, "task");
                    continue;
                }
            }
            dropped.push(victim);
            continue;
        }
        if count > 0 {
            count -= 1;
            continue;
        }
        let minimal = candidate(
            &source,
            &f.identity,
            &dropped,
            &omitted_fields,
            0,
            total,
            None,
            f.begin,
        );
        // C-16：连身份都放不下时报错；begin 例外，始终返回身份。
        if f.begin.is_none() && js_len(&minimal) > f.max_chars {
            return Err(too_large(
                format!("max_chars={} 连 brief 的身份字段都放不下", f.max_chars),
                json!({ "max_chars": f.max_chars, "recovery": { "action": "increase_max_chars" } }),
            ));
        }
        return Ok(minimal);
    }
}

/// 2.x `continueWholeBrief`：续读页只含 records。
fn continue_whole(
    cx: &Ctx<'_>,
    c: &Cursor,
    session: Option<&str>,
    max_chars: usize,
    records: &[Value],
) -> Result<Value, DomainError> {
    let mut returned = records.len() - c.offset;
    loop {
        let next = c.offset + returned;
        let token = (next < records.len()).then(|| {
            encode(
                cx,
                &Cursor {
                    target: c.target.clone(),
                    offset: next,
                    records: c.records.clone(),
                    seq: c.seq,
                    expires: c.expires,
                },
            )
        });
        let mut m = Map::new();
        m.insert("project".into(), json!(cx.p.code));
        m.insert("seq".into(), json!(cx.p.seq));
        if let Some(s) = session {
            m.insert("session_id".into(), json!(s));
        }
        m.insert(
            "records".into(),
            Value::Array(records[c.offset..next].iter().map(record_view).collect()),
        );
        m.insert("offset".into(), json!(c.offset));
        m.insert("returned_items".into(), json!(returned));
        m.insert("total_items".into(), json!(records.len()));
        m.insert("truncated".into(), json!(token.is_some()));
        if cx.p.seq > c.seq {
            m.insert("snapshot_advanced_from".into(), json!(c.seq));
            m.insert("snapshot_advanced_to".into(), json!(cx.p.seq));
        }
        if let Some(t) = &token {
            m.insert(
                "continuation".into(),
                json!({ "tool": "atm_brief", "cursor": t }),
            );
        }
        let v = Value::Object(m);
        if js_len(&v) <= max_chars {
            return Ok(v);
        }
        if returned > 0 {
            returned -= 1;
            continue;
        }
        return Err(too_large(
            format!("max_chars={max_chars} 放不下一条完整的记录续读"),
            json!({ "max_chars": max_chars, "recovery": { "action": "increase_max_chars", "preserve_cursor": true } }),
        ));
    }
}

fn snapshot_versions(
    cx: &Ctx<'_>,
    payload: &Map<String, Value>,
) -> Result<Vec<(String, String)>, DomainError> {
    record_keys(payload)
        .into_iter()
        .map(|k| {
            let v = record_version(cx, &k)?.ok_or_else(|| views::record_not_found(&k))?;
            Ok((k, v))
        })
        .collect()
}

/// 续读时核对冻结的记录：读不到或版本变了都是 STALE（S-056）。
fn resolve(
    cx: &Ctx<'_>,
    c: &Cursor,
    payload: &Map<String, Value>,
) -> Result<Vec<Value>, DomainError> {
    let current: Map<String, Value> = payload
        .get("records")
        .and_then(Value::as_array)
        .map(|rs| {
            rs.iter()
                .filter_map(|r| r["key"].as_str().map(|k| (k.to_owned(), r.clone())))
                .collect()
        })
        .unwrap_or_default();
    let mut out = Vec::new();
    for (key, expected) in &c.records {
        let stale = || {
            cursor::stale(format!("brief 续读冻结的记录已经变化：{key}"))
                .detail("record_key", key.as_str())
        };
        let version = record_version(cx, key)?.ok_or_else(stale)?;
        if &version != expected {
            return Err(stale());
        }
        let record = match current.get(key) {
            Some(r) => r.clone(),
            None => {
                let full = views::record(cx, &views::record_id(cx, key)?)?;
                json!({
                    "key": full["key"], "kind": full["kind"], "summary": full["summary"],
                    "importance": full["importance"], "source_type": full["source_type"],
                })
            }
        };
        out.push(record);
    }
    Ok(out)
}

impl Service {
    /// atm_brief（S-050～S-059）。
    pub fn brief(
        &self,
        principal: &Principal,
        project: &str,
        r: &BriefRequest,
    ) -> Result<Value, DomainError> {
        self.read_project(principal, Capability::ProjectRead, project, |cx| {
            let include = parse_include(&r.include)?;
            let max_chars = r.max_chars.clamp(300, 5000);
            let session = r.session.as_deref().map(str::trim).filter(|s| !s.is_empty());
            let target = Target {
                session,
                mask: mask(&include),
                task_key: r.task_key.as_deref(),
                since_seq: r.since_seq,
            };
            let decoded = match &r.cursor {
                Some(t) => {
                    let c = decode(cx, t)?;
                    if c.target != target_hash(cx, &target) {
                        return Err(cursor::target_mismatch("brief"));
                    }
                    Some(c)
                }
                None => None,
            };
            let wanted = |s: &str| include.is_empty() || include.contains(&s);
            let mut payload = snapshot(cx, session)?;
            if let (Some(k), true) = (r.task_key.as_deref(), wanted("task")) {
                let t = views::task_by_key(cx, k)?;
                let view = views::task_view(cx, &t, TaskView::Context)?;
                let compact: Map<String, Value> = COMPACT_TASK
                    .iter()
                    .filter_map(|key| view.get(*key).map(|v| ((*key).to_owned(), v.clone())))
                    .collect();
                payload.insert("task".into(), Value::Object(compact));
            }
            if let (Some(since), true) = (r.since_seq, wanted("delta")) {
                let page = delta::events(cx, Some(since), 20, &[])?;
                payload.insert(
                    "delta".into(),
                    json!({ "events": page.events, "currentSequence": cx.p.seq, "hasMore": page.has_more }),
                );
            }
            let payload = match jsify(Value::Object(payload)) {
                Value::Object(m) => m,
                _ => Map::new(),
            };
            if let Some(c) = decoded {
                let records = resolve(cx, &c, &payload)?;
                return continue_whole(cx, &c, session, max_chars, &records);
            }
            let snapshot = if wanted("records") {
                snapshot_versions(cx, &payload)?
            } else {
                Vec::new()
            };
            let mut identity = Map::new();
            if let Some(s) = session {
                identity.insert("session_id".into(), json!(s));
                // C-17：已关闭的 session 在 brief 里给出提示。
                if let Ok(w) = who(cx, s)
                    && let Some(state) = w.state.filter(|st| st != "ONLINE")
                {
                    identity.insert("session_state".into(), json!(state));
                }
            }
            fit_whole(
                cx,
                &payload,
                Fit {
                    include: &include,
                    max_chars,
                    identity,
                    target,
                    begin: None,
                    snapshot,
                },
            )
        })
    }

    /// atm_begin 附带的 brief（02 §4.2 fitBegin；S-060）。身份永不裁剪。
    pub fn begin_brief(
        &self,
        principal: &Principal,
        begun: &Written,
        mode: BeginBrief,
        max_chars: usize,
    ) -> Result<Value, DomainError> {
        let result = &begun.result;
        let code = result["project"]["code"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let session = result["session"]["id"].as_str().map(str::to_owned);
        let mut identity = Map::new();
        identity.insert(
            "scope".into(),
            result.get("scope").cloned().unwrap_or(json!("project")),
        );
        identity.insert("session".into(), json!(session));
        identity.insert("project".into(), json!(code));
        identity.insert("surface_version".into(), json!(6));
        for (from, to) in [
            ("outcome", "outcome"),
            ("predecessorSessionId", "predecessor_session_id"),
            ("acknowledgedHandoffs", "acknowledged_handoffs"),
            ("resumeCandidates", "resume_candidates"),
            ("sessionState", "session_state"),
        ] {
            if let Some(v) = result.get(from).filter(|v| !v.is_null()) {
                identity.insert(to.into(), v.clone());
            }
        }
        if begun.replayed {
            identity.insert("replayed".into(), json!(true));
        }
        if mode == BeginBrief::None {
            identity.insert("brief_mode".into(), json!("none"));
            identity.insert("brief_truncated".into(), json!(false));
            return Ok(jsify(Value::Object(identity)));
        }
        let max_chars = max_chars.clamp(400, 5000);
        self.read_project(principal, Capability::ProjectRead, &code, |cx| {
            let payload = match jsify(Value::Object(snapshot(cx, session.as_deref())?)) {
                Value::Object(m) => m,
                _ => Map::new(),
            };
            let minimal: [&'static str; 4] = ["counts", "next", "current", "handoff"];
            let selected = if mode == BeginBrief::Minimal {
                pick(&payload, &minimal)
            } else {
                payload
            };
            let snapshot = snapshot_versions(cx, &selected)?;
            fit_whole(
                cx,
                &selected,
                Fit {
                    include: &[],
                    max_chars,
                    identity,
                    target: Target {
                        session: session.as_deref(),
                        mask: mask(&[]),
                        task_key: None,
                        since_seq: None,
                    },
                    begin: Some(mode),
                    snapshot,
                },
            )
        })
    }
}
