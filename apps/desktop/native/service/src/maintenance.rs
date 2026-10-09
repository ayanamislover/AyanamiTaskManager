//! 维护作业（W5h；03 §2.4 job `maintenance`，P-009；2.x `backup-maintenance.ts`、`backup-retention.ts`）。
//!
//! 3.0 只有一个库，DAILY / WEEKLY 都是整库备份：
//! - 当天（UTC 日期）还没有 DAILY 就做一份；最近一份 WEEKLY 满 7 天（或没有）就做一份；
//! - 每种备份按 `backup.policy` 各留最新的几份（DAILY 默认 2、WEEKLY 2、其余每种 2），多出来的修剪掉：
//!   固定还没到期的、被恢复引用着的不删（A4），撤回走存储层的隔离再删，任何时刻目录与登记都一致；
//! - 做备份失败记一条全局 `backup.failed`（托盘与系统通知据此提示）；
//! - 收尾做一次 `PRAGMA optimize`（`store.maintain`）。
//!
//! `backup.policy.enabled = false` 时整轮跳过（2.x 一样，连修剪也不做）。手动备份不在这里：它只能由 User
//! 发起（P-005）。手动备份、生命周期迁移前的 PRE_ARCHIVE / PRE_TRASH、恢复前的 PRE_RESTORE 做完都立刻
//! 按策略修剪同一种（[`Service::prune_after`]，2.x 的 `#createBackup` 也是这样）。

use crate::write::{Service, internal};
use atm_domain::capability::{self, Capability};
use atm_domain::error::DomainError;
use atm_domain::principal::Principal;
use atm_domain::time::Timestamp;
use atm_store::backup::{BackupInfo, Withdrawal, create_backup, prune_backup, sweep_withdrawn};
use atm_store::events as store_events;
use serde_json::{Value, json};
use std::path::PathBuf;

const WEEK_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// 一轮维护的结果。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MaintenanceReport {
    pub skipped: bool,
    pub daily_created: usize,
    pub weekly_created: usize,
    pub pruned: usize,
    /// 修剪时因固定、恢复引用或文件被占用而保留下来的份数。
    pub kept: usize,
    pub errors: Vec<String>,
}

impl MaintenanceReport {
    pub fn to_json(&self) -> Value {
        json!({
            "skipped": self.skipped,
            "dailyCreated": self.daily_created,
            "weeklyCreated": self.weekly_created,
            "prunedBackups": self.pruned,
            "keptBackups": self.kept,
            "errors": self.errors,
        })
    }
}

fn info(row: (String, String, String, String, i64, Option<String>, String)) -> BackupInfo {
    BackupInfo {
        id: row.0,
        kind: row.1,
        dir: PathBuf::from(row.2),
        sha256: row.3,
        size_bytes: u64::try_from(row.4).unwrap_or(0),
        attachments_sha256: row.5.unwrap_or_default(),
        created_at: row.6,
    }
}

impl Service {
    /// 一轮维护（job `maintenance`）：DAILY / WEEKLY 备份、按策略修剪、`PRAGMA optimize`。
    pub fn run_maintenance(
        &self,
        principal: &Principal,
        at: Timestamp,
    ) -> Result<MaintenanceReport, DomainError> {
        capability::require(principal, Capability::BackupCreateScheduled)?;
        capability::require(principal, Capability::BackupPruneRetention)?;
        capability::require(principal, Capability::StoreMaintain)?;
        let root = self
            .backups_root
            .clone()
            .ok_or_else(|| internal("没有配置备份目录"))?;
        let policy = self
            .store()
            .read(crate::settings::stored_backup_policy)
            .map_err(crate::project::dom_read_error)?;
        let mut report = MaintenanceReport::default();
        if !policy.enabled {
            report.skipped = true;
            return Ok(report);
        }
        let at_text = at.to_string();
        let day = at_text.get(..10).unwrap_or_default().to_owned();
        let (has_daily, last_weekly): (bool, Option<String>) = self
            .store()
            .read({
                let day = day.clone();
                move |tx| {
                    let daily = tx.query_row(
                        "SELECT EXISTS (SELECT 1 FROM backups WHERE kind = 'DAILY' AND substr(created_at, 1, 10) = ?1)",
                        [&day],
                        |r| r.get(0),
                    )?;
                    let weekly = tx
                        .query_row(
                            "SELECT max(created_at) FROM backups WHERE kind = 'WEEKLY'",
                            [],
                            |r| r.get(0),
                        )?;
                    Ok::<_, rusqlite::Error>((daily, weekly))
                }
            })
            .map_err(|e| internal(format!("{e:?}")))?;
        let weekly_due = last_weekly
            .and_then(|t| Timestamp::parse(&t))
            .is_none_or(|t| at.millis() - t.millis() >= WEEK_MS);
        for (kind, due) in [("DAILY", !has_daily), ("WEEKLY", weekly_due)] {
            if !due {
                continue;
            }
            match create_backup(self.store(), &root, kind, &at_text) {
                Ok(_) if kind == "DAILY" => report.daily_created += 1,
                Ok(_) => report.weekly_created += 1,
                Err(e) => {
                    let error = crate::backups::backup_error(e);
                    report
                        .errors
                        .push(format!("{kind}: {}", error.code.as_str()));
                    self.backup_failed(kind, error.code.as_str(), &at_text);
                }
            }
        }
        let (pruned, kept) = self.prune_retention(None, &policy, &at_text, &mut report.errors);
        report.pruned = pruned;
        report.kept = kept;
        if let Err(e) = sweep_withdrawn(self.store(), &root) {
            report.errors.push(format!("SWEEP: {e}"));
        }
        if let Err(e) = self.store().write(|tx| tx.execute_batch("PRAGMA optimize")) {
            report.errors.push(format!("OPTIMIZE: {e:?}"));
        }
        Ok(report)
    }

    /// 做备份失败：一条全局 `backup.failed`（不属于项目流），说明里只有种类与错误码。
    fn backup_failed(&self, kind: &str, code: &str, at: &str) {
        let (kind, code, at) = (kind.to_owned(), code.to_owned(), at.to_owned());
        let _ = self.store().write(move |tx| {
            let payload = json!({ "scope": "DATABASE", "reason": kind, "code": code }).to_string();
            store_events::append_global(
                tx,
                "backup.failed",
                &format!("{kind}:{at}"),
                "SYSTEM",
                &payload,
                None,
                &at,
            )
        });
    }

    /// 刚做完一份 `kind` 备份之后按策略修剪这一种（2.x 每做一份备份都按原因修剪，backup-maintenance:276）。
    /// 与 2.x 一样不看 `enabled`；出错不影响已经做好的备份与已经提交的操作，只留在撤回诊断里。
    pub(crate) fn prune_after(&self, kind: &str, at: &str) {
        if let Ok(policy) = self.store().read(crate::settings::stored_backup_policy) {
            self.prune_retention(Some(kind), &policy, at, &mut Vec::new());
        }
    }

    /// 按策略修剪。`only` 给出时只修剪这一种（手动备份之后只动 MANUAL）。返回（删掉的，留下的）。
    pub(crate) fn prune_retention(
        &self,
        only: Option<&str>,
        policy: &crate::settings::BackupPolicy,
        now: &str,
        errors: &mut Vec<String>,
    ) -> (usize, usize) {
        let only = only.map(str::to_owned);
        type Row = (String, String, String, String, i64, Option<String>, String);
        let rows: Vec<Row> = match self.store().read(move |tx| {
            tx.prepare(
                "SELECT id, kind, path, sha256, size_bytes, attachments_manifest_sha256, created_at
                 FROM backups WHERE (?1 IS NULL OR kind = ?1) ORDER BY kind, created_at DESC, id DESC",
            )?
            .query_map([only], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            })?
            .collect::<rusqlite::Result<_>>()
        }) {
            Ok(rows) => rows,
            Err(e) => {
                errors.push(format!("PRUNE: {e:?}"));
                return (0, 0);
            }
        };
        let (mut pruned, mut kept) = (0, 0);
        let mut seen: Option<(String, usize)> = None;
        for row in rows {
            let index = match &mut seen {
                Some((kind, n)) if *kind == row.1 => {
                    *n += 1;
                    *n
                }
                _ => {
                    seen = Some((row.1.clone(), 0));
                    0
                }
            };
            let keep = match row.1.as_str() {
                "DAILY" => policy.daily_keep,
                "WEEKLY" => policy.weekly_keep,
                _ => policy.other_keep,
            };
            if (index as i64) < keep {
                continue;
            }
            let backup = info(row);
            match prune_backup(self.store(), &backup, now) {
                Ok(Withdrawal::Withdrawn | Withdrawal::CleanupPending) => pruned += 1,
                Ok(outcome @ Withdrawal::Kept(_)) => {
                    kept += 1;
                    self.note_withdrawal(&backup.id, outcome);
                }
                Ok(outcome @ Withdrawal::Failed(_)) => {
                    errors.push(format!("PRUNE {}: failed", backup.id));
                    self.note_withdrawal(&backup.id, outcome);
                }
                Err(e) => errors.push(format!("PRUNE {}: {e}", backup.id)),
            }
        }
        (pruned, kept)
    }
}
