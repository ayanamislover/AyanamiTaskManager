//! 能力目录（03 §3、§2.4、§5.2；00 §3 C-07、C-08、C-09、C-10）。
//!
//! 每个服务入口第一步调用 `require(principal, Capability::X)`，在任何副作用之前（P-004）。
//! 表里 U=✓、A=– 的写能力合起来就是 USER_ONLY 集合（P-005）；System 的授权是一份按 job 的
//! 快照常量，新增 job 或扩大能力都必须改快照（M-12）。

use crate::error::{DomainError, ErrorCode};
use crate::principal::{JobId, Principal, PrincipalKind};

macro_rules! capabilities {
    ($($cap:ident => $name:literal, $rw:ident, U $u:literal, A $a:literal, P $p:literal, session $s:literal, S [$($job:ident),*];)+) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum Capability { $($cap),+ }

        impl Capability {
            pub const ALL: &'static [Capability] = &[$(Capability::$cap),+];

            pub const fn as_str(self) -> &'static str {
                match self { $(Capability::$cap => $name),+ }
            }

            pub const fn grant(self) -> Grant {
                match self {
                    $(Capability::$cap => Grant {
                        access: Access::$rw,
                        user: $u,
                        agent: $a,
                        phone: $p,
                        agent_needs_session: $s,
                        system: &[$(JobId::$job),*],
                    }),+
                }
            }
        }
    };
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    Read,
    Write,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Grant {
    pub access: Access,
    pub user: bool,
    pub agent: bool,
    pub phone: bool,
    /// 03 §3「需 session」列，只针对 Agent。
    pub agent_needs_session: bool,
    pub system: &'static [JobId],
}

// 名称 => 读写, U, A, P, Agent 需 session, System 允许的 job。
capabilities! {
    SystemStatus => "system.status", Read, U true, A true, P false, session false, S [];
    ProjectRead => "project.read", Read, U true, A true, P false, session false, S [SyncLoop];
    WorkRead => "work.read", Read, U true, A true, P false, session false, S [SyncLoop];
    RecordRead => "record.read", Read, U true, A true, P false, session false, S [SyncLoop];
    SessionRead => "session.read", Read, U true, A true, P false, session false, S [SyncLoop];
    SearchRead => "search.read", Read, U true, A true, P false, session false, S [SyncLoop];
    EventsRead => "events.read", Read, U true, A true, P false, session false, S [SyncLoop, NotifyObserve];
    QuickRead => "quick.read", Read, U true, A true, P false, session false, S [];
    KnowledgeRead => "knowledge.read", Read, U true, A true, P false, session false, S [];
    KnowledgePreviewRecord => "knowledge.preview_record", Read, U true, A false, P false, session false, S [];
    SavedViewRead => "saved_view.read", Read, U true, A false, P false, session false, S [];
    // 「各 job 只读自己需要的 key」：key 级过滤在服务的设置读取里做，这里只给需要读设置的 job。
    SettingsRead => "settings.read", Read, U true, A false, P false, session false,
        S [Maintenance, NotifyObserve, UpdateCheck, SyncLoop, DispatchTrack, AgentsRepair];
    BackupList => "backup.list", Read, U true, A true, P false, session false, S [Maintenance];
    SessionBegin => "session.begin", Write, U false, A true, P false, session false, S [];
    // C-04：只能结束自己 lineage 内的 session（服务判定）。
    SessionEnd => "session.end", Write, U false, A true, P false, session true, S [];
    SessionForceClose => "session.force_close", Write, U true, A false, P false, session false, S [];
    SessionGitRefresh => "session.git_refresh", Write, U true, A false, P false, session false, S [];
    SessionRecoverStale => "session.recover_stale", Write, U false, A false, P false, session false, S [StartupRecover];
    ProjectCreate => "project.create", Write, U true, A true, P false, session false, S [];
    ProjectPathAttach => "project.path_attach", Write, U true, A false, P false, session false, S [];
    ProjectArchive => "project.archive", Write, U true, A false, P false, session false, S [];
    ProjectUnarchive => "project.unarchive", Write, U true, A false, P false, session false, S [];
    ProjectTrash => "project.trash", Write, U true, A false, P false, session false, S [];
    ProjectUntrash => "project.untrash", Write, U true, A false, P false, session false, S [];
    // 只能经 begin 撞上 TRASHED 时隐式触发（服务保证没有别的入口）。
    ProjectRestoreRequestCreate => "project.restore_request.create", Write, U false, A true, P false, session false, S [];
    ProjectRestoreRequestDecide => "project.restore_request.decide", Write, U true, A false, P false, session false, S [];
    WorkPlan => "work.plan", Write, U true, A true, P false, session true, S [];
    WorkCreate => "work.create", Write, U true, A true, P true, session true, S [];
    WorkPatch => "work.patch", Write, U true, A true, P false, session true, S [];
    WorkVerifyComplete => "work.verify_complete", Write, U true, A true, P false, session true, S [];
    ChecklistUpdate => "checklist.update", Write, U true, A true, P false, session true, S [];
    // C-10：User 不能发起或提交 review。
    ReviewRequest => "review.request", Write, U false, A true, P false, session true, S [];
    ReviewSubmit => "review.submit", Write, U false, A true, P false, session true, S [];
    ProgressAdd => "progress.add", Write, U false, A true, P false, session true, S [];
    ProjectUpdatePublish => "project_update.publish", Write, U true, A false, P false, session false, S [];
    ProjectUpdateDraft => "project_update.draft", Write, U true, A false, P false, session false, S [];
    RecordCreate => "record.create", Write, U true, A true, P false, session true, S [];
    RecordFeedback => "record.feedback", Write, U false, A true, P false, session true, S [];
    // Agent 的 quick 写入 actor 是自己，不能是 USER（03 §5.3、C-12，服务判定）。
    QuickCreate => "quick.create", Write, U true, A true, P false, session false, S [];
    QuickUpdate => "quick.update", Write, U true, A true, P false, session false, S [];
    QuickPromote => "quick.promote", Write, U true, A true, P false, session false, S [];
    KnowledgeAgentSave => "knowledge.agent_save", Write, U false, A true, P false, session true, S [];
    KnowledgeUserEdit => "knowledge.user_edit", Write, U true, A false, P false, session false, S [];
    KnowledgeArchive => "knowledge.archive", Write, U true, A false, P false, session false, S [];
    SavedViewManage => "saved_view.manage", Write, U true, A false, P false, session false, S [];
    SettingsWrite => "settings.write", Write, U true, A false, P false, session false, S [];
    NotificationModeSet => "notification.mode_set", Write, U true, A false, P false, session false, S [];
    BackupCreateManual => "backup.create_manual", Write, U true, A false, P false, session false, S [];
    BackupCreateScheduled => "backup.create_scheduled", Write, U false, A false, P false, session false, S [Maintenance];
    BackupPruneRetention => "backup.prune_retention", Write, U false, A false, P false, session false, S [Maintenance];
    BackupRestoreScope => "backup.restore_scope", Write, U true, A false, P false, session false, S [];
    ImportPreview => "import.preview", Read, U true, A true, P false, session false, S [];
    ImportApply => "import.apply", Write, U true, A false, P false, session false, S [];
    // 00 C-07：导出改为 POST，只有 User 能用。
    ExportCreate => "export.create", Write, U true, A false, P false, session false, S [];
    MetricsRead => "metrics.read", Read, U true, A true, P false, session false, S [];
    // 00 C-08：刷新只给 User 和 System。
    MetricsRefresh => "metrics.refresh", Write, U true, A false, P false, session false, S [MetricsCapture];
    SyncStatus => "sync.status", Read, U true, A false, P false, session false, S [];
    SyncConfigure => "sync.configure", Write, U true, A false, P false, session false, S [];
    SyncTestRelay => "sync.test_relay", Write, U true, A false, P false, session false, S [];
    SyncPairingCreate => "sync.pairing_create", Write, U true, A false, P false, session false, S [];
    SyncReset => "sync.reset", Write, U true, A false, P false, session false, S [];
    DispatchStatus => "dispatch.status", Read, U true, A false, P false, session false, S [];
    DispatchConfigure => "dispatch.configure", Write, U true, A false, P false, session false, S [];
    // P-017：只给 User 和 Phone。
    DispatchLaunch => "dispatch.launch", Write, U true, A false, P true, session false, S [];
    DispatchCancel => "dispatch.cancel", Write, U true, A false, P false, session false, S [];
    AgentsRead => "agents.read", Read, U true, A false, P false, session false, S [];
    AgentsInstallMcp => "agents.install_mcp", Write, U true, A false, P false, session false, S [];
    // agents.repair 只修复已接入的客户端（P-016，动作白名单在服务里）。
    AgentsManage => "agents.manage", Write, U true, A false, P false, session false, S [AgentsRepair];
    AgentsProfileSwitch => "agents.profile_switch", Write, U true, A false, P false, session false, S [];
    UpdateStatus => "update.status", Read, U true, A false, P false, session false, S [];
    UpdateCheck => "update.check", Write, U true, A false, P false, session false, S [UpdateCheck];
    UpdateApply => "update.apply", Write, U true, A false, P false, session false, S [];
    ShellAutostart => "shell.autostart", Write, U true, A false, P false, session false, S [];
    ShellClipboardWrite => "shell.clipboard_write", Write, U true, A false, P false, session false, S [];
    ShellRevealPath => "shell.reveal_path", Write, U true, A false, P false, session false, S [];
    ShellWindow => "shell.window", Write, U true, A false, P false, session false, S [];
    // —— 03 §2.4 里 job 的「允许」列，表 §3 没有单列的内部能力 ——
    StoreCleanup => "store.cleanup", Write, U false, A false, P false, session false, S [StartupRecover];
    StoreMaintain => "store.maintain", Write, U false, A false, P false, session false, S [Maintenance];
    NotifySend => "notify.send", Write, U false, A false, P false, session false, S [NotifyObserve];
    SyncRun => "sync.run", Write, U false, A false, P false, session false, S [SyncLoop];
    DispatchTrackRuns => "dispatch.track", Write, U false, A false, P false, session false, S [DispatchTrack];
    AgentsDocsInstall => "agents.docs_install", Write, U false, A false, P false, session false, S [AgentsDocs];
    MemoryReleaseCaches => "memory.release", Write, U false, A false, P false, session false, S [MemoryRelease];
}

impl Capability {
    /// USER_ONLY：User 有、Agent 没有的写能力（P-005）。
    pub fn is_user_only(self) -> bool {
        let g = self.grant();
        g.access == Access::Write && g.user && !g.agent
    }

    /// 用户在桌面端完成这一步的入口（03 §5.2 拒绝信封的 `where`）。只对 User 有、Agent 没有的能力有意义；
    /// 其余能力返回 `None`。
    pub fn user_entry(self) -> Option<&'static str> {
        use Capability::*;
        let g = self.grant();
        if !g.user || g.agent {
            return None;
        }
        Some(match self {
            KnowledgePreviewRecord => "ATM 窗口 → 记录详情 → 预览为知识",
            SavedViewRead | SavedViewManage => "ATM 窗口 → 项目任务列表 → 已保存的视图",
            SettingsRead | SettingsWrite => "ATM 窗口 → 设置",
            NotificationModeSet => "ATM 窗口 → 设置 → 通知",
            SessionForceClose => "ATM 窗口 → Agents → 强制结束 session",
            SessionGitRefresh => "ATM 窗口 → Agents → 刷新 git 上下文",
            ProjectPathAttach => "ATM 窗口 → 项目 → 路径",
            ProjectArchive => "ATM 窗口 → 项目 → 归档",
            ProjectUnarchive => "ATM 窗口 → 项目 → 取消归档",
            ProjectTrash => "ATM 窗口 → 项目 → 移到垃圾箱",
            ProjectUntrash => "ATM 窗口 → 项目列表 → 垃圾箱 → 恢复",
            ProjectRestoreRequestDecide => "ATM 窗口 → 项目列表 → 垃圾箱 → 恢复请求",
            ProjectUpdateDraft | ProjectUpdatePublish => "ATM 窗口 → 项目概览 → 发布项目进度",
            KnowledgeUserEdit => "ATM 窗口 → 知识库 → 编辑",
            KnowledgeArchive => "ATM 窗口 → 知识库 → 归档",
            BackupCreateManual => "ATM 窗口 → 项目数据 → 备份",
            BackupRestoreScope => "ATM 窗口 → 项目数据 → 从备份恢复",
            ImportApply => "ATM 窗口 → 项目数据 → 导入",
            ExportCreate => "ATM 窗口 → 项目数据 → 导出",
            MetricsRefresh => "ATM 窗口 → 项目统计 → 刷新",
            SyncStatus | SyncConfigure | SyncTestRelay | SyncPairingCreate | SyncReset => {
                "ATM 窗口 → 设置 → 手机同步"
            }
            DispatchStatus | DispatchConfigure | DispatchCancel => "ATM 窗口 → 设置 → 派单",
            DispatchLaunch => "ATM 窗口 → 任务详情 → 派单",
            AgentsRead | AgentsInstallMcp | AgentsManage | AgentsProfileSwitch => {
                "ATM 窗口 → 设置 → Agent 接入"
            }
            UpdateStatus | UpdateCheck | UpdateApply => "ATM 窗口 → 设置 → 更新",
            ShellAutostart => "ATM 窗口 → 设置 → 开机启动",
            ShellClipboardWrite | ShellRevealPath | ShellWindow => "ATM 桌面端",
            _ => return None,
        })
    }

    pub fn allows(self, principal: &Principal) -> bool {
        let g = self.grant();
        match principal.kind() {
            PrincipalKind::User => g.user,
            PrincipalKind::Agent => g.agent,
            PrincipalKind::Phone => g.phone,
            PrincipalKind::System => principal.job().is_some_and(|job| g.system.contains(&job)),
        }
    }
}

/// 03 §1.1 拒绝信封的 `next_step`（沿用 2.0 `http-boundary.ts` 的意思）：Agent 不该换个入口再试。
pub const USER_NEXT_STEP: &str =
    "不要重试，也不要寻找其他入口：请用户在 ATM 桌面端按 where 完成这一步";

/// P-004：入口的第一步。拒绝码按 03 §5.2：Agent 碰 User 能力是 USER_AUTHORIZATION_REQUIRED，
/// 其余越权（Agent 碰 System 能力、User 碰 Agent 专属、Phone、System）是 PRINCIPAL_CAPABILITY_DENIED。
pub fn require(principal: &Principal, capability: Capability) -> Result<(), DomainError> {
    if capability.allows(principal) {
        return Ok(());
    }
    let kind = principal.kind();
    let error = if kind == PrincipalKind::Agent && capability.grant().user {
        let entry = capability.user_entry().unwrap_or("ATM 桌面端");
        DomainError::new(
            ErrorCode::USER_AUTHORIZATION_REQUIRED,
            format!(
                "「{}」只能由用户在 ATM 桌面端操作（{entry}）",
                capability.as_str()
            ),
        )
        .detail("where", entry)
        .detail("next_step", USER_NEXT_STEP)
    } else {
        DomainError::new(
            ErrorCode::PRINCIPAL_CAPABILITY_DENIED,
            format!("{} 没有能力 {}", kind.as_str(), capability.as_str()),
        )
    };
    let mut error = error
        .detail("principal", kind.as_str())
        .detail("capability", capability.as_str());
    if let Some(job) = principal.job() {
        error = error.detail("job", job.as_str());
    }
    Err(error)
}
