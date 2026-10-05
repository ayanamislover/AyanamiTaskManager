//! atm_search（02 §4.4 搜索、§4.5 精确读取、§4.6 回查；00 02 C-09；03 F-05；S-068～S-070）。
//!
//! 分派顺序照 2.x 工具：list → op_id → `op:` → `progress:`/`session:` → 完整公开 key → 全文搜索。
//! 全文搜索按空白拆词、每词都要命中（最多 8 个）；翻页用首页时的 doc_id 上限做快照，新文档不出现在后续页。
//! 全局搜索只看 ACTIVE / ARCHIVED 项目（F-05），并带上 quick task。`truncated` 只表示预算截断（C-09），
//! 首页一条都放不下时返回起点游标而不是 null。

use super::codec::{b64, js_len, jsify, sha256, utf16_prefix};
use super::cursor::{self, SEARCH};
use super::field::{self, Target, fit_ignored, ignored, select};
use super::lists::ListRequest;
use super::views::{self, TaskView};
use super::{Ctx, db, too_large};
use crate::write::Service;
use atm_domain::capability::Capability;
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::principal::Principal;
use atm_domain::text::js_trim;
use atm_store::search::{TermsError, fts_phrase, like_pattern, terms, uses_fts};
use rusqlite::Transaction;
use rusqlite::params_from_iter;
use rusqlite::types::Value as Sql;
use serde_json::{Map, Value, json};

#[derive(Clone, Debug)]
pub struct SearchRequest {
    /// `records` / `sessions`：列表模式。
    pub list: Option<String>,
    pub project: Option<String>,
    pub query: Option<String>,
    pub op_id: Option<String>,
    pub session: Option<String>,
    pub limit: usize,
    pub cursor: Option<String>,
    pub field_mask: Vec<String>,
    pub max_chars: usize,
    /// list=sessions 时按当前任务过滤。
    pub task_key: Option<String>,
}

impl Default for SearchRequest {
    fn default() -> Self {
        SearchRequest {
            list: None,
            project: None,
            query: None,
            op_id: None,
            session: None,
            limit: 20,
            cursor: None,
            field_mask: Vec::new(),
            max_chars: 6000,
            task_key: None,
        }
    }
}

fn arg_error(field: &str, message: impl Into<String>) -> DomainError {
    DomainError::new(ErrorCode::INVALID_ARGUMENT, message).detail("field", field)
}

fn project_required(message: &str) -> DomainError {
    DomainError::new(ErrorCode::PROJECT_REQUIRED, message)
}

/// `progress:<ULID>` / `session:<ULID>`。
fn scoped_ulid(query: &str) -> Result<Option<(&'static str, String)>, DomainError> {
    let q = js_trim(query);
    let lower = q.to_ascii_lowercase();
    let (kind, rest) = if lower.starts_with("progress:") {
        ("PROGRESS", &q["progress:".len()..])
    } else if lower.starts_with("session:") {
        ("SESSION", &q["session:".len()..])
    } else {
        return Ok(None);
    };
    let id = js_trim(rest).to_ascii_uppercase();
    let ok = id.len() == 26
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b.is_ascii_uppercase() && !b"ILOU".contains(&b)));
    if !ok {
        return Err(DomainError::new(
            ErrorCode::VALIDATION_ERROR,
            format!("{}: 后必须提供 ULID", kind.to_ascii_lowercase()),
        )
        .detail("field", "query"));
    }
    Ok(Some((kind, id)))
}

/// 完整公开 key：`…-T-n` 是任务，`…-D-n` / `…-R-n` 是记录；返回 `(类型, 项目)`。
fn public_key(query: &str) -> Option<(&'static str, String)> {
    let q = js_trim(query).to_ascii_uppercase();
    let (head, digits) = q.rsplit_once('-')?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let (project, letter) = head.rsplit_once('-')?;
    let kind = match letter {
        "T" => "WORK_ITEM",
        "D" | "R" => "RECORD",
        _ => return None,
    };
    Some((kind, project.to_owned()))
}

fn masked_exact(
    cx: &Ctx<'_>,
    value: Value,
    r: &SearchRequest,
    max_chars: usize,
    entity: String,
    entity_type: &str,
    slot: &str,
) -> Result<Value, DomainError> {
    let value = jsify(value);
    let map = value.as_object().cloned().unwrap_or_default();
    let (echo, _) = fit_ignored(&ignored(&map, &r.field_mask), max_chars);
    let mut envelope = Map::new();
    envelope.insert("exact".into(), json!(true));
    envelope.insert("entity_type".into(), json!(entity_type));
    let mut probe = envelope.clone();
    probe.insert(slot.into(), json!({}));
    probe.extend(echo.clone());
    let overhead = js_len(&Value::Object(probe)).saturating_sub(2);
    let target = Target {
        entity,
        entity_type: entity_type.to_owned(),
        mask: r.field_mask.clone(),
        version: field::target_version(&value),
    };
    let fitted = field::fit(
        cx,
        Value::Object(select(map, &r.field_mask)),
        max_chars.saturating_sub(overhead),
        "atm_search",
        &target,
        r.cursor.as_deref(),
    )?;
    let mut out = envelope;
    out.insert(slot.into(), fitted);
    out.extend(echo);
    let out = Value::Object(out);
    if js_len(&out) > max_chars {
        return Err(too_large(
            "预算无法容纳字段回执",
            json!({ "recovery": { "action": "increase_max_chars", "preserve_cursor": true } }),
        ));
    }
    Ok(out)
}

// ---------- 全文搜索 ----------

struct Hit {
    entity_type: String,
    entity_key: String,
    title: String,
    snippet: String,
    updated_at: String,
    /// 全局搜索才有（quick task 为 null）。
    project: Option<Option<String>>,
}

impl Hit {
    fn compact(&self) -> Value {
        let mut m = Map::new();
        m.insert("entity_type".into(), json!(self.entity_type));
        m.insert("entity_key".into(), json!(self.entity_key));
        m.insert("title".into(), json!(self.title));
        m.insert("snippet".into(), json!(self.snippet));
        m.insert("updated_at".into(), json!(self.updated_at));
        if let Some(p) = &self.project {
            m.insert("project".into(), json!(p));
        }
        Value::Object(m)
    }
}

struct SearchPage {
    hits: Vec<Hit>,
    next_cursor: Option<String>,
    has_more: bool,
    /// 这次请求的起点（输入游标，或首页的起点游标）。
    start_cursor: String,
}

/// 搜索的位置与快照。
struct Pos {
    docs: i64,
    quick: i64,
    last: Option<(String, String, String, String)>,
}

fn query_hash(query: &str) -> String {
    b64(&sha256(js_trim(query).as_bytes()))[..22].to_owned()
}

enum Scope<'a> {
    Project(&'a Ctx<'a>),
    Global {
        tx: &'a Transaction<'a>,
        key: &'a [u8],
    },
}

impl Scope<'_> {
    fn tx(&self) -> &Transaction<'_> {
        match self {
            Scope::Project(cx) => cx.tx,
            Scope::Global { tx, .. } => tx,
        }
    }

    fn seal(&self, query: &str, pos: &Pos) -> String {
        let mut payload = Map::new();
        payload.insert("q".into(), json!(query_hash(query)));
        payload.insert("d".into(), json!(pos.docs));
        payload.insert("k".into(), json!(pos.quick));
        payload.insert(
            "l".into(),
            pos.last
                .as_ref()
                .map_or(Value::Null, |(u, p, t, e)| json!([u, p, t, e])),
        );
        match self {
            Scope::Project(cx) => cursor::seal(&cx.key, SEARCH, &cx.p, payload),
            Scope::Global { key, .. } => {
                payload.insert("s".into(), json!("*"));
                cursor::seal_plain(key, SEARCH, payload)
            }
        }
    }

    fn open(&self, query: &str, token: &str) -> Result<Pos, DomainError> {
        let c = match self {
            Scope::Project(cx) => {
                let c = cursor::open(&cx.key, SEARCH, &cx.p, token)?;
                cursor::exact_keys(&c, &["q", "d", "k", "l"])?;
                c
            }
            Scope::Global { key, .. } => {
                let c = cursor::open_plain(key, SEARCH, token)?;
                cursor::exact_keys(&c, &["q", "d", "k", "l", "s"])?;
                if cursor::str_of(&c, "s")? != "*" {
                    return Err(cursor::tampered());
                }
                c
            }
        };
        if cursor::str_of(&c, "q")? != query_hash(query) {
            return Err(cursor::tampered());
        }
        let docs = cursor::int_of(&c, "d")?;
        let quick = cursor::int_of(&c, "k")?;
        if docs < 0 || quick < 0 {
            return Err(cursor::tampered());
        }
        let last = match c.get("l") {
            Some(Value::Null) => None,
            Some(Value::Array(l)) if l.len() == 4 && l.iter().all(Value::is_string) => Some((
                l[0].as_str().unwrap_or_default().to_owned(),
                l[1].as_str().unwrap_or_default().to_owned(),
                l[2].as_str().unwrap_or_default().to_owned(),
                l[3].as_str().unwrap_or_default().to_owned(),
            )),
            _ => return Err(cursor::tampered()),
        };
        Ok(Pos { docs, quick, last })
    }
}

fn split_terms(query: &str) -> Result<Vec<String>, DomainError> {
    terms(query).map_err(|e| match e {
        TermsError::TooMany { actual } => DomainError::new(
            ErrorCode::VALIDATION_ERROR,
            format!(
                "query 最多 8 个词（去重后 {actual} 个）：删掉次要的词，或用双引号把相邻的几个词合成一个短语"
            ),
        )
        .detail("field", "query")
        .detail("issue", "too_many_terms")
        .detail("max", 8)
        .detail("actual", actual),
    })
}

fn run_search(
    scope: &Scope<'_>,
    query: &str,
    limit: usize,
    cursor_in: Option<&str>,
) -> Result<SearchPage, DomainError> {
    let bounded = limit.clamp(1, 30);
    let q = js_trim(query);
    let tx = scope.tx();
    let words = split_terms(q)?;
    let pos = match cursor_in {
        Some(t) => scope.open(q, t)?,
        None => Pos {
            docs: tx
                .query_row(
                    "SELECT COALESCE(MAX(doc_id), 0) FROM search_docs",
                    [],
                    |r| r.get(0),
                )
                .map_err(db)?,
            quick: tx
                .query_row("SELECT COALESCE(MAX(rowid), 0) FROM quick_tasks", [], |r| {
                    r.get(0)
                })
                .map_err(db)?,
            last: None,
        },
    };
    let start_cursor =
        cursor_in.map_or_else(|| scope.seal(q, &Pos { last: None, ..pos }), str::to_owned);
    if words.is_empty() {
        return Ok(SearchPage {
            hits: Vec::new(),
            next_cursor: None,
            has_more: false,
            start_cursor,
        });
    }
    let mut doc_where = Vec::new();
    let mut doc_args: Vec<Sql> = Vec::new();
    for w in &words {
        if uses_fts(w) {
            doc_where.push(
                "(d.doc_id IN (SELECT rowid FROM search_fts WHERE search_fts MATCH ?) OR d.entity_key LIKE ? ESCAPE '\\')",
            );
            doc_args.push(Sql::Text(fts_phrase(w)));
            doc_args.push(Sql::Text(like_pattern(w)));
        } else {
            doc_where.push("(d.title LIKE ? ESCAPE '\\' OR d.body LIKE ? ESCAPE '\\')");
            doc_args.push(Sql::Text(like_pattern(w)));
            doc_args.push(Sql::Text(like_pattern(w)));
        }
    }
    let (sql, mut args, global) = match scope {
        Scope::Project(cx) => {
            let mut args = vec![Sql::Text(cx.p.id.clone()), Sql::Integer(pos.docs)];
            args.extend(doc_args);
            let mut sql = format!(
                "SELECT d.entity_type, d.entity_key, d.title, d.body, d.updated_at, '' FROM search_docs d
                 WHERE d.project_id = ? AND d.doc_id <= ? AND {}",
                doc_where.join(" AND ")
            );
            if let Some((u, _, t, e)) = &pos.last {
                sql.push_str(
                    " AND (d.updated_at < ? OR (d.updated_at = ? AND d.entity_type > ?)
                       OR (d.updated_at = ? AND d.entity_type = ? AND d.entity_key > ?))",
                );
                args.extend([u, u, t, u, t, e].iter().map(|s| Sql::Text((*s).clone())));
            }
            sql.push_str(" ORDER BY d.updated_at DESC, d.entity_type, d.entity_key LIMIT ?");
            (sql, args, false)
        }
        Scope::Global { .. } => {
            let mut args = vec![Sql::Integer(pos.docs)];
            args.extend(doc_args);
            args.push(Sql::Integer(pos.quick));
            let mut quick_where = Vec::new();
            for w in &words {
                quick_where.push(
                    "(q.title LIKE ? ESCAPE '\\' OR q.note LIKE ? ESCAPE '\\' OR 'Q-' || printf('%04d', q.local_no) LIKE ? ESCAPE '\\')",
                );
                for _ in 0..3 {
                    args.push(Sql::Text(like_pattern(w)));
                }
            }
            let mut sql = format!(
                "WITH c AS (
                   SELECT d.entity_type AS t, d.entity_key AS k, d.title AS title, d.body AS body, d.updated_at AS u,
                          p.code AS project
                   FROM search_docs d JOIN projects p ON p.id = d.project_id
                   WHERE p.lifecycle IN ('ACTIVE', 'ARCHIVED') AND d.doc_id <= ? AND {}
                   UNION ALL
                   SELECT 'QUICK_TASK', 'Q-' || printf('%04d', q.local_no), q.title, q.note, q.updated_at, NULL
                   FROM quick_tasks q WHERE q.rowid <= ? AND {})
                 SELECT t, k, title, body, u, project FROM c",
                doc_where.join(" AND "),
                quick_where.join(" AND ")
            );
            if let Some((u, p, t, e)) = &pos.last {
                sql.push_str(
                    " WHERE (u < ? OR (u = ? AND COALESCE(project, '') > ?)
                       OR (u = ? AND COALESCE(project, '') = ? AND t > ?)
                       OR (u = ? AND COALESCE(project, '') = ? AND t = ? AND k > ?))",
                );
                args.extend(
                    [u, u, p, u, p, t, u, p, t, e]
                        .iter()
                        .map(|s| Sql::Text((*s).clone())),
                );
            }
            sql.push_str(" ORDER BY u DESC, COALESCE(project, ''), t, k LIMIT ?");
            (sql, args, true)
        }
    };
    args.push(Sql::Integer(bounded as i64 + 1));
    let rows: Vec<(String, String, String, String, String, Option<String>)> = tx
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
            ))
        })
        .map_err(db)?
        .collect::<rusqlite::Result<_>>()
        .map_err(db)?;
    let has_more = rows.len() > bounded;
    let hits: Vec<Hit> = rows
        .into_iter()
        .take(bounded)
        .map(|(t, k, title, body, u, project)| Hit {
            entity_type: t,
            entity_key: k,
            title,
            snippet: utf16_prefix(&body, 240).to_owned(),
            updated_at: u,
            project: global.then_some(project),
        })
        .collect();
    let next_cursor = match (has_more, hits.last()) {
        (true, Some(h)) => Some(scope.seal(
            q,
            &Pos {
                last: Some((
                    h.updated_at.clone(),
                    h.project.clone().flatten().unwrap_or_default(),
                    h.entity_type.clone(),
                    h.entity_key.clone(),
                )),
                ..pos
            },
        )),
        _ => None,
    };
    Ok(SearchPage {
        hits,
        next_cursor,
        has_more,
        start_cursor,
    })
}

fn no_match(query: &str, project: bool) -> Value {
    let mut suggestions = vec![if query.split_whitespace().count() > 1 {
        "每个词都必须命中；删掉部分词，只留最有区分度的一两个（如 ID 片段 D-398）"
    } else {
        "换更短的片段或同义词；ID 可只写编号部分（如 D-398）"
    }];
    suggestions.push("已知完整 key（如 ATM-R-012）时直接用它查，走精确读取");
    if project {
        suggestions.push("省略 project 可跨全部项目搜索");
    }
    json!({ "reason": "NO_MATCH", "suggestions": suggestions })
}

/// 2.x `fitSearchPage`（按 C-09 修正 truncated 与首页放不下时的游标）。
fn fit_search(
    scope: &Scope<'_>,
    r: &SearchRequest,
    query: &str,
    max_chars: usize,
) -> Result<Value, DomainError> {
    let requested = r.limit.clamp(1, 30);
    let initial = run_search(scope, query, requested, r.cursor.as_deref())?;
    let shapes: Vec<Value> = initial.hits.iter().map(Hit::compact).collect();
    let mut shape = Map::new();
    for h in &shapes {
        if let Some(m) = h.as_object() {
            shape.extend(m.clone());
        }
    }
    let ignored_fields = if shapes.is_empty() {
        Vec::new()
    } else {
        ignored(&shape, &r.field_mask)
    };
    let (echo, cost) = fit_ignored(&ignored_fields, max_chars);
    let budget = max_chars - cost;
    let maximum = requested.min(initial.hits.len());
    let mut fitted = None;
    for count in (1..=maximum).rev() {
        let refetched;
        let page = if count == maximum {
            &initial
        } else {
            refetched = run_search(scope, query, count, r.cursor.as_deref())?;
            &refetched
        };
        let hits: Vec<Value> = page
            .hits
            .iter()
            .take(count)
            .map(|h| {
                Value::Object(select(
                    h.compact().as_object().cloned().unwrap_or_default(),
                    &r.field_mask,
                ))
            })
            .collect();
        let candidate = jsify(json!({
            "exact": false,
            "requested_limit": requested,
            "returned_count": hits.len(),
            "hits": hits,
            "next_cursor": if page.has_more { json!(page.next_cursor) } else { Value::Null },
            "has_more": page.has_more,
            "truncated": count < maximum,
        }));
        if js_len(&candidate) <= budget {
            fitted = Some(candidate);
            break;
        }
    }
    let page = match fitted {
        Some(p) => p,
        None if initial.hits.is_empty() => json!({
            "exact": false, "requested_limit": requested, "returned_count": 0, "hits": [],
            "next_cursor": null, "has_more": false, "truncated": false,
        }),
        None => {
            let retry = json!({
                "exact": false, "returned_count": 0, "hits": [],
                "next_cursor": initial.start_cursor, "has_more": true, "truncated": true,
            });
            if js_len(&retry) > budget {
                return Err(too_large(
                    "预算无法容纳搜索回执",
                    json!({ "recovery": { "action": "increase_max_chars", "preserve_cursor": true } }),
                ));
            }
            retry
        }
    };
    let mut out = page.as_object().cloned().unwrap_or_default();
    if initial.hits.is_empty() && r.cursor.is_none() {
        out.insert(
            "next_step".into(),
            no_match(query, matches!(scope, Scope::Project(_))),
        );
    }
    out.extend(echo);
    let out = Value::Object(out);
    if js_len(&out) > max_chars {
        return Err(too_large(
            "预算无法容纳搜索回执",
            json!({ "recovery": { "action": "increase_max_chars", "preserve_cursor": true } }),
        ));
    }
    Ok(out)
}

impl Service {
    /// atm_search 的全部模式（02 §4.4–4.6）。
    pub fn search(&self, principal: &Principal, r: &SearchRequest) -> Result<Value, DomainError> {
        let max_chars = r.max_chars.clamp(300, 50_000);
        let project = r.project.as_deref().map(js_trim).filter(|s| !s.is_empty());
        let query = r.query.as_deref().map(js_trim).filter(|s| !s.is_empty());
        let op_id = r.op_id.as_deref().map(js_trim).filter(|s| !s.is_empty());
        if let Some(list) = r.list.as_deref() {
            let Some(project) = project else {
                return Err(arg_error("project", format!("list={list} 要求 project")));
            };
            for (field, given) in [
                ("query", query.is_some()),
                ("op_id", op_id.is_some()),
                ("session", r.session.is_some()),
            ] {
                if given {
                    return Err(arg_error(field, format!("list={list} 时 {field} 必须省略")));
                }
            }
            let lr = ListRequest {
                limit: r.limit,
                cursor: r.cursor.clone(),
                field_mask: r.field_mask.clone(),
                max_chars: r.max_chars,
                task_key: r.task_key.clone(),
            };
            return match list.trim().to_ascii_lowercase().as_str() {
                "records" => self.record_list(principal, project, &lr),
                "sessions" => self.session_list(principal, project, &lr),
                _ => Err(arg_error("list", "list 只能是 records / sessions")),
            };
        }
        if query.is_none() && op_id.is_none() {
            return Err(arg_error("query", "query 或 op_id 至少提供一个"));
        }
        if r.session.is_some() && op_id.is_none() {
            return Err(arg_error(
                "session",
                "session 仅可与 op_id 精确回查一起使用",
            ));
        }
        if let Some(op) = op_id {
            let Some(project) = project else {
                return Err(project_required("op_id 精确回查要求 project"));
            };
            let session = r.session.as_deref();
            return self.read_project(principal, Capability::SearchRead, project, |cx| {
                let trace = super::trace::trace(cx, op, session)?;
                let entity = format!("{op}@{}", session.unwrap_or("*"));
                masked_exact(cx, trace, r, max_chars, entity, "OPERATION", "operation")
            });
        }
        let query = query.unwrap_or_default();
        if query.len() >= 3 && query[..3].eq_ignore_ascii_case("op:") {
            let Some(project) = project else {
                return Err(project_required("op_id 精确回查要求 project"));
            };
            let op = js_trim(&query[3..]);
            if op.is_empty() {
                return Err(
                    DomainError::new(ErrorCode::VALIDATION_ERROR, "op: 后必须提供 op_id")
                        .detail("field", "query"),
                );
            }
            return self.read_project(principal, Capability::SearchRead, project, |cx| {
                let trace = super::trace::trace(cx, op, None)?;
                masked_exact(
                    cx,
                    trace,
                    r,
                    max_chars,
                    format!("{op}@*"),
                    "OPERATION",
                    "operation",
                )
            });
        }
        if let Some((kind, id)) = scoped_ulid(query)? {
            let Some(project) = project else {
                return Err(project_required(&format!(
                    "{} 精确读取要求 project",
                    kind.to_ascii_lowercase()
                )));
            };
            return self.read_project(principal, Capability::SearchRead, project, |cx| {
                let entity = if kind == "PROGRESS" {
                    views::progress(cx, &id)?
                } else {
                    views::session(cx, &id)?
                };
                masked_exact(cx, entity, r, max_chars, id.clone(), kind, "entity")
            });
        }
        if let Some((kind, from_key)) = public_key(query) {
            let exact_project = project.map_or(from_key, str::to_owned);
            return self.read_project(principal, Capability::SearchRead, &exact_project, |cx| {
                let entity = if kind == "WORK_ITEM" {
                    let t = views::task_by_key(cx, query)?;
                    views::snake(views::task_view(cx, &t, TaskView::Full)?)
                } else {
                    views::record(cx, &views::record_id(cx, query)?)?
                };
                masked_exact(
                    cx,
                    entity,
                    r,
                    max_chars,
                    query.to_ascii_uppercase(),
                    kind,
                    "entity",
                )
            });
        }
        match project {
            Some(project) => self.read_project(principal, Capability::SearchRead, project, |cx| {
                fit_search(&Scope::Project(cx), r, query, max_chars)
            }),
            None => self.read_global(principal, Capability::SearchRead, |tx, key, _| {
                fit_search(&Scope::Global { tx, key }, r, query, max_chars)
            }),
        }
    }

    /// atm_task_get（02 §4.5）：视图 + field_mask + 最近进度 + 字段续读。
    pub fn task_get(
        &self,
        principal: &Principal,
        project: &str,
        r: &TaskGetRequest,
    ) -> Result<Value, DomainError> {
        self.read_project(principal, Capability::WorkRead, project, |cx| {
            let max_chars = r.max_chars.clamp(300, 50_000);
            let t = views::task_by_key(cx, &r.task_key)?;
            let item = jsify(views::snake(views::task_view(cx, &t, r.view)?));
            let map = item.as_object().cloned().unwrap_or_default();
            let mut projected = select(map.clone(), &r.field_mask);
            if let Some(n) = r.last_progress {
                let recent: Vec<Value> = views::recent_progress(cx, &t.id, n.clamp(1, 10))?
                    .into_iter()
                    .map(|mut p| {
                        if let Value::Object(m) = &mut p {
                            m.remove("task_key");
                        }
                        jsify(p)
                    })
                    .collect();
                projected.insert("recent_progress".into(), Value::Array(recent));
            }
            let (echo, cost) = fit_ignored(&ignored(&map, &r.field_mask), max_chars);
            let mut mask = vec![format!("@view:{}", r.view.as_str())];
            if let Some(n) = r.last_progress {
                mask.push(format!("@progress:{n}"));
            }
            mask.extend(r.field_mask.iter().cloned());
            let target = Target {
                entity: views::task_key(cx, t.local_no),
                entity_type: "WORK_ITEM".into(),
                mask,
                version: field::target_version(&item),
            };
            let fitted = field::fit(
                cx,
                Value::Object(projected),
                max_chars - cost,
                "atm_task_get",
                &target,
                r.cursor.as_deref(),
            )?;
            Ok(match fitted {
                Value::Object(mut m) => {
                    m.extend(echo);
                    Value::Object(m)
                }
                other => other,
            })
        })
    }
}

/// atm_task_get 的入参。
#[derive(Clone, Debug)]
pub struct TaskGetRequest {
    pub task_key: String,
    pub view: TaskView,
    pub field_mask: Vec<String>,
    pub cursor: Option<String>,
    pub last_progress: Option<i64>,
    pub max_chars: usize,
}

impl TaskGetRequest {
    pub fn new(task_key: impl Into<String>) -> Self {
        TaskGetRequest {
            task_key: task_key.into(),
            view: TaskView::Core,
            field_mask: Vec::new(),
            cursor: None,
            last_progress: None,
            max_chars: 12_000,
        }
    }
}
