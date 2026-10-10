//! `doctor --offline`（06 §6、03 §2.5）：不依赖服务、不发任何请求、不构造 Principal，只读文件。
//!
//! 读的东西：转换清单 `conversion.json`、启动状态 `runtime\startup-state.json`、服务描述 `runtime\daemon.json`
//! （只看 pid 是否活着，令牌与端口不输出）、整库 `data\atm.sqlite`（只读打开：`app_meta` 的版本与 generation、
//! 项目数、`PRAGMA quick_check`），以及备份目录里的文件数。`app_meta.cursor_key` 是游标密钥，不读。
//!
//! 只读的意思是不改任何文件，也不取服务的准入锁（取了会让同时启动的服务以为另一个实例在跑）。
//! 整库没有 `-wal` 时按 `immutable` 打开，SQLite 不会建 `-wal` / `-shm`；有 `-wal` 时说明服务在跑或上次没正常退出，
//! 按只读打开，读得到 `-wal` 里已提交的内容。服务在跑时照样能用：诊断挂住的服务正需要它。

use crate::discover::{self, Unavailable};
use atm_store::conversion::{Layout, ManifestState, read_manifest};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use std::path::Path;

/// 报告与发现的问题（问题为空才算健康）。
pub struct Report {
    pub value: Value,
    pub problems: Vec<String>,
}

pub fn doctor(root: &Path) -> Report {
    let mut problems = Vec::new();
    let layout = Layout::new(root);
    let exists = root.is_dir();
    if !exists {
        problems.push("数据目录不存在：ATM 3 还没有在这台电脑上运行过".to_owned());
    }

    let conversion = match read_manifest(&layout) {
        ManifestState::Missing => json!({ "state": "MISSING" }),
        ManifestState::Corrupt => {
            problems.push("转换清单 conversion.json 损坏".to_owned());
            json!({ "state": "CORRUPT" })
        }
        ManifestState::Present(m) => {
            if m.phase.as_str() != "PUBLISHED" {
                problems.push(format!("数据转换没有完成（{}）", m.phase.as_str()));
            }
            json!({
                "state": "PRESENT",
                "phase": m.phase.as_str(),
                "generation": m.generation,
                "published_at": m.published_at,
                "failure": m.failure,
            })
        }
    };

    let startup = discover::startup_state(root).map(|s| {
        problems.push(format!("等待用户在 ATM 窗口里选择数据来源（{}）", s.reason));
        json!({ "state": s.state, "since": s.since, "reason": s.reason })
    });

    let service = match discover::read_descriptor(root) {
        Ok(None) => json!({ "descriptor": "MISSING" }),
        Ok(Some(d)) => {
            json!({ "descriptor": "PRESENT", "pid": d.pid, "pid_alive": discover::pid_alive(d.pid) })
        }
        Err(Unavailable::DescriptorInvalid) => {
            problems.push("服务描述 runtime\\daemon.json 无效".to_owned());
            json!({ "descriptor": "INVALID" })
        }
        Err(_) => json!({ "descriptor": "UNREADABLE" }),
    };

    let database = database(&layout.database(), &mut problems);

    let backups_dir = root.join("backups");
    let backups = std::fs::read_dir(&backups_dir).map_or(json!({ "exists": false }), |entries| {
        let files = entries
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
            .count();
        json!({ "exists": true, "files": files })
    });

    let healthy = problems.is_empty();
    Report {
        value: json!({
            "mode": "offline",
            "data_root": root.display().to_string(),
            "exists": exists,
            "healthy": healthy,
            "problems": problems.clone(),
            "conversion": conversion,
            "startup_state": startup,
            "service": service,
            "database": database,
            "backups": backups,
        }),
        problems,
    }
}

fn database(path: &Path, problems: &mut Vec<String>) -> Value {
    let Ok(meta) = std::fs::metadata(path) else {
        return json!({ "exists": false });
    };
    let wal = path.with_file_name(format!(
        "{}-wal",
        path.file_name().unwrap_or_default().to_string_lossy()
    ));
    let wal_bytes = std::fs::metadata(&wal).ok().map(|m| m.len());
    let mut out = json!({
        "exists": true,
        "size_bytes": meta.len(),
        "wal_bytes": wal_bytes,
    });
    match read_database(path, wal_bytes.is_none()) {
        Ok(facts) => {
            if facts["quick_check"] != "ok" {
                problems.push(format!("整库完整性检查没有通过：{}", facts["quick_check"]));
            }
            if let (Value::Object(o), Value::Object(f)) = (&mut out, facts) {
                o.extend(f);
            }
        }
        Err(e) => {
            problems.push(format!("整库打不开：{e}"));
            out["error"] = json!(e.to_string());
        }
    }
    out
}

fn read_database(path: &Path, immutable: bool) -> rusqlite::Result<Value> {
    let mut uri = String::from("file:///");
    for c in path.to_string_lossy().replace('\\', "/").chars() {
        match c {
            '?' => uri.push_str("%3f"),
            '#' => uri.push_str("%23"),
            '%' => uri.push_str("%25"),
            ' ' => uri.push_str("%20"),
            c => uri.push(c),
        }
    }
    uri.push_str(if immutable {
        "?mode=ro&immutable=1"
    } else {
        "?mode=ro"
    });
    let conn = Connection::open_with_flags(
        &uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(std::time::Duration::from_secs(2))?;
    conn.pragma_update(None, "query_only", true)?;
    let (schema_version, generation, converted_from) = conn.query_row(
        "SELECT schema_version, generation, converted_from FROM app_meta WHERE singleton = 1",
        [],
        |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        },
    )?;
    let projects: i64 = conn.query_row("SELECT count(*) FROM projects", [], |r| r.get(0))?;
    let check: Vec<String> = conn
        .prepare("PRAGMA quick_check(5)")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(json!({
        "schema_version": schema_version,
        "generation": generation,
        "converted": converted_from.is_some(),
        "projects": projects,
        "quick_check": check.join("; "),
    }))
}
