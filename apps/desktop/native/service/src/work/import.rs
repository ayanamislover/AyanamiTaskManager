//! agenttask-md 导入（03 U13 `import.apply`、A18 `import.preview`；00 C-17；2.x `agenttask-import.ts`、
//! `project-commands.ts:130-253`）。
//!
//! - 解析逐条照 2.x 的三条正则：一级标题是 objective，二级标题是 milestone，更深的标题和普通行成为
//!   REFERENCE 记录，`- [ ]` / `- [x]` 是任务（x 直接落到 DONE，C-17 的内部创建）。行号从 1 开始。
//! - 预览只解析、不落账（Agent 也可以）；应用只有 User。
//! - 应用是**一个**写事务：objective、milestone、任务、记录、`import_history` 一起提交或一起回滚。
//!   2.x 是逐条各自提交、中途失败会留下半个导入；单进程单库之后没有理由保留这个。同一个源（sha256）
//!   在同一项目已经导入过时不再写任何业务行，返回当时的结果并标 `alreadyImported`。
//! - 记录标题按 2.x 截到 80 个 UTF-16 码元，但不切开代理对（00 02 C-19 同一规则）。

use super::Target;
use super::core::{Work, db, invalid_argument};
use super::create::{self, CreateItem, Internal, MAX_BATCH};
use super::planning::{
    MilestoneRequest, ObjectiveRequest, create_milestone, create_objective, validate_milestone,
    validate_objective,
};
use crate::fp::JsValue;
use crate::memory::{RecordRequest, import_record};
use crate::read::codec::utf16_prefix;
use crate::write::{Family, FpInput, Service, Written, internal};
use atm_domain::capability::{self, Capability};
use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::principal::Principal;
use atm_domain::text::{is_js_whitespace, js_trim};
use atm_domain::work::Status;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const IMPORT_OPERATION: &str = "import.agenttask-md.apply";
const SOURCE: &str = "agenttask_import";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportObjective {
    pub r#ref: String,
    pub title: String,
    pub line: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportMilestone {
    pub r#ref: String,
    pub objective_ref: String,
    pub title: String,
    pub line: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportTask {
    pub r#ref: String,
    pub objective_ref: String,
    pub milestone_ref: Option<String>,
    pub title: String,
    pub completed: bool,
    pub line: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportRecord {
    pub title: String,
    pub detail: String,
    pub line: usize,
}

/// 解析结果（2.x `AgentTaskImportPlan`）。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ImportPlan {
    pub sha256: String,
    pub source_name: String,
    pub objectives: Vec<ImportObjective>,
    pub milestones: Vec<ImportMilestone>,
    pub tasks: Vec<ImportTask>,
    pub records: Vec<ImportRecord>,
    pub warnings: Vec<String>,
}

/// JS 正则的 `.` 不匹配的行终止符。
fn line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `\s+(.+?)\s*$` 作用在 `rest` 上：捕获组去掉两端空白后的值。`None` 是不匹配。
fn spaced_tail(rest: &str) -> Option<String> {
    let mut chars = rest.chars();
    if !chars.next().is_some_and(is_js_whitespace) {
        return None;
    }
    let core = js_trim(rest);
    if core.is_empty() {
        // 全是空白：`\s+` 让出一个不是行终止符的空白给 `.+?`，捕获的仍是空白。
        return rest
            .chars()
            .skip(1)
            .any(|c| !line_terminator(c))
            .then(String::new);
    }
    (!core.chars().any(line_terminator)).then(|| core.to_owned())
}

/// 去掉开头的 `\s*`。
fn skip_space(s: &str) -> &str {
    s.trim_start_matches(is_js_whitespace)
}

/// `^(#{1,6})\s+(.+)$`（作用在已去空白的行上）：级别与标题。
fn heading(trimmed: &str) -> Option<(usize, String)> {
    let level = trimmed.bytes().take_while(|b| *b == b'#').count();
    if !(1..=6).contains(&level) {
        return None;
    }
    let rest = &trimmed[level..];
    if !rest.chars().next().is_some_and(is_js_whitespace) {
        return None;
    }
    let body = skip_space(rest);
    (!body.is_empty() && !body.chars().any(line_terminator))
        .then(|| (level, js_trim(body).to_owned()))
}

/// `^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$`：是否完成与标题。
fn checkbox(raw: &str) -> Option<(bool, String)> {
    let s = skip_space(raw);
    let rest = s.strip_prefix(['-', '*', '+'])?;
    if !rest.chars().next().is_some_and(is_js_whitespace) {
        return None;
    }
    let rest = skip_space(rest).strip_prefix('[')?;
    let mark = rest.chars().next()?;
    if !matches!(mark, ' ' | 'x' | 'X') {
        return None;
    }
    let rest = rest[mark.len_utf8()..].strip_prefix(']')?;
    spaced_tail(rest).map(|title| (mark != ' ', title))
}

/// `^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$`：列表项的正文。
fn list_item(raw: &str) -> Option<String> {
    let s = skip_space(raw);
    let rest = if let Some(r) = s.strip_prefix(['-', '*', '+']) {
        r
    } else {
        let digits = s.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        s[digits..].strip_prefix(['.', ')'])?
    };
    spaced_tail(rest)
}

fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// 2.x `parseAgentTaskMarkdown`。
pub fn parse(content: &str, source_name: &str) -> ImportPlan {
    let mut plan = ImportPlan {
        sha256: sha256_hex(content),
        source_name: source_name.to_owned(),
        ..ImportPlan::default()
    };
    let mut objective: Option<usize> = None;
    let mut milestone: Option<usize> = None;
    let normalized = content.replace("\r\n", "\n");
    for (index, raw) in normalized.split('\n').enumerate() {
        let line = index + 1;
        let trimmed = js_trim(raw);
        if trimmed.is_empty() {
            continue;
        }
        let mut ensure = |plan: &mut ImportPlan| -> usize {
            if let Some(o) = objective {
                return o;
            }
            plan.objectives.push(ImportObjective {
                r#ref: "objective-imported".into(),
                title: "导入任务".into(),
                line,
            });
            plan.warnings
                .push("源文件在首个一级标题前包含任务，已归入“导入任务”目标。".into());
            objective = Some(plan.objectives.len() - 1);
            plan.objectives.len() - 1
        };
        if let Some((level, title)) = heading(trimmed) {
            if level == 1 {
                plan.objectives.push(ImportObjective {
                    r#ref: format!("objective-{line}"),
                    title,
                    line,
                });
                objective = Some(plan.objectives.len() - 1);
                milestone = None;
            } else if level == 2 {
                let o = ensure(&mut plan);
                plan.milestones.push(ImportMilestone {
                    r#ref: format!("milestone-{line}"),
                    objective_ref: plan.objectives[o].r#ref.clone(),
                    title,
                    line,
                });
                milestone = Some(plan.milestones.len() - 1);
            } else {
                plan.records.push(ImportRecord {
                    title: format!("标题：{title}"),
                    detail: format!("第 {line} 行\n{raw}"),
                    line,
                });
            }
            continue;
        }
        if let Some((completed, title)) = checkbox(raw) {
            let o = ensure(&mut plan);
            plan.tasks.push(ImportTask {
                r#ref: format!("task-{line}"),
                objective_ref: plan.objectives[o].r#ref.clone(),
                milestone_ref: milestone.map(|m| plan.milestones[m].r#ref.clone()),
                title,
                completed,
                line,
            });
            continue;
        }
        let detail = list_item(raw).unwrap_or_else(|| trimmed.to_owned());
        plan.records.push(ImportRecord {
            title: utf16_prefix(&detail, 80).to_owned(),
            detail: format!("第 {line} 行\n{raw}"),
            line,
        });
    }
    if !js_trim(content).is_empty() && plan.objectives.is_empty() && plan.tasks.is_empty() {
        plan.warnings
            .push("未识别到标题或 checkbox，全部内容将保留为参考记录。".into());
    }
    plan
}

fn plan_view(plan: &ImportPlan) -> Value {
    json!({
        "sha256": plan.sha256,
        "sourceName": plan.source_name,
        "objectives": plan.objectives.iter().map(|o| json!({ "ref": o.r#ref, "title": o.title, "line": o.line })).collect::<Vec<_>>(),
        "milestones": plan.milestones.iter().map(|m| json!({ "ref": m.r#ref, "objectiveRef": m.objective_ref, "title": m.title, "line": m.line })).collect::<Vec<_>>(),
        "tasks": plan.tasks.iter().map(|t| json!({ "ref": t.r#ref, "objectiveRef": t.objective_ref, "milestoneRef": t.milestone_ref, "title": t.title, "completed": t.completed, "line": t.line })).collect::<Vec<_>>(),
        "records": plan.records.iter().map(|r| json!({ "title": r.title, "detail": r.detail, "line": r.line })).collect::<Vec<_>>(),
        "warnings": plan.warnings,
        "objectiveCount": plan.objectives.len(),
        "milestoneCount": plan.milestones.len(),
        "taskCount": plan.tasks.len(),
        "recordCount": plan.records.len(),
    })
}

fn source_name(name: Option<&str>) -> Result<String, DomainError> {
    let name = name.map_or("agenttask.md", js_trim);
    if name.is_empty() || atm_domain::text::utf16_len(name) > 260 {
        return Err(invalid_argument(
            "source_name",
            "source_name 必须是 1 至 260 个字符",
        ));
    }
    Ok(name.to_owned())
}

/// 内容上限：与知识正文同级（2.x 没有显式上限，受 HTTP 体积限制）。
const CONTENT_MAX_BYTES: usize = 2 * 1024 * 1024;

fn check_content(content: &str) -> Result<(), DomainError> {
    if content.len() > CONTENT_MAX_BYTES {
        return Err(invalid_argument("content", "content 最多 2 MiB")
            .detail("max_bytes", CONTENT_MAX_BYTES));
    }
    Ok(())
}

fn apply(w: &mut Work<'_>, plan: &ImportPlan) -> Result<Value, DomainError> {
    let existing: Option<String> =
        w.tx.query_row(
            "SELECT result_json FROM import_history WHERE source_sha256 = ?1 AND project_id = ?2",
            [&plan.sha256, &w.project],
            |r| r.get(0),
        )
        .optional()
        .map_err(db)?;
    if let Some(saved) = existing {
        let mut v: Value = serde_json::from_str(&saved).map_err(internal)?;
        v["alreadyImported"] = json!(true);
        return Ok(v);
    }
    let source = &plan.source_name;
    let mut objective_ids = std::collections::HashMap::new();
    for o in &plan.objectives {
        let r = validate_objective(&ObjectiveRequest {
            title: o.title.clone(),
            description: format!("从 {source} 第 {} 行导入", o.line),
            definition_of_done: Vec::new(),
        })
        .map_err(|e| e.detail("line", o.line))?;
        let created = create_objective(w, &r)?;
        objective_ids.insert(
            o.r#ref.clone(),
            created["id"].as_str().unwrap_or_default().to_owned(),
        );
    }
    let missing = |r: &str| {
        DomainError::new(
            ErrorCode::IMPORT_OBJECTIVE_MISSING,
            format!("导入目标不存在：{r}"),
        )
        .detail("reference", r)
    };
    let mut milestone_ids = std::collections::HashMap::new();
    for m in &plan.milestones {
        let objective = objective_ids
            .get(&m.objective_ref)
            .ok_or_else(|| missing(&m.objective_ref))?;
        let r = validate_milestone(&MilestoneRequest {
            objective_id: objective.clone(),
            title: m.title.clone(),
            description: format!("从 {source} 第 {} 行导入", m.line),
            target_date: None,
        })
        .map_err(|e| e.detail("line", m.line))?;
        let created = create_milestone(w, &r)?;
        milestone_ids.insert(
            m.r#ref.clone(),
            created["id"].as_str().unwrap_or_default().to_owned(),
        );
    }
    let items: Vec<CreateItem> = plan
        .tasks
        .iter()
        .map(|t| {
            Ok(CreateItem {
                client_ref: Some(t.r#ref.clone()),
                objective_id: Some(
                    objective_ids
                        .get(&t.objective_ref)
                        .ok_or_else(|| missing(&t.objective_ref))?
                        .clone(),
                ),
                milestone_id: Some(
                    t.milestone_ref
                        .as_ref()
                        .and_then(|m| milestone_ids.get(m).cloned()),
                ),
                title: t.title.clone(),
                description: Some(format!("从 {source} 第 {} 行导入", t.line)),
                kind: Some("TASK".into()),
                priority: Some("NORMAL".into()),
                status: Some(if t.completed {
                    Status::Done
                } else {
                    Status::Ready
                }),
                ..CreateItem::default()
            })
        })
        .collect::<Result<_, DomainError>>()?;
    let internal_create = Internal {
        source: SOURCE,
        source_quick_id: None,
    };
    for (n, chunk) in items.chunks(MAX_BATCH).enumerate() {
        create::validate(chunk, true).map_err(|e| e.detail("chunk", n))?;
        create::run(w, chunk, Some(&internal_create))?;
    }
    for r in &plan.records {
        import_record(
            w,
            &RecordRequest {
                detail: format!("{}\n来源：{source}", r.detail),
                importance: Some("NORMAL".into()),
                scope: Some("PROJECT".into()),
                ..RecordRequest::new("REFERENCE", &r.title, &r.title)
            },
            source,
        )
        .map_err(|e| e.detail("line", r.line))?;
    }
    let result = json!({
        "sourceName": source,
        "sha256": plan.sha256,
        "importedObjectives": plan.objectives.len(),
        "importedMilestones": plan.milestones.len(),
        "importedTasks": plan.tasks.len(),
        "importedRecords": plan.records.len(),
        "warnings": plan.warnings,
        "alreadyImported": false,
    });
    w.tx.execute(
        "INSERT INTO import_history (source_sha256, project_id, result_json, imported_at) VALUES (?1, ?2, ?3, ?4)",
        params![plan.sha256, w.project, result.to_string(), w.now_iso],
    )
    .map_err(db)?;
    let mut out = result;
    out["sequence"] = json!(w.sequence);
    Ok(out)
}

impl Service {
    /// 预览导入（`import.preview`；A18：只解析，不落账）。
    pub fn preview_import(
        &self,
        principal: &Principal,
        project: &str,
        content: &str,
        source: Option<&str>,
    ) -> Result<Value, DomainError> {
        capability::require(principal, Capability::ImportPreview)?;
        check_content(content)?;
        let plan = parse(content, &source_name(source)?);
        let project_id = self.project_scope(project)?;
        let sha = plan.sha256.clone();
        let (code, name, imported): (String, String, bool) = self
            .store()
            .read(move |tx| {
                tx.query_row(
                    "SELECT code, name, EXISTS (SELECT 1 FROM import_history WHERE source_sha256 = ?2 AND project_id = ?1)
                     FROM projects WHERE id = ?1",
                    params![project_id, sha],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
            })
            .map_err(|e| internal(format!("{e:?}")))?;
        let mut v = plan_view(&plan);
        v["project"] = json!({ "code": code, "name": name });
        v["alreadyImported"] = json!(imported);
        Ok(v)
    }

    /// 应用导入（`import.apply`；U13，只有 User）。`expected_sha256` 给了就必须等于这次内容的摘要
    /// （预览之后源文件变了 → IMPORT_SOURCE_CHANGED）。
    pub fn apply_import(
        &self,
        principal: &Principal,
        target: &Target,
        content: &str,
        source: Option<&str>,
        expected_sha256: Option<&str>,
    ) -> Result<Written, DomainError> {
        capability::require(principal, Capability::ImportApply)?;
        check_content(content)?;
        let plan = parse(content, &source_name(source)?);
        if let Some(expected) = expected_sha256
            && js_trim(expected) != plan.sha256
        {
            return Err(DomainError::new(
                ErrorCode::IMPORT_SOURCE_CHANGED,
                "源文件已在预览后发生变化：重新预览再导入",
            )
            .detail("expected_sha256", js_trim(expected))
            .detail("actual_sha256", plan.sha256.as_str()));
        }
        let (sha, name) = (plan.sha256.clone(), plan.source_name.clone());
        let fingerprint: FpInput = Box::new(move |_, family, _| match family {
            Family::CanonV2 => Some(JsValue::from_json(
                &json!({ "sha256": sha, "sourceName": name }),
            )),
            Family::KernelV1 | Family::KnowledgeV1 => None,
        });
        self.write(
            principal,
            target.request(Capability::ImportApply, IMPORT_OPERATION, fingerprint),
            move |tx, ctx| apply(&mut Work::open(tx, ctx)?, &plan),
        )
    }
}
