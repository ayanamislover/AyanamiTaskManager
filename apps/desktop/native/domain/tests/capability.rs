//! 能力目录（03 §3、§2.4、§5.2；P-005、P-008、P-009、P-017；M-05、M-12、M-13、M-17；00 §3 C-07、C-08、C-10）。

use atm_domain::capability::{Capability, require};
use atm_domain::error::ErrorCode;
use atm_domain::principal::{JobId, Principal, UiSurface};

fn user() -> Principal {
    Principal::trusted_ui(UiSurface::WebView {
        generation: 1,
        epoch: 1,
    })
}

fn agent() -> Principal {
    Principal::authenticated_agent(None)
}

fn phone() -> Principal {
    Principal::verified_phone("space".into(), "device".into(), "command".into())
}

/// M-05：USER_ONLY 集合的数量与名单（替代 2.x 的 `>= 25` 下限）。改小、漏项都会变红。
#[test]
fn m05_user_only_snapshot() {
    let mut got: Vec<&str> = Capability::ALL
        .iter()
        .filter(|c| c.is_user_only())
        .map(|c| c.as_str())
        .collect();
    got.sort_unstable();
    let mut expected = vec![
        "agents.install_mcp",
        "agents.manage",
        "agents.profile_switch",
        "backup.create_manual",
        "backup.restore_scope",
        "dispatch.cancel",
        "dispatch.configure",
        "dispatch.launch",
        "export.create",
        "import.apply",
        "knowledge.archive",
        "knowledge.user_edit",
        "metrics.refresh",
        "notification.mode_set",
        "project.archive",
        "project.path_attach",
        "project.restore_request.decide",
        "project.trash",
        "project.unarchive",
        "project.untrash",
        "project_update.draft",
        "project_update.publish",
        "saved_view.manage",
        "session.force_close",
        "session.git_refresh",
        "settings.write",
        "shell.autostart",
        "shell.clipboard_write",
        "shell.reveal_path",
        "shell.window",
        "sync.configure",
        "sync.pairing_create",
        "sync.reset",
        "sync.test_relay",
        "update.apply",
        "update.check",
    ];
    expected.sort_unstable();
    assert_eq!(got, expected);
}

/// 每一项 USER_ONLY：Agent 被拒且是 USER_AUTHORIZATION_REQUIRED；阳性对照 User 放行。
#[test]
fn m01_agent_is_refused_every_user_only_capability() {
    for &cap in Capability::ALL.iter().filter(|c| c.is_user_only()) {
        let err = require(&agent(), cap).unwrap_err();
        assert_eq!(
            err.code,
            ErrorCode::USER_AUTHORIZATION_REQUIRED,
            "{}",
            cap.as_str()
        );
        assert_eq!(err.details["principal"], "AGENT");
        assert_eq!(err.details["capability"], cap.as_str());
        assert!(require(&user(), cap).is_ok(), "{}", cap.as_str());
    }
}

/// 03 §5.2：拒绝信封的 details 是 `{principal:"AGENT", where, next_step}`。User 有、Agent 没有的每个能力
/// （读也算）都要有具体的界面入口；只有不在界面上单列的宿主动作用「ATM 桌面端」。
#[test]
fn every_user_side_refusal_names_where_and_the_next_step() {
    let generic = ["shell.clipboard_write", "shell.reveal_path", "shell.window"];
    let mut seen = 0;
    for &cap in Capability::ALL {
        let g = cap.grant();
        if !(g.user && !g.agent) {
            assert_eq!(cap.user_entry(), None, "{}", cap.as_str());
            continue;
        }
        seen += 1;
        let err = require(&agent(), cap).unwrap_err();
        assert_eq!(
            err.code,
            ErrorCode::USER_AUTHORIZATION_REQUIRED,
            "{}",
            cap.as_str()
        );
        let entry = cap
            .user_entry()
            .unwrap_or_else(|| panic!("{} has no entry", cap.as_str()));
        assert_eq!(err.details["where"], entry, "{}", cap.as_str());
        assert_eq!(
            err.details["next_step"],
            atm_domain::capability::USER_NEXT_STEP
        );
        assert!(err.message.contains(entry), "{}", err.message);
        assert_eq!(
            entry == "ATM 桌面端",
            generic.contains(&cap.as_str()),
            "{}: {entry}",
            cap.as_str()
        );
    }
    assert!(seen > 35, "{seen}");
}

#[test]
fn decisions_on_who_may_do_what() {
    // C-07：导出只给 User；C-08：metrics.refresh 不给 Agent，metrics.read 给。
    assert!(require(&agent(), Capability::ExportCreate).is_err());
    assert!(require(&agent(), Capability::MetricsRefresh).is_err());
    assert!(require(&agent(), Capability::MetricsRead).is_ok());
    // C-10：User 不能发起或提交 review。
    for cap in [Capability::ReviewRequest, Capability::ReviewSubmit] {
        let err = require(&user(), cap).unwrap_err();
        assert_eq!(err.code, ErrorCode::PRINCIPAL_CAPABILITY_DENIED);
        assert!(require(&agent(), cap).is_ok());
    }
    // C-09：只供界面用的读接口不对 Agent 开放。
    for cap in [
        Capability::SavedViewRead,
        Capability::SettingsRead,
        Capability::KnowledgePreviewRecord,
        Capability::SyncStatus,
        Capability::DispatchStatus,
    ] {
        assert!(require(&agent(), cap).is_err(), "{}", cap.as_str());
        assert!(require(&user(), cap).is_ok());
    }
    // M-17：Agent 不能建备份。
    assert!(require(&agent(), Capability::BackupCreateManual).is_err());
    // Agent 碰 System 专属能力：不是「请用户来做」，而是越权。
    assert_eq!(
        require(&agent(), Capability::SessionRecoverStale)
            .unwrap_err()
            .code,
        ErrorCode::PRINCIPAL_CAPABILITY_DENIED
    );
}

/// P-008 / M-13：Phone 只有两项能力。
#[test]
fn p008_phone_has_exactly_two_capabilities() {
    let got: Vec<&str> = Capability::ALL
        .iter()
        .filter(|c| c.allows(&phone()))
        .map(|c| c.as_str())
        .collect();
    assert_eq!(got, ["work.create", "dispatch.launch"]);
    let err = require(&phone(), Capability::WorkPatch).unwrap_err();
    assert_eq!(err.code, ErrorCode::PRINCIPAL_CAPABILITY_DENIED);
}

/// P-017：dispatch.launch 只给 User 和 Phone。
#[test]
fn p017_only_user_and_phone_launch() {
    assert!(require(&user(), Capability::DispatchLaunch).is_ok());
    assert!(require(&phone(), Capability::DispatchLaunch).is_ok());
    assert!(require(&agent(), Capability::DispatchLaunch).is_err());
    for &job in JobId::ALL {
        assert!(require(&Principal::system_job(job), Capability::DispatchLaunch).is_err());
    }
}

/// M-12：System 按 job 的能力快照。
#[test]
fn m12_system_job_snapshot() {
    let mut got = Vec::new();
    for &job in JobId::ALL {
        let p = Principal::system_job(job);
        let caps: Vec<&str> = Capability::ALL
            .iter()
            .filter(|c| c.allows(&p))
            .map(|c| c.as_str())
            .collect();
        got.push((job.as_str(), caps));
    }
    let expected: Vec<(&str, Vec<&str>)> = vec![
        (
            "startup.recover",
            vec!["session.recover_stale", "store.cleanup"],
        ),
        (
            "maintenance",
            vec![
                "settings.read",
                "backup.list",
                "backup.create_scheduled",
                "backup.prune_retention",
                "store.maintain",
            ],
        ),
        ("metrics.capture", vec!["metrics.refresh"]),
        (
            "notify.observe",
            vec!["events.read", "settings.read", "notify.send"],
        ),
        ("update.check", vec!["settings.read", "update.check"]),
        (
            "sync.loop",
            vec![
                "project.read",
                "work.read",
                "record.read",
                "session.read",
                "search.read",
                "events.read",
                "settings.read",
                "sync.run",
            ],
        ),
        ("dispatch.track", vec!["settings.read", "dispatch.track"]),
        ("agents.repair", vec!["settings.read", "agents.manage"]),
        ("agents.docs", vec!["agents.docs_install"]),
        ("memory.release", vec!["memory.release"]),
        ("keepalive", vec![]),
    ];
    assert_eq!(got, expected);
    // P-009 反例：maintenance 不能做用户决定。
    let m = Principal::system_job(JobId::Maintenance);
    for cap in [
        Capability::BackupRestoreScope,
        Capability::ProjectTrash,
        Capability::BackupCreateManual,
    ] {
        let err = require(&m, cap).unwrap_err();
        assert_eq!(err.code, ErrorCode::PRINCIPAL_CAPABILITY_DENIED);
        assert_eq!(err.details["job"], "maintenance");
    }
}

/// 「需 session」列：Agent 的项目写入都要 session；begin、quick、project.create 不要。
#[test]
fn agent_session_column() {
    let needs: Vec<&str> = Capability::ALL
        .iter()
        .filter(|c| c.grant().agent_needs_session)
        .map(|c| c.as_str())
        .collect();
    assert_eq!(
        needs,
        [
            "session.end",
            "work.plan",
            "work.create",
            "work.patch",
            "work.verify_complete",
            "checklist.update",
            "review.request",
            "review.submit",
            "progress.add",
            "record.create",
            "record.feedback",
            "knowledge.agent_save",
        ]
    );
    // 只对 Agent 有意义：Agent 没有的能力不应标「需 session」。
    for &c in Capability::ALL {
        if c.grant().agent_needs_session {
            assert!(c.grant().agent, "{}", c.as_str());
        }
    }
}

#[test]
fn capability_names_are_unique() {
    let mut names: Vec<&str> = Capability::ALL.iter().map(|c| c.as_str()).collect();
    let n = names.len();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), n);
}
