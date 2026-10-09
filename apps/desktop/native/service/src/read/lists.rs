//! 列表分页（02 §4.4，D30；00 02 C-15；R11 P2-5）。
//!
//! keyset 分页，每一项都有「读到这一项为止」的游标。预算截断时 `next_cursor` 取最后一个返回项的游标，
//! 一项都放不下时取本次请求的游标（首页则是起点游标），所以截断不丢不重（S-065）。
//! 游标绑定项目 id、范围世代与选择集哈希：换项目、换过滤条件都是 `INVALID_CURSOR`。

use super::codec::{b64, js_len, js_text, jsify, sha256};
use super::cursor::{self, RECORD_LIST, SESSION_LIST, TASK_LIST};
use super::field::{fit_ignored, ignored, select};
use super::views::{
    self, PRIORITY_RANK_SQL, SESSION_COLS, SESSION_FROM, TASK_COLS, TaskRow, TaskView,
};
use super::{Ctx, db, too_large};
use crate::write::Service;
use atm_domain::capability::Capability;
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::keys;
use atm_domain::principal::Principal;
use atm_domain::text::js_trim;
use rusqlite::types::Value as Sql;
use rusqlite::{OptionalExtension, params, params_from_iter};
use serde_json::{Map, Value, json};

fn clamp(v: usize, lo: usize, hi: usize) -> usize {
    v.clamp(lo, hi)
}

/// 选择集哈希：sha256(JSON) 前 22 个 base64url 字符；里面的文本先做 NFC（02 §4.4），
/// 同一个筛选换一种 Unicode 写法（预组字符 / 组合字符）仍能续读。
fn selection_hash(selection: &Value) -> String {
    let full = b64(&sha256(js_text(&nfc_strings(selection)).as_bytes()));
    full[..22].to_owned()
}

/// JSON 里每个字符串做 NFC。
pub(crate) fn nfc_strings(v: &Value) -> Value {
    use unicode_normalization::UnicodeNormalization;
    match v {
        Value::String(s) => Value::String(s.nfc().collect()),
        Value::Array(a) => Value::Array(a.iter().map(nfc_strings).collect()),
        Value::Object(o) => {
            Value::Object(o.iter().map(|(k, v)| (k.clone(), nfc_strings(v))).collect())
        }
        other => other.clone(),
    }
}

/// 一页结果（服务层形状）：每项的游标、下一页、重试游标。
pub(crate) struct Page {
    pub(crate) items: Vec<Value>,
    pub(crate) item_cursors: Vec<String>,
    pub(crate) has_more: bool,
    pub(crate) retry_cursor: String,
}

/// 一条都放不下时，按条目与预算给出 `oversized_item`。
type Oversized<'a> = &'a dyn Fn(&Value, usize) -> Value;

/// 2.x `fitTaskPage` / `fitRecordPage` / `fitSessionPage` 的共同骨架：从全部条目开始逐条减少。
fn fit_page(
    head: &Map<String, Value>,
    max_chars: usize,
    page: &Page,
    oversized: Option<Oversized<'_>>,
    collections: bool,
) -> Option<Value> {
    let n = page.items.len();
    for count in (0..=n).rev() {
        let budget_truncated = count < n;
        let has_more = budget_truncated || page.has_more;
        let next_cursor = if !has_more {
            Value::Null
        } else if count > 0 {
            json!(page.item_cursors[count - 1])
        } else {
            json!(page.retry_cursor)
        };
        let mut c = head.clone();
        c.insert("returned_count".into(), json!(count));
        c.insert("items".into(), Value::Array(page.items[..count].to_vec()));
        c.insert("next_cursor".into(), next_cursor);
        c.insert("has_more".into(), json!(has_more));
        c.insert("truncated".into(), json!(budget_truncated));
        if collections && budget_truncated {
            c.insert(
                "truncated_collections".into(),
                json!([{ "path": "items", "original_items": n, "returned_items": count }]),
            );
        }
        if count == 0
            && n > 0
            && let Some(f) = oversized
        {
            c.insert("oversized_item".into(), f(&page.items[0], max_chars));
        }
        let candidate = Value::Object(c);
        if js_len(&candidate) <= max_chars {
            return Some(candidate);
        }
    }
    None
}

// ================= 任务 =================

/// `atm_task_list` 的入参（R11 P2-5：`mine`、`status=open|closed|all|<状态>`）。
#[derive(Clone, Debug)]
pub struct TaskListRequest {
    /// `open` / `closed` / `all` / 具体状态；None 等同 `all`。
    pub status: Option<String>,
    pub owner: Option<String>,
    pub parent_key: Option<String>,
    pub milestone_id: Option<String>,
    pub ready_only: bool,
    pub query: Option<String>,
    /// 只列这个 session 所在 lineage 持有的任务。
    pub mine_session: Option<String>,
    pub limit: usize,
    pub cursor: Option<String>,
    pub view: TaskView,
    pub field_mask: Vec<String>,
    pub max_chars: usize,
}

impl Default for TaskListRequest {
    fn default() -> Self {
        TaskListRequest {
            status: None,
            owner: None,
            parent_key: None,
            milestone_id: None,
            ready_only: false,
            query: None,
            mine_session: None,
            limit: 10,
            cursor: None,
            view: TaskView::Core,
            field_mask: Vec::new(),
            max_chars: 12_000,
        }
    }
}

/// ready 的定义（02 §4.1）：READY 且没有未 DONE 的 BLOCKS 前置。
pub(crate) const READY_SQL: &str = "w.status = 'READY' AND NOT EXISTS (
    SELECT 1 FROM work_item_relations r JOIN work_items d ON d.project_id = r.project_id AND d.id = r.source_id
    WHERE r.project_id = w.project_id AND r.target_id = w.id AND r.relation_type = 'BLOCKS' AND d.status <> 'DONE')";

fn like(text: &str) -> String {
    let mut s = String::from("%");
    for c in text.chars() {
        if matches!(c, '\\' | '%' | '_') {
            s.push('\\');
        }
        s.push(c);
    }
    s.push('%');
    s
}

struct TaskFilter {
    clauses: Vec<String>,
    args: Vec<Sql>,
    selection: Value,
}

fn task_filter(cx: &Ctx<'_>, r: &TaskListRequest) -> Result<TaskFilter, DomainError> {
    let mut clauses = vec!["w.project_id = ?".to_owned()];
    let mut args = vec![Sql::Text(cx.p.id.clone())];
    let status = r
        .status
        .as_deref()
        .map(|s| js_trim(s).to_uppercase())
        .filter(|s| !s.is_empty());
    match status.as_deref() {
        None | Some("ALL") => {}
        Some("OPEN") => clauses.push("w.status NOT IN ('DONE', 'CANCELLED')".into()),
        Some("CLOSED") => clauses.push("w.status IN ('DONE', 'CANCELLED')".into()),
        Some(s) => {
            const STATUSES: [&str; 10] = [
                "BACKLOG",
                "READY",
                "CLAIMED",
                "IN_PROGRESS",
                "BLOCKED",
                "WAITING_USER",
                "WAITING_AGENT",
                "VERIFYING",
                "DONE",
                "CANCELLED",
            ];
            if !STATUSES.contains(&s) {
                return Err(DomainError::new(
                    ErrorCode::INVALID_ARGUMENT,
                    format!(
                        "status 只能是 open / closed / all 或 {}",
                        STATUSES.join(" / ")
                    ),
                )
                .detail("field", "status")
                .detail("got", s));
            }
            clauses.push("w.status = ?".into());
            args.push(Sql::Text(s.to_owned()));
        }
    }
    let owner = r.owner.as_deref().map(js_trim).filter(|s| !s.is_empty());
    if let Some(o) = owner {
        clauses.push("w.assignee_agent_id = ?".into());
        args.push(Sql::Text(o.to_owned()));
    }
    let parent = match r.parent_key.as_deref() {
        Some(k) => {
            let t = views::task_by_key(cx, k)?;
            clauses.push("w.parent_id = ?".into());
            args.push(Sql::Text(t.id.clone()));
            Some(t.id)
        }
        None => None,
    };
    let milestone = r
        .milestone_id
        .as_deref()
        .map(js_trim)
        .filter(|s| !s.is_empty());
    if let Some(m) = milestone {
        let known: Option<i64> = cx
            .tx
            .query_row(
                "SELECT 1 FROM milestones WHERE project_id = ?1 AND id = ?2",
                params![cx.p.id, m],
                |row| row.get(0),
            )
            .optional()
            .map_err(db)?;
        if known.is_none() {
            return Err(DomainError::new(
                ErrorCode::MILESTONE_NOT_FOUND,
                format!("里程碑不存在：{m}"),
            )
            .detail("entity", "MILESTONE")
            .detail("reference", m));
        }
        clauses.push("w.milestone_id = ?".into());
        args.push(Sql::Text(m.to_owned()));
    }
    let query = r.query.as_deref().map(js_trim).filter(|s| !s.is_empty());
    if let Some(q) = query {
        clauses.push("(w.title LIKE ? ESCAPE '\\' OR w.description LIKE ? ESCAPE '\\')".into());
        args.push(Sql::Text(like(q)));
        args.push(Sql::Text(like(q)));
    }
    if r.ready_only {
        clauses.push(READY_SQL.into());
    }
    let mine = match r.mine_session.as_deref() {
        Some(s) => {
            let members = crate::lineage::lineage(cx.tx, &cx.p.id, s).map_err(db)?;
            if members.is_empty() {
                return Err(views::session(cx, s).err().unwrap_or_else(|| {
                    DomainError::new(ErrorCode::SESSION_NOT_FOUND, "session 不存在")
                }));
            }
            clauses.push(format!(
                "w.claimed_by_session_id IN ({})",
                vec!["?"; members.len()].join(", ")
            ));
            args.extend(members.iter().cloned().map(Sql::Text));
            Some(members)
        }
        None => None,
    };
    let selection = json!([status, owner, parent, milestone, r.ready_only, query, mine]);
    Ok(TaskFilter {
        clauses,
        args,
        selection,
    })
}

fn task_cursor(cx: &Ctx<'_>, selection: &str, last: Option<&TaskRow>) -> String {
    let mut payload = Map::new();
    payload.insert("s".into(), json!(selection));
    payload.insert(
        "l".into(),
        last.map_or(Value::Null, |t| {
            json!([t.priority_rank(), t.sort_key, t.created_at, t.local_no])
        }),
    );
    cursor::seal(&cx.key, TASK_LIST, &cx.p, payload)
}

fn task_page(cx: &Ctx<'_>, r: &TaskListRequest) -> Result<Page, DomainError> {
    let mut f = task_filter(cx, r)?;
    let selection = selection_hash(&f.selection);
    if let Some(token) = &r.cursor {
        let c = cursor::open(&cx.key, TASK_LIST, &cx.p, token)?;
        cursor::exact_keys(&c, &["s", "l"])?;
        if cursor::str_of(&c, "s")? != selection {
            return Err(cursor::tampered());
        }
        match c.get("l") {
            Some(Value::Null) => {}
            Some(Value::Array(l)) if l.len() == 4 => {
                let (Some(rank), Some(sort), Some(created), Some(no)) =
                    (l[0].as_i64(), l[1].as_i64(), l[2].as_str(), l[3].as_i64())
                else {
                    return Err(cursor::tampered());
                };
                f.clauses.push(
                    format!(
                        "({PRIORITY_RANK_SQL}, w.sort_key, w.created_at, w.local_no) > (?, ?, ?, ?)"
                    )
                    .replace("CASE priority", "CASE w.priority"),
                );
                f.args.extend([
                    Sql::Integer(rank),
                    Sql::Integer(sort),
                    Sql::Text(created.to_owned()),
                    Sql::Integer(no),
                ]);
            }
            _ => return Err(cursor::tampered()),
        }
    }
    let limit = clamp(r.limit, 1, 100);
    f.args.push(Sql::Integer(limit as i64 + 1));
    let cols = TASK_COLS
        .split(',')
        .map(|c| format!("w.{}", c.trim()))
        .collect::<Vec<_>>()
        .join(", ");
    let rank = PRIORITY_RANK_SQL.replace("CASE priority", "CASE w.priority");
    let sql = format!(
        "SELECT {cols} FROM work_items w WHERE {} ORDER BY {rank}, w.sort_key, w.created_at, w.local_no LIMIT ?",
        f.clauses.join(" AND ")
    );
    let rows: Vec<TaskRow> = cx
        .tx
        .prepare(&sql)
        .map_err(db)?
        .query_map(params_from_iter(f.args), TaskRow::from_row)
        .map_err(db)?
        .collect::<rusqlite::Result<_>>()
        .map_err(db)?;
    let has_more = rows.len() > limit;
    let rows = &rows[..rows.len().min(limit)];
    let mut items = Vec::with_capacity(rows.len());
    let mut item_cursors = Vec::with_capacity(rows.len());
    for t in rows {
        items.push(jsify(views::snake(views::task_view(cx, t, r.view)?)));
        item_cursors.push(task_cursor(cx, &selection, Some(t)));
    }
    Ok(Page {
        items,
        item_cursors,
        has_more,
        retry_cursor: r
            .cursor
            .clone()
            .unwrap_or_else(|| task_cursor(cx, &selection, None)),
    })
}

impl Service {
    /// atm_task_list（02 §4.4 S-065；R11 P2-5）。
    pub fn task_list(
        &self,
        principal: &Principal,
        project: &str,
        r: &TaskListRequest,
    ) -> Result<Value, DomainError> {
        self.read_project(principal, Capability::WorkRead, project, |cx| {
            let max_chars = clamp(r.max_chars, 500, 50_000);
            let page = task_page(cx, r)?;
            let projected: Vec<Value> = page
                .items
                .iter()
                .map(|v| Value::Object(select(v.as_object().cloned().unwrap_or_default(), &r.field_mask)))
                .collect();
            let shape = page.items.first().and_then(Value::as_object);
            let ignored_fields = shape.map_or_else(Vec::new, |s| ignored(s, &r.field_mask));
            let (echo, cost) = fit_ignored(&ignored_fields, max_chars);
            let mut head = Map::new();
            head.insert("project".into(), json!(cx.p.code));
            head.insert("view".into(), json!(r.view.as_str()));
            let page = Page {
                items: projected,
                ..page
            };
            let oversized = |first: &Value, max: usize| {
                let chars = js_len(first);
                json!({
                    "key": first.get("key"),
                    "chars": chars,
                    "suggested_max_chars": 50_000.min((max + 1).max(chars + 800)),
                    "hint": "提高 max_chars，或用 field_mask 缩小列表投影，再以相同 cursor 重试",
                })
            };
            let budget = max_chars - cost;
            let fitted = match fit_page(&head, budget, &page, Some(&oversized), true) {
                Some(v) => v,
                None => {
                    let fallback = json!({
                        "project": cx.p.code,
                        "view": r.view.as_str(),
                        "returned_count": 0,
                        "items": [],
                        "next_cursor": page.retry_cursor,
                        "has_more": !page.items.is_empty() || page.has_more,
                        "truncated": !page.items.is_empty(),
                        "hint": "提高 max_chars 或缩小 field_mask，使用相同 cursor 重试",
                    });
                    if js_len(&fallback) > budget {
                        return Err(too_large(
                            "预算无法容纳列表游标和回执",
                            json!({ "recovery": { "action": "increase_max_chars", "preserve_cursor": true } }),
                        ));
                    }
                    fallback
                }
            };
            Ok(with_echo(fitted, echo))
        })
    }
}

fn with_echo(v: Value, echo: Map<String, Value>) -> Value {
    match v {
        Value::Object(mut m) => {
            m.extend(echo);
            Value::Object(m)
        }
        other => other,
    }
}

// ================= 记录与 session =================

/// `atm_search list=records|sessions` 的入参。
#[derive(Clone, Debug)]
pub struct ListRequest {
    pub limit: usize,
    pub cursor: Option<String>,
    pub field_mask: Vec<String>,
    pub max_chars: usize,
    /// 只用于 sessions：按当前任务过滤（认不出的 key → 匹配不到，00 02 C-15 纳入选择集）。
    pub task_key: Option<String>,
}

impl Default for ListRequest {
    fn default() -> Self {
        ListRequest {
            limit: 20,
            cursor: None,
            field_mask: Vec::new(),
            max_chars: 6000,
            task_key: None,
        }
    }
}

const RECORD_MASK: [&str; 10] = [
    "key",
    "kind",
    "title",
    "summary",
    "importance",
    "status",
    "topic",
    "subject_key",
    "source_type",
    "updated_at",
];

const SESSION_MASK: [&str; 11] = [
    "id",
    "agent_id",
    "display_name",
    "client_kind",
    "role",
    "work_state",
    "connection_state",
    "current_task_key",
    "last_seen_at",
    "started_at",
    "updated_at",
];

fn keyset_cursor(cx: &Ctx<'_>, prefix: &str, selection: &str, last: Value) -> String {
    let mut payload = Map::new();
    payload.insert("s".into(), json!(selection));
    payload.insert("l".into(), last);
    cursor::seal(&cx.key, prefix, &cx.p, payload)
}

/// 打开列表游标，返回 `l`（`[时间, 次键]` 或 null）。
fn open_keyset(
    cx: &Ctx<'_>,
    prefix: &str,
    selection: &str,
    token: &str,
) -> Result<Option<(String, Value)>, DomainError> {
    let c = cursor::open(&cx.key, prefix, &cx.p, token)?;
    cursor::exact_keys(&c, &["s", "l"])?;
    if cursor::str_of(&c, "s")? != selection {
        return Err(cursor::tampered());
    }
    match c.get("l") {
        Some(Value::Null) => Ok(None),
        Some(Value::Array(l)) if l.len() == 2 => match (&l[0], &l[1]) {
            (Value::String(at), second @ (Value::String(_) | Value::Number(_))) => {
                Ok(Some((at.clone(), second.clone())))
            }
            _ => Err(cursor::tampered()),
        },
        _ => Err(cursor::tampered()),
    }
}

pub(crate) fn record_page(cx: &Ctx<'_>, r: &ListRequest) -> Result<Page, DomainError> {
    let selection = selection_hash(&json!(["records"]));
    let last = match &r.cursor {
        Some(t) => open_keyset(cx, RECORD_LIST, &selection, t)?,
        None => None,
    };
    let limit = clamp(r.limit, 1, 100);
    let rows: Vec<(String, String, i64)> = {
        let mut sql =
            String::from("SELECT id, updated_at, local_no FROM records WHERE project_id = ?1");
        let mut args = vec![Sql::Text(cx.p.id.clone())];
        if let Some((at, no)) = &last {
            sql.push_str(" AND (updated_at, local_no) < (?2, ?3)");
            args.push(Sql::Text(at.clone()));
            args.push(Sql::Integer(no.as_i64().ok_or_else(cursor::tampered)?));
        }
        sql.push_str(&format!(
            " ORDER BY updated_at DESC, local_no DESC LIMIT {}",
            limit + 1
        ));
        cx.tx
            .prepare(&sql)
            .map_err(db)?
            .query_map(params_from_iter(args), |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(db)?
            .collect::<rusqlite::Result<_>>()
            .map_err(db)?
    };
    let has_more = rows.len() > limit;
    let mut items = Vec::new();
    let mut item_cursors = Vec::new();
    for (id, at, no) in rows.iter().take(limit) {
        items.push(jsify(views::record(cx, id)?));
        item_cursors.push(keyset_cursor(cx, RECORD_LIST, &selection, json!([at, no])));
    }
    Ok(Page {
        items,
        item_cursors,
        has_more,
        retry_cursor: r
            .cursor
            .clone()
            .unwrap_or_else(|| keyset_cursor(cx, RECORD_LIST, &selection, Value::Null)),
    })
}

pub(crate) fn session_page(cx: &Ctx<'_>, r: &ListRequest) -> Result<Page, DomainError> {
    let task_filter = r.task_key.as_deref().map(js_trim);
    let selection = selection_hash(&json!(["sessions", task_filter]));
    let last = match &r.cursor {
        Some(t) => open_keyset(cx, SESSION_LIST, &selection, t)?,
        None => None,
    };
    let limit = clamp(r.limit, 1, 100);
    let mut sql = format!("SELECT {SESSION_COLS} FROM {SESSION_FROM} WHERE s.project_id = ?");
    let mut args = vec![Sql::Text(cx.p.id.clone())];
    if let Some((at, id)) = &last {
        sql.push_str(" AND (s.started_at, s.id) < (?, ?)");
        args.push(Sql::Text(at.clone()));
        args.push(Sql::Text(
            id.as_str().ok_or_else(cursor::tampered)?.to_owned(),
        ));
    }
    if let Some(k) = task_filter {
        sql.push_str(" AND t.local_no = ?");
        args.push(Sql::Integer(
            keys::parse_task_key(&cx.p.code, k).unwrap_or(-1),
        ));
    }
    sql.push_str(&format!(
        " ORDER BY s.started_at DESC, s.id DESC LIMIT {}",
        limit + 1
    ));
    let rows: Vec<Value> = cx
        .tx
        .prepare(&sql)
        .map_err(db)?
        .query_map(params_from_iter(args), |row| {
            views::session_from_row(&cx.p.code, row)
        })
        .map_err(db)?
        .collect::<rusqlite::Result<_>>()
        .map_err(db)?;
    let has_more = rows.len() > limit;
    let items: Vec<Value> = rows.into_iter().take(limit).map(jsify).collect();
    let item_cursors = items
        .iter()
        .map(|s| {
            keyset_cursor(
                cx,
                SESSION_LIST,
                &selection,
                json!([s["started_at"], s["id"]]),
            )
        })
        .collect();
    Ok(Page {
        items,
        item_cursors,
        has_more,
        retry_cursor: r
            .cursor
            .clone()
            .unwrap_or_else(|| keyset_cursor(cx, SESSION_LIST, &selection, Value::Null)),
    })
}

fn fit_list(
    cx: &Ctx<'_>,
    list: &str,
    r: &ListRequest,
    page: Page,
    defaults: &[&str],
) -> Result<Value, DomainError> {
    let max_chars = clamp(r.max_chars, 300, 50_000);
    let mask: Vec<String> = if r.field_mask.is_empty() {
        defaults.iter().map(|s| (*s).to_owned()).collect()
    } else {
        r.field_mask.clone()
    };
    // 2.x 把整页条目的键合起来判断越界字段。
    let mut shape = Map::new();
    for item in &page.items {
        if let Some(m) = item.as_object() {
            for (k, v) in m {
                shape.insert(k.clone(), v.clone());
            }
        }
    }
    let ignored_fields = if page.items.is_empty() {
        Vec::new()
    } else {
        ignored(&shape, &r.field_mask)
    };
    let (echo, cost) = fit_ignored(&ignored_fields, max_chars);
    let projected = Page {
        items: page
            .items
            .iter()
            .map(|v| Value::Object(select(v.as_object().cloned().unwrap_or_default(), &mask)))
            .collect(),
        ..page
    };
    let mut head = Map::new();
    head.insert("exact".into(), json!(false));
    head.insert("project".into(), json!(cx.p.code));
    head.insert("list".into(), json!(list));
    head.insert("requested_limit".into(), json!(r.limit));
    let fitted = fit_page(&head, max_chars - cost, &projected, None, false).unwrap_or_else(|| {
        let mut m = head.clone();
        m.insert("returned_count".into(), json!(0));
        m.insert("items".into(), json!([]));
        m.insert("next_cursor".into(), json!(projected.retry_cursor));
        m.insert(
            "has_more".into(),
            json!(!projected.items.is_empty() || projected.has_more),
        );
        m.insert("truncated".into(), json!(!projected.items.is_empty()));
        Value::Object(m)
    });
    let combined = with_echo(fitted, echo);
    if js_len(&combined) > max_chars {
        return Err(too_large(
            "预算无法容纳列表回执",
            json!({ "recovery": { "action": "increase_max_chars", "preserve_cursor": true } }),
        ));
    }
    Ok(combined)
}

impl Service {
    /// `atm_search list=records`（S-066）。
    pub fn record_list(
        &self,
        principal: &Principal,
        project: &str,
        r: &ListRequest,
    ) -> Result<Value, DomainError> {
        self.read_project(principal, Capability::RecordRead, project, |cx| {
            let page = record_page(cx, r)?;
            fit_list(cx, "records", r, page, &RECORD_MASK)
        })
    }

    /// `atm_search list=sessions`（S-067；00 02 C-15）。
    pub fn session_list(
        &self,
        principal: &Principal,
        project: &str,
        r: &ListRequest,
    ) -> Result<Value, DomainError> {
        self.read_project(principal, Capability::SessionRead, project, |cx| {
            let page = session_page(cx, r)?;
            fit_list(cx, "sessions", r, page, &SESSION_MASK)
        })
    }
}
