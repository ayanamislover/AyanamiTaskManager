//! 搜索（W1d，05 §2.5）：`search_docs` + 外部内容 `search_fts`（trigram），知识库的 `knowledge_fts`。
//!
//! - 项目搜索与全局搜索共用一张 `search_docs`；全局搜索按项目 lifecycle 过滤。
//! - `search_fts` 由三个触发器跟随 `search_docs` 维护，这里只写 `search_docs`。
//!   `doc_id` 是显式 INTEGER PRIMARY KEY，VACUUM 不会重排它，FTS 的 rowid 映射因此稳定。
//! - 词项规则照搬 2.0 `search-terms.ts`：按空白拆词，双引号括起的一段算一个词，大小写折叠后去重，
//!   最多 8 个词，词与词 AND。trigram 服务不了不足 3 个 code point 的词，这类词改用 LIKE 扫表，
//!   中文双字词因此仍能搜到（r2 A6）。
//! - 文档内容（标题、正文怎么拼）由服务层决定，这里不派生。
//! - `knowledge_fts` 是普通 fts5 表（字段与 2.0 一致），从每个条目的 head revision 重建。

use rusqlite::types::Value;
use rusqlite::{Connection, Transaction, params, params_from_iter};

pub const MAX_SEARCH_TERMS: usize = 8;

#[derive(Debug, PartialEq, Eq)]
pub enum TermsError {
    /// 去重后超过 [`MAX_SEARCH_TERMS`] 个词。不截断：契约是每个词都要命中。
    TooMany { actual: usize },
}

/// 2.0 `searchTerms`：正则 `"([^"]*)"|(\S+)` 的逐字符实现。
/// 引号只在词首有意义：`ab"cd` 是一个普通词；没有闭合的引号也按普通词处理。
pub fn terms(query: &str) -> Result<Vec<String>, TermsError> {
    let chars: Vec<char> = query.chars().collect();
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if is_space(chars[i]) {
            i += 1;
            continue;
        }
        let raw: String;
        if chars[i] == '"'
            && let Some(close) = chars[i + 1..].iter().position(|c| *c == '"')
        {
            raw = chars[i + 1..i + 1 + close].iter().collect();
            i += close + 2;
        } else {
            let start = i;
            while i < chars.len() && !is_space(chars[i]) {
                i += 1;
            }
            raw = chars[start..i].iter().collect();
        }
        let term = raw.trim_matches(is_space).to_string();
        if term.is_empty() || !seen.insert(term.to_lowercase()) {
            continue;
        }
        out.push(term);
    }
    if out.len() > MAX_SEARCH_TERMS {
        return Err(TermsError::TooMany { actual: out.len() });
    }
    Ok(out)
}

/// JS 的 `\s`：Unicode 空白再加 U+FEFF。
fn is_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// 不少于 3 个 code point 的词走 FTS。
pub fn uses_fts(term: &str) -> bool {
    term.chars().count() >= 3
}

/// 引号短语让 FTS 语法字面化：连字符、冒号、AND/OR 都不再是运算符。
pub fn fts_phrase(term: &str) -> String {
    format!("\"{}\"", term.replace('"', "\"\""))
}

/// `%`、`_` 和反斜杠在 LIKE 里是元字符，配合 `ESCAPE '\'` 使用。
pub fn like_pattern(term: &str) -> String {
    let mut s = String::with_capacity(term.len() + 2);
    s.push('%');
    for c in term.chars() {
        if matches!(c, '\\' | '%' | '_') {
            s.push('\\');
        }
        s.push(c);
    }
    s.push('%');
    s
}

/// 一份搜索文档。`(project_id, entity_type, entity_id)` 唯一。
#[derive(Clone, Debug)]
pub struct Doc<'a> {
    pub project_id: &'a str,
    pub entity_type: &'a str,
    pub entity_id: &'a str,
    pub entity_key: &'a str,
    pub title: &'a str,
    pub body: &'a str,
    pub updated_at: &'a str,
}

/// 新增或更新一份文档（2.0 `upsertSearchDocument` 的语义：同一实体的 key、标题、正文、时间整体替换）。
pub fn upsert_doc(tx: &Transaction<'_>, d: &Doc<'_>) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO search_docs (project_id, entity_type, entity_id, entity_key, title, body, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (project_id, entity_type, entity_id) DO UPDATE SET
           entity_key = excluded.entity_key, title = excluded.title, body = excluded.body, updated_at = excluded.updated_at",
        params![d.project_id, d.entity_type, d.entity_id, d.entity_key, d.title, d.body, d.updated_at],
    )?;
    Ok(())
}

pub fn delete_doc(
    tx: &Transaction<'_>,
    project_id: &str,
    entity_type: &str,
    entity_id: &str,
) -> rusqlite::Result<bool> {
    Ok(tx.execute(
        "DELETE FROM search_docs WHERE project_id = ?1 AND entity_type = ?2 AND entity_id = ?3",
        [project_id, entity_type, entity_id],
    )? > 0)
}

/// 删掉一个项目的全部文档（触发器同步删 FTS）。按范围恢复时先删，再写回恢复后的文档。
pub fn delete_project_docs(tx: &Transaction<'_>, project_id: &str) -> rusqlite::Result<usize> {
    tx.execute(
        "DELETE FROM search_docs WHERE project_id = ?1",
        [project_id],
    )
}

/// 从 `search_docs` 整表重建 `search_fts`（外部内容表的标准 rebuild）。
pub fn rebuild_search_fts(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute("INSERT INTO search_fts (search_fts) VALUES ('rebuild')", [])
        .map(|_| ())
}

/// FTS5 自带的一致性检查；外部内容表还会逐行比对内容表。不一致时返回 SQLite 错误。
pub fn check_fts(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO search_fts (search_fts, rank) VALUES ('integrity-check', 1)",
        [],
    )?;
    conn.execute(
        "INSERT INTO knowledge_fts (knowledge_fts) VALUES ('integrity-check')",
        [],
    )?;
    Ok(())
}

#[derive(Clone, Debug)]
pub enum Scope<'a> {
    Project(&'a str),
    /// 全局搜索：只看这些 lifecycle 的项目。
    Global {
        lifecycles: &'a [&'a str],
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hit {
    pub project_id: String,
    pub entity_type: String,
    pub entity_id: String,
    pub entity_key: String,
    pub title: String,
    pub updated_at: String,
}

/// 按词项匹配文档，每个词都要命中。没有词时返回空。
/// 排序：`updated_at DESC, project_id, entity_type, entity_key`（对应 `ix_search_docs_keyset`）。
pub fn match_docs(
    conn: &Connection,
    terms: &[String],
    scope: &Scope<'_>,
    limit: usize,
) -> rusqlite::Result<Vec<Hit>> {
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let mut args: Vec<Value> = Vec::new();
    let mut sql = String::from(
        "SELECT d.project_id, d.entity_type, d.entity_id, d.entity_key, d.title, d.updated_at
         FROM search_docs d JOIN projects p ON p.id = d.project_id WHERE ",
    );
    match scope {
        Scope::Project(id) => {
            sql.push_str("d.project_id = ?");
            args.push(Value::Text(id.to_string()));
        }
        Scope::Global { lifecycles } => {
            if lifecycles.is_empty() {
                return Ok(Vec::new());
            }
            sql.push_str("p.lifecycle IN (");
            sql.push_str(&vec!["?"; lifecycles.len()].join(", "));
            sql.push(')');
            args.extend(lifecycles.iter().map(|l| Value::Text(l.to_string())));
        }
    }
    for term in terms {
        if uses_fts(term) {
            // entity_key 不进 FTS，`D-398` 这类 key 片段靠 LIKE 补上。
            sql.push_str(
                " AND (d.doc_id IN (SELECT rowid FROM search_fts WHERE search_fts MATCH ?)
                       OR d.entity_key LIKE ? ESCAPE '\\')",
            );
            args.push(Value::Text(fts_phrase(term)));
            args.push(Value::Text(like_pattern(term)));
        } else {
            sql.push_str(" AND (d.title LIKE ? ESCAPE '\\' OR d.body LIKE ? ESCAPE '\\')");
            args.push(Value::Text(like_pattern(term)));
            args.push(Value::Text(like_pattern(term)));
        }
    }
    sql.push_str(" ORDER BY d.updated_at DESC, d.project_id, d.entity_type, d.entity_key LIMIT ?");
    args.push(Value::Integer(limit as i64));
    let mut st = conn.prepare(&sql)?;
    let rows = st.query_map(params_from_iter(args), |r| {
        Ok(Hit {
            project_id: r.get(0)?,
            entity_type: r.get(1)?,
            entity_id: r.get(2)?,
            entity_key: r.get(3)?,
            title: r.get(4)?,
            updated_at: r.get(5)?,
        })
    })?;
    rows.collect()
}

/// head revision 的快照到 knowledge_fts 一行的映射（2.0 `knowledge-repository.ts` 发布路径）：
/// metadata 去掉 bodyMarkdown / sourceRefs / aliases（读取时再用条目行覆盖 version / archived）；
/// aliases、tags、appliesTo 用换行连接。
const KNOWLEDGE_ROW: &str = "
    SELECT e.id,
           json_set(json_remove(r.snapshot, '$.bodyMarkdown', '$.sourceRefs', '$.aliases'),
                    '$.version', e.version,
                    '$.archived', json(CASE e.archived WHEN 1 THEN 'true' ELSE 'false' END)),
           coalesce(r.snapshot ->> '$.title', ''),
           coalesce((SELECT group_concat(value, char(10) ORDER BY key) FROM json_each(r.snapshot, '$.aliases')), ''),
           coalesce((SELECT group_concat(value, char(10) ORDER BY key) FROM json_each(r.snapshot, '$.tags')), ''),
           coalesce(r.snapshot ->> '$.summary', ''),
           coalesce(r.snapshot ->> '$.useWhen', ''),
           coalesce((SELECT group_concat(value, char(10) ORDER BY key) FROM json_each(r.snapshot, '$.appliesTo')), ''),
           coalesce(r.snapshot ->> '$.bodyMarkdown', '')
    FROM knowledge_entries e
    JOIN knowledge_revisions r ON r.entry_id = e.id AND r.revision = e.head_revision";

const KNOWLEDGE_INSERT: &str = "INSERT INTO knowledge_fts (entry_id, metadata, title, aliases, tags, summary, use_when, applies_to, body)";

/// 重建一个条目的索引行（发布、改 head 之后调用）。条目不存在时只删除。
pub fn index_knowledge_entry(tx: &Transaction<'_>, entry_id: &str) -> rusqlite::Result<()> {
    tx.execute("DELETE FROM knowledge_fts WHERE entry_id = ?1", [entry_id])?;
    tx.execute(
        &format!("{KNOWLEDGE_INSERT} {KNOWLEDGE_ROW} WHERE e.id = ?1"),
        [entry_id],
    )?;
    Ok(())
}

/// 整表重建 knowledge_fts（知识库恢复、转换之后）。
pub fn rebuild_knowledge_fts(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute("DELETE FROM knowledge_fts", [])?;
    tx.execute(&format!("{KNOWLEDGE_INSERT} {KNOWLEDGE_ROW}"), [])?;
    Ok(())
}
