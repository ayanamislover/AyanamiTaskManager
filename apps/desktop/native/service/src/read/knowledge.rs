//! 知识库读取与搜索（W2g4；04 §5.3、§5.4、L-109～L-116；00 C-L12、C-L13）。
//!
//! 照搬 2.x `knowledge-queries.ts` 的分页与预算规则，改两处：
//! - 游标 `k2`：库内密钥做 HMAC（C-L12），绑定知识库 database_id 与范围世代 `scope_gen`。恢复之后旧游标
//!   `INVALID_CURSOR SCOPE_RESTORED`；2.x 的 `k1` 是 `FORMAT_RETIRED`（Q-01：不新增错误码）。
//! - 读回执带 `isHead`（C-L13）：按 revisionId 读旧修订时，调用方一眼看出它不是 head，不会拿它去覆盖。
//!
//! Agent 视图（主体是 Agent）去掉作者等管理字段（L-116）；User 视图是完整的管理 DTO。

use super::codec::{b64, js_len, js_text, sha256};
use super::cursor::{self, exact_keys, int_of, str_of, tampered};
use super::{db, too_large};
use crate::write::{Service, internal};
use atm_domain::capability::{self, Capability};
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::principal::{Principal, PrincipalKind};
use atm_domain::text::js_trim;
use rusqlite::types::ToSql;
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Map, Value, json};

pub(crate) const KNOWLEDGE: &str = "k2";

pub const MAX_SEARCH_TERMS: usize = 8;

#[derive(Clone, Debug, PartialEq)]
pub struct KnowledgeSearchRequest {
    pub query: String,
    pub tag: Option<String>,
    pub include_archived: bool,
    /// 1～50，默认 5。
    pub limit: i64,
    /// 1～50000，默认 2400。
    pub max_chars: i64,
    pub cursor: Option<String>,
}

impl Default for KnowledgeSearchRequest {
    fn default() -> Self {
        KnowledgeSearchRequest {
            query: String::new(),
            tag: None,
            include_archived: false,
            limit: 5,
            max_chars: 2400,
            cursor: None,
        }
    }
}

/// 读正文还是读元数据（元数据分页只给 Agent，见 2.x `part:"metadata"`）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Part {
    #[default]
    Body,
    Metadata,
}

#[derive(Clone, Debug, PartialEq)]
pub struct KnowledgeGetRequest {
    pub id: String,
    /// Agent 首页附带 `edit` 块（slug、summary、tags、aliases）。
    pub for_edit: bool,
    pub revision_id: Option<String>,
    pub section: Option<String>,
    /// 1～600000，默认 6000。
    pub max_chars: i64,
    pub cursor: Option<String>,
    pub part: Part,
}

impl KnowledgeGetRequest {
    pub fn new(id: impl Into<String>) -> Self {
        KnowledgeGetRequest {
            id: id.into(),
            for_edit: false,
            revision_id: None,
            section: None,
            max_chars: 6000,
            cursor: None,
            part: Part::Body,
        }
    }
}

fn validation(field: &str, message: impl Into<String>) -> DomainError {
    DomainError::new(ErrorCode::VALIDATION_ERROR, message).detail("field", field)
}

fn bounded(field: &str, v: i64, max: i64) -> Result<(), DomainError> {
    if (1..=max).contains(&v) {
        Ok(())
    } else {
        Err(validation(field, format!("{field} 必须在 1～{max} 之间")).detail("got", v))
    }
}

fn too_small() -> DomainError {
    too_large(
        "max_chars 不足以容纳知识元数据与至少一项内容，请提高预算",
        json!({}),
    )
}

fn hash(v: &Value) -> String {
    b64(&sha256(js_text(v).as_bytes()))
}

// ---------- 游标 ----------

struct Identity {
    database: String,
    generation: i64,
    sequence: i64,
}

fn identity(tx: &Transaction<'_>) -> Result<Option<Identity>, DomainError> {
    tx.query_row(
        "SELECT database_id, scope_gen, sequence FROM knowledge_meta",
        [],
        |r| {
            Ok(Identity {
                database: r.get(0)?,
                generation: r.get(1)?,
                sequence: r.get(2)?,
            })
        },
    )
    .optional()
    .map_err(db)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Search,
    Get,
    Metadata,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Search => "search",
            Kind::Get => "get",
            Kind::Metadata => "metadata",
        }
    }
}

struct Cursor {
    position: usize,
    revision: i64,
    edit_version: i64,
    snapshot: String,
}

fn is_ulid(s: &str) -> bool {
    s.len() == 26
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b.is_ascii_uppercase() && !b"ILOU".contains(&b)))
}

fn make_cursor(key: &[u8], id: &Identity, kind: Kind, scope: &str, c: &Cursor) -> String {
    let mut m = Map::new();
    m.insert("k".into(), json!(kind.as_str()));
    m.insert("d".into(), json!(id.database));
    m.insert("g".into(), json!(id.generation));
    m.insert("s".into(), json!(scope));
    m.insert("o".into(), json!(c.position));
    m.insert("r".into(), json!(c.revision));
    m.insert("v".into(), json!(c.edit_version));
    m.insert("i".into(), json!(c.snapshot));
    cursor::seal_plain(key, KNOWLEDGE, m)
}

fn read_cursor(
    key: &[u8],
    id: Option<&Identity>,
    token: Option<&str>,
    kind: Kind,
    scope: &str,
) -> Result<Option<Cursor>, DomainError> {
    let Some(token) = token else {
        return Ok(None);
    };
    let m = cursor::open_plain(key, KNOWLEDGE, token)?;
    exact_keys(&m, &["k", "d", "g", "s", "o", "r", "v", "i"])?;
    let id = id.ok_or_else(tampered)?;
    if str_of(&m, "k")? != kind.as_str()
        || str_of(&m, "s")? != scope
        || str_of(&m, "d")? != id.database
    {
        return Err(tampered());
    }
    if int_of(&m, "g")? != id.generation {
        return Err(cursor::invalid("SCOPE_RESTORED"));
    }
    let (position, revision, edit_version) = (int_of(&m, "o")?, int_of(&m, "r")?, int_of(&m, "v")?);
    let snapshot = str_of(&m, "i")?.to_owned();
    if position < 0
        || revision < 0
        || edit_version < 0
        || (kind != Kind::Search && (edit_version == 0 || !is_ulid(&snapshot)))
    {
        return Err(tampered());
    }
    Ok(Some(Cursor {
        position: usize::try_from(position).map_err(|_| tampered())?,
        revision,
        edit_version,
        snapshot,
    }))
}

fn catalog_changed() -> DomainError {
    DomainError::new(
        ErrorCode::INVALID_CURSOR,
        "知识目录已更新，请重新搜索；已固定的正文修订仍可继续读取",
    )
    .detail("reason", "CATALOG_CHANGED")
    .detail(
        "recovery",
        json!({ "action": "restart_read", "omit_cursor": true }),
    )
}

// ---------- 搜索词（2.x search-terms.ts）----------

fn js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{FEFF}'
}

/// 按空白拆词；双引号括起来的一段算一个词；不分大小写去重；超过 8 个直接拒绝（不截断）。
pub(crate) fn search_terms(query: &str) -> Result<Vec<String>, DomainError> {
    let chars: Vec<char> = query.chars().collect();
    let mut i = 0;
    let mut seen = std::collections::HashSet::new();
    let mut terms = Vec::new();
    while i < chars.len() {
        if js_space(chars[i]) {
            i += 1;
            continue;
        }
        let raw: String = if chars[i] == '"'
            && let Some(close) = chars[i + 1..].iter().position(|c| *c == '"')
        {
            let inner: String = chars[i + 1..i + 1 + close].iter().collect();
            i += close + 2;
            inner
        } else {
            let start = i;
            while i < chars.len() && !js_space(chars[i]) {
                i += 1;
            }
            chars[start..i].iter().collect()
        };
        let term = raw.trim_matches(js_space).to_owned();
        if term.is_empty() || !seen.insert(term.to_lowercase()) {
            continue;
        }
        terms.push(term);
    }
    if terms.len() > MAX_SEARCH_TERMS {
        return Err(validation(
            "query",
            format!(
                "query 最多 {MAX_SEARCH_TERMS} 个词（去重后 {} 个）：删掉次要的词，或用双引号把相邻的几个词合成一个短语",
                terms.len()
            ),
        )
        .detail("issue", "too_many_terms")
        .detail("max", MAX_SEARCH_TERMS)
        .detail("actual", terms.len()));
    }
    Ok(terms)
}

/// trigram FTS 服务不了少于三个 code point 的词。
fn uses_fts(term: &str) -> bool {
    term.chars().count() >= 3
}

fn fts_phrase(term: &str) -> String {
    format!("\"{}\"", term.replace('"', "\"\""))
}

fn like_pattern(term: &str) -> String {
    let mut out = String::from("%");
    for c in term.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

// ---------- 视图 ----------

const HIT_KEYS: [&str; 13] = [
    "slug",
    "title",
    "summary",
    "useWhen",
    "tags",
    "appliesTo",
    "id",
    "revision",
    "revisionId",
    "createdAt",
    "publishedBy",
    "version",
    "archived",
];
const AGENT_HIT_KEYS: [&str; 8] = [
    "title",
    "summary",
    "useWhen",
    "tags",
    "appliesTo",
    "id",
    "revisionId",
    "archived",
];
const CONTENT_KEYS: [&str; 9] = [
    "slug",
    "title",
    "summary",
    "useWhen",
    "tags",
    "aliases",
    "appliesTo",
    "bodyMarkdown",
    "sourceRefs",
];

fn pick(from: &Map<String, Value>, keys: &[&str]) -> Map<String, Value> {
    keys.iter()
        .filter_map(|k| from.get(*k).map(|v| ((*k).to_owned(), v.clone())))
        .collect()
}

/// 一条条目在某个修订上的样子：快照 + head 的 version / archived（2.x `get`）+ isHead（C-L13）。
struct Entry {
    fields: Map<String, Value>,
    revision: i64,
    revision_id: String,
    version: i64,
    body: String,
}

fn entry(tx: &Transaction<'_>, id: &str, revision_id: Option<&str>) -> Result<Entry, DomainError> {
    let head: Option<(i64, i64, i64)> = tx
        .query_row(
            "SELECT head_revision, version, archived FROM knowledge_entries WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(db)?;
    let Some((head_revision, version, archived)) = head else {
        return Err(DomainError::new(ErrorCode::NOT_FOUND, "知识条目不存在")
            .detail("entity", "KNOWLEDGE")
            .detail("id", id));
    };
    let snapshot: Option<(i64, String)> = match revision_id {
        Some(rid) => tx.query_row(
            "SELECT revision, snapshot FROM knowledge_revisions WHERE entry_id = ?1 AND revision_id = ?2",
            [id, rid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ),
        None => tx.query_row(
            "SELECT revision, snapshot FROM knowledge_revisions WHERE entry_id = ?1 AND revision = ?2",
            params![id, head_revision],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ),
    }
    .optional()
    .map_err(db)?;
    let Some((revision, snapshot)) = snapshot else {
        return Err(DomainError::new(ErrorCode::NOT_FOUND, "知识修订不存在")
            .detail("entity", "KNOWLEDGE_REVISION")
            .detail("revision_id", revision_id));
    };
    let Value::Object(mut fields) = serde_json::from_str(&snapshot).map_err(internal)? else {
        return Err(internal("knowledge snapshot is not an object"));
    };
    let body = fields
        .get("bodyMarkdown")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let revision_id = fields
        .get("revisionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    fields.insert("archived".into(), json!(archived == 1));
    fields.insert("isHead".into(), json!(revision == head_revision));
    Ok(Entry {
        fields,
        revision,
        revision_id,
        version,
        body,
    })
}

// ---------- 目录（2.x headings）----------

struct Heading {
    id: String,
    title: String,
    level: usize,
    /// UTF-16 码元偏移。
    start: usize,
}

fn line_end(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `^ {0,3}` 之后的部分；缩进超过三格返回 None。
fn indent(line: &str) -> Option<&str> {
    let n = line.bytes().take_while(|b| *b == b' ').count();
    (n <= 3).then(|| &line[n..])
}

fn headings(markdown: &str) -> Vec<Heading> {
    let mut out: Vec<Heading> = Vec::new();
    let mut offset = 0;
    let mut fence: Option<(char, usize)> = None;
    for line in markdown.split_inclusive('\n') {
        let fenced = indent(line).and_then(|rest| {
            let c = rest.chars().next().filter(|c| *c == '`' || *c == '~')?;
            let size = rest.chars().take_while(|x| *x == c).count();
            (size >= 3).then(|| {
                let tail: String = rest[size..].chars().take_while(|x| !line_end(*x)).collect();
                (c, size, tail)
            })
        });
        if let Some((c, size, tail)) = fenced {
            match fence {
                None => fence = Some((c, size)),
                Some((fc, fs))
                    if c == fc && size >= fs && tail.trim_matches(js_space).is_empty() =>
                {
                    fence = None;
                }
                _ => {}
            }
        } else if fence.is_none()
            && let Some((level, title)) = heading(line.trim_end_matches(js_space))
        {
            out.push(Heading {
                id: format!("h-{}", out.len() + 1),
                title,
                level,
                start: offset,
            });
        }
        offset += line.encode_utf16().count();
    }
    out
}

/// `^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$`，标题去掉收尾的 `#` 再去空白。
fn heading(line: &str) -> Option<(usize, String)> {
    let rest = indent(line)?;
    let level = rest.bytes().take_while(|b| *b == b'#').count();
    if !(1..=6).contains(&level) {
        return None;
    }
    let after = &rest[level..];
    if !(after.is_empty() || after.starts_with([' ', '\t'])) {
        return None;
    }
    let text = after.trim_start_matches([' ', '\t']);
    if text.chars().any(line_end) {
        return None;
    }
    let spaced = text.trim_end_matches([' ', '\t']);
    let unhashed = spaced.trim_end_matches('#');
    let title = if unhashed.len() < spaced.len() && unhashed.ends_with([' ', '\t']) {
        unhashed
    } else {
        text
    };
    Some((level, title.trim_matches(js_space).to_owned()))
}

// ---------- 读 ----------

fn utf16(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

fn text_of(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// 切点落在代理对中间时退一格（不劈开代理对）。
fn boundary(units: &[u16], offset: usize, index: usize) -> usize {
    if index > offset
        && index < units.len()
        && (units[index] & 0xfc00) == 0xdc00
        && (units[index - 1] & 0xfc00) == 0xd800
    {
        index - 1
    } else {
        index
    }
}

/// 在预算内取最多的码元：整段放得下就整段，否则二分。返回码元数。
fn fit(total: usize, max: usize, len: &dyn Fn(usize) -> usize) -> usize {
    if len(total) <= max {
        return total;
    }
    let (mut low, mut high) = (0, total.saturating_sub(1));
    while low < high {
        let mid = (low + high).div_ceil(2);
        if len(mid) <= max {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    low
}

fn ulid_arg(field: &str, v: Option<&str>) -> Result<Option<String>, DomainError> {
    match v {
        Some(s) if !is_ulid(s) => Err(validation(
            field,
            format!("{field} 必须是修订 ID（26 位 ULID）"),
        )),
        other => Ok(other.map(str::to_owned)),
    }
}

impl Service {
    /// 知识搜索（04 §5.4、L-111、L-114、L-115、L-116）。
    pub fn knowledge_search(
        &self,
        principal: &Principal,
        r: &KnowledgeSearchRequest,
    ) -> Result<Value, DomainError> {
        capability::require(principal, Capability::KnowledgeRead)?;
        let agent = principal.kind() == PrincipalKind::Agent;
        let query = js_trim(&r.query).to_owned();
        if query.encode_utf16().count() > 500 {
            return Err(validation("query", "query 最多 500 个字符"));
        }
        if query.contains('\0') {
            return Err(validation("query", "query 不能包含 U+0000（NUL）"));
        }
        let tag = match r.tag.as_deref().map(js_trim) {
            Some("") => return Err(validation("tag", "tag 不能为空")),
            Some(t) if t.encode_utf16().count() > 80 => {
                return Err(validation("tag", "tag 最多 80 个字符"));
            }
            other => other.map(str::to_owned),
        };
        bounded("limit", r.limit, 50)?;
        bounded("max_chars", r.max_chars, 50_000)?;
        let terms = search_terms(&query)?;
        let (limit, max_chars) = (r.limit as usize, r.max_chars as usize);
        let token = r.cursor.clone();
        let include_archived = r.include_archived;
        self.store()
            .read(move |tx| {
                let key = super::cursor_key(tx)?;
                let id = identity(tx)?;
                let scope = hash(&json!([query, tag, include_archived]));
                let cursor = read_cursor(&key, id.as_ref(), token.as_deref(), Kind::Search, &scope)?;
                let sequence = id.as_ref().map_or(0, |i| i.sequence);
                if cursor.as_ref().is_some_and(|c| c.revision != sequence) {
                    return Err(catalog_changed());
                }
                let offset = cursor.as_ref().map_or(0, |c| c.position);
                let rows = search_rows(tx, &query, tag.as_deref(), include_archived, &terms, limit + 1, offset)?;
                let keys: &[&str] = if agent { &AGENT_HIT_KEYS } else { &HIT_KEYS };
                let hits: Vec<Value> = rows
                    .iter()
                    .take(limit)
                    .map(|m| Value::Object(pick(m, keys)))
                    .collect();
                let page = |count: usize| -> Value {
                    let more = rows.len() > count;
                    json!({
                        "hits": hits[..count],
                        "hasMore": more,
                        "nextCursor": match (&id, more) {
                            (Some(id), true) => Value::String(make_cursor(&key, id, Kind::Search, &scope, &Cursor {
                                position: offset + count,
                                revision: sequence,
                                edit_version: 0,
                                snapshot: String::new(),
                            })),
                            _ => Value::Null,
                        },
                    })
                };
                for count in (1..=hits.len()).rev() {
                    let p = page(count);
                    if js_len(&p) <= max_chars {
                        return Ok(p);
                    }
                }
                let empty = page(0);
                if !hits.is_empty() || js_len(&empty) > max_chars {
                    return Err(too_small());
                }
                Ok(empty)
            })
            .map_err(super::read_error)
    }

    /// 读一条知识（04 §5.3、L-109、L-110、L-115、L-116）。
    pub fn knowledge_get(
        &self,
        principal: &Principal,
        r: &KnowledgeGetRequest,
    ) -> Result<Value, DomainError> {
        capability::require(principal, Capability::KnowledgeRead)?;
        let agent = principal.kind() == PrincipalKind::Agent;
        let id = js_trim(&r.id).to_owned();
        if id.is_empty() || id.encode_utf16().count() > 100 {
            return Err(validation("id", "id 必须是 1 至 100 个字符"));
        }
        let revision_id = ulid_arg("revision_id", r.revision_id.as_deref())?;
        let section = match r.section.as_deref().map(js_trim) {
            Some("") => return Err(validation("section", "section 不能为空")),
            Some(s) if s.encode_utf16().count() > 200 => {
                return Err(validation("section", "section 最多 200 个字符"));
            }
            other => other.map(str::to_owned),
        };
        bounded("max_chars", r.max_chars, 600_000)?;
        let max = r.max_chars as usize;
        if r.part == Part::Metadata {
            if !agent {
                return Err(DomainError::new(
                    ErrorCode::INVALID_ARGUMENT,
                    "元数据分页只给 Agent；管理界面读完整条目",
                ));
            }
            if section.is_some() {
                return Err(DomainError::new(
                    ErrorCode::INVALID_ARGUMENT,
                    "元数据分页不能与 section 混用",
                ));
            }
        }
        let (part, for_edit, token) = (r.part, r.for_edit, r.cursor.clone());
        self.store()
            .read(move |tx| {
                let key = super::cursor_key(tx)?;
                let ident = identity(tx)?;
                if part == Part::Metadata {
                    return metadata_page(
                        tx,
                        &key,
                        ident.as_ref(),
                        &id,
                        revision_id.as_deref(),
                        token.as_deref(),
                        max,
                    );
                }
                let scope = hash(&json!([id, section]));
                let cursor =
                    read_cursor(&key, ident.as_ref(), token.as_deref(), Kind::Get, &scope)?;
                if let (Some(c), Some(rid)) = (&cursor, &revision_id)
                    && c.snapshot != *rid
                {
                    return Err(cursor::invalid("REVISION_MISMATCH"));
                }
                let e = entry(
                    tx,
                    &id,
                    cursor
                        .as_ref()
                        .map(|c| c.snapshot.as_str())
                        .or(revision_id.as_deref()),
                )?;
                // 续页沿用首页的 version：旧正文配新版本号等于授权一次覆盖（L-110）。
                let edit_version = cursor.as_ref().map_or(e.version, |c| c.edit_version);
                let continuation = cursor.is_some();
                let all = if !agent || !continuation || section.is_some() {
                    headings(&e.body)
                } else {
                    Vec::new()
                };
                let toc: Vec<Value> = all
                    .iter()
                    .map(|h| json!({ "id": h.id, "title": h.title, "level": h.level }))
                    .collect();
                let mut body = utf16(&e.body);
                if let Some(section) = &section {
                    let index = match all.iter().position(|h| h.id == *section) {
                        Some(i) => Some(i),
                        None => {
                            let matches: Vec<usize> = all
                                .iter()
                                .enumerate()
                                .filter(|(_, h)| h.title == *section)
                                .map(|(i, _)| i)
                                .collect();
                            if matches.len() > 1 {
                                return Err(DomainError::new(
                                    ErrorCode::INVALID_ARGUMENT,
                                    "章节标题重复，请使用章节 ID",
                                )
                                .detail(
                                    "candidateIds",
                                    matches
                                        .iter()
                                        .take(20)
                                        .map(|i| all[*i].id.clone())
                                        .collect::<Vec<_>>(),
                                )
                                .detail("candidateCount", matches.len()));
                            }
                            matches.first().copied()
                        }
                    };
                    let Some(index) = index else {
                        return Err(DomainError::new(
                            ErrorCode::NOT_FOUND,
                            "知识章节不存在，请从 toc 选择 section",
                        ));
                    };
                    let h = &all[index];
                    let end = all[index + 1..]
                        .iter()
                        .find(|x| x.level <= h.level)
                        .map_or(body.len(), |x| x.start);
                    body = body[h.start..end].to_vec();
                }
                let total = body.len();
                let offset = cursor.as_ref().map_or(0, |c| c.position);
                if offset > total {
                    return Err(tampered());
                }
                let end_of = |count: usize| boundary(&body, offset, (offset + count).min(total));
                let page = |count: usize| -> Value {
                    let end = end_of(count);
                    let next = match (&ident, end < total) {
                        (Some(i), true) => Value::String(make_cursor(
                            &key,
                            i,
                            Kind::Get,
                            &scope,
                            &Cursor {
                                position: end,
                                revision: e.revision,
                                edit_version,
                                snapshot: e.revision_id.clone(),
                            },
                        )),
                        _ => Value::Null,
                    };
                    let chunk = text_of(&body[offset..end]);
                    if agent {
                        agent_page(
                            &e,
                            chunk,
                            end < total,
                            next,
                            &toc,
                            continuation,
                            for_edit,
                            max,
                        )
                    } else {
                        let mut m = pick(&e.fields, &CONTENT_KEYS);
                        m.insert("bodyMarkdown".into(), json!(chunk));
                        for k in ["id", "revision", "revisionId", "createdAt", "publishedBy"] {
                            if let Some(v) = e.fields.get(k) {
                                m.insert(k.into(), v.clone());
                            }
                        }
                        m.insert("version".into(), json!(edit_version));
                        m.insert("archived".into(), e.fields["archived"].clone());
                        m.insert("isHead".into(), e.fields["isHead"].clone());
                        m.insert("toc".into(), json!(toc));
                        m.insert("truncated".into(), json!(end < total));
                        m.insert("nextCursor".into(), next);
                        Value::Object(m)
                    }
                };
                let count = fit(total - offset, max, &|n| js_len(&page(n)));
                let result = page(count);
                // 切点被退回起点时这一页是空的，再发游标就指回原处，续读会死循环（L-115）。
                if (end_of(count) == offset && offset < total) || js_len(&result) > max {
                    return Err(too_small());
                }
                Ok(result)
            })
            .map_err(super::read_error)
    }

    /// 修订历史（04 L-113）：keyset 翻页，不带正文。
    pub fn knowledge_history(
        &self,
        principal: &Principal,
        id: &str,
        before_revision: Option<i64>,
        limit: Option<i64>,
    ) -> Result<Value, DomainError> {
        capability::require(principal, Capability::KnowledgeRead)?;
        let id = js_trim(id).to_owned();
        self.store()
            .read(move |tx| {
                entry(tx, &id, None)?;
                let limit = limit.unwrap_or(50);
                if !(1..=100).contains(&limit) || before_revision.is_some_and(|b| b < 1) {
                    return Err(DomainError::new(
                        ErrorCode::INVALID_ARGUMENT,
                        "limit 必须在 1～100 之间，beforeRevision 必须是正整数",
                    ));
                }
                let mut st = tx
                    .prepare(
                        "SELECT json_remove(snapshot, '$.bodyMarkdown') FROM knowledge_revisions
                         WHERE entry_id = ?1 AND revision < ?2 ORDER BY revision DESC LIMIT ?3",
                    )
                    .map_err(db)?;
                let rows: Vec<String> = st
                    .query_map(
                        params![id, before_revision.unwrap_or(i64::MAX), limit + 1],
                        |r| r.get(0),
                    )
                    .map_err(db)?
                    .collect::<Result<_, _>>()
                    .map_err(db)?;
                let more = rows.len() as i64 > limit;
                let revisions = rows
                    .iter()
                    .take(limit as usize)
                    .map(|s| serde_json::from_str::<Value>(s).map_err(internal))
                    .collect::<Result<Vec<_>, _>>()?;
                let next = if more {
                    revisions
                        .last()
                        .map_or(Value::Null, |r| r["revision"].clone())
                } else {
                    Value::Null
                };
                Ok(json!({ "revisions": revisions, "nextRevision": next }))
            })
            .map_err(super::read_error)
    }
}

/// Agent 的正文页：续页只带身份与正文；首页带目录与元数据，元数据放不下时不给截断后的编辑值（L-115）。
#[allow(clippy::too_many_arguments)]
fn agent_page(
    e: &Entry,
    chunk: String,
    truncated: bool,
    next: Value,
    toc: &[Value],
    continuation: bool,
    for_edit: bool,
    max: usize,
) -> Value {
    let mut m = Map::new();
    m.insert("id".into(), e.fields["id"].clone());
    m.insert("revisionId".into(), json!(e.revision_id));
    m.insert("archived".into(), e.fields["archived"].clone());
    m.insert("bodyMarkdown".into(), json!(chunk));
    m.insert("truncated".into(), json!(truncated));
    m.insert("nextCursor".into(), next);
    if continuation {
        return Value::Object(m);
    }
    m.insert("isHead".into(), e.fields["isHead"].clone());
    let mut short: Vec<Value> = toc
        .iter()
        .take(40)
        .map(|h| {
            let title: Vec<char> = h["title"].as_str().unwrap_or_default().chars().collect();
            let mut h = h.clone();
            if title.len() > 120 {
                h["title"] = json!(format!("{}…", title[..120].iter().collect::<String>()));
            }
            h
        })
        .collect();
    let budget = 1600.min(max / 3);
    while !short.is_empty() && js_len(&json!(short)) > budget {
        short.pop();
    }
    let mut full = m.clone();
    for k in ["title", "useWhen", "appliesTo", "sourceRefs"] {
        full.insert(k.into(), e.fields.get(k).cloned().unwrap_or(Value::Null));
    }
    full.insert("tocTruncated".into(), json!(short.len() < toc.len()));
    full.insert("toc".into(), json!(short));
    full.insert("tocTotal".into(), json!(toc.len()));
    if for_edit {
        full.insert(
            "edit".into(),
            Value::Object(pick(&e.fields, &["slug", "summary", "tags", "aliases"])),
        );
    }
    let mut probe = full.clone();
    probe.insert("bodyMarkdown".into(), json!(""));
    if js_len(&Value::Object(probe)) <= max.saturating_sub(32) {
        return Value::Object(full);
    }
    let title: String = e.fields["title"]
        .as_str()
        .unwrap_or_default()
        .chars()
        .take(80)
        .collect();
    m.insert("title".into(), json!(title));
    m.insert("useWhen".into(), json!(""));
    m.insert("appliesTo".into(), json!([]));
    m.insert("sourceRefs".into(), json!([]));
    m.insert("toc".into(), json!([]));
    m.insert("tocTotal".into(), json!(toc.len()));
    m.insert("tocTruncated".into(), json!(!toc.is_empty()));
    m.insert("metadataTruncated".into(), json!(true));
    let count = |k: &str| {
        e.fields
            .get(k)
            .and_then(Value::as_array)
            .map_or(0, Vec::len)
    };
    m.insert("sourceRefsTotal".into(), json!(count("sourceRefs")));
    m.insert("appliesToTotal".into(), json!(count("appliesTo")));
    m.insert(
        "metadataRead".into(),
        json!({ "id": e.fields["id"], "revision_id": e.revision_id, "part": "metadata" }),
    );
    Value::Object(m)
}

/// Agent 的元数据分页：内容（不含正文）的 JSON 文本，按码元无损分页、绑定修订。
fn metadata_page(
    tx: &Transaction<'_>,
    key: &[u8],
    ident: Option<&Identity>,
    id: &str,
    revision_id: Option<&str>,
    token: Option<&str>,
    max: usize,
) -> Result<Value, DomainError> {
    let scope = hash(&json!([id, "metadata"]));
    let cursor = read_cursor(key, ident, token, Kind::Metadata, &scope)?;
    if let (Some(c), Some(rid)) = (&cursor, revision_id)
        && c.snapshot != rid
    {
        return Err(cursor::invalid("REVISION_MISMATCH"));
    }
    let e = entry(
        tx,
        id,
        cursor.as_ref().map(|c| c.snapshot.as_str()).or(revision_id),
    )?;
    let mut content = pick(&e.fields, &CONTENT_KEYS);
    content.remove("bodyMarkdown");
    let text = utf16(&js_text(&Value::Object(content)));
    let offset = cursor.as_ref().map_or(0, |c| c.position);
    if offset > text.len() {
        return Err(tampered());
    }
    let edit_version = cursor.as_ref().map_or(e.version, |c| c.edit_version);
    let page = |count: usize| -> (Value, usize) {
        let end = boundary(&text, offset, (offset + count).min(text.len()));
        let truncated = end < text.len();
        let next = match (ident, truncated) {
            (Some(i), true) => Value::String(make_cursor(
                key,
                i,
                Kind::Metadata,
                &scope,
                &Cursor {
                    position: end,
                    revision: e.revision,
                    edit_version,
                    snapshot: e.revision_id.clone(),
                },
            )),
            _ => Value::Null,
        };
        let v = json!({
            "id": e.fields["id"],
            "revisionId": e.revision_id,
            "part": "metadata",
            "metadataJson": text_of(&text[offset..end]),
            "offset": offset,
            "totalChars": text.len(),
            "truncated": truncated,
            "nextCursor": next,
        });
        (v, end)
    };
    let remaining = text.len() - offset;
    let count = if js_len(&page(remaining).0) <= max {
        remaining
    } else {
        let (mut low, mut high) = (0, remaining);
        while low < high {
            let mid = (low + high).div_ceil(2);
            if js_len(&page(mid).0) <= max {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        low
    };
    let (result, end) = page(count);
    if end == offset || js_len(&result) > max {
        return Err(too_small());
    }
    Ok(result)
}

/// 搜索的 SQL（2.x 原样）：每个词各自匹配、彼此 AND；排名按整条 query 算。返回命中的 metadata（version、archived
/// 以 entries 为准）。
fn search_rows(
    tx: &Transaction<'_>,
    query: &str,
    tag: Option<&str>,
    include_archived: bool,
    terms: &[String],
    limit: usize,
    offset: usize,
) -> Result<Vec<Map<String, Value>>, DomainError> {
    let fields = [
        "title",
        "summary",
        "use_when",
        "aliases",
        "tags",
        "applies_to",
    ];
    let metadata = |name: &str| {
        fields
            .iter()
            .map(|f| format!("instr(lower(f.{f}), lower(@{name})) > 0"))
            .collect::<Vec<_>>()
            .join(" OR ")
    };
    let mut values: Vec<(String, Box<dyn ToSql>)> = vec![
        ("@q".into(), Box::new(query.to_owned())),
        ("@tag".into(), Box::new(tag.map(str::to_owned))),
        ("@archived".into(), Box::new(i64::from(include_archived))),
        ("@limit".into(), Box::new(limit as i64)),
        ("@offset".into(), Box::new(offset as i64)),
    ];
    let mut matches = Vec::new();
    for (i, term) in terms.iter().enumerate() {
        let body = if uses_fts(term) {
            values.push((format!("@m{i}"), Box::new(fts_phrase(term))));
            format!("e.id IN (SELECT entry_id FROM knowledge_fts WHERE knowledge_fts MATCH @m{i})")
        } else {
            values.push((format!("@m{i}"), Box::new(like_pattern(term))));
            format!("f.body LIKE @m{i} ESCAPE '\\'")
        };
        values.push((format!("@t{i}"), Box::new(term.clone())));
        matches.push(format!(
            "(e.id = @t{i} OR instr(lower(e.slug), lower(@t{i})) > 0 OR {} OR {body})",
            metadata(&format!("t{i}"))
        ));
    }
    let sql = format!(
        "SELECT e.version, e.archived, f.metadata,
           CASE WHEN e.id = @q OR lower(e.slug) = lower(@q) OR lower(f.title) = lower(@q) THEN 0
             WHEN instr(lower(f.title), lower(@q)) > 0 THEN 1
             WHEN instr(lower(f.aliases), lower(@q)) > 0 OR instr(lower(f.tags), lower(@q)) > 0 THEN 2
             WHEN {} THEN 3 ELSE 4 END AS rank
         FROM knowledge_fts f JOIN knowledge_entries e ON e.id = f.entry_id
         WHERE (@archived = 1 OR e.archived = 0)
           AND (@tag IS NULL OR EXISTS (SELECT 1 FROM json_each(f.metadata, '$.tags') WHERE value = @tag))
           AND {}
         ORDER BY rank, e.id DESC LIMIT @limit OFFSET @offset",
        metadata("q"),
        if matches.is_empty() {
            "1 = 1".to_owned()
        } else {
            matches.join(" AND ")
        }
    );
    let mut st = tx.prepare(&sql).map_err(db)?;
    let named: Vec<(&str, &dyn ToSql)> = values
        .iter()
        .filter(|(name, _)| sql.contains(name.as_str()))
        .map(|(name, v)| (name.as_str(), v.as_ref()))
        .collect();
    let rows = st
        .query_map(named.as_slice(), |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(db)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db)?;
    rows.into_iter()
        .map(|(version, archived, metadata)| {
            let Value::Object(mut m) = serde_json::from_str(&metadata).map_err(internal)? else {
                return Err(internal("knowledge metadata is not an object"));
            };
            m.insert("version".into(), json!(version));
            m.insert("archived".into(), json!(archived == 1));
            Ok(m)
        })
        .collect()
}

impl Service {
    /// 把一条项目记录预览成知识条目的草稿（`knowledge.preview_record`，只有 User；2.x
    /// `knowledge-service.ts:84-100`）。只读：返回标题、摘要、正文与固定了版本的来源，保存仍走 knowledge_save。
    pub fn preview_record(
        &self,
        principal: &Principal,
        project: &str,
        record: &str,
    ) -> Result<Value, DomainError> {
        self.read_project(principal, Capability::KnowledgePreviewRecord, project, |cx| {
            let id = super::views::record_id(cx, record)?;
            let (no, kind, title, summary, detail, version): (i64, String, String, String, String, i64) = cx
                .tx
                .query_row(
                    "SELECT local_no, kind, title, summary, detail, version FROM records WHERE project_id = ?1 AND id = ?2",
                    params![cx.p.id, id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
                )
                .map_err(db)?;
            let letter = if kind == "DECISION" {
                atm_domain::keys::RecordLetter::Decision
            } else {
                atm_domain::keys::RecordLetter::Other
            };
            Ok(json!({
                "title": title,
                "summary": summary,
                "bodyMarkdown": detail,
                "sourceRef": {
                    "type": "project_record",
                    "reference": atm_domain::keys::record_key(&cx.p.code, letter, no),
                    "projectId": cx.p.id,
                    "recordId": id,
                    "sourceVersion": version,
                },
            }))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_terms_follow_2x() {
        assert_eq!(
            search_terms("D-398 HALF_OPEN 复审").unwrap(),
            ["D-398", "HALF_OPEN", "复审"]
        );
        assert_eq!(
            search_terms(r#""foo bar" baz Foo"#).unwrap(),
            ["foo bar", "baz", "Foo"]
        );
        assert_eq!(search_terms("a A a").unwrap(), ["a"]);
        assert_eq!(
            search_terms(r#""unclosed x"#).unwrap(),
            [r#""unclosed"#, "x"]
        );
        assert_eq!(search_terms(r#""" "  " y"#).unwrap(), ["y"]);
        assert!(search_terms("1 2 3 4 5 6 7 8").is_ok());
        let e = search_terms("1 2 3 4 5 6 7 8 9").unwrap_err();
        assert_eq!(e.code, ErrorCode::VALIDATION_ERROR);
        assert_eq!(e.details["actual"], 9);
        assert_eq!(like_pattern(r"5%_\"), r"%5\%\_\\%");
        assert_eq!(fts_phrase(r#"a"b"#), r#""a""b""#);
        assert!(uses_fts("备份策") && !uses_fts("备份") && uses_fts("abc") && !uses_fts("ab"));
    }

    #[test]
    fn headings_follow_2x() {
        let md = "# 一\n正文\n```\n# 不是\n```\n  ## 二 ##\n####### 七个\n#没空格\n    # 缩进四格\n~~~~\n## 也不是\n~~~\n## 还在围栏里\n~~~~\n### 三\t\n";
        let h = headings(md);
        let got: Vec<(&str, &str, usize)> = h
            .iter()
            .map(|x| (x.id.as_str(), x.title.as_str(), x.level))
            .collect();
        assert_eq!(got, [("h-1", "一", 1), ("h-2", "二", 2), ("h-3", "三", 3)]);
        assert_eq!(h[0].start, 0);
        assert_eq!(
            h[1].start,
            md.split("  ## 二").next().unwrap().encode_utf16().count()
        );
        assert_eq!(heading("#").map(|x| x.1), Some(String::new()));
        assert_eq!(heading("# a # b ##").map(|x| x.1), Some("a # b".into()));
        assert_eq!(heading("# a#").map(|x| x.1), Some("a#".into()));
    }

    #[test]
    fn surrogate_pairs_are_never_split() {
        let units = utf16("a😀b");
        assert_eq!(boundary(&units, 0, 2), 1);
        assert_eq!(boundary(&units, 0, 3), 3);
        assert_eq!(boundary(&units, 1, 1), 1);
    }
}
