//! 宿主重启与请求账本（2.x `residual.test.ts`、`request-ledger.test.ts`、`ledger-recovery.test.ts`；05 M-08）：
//! 在途会话被新实例接管、身份不符的不碰；同一个命令 ID 只起一次会话；账本坏了设水位线、读不出来 503。

mod support;

use std::time::Duration;

use atm_dispatch::process::{Native, Probe as _};
use serde_json::json;
use support::*;

fn run_of(v: &serde_json::Map<String, serde_json::Value>) -> String {
    v["run"].as_str().unwrap().to_owned()
}

#[test]
fn m08_a_session_left_running_is_adopted_after_a_restart_and_judged_when_it_ends() {
    let w = world("adopt");
    let key = w.seed_task("ATM", "t");
    let first = w.dispatcher();
    w.enable(&first, json!({}));
    w.behave(json!({ "mode": "slow", "delayMs": 1500 }));
    let run = run_of(&first.enqueue(&user(), &desktop(&key)).unwrap());
    wait_state(&first, &run, "running");
    let pid = w.dump(&run)["pid"].as_u64().unwrap() as u32;
    let _reap = Reap(vec![pid]);
    // 宿主退出：会话照常跑，派单器不再跟它。
    first.close();
    assert!(Native.is_alive(pid));
    let identity: String = {
        let c = rusqlite::Connection::open(&w.db).unwrap();
        c.query_row(
            "SELECT process_identity FROM dispatch_runs WHERE run = ?1",
            [&run],
            |r| r.get(0),
        )
        .unwrap()
    };
    assert_eq!(Some(identity.clone()), Native.identity(pid));
    assert!(identity.starts_with("win32:"));
    let second = w.dispatcher();
    // 接管后照常算并发：同一任务不能再派。
    assert_eq!(
        second.enqueue(&user(), &desktop(&key)).unwrap_err().code(),
        "DISPATCH_ALREADY_ACTIVE"
    );
    let done = wait_state(&second, &run, "succeeded");
    assert_eq!(done["summary"]["numTurns"], 3);
    // 没有重新拉起。
    assert_eq!(w.spawns(), 1);
    second.close();
}

#[test]
fn m08_a_pid_with_another_birth_mark_is_never_touched() {
    let w = world("adopt-different");
    let key = w.seed_task("ATM", "t");
    let first = w.dispatcher();
    w.enable(&first, json!({}));
    w.behave(json!({ "mode": "slow", "delayMs": 60000 }));
    let run = run_of(&first.enqueue(&user(), &desktop(&key)).unwrap());
    wait_state(&first, &run, "running");
    let pid = w.dump(&run)["pid"].as_u64().unwrap() as u32;
    let _reap = Reap(vec![pid]);
    first.close();
    // PID 被复用：出生标识只差 100 ns。
    let real = Native.identity(pid).unwrap();
    let n: u64 = real.strip_prefix("win32:").unwrap().parse().unwrap();
    *w.probe.identity_override.lock().unwrap() = Some((pid, Some(format!("win32:{}", n + 1))));
    let second = w.dispatcher();
    let done = second
        .list_runs()
        .into_iter()
        .find(|v| v["run"] == run.as_str())
        .unwrap();
    assert_eq!(done["state"], "failed");
    assert!(
        done["error"]
            .as_str()
            .unwrap()
            .starts_with("宿主重启时会话已结束；")
    );
    // 新进程（这里就是原来那个）没有被结束。
    std::thread::sleep(Duration::from_millis(300));
    assert!(Native.is_alive(pid));
    assert!(w.probe.kills.lock().unwrap().is_empty());
    second.close();
}

#[test]
fn m08_an_unknown_identity_is_neither_adopted_nor_killed() {
    let w = world("adopt-unknown");
    let key = w.seed_task("ATM", "t");
    let first = w.dispatcher();
    w.enable(&first, json!({}));
    w.behave(json!({ "mode": "slow", "delayMs": 60000 }));
    let run = run_of(&first.enqueue(&user(), &desktop(&key)).unwrap());
    wait_state(&first, &run, "running");
    let pid = w.dump(&run)["pid"].as_u64().unwrap() as u32;
    let _reap = Reap(vec![pid]);
    first.close();
    w.sql("UPDATE dispatch_runs SET process_identity = NULL", &[]);
    let second = w.dispatcher();
    let done = second
        .list_runs()
        .into_iter()
        .find(|v| v["run"] == run.as_str())
        .unwrap();
    assert_eq!(done["state"], "failed");
    assert_eq!(
        done["error"],
        format!(
            "宿主重启后无法确认 Claude 进程身份（PID {pid}），已停止跟踪，没有结束该进程；如仍在运行可在任务管理器里手动结束"
        )
    );
    assert!(Native.is_alive(pid));
    assert!(w.probe.kills.lock().unwrap().is_empty());
    second.close();
}

#[test]
fn an_adopted_session_whose_identity_stays_unreadable_is_released_untouched() {
    let w = world("adopt-lost");
    let key = w.seed_task("ATM", "t");
    let first = w.dispatcher();
    w.enable(&first, json!({}));
    w.behave(json!({ "mode": "slow", "delayMs": 60000 }));
    let run = run_of(&first.enqueue(&user(), &desktop(&key)).unwrap());
    wait_state(&first, &run, "running");
    let pid = w.dump(&run)["pid"].as_u64().unwrap() as u32;
    let _reap = Reap(vec![pid]);
    first.close();
    let second = w.dispatcher();
    assert_eq!(second.list_runs()[0]["state"], "running");
    // 接管之后查不到出生标识：连续三次就停止跟踪，记失败，不结束进程。
    *w.probe.identity_override.lock().unwrap() = Some((pid, None));
    let done = wait_state(&second, &run, "failed");
    assert!(
        done["error"]
            .as_str()
            .unwrap()
            .starts_with("接管后连续几次无法确认 Claude 进程身份")
    );
    assert!(Native.is_alive(pid));
    assert!(w.probe.kills.lock().unwrap().is_empty());
    second.close();
}

#[test]
fn cancelling_an_adopted_session_rechecks_its_identity_first() {
    let w = world("adopt-cancel");
    let key = w.seed_task("ATM", "t");
    let first = w.dispatcher();
    w.enable(&first, json!({}));
    w.behave(json!({ "mode": "tree", "delayMs": 60000 }));
    let run = run_of(&first.enqueue(&user(), &desktop(&key)).unwrap());
    wait_state(&first, &run, "running");
    let dump = w.dump(&run);
    let (pid, grandchild) = (
        dump["pid"].as_u64().unwrap() as u32,
        dump["grandchild"].as_u64().unwrap() as u32,
    );
    let _reap = Reap(vec![pid, grandchild]);
    first.close();
    let second = w.dispatcher();
    // 核验不了：拒绝结束，派单保持运行。
    *w.probe.identity_override.lock().unwrap() = Some((pid, None));
    let e = second.cancel(&user(), &run).unwrap_err();
    assert_eq!(e.code(), "DISPATCH_CANCEL_FAILED");
    assert!(w.probe.kills.lock().unwrap().is_empty());
    assert_eq!(second.list_runs()[0]["state"], "running");
    // 核验一致：结束整棵树。
    *w.probe.identity_override.lock().unwrap() = None;
    assert_eq!(second.cancel(&user(), &run).unwrap()["state"], "cancelled");
    support::wait_for(
        || !Native.is_alive(pid) && !Native.is_alive(grandchild),
        "进程树结束",
    );
    second.close();
}

#[test]
fn queued_runs_left_by_the_previous_host_are_cancelled_not_launched() {
    let w = world("leftover-queue");
    let a = w.seed_task("ATM", "a");
    let b = w.seed_task("ATM", "b");
    let first = w.dispatcher();
    w.enable(&first, json!({}));
    w.behave(json!({ "mode": "slow", "delayMs": 800 }));
    let ra = run_of(&first.enqueue(&user(), &desktop(&a)).unwrap());
    let rb = run_of(
        &first
            .enqueue(
                &phone("c1"),
                &mobile(&b, &command_id(atm_sync::time::now_ms(), 2)),
            )
            .unwrap(),
    );
    wait_state(&first, &ra, "running");
    let _reap = Reap(vec![w.dump(&ra)["pid"].as_u64().unwrap() as u32]);
    first.close();
    // 新实例：跟踪作业只核对、定结局，不会把上次的排队派单拉起来（没有启动授权）。
    let second = w.dispatcher();
    let b_view = second
        .list_runs()
        .into_iter()
        .find(|v| v["run"] == rb.as_str())
        .unwrap();
    assert_eq!(b_view["state"], "cancelled");
    assert_eq!(
        b_view["error"],
        "ATM 重启前这次派单还在排队，没有启动：需要的话请重新交给 Claude"
    );
    wait_state(&second, &ra, "succeeded");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(w.spawns(), 1);
    // 账本里那条命令的快照也跟着变成取消。
    assert_eq!(
        w.count(
            "SELECT COUNT(*) FROM dispatch_requests WHERE run_snapshot_json LIKE '%cancelled%'"
        ),
        1
    );
    second.close();
}

#[test]
fn one_request_id_starts_one_session_even_when_sent_twice_at_once_and_after_a_restart() {
    let w = world("ledger-once");
    let key = w.seed_task("ATM", "t");
    let d = w.dispatcher();
    w.enable(&d, json!({}));
    w.behave(json!({ "mode": "slow", "delayMs": 300 }));
    let id = command_id(atm_sync::time::now_ms(), 9);
    let threads: Vec<_> = (0..3)
        .map(|_| {
            let (d, id, key) = (d.clone(), id.clone(), key.clone());
            std::thread::spawn(move || d.enqueue(&phone("c"), &mobile(&key, &id)))
        })
        .collect();
    let views: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    let runs: Vec<String> = views
        .iter()
        .map(|v| match v {
            Ok(v) => run_of(v),
            Err(e) => panic!("{e}"),
        })
        .collect();
    assert!(runs.windows(2).all(|p| p[0] == p[1]), "{runs:?}");
    wait_state(&d, &runs[0], "succeeded");
    assert_eq!(w.spawns(), 1);
    // 不带 requestId 的桌面派单不受影响。
    let desk = run_of(&d.enqueue(&user(), &desktop(&key)).unwrap());
    assert_ne!(desk, runs[0]);
    wait_state(&d, &desk, "succeeded");
    d.close();
    // 新实例读同一个库：仍幂等。
    let again = w.dispatcher();
    let replay = again.enqueue(&phone("c"), &mobile(&key, &id)).unwrap();
    assert_eq!(replay["run"], runs[0].as_str());
    assert_eq!(replay["state"], "succeeded");
    assert_eq!(w.spawns(), 2);
    again.close();
}

#[test]
fn a_rejection_is_remembered_and_never_turns_into_a_session_later() {
    let w = world("ledger-reject");
    let key = w.seed_task("ATM", "t");
    let d = w.dispatcher();
    let id = command_id(atm_sync::time::now_ms(), 3);
    let e = d.enqueue(&phone("c"), &mobile(&key, &id)).unwrap_err();
    assert_eq!(e.code(), "DISPATCH_DISABLED");
    w.enable(&d, json!({}));
    let e = d.enqueue(&phone("c"), &mobile(&key, &id)).unwrap_err();
    assert_eq!(e.code(), "DISPATCH_DISABLED");
    assert_eq!(
        e.dispatch().unwrap().details.as_ref().unwrap()["requestId"],
        id.as_str()
    );
    assert_eq!(w.spawns(), 0);
    // 新命令照常派。
    let fresh = command_id(atm_sync::time::now_ms(), 4);
    let view = d.enqueue(&phone("c"), &mobile(&key, &fresh)).unwrap();
    wait_state(&d, &run_of(&view), "succeeded");
    d.close();
}

#[test]
fn a_damaged_ledger_row_sets_a_watermark_and_older_unknown_commands_are_refused() {
    let w = world("ledger-damaged");
    let key = w.seed_task("ATM", "t");
    let before = atm_sync::time::now_ms() - 60_000;
    w.sql(
        "INSERT INTO dispatch_requests (id, at, run_snapshot_json) VALUES ('broken', ?1, '[1]')",
        &[&atm_sync::time::iso(before)],
    );
    let d = w.dispatcher();
    w.enable(&d, json!({}));
    let lost = d.status(&user()).unwrap()["requestLedger"].clone();
    assert!(lost["lostBefore"].is_string());
    assert_eq!(
        w.count("SELECT COUNT(*) FROM dispatch_requests WHERE id = 'broken'"),
        0
    );
    assert_eq!(
        w.count("SELECT COUNT(*) FROM dispatch_meta WHERE lost_before IS NOT NULL"),
        1
    );
    // 水位线之前发出、账本里查不到：无法确认是否执行过，拒绝，不记账。
    let e = d
        .enqueue(&phone("c"), &mobile(&key, &command_id(before, 5)))
        .unwrap_err();
    assert_eq!(e.code(), "DISPATCH_REQUEST_STATE_LOST");
    assert_eq!(w.count("SELECT COUNT(*) FROM dispatch_requests"), 0);
    // 之后发出的照常派。
    std::thread::sleep(Duration::from_millis(5));
    let view = d
        .enqueue(
            &phone("c"),
            &mobile(&key, &command_id(atm_sync::time::now_ms(), 6)),
        )
        .unwrap();
    wait_state(&d, &run_of(&view), "succeeded");
    assert_eq!(w.spawns(), 1);
    d.close();
}

#[test]
fn an_unreadable_ledger_answers_503_until_it_can_be_read() {
    let w = world("ledger-unreadable");
    let key = w.seed_task("ATM", "t");
    let d = w.dispatcher();
    w.enable(&d, json!({}));
    w.sql(
        "ALTER TABLE dispatch_requests RENAME TO dispatch_requests_away",
        &[],
    );
    let restarted = w.dispatcher();
    let id = command_id(atm_sync::time::now_ms(), 8);
    let e = restarted
        .enqueue(&phone("c"), &mobile(&key, &id))
        .unwrap_err();
    assert_eq!(e.code(), "DISPATCH_LEDGER_UNAVAILABLE");
    assert!(e.dispatch().unwrap().retryable());
    assert_eq!(
        restarted.status(&user()).unwrap()["requestLedger"]["unavailable"],
        true
    );
    // 桌面派单不经账本，照常。
    let desk = restarted.enqueue(&user(), &desktop(&key)).unwrap();
    wait_state(&restarted, &run_of(&desk), "succeeded");
    w.sql(
        "ALTER TABLE dispatch_requests_away RENAME TO dispatch_requests",
        &[],
    );
    let view = restarted.enqueue(&phone("c"), &mobile(&key, &id)).unwrap();
    wait_state(&restarted, &run_of(&view), "succeeded");
    assert_eq!(w.spawns(), 2);
    d.close();
    restarted.close();
}

#[test]
fn history_keeps_fifty_runs_and_their_logs() {
    let w = world("history");
    let key = w.seed_task("ATM", "t");
    let d = w.dispatcher();
    w.enable(&d, json!({}));
    w.behave(json!({ "mode": "fail" }));
    let mut runs = Vec::new();
    for _ in 0..52 {
        let run = run_of(&d.enqueue(&user(), &desktop(&key)).unwrap());
        wait_state(&d, &run, "failed");
        runs.push(run);
    }
    let listed = d.list_runs();
    assert_eq!(listed.len(), 50);
    assert_eq!(listed[0]["run"], runs[51].as_str());
    assert_eq!(w.count("SELECT COUNT(*) FROM dispatch_runs"), 50);
    for old in &runs[..2] {
        assert!(!w.logs.join(format!("{old}.jsonl")).exists());
        assert!(!w.logs.join(format!("{old}.stderr.log")).exists());
    }
    assert!(w.logs.join(format!("{}.stderr.log", runs[51])).exists());
    d.close();
}

#[test]
fn r5_a_run_whose_task_was_undone_by_a_restore_says_so() {
    let w = world("r5");
    let key = w.seed_task("ATM", "t");
    let d = w.dispatcher();
    w.enable(&d, json!({}));
    let run = run_of(&d.enqueue(&user(), &desktop(&key)).unwrap());
    wait_state(&d, &run, "succeeded");
    let status = d.status(&user()).unwrap();
    assert_eq!(status["runs"][0]["targetUndone"], false);
    let task_id = status["runs"][0]["taskId"].as_str().unwrap().to_owned();
    // 回执同时存公开 key 与实体 id。
    assert_eq!(
        w.count(&format!(
            "SELECT COUNT(*) FROM dispatch_runs WHERE task_key = '{key}' AND task_id = '{task_id}'"
        )),
        1
    );
    // 按范围恢复撤销了这个任务（这里直接删掉那一行来模拟）。
    w.sql_batch(&format!(
        "PRAGMA foreign_keys = OFF; DELETE FROM work_items WHERE id = '{task_id}';"
    ));
    assert_eq!(d.status(&user()).unwrap()["runs"][0]["targetUndone"], true);
    d.close();
}
