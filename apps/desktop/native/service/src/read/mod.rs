//! 读模型（W2f；02 §4，D24–D27、D30；00 02 C-04、C-05、C-09、C-10、C-12、C-15、C-16、C-19、Q-01、Q-05；
//! 10 R4′、R11 P2-5）。
//!
//! 输出形状照 surface v5 的 MCP 回执（brief 沿用 camelCase 载荷，列表、搜索、精确读取是 snake_case），
//! 预算按 `JSON.stringify` 的 UTF-16 码元数计（[`codec::js_len`]）。W4 的 MCP 适配层只做参数映射。
//!
//! 所有读都在一个只读事务里完成，SQL 一律带 `project_id`（S-070）。游标见 [`cursor`]：旧格式一律
//! `INVALID_CURSOR FORMAT_RETIRED`，新游标带项目 id 与范围世代、用库内密钥做 HMAC。

pub mod ack;
pub mod brief;
pub(crate) mod codec;
pub(crate) mod cursor;
pub mod delta;
pub mod field;
pub mod knowledge;
pub mod lists;
pub mod metrics;
pub(crate) mod present;
pub mod search;
pub mod trace;
pub(crate) mod views;

pub use brief::{BeginBrief, BriefRequest};
pub use delta::DeltaRequest;
pub use knowledge::{KnowledgeGetRequest, KnowledgeSearchRequest, Part};
pub use lists::{ListRequest, TaskListRequest};
pub use search::{SearchRequest, TaskGetRequest};
pub use views::TaskView;

use crate::work::core::project_not_found;
use crate::write::{Service, internal};
use atm_domain::capability::{self, Capability};
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::keys;
use atm_domain::principal::Principal;
use atm_domain::time::Timestamp;
use atm_store::ReadError;
use rusqlite::{OptionalExtension, Transaction};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

/// 一次读请求看到的项目。
#[derive(Clone, Debug)]
pub(crate) struct Proj {
    pub id: String,
    pub code: String,
    pub name: String,
    /// 项目事件高水位（02 的 `current_sequence`）。
    pub seq: i64,
    /// 范围世代：游标绑定它，按范围恢复之后旧游标失效（02 §9.5、A3）。
    pub generation: i64,
}

/// 读事务里的上下文。
pub(crate) struct Ctx<'a> {
    pub tx: &'a Transaction<'a>,
    pub p: Proj,
    pub key: Vec<u8>,
    pub now: Timestamp,
}

pub(crate) fn db(e: rusqlite::Error) -> DomainError {
    internal(e)
}

fn read_error(e: ReadError<DomainError>) -> DomainError {
    match e {
        ReadError::Rejected(e) => e,
        ReadError::Busy => DomainError::new(ErrorCode::STORE_BUSY, "存储繁忙，稍后重试"),
        other => internal(format!("{other:?}")),
    }
}

pub(crate) fn now() -> Timestamp {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    Timestamp::from_millis(i64::try_from(ms).unwrap_or(i64::MAX))
}

pub(crate) fn cursor_key(tx: &Transaction<'_>) -> Result<Vec<u8>, DomainError> {
    let key: Option<String> = tx
        .query_row(
            "SELECT cursor_key FROM app_meta WHERE singleton = 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(db)?;
    key.map(String::into_bytes)
        .ok_or_else(|| internal("app_meta is missing"))
}

/// 按项目代码（不区分大小写）定位。TRASHED 的内容不可读（04 §1.3）。
pub(crate) fn locate(tx: &Transaction<'_>, code: &str) -> Result<Proj, DomainError> {
    let code_in = keys::normalize(code);
    let row: Option<(String, String, String, String, i64, i64)> = tx
        .query_row(
            "SELECT id, code, name, lifecycle, project_seq, scope_gen FROM projects WHERE code = ?1",
            [&code_in],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .optional()
        .map_err(db)?;
    let Some((id, code, name, lifecycle, seq, generation)) = row else {
        return Err(project_not_found(code.trim()));
    };
    if lifecycle == "TRASHED" {
        return Err(crate::project::trashed_error(&code));
    }
    Ok(Proj {
        id,
        code,
        name,
        seq,
        generation,
    })
}

impl Service {
    /// 在一个只读事务里读一个项目。
    pub(crate) fn read_project<R>(
        &self,
        principal: &Principal,
        capability: Capability,
        project: &str,
        f: impl FnOnce(&Ctx<'_>) -> Result<R, DomainError>,
    ) -> Result<R, DomainError> {
        capability::require(principal, capability)?;
        self.store()
            .read(|tx| {
                let p = locate(tx, project)?;
                let key = cursor_key(tx)?;
                f(&Ctx {
                    tx,
                    p,
                    key,
                    now: self.clock(),
                })
            })
            .map_err(read_error)
    }

    /// 不限定项目的读（全局搜索）。
    pub(crate) fn read_global<R>(
        &self,
        principal: &Principal,
        capability: Capability,
        f: impl FnOnce(&Transaction<'_>, &[u8], Timestamp) -> Result<R, DomainError>,
    ) -> Result<R, DomainError> {
        capability::require(principal, capability)?;
        self.store()
            .read(|tx| {
                let key = cursor_key(tx)?;
                f(tx, &key, self.clock())
            })
            .map_err(read_error)
    }
}

/// `{project, seq}` 之外的公共错误。
pub(crate) fn too_large(message: impl Into<String>, details: Value) -> DomainError {
    let mut e = DomainError::new(ErrorCode::RESULT_TOO_LARGE, message);
    if let Value::Object(map) = details {
        for (k, v) in map {
            e = e.detail(&k, v);
        }
    }
    e
}
