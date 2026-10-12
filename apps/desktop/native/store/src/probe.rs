//! 安装探测（方案 §6 PROBE、06 :345）：新版能不能打开或转换这台机器上的数据。setup 在旧版还在服务时运行它，
//! 所以全程只读——不做转换，不写 `N` 与 `L`，不起服务。库都经 [`crate::detached`] 读：能 `immutable` 就直接读，
//! 否则在安装根下的暂存目录里读副本（只读连接对 WAL 库并不只读，会建、改 `-shm` 与 `-wal`，W8 关口 peer r1 P1-01）。
//!
//! 与 2.0 的 `probeDataRoot` 同一个问题、换成 3.0 的两处数据：
//! - `N` 里服务会打开的发布物：已应用的迁移都是这个构建认得的（[`crate::check_applied`]），不是更新的 3.x 写的；
//! - `L` 的每个源库（只要 `L` 在，转换随时可能从它重来：首次转换、重做、回滚后以 2.x 为准）：已应用的 2.x 迁移
//!   都是转换器认得的（[`crate::legacy::check_legacy_applied`]）；
//! - `L` 里同步密文的 DPAPI 自检（05 §3.4）：解不开时转换会停下等用户决定，切过去就卡在 START。
//!
//! 结论里的 `startup` 是 [`decide`] 此刻的判定（同样只读），报告给 setup 看。

use std::io::Read;
use std::path::Path;

use crate::conversion::{Layout, Startup, decide_reading};
use crate::detached;
use crate::legacy::{ConvertError, Home, LegacySources, check_legacy_applied};

/// 一个检查过的库：在哪一处（`v3`、`registry`、`knowledge`、`project`）、已应用的最高迁移号。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Checked {
    pub scope: &'static str,
    pub version: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Report {
    pub startup: &'static str,
    pub databases: Vec<Checked>,
}

/// 新版处理不了的数据：`code` 是给 setup 的错误码，`scope` 是哪一处，`detail` 给人看。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub code: &'static str,
    pub scope: &'static str,
    pub detail: String,
}

fn fail(code: &'static str, scope: &'static str, detail: impl Into<String>) -> Failure {
    Failure {
        code,
        scope,
        detail: detail.into(),
    }
}

/// 与转换器读 JSON 文件的上限相同（`legacy::jsonfiles`）。
const MAX_SECRETS_BYTES: u64 = 64 << 20;

fn startup_name(s: &Startup) -> &'static str {
    match s {
        Startup::ResumeSeal => "RESUME_SEAL",
        Startup::FreshInstall => "FRESH_INSTALL",
        Startup::FirstConversion => "FIRST_CONVERSION",
        Startup::Restart { .. } => "RESTART",
        Startup::FinishPublishing { .. } => "FINISH_PUBLISHING",
        Startup::Quarantine { .. } => "QUARANTINE",
        Startup::Damaged { .. } => "DAMAGED",
        Startup::Published(_) => "PUBLISHED",
        Startup::SourceConflict(_) => "SOURCE_CONFLICT",
    }
}

/// `L\sync\secrets.dpapi.json` 的内容；没有是 `None`，超过上限当作读不出。
fn read_secrets(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut bytes = Vec::new();
    file.take(MAX_SECRETS_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_SECRETS_BYTES {
        return Err(std::io::Error::other(format!(
            "it is larger than {MAX_SECRETS_BYTES} bytes"
        )));
    }
    Ok(Some(bytes))
}

/// `n` 是新根 `N`，`legacy` 是旧根 `L`；`scratch` 是放副本的暂存目录（不在 `N`、`L` 里，读完即删）；
/// `secrets_check` 是宿主的 DPAPI 自检（拿密文试着解开，只答成功与否）。
pub fn run(
    n: &Path,
    legacy: &Path,
    scratch: &Path,
    secrets_check: Option<fn(&[u8]) -> bool>,
) -> Result<Report, Failure> {
    let layout = Layout::new(n);
    // 读不了 `L` 就当它在：下面的检查会报出具体原因。
    let legacy_exists = crate::conversion::legacy_present(legacy).unwrap_or(true);
    let startup = decide_reading(&layout, legacy_exists, scratch);
    let mut databases = Vec::new();

    // N：服务会打开的那份发布物。隔离、封存、重做的发布物不会被打开，不查。
    if matches!(
        startup,
        Startup::Published(_) | Startup::SourceConflict(_) | Startup::FinishPublishing { .. }
    ) {
        let db = layout.database();
        let applied = detached::read(&db, scratch, crate::check_applied).map_err(|e| match e {
            detached::Error::Open(e) => {
                fail("V3_UNREADABLE", "v3", format!("{}: {e}", db.display()))
            }
            detached::Error::Read(e) => {
                let code = match e {
                    crate::StoreError::MigrationMismatch(_) => "V3_SCHEMA_UNKNOWN",
                    _ => "V3_UNREADABLE",
                };
                fail(code, "v3", format!("{}: {e}", db.display()))
            }
        })?;
        databases.push(Checked {
            scope: "v3",
            version: applied.last().map(|a| a.0),
        });
    }

    // L：只要它在，转换就可能从它重来。没有 registry 的 `L` 转不了，只在这一次就要转换时算失败。
    let converting = matches!(startup, Startup::FirstConversion | Startup::Restart { .. });
    let registry = legacy.join("registry").join("registry.sqlite");
    if legacy_exists && (converting || registry.is_file()) {
        let sources = LegacySources::from_root(legacy)
            .map_err(|e| fail("LEGACY_UNREADABLE", "registry", e.to_string()))?;
        let mut each = vec![(sources.registry.clone(), Home::Registry, "registry")];
        if let Some(k) = &sources.knowledge {
            each.push((k.clone(), Home::Knowledge, "knowledge"));
        }
        each.extend(
            sources
                .projects
                .iter()
                .map(|p| (p.clone(), Home::Project, "project")),
        );
        for (path, home, scope) in each {
            let shown = path.display().to_string();
            let applied = detached::read(&path, scratch, |c| check_legacy_applied(c, home, &shown))
                .map_err(|e| match e {
                    detached::Error::Open(e) => {
                        fail("LEGACY_UNREADABLE", scope, format!("{shown}: {e}"))
                    }
                    detached::Error::Read(e) => {
                        let code = match e {
                            ConvertError::UnsupportedSchema(_) => "LEGACY_SCHEMA_UNKNOWN",
                            _ => "LEGACY_UNREADABLE",
                        };
                        fail(code, scope, e.to_string())
                    }
                })?;
            databases.push(Checked {
                scope,
                version: applied.last().map(|a| a.0),
            });
        }
        let secrets = legacy.join("sync").join("secrets.dpapi.json");
        let bytes = read_secrets(&secrets).map_err(|e| {
            fail(
                "SYNC_SECRETS_UNREADABLE",
                "sync",
                format!("{}: {e}", secrets.display()),
            )
        })?;
        if let Some(bytes) = bytes
            && !secrets_check.is_some_and(|check| check(&bytes))
        {
            return Err(fail(
                "SYNC_SECRETS_UNREADABLE",
                "sync",
                format!(
                    "{} cannot be opened by this Windows account; the conversion would stop for a decision",
                    secrets.display()
                ),
            ));
        }
    }

    Ok(Report {
        startup: startup_name(&startup),
        databases,
    })
}
