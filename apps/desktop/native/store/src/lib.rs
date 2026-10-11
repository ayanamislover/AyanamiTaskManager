//! ATM 3 单库存储层。
//!
//! 一个 SQLite 文件装下全部数据：全局实体、知识库、所有项目（复合键），以及幂等回执。
//! schema 来自 `migrations/`，迁移按版本号顺序执行，每条记下 SHA-256。
//! 已应用的迁移文本以后被改动，打开时直接拒绝，不会在旧库上悄悄套用新定义。

use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};
use std::path::Path;

pub mod backup;
mod chain;
pub mod conversion;
mod engine;
pub mod events;
pub mod jsjson;
#[cfg(all(test, windows))]
mod late_links;
pub mod legacy;
pub mod package;
pub mod paths;
mod pin;
pub mod probe;
pub mod progress;
pub mod recover;
pub mod restore;
pub mod search;
pub use engine::{Config, ReadError, Stats, Store, Ticket, Waited, WriteError, WriteMark};
#[doc(hidden)]
pub use engine::{PassiveHold, hold_next_passive};

/// 内置迁移，按版本号升序。新增迁移只能追加，不能改已发布的文本。
pub const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    name: "schema_v1",
    sql: include_str!("../migrations/0001_schema_v1.sql"),
}];

#[derive(Clone, Copy, Debug)]
pub struct Migration {
    pub version: i64,
    pub name: &'static str,
    pub sql: &'static str,
}

impl Migration {
    pub fn sha256(&self) -> String {
        hex(&Sha256::digest(self.sql.as_bytes()))
    }
}

#[derive(Debug)]
pub enum StoreError {
    Sqlite(rusqlite::Error),
    /// 库里记录的迁移和内置的对不上：版本相同、内容不同，或者库比程序新。
    MigrationMismatch(String),
    /// 启动写线程等非 SQLite 的系统调用失败。
    Io(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Sqlite(e) => write!(f, "sqlite: {e}"),
            StoreError::MigrationMismatch(m) => write!(f, "migration mismatch: {m}"),
            StoreError::Io(m) => write!(f, "io: {m}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        StoreError::Sqlite(e)
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;

/// 打开（或新建）数据库并迁移到最新。
pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    configure(&conn)?;
    migrate(&conn)?;
    Ok(conn)
}

/// 每条连接都要设的参数。foreign_keys 是连接级的，默认关闭，必须显式打开。
pub fn configure(conn: &Connection) -> Result<()> {
    // journal_mode 会返回一行；内存库得到的是 "memory"，文件库必须真的切到 WAL。
    let mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
    if conn.path().is_some_and(|p| !p.is_empty()) && !mode.eq_ignore_ascii_case("wal") {
        return Err(StoreError::Sqlite(rusqlite::Error::InvalidParameterName(
            format!("journal_mode stayed {mode}"),
        )));
    }
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    harden(conn)?;
    Ok(())
}

/// 关掉 SQLite 的「双引号回退」：默认情况下，找不到的 `"标识符"` 会被悄悄当成字符串字面量，
/// 列名写错时不报错、而是把列名本身写进数据（W1f 转换原型里实际踩到过）。每条连接都要关。
pub fn harden(conn: &Connection) -> Result<()> {
    use rusqlite::config::DbConfig;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DML, false)?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DDL, false)?;
    Ok(())
}

/// 把库迁移到内置的最新版本。每条迁移和它的登记在同一个事务里提交。
pub fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
           version INTEGER PRIMARY KEY, name TEXT NOT NULL,
           sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)",
    )?;
    let applied = check_applied(conn)?;
    for m in MIGRATIONS
        .iter()
        .filter(|m| !applied.iter().any(|(v, _)| *v == m.version))
    {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(m.sql)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, name, sha256, applied_at) VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            params![m.version, m.name, m.sha256()],
        )?;
        tx.commit()?;
    }
    Ok(())
}

/// 库里已应用的迁移都是这个构建认得的（版本在、文本一致），返回 (版本, sha256)。不写任何东西：没有
/// `schema_migrations` 就是什么都还没应用；只读打开的连接也能用（安装探测，[`probe`]）。
pub fn check_applied(conn: &Connection) -> Result<Vec<(i64, String)>> {
    let has_table: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations')",
        [],
        |r| r.get(0),
    )?;
    if !has_table {
        return Ok(Vec::new());
    }
    let applied: Vec<(i64, String)> = {
        let mut st =
            conn.prepare("SELECT version, sha256 FROM schema_migrations ORDER BY version")?;
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?
    };
    for (version, sha) in &applied {
        match MIGRATIONS.iter().find(|m| m.version == *version) {
            None => {
                return Err(StoreError::MigrationMismatch(format!(
                    "database has migration {version}, this build does not"
                )));
            }
            Some(m) if m.sha256() != *sha => {
                return Err(StoreError::MigrationMismatch(format!(
                    "migration {version} ({}) differs from the applied text",
                    m.name
                )));
            }
            Some(_) => {}
        }
    }
    Ok(applied)
}

/// 当前库的 schema 版本（已应用的最大迁移号）。
pub fn schema_version(conn: &Connection) -> Result<Option<i64>> {
    Ok(conn
        .query_row("SELECT max(version) FROM schema_migrations", [], |r| {
            r.get(0)
        })
        .optional()?
        .flatten())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
