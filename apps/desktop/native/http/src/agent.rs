//! MCP 工具 → 服务入口（W4c 读工具；写工具在 W4d）。参数已经过 [`crate::schema`] 校验与规范化，
//! 这里只做字段映射、省略项的推断（R11 A3：project 按最终生效的 session 推出）和错误装信封。

use crate::Agent;
use crate::mcp::Handler;
use crate::schema::{Checked, Tool};
use atm_domain::error::{Committed, DomainError, Envelope, ErrorCode, Fix};
use atm_domain::principal::Principal;
use atm_service::read::{
    BriefRequest, DeltaRequest, KnowledgeGetRequest, KnowledgeSearchRequest, Part,
    ReconcileRequest, SearchRequest, TaskGetRequest, TaskListRequest, TaskView,
};
use atm_service::write::Service;
use serde_json::{Map, Value};
use std::sync::Arc;

/// Agent 面：一个服务实例上的全部 MCP 工具。
pub struct Surface {
    svc: Arc<Service>,
}

impl Surface {
    pub fn new(svc: Arc<Service>) -> Arc<Surface> {
        Arc::new(Surface { svc })
    }

    /// 交给 [`crate::mcp::routes`] 的处理器。
    pub fn handler(self: &Arc<Surface>) -> Handler {
        let me = self.clone();
        Arc::new(
            move |agent: &Agent, tool: &'static Tool, checked: Checked| {
                me.call(&agent.0, tool, checked)
            },
        )
    }

    fn call(&self, p: &Principal, tool: &Tool, checked: Checked) -> Result<Value, Envelope> {
        let a = Args(&checked.args);
        let out = match tool.name {
            "atm_brief" => self.brief(p, &a).inspect(|_| self.touch(p, &a)),
            "atm_task_list" => self.task_list(p, &a).inspect(|_| self.touch(p, &a)),
            "atm_task_get" => self.task_get(p, &a).inspect(|_| self.touch(p, &a)),
            "atm_search" => self.search(p, &a),
            "atm_knowledge_search" => self.knowledge_search(p, &a),
            "atm_knowledge_get" => self.knowledge_get(p, &a),
            "atm_delta" => self.delta(p, &a),
            _ => Err(DomainError::new(
                ErrorCode::INTERNAL_ERROR,
                format!("{} 还没有接到服务上", tool.name),
            )),
        };
        out.map_err(read_envelope)
    }

    /// owner 的读也续租（R11 P3）：读成功、而且带着读者自己的 session 时，刷新心跳并给它的领取续租。
    /// 尽力而为：续租失败（例如存储正忙）不影响这次读的结果，下一次读或写还会再续。
    fn touch(&self, p: &Principal, a: &Args<'_>) {
        if let Some(session) = a.str("session") {
            let _ = self.svc.touch_session(p, &session);
        }
    }

    /// 省略 project 时按 session 推出（R11 A3）；两者都没有就要先 begin 或补 session。
    fn project(&self, p: &Principal, a: &Args<'_>) -> Result<String, DomainError> {
        if let Some(project) = a.str("project") {
            return Ok(project);
        }
        match a.str("session") {
            Some(session) => Ok(self.svc.session_scope(p, &session)?.project),
            None => Err(DomainError::new(
                ErrorCode::SESSION_REQUIRED,
                "没有 project，也没有可以推出项目的 session：先 atm_begin，或带上 project / session",
            )
            .detail("next", serde_json::json!({"operation": "begin"}))),
        }
    }

    fn brief(&self, p: &Principal, a: &Args<'_>) -> Result<Value, DomainError> {
        let project = self.project(p, a)?;
        let mut r = BriefRequest {
            session: a.str("session"),
            task_key: a.str("task_key"),
            since_seq: a.int("since_seq"),
            cursor: a.str("cursor"),
            include: a.strs("include"),
            ..BriefRequest::default()
        };
        if let Some(n) = a.usize("max_chars") {
            r.max_chars = n;
        }
        self.svc.brief(p, &project, &r)
    }

    fn task_list(&self, p: &Principal, a: &Args<'_>) -> Result<Value, DomainError> {
        let project = self.project(p, a)?;
        let mine_session = if a.bool("mine") {
            Some(a.str("session").ok_or_else(|| {
                DomainError::new(
                    ErrorCode::SESSION_REQUIRED,
                    "mine:true 要知道是哪个会话：带上 session",
                )
            })?)
        } else {
            None
        };
        let mut r = TaskListRequest {
            status: a.str("status"),
            owner: a.str("owner"),
            parent_key: a.str("parent_key"),
            milestone_id: a.str("milestone_id"),
            ready_only: a.bool("ready_only"),
            query: a.str("query"),
            mine_session,
            cursor: a.str("cursor"),
            field_mask: a.strs("field_mask"),
            ..TaskListRequest::default()
        };
        if a.str("view").as_deref() == Some("reconcile") {
            // 对账视图只看 include_active、limit、cursor、field_mask、max_chars（与 2.x 相同）。
            let mut rr = ReconcileRequest {
                include_active: a.bool("include_active"),
                cursor: a.str("cursor"),
                field_mask: a.strs("field_mask"),
                ..ReconcileRequest::default()
            };
            if let Some(n) = a.usize("limit") {
                rr.limit = n;
            }
            if let Some(n) = a.usize("max_chars") {
                rr.max_chars = n;
            }
            return self.svc.reconcile(p, &project, &rr);
        }
        if let Some(view) = a.str("view").and_then(|v| TaskView::parse(&v)) {
            r.view = view;
        }
        if let Some(n) = a.usize("limit") {
            r.limit = n;
        }
        if let Some(n) = a.usize("max_chars") {
            r.max_chars = n;
        }
        self.svc.task_list(p, &project, &r)
    }

    fn task_get(&self, p: &Principal, a: &Args<'_>) -> Result<Value, DomainError> {
        let project = self.project(p, a)?;
        let mut r = TaskGetRequest::new(a.str("task_key").unwrap_or_default());
        if let Some(view) = a.str("view").and_then(|v| TaskView::parse(&v)) {
            r.view = view;
        }
        r.field_mask = a.strs("field_mask");
        r.cursor = a.str("cursor");
        r.last_progress = a.int("last_progress");
        if let Some(n) = a.usize("max_chars") {
            r.max_chars = n;
        }
        self.svc.task_get(p, &project, &r)
    }

    fn search(&self, p: &Principal, a: &Args<'_>) -> Result<Value, DomainError> {
        let mut r = SearchRequest {
            list: a.str("list"),
            project: a.str("project"),
            query: a.str("query"),
            op_id: a.str("op_id"),
            session: a.str("session"),
            cursor: a.str("cursor"),
            field_mask: a.strs("field_mask"),
            task_key: a.str("task_key"),
            ..SearchRequest::default()
        };
        // 列表与操作回查要项目：省略时按 session 推出。
        if r.project.is_none() && (r.list.is_some() || r.op_id.is_some()) && r.session.is_some() {
            r.project = Some(self.project(p, a)?);
        }
        if let Some(n) = a.usize("limit") {
            r.limit = n;
        }
        if let Some(n) = a.usize("max_chars") {
            r.max_chars = n;
        }
        self.svc.search(p, &r)
    }

    fn knowledge_search(&self, p: &Principal, a: &Args<'_>) -> Result<Value, DomainError> {
        let mut r = KnowledgeSearchRequest {
            query: a.str("query").unwrap_or_default(),
            tag: a.str("tag"),
            include_archived: a.bool("include_archived"),
            cursor: a.str("cursor"),
            ..KnowledgeSearchRequest::default()
        };
        if let Some(n) = a.int("limit") {
            r.limit = n;
        }
        if let Some(n) = a.int("max_chars") {
            r.max_chars = n;
        }
        self.svc.knowledge_search(p, &r)
    }

    fn knowledge_get(&self, p: &Principal, a: &Args<'_>) -> Result<Value, DomainError> {
        let mut r = KnowledgeGetRequest::new(a.str("id").unwrap_or_default());
        r.for_edit = a.bool("for_edit");
        r.revision_id = a.str("revision_id");
        r.section = a.str("section");
        r.cursor = a.str("cursor");
        if a.str("part").as_deref() == Some("metadata") {
            r.part = Part::Metadata;
        }
        if let Some(n) = a.int("max_chars") {
            r.max_chars = n;
        }
        self.svc.knowledge_get(p, &r)
    }

    fn delta(&self, p: &Principal, a: &Args<'_>) -> Result<Value, DomainError> {
        let project = self.project(p, a)?;
        let mut r = DeltaRequest {
            since_seq: a.int("since_seq"),
            types: a.strs("types"),
            ..DeltaRequest::default()
        };
        if let Some(n) = a.usize("limit") {
            r.limit = n;
        }
        if let Some(n) = a.usize("max_chars") {
            r.max_chars = n;
        }
        self.svc.delta(p, &project, &r)
    }
}

/// 读失败的信封：读什么都没写，`committed:false`。fix 由 W4e 的生成器补全；在那之前 `details.next`
/// 原样带出，Agent 仍能看到下一步。
fn read_envelope(e: DomainError) -> Envelope {
    Envelope::new(e, Committed::No, None, Fix::None)
}

/// 规范化之后的参数（键已是规范名，枚举已是规范写法，`null` 已去掉）。
struct Args<'a>(&'a Map<String, Value>);

impl Args<'_> {
    fn str(&self, k: &str) -> Option<String> {
        self.0.get(k).and_then(Value::as_str).map(str::to_owned)
    }

    fn int(&self, k: &str) -> Option<i64> {
        self.0.get(k).and_then(Value::as_i64)
    }

    fn usize(&self, k: &str) -> Option<usize> {
        self.int(k).and_then(|n| usize::try_from(n).ok())
    }

    fn bool(&self, k: &str) -> bool {
        self.0.get(k).and_then(Value::as_bool).unwrap_or(false)
    }

    fn strs(&self, k: &str) -> Vec<String> {
        self.0
            .get(k)
            .and_then(Value::as_array)
            .map(|v| {
                v.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    }
}
