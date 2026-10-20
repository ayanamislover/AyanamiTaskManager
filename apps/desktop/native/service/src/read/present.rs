//! 事件的可读呈现（2.x `event-presentation.ts`）：delta、操作追踪、W-104 的最近变化共用。

use serde_json::{Map, Value};

fn title_of(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "agent.joined" => "Agent 加入",
        "agent.resumed" => "Agent 接回会话",
        "agent.left" => "Agent 离开",
        "agent.force_closed" => "Agent 会话关闭",
        "agent.recovered_stale" => "回收过期 Agent 声明",
        "agent.git_context.updated" => "刷新 Git 上下文",
        "backup.created" => "创建备份",
        "backup.failed" => "备份失败",
        "backup.restored" => "恢复备份",
        "checklist.batch_updated" => "批量更新验收清单",
        "checklist.updated" => "更新验收清单",
        "milestone.created" => "创建里程碑",
        "objective.created" => "创建目标",
        "project.creating" => "开始创建项目",
        "project.created" => "创建项目",
        "project.path.attached" => "关联项目路径",
        "project.update.drafted" => "草拟项目摘要",
        "project.update.published" => "发布项目摘要",
        "project.archived" => "归档项目",
        "project.restored" => "恢复项目",
        "project.restore_requested" => "请求恢复项目",
        "project.restore_approved" => "授权恢复项目",
        "project.restore_rejected" => "拒绝恢复项目",
        "project.trashed" => "移入回收站",
        "record.created" => "新增记录",
        "setting.updated" => "更新设置",
        "quick.created" => "创建临时任务",
        "quick.updated" => "更新临时任务",
        "quick.promoted" => "提升为项目任务",
        "work.blocked" => "任务受阻",
        "work.cancelled" => "取消任务",
        "work.claimed" => "领取任务",
        "work.completed" => "完成任务",
        "work.created" => "创建任务",
        "work.moved" => "移动任务",
        "work.progressed" => "更新任务进度",
        "work.readied" => "任务就绪",
        "work.relations_changed" => "调整任务关系",
        "work.released" => "释放任务",
        "work.reopened" => "重新打开任务",
        "work.started" => "开始任务",
        "work.updated" => "更新任务",
        "work.verification_requested" => "请求任务验收",
        "work.waiting" => "任务进入等待",
        "import.agenttask.applied" => "导入 AgentTask",
        _ => return None,
    })
}

fn fallback_title(kind: &str) -> String {
    title_of(kind).map_or_else(
        || {
            kind.split('.')
                .filter(|p| !p.is_empty())
                .map(|p| {
                    let mut c = p.chars();
                    c.next()
                        .map_or_else(String::new, |f| f.to_uppercase().chain(c).collect())
                })
                .collect::<Vec<_>>()
                .join(" ")
        },
        str::to_owned,
    )
}

/// JS `typeof v === "string" && v.trim() ? v.trim() : null`（JS trim 的空白集合）。
fn text<'a>(payload: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(atm_domain::text::js_trim)
        .filter(|s| !s.is_empty())
}

fn js_number(v: &Value) -> Option<String> {
    let n = v.as_f64().filter(|f| f.is_finite())?;
    Some(atm_store::jsjson::number_to_string(n))
}

fn percent(v: Option<&Value>) -> Option<String> {
    v.and_then(js_number).map(|n| format!("{n}%"))
}

fn work_detail(kind: &str, key: &str, payload: &Map<String, Value>) -> String {
    let title = text(payload, "title").or_else(|| text(payload, "taskTitle"));
    let label = title.map_or_else(|| key.to_owned(), |t| format!("{key}「{t}」"));
    let status = text(payload, "status");
    let summary = text(payload, "summary");
    let operation = text(payload, "operation");
    let colon = |s: Option<&str>| s.map_or_else(String::new, |s| format!("：{s}"));
    match kind {
        "work.created" => format!(
            "创建任务 {label}{}",
            status.map_or_else(String::new, |s| format!("，初始状态 {s}"))
        ),
        "work.progressed" | "work.blocked" => {
            let from = percent(payload.get("from"));
            let to = percent(payload.get("to"));
            let progress = if from.is_some() || to.is_some() {
                format!(
                    "（{} → {}）",
                    from.as_deref().unwrap_or("—"),
                    to.as_deref().unwrap_or("—")
                )
            } else {
                String::new()
            };
            format!("{label} 更新进度{progress}{}", colon(summary))
        }
        "work.completed" => format!("完成任务 {label}"),
        "work.started" => format!("开始执行 {label}"),
        "work.claimed" => format!("领取任务 {label}"),
        "work.released" => format!("释放任务 {label}"),
        "work.verification_requested" => format!("请求验收 {label}"),
        "work.waiting" => format!("{label} 进入等待{}", colon(summary)),
        "work.cancelled" => format!("取消任务 {label}"),
        "work.reopened" => format!("重新打开 {label}"),
        "work.moved" => format!("移动任务 {label}"),
        "work.readied" => format!("{label} 从待办转为就绪"),
        "work.relations_changed" => {
            let relations = payload.get("relations").and_then(Value::as_object);
            let mut parts = Vec::new();
            if let Some(deps) = relations
                .and_then(|r| r.get("dependsOn"))
                .and_then(Value::as_array)
            {
                let list: Vec<String> = deps
                    .iter()
                    .map(|d| d.as_str().map_or_else(|| d.to_string(), str::to_owned))
                    .collect();
                parts.push(format!(
                    "前置依赖 {}",
                    if list.is_empty() {
                        "清空".to_owned()
                    } else {
                        list.join("、")
                    }
                ));
            }
            if let Some(from) = relations.and_then(|r| r.get("discoveredFrom")) {
                let source = from
                    .as_str()
                    .map(atm_domain::text::js_trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("解除");
                parts.push(format!("来源 {source}"));
            }
            format!(
                "调整 {label} 的关系{}",
                if parts.is_empty() {
                    String::new()
                } else {
                    format!("：{}", parts.join("；"))
                }
            )
        }
        _ => format!(
            "{label}{}{}{}",
            operation.map_or_else(String::new, |o| format!("（{o}）")),
            status.map_or_else(String::new, |s| format!("，状态 {s}")),
            colon(summary)
        ),
    }
}

fn detail_for(kind: &str, actor: &str, payload: &Map<String, Value>, key: &str) -> String {
    if kind.starts_with("work.") {
        return work_detail(kind, key, payload);
    }
    let pick = |k: &str| text(payload, k);
    let agent = || pick("agentId").map_or_else(|| actor.to_owned(), str::to_owned);
    match kind {
        "record.created" => {
            let decision = pick("kind") == Some("DECISION");
            format!(
                "{} {key}{}{}",
                if decision {
                    "记录决策"
                } else {
                    "新增记录"
                },
                pick("title").map_or_else(String::new, |t| format!("「{t}」")),
                pick("summary").map_or_else(String::new, |s| format!("：{s}"))
            )
        }
        "project.update.published" | "project.update.drafted" => pick("summary")
            .map_or_else(|| "项目摘要已更新".to_owned(), |s| format!("项目摘要：{s}")),
        "checklist.updated" => format!(
            "验收清单{}{}",
            pick("taskKey").map_or_else(String::new, |k| format!("（{k}）")),
            pick("status").map_or_else(|| "已更新".to_owned(), |s| format!("状态变为 {s}"))
        ),
        "checklist.batch_updated" => {
            let task = pick("taskKey").unwrap_or(key);
            let count = payload.get("items").and_then(Value::as_array).map(Vec::len);
            format!(
                "批量更新验收清单{}{}",
                if task.is_empty() {
                    String::new()
                } else {
                    format!("（{task}）")
                },
                count.map_or_else(String::new, |c| format!("：{c} 项"))
            )
        }
        "agent.joined" => format!(
            "{} 加入{}",
            agent(),
            pick("role").map_or_else(String::new, |r| format!("（{r}）"))
        ),
        "agent.left" | "agent.force_closed" => format!(
            "{} 结束会话{}",
            agent(),
            pick("summary").map_or_else(String::new, |s| format!("：{s}"))
        ),
        "agent.git_context.updated" => {
            let dirty = payload.get("dirty").and_then(Value::as_bool);
            format!(
                "{} 的 Git 上下文{}{}{}",
                agent(),
                pick("branch").map_or_else(String::new, |b| format!("：分支 {b}")),
                pick("head").map_or_else(String::new, |h| format!(
                    "，HEAD {}",
                    super::codec::utf16_prefix(h, 8)
                )),
                match dirty {
                    None => "",
                    Some(true) => "，工作区有改动",
                    Some(false) => "，工作区干净",
                }
            )
        }
        _ if kind.starts_with("backup.") => format!(
            "{}备份{}{}",
            pick("scope").map_or_else(String::new, |s| format!("{s} ")),
            pick("reason").map_or_else(String::new, |r| format!("（{r}）")),
            pick("code").map_or_else(String::new, |c| format!("：{c}"))
        ),
        "objective.created" | "milestone.created" => format!(
            "{}{}",
            fallback_title(kind),
            pick("title").map_or_else(String::new, |t| format!("「{t}」"))
        ),
        _ => pick("summary")
            .or_else(|| pick("title"))
            .or_else(|| pick("name"))
            .map_or_else(
                || {
                    format!(
                        "{}{}",
                        fallback_title(kind),
                        if key.is_empty() {
                            String::new()
                        } else {
                            format!("（{key}）")
                        }
                    )
                },
                str::to_owned,
            ),
    }
}

/// 呈现结果：`(key, actor, title, detail)`；summary 与 detail 相同。
pub(crate) struct Presented {
    pub key: Option<String>,
    pub actor: String,
    pub title: String,
    pub detail: String,
}

pub(crate) fn present(
    kind: &str,
    aggregate_id: Option<&str>,
    actor: Option<&str>,
    payload: &Map<String, Value>,
) -> Presented {
    let aggregate = aggregate_id
        .map(atm_domain::text::js_trim)
        .filter(|s| !s.is_empty());
    let key = text(payload, "key").or(aggregate).map(str::to_owned);
    let actor = actor
        .map(atm_domain::text::js_trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("SYSTEM")
        .to_owned();
    let title = if kind == "record.created" && text(payload, "kind") == Some("DECISION") {
        "记录决策".to_owned()
    } else {
        fallback_title(kind)
    };
    let detail = detail_for(kind, &actor, payload, key.as_deref().unwrap_or_default());
    Presented {
        key,
        actor,
        title,
        detail,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn p(kind: &str, payload: Value) -> Presented {
        present(
            kind,
            Some("AGG"),
            Some("claude"),
            payload.as_object().unwrap(),
        )
    }

    #[test]
    fn work_and_record_details() {
        let e = p(
            "work.progressed",
            json!({ "key": "ATM-T-0001", "title": "一", "from": 40.0, "to": 50, "summary": "做了" }),
        );
        assert_eq!(e.detail, "ATM-T-0001「一」 更新进度（40% → 50%）：做了");
        assert_eq!(e.title, "更新任务进度");
        let e = p(
            "record.created",
            json!({ "key": "ATM-D-001", "kind": "DECISION", "title": "选" }),
        );
        assert_eq!(
            (e.title.as_str(), e.detail.as_str()),
            ("记录决策", "记录决策 ATM-D-001「选」")
        );
        let e = p(
            "work.relations_changed",
            json!({ "key": "K", "relations": { "dependsOn": [] } }),
        );
        assert_eq!(e.detail, "调整 K 的关系：前置依赖 清空");
    }

    #[test]
    fn fallbacks() {
        let e = present("custom.thing_done", None, None, &Map::new());
        assert_eq!((e.key, e.actor.as_str()), (None, "SYSTEM"));
        assert_eq!(e.detail, "Custom Thing_done");
        let e = p(
            "agent.joined",
            json!({ "agentId": "codex", "role": "REVIEWER" }),
        );
        assert_eq!(e.detail, "codex 加入（REVIEWER）");
        assert_eq!(e.key.as_deref(), Some("AGG"));
    }
}
