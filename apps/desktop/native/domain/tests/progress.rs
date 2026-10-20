//! 进度（D28；W-110～W-115；00 C-02、C-04、C-23、C-24）。

use atm_domain::gate::ChecklistStatus;
use atm_domain::progress::{
    ChecklistWeight, ChildProgress, Progress, ProgressSource, compute, recompute_bumps_version,
    report_bucket, reported_after_report,
};
use atm_domain::work::Status;

fn child(status: Status, computed_progress: f64, weight: f64) -> ChildProgress {
    ChildProgress {
        status,
        computed_progress,
        weight,
    }
}

fn check(status: ChecklistStatus, weight: f64) -> ChecklistWeight {
    ChecklistWeight { status, weight }
}

fn p(value: f64, source: ProgressSource) -> Progress {
    Progress { value, source }
}

#[test]
fn w110_source_priority() {
    let ip = Status::InProgress;
    assert_eq!(
        compute(
            ip,
            &[child(Status::Done, 100.0, 1.0), child(ip, 40.0, 1.0)],
            &[],
            None
        ),
        p(70.0, ProgressSource::Children)
    );
    assert_eq!(
        compute(
            ip,
            &[],
            &[
                check(ChecklistStatus::Done, 1.0),
                check(ChecklistStatus::Todo, 3.0)
            ],
            None
        ),
        p(25.0, ProgressSource::Checklist)
    );
    assert_eq!(
        compute(ip, &[], &[], Some(86.0)),
        p(90.0, ProgressSource::Reported)
    );
    assert_eq!(compute(ip, &[], &[], None), p(0.0, ProgressSource::None));
    // 子项优先于检查项，检查项优先于上报。
    assert_eq!(
        compute(
            ip,
            &[child(ip, 10.0, 1.0)],
            &[check(ChecklistStatus::Done, 1.0)],
            Some(90.0)
        ),
        p(10.0, ProgressSource::Children)
    );
    assert_eq!(
        compute(ip, &[], &[check(ChecklistStatus::Todo, 1.0)], Some(90.0)),
        p(0.0, ProgressSource::Checklist)
    );
}

#[test]
fn w110_done_is_100_and_unfinished_caps_at_99() {
    // C-24：DONE 的来源是 NONE。
    assert_eq!(
        compute(Status::Done, &[child(Status::Ready, 0.0, 1.0)], &[], None),
        p(100.0, ProgressSource::None)
    );
    // 子项全部 DONE 但父未 DONE → 99；上报 100 也只显示 99（D28）。
    assert_eq!(
        compute(
            Status::InProgress,
            &[child(Status::Done, 100.0, 1.0)],
            &[],
            None
        ),
        p(99.0, ProgressSource::Children)
    );
    assert_eq!(
        compute(Status::InProgress, &[], &[], Some(100.0)),
        p(99.0, ProgressSource::Reported)
    );
}

#[test]
fn w110_cancelled_children_and_skipped_items_drop_out() {
    let ip = Status::InProgress;
    // 子项全部 CANCELLED：落到检查项 / 上报，而不是按 CHILDREN 算出 0。
    assert_eq!(
        compute(ip, &[child(Status::Cancelled, 0.0, 1.0)], &[], Some(40.0)),
        p(40.0, ProgressSource::Reported)
    );
    assert_eq!(
        compute(ip, &[], &[check(ChecklistStatus::Skipped, 1.0)], Some(40.0)),
        p(40.0, ProgressSource::Reported)
    );
    // DOING 记 0。
    assert_eq!(
        compute(
            ip,
            &[],
            &[
                check(ChecklistStatus::Doing, 1.0),
                check(ChecklistStatus::Done, 1.0)
            ],
            None
        ),
        p(50.0, ProgressSource::Checklist)
    );
}

#[test]
fn w111_weights_clamp_at_zero() {
    let ip = Status::InProgress;
    assert_eq!(
        compute(
            ip,
            &[],
            &[
                check(ChecklistStatus::Done, 3.0),
                check(ChecklistStatus::Todo, 1.0)
            ],
            None
        ),
        p(75.0, ProgressSource::Checklist)
    );
    assert_eq!(
        compute(
            ip,
            &[],
            &[
                check(ChecklistStatus::Done, 0.0),
                check(ChecklistStatus::Done, 0.0)
            ],
            None
        ),
        p(0.0, ProgressSource::Checklist)
    );
    assert_eq!(
        compute(
            ip,
            &[],
            &[
                check(ChecklistStatus::Done, -5.0),
                check(ChecklistStatus::Todo, 1.0)
            ],
            None
        ),
        p(0.0, ProgressSource::Checklist)
    );
    // 负权重在分子和分母里都按 0 计：[DONE 1, TODO 1, TODO -1] 是 50，不是 100（再封顶成 99）。
    assert_eq!(
        compute(
            ip,
            &[],
            &[
                check(ChecklistStatus::Done, 1.0),
                check(ChecklistStatus::Todo, 1.0),
                check(ChecklistStatus::Todo, -1.0)
            ],
            None
        ),
        p(50.0, ProgressSource::Checklist)
    );
}

#[test]
fn w112_rounding_is_math_round() {
    let ip = Status::InProgress;
    let third = |done: usize| {
        let items: Vec<_> = (0..3)
            .map(|n| {
                check(
                    if n < done {
                        ChecklistStatus::Done
                    } else {
                        ChecklistStatus::Todo
                    },
                    1.0,
                )
            })
            .collect();
        compute(ip, &[], &items, None).value
    };
    assert_eq!(third(1), 33.3);
    assert_eq!(third(2), 66.7);
    assert_eq!(report_bucket(45.0), 50.0);
    assert_eq!(report_bucket(44.0), 40.0);
    assert_eq!(report_bucket(37.0), 40.0);
    assert_eq!(report_bucket(150.0), 100.0);
    assert_eq!(report_bucket(-3.0), 0.0);
    // 一位小数 .x5 向上（JS Math.round）：子项 [0.25 → 平均 0.25] → 0.3。
    assert_eq!(compute(ip, &[child(ip, 0.25, 1.0)], &[], None).value, 0.3);
}

#[test]
fn c23_report_without_percent_keeps_previous() {
    assert_eq!(reported_after_report(Some(40.0), None), Some(40.0));
    assert_eq!(reported_after_report(Some(40.0), Some(86.0)), Some(90.0));
    assert_eq!(reported_after_report(None, None), None);
}

#[test]
fn c02_version_moves_only_when_derived_values_change() {
    let a = p(50.0, ProgressSource::Checklist);
    assert!(!recompute_bumps_version(a, a));
    assert!(recompute_bumps_version(
        a,
        p(50.1, ProgressSource::Checklist)
    ));
    assert!(recompute_bumps_version(
        a,
        p(50.0, ProgressSource::Children)
    ));
    assert!(!recompute_bumps_version(
        p(0.0, ProgressSource::None),
        p(-0.0, ProgressSource::None)
    ));
}
