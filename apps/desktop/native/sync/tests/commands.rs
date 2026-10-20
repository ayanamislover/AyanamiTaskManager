//! 手机命令端到端（2.x `connector-commands.test.ts`、`dispatch-replay.test.ts` 的连接器部分；03 P-008、C-05）：
//! 真实服务、内存中继、连接器，手机一侧用配对码读写同一个空间。

mod support;

use std::sync::Arc;
use std::time::Duration;

use atm_sync::dispatch::DispatchPort;
use atm_sync_protocol::keys::command_key;
use serde_json::{Value, json};
use support::world::{FakeDispatch, Opts, connect, phone_for, requests_for, user, wait_for, world};

const DAY: i64 = 24 * 60 * 60 * 1000;

fn events(w: &support::world::World, code: &str) -> Vec<(String, String, String)> {
    let code = code.to_owned();
    w.service
        .store()
        .read(move |tx| {
            let mut st = tx.prepare(
                "SELECT e.type, e.actor_type, e.actor_id FROM events e JOIN projects p ON p.id = e.project_id
                 WHERE p.code = ?1 ORDER BY e.seq",
            )?;
            st.query_map([&code], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap()
}

#[test]
fn task_create_runs_as_the_phone_and_acks_before_deleting_the_command() {
    let w = world("cmd-create", &[("PA", "ALPHA", true)]);
    let c = w.connector();
    let pairing = connect(&c, &w.relay);
    let phone = phone_for(&w.relay, &pairing);
    let id = phone.send(json!({
        "type": "task.create",
        "body": { "project": "ALPHA", "title": "  手机建的任务 ", "description": "路上想到的", "priority": "HIGH" },
    }));
    let ack = phone.await_ack(&id);
    assert_eq!(
        (ack["ok"].clone(), ack["result"]["project"].clone()),
        (json!(true), json!("ALPHA"))
    );
    let key = ack["result"]["key"].as_str().unwrap().to_owned();
    let task = w.task("ALPHA", &key);
    assert_eq!(task["title"], "手机建的任务");
    assert_eq!(task["description"], "路上想到的");
    assert_eq!(task["priority"], "HIGH");
    assert_eq!(task["status"], "READY");
    assert_eq!(task["objectiveId"], "O-PA");
    // 2.x 的手机任务只带 objectiveId，不挂 milestone。
    assert_eq!(task["milestoneId"], Value::Null);
    // 03 C-05：写入者记为 PHONE:<设备>（事件的 actor_type 是 USER）。
    let created: Vec<_> = events(&w, "ALPHA")
        .into_iter()
        .filter(|e| e.0 == "work.created")
        .collect();
    assert_eq!(
        created,
        [(
            "work.created".to_owned(),
            "USER".to_owned(),
            "PHONE:m-0123456789ab".to_owned()
        )]
    );
    let cmd = command_key(&phone.space_id, &id).unwrap();
    wait_for(|| !w.relay.state().docs.contains_key(&cmd), "命令被删掉");
    // 回执先于删命令。
    let order: Vec<String> = requests_for(&w.relay, &id)
        .into_iter()
        .filter(|(m, _)| m != "GET")
        .map(|(m, k)| format!("{m} {}", k.split('/').nth(2).unwrap()))
        .collect();
    let put_ack = order.iter().position(|o| o == "PUT ack").unwrap();
    let del_cmd = order.iter().position(|o| o == "DELETE cmd").unwrap();
    assert!(put_ack < del_cmd, "{order:?}");
    // 已处理集合记在库里。
    assert!(c.config().processed.contains(&id));
    // 新任务随后进快照。
    wait_for(
        || {
            let Some(head) = phone.store.read_head().unwrap() else {
                return false;
            };
            let Some(h) = head["projects"][0]["h"].as_str() else {
                return false;
            };
            phone.store.read_project(h).unwrap().is_some_and(|d| {
                d["tasks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|t| t["key"] == key)
            })
        },
        "新任务进入快照",
    );
    c.stop();
}

#[test]
fn a_replayed_command_never_creates_a_second_task() {
    let w = world("cmd-replay", &[("PA", "ALPHA", true)]);
    let c = w.connector();
    let pairing = connect(&c, &w.relay);
    let phone = phone_for(&w.relay, &pairing);
    let id = phone.send(
        json!({ "type": "task.create", "body": { "project": "ALPHA", "title": "只该有一个" } }),
    );
    let first = phone.await_ack(&id);
    let key = first["result"]["key"].as_str().unwrap().to_owned();
    let cmd = command_key(&phone.space_id, &id).unwrap();
    wait_for(|| !w.relay.state().docs.contains_key(&cmd), "命令被删掉");
    // 第一道：已处理集合。重放只被删掉，不再执行，也不重写回执。
    let doc = json!({
        "v": 1, "id": id, "device": { "id": phone.device.id, "name": phone.device.name },
        "at": first["at"], "type": "task.create", "body": { "project": "ALPHA", "title": "只该有一个" },
    });
    let mark = w.relay.request_count();
    phone.store.write_object(&cmd, &doc, true).unwrap();
    wait_for(
        || !w.relay.state().docs.contains_key(&cmd),
        "重放命令被删掉",
    );
    assert_eq!(w.task_keys("ALPHA"), std::slice::from_ref(&key));
    assert!(
        w.relay
            .puts_since(mark)
            .iter()
            .all(|k| !k.contains("/ack/")),
        "重放不重写回执"
    );

    // 第二道：忘掉已处理集合、删掉旧回执再重放——op_id 幂等返回同一个任务。
    c.stop();
    let mut ledger = w.service.sync_ledger(&user()).unwrap().unwrap();
    ledger.processed.clear();
    w.service.save_sync_ledger(&user(), &ledger).unwrap();
    phone.store.delete_ack(&id).unwrap();
    phone.store.write_object(&cmd, &doc, true).unwrap();
    let again = w.connector();
    again.start().unwrap();
    let second = phone.await_ack(&id);
    assert_eq!(second["result"]["key"], json!(key));
    assert_eq!(w.task_keys("ALPHA"), [key]);
    again.stop();
}

#[test]
fn expired_future_and_forged_commands_are_refused() {
    let w = world("cmd-time", &[("PA", "ALPHA", true)]);
    let c = w.connector();
    let pairing = connect(&c, &w.relay);
    let phone = phone_for(&w.relay, &pairing);
    let now = atm_sync::time::now_ms();
    let stale = phone.send_at(
        json!({ "type": "task.create", "body": { "project": "ALPHA", "title": "八天前发的" } }),
        now - 8 * DAY,
    );
    let ack = phone.await_ack(&stale);
    assert_eq!(
        (ack["ok"].clone(), ack["error"]["code"].clone()),
        (json!(false), json!("COMMAND_EXPIRED"))
    );
    let future = phone.send_at(
        json!({ "type": "task.create", "body": { "project": "ALPHA", "title": "两天后" } }),
        now + 2 * DAY,
    );
    assert_eq!(phone.await_ack(&future)["error"]["code"], "COMMAND_INVALID");
    // 命令 ID 里的时间是现在，明文 at 却是一小时前：对不上。
    let id = atm_sync_protocol::keys::new_command_id(&phone.device.id, now as u64).unwrap();
    let forged = json!({
        "v": 1, "id": id, "device": { "id": phone.device.id, "name": "手机" },
        "at": atm_sync::time::iso(now - 60 * 60 * 1000), "type": "task.create", "body": { "project": "ALPHA", "title": "改了时间" },
    });
    phone
        .store
        .write_object(&command_key(&phone.space_id, &id).unwrap(), &forged, true)
        .unwrap();
    assert_eq!(phone.await_ack(&id)["error"]["code"], "COMMAND_INVALID");
    // 别的设备名下的 ID。
    let other = atm_sync_protocol::keys::new_command_id("m-ffffffffffff", now as u64).unwrap();
    let foreign = json!({
        "v": 1, "id": other, "device": { "id": phone.device.id, "name": "手机" },
        "at": atm_sync::time::iso(now), "type": "task.create", "body": { "project": "ALPHA", "title": "冒名" },
    });
    phone
        .store
        .write_object(
            &command_key(&phone.space_id, &other).unwrap(),
            &foreign,
            true,
        )
        .unwrap();
    assert_eq!(phone.await_ack(&other)["error"]["code"], "COMMAND_INVALID");
    assert!(w.task_keys("ALPHA").is_empty());
    c.stop();
}

#[test]
fn a_project_without_objectives_gets_a_planning_root_and_missing_projects_fail() {
    let w = world("cmd-root", &[("PB", "BARE", false), ("PR", "OLD", true)]);
    w.service
        .store()
        .write(|tx| {
            tx.execute(
                "UPDATE projects SET lifecycle = 'ARCHIVED' WHERE id = 'PR'",
                [],
            )
        })
        .unwrap();
    let c = w.connector();
    let pairing = connect(&c, &w.relay);
    let phone = phone_for(&w.relay, &pairing);
    let id = phone.send(json!({ "type": "task.create", "body": { "project": "BARE", "title": "新项目的第一个任务" } }));
    let ack = phone.await_ack(&id);
    assert_eq!(ack["ok"], true, "{ack}");
    let objectives = w.service.ui_objectives(&user(), "BARE").unwrap();
    let objectives = objectives.as_array().unwrap();
    assert_eq!(objectives.len(), 1);
    assert!(
        objectives[0]["title"]
            .as_str()
            .unwrap()
            .contains("自动补建")
    );
    assert_eq!(
        w.task_keys("BARE"),
        [ack["result"]["key"].as_str().unwrap().to_owned()]
    );
    // 与 2.x `ensurePlanningRoot` 一样连「执行」milestone 一起补建，任务只挂目标、不挂 milestone。
    let milestones = w.service.ui_milestones(&user(), "BARE", None).unwrap();
    let milestones = milestones.as_array().unwrap();
    assert_eq!(milestones.len(), 1, "{milestones:?}");
    assert_eq!(milestones[0]["title"], "执行");
    assert_eq!(milestones[0]["objective_id"], objectives[0]["id"]);
    let task = w.task("BARE", ack["result"]["key"].as_str().unwrap());
    assert_eq!(task["objectiveId"], objectives[0]["id"]);
    assert_eq!(task["milestoneId"], Value::Null);
    for (code, title) in [("NOPE", "没有这个项目"), ("OLD", "已归档")] {
        let id = phone
            .send(json!({ "type": "task.create", "body": { "project": code, "title": title } }));
        assert_eq!(
            phone.await_ack(&id)["error"]["code"],
            "PROJECT_NOT_FOUND",
            "{code}"
        );
    }
    c.stop();
}

#[test]
fn dispatch_goes_through_the_port_with_the_phone_and_the_command_id() {
    let w = world("cmd-dispatch", &[("PA", "ALPHA", true)]);
    let accepted = Arc::new(FakeDispatch::default());
    let c = w.connector_with(Opts {
        dispatch: Some(accepted.clone() as Arc<dyn DispatchPort>),
        ..Default::default()
    });
    let pairing = connect(&c, &w.relay);
    let phone = phone_for(&w.relay, &pairing);
    let id = phone.send(json!({ "type": "task.create", "body": { "project": "ALPHA", "title": "交给 Claude", "dispatch": true } }));
    let ack = phone.await_ack(&id);
    assert_eq!(
        ack["result"]["dispatch"],
        json!({ "run": "run-1", "state": "queued" })
    );
    let key = ack["result"]["key"].as_str().unwrap().to_owned();
    {
        let calls = accepted.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        let (input, phone_principal) = &calls[0];
        assert_eq!(
            (input.project.as_str(), input.key.as_str()),
            ("ALPHA", key.as_str())
        );
        assert_eq!(input.requested_by.as_deref(), Some("测试手机"));
        assert_eq!(input.request_id.as_deref(), Some(id.as_str()));
        assert_eq!(
            phone_principal.as_ref().unwrap(),
            &(phone.space_id.clone(), phone.device.id.clone(), id.clone())
        );
    }
    c.stop();

    let rejected = Arc::new(FakeDispatch {
        reject: Some(("DISPATCH_DISABLED".into(), "派单未开启".into())),
        ..Default::default()
    });
    let c = w.connector_with(Opts {
        dispatch: Some(rejected.clone() as Arc<dyn DispatchPort>),
        ..Default::default()
    });
    c.start().unwrap();
    let again = phone.send(json!({ "type": "task.create", "body": { "project": "ALPHA", "title": "派不出去", "dispatch": true } }));
    let refused = phone.await_ack(&again);
    assert_eq!(refused["ok"], true);
    assert_eq!(
        refused["result"]["dispatchError"],
        json!({ "code": "DISPATCH_DISABLED", "message": "派单未开启" })
    );
    assert!(refused["result"].get("dispatch").is_none());
    assert_eq!(w.task_keys("ALPHA").len(), 2);
    // task.dispatch 被拒就是整条失败，码照实透传。
    let only =
        phone.send(json!({ "type": "task.dispatch", "body": { "project": "ALPHA", "key": key } }));
    assert_eq!(phone.await_ack(&only)["error"]["code"], "DISPATCH_DISABLED");
    c.stop();
}

#[test]
fn without_a_dispatcher_create_reports_unavailable_and_dispatch_fails() {
    let w = world("cmd-nodispatch", &[("PA", "ALPHA", true)]);
    let existing = w.seed_task("ALPHA", "已有任务");
    let c = w.connector();
    let pairing = connect(&c, &w.relay);
    let phone = phone_for(&w.relay, &pairing);
    let id = phone.send(json!({ "type": "task.create", "body": { "project": "ALPHA", "title": "想派单", "dispatch": true } }));
    assert_eq!(
        phone.await_ack(&id)["result"]["dispatchError"]["code"],
        "DISPATCH_UNAVAILABLE"
    );
    let d = phone
        .send(json!({ "type": "task.dispatch", "body": { "project": "ALPHA", "key": existing } }));
    assert_eq!(phone.await_ack(&d)["error"]["code"], "DISPATCH_UNAVAILABLE");
    let unknown = phone.send(
        json!({ "type": "task.dispatch", "body": { "project": "ALPHA", "key": "ALPHA-T-9999" } }),
    );
    assert_eq!(phone.await_ack(&unknown)["error"]["code"], "TASK_NOT_FOUND");
    c.stop();
}

/// 派单器已随宿主退出关闭：这一批就此打住，后面的命令不执行、不写回执，都留给下次启动。
#[test]
fn a_closed_dispatcher_defers_the_rest_of_the_batch() {
    let w = world("cmd-deferred", &[("PA", "ALPHA", true)]);
    let c = w.connector();
    let pairing = connect(&c, &w.relay);
    let phone = phone_for(&w.relay, &pairing);
    c.stop();
    let closed = Arc::new(FakeDispatch {
        reject: Some(("DISPATCH_CLOSED".into(), "派单器已关闭".into())),
        ..Default::default()
    });
    // 命令 ID 以毫秒时间开头、后缀随机：同一毫秒发出的两条谁先被列出不一定，所以错开 5 ms。
    let now = atm_sync::time::now_ms();
    let first = phone.send_at(json!({ "type": "task.dispatch", "body": { "project": "ALPHA", "key": w.seed_task("ALPHA", "已有") } }), now);
    let second = phone.send_at(
        json!({ "type": "task.create", "body": { "project": "ALPHA", "title": "后面那条" } }),
        now + 5,
    );
    let c = w.connector_with(Opts {
        dispatch: Some(closed.clone() as Arc<dyn DispatchPort>),
        ..Default::default()
    });
    c.start().unwrap();
    wait_for(|| !closed.calls.lock().unwrap().is_empty(), "派单被调用");
    std::thread::sleep(std::time::Duration::from_millis(200));
    c.sync_now();
    for id in [&first, &second] {
        assert!(phone.store.read_ack(id).unwrap().is_none(), "{id} 不写回执");
        assert!(
            w.relay
                .state()
                .docs
                .contains_key(&command_key(&phone.space_id, id).unwrap()),
            "{id} 留在中继上"
        );
    }
    assert_eq!(w.task_keys("ALPHA").len(), 1, "后面那条没有执行");
    c.stop();
    // 下次启动派单器正常：两条都处理。
    let c = w.connector_with(Opts {
        dispatch: Some(Arc::new(FakeDispatch::default()) as Arc<dyn DispatchPort>),
        ..Default::default()
    });
    c.start().unwrap();
    assert_eq!(phone.await_ack(&first)["ok"], true);
    assert_eq!(phone.await_ack(&second)["ok"], true);
    c.stop();
}

#[test]
fn commands_sent_while_stopped_are_found_by_listing_on_start() {
    let w = world("cmd-offline", &[("PA", "ALPHA", true)]);
    let c = w.connector();
    let pairing = connect(&c, &w.relay);
    let phone = phone_for(&w.relay, &pairing);
    c.stop();
    let id = phone.send(
        json!({ "type": "task.create", "body": { "project": "ALPHA", "title": "电脑关着时发的" } }),
    );
    // 清空变更记录：只能靠启动时列 cmd 兜底。
    w.relay.state().changes.clear();
    let c = w.connector();
    c.start().unwrap();
    assert_eq!(phone.await_ack(&id)["ok"], true);
    c.stop();
}

/// 回执写失败：命令留在待处理里稍后整条重做，op_id 让它拿回同一个任务，只补写回执。
#[test]
fn a_failed_ack_write_is_retried_without_a_second_task() {
    let w = world("cmd-ackfail", &[("PA", "ALPHA", true)]);
    let c = w.connector();
    let pairing = connect(&c, &w.relay);
    let phone = phone_for(&w.relay, &pairing);
    w.relay
        .state()
        .faults
        .push(("PUT", "/ack/".into(), 503, "INTERNAL".into()));
    let id = phone.send(json!({ "type": "task.create", "body": { "project": "ALPHA", "title": "回执第一次写不进去" } }));
    let ack = phone.await_ack(&id);
    assert_eq!(ack["ok"], true);
    assert_eq!(w.task_keys("ALPHA").len(), 1);
    let puts = requests_for(&w.relay, &format!("/ack/{id}"))
        .into_iter()
        .filter(|(m, _)| m == "PUT")
        .count();
    assert_eq!(puts, 2, "第一次失败，第二次成功");
    c.stop();
}

/// 没有目标的项目，回执第一次写失败：第一次在建任务的事务里补建了规划根，重做时请求不能因此变样
/// （目标不进请求），拿回的是同一个任务，不是 IDEMPOTENCY_CONFLICT（W7 r1 P1-01）。
#[test]
fn a_failed_ack_write_after_a_planning_root_returns_the_same_task() {
    let w = world("cmd-ackfail-root", &[("PB", "BARE", false)]);
    let c = w.connector();
    let pairing = connect(&c, &w.relay);
    let phone = phone_for(&w.relay, &pairing);
    w.relay
        .state()
        .faults
        .push(("PUT", "/ack/".into(), 503, "INTERNAL".into()));
    let id = phone.send(json!({ "type": "task.create", "body": { "project": "BARE", "title": "新项目，回执第一次写不进去" } }));
    let ack = phone.await_ack(&id);
    let keys = w.task_keys("BARE");
    let objectives = w.service.ui_objectives(&user(), "BARE").unwrap();
    let puts = requests_for(&w.relay, &format!("/ack/{id}"))
        .into_iter()
        .filter(|(m, _)| m == "PUT")
        .count();
    c.stop();
    assert_eq!(ack["ok"], true, "{ack}");
    assert_eq!(keys.len(), 1, "{keys:?}");
    assert_eq!(ack["result"]["key"], keys[0]);
    assert_eq!(
        objectives.as_array().unwrap().len(),
        1,
        "只补建一次：{objectives}"
    );
    assert_eq!(puts, 2, "第一次失败，第二次成功");
}

/// 手机的任务挂在按创建顺序第一个 ACTIVE 的目标下（2.x 与桌面「新建任务」同一规则），不是最近更新的那个；
/// 两次尝试之间目标变了（第一个被取消），重做拿回的仍是第一次建的那条（W7 r1 P1-01）。
#[test]
fn the_first_active_objective_is_chosen_once_even_if_objectives_change_before_the_retry() {
    let w = world("cmd-ackfail-objectives", &[("PA", "ALPHA", true)]);
    w.service
        .store()
        .write(|tx| {
            tx.execute(
                "INSERT INTO objectives (project_id, id, local_no, title, status, created_at, updated_at) VALUES ('PA', 'O-PA2', 2, '后建的目标', 'ACTIVE', '2026-10-02T00:00:00.000Z', '2026-10-03T00:00:00.000Z')",
                [],
            )
        })
        .unwrap();
    // 退避的那一次等待：任务已经建出来、回执写失败之后，把第一个目标取消，再让它重做。
    let service = w.service.clone();
    let flipped = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flip = flipped.clone();
    let sleep: atm_sync::transport::Sleeper = Arc::new(move |d| {
        let tasks: i64 = service
            .store()
            .write(|tx| {
                tx.query_row(
                    "SELECT count(*) FROM work_items WHERE project_id = 'PA'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        if tasks > 0 && !flip.swap(true, std::sync::atomic::Ordering::SeqCst) {
            service
                .store()
                .write(|tx| {
                    tx.execute(
                        "UPDATE objectives SET status = 'CANCELLED' WHERE id = 'O-PA'",
                        [],
                    )
                })
                .unwrap();
        }
        std::thread::sleep(d.min(Duration::from_millis(5)));
        true
    });
    let c = w.connector_with(Opts {
        sleep: Some(sleep),
        ..Default::default()
    });
    let pairing = connect(&c, &w.relay);
    let phone = phone_for(&w.relay, &pairing);
    w.relay
        .state()
        .faults
        .push(("PUT", "/ack/".into(), 503, "INTERNAL".into()));
    let id = phone.send(json!({ "type": "task.create", "body": { "project": "ALPHA", "title": "目标在重做之前变了" } }));
    let ack = phone.await_ack(&id);
    let keys = w.task_keys("ALPHA");
    c.stop();
    assert!(
        flipped.load(std::sync::atomic::Ordering::SeqCst),
        "两次尝试之间取消了第一个目标"
    );
    assert_eq!(ack["ok"], true, "{ack}");
    assert_eq!(keys.len(), 1, "{keys:?}");
    assert_eq!(ack["result"]["key"], keys[0]);
    let task = w.task("ALPHA", &keys[0]);
    assert_eq!(task["objectiveId"], "O-PA");
    assert_eq!(task["milestoneId"], Value::Null);
}

/// 读不出来的命令（别的密钥写的）：写 COMMAND_UNREADABLE 回执并删掉。
#[test]
fn an_unreadable_command_gets_a_failure_ack() {
    let w = world("cmd-unreadable", &[("PA", "ALPHA", true)]);
    let c = w.connector();
    let pairing = connect(&c, &w.relay);
    let phone = phone_for(&w.relay, &pairing);
    let id =
        atm_sync_protocol::keys::new_command_id(&phone.device.id, atm_sync::time::now_ms() as u64)
            .unwrap();
    let key = command_key(&phone.space_id, &id).unwrap();
    w.relay.put_raw(&key, json!({ "v": 1, "kid": "00000000", "iv": "AAAAAAAAAAAAAAAA", "z": 0, "n": 1, "d": "0000000000000000", "c": "AAAA" }));
    let ack = phone.await_ack(&id);
    assert_eq!(ack["error"]["code"], "COMMAND_UNREADABLE");
    wait_for(|| !w.relay.state().docs.contains_key(&key), "命令被删掉");
    let _: Value = ack;
    c.stop();
}

/// 03 P-008 端到端：手机能做的只有建任务与派单。别的命令类型即使用正确的空间密钥加密、信封字段都对，
/// 也只得到失败回执，项目、任务、事件都不变。
#[test]
fn a_phone_cannot_do_anything_but_create_and_dispatch() {
    let w = world("cmd-p008", &[("PA", "ALPHA", true)]);
    let key = w.seed_task("ALPHA", "已有的任务");
    let c = w.connector();
    let pairing = connect(&c, &w.relay);
    let phone = phone_for(&w.relay, &pairing);
    let before = (
        events(&w, "ALPHA"),
        w.task("ALPHA", &key),
        w.service.ui_project(&user(), "ALPHA").unwrap(),
    );
    let attempts = [
        ("project.archive", json!({ "project": "ALPHA" })),
        (
            "task.update",
            json!({ "project": "ALPHA", "key": key, "title": "手机改的标题" }),
        ),
        ("task.complete", json!({ "project": "ALPHA", "key": key })),
        (
            "knowledge.save",
            json!({ "project": "ALPHA", "title": "手机写的知识" }),
        ),
        ("sync.reset", json!({})),
    ];
    for (kind, body) in attempts {
        let now = atm_sync::time::now_ms();
        let id = atm_sync_protocol::keys::new_command_id(&phone.device.id, now as u64).unwrap();
        let doc = json!({
            "v": 1, "id": id, "device": { "id": phone.device.id, "name": phone.device.name },
            "at": atm_sync::time::iso(now), "type": kind, "body": body,
        });
        phone
            .store
            .write_object(&command_key(&phone.space_id, &id).unwrap(), &doc, true)
            .unwrap();
        let ack = phone.await_ack(&id);
        assert_eq!(ack["ok"], false, "{kind}: {ack}");
        assert!(
            ack["error"]["code"]
                .as_str()
                .unwrap()
                .starts_with("COMMAND_"),
            "{kind}: {ack}"
        );
        wait_for(
            || {
                phone
                    .store
                    .read_command(&id)
                    .map(|d| d.is_none())
                    .unwrap_or(true)
            },
            "命令被删掉",
        );
    }
    let after = (
        events(&w, "ALPHA"),
        w.task("ALPHA", &key),
        w.service.ui_project(&user(), "ALPHA").unwrap(),
    );
    assert_eq!(before.0, after.0, "没有新事件");
    assert_eq!(before.1, after.1, "任务没被改");
    assert_eq!(before.2["lifecycle"], after.2["lifecycle"]);
    assert_eq!(w.task_keys("ALPHA"), std::slice::from_ref(&key));
    // 绕过命令层，在 Rust 里直接拿 Phone 主体调 work.patch：能力层拒绝（03 §5 P-008 反例）。
    let as_phone = atm_domain::principal::Principal::verified_phone(
        phone.space_id.clone(),
        phone.device.id.clone(),
        "m-0123456789ab.direct".into(),
    );
    let target =
        atm_service::work::Target::new("PA".to_owned(), None, "phone-direct-patch".to_owned());
    let item = atm_service::work::PatchItem::new(key.clone(), atm_domain::work::Operation::Start);
    let e = w
        .service
        .patch_work_items(&as_phone, &target, vec![item])
        .unwrap_err();
    assert_eq!(e.code.as_str(), "PRINCIPAL_CAPABILITY_DENIED");
    assert_eq!(w.task("ALPHA", &key), after.1);
    // 阳性对照：同样的信封换成 task.create 就建出任务。
    let ok = phone.send(
        json!({ "type": "task.create", "body": { "project": "ALPHA", "title": "这条可以" } }),
    );
    assert_eq!(phone.await_ack(&ok)["ok"], true);
    assert_eq!(w.task_keys("ALPHA").len(), 2);
    c.stop();
}
