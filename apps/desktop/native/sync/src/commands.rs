//! 手机命令（docs/mobile-sync.md §6，2.x `packages/sync/src/commands.ts`）：校验 → 以手机（Phone）的身份执行
//! → 生成 ack 结果。
//!
//! 3.0 的差别：执行主体是 Phone（03 §2.3），事件与回执的写入者记为 `PHONE:<设备>`（03 C-05），能力只有
//! `work.create` 与 `dispatch.launch`；读项目与任务用 System `sync.loop`。

use atm_domain::error::ErrorCode;
use atm_domain::principal::Principal;
use atm_service::work::{CreateItem, Target};
use atm_sync_protocol::encoding::js_trim;
use atm_sync_protocol::keys::command_timestamp;
use atm_sync_protocol::schema::COMMAND_MAX_AGE_MS;
use serde_json::{Map, Value, json};

use crate::dispatch::EnqueueInput;
use crate::errors::{Failure, ack_error};
use crate::host::Host;
use crate::snapshot::reader;
use crate::time::js_date_parse;

/// 命令 ID 里的时间与 `at` 允许的偏差：两者本来由同一次 `Date.now()` 生成。
pub const COMMAND_CLOCK_TOLERANCE_MS: i64 = 10 * 60 * 1000;
/// 手机时钟快一点可以，快出一天就当伪造。
pub const COMMAND_FUTURE_TOLERANCE_MS: i64 = 24 * 60 * 60 * 1000;

fn invalid(message: &str) -> Failure {
    Failure::command("COMMAND_INVALID", message)
}

/// 键名里的命令 ID 必须与明文一致、属于发送设备，时间合理且不过期。`doc` 已经过 `COMMAND_DOC` 校验。
pub fn validate_command(doc: &Value, key_command_id: &str, now_ms: i64) -> Result<(), Failure> {
    let id = doc["id"].as_str().unwrap_or_default();
    if id != key_command_id {
        return Err(invalid("命令内容与文档键不一致，已拒绝"));
    }
    let device = doc["device"]["id"].as_str().unwrap_or_default();
    if !id.starts_with(&format!("{device}.")) {
        return Err(invalid("命令 ID 与发送设备不符，已拒绝"));
    }
    let at = doc["at"].as_str().and_then(js_date_parse);
    let stamped = command_timestamp(id);
    let (Some(at), Some(stamped)) = (at, stamped) else {
        return Err(invalid("命令时间无法识别，已拒绝"));
    };
    let (at, stamped, now) = (i128::from(at), i128::from(stamped), i128::from(now_ms));
    if (stamped - at).abs() > i128::from(COMMAND_CLOCK_TOLERANCE_MS) {
        return Err(invalid("命令 ID 里的时间与发送时间不一致，已拒绝"));
    }
    if now - at > i128::from(COMMAND_MAX_AGE_MS) {
        return Err(Failure::command(
            "COMMAND_EXPIRED",
            "命令发出已超过 7 天，电脑不再执行",
        ));
    }
    if at - now > i128::from(COMMAND_FUTURE_TOLERANCE_MS) {
        return Err(invalid("命令时间在未来，请检查手机时间设置"));
    }
    Ok(())
}

/// 命令的发送方：命令已解密、核对过键名、通过了 [`validate_command`]，才构造手机主体（03 §2.3）。
pub fn phone_principal(space_id: &str, doc: &Value) -> Principal {
    Principal::verified_phone(
        space_id.to_owned(),
        doc["device"]["id"].as_str().unwrap_or_default().to_owned(),
        doc["id"].as_str().unwrap_or_default().to_owned(),
    )
}

/// 项目必须存在且是 ACTIVE。返回（项目 id，项目码）：写入按 id 找项目，读与回执用项目码。
fn active_project(host: &Host, code: &str) -> Result<(String, String), Failure> {
    match host.service()?.ui_project(&reader(), code) {
        Ok(p) if p["lifecycle"] == "ACTIVE" => {
            let id = p["id"].as_str().unwrap_or_default().to_owned();
            return Ok((id, p["code"].as_str().unwrap_or(code).to_owned()));
        }
        Ok(_) => {}
        Err(e) if e.code == ErrorCode::PROJECT_NOT_FOUND => {}
        Err(e) => return Err(e.into()),
    }
    Err(Failure::command(
        "PROJECT_NOT_FOUND",
        format!("项目 {code} 不存在或已归档"),
    ))
}

/// 派单。命令 ID 作 `request_id` 交给派单层：它按这个 ID 持久幂等，同一条命令无论被中继重放、还是回执写失败
/// 后重做，拿到的都是当初那次派单（或当初的拒绝），绝不会再起一次会话。
fn dispatch_outcome(
    host: &Host,
    phone: &Principal,
    input: EnqueueInput,
) -> Result<Map<String, Value>, Failure> {
    let mut out = Map::new();
    let Some(dispatch) = host.dispatch()? else {
        out.insert(
            "dispatchError".into(),
            json!({ "code": "DISPATCH_UNAVAILABLE", "message": "这台电脑没有启用 Claude 派单" }),
        );
        return Ok(out);
    };
    match dispatch.enqueue(phone, input.clone()) {
        Ok(run) => {
            out.insert(
                "dispatch".into(),
                json!({ "run": run.run, "state": run.state }),
            );
        }
        // 派单器正随电脑上的 ATM 退出：这条命令不算失败，整条留到下次启动再处理。
        Err(e) if e.is_deferred() => return Err(e),
        Err(e) => {
            if e.code() == Some("DISPATCH_ALREADY_ACTIVE")
                && let Some(existing) = dispatch.run_for_task(&input.project, &input.key)
                && matches!(existing.state.as_str(), "queued" | "running")
            {
                out.insert(
                    "dispatch".into(),
                    json!({ "run": existing.run, "state": existing.state }),
                );
                return Ok(out);
            }
            let (code, message) = ack_error(&e);
            out.insert(
                "dispatchError".into(),
                json!({ "code": code, "message": message }),
            );
        }
    }
    Ok(out)
}

fn create_task(host: &Host, phone: &Principal, doc: &Value) -> Result<Value, Failure> {
    let body = &doc["body"];
    let (project_id, project) = active_project(host, body["project"].as_str().unwrap_or_default())?;
    let id = doc["id"].as_str().unwrap_or_default();
    // 不传 objective_id：目标由服务在建任务的同一个事务里挑（按创建顺序第一个 ACTIVE，没有就补建规划根，
    // W-071），请求里只有命令本身的字段。同一条命令重做（回执写失败、崩溃恢复、中继重放）时请求不变，
    // `mobile:<id>` 回放的就是第一次建出来的那条；在这里先挑好再传，第一次补建之后重做的请求就变了。
    let item = CreateItem {
        client_ref: Some("mobile".into()),
        title: js_trim(body["title"].as_str().unwrap_or_default()).to_owned(),
        description: Some(body["description"].as_str().unwrap_or_default().to_owned()),
        kind: Some("TASK".into()),
        priority: Some(body["priority"].as_str().unwrap_or("NORMAL").to_owned()),
        status: Some(atm_domain::work::Status::Ready),
        ..Default::default()
    };
    let target = Target::new(project_id, None, format!("mobile:{id}"));
    let written = host
        .service()?
        .create_work_items(phone, &target, vec![item])?;
    let Some(key) = written.result["items"][0]["key"]
        .as_str()
        .map(str::to_owned)
    else {
        return Err(Failure::command("COMMAND_FAILED", "任务没有建出来"));
    };
    let mut result = Map::new();
    result.insert("project".into(), json!(project));
    result.insert("key".into(), json!(key));
    if body["dispatch"] == Value::Bool(true) {
        let outcome = dispatch_outcome(
            host,
            phone,
            EnqueueInput {
                project: project.clone(),
                key,
                requested_by: doc["device"]["name"].as_str().map(str::to_owned),
                request_id: Some(id.to_owned()),
            },
        )?;
        result.extend(outcome);
    }
    Ok(Value::Object(result))
}

fn dispatch_task(host: &Host, phone: &Principal, doc: &Value) -> Result<Value, Failure> {
    let body = &doc["body"];
    let (_, project) = active_project(host, body["project"].as_str().unwrap_or_default())?;
    let key = body["key"].as_str().unwrap_or_default().to_owned();
    match host.service()?.ui_work_item(&reader(), &project, &key) {
        Ok(_) => {}
        Err(e) if e.code == ErrorCode::WORK_ITEM_NOT_FOUND => {
            return Err(Failure::command(
                "TASK_NOT_FOUND",
                format!("任务 {key} 不存在"),
            ));
        }
        Err(e) => return Err(e.into()),
    }
    let outcome = dispatch_outcome(
        host,
        phone,
        EnqueueInput {
            project: project.clone(),
            key: key.clone(),
            requested_by: doc["device"]["name"].as_str().map(str::to_owned),
            request_id: doc["id"].as_str().map(str::to_owned),
        },
    )?;
    if let Some(err) = outcome.get("dispatchError") {
        // 派单被拒就是这条命令失败，错误码照实透传（例如 DISPATCH_DISABLED）。
        let code = err["code"].as_str().unwrap_or_default();
        let code = if code.starts_with("DISPATCH_") {
            code
        } else {
            "COMMAND_FAILED"
        };
        return Err(Failure::command(
            code,
            err["message"].as_str().unwrap_or_default(),
        ));
    }
    let mut result = Map::new();
    result.insert("project".into(), json!(project));
    result.insert("key".into(), json!(key));
    result.extend(outcome);
    Ok(Value::Object(result))
}

/// 执行一条已校验的命令。失败由调用方写 `ok:false` 的 ack（可重试与延后的除外）。
pub fn execute_command(host: &Host, phone: &Principal, doc: &Value) -> Result<Value, Failure> {
    match doc["type"].as_str() {
        Some("task.create") => create_task(host, phone, doc),
        Some("task.dispatch") => dispatch_task(host, phone, doc),
        _ => Err(invalid("不认识的命令类型")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use atm_sync_protocol::keys::command_id;

    fn doc(id: &str, device: &str, at: &str) -> Value {
        json!({ "v": 1, "id": id, "device": { "id": device, "name": "手机" }, "at": at, "type": "task.create", "body": {} })
    }

    #[test]
    fn commands_are_checked_against_their_key_device_and_clock() {
        let now = js_date_parse("2026-10-10T12:00:00.000Z").unwrap();
        let dev = "m-0123456789ab";
        let id = |ms: i64| command_id(dev, ms as u64, [1, 2, 3, 4]).unwrap();
        let at = |ms: i64| crate::time::iso(ms);
        let ok = id(now);
        assert!(validate_command(&doc(&ok, dev, &at(now)), &ok, now).is_ok());
        let code = |r: Result<(), Failure>| r.unwrap_err().code().unwrap().to_owned();
        assert_eq!(
            code(validate_command(
                &doc(&ok, dev, &at(now)),
                &id(now + 1),
                now
            )),
            "COMMAND_INVALID"
        );
        assert_eq!(
            code(validate_command(
                &doc(&ok, "m-ffffffffffff", &at(now)),
                &ok,
                now
            )),
            "COMMAND_INVALID"
        );
        assert_eq!(
            code(validate_command(&doc(&ok, dev, "yesterday"), &ok, now)),
            "COMMAND_INVALID"
        );
        let ten = COMMAND_CLOCK_TOLERANCE_MS;
        assert!(validate_command(&doc(&ok, dev, &at(now + ten)), &ok, now).is_ok());
        assert_eq!(
            code(validate_command(
                &doc(&ok, dev, &at(now + ten + 1)),
                &ok,
                now
            )),
            "COMMAND_INVALID"
        );
        let week = COMMAND_MAX_AGE_MS as i64;
        let old = id(now - week);
        assert!(validate_command(&doc(&old, dev, &at(now - week)), &old, now).is_ok());
        let older = id(now - week - 1);
        assert_eq!(
            code(validate_command(
                &doc(&older, dev, &at(now - week - 1)),
                &older,
                now
            )),
            "COMMAND_EXPIRED"
        );
        let day = COMMAND_FUTURE_TOLERANCE_MS;
        let ahead = id(now + day);
        assert!(validate_command(&doc(&ahead, dev, &at(now + day)), &ahead, now).is_ok());
        let far = id(now + day + 1);
        assert_eq!(
            code(validate_command(
                &doc(&far, dev, &at(now + day + 1)),
                &far,
                now
            )),
            "COMMAND_INVALID"
        );
    }
}
