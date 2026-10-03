//! 事件与序号（W1c）：project_seq、global_seq、公开编号计数器。
//!
//! R6：项目事件和它的全局镜像在**同一个写事务**里写入，没有异步投影。
//! 05 §2.1 第 4、5 条与 R5：序号逐值保留，新写入从高水位继续；任何已提交的序号都不复用。
//! 按范围恢复会把项目流和计数器带回备份时的样子，所以恢复前先 [`HighWater::capture`]，
//! 恢复后 [`HighWater::reapply`]，序号与编号都取 `max(恢复前, 备份)`，只会跳号，不会回退。
//! 读侧必须容忍空洞。
//!
//! 这里的函数都只接受 `&Transaction`：它们只能在写作业里调用。

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug)]
pub enum EventError {
    Sqlite(rusqlite::Error),
    /// 项目不存在。
    ProjectNotFound(String),
    /// app_meta 没有种下。
    MetaMissing,
    /// 计数器不存在（2.0 的 COUNTER_NOT_FOUND）。
    CounterNotFound(String),
    /// payload 必须是 JSON 对象：全局镜像要往里补项目字段。
    PayloadNotObject,
}

impl From<rusqlite::Error> for EventError {
    fn from(e: rusqlite::Error) -> Self {
        EventError::Sqlite(e)
    }
}

impl std::fmt::Display for EventError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EventError::Sqlite(e) => write!(f, "sqlite: {e}"),
            EventError::ProjectNotFound(p) => write!(f, "project not found: {p}"),
            EventError::MetaMissing => write!(f, "app_meta is missing"),
            EventError::CounterNotFound(n) => write!(f, "counter not found: {n}"),
            EventError::PayloadNotObject => write!(f, "event payload must be a JSON object"),
        }
    }
}

impl std::error::Error for EventError {}

pub type Result<T> = std::result::Result<T, EventError>;

/// 一条项目事件。字段对应 `events` 表；`at` 是 ISO 时间串，由调用方给出，事件和镜像用同一个值。
#[derive(Clone, Debug)]
pub struct NewEvent<'a> {
    pub project_id: &'a str,
    pub kind: &'a str,
    pub actor_type: &'a str,
    pub actor_id: &'a str,
    pub session_id: Option<&'a str>,
    pub aggregate_type: &'a str,
    pub aggregate_id: &'a str,
    pub correlation_id: Option<&'a str>,
    pub op_id: Option<&'a str>,
    pub payload_json: &'a str,
    pub at: &'a str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Appended {
    pub seq: i64,
    pub event_id: String,
    pub global_seq: i64,
}

/// 追加一条项目事件，并在同一事务里追加它的全局镜像。
///
/// 镜像沿用 2.0 投影的形状（`registry-projection-dispatcher.ts`）：payload 是事件 payload
/// 再补上项目字段，`dedupe_key = project:<id>:event:<event_id>`，actor 取事件的 actor_id。
pub fn append_event(tx: &Transaction<'_>, ev: &NewEvent<'_>) -> Result<Appended> {
    if !is_object(tx, ev.payload_json)? {
        return Err(EventError::PayloadNotObject);
    }
    let (seq, code, name): (i64, String, String) = tx
        .query_row(
            "UPDATE projects SET project_seq = project_seq + 1 WHERE id = ?1 RETURNING project_seq, code, name",
            [ev.project_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?
        .ok_or_else(|| EventError::ProjectNotFound(ev.project_id.to_string()))?;
    let event_id = ulid(tx)?;
    tx.execute(
        "INSERT INTO events (project_id, seq, id, type, actor_type, actor_id, session_id, aggregate_type, aggregate_id,
                             causation_id, correlation_id, payload_json, created_at, op_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?11, ?12, ?13)",
        params![
            ev.project_id,
            seq,
            event_id,
            ev.kind,
            ev.actor_type,
            ev.actor_id,
            ev.session_id,
            ev.aggregate_type,
            ev.aggregate_id,
            ev.correlation_id,
            ev.payload_json,
            ev.at,
            ev.op_id
        ],
    )?;

    let global_seq = next_global_seq(tx, ev.at)?;
    let aggregate = if ev.aggregate_id.is_empty() {
        ev.project_id
    } else {
        ev.aggregate_id
    };
    tx.execute(
        "INSERT INTO global_feed (global_seq, type, aggregate_id, actor, payload_json, created_at, dedupe_key, project_id, event_id)
         VALUES (?1, ?2, ?3, ?4,
                 json_set(?5, '$.projectId', ?6, '$.projectCode', ?7, '$.projectName', ?8,
                          '$.projectSequence', ?9, '$.sourceEventId', ?10, '$.sourceProjectSequence', ?9,
                          '$.sourceAggregateType', ?11, '$.sourceAggregateId', ?12),
                 ?13, ?14, ?6, ?10)",
        params![
            global_seq,
            ev.kind,
            aggregate,
            ev.actor_id,
            ev.payload_json,
            ev.project_id,
            code,
            name,
            seq,
            event_id,
            ev.aggregate_type,
            ev.aggregate_id,
            ev.at,
            format!("project:{}:event:{}", ev.project_id, event_id)
        ],
    )?;
    Ok(Appended {
        seq,
        event_id,
        global_seq,
    })
}

/// 追加一条不属于项目流的全局事件（备份、恢复申请、导入等）。
/// 给了 `dedupe_key` 且已存在时不再追加，返回已有的 global_seq（2.0 `appendGlobalEvent` 的语义）。
pub fn append_global(
    tx: &Transaction<'_>,
    kind: &str,
    aggregate_id: &str,
    actor: &str,
    payload_json: &str,
    dedupe_key: Option<&str>,
    at: &str,
) -> Result<i64> {
    if let Some(key) = dedupe_key {
        let existing = tx
            .query_row(
                "SELECT global_seq FROM global_feed WHERE dedupe_key = ?1",
                [key],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(seq) = existing {
            return Ok(seq);
        }
    }
    let global_seq = next_global_seq(tx, at)?;
    tx.execute(
        "INSERT INTO global_feed (global_seq, type, aggregate_id, actor, payload_json, created_at, dedupe_key)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![global_seq, kind, aggregate_id, actor, payload_json, at, dedupe_key],
    )?;
    Ok(global_seq)
}

/// 取下一个公开编号（任务号、记录号等），计数器前进一位。返回取到的值。
pub fn next_number(tx: &Transaction<'_>, project_id: &str, name: &str) -> Result<i64> {
    tx.query_row(
        "UPDATE counters SET next_value = next_value + 1 WHERE project_id = ?1 AND name = ?2 RETURNING next_value - 1",
        [project_id, name],
        |r| r.get(0),
    )
    .optional()?
    .ok_or_else(|| EventError::CounterNotFound(name.to_string()))
}

fn next_global_seq(tx: &Transaction<'_>, at: &str) -> Result<i64> {
    tx.query_row(
        "UPDATE app_meta SET global_seq = global_seq + 1, updated_at = ?1 WHERE singleton = 1 RETURNING global_seq",
        [at],
        |r| r.get(0),
    )
    .optional()?
    .ok_or(EventError::MetaMissing)
}

fn is_object(tx: &Transaction<'_>, json: &str) -> Result<bool> {
    // AND 不保证短路，非法 JSON 交给 json_type 会直接报错，所以用 CASE。
    Ok(tx.query_row(
        "SELECT CASE WHEN json_valid(?1) THEN json_type(?1) = 'object' ELSE 0 END",
        [json],
        |r| r.get(0),
    )?)
}

/// 一个项目在恢复前的高水位：project_seq 和全部计数器。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HighWater {
    pub project_id: String,
    pub project_seq: i64,
    pub counters: Vec<(String, i64)>,
}

impl HighWater {
    pub fn capture(tx: &Transaction<'_>, project_id: &str) -> Result<HighWater> {
        let project_seq = tx
            .query_row(
                "SELECT project_seq FROM projects WHERE id = ?1",
                [project_id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| EventError::ProjectNotFound(project_id.to_string()))?;
        let mut st = tx
            .prepare("SELECT name, next_value FROM counters WHERE project_id = ?1 ORDER BY name")?;
        let counters = st
            .query_map([project_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(HighWater {
            project_id: project_id.to_string(),
            project_seq,
            counters,
        })
    }

    /// 恢复写回备份的内容之后调用：序号和每个计数器取 `max(恢复前, 当前)`。
    /// 备份里没有的计数器按恢复前的值补回。返回恢复后的 project_seq（续号从它 +1 开始）。
    pub fn reapply(&self, tx: &Transaction<'_>) -> Result<i64> {
        let seq = tx
            .query_row(
                "UPDATE projects SET project_seq = max(project_seq, ?2) WHERE id = ?1 RETURNING project_seq",
                params![self.project_id, self.project_seq],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| EventError::ProjectNotFound(self.project_id.clone()))?;
        for (name, value) in &self.counters {
            tx.execute(
                "INSERT INTO counters (project_id, name, next_value) VALUES (?1, ?2, ?3)
                 ON CONFLICT (project_id, name) DO UPDATE SET next_value = max(next_value, excluded.next_value)",
                params![self.project_id, name, value],
            )?;
        }
        Ok(seq)
    }
}

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// 26 位 Crockford base32 ULID，与 2.0 `createUlid` 同一格式。随机部分取 SQLite 的 `randomblob`（由 OS 熵播种）。
pub fn ulid(conn: &Connection) -> rusqlite::Result<String> {
    let random: Vec<u8> = conn.query_row("SELECT randomblob(10)", [], |r| r.get(0))?;
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0) as u64;
    Ok(encode_ulid(millis, &random))
}

fn encode_ulid(millis: u64, random: &[u8]) -> String {
    let mut value: u128 = u128::from(millis & 0xffff_ffff_ffff) << 80;
    for (i, b) in random.iter().take(10).enumerate() {
        value |= u128::from(*b) << (72 - 8 * i);
    }
    let mut out = [0u8; 26];
    for slot in out.iter_mut().rev() {
        *slot = CROCKFORD[(value & 31) as usize];
        value >>= 5;
    }
    String::from_utf8(out.to_vec()).expect("crockford alphabet is ascii")
}

#[cfg(test)]
mod tests {
    use super::encode_ulid;

    #[test]
    fn ulid_matches_the_2x_encoding() {
        // 2.0：createUlid(0, 全零) = 26 个 '0'；createUlid(2^48-1, 全 0xff) = '7ZZZ…Z'。
        assert_eq!(encode_ulid(0, &[0; 10]), "0".repeat(26));
        assert_eq!(
            encode_ulid(0xffff_ffff_ffff, &[0xff; 10]),
            format!("7{}", "Z".repeat(25))
        );
        // 时间 1 ms、随机全零：第 10 位是 '1'，其余为 '0'（48 位时间占前 10 个字符）。
        assert_eq!(
            encode_ulid(1, &[0; 10]),
            format!("{}1{}", "0".repeat(9), "0".repeat(16))
        );
    }
}
