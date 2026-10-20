//! 界面的列表读：sessions、records、对账、项目事件、设置、已保存的视图、quick、备份。
//!
//! 能复用 Agent 读的就复用同一份查询（同一个排序、同一种游标），只把形状换成 2.0 的 camelCase、去掉裁剪。

use super::camel;
use crate::read::codec::jsify;
use crate::read::lists::{ListRequest, record_page, session_page};
use crate::read::views;
use crate::read::{ReconcileRequest, delta};
use crate::session::GitContext;
use crate::write::Service;
use atm_domain::capability::Capability;
use atm_domain::error::DomainError;
use atm_domain::principal::Principal;
use serde_json::{Value, json};

fn page_of(items: Vec<Value>, cursors: &[String], has_more: bool, depth: usize) -> Value {
    let next = if has_more {
        cursors.last().cloned().map_or(Value::Null, Value::String)
    } else {
        Value::Null
    };
    json!({
        "items": items.into_iter().map(|v| camel(v, depth)).collect::<Vec<_>>(),
        "nextCursor": next,
        "hasMore": has_more,
    })
}

fn unwrap(mut v: Value, key: &str) -> Value {
    v.get_mut(key).map(Value::take).unwrap_or(json!([]))
}

impl Service {
    /// `GET /projects/:code/agents`（#30）：2.0 `SessionView` 分页（camelCase，git 子对象也是）。
    pub fn ui_sessions(
        &self,
        principal: &Principal,
        project: &str,
        limit: Option<usize>,
        cursor: Option<String>,
        task: Option<String>,
    ) -> Result<Value, DomainError> {
        self.read_project(principal, Capability::SessionRead, project, |cx| {
            let r = ListRequest {
                limit: limit.unwrap_or(20).clamp(1, 100),
                cursor,
                task_key: task,
                ..ListRequest::default()
            };
            let page = session_page(cx, &r)?;
            Ok(page_of(page.items, &page.item_cursors, page.has_more, 2))
        })
    }

    /// 界面「刷新 git 上下文」（#83）要的 session 工作目录：git 在事务之外跑，然后交给 `refresh_git_context`。
    pub fn ui_session_cwd(
        &self,
        principal: &Principal,
        project: &str,
        session: &str,
    ) -> Result<Option<String>, DomainError> {
        self.read_project(principal, Capability::SessionRead, project, |cx| {
            use rusqlite::OptionalExtension;
            let cwd: Option<Option<String>> = cx
                .tx
                .query_row(
                    "SELECT cwd FROM agent_sessions WHERE project_id = ?1 AND id = ?2",
                    [&cx.p.id, &session.trim().to_owned()],
                    |r| r.get(0),
                )
                .optional()
                .map_err(crate::read::db)?;
            match cwd {
                Some(cwd) => Ok(cwd),
                None => Err(DomainError::new(
                    atm_domain::error::ErrorCode::SESSION_NOT_FOUND,
                    format!("Session 不存在：{session}"),
                )
                .detail("entity", "SESSION")
                .detail("reference", session)),
            }
        })
    }

    /// `GET /projects/:code/records`（#33）：2.0 `RecordView` 分页。
    pub fn ui_records(
        &self,
        principal: &Principal,
        project: &str,
        limit: Option<usize>,
        cursor: Option<String>,
    ) -> Result<Value, DomainError> {
        self.read_project(principal, Capability::RecordRead, project, |cx| {
            let r = ListRequest {
                limit: limit.unwrap_or(20).clamp(1, 100),
                cursor,
                ..ListRequest::default()
            };
            let page = record_page(cx, &r)?;
            Ok(page_of(page.items, &page.item_cursors, page.has_more, 1))
        })
    }

    /// `GET /projects/:code/reconciliation`（#32）：2.0 `ReconciliationResult`，一次给全（上限 100 项）。
    pub fn ui_reconciliation(
        &self,
        principal: &Principal,
        project: &str,
        include_active: bool,
    ) -> Result<Value, DomainError> {
        let v = self.reconcile(
            principal,
            project,
            &ReconcileRequest {
                include_active,
                limit: 100,
                max_chars: 50_000,
                ..ReconcileRequest::default()
            },
        )?;
        Ok(json!({
            "project": {
                "code": v["project"],
                "name": v["project_name"],
                "sourceRoot": v["source_root"],
            },
            "generatedAt": v["generated_at"],
            "attentionCount": v["attention_count"],
            "counts": v["counts"],
            "items": camel(v["items"].clone(), 2),
        }))
    }

    /// `GET /projects/:code/events`（#79 的界面形状）：每条事件带项目，`{events, currentSequence, hasMore}`。
    pub fn ui_events(
        &self,
        principal: &Principal,
        project: &str,
        since: Option<i64>,
        limit: usize,
        types: &[String],
    ) -> Result<Value, DomainError> {
        if since.is_some_and(|s| s < 0) {
            return Err(DomainError::invalid_argument(vec![
                atm_domain::error::Problem::new("since", atm_domain::error::ProblemKind::Pattern)
                    .allowed("a non-negative event sequence"),
            ]));
        }
        self.read_project(principal, Capability::EventsRead, project, |cx| {
            let page = delta::events(cx, since, limit.clamp(1, 100), types)?;
            let project = json!({ "id": cx.p.id, "code": cx.p.code, "name": cx.p.name });
            let events: Vec<Value> = page
                .events
                .into_iter()
                .map(|mut e| {
                    if let Value::Object(m) = &mut e {
                        if let Some(op) = m.remove("op_id") {
                            m.insert("opId".into(), op);
                        }
                        m.insert("project".into(), project.clone());
                        m.insert("projectCode".into(), json!(cx.p.code));
                        m.insert("projectName".into(), json!(cx.p.name));
                    }
                    e
                })
                .collect();
            Ok(json!({
                "events": events,
                "currentSequence": cx.p.seq,
                "hasMore": page.has_more,
            }))
        })
    }

    /// `GET /settings`（#9）：裸数组 `[{key, value, version, updatedAt}]`。
    pub fn ui_settings(&self, principal: &Principal) -> Result<Value, DomainError> {
        Ok(unwrap(self.list_settings(principal)?, "settings"))
    }

    /// `GET /saved-views`（#5）：裸数组。
    pub fn ui_saved_views(
        &self,
        principal: &Principal,
        project: Option<&str>,
    ) -> Result<Value, DomainError> {
        Ok(unwrap(self.list_saved_views(principal, project)?, "views"))
    }

    /// `GET /quick-tasks`（#84 的界面形状）：裸数组。
    pub fn ui_quick_tasks(
        &self,
        principal: &Principal,
        status: Option<&str>,
    ) -> Result<Value, DomainError> {
        Ok(unwrap(self.quick_list(principal, status)?, "quick_tasks"))
    }

    /// `POST /projects/:code/sessions/:id/git-context/refresh`（#83 的界面形状）：2.0 回 `{updated, sequence, session}`。
    /// git 在事务之外跑（`inspect` 拿 session 的工作目录，没有工作目录就是空的上下文），写入按 S-022 无变化不写。
    pub fn ui_refresh_git(
        &self,
        principal: &Principal,
        project: &str,
        session: &str,
        inspect: &dyn Fn(&str) -> GitContext,
    ) -> Result<Value, DomainError> {
        let cwd = self.ui_session_cwd(principal, project, session)?;
        let git = cwd.as_deref().map(inspect).unwrap_or_default();
        let id = self.project_id(principal, project)?;
        let r = self.refresh_git_context(principal, &id, session, git)?;
        let view = self.read_project(principal, Capability::SessionRead, project, |cx| {
            views::session(cx, session.trim())
        })?;
        Ok(json!({
            "updated": r["updated"],
            "sequence": r["sequence"],
            "session": camel(jsify(view), 2),
        }))
    }

    /// `POST /backups`（#23 的界面形状）：手动备份，回 2.0 的 `BackupView`（与 #22 列表的一项同形）。
    pub fn ui_create_backup(&self, principal: &Principal) -> Result<Value, DomainError> {
        Ok(backup_view(&self.create_manual_backup(principal)?))
    }

    /// `GET /backups`（#22 的界面形状）：2.0 `BackupView` 的裸数组。3.0 的备份是整库的（方案 §4），
    /// `scope` 是 `STORE`，按范围恢复由恢复入口选；「3.0 / 2.x 备份」两栏的新界面在 W6。
    pub fn ui_backups(&self, principal: &Principal) -> Result<Value, DomainError> {
        let v = self.list_backups(principal, 100)?;
        let rows = v["backups"].as_array().cloned().unwrap_or_default();
        Ok(Value::Array(rows.iter().map(backup_view).collect()))
    }
}

/// 2.0 的 `BackupView`：3.0 的备份是整库的，`scope` 是 `STORE`，没有单项目字段；`reason` 是备份的种类。
fn backup_view(b: &Value) -> Value {
    json!({
        "id": b["id"],
        "scope": "STORE",
        "projectId": null,
        "projectCode": null,
        "path": null,
        "sha256": b["sha256"],
        "sizeBytes": b["sizeBytes"],
        "reason": b["kind"],
        "schemaVersion": b["schemaVersion"],
        "createdAt": b["createdAt"],
        "verifiedAt": b["verifiedAt"],
    })
}
