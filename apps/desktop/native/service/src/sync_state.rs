//! 手机同步的账本（05 §2.4、§7）：2.x 的 `sync/config.json` 拆成三张表——`sync_state`（单行配置与游标）、
//! `sync_published`（发布去重缓存）、`sync_processed`（已处理的命令 ID，`ord` 保留次序）。密钥不在这里
//! （`sync/secrets.dpapi.json`，见 atm-sync）。
//!
//! 这里只管读写，不解释内容：格式校验、默认值、保留期在 atm-sync（2.x 的 `config.ts`）。写入是整份替换，
//! 与 2.x 每次整份写 JSON 一样；没有事件（05 F1：设置页可以只改 deviceName 或 enabled）。
//!
//! 能力：读要 `sync.run`（System `sync.loop`）或 `sync.status`（User）；写要 `sync.run` 或设置页的
//! `sync.configure` / `sync.pairing_create` / `sync.reset` 之一。

use std::collections::BTreeMap;

use crate::project::{db, dom_read_error, write_error};
use crate::write::Service;
use atm_domain::capability::{self, Capability};
use atm_domain::error::DomainError;
use atm_domain::principal::Principal;
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::Value;

/// 发布去重缓存的一条：项目在当前空间里的键名哈希、最近一次写入的内容摘要、head 里的条目。
#[derive(Clone, Debug, PartialEq)]
pub struct Published {
    pub h: String,
    pub d: String,
    pub head: Value,
}

/// 2.x `SyncConfig`（`v` 恒为 1，不单独存）。
#[derive(Clone, Debug, PartialEq)]
pub struct SyncLedger {
    pub enabled: bool,
    pub relay_url: Option<String>,
    pub app_id: String,
    pub device_id: String,
    pub device_name: String,
    pub space_id: Option<String>,
    pub cursor: Option<String>,
    /// 项目码 → 发布缓存。
    pub published: BTreeMap<String, Published>,
    pub head_digest: Option<String>,
    /// 已处理的命令 ID，按记下的先后。
    pub processed: Vec<String>,
    pub last_sync_at: Option<String>,
    pub last_ack_sweep_at: Option<String>,
}

fn require_any(principal: &Principal, any: &[Capability]) -> Result<(), DomainError> {
    let mut first = None;
    for c in any {
        match capability::require(principal, *c) {
            Ok(()) => return Ok(()),
            Err(e) => {
                first.get_or_insert(e);
            }
        }
    }
    Err(first.unwrap_or_else(|| {
        DomainError::new(
            atm_domain::error::ErrorCode::INTERNAL_ERROR,
            "没有可检查的能力",
        )
    }))
}

const READERS: [Capability; 2] = [Capability::SyncRun, Capability::SyncStatus];
const WRITERS: [Capability; 4] = [
    Capability::SyncRun,
    Capability::SyncConfigure,
    Capability::SyncPairingCreate,
    Capability::SyncReset,
];

fn load(tx: &Transaction<'_>) -> rusqlite::Result<Option<SyncLedger>> {
    let row = tx
        .query_row(
            "SELECT enabled, relay_url, app_id, device_id, device_name, space_id, cursor, head_digest,
                    last_sync_at, last_ack_sweep_at
             FROM sync_state WHERE singleton = 1",
            [],
            |r| {
                Ok(SyncLedger {
                    enabled: r.get::<_, i64>(0)? != 0,
                    relay_url: r.get(1)?,
                    app_id: r.get(2)?,
                    device_id: r.get(3)?,
                    device_name: r.get(4)?,
                    space_id: r.get(5)?,
                    cursor: r.get(6)?,
                    published: BTreeMap::new(),
                    head_digest: r.get(7)?,
                    processed: Vec::new(),
                    last_sync_at: r.get(8)?,
                    last_ack_sweep_at: r.get(9)?,
                })
            },
        )
        .optional()?;
    let Some(mut ledger) = row else {
        return Ok(None);
    };
    let mut published = tx.prepare("SELECT project_code, h, d, head_json FROM sync_published")?;
    for row in published.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
        ))
    })? {
        let (code, h, d, head) = row?;
        let head = serde_json::from_str(&head).unwrap_or(Value::Null);
        ledger.published.insert(code, Published { h, d, head });
    }
    let mut processed = tx.prepare("SELECT command_id FROM sync_processed ORDER BY ord")?;
    ledger.processed = processed
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Some(ledger))
}

fn save(tx: &Transaction<'_>, l: &SyncLedger, now: &str) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO sync_state (singleton, v, enabled, relay_url, app_id, device_id, device_name, space_id,
                                 cursor, head_digest, last_sync_at, last_ack_sweep_at, updated_at)
         VALUES (1, 1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(singleton) DO UPDATE SET
           v = 1, enabled = excluded.enabled, relay_url = excluded.relay_url, app_id = excluded.app_id,
           device_id = excluded.device_id, device_name = excluded.device_name, space_id = excluded.space_id,
           cursor = excluded.cursor, head_digest = excluded.head_digest, last_sync_at = excluded.last_sync_at,
           last_ack_sweep_at = excluded.last_ack_sweep_at, updated_at = excluded.updated_at",
        params![
            i64::from(l.enabled),
            l.relay_url,
            l.app_id,
            l.device_id,
            l.device_name,
            l.space_id,
            l.cursor,
            l.head_digest,
            l.last_sync_at,
            l.last_ack_sweep_at,
            now,
        ],
    )?;
    tx.execute("DELETE FROM sync_published", [])?;
    for (code, p) in &l.published {
        tx.execute(
            "INSERT INTO sync_published (project_code, h, d, head_json) VALUES (?1, ?2, ?3, ?4)",
            params![code, p.h, p.d, p.head.to_string()],
        )?;
    }
    tx.execute("DELETE FROM sync_processed", [])?;
    for (i, id) in l.processed.iter().enumerate() {
        tx.execute(
            "INSERT INTO sync_processed (ord, command_id) VALUES (?1, ?2)",
            params![i as i64 + 1, id],
        )?;
    }
    Ok(())
}

impl Service {
    /// 读账本；还没有写过（新装、2.x 的 config.json 缺失或损坏）是 `None`，由调用方用默认值。
    pub fn sync_ledger(&self, principal: &Principal) -> Result<Option<SyncLedger>, DomainError> {
        require_any(principal, &READERS)?;
        self.store()
            .read(|tx| load(tx).map_err(db))
            .map_err(dom_read_error)
    }

    /// 整份写入账本。
    pub fn save_sync_ledger(
        &self,
        principal: &Principal,
        ledger: &SyncLedger,
    ) -> Result<(), DomainError> {
        require_any(principal, &WRITERS)?;
        let ledger = ledger.clone();
        let now = self.clock().to_string();
        self.store()
            .write(move |tx| save(tx, &ledger, &now).map_err(db))
            .map_err(write_error)
    }
}
