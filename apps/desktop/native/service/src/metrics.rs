//! 工程指标的采集与刷新（W5h2；03 `metrics.capture` / `metrics.refresh`，C-08，P-014；2.x
//! `engineering-metrics-observer.ts`、`registry-observability.ts`）。
//!
//! - **刷新**（`metrics.refresh`，User 与 job `metrics.capture`）：当场扫一次项目，给了任务键再扫这个任务，
//!   返回与 [`Service::metrics_read`] 同形状的视图。界面的「刷新统计」走这里；读（GET）永远不扫（P-014）。
//! - **采集**（job `metrics.capture`）：任务操作提交之后，入口把「哪些任务、要不要记 baseline」交给
//!   [`Service::set_metrics_sink`] 登记的去处（2.x 在同样的位置调 `captureWorkItemEngineeringMetrics`）：
//!   claim / start 记 baseline，complete / cancel、`verify_and_complete`、atm_end 释放的任务只在已有 baseline
//!   时补扫。采集线程再调 [`Service::metrics_capture`]。
//! - baseline 只记一次（2.x `ON CONFLICT DO NOTHING`）：它锚的是任务从哪个 commit 开始。
//! - git 永远不在事务里跑：先读源码目录（读事务），再扫（无事务），最后一笔短写落库。扫描在
//!   `metrics_lock` 下逐个进行，后开始的后落库，界面刚刷出来的数字不会被更早开始的补扫盖掉。
//! - 指标是观察数据：不发事件、不走回执，失败不影响已经提交的任务操作。项目指标每个项目留最新 120 条。

use crate::write::{Service, internal};
use atm_domain::capability::{self, Capability};
use atm_domain::error::DomainError;
use atm_domain::keys;
use atm_domain::principal::Principal;
use atm_domain::time::Timestamp;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// 每个项目保留的项目指标条数（2.x `OFFSET 120`）。
pub const PROJECT_METRICS_KEPT: i64 = 120;
/// 采集时项目指标多旧才顺带重扫（2.x 读时的 5 分钟）。
pub const PROJECT_STALE_MS: i64 = 5 * 60_000;

/// 一次任务操作之后要采集的任务。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Signal {
    pub project_id: String,
    /// 调用方给的任务键（原样，采集时再解析）。
    pub task_keys: Vec<String>,
    /// claim / start：还没有 baseline 就以当前 HEAD 记一个。
    pub establish: bool,
}

pub type SignalSink = std::sync::Arc<dyn Fn(Signal) + Send + Sync>;

/// 一次采集做了什么（测试与诊断用）。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CaptureReport {
    pub baselines: usize,
    pub scanned: Vec<String>,
    pub project_scanned: bool,
    pub errors: Vec<String>,
}

fn now() -> Timestamp {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    Timestamp::from_millis(i64::try_from(ms).unwrap_or(i64::MAX))
}

fn db(e: impl std::fmt::Debug) -> DomainError {
    internal(format!("{e:?}"))
}

/// 项目的代码与源码目录（主路径在前）。
struct Source {
    code: String,
    dir: Option<PathBuf>,
}

impl Service {
    /// 登记采集的去处（采集线程起来时给、停下时撤）。
    pub fn set_metrics_sink(&self, sink: Option<SignalSink>) {
        *self.metrics_sink.lock().unwrap_or_else(|e| e.into_inner()) = sink;
    }

    /// 测试用：现在有没有登记采集的去处。
    #[doc(hidden)]
    pub fn metrics_sink_registered(&self) -> bool {
        self.metrics_sink
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }

    /// 任务操作提交之后调用。没有登记去处（e2e、独立运行时）就什么都不做。
    pub(crate) fn metrics_signal(&self, project_id: &str, task_keys: Vec<String>, establish: bool) {
        if task_keys.is_empty() {
            return;
        }
        let sink = self
            .metrics_sink
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(sink) = sink {
            sink(Signal {
                project_id: project_id.to_owned(),
                task_keys,
                establish,
            });
        }
    }

    fn metrics_source(&self, project_id: &str) -> Result<Option<(String, Source)>, DomainError> {
        let by = project_id.to_owned();
        self.store()
            .read(move |tx| {
                let Some(code): Option<String> = tx
                    .query_row("SELECT code FROM projects WHERE id = ?1", [&by], |r| {
                        r.get(0)
                    })
                    .optional()?
                else {
                    return Ok(None);
                };
                let dir: Option<String> = tx
                    .query_row(
                        "SELECT canonical_path FROM project_paths WHERE project_id = ?1
                         ORDER BY is_primary DESC, canonical_path LIMIT 1",
                        [&by],
                        |r| r.get(0),
                    )
                    .optional()?;
                Ok::<_, rusqlite::Error>(Some((
                    by.clone(),
                    Source {
                        code,
                        dir: dir.map(PathBuf::from),
                    },
                )))
            })
            .map_err(db)
    }

    /// 任务键 → 任务 id（不属于这个项目或不存在是 None）。
    fn metrics_task(
        &self,
        project_id: &str,
        code: &str,
        reference: &str,
    ) -> Result<Option<String>, DomainError> {
        let Some(no) = keys::parse_task_key(code, reference) else {
            return Ok(None);
        };
        let project = project_id.to_owned();
        self.store()
            .read(move |tx| {
                tx.query_row(
                    "SELECT id FROM work_items WHERE project_id = ?1 AND local_no = ?2",
                    params![project, no],
                    |r| r.get(0),
                )
                .optional()
            })
            .map_err(db)
    }

    fn metrics_baseline_of(
        &self,
        project_id: &str,
        task_id: &str,
    ) -> Result<Option<String>, DomainError> {
        let (p, t) = (project_id.to_owned(), task_id.to_owned());
        self.store()
            .read(move |tx| {
                tx.query_row(
                    "SELECT baseline_ref FROM engineering_work_item_metrics WHERE project_id = ?1 AND work_item_id = ?2",
                    [&p, &t],
                    |r| r.get(0),
                )
                .optional()
            })
            .map_err(db)
    }

    /// 还没有 baseline 就记一个；返回生效的 baseline（已有的不变）。任务已经不在就是 None。
    fn metrics_ensure_baseline(
        &self,
        project_id: &str,
        task_id: &str,
        head: &str,
        at: &str,
    ) -> Result<Option<String>, DomainError> {
        let (p, t, h, a) = (
            project_id.to_owned(),
            task_id.to_owned(),
            head.to_owned(),
            at.to_owned(),
        );
        self.store()
            .write(move |tx| {
                tx.execute(
                    "INSERT INTO engineering_work_item_metrics
                       (project_id, work_item_id, baseline_ref, baseline_captured_at, payload_json, captured_at, updated_at)
                     SELECT project_id, id, ?3, ?4, NULL, NULL, ?4 FROM work_items WHERE project_id = ?1 AND id = ?2
                     ON CONFLICT (project_id, work_item_id) DO NOTHING",
                    params![p, t, h, a],
                )?;
                tx.query_row(
                    "SELECT baseline_ref FROM engineering_work_item_metrics WHERE project_id = ?1 AND work_item_id = ?2",
                    [&p, &t],
                    |r| r.get(0),
                )
                .optional()
            })
            .map_err(db)
    }

    fn metrics_save_task(
        &self,
        project_id: &str,
        task_id: &str,
        payload: &Value,
    ) -> Result<(), DomainError> {
        let at = payload["capturedAt"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let (p, t, body) = (
            project_id.to_owned(),
            task_id.to_owned(),
            payload.to_string(),
        );
        self.store()
            .write(move |tx| {
                tx.execute(
                    "UPDATE engineering_work_item_metrics SET payload_json = ?3, captured_at = ?4, updated_at = ?4
                     WHERE project_id = ?1 AND work_item_id = ?2",
                    params![p, t, body, at],
                )
            })
            .map(|_| ())
            .map_err(db)
    }

    fn metrics_save_project(&self, project_id: &str, payload: &Value) -> Result<(), DomainError> {
        let head = payload["head"].as_str().unwrap_or_default().to_owned();
        let at = payload["capturedAt"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let (p, body) = (project_id.to_owned(), payload.to_string());
        self.store()
            .write(move |tx| {
                let id = atm_store::events::ulid(tx)?;
                tx.execute(
                    "INSERT INTO engineering_project_metrics (project_id, id, git_head, captured_at, payload_json)
                     SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?1)",
                    params![p, id, head, at, body],
                )?;
                tx.execute(
                    "DELETE FROM engineering_project_metrics WHERE project_id = ?1 AND id IN (
                       SELECT id FROM engineering_project_metrics WHERE project_id = ?1
                       ORDER BY captured_at DESC, id DESC LIMIT -1 OFFSET ?2)",
                    params![p, PROJECT_METRICS_KEPT],
                )
            })
            .map(|_| ())
            .map_err(db)
    }

    fn metrics_project_age(
        &self,
        project_id: &str,
        at: Timestamp,
    ) -> Result<Option<i64>, DomainError> {
        let p = project_id.to_owned();
        let latest: Option<String> = self
            .store()
            .read(move |tx| {
                tx.query_row(
                    "SELECT max(captured_at) FROM engineering_project_metrics WHERE project_id = ?1",
                    [&p],
                    |r| r.get(0),
                )
            })
            .map_err(db)?;
        Ok(latest
            .and_then(|t| Timestamp::parse(&t))
            .map(|t| at.millis() - t.millis()))
    }

    /// 扫一个任务并落库：没有 baseline 先以当前 HEAD 记一个（2.x `#scanWorkItem`）。
    fn metrics_scan_task(
        &self,
        project_id: &str,
        task_id: &str,
        dir: &std::path::Path,
    ) -> Result<(), String> {
        let at = now();
        let baseline = match self
            .metrics_baseline_of(project_id, task_id)
            .map_err(|e| e.message)?
        {
            Some(b) => b,
            None => {
                let head = atm_metrics::git_head(dir)?;
                match self
                    .metrics_ensure_baseline(project_id, task_id, &head, &at.to_string())
                    .map_err(|e| e.message)?
                {
                    Some(b) => b,
                    None => return Ok(()),
                }
            }
        };
        let payload = atm_metrics::scan_work_item(dir, &baseline, now())?;
        self.metrics_save_task(project_id, task_id, &payload)
            .map_err(|e| e.message)
    }

    /// `metrics.refresh`：当场扫项目（与任务），返回与 `metrics.read` 同形状的视图。
    /// 没有源码目录报 `NO_SOURCE_PATH`，git 失败报 `METRICS_FAILED` 并带说明（2.x 一样不当作错误）。
    pub fn metrics_refresh(
        &self,
        principal: &Principal,
        project: &str,
        task_key: Option<&str>,
    ) -> Result<Value, DomainError> {
        capability::require(principal, Capability::MetricsRefresh)?;
        // 项目与任务按读的规则解析（不存在、在垃圾箱、任务不属于这个项目，错误与 `metrics.read` 相同）。
        let (id, dir, task) = self.read_located(project, |cx| {
            let task = match task_key {
                Some(reference) => Some(crate::read::views::task_by_key(cx, reference)?.id),
                None => None,
            };
            let dir: Option<String> = cx
                .tx
                .query_row(
                    "SELECT canonical_path FROM project_paths WHERE project_id = ?1
                     ORDER BY is_primary DESC, canonical_path LIMIT 1",
                    [&cx.p.id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(db)?;
            Ok((cx.p.id.clone(), dir.map(PathBuf::from), task))
        })?;
        let Some(dir) = dir else {
            return Ok(unavailable(
                "NO_SOURCE_PATH",
                Some("项目没有源码目录".into()),
            ));
        };
        let _serial = self.metrics_lock.lock().unwrap_or_else(|e| e.into_inner());
        let scanned = atm_metrics::scan_project(&dir, now(), None).and_then(|payload| {
            self.metrics_save_project(&id, &payload)
                .map_err(|e| e.message)
        });
        let scanned = scanned.and_then(|()| match &task {
            Some(t) => self.metrics_scan_task(&id, t, &dir),
            None => Ok(()),
        });
        drop(_serial);
        if let Err(message) = scanned {
            return Ok(unavailable("METRICS_FAILED", Some(message)));
        }
        self.metrics_view(project, task_key)
    }

    /// job `metrics.capture`：一次任务操作之后的采集。单个任务失败只记进报告，不影响其他任务。
    pub fn metrics_capture(
        &self,
        principal: &Principal,
        signal: &Signal,
    ) -> Result<CaptureReport, DomainError> {
        capability::require(principal, Capability::MetricsRefresh)?;
        let mut report = CaptureReport::default();
        let Some((id, source)) = self.metrics_source(&signal.project_id)? else {
            return Ok(report);
        };
        let Some(dir) = source.dir else {
            return Ok(report);
        };
        let mut keys: Vec<&String> = Vec::new();
        for k in &signal.task_keys {
            if !keys.contains(&k) {
                keys.push(k);
            }
        }
        // baseline 当场记（一条 rev-parse 加一次落库），diff 之后再算。
        let head = if signal.establish {
            match atm_metrics::git_head(&dir) {
                Ok(h) => Some(h),
                Err(e) => {
                    report.errors.push(e);
                    return Ok(report);
                }
            }
        } else {
            None
        };
        let at = now().to_string();
        let mut tasks = Vec::new();
        for key in keys {
            let Some(task) = self.metrics_task(&id, &source.code, key)? else {
                continue;
            };
            let stored = match &head {
                Some(h) => {
                    let before = self.metrics_baseline_of(&id, &task)?;
                    let after = self.metrics_ensure_baseline(&id, &task, h, &at)?;
                    if before.is_none() && after.is_some() {
                        report.baselines += 1;
                    }
                    after
                }
                None => self.metrics_baseline_of(&id, &task)?,
            };
            if stored.is_some() {
                tasks.push((key.clone(), task));
            }
        }
        let _serial = self.metrics_lock.lock().unwrap_or_else(|e| e.into_inner());
        for (key, task) in tasks {
            match self.metrics_scan_task(&id, &task, &dir) {
                Ok(()) => report.scanned.push(key),
                Err(e) => report.errors.push(format!("{key}: {e}")),
            }
        }
        // 任务结束时项目指标太旧就顺带重扫（2.x 读时做的那一次挪到这里，读本身不再扫）。
        if !signal.establish {
            let stale = self
                .metrics_project_age(&id, now())?
                .is_none_or(|age| age >= PROJECT_STALE_MS);
            if stale {
                match atm_metrics::scan_project(&dir, now(), None)
                    .and_then(|p| self.metrics_save_project(&id, &p).map_err(|e| e.message))
                {
                    Ok(()) => report.project_scanned = true,
                    Err(e) => report.errors.push(format!("PROJECT: {e}")),
                }
            }
        }
        Ok(report)
    }
}

fn unavailable(reason: &str, message: Option<String>) -> Value {
    json!({
        "available": false,
        "reason": reason,
        "message": message,
        "project": null,
        "workItem": null,
    })
}
