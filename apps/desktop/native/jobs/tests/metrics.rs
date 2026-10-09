//! 工程指标的采集与刷新（W5h2；03 `metrics.capture` / `metrics.refresh`、C-08、P-014；2.x
//! `engineering-metrics-observer.ts`、`work-item-commands.ts:160-233`、`session-commands.ts:239`）。
//!
//! 任务操作走真实的服务写入；扫描对着真实的 git 仓库（项目的源码目录）。

#[path = "../../service/tests/support/mod.rs"]
mod support;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use atm_domain::error::ErrorCode;
use atm_domain::principal::{JobId, Principal};
use atm_domain::work::Operation;
use atm_jobs::metrics::{MetricsCapture, capture_once};
use atm_service::metrics::{PROJECT_METRICS_KEPT, Signal};
use atm_service::session::{EndRequest, Outcome};
use atm_service::work::{Target, VerifyAndComplete};
use serde_json::Value;
use support::*;

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.invalid",
            "-c",
            "core.autocrlf=false",
        ])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn head(dir: &Path) -> String {
    atm_metrics::git_head(dir).unwrap()
}

/// 给项目 PA 一个源码目录：一个有一次提交的 git 仓库。
fn with_repo(w: &World) -> PathBuf {
    let repo = w.dir.join("repo");
    std::fs::create_dir_all(repo.join("src")).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("src/lib.rs"), "fn a() {}\n").unwrap();
    commit(&repo, "first");
    let path = repo.to_string_lossy().into_owned();
    w.exec(&format!(
        "INSERT INTO project_paths (id, project_id, path_key, canonical_path, is_primary, last_seen_at)
         VALUES ('PP1', 'PA', '{}', '{path}', 1, '{T0}')",
        path.to_lowercase()
    ));
    repo
}

fn commit(repo: &Path, message: &str) {
    git(repo, &["add", "-A"]);
    git(repo, &["commit", "-q", "-m", message]);
}

/// 收集服务交出来的信号。
fn collect(w: &World) -> Arc<Mutex<Vec<Signal>>> {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    w.svc
        .set_metrics_sink(Some(Arc::new(move |s| sink.lock().unwrap().push(s))));
    seen
}

fn signal(keys: &[&str], establish: bool) -> Signal {
    Signal {
        project_id: "PA".into(),
        task_keys: keys.iter().map(|k| (*k).to_owned()).collect(),
        establish,
    }
}

fn job() -> Principal {
    Principal::system_job(JobId::MetricsCapture)
}

/// (baseline, payload) of a task's metrics row.
fn task_row(w: &World, key: &str) -> Option<(String, Value)> {
    let no: i64 = key.rsplit('-').next().unwrap().parse().unwrap();
    w.svc
        .store()
        .read(move |tx| {
            use rusqlite::OptionalExtension;
            tx.query_row(
                "SELECT m.baseline_ref, m.payload_json FROM engineering_work_item_metrics m
                 JOIN work_items t ON t.project_id = m.project_id AND t.id = m.work_item_id
                 WHERE t.project_id = 'PA' AND t.local_no = ?1",
                [no],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
            )
            .optional()
        })
        .unwrap()
        .map(|(b, p)| {
            (
                b,
                p.map_or(Value::Null, |p| serde_json::from_str(&p).unwrap()),
            )
        })
}

fn metric_rows(w: &World) -> (i64, i64) {
    (
        w.count("SELECT count(*) FROM engineering_project_metrics"),
        w.count("SELECT count(*) FROM engineering_work_item_metrics"),
    )
}

/// 2.x 的触发点：claim / start 记 baseline，complete / cancel、verify_and_complete、atm_end 释放的任务补扫；
/// 其他操作、重放、失败的写入都不交信号。
#[test]
fn signals_follow_the_2_0_operations() {
    let w = world("metrics-signals");
    let seen = collect(&w);
    let (a, b, c, d) = (w.task("一"), w.task("二"), w.task("三"), w.task("四"));
    let take = || std::mem::take(&mut *seen.lock().unwrap());
    assert!(take().is_empty(), "creating tasks sends nothing");

    w.s1(p(&a, Operation::Claim)).unwrap();
    assert_eq!(take(), [signal(&[&a], true)]);
    w.s1(p(&a, Operation::Start)).unwrap();
    assert_eq!(take(), [signal(&[&a], true)]);
    w.s1(p(&a, Operation::Verify)).unwrap();
    assert!(take().is_empty(), "verify sends nothing");
    w.s1(p(&a, Operation::Complete)).unwrap();
    assert_eq!(take(), [signal(&[&a], false)]);

    // 一批里既有开始也有结束：各一个信号。
    w.s1(p(&b, Operation::Start)).unwrap();
    take();
    let op = w.next_op();
    let mut cancel = p(&b, Operation::Cancel);
    cancel.expected_version = Some(w.version(&b));
    let batch = vec![p(&c, Operation::Start), cancel];
    w.svc
        .patch_work_items(
            &agent(),
            &Target::new("PA", Some("S1"), op.clone()),
            batch.clone(),
        )
        .unwrap();
    assert_eq!(take(), [signal(&[&c], true), signal(&[&b], false)]);
    // 同一个 op_id 重放：不再交。
    let replay = w
        .svc
        .patch_work_items(&agent(), &Target::new("PA", Some("S1"), op), batch)
        .unwrap();
    assert!(replay.replayed);
    assert!(take().is_empty(), "a replay sends nothing");
    // 失败的写入不交。
    assert!(w.s1(p(&a, Operation::Start)).is_err());
    assert!(take().is_empty());
    // release 不补扫（2.x 一样）。
    w.s1(p(&c, Operation::Release)).unwrap();
    assert!(take().is_empty());

    w.svc
        .verify_and_complete(
            &agent(),
            &w.target(Some("S1")),
            VerifyAndComplete {
                task_key: c.clone(),
                expected_version: None,
            },
        )
        .unwrap();
    assert_eq!(take(), [signal(&[&c], false)]);

    // atm_end 释放领取：补扫被释放的任务。
    w.s1(p(&d, Operation::Claim)).unwrap();
    take();
    w.svc
        .end_session(
            &agent(),
            &w.target(Some("S1")),
            EndRequest {
                outcome: Outcome::Completed,
                summary: "收工".into(),
                next: vec![],
                release_claims: true,
                retirement_reason: None,
                git: None,
            },
        )
        .unwrap();
    assert_eq!(take(), [signal(&[&d], false)]);

    // 撤掉去处之后什么都不交，也不出错。
    w.svc.set_metrics_sink(None);
    w.s1(p(&a, Operation::Reopen)).ok();
    assert!(take().is_empty());
}

/// baseline 在开始时当场记、只记一次；结束时从 baseline 量到工作区，项目指标太旧就顺带重扫。
#[test]
fn the_baseline_is_taken_at_start_and_changes_are_measured_at_finish() {
    let w = world("metrics-capture");
    let repo = with_repo(&w);
    let k = w.task("要量的");
    let first = head(&repo);

    // 没有 baseline 的任务结束：任务不扫；还没有项目指标，项目顺带扫一次。
    let other = w.task("没开始过");
    let r = capture_once(&w.svc, &signal(&[&other], false)).unwrap();
    assert!(r.scanned.is_empty(), "{r:?}");
    assert!(r.project_scanned);
    assert!(task_row(&w, &other).is_none());
    assert_eq!(metric_rows(&w), (1, 0));
    // 项目指标过了 5 分钟才在下一次结束时重扫。
    w.exec("UPDATE engineering_project_metrics SET captured_at = '2020-01-01T00:00:00.000Z'");

    let r = capture_once(&w.svc, &signal(&[&k, &k], true)).unwrap();
    assert_eq!(
        (r.baselines, r.scanned.clone()),
        (1, vec![k.clone()]),
        "{r:?}"
    );
    assert!(!r.project_scanned, "starting does not scan the project");
    let (baseline, metrics) = task_row(&w, &k).unwrap();
    assert_eq!(baseline, first);
    assert_eq!(metrics["linesAdded"], 0);

    // 工作继续：新提交加一个文件、工作区再加一个未跟踪的。
    std::fs::write(repo.join("src/more.rs"), "fn b() {}\nfn c() {}\n").unwrap();
    commit(&repo, "second");
    std::fs::write(repo.join("src/new.rs"), "fn d() {}\n").unwrap();
    // 再次 start 不改 baseline。
    let r = capture_once(&w.svc, &signal(&[&k], true)).unwrap();
    assert_eq!(r.baselines, 0);
    assert_eq!(task_row(&w, &k).unwrap().0, first);

    let r = capture_once(&w.svc, &signal(&[&k], false)).unwrap();
    assert!(r.errors.is_empty(), "{r:?}");
    assert!(
        r.project_scanned,
        "the project metrics were stale: scanned at finish"
    );
    let (baseline, metrics) = task_row(&w, &k).unwrap();
    assert_eq!(baseline, first);
    assert_eq!(metrics["baseline"], first);
    assert_eq!(metrics["head"], head(&repo));
    assert_eq!(
        (
            metrics["filesCreated"].clone(),
            metrics["linesAdded"].clone()
        ),
        (2.into(), 3.into())
    );
    assert_eq!(metric_rows(&w), (2, 1));

    // 5 分钟内再结束一个：项目指标不重扫。
    let r = capture_once(&w.svc, &signal(&[&k], false)).unwrap();
    assert!(!r.project_scanned);
    assert_eq!(metric_rows(&w).0, 2);

    // 项目没有源码目录：什么都不做。
    w.exec("DELETE FROM project_paths");
    let r = capture_once(&w.svc, &signal(&[&k], false)).unwrap();
    assert_eq!(r, Default::default());
}

/// C-08 / P-014：读只返回已存的值（不扫、不写）；刷新只有 User 与 job `metrics.capture`。
#[test]
fn reading_has_no_side_effects_and_refreshing_is_user_or_capture_only() {
    let w = world("metrics-refresh");
    let k = w.task("任务");
    // 没有源码目录。
    for p in [user(), agent()] {
        let v = w.svc.metrics_read(&p, "ATM", None).unwrap();
        assert_eq!(
            (v["available"].clone(), v["reason"].clone()),
            (false.into(), "NO_SOURCE_PATH".into())
        );
    }
    assert_eq!(
        w.svc.metrics_refresh(&user(), "ATM", None).unwrap()["reason"],
        "NO_SOURCE_PATH"
    );

    let repo = with_repo(&w);
    let before = w.snapshot();
    let v = w.svc.metrics_read(&agent(), "ATM", Some(&k)).unwrap();
    assert_eq!(
        (v["available"].clone(), v["reason"].clone()),
        (false.into(), "NO_DATA".into())
    );
    assert_eq!(w.snapshot(), before, "a read writes nothing");

    // Agent 不能刷新、不能采集；maintenance、update.check 也不能。都是零变化。
    let e = w
        .svc
        .metrics_capture(&agent(), &signal(&[&k], true))
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::USER_AUTHORIZATION_REQUIRED, "{e:?}");
    let e = w.svc.metrics_refresh(&agent(), "ATM", None).unwrap_err();
    assert_eq!(e.code, ErrorCode::USER_AUTHORIZATION_REQUIRED, "{e:?}");
    for job in [JobId::Maintenance, JobId::UpdateCheck] {
        let e = w
            .svc
            .metrics_refresh(&Principal::system_job(job), "ATM", None)
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::PRINCIPAL_CAPABILITY_DENIED, "{e:?}");
    }
    assert_eq!(w.snapshot(), before);

    // User 刷新：当场扫项目，给了任务键再扫任务（没有 baseline 就以当前 HEAD 记一个）。
    let v = w
        .svc
        .metrics_refresh(&user(), "atm", Some(&k.to_lowercase()))
        .unwrap();
    assert_eq!(v["available"], true, "{v}");
    assert_eq!(v["project"]["sourceLoc"], 1);
    assert_eq!(v["project"]["head"], head(&repo));
    assert_eq!(v["workItem"]["baseline"], head(&repo));
    assert_eq!(v["workItem"]["metrics"]["linesAdded"], 0);
    // 之后的读拿到的就是这一份。
    let read = w.svc.metrics_read(&agent(), "ATM", Some(&k)).unwrap();
    assert_eq!(read["project"], v["project"]);
    assert_eq!(read["workItem"], v["workItem"]);
    // job metrics.capture 也能刷新。
    w.svc.metrics_refresh(&job(), "ATM", None).unwrap();
    assert_eq!(metric_rows(&w).0, 2);

    // 找不到的项目、任务：与读一样的错误。
    assert_eq!(
        w.svc
            .metrics_refresh(&user(), "NOPE", None)
            .unwrap_err()
            .code,
        ErrorCode::PROJECT_NOT_FOUND
    );
    assert_eq!(
        w.svc
            .metrics_refresh(&user(), "ATM", Some("ATM-T-999"))
            .unwrap_err()
            .code,
        ErrorCode::WORK_ITEM_NOT_FOUND
    );
    // 源码目录不是 git 仓库：不是错误，回 METRICS_FAILED 与说明，什么都不写。
    std::fs::remove_dir_all(repo.join(".git")).unwrap();
    std::fs::write(repo.join(".git"), "gitdir: does-not-exist\n").unwrap();
    let before = metric_rows(&w);
    let v = w.svc.metrics_refresh(&user(), "ATM", None).unwrap();
    assert_eq!(v["reason"], "METRICS_FAILED", "{v}");
    assert!(
        v["message"]
            .as_str()
            .unwrap()
            .starts_with("GIT_METRICS_FAILED")
    );
    assert_eq!(metric_rows(&w), before);
}

/// 每个项目只留最新的 120 条项目指标。
#[test]
fn project_metrics_keep_the_latest_rows() {
    let w = world("metrics-kept");
    with_repo(&w);
    for n in 0..PROJECT_METRICS_KEPT + 5 {
        w.exec(&format!(
            "INSERT INTO engineering_project_metrics (project_id, id, git_head, captured_at, payload_json)
             VALUES ('PA', 'M{n:04}', 'h', '2026-01-01T00:{:02}:{:02}.000Z', '{{}}')",
            n / 60,
            n % 60
        ));
    }
    w.svc.metrics_refresh(&user(), "ATM", None).unwrap();
    assert_eq!(metric_rows(&w).0, PROJECT_METRICS_KEPT);
    // 删掉的是最旧的 6 条（刚扫的那一条最新）。
    assert_eq!(
        w.count(
            "SELECT count(*) FROM engineering_project_metrics WHERE id LIKE 'M%' AND id < 'M0006'"
        ),
        0
    );
    assert_eq!(
        w.count("SELECT count(*) FROM engineering_project_metrics WHERE id = 'M0006'"),
        1
    );
}

/// 线程：服务交来的信号在后台处理，任务操作不等它；停下之后撤掉去处。
#[test]
fn the_capture_thread_measures_in_the_background_and_stops() {
    let w = world("metrics-thread");
    with_repo(&w);
    let (k, j) = (w.task("后台量"), w.task("停下之后"));
    let svc = Arc::new(w.svc);
    let capture = MetricsCapture::start(svc.clone());
    svc.patch_work_items(
        &agent(),
        &Target::new("PA", Some("S1"), "op-thread-1"),
        vec![p(&k, Operation::Start)],
    )
    .unwrap();
    let rows = |svc: &atm_service::write::Service| -> i64 {
        svc.store()
            .read(|tx| {
                tx.query_row(
                    "SELECT count(*) FROM engineering_work_item_metrics WHERE payload_json IS NOT NULL",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap()
    };
    let deadline = Instant::now() + Duration::from_secs(30);
    while rows(&svc) == 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(rows(&svc), 1);
    let t = Instant::now();
    capture.stop();
    assert!(t.elapsed() < Duration::from_secs(20));
    // 停下之后的任务操作照常提交，不再采集。
    svc.patch_work_items(
        &agent(),
        &Target::new("PA", Some("S1"), "op-thread-2"),
        vec![p(&j, Operation::Start)],
    )
    .unwrap();
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(rows(&svc), 1);
}
