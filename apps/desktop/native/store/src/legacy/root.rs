//! 按数据根输入（W3b4；05 §1.1、§3.1、§3.3、§3.4、§5.2）。
//!
//! - 数据根的每个顶层条目必须命中族表的某一行，否则停（05 §5.1「未登记的文件 → UNKNOWN」）；
//!   `trash\` 非空也停。R / X 类只登记文件数与字节数，不复制、不读内容。
//! - 进行中的文件事务残留（`.creating-*`、`.restore-*`、`restore.json` 等）由 W3b6 落定，在那之前拒绝。
//! - 附件目录逐文件复制到目标旁的 `artifacts\<pid>\`，(相对路径, size, sha256) 集合两边相等；
//!   `artifacts.local_path` 指向本项目附件目录里的文件时改写成新根的相对路径，原值留在 `legacy_local_path`。
//! - 不在备份目录表里的 2.0 备份文件（升级前备份、知识恢复前的现库、知识恢复的孤儿件）登记进 `legacy_backups`，
//!   不复制；所有登记的备份核对存在性与 sha256，缺失或不符只记信息项（X 类）。
//! - `manifest.json` 的 project_id、project_code、schema_version 必须与 registry 一致；名字不同只记信息项
//!   （2.0 只在建项目时写 manifest，改名不回写）。

use super::{
    ConvertError, FamilyCheck, LegacySources, Report, Result, SourceDigest, file_sha256,
    json_string,
};
use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// 数据根 → 三类源库的路径。项目库按 `projects\<id>\project.sqlite` 枚举（目录名就是项目 id，按名字排序），
/// 以 `.` 开头或以 `.creating` 结尾的是进行中的事务，不算项目。
pub fn sources_from_root(root: &Path) -> Result<LegacySources> {
    let registry = root.join("registry").join("registry.sqlite");
    if !registry.is_file() {
        return Err(ConvertError::Unsupported(format!(
            "{}: no registry/registry.sqlite",
            root.display()
        )));
    }
    let knowledge = root.join("knowledge").join("knowledge.sqlite");
    let mut projects = Vec::new();
    if let Ok(dir) = std::fs::read_dir(root.join("projects")) {
        let mut names: Vec<String> = dir
            .flatten()
            .filter(|e| e.path().join("project.sqlite").is_file())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| !n.starts_with('.') && !n.ends_with(".creating"))
            .collect();
        names.sort();
        projects = names
            .into_iter()
            .map(|n| root.join("projects").join(n).join("project.sqlite"))
            .collect();
    }
    Ok(LegacySources {
        registry,
        knowledge: knowledge.is_file().then_some(knowledge),
        projects,
        root: Some(root.to_path_buf()),
    })
}

/// 目录下的全部文件（不跟随链接）：(以 `/` 分隔的相对路径, 大小)，按相对路径排序。链接本身算一个条目。
fn walk(dir: &Path) -> Result<Vec<(String, PathBuf, u64)>> {
    let mut out = Vec::new();
    let mut stack = vec![(dir.to_path_buf(), String::new())];
    while let Some((d, prefix)) = stack.pop() {
        let entries = match std::fs::read_dir(&d) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        };
        for e in entries {
            let e = e?;
            let name = e.file_name().to_string_lossy().into_owned();
            let rel = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            let meta = std::fs::symlink_metadata(e.path())?;
            if meta.is_dir() {
                stack.push((e.path(), rel));
            } else {
                out.push((rel, e.path(), meta.len()));
            }
        }
    }
    out.sort();
    Ok(out)
}

/// 族名 → 顶层条目的判定。返回 None 表示未登记。
fn top_level_family(name: &str) -> Option<&'static str> {
    Some(match name {
        "registry" | "knowledge" | "projects" | "sync" | "dispatch" => "",
        "backups" => "backups",
        "exports" => "exports",
        "runtime" => "runtime",
        "logs" => "logs",
        "ATM_AGENT_GUIDE.md" | "docs" | "skills" | "mcp-stdio.cjs" => "install-copies",
        "current" | "updates" => "setup",
        "webview" => "webview",
        "trash" => "trash",
        n if n.contains(".staging-") || n.contains(".backup-") => "install-copies",
        _ => return None,
    })
}

fn is_db_file(name: &str, db: &str) -> bool {
    name == db || name == format!("{db}-wal") || name == format!("{db}-shm")
}

/// 数据根枚举：未登记的条目、非空的 trash、进行中的事务残留都在动目标之前停下；
/// R / X 类按族记文件数与字节数（`Report::sources`，范围 `root`）。sync / dispatch 的内容归 W3b5。
pub(super) fn scan(root: &Path, report: &mut Report) -> Result<()> {
    let shown = root.display();
    let mut counts: std::collections::BTreeMap<&'static str, (i64, u64)> = Default::default();
    let mut add = |family: &'static str, files: &[(String, PathBuf, u64)]| {
        let c = counts.entry(family).or_default();
        c.0 += files.len() as i64;
        c.1 += files.iter().map(|f| f.2).sum::<u64>();
    };
    let mut names: Vec<String> = std::fs::read_dir(root)?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    for name in &names {
        let path = root.join(name);
        let Some(family) = top_level_family(name) else {
            return Err(ConvertError::Unsupported(format!(
                "{shown}: unregistered entry in the data root: {name}"
            )));
        };
        let files = if path.is_dir() {
            walk(&path)?
        } else {
            vec![(
                name.clone(),
                path.clone(),
                std::fs::symlink_metadata(&path)?.len(),
            )]
        };
        match name.as_str() {
            "trash" if !files.is_empty() => {
                return Err(ConvertError::Unsupported(format!(
                    "{shown}: trash is not empty ({} files); 2.0 never writes there",
                    files.len()
                )));
            }
            "registry" => {
                if let Some(f) = files.iter().find(|f| !is_db_file(&f.0, "registry.sqlite")) {
                    return Err(ConvertError::Unsupported(format!(
                        "{shown}: unregistered entry registry/{}",
                        f.0
                    )));
                }
            }
            "knowledge" => {
                if let Some(f) = files.iter().find(|f| !is_db_file(&f.0, "knowledge.sqlite")) {
                    return Err(ConvertError::Unsupported(format!(
                        "{shown}: knowledge/{} is an in-flight restore or unregistered; settled by W3b6",
                        f.0
                    )));
                }
            }
            "projects" => scan_projects(root, &files)?,
            "sync" => {
                for f in &files {
                    match f.0.as_str() {
                        "config.json" | "secrets.dpapi.json" => {}
                        "config.corrupt.json" => add("diagnostic-copies", std::slice::from_ref(f)),
                        "secrets.json" => add("sync.plain-secrets", std::slice::from_ref(f)),
                        n if n.ends_with(".tmp") => {
                            add("diagnostic-copies", std::slice::from_ref(f))
                        }
                        n => {
                            return Err(ConvertError::Unsupported(format!(
                                "{shown}: unregistered entry sync/{n}"
                            )));
                        }
                    }
                }
            }
            "dispatch" => {
                for f in &files {
                    match f.0.as_str() {
                        "config.json" | "runs.json" | "requests.json" => {}
                        n if n.starts_with("logs/") => {}
                        "requests.corrupt.json" => {
                            add("diagnostic-copies", std::slice::from_ref(f))
                        }
                        n if n.ends_with(".tmp") => {
                            add("diagnostic-copies", std::slice::from_ref(f))
                        }
                        n => {
                            return Err(ConvertError::Unsupported(format!(
                                "{shown}: unregistered entry dispatch/{n}"
                            )));
                        }
                    }
                }
            }
            _ => {}
        }
        if !family.is_empty() {
            add(family, &files);
        }
    }
    // 项目目录里的备份也是 X7。
    for p in project_dirs(root)? {
        add("backups", &walk(&p.join("backups"))?);
    }
    for f in super::FAMILIES
        .iter()
        .filter(|f| f.home == super::Home::Root && f.pending.is_none())
    {
        let (files, bytes) = counts.get(f.name).copied().unwrap_or_default();
        report.sources.push(SourceDigest {
            spec: f.name,
            scope: "root".into(),
            rows: files,
            // R / X 类只登记数量，不读内容。
            digest: String::new(),
            bytes: Some(bytes as i64),
        });
    }
    Ok(())
}

fn project_dirs(root: &Path) -> Result<Vec<PathBuf>> {
    let mut out: Vec<PathBuf> = match std::fs::read_dir(root.join("projects")) {
        Ok(d) => d
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e.into()),
    };
    out.sort();
    Ok(out)
}

/// `projects\` 下：每个项目目录只能有项目库（含 -wal/-shm）、manifest、artifacts、backups。
fn scan_projects(root: &Path, files: &[(String, PathBuf, u64)]) -> Result<()> {
    for f in files {
        let mut parts = f.0.splitn(3, '/');
        let (dir, rest) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        let in_flight =
            dir.starts_with('.') || dir.ends_with(".creating") || rest.contains(".restore-old-");
        if in_flight {
            return Err(ConvertError::Unsupported(format!(
                "{}: projects/{} is an in-flight file transaction; settled by W3b6",
                root.display(),
                f.0
            )));
        }
        let known = is_db_file(rest, "project.sqlite")
            || rest == "manifest.json"
            || ((rest == "artifacts" || rest == "backups") && f.0.matches('/').count() >= 2);
        if !known {
            return Err(ConvertError::Unsupported(format!(
                "{}: unregistered entry projects/{}",
                root.display(),
                f.0
            )));
        }
    }
    Ok(())
}

/// 新根下附件的相对路径前缀：`data/artifacts/<pid>/`（目标库在 `N\data\atm.sqlite`，附件在 `N\data\artifacts\`）。
fn artifact_prefix(pid: &str) -> String {
    format!("data/artifacts/{pid}/")
}

/// `p` 在 `dir` 下面时返回以 `/` 分隔的相对路径（按 Windows 规则不分大小写，两种分隔符都认）。
fn relative_under(p: &str, dir: &Path) -> Option<String> {
    let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_string();
    let (p, d) = (norm(p), norm(&dir.to_string_lossy()));
    if p.len() > d.len() + 1
        && p[..d.len()].eq_ignore_ascii_case(&d)
        && p.as_bytes()[d.len()] == b'/'
    {
        Some(p[d.len() + 1..].to_string())
    } else {
        None
    }
}

/// 转换阶段：复制附件、改写 `local_path`、登记目录表之外的备份文件。在目标库已提交之后做。
pub(super) fn convert_files(
    t: &mut Connection,
    root: &Path,
    out: &Path,
    report: &mut Report,
) -> Result<()> {
    let pids: Vec<String> = t
        .prepare("SELECT id FROM projects ORDER BY id")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let tx = t.transaction()?;
    for pid in &pids {
        let src = root.join("projects").join(pid).join("artifacts");
        let dst = out.join("artifacts").join(pid);
        for (rel, path, _) in walk(&src)? {
            let to = dst.join(&rel);
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(&path, &to)?;
        }
        let rows: Vec<(String, Option<String>)> = tx
            .prepare(
                "SELECT id, legacy_local_path FROM artifacts WHERE project_id = ?1 ORDER BY id",
            )?
            .query_map([pid], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (id, legacy) in rows {
            let Some(legacy) = legacy else { continue };
            match relative_under(&legacy, &src) {
                Some(rel) => {
                    tx.execute(
                        "UPDATE artifacts SET local_path = ?3 WHERE project_id = ?1 AND id = ?2",
                        params![pid, id, format!("{}{rel}", artifact_prefix(pid))],
                    )?;
                    if !src.join(&rel).is_file() {
                        report
                            .notes
                            .push(format!("{pid}/artifacts: {id} points to a missing source file"));
                    }
                }
                None => report.notes.push(format!(
                    "{pid}/artifacts: {id} points outside the project's artifacts directory; local_path kept"
                )),
            }
        }
    }
    for (source, scope, pid, dir) in backup_dirs(root)? {
        for (rel, path, size) in walk(&dir)? {
            if rel.contains('/') {
                continue;
            }
            let kind = backup_kind(&rel, source);
            let Some((kind, version)) = kind else {
                continue;
            };
            tx.execute(
                "INSERT INTO legacy_backups (id, source, scope, project_id, legacy_path, sha256, size_bytes, reason,
                                             schema_version, created_at, verified_at, importable)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, NULL, NULL, ?9)",
                params![
                    format!("{kind}:{}", path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/")),
                    kind,
                    scope,
                    pid,
                    path.to_string_lossy(),
                    file_sha256(&path)?,
                    size as i64,
                    version,
                    match scope {
                        "PROJECT" => "AS_PROJECT",
                        "KNOWLEDGE" => "AS_KNOWLEDGE",
                        _ => "NO",
                    }
                ],
            )
            .map_err(|error| ConvertError::Constraint {
                table: "legacy_backups".into(),
                error,
            })?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// 一个备份目录：(来源目录的种类, scope, project_id, 目录)。
type BackupDir = (&'static str, &'static str, Option<String>, PathBuf);

fn backup_dirs(root: &Path) -> Result<Vec<BackupDir>> {
    let mut out = vec![
        (
            "registry",
            "REGISTRY",
            None,
            root.join("backups").join("registry"),
        ),
        (
            "knowledge",
            "KNOWLEDGE",
            None,
            root.join("backups").join("knowledge"),
        ),
    ];
    for p in project_dirs(root)? {
        let pid = p
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        out.push(("project", "PROJECT", Some(pid), p.join("backups")));
    }
    Ok(out)
}

fn is_ulid(s: &str) -> bool {
    s.len() == 26
        && s.bytes()
            .all(|b| b"0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(&b))
}

/// 目录表之外、2.0 自己留下的备份文件：
/// - `pre-migration-v<n>-<stamp>.sqlite`（`migration-runner.ts:146-155`，三类目录都有）；
/// - `before-restore-<ULID>.sqlite`、`orphan-<ULID>-restore-<ULID>.sqlite`（`knowledge-restore.ts:20-75`）。
fn backup_kind(name: &str, dir: &str) -> Option<(&'static str, Option<i64>)> {
    let stem = name.strip_suffix(".sqlite")?;
    if let Some(rest) = stem.strip_prefix("pre-migration-v") {
        let version = rest.split('-').next()?.parse::<i64>().ok()?;
        return Some(("PRE_MIGRATION_FILE", Some(version)));
    }
    if dir == "knowledge" {
        if stem.strip_prefix("before-restore-").is_some_and(is_ulid) {
            return Some(("KNOWLEDGE_BEFORE_RESTORE", None));
        }
        if let Some(rest) = stem.strip_prefix("orphan-")
            && let Some((a, b)) = rest.split_once("-restore-")
            && is_ulid(a)
            && is_ulid(b)
        {
            return Some(("KNOWLEDGE_ORPHAN", None));
        }
    }
    None
}

fn set_digest(files: &[(String, u64, String)]) -> String {
    let mut h = Sha256::new();
    h.update(b"ATM-FILESET-1");
    for (rel, size, sha) in files {
        h.update(rel.as_bytes());
        h.update([0]);
        h.update(size.to_string().as_bytes());
        h.update([0]);
        h.update(sha.as_bytes());
        h.update([0]);
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn hashed(dir: &Path) -> Result<Vec<(String, u64, String)>> {
    walk(dir)?
        .into_iter()
        .map(|(rel, path, size)| Ok((rel, size, file_sha256(&path)?)))
        .collect()
}

/// VERIFY 的文件部分：附件集合（P11）、manifest（P10）、附件行指向的文件、登记的备份文件（X7）。
pub(super) fn verify_files(
    c: &Connection,
    root: &Path,
    out: &Path,
    report: &mut Report,
) -> Result<()> {
    for pid in report.projects.clone() {
        // P11：(相对路径, size, sha256) 集合两边相等。
        let source = hashed(&root.join("projects").join(&pid).join("artifacts"))?;
        let target = hashed(&out.join("artifacts").join(&pid))?;
        report.sources.push(SourceDigest {
            spec: "artifacts.files",
            scope: pid.clone(),
            rows: source.len() as i64,
            digest: set_digest(&source),
            bytes: Some(source.iter().map(|f| f.1 as i64).sum()),
        });
        let label = format!("{pid}/artifacts.files");
        let mut errors = 0i64;
        let mut first = None;
        for f in source
            .iter()
            .filter(|f| !target.contains(f))
            .chain(target.iter().filter(|f| !source.contains(f)))
        {
            errors += 1;
            first.get_or_insert_with(|| format!("{label}({})", json_string(&f.0)));
        }
        report.checks.push(FamilyCheck {
            family: label,
            spec: "artifacts.files",
            scope: pid.clone(),
            source_rows: source.len() as i64,
            target_rows: target.len() as i64,
            source_digest: set_digest(&source),
            target_digest: set_digest(&target),
            errors,
            first_failure_locator: first,
        });

        // P10：manifest 的身份字段与 registry 一致。
        let manifest_path = root.join("projects").join(&pid).join("manifest.json");
        let manifest = std::fs::read_to_string(&manifest_path).ok();
        report.sources.push(SourceDigest {
            spec: "manifest.json",
            scope: pid.clone(),
            rows: i64::from(manifest.is_some()),
            digest: if manifest.is_some() {
                file_sha256(&manifest_path)?
            } else {
                String::new()
            },
            bytes: manifest.as_ref().map(|m| m.len() as i64),
        });
        let cols = ["project_id", "project_code", "schema_version"].map(String::from);
        super::compare(
            c,
            report,
            super::Ck {
                spec: "manifest.json",
                label: &format!("{pid}/manifest.json"),
                key: &[],
            },
            &cols,
            "SELECT ?1 ->> '$.project_id', ?1 ->> '$.project_code', ?1 ->> '$.schema_version'
             WHERE json_valid(?1)",
            &[&manifest],
            "SELECT id, code, 1 FROM main.projects WHERE id = ?1",
            &[&pid],
        )?;
        let renamed: Option<String> = c
            .query_row(
                "SELECT p.id FROM main.projects p WHERE p.id = ?1 AND json_valid(?2) AND (?2 ->> '$.name') IS NOT p.name",
                params![pid, manifest],
                |r| r.get(0),
            )
            .ok();
        if renamed.is_some() {
            report.notes.push(format!(
                "{pid}/manifest.json: name differs from the registry (2.0 does not rewrite it on rename)"
            ));
        }

        // 附件行指向的新文件必须在（源缺失的那些只是信息项，转换时已记）；
        // 行里有 size / sha256 时与文件一致（不一致只记信息项）。
        let prefix = artifact_prefix(&pid);
        let rows: Vec<(String, String, Option<String>, Option<i64>)> = c
            .prepare(
                "SELECT id, local_path, sha256, size_bytes FROM main.artifacts
                 WHERE project_id = ?1 AND substr(local_path, 1, length(?2)) = ?2 ORDER BY id",
            )?
            .query_map(params![pid, prefix], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?
            .collect::<rusqlite::Result<_>>()?;
        let source_dir = root.join("projects").join(&pid).join("artifacts");
        for (id, local, sha, size) in rows {
            let rel = &local[prefix.len()..];
            if !source_dir.join(rel).is_file() {
                continue;
            }
            let file = out.join("artifacts").join(&pid).join(rel);
            match std::fs::metadata(&file) {
                Err(_) => report.graph_violations.push(format!(
                    "{pid}/artifacts: {id} points to a file missing from the target"
                )),
                Ok(m) => {
                    let actual = file_sha256(&file)?;
                    if size.is_some_and(|s| s != m.len() as i64)
                        || sha.as_ref().is_some_and(|s| *s != actual)
                    {
                        report.notes.push(format!(
                            "{pid}/artifacts: {id} size or sha256 differs from its row"
                        ));
                    }
                }
            }
        }
    }

    // X7：登记的备份文件存在、sha256 与登记一致；不符只记信息项（备份是 X 类资产）。
    let backups: Vec<(String, String, Option<String>)> = c
        .prepare("SELECT id, legacy_path, sha256 FROM main.legacy_backups ORDER BY id")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let (mut missing, mut differs) = (Vec::new(), Vec::new());
    for (id, path, sha) in backups {
        let p = Path::new(&path);
        if !p.is_file() {
            missing.push(id);
        } else if let Some(sha) = sha
            && file_sha256(p)? != sha
        {
            differs.push(id);
        }
    }
    for (what, ids) in [("missing", missing), ("sha256 differs", differs)] {
        if let Some(first) = ids.first() {
            report.notes.push(format!(
                "r/legacy_backups: {} {what}, first {first}",
                ids.len()
            ));
        }
    }
    Ok(())
}
