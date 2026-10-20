//! W3i：对真实数据根做转换演练（需要用户单独授权；不是用例，不进 `cargo test`）。
//!
//! ```text
//! cargo run --release -p atm-store --example rehearse -- <2.x 数据根> <工作目录>
//! ```
//!
//! 走 [`atm_store::conversion::rehearse`]：对真实根原样做正式的 dry-run（输出 `<工作目录>\dry`）、
//! 完整转换（`N = <工作目录>\n`）、启动判定与比较。不自己挑文件、不另做副本：复制集合、恢复依赖、
//! 路径映射都与正式转换相同（W3 peer r2 P2-07）。2.x 可以不停；一致性由 SNAPSHOT 的 F0/F1 保证，见 `rehearse` 的说明。
//!
//! 任何一步不是正式意义上的通过就停下，以非零退出：2 用法，3 枚举拒绝，4 dry-run，5 完整转换，
//! 6 两次快照之间源变了，7 启动判定，8 比较。
//! 只打印计数、族名与失败的定位（不含正文、不含凭据）。真实根只读；产物留在本机的工作目录里。

use atm_install_state::startup::iso_utc;
use atm_store::conversion::{self as cv, RehearseOptions, RehearseStop};
use rusqlite::Connection;
use std::fs;
use std::path::Path;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

const GENERATION: &str = "01J0000000000000000W3IREAL";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [real, work] = args.as_slice() else {
        eprintln!("usage: rehearse <2.x data root> <work dir>");
        std::process::exit(2);
    };
    let (real, work) = (Path::new(real), Path::new(work));
    if fs::read_dir(work).is_ok_and(|mut d| d.next().is_some()) {
        eprintln!("{} is not empty; use an empty work dir", work.display());
        std::process::exit(2);
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
    let at = iso_utc(now.as_millis() as u64);
    println!("at {at}");
    let t = Instant::now();
    let mut step_started = Instant::now();
    let result = cv::rehearse(RehearseOptions {
        at: &at,
        source: real,
        work,
        generation: GENERATION,
        allow_real_data_root: true,
        real_data_root: Some(real),
        secrets_check: None,
        before: &mut |step| {
            println!(
                "{step} (previous step {:.1}s)",
                step_started.elapsed().as_secs_f64()
            );
            step_started = Instant::now();
        },
    });
    println!("total {:.1}s", t.elapsed().as_secs_f64());
    summarize(&work.join("dry").join("report.json"));
    let r = match result {
        Ok(r) => r,
        Err(stop) => {
            let code = match &stop {
                RehearseStop::Refused(e) => {
                    println!("REFUSED by the formal scan: {e}");
                    3
                }
                RehearseStop::DryRun(why) => {
                    println!("DRY-RUN did not verify: {why}");
                    4
                }
                RehearseStop::Run(e) => {
                    println!("RUN failed: {e}");
                    summarize(
                        &work
                            .join("n")
                            .join("staging")
                            .join(GENERATION)
                            .join("report.json"),
                    );
                    5
                }
                RehearseStop::Moved(families) => {
                    println!("the source changed between the two snapshots: {families:?}");
                    6
                }
                RehearseStop::Decide(s) => {
                    println!("DECIDE is not Published: {s:?}");
                    7
                }
                RehearseStop::Compare(c) => {
                    println!("COMPARE is not Unchanged: {c:?}");
                    8
                }
            };
            std::process::exit(code);
        }
    };
    println!(
        "PASSED: {} files snapshotted; {} business families, the same in dry-run and run; {} generation {}; decide Published; compare Unchanged",
        r.files.len(),
        r.manifest.business_digest.len(),
        r.manifest.phase.as_str(),
        r.manifest.generation,
    );
    let db = Connection::open(r.layout.database()).unwrap();
    for table in [
        "projects",
        "objectives",
        "work_items",
        "checklist_items",
        "records",
        "progress_updates",
        "review_requests",
        "agent_sessions",
        "events",
        "knowledge_entries",
        "legacy_backups",
    ] {
        match db.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| {
            r.get::<_, i64>(0)
        }) {
            Ok(c) => println!("  {table}: {c}"),
            Err(e) => println!("  {table}: ({e})"),
        }
    }
}

/// `report.json` 的概要：顶层每个键的条目数，以及规范化规则与落定的计数（不含正文）。
fn summarize(path: &Path) {
    let Ok(text) = fs::read_to_string(path) else {
        println!("  (no report at {})", path.display());
        return;
    };
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    println!("  report {} ({} bytes)", path.display(), text.len());
    if let Some(o) = v.as_object() {
        for (k, x) in o {
            let size = match x {
                serde_json::Value::Array(a) => format!("{} items", a.len()),
                serde_json::Value::Object(o) => format!("{} keys", o.len()),
                other => other.to_string().chars().take(80).collect(),
            };
            println!("    {k}: {size}");
        }
        for key in ["normalizations", "settlements"] {
            for item in o.get(key).and_then(|x| x.as_array()).into_iter().flatten() {
                let rule = item
                    .get("rule")
                    .or_else(|| item.get("scope"))
                    .cloned()
                    .unwrap_or_default();
                let detail = item
                    .get("count")
                    .or_else(|| item.get("now"))
                    .cloned()
                    .unwrap_or_default();
                let family = item.get("family").or_else(|| item.get("was")).cloned();
                println!(
                    "      {key}: {rule} {} {detail}",
                    family.map(|f| f.to_string()).unwrap_or_default()
                );
            }
        }
    }
}
