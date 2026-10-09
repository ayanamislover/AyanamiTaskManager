//! 每条界面路由接到服务上（06 §2 的界面用法，契约见 `output/w5-evidence/ui-contract-inventory.md`）。
//!
//! - 读：服务的 `ui_*` 读给 2.0 形状；少数直接复用 Agent 读再换形状。
//! - 写：与 Agent 同一个服务入口，主体是 User。界面上有 MCP 工具对应的写（建任务、改任务、记录）走同一份
//!   参数 schema 与同一个工具处理器（[`atm_http::rest::call_tool_as`]，03 A6）。
//! - 回执：界面读得到的字段按 2.0 给（项目的 `code`、目标的 `id`、知识条目、已保存视图……）；界面不读的照服务的结果原样给。

use crate::input::Input;
use crate::routes::UiRoute;
use crate::{Reply, Ui, domain_reply, envelope_reply, error_reply};
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::evidence::{Evidence, EvidenceKind};
use atm_domain::gate::ChecklistStatus;
use atm_domain::principal::Principal;
use atm_service::backups::RestoreScope;
use atm_service::knowledge::{ArchiveRequest, Content, SourceRef, UserSave};
use atm_service::project::{CreateProjectRequest, PathInfo, Transition};
use atm_service::quick::{QuickCreateRequest, QuickPromoteRequest, QuickUpdateRequest};
use atm_service::read::{KnowledgeGetRequest, KnowledgeSearchRequest, SearchRequest};
use atm_service::settings::BackupPolicy;
use atm_service::ui::WorkItemFilter;
use atm_service::views::SavedViewCreate;
use atm_service::work::{
    ChecklistSingle, MilestoneRequest, ObjectiveRequest, PublishRequest, Target,
};
use serde_json::{Map, Value, json};

type Out = Result<Reply, Reply>;

fn svc(e: DomainError) -> Reply {
    domain_reply(e)
}

fn ok(v: Result<Value, DomainError>) -> Out {
    v.map(Reply::ok).map_err(svc)
}

fn created(v: Result<Value, DomainError>) -> Out {
    v.map(Reply::created).map_err(svc)
}

fn invalid(message: &str) -> Reply {
    error_reply(
        400,
        ErrorCode::INVALID_ARGUMENT.as_str(),
        message,
        false,
        None,
    )
}

/// W7 才有的功能：2.0 在没有这个功能时就回 404 加这个码，界面按「功能不可用」安静处理。
fn unavailable_feature(code: &str, what: &str) -> Reply {
    error_reply(
        404,
        code,
        &format!("{what}在这个版本里还不可用"),
        false,
        None,
    )
}

pub(crate) fn handle(ui: &Ui, p: &Principal, route: &UiRoute, i: &Input) -> Reply {
    match route_call(ui, p, route.n, i) {
        Ok(r) | Err(r) => r,
    }
}

impl Ui {
    fn op_id(&self, i: &Input) -> Result<String, Reply> {
        match i.str("opId").filter(|s| !s.trim().is_empty()) {
            Some(op) => Ok(op),
            None => self.svc.auto_op_id().map_err(svc),
        }
    }

    /// 项目内写入的目标：User 不带 session。
    fn target(&self, p: &Principal, project: &str, i: &Input) -> Result<Target, Reply> {
        let id = self.svc.project_id(p, project).map_err(svc)?;
        Ok(Target::new(id, None, self.op_id(i)?))
    }

    fn project(&self, p: &Principal, code: &str) -> Out {
        ok(self.svc.ui_project(p, code))
    }

    /// 界面上有 MCP 工具对应的写：同一份 schema、同一个处理器（03 A6）。
    /// 有 MCP 工具的界面写（03 A6）：同一份参数 schema、同一个处理器，回服务的原始写结果
    /// （2.0 界面路由的形状由它挑出来，见 [`present`]），不是给 Agent 的 ACK。
    fn tool(&self, p: &Principal, tool: &str, i: &Input, project: &str) -> Result<Value, Reply> {
        let mut args: Map<String, Value> = i.body.clone();
        // 2.0 的 `opId` 与工具的 `op_id` 同义；session 由服务按 User 处理（不带）。
        if let Some(op) = args.remove("opId") {
            args.entry("op_id").or_insert(op);
        }
        args.remove("session");
        let (_, raw) =
            atm_http::rest::call_tool_raw_as(&self.surface, p, tool, args, &[("project", project)])
                .map_err(envelope_reply)?;
        raw.ok_or_else(|| {
            error_reply(
                500,
                "INTERNAL_ERROR",
                &format!("{tool} 没有回写入结果"),
                false,
                None,
            )
        })
    }
}

/// 从服务的写结果里挑出 2.0 界面路由回的那几个键（`refs`、`checklist` 是给 Agent ACK 的，2.0 界面路由不回）。
fn present(raw: &Value, keys: &[&str]) -> Value {
    let mut out = Map::new();
    for k in keys {
        if let Some(v) = raw.get(*k) {
            out.insert((*k).to_owned(), v.clone());
        }
    }
    Value::Object(out)
}

fn evidence(v: &Value) -> Result<Evidence, Reply> {
    match v {
        Value::String(s) => Ok(Evidence::Text(s.clone())),
        Value::Object(m) => {
            let kind = m
                .get("kind")
                .and_then(Value::as_str)
                .and_then(EvidenceKind::parse)
                .ok_or_else(|| invalid("evidence 的 kind 不认识"))?;
            let value = m
                .get("value")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("evidence 缺少 value"))?;
            Ok(Evidence::Item {
                kind,
                value: value.to_owned(),
                note: m.get("note").and_then(Value::as_str).map(str::to_owned),
            })
        }
        _ => Err(invalid("evidence 只能是字符串或 {kind, value}")),
    }
}

fn content(i: &Input) -> Result<Content, Reply> {
    let refs = match i.get("sourceRefs") {
        None => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| {
                let m = v
                    .as_object()
                    .ok_or_else(|| invalid("sourceRefs 的每一项必须是对象"))?;
                Ok(SourceRef {
                    kind: m
                        .get("type")
                        .and_then(Value::as_str)
                        .ok_or_else(|| invalid("sourceRefs 缺少 type"))?
                        .to_owned(),
                    reference: m
                        .get("reference")
                        .and_then(Value::as_str)
                        .ok_or_else(|| invalid("sourceRefs 缺少 reference"))?
                        .to_owned(),
                    source_version: m.get("sourceVersion").and_then(Value::as_i64),
                    project_id: m
                        .get("projectId")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    record_id: m.get("recordId").and_then(Value::as_str).map(str::to_owned),
                })
            })
            .collect::<Result<_, Reply>>()?,
        Some(_) => return Err(invalid("sourceRefs 必须是数组")),
    };
    Ok(Content {
        slug: i.need_str("slug")?,
        title: i.need_str("title")?,
        summary: i.need_str("summary")?,
        use_when: i.str("useWhen"),
        tags: i.strs("tags").unwrap_or_default(),
        aliases: i.strs("aliases").unwrap_or_default(),
        applies_to: i.strs("appliesTo").unwrap_or_default(),
        body_markdown: i.need_str("bodyMarkdown")?,
        source_refs: refs,
    })
}

/// 2.0 的 `/system/status`：单库的健康加运行时状态。投影健康随面板删除（00 §6），单库没有逐库失败。
fn status(ui: &Ui, p: &Principal) -> Out {
    let s = ui.svc.system_status(p).map_err(svc)?;
    let runtime = (ui.runtime)();
    let out = json!({
        "ok": s["ok"],
        "version": runtime.get("version").cloned().unwrap_or(Value::Null),
        "sqlite": {
            "ok": s["ok"],
            "sqliteVersion": s["sqlite"]["version"],
            "fts5": true,
            "trigram": true,
            "wal": true,
        },
        "projectCount": s["project_count"],
        // 2.0 是 `{生命周期: {total, failed}}`；单库没有逐库失败。
        "projectCounts": s["project_counts"]
            .as_object()
            .map(|m| {
                m.iter()
                    .map(|(k, n)| (k.clone(), json!({ "total": n, "failed": 0 })))
                    .collect::<Map<String, Value>>()
            })
            .map_or(json!({}), Value::Object),
        "projectFailures": [],
        "startedAt": ui.started_at,
        "at": s["at"],
    });
    Ok(Reply::ok(out))
}

fn route_call(ui: &Ui, p: &Principal, n: u16, i: &Input) -> Out {
    let s = &ui.svc;
    match n {
        1 => status(ui, p),
        2 => ok(s.ui_overview(p)),
        5 => ok(s.ui_saved_views(p, i.q("project"))),
        6 => {
            let r = SavedViewCreate {
                scope: i.str("scope").unwrap_or_else(|| "PROJECT".into()),
                project: i.str("project"),
                name: i.str("name").unwrap_or_default(),
                query: i.get("query").cloned(),
                sort: i.get("sort").cloned(),
            };
            let op = ui.op_id(i)?;
            let w = s.create_saved_view(p, r, &op).map_err(svc)?;
            Ok(Reply::created(w.result["view"].clone()))
        }
        8 => {
            let op = ui.op_id(i)?;
            let w = s
                .delete_saved_view(p, i.param("id"), i.q_i64("expectedVersion")?, &op)
                .map_err(svc)?;
            Ok(Reply::ok(w.result))
        }
        9 => ok(s.ui_settings(p)),
        10 => {
            let key = i.param("key");
            let expected = i.i64("expectedVersion");
            let op = ui.op_id(i)?;
            let value = i.get("value").cloned().unwrap_or(Value::Null);
            let w = match key {
                // 通知方式走专门的入口（03 C-06：ALL / CRITICAL / OFF）。
                "notification.mode" => {
                    s.set_notification_mode(p, value.as_str().unwrap_or_default(), expected, &op)
                }
                "backup.policy" => {
                    let field = |k: &str| value.get(k).and_then(Value::as_i64);
                    let (Some(enabled), Some(daily), Some(weekly), Some(other)) = (
                        value.get("enabled").and_then(Value::as_bool),
                        field("dailyKeep"),
                        field("weeklyKeep"),
                        field("otherKeep"),
                    ) else {
                        return Err(invalid(
                            "backup.policy 要 {enabled, dailyKeep, weeklyKeep, otherKeep}",
                        ));
                    };
                    let policy = BackupPolicy {
                        enabled,
                        daily_keep: daily,
                        weekly_keep: weekly,
                        other_keep: other,
                    };
                    s.set_backup_policy(p, policy, expected, &op)
                }
                _ => s.set_setting(p, key, value, expected, &op),
            }
            .map_err(svc)?;
            Ok(Reply::ok(w.result["setting"].clone()))
        }
        11 => ok(s.ui_projects(p)),
        12 => ok(s.ui_trash(p)),
        13 | 14 => {
            let op = ui.op_id(i)?;
            let id = i.param("id");
            let w = s.decide_restore_request(p, id, n == 13, &op).map_err(svc)?;
            let request = s.ui_restore_request(p, id).map_err(svc)?;
            let project = w.result["project"]["id"]
                .as_str()
                .or(request["projectId"].as_str())
                .unwrap_or_default()
                .to_owned();
            let project = s.ui_project(p, &project).map_err(svc)?;
            Ok(Reply::ok(json!({ "request": request, "project": project })))
        }
        15 => {
            let mut r = CreateProjectRequest::new(i.str("name").unwrap_or_default());
            r.code = i.str("code").filter(|c| !c.trim().is_empty());
            r.description = i.str("description");
            r.path = i
                .str("sourcePath")
                .filter(|p| !p.trim().is_empty())
                .map(|raw| {
                    let path = atm_http::workspace::canonical(&raw).unwrap_or(raw);
                    PathInfo {
                        git_common_dir: atm_http::workspace::git_common_dir(&path),
                        canonical_path: path,
                    }
                });
            r.coordination_mode = i.str("coordinationMode");
            r.creation_reason = i.str("creationReason");
            if let Some(Value::Object(signals)) = i.get("creationSignals") {
                r.signals = signals.clone();
            }
            r.op_id = Some(ui.op_id(i)?);
            let w = s.create_project(p, r).map_err(svc)?;
            // C-L03：marker 与 git exclude 在提交之后写（与 Agent 入口同一个函数）。
            if let Some(marker) = w.result.get("marker").filter(|m| m.is_object()) {
                atm_http::workspace::write_marker(marker);
            }
            let code = w.result["project"]["code"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            created(s.ui_project(p, &code))
        }
        // 工程指标的采集与刷新在 W5h（P-009 / P-014）；在那之前界面看到的是「还没有采集」。
        18 => Ok(Reply::ok(json!({
            "available": false,
            "reason": "NOT_CAPTURED",
            "message": "工程指标还没有采集",
            "project": null,
            "workItem": null,
        }))),
        19..=21 => {
            let code = i.param("code");
            let transition = match n {
                19 => Transition::Archive,
                21 => Transition::Trash,
                // 2.0 的 restore 一条路由管「取消归档」与「从垃圾箱恢复」，按当前生命周期分。
                _ => {
                    let current = s.ui_project(p, code).map_err(svc)?;
                    if current["lifecycle"] == "TRASHED" {
                        Transition::Untrash
                    } else {
                        Transition::Unarchive
                    }
                }
            };
            let op = ui.op_id(i)?;
            s.set_lifecycle(p, code, transition, &op).map_err(svc)?;
            ui.project(p, code)
        }
        22 => ok(s.ui_backups(p)),
        23 => created(s.ui_create_backup(p)),
        // 3.0 的备份是整库的，恢复要选范围（05 §2.7）：选范围的界面随新的数据界面在 W6。
        24 => match (i.str("scope").as_deref(), i.str("project")) {
            (Some("KNOWLEDGE"), _) => {
                ok(s.restore_scope(p, i.param("id"), RestoreScope::Knowledge))
            }
            (Some("PROJECT"), Some(project)) => {
                ok(s.restore_scope(p, i.param("id"), RestoreScope::Project(project)))
            }
            _ => Err(error_reply(
                422,
                "BACKUP_RESTORE_SCOPE_UNSUPPORTED",
                "3.0 的备份需要指明恢复范围（scope: PROJECT 加 project，或 KNOWLEDGE）",
                false,
                None,
            )),
        },
        25 => {
            let project = i.need_str("project")?;
            let mut v = s
                .preview_import(
                    p,
                    &project,
                    &i.need_str("content")?,
                    i.str("sourceName").as_deref(),
                )
                .map_err(svc)?;
            // 2.0 的预览里项目是 `{id, code, name}`。
            if v["project"].is_object() {
                v["project"]["id"] = s.ui_project(p, &project).map_err(svc)?["id"].clone();
            }
            Ok(Reply::ok(v))
        }
        26 => {
            let project = i.need_str("project")?;
            let target = ui.target(p, &project, i)?;
            let w = s
                .apply_import(
                    p,
                    &target,
                    &i.need_str("content")?,
                    i.str("sourceName").as_deref(),
                    i.str("expectedSha256").as_deref(),
                )
                .map_err(svc)?;
            Ok(Reply::ok(without(w.result, &["sequence"])))
        }
        // `.aytproj` v2 的导出在 W6（方案 §4）；路由已按 R8 改成 User 的 POST。
        27 => Err(error_reply(
            503,
            "SERVICE_UNAVAILABLE",
            "导出功能在这个版本里还不可用",
            false,
            None,
        )),
        28 => ok(s.ui_objectives(p, i.param("code"))),
        29 => ok(s.ui_milestones(p, i.param("code"), i.q("objective"))),
        30 => ok(s.ui_sessions(
            p,
            i.param("code"),
            i.q_usize("limit")?,
            i.q("cursor").map(str::to_owned),
            i.q("task").map(str::to_owned),
        )),
        32 => ok(s.ui_reconciliation(
            p,
            i.param("code"),
            i.q_bool("include_active")?.unwrap_or(false),
        )),
        33 => ok(s.ui_records(
            p,
            i.param("code"),
            i.q_usize("limit")?,
            i.q("cursor").map(str::to_owned),
        )),
        36 => ok(s.ui_project_updates(p, i.param("code"), i.q_usize("limit")?)),
        39 => {
            let target = ui.target(p, i.param("code"), i)?;
            let w = s.draft_project_update(p, &target).map_err(svc)?;
            Ok(Reply::created(atm_service::ui::project_update_receipt(
                w.result,
            )))
        }
        40 => {
            let target = ui.target(p, i.param("code"), i)?;
            let r = PublishRequest {
                draft_id: i.str("draftId"),
                health: i.str("health"),
                summary: i.str("summary").unwrap_or_default(),
                completed: i.strs("completed"),
                risks: i.strs("risks"),
                next: i.strs("next"),
            };
            let w = s.publish_project_update(p, &target, r).map_err(svc)?;
            Ok(Reply::created(atm_service::ui::project_update_receipt(
                w.result,
            )))
        }
        41 => ok(s.ui_brief(p, i.param("code"), i.q("session"))),
        42 => ok(s.preview_record(
            p,
            &i.q("project")
                .map(str::to_owned)
                .ok_or_else(|| invalid("缺少 project"))?,
            &i.q("record")
                .map(str::to_owned)
                .ok_or_else(|| invalid("缺少 record"))?,
        )),
        44 => {
            let r = KnowledgeSearchRequest {
                query: i.q("query").unwrap_or_default().to_owned(),
                tag: i.q("tag").map(str::to_owned),
                include_archived: i.q_bool("includeArchived")?.unwrap_or(false),
                limit: i.q_i64("limit")?.unwrap_or(20),
                max_chars: i.q_i64("maxChars")?.unwrap_or(50_000),
                cursor: i.q("cursor").map(str::to_owned),
            };
            ok(s.knowledge_search(p, &r))
        }
        45 | 47 => {
            let id = if n == 47 {
                Some(i.param("id").to_owned())
            } else {
                i.str("id").filter(|id| !id.trim().is_empty())
            };
            let is_new = id.is_none();
            let r = UserSave {
                content: content(i)?,
                id,
                expected_version: i.i64("expectedVersion").unwrap_or(0),
                expected_revision_id: i.str("expectedRevisionId"),
            };
            let op = ui.op_id(i)?;
            let w = s.knowledge_save(p, r, &op).map_err(svc)?;
            Ok(if is_new {
                Reply::created(w.result)
            } else {
                Reply::ok(w.result)
            })
        }
        48 => {
            let mut r = KnowledgeGetRequest::new(i.param("id"));
            r.revision_id = i.q("revisionId").map(str::to_owned);
            r.max_chars = i.q_i64("maxChars")?.unwrap_or(600_000);
            r.cursor = i.q("cursor").map(str::to_owned);
            // `isHead` 是 3.0 给 Agent 的（是否当前修订）；2.0 的界面读不带它。
            Ok(Reply::ok(without(
                s.knowledge_get(p, &r).map_err(svc)?,
                &["isHead"],
            )))
        }
        49 => ok(s.knowledge_history(
            p,
            i.param("id"),
            i.q_i64("beforeRevision")?,
            i.q_i64("limit")?,
        )),
        50 => {
            let r = ArchiveRequest {
                id: i.param("id").to_owned(),
                expected_version: i.need_i64("expectedVersion")?,
                expected_revision_id: i.need_str("expectedRevisionId")?,
                archived: i.bool("archived").unwrap_or(true),
            };
            let op = ui.op_id(i)?;
            let w = s.knowledge_archive(p, r, &op).map_err(svc)?;
            Ok(Reply::ok(w.result))
        }
        53 => {
            let target = ui.target(p, i.param("code"), i)?;
            let r = ObjectiveRequest {
                title: i.str("title").unwrap_or_default(),
                description: i.str("description").unwrap_or_default(),
                definition_of_done: i.strs("definitionOfDone").unwrap_or_default(),
            };
            let w = s.create_objective(p, &target, r).map_err(svc)?;
            Ok(Reply::created(w.result))
        }
        54 => {
            let target = ui.target(p, i.param("code"), i)?;
            let r = MilestoneRequest {
                objective_id: i.str("objectiveId").unwrap_or_default(),
                title: i.str("title").unwrap_or_default(),
                description: i.str("description").unwrap_or_default(),
                target_date: i.str("targetDate"),
            };
            let w = s.create_milestone(p, &target, r).map_err(svc)?;
            Ok(Reply::created(w.result))
        }
        55 => ui.tool(p, "atm_task_create", i, i.param("code")).map(|r| {
            Reply::created(present(
                &r,
                &["items", "planningRootProvisioned", "sequence"],
            ))
        }),
        56 => ui
            .tool(p, "atm_task_patch", i, i.param("code"))
            .map(|r| Reply::ok(present(&r, &["items", "sequence"]))),
        59 => {
            let target = ui.target(p, i.param("code"), i)?;
            let status = match i.str("status").as_deref() {
                Some("TODO") => ChecklistStatus::Todo,
                Some("DOING") => ChecklistStatus::Doing,
                Some("DONE") => ChecklistStatus::Done,
                Some("SKIPPED") => ChecklistStatus::Skipped,
                _ => return Err(invalid("status 只能是 TODO、DOING、DONE、SKIPPED")),
            };
            let evidence = match i.get("evidence") {
                None => None,
                Some(Value::Array(items)) => {
                    Some(items.iter().map(evidence).collect::<Result<Vec<_>, _>>()?)
                }
                Some(_) => return Err(invalid("evidence 必须是数组")),
            };
            let r = ChecklistSingle {
                task_key: None,
                checklist_id: i.param("id").to_owned(),
                expected_checklist_version: i.i64("expectedVersion"),
                legacy_version_name: false,
                status,
                evidence,
            };
            let w = s.update_checklist(p, &target, r).map_err(svc)?;
            Ok(Reply::ok(without(w.result, &["taskKey"])))
        }
        60 => {
            let f = WorkItemFilter {
                status: i.q("status").map(str::to_owned),
                assignee: i.q("assignee").map(str::to_owned),
                milestone: i.q("milestone").map(str::to_owned),
                query: i.q("q").map(str::to_owned),
                ready: i.q_bool("ready")?.unwrap_or(false),
                closed: i.q_bool("closed")?,
                limit: i.q_usize("limit")?,
                cursor: i.q("cursor").map(str::to_owned),
            };
            ok(s.ui_work_items(p, i.param("code"), &f))
        }
        61 => ok(s.ui_progress_strip(p, i.param("code"), &ui.started_at)),
        62 => ok(s.ui_closed_work_items(p, i.param("code"), i.q_usize("limit")?, i.q("cursor"))),
        63 => ok(s.ui_work_item(p, i.param("code"), i.param("taskKey"))),
        68 => ok(s.ui_task_full(p, i.param("code"), i.param("taskKey"))),
        76 => ui.tool(p, "atm_record", i, i.param("code")).map(|r| {
            // 2.0 的 RecordCreateReceipt：`{ok: 1, seq, key, v, relatedRecords}`。
            let record = &r["record"];
            Reply::created(json!({
                "ok": 1,
                "seq": r["sequence"],
                "key": record["key"],
                "v": record["version"],
                "relatedRecords": record["relatedRecords"],
            }))
        }),
        77 | 78 => {
            let r = SearchRequest {
                project: (n == 77).then(|| i.param("code").to_owned()),
                query: i.q("query").map(str::to_owned),
                limit: i.q_usize("limit")?.unwrap_or(20),
                cursor: i.q("cursor").map(str::to_owned),
                max_chars: 50_000,
                ..SearchRequest::default()
            };
            let v = s.search(p, &r).map_err(svc)?;
            Ok(Reply::ok(search_page(v, n == 78)))
        }
        79 => {
            let types: Vec<String> = i
                .q("types")
                .map(|t| {
                    t.split(',')
                        .map(str::trim)
                        .filter(|t| !t.is_empty())
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            ok(s.ui_events(
                p,
                i.param("code"),
                i.q_i64("since")?,
                i.q_usize("limit")?.unwrap_or(50),
                &types,
            ))
        }
        82 => {
            let project = i.need_str("project")?;
            let target = ui.target(p, &project, i)?;
            let w = s
                .force_close_session(
                    p,
                    &target,
                    i.param("id"),
                    i.bool("releaseClaims").unwrap_or(true),
                )
                .map_err(svc)?;
            Ok(Reply::ok(json!({
                "ok": 1,
                "session": w.result["session"],
                "released": w.result["released"],
                "seq": w.result["sequence"],
            })))
        }
        83 => ok(s.ui_refresh_git(
            p,
            i.param("code"),
            i.param("id"),
            &atm_http::workspace::git_context,
        )),
        84 => {
            let list = s.ui_quick_tasks(p, i.q("status")).map_err(svc)?;
            let items = list.as_array().cloned().unwrap_or_default();
            Ok(Reply::ok(Value::Array(
                items.into_iter().map(quick_view).collect(),
            )))
        }
        85 => {
            let op = ui.op_id(i)?;
            let r = QuickCreateRequest {
                title: i.str("title").unwrap_or_default(),
                note: i.str("note"),
                due_date: i.str("dueDate"),
                source_cwd: i.str("sourceCwd"),
                actor: i.str("actor"),
            };
            let w = s.quick_create(p, r, &op).map_err(svc)?;
            Ok(Reply::created(quick_view(w.result["quick"].clone())))
        }
        86 => {
            let op = ui.op_id(i)?;
            let nullable = |k: &str| i.body.contains_key(k).then(|| i.str(k));
            let r = QuickUpdateRequest {
                expected_version: i.need_i64("expectedVersion")?,
                status: i.str("status"),
                title: i.str("title"),
                note: i.str("note"),
                due_date: nullable("dueDate"),
                percent: i.body.contains_key("percent").then(|| i.i64("percent")),
                summary: i.str("summary"),
                actor: i.str("actor"),
            };
            let w = s.quick_update(p, i.param("id"), r, &op).map_err(svc)?;
            Ok(Reply::ok(quick_view(w.result["quick"].clone())))
        }
        87 => {
            let op = ui.op_id(i)?;
            let r = QuickPromoteRequest {
                expected_version: i.need_i64("expectedVersion")?,
                target_project: i
                    .str("targetProjectCode")
                    .or_else(|| i.str("targetProject")),
                actor: i.str("actor"),
                session: None,
                expected_target: None,
            };
            let w = s.quick_promote(p, i.param("id"), r, &op).map_err(svc)?;
            Ok(Reply::ok(quick_view(w.result["quick"].clone())))
        }
        // 派单与手机同步在 W7。
        88..=91 => Err(unavailable_feature("DISPATCH_UNAVAILABLE", "Claude 派单")),
        92..=96 => Err(unavailable_feature("SYNC_UNAVAILABLE", "手机同步")),
        _ => Err(error_reply(
            500,
            ErrorCode::INTERNAL_ERROR.as_str(),
            &format!("界面路由 #{n} 没有接到服务上"),
            true,
            None,
        )),
    }
}

/// 2.0 的 quick 任务：3.0 加的 `promotedWorkItemId`、`promotionUndone`（撤销晋升用）界面不读，不回。
fn quick_view(v: Value) -> Value {
    without(v, &["promotedWorkItemId", "promotionUndone"])
}

/// 去掉 2.0 界面形状里没有的键。
fn without(mut v: Value, keys: &[&str]) -> Value {
    if let Value::Object(m) = &mut v {
        for k in keys {
            m.remove(*k);
        }
    }
    v
}

/// 搜索的界面形状（2.0 `SearchPage`，camelCase）。Agent 的 `atm_search` 回执是 snake_case 的。
/// 全局搜索（#78）的命中带 `project`，项目内搜索（#77）不带。
fn search_page(v: Value, global: bool) -> Value {
    let hits: Vec<Value> = v["hits"]
        .as_array()
        .or_else(|| v["items"].as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|h| {
            let mut hit = json!({
                "entityType": h["entity_type"],
                "entityKey": h["entity_key"],
                "title": h["title"],
                "snippet": h["snippet"],
                "updatedAt": h["updated_at"],
            });
            if global {
                hit["project"] = h["project"].clone();
            }
            hit
        })
        .collect();
    json!({
        "hits": hits,
        "nextCursor": v["next_cursor"],
        "hasMore": v["has_more"].as_bool().unwrap_or(false),
    })
}
