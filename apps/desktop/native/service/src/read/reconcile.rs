//! 对账视图（`atm_task_list(view:"reconcile")`；2.x `application/src/reconcile.ts`，W2 推迟到 W4）。
//!
//! 每个任务归入一类：
//! - `LEASE_EXPIRED_ONLINE`：领取租约过期、领取它的 session 仍在线——先确认 Agent 是否还在做；
//! - `STALLED`：租约过期、session 已关闭或不存在——检查最后进度后由用户释放或新 session 接管；
//! - `POSSIBLY_COMPLETE`：BACKLOG / READY、从未被领取过，而验收条件里**显式写出的每个相对路径**
//!   都已存在于项目源码根之内——只是提示人工核对，从不据此推断完成；
//! - `ACTIVE`：以上都不是。
//!
//! 游标是数字 offset 字符串（02 §9.5 的表：对账分类由服务决定，不用签名游标）。

use super::codec::js_len;
use super::views::PRIORITY_RANK_SQL;
use super::{Ctx, db, field};
use crate::write::Service;
use atm_domain::capability::Capability;
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::keys;
use atm_domain::principal::Principal;
use atm_domain::time::Timestamp;
use rusqlite::OptionalExtension;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Debug)]
pub struct ReconcileRequest {
    pub include_active: bool,
    pub limit: usize,
    pub cursor: Option<String>,
    pub field_mask: Vec<String>,
    pub max_chars: usize,
}

impl Default for ReconcileRequest {
    fn default() -> Self {
        ReconcileRequest {
            include_active: false,
            limit: 10,
            cursor: None,
            field_mask: Vec::new(),
            max_chars: 12_000,
        }
    }
}

struct Task {
    key: String,
    title: String,
    status: String,
    acceptance: Vec<String>,
    claimed_by: Option<String>,
    lease_until: Option<String>,
    ever_claimed: bool,
    updated_at: String,
}

struct Session {
    id: String,
    agent_id: String,
    display_name: String,
    connection_state: String,
    last_seen_at: Option<String>,
    closed_at: Option<String>,
}

const CLASSES: [&str; 4] = [
    "ACTIVE",
    "LEASE_EXPIRED_ONLINE",
    "STALLED",
    "POSSIBLY_COMPLETE",
];

impl Service {
    pub fn reconcile(
        &self,
        principal: &Principal,
        project: &str,
        r: &ReconcileRequest,
    ) -> Result<Value, DomainError> {
        let offset = match r.cursor.as_deref() {
            None => 0,
            Some(c) => c.trim().parse::<usize>().map_err(|_| {
                DomainError::new(
                    ErrorCode::INVALID_CURSOR,
                    "对账视图的 cursor 是上一页给的数字",
                )
                .detail("cursor", c)
            })?,
        };
        let limit = r.limit.clamp(1, 100);
        let max_chars = r.max_chars.clamp(500, 50_000);
        let (code, name, root, tasks, sessions, now) =
            self.read_project(principal, Capability::WorkRead, project, load)?;
        let canonical_root = root.as_deref().and_then(|r| std::fs::canonicalize(r).ok());
        let mut counts: HashMap<&str, usize> = CLASSES.iter().map(|c| (*c, 0)).collect();
        let mut items = Vec::new();
        for t in &tasks {
            let item = classify(t, &sessions, canonical_root.as_deref(), now);
            *counts.entry(item.0).or_default() += 1;
            if r.include_active || item.0 != "ACTIVE" {
                items.push(item.1);
            }
        }
        let total = items.len();
        let page: Vec<Value> = items
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(|v| match v {
                Value::Object(m) => Value::Object(field::select(m, &r.field_mask)),
                other => other,
            })
            .collect();
        let source_has_more = offset + page.len() < total;
        let counts: Map<String, Value> = CLASSES
            .iter()
            .map(|c| ((*c).to_owned(), json!(counts[c])))
            .collect();
        let attention = tasks.len() - counts["ACTIVE"].as_u64().unwrap_or(0) as usize;
        for n in (1..=page.len()).rev() {
            let truncated = n < page.len();
            let has_more = truncated || source_has_more;
            let candidate = json!({
                "project": code,
                "project_name": name,
                "source_root": root,
                "view": "reconcile",
                "generated_at": now.to_string(),
                "attention_count": attention,
                "counts": counts,
                "returned_count": n,
                "items": page[..n],
                "next_cursor": has_more.then(|| (offset + n).to_string()),
                "has_more": has_more,
                "truncated": truncated,
            });
            if js_len(&candidate) <= max_chars {
                return Ok(candidate);
            }
        }
        // 一条也放不下：只给身份字段，其余字段名列在 omitted_fields 里。
        let first = page.first().and_then(Value::as_object);
        let identity: Map<String, Value> = first
            .map(|m| {
                ["task_key", "classification"]
                    .iter()
                    .filter_map(|k| m.get(*k).map(|v| ((*k).to_owned(), v.clone())))
                    .collect()
            })
            .unwrap_or_default();
        let omitted: Vec<&String> = first
            .map(|m| {
                m.keys()
                    .filter(|k| *k != "task_key" && *k != "classification")
                    .collect()
            })
            .unwrap_or_default();
        let has_more = page.len() > 1 || source_has_more;
        let n = usize::from(first.is_some());
        Ok(json!({
            "project": code,
            "view": "reconcile",
            "generated_at": now.to_string(),
            "attention_count": attention,
            "counts": counts,
            "returned_count": n,
            "items": if first.is_some() { vec![Value::Object(identity)] } else { Vec::new() },
            "omitted_fields": omitted,
            "next_cursor": has_more.then(|| (offset + n).to_string()),
            "has_more": has_more,
            "truncated": true,
        }))
    }
}

type Loaded = (
    String,
    String,
    Option<String>,
    Vec<Task>,
    HashMap<String, Session>,
    Timestamp,
);

fn load(c: &Ctx<'_>) -> Result<Loaded, DomainError> {
    let root: Option<String> =
        c.tx.query_row(
            "SELECT canonical_path FROM project_paths WHERE project_id = ?1
              ORDER BY is_primary DESC, last_seen_at DESC, id LIMIT 1",
            [&c.p.id],
            |r| r.get(0),
        )
        .optional()
        .map_err(db)?;
    let rank = PRIORITY_RANK_SQL.replace("CASE priority", "CASE w.priority");
    let mut stmt =
        c.tx.prepare(&format!(
            "SELECT w.local_no, w.title, w.status, w.acceptance_json, w.claimed_by_session_id,
                    w.claim_lease_until, w.ever_claimed_at IS NOT NULL, w.updated_at
               FROM work_items w WHERE w.project_id = ?1
              ORDER BY {rank}, w.sort_key, w.created_at, w.local_no"
        ))
        .map_err(db)?;
    let tasks = stmt
        .query_map([&c.p.id], |r| {
            let acceptance: String = r.get(3)?;
            Ok(Task {
                key: keys::task_key(&c.p.code, r.get(0)?),
                title: r.get(1)?,
                status: r.get(2)?,
                acceptance: serde_json::from_str(&acceptance).unwrap_or_default(),
                claimed_by: r.get(4)?,
                lease_until: r.get(5)?,
                ever_claimed: r.get(6)?,
                updated_at: r.get(7)?,
            })
        })
        .map_err(db)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db)?;
    let mut stmt =
        c.tx.prepare(
            "SELECT s.id, s.agent_id, COALESCE(a.display_name, s.agent_id), s.connection_state,
                    s.heartbeat_at, s.closed_at
               FROM agent_sessions s
               LEFT JOIN agents a ON a.project_id = s.project_id AND a.id = s.agent_id
              WHERE s.project_id = ?1
                AND s.id IN (SELECT claimed_by_session_id FROM work_items
                              WHERE project_id = ?1 AND claimed_by_session_id IS NOT NULL)",
        )
        .map_err(db)?;
    let sessions = stmt
        .query_map([&c.p.id], |r| {
            Ok(Session {
                id: r.get(0)?,
                agent_id: r.get(1)?,
                display_name: r.get(2)?,
                connection_state: r.get(3)?,
                last_seen_at: r.get(4)?,
                closed_at: r.get(5)?,
            })
        })
        .map_err(db)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db)?
        .into_iter()
        .map(|s| (s.id.clone(), s))
        .collect();
    Ok((
        c.p.code.clone(),
        c.p.name.clone(),
        root,
        tasks,
        sessions,
        c.now,
    ))
}

fn seconds_since(now: Timestamp, at: Option<&str>) -> i64 {
    at.and_then(Timestamp::parse)
        .map_or(0, |t| ((now.millis() - t.millis()) / 1000).max(0))
}

fn present_session(s: Option<&Session>) -> Value {
    match s {
        None => Value::Null,
        Some(s) => json!({
            "id": s.id,
            "agent_id": s.agent_id,
            "display_name": if s.display_name.is_empty() { &s.agent_id } else { &s.display_name },
            "connection_state": s.connection_state,
            "last_seen_at": s.last_seen_at,
            "ended_at": s.closed_at,
        }),
    }
}

fn classify(
    t: &Task,
    sessions: &HashMap<String, Session>,
    root: Option<&Path>,
    now: Timestamp,
) -> (&'static str, Value) {
    let session = t.claimed_by.as_ref().and_then(|id| sessions.get(id));
    let terminal = matches!(t.status.as_str(), "DONE" | "CANCELLED");
    let lease_expired = !terminal
        && t.claimed_by.is_some()
        && t.lease_until
            .as_deref()
            .and_then(Timestamp::parse)
            .is_some_and(|until| until.millis() <= now.millis());
    let item = |class: &'static str,
                reason: &str,
                age_from: Option<&str>,
                action: &str,
                paths: Vec<String>,
                session: Value| {
        (
            class,
            json!({
                "task_key": t.key,
                "title": t.title,
                "status": t.status,
                "classification": class,
                "reason": reason,
                "age_seconds": seconds_since(now, age_from),
                "session": session,
                "suggested_action": action,
                "evidence_paths": paths,
            }),
        )
    };
    if lease_expired && session.is_some_and(|s| s.connection_state == "ONLINE") {
        return item(
            "LEASE_EXPIRED_ONLINE",
            "claim_lease_expired_but_session_online",
            t.lease_until.as_deref(),
            "先确认 Agent 是否仍在工作；需要接管时再显式释放或接管领取。",
            Vec::new(),
            present_session(session),
        );
    }
    if lease_expired && session.is_none_or(|s| s.connection_state == "CLOSED") {
        let reason = if session.is_some() {
            "session_closed_and_lease_expired"
        } else {
            "claim_session_missing_and_lease_expired"
        };
        return item(
            "STALLED",
            reason,
            t.lease_until.as_deref(),
            "检查最后进度与证据后，由用户显式释放或由新 Session 接管。",
            Vec::new(),
            present_session(session),
        );
    }
    if matches!(t.status.as_str(), "BACKLOG" | "READY")
        && t.claimed_by.is_none()
        && !t.ever_claimed
        && let Some(paths) = root.and_then(|r| verified_paths(r, &t.acceptance))
    {
        return item(
            "POSSIBLY_COMPLETE",
            "all_explicit_acceptance_paths_exist_and_never_claimed",
            Some(&t.updated_at),
            "人工核对产物内容与验收条件；确认无误后再正常领取、验收并完成。",
            paths,
            Value::Null,
        );
    }
    item(
        "ACTIVE",
        "no_reconciliation_attention_required",
        Some(&t.updated_at),
        "无需对账，按当前任务状态继续。",
        Vec::new(),
        present_session(session),
    )
}

/// 验收条件里显式写出的路径全部存在、而且（跟随链接之后）都在源码根之内时返回它们；
/// 没有显式路径、任何一个不存在或越出根，都返回 None（宁可不提示，也不据自然语言推断）。
fn verified_paths(root: &Path, acceptance: &[String]) -> Option<Vec<String>> {
    let explicit = explicit_paths(acceptance);
    if explicit.is_empty() {
        return None;
    }
    for p in &explicit {
        // canonicalize 给的根是 verbatim 路径（`\\?\` 前缀），其中 `/` 不算分隔符：先统一成本机分隔符。
        let lexical = normalize(&root.join(p.replace('/', std::path::MAIN_SEPARATOR_STR)));
        if !lexical.starts_with(root) {
            return None;
        }
        let real = std::fs::canonicalize(&lexical).ok()?;
        if !real.starts_with(root) {
            return None;
        }
    }
    Some(explicit)
}

/// 去掉 `.`、按 `..` 回退，不碰文件系统（`path.resolve` 的词法部分）。
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 2.x `explicitAcceptancePaths`：反引号里的片段（允许根目录下的裸文件名），以及正文里带分隔符的
/// 相对路径（形如 `a/b`、`./a`、`../a/b.txt`）。按出现顺序去重。
pub fn explicit_paths(acceptance: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut add = |s: &str| {
        if !out.iter().any(|o| o == s) {
            out.push(s.to_owned());
        }
    };
    for statement in acceptance {
        let mut prose = String::new();
        let mut rest = statement.as_str();
        while let Some(open) = rest.find('`') {
            prose.push_str(&rest[..open]);
            let after = &rest[open + 1..];
            match after.find('`') {
                Some(close) if close > 0 && !after[..close].contains(['\r', '\n']) => {
                    let candidate = after[..close].trim();
                    if looks_relative(candidate, true) {
                        add(candidate);
                    }
                    prose.push(' ');
                    rest = &after[close + 1..];
                }
                _ => {
                    prose.push('`');
                    rest = after;
                }
            }
        }
        prose.push_str(rest);
        for candidate in prose_paths(&prose) {
            if looks_relative(candidate, false) {
                add(candidate);
            }
        }
    }
    out
}

fn is_seg(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '@' | '(' | ')' | '-')
}

fn is_last(c: char) -> bool {
    is_seg(c) || c == '.'
}

fn is_sep(c: char) -> bool {
    c == '/' || c == '\\'
}

/// 正文里的路径：`(?:\.{1,2}[\\/])?(?:seg[\\/])+last`，seg = `[A-Za-z0-9_@()-]+`，
/// last = `[A-Za-z0-9_@().-]+`；从左到右取不重叠的最长匹配（JS `match` 带 /g 的语义）。
fn prose_paths(text: &str) -> Vec<&str> {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let at = |i: usize| chars.get(i).map(|(_, c)| *c);
    let byte = |i: usize| chars.get(i).map_or(text.len(), |(b, _)| *b);
    let try_from = |start: usize| -> Option<usize> {
        // 返回匹配结束的字符下标（不含）。可选前缀先试「有」再试「无」。
        let prefixes: Vec<usize> = {
            let mut v = Vec::new();
            for dots in [2, 1] {
                if (0..dots).all(|k| at(start + k) == Some('.'))
                    && at(start + dots).is_some_and(is_sep)
                {
                    v.push(start + dots + 1);
                }
            }
            v.push(start);
            v
        };
        for body in prefixes {
            let mut pos = body;
            let mut group_ends = Vec::new(); // 每个 seg 的结束下标（分隔符之前）
            loop {
                let mut j = pos;
                while at(j).is_some_and(is_seg) {
                    j += 1;
                }
                if j > pos && at(j).is_some_and(is_sep) {
                    group_ends.push(j);
                    pos = j + 1;
                } else {
                    break;
                }
            }
            if group_ends.is_empty() {
                continue;
            }
            let mut j = pos;
            while at(j).is_some_and(is_last) {
                j += 1;
            }
            if j > pos {
                return Some(j);
            }
            // 末段为空：退掉最后一组，让它的 seg 充当末段（seg 字符都是 last 字符）。
            if group_ends.len() >= 2 {
                return Some(group_ends[group_ends.len() - 1]);
            }
        }
        None
    };
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        match try_from(i) {
            Some(end) if end > i => {
                out.push(&text[byte(i)..byte(end)]);
                i = end;
            }
            _ => i += 1,
        }
    }
    out
}

/// 2.x `looksLikeRelativePath`。
fn looks_relative(value: &str, allow_bare_file: bool) -> bool {
    let c = value
        .trim()
        .trim_start_matches(['\'', '"'])
        .trim_end_matches(['\'', '"']);
    if c.is_empty() || c.contains(':') || c.starts_with(['/', '\\']) {
        return false;
    }
    c.starts_with("./")
        || c.starts_with(".\\")
        || c.starts_with("../")
        || c.starts_with("..\\")
        || c.contains(['/', '\\'])
        || (allow_bare_file && bare_file(c))
}

/// `/[A-Za-z0-9_@() -]+\.[A-Za-z0-9_-]{1,16}$/`：以「名字.扩展名」结尾。
fn bare_file(s: &str) -> bool {
    let Some(dot) = s.rfind('.') else {
        return false;
    };
    let ext = &s[dot + 1..];
    let name_tail = s[..dot].chars().next_back();
    (1..=16).contains(&ext.len())
        && ext
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        && name_tail.is_some_and(|c| c.is_ascii_alphanumeric() || "_@() -".contains(c))
}
