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
    // 与 sync、dispatch 的 JSON 同一个读入：计量、有上限（W4 关口第三轮 P2-W4A-01）。
    match super::jsonfiles::read_json_file(&journal_path)? {
        super::jsonfiles::JsonFile::Missing => {}
        super::jsonfiles::JsonFile::TooLarge(len) => {
            return Err(super::jsonfiles::too_large(
                root,
                "knowledge/restore.json",
                len,
            ));
        }
        super::jsonfiles::JsonFile::Bytes(bytes) => {
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
    crate::progress::copy_path(path, &probe)?;
    let wal = sidecar(path, "-wal");
    if std::fs::metadata(&wal).is_ok_and(|m| m.len() > 0) {
        crate::progress::copy_path(&wal, &probe_wal)?;
    }
    let ok = (|| -> rusqlite::Result<bool> {
        let c = Connection::open(&probe)?;
        crate::progress::watch(&c)?;
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
    crate::progress::watch(&c)?;
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
    // CREATING 的 db_path 写原始根里的路径（2.0 写的是数据根里的绝对路径）。
    let origin = report.origin(root).to_path_buf();
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
                    Some(&origin.join("projects").join(&row.id).join("project.sqlite")),
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
    crate::progress::watch(&c)?;
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
        // 先按 2.0 的重试走一遍（不落任何状态）：能不能恢复决定了舍弃许可是否成立（05 §4.1）。
        let attempt = (|| -> std::result::Result<(usize, PathBuf, _), String> {
            let i = sources
                .iter()
                .position(|p| {
                    p.parent()
                        .and_then(Path::file_name)
                        .is_some_and(|n| n == row.id.as_str())
                })
                .ok_or("its database is missing")?;
            if std::fs::metadata(&sources[i]).map_or(true, |m| m.len() == 0) {
                return Err("its database is empty".into());
            }
            let (working, p) = prepare_source(
                &sources[i],
                Home::Project,
                &work.join(format!("recovered-{}.sqlite", prepared.len())),
                at,
            )
            .map_err(|e| e.to_string())?;
            let identity: Option<(String, String)> = Connection::open(&working)
                .and_then(|w| {
                    w.query_row(
                        "SELECT project_id, project_code FROM project_meta WHERE singleton = 1",
                        [],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()
                })
                .map_err(|e| e.to_string())?;
            if identity.as_ref() != Some(&(row.id.clone(), row.code.clone())) {
                return Err("project_meta does not match the registry".into());
            }
            Ok((i, working, p))
        })();
        if accepted.contains(&row.code) {
            // 重试能恢复的项目不许舍弃：许可是给「恢复不了」的（旧许可也不能拿来丢掉现在恢复得了的数据）。
            if attempt.is_ok() {
                return Err(ConvertError::Unsupported(format!(
                    "{}: --accept-unconvertible {}: project {} can be recovered by 2.0's retry, so it is converted, not dropped",
                    root.display(),
                    row.code,
                    row.id
                )));
            }
            // 用户点名舍弃：进回收站、没有数据；原库在 convert_files 里登记成 legacy 资产。
            // 许可只对这一份内容有效：记下项目目录的内容摘要，计入 business_digest。
            let digest = tree_digest(&root.join("projects").join(&row.id), work)?;
            report.dropped_sources.insert(row.id.clone(), digest);
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
        let (i, working, p) = attempt.map_err(|why| {
            ConvertError::Unsupported(format!(
                "{}: project {} ({}) is {} and 2.0's retry would not recover it: {why}",
                root.display(),
                row.code,
                row.id,
                row.lifecycle
            ))
        })?;
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

/// 一个目录下全部内容的摘要：按相对路径排序的 (路径, 种类, 摘要)。目录不在时是空集合的摘要。
///
/// 按内容而不是按存储取（W3 peer r2 P2-06）：
/// - 项目库（目录下的 `project.sqlite`，文件头是 `SQLite format 3\0`）连同旁边的 `-wal`、`-shm` 算一项，
///   取 [`database_digest`]。checkpoint、正常关库、SHM 重建、ANALYZE 都不改变它，保留 rowid 的 VACUUM 也不改变
///   （重排了 rowid 就算「变了」）；WAL 里还没合并的写入照样算进去。认不出 schema、索引与行对不上时按字节。
/// - 其他文件按字节（大小与 sha256），包括附件里的 SQLite 文件与它们的 `-wal`、`-shm`：用户自己的库里 rowid
///   可能就是业务键，不能套用 ATM 库的规范化（W4 关口 P1-W4A-02）。
fn tree_digest(dir: &Path, work: &Path) -> Result<String> {
    use sha2::{Digest, Sha256};
    let mut files = Vec::new();
    let mut stack = vec![(dir.to_path_buf(), String::new())];
    while let Some((d, prefix)) = stack.pop() {
        let entries = match std::fs::read_dir(&d) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && d == dir => break,
            r => r?,
        };
        for e in entries {
            let e = e?;
            crate::progress::pulse();
            let rel = format!("{prefix}/{}", e.file_name().to_string_lossy());
            if e.file_type()?.is_dir() {
                stack.push((e.path(), rel));
            } else {
                files.push((rel, e.path()));
            }
        }
    }
    let databases: Vec<String> = files
        .iter()
        .filter(|(rel, p)| rel.eq_ignore_ascii_case("/project.sqlite") && is_database(p))
        .map(|(rel, _)| rel.clone())
        .collect();
    let mut items = Vec::new();
    for (rel, path) in files {
        if databases
            .iter()
            .any(|db| rel == format!("{db}-wal") || super::root::is_wal_index(&rel, db))
        {
            continue;
        }
        let (kind, digest) = if databases.contains(&rel) {
            database_digest(&path, work)?
        } else {
            let size = std::fs::metadata(&path)?.len();
            ("file", format!("{size}:{}", super::file_sha256(&path)?))
        };
        items.push((rel, kind, digest));
    }
    items.sort();
    let mut h = Sha256::new();
    h.update(b"ATM-DROPPED-PROJECT-2");
    for (rel, kind, digest) in items {
        for part in [rel.as_bytes(), kind.as_bytes(), digest.as_bytes()] {
            h.update(part);
            h.update([0]);
        }
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

pub(super) fn is_database(path: &Path) -> bool {
    use std::io::Read;
    let mut header = [0u8; 16];
    std::fs::File::open(path).is_ok_and(|mut f| f.read_exact(&mut header).is_ok())
        && &header == b"SQLite format 3\0"
}

/// 一个库的内容摘要。库与非空的 `-wal` 复制到 `work` 里打开（WAL 在副本里恢复，不开源文件）：
/// - 读得完、并且是 2.x 的项目库（有 `project_meta` 表）：种类 `sqlite`，取逻辑内容（[`logical_digest`]）。
/// - 打不开、读不完，或证明不了是项目库：种类 `sqlite-raw`，绑定原始字节——库与非空的 `-wal`
///   （`-shm` 只是 WAL 的索引，不算）。这样的库任何变化（包括 checkpoint）都是「变了」：说不清就保守，不漏报。
fn database_digest(path: &Path, work: &Path) -> Result<(&'static str, String)> {
    let copy = work.join("dropped-digest.sqlite");
    let copies = [copy.clone(), sidecar(&copy, "-wal"), sidecar(&copy, "-shm")];
    // 上一个库留下的 -wal 会被当成这个库的 WAL 恢复进去：删不掉就失败，不能忽略。
    let clear = || -> Result<()> {
        for f in &copies {
            match std::fs::remove_file(f) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
                _ => {}
            }
        }
        Ok(())
    };
    clear()?;
    let wal = sidecar(path, "-wal");
    let has_wal = std::fs::metadata(&wal).is_ok_and(|m| m.len() > 0);
    crate::progress::copy_path(path, &copy)?;
    if has_wal {
        crate::progress::copy_path(&wal, &copies[1])?;
    }
    let logical = logical_digest(&copy);
    clear()?;
    if let Ok(digest) = logical {
        return Ok(("sqlite", digest));
    }
    let mut raw = super::file_sha256(path)?;
    if has_wal {
        raw = format!("{raw}+{}", super::file_sha256(&wal)?);
    }
    Ok(("sqlite-raw", raw))
}

/// 一份库的 schema：(类型, 名字, 所属表, 规范化的 SQL)，不含 `sqlite_stat*`（ANALYZE 会建）与 `schema_migrations`
/// （由迁移执行器建，另外核对）。SQL 只把空白合并，其余逐字比较。
fn schema_of(
    c: &Connection,
) -> rusqlite::Result<std::collections::BTreeSet<(String, String, String, String)>> {
    c.prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema
         WHERE substr(name, 1, 11) <> 'sqlite_stat' AND tbl_name <> 'schema_migrations'",
    )?
    .query_map([], |r| {
        let sql: Option<String> = r.get(3)?;
        Ok((
            r.get(0)?,
            r.get(1)?,
            r.get(2)?,
            sql.unwrap_or_default()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" "),
        ))
    })?
    .collect()
}

/// 舍弃项目库的 schema 是不是 2.x 的项目迁移推出来的那一份：
/// - `schema_migrations` 的列与 2.0 迁移执行器建的一样（`version` 是 INTEGER 主键，rowid 就是它）；
/// - 登记的迁移从 1 起连续，名字与转换器嵌入的项目迁移逐个相同；
/// - 在内存库里依次执行这些迁移，得到的 schema 与这个库的逐项相等（多一张表、一列、一个索引都不算）。
fn known_project_schema(c: &Connection) -> rusqlite::Result<bool> {
    let columns: Vec<(String, String, i64)> = c
        .prepare("SELECT name, type, pk FROM pragma_table_info('schema_migrations') ORDER BY cid")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let expected = [
        ("version", "INTEGER", 1),
        ("name", "TEXT", 0),
        ("applied_at", "TEXT", 0),
        ("content_sha256", "TEXT", 0),
        ("hash_origin", "TEXT", 0),
    ];
    if columns.len() != expected.len()
        || columns
            .iter()
            .zip(expected)
            .any(|((n, t, pk), (en, et, epk))| n != en || !t.eq_ignore_ascii_case(et) || *pk != epk)
    {
        return Ok(false);
    }
    let applied: Vec<(i64, String)> = c
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let known: Vec<&super::LegacyMigration> = super::MIGRATIONS
        .iter()
        .filter(|m| m.home == Home::Project)
        .collect();
    if applied.is_empty()
        || applied.len() > known.len()
        || applied
            .iter()
            .zip(&known)
            .any(|((v, n), m)| *v != m.version || n != m.name)
    {
        return Ok(false);
    }
    let reference = Connection::open_in_memory()?;
    for m in &known[..applied.len()] {
        reference.execute_batch(m.sql)?;
    }
    Ok(schema_of(c)? == schema_of(&reference)?)
}

/// 库的逻辑内容：`user_version`、`application_id`；schema（类型、名字、所属表、SQL，不含随存储变的 rootpage）；
/// 每张表与虚表的全部行：有 rowid 的连同 rowid、按 rowid 排序，没有的按全部列排序。
/// 不算 `sqlite_stat*`（ANALYZE、`PRAGMA optimize` 会写）与 FTS 的索引影子表（optimize、merge 会重排；虚表本身的行与
/// `_config` 照算）。只在 `integrity_check` 恰好为 `ok`、索引与行一致时才这样取；否则按字节。
/// checkpoint、关库、SHM 重建、ANALYZE、改日志模式都不动这些；VACUUM 一般也保留 rowid，真改了就算「变了」——
/// 2.x 拿 rowid 裁决同时间的记录，它变了 2.x 看到的顺序就变了。
fn logical_digest(db: &Path) -> rusqlite::Result<String> {
    use rusqlite::types::ValueRef;
    use sha2::{Digest, Sha256};
    let c = Connection::open(db)?;
    crate::progress::watch(&c)?;
    // 只有 2.x 的项目库能这样规范化：除了 rowid（下面照算），它的状态都在表与 FTS 虚表的行里，影子表与统计表不承载业务。
    // 这要整份 schema 都是 2.x 项目迁移推出来的那一份才成立：多一张表、一列、一个虚表模块都证明不了，
    // 按错误返回，调用方改按原始字节绑定（W4 关口第二轮 P1-W4A-02）。
    if !known_project_schema(&c)? {
        return Err(rusqlite::Error::InvalidQuery);
    }
    // 只看表里的行，还要先证明索引与行一致：2.x 的查询走 b-tree 索引与 FTS5 的倒排索引，它们与行对不上时
    // 2.x 看到的结果就不是这些行。`integrity_check` 两样都核对（SQLite 3.44 起含 FTS5 的 xIntegrity），
    // 不是恰好一行 `ok` 就按字节绑定（W4 关口第四轮 P1-W4A-02）。
    let check: Vec<String> = c
        .prepare("PRAGMA integrity_check")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    if check != ["ok"] {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let mut h = Sha256::new();
    h.update(b"ATM-DROPPED-SQLITE-2\0");
    for pragma in ["user_version", "application_id"] {
        let v: i64 = c.query_row(&format!("PRAGMA {pragma}"), [], |r| r.get(0))?;
        h.update(format!("{pragma}={v}\0"));
    }
    let not_stat = "substr(name, 1, 11) <> 'sqlite_stat'";
    let schema: Vec<(String, String, String, Option<String>)> = c
        .prepare(&format!(
            "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE {not_stat} ORDER BY type, name"
        ))?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (kind, name, table, sql) in schema {
        for part in [kind, name, table, sql.unwrap_or_default()] {
            h.update(part.as_bytes());
            h.update([0]);
        }
    }
    // 隐含的 rowid 是业务内容：2.x 的读模型拿它裁决同时间的记录（`search_documents` 的最新投影、
    // `checklist_items` 的顺序、搜索分页的上界），FTS 虚表的 rowid 同理（W4 关口第三轮 P1-W4A-02）。
    // FTS5 的 `_config` 影子表（rank 等设置会改 MATCH 的结果顺序）也算；其余影子表是由行推出的索引，
    // 上面的 integrity_check 已证明它们与行一致（第四轮）。
    let tables: Vec<(String, bool)> = c
        .prepare(&format!(
            "SELECT name, type = 'virtual' OR wr = 0 FROM pragma_table_list WHERE schema = 'main'
             AND (type IN ('table', 'virtual') OR (type = 'shadow' AND substr(name, -7) = '_config'))
             AND (substr(name, 1, 7) <> 'sqlite_' OR name = 'sqlite_sequence') AND {not_stat} ORDER BY name"
        ))?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (table, rowid) in tables {
        let quoted = format!("\"{}\"", table.replace('"', "\"\""));
        let select = if rowid {
            format!("SELECT rowid, * FROM {quoted}")
        } else {
            format!("SELECT * FROM {quoted}")
        };
        let columns = c.prepare(&select)?.column_count();
        let order: Vec<String> = if rowid {
            vec!["1".into()]
        } else {
            (1..=columns).map(|i| i.to_string()).collect()
        };
        let mut st = c.prepare(&format!("{select} ORDER BY {}", order.join(", ")))?;
        h.update(format!(
            "table\0{table}\0{columns}\0{}\0",
            if rowid { "rowid" } else { "" }
        ));
        let mut rows = st.query([])?;
        let mut count = 0u64;
        while let Some(row) = rows.next()? {
            count += 1;
            for i in 0..columns {
                match row.get_ref(i)? {
                    ValueRef::Null => h.update(b"n"),
                    ValueRef::Integer(v) => {
                        h.update(b"i");
                        h.update(v.to_le_bytes());
                    }
                    ValueRef::Real(v) => {
                        h.update(b"r");
                        h.update(v.to_bits().to_le_bytes());
                    }
                    ValueRef::Text(v) => {
                        h.update(b"t");
                        h.update((v.len() as u64).to_le_bytes());
                        h.update(v);
                    }
                    ValueRef::Blob(v) => {
                        h.update(b"b");
                        h.update((v.len() as u64).to_le_bytes());
                        h.update(v);
                    }
                }
            }
        }
        h.update(format!("rows\0{count}\0"));
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::{known_project_schema, logical_digest, tree_digest};
    use rusqlite::Connection;
    use std::path::{Path, PathBuf};

    /// 按转换器嵌入的前 `upto` 个项目迁移建一份 2.x 项目库，登记方式与 2.0 迁移执行器相同。
    fn project_db(path: &Path, upto: usize) -> Connection {
        let c = Connection::open(path).unwrap();
        c.execute_batch(
            "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL,
               content_sha256 TEXT NOT NULL, hash_origin TEXT NOT NULL CHECK(hash_origin IN ('APPLIED','LEGACY_BASELINE_UNVERIFIED')))",
        )
        .unwrap();
        for m in super::super::MIGRATIONS
            .iter()
            .filter(|m| m.home == super::Home::Project)
            .take(upto)
        {
            c.execute_batch(m.sql).unwrap();
            c.execute(
                "INSERT INTO schema_migrations VALUES (?1, ?2, '2026-01-01T00:00:00.000Z', ?3, 'APPLIED')",
                rusqlite::params![m.version, m.name, m.sha256],
            )
            .unwrap();
        }
        c
    }

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::var_os("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("target")
            })
            .join("store-unit")
            .join(name);
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// W4 关口 P1-W4A-02：舍弃项目里用户自己的 SQLite 附件按字节绑定。rowid 在用户的库里可能就是业务键，
    /// 改了它（业务关联随之变化）摘要必须变。项目库按逻辑内容：VACUUM、ANALYZE 不误报，rowid 照算（第三轮）。
    #[test]
    fn a_sqlite_attachment_is_bound_to_its_bytes() {
        let dir = scratch("dropped-sqlite-attachment");
        let (tree, work) = (dir.join("project"), dir.join("work"));
        std::fs::create_dir_all(tree.join("artifacts")).unwrap();
        std::fs::create_dir_all(&work).unwrap();
        let db = tree.join("artifacts/customer.sqlite");
        let c = Connection::open(&db).unwrap();
        c.execute_batch(
            "CREATE TABLE documents(title TEXT); CREATE TABLE links(document_id INTEGER);
             INSERT INTO documents(rowid, title) VALUES (7, 'customer record'); INSERT INTO links VALUES (7);",
        )
        .unwrap();
        let before = tree_digest(&tree, &work).unwrap();
        c.execute_batch("UPDATE documents SET rowid = 9 WHERE rowid = 7;")
            .unwrap();
        drop(c);
        assert_ne!(before, tree_digest(&tree, &work).unwrap());

        // 附件里的库即使就是一份项目库（schema 完全是迁移推出来的，例如用户存的副本）也按字节：
        // 逻辑摘要只给目录下那一个 project.sqlite。ANALYZE 只写 `sqlite_stat*`，逻辑摘要不看，字节看得见。
        let copy = tree.join("artifacts/copy-of-project.sqlite");
        let k = project_db(&copy, usize::MAX);
        k.execute_batch(
            "INSERT INTO settings(rowid, key, value_json, updated_at) VALUES (5, 'a', '{}', 't');",
        )
        .unwrap();
        let before = tree_digest(&tree, &work).unwrap();
        k.execute_batch("ANALYZE;").unwrap();
        drop(k);
        assert_ne!(before, tree_digest(&tree, &work).unwrap());

        // 项目库的位置上、schema 不是项目迁移推出来的库按字节：逻辑摘要只对认得的 schema 成立。
        // 例如一列就叫 `rowid`，`SELECT rowid` 取到的是这一列，隐含的 rowid 被它遮住，按逻辑内容就看不见。
        let fake = tree.join("project.sqlite");
        let f = Connection::open(&fake).unwrap();
        f.execute_batch(
            "CREATE TABLE documents(title TEXT, rowid TEXT);
             INSERT INTO documents(_rowid_, title, rowid) VALUES (9, 'customer record', 'shown');",
        )
        .unwrap();
        let before = tree_digest(&tree, &work).unwrap();
        f.execute_batch("UPDATE documents SET _rowid_ = 11 WHERE _rowid_ = 9;")
            .unwrap();
        drop(f);
        assert_ne!(before, tree_digest(&tree, &work).unwrap());

        // 项目库：VACUUM、ANALYZE 前后摘要不变；表与 FTS 虚表的 rowid 是业务内容，改了就变，改回去又不变。
        std::fs::remove_file(&fake).unwrap();
        let p = project_db(&fake, usize::MAX);
        p.execute_batch(
            "INSERT INTO settings(rowid, key, value_json, updated_at) VALUES (5, 'a', '{}', 't'), (3, 'b', '{}', 't');
             INSERT INTO search_documents_fts(rowid, entity_type, entity_id, entity_key, title, body)
               VALUES (4, 'TASK', 'w', 'X-T-0001', 'title', 'body');",
        )
        .unwrap();
        let before = tree_digest(&tree, &work).unwrap();
        p.execute_batch("VACUUM; ANALYZE;").unwrap();
        assert_eq!(before, tree_digest(&tree, &work).unwrap());
        p.execute_batch("UPDATE settings SET rowid = 8 WHERE rowid = 5;")
            .unwrap();
        assert_ne!(before, tree_digest(&tree, &work).unwrap());
        p.execute_batch("UPDATE settings SET rowid = 5 WHERE rowid = 8;")
            .unwrap();
        assert_eq!(before, tree_digest(&tree, &work).unwrap());
        p.execute_batch("UPDATE search_documents_fts SET rowid = 6 WHERE rowid = 4;")
            .unwrap();
        drop(p);
        assert_ne!(before, tree_digest(&tree, &work).unwrap());
    }

    /// W4 关口第四轮 P1-W4A-02：FTS 的倒排索引与内容对不上（codex 的构造：清空虚表后只放回内容行，MATCH 1 → 0）
    /// 时按字节，摘要变；FTS 的 rank 设置算内容，改了变；optimize、merge 只重排索引，不变。
    #[test]
    fn fts_state_beyond_its_rows_is_bound() {
        let dir = scratch("dropped-fts-state");
        let (tree, work) = (dir.join("project"), dir.join("work"));
        std::fs::create_dir_all(&tree).unwrap();
        std::fs::create_dir_all(&work).unwrap();
        let db = tree.join("project.sqlite");
        let c = project_db(&db, 10);
        c.execute_batch(
            "INSERT INTO search_documents_fts(rowid, entity_type, entity_id, entity_key, title, body)
               VALUES (7, 'TASK', 'w', 'X-T-0001', 'hello world', '');",
        )
        .unwrap();
        let matches = || -> i64 {
            c.query_row(
                "SELECT count(*) FROM search_documents_fts WHERE search_documents_fts MATCH 'hello'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };
        let before = tree_digest(&tree, &work).unwrap();
        c.execute_batch(
            "INSERT INTO search_documents_fts(search_documents_fts) VALUES ('optimize');
             INSERT INTO search_documents_fts(search_documents_fts, rank) VALUES ('merge', 16);",
        )
        .unwrap();
        assert_eq!(
            before,
            tree_digest(&tree, &work).unwrap(),
            "optimize / merge"
        );

        c.execute_batch(
            "INSERT INTO search_documents_fts(search_documents_fts, rank) VALUES ('rank', 'bm25(10.0, 5.0)');",
        )
        .unwrap();
        assert_ne!(before, tree_digest(&tree, &work).unwrap(), "rank setting");
        c.execute_batch("DELETE FROM search_documents_fts_config WHERE k = 'rank';")
            .unwrap();
        assert_eq!(
            before,
            tree_digest(&tree, &work).unwrap(),
            "rank setting removed"
        );

        assert_eq!(matches(), 1);
        c.execute_batch(
            "DELETE FROM search_documents_fts;
             INSERT INTO search_documents_fts_content(id, c0, c1, c2, c3, c4)
               VALUES (7, 'TASK', 'w', 'X-T-0001', 'hello world', '');",
        )
        .unwrap();
        assert_eq!(matches(), 0);
        drop(c);
        assert_ne!(
            before,
            tree_digest(&tree, &work).unwrap(),
            "index out of step with the rows"
        );
    }

    /// W4 关口第三轮 P2-W4A-01：知识库的恢复日志与 sync、dispatch 的 JSON 走同一个读入：有上限，解析途中推进。
    #[test]
    fn the_restore_journal_is_read_within_the_limit() {
        let limit = super::super::jsonfiles::MAX_JSON_BYTES as usize;
        let journal = "{\"id\":\"01ARZ3NDEKTSV4RRFFQ69G5FAV\",\"committed\":false}";
        let write = |name: &str, len: usize| {
            let dir = scratch(name);
            std::fs::create_dir_all(dir.join("knowledge")).unwrap();
            std::fs::write(
                dir.join("knowledge/restore.json"),
                format!("{journal}{}", " ".repeat(len - journal.len())),
            )
            .unwrap();
            dir
        };
        let over = write("journal-over-limit", limit + 1);
        match super::knowledge(&over) {
            Err(e) => assert!(e.to_string().contains("reads JSON files up to"), "{e}"),
            Ok(_) => panic!("a restore journal above the limit was read"),
        }
        let within = write("journal-within-limit", limit);
        let work = std::cell::Cell::new(0u64);
        let report = |_: &str, _: usize, _: usize, w: u64| work.set(w);
        let meter = crate::progress::Meter::new(&report);
        let plan = crate::progress::with(Some(&meter), || super::knowledge(&within)).unwrap();
        assert!(plan.journal.is_some());
        let batches = (limit / crate::progress::PARSE_BYTES) as u64;
        assert!(work.get() >= batches, "{} < {batches}", work.get());
    }

    /// W4 关口第二轮 P1-W4A-02：只有整份 schema 都是 2.x 项目迁移推出来的那一份，才算认得。
    /// 停在旧版本的项目库认得；多一张表、多一列、多一个索引、登记的名字或 `schema_migrations` 的列不对都不认得。
    #[test]
    fn only_the_migrated_project_schema_is_known() {
        let dir = scratch("known-project-schema");
        let known = |name: &str, upto: usize, change: &str| -> bool {
            let path = dir.join(format!("{name}.sqlite"));
            let c = project_db(&path, upto);
            c.execute_batch(change).unwrap();
            known_project_schema(&c).unwrap()
        };
        assert!(known("current", usize::MAX, ""));
        assert!(known("older", 10, ""));
        assert!(known("analyzed", usize::MAX, "ANALYZE;"));
        assert!(!known(
            "extra-table",
            usize::MAX,
            "CREATE TABLE documents(title TEXT);"
        ));
        assert!(!known(
            "extra-table-old",
            10,
            "CREATE TABLE documents(title TEXT);"
        ));
        assert!(!known(
            "extra-column",
            usize::MAX,
            "ALTER TABLE settings ADD COLUMN note TEXT;"
        ));
        assert!(!known(
            "extra-index",
            usize::MAX,
            "CREATE INDEX x ON settings(updated_at);"
        ));
        assert!(!known(
            "extra-view",
            usize::MAX,
            "CREATE VIEW v AS SELECT 1;"
        ));
        assert!(!known(
            "dropped-trigger-or-index",
            usize::MAX,
            "DROP INDEX IF EXISTS idx_work_items_status; DROP TABLE IF EXISTS labels;"
        ));
        assert!(!known(
            "renamed",
            usize::MAX,
            "UPDATE schema_migrations SET name = 'other.sql' WHERE version = 3;"
        ));
        assert!(!known(
            "gap",
            usize::MAX,
            "DELETE FROM schema_migrations WHERE version = 3;"
        ));
        assert!(!known(
            "claims-more",
            10,
            "INSERT INTO schema_migrations VALUES (11, '0011_x.sql', 't', 'h', 'APPLIED');"
        ));
        assert!(!known("empty", 0, ""));
        // 登记一样、schema 一样，只是 `version` 不是主键（rowid 不再是它）：不是 2.0 执行器建的，不认。
        assert!(!known(
            "other-runner",
            usize::MAX,
            "CREATE TABLE sm AS SELECT * FROM schema_migrations; DROP TABLE schema_migrations;
             CREATE TABLE schema_migrations (version INTEGER NOT NULL, name TEXT NOT NULL, applied_at TEXT NOT NULL,
               content_sha256 TEXT NOT NULL, hash_origin TEXT NOT NULL);
             INSERT INTO schema_migrations SELECT * FROM sm; DROP TABLE sm;",
        ));
    }

    /// W4 关口 P2-W4A-01：大项目库的逻辑扫描在计量里推进工作量（SQLite 指令计量），不是一声不响地跑完。
    #[test]
    fn the_logical_scan_reports_its_work() {
        let dir = scratch("dropped-digest-work");
        let db = dir.join("project.sqlite");
        let c = project_db(&db, usize::MAX);
        c.execute_batch(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300000)
             INSERT INTO settings SELECT printf('%010d', 300001 - i), '{}', i, 't' FROM n;",
        )
        .unwrap();
        drop(c);
        let work = std::cell::Cell::new(0u64);
        let report = |_: &str, _: usize, _: usize, w: u64| work.set(w);
        let meter = crate::progress::Meter::new(&report);
        let digest = crate::progress::with(Some(&meter), || logical_digest(&db)).unwrap();
        assert_eq!(digest.len(), 64);
        assert!(work.get() > 0, "the scan moved no work");
    }

    /// W4 关口 P2-W4A-01：数据根的枚举每列一个条目推进一次。
    #[test]
    fn the_enumeration_reports_its_work() {
        let dir = scratch("walk-work");
        for i in 0..100 {
            std::fs::write(dir.join(format!("f{i}")), b"x").unwrap();
        }
        let work = std::cell::Cell::new(0u64);
        let report = |_: &str, _: usize, _: usize, w: u64| work.set(w);
        let meter = crate::progress::Meter::new(&report);
        let files = crate::progress::with(Some(&meter), || super::super::root::walk(&dir)).unwrap();
        assert_eq!(files.len(), 100);
        assert!(work.get() >= 100, "{}", work.get());
    }
}
