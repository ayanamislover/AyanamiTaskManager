//! 进行中文件事务的落定（W3b6；05 §4.1）。在工作副本上照做 2.0 启动恢复的规则，源文件只读不开。
//!
//! 顺序与 2.0 一样（`manager.ts:238-240`、`knowledge-database.ts:37`）：
//! 1. 知识库恢复日志 `knowledge\restore.json`（`knowledge-restore.ts:28-58`）：`committed=false` 且
//!    `before-restore-<id>` 在 → 它是现库；否则现库为准。候选件 `restore-<id>.sqlite` 丢弃；
//!    别的 `restore-<ULID>.sqlite` 是孤儿，2.0 移进 `backups\knowledge\orphan-*`，这里登记进 `legacy_backups`。
//!    日志读不出、不是对象、id 不是 ULID、committed 不是布尔 → 2.0 让知识库不可用，这里停。
//! 2. `CREATING`（`startup-recovery.ts:81-103`）：`projects\<id>\project.sqlite` 通过 `quick_check` → ACTIVE
//!    （写 `db_path`）；否则 TRASHED，且没有项目数据。`.creating-*` 目录丢弃。
//! 3. `RESTORING`（`startup-recovery.ts:122-146`）：名字以 `project.sqlite.restore-old-` 开头的文件按名排序，
//!    从后往前取第一个健康的作为现库 → ACTIVE；没有回滚件且现库健康 → ACTIVE；否则 MIGRATION_FAILED。
//!    ACTIVE 且有回滚件时以现库为准，回滚件丢弃。`projects\.restore-*` 暂存目录丢弃。
//! 4. `MIGRATION_FAILED`（`manager.ts:315-356`）：库在且非空 → 在副本上补迁移、核对 project_meta 的身份 →
//!    ACTIVE，并追加全局事件 `project.migration_recovered`（dedupe 键已在就不追加）；做不到 → 整体转换失败，点名项目。
//!    用户用 `accept_unconvertible` 点名的项目改为舍弃：TRASHED、没有数据，原库登记进 `legacy_backups`。
//!
//! 落定只改 registry 的工作副本（lifecycle、`updated_at = at`、`db_path`、全局事件），并决定每个项目取哪个文件；
//! 转换与独立 VERIFY 各自重做一遍，结果相同。每一项落定记进 [`Report::settlements`]。

use super::{ConvertError, Home, Report, Result, Settlement, prepare_source, sidecar};
use crate::jsjson::{self, Value};
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn is_ulid(s: &str) -> bool {
    s.len() == 26
        && s.bytes()
            .all(|b| b"0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(&b))
}

// ---------------------------------------------------------------- 知识库

/// 知识库恢复日志落定之后的样子。
#[derive(Debug, Default)]
pub(super) struct KnowledgePlan {
    /// 现库：`knowledge\knowledge.sqlite`，或未提交恢复留下的 `before-restore-<id>.sqlite`。
    pub live: Option<PathBuf>,
    /// 恢复日志：(id, committed)。
    pub journal: Option<(String, bool)>,
    /// `before-restore-<id>.sqlite` 成了现库（不再是备份）。
    pub previous_is_live: Option<PathBuf>,
    /// 孤儿候选件（2.0 会移进 `backups\knowledge\orphan-*`）。
    pub orphans: Vec<PathBuf>,
}

pub(super) fn knowledge(root: &Path) -> Result<KnowledgePlan> {
    let dir = root.join("knowledge");
    let journal_path = dir.join("restore.json");
    let mut plan = KnowledgePlan::default();
    let mut live = dir.join("knowledge.sqlite");
    let mut candidate = None;
    match std::fs::read(&journal_path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
        Ok(bytes) => {
            let damaged = || {
                ConvertError::Unsupported(format!(
                    "{}: knowledge/restore.json is damaged; 2.0 keeps the knowledge base unavailable until it is repaired",
                    root.display()
                ))
            };
            let value = jsjson::parse_value(&String::from_utf8_lossy(&bytes))
                .ok()
                .flatten()
                .ok_or_else(damaged)?;
            let Value::Object(fields) = &value else {
                return Err(damaged());
            };
            let field = |k: &str| fields.iter().find(|(n, _)| n == k).map(|(_, v)| v);
            let (Some(Value::String(id)), Some(Value::Bool(committed))) =
                (field("id"), field("committed"))
            else {
                return Err(damaged());
            };
            if !is_ulid(id) {
                return Err(damaged());
            }
            let previous = root
                .join("backups")
                .join("knowledge")
                .join(format!("before-restore-{id}.sqlite"));
            if !committed && previous.is_file() {
                live = previous.clone();
                plan.previous_is_live = Some(previous);
            }
            candidate = Some(format!("restore-{id}.sqlite"));
            plan.journal = Some((id.clone(), *committed));
        }
    }
    if let Ok(entries) = std::fs::read_dir(&dir) {
        let mut orphans: Vec<PathBuf> = entries
            .flatten()
            .filter(|e| e.path().is_file())
            .filter(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                name.strip_prefix("restore-")
                    .and_then(|r| r.strip_suffix(".sqlite"))
                    .is_some_and(is_ulid)
                    && candidate.as_deref() != Some(name.as_str())
            })
            .map(|e| e.path())
            .collect();
        orphans.sort();
        plan.orphans = orphans;
    }
    plan.live = live.is_file().then_some(live);
    Ok(plan)
}

/// 知识库这一项落定写进报告（数据根枚举时，转换与 VERIFY 各一次）。
pub(super) fn report_knowledge(plan: &KnowledgePlan, report: &mut Report) {
    if let Some((id, committed)) = &plan.journal {
        let (now, how) = match (&plan.previous_is_live, committed) {
            (Some(_), _) => (
                "ROLLED_BACK",
                format!("restore {id} was not committed; before-restore-{id} is the live database"),
            ),
            (None, true) => (
                "COMMITTED",
                format!("restore {id} was committed; the live database stands"),
            ),
            (None, false) => (
                "COMMITTED",
                format!(
                    "restore {id} was not committed and left no before-restore file; the live database stands"
                ),
            ),
        };
        report.settlements.push(Settlement {
            scope: "k".into(),
            was: "RESTORING".into(),
            now: now.into(),
            how,
        });
    }
}

// ---------------------------------------------------------------- 项目

/// `healthyDatabase`：文件在、`quick_check` 恰好一行 `ok`。在探测副本上做（含非空的 `-wal`），不开源文件。
fn healthy(path: &Path, work: &Path) -> Result<bool> {
    if !path.is_file() {
        return Ok(false);
    }
    let probe = work.join("probe.sqlite");
    let probe_wal = sidecar(&probe, "-wal");
    let _ = std::fs::remove_file(&probe_wal);
    std::fs::copy(path, &probe)?;
    let wal = sidecar(path, "-wal");
    if std::fs::metadata(&wal).is_ok_and(|m| m.len() > 0) {
        std::fs::copy(&wal, &probe_wal)?;
    }
    let ok = (|| -> rusqlite::Result<bool> {
        let c = Connection::open(&probe)?;
        let rows: Vec<String> = c
            .prepare("PRAGMA quick_check")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows == ["ok"])
    })()
    .unwrap_or(false);
    for f in [probe.clone(), probe_wal, sidecar(&probe, "-shm")] {
        let _ = std::fs::remove_file(f);
    }
    Ok(ok)
}

struct Row {
    id: String,
    code: String,
    lifecycle: String,
}

/// 项目的落定（CREATING、RESTORING）：改 registry 工作副本，返回每个项目取哪个源文件。
/// 落定成 TRASHED 的项目没有数据，不在返回里（[`Report::settlements`] 里有它）。
/// `sources` 是数据根枚举出的 `projects\<id>\project.sqlite`。MIGRATION_FAILED 留给 [`migration_failed`]。
pub(super) fn projects(
    root: &Path,
    registry: &Path,
    sources: &[PathBuf],
    work: &Path,
    at: &str,
    report: &mut Report,
) -> Result<Vec<PathBuf>> {
    let mut by_id: BTreeMap<String, PathBuf> = sources
        .iter()
        .filter_map(|p| {
            let id = p.parent()?.file_name()?.to_string_lossy().into_owned();
            Some((id, p.clone()))
        })
        .collect();
    let c = Connection::open(registry)?;
    let rows: Vec<Row> = c
        .prepare("SELECT id, code, lifecycle FROM projects WHERE lifecycle IN ('CREATING', 'RESTORING') ORDER BY id")?
        .query_map([], |r| {
            Ok(Row {
                id: r.get(0)?,
                code: r.get(1)?,
                lifecycle: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut settle =
        |id: &str, was: &str, now: &str, how: String, db_path: Option<&Path>| -> Result<()> {
            match db_path {
            Some(p) => c.execute(
                "UPDATE projects SET db_path = ?2, lifecycle = ?3, updated_at = ?4 WHERE id = ?1",
                params![id, p.to_string_lossy(), now, at],
            )?,
            None => c.execute(
                "UPDATE projects SET lifecycle = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, now, at],
            )?,
        };
            report.settlements.push(Settlement {
                scope: id.to_string(),
                was: was.into(),
                now: now.into(),
                how,
            });
            Ok(())
        };
    for row in rows {
        let dir = root.join("projects").join(&row.id);
        let current = dir.join("project.sqlite");
        if row.lifecycle == "CREATING" {
            if healthy(&current, work)? {
                settle(
                    &row.id,
                    "CREATING",
                    "ACTIVE",
                    "the database passed quick_check".into(),
                    Some(&current),
                )?;
                by_id.insert(row.id.clone(), current);
            } else {
                settle(
                    &row.id,
                    "CREATING",
                    "TRASHED",
                    "no healthy database; the project is kept in the trash without data".into(),
                    None,
                )?;
                by_id.remove(&row.id);
            }
            continue;
        }
        // RESTORING
        let mut rollbacks: Vec<PathBuf> = std::fs::read_dir(&dir)
            .map(|d| {
                d.flatten()
                    .filter(|e| e.path().is_file())
                    .filter(|e| {
                        e.file_name()
                            .to_string_lossy()
                            .starts_with("project.sqlite.restore-old-")
                    })
                    .map(|e| e.path())
                    .collect()
            })
            .unwrap_or_default();
        rollbacks.sort();
        let mut chosen = None;
        for r in rollbacks.iter().rev() {
            if healthy(r, work)? {
                chosen = Some(r.clone());
                break;
            }
        }
        if let Some(r) = chosen {
            // 2.0 只把回滚件的主文件改名成现库，它的 -wal 留在原名下；非空的 -wal 这里无法如实复现。
            if std::fs::metadata(sidecar(&r, "-wal")).is_ok_and(|m| m.len() > 0) {
                return Err(ConvertError::Unsupported(format!(
                    "{}: the rollback {} has a WAL that 2.0's recovery would leave behind",
                    root.display(),
                    r.display()
                )));
            }
            let name = r
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            settle(
                &row.id,
                "RESTORING",
                "ACTIVE",
                format!("the healthy rollback {name} is the live database"),
                None,
            )?;
            by_id.insert(row.id.clone(), r);
        } else if rollbacks.is_empty() && healthy(&current, work)? {
            settle(
                &row.id,
                "RESTORING",
                "ACTIVE",
                "interrupted before the first rename; the live database is the pre-restore one"
                    .into(),
                None,
            )?;
        } else {
            settle(
                &row.id,
                "RESTORING",
                "MIGRATION_FAILED",
                "no healthy rollback and the live database cannot stand alone".into(),
                None,
            )?;
        }
    }
    Ok(by_id.into_values().collect())
}

/// MIGRATION_FAILED 的项目：库在且非空时在副本上补迁移、核对身份，成功 → ACTIVE 并追加全局事件；
/// 做不到 → 整体转换失败，点名项目（05 §4.1：不悄悄跳过）。已经做好的工作副本从 `sources` 里拿走，
/// 以 (源文件, 工作副本) 返回。
pub(super) fn migration_failed(
    root: &Path,
    registry: &Path,
    sources: &mut Vec<PathBuf>,
    work: &Path,
    at: &str,
    report: &mut Report,
) -> Result<Vec<(PathBuf, PathBuf)>> {
    let mut prepared = Vec::new();
    let c = Connection::open(registry)?;
    let rows: Vec<Row> = c
        .prepare("SELECT id, code, lifecycle FROM projects WHERE lifecycle = 'MIGRATION_FAILED' ORDER BY code")?
        .query_map([], |r| {
            Ok(Row {
                id: r.get(0)?,
                code: r.get(1)?,
                lifecycle: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let accepted = report.accepted_unconvertible.clone();
    if let Some(code) = accepted
        .iter()
        .find(|c| !rows.iter().any(|r| &r.code == *c))
    {
        return Err(ConvertError::Unsupported(format!(
            "{}: --accept-unconvertible {code}: no project with that code is MIGRATION_FAILED",
            root.display()
        )));
    }
    for row in rows {
        if accepted.contains(&row.code) {
            // 用户点名舍弃：进回收站、没有数据；原库在 convert_files 里登记成 legacy 资产。
            c.execute(
                "UPDATE projects SET lifecycle = 'TRASHED', updated_at = ?2 WHERE id = ?1",
                params![row.id, at],
            )?;
            report.settlements.push(Settlement {
                scope: row.id.clone(),
                was: "MIGRATION_FAILED".into(),
                now: "TRASHED".into(),
                how: "accepted as unconvertible by the user; the original database is registered in legacy_backups"
                    .into(),
            });
            sources.retain(|p| {
                !p.parent()
                    .and_then(Path::file_name)
                    .is_some_and(|n| n == row.id.as_str())
            });
            continue;
        }
        let fail = |why: String| {
            ConvertError::Unsupported(format!(
                "{}: project {} ({}) is {} and 2.0's retry would not recover it: {why}",
                root.display(),
                row.code,
                row.id,
                row.lifecycle
            ))
        };
        let Some(i) = sources.iter().position(|p| {
            p.parent()
                .and_then(Path::file_name)
                .is_some_and(|n| n == row.id.as_str())
        }) else {
            return Err(fail("its database is missing".into()));
        };
        if std::fs::metadata(&sources[i]).map_or(true, |m| m.len() == 0) {
            return Err(fail("its database is empty".into()));
        }
        let (working, p) = prepare_source(
            &sources[i],
            Home::Project,
            &work.join(format!("recovered-{}.sqlite", prepared.len())),
            at,
        )
        .map_err(|e| fail(e.to_string()))?;
        let identity: Option<(String, String)> = Connection::open(&working)?
            .query_row(
                "SELECT project_id, project_code FROM project_meta WHERE singleton = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if identity.as_ref() != Some(&(row.id.clone(), row.code.clone())) {
            return Err(fail("project_meta does not match the registry".into()));
        }
        // 2.0：同一个事务里改 ACTIVE、追加 `project.migration_recovered`（dedupe 键已在就不追加）。
        c.execute_batch("BEGIN IMMEDIATE;")?;
        let r = (|| -> rusqlite::Result<()> {
            c.execute(
                "UPDATE projects SET lifecycle = 'ACTIVE', updated_at = ?2 WHERE id = ?1",
                params![row.id, at],
            )?;
            let dedupe = format!("project-migration-recovered:{}", row.id);
            let exists: bool = c.query_row(
                "SELECT EXISTS (SELECT 1 FROM global_events WHERE dedupe_key = ?1)",
                [&dedupe],
                |r| r.get(0),
            )?;
            if !exists {
                let seq: i64 = c.query_row(
                    "UPDATE app_meta SET current_sequence = current_sequence + 1, updated_at = ?1
                     WHERE singleton = 1 RETURNING current_sequence",
                    [at],
                    |r| r.get(0),
                )?;
                c.execute(
                    "INSERT INTO global_events (sequence, type, aggregate_id, actor, payload_json, created_at, dedupe_key)
                     VALUES (?1, 'project.migration_recovered', ?2, 'SYSTEM', ?3, ?4, ?5)",
                    params![seq, row.id, format!("{{\"code\":{}}}", super::json_string(&row.code)), at, dedupe],
                )?;
            }
            Ok(())
        })();
        c.execute_batch(if r.is_ok() { "COMMIT;" } else { "ROLLBACK;" })?;
        r?;
        report.settlements.push(Settlement {
            scope: row.id.clone(),
            was: "MIGRATION_FAILED".into(),
            now: "ACTIVE".into(),
            how: "migrations applied on the working copy and project_meta matches the registry"
                .into(),
        });
        report.provenance.push(p);
        prepared.push((sources.remove(i), working));
    }
    Ok(prepared)
}
