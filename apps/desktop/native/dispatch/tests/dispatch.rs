//! 派单器（2.x `test/dispatcher.test.ts`、`cancel.test.ts`、`closing.test.ts`、`auth.test.ts`）：用例真的拉起
//! `atm-fake-claude.exe`，核对参数、stdin、工作目录、日志、环境剥离、结局、并发、取消与关闭。

mod support;

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use atm_dispatch::errors::{CLAUDE_LOGIN_REQUIRED_MESSAGE, Error};
use atm_dispatch::process::{Native, Probe as _};
use serde_json::json;
use support::*;

fn code(e: Error) -> String {
    e.code().to_owned()
}

#[test]
fn every_refusal_has_its_own_code() {
    let w = world("refusals");
    let key = w.seed_task("ATM", "第一个");
    let d = w.dispatcher();
    // 默认关闭。
    assert_eq!(
        code(d.enqueue(&user(), &desktop(&key)).unwrap_err()),
        "DISPATCH_DISABLED"
    );
    w.enable(&d, json!({}));
    assert_eq!(
        code(d.enqueue(&user(), &desktop("atm-t-1")).unwrap_err()),
        "DISPATCH_INVALID_ARGUMENT"
    );
    let mut other = desktop("OTHER-T-0001");
    other.project = "NOPE".into();
    assert_eq!(
        code(d.enqueue(&user(), &other).unwrap_err()),
        "DISPATCH_PROJECT_NOT_FOUND"
    );
    other.project = "OTHER".into();
    let e = d.enqueue(&user(), &other).unwrap_err();
    assert_eq!(code(e.clone()), "DISPATCH_PROJECT_PATH_MISSING");
    assert!(e.message().contains("没有绑定工作目录"));
    let mut wrong = desktop("OTHER-T-0001");
    wrong.project = "ATM".into();
    assert_eq!(
        code(d.enqueue(&user(), &wrong).unwrap_err()),
        "DISPATCH_TASK_NOT_FOUND"
    );
    assert_eq!(
        code(d.enqueue(&user(), &desktop("ATM-T-9999")).unwrap_err()),
        "DISPATCH_TASK_NOT_FOUND"
    );
    w.sql(
        "UPDATE work_items SET status = 'IN_PROGRESS' WHERE local_no = 1 AND project_id = 'P1'",
        &[],
    );
    let e = d.enqueue(&user(), &desktop(&key)).unwrap_err();
    assert_eq!(code(e.clone()), "DISPATCH_TASK_NOT_READY");
    assert!(e.message().contains("IN_PROGRESS"));
    w.sql(
        "UPDATE work_items SET status = 'READY', claimed_by_session_id = 'S-OTHER', claim_lease_until = '2999-01-01T00:00:00.000Z' WHERE local_no = 1 AND project_id = 'P1'",
        &[],
    );
    let e = d.enqueue(&user(), &desktop(&key)).unwrap_err();
    assert!(e.message().contains("S-OTHER"), "{e}");
    w.sql("UPDATE work_items SET claimed_by_session_id = NULL, claim_lease_until = NULL WHERE project_id = 'P1'", &[]);
    *w.claude.lock().unwrap() = None;
    assert_eq!(
        code(d.enqueue(&user(), &desktop(&key)).unwrap_err()),
        "DISPATCH_CLAUDE_NOT_FOUND"
    );
    *w.claude.lock().unwrap() = Some(FAKE_CLAUDE.into());
    w.behave(json!({ "mode": "slow", "delayMs": 3000 }));
    let first = d.enqueue(&user(), &desktop(&key)).unwrap();
    let again = d.enqueue(&user(), &desktop(&key)).unwrap_err();
    assert_eq!(code(again.clone()), "DISPATCH_ALREADY_ACTIVE");
    let reap = Reap(vec![]);
    let run = first["run"].as_str().unwrap().to_owned();
    wait_state(&d, &run, "running");
    d.cancel(&user(), &run).unwrap();
    drop(reap);
    assert_eq!(w.spawns(), 1);
    d.close();
    assert_eq!(
        code(d.enqueue(&user(), &desktop(&key)).unwrap_err()),
        "DISPATCH_CLOSED"
    );
}

#[test]
fn a_successful_session_gets_its_arguments_prompt_cwd_logs_and_a_clean_environment() {
    let w = world("success");
    let key = w.seed_task("ATM", "Claude 自动派单\n（agent-dispatch）");
    let d = w.dispatcher();
    w.enable(&d, json!({ "model": "claude-opus-5-5", "effort": "high" }));
    let changes = Arc::new(AtomicUsize::new(0));
    let seen = changes.clone();
    d.on_change(Arc::new(move |p| {
        if p == Some("ATM") {
            seen.fetch_add(1, Ordering::SeqCst);
        }
    }));
    let view = d
        .enqueue(
            &phone("cmd-1"),
            &mobile(&key, &command_id(atm_sync::time::now_ms(), 1)),
        )
        .unwrap();
    assert_eq!(view["state"], "queued");
    assert_eq!(view["origin"], "mobile");
    for hidden in ["cwd", "requestedBy", "pid", "processIdentity", "requestId"] {
        assert!(!view.contains_key(hidden), "{hidden}");
    }
    let run = view["run"].as_str().unwrap().to_owned();
    let done = wait_state(&d, &run, "succeeded");
    let dump = w.dump(&run);
    let session = view["sessionId"].as_str().unwrap();
    let args: Vec<&str> = dump["args"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a.as_str().unwrap())
        .collect();
    assert_eq!(
        args,
        [
            "-p",
            "--permission-mode",
            "auto",
            "--output-format",
            "stream-json",
            "--verbose",
            "--session-id",
            session,
            "--name",
            &format!("ATM · {key}"),
            "--model",
            "claude-opus-5-5",
            "--effort",
            "high"
        ]
    );
    let stdin = dump["stdin"].as_str().unwrap();
    assert!(stdin.contains("用户在 ATM 手机端（Pixel 9）点名"));
    assert!(stdin.contains(&format!("- 任务：{key} Claude 自动派单 （agent-dispatch）")));
    assert!(stdin.contains("- 项目：项目 ATM（ATM）"));
    assert!(stdin.contains(&format!("- 派单编号：{run}")));
    assert_eq!(Path::new(dump["cwd"].as_str().unwrap()), w.work.as_path());
    let names: Vec<String> = dump["envNames"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_str().unwrap().to_uppercase())
        .collect();
    assert!(!names.contains(&"CLAUDECODE".to_owned()));
    assert!(!names.contains(&"CLAUDE_CODE_ENTRYPOINT".to_owned()));
    assert_eq!(dump["env"]["ATM_DISPATCH_RUN"], run.as_str());
    assert_eq!(dump["env"]["KEEP_DISPATCH_VALUE"], "kept");
    // detached + windowsHide：没有继承宿主（用例进程）的控制台，窗口要求隐藏（SW_HIDE = 0）。
    assert_eq!(dump["console"], false);
    assert_eq!(dump["showWindow"], 0);
    // 日志落盘；摘要从 result 行来，按 500 字截断。
    let log = std::fs::read_to_string(w.logs.join(format!("{run}.jsonl"))).unwrap();
    assert!(log.contains("\"type\":\"result\""));
    let summary = &done["summary"];
    assert_eq!(summary["numTurns"], 3);
    assert_eq!(summary["durationMs"], 1234);
    assert_eq!(summary["result"].as_str().unwrap().chars().count(), 500);
    assert_eq!(done["exitCode"], 0);
    assert!(done.contains_key("taskId"));
    // 排队、运行、结束各一次变化。
    wait_for(|| changes.load(Ordering::SeqCst) >= 3, "三次变化");
    // 库里有这一行与它的账本条目。
    assert_eq!(
        w.count("SELECT COUNT(*) FROM dispatch_runs WHERE state = 'succeeded'"),
        1
    );
    assert_eq!(
        w.count(
            "SELECT COUNT(*) FROM dispatch_requests WHERE run_snapshot_json LIKE '%succeeded%'"
        ),
        1
    );
    d.close();
}

#[test]
fn failures_are_judged_from_exit_code_stderr_and_result_lines() {
    let w = world("failures");
    let key = w.seed_task("ATM", "t");
    let d = w.dispatcher();
    w.enable(&d, json!({}));
    let cases = [
        ("fail", "进程退出（exit code 2）：fake-claude: boom", false),
        ("api-error", "API Error: 529 overloaded_error", false),
        ("error-result", CLAUDE_LOGIN_REQUIRED_MESSAGE, true),
        ("auth-stderr", CLAUDE_LOGIN_REQUIRED_MESSAGE, true),
    ];
    for (mode, error, _auth) in cases {
        w.behave(json!({ "mode": mode }));
        let view = d.enqueue(&user(), &desktop(&key)).unwrap();
        let run = view["run"].as_str().unwrap().to_owned();
        let done = wait_state(&d, &run, "failed");
        assert_eq!(done["error"], error, "{mode}");
    }
    // 最后一次是鉴权失败：它让登录缓存失效，下一次派单重新探。
    let before = w.auth_probes();
    w.behave(json!({ "mode": "success" }));
    let view = d.enqueue(&user(), &desktop(&key)).unwrap();
    wait_state(&d, view["run"].as_str().unwrap(), "succeeded");
    assert!(w.auth_probes() > before);
    d.close();
}

#[test]
fn a_session_that_cannot_start_fails_and_the_next_one_still_runs() {
    let w = world("spawn-fail");
    let key = w.seed_task("ATM", "t");
    let d = w.dispatcher();
    w.enable(&d, json!({}));
    *w.spawner.fail_next.lock().unwrap() = Some("拒绝访问".into());
    let view = d.enqueue(&user(), &desktop(&key)).unwrap();
    let done = wait_state(&d, view["run"].as_str().unwrap(), "failed");
    assert_eq!(done["error"], "启动失败：拒绝访问");
    let view = d.enqueue(&user(), &desktop(&key)).unwrap();
    wait_state(&d, view["run"].as_str().unwrap(), "succeeded");
    d.close();
}

#[test]
fn concurrency_limits_hold_the_second_session_until_a_slot_frees() {
    let w = world("concurrency");
    let a = w.seed_task("ATM", "a");
    let b = w.seed_task("ATM", "b");
    let c = w.seed_task("ATM", "c");
    let d = w.dispatcher();
    w.enable(&d, json!({}));
    w.behave(json!({ "mode": "slow", "delayMs": 1500 }));
    let ra = d.enqueue(&user(), &desktop(&a)).unwrap()["run"]
        .as_str()
        .unwrap()
        .to_owned();
    let rb = d.enqueue(&user(), &desktop(&b)).unwrap()["run"]
        .as_str()
        .unwrap()
        .to_owned();
    wait_state(&d, &ra, "running");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        d.list_runs()
            .iter()
            .find(|v| v["run"] == rb.as_str())
            .unwrap()["state"],
        "queued"
    );
    wait_state(&d, &ra, "succeeded");
    wait_state(&d, &rb, "running");
    wait_state(&d, &rb, "succeeded");
    // 上限 2：两个同时跑。
    w.enable(&d, json!({ "maxConcurrent": 2 }));
    let ra = d.enqueue(&user(), &desktop(&a)).unwrap()["run"]
        .as_str()
        .unwrap()
        .to_owned();
    let rc = d.enqueue(&user(), &desktop(&c)).unwrap()["run"]
        .as_str()
        .unwrap()
        .to_owned();
    wait_state(&d, &ra, "running");
    wait_state(&d, &rc, "running");
    wait_state(&d, &ra, "succeeded");
    wait_state(&d, &rc, "succeeded");
    assert_eq!(w.spawns(), 4);
    d.close();
}

#[test]
fn cancelling_kills_the_whole_tree_and_queued_runs_are_cancelled_directly() {
    let w = world("cancel");
    let a = w.seed_task("ATM", "a");
    let b = w.seed_task("ATM", "b");
    let d = w.dispatcher();
    w.enable(&d, json!({}));
    w.behave(json!({ "mode": "tree", "delayMs": 60000 }));
    let ra = d.enqueue(&user(), &desktop(&a)).unwrap()["run"]
        .as_str()
        .unwrap()
        .to_owned();
    let rb = d.enqueue(&user(), &desktop(&b)).unwrap()["run"]
        .as_str()
        .unwrap()
        .to_owned();
    wait_state(&d, &ra, "running");
    let dump = w.dump(&ra);
    let (pid, grandchild) = (
        dump["pid"].as_u64().unwrap() as u32,
        dump["grandchild"].as_u64().unwrap() as u32,
    );
    let _reap = Reap(vec![pid, grandchild]);
    // 排队中的直接取消。
    let cancelled = d.cancel(&user(), &rb).unwrap();
    assert_eq!(cancelled["state"], "cancelled");
    assert_eq!(cancelled["error"], "用户取消");
    let view = d.cancel(&user(), &ra).unwrap();
    assert_eq!(view["state"], "cancelled");
    wait_for(
        || !Native.is_alive(pid) && !Native.is_alive(grandchild),
        "进程树结束",
    );
    assert_eq!(
        code(d.cancel(&user(), &ra).unwrap_err()),
        "DISPATCH_RUN_NOT_ACTIVE"
    );
    assert_eq!(
        code(d.cancel(&user(), "zzz-00000000").unwrap_err()),
        "DISPATCH_RUN_NOT_FOUND"
    );
    // 结束途中进程自己退出：退出码记下，结局仍是取消。
    std::thread::sleep(Duration::from_millis(200));
    let final_view = d
        .list_runs()
        .into_iter()
        .find(|v| v["run"] == ra.as_str())
        .unwrap();
    assert_eq!(final_view["state"], "cancelled");
    assert_eq!(w.spawns(), 1);
    d.close();
}

#[test]
fn a_failed_kill_keeps_the_run_and_its_slot_until_a_retry_succeeds() {
    let w = world("cancel-fail");
    let a = w.seed_task("ATM", "a");
    let b = w.seed_task("ATM", "b");
    let d = w.dispatcher();
    w.enable(&d, json!({}));
    w.behave(json!({ "mode": "slow", "delayMs": 60000 }));
    let ra = d.enqueue(&user(), &desktop(&a)).unwrap()["run"]
        .as_str()
        .unwrap()
        .to_owned();
    wait_state(&d, &ra, "running");
    let pid = w.dump(&ra)["pid"].as_u64().unwrap() as u32;
    let _reap = Reap(vec![pid]);
    let rb = d.enqueue(&user(), &desktop(&b)).unwrap()["run"]
        .as_str()
        .unwrap()
        .to_owned();
    *w.probe.kill_fails.lock().unwrap() = Some("拒绝访问".into());
    let e = d.cancel(&user(), &ra).unwrap_err();
    assert_eq!(code(e.clone()), "DISPATCH_CANCEL_FAILED");
    assert!(e.dispatch().unwrap().retryable());
    assert_eq!(
        d.list_runs()
            .iter()
            .find(|v| v["run"] == ra.as_str())
            .unwrap()["state"],
        "running"
    );
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(
        d.list_runs()
            .iter()
            .find(|v| v["run"] == rb.as_str())
            .unwrap()["state"],
        "queued"
    );
    *w.probe.kill_fails.lock().unwrap() = None;
    assert_eq!(d.cancel(&user(), &ra).unwrap()["state"], "cancelled");
    wait_state(&d, &rb, "running");
    d.cancel(&user(), &rb).unwrap();
    d.close();
}

#[test]
fn concurrent_cancels_share_one_kill() {
    let w = world("cancel-twice");
    let a = w.seed_task("ATM", "a");
    let d = w.dispatcher();
    w.enable(&d, json!({}));
    w.behave(json!({ "mode": "slow", "delayMs": 60000 }));
    let ra = d.enqueue(&user(), &desktop(&a)).unwrap()["run"]
        .as_str()
        .unwrap()
        .to_owned();
    wait_state(&d, &ra, "running");
    let _reap = Reap(vec![w.dump(&ra)["pid"].as_u64().unwrap() as u32]);
    let threads: Vec<_> = (0..3)
        .map(|_| {
            let (d, ra) = (d.clone(), ra.clone());
            std::thread::spawn(move || d.cancel(&user(), &ra))
        })
        .collect();
    let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    let ok = results.iter().filter(|r| r.is_ok()).count();
    assert!(ok >= 1);
    for r in &results {
        if let Err(e) = r {
            assert_eq!(e.code(), "DISPATCH_RUN_NOT_ACTIVE");
        }
    }
    assert_eq!(w.probe.kills.lock().unwrap().len(), 1);
    d.close();
}

#[test]
fn turning_dispatch_off_cancels_the_queue_and_lets_the_running_one_finish() {
    let w = world("disable");
    let a = w.seed_task("ATM", "a");
    let b = w.seed_task("ATM", "b");
    let d = w.dispatcher();
    w.enable(&d, json!({}));
    w.behave(json!({ "mode": "slow", "delayMs": 800 }));
    let ra = d.enqueue(&user(), &desktop(&a)).unwrap()["run"]
        .as_str()
        .unwrap()
        .to_owned();
    let rb = d.enqueue(&user(), &desktop(&b)).unwrap()["run"]
        .as_str()
        .unwrap()
        .to_owned();
    wait_state(&d, &ra, "running");
    d.update_config(&user(), &json!({ "enabled": false }))
        .unwrap();
    let b_view = d
        .list_runs()
        .into_iter()
        .find(|v| v["run"] == rb.as_str())
        .unwrap();
    assert_eq!(b_view["state"], "cancelled");
    assert_eq!(b_view["error"], "派单已关闭");
    wait_state(&d, &ra, "succeeded");
    d.close();
}

#[test]
fn a_task_claimed_while_queued_is_cancelled_with_the_reason() {
    let w = world("claimed-while-queued");
    let a = w.seed_task("ATM", "a");
    let b = w.seed_task("ATM", "b");
    let d = w.dispatcher();
    w.enable(&d, json!({}));
    w.behave(json!({ "mode": "slow", "delayMs": 600 }));
    let ra = d.enqueue(&user(), &desktop(&a)).unwrap()["run"]
        .as_str()
        .unwrap()
        .to_owned();
    let rb = d.enqueue(&user(), &desktop(&b)).unwrap()["run"]
        .as_str()
        .unwrap()
        .to_owned();
    wait_state(&d, &ra, "running");
    w.sql(
        "UPDATE work_items SET claimed_by_session_id = 'S-9', claim_lease_until = '2999-01-01T00:00:00.000Z' WHERE local_no = 2 AND project_id = 'P1'",
        &[],
    );
    let b_view = wait_state(&d, &rb, "cancelled");
    assert_eq!(
        b_view["error"],
        "排队期间任务状态已变化：任务已被会话 S-9 领取"
    );
    assert_eq!(w.spawns(), 1);
    d.close();
}

#[test]
fn a_cached_logged_out_state_is_rechecked_before_refusing() {
    let w = world("auth");
    let key = w.seed_task("ATM", "t");
    let d = w.dispatcher();
    w.enable(&d, json!({}));
    w.auth("out");
    let s = d.status(&user()).unwrap();
    assert_eq!(s["claude"]["loggedIn"], false);
    assert_eq!(s["claude"]["version"], "9.9.9 (Fake Claude)");
    assert_eq!(s["claude"]["authMethod"], "none");
    // 缓存说未登录：派单前强制重探；用户刚在终端登录完就能直接派。
    w.auth("in");
    let probes = w.auth_probes();
    let view = d.enqueue(&user(), &desktop(&key)).unwrap();
    assert_eq!(w.auth_probes(), probes + 1);
    wait_state(&d, view["run"].as_str().unwrap(), "succeeded");
    // 仍未登录：拒绝，不排队。
    w.auth("out");
    let fresh = w.dispatcher();
    let e = fresh.enqueue(&user(), &desktop(&key)).unwrap_err();
    assert_eq!(code(e), "DISPATCH_CLAUDE_NOT_LOGGED_IN");
    // 探不出来（输出看不懂）：不挡派单。
    w.auth("garbage");
    let other = w.dispatcher();
    let view = other.enqueue(&user(), &desktop(&key)).unwrap();
    wait_state(&other, view["run"].as_str().unwrap(), "succeeded");
    d.close();
    fresh.close();
    other.close();
}

#[test]
fn closing_while_the_login_probe_hangs_ends_the_enqueue_at_once() {
    let w = world("closing");
    let key = w.seed_task("ATM", "t");
    let d = w.dispatcher();
    w.enable(&d, json!({}));
    w.auth("hang");
    let d2 = d.clone();
    let k2 = key.clone();
    let id = command_id(atm_sync::time::now_ms(), 7);
    let id2 = id.clone();
    let t = std::thread::spawn(move || d2.enqueue(&phone("c"), &mobile(&k2, &id2)));
    std::thread::sleep(Duration::from_millis(300));
    let started = Instant::now();
    d.close();
    let e = t.join().unwrap().unwrap_err();
    assert_eq!(code(e), "DISPATCH_CLOSED");
    assert!(started.elapsed() < Duration::from_secs(2));
    // 不记账本、不排队、不起会话。
    assert_eq!(w.count("SELECT COUNT(*) FROM dispatch_requests"), 0);
    assert_eq!(w.count("SELECT COUNT(*) FROM dispatch_runs"), 0);
    assert_eq!(w.spawns(), 0);
    // 同一条命令在下次启动照常办理。
    w.auth("in");
    let next = w.dispatcher();
    let view = next.enqueue(&phone("c"), &mobile(&key, &id)).unwrap();
    wait_state(&next, view["run"].as_str().unwrap(), "succeeded");
    next.close();
}

#[test]
fn the_status_reports_the_claude_install_and_the_ledger() {
    let w = world("status");
    let d = w.dispatcher();
    let s = d.status(&user()).unwrap();
    assert_eq!(s["enabled"], false);
    assert_eq!(s["claude"]["found"], true);
    assert_eq!(s["runs"], json!([]));
    assert_eq!(
        s["requestLedger"],
        json!({ "lostBefore": null, "lostUntil": null, "unavailable": false })
    );
    *w.claude.lock().unwrap() = None;
    let s = d.status(&user()).unwrap();
    assert_eq!(
        s["claude"],
        json!({ "found": false, "path": null, "loggedIn": null })
    );
    d.close();
}
