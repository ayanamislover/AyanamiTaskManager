//! W3i：拿真实数据根的一致副本演练转换（需要用户单独授权；不是用例，不进 `cargo test`）。
//!
//! ```text
//! cargo run --release -p atm-store --example rehearse -- <2.x 数据根> <工作目录> [--exclude <相对路径>]...
//! ```
//!
//! 1. **一致副本**（`<工作目录>\copy`）：只复制业务目录（`registry`、`knowledge`、`projects` 去掉各项目的
//!    `backups\`、`sync`、`dispatch`）。库用只读连接 `VACUUM INTO`，在一个读事务里得到这一刻的一致内容，
//!    不写真实库，`-wal` / `-shm` 不另复制；其余文件逐字节复制。令牌与运行时文件、备份、日志、更新包一概不碰。
//!    `--exclude` 点名的条目不复制并打印出来（用户决定怎么处理的游离文件）。
//! 2. **dry-run**：在副本上，输出到 `<工作目录>\dry`。
//! 3. **完整转换**：`N = <工作目录>\n`，以副本为 `L` 走 [`conversion::run`]，再做一次启动判定与比较。
//!
//! 只打印计数、族名与失败的定位（不含正文、不含凭据）。真实根只读；产物留在本机的工作目录里。

use atm_install_state::startup::iso_utc;
use atm_store::conversion::{
    self as cv, CompareOptions, DryRun, DryRunOptions, Layout, Quiesce, RunOptions,
};
use rusqlite::{Connection, OpenFlags};
use std::fs;
use std::path::Path;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

const GENERATION: &str = "01J0000000000000000W3IREAL";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut positional = Vec::new();
    let mut excluded = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--exclude" {
            excluded.push(it.next().expect("--exclude <relative path>").as_str());
        } else {
            positional.push(a);
        }
    }
    let [real, work] = positional.as_slice() else {
        eprintln!("usage: rehearse <2.x data root> <work dir> [--exclude <relative path>]...");
        std::process::exit(2);
    };
    let (real, work) = (Path::new(real), Path::new(work));
    let (copy, dry, n) = (work.join("copy"), work.join("dry"), work.join("n"));
    for d in [&copy, &dry, &n] {
        assert!(
            !d.exists(),
            "{} already exists; use an empty work dir",
            d.display()
        );
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
    let at = iso_utc(now.as_millis() as u64);
    println!("at {at}");

    // 1. 一致副本：业务目录里的全部条目（项目的 backups\ 除外），去掉用户点名排除的。
    let t = Instant::now();
    let mut files = Vec::new();
    for top in ["registry", "knowledge", "projects", "sync", "dispatch"] {
        walk(real, top, &mut files);
    }
    files.retain(|rel| {
        let skip = excluded.contains(&rel.as_str());
        if skip {
            println!("excluded by the user's run: {rel}");
        }
        !skip
            && !rel
                .split('/')
                .collect::<Vec<_>>()
                .get(2)
                .is_some_and(|p| *p == "backups" && rel.starts_with("projects/"))
    });
    let (mut dbs, mut plain, mut bytes) = (0, 0, 0u64);
    for rel in &files {
        let (from, to) = (real.join(rel), copy.join(rel));
        fs::create_dir_all(to.parent().unwrap()).unwrap();
        if rel.ends_with("-wal") || rel.ends_with("-shm") {
            continue;
        }
        if rel.ends_with(".sqlite") {
            let c = Connection::open_with_flags(
                &from,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .unwrap_or_else(|e| panic!("open {rel}: {e}"));
            c.busy_timeout(std::time::Duration::from_secs(30)).unwrap();
            c.execute("VACUUM INTO ?1", [to.to_string_lossy()])
                .unwrap_or_else(|e| panic!("VACUUM INTO {rel}: {e}"));
            dbs += 1;
        } else {
            fs::copy(&from, &to).unwrap_or_else(|e| panic!("copy {rel}: {e}"));
            plain += 1;
        }
        bytes += fs::metadata(&to).map(|m| m.len()).unwrap_or(0);
    }
    println!(
        "copy: {} listed, {dbs} databases, {plain} files, {bytes} bytes, {:.1}s",
        files.len(),
        t.elapsed().as_secs_f64()
    );

    // 2. dry-run
    let t = Instant::now();
    let outcome = cv::dry_run(DryRunOptions {
        at: &at,
        source: &copy,
        out: &dry,
        v3_root: Some(&n),
        allow_real_data_root: false,
        real_data_root: Some(real),
        secrets_check: None,
        accept_unconvertible: &[],
        keep_data: false,
        quiesce: &mut || Quiesce::Quiet,
        after_copy: &mut || {},
    });
    println!("dry-run ({:.1}s):", t.elapsed().as_secs_f64());
    match &outcome {
        Ok(DryRun::Verified {
            business_digest,
            pending,
        }) => println!(
            "  VERIFIED: {} business families, pending {pending:?}",
            business_digest.len()
        ),
        Ok(DryRun::VerifyFailed(failures)) => {
            println!("  VERIFY FAILED: {} failures", failures.len());
            for f in failures {
                println!("    {f}");
            }
        }
        other => println!("  {other:?}"),
    }
    summarize(&dry.join("report.json"));

    // 3. 完整转换
    let t = Instant::now();
    let layout = Layout::new(n.clone());
    let m = cv::run(
        &layout,
        RunOptions {
            at: &at,
            generation: GENERATION,
            legacy_root: &copy,
            allow_real_data_root: false,
            real_data_root: Some(real),
            secrets_check: None,
            accept_unconvertible: &[],
            hook: &mut |_| true,
            progress: None,
        },
    );
    println!("run ({:.1}s):", t.elapsed().as_secs_f64());
    let m = match m {
        Ok(m) => m,
        Err(e) => {
            println!("  FAILED: {e}");
            summarize(
                &layout
                    .root
                    .join("staging")
                    .join(GENERATION)
                    .join("report.json"),
            );
            std::process::exit(1);
        }
    };
    println!(
        "  {} generation {}, {} business families, published {:?}",
        m.phase.as_str(),
        m.generation,
        m.business_digest.len(),
        m.published_at
    );
    match cv::decide(&layout, true) {
        cv::Startup::Published(_) => println!("  decide: Published"),
        other => println!("  decide: {other:?}"),
    }
    let cmp = cv::compare(
        &layout,
        &m,
        &m.business_digest,
        &CompareOptions {
            legacy_root: &copy,
            allow_real_data_root: false,
            real_data_root: Some(real),
            secrets_check: None,
        },
    );
    match cmp {
        cv::Comparison::Unchanged(_) => println!("  compare with the copy: Unchanged"),
        other => println!("  compare with the copy: {other:?}"),
    }
    let db = Connection::open(layout.database()).unwrap();
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

/// `root\rel` 下全部文件的相对路径（`/` 分隔）。
fn walk(root: &Path, rel: &str, out: &mut Vec<String>) {
    let path = root.join(rel);
    let Ok(meta) = fs::symlink_metadata(&path) else {
        return;
    };
    if meta.is_dir() {
        let mut names: Vec<String> = fs::read_dir(&path)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        for n in names {
            walk(root, &format!("{rel}/{n}"), out);
        }
    } else {
        out.push(rel.to_string());
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
