//! 备份的服务入口（03：`backup.list`、`backup.create_manual`、`backup.restore_scope`；方案 §4；10 R4、R5）。
//!
//! 备份与按范围恢复的机制都在存储层（W1，`atm_store::backup` / `atm_store::restore`）；这里只加主体与
//! 能力检查、选项与错误码。三者都不走写入流水线：备份是文件 IO 加一行登记，恢复自带世代与墓碑
//! （R4），两者在 2.x 也都没有 op_id。
//!
//! - 列表：最新的在前；Agent 也可以读（03 能力表 A=✓）。
//! - 手动备份：kind `MANUAL`，只有 User。
//! - 按范围恢复：只有 User；范围是一个项目或知识库。恢复前把选中的备份固定 [`RESTORE_PIN_DAYS`] 天
//!   （A4 的「固定选中的备份」，保留期清理在 W5 跳过固定的备份），PRE_RESTORE 由存储层先做。

use crate::write::{Service, internal};
use atm_domain::capability::{self, Capability};
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::principal::Principal;
use atm_domain::text::js_trim;
use atm_domain::time::Timestamp;
use atm_store::backup::{BackupError, BackupInfo, StoreFailure, Withdrawal, create_backup};
use atm_store::restore::{RestoreOptions, RestoreOutcome, restore_knowledge, restore_project};
use serde_json::{Value, json};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 恢复时把选中的备份固定多少天（由实现定下：够用户在恢复后发现问题再回退一次）。
pub const RESTORE_PIN_DAYS: i64 = 30;
/// 恢复事务的时长预算。
const RESTORE_BUDGET: Duration = Duration::from_secs(30);
const LIST_MAX: usize = 200;
/// 撤回诊断保留的条数。
pub const WITHDRAWALS_KEPT: usize = 16;

/// 按范围恢复的范围。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RestoreScope {
    /// 项目代码或 id。
    Project(String),
    Knowledge,
}

fn now() -> Timestamp {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    Timestamp::from_millis(i64::try_from(ms).unwrap_or(i64::MAX))
}

pub(crate) fn backup_error(e: BackupError) -> DomainError {
    let message = e.to_string();
    let (code, extra): (ErrorCode, Option<(&str, Value)>) = match e {
        BackupError::NotFound(_) => (ErrorCode::BACKUP_NOT_FOUND, None),
        BackupError::Corrupt(_) | BackupError::Unsupported(_) => {
            (ErrorCode::BACKUP_INTEGRITY_FAILED, None)
        }
        BackupError::SchemaMismatch => (
            ErrorCode::BACKUP_MANIFEST_MISMATCH,
            Some(("reason", json!("SCHEMA"))),
        ),
        BackupError::TimelineMismatch(_) => (ErrorCode::BACKUP_PROJECT_IDENTITY_MISMATCH, None),
        BackupError::ScopeMissing(_) => (ErrorCode::BACKUP_RESTORE_SCOPE_UNSUPPORTED, None),
        // 只有真正没执行的才是可重试的 STORE_BUSY / SERVICE_UNAVAILABLE（W2 peer r2 P2-01）。
        // 写准入超时保证这一次写没有提交；读忙只说明这一次读没做，之前的步骤由各自的错误说明。
        BackupError::Write { failure, .. } => match failure {
            StoreFailure::WriteBusy => (ErrorCode::STORE_BUSY, Some(("committed", json!(false)))),
            StoreFailure::ReadBusy => (ErrorCode::STORE_BUSY, None),
            StoreFailure::Closed => (ErrorCode::SERVICE_UNAVAILABLE, None),
            StoreFailure::Failed => (ErrorCode::INTERNAL_ERROR, None),
        },
        // 库已经恢复、附件还没换入：不能当作没发生，交给调用方看详情。
        BackupError::AttachmentsPending { generation, .. } => (
            ErrorCode::INTERNAL_ERROR,
            Some(("attachments_pending_generation", json!(generation))),
        ),
        BackupError::Sqlite(_) | BackupError::Io(_) | BackupError::Reentrant(_) => {
            (ErrorCode::INTERNAL_ERROR, None)
        }
    };
    let e = DomainError::new(code, message);
    match extra {
        Some((k, v)) => e.detail(k, v),
        None => e,
    }
}

fn info_view(b: &BackupInfo) -> Value {
    json!({
        "id": b.id,
        "kind": b.kind,
        "path": b.dir.to_string_lossy(),
        "sha256": b.sha256,
        "sizeBytes": b.size_bytes,
        "attachmentsSha256": b.attachments_sha256,
        "createdAt": b.created_at,
    })
}

impl Service {
    fn backups_dir(&self) -> Result<std::path::PathBuf, DomainError> {
        self.backups_root
            .clone()
            .ok_or_else(|| internal("没有配置备份目录"))
    }

    /// 备份列表（`backup.list`），最新的在前，最多 `limit`（1–200）条。
    pub fn list_backups(&self, principal: &Principal, limit: usize) -> Result<Value, DomainError> {
        capability::require(principal, Capability::BackupList)?;
        let limit = limit.clamp(1, LIST_MAX) as i64;
        let rows: Vec<Value> = self
            .store()
            .read(|tx| {
                tx.prepare(
                    "SELECT id, kind, sha256, size_bytes, schema_version, created_at, verified_at, pinned_until
                     FROM backups ORDER BY created_at DESC, id DESC LIMIT ?1",
                )?
                .query_map([limit], |r| {
                    Ok(json!({
                        "id": r.get::<_, String>(0)?,
                        "kind": r.get::<_, String>(1)?,
                        "sha256": r.get::<_, String>(2)?,
                        "sizeBytes": r.get::<_, i64>(3)?,
                        "schemaVersion": r.get::<_, i64>(4)?,
                        "createdAt": r.get::<_, String>(5)?,
                        "verifiedAt": r.get::<_, Option<String>>(6)?,
                        "pinnedUntil": r.get::<_, Option<String>>(7)?,
                    }))
                })?
                .collect::<rusqlite::Result<_>>()
            })
            .map_err(|e| internal(format!("{e:?}")))?;
        let pending = self
            .backups_root
            .as_deref()
            .map_or(0, atm_store::backup::withdrawn_pending);
        let recent: Vec<Value> = self
            .withdrawals
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .cloned()
            .collect();
        Ok(json!({
            "backups": rows,
            "withdrawals": { "cleanupPending": pending, "recent": recent },
        }))
    }

    /// 记一次撤回的结果，只留最近 [`WITHDRAWALS_KEPT`] 条。
    pub(crate) fn note_withdrawal(&self, id: &str, outcome: Withdrawal) {
        let reason = match &outcome {
            Withdrawal::Kept(why) => Some((*why).to_string()),
            Withdrawal::Failed(e) => Some(e.chars().take(200).collect()),
            _ => None,
        };
        let mut log = self.withdrawals.lock().unwrap_or_else(|e| e.into_inner());
        if log.len() == WITHDRAWALS_KEPT {
            log.pop_front();
        }
        log.push_back(json!({ "id": id, "outcome": outcome.as_str(), "reason": reason }));
    }

    /// 手动整库备份（`backup.create_manual`，只有 User）。
    pub fn create_manual_backup(&self, principal: &Principal) -> Result<Value, DomainError> {
        capability::require(principal, Capability::BackupCreateManual)?;
        let info = create_backup(
            self.store(),
            &self.backups_dir()?,
            "MANUAL",
            &now().to_string(),
        )
        .map_err(backup_error)?;
        Ok(info_view(&info))
    }

    /// 按范围恢复（`backup.restore_scope`，只有 User）。
    pub fn restore_scope(
        &self,
        principal: &Principal,
        backup_id: &str,
        scope: RestoreScope,
    ) -> Result<Value, DomainError> {
        capability::require(principal, Capability::BackupRestoreScope)?;
        let backup_id = js_trim(backup_id);
        if backup_id.is_empty() {
            return Err(
                DomainError::new(ErrorCode::INVALID_ARGUMENT, "backup_id 不能为空")
                    .detail("field", "backup_id"),
            );
        }
        let root = self.backups_dir()?;
        let at = now();
        let pin = Timestamp::from_millis(at.millis() + RESTORE_PIN_DAYS * 86_400_000);
        let (at, pin) = (at.to_string(), pin.to_string());
        let opts = RestoreOptions {
            backups_root: &root,
            at: &at,
            pin_until: &pin,
            budget: RESTORE_BUDGET,
        };
        let (outcome, scope_view): (RestoreOutcome, Value) = match scope {
            RestoreScope::Project(project) => {
                let id = self.project_scope(&project)?;
                let out =
                    restore_project(self.store(), backup_id, &id, &opts).map_err(backup_error)?;
                (out, json!({ "kind": "PROJECT", "projectId": id }))
            }
            RestoreScope::Knowledge => {
                let out =
                    restore_knowledge(self.store(), backup_id, &opts).map_err(backup_error)?;
                (out, json!({ "kind": "KNOWLEDGE" }))
            }
        };
        Ok(json!({
            "backupId": backup_id,
            "scope": scope_view,
            "generation": outcome.generation,
            "preRestoreBackupId": outcome.pre_restore_backup_id,
            "sequenceBefore": outcome.seq_before,
            "sequenceAfter": outcome.seq_after,
            "pinnedUntil": pin,
        }))
    }
}
