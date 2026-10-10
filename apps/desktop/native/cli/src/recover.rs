//! `recover --offline`（03 §2.5，P-011）：服务不在时，从整库备份恢复。
//!
//! - R1 独占准入：先确认没有安装事务，再取宿主的单实例互斥（与宿主同一个名字，按 2.x 根 `L` 起名），再取
//!   `N\runtime\service.lock`（与服务同一把）。任何一项取不到就以退出码 5 退出、什么都不改，提示「请先在托盘退出 ATM」。
//!   服务挂住但进程还在时它仍持有锁，同样拒绝。
//! - R2：这里是唯一的入口；HTTP、MCP、ui-bridge 都不链接也不调用 [`atm_store::recover`]（`cli/tests/recover.rs`）。
//! - R3 / R4：见 [`atm_store::recover`]。另在 `N\logs\lifecycle.ndjson` 记一行 `offline.recover`。
//! - R5：要在控制台输入备份 ID 确认；`--yes` 只在 `ATM_TEST_MODE=1` 时有效。
//!
//! 不构造任何 Principal，不连服务。`--list` 只读，不取准入。

use crate::{FAILED, OK, Out, USAGE, show};
use atm_store::conversion::{self as cv, Layout, Quiesce};
use atm_store::recover::{self, RecoverError, RecoverOptions};
use serde_json::{Value, json};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

/// 准入冲突：ATM（或安装程序）在跑。
pub const ADMISSION: i32 = 5;
/// 选中的备份固定多久（与按范围恢复相同，A4）。
const PIN_DAYS: u64 = 30;

pub struct Request {
    pub from: Option<String>,
    pub list: bool,
    pub yes: bool,
}

fn say(out: Out, code: &str, message: &str, exit: i32) -> i32 {
    if out.json {
        println!("{}", json!({"error": {"code": code, "message": message}}));
    } else {
        eprintln!("{message}");
    }
    exit
}

pub fn run(out: Out, r: Request) -> i32 {
    if r.yes && std::env::var("ATM_TEST_MODE").as_deref() != Ok("1") {
        return say(
            out,
            "USAGE",
            "--yes 只在测试模式（ATM_TEST_MODE=1）下有效：请在控制台输入备份 ID 确认",
            USAGE,
        );
    }
    let Some(root) = crate::discover::data_root() else {
        return say(
            out,
            "ATM_RUNTIME_UNAVAILABLE",
            "找不到 ATM 数据目录：没有 LOCALAPPDATA；请设置 ATM3_DATA_DIR",
            FAILED,
        );
    };
    let layout = Layout::new(&root);
    if r.list {
        return list(out, &layout);
    }

    // R1：安装事务 → 宿主单实例互斥 → 服务准入锁。守卫活到进程结束。
    if let Some(why) = install_busy() {
        return say(out, "ATM_ADMISSION_CONFLICT", &why, ADMISSION);
    }
    let legacy = match atm_install_state::data_dir() {
        Ok(legacy) => legacy,
        Err(e) => {
            return say(
                out,
                "ATM_RUNTIME_UNAVAILABLE",
                &format!("找不到 ATM 数据目录：{e}"),
                FAILED,
            );
        }
    };
    let Some(_primary) = atm_install_state::ipc::acquire(&legacy) else {
        return say(
            out,
            "ATM_ADMISSION_CONFLICT",
            "ATM 正在运行：请先在托盘退出 ATM，再运行 recover",
            ADMISSION,
        );
    };
    let _admission = match cv::admit(&layout, || Quiesce::Quiet) {
        Ok(admission) => admission,
        Err(cv::AdmitError::AlreadyRunning) => {
            return say(
                out,
                "ATM_ADMISSION_CONFLICT",
                "ATM 的服务仍持有数据目录（可能挂住了）：请先在托盘退出 ATM 或结束它，再运行 recover",
                ADMISSION,
            );
        }
        Err(e) => {
            return say(
                out,
                "ATM_RECOVER_FAILED",
                &format!("取不到数据目录的准入：{e:?}"),
                FAILED,
            );
        }
    };

    let pending = match recover::pending_backup(&layout) {
        Ok(p) => p,
        Err(e) => {
            return say(
                out,
                "ATM_RECOVER_FAILED",
                &format!("上次恢复的记录读不出来：{e}"),
                FAILED,
            );
        }
    };
    let candidates = match recover::candidates(&layout) {
        Ok(c) => c,
        Err(e) => {
            return say(
                out,
                "ATM_RECOVER_FAILED",
                &format!("列不出备份：{e}"),
                FAILED,
            );
        }
    };
    let id = match (&pending, &r.from) {
        (Some(p), Some(f)) if p != f => {
            return say(
                out,
                "ATM_RECOVER_UNFINISHED",
                &format!(
                    "上次恢复到备份 {p} 还没做完：只能先续做同一份（atm recover --offline --from {p}）"
                ),
                FAILED,
            );
        }
        (Some(p), _) => p.clone(),
        (None, Some(f)) => f.clone(),
        (None, None) => match candidates.iter().find(|c| c.problem.is_none()) {
            Some(c) => c.id.clone(),
            None => {
                return say(
                    out,
                    "ATM_RECOVER_NO_BACKUP",
                    "没有可用的整库备份（atm recover --offline --list 看原因）",
                    FAILED,
                );
            }
        },
    };
    let chosen = candidates.iter().find(|c| c.id == id);
    if pending.is_none() {
        match chosen {
            None => {
                return say(
                    out,
                    "ATM_RECOVER_NO_BACKUP",
                    &format!("没有备份 {id}"),
                    FAILED,
                );
            }
            Some(c) if c.problem.is_some() => {
                return say(
                    out,
                    "ATM_RECOVER_BACKUP_UNUSABLE",
                    &format!(
                        "备份 {id} 不能用：{}",
                        c.problem.as_deref().unwrap_or_default()
                    ),
                    FAILED,
                );
            }
            Some(_) => {}
        }
    }

    // R5：确认。
    let (kind, created) = chosen.map_or(("?", "?"), |c| (c.kind.as_str(), c.created_at.as_str()));
    eprintln!(
        "将把 ATM 数据恢复到整库备份 {id}（{kind}，{created}）。\n\
         当前数据会整代移入 {}\\quarantine\\，不会删除；备份点之后的写入不会保留，Agent 需要按 ATM_AGENT_GUIDE 重做。",
        root.display()
    );
    if !r.yes {
        eprint!("请输入备份 ID 确认：");
        let _ = std::io::stderr().flush();
        let mut line = String::new();
        let _ = std::io::stdin().lock().read_line(&mut line);
        if line.trim() != id {
            return say(
                out,
                "ATM_RECOVER_NOT_CONFIRMED",
                "没有确认，什么都没改",
                FAILED,
            );
        }
    }

    let now = atm_install_state::handoff::now_ms();
    let at = atm_install_state::startup::iso_utc(now);
    let pin_until = atm_install_state::startup::iso_utc(now + PIN_DAYS * 86_400_000);
    match recover::recover(
        &layout,
        &id,
        RecoverOptions {
            at: &at,
            pin_until: &pin_until,
        },
    ) {
        Ok(done) => {
            lifecycle(&root, &at, &done.backup_id, done.ledgers_lost);
            let value = json!({
                "ok": true,
                "operation": "recover.offline",
                "backup_id": done.backup_id,
                "quarantine": done.quarantine.display().to_string(),
                "ledgers_lost": done.ledgers_lost,
                "next": "启动 ATM：第一次启动会记一条「数据库已恢复」并让所有游标失效",
            });
            show(out, &value, &[]);
            OK
        }
        Err(RecoverError::Unusable { id, why }) => say(
            out,
            "ATM_RECOVER_BACKUP_UNUSABLE",
            &format!("备份 {id} 不能用：{why}"),
            FAILED,
        ),
        Err(e) => say(
            out,
            "ATM_RECOVER_FAILED",
            &format!("恢复没有做完：{e}。再运行一次 atm recover --offline 会接着做"),
            FAILED,
        ),
    }
}

fn list(out: Out, layout: &Layout) -> i32 {
    let candidates = match recover::candidates(layout) {
        Ok(c) => c,
        Err(e) => {
            return say(
                out,
                "ATM_RECOVER_FAILED",
                &format!("列不出备份：{e}"),
                FAILED,
            );
        }
    };
    let rows: Vec<Value> = candidates
        .iter()
        .map(|c| {
            json!({
                "id": c.id,
                "kind": c.kind,
                "createdAt": c.created_at,
                "status": if c.problem.is_none() { "USABLE" } else { "UNUSABLE" },
                "problem": c.problem,
            })
        })
        .collect();
    let pending = recover::pending_backup(layout).ok().flatten();
    show(
        out,
        &json!({"backups": rows, "unfinished": pending}),
        &[("backups", "")],
    );
    OK
}

/// 安装或更新正在进行（setup 的事务日志或锁在）：不恢复。atm.exe 不在安装布局里时没有可查的。
fn install_busy() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let root = install_root(&exe)?;
    let busy = atm_install_state::lock_held(&root)
        || !matches!(atm_install_state::read_journal(&root), Ok(None));
    busy.then(|| "正在安装或更新 ATM：等它结束后再运行 recover".to_owned())
}

/// `<安装根>\app-<版本>\resources\atm.exe` → `<安装根>`（有 `app.json` 才算）。
fn install_root(exe: &Path) -> Option<PathBuf> {
    let root = exe.parent()?.parent()?.parent()?;
    root.join(atm_install_state::APP_POINTER)
        .is_file()
        .then(|| root.to_path_buf())
}

/// R4：在宿主的 lifecycle 日志里记一行（宿主的 `lifecycle-state.json` 不动：它只描述宿主自己的上一次运行）。
fn lifecycle(root: &Path, at: &str, backup: &str, ledgers_lost: bool) {
    let dir = root.join("logs");
    let line = json!({
        "event": "offline.recover",
        "at": at,
        "pid": std::process::id(),
        "backupId": backup,
        "ledgersLost": ledgers_lost,
    });
    let _ = std::fs::create_dir_all(&dir).and_then(|()| {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("lifecycle.ndjson"))?
            .write_all(format!("{line}\n").as_bytes())
    });
}
