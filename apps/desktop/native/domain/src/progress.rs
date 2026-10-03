//! 进度（01 §6 W-110～W-115；00 C-02、C-04、C-23、C-24）。

use crate::gate::ChecklistStatus;
use crate::text::js_round;
use crate::work::Status;
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ProgressSource {
    Children,
    Checklist,
    Reported,
    None,
}

#[derive(Clone, Copy, Debug)]
pub struct ChildProgress {
    pub status: Status,
    pub computed_progress: f64,
    pub weight: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct ChecklistWeight {
    pub status: ChecklistStatus,
    pub weight: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Progress {
    pub value: f64,
    pub source: ProgressSource,
}

/// W-110：DONE → 100/NONE；否则依次取未取消的子项、非 SKIPPED 的检查项、上报值，都没有就 0/NONE。
/// 第 2–5 步的结果再做一位小数舍入，未 DONE 最多 99（D28：上报 100 也不能当完成）。
pub fn compute(
    status: Status,
    children: &[ChildProgress],
    checklist: &[ChecklistWeight],
    reported: Option<f64>,
) -> Progress {
    if status == Status::Done {
        return Progress {
            value: 100.0,
            source: ProgressSource::None,
        };
    }
    let active: Vec<_> = children
        .iter()
        .filter(|c| c.status != Status::Cancelled)
        .collect();
    let counted: Vec<_> = checklist
        .iter()
        .filter(|c| c.status != ChecklistStatus::Skipped)
        .collect();
    let (value, source) = if !active.is_empty() {
        (
            weighted(active.iter().map(|c| (c.computed_progress, c.weight))),
            ProgressSource::Children,
        )
    } else if !counted.is_empty() {
        let done = |c: &ChecklistWeight| {
            if c.status == ChecklistStatus::Done {
                100.0
            } else {
                0.0
            }
        };
        (
            weighted(counted.iter().map(|c| (done(c), c.weight))),
            ProgressSource::Checklist,
        )
    } else if let Some(r) = reported {
        (report_bucket(r), ProgressSource::Reported)
    } else {
        (0.0, ProgressSource::None)
    };
    Progress {
        value: js_round(value.min(99.0) * 10.0) / 10.0,
        source,
    }
}

/// W-111：权重先取 max(0, w)，总权重为 0 时结果为 0。
fn weighted(items: impl Iterator<Item = (f64, f64)> + Clone) -> f64 {
    let total: f64 = items.clone().map(|(_, w)| w.max(0.0)).sum();
    if total == 0.0 {
        return 0.0;
    }
    items.map(|(v, w)| v * w.max(0.0)).sum::<f64>() / total
}

/// W-112 / W-115：上报值按十位舍入（JS `Math.round`，45 → 50）。
pub fn report_bucket(percent: f64) -> f64 {
    js_round(percent.clamp(0.0, 100.0) / 10.0) * 10.0
}

/// 00 C-23：上报不带 percent 时保留原来的 reported_progress。
pub fn reported_after_report(previous: Option<f64>, percent: Option<f64>) -> Option<f64> {
    percent.map(report_bucket).or(previous)
}

/// 00 C-02：只有 computed_progress 或 progress_source 实际变化，重算才推版本。
pub fn recompute_bumps_version(before: Progress, after: Progress) -> bool {
    before.value != after.value || before.source != after.source
}
