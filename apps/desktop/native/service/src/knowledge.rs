//! 知识库写入（W2g3；04 §5.2、L-101～L-108、L-117；10 A2）。
//!
//! 三个入口都经写入流水线，回执落在知识范围（`knowledge_meta.database_id`）：
//! - User 保存（`knowledge.save`）：expectedVersion 与 expectedRevisionId 双 CAS（L-103），可以改已归档的条目（L-104）；
//! - User 归档 / 取消归档（`knowledge.archive`）：同样双 CAS，只加 version，不产生修订（L-102）；
//! - Agent 保存（`knowledge.agent-save`）：作者取自 session（L-105），只靠 revisionId 做 CAS，不能写已归档的条目。
//!
//! 回执只存 `knowledge-receipt-v2 {id, revisionId, version, archived}`；返回前按不可变修订展开，version 与 archived 取
//! 回执里当时的值（L-107），所以重放拿到的是原修订与原版本号，不是今天的 head。
//!
//! 转换来的 2.x 回执按 knowledge-v1 比对（A2）：payload 照 2.x 的 zod 输出键序拼，`JSON.stringify` 后哈希。

use crate::fp::JsValue;
use crate::project::{db, dom_read_error, invalid};
use crate::receipts::ReceiptScope;
use crate::write::{
    Author, Family, FpInput, Prepare, Rebind, Service, SessionRef, WriteRequest, Written, internal,
};
use atm_domain::capability::{self, Capability};
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::principal::Principal;
use atm_domain::text::{js_trim, utf16_len};
use atm_store::events as store_events;
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Map, Value, json};

pub const SAVE_OPERATION: &str = "knowledge.save";
pub const ARCHIVE_OPERATION: &str = "knowledge.archive";
pub const AGENT_SAVE_OPERATION: &str = "knowledge.agent-save";

const RECEIPT_FORMAT: &str = "knowledge-receipt-v2";
const SOURCE_TYPES: [&str; 4] = ["project_record", "file", "url", "manual"];

/// 知识来源（2.x `KnowledgeSourceSchema`）。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SourceRef {
    /// `project_record` / `file` / `url` / `manual`。
    pub kind: String,
    pub reference: String,
    pub source_version: Option<i64>,
    pub project_id: Option<String>,
    pub record_id: Option<String>,
}

/// 条目内容（2.x `KnowledgeContentSchema`）。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Content {
    pub slug: String,
    pub title: String,
    pub summary: String,
    pub use_when: Option<String>,
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
    pub applies_to: Vec<String>,
    pub body_markdown: String,
    pub source_refs: Vec<SourceRef>,
}

/// User 保存。新建：不带 id，expected_version 为 0；更新：两个 expected 都要匹配 head。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct UserSave {
    pub content: Content,
    pub id: Option<String>,
    pub expected_version: i64,
    pub expected_revision_id: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ArchiveRequest {
    pub id: String,
    pub expected_version: i64,
    pub expected_revision_id: String,
    pub archived: bool,
}

/// Agent 保存。id 与 expected_revision_id 要么都给（更新），要么都不给（新建）。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AgentSave {
    pub content: Content,
    pub id: Option<String>,
    pub expected_revision_id: Option<String>,
}

// ---------- 校验与规范化（2.x zod 的语义：Text = trim + min(1)，max 按 UTF-16 码元）----------

fn text(field: &str, value: &str, max: usize) -> Result<String, DomainError> {
    let t = js_trim(value);
    if t.is_empty() {
        return Err(invalid(field, format!("{field} 不能为空")));
    }
    if utf16_len(t) > max {
        return Err(invalid(field, format!("{field} 最多 {max} 个字符")));
    }
    Ok(t.to_owned())
}

fn list(
    field: &str,
    items: &[String],
    max_items: usize,
    max: usize,
) -> Result<Vec<String>, DomainError> {
    if items.len() > max_items {
        return Err(invalid(field, format!("{field} 最多 {max_items} 项")));
    }
    items
        .iter()
        .enumerate()
        .map(|(i, s)| text(field, s, max).map_err(|e| e.detail("index", i)))
        .collect()
}

fn opt_text(field: &str, value: Option<&str>, max: usize) -> Result<Option<String>, DomainError> {
    value.map(|v| text(field, v, max)).transpose()
}

/// 校验并规范化内容（去空白、补默认值）。
pub(crate) fn normalize(c: &Content) -> Result<Content, DomainError> {
    let use_when = c.use_when.clone().unwrap_or_default();
    if utf16_len(&use_when) > 2000 {
        return Err(invalid("use_when", "use_when 最多 2000 个字符"));
    }
    if utf16_len(&c.body_markdown) > 500_000 {
        return Err(invalid("body_markdown", "body_markdown 最多 500000 个字符"));
    }
    // 短查询走 LIKE，SQLite 把 NUL 当字符串终点：存进去却查不出来，入口就拒掉（2.x 同）。
    if c.body_markdown.contains('\0') {
        return Err(invalid(
            "body_markdown",
            "body_markdown 不能包含 U+0000（NUL）",
        ));
    }
    if c.source_refs.len() > 30 {
        return Err(invalid("source_refs", "source_refs 最多 30 项"));
    }
    let source_refs = c
        .source_refs
        .iter()
        .enumerate()
        .map(|(i, s)| source_ref(s).map_err(|e| e.detail("index", i)))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Content {
        slug: text("slug", &c.slug, 160)?,
        title: text("title", &c.title, 240)?,
        summary: text("summary", &c.summary, 1000)?,
        use_when: Some(use_when),
        tags: list("tags", &c.tags, 30, 80)?,
        aliases: list("aliases", &c.aliases, 30, 160)?,
        applies_to: list("applies_to", &c.applies_to, 30, 200)?,
        body_markdown: c.body_markdown.clone(),
        source_refs,
    })
}

fn source_ref(s: &SourceRef) -> Result<SourceRef, DomainError> {
    if !SOURCE_TYPES.contains(&s.kind.as_str()) {
        return Err(invalid(
            "source_refs",
            "来源类型只能是 project_record、file、url 或 manual",
        )
        .detail("got", s.kind.as_str()));
    }
    if s.source_version.is_some_and(|v| v < 0) {
        return Err(invalid("source_refs", "sourceVersion 不能为负"));
    }
    let r = SourceRef {
        kind: s.kind.clone(),
        reference: text("source_refs", &s.reference, 2000)?,
        source_version: s.source_version,
        project_id: opt_text("source_refs", s.project_id.as_deref(), 100)?,
        record_id: opt_text("source_refs", s.record_id.as_deref(), 100)?,
    };
    if r.kind == "project_record"
        && (r.source_version.is_none() || r.project_id.is_none() || r.record_id.is_none())
    {
        return Err(invalid(
            "source_refs",
            "项目 Record 来源必须固定 projectId、recordId 和 sourceVersion",
        ));
    }
    Ok(r)
}

/// 内容的 JSON，键序照 2.x zod 的 shape（快照与 knowledge-v1 指纹都用它）。
fn content_json(c: &Content) -> Map<String, Value> {
    let refs: Vec<Value> = c
        .source_refs
        .iter()
        .map(|s| {
            let mut m = Map::new();
            m.insert("type".into(), json!(s.kind));
            m.insert("reference".into(), json!(s.reference));
            if let Some(v) = s.source_version {
                m.insert("sourceVersion".into(), json!(v));
            }
            if let Some(v) = &s.project_id {
                m.insert("projectId".into(), json!(v));
            }
            if let Some(v) = &s.record_id {
                m.insert("recordId".into(), json!(v));
            }
            Value::Object(m)
        })
        .collect();
    let mut m = Map::new();
    m.insert("slug".into(), json!(c.slug));
    m.insert("title".into(), json!(c.title));
    m.insert("summary".into(), json!(c.summary));
    m.insert(
        "useWhen".into(),
        json!(c.use_when.clone().unwrap_or_default()),
    );
    m.insert("tags".into(), json!(c.tags));
    m.insert("aliases".into(), json!(c.aliases));
    m.insert("appliesTo".into(), json!(c.applies_to));
    m.insert("bodyMarkdown".into(), json!(c.body_markdown));
    m.insert("sourceRefs".into(), Value::Array(refs));
    m
}

fn with(
    mut m: Map<String, Value>,
    entries: impl IntoIterator<Item = (&'static str, Value)>,
) -> Map<String, Value> {
    for (k, v) in entries {
        if !v.is_null() {
            m.insert(k.into(), v);
        }
    }
    m
}

fn object(m: Map<String, Value>) -> JsValue {
    JsValue::from_json(&Value::Object(m))
}

// ---------- 存储 ----------

struct Head {
    version: i64,
    archived: bool,
    head_revision: i64,
    revision_id: String,
}

fn not_found() -> DomainError {
    DomainError::new(ErrorCode::NOT_FOUND, "知识条目不存在").detail("entity", "KNOWLEDGE")
}

fn head(tx: &Transaction<'_>, id: &str) -> Result<Head, DomainError> {
    tx.query_row(
        "SELECT e.version, e.archived, e.head_revision, r.revision_id
         FROM knowledge_entries e JOIN knowledge_revisions r ON r.entry_id = e.id AND r.revision = e.head_revision
         WHERE e.id = ?1",
        [id],
        |r| {
            Ok(Head {
                version: r.get(0)?,
                archived: r.get::<_, i64>(1)? == 1,
                head_revision: r.get(2)?,
                revision_id: r.get(3)?,
            })
        },
    )
    .optional()
    .map_err(db)?
    .ok_or_else(|| not_found().detail("id", id))
}

fn version_conflict(id: &str, h: &Head) -> DomainError {
    DomainError::new(
        ErrorCode::VERSION_CONFLICT,
        "知识已被其他编辑者更新，请重新读取并合并",
    )
    .detail("entity", "KNOWLEDGE")
    .detail("id", id)
    .detail("current_version", h.version)
    .detail("current_revision_id", h.revision_id.as_str())
}

fn bump_sequence(tx: &Transaction<'_>) -> Result<(), DomainError> {
    tx.execute("UPDATE knowledge_meta SET sequence = sequence + 1", [])
        .map_err(db)?;
    Ok(())
}

fn receipt(id: &str, revision_id: &str, version: i64, archived: bool) -> Value {
    json!({ "format": RECEIPT_FORMAT, "id": id, "revisionId": revision_id, "version": version, "archived": archived })
}

/// 写一条新修订并移动 head（2.x `saveRevision`）。`expected_version` 与 `expected_revision_id` 按 head 校验。
fn save_revision(
    tx: &Transaction<'_>,
    content: &Content,
    requested: Option<&str>,
    expected_version: i64,
    expected_revision_id: Option<&str>,
    published_by: Option<Value>,
    at: &str,
) -> Result<Value, DomainError> {
    let h = requested.map(|id| head(tx, id)).transpose()?;
    let current = h.as_ref().map_or(0, |h| h.version);
    if current != expected_version
        || h.as_ref()
            .is_some_and(|h| Some(h.revision_id.as_str()) != expected_revision_id)
    {
        return Err(match (&h, requested) {
            (Some(h), Some(id)) => version_conflict(id, h),
            _ => DomainError::new(
                ErrorCode::VERSION_CONFLICT,
                "新建知识的 expected_version 必须是 0",
            )
            .detail("entity", "KNOWLEDGE"),
        });
    }
    let id = match requested {
        Some(id) => id.to_owned(),
        None => store_events::ulid(tx).map_err(db)?,
    };
    let holder: Option<String> = tx
        .query_row(
            "SELECT id FROM knowledge_entries WHERE slug = ?1 AND id <> ?2",
            params![content.slug, id],
            |r| r.get(0),
        )
        .optional()
        .map_err(db)?;
    if let Some(holder) = holder {
        return Err(DomainError::new(
            ErrorCode::KNOWLEDGE_SLUG_CONFLICT,
            format!("知识 slug {} 已被另一条目使用：换一个 slug", content.slug),
        )
        .detail("slug", content.slug.as_str())
        .detail("holder_id", holder));
    }
    let revision = h.as_ref().map_or(0, |h| h.head_revision) + 1;
    let revision_id = store_events::ulid(tx).map_err(db)?;
    let mut snapshot = with(
        content_json(content),
        [
            ("id", json!(id)),
            ("revision", json!(revision)),
            ("revisionId", json!(revision_id)),
            ("createdAt", json!(at)),
        ],
    );
    if let Some(author) = published_by {
        snapshot.insert("publishedBy".into(), author);
    }
    let version = current + 1;
    let archived = h.as_ref().is_some_and(|h| h.archived);
    tx.execute(
        "INSERT INTO knowledge_entries (id, slug, head_revision, version) VALUES (?1, ?2, ?3, 1)
         ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, head_revision = excluded.head_revision,
                                       version = knowledge_entries.version + 1",
        params![id, content.slug, revision],
    )
    .map_err(db)?;
    tx.execute(
        "INSERT INTO knowledge_revisions (entry_id, revision, revision_id, snapshot) VALUES (?1, ?2, ?3, ?4)",
        params![id, revision, revision_id, Value::Object(snapshot.clone()).to_string()],
    )
    .map_err(db)?;
    // FTS 是派生的：跟着 head 重建（metadata 照 2.x 的命中形状：去掉正文、来源与别名）。
    let mut metadata = snapshot;
    for k in ["bodyMarkdown", "sourceRefs", "aliases"] {
        metadata.remove(k);
    }
    metadata.insert("version".into(), json!(version));
    metadata.insert("archived".into(), json!(archived));
    tx.execute("DELETE FROM knowledge_fts WHERE entry_id = ?1", [&id])
        .map_err(db)?;
    tx.execute(
        "INSERT INTO knowledge_fts (entry_id, metadata, title, aliases, tags, summary, use_when, applies_to, body)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            id,
            Value::Object(metadata).to_string(),
            content.title,
            content.aliases.join("\n"),
            content.tags.join("\n"),
            content.summary,
            content.use_when.clone().unwrap_or_default(),
            content.applies_to.join("\n"),
            content.body_markdown
        ],
    )
    .map_err(db)?;
    bump_sequence(tx)?;
    Ok(receipt(&id, &revision_id, version, archived))
}

/// 回执 → 条目：v2 回执按原修订展开，version / archived 取回执里的值；2.x 的旧格式回执本身就是条目。
fn expand(tx: &Transaction<'_>, r: &Value) -> Result<Value, DomainError> {
    if r["format"] != RECEIPT_FORMAT {
        return Ok(r.clone());
    }
    let (id, revision_id) = (
        r["id"].as_str().unwrap_or_default(),
        r["revisionId"].as_str().unwrap_or_default(),
    );
    let snapshot: String = tx
        .query_row(
            "SELECT snapshot FROM knowledge_revisions WHERE entry_id = ?1 AND revision_id = ?2",
            [id, revision_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(db)?
        .ok_or_else(|| {
            DomainError::new(ErrorCode::NOT_FOUND, "知识修订不存在")
                .detail("entity", "KNOWLEDGE_REVISION")
                .detail("revision_id", revision_id)
        })?;
    let mut entry: Value = serde_json::from_str(&snapshot).map_err(internal)?;
    entry["version"] = r["version"].clone();
    entry["archived"] = r["archived"].clone();
    Ok(entry)
}

/// 知识库的身份行。新库第一次成功写知识时、在那次写入的事务里建（新世代，reason CREATED）；转换来的库
/// 已经有。`id` 是事务外预先选好、回执范围已经用上的 database_id：并发的另一个首次写入先建了身份时，
/// 范围对不上，以 [`SCOPE_MOVED`] 失败（回滚），调用方按新身份重来一次。
fn ensure_meta(tx: &Transaction<'_>, id: &str, at: &str) -> Result<(), DomainError> {
    if let Some(found) = tx
        .query_row("SELECT database_id FROM knowledge_meta", [], |r| {
            r.get::<_, String>(0)
        })
        .optional()
        .map_err(db)?
    {
        return if found == id {
            Ok(())
        } else {
            Err(internal("知识库身份刚被并发建立").detail(SCOPE_MOVED, found))
        };
    }
    let generation_id = store_events::ulid(tx).map_err(db)?;
    let (generation, epoch) =
        atm_store::restore::allocate_generation(tx).map_err(|e| internal(format!("{e:?}")))?;
    tx.execute(
        "INSERT INTO scope_generations (gen, scope_kind, scope_id, reason, epoch, created_at)
         VALUES (?1, 'KNOWLEDGE', ?2, 'CREATED', ?3, ?4)",
        params![generation, id, epoch, at],
    )
    .map_err(db)?;
    tx.execute(
        "INSERT INTO knowledge_meta (singleton, database_id, generation, sequence, scope_gen) VALUES (1, ?1, ?2, 0, ?3)",
        params![id, generation_id, generation],
    )
    .map_err(db)?;
    Ok(())
}

/// 知识库身份在请求读到之后被并发建立的内部标记；只在三个写入口的重试里流转，不出服务。
const SCOPE_MOVED: &str = "__knowledge_scope_moved";

fn id_field(field: &str, value: Option<&str>) -> Result<Option<String>, DomainError> {
    opt_text(field, value, 100)
}

impl Service {
    /// 知识库的 database_id。还没有时只在事务外选好一个，连同在写事务里建它的准备步骤一起返回：
    /// 身份与世代跟着第一次成功的写入提交，失败的请求不留下它们（peer W2 r1 P1-03）。
    fn knowledge_scope(&self) -> Result<(String, Option<Prepare>), DomainError> {
        let found: Option<String> = self
            .store()
            .read(|tx| {
                tx.query_row("SELECT database_id FROM knowledge_meta", [], |r| r.get(0))
                    .optional()
            })
            .map_err(|e| internal(format!("{e:?}")))?;
        if let Some(id) = found {
            return Ok((id, None));
        }
        let id = self
            .store()
            .read(|tx| store_events::ulid(tx))
            .map_err(|e| internal(format!("{e:?}")))?;
        let at = self.clock().to_string();
        let candidate = id.clone();
        Ok((
            id,
            Some(Box::new(move |tx: &Transaction<'_>| {
                ensure_meta(tx, &candidate, &at)
            })),
        ))
    }

    /// 三个写入口共用：选知识范围、写一次；范围在两者之间被并发建立时按新身份再写一次。
    fn knowledge_write(
        &self,
        mut attempt: impl FnMut(&str, Option<Prepare>) -> Result<Written, DomainError>,
    ) -> Result<Written, DomainError> {
        let (scope, prepare) = self.knowledge_scope()?;
        match attempt(&scope, prepare) {
            Err(e) if e.details.contains_key(SCOPE_MOVED) => {
                let (scope, prepare) = self.knowledge_scope()?;
                self.knowledge_result(attempt(&scope, prepare)?)
            }
            other => self.knowledge_result(other?),
        }
    }

    /// 回执展开成条目（新写入与重放同一条路）。
    fn knowledge_result(&self, w: Written) -> Result<Written, DomainError> {
        let receipt = w.result.clone();
        let entry = self
            .store()
            .read(move |tx| expand(tx, &receipt))
            .map_err(dom_read_error)?;
        Ok(Written { result: entry, ..w })
    }

    /// User 保存（04 L-103、L-104）。
    pub fn knowledge_save(
        &self,
        principal: &Principal,
        r: UserSave,
        op_id: &str,
    ) -> Result<Written, DomainError> {
        capability::require(principal, Capability::KnowledgeUserEdit)?;
        let content = normalize(&r.content)?;
        let id = id_field("id", r.id.as_deref())?;
        let expected_revision_id =
            id_field("expected_revision_id", r.expected_revision_id.as_deref())?;
        if r.expected_version < 0 {
            return Err(invalid("expected_version", "expected_version 不能为负"));
        }
        if id.is_some() && expected_revision_id.is_none() {
            return Err(invalid(
                "expected_revision_id",
                "更新知识必须带当前修订的 revisionId，防止备份恢复后版本号重用",
            ));
        }
        self.knowledge_write(|scope, prepare| {
            let (content, id, expected_revision_id) =
                (content.clone(), id.clone(), expected_revision_id.clone());
            let (fp_content, fp_id, fp_rev, fp_ver, op) = (
                content.clone(),
                id.clone(),
                expected_revision_id.clone(),
                r.expected_version,
                op_id.to_owned(),
            );
            let fingerprint: FpInput = Box::new(move |_, family, _| {
                let tail = [
                    ("id", json!(fp_id)),
                    ("expectedVersion", json!(fp_ver)),
                    ("expectedRevisionId", json!(fp_rev)),
                ];
                match family {
                    Family::KnowledgeV1 => {
                        let mut m = Map::new();
                        m.insert("operation".into(), json!("save"));
                        m.extend(content_json(&fp_content));
                        m.insert("opId".into(), json!(op));
                        Some(object(with(m, tail)))
                    }
                    Family::CanonV2 => {
                        let mut m = Map::new();
                        m.insert("operation".into(), json!("save"));
                        m.extend(content_json(&fp_content));
                        Some(object(with(m, tail)))
                    }
                    Family::KernelV1 => None,
                }
            });
            self.write(
                principal,
                knowledge_request(
                    Capability::KnowledgeUserEdit,
                    SAVE_OPERATION,
                    op_id,
                    scope,
                    None,
                    fingerprint,
                    prepare,
                ),
                move |tx, ctx| {
                    save_revision(
                        tx,
                        &content,
                        id.as_deref(),
                        r.expected_version,
                        expected_revision_id.as_deref(),
                        None,
                        &ctx.now.to_string(),
                    )
                },
            )
        })
    }

    /// User 归档 / 取消归档（04 L-104）：双 CAS，version+1，不产生修订。
    pub fn knowledge_archive(
        &self,
        principal: &Principal,
        r: ArchiveRequest,
        op_id: &str,
    ) -> Result<Written, DomainError> {
        capability::require(principal, Capability::KnowledgeArchive)?;
        let id = text("id", &r.id, 100)?;
        let expected_revision_id = text("expected_revision_id", &r.expected_revision_id, 100)?;
        if r.expected_version < 1 {
            return Err(invalid("expected_version", "expected_version 必须是正整数"));
        }
        self.knowledge_write(|scope, prepare| {
let (id, expected_revision_id) = (id.clone(), expected_revision_id.clone());
        let (fp_id, fp_rev, op) = (id.clone(), expected_revision_id.clone(), op_id.to_owned());
        let (expected, archived) = (r.expected_version, r.archived);
        let fingerprint: FpInput = Box::new(move |_, family, _| {
            let mut m = Map::new();
            m.insert("operation".into(), json!("archive"));
            match family {
                Family::KnowledgeV1 => {
                    m.insert("opId".into(), json!(op));
                }
                Family::CanonV2 => {}
                Family::KernelV1 => return None,
            }
            m.insert("id".into(), json!(fp_id));
            m.insert("expectedVersion".into(), json!(expected));
            m.insert("expectedRevisionId".into(), json!(fp_rev));
            m.insert("archived".into(), json!(archived));
            Some(object(m))
        });
        self.write(
            principal,
            knowledge_request(Capability::KnowledgeArchive, ARCHIVE_OPERATION, op_id, scope, None, fingerprint, prepare),
            move |tx, _| {
                let h = head(tx, &id)?;
                if h.version != expected || h.revision_id != expected_revision_id {
                    return Err(version_conflict(&id, &h));
                }
                tx.execute(
                    "UPDATE knowledge_entries SET archived = ?2, version = version + 1 WHERE id = ?1",
                    params![id, i64::from(archived)],
                )
                .map_err(db)?;
                bump_sequence(tx)?;
                Ok(receipt(&id, &h.revision_id, h.version + 1, archived))
            },
        )
        })
    }

    /// Agent 保存（04 L-105、L-106）：作者取自 session，输入里无法指定。
    pub fn knowledge_save_agent(
        &self,
        principal: &Principal,
        project: &str,
        session: &str,
        r: AgentSave,
        op_id: &str,
    ) -> Result<Written, DomainError> {
        capability::require(principal, Capability::KnowledgeAgentSave)?;
        let content = normalize(&r.content)?;
        let id = id_field("id", r.id.as_deref())?;
        let expected_revision_id =
            id_field("expected_revision_id", r.expected_revision_id.as_deref())?;
        if id.is_some() != expected_revision_id.is_some() {
            return Err(invalid(
                "expected_revision_id",
                "更新时 id 与 expected_revision_id 必须同时提供；新建时均省略",
            ));
        }
        let project_id = self.project_scope(project)?;
        self.knowledge_write(|scope, prepare| {
let (content, id, expected_revision_id, project_id) = (content.clone(), id.clone(), expected_revision_id.clone(), project_id.clone());
        let (fp_content, fp_id, fp_rev, fp_project, op) = (
            content.clone(),
            id.clone(),
            expected_revision_id.clone(),
            project_id.clone(),
            op_id.to_owned(),
        );
        let fingerprint: FpInput = Box::new(move |tx, family, author: &Author| {
            let tail = [("id", json!(fp_id)), ("expectedRevisionId", json!(fp_rev))];
            match family {
                Family::KnowledgeV1 => {
                    // 2.x：{operation, ...parsed（project 换成项目 id）, author}；作者按候选自己的 session 重建。
                    let session = author.session.as_deref()?;
                    let agent: String = tx
                        .query_row(
                            "SELECT agent_id FROM agent_sessions WHERE project_id = ?1 AND id = ?2",
                            [&fp_project, session],
                            |r| r.get(0),
                        )
                        .ok()?;
                    let mut m = Map::new();
                    m.insert("operation".into(), json!("agent.save"));
                    m.extend(content_json(&fp_content));
                    m.insert("project".into(), json!(fp_project));
                    m.insert("session".into(), json!(session));
                    m.insert("opId".into(), json!(op));
                    let mut m = with(m, tail);
                    m.insert(
                        "author".into(),
                        json!({ "type": "AGENT", "agentId": agent, "sessionId": session, "projectId": fp_project }),
                    );
                    Some(object(m))
                }
                Family::CanonV2 => {
                    let mut m = Map::new();
                    m.insert("operation".into(), json!("agent.save"));
                    m.extend(content_json(&fp_content));
                    Some(object(with(m, tail)))
                }
                Family::KernelV1 => None,
            }
        });
        let session_ref = SessionRef {
            project_id: project_id.clone(),
            session_id: js_trim(session).to_owned(),
        };
        self.write(
            principal,
            knowledge_request(
                Capability::KnowledgeAgentSave,
                AGENT_SAVE_OPERATION,
                op_id,
                scope,
                Some(session_ref),
                fingerprint,
                prepare,
            ),
            move |tx, ctx| {
                // 2.x 要先打开 session 所在的项目库，垃圾箱里的项目打不开；重放在这之前，照样拿回原回执。
                crate::project::require_writable(tx, &project_id)?;
                let h = id.as_deref().map(|i| head(tx, i)).transpose()?;
                if h.as_ref().is_some_and(|h| h.archived) {
                    return Err(DomainError::new(
                        ErrorCode::INVALID_ARGUMENT,
                        "归档知识不能直接更新；请先由管理界面恢复",
                    )
                    .detail("id", id.clone()));
                }
                let author = json!({
                    "type": "AGENT",
                    "agentId": ctx.author.agent,
                    "sessionId": ctx.author.session,
                    "projectId": project_id,
                });
                save_revision(
                    tx,
                    &content,
                    id.as_deref(),
                    h.as_ref().map_or(0, |h| h.version),
                    expected_revision_id.as_deref(),
                    Some(author),
                    &ctx.now.to_string(),
                )
            },
        )
        })
    }
}

fn knowledge_request(
    capability: Capability,
    operation: &'static str,
    op_id: &str,
    scope: &str,
    session: Option<SessionRef>,
    fingerprint: FpInput,
    prepare: Option<Prepare>,
) -> WriteRequest {
    WriteRequest {
        capability,
        operation,
        op_id: op_id.to_owned(),
        scope: ReceiptScope::knowledge(scope),
        session,
        actor: None,
        expected_generation: None,
        fingerprint,
        compat_v1: None,
        replay_guard: None,
        prepare,
        rebind: Rebind::Create,
    }
}
