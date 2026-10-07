//! MCP 写工具 → 服务入口（W4d；R11 P1～P3、A1、A3；01 W-050；01 Q-04；03 C-04、P-001）。
//!
//! 参数已经过 [`crate::schema`] 校验与规范化。这里做：
//! - 写入目标：project 省略时按最终生效的 session 推出（A3），op_id 省略时签发 `auto:<ULID>`；
//! - R11 的默认值与推断：progress 的 scope、end 的 outcome、task_create 的 depends_on / parent 合并写法、
//!   task_patch 的单条顶层写法与 `checklist` 合称（按条数分派到 single / batch）、record 的 `ATM_FEEDBACK`；
//! - 复合操作只能单条、`takeover_stale` 只能 false（W-050，服务层每个复合操作是独立入口，规则在这一层）；
//! - begin 的项目识别、git 上下文、A1 白名单与提交后的 marker（C-L03）；
//! - 回执：服务的固定形状 ACK 加上 v6 字段（`merges` 在顶层、`auto_applied`、`refs`、`checklist`、
//!   `deprecations`、`adjusted`、`normalized`）。

use crate::agent::{Args, Surface};
use crate::schema::{Renamed, Tool};
use crate::workspace;
use atm_domain::error::{
    Committed, DomainError, Envelope, ErrorCode, Fix, Problem, ProblemKind, ToolCall,
};
use atm_domain::evidence::{Evidence, EvidenceKind};
use atm_domain::gate::ChecklistStatus;
use atm_domain::principal::Principal;
use atm_domain::work::{Operation, Status};
use atm_service::knowledge::{AgentSave, Content, SourceRef};
use atm_service::memory::{
    Completed, FeedbackRequest, ProgressRequest, ProgressScope, RecordRequest,
};
use atm_service::read::BeginBrief;
use atm_service::session::{BeginRequest, EndRequest, Outcome, Resume};
use atm_service::work::{
    ChecklistBatch, ChecklistChange, ChecklistRef, ChecklistSingle, CompleteChecklist, CreateItem,
    EditFields, ExpectedFields, NewChecklist, PatchItem, ReviewRequest, ReviewSubmit, Target,
    Verdict, VerifyAndComplete,
};
use atm_service::write::Written;
use serde_json::{Map, Value, json};

/// R11 A1：已知「一个连接只承载一个对话」的客户端（MCP `initialize` 的 `clientInfo.name`，不分大小写）。
/// 只有它们开的 session 才做同连接组接回；每一项都要在 W4j 用真实客户端实测确认（A4）。
pub const SINGLE_CONVERSATION_CLIENTS: &[&str] = &["claude-code", "codex-mcp-client"];

/// 连接组身份（A4）里的客户端名：桥发的是 `<祖先 pid>:<创建时间>@<clientInfo.name>`。没有 `@` 的
/// （直连 HTTP、自己拼头的脚本）没有客户端名，按非白名单处理。
pub fn client_name(group: &str) -> Option<&str> {
    group
        .split_once('@')
        .map(|(_, name)| name.trim())
        .filter(|n| !n.is_empty())
}

/// 这个连接是不是白名单里的单对话客户端。
pub fn single_conversation(group: Option<&str>) -> bool {
    group.and_then(client_name).is_some_and(|name| {
        SINGLE_CONVERSATION_CLIENTS
            .iter()
            .any(|c| c.eq_ignore_ascii_case(name))
    })
}

/// 写入的落点：项目代码与内部 id、session、op_id、世代。
struct Place {
    code: String,
    target: Target,
}

/// 写失败的信封：服务内部错误时不知道事务是否已经提交（`committed:"unknown"`，用同一 op_id 重试或回查），
/// 其余错误都在提交前就被拒绝。
fn write_envelope(e: DomainError) -> Envelope {
    let committed = if e.code == ErrorCode::INTERNAL_ERROR {
        Committed::Unknown
    } else {
        Committed::No
    };
    Envelope::new(e, committed, None, Fix::None)
}

fn invalid(problems: Vec<Problem>) -> DomainError {
    DomainError::invalid_argument(problems)
}

impl Surface {
    pub(crate) fn write(
        &self,
        p: &Principal,
        tool: &Tool,
        a: &Args<'_>,
        normalized: &[Renamed],
    ) -> Result<Value, Envelope> {
        let out = match tool.name {
            "atm_begin" => return self.begin(p, a),
            "atm_task_create" => self.task_create(p, a),
            "atm_task_patch" => self.task_patch(p, a),
            "atm_progress_add" => self.progress_add(p, a),
            "atm_record" => self.record(p, a),
            "atm_feedback" => self.feedback(p, a),
            "atm_end" => self.end(p, a),
            "atm_knowledge_save" => self.knowledge_save(p, a),
            _ => Err(DomainError::new(
                ErrorCode::INTERNAL_ERROR,
                format!("{} 没有接到服务上", tool.name),
            )),
        };
        out.map(|mut ack| {
            if !normalized.is_empty()
                && let Value::Object(m) = &mut ack
            {
                m.insert("normalized".into(), json!(normalized));
            }
            ack
        })
        .map_err(write_envelope)
    }

    /// 写入目标（A3 的逐字段补缺）：显式给的原样用，project 省略时按 session 推出，op_id 省略时签发。
    fn place(&self, p: &Principal, a: &Args<'_>) -> Result<Place, DomainError> {
        let code = self.project(p, a)?;
        let id = self.svc.project_id(p, &code)?;
        let op_id = match a.str("op_id") {
            Some(op) => op,
            None => self.svc.auto_op_id()?,
        };
        let mut target = Target::new(id, a.str("session").as_deref(), op_id);
        target.expected_generation = a.int("expected_scope_generation");
        Ok(Place { code, target })
    }

    /// 服务的固定形状 ACK（02 §4.7），再叠上 v6 从写结果里带出的字段。
    fn ack(&self, place: &Place, operation: &str, written: &Written) -> Result<Value, DomainError> {
        let mut ack = self.svc.mutation_ack(
            &place.code,
            operation,
            &place.target.op_id,
            place.target.session.as_deref(),
            written,
        )?;
        let r = &written.result;
        if let Value::Object(m) = &mut ack {
            // 01 Q-04：安全合并在 ACK 顶层，Agent 不必再去 details 里找。
            if let Some(merges) = r.get("merges").filter(|v| !v.is_null()) {
                m.insert("merges".into(), merges.clone());
            }
            // R11 P1-1：自动补的 start。
            if let Some(Value::Array(auto)) = r.get("autoApplied") {
                let auto: Vec<Value> = auto
                    .iter()
                    .map(|x| json!({"task_key": x["taskKey"], "operations": x["operations"]}))
                    .collect();
                m.insert("auto_applied".into(), Value::Array(auto));
            }
            // R11 P2-4：client_ref → key 与新检查项的 id。
            if operation == "work.create.batch" {
                for k in ["refs", "checklist"] {
                    if let Some(v) = r.get(k) {
                        m.insert(k.into(), v.clone());
                    }
                }
            }
            if let Some(d) = r.get("deprecations").filter(|v| !v.is_null()) {
                m.insert("deprecations".into(), d.clone());
            }
            // R11 P2-1：summary 太长时服务端截断，全文移到 detail。
            if r.get("summaryTruncated") == Some(&Value::Bool(true)) {
                m.insert(
                    "adjusted".into(),
                    json!([{"field": "summary", "action": "truncated", "moved_to": "detail"}]),
                );
            }
        }
        Ok(ack)
    }

    // ---- begin ---------------------------------------------------------------------------------

    /// begin 的错误分两段：开会话失败时没有提交；会话已经开好、附带的 brief 读失败时已经提交，
    /// 不能让 Agent 以为没开成而重试（重试会再开一个），改为指向 atm_brief。
    fn begin(&self, p: &Principal, a: &Args<'_>) -> Result<Value, Envelope> {
        let cwd = a.str("cwd");
        let mut req = BeginRequest::new(a.str("agent_id").unwrap_or_default());
        req.selector = workspace::selector(a.str("project"), cwd.as_deref());
        // A1 按「规范化后的 cwd」接回：存 realpath，同一目录不同写法也是同一个。
        req.cwd = req.selector.canonical_path.clone().or(cwd.clone());
        req.git = cwd.as_deref().map(workspace::git_context);
        req.title = a.str("title");
        req.mode = a.str("mode");
        req.display_name = a.str("display_name");
        req.client_kind = a.str("client_kind");
        req.parent_session_id = a.str("parent_session_id");
        req.thread_id = a.str("thread_id");
        req.role = a.str("role");
        req.git_branch = a.str("git_branch");
        req.resume = match a.get("resume") {
            Some(Value::Bool(true)) => Some(Resume::Yes),
            Some(Value::Bool(false)) => Some(Resume::No),
            Some(Value::String(_)) => Some(Resume::Auto),
            _ => None,
        };
        req.session = a.str("session");
        req.predecessor_session_id = a.str("predecessor_session_id");
        if let Some(Value::Object(signals)) = a.get("signals") {
            req.signals = signals.clone();
        }
        req.allow_project_create = a.bool("allow_project_create");
        req.creation_reason = a.str("creation_reason");
        req.single_conversation = single_conversation(p.client_group());
        req.op_id = a.str("op_id");
        req.expected_generation = a.int("expected_scope_generation");
        let written = self.svc.begin(p, req).map_err(write_envelope)?;
        // C-L03：marker 与 git exclude 在提交之后写，写没写成如实报告（失败不影响已经开好的 session）。
        let marker_written = written
            .result
            .get("marker")
            .filter(|m| m.is_object())
            .map(workspace::write_marker);
        let mode = a
            .str("brief")
            .and_then(|b| BeginBrief::parse(&b))
            .unwrap_or(BeginBrief::Full);
        let mut out = self
            .svc
            .begin_brief(p, &written, mode, a.usize("max_chars").unwrap_or(1200))
            .map_err(|e| {
                let project = written.result["project"]["code"].clone();
                let session = written.result["session"]["id"].clone();
                let e = e
                    .detail("session_id", session.clone())
                    .detail("project", project.clone());
                Envelope::new(
                    e,
                    Committed::Yes,
                    None,
                    Fix::Call {
                        call: ToolCall {
                            name: "atm_brief".into(),
                            arguments: json!({"project": project, "session": session}),
                        },
                        why: "会话已经开好，只是附带的 brief 没读出来：不要重新 begin，改读 brief"
                            .into(),
                    },
                )
            })?;
        if let (Some(ok), Value::Object(m)) = (marker_written, &mut out) {
            m.insert("marker_written".into(), json!(ok));
        }
        Ok(out)
    }

    // ---- task_create ---------------------------------------------------------------------------

    fn task_create(&self, p: &Principal, a: &Args<'_>) -> Result<Value, DomainError> {
        let place = self.place(p, a)?;
        let items: Vec<&Map<String, Value>> = a
            .get("items")
            .and_then(Value::as_array)
            .map(|v| v.iter().filter_map(Value::as_object).collect())
            .unwrap_or_default();
        // 批内引用名：显式 client_ref，否则从 1 开始的序号（服务端同一规则）。
        let refs: Vec<String> = items
            .iter()
            .enumerate()
            .map(|(i, m)| Args(m).str("client_ref").unwrap_or((i + 1).to_string()))
            .collect();
        let code = atm_domain::keys::normalize(&place.code);
        let link = Link {
            code: &code,
            refs: &refs,
        };
        let mut out = Vec::with_capacity(items.len());
        for m in items {
            let i = Args(m);
            let mut item = CreateItem {
                client_ref: i.str("client_ref"),
                title: i.str("title").unwrap_or_default(),
                objective_id: i.str("objective_id"),
                milestone_id: i.nullable("milestone_id"),
                parent_key: i.str("parent_key"),
                parent_ref: i.str("parent_ref"),
                depends_on_refs: i.strs("depends_on_refs"),
                discovered_from_ref: i.str("discovered_from_ref"),
                description: i.str("description"),
                kind: i.str("type"),
                priority: i.str("priority"),
                status: i.str("status").and_then(|s| Status::parse(&s)),
                acceptance: i.strs("acceptance"),
                weight: i.num("weight"),
                target_date: i.str("target_date"),
                verification_required: i.bool("verification_required"),
                assignee_agent_id: i.str("assignee_agent_id"),
                ..CreateItem::default()
            };
            // R11 P1-4 第 5 条：形如任务 key 的是已有任务，否则是本批的引用（client_ref 或序号）。
            for v in i.strs("depends_on") {
                match link.resolve(&v) {
                    Linked::Key(k) => item.depends_on.push(k),
                    Linked::Ref(r) => item.depends_on_refs.push(r),
                }
            }
            if let Some(v) = i.str("parent") {
                match link.resolve(&v) {
                    Linked::Key(k) => item.parent_key = Some(k),
                    Linked::Ref(r) => item.parent_ref = Some(r),
                }
            }
            if let Some(v) = i.str("discovered_from") {
                match link.resolve(&v) {
                    Linked::Key(k) => item.discovered_from = Some(k),
                    Linked::Ref(r) => item.discovered_from_ref = Some(r),
                }
            }
            if let Some(Value::Array(list)) = i.get("checklist") {
                item.checklist = list
                    .iter()
                    .filter_map(Value::as_object)
                    .map(|c| {
                        let c = Args(c);
                        NewChecklist {
                            title: c.str("title").unwrap_or_default(),
                            evidence_required: c.bool("evidence_required"),
                            weight: c.num("weight"),
                        }
                    })
                    .collect();
            }
            out.push(item);
        }
        let written = self.svc.create_work_items(p, &place.target, out)?;
        self.ack(&place, "work.create.batch", &written)
    }

    // ---- task_patch ----------------------------------------------------------------------------

    fn task_patch(&self, p: &Principal, a: &Args<'_>) -> Result<Value, DomainError> {
        // 单条可以直接写在顶层（R11 P1-4 第 4 条）；校验器已经保证两种写法不混用。
        let (items, flat): (Vec<&Map<String, Value>>, bool) = match a.get("items") {
            Some(Value::Array(list)) => (list.iter().filter_map(Value::as_object).collect(), false),
            _ => (vec![a.0], true),
        };
        let path = |i: usize, f: &str| {
            if flat {
                f.to_owned()
            } else {
                format!("items[{i}].{f}")
            }
        };
        let ops: Vec<String> = items
            .iter()
            .map(|m| Args(m).str("operation").unwrap_or_default())
            .collect();
        let mut problems = Vec::new();
        for (i, (m, op)) in items.iter().zip(&ops).enumerate() {
            problems.extend(item_problems(&Args(m), op, &|f| path(i, f)));
        }
        // W-050：复合操作只能单条。
        if items.len() > 1 {
            for (i, op) in ops.iter().enumerate() {
                if COMPOSITE.contains(&op.as_str()) {
                    problems.push(
                        Problem::new(path(i, "operation"), ProblemKind::Conflict)
                            .got(op.as_str())
                            .allowed(
                                "复合操作（verify_and_complete、checklist、review_*）只能单独一条",
                            ),
                    );
                }
            }
        }
        if !problems.is_empty() {
            problems.sort_by(|x, y| x.path.cmp(&y.path));
            return Err(invalid(problems));
        }
        let place = self.place(p, a)?;
        let first = Args(items[0]);
        match ops[0].as_str() {
            "verify_and_complete" => {
                let req = VerifyAndComplete {
                    task_key: first.str("task_key").unwrap_or_default(),
                    expected_version: first.int("expected_version"),
                };
                let written = self.svc.verify_and_complete(p, &place.target, req)?;
                self.ack(&place, "work.verify-and-complete", &written)
            }
            "review_request" => {
                let req = ReviewRequest {
                    review_task_key: first.str("task_key").unwrap_or_default(),
                    expected_review_task_version: first.int("expected_version"),
                    parent_checklist_id: first.str("parent_checklist_id").unwrap_or_default(),
                    expected_parent_checklist_version: first
                        .int("expected_parent_checklist_version")
                        .unwrap_or_default(),
                    candidate_hashes: hashes(&first, &path(0, "candidate_hashes"))?,
                };
                let written = self.svc.request_review(p, &place.target, req)?;
                self.ack(&place, "review.request.create", &written)
            }
            "review_submit" => {
                let req = ReviewSubmit {
                    request_key: first.str("request_key").unwrap_or_default(),
                    review_task_key: first.str("review_task_key").or(first.str("task_key")),
                    expected_review_task_version: first.int("expected_version"),
                    verdict: match first.str("verdict").as_deref() {
                        Some("CHANGES_REQUESTED") => Verdict::ChangesRequested,
                        _ => Verdict::Approved,
                    },
                    reviewed_hashes: hashes(&first, &path(0, "candidate_hashes"))?,
                    evidence: evidence(first.get("evidence")).unwrap_or_default(),
                };
                let written = self.svc.submit_review(p, &place.target, req)?;
                self.ack(&place, "review.submit", &written)
            }
            op @ ("checklist" | "checklist_single" | "checklist_batch") => {
                self.checklist(p, &place, &first, op, flat)
            }
            _ => {
                let list = items
                    .iter()
                    .map(|m| patch_item(&Args(m)))
                    .collect::<Vec<_>>();
                let written = self.svc.patch_work_items(p, &place.target, list)?;
                self.ack(&place, "work.patch.batch", &written)
            }
        }
    }

    /// `checklist`：一条改动走 checklist_single（比检查项自己的版本），多条走 checklist_batch（比任务版本）。
    /// 旧名 `checklist_single` / `checklist_batch` 照旧语义执行，回执给弃用提示（11 §4）。
    fn checklist(
        &self,
        p: &Principal,
        place: &Place,
        a: &Args<'_>,
        op: &str,
        flat: bool,
    ) -> Result<Value, DomainError> {
        let at = |f: &str| {
            if flat {
                f.to_owned()
            } else {
                format!("items[0].{f}")
            }
        };
        let task_key = a.str("task_key").unwrap_or_default();
        let mut changes = changes(a);
        if changes.is_empty() {
            return Err(invalid(vec![Problem::new(
                at("checklist"),
                ProblemKind::Missing,
            )]));
        }
        // 序号与标题换成 id（与 complete 的 checklist 同一顺序）；找不到的原样交给服务报 CHECKLIST_NOT_FOUND。
        let index = self.svc.checklist_index(p, &place.code, &task_key)?;
        for (i, c) in changes.iter_mut().enumerate() {
            c.id = resolve_item(&index, &c.item, &task_key, i)?;
        }
        let expected_version = a.int("expected_version");
        let root_cv = a.int("expected_checklist_version");
        let single = match op {
            "checklist_single" => true,
            "checklist_batch" => false,
            _ => changes.len() == 1 && expected_version.is_none(),
        };
        let mut deprecated = (op != "checklist").then(|| {
            json!({"field": "operation", "use": "checklist", "message": format!("operation {op} 已合并为 checklist（按条数自动分派）")})
        });
        let written = if single {
            if changes.len() > 1 {
                return Err(invalid(vec![
                    Problem::new(at("checklist"), ProblemKind::TooMany).allowed(1),
                ]));
            }
            let c = changes.remove(0);
            // 旧名 checklist_single 的 expected_version 比的是检查项版本（C-12）。
            let legacy = op == "checklist_single" && c.version.is_none() && root_cv.is_none();
            let req = ChecklistSingle {
                task_key: Some(task_key),
                checklist_id: c.id,
                expected_checklist_version: c.version.or(root_cv).or(if legacy {
                    expected_version
                } else {
                    None
                }),
                legacy_version_name: legacy && expected_version.is_some(),
                status: c.status,
                evidence: c.evidence,
            };
            let w = self.svc.update_checklist(p, &place.target, req)?;
            (w, "checklist.update")
        } else {
            if let Some(i) = changes.iter().position(|c| c.version.is_some()) {
                return Err(invalid(vec![
                    Problem::new(
                        at(&format!("checklist[{i}].expected_checklist_version")),
                        ProblemKind::Conflict,
                    )
                    .allowed("多条改动比的是任务版本：只写 expected_version"),
                ]));
            }
            let req = ChecklistBatch {
                task_key,
                expected_version,
                items: changes
                    .into_iter()
                    .map(|c| ChecklistChange {
                        checklist_id: c.id,
                        status: c.status,
                        evidence: c.evidence,
                    })
                    .collect(),
            };
            let w = self.svc.update_checklist_batch(p, &place.target, req)?;
            (w, "checklist.update.batch")
        };
        let mut ack = self.ack(place, written.1, &written.0)?;
        if let (Some(d), Value::Object(m)) = (deprecated.take(), &mut ack) {
            match m.get_mut("deprecations") {
                Some(Value::Array(list)) => list.push(d),
                _ => {
                    m.insert("deprecations".into(), json!([d]));
                }
            }
        }
        Ok(ack)
    }

    // ---- progress / record / feedback ----------------------------------------------------------

    fn progress_add(&self, p: &Principal, a: &Args<'_>) -> Result<Value, DomainError> {
        let place = self.place(p, a)?;
        // R11 P2-2：scope 省略时，有 task_key 就是任务进度。
        let scope = match a.str("scope").as_deref() {
            Some("task") => ProgressScope::Task,
            Some(_) => ProgressScope::Project,
            None if a.has("task_key") => ProgressScope::Task,
            None => ProgressScope::Project,
        };
        let completed = a
            .get("completed")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|c| match c {
                        Value::String(s) => Some(Completed::Text(s.clone())),
                        Value::Object(m) => Some(Completed::Item {
                            text: Args(m).str("text").unwrap_or_default(),
                            work_item_key: Args(m).str("task_key"),
                        }),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default();
        let req = ProgressRequest {
            scope,
            task_key: a.str("task_key"),
            summary: a.str("summary").unwrap_or_default(),
            percent: a.num("percent"),
            completed,
            next: a.strs("next"),
            evidence: evidence(a.get("evidence")).unwrap_or_default(),
            blocker: a.str("blocker"),
            health: a.str("health"),
        };
        // 项目进度在服务里是另一个 operation（2.x 同样分开），回执的实体也不同。
        let operation = match scope {
            ProgressScope::Task => "work.progress",
            ProgressScope::Project => "project-update.publish",
        };
        let written = self.svc.add_progress(p, &place.target, req)?;
        self.ack(&place, operation, &written)
    }

    fn record(&self, p: &Principal, a: &Args<'_>) -> Result<Value, DomainError> {
        let kind = a.str("kind").unwrap_or_default();
        if kind == "ATM_FEEDBACK" {
            // R11 P3：feedback 并入 record。标题并进 detail 的第一行（feedback 的标题由服务按 summary 生成）。
            let title = a.str("title").unwrap_or_default();
            let detail = match a.str("detail").filter(|d| !d.trim().is_empty()) {
                Some(d) => format!("{title}\n\n{d}"),
                None => title,
            };
            let req = FeedbackRequest {
                summary: a.str("summary").unwrap_or_default(),
                detail: Some(detail),
                tool: None,
                severity: a.str("importance"),
                task_key: a.str("task_key"),
            };
            return self.send_feedback(p, a, req);
        }
        let place = self.place(p, a)?;
        let mut req = RecordRequest::new(
            &kind,
            &a.str("title").unwrap_or_default(),
            &a.str("summary").unwrap_or_default(),
        );
        req.detail = a.str("detail").unwrap_or_default();
        req.importance = a.str("importance");
        req.scope = a.str("scope");
        req.work_item_key = a.str("task_key");
        req.supersedes = a.str("supersedes");
        req.topic = a.str("topic");
        req.subject_key = a.str("subject_key");
        let written = self.svc.create_record(p, &place.target, req)?;
        self.ack(&place, "record.create", &written)
    }

    fn feedback(&self, p: &Principal, a: &Args<'_>) -> Result<Value, DomainError> {
        let req = FeedbackRequest {
            summary: a.str("summary").unwrap_or_default(),
            detail: a.str("detail"),
            tool: a.str("tool"),
            severity: a.str("severity"),
            task_key: a.str("task_key"),
        };
        self.send_feedback(p, a, req)
    }

    fn send_feedback(
        &self,
        p: &Principal,
        a: &Args<'_>,
        req: FeedbackRequest,
    ) -> Result<Value, DomainError> {
        let place = self.place(p, a)?;
        let written = self.svc.feedback(p, &place.target, req)?;
        self.ack(&place, "record.create", &written)
    }

    // ---- end -----------------------------------------------------------------------------------

    fn end(&self, p: &Principal, a: &Args<'_>) -> Result<Value, DomainError> {
        let place = self.place(p, a)?;
        // R11 P2-3：省略 outcome 时，本 lineage 还持有未完成的领取就是 paused，否则 completed。
        let outcome = match a.str("outcome").and_then(|o| Outcome::parse(&o)) {
            Some(o) => o,
            None => match &place.target.session {
                Some(s) if self.svc.holds_open_claims(p, &place.code, s)? => Outcome::Paused,
                _ => Outcome::Completed,
            },
        };
        let req = EndRequest {
            outcome,
            summary: a.str("summary").unwrap_or_default(),
            next: a.strs("next"),
            release_claims: a.flag("release_claims", true),
            retirement_reason: a.str("retirement_reason"),
            git: None,
        };
        let written = self.svc.end_session(p, &place.target, req)?;
        let mut ack = self.ack(&place, "session.end", &written)?;
        if let Value::Object(m) = &mut ack {
            m.insert("outcome".into(), json!(outcome.as_str()));
        }
        Ok(ack)
    }

    // ---- knowledge_save ------------------------------------------------------------------------

    fn knowledge_save(&self, p: &Principal, a: &Args<'_>) -> Result<Value, DomainError> {
        let code = self.project(p, a)?;
        // 作者取自 session（A3：需要 session 的 operation）；补默认 session 是桥的事。
        let session = a.str("session").ok_or_else(|| {
            DomainError::new(
                ErrorCode::SESSION_REQUIRED,
                "atm_knowledge_save 要知道作者：带上 atm_begin 返回的 session",
            )
            .detail("field", "session")
        })?;
        let op_id = match a.str("op_id") {
            Some(op) => op,
            None => self.svc.auto_op_id()?,
        };
        let source_refs = a
            .get("source_refs")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_object)
                    .map(|r| {
                        let r = Args(r);
                        SourceRef {
                            kind: r.str("type").unwrap_or_default(),
                            reference: r.str("reference").unwrap_or_default(),
                            source_version: r.int("sourceVersion"),
                            project_id: r.str("projectId"),
                            record_id: r.str("recordId"),
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        let save = AgentSave {
            content: Content {
                slug: a.str("slug").unwrap_or_default(),
                title: a.str("title").unwrap_or_default(),
                summary: a.str("summary").unwrap_or_default(),
                use_when: a.str("use_when"),
                tags: a.strs("tags"),
                aliases: a.strs("aliases"),
                applies_to: a.strs("applies_to"),
                body_markdown: a.str("body_markdown").unwrap_or_default(),
                source_refs,
            },
            id: a.str("id"),
            expected_revision_id: a.str("expected_revision_id"),
        };
        let written = self
            .svc
            .knowledge_save_agent(p, &code, &session, save, &op_id)?;
        // 2.x 直接回服务结果；v6 的 ACK 规则（op_id、replayed、实际的 project 与 session）补在旁边。
        let mut out = written.result.clone();
        if let Value::Object(m) = &mut out {
            m.insert("op_id".into(), json!(op_id));
            m.insert("replayed".into(), json!(written.replayed));
            m.insert("project".into(), json!(atm_domain::keys::normalize(&code)));
            m.insert(
                "session".into(),
                json!(written.rebound_to.clone().unwrap_or(session)),
            );
        }
        Ok(out)
    }
}

// ---- task_create 的引用合并 --------------------------------------------------------------------

enum Linked {
    Key(String),
    Ref(String),
}

struct Link<'a> {
    code: &'a str,
    refs: &'a [String],
}

impl Link<'_> {
    /// 形如本项目任务 key 的按已有任务；本批的 client_ref 原样；从 1 开始的序号换成那一条的引用名。
    fn resolve(&self, v: &str) -> Linked {
        let t = v.trim();
        if atm_domain::keys::parse_task_key(self.code, t).is_some() {
            return Linked::Key(t.to_owned());
        }
        if self.refs.iter().any(|r| r == t) {
            return Linked::Ref(t.to_owned());
        }
        match t.parse::<usize>() {
            Ok(n) if (1..=self.refs.len()).contains(&n) => Linked::Ref(self.refs[n - 1].clone()),
            _ => Linked::Ref(t.to_owned()),
        }
    }
}

// ---- task_patch 的逐条映射 ---------------------------------------------------------------------

/// 复合操作：服务层各是独立入口，只能单条（W-050）。
const COMPOSITE: &[&str] = &[
    "verify_and_complete",
    "review_request",
    "review_submit",
    "checklist",
    "checklist_single",
    "checklist_batch",
];

/// 每条 item 都能写的字段。
const COMMON: &[&str] = &[
    "task_key",
    "operation",
    "expected_version",
    "takeover_stale",
];

/// 一个 operation 额外接受的字段，与其中必填的。
fn operation_fields(op: &str) -> (&'static [&'static str], &'static [&'static str]) {
    match op {
        "block" => (&["blocked_reason"], &["blocked_reason"]),
        "wait_agent" | "wait_user" => (&["waiting_for"], &["waiting_for"]),
        "complete" => (&["note", "evidence", "checklist"], &[]),
        "cancel" => (&["cancel_reason", "duplicate_of", "superseded_by"], &[]),
        "edit" => (
            &[
                "title",
                "description",
                "acceptance",
                "target_date",
                "parent_key",
                "assignee_agent_id",
                "depends_on",
                "discovered_from",
                "expected_fields",
            ],
            &[],
        ),
        "review_request" => (
            &[
                "parent_checklist_id",
                "expected_parent_checklist_version",
                "candidate_hashes",
            ],
            &[
                "parent_checklist_id",
                "expected_parent_checklist_version",
                "candidate_hashes",
            ],
        ),
        "review_submit" => (
            &[
                "request_key",
                "verdict",
                "candidate_hashes",
                "evidence",
                "review_task_key",
            ],
            &["request_key", "verdict", "candidate_hashes", "evidence"],
        ),
        "checklist" | "checklist_single" | "checklist_batch" => (
            &[
                "checklist",
                "expected_checklist_version",
                "checklist_id",
                "status",
                "evidence",
            ],
            &[],
        ),
        _ => (&[], &[]),
    }
}

/// 一条 item 的形状问题：这个 operation 不收的字段、缺的必填字段、复合操作的 takeover_stale。
fn item_problems(a: &Args<'_>, op: &str, path: &dyn Fn(&str) -> String) -> Vec<Problem> {
    let (extra, required) = operation_fields(op);
    let patch_fields: Vec<&str> = crate::tools::patch_item_names();
    let mut out = Vec::new();
    for key in a.0.keys() {
        let k = key.as_str();
        // 根上的 project / session / op_id 等不属于 item。
        if !patch_fields.contains(&k) || COMMON.contains(&k) || extra.contains(&k) {
            continue;
        }
        let mut allowed: Vec<&str> = COMMON.to_vec();
        allowed.extend_from_slice(extra);
        out.push(
            Problem::new(path(k), ProblemKind::Unknown)
                .got(format!("operation={op}"))
                .allowed(allowed),
        );
    }
    for f in required {
        if !a.has(f) {
            out.push(Problem::new(path(f), ProblemKind::Missing));
        }
    }
    if COMPOSITE.contains(&op) && a.bool("takeover_stale") {
        out.push(
            Problem::new(path("takeover_stale"), ProblemKind::Conflict)
                .got(true)
                .allowed(false),
        );
    }
    if matches!(op, "checklist" | "checklist_single" | "checklist_batch")
        && !a.has("checklist")
        && !a.has("checklist_id")
    {
        out.push(Problem::new(path("checklist"), ProblemKind::Missing));
    }
    out
}

fn patch_item(a: &Args<'_>) -> PatchItem {
    let op = a.str("operation").unwrap_or_default();
    // 校验器只放过表里的 operation；基础操作的名字与 domain 的规范写法相同。
    let operation = Operation::parse(&op).unwrap_or(Operation::Start);
    let mut item = PatchItem::new(a.str("task_key").unwrap_or_default(), operation);
    item.expected_version = a.int("expected_version");
    item.takeover_stale = a.bool("takeover_stale");
    item.blocked_reason = a.str("blocked_reason");
    item.waiting_for = a.str("waiting_for");
    item.cancel_reason = a.str("cancel_reason");
    item.duplicate_of = a.nullable("duplicate_of");
    item.superseded_by = a.nullable("superseded_by");
    item.edit = EditFields {
        title: a.str("title"),
        description: a.str("description"),
        acceptance: a.list("acceptance"),
        assignee_agent_id: a.nullable("assignee_agent_id"),
        target_date: a.nullable("target_date"),
        parent_key: a.nullable("parent_key"),
        depends_on: a.list("depends_on"),
        discovered_from: a.nullable("discovered_from"),
    };
    if let Some(Value::Object(m)) = a.get("expected_fields") {
        let e = Args(m);
        item.expected_fields = Some(ExpectedFields {
            title: e.str("title"),
            description: e.str("description"),
            acceptance: e.list("acceptance"),
            target_date: e.nullable("target_date"),
            parent_key: e.nullable("parent_key"),
        });
    }
    item.note = a.str("note");
    item.evidence = evidence(a.get("evidence"));
    if a.has("checklist") {
        item.checklist = Some(
            changes(a)
                .into_iter()
                .map(|c| CompleteChecklist {
                    item: c.item,
                    status: c.status,
                    evidence: c.evidence,
                })
                .collect(),
        );
    }
    item
}

/// 一条检查项改动（`checklist[]` 的元素，或 2.x 单条形状的 `checklist_id` + `status`）。
struct Change {
    item: ChecklistRef,
    /// 解析后的检查项 id（单独的 checklist 操作才解析）。
    id: String,
    status: ChecklistStatus,
    evidence: Option<Vec<Evidence>>,
    version: Option<i64>,
}

fn changes(a: &Args<'_>) -> Vec<Change> {
    let reference = |s: String| match s.trim().parse::<usize>() {
        Ok(n) => ChecklistRef::Index(n),
        Err(_) => ChecklistRef::Text(s),
    };
    if let Some(Value::Array(list)) = a.get("checklist") {
        return list
            .iter()
            .filter_map(Value::as_object)
            .map(|m| {
                let c = Args(m);
                Change {
                    item: reference(c.str("item").unwrap_or_default()),
                    id: String::new(),
                    status: checklist_status(c.str("status").as_deref()),
                    evidence: evidence(c.get("evidence")),
                    version: c.int("expected_checklist_version"),
                }
            })
            .collect();
    }
    match a.str("checklist_id") {
        Some(id) => vec![Change {
            item: ChecklistRef::Text(id),
            id: String::new(),
            status: checklist_status(a.str("status").as_deref()),
            evidence: evidence(a.get("evidence")),
            version: None,
        }],
        None => Vec::new(),
    }
}

/// 序号（从 1 开始）、id、标题全文 → 检查项 id。标题重名时要求改用 id 或序号；找不到的原样返回，
/// 由服务报 `CHECKLIST_NOT_FOUND` / `CHECKLIST_TASK_MISMATCH`（与 complete 的 checklist 同一套错误）。
fn resolve_item(
    index: &[(String, String)],
    item: &ChecklistRef,
    task_key: &str,
    i: usize,
) -> Result<String, DomainError> {
    match item {
        ChecklistRef::Index(n) => Ok(index
            .get(n.wrapping_sub(1))
            .map_or_else(|| format!("#{n}"), |(id, _)| id.clone())),
        ChecklistRef::Text(text) => {
            let t = text.trim();
            if index.iter().any(|(id, _)| id == t) {
                return Ok(t.to_owned());
            }
            let by_title: Vec<&str> = index
                .iter()
                .filter(|(_, title)| title.trim() == t)
                .map(|(id, _)| id.as_str())
                .collect();
            match by_title.as_slice() {
                [one] => Ok((*one).to_owned()),
                [] => Ok(t.to_owned()),
                many => Err(DomainError::new(
                    ErrorCode::VALIDATION_ERROR,
                    format!("任务 {task_key} 有多个标题为「{t}」的检查项：改用 id 或序号"),
                )
                .detail("field", "checklist.item")
                .detail("issue", "ambiguous_title")
                .detail("item_index", i)
                .detail("candidates", many.to_vec())),
            }
        }
    }
}

fn checklist_status(s: Option<&str>) -> ChecklistStatus {
    match s {
        Some("DOING") => ChecklistStatus::Doing,
        Some("DONE") => ChecklistStatus::Done,
        Some("SKIPPED") => ChecklistStatus::Skipped,
        _ => ChecklistStatus::Todo,
    }
}

/// 证据：文本或 `{kind, value, note}`。没给是 None（保留原证据），给了空数组是清空。
fn evidence(v: Option<&Value>) -> Option<Vec<Evidence>> {
    let list = v?.as_array()?;
    Some(
        list.iter()
            .filter_map(|e| match e {
                Value::String(s) => Some(Evidence::Text(s.clone())),
                Value::Object(m) => {
                    let e = Args(m);
                    Some(Evidence::Item {
                        kind: EvidenceKind::parse(&e.str("kind")?)?,
                        value: e.str("value").unwrap_or_default(),
                        note: e.str("note"),
                    })
                }
                _ => None,
            })
            .collect(),
    )
}

/// `candidate_hashes`：`{名称: 十六进制}`。名称与取值的格式由服务校验（W-010）。
fn hashes(a: &Args<'_>, path: &str) -> Result<Vec<(String, String)>, DomainError> {
    let Some(Value::Object(m)) = a.get("candidate_hashes") else {
        return Err(invalid(vec![
            Problem::new(path, ProblemKind::Pattern).allowed("{名称: 十六进制哈希}"),
        ]));
    };
    m.iter()
        .map(|(k, v)| match v.as_str() {
            Some(s) => Ok((k.clone(), s.to_owned())),
            None => Err(invalid(vec![
                Problem::new(format!("{path}.{k}"), ProblemKind::Pattern)
                    .got(v.clone())
                    .allowed("十六进制字符串"),
            ])),
        })
        .collect()
}
