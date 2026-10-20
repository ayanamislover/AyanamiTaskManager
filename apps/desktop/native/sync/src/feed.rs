//! 变更流（2.x `packages/sync-protocol/src/feed.ts`）。每次 [`ChangeFeed::next`] 返回一批（可能为空）：
//! 支持长轮询的中继挂起等待；不支持的（AyanamiCloud）在上一批为空时先睡 `interval` 再问。

use std::time::Duration;

use atm_sync_protocol::keys::space_prefix;

use crate::relay::{Change, RelayClient, RelayError};
use crate::transport::{Cancel, Sleeper};

#[derive(Debug, Clone, PartialEq)]
pub struct FeedBatch {
    /// 只含本空间的变更。
    pub changes: Vec<Change>,
    pub cursor: Option<String>,
    /// 游标刚建立或已过期（410）：调用方应该全量列一次本空间的文档，之后的增量从新游标开始。
    pub reset: bool,
}

pub struct ChangeFeedOptions {
    pub client: RelayClient,
    pub space_id: String,
    pub cursor: Option<String>,
    pub long_poll: bool,
    /// 长轮询时每次最多挂起的秒数，默认 25。
    pub max_wait: Option<f64>,
    /// 定时轮询间隔。
    pub interval: Duration,
    /// 换掉默认的等待（用例）。默认用调用方给的令牌打断。
    pub sleep: Option<Sleeper>,
}

const BOOTSTRAP_PAGE_LIMIT: usize = 200;

pub struct ChangeFeed {
    client: RelayClient,
    prefix: String,
    long_poll: bool,
    max_wait: f64,
    interval: Duration,
    sleep: Option<Sleeper>,
    cursor: Option<String>,
    idle: bool,
}

impl ChangeFeed {
    /// 空间 ID 不合法时返回 `None`（会话打开前已经校验过）。
    pub fn new(options: ChangeFeedOptions) -> Option<ChangeFeed> {
        Some(ChangeFeed {
            prefix: space_prefix(&options.space_id).ok()?,
            client: options.client,
            long_poll: options.long_poll,
            max_wait: options.max_wait.unwrap_or(25.0).clamp(1.0, 25.0),
            interval: options.interval,
            sleep: options.sleep,
            cursor: options.cursor,
            idle: false,
        })
    }

    pub fn cursor(&self) -> Option<&str> {
        self.cursor.as_deref()
    }

    /// 下一次 `next` 不等待（例如刚发了命令，想尽快看到回执）。
    pub fn poke(&mut self) {
        self.idle = false;
    }

    fn bootstrap(&mut self, cancel: Option<&Cancel>) -> Result<FeedBatch, RelayError> {
        let mut cursor: Option<String> = None;
        for _ in 0..BOOTSTRAP_PAGE_LIMIT {
            let page = self
                .client
                .changes(cursor.as_deref(), Some(500), 0.0, cancel)?;
            cursor = page.next_cursor;
            if !page.has_more {
                break;
            }
        }
        self.cursor = cursor.clone();
        self.idle = false;
        Ok(FeedBatch {
            changes: Vec::new(),
            cursor,
            reset: true,
        })
    }

    pub fn next(&mut self, cancel: Option<&Cancel>) -> Result<FeedBatch, RelayError> {
        let Some(cursor) = self.cursor.clone() else {
            return self.bootstrap(cancel);
        };
        if !self.long_poll && self.idle {
            let slept = match (&self.sleep, cancel) {
                (Some(sleep), _) => sleep(self.interval),
                (None, Some(c)) => c.sleep(self.interval),
                (None, None) => {
                    std::thread::sleep(self.interval);
                    true
                }
            };
            if !slept || cancel.is_some_and(Cancel::is_cancelled) {
                return Err(RelayError::aborted());
            }
        }
        let wait = if self.long_poll { self.max_wait } else { 0.0 };
        match self.client.changes(Some(&cursor), Some(500), wait, cancel) {
            Ok(page) => {
                if let Some(next) = page.next_cursor {
                    self.cursor = Some(next);
                }
                self.idle = !page.has_more && page.changes.is_empty();
                Ok(FeedBatch {
                    changes: page
                        .changes
                        .into_iter()
                        .filter(|c| c.key.starts_with(&self.prefix))
                        .collect(),
                    cursor: self.cursor.clone(),
                    reset: false,
                })
            }
            Err(e) if e.status == 410 => {
                self.cursor = None;
                self.bootstrap(cancel)
            }
            Err(e) => Err(e),
        }
    }
}

/// 网络失败后的退避：1 s → 2 s → … → 60 s。
pub fn backoff_delay(failures: u32) -> Duration {
    let exp = failures.saturating_sub(1).min(16);
    Duration::from_millis((1000u64 << exp).min(60_000))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_up_to_a_minute() {
        let ms: Vec<u128> = [0, 1, 2, 3, 6, 7, 40, u32::MAX]
            .iter()
            .map(|f| backoff_delay(*f).as_millis())
            .collect();
        assert_eq!(ms, [1000, 1000, 2000, 4000, 32_000, 60_000, 60_000, 60_000]);
    }
}
