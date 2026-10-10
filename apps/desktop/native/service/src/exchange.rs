//! 项目数据交换的服务入口（06 #27、00 C-07 v6、方案 §4、r2 A4）：导出、可导入来源的列表、导入预览与导入。
//!
//! 机制都在存储层（[`atm_store::package`]）；这里加主体与能力检查、来源的解析与错误码。
//!
//! - 导出（`export.create`）只有 User：在 `N\exports` 写文件，不建备份、不修剪（C-07 v6）。
//! - 来源列表与预览（`import.preview`）A+U，只读，不写任何文件：来源只能是 `N\exports` 与 2.x 根的 `exports\`
//!   里的 `.aytproj`（按文件名点名，不收任意路径），或 2.x 备份登记（`legacy_backups`）里可导入的那几份。
//! - 导入（`import.apply`）只有 User：项目包与 2.x 项目备份成为新项目，2.x 知识库备份合并进知识库。

use crate::write::{Service, internal};
use atm_domain::capability::{self, Capability};
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::keys;
use atm_domain::principal::Principal;
use atm_domain::time::Timestamp;
use atm_store::package::{self, ExportOptions, Format, ImportOptions, ImportSource, PackageError};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const LIST_MAX: usize = 200;

/// 数据交换用到的位置与产品版本（常驻进程给；测试给临时目录）。
#[derive(Clone, Debug)]
pub struct ExchangeConfig {
    /// `N\exports`：导出写在这里，也是可导入的来源之一。
    pub exports: PathBuf,
    /// 2.x 根的 `exports\`（2.0 导出的 `.aytproj` v1 在这里）：只读。
    pub legacy_exports: Option<PathBuf>,
    /// 写进 manifest 的产品版本。
    pub app_version: String,
}

/// 一个可导入的来源。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImportFrom {
    /// `origin` 是 `EXPORTS`（`N\exports`）或 `LEGACY_EXPORTS`（2.x 根的 `exports\`），`name` 是其中的文件名。
    Package { origin: String, name: String },
    /// 2.x 备份登记的 id。
    LegacyBackup { id: String },
}

impl ImportFrom {
    /// `{kind: "PACKAGE", origin, name}` 或 `{kind: "LEGACY_BACKUP", id}`。
    pub fn from_json(v: &Value) -> Result<ImportFrom, DomainError> {
        let field = |k: &str| {
            v.get(k)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
        };
        let bad =
            |m: &str| DomainError::new(ErrorCode::INVALID_ARGUMENT, m).detail("field", "source");
        match field("kind") {
            Some("PACKAGE") => Ok(ImportFrom::Package {
                origin: field("origin")
                    .ok_or_else(|| bad("source.origin 不能为空"))?
                    .to_owned(),
                name: field("name")
                    .ok_or_else(|| bad("source.name 不能为空"))?
                    .to_owned(),
            }),
            Some("LEGACY_BACKUP") => Ok(ImportFrom::LegacyBackup {
                id: field("id")
                    .ok_or_else(|| bad("source.id 不能为空"))?
                    .to_owned(),
            }),
            _ => Err(bad("source.kind 必须是 PACKAGE 或 LEGACY_BACKUP")),
        }
    }

    fn view(&self) -> Value {
        match self {
            ImportFrom::Package { origin, name } => {
                json!({"kind": "PACKAGE", "origin": origin, "name": name})
            }
            ImportFrom::LegacyBackup { id } => json!({"kind": "LEGACY_BACKUP", "id": id}),
        }
    }
}

/// 解析出来的来源：包文件，或 2.x 备份（项目库 / 知识库）的文件。
enum Resolved {
    Package(PathBuf),
    LegacyProject(PathBuf),
    LegacyKnowledge(PathBuf),
}

fn now() -> Timestamp {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    Timestamp::from_millis(i64::try_from(ms).unwrap_or(i64::MAX))
}

pub(crate) fn package_error(e: PackageError) -> DomainError {
    match e {
        PackageError::NotFound(m) => DomainError::new(
            ErrorCode::NOT_FOUND,
            format!("找不到要导入或导出的内容：{m}"),
        ),
        PackageError::Invalid(m) => DomainError::new(
            ErrorCode::BACKUP_INTEGRITY_FAILED,
            format!("项目包校验失败，没有导入任何内容：{m}"),
        ),
        PackageError::SchemaMismatch(m) => DomainError::new(
            ErrorCode::BACKUP_MANIFEST_MISMATCH,
            format!("项目包来自数据结构不同的版本，不能直接导入：{m}"),
        )
        .detail("reason", "SCHEMA"),
        PackageError::CodeTaken { code, suggested } => DomainError::new(
            ErrorCode::PROJECT_CODE_CONFLICT,
            format!("项目代码 {code} 已被占用：换一个代码再导入（例如 {suggested}）"),
        )
        .detail("code", code.as_str())
        .detail("suggestedCode", suggested.as_str()),
        PackageError::Legacy(e) => DomainError::new(
            ErrorCode::BACKUP_INTEGRITY_FAILED,
            format!("2.x 数据转换失败，没有导入任何内容：{e}"),
        )
        .detail("reason", "LEGACY_CONVERSION"),
        PackageError::Write(m) if m.contains("Busy") => {
            DomainError::new(ErrorCode::STORE_BUSY, "存储繁忙，稍后重试").detail("committed", false)
        }
        PackageError::Backup(e) => crate::backups::backup_error(e),
        other => internal(other.to_string()),
    }
}

fn file_name_ok(name: &str) -> bool {
    !name.starts_with('.')
        && !name.contains(['/', '\\', ':'])
        && name.len() <= 200
        && name.to_ascii_lowercase().ends_with(".aytproj")
}

impl Service {
    /// 数据交换的位置（见 [`ExchangeConfig`]）。没给时导出与导入报内部错误。
    pub fn with_exchange(mut self, config: ExchangeConfig) -> Self {
        self.exchange = Some(config);
        self
    }

    fn exchange(&self) -> Result<&ExchangeConfig, DomainError> {
        self.exchange
            .as_ref()
            .ok_or_else(|| internal("没有配置导出目录"))
    }

    /// 导出一个项目（`export.create`，只有 User）。`format` 是 `aytproj`、`json` 或 `csv`。
    pub fn export_project(
        &self,
        principal: &Principal,
        project: &str,
        format: &str,
    ) -> Result<Value, DomainError> {
        capability::require(principal, Capability::ExportCreate)?;
        let format = Format::parse(format).ok_or_else(|| {
            DomainError::new(
                ErrorCode::INVALID_ARGUMENT,
                "format 必须是 aytproj、json 或 csv",
            )
            .detail("field", "format")
        })?;
        let id = self.project_scope(project)?;
        let x = self.exchange()?;
        let at = now().to_string();
        let out = package::export_project(
            self.store(),
            &id,
            format,
            &ExportOptions {
                exports_dir: &x.exports,
                at: &at,
                app_version: &x.app_version,
            },
        )
        .map_err(package_error)?;
        Ok(json!({
            "format": out.format.as_str(),
            "projectCode": out.project_code,
            "path": out.path.to_string_lossy(),
            "sha256": out.sha256,
            "sizeBytes": out.size_bytes,
            "createdAt": out.created_at,
            "attachments": out.attachments,
        }))
    }

    /// 可导入的来源（`import.preview`）：两处 exports 里的 `.aytproj`（新的在前），与可导入的 2.x 备份。
    pub fn import_sources(&self, principal: &Principal) -> Result<Value, DomainError> {
        capability::require(principal, Capability::ImportPreview)?;
        let x = self.exchange()?;
        let mut packages = Vec::new();
        for (origin, dir) in [
            ("EXPORTS", Some(&x.exports)),
            ("LEGACY_EXPORTS", x.legacy_exports.as_ref()),
        ] {
            let Some(dir) = dir else { continue };
            let Ok(it) = std::fs::read_dir(dir) else {
                continue;
            };
            for e in it.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                let Ok(meta) = e.metadata() else { continue };
                if !meta.is_file() || !file_name_ok(&name) {
                    continue;
                }
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| {
                        Timestamp::from_millis(i64::try_from(d.as_millis()).unwrap_or(0))
                            .to_string()
                    });
                packages.push(json!({
                    "source": {"kind": "PACKAGE", "origin": origin, "name": name},
                    "name": name,
                    "origin": origin,
                    "sizeBytes": meta.len(),
                    "modifiedAt": modified,
                }));
            }
        }
        packages.sort_by(|a, b| {
            b["modifiedAt"]
                .as_str()
                .cmp(&a["modifiedAt"].as_str())
                .then_with(|| a["name"].as_str().cmp(&b["name"].as_str()))
        });
        packages.truncate(LIST_MAX);
        let legacy: Vec<Value> = self
            .store()
            .read(|tx| {
                tx.prepare(
                    "SELECT l.id, l.scope, l.importable, p.code, l.reason, l.created_at, l.size_bytes
                     FROM legacy_backups l LEFT JOIN projects p ON p.id = l.project_id
                     WHERE l.importable <> 'NO' ORDER BY l.created_at DESC, l.id DESC LIMIT ?1",
                )?
                .query_map([LIST_MAX as i64], |r| {
                    let id: String = r.get(0)?;
                    Ok(json!({
                        "source": {"kind": "LEGACY_BACKUP", "id": id},
                        "id": id,
                        "scope": r.get::<_, String>(1)?,
                        "importable": r.get::<_, String>(2)?,
                        "project": r.get::<_, Option<String>>(3)?,
                        "reason": r.get::<_, Option<String>>(4)?,
                        "createdAt": r.get::<_, Option<String>>(5)?,
                        "sizeBytes": r.get::<_, Option<i64>>(6)?,
                    }))
                })?
                .collect::<rusqlite::Result<_>>()
            })
            .map_err(|e| internal(format!("{e:?}")))?;
        Ok(json!({ "packages": packages, "legacyBackups": legacy }))
    }

    fn resolve_import(&self, from: &ImportFrom) -> Result<Resolved, DomainError> {
        match from {
            ImportFrom::Package { origin, name } => {
                let x = self.exchange()?;
                let dir = match origin.as_str() {
                    "EXPORTS" => Some(&x.exports),
                    "LEGACY_EXPORTS" => x.legacy_exports.as_ref(),
                    _ => {
                        return Err(DomainError::new(
                            ErrorCode::INVALID_ARGUMENT,
                            "source.origin 必须是 EXPORTS 或 LEGACY_EXPORTS",
                        )
                        .detail("field", "source"));
                    }
                };
                if !file_name_ok(name) {
                    return Err(DomainError::new(
                        ErrorCode::INVALID_ARGUMENT,
                        "source.name 必须是导出目录里的一个 .aytproj 文件名",
                    )
                    .detail("field", "source"));
                }
                let dir = dir.ok_or_else(|| {
                    DomainError::new(ErrorCode::NOT_FOUND, "这台电脑上没有 2.x 的导出目录")
                })?;
                let path = dir.join(name);
                if !path.is_file() {
                    return Err(DomainError::new(
                        ErrorCode::NOT_FOUND,
                        format!("导出目录里没有 {name}"),
                    ));
                }
                Ok(Resolved::Package(path))
            }
            ImportFrom::LegacyBackup { id } => {
                let key = id.clone();
                let row: Option<(String, String, String, Option<String>)> = self
                    .store()
                    .read(move |tx| {
                        tx.query_row(
                            "SELECT scope, importable, legacy_path, sha256 FROM legacy_backups WHERE id = ?1",
                            [key],
                            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                        )
                        .optional()
                    })
                    .map_err(|e| internal(format!("{e:?}")))?;
                let Some((scope, importable, path, sha)) = row else {
                    return Err(DomainError::new(
                        ErrorCode::BACKUP_NOT_FOUND,
                        format!("没有 2.x 备份 {id}"),
                    ));
                };
                let path = PathBuf::from(path);
                if !path.is_file() {
                    return Err(DomainError::new(
                        ErrorCode::BACKUP_NOT_FOUND,
                        format!("2.x 备份的文件不在了：{}", path.display()),
                    ));
                }
                if let Some(expected) = sha {
                    let actual = sha256_file(&path).map_err(|e| internal(e.to_string()))?;
                    if !actual.eq_ignore_ascii_case(&expected) {
                        return Err(DomainError::new(
                            ErrorCode::BACKUP_INTEGRITY_FAILED,
                            "2.x 备份的文件在登记之后变了，没有导入任何内容",
                        ));
                    }
                }
                match (scope.as_str(), importable.as_str()) {
                    ("PROJECT", "AS_PROJECT") => Ok(Resolved::LegacyProject(path)),
                    ("KNOWLEDGE", "AS_KNOWLEDGE") => Ok(Resolved::LegacyKnowledge(path)),
                    _ => Err(DomainError::new(
                        ErrorCode::BACKUP_RESTORE_SCOPE_UNSUPPORTED,
                        "这份 2.x 备份不能导入（只有项目备份与知识库备份可以）",
                    )
                    .detail("scope", scope.as_str())),
                }
            }
        }
    }

    /// 导入预览（`import.preview`）：只读，不写任何文件。
    pub fn preview_import_source(
        &self,
        principal: &Principal,
        from: &ImportFrom,
    ) -> Result<Value, DomainError> {
        capability::require(principal, Capability::ImportPreview)?;
        let mut v = match self.resolve_import(from)? {
            Resolved::Package(path) => {
                let i = package::inspect_package(&path).map_err(package_error)?;
                let taken =
                    package::code_status(self.store(), &i.project.code).map_err(package_error)?;
                json!({
                    "kind": "PROJECT",
                    "formatVersion": i.format_version,
                    "project": {"id": i.project.id, "code": i.project.code, "name": i.project.name},
                    "createdAt": i.created_at,
                    "applicationVersion": i.application_version,
                    "schemaVersion": i.schema_version,
                    "counts": i.counts,
                    "attachments": i.attachments.len(),
                    "attachmentsBytes": i.attachments.iter().map(|f| f.size).sum::<u64>(),
                    "codeTaken": taken.is_some(),
                    "suggestedCode": taken,
                    "sha256": i.sha256,
                    "sizeBytes": i.size_bytes,
                })
            }
            Resolved::LegacyProject(path) => {
                let i = package::inspect_legacy(&path, atm_store::legacy::Home::Project)
                    .map_err(package_error)?;
                let project = i
                    .project
                    .ok_or_else(|| internal("2.x project without project_meta"))?;
                let taken =
                    package::code_status(self.store(), &project.code).map_err(package_error)?;
                json!({
                    "kind": "PROJECT",
                    "formatVersion": null,
                    "project": {"id": project.id, "code": project.code, "name": project.name},
                    "schemaVersion": i.schema_version,
                    "counts": i.counts,
                    "attachments": 0,
                    "codeTaken": taken.is_some(),
                    "suggestedCode": taken,
                })
            }
            Resolved::LegacyKnowledge(path) => {
                let i = package::inspect_legacy(&path, atm_store::legacy::Home::Knowledge)
                    .map_err(package_error)?;
                let (new, existing) =
                    package::knowledge_overlap(self.store(), &path).map_err(package_error)?;
                json!({
                    "kind": "KNOWLEDGE",
                    "schemaVersion": i.schema_version,
                    "counts": i.counts,
                    "newEntries": new,
                    "existingEntries": existing,
                })
            }
        };
        v["source"] = from.view();
        Ok(v)
    }

    /// 导入（`import.apply`，只有 User）。`code` 只对项目有效：导入后的项目代码（先转大写，按项目代码的规则校验）。
    pub fn import_source(
        &self,
        principal: &Principal,
        from: &ImportFrom,
        code: Option<&str>,
    ) -> Result<Value, DomainError> {
        capability::require(principal, Capability::ImportApply)?;
        let code = match code.map(str::trim).filter(|c| !c.is_empty()) {
            Some(c) => {
                let c = keys::normalize(c);
                if !crate::project::valid_code(&c) {
                    return Err(DomainError::new(
                        ErrorCode::INVALID_ARGUMENT,
                        "项目代码须以大写字母开头，2–12 位大写字母、数字或连字符",
                    )
                    .detail("field", "code"));
                }
                Some(c)
            }
            None => None,
        };
        let x = self.exchange()?;
        let at = now().to_string();
        let label = match from {
            ImportFrom::Package { origin, name } => format!("{origin}/{name}"),
            ImportFrom::LegacyBackup { id } => format!("legacy-backup/{id}"),
        };
        let opts = ImportOptions {
            exports_dir: &x.exports,
            at: &at,
            code: code.as_deref(),
            source_label: &label,
        };
        let mut v = match self.resolve_import(from)? {
            Resolved::Package(path) => project_view(package::import_project(
                self.store(),
                ImportSource::Package(&path),
                &opts,
            ))?,
            Resolved::LegacyProject(path) => project_view(package::import_project(
                self.store(),
                ImportSource::LegacyProject(&path),
                &opts,
            ))?,
            Resolved::LegacyKnowledge(path) => {
                let m = package::import_legacy_knowledge(self.store(), &path, &opts)
                    .map_err(package_error)?;
                json!({"kind": "KNOWLEDGE", "inserted": m.inserted, "skipped": m.skipped})
            }
        };
        v["source"] = from.view();
        Ok(v)
    }
}

fn project_view(r: Result<package::Imported, PackageError>) -> Result<Value, DomainError> {
    let i = r.map_err(package_error)?;
    Ok(json!({
        "kind": "PROJECT",
        "projectId": i.project_id,
        "code": i.code,
        "name": i.name,
        "sourceCode": i.source_code,
        "generation": i.generation,
        "attachments": i.attachments,
        "sessionsClosed": i.sessions_closed,
    }))
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    use sha2::Digest;
    let mut f = std::fs::File::open(path)?;
    let mut h = sha2::Sha256::new();
    std::io::copy(&mut f, &mut h)?;
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}
