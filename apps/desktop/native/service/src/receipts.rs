//! 幂等回执的查找与写入（10 R3、R3′、R4、R11 A3；02 §3.2、§9.2）。
//!
//! 两种查找，按 operation 静态区分：
//! - **落点固定**的 operation（绝大多数）：[`find_fixed`]，照 R3′。同一 scope 内，收请求方 lineage 每个 session 的
//!   新键 `(ns_kind, ns_id, op_id)` 与旧格式键（`legacy_key`）命中的全部行（VALID、TOMBSTONED 都收；
//!   R7‴ 的惰性类不收）。不同 scope 的回执永远不是候选。
//! - **落点取决于服务端状态**的三个 operation（begin、`project.create`、不带目标的 `quick.promote`）：
//!   [`find_call`]，按调用索引 `(principal_kind, principal_id, operation, op_id)` 找 3.0 行，
//!   begin 另带一个 2.x 旧行候选。
//!
//! 「是否同一请求」由调用方给的 `rebuild` 判断：按候选自己的指纹族、用候选保存的原作者重建这次请求的指纹，
//! 与候选存的指纹比较（R3′ 第 4 步）。旧族无法表达这次请求时返回 [`Rebuilt::NotComparable`]（A3 的可比性检查），
//! kernel-v1 遇到不支持的键返回 [`Rebuilt::Unsupported`]（02 §9.4，fail closed）。
//!
//! 查找和插入必须在同一个写事务里（单写线程保证没有竞态，R3）。

use rusqlite::{OptionalExtension, Transaction, params};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScopeKind {
    Project,
    Knowledge,
    Global,
}

impl ScopeKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            ScopeKind::Project => "PROJECT",
            ScopeKind::Knowledge => "KNOWLEDGE",
            ScopeKind::Global => "GLOBAL",
        }
    }
}

/// 回执所在的范围。GLOBAL 的 id 恒为 `"GLOBAL"`。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReceiptScope {
    pub kind: ScopeKind,
    pub id: String,
}

impl ReceiptScope {
    pub fn project(id: impl Into<String>) -> Self {
        ReceiptScope {
            kind: ScopeKind::Project,
            id: id.into(),
        }
    }

    pub fn knowledge(database_id: impl Into<String>) -> Self {
        ReceiptScope {
            kind: ScopeKind::Knowledge,
            id: database_id.into(),
        }
    }

    pub fn global() -> Self {
        ReceiptScope {
            kind: ScopeKind::Global,
            id: "GLOBAL".into(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NsKind {
    Session,
    Actor,
    Global,
}

impl NsKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            NsKind::Session => "SESSION",
            NsKind::Actor => "ACTOR",
            NsKind::Global => "GLOBAL",
        }
    }
}

/// 幂等命名空间（R3）：由服务按 operation 与可信主体确定，不是客户端选的。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ns {
    pub kind: NsKind,
    pub id: String,
}

impl Ns {
    pub fn session(id: impl Into<String>) -> Self {
        Ns {
            kind: NsKind::Session,
            id: id.into(),
        }
    }

    pub fn actor(id: impl Into<String>) -> Self {
        Ns {
            kind: NsKind::Actor,
            id: id.into(),
        }
    }
}

/// 一个旧格式键的探测：键、它由哪个 session 生成（重建知识族 v1 指纹要用），以及它是不是请求方自己的键。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LegacyProbe {
    pub key: String,
    pub session: Option<String>,
    pub own: bool,
}

/// 一条候选回执。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub receipt_id: i64,
    pub ns_kind: Option<String>,
    pub ns_id: Option<String>,
    pub legacy_key: Option<String>,
    pub operation: String,
    pub fp_family: String,
    pub fingerprint: String,
    pub receipt_json: String,
    pub author_agent: Option<String>,
    pub author_session: Option<String>,
    /// 2.x 的 `actor_session_id`：kernel-v1 行按它重建指纹。
    pub actor_session_id: Option<String>,
    /// TOMBSTONED 时为撤销它的世代。
    pub tombstoned_by_gen: Option<i64>,
    /// 经由哪个 lineage 成员的键命中。
    pub via_session: Option<String>,
    /// 是请求方自己的精确键命中的。
    pub exact: bool,
}

impl Candidate {
    pub fn is_valid(&self) -> bool {
        self.tombstoned_by_gen.is_none()
    }

    fn summary(&self) -> CandidateSummary {
        CandidateSummary {
            receipt_id: self.receipt_id,
            session: self.via_session.clone().or_else(|| self.ns_id.clone()),
            state: if self.is_valid() {
                "VALID"
            } else {
                "TOMBSTONED"
            },
        }
    }
}

/// 按候选重建出来的这次请求的指纹。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Rebuilt {
    Fingerprint(String),
    /// kernel-v1 无法复现这个键（02 §9.4）。
    Unsupported(String),
    /// 这次请求带了旧族表达不了、且不是缺省值的字段：与该候选不是同一请求（A3 可比性检查）。
    NotComparable,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CandidateSummary {
    pub receipt_id: i64,
    pub session: Option<String>,
    pub state: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConflictReason {
    /// 精确命中，但不是同一请求（或 operation 不同）。
    Mismatch,
    /// lineage 里有多个候选，无法唯一判定（R3′）。
    AmbiguousLineage,
    /// begin 的旧行与 3.0 行都匹配但状态或原文不同（A3）。
    AmbiguousLegacy,
    /// kernel-v1 遇到无法复现的键（02 §9.4）。
    FpV1UnsupportedKey(String),
}

impl ConflictReason {
    /// 写进 details.reason 的值；普通不匹配没有 reason。
    pub fn code(&self) -> Option<&'static str> {
        match self {
            ConflictReason::Mismatch => None,
            ConflictReason::AmbiguousLineage => Some("AMBIGUOUS_LINEAGE"),
            ConflictReason::AmbiguousLegacy => Some("AMBIGUOUS_LEGACY"),
            ConflictReason::FpV1UnsupportedKey(_) => Some("FP_V1_UNSUPPORTED_KEY"),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// 没有候选：按新写入执行。
    New,
    /// 原样返回这条回执，不执行、不新增任何行。
    Replay(Box<Candidate>),
    /// 回执已被按范围恢复撤销：OPERATION_UNDONE_BY_RESTORE。
    Undone { generation: i64 },
    /// IDEMPOTENCY_CONFLICT。
    Conflict {
        reason: ConflictReason,
        candidates: Vec<CandidateSummary>,
    },
}

const COLUMNS: &str =
    "receipt_id, ns_kind, ns_id, legacy_key, operation, fp_family, fingerprint, receipt_json,
                       author_agent, author_session, actor_session_id, tombstoned_by_gen";

/// R7‴ 的惰性类不参与查找。
const ACTIVE: &str =
    "(legacy_class IS NULL OR legacy_class NOT IN ('PROMOTION_HISTORY', 'LEGACY_UNCLASSIFIED'))";

fn row(r: &rusqlite::Row<'_>, via: Option<&str>, exact: bool) -> rusqlite::Result<Candidate> {
    Ok(Candidate {
        receipt_id: r.get(0)?,
        ns_kind: r.get(1)?,
        ns_id: r.get(2)?,
        legacy_key: r.get(3)?,
        operation: r.get(4)?,
        fp_family: r.get(5)?,
        fingerprint: r.get(6)?,
        receipt_json: r.get(7)?,
        author_agent: r.get(8)?,
        author_session: r.get(9)?,
        actor_session_id: r.get(10)?,
        tombstoned_by_gen: r.get(11)?,
        via_session: via.map(str::to_owned),
        exact,
    })
}

/// 落点固定的 operation 的查找输入。
#[derive(Clone, Debug)]
pub struct FixedLookup<'a> {
    pub scope: &'a ReceiptScope,
    pub op_id: &'a str,
    pub operation: &'a str,
    /// 请求方自己的命名空间。
    pub own: Ns,
    /// lineage 里其他成员的命名空间（不含 `own`）。
    pub others: Vec<Ns>,
    /// 旧格式键。
    pub legacy: Vec<LegacyProbe>,
}

/// R3′ 第 1～3 步：收候选。
pub fn candidates(tx: &Transaction<'_>, l: &FixedLookup<'_>) -> rusqlite::Result<Vec<Candidate>> {
    let mut out: Vec<Candidate> = Vec::new();
    let mut push = |c: Candidate| match out.iter_mut().find(|x| x.receipt_id == c.receipt_id) {
        Some(x) => {
            x.exact |= c.exact;
            if x.via_session.is_none() {
                x.via_session = c.via_session;
            }
        }
        None => out.push(c),
    };
    let by_ns = format!(
        "SELECT {COLUMNS} FROM idempotency_receipts
         WHERE scope_kind = ?1 AND scope_id = ?2 AND ns_kind = ?3 AND ns_id = ?4 AND op_id = ?5 AND {ACTIVE}"
    );
    let mut stmt = tx.prepare_cached(&by_ns)?;
    for (ns, own) in std::iter::once((&l.own, true)).chain(l.others.iter().map(|n| (n, false))) {
        let via = (ns.kind == NsKind::Session).then_some(ns.id.as_str());
        let found = stmt
            .query_row(
                params![
                    l.scope.kind.as_str(),
                    l.scope.id,
                    ns.kind.as_str(),
                    ns.id,
                    l.op_id
                ],
                |r| row(r, via, own),
            )
            .optional()?;
        if let Some(c) = found {
            push(c);
        }
    }
    let by_legacy = format!(
        "SELECT {COLUMNS} FROM idempotency_receipts
         WHERE scope_kind = ?1 AND scope_id = ?2 AND legacy_key = ?3 AND {ACTIVE}"
    );
    let mut stmt = tx.prepare_cached(&by_legacy)?;
    for p in &l.legacy {
        let found = stmt
            .query_row(params![l.scope.kind.as_str(), l.scope.id, p.key], |r| {
                row(r, p.session.as_deref(), p.own)
            })
            .optional()?;
        if let Some(c) = found {
            push(c);
        }
    }
    Ok(out)
}

enum Match {
    Yes,
    No,
    Unsupported(String),
}

fn judge(c: &Candidate, operation: &str, rebuild: &dyn Fn(&Candidate) -> Rebuilt) -> Match {
    // 转换来的知识库旧行没有记 operation（存为 `*`），2.x 只比指纹。
    if c.operation != "*" && c.operation != operation {
        return Match::No;
    }
    match rebuild(c) {
        Rebuilt::Fingerprint(fp) if fp == c.fingerprint => Match::Yes,
        Rebuilt::Fingerprint(_) | Rebuilt::NotComparable => Match::No,
        Rebuilt::Unsupported(key) => Match::Unsupported(key),
    }
}

/// R3′ 第 4～5 步：裁决。
pub fn decide_fixed(
    found: Vec<Candidate>,
    operation: &str,
    rebuild: &dyn Fn(&Candidate) -> Rebuilt,
) -> Verdict {
    if found.is_empty() {
        return Verdict::New;
    }
    let exact: Vec<&Candidate> = found.iter().filter(|c| c.exact).collect();
    // 精确命中只看它自己；万一请求方自己的新键与旧键命中了两条不同的行，就在这两条里按多候选规则裁决。
    let pool: Vec<&Candidate> = if exact.is_empty() {
        found.iter().collect()
    } else {
        exact
    };
    let summaries = || pool.iter().map(|c| c.summary()).collect::<Vec<_>>();
    let mut matched = Vec::new();
    for c in &pool {
        match judge(c, operation, rebuild) {
            Match::Yes => matched.push(*c),
            Match::No => {}
            Match::Unsupported(key) => {
                return Verdict::Conflict {
                    reason: ConflictReason::FpV1UnsupportedKey(key),
                    candidates: summaries(),
                };
            }
        }
    }
    let single_exact = pool.len() == 1 && pool[0].exact;
    if matched.len() < pool.len() {
        return Verdict::Conflict {
            reason: if single_exact {
                ConflictReason::Mismatch
            } else {
                ConflictReason::AmbiguousLineage
            },
            candidates: summaries(),
        };
    }
    if matched.iter().all(|c| !c.is_valid()) {
        let generation = matched
            .iter()
            .filter_map(|c| c.tombstoned_by_gen)
            .max()
            .unwrap_or_default();
        return Verdict::Undone { generation };
    }
    let first = matched[0];
    if matched
        .iter()
        .all(|c| c.is_valid() && c.receipt_json == first.receipt_json)
    {
        let earliest = matched
            .iter()
            .min_by_key(|c| c.receipt_id)
            .copied()
            .unwrap_or(first);
        return Verdict::Replay(Box::new(earliest.clone()));
    }
    Verdict::Conflict {
        reason: ConflictReason::AmbiguousLineage,
        candidates: summaries(),
    }
}

/// 落点固定的 operation：收候选并裁决。
pub fn find_fixed(
    tx: &Transaction<'_>,
    lookup: &FixedLookup<'_>,
    rebuild: &dyn Fn(&Candidate) -> Rebuilt,
) -> rusqlite::Result<Verdict> {
    Ok(decide_fixed(
        candidates(tx, lookup)?,
        lookup.operation,
        rebuild,
    ))
}

/// A3 调用索引的主键（四列原值，不拼接）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallKey {
    /// `AGENT` 或 `USER`。
    pub principal_kind: &'static str,
    pub principal_id: String,
    pub operation: String,
}

/// 落点取决于服务端状态的三个 operation（A3）。`legacy` 是 begin 的 2.x 旧行：请求自己的选择器在当前状态下
/// 识别出的那一个项目里，`session-begin:<op_id>` 那一行；没有就是 None。
pub fn find_call(
    tx: &Transaction<'_>,
    key: &CallKey,
    op_id: &str,
    legacy: Option<(&ReceiptScope, &str)>,
    rebuild: &dyn Fn(&Candidate) -> Rebuilt,
) -> rusqlite::Result<Verdict> {
    let n = tx
        .query_row(
            &format!(
                "SELECT {COLUMNS} FROM idempotency_receipts
                 WHERE call_principal_kind = ?1 AND call_principal_id = ?2 AND call_operation = ?3 AND op_id = ?4"
            ),
            params![key.principal_kind, key.principal_id, key.operation, op_id],
            |r| row(r, None, false),
        )
        .optional()?;
    let l = match legacy {
        Some((scope, legacy_key)) => tx
            .query_row(
                &format!(
                    "SELECT {COLUMNS} FROM idempotency_receipts
                     WHERE scope_kind = ?1 AND scope_id = ?2 AND legacy_key = ?3 AND {ACTIVE}"
                ),
                params![scope.kind.as_str(), scope.id, legacy_key],
                |r| row(r, None, false),
            )
            .optional()?,
        None => None,
    };
    Ok(decide_call(l, n, &key.operation, rebuild))
}

/// A3 的裁决：先看谁与请求匹配，再看状态。
pub fn decide_call(
    l: Option<Candidate>,
    n: Option<Candidate>,
    operation: &str,
    rebuild: &dyn Fn(&Candidate) -> Rebuilt,
) -> Verdict {
    let found: Vec<Candidate> = l.into_iter().chain(n).collect();
    if found.is_empty() {
        return Verdict::New;
    }
    let summaries = || found.iter().map(Candidate::summary).collect::<Vec<_>>();
    let mut matched = Vec::new();
    for c in &found {
        match judge(c, operation, rebuild) {
            Match::Yes => matched.push(c),
            Match::No => {}
            Match::Unsupported(key) => {
                return Verdict::Conflict {
                    reason: ConflictReason::FpV1UnsupportedKey(key),
                    candidates: summaries(),
                };
            }
        }
    }
    match matched.as_slice() {
        [] => Verdict::Conflict {
            reason: ConflictReason::Mismatch,
            candidates: summaries(),
        },
        [one] if one.is_valid() => Verdict::Replay(Box::new((*one).clone())),
        [one] => Verdict::Undone {
            generation: one.tombstoned_by_gen.unwrap_or_default(),
        },
        [a, b] => match (a.is_valid(), b.is_valid()) {
            (false, false) => Verdict::Undone {
                generation: a
                    .tombstoned_by_gen
                    .max(b.tombstoned_by_gen)
                    .unwrap_or_default(),
            },
            (true, true) if a.receipt_json == b.receipt_json => {
                Verdict::Replay(Box::new(if a.receipt_id <= b.receipt_id {
                    (*a).clone()
                } else {
                    (*b).clone()
                }))
            }
            _ => Verdict::Conflict {
                reason: ConflictReason::AmbiguousLegacy,
                candidates: summaries(),
            },
        },
        _ => unreachable!("at most two candidates"),
    }
}

/// 3.0 新写入的回执（fp_v2，`canon-v2`）。
#[derive(Clone, Debug)]
pub struct NewReceipt<'a> {
    pub scope: &'a ReceiptScope,
    /// 落点固定的 operation 用它；调用索引的三个 operation 用 `call`，二者恰好给一个。
    pub ns: Option<&'a Ns>,
    pub call: Option<&'a CallKey>,
    pub op_id: &'a str,
    pub operation: &'a str,
    pub fingerprint: &'a str,
    pub receipt_json: &'a str,
    pub author_agent: Option<&'a str>,
    pub author_session: Option<&'a str>,
    /// 2.x 的 `actor_session_id` 列：Agent 写入是 session，User / System 是 NULL（R7）。
    pub actor_session_id: Option<&'a str>,
    /// EXISTING / CREATE 分支落点的世代；GLOBAL 为 None。
    pub scope_generation: Option<i64>,
    pub created_at: &'a str,
}

pub fn insert(tx: &Transaction<'_>, r: &NewReceipt<'_>) -> rusqlite::Result<i64> {
    let (ns_kind, ns_id) = match (r.ns, r.call) {
        (Some(ns), None) => (ns.kind.as_str(), ns.id.as_str()),
        (None, Some(call)) => ("CALL", call.principal_id.as_str()),
        _ => {
            return Err(rusqlite::Error::InvalidParameterName(
                "exactly one of ns / call".into(),
            ));
        }
    };
    tx.execute(
        "INSERT INTO idempotency_receipts (scope_kind, scope_id, ns_kind, ns_id, op_id, actor_session_id, operation,
                                           fp_v, fp_family, fingerprint, receipt_json, author_agent, author_session,
                                           scope_generation, created_at, call_principal_kind, call_principal_id,
                                           call_operation)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 2, 'canon-v2', ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            r.scope.kind.as_str(),
            r.scope.id,
            ns_kind,
            ns_id,
            r.op_id,
            r.actor_session_id,
            r.operation,
            r.fingerprint,
            r.receipt_json,
            r.author_agent,
            r.author_session,
            r.scope_generation,
            r.created_at,
            r.call.map(|c| c.principal_kind),
            r.call.map(|c| c.principal_id.as_str()),
            r.call.map(|c| c.operation.as_str()),
        ],
    )?;
    Ok(tx.last_insert_rowid())
}
