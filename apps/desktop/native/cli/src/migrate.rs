//! `migrate --dry-run --source <2.x 根> --out <目录>`（07 §9、03 §2.5、06 §6）：用正式转换的同一套代码
//! （[`atm_store::conversion::dry_run`]）在 `--out` 里演练一遍，写出 `report.json` 与 `attachment.jsonl`。
//!
//! 只写 `--out`：不写源根、不写 3.0 根 `N`（输出目录也不许落在两者里面），不取服务准入，不起任何调度器，不构造 Principal。
//! 2.x 服务还在跑（它的租约有效）就只报告、什么都不做（退出码 5）。DPAPI 密文的自检要解密，只在真正转换时由宿主做，
//! 演练不做。源是这台电脑上真正的 2.x 根时照样读（只读），这正是演练的用途。

use crate::{FAILED, OK, Out, USAGE, show};
use atm_store::conversion::{self as cv, DryRun, DryRunOptions, Quiesce};
use serde_json::json;
use std::path::PathBuf;

pub struct Request {
    pub source: String,
    pub out: String,
    pub keep_data: bool,
}

pub fn run(out: Out, r: Request) -> i32 {
    let fail = |code: &str, message: String, exit: i32| {
        if out.json {
            println!("{}", json!({"error": {"code": code, "message": message}}));
        } else {
            eprintln!("{message}");
        }
        exit
    };
    let (Ok(source), Ok(target)) = (std::path::absolute(&r.source), std::path::absolute(&r.out))
    else {
        return fail("USAGE", "路径无效".into(), USAGE);
    };
    let v3_root: Option<PathBuf> = crate::discover::data_root();
    let at = atm_install_state::startup::iso_utc(atm_install_state::handoff::now_ms());
    let runtime = source.join("runtime");
    let mut quiesce = || match atm_install_state::service::lease_holder(&runtime) {
        Some(pid) => Quiesce::Wait(format!("the 2.x service (pid {pid}) still holds its lease")),
        None => Quiesce::Quiet,
    };
    let result = cv::dry_run(DryRunOptions {
        at: &at,
        source: &source,
        out: &target,
        v3_root: v3_root.as_deref(),
        allow_real_data_root: true,
        real_data_root: None,
        secrets_check: None,
        accept_unconvertible: &[],
        keep_data: r.keep_data,
        quiesce: &mut quiesce,
        after_copy: &mut || {},
    });
    let report = target.join("report.json").display().to_string();
    match result {
        Ok(DryRun::Verified { pending, .. }) => {
            show(
                out,
                &json!({
                    "ok": true,
                    "result": "VERIFIED",
                    "report": report,
                    "pending": pending,
                }),
                &[],
            );
            OK
        }
        Ok(DryRun::VerifyFailed(families)) => {
            show(
                out,
                &json!({"ok": false, "result": "VERIFY_FAILED", "report": report, "families": families}),
                &[],
            );
            FAILED
        }
        Ok(DryRun::SourceNotQuiet(why)) => fail(
            "ATM_MIGRATE_SOURCE_NOT_QUIET",
            format!("演练期间 2.x 的数据在变（{why}）：等它静止后再试"),
            FAILED,
        ),
        Ok(DryRun::SourceBusy(why)) => fail(
            "ATM_ADMISSION_CONFLICT",
            format!("2.x 的服务还在跑（{why}）：先在托盘退出旧版 ATM，什么都没做"),
            crate::recover::ADMISSION,
        ),
        Err(e) => fail("ATM_MIGRATE_REFUSED", format!("演练没有进行：{e}"), FAILED),
    }
}
