//! 工程指标的只读入口（03：`metrics.read`；C-08、P-014；W2 peer r2 P1-03）。
//!
//! 2.x 的 `GET …/engineering-metrics` 读时会刷新：超过 5 分钟没扫或带 `refresh=1` 就调 git、写指标行
//! （03 §3 :314、F-04）。ATM 3 拆成两项：这里只返回已存的值，不调 git、不写任何行、不排后台扫描；
//! 采集（`metrics.capture`）与刷新（`metrics.refresh`）在 [`crate::metrics`]。
//!
//! 形状沿用 2.x 的 camelCase 载荷：`project` 是最新一条项目指标的原文，`workItem` 是任务的基线与指标。
//! 项目没有源码目录时 `available=false`、`reason="NO_SOURCE_PATH"`（2.x 先看这个）；有目录但没有任何已存指标时
//! `reason="NO_DATA"`——不是错误，界面据此提示去刷新。

use super::views;
use crate::write::Service;
use atm_domain::capability::Capability;
use atm_domain::error::DomainError;
use atm_domain::principal::Principal;
use rusqlite::OptionalExtension;
use serde_json::{Value, json};

use super::db;

fn payload(text: Option<String>) -> Value {
    text.and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null)
}

impl Service {
    /// `metrics.read`：项目最新一条工程指标，`task_key` 给出时再带上这个任务的基线与指标。
    /// 任务键不属于这个项目或不存在时报 WORK_ITEM_NOT_FOUND；任务存在但没有指标行时 `workItem` 为 null。
    pub fn metrics_read(
        &self,
        principal: &Principal,
        project: &str,
        task_key: Option<&str>,
    ) -> Result<Value, DomainError> {
        self.read_project(principal, Capability::MetricsRead, project, |cx| {
            metrics_view(cx, task_key)
        })
    }

    /// 刷新之后的视图（调用方已经核过 `metrics.refresh`）。
    pub(crate) fn metrics_view(
        &self,
        project: &str,
        task_key: Option<&str>,
    ) -> Result<Value, DomainError> {
        self.read_located(project, |cx| metrics_view(cx, task_key))
    }
}

fn metrics_view(cx: &super::Ctx<'_>, task_key: Option<&str>) -> Result<Value, DomainError> {
    let has_source: bool = cx
        .tx
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM project_paths WHERE project_id = ?1)",
            [&cx.p.id],
            |r| r.get(0),
        )
        .map_err(db)?;
    let latest: Option<(String, String, Option<String>)> = cx
        .tx
        .query_row(
            "SELECT git_head, captured_at, payload_json FROM engineering_project_metrics
                     WHERE project_id = ?1 ORDER BY captured_at DESC, id DESC LIMIT 1",
            [&cx.p.id],
            |r| Ok((r.get(0)?, r.get(1)?, Some(r.get(2)?))),
        )
        .optional()
        .map_err(db)?;
    let work_item = match task_key {
        None => Value::Null,
        Some(reference) => {
            let t = views::task_by_key(cx, reference)?;
            cx.tx
                        .query_row(
                            "SELECT baseline_ref, baseline_captured_at, payload_json, captured_at, updated_at
                             FROM engineering_work_item_metrics WHERE project_id = ?1 AND work_item_id = ?2",
                            [&cx.p.id, &t.id],
                            |r| {
                                Ok(json!({
                                    "taskKey": views::task_key(cx, t.local_no),
                                    "baseline": r.get::<_, String>(0)?,
                                    "baselineCapturedAt": r.get::<_, String>(1)?,
                                    "metrics": payload(r.get(2)?),
                                    "capturedAt": r.get::<_, Option<String>>(3)?,
                                    "updatedAt": r.get::<_, String>(4)?,
                                }))
                            },
                        )
                        .optional()
                        .map_err(db)?
                        .unwrap_or(Value::Null)
        }
    };
    // 没有源码目录：与 2.x 一样不给任何指标（旧的也不给），任务键照样先校验。
    if !has_source {
        return Ok(json!({
            "available": false,
            "reason": "NO_SOURCE_PATH",
            "message": "项目没有源码目录",
            "projectCode": cx.p.code,
            "project": null,
            "projectHead": null,
            "projectCapturedAt": null,
            "workItem": null,
        }));
    }
    let has_item_metrics = !work_item["metrics"].is_null();
    let (head, captured_at, project_payload) = match latest {
        Some((h, c, p)) => (Value::from(h), Value::from(c), payload(p)),
        None => (Value::Null, Value::Null, Value::Null),
    };
    let available = !project_payload.is_null() || has_item_metrics;
    let (reason, message) = if available {
        (Value::Null, Value::Null)
    } else {
        (json!("NO_DATA"), json!("还没有统计：点「刷新统计」"))
    };
    Ok(json!({
        "available": available,
        "reason": reason,
        "message": message,
        "projectCode": cx.p.code,
        "project": project_payload,
        "projectHead": head,
        "projectCapturedAt": captured_at,
        "workItem": work_item,
    }))
}
