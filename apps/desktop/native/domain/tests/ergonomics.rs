//! 10 R11 P1-1（自动补 start、owner 路径省略版本）与 P1-5（默认 READY）、00 C-17（公开入口只建 BACKLOG / READY）。

use atm_domain::work::{
    AutoStart, Operation, PatchKind, StateWrite, Status, VersionNeed, auto_start,
    public_create_state, version_need,
};

#[test]
fn r11_auto_start_applies_before_state_writes_on_unstarted_tasks() {
    let writes = [
        StateWrite::Basic(Operation::Complete),
        StateWrite::Basic(Operation::Verify),
        StateWrite::Basic(Operation::WaitAgent),
        StateWrite::Basic(Operation::WaitUser),
        StateWrite::Basic(Operation::Block),
        StateWrite::VerifyAndComplete,
    ];
    for w in writes {
        for s in [Status::Backlog, Status::Ready, Status::Claimed] {
            assert_eq!(auto_start(w, s), AutoStart::Apply, "{w:?} on {s}");
        }
        for s in [
            Status::InProgress,
            Status::Verifying,
            Status::Done,
            Status::Cancelled,
        ] {
            assert_eq!(auto_start(w, s), AutoStart::NotApplicable, "{w:?} on {s}");
        }
    }
    // 其他操作从不自动补 start。
    for op in [
        Operation::Claim,
        Operation::Start,
        Operation::Release,
        Operation::Ready,
        Operation::Cancel,
        Operation::Reopen,
        Operation::Edit,
    ] {
        for &s in Status::ALL {
            assert_eq!(
                auto_start(StateWrite::Basic(op), s),
                AutoStart::NotApplicable,
                "{op} on {s}"
            );
        }
    }
}

#[test]
fn r11_blocked_and_waiting_are_never_auto_started() {
    use AutoStart::{NotApplicable as Na, SuggestStart as Suggest};
    // 状态机本来就放行的不提示；会被拒的（INVALID_TRANSITION 或完成门的 current_state）给出 start。
    let cases = [
        (
            StateWrite::Basic(Operation::Complete),
            [Suggest, Suggest, Suggest],
        ),
        (StateWrite::VerifyAndComplete, [Suggest, Na, Na]),
        (StateWrite::Basic(Operation::Verify), [Suggest, Na, Na]),
        (StateWrite::Basic(Operation::Block), [Na, Na, Na]),
        (StateWrite::Basic(Operation::WaitAgent), [Na, Na, Suggest]),
        (StateWrite::Basic(Operation::WaitUser), [Na, Suggest, Na]),
    ];
    for (w, expected) in cases {
        for (s, e) in [Status::Blocked, Status::WaitingAgent, Status::WaitingUser]
            .into_iter()
            .zip(expected)
        {
            assert_eq!(auto_start(w, s), e, "{w:?} on {s}");
        }
    }
}

#[test]
fn r11_version_is_optional_only_for_the_claim_holder() {
    let always = [
        PatchKind::Basic(Operation::Edit),
        PatchKind::Basic(Operation::Cancel),
        PatchKind::Basic(Operation::Reopen),
        PatchKind::ReviewRequest,
        PatchKind::ReviewSubmit,
    ];
    for k in always {
        assert_eq!(version_need(k, true), VersionNeed::Required, "{k:?}");
        assert_eq!(version_need(k, false), VersionNeed::Required, "{k:?}");
    }
    let owner_optional = [
        PatchKind::Basic(Operation::Claim),
        PatchKind::Basic(Operation::Start),
        PatchKind::Basic(Operation::Release),
        PatchKind::Basic(Operation::Ready),
        PatchKind::Basic(Operation::Block),
        PatchKind::Basic(Operation::WaitAgent),
        PatchKind::Basic(Operation::WaitUser),
        PatchKind::Basic(Operation::Verify),
        PatchKind::Basic(Operation::Complete),
        PatchKind::VerifyAndComplete,
        PatchKind::ChecklistSingle,
        PatchKind::ChecklistBatch,
    ];
    for k in owner_optional {
        assert_eq!(version_need(k, true), VersionNeed::Optional, "{k:?}");
        // 非 owner（他人领取、User、release 别人的过期领取）仍然要版本。
        assert_eq!(version_need(k, false), VersionNeed::Required, "{k:?}");
    }
}

#[test]
fn p1_5_and_c17_public_creation_defaults_to_ready() {
    assert_eq!(
        public_create_state(None).map(|s| s.status()),
        Ok(Status::Ready)
    );
    assert_eq!(
        public_create_state(Some(Status::Backlog)).map(|s| s.status()),
        Ok(Status::Backlog)
    );
    for s in [
        Status::Claimed,
        Status::InProgress,
        Status::Blocked,
        Status::WaitingAgent,
        Status::WaitingUser,
        Status::Verifying,
        Status::Done,
        Status::Cancelled,
    ] {
        assert_eq!(public_create_state(Some(s)), Err(s));
    }
}

#[test]
fn r1_claim_guard_covers_every_write_except_the_claim_rules_themselves() {
    for &op in Operation::ALL {
        let expected = !matches!(op, Operation::Claim | Operation::Start | Operation::Release);
        assert_eq!(op.guarded_by_claim(), expected, "{op}");
    }
}
