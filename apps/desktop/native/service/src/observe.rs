//! 托盘与系统通知要读的东西（W5f；06 §2 桌面观察器，03 §2.4 `notify.observe`）。
//!
//! 2.0 的 `desktop-observer.ts` 按项目订阅事件流，再单独订一条全局流看 `backup.failed`。3.0 只有一个库，
//! 项目事件在同一个写事务里镜像进 `global_feed`（R6），所以观察器只追这一条流：按 `global_seq` 往后读，
//! 每条带上它所属项目的代码与生命周期。托盘计数与通知方式在同一个读事务里给出，三者是同一个快照。
//!
//! 只读。决定发不发、怎么去重的策略在 `atm-jobs` 的观察器里（System 主体只在那里构造）。

use crate::project::{db, dom_read_error};
use crate::read::present::present;
use crate::settings::NOTIFICATION_MODE;
use crate::write::Service;
use atm_domain::capability::{self, Capability};
use atm_domain::error::DomainError;
use atm_domain::principal::Principal;
use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value};

/// 一次最多读的事件条数（与 delta 同一上限）。
pub const OBSERVE_MAX: usize = 100;

const MODES: [&str; 3] = ["ALL", "CRITICAL", "OFF"];

/// 全局流里的一条事件，呈现方式与 delta / 全局活动相同。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeedEvent {
    pub seq: i64,
    pub kind: String,
    pub key: Option<String>,
    pub summary: String,
    /// 项目事件的项目；全局事件（备份等）是 `None`。
    pub project: Option<FeedProject>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeedProject {
    pub code: String,
    /// 生命周期是 ACTIVE。2.0 只订阅 ACTIVE 项目的事件流，归档、回收站里的项目不发通知。
    pub active: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Observed {
    /// 未进回收站的项目里 BLOCKED 的任务数（与总览的 `blocked_count` 之和同一口径）。
    pub blocked: u64,
    /// 同上，WAITING_USER（总览的 `waiting_user_count`）。
    pub waiting: u64,
    /// `notification.mode`；没有或不合法时是 ALL。旧键 `notification.enabled` 已在转换时并入（N-04）。
    pub mode: &'static str,
    /// `since` 之后的事件，升序。
    pub events: Vec<FeedEvent>,
    /// 下一次的 `since`：读到的最后一条；没读到就是这次的 `since`。
    pub next_seq: i64,
    pub has_more: bool,
}

impl Service {
    /// 托盘计数、通知方式，以及 `since` 之后最多 `limit`（1～[`OBSERVE_MAX`]）条全局流事件。
    /// `since` 为 `None` 时从当前末尾开始：不读事件，`next_seq` 是现在的最大 `global_seq`
    /// （与 2.0 一样，观察器启动前发生的事不补发通知）。
    pub fn observe(
        &self,
        principal: &Principal,
        since: Option<i64>,
        limit: usize,
    ) -> Result<Observed, DomainError> {
        capability::require(principal, Capability::EventsRead)?;
        capability::require(principal, Capability::SettingsRead)?;
        let limit = limit.clamp(1, OBSERVE_MAX);
        self.store()
            .read(move |tx| -> Result<Observed, DomainError> {
                let (blocked, waiting): (i64, i64) = tx
                    .query_row(
                        "SELECT COALESCE(SUM(CASE WHEN w.status = 'BLOCKED' THEN 1 ELSE 0 END), 0),
                                COALESCE(SUM(CASE WHEN w.status = 'WAITING_USER' THEN 1 ELSE 0 END), 0)
                         FROM work_items w JOIN projects p ON p.id = w.project_id
                         WHERE p.lifecycle <> 'TRASHED'",
                        [],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .map_err(db)?;
                let stored: Option<String> = tx
                    .query_row(
                        "SELECT value_json FROM settings WHERE key = ?1",
                        [NOTIFICATION_MODE],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(db)?;
                let mode = stored
                    .and_then(|v| serde_json::from_str::<Value>(&v).ok())
                    .and_then(|v| {
                        MODES
                            .into_iter()
                            .find(|m| v.as_str() == Some(*m))
                    })
                    .unwrap_or("ALL");
                let Some(since) = since else {
                    let tail: i64 = tx
                        .query_row(
                            "SELECT COALESCE(MAX(global_seq), 0) FROM global_feed",
                            [],
                            |r| r.get(0),
                        )
                        .map_err(db)?;
                    return Ok(Observed {
                        blocked: blocked.max(0) as u64,
                        waiting: waiting.max(0) as u64,
                        mode,
                        events: Vec::new(),
                        next_seq: tail,
                        has_more: false,
                    });
                };
                let mut events = tx
                    .prepare(
                        "SELECT f.global_seq, f.type, f.aggregate_id, f.actor, f.payload_json, p.code, p.lifecycle
                         FROM global_feed f LEFT JOIN projects p ON p.id = f.project_id
                         WHERE f.global_seq > ?1 ORDER BY f.global_seq LIMIT ?2",
                    )
                    .map_err(db)?
                    .query_map(params![since, (limit + 1) as i64], |r| {
                        let kind: String = r.get(1)?;
                        let aggregate: String = r.get(2)?;
                        let actor: String = r.get(3)?;
                        let payload = match serde_json::from_str::<Value>(&r.get::<_, String>(4)?) {
                            Ok(Value::Object(m)) => m,
                            _ => Map::new(),
                        };
                        let shown = present(&kind, Some(&aggregate), Some(&actor), &payload);
                        let project = match r.get::<_, Option<String>>(5)? {
                            Some(code) => Some(FeedProject {
                                code,
                                active: r.get::<_, Option<String>>(6)?.as_deref() == Some("ACTIVE"),
                            }),
                            None => None,
                        };
                        Ok(FeedEvent {
                            seq: r.get(0)?,
                            kind,
                            key: shown.key,
                            summary: shown.detail,
                            project,
                        })
                    })
                    .map_err(db)?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(db)?;
                let has_more = events.len() > limit;
                events.truncate(limit);
                Ok(Observed {
                    blocked: blocked.max(0) as u64,
                    waiting: waiting.max(0) as u64,
                    mode,
                    next_seq: events.last().map_or(since, |e| e.seq),
                    events,
                    has_more,
                })
            })
            .map_err(dom_read_error)
    }
}
