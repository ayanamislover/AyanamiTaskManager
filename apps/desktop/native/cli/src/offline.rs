//! `doctor --offline`（06 §6、03 §2.5）：不依赖服务、不发任何请求、不构造 Principal，只读文件。
//!
//! 读的东西：转换清单 `conversion.json`、启动状态 `runtime\startup-state.json`、服务描述 `runtime\daemon.json`
//! （只看 pid 是否活着，令牌与端口不输出）、整库 `data\atm.sqlite`（只读打开：`app_meta` 的版本与 generation、
//! 项目数、`PRAGMA quick_check`），以及备份目录里的文件数。`app_meta.cursor_key` 是游标密钥，不读。
//! 另外报崩溃后的自动恢复（`keepalive`）：安装根 `state\keepalive-task.json` 的登记、`runtime\keepalive.json`
//! 的熔断、`runtime\user-quit.json` 的用户退出标记。
//!
//! 只读的意思是不改任何文件，也不取服务的准入锁（取了会让同时启动的服务以为另一个实例在跑）。
//! 整库没有 `-wal` 时按 `immutable` 打开，SQLite 不会建 `-wal` / `-shm`；有 `-wal` 时说明服务在跑或上次没正常退出，
//! 按只读打开，读得到 `-wal` 里已提交的内容。服务在跑时照样能用：诊断挂住的服务正需要它。
//! 有 `-journal` 时也不用 `immutable`：那是上次写到一半被中断留下的回滚日志，`immutable` 会无视它、读到半截的页。
//! 只读连接回滚不了它，打不开时如实说「正常启动一次会回滚」，不说库坏了（W8 关口，ATM-D-526）。

use crate::discover::{self, Unavailable};
use atm_store::conversion::{Layout, ManifestState, read_manifest};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

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
            "keepalive": keepalive(root, installed_root().as_deref()),
        }),
        problems,
    }
}

/// 这个 `atm.exe` 所在的安装根；便携版、开发构建没有。
fn installed_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    atm_install_state::keepalive::install_root_of(&exe)
}

/// 崩溃后的自动恢复（方案 §5、B1）。只报事实，不算问题：便携版、开发构建本来就没有，
/// 熔断与用户退出是有意的停手。`auto_recovery` 只在任务登记成功、没熔断、这次登录里用户没退出时为真
/// ——注册失败时不声称有自动恢复。`reason` 说明为什么没有（setup 登记的原因照原文）。
pub fn keepalive(n: &Path, install_root: Option<&Path>) -> Value {
    use atm_install_state::keepalive as k;
    let registration = install_root.and_then(k::read_registration);
    let breaker = k::read_breaker(n);
    let now = atm_install_state::handoff::now_ms();
    let recent = breaker
        .exits
        .iter()
        .filter(|exit| now.saturating_sub(exit.at_ms) < k::BREAKER_WINDOW_MS)
        .count();
    let user_quit = k::user_quit_applies(n, k::logon_id().as_deref());
    let reason = match (install_root, &registration) {
        (None, _) => Some("不是安装版（便携版或开发构建）：没有保活任务".to_owned()),
        (Some(_), None) => Some("setup 没有登记保活任务".to_owned()),
        (Some(_), Some(r)) if !r.registered => Some(
            r.reason
                .clone()
                .unwrap_or_else(|| "保活任务没有注册".to_owned()),
        ),
        _ if breaker.tripped() => {
            Some("熔断：30 分钟内异常退出 3 次，等用户自己启动一次".to_owned())
        }
        _ if user_quit => Some("这次登录里用户从托盘退出过".to_owned()),
        _ => None,
    };
    json!({
        "auto_recovery": reason.is_none(),
        "registered": registration.as_ref().is_some_and(|r| r.registered),
        "registered_at": registration.as_ref().map(|r| r.at.clone()),
        "reason": reason,
        "breaker_tripped": breaker.tripped(),
        "recent_abnormal_exits": recent,
        "user_quit": user_quit,
    })
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
    let journal = path.with_file_name(format!(
        "{}-journal",
        path.file_name().unwrap_or_default().to_string_lossy()
    ));
    let journal_bytes = std::fs::metadata(&journal).ok().map(|m| m.len());
    let mut out = json!({
        "exists": true,
        "size_bytes": meta.len(),
        "wal_bytes": wal_bytes,
        "journal_bytes": journal_bytes,
    });
    match read_database(path, wal_bytes.is_none() && journal_bytes.is_none()) {
        Ok(facts) => {
            if facts["quick_check"] != "ok" {
                problems.push(format!("整库完整性检查没有通过：{}", facts["quick_check"]));
            }
            if let (Value::Object(o), Value::Object(f)) = (&mut out, facts) {
                o.extend(f);
            }
        }
        Err(e) if journal_bytes.is_some() => {
            problems.push(format!(
                "整库旁边有没回滚的日志 {}：上次写到一半被中断。正常启动一次 ATM 会先回滚它再用；\
                 这不是库坏了，不要因此从备份恢复（只读诊断回滚不了它：{e}）",
                journal.display()
            ));
            out["error"] = json!(e.to_string());
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

#[cfg(test)]
mod tests {
    use super::*;
    use atm_install_state::keepalive as k;
    use std::fs;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::var_os("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("target")
            })
            .join("cli-tests")
            .join("offline-keepalive")
            .join(name);
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn registered(root: &Path, registered: bool, reason: Option<&str>) {
        k::write_registration(
            root,
            &k::Registration {
                registered,
                at: "2026-10-11T00:00:00.000Z".into(),
                reason: reason.map(str::to_owned),
            },
        )
        .unwrap();
    }

    #[test]
    fn auto_recovery_is_claimed_only_for_a_registered_install() {
        let base = dir("claimed");
        let (n, root) = (base.join("n"), base.join("root"));
        fs::create_dir_all(&n).unwrap();
        fs::create_dir_all(&root).unwrap();

        let v = keepalive(&n, None);
        assert_eq!(v["auto_recovery"], false, "{v}");
        assert!(v["reason"].as_str().unwrap().contains("不是安装版"), "{v}");

        let v = keepalive(&n, Some(&root));
        assert_eq!(v["auto_recovery"], false, "nothing recorded: {v}");
        assert_eq!(v["registered"], false, "{v}");

        registered(&root, false, Some("TaskScheduler: access denied"));
        let v = keepalive(&n, Some(&root));
        assert_eq!(v["auto_recovery"], false, "{v}");
        assert_eq!(v["reason"], "TaskScheduler: access denied", "{v}");

        registered(&root, true, None);
        let v = keepalive(&n, Some(&root));
        assert_eq!(v["auto_recovery"], true, "{v}");
        assert_eq!(v["registered"], true, "{v}");
        assert_eq!(v["reason"], Value::Null, "{v}");
        assert_eq!(v["breaker_tripped"], false, "{v}");
        assert_eq!(v["user_quit"], false, "{v}");
    }

    #[test]
    fn a_tripped_breaker_and_a_user_quit_suspend_it() {
        let base = dir("suspended");
        let (n, root) = (base.join("n"), base.join("root"));
        fs::create_dir_all(&root).unwrap();
        registered(&root, true, None);
        let now = atm_install_state::handoff::now_ms();
        // As the launcher leaves the file: an exit from an hour ago stays in it until the
        // next one is recorded. It is no longer recent.
        let exit = |run: &str, at_ms| k::AbnormalExit {
            run_id: run.into(),
            at_ms,
        };
        let breaker = k::Breaker {
            exits: vec![
                exit("old", now - 60 * 60 * 1000),
                exit("a", now),
                exit("b", now),
                exit("c", now),
            ],
            tripped_at_ms: Some(now),
        };
        k::write_breaker(&n, &breaker).unwrap();
        let v = keepalive(&n, Some(&root));
        assert_eq!(v["auto_recovery"], false, "{v}");
        assert_eq!(v["breaker_tripped"], true, "{v}");
        assert_eq!(v["recent_abnormal_exits"], 3, "{v}");
        assert!(v["reason"].as_str().unwrap().contains("熔断"), "{v}");

        k::reset_breaker(&n);
        k::mark_user_quit(
            &n,
            &k::UserQuit {
                logon: k::logon_id().unwrap_or_default(),
                at: "2026-10-11T00:00:00.000Z".into(),
            },
        )
        .unwrap();
        let v = keepalive(&n, Some(&root));
        assert_eq!(v["auto_recovery"], false, "{v}");
        assert_eq!(v["user_quit"], true, "{v}");

        // Another logon's marker no longer applies.
        k::mark_user_quit(
            &n,
            &k::UserQuit {
                logon: "another".into(),
                at: "2026-10-11T00:00:00.000Z".into(),
            },
        )
        .unwrap();
        let v = keepalive(&n, Some(&root));
        assert_eq!(v["auto_recovery"], true, "{v}");
    }
}
