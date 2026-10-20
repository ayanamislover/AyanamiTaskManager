//! 工作项状态机（01 §2；00 C-16、C-17；10 R11 P1-1）。
//!
//! 状态存成 `(phase, waiting_on)`，status 由两者推出（05 第 9 条：status 是生成列）。
//! 所以 W-002 列出的非法组合（`(WAITING_USER, BLOCKED, …)`、`(READY, IN_PROGRESS, …)` 等）
//! 在类型上就构造不出来：只有 phase 为 IN_PROGRESS / VERIFYING 时才能带 waiting_on。
//!
//! 本模块只做「不读数据库」的那一层（W-020 的 `resolve`、W-022 的 legal_operations、
//! 自动补 start、版本要求）。依赖、领取、原因、完成门这些前置条件在别的模块。

use serde::Serialize;
use std::fmt;

macro_rules! names {
    ($ty:ident { $($variant:ident => $name:literal),+ $(,)? }) => {
        impl $ty {
            pub const ALL: &'static [$ty] = &[$($ty::$variant),+];

            pub const fn as_str(self) -> &'static str {
                match self { $($ty::$variant => $name),+ }
            }

            /// 按规范写法解析；R11 P1-4 的「枚举不区分大小写」由入参层先转换。
            pub fn parse(text: &str) -> Option<Self> {
                match text { $($name => Some($ty::$variant),)+ _ => None }
            }
        }

        impl fmt::Display for $ty {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl Serialize for $ty {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str(self.as_str())
            }
        }
    };
}

/// 01 §2.1 的十种状态。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Status {
    Backlog,
    Ready,
    Claimed,
    InProgress,
    Blocked,
    WaitingAgent,
    WaitingUser,
    Verifying,
    Done,
    Cancelled,
}

names!(Status {
    Backlog => "BACKLOG",
    Ready => "READY",
    Claimed => "CLAIMED",
    InProgress => "IN_PROGRESS",
    Blocked => "BLOCKED",
    WaitingAgent => "WAITING_AGENT",
    WaitingUser => "WAITING_USER",
    Verifying => "VERIFYING",
    Done => "DONE",
    Cancelled => "CANCELLED",
});

impl Status {
    pub const fn is_terminal(self) -> bool {
        matches!(self, Status::Done | Status::Cancelled)
    }
}

/// 八种 phase：没有 WAITING_*，等待时记「等待之前在做什么」（W-002）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Phase {
    Backlog,
    Ready,
    Claimed,
    InProgress,
    Blocked,
    Verifying,
    Done,
    Cancelled,
}

names!(Phase {
    Backlog => "BACKLOG",
    Ready => "READY",
    Claimed => "CLAIMED",
    InProgress => "IN_PROGRESS",
    Blocked => "BLOCKED",
    Verifying => "VERIFYING",
    Done => "DONE",
    Cancelled => "CANCELLED",
});

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum WaitingOn {
    Agent,
    User,
}

names!(WaitingOn { Agent => "AGENT", User => "USER" });

/// 一个工作项的状态：`(phase, waiting_on)`，只有合法组合构造得出来。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct WorkState {
    phase: Phase,
    waiting_on: Option<WaitingOn>,
}

impl WorkState {
    /// W-002：等待只能挂在 IN_PROGRESS 或 VERIFYING 上。
    pub const fn new(phase: Phase, waiting_on: Option<WaitingOn>) -> Option<Self> {
        match (phase, waiting_on) {
            (_, None) | (Phase::InProgress | Phase::Verifying, Some(_)) => {
                Some(WorkState { phase, waiting_on })
            }
            _ => None,
        }
    }

    /// 不等待的状态。
    pub const fn plain(phase: Phase) -> Self {
        WorkState {
            phase,
            waiting_on: None,
        }
    }

    /// 由 status 推出状态；WAITING_* 需要知道 phase，所以这里取 IN_PROGRESS
    /// （与 2.x 读路径对空 phase 的兜底相同，WO:8–16）。
    pub const fn from_status(status: Status) -> Self {
        let (phase, waiting_on) = match status {
            Status::Backlog => (Phase::Backlog, None),
            Status::Ready => (Phase::Ready, None),
            Status::Claimed => (Phase::Claimed, None),
            Status::InProgress => (Phase::InProgress, None),
            Status::Blocked => (Phase::Blocked, None),
            Status::WaitingAgent => (Phase::InProgress, Some(WaitingOn::Agent)),
            Status::WaitingUser => (Phase::InProgress, Some(WaitingOn::User)),
            Status::Verifying => (Phase::Verifying, None),
            Status::Done => (Phase::Done, None),
            Status::Cancelled => (Phase::Cancelled, None),
        };
        WorkState { phase, waiting_on }
    }

    pub const fn phase(self) -> Phase {
        self.phase
    }

    pub const fn waiting_on(self) -> Option<WaitingOn> {
        self.waiting_on
    }

    pub const fn status(self) -> Status {
        match (self.waiting_on, self.phase) {
            (Some(WaitingOn::Agent), _) => Status::WaitingAgent,
            (Some(WaitingOn::User), _) => Status::WaitingUser,
            (None, Phase::Backlog) => Status::Backlog,
            (None, Phase::Ready) => Status::Ready,
            (None, Phase::Claimed) => Status::Claimed,
            (None, Phase::InProgress) => Status::InProgress,
            (None, Phase::Blocked) => Status::Blocked,
            (None, Phase::Verifying) => Status::Verifying,
            (None, Phase::Done) => Status::Done,
            (None, Phase::Cancelled) => Status::Cancelled,
        }
    }
}

/// 公开入口新建任务时允许的初始状态（00 C-17；R11 P1-5 默认 READY）。
/// quick 晋升和导入走服务内部操作，不经过这里。
pub fn public_create_state(requested: Option<Status>) -> Result<WorkState, Status> {
    match requested.unwrap_or(Status::Ready) {
        s @ (Status::Backlog | Status::Ready) => Ok(WorkState::from_status(s)),
        other => Err(other),
    }
}

/// 十二种基础操作，顺序就是操作表的顺序（W-022 的 legal_operations 按它排）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Operation {
    Claim,
    Start,
    Release,
    Ready,
    Block,
    WaitAgent,
    WaitUser,
    Verify,
    Complete,
    Cancel,
    Reopen,
    Edit,
}

names!(Operation {
    Claim => "claim",
    Start => "start",
    Release => "release",
    Ready => "ready",
    Block => "block",
    WaitAgent => "wait_agent",
    WaitUser => "wait_user",
    Verify => "verify",
    Complete => "complete",
    Cancel => "cancel",
    Reopen => "reopen",
    Edit => "edit",
});

const NON_TERMINAL: &[Status] = &[
    Status::Backlog,
    Status::Ready,
    Status::Claimed,
    Status::InProgress,
    Status::Blocked,
    Status::WaitingAgent,
    Status::WaitingUser,
    Status::Verifying,
];

impl Operation {
    /// 01 §2.2 矩阵里「不是 ✗」的起始状态（含 `=` 与 `门`）。
    ///
    /// 2.x 另有一张 homomorphicFrom 表，拒绝「目标等于当前、但当前不在同态表里」的情形。
    /// 在这张矩阵下这种情形不存在：release / complete / cancel 的目标都不在各自的起始集合里，
    /// reopen 的目标永远不等于当前。所以同态表与起始集合等价，这里不再重复一份
    /// （留着它只会多出一个删掉也不变红的条件）。
    pub fn allowed_from(self) -> &'static [Status] {
        use Status::*;
        match self {
            Operation::Claim => &[Backlog, Ready, Claimed, InProgress],
            Operation::Start => NON_TERMINAL,
            Operation::Release => &[
                Claimed,
                InProgress,
                Blocked,
                WaitingAgent,
                WaitingUser,
                Verifying,
            ],
            Operation::Ready => &[Backlog, Ready],
            Operation::Block => &[
                Claimed,
                InProgress,
                Blocked,
                WaitingAgent,
                WaitingUser,
                Verifying,
            ],
            Operation::WaitAgent => &[InProgress, Blocked, WaitingAgent, Verifying],
            Operation::WaitUser => &[InProgress, Blocked, WaitingUser, Verifying],
            Operation::Verify => &[InProgress, WaitingAgent, WaitingUser, Verifying],
            Operation::Complete => NON_TERMINAL,
            Operation::Cancel => NON_TERMINAL,
            Operation::Reopen => &[
                Blocked,
                WaitingAgent,
                WaitingUser,
                Verifying,
                Done,
                Cancelled,
            ],
            Operation::Edit => Status::ALL,
        }
    }

    /// 操作之后的状态（不检查是否允许）。
    pub fn target(self, from: WorkState) -> WorkState {
        let plain = WorkState::plain;
        match self {
            Operation::Claim => match from.status() {
                Status::InProgress => plain(Phase::InProgress),
                _ => plain(Phase::Claimed),
            },
            Operation::Start => plain(Phase::InProgress),
            Operation::Release | Operation::Ready => plain(Phase::Ready),
            Operation::Block => plain(Phase::Blocked),
            Operation::WaitAgent => wait_target(from, WaitingOn::Agent),
            Operation::WaitUser => wait_target(from, WaitingOn::User),
            Operation::Verify => plain(Phase::Verifying),
            Operation::Complete => plain(Phase::Done),
            Operation::Cancel => plain(Phase::Cancelled),
            // W-034：CANCELLED → BACKLOG；WAITING_* 回到等待之前的 phase；其余 → IN_PROGRESS。
            Operation::Reopen => match from.status() {
                Status::Cancelled => plain(Phase::Backlog),
                Status::WaitingAgent | Status::WaitingUser => plain(from.phase()),
                _ => plain(Phase::InProgress),
            },
            Operation::Edit => from,
        }
    }

    /// 00 C-07 / 10 R1：会修改已领取任务、因而要先过 `may_modify` 的操作。
    /// claim / start / release 自己就是领取规则，另有判定（ownership 模块）。
    /// reopen 不在 R1 的举例里，但它同样改动被领取的任务（BLOCKED / WAITING / VERIFYING 都可能有领取），
    /// 按 R1 的总原则「凡是会修改已被领取任务的操作」纳入。
    pub const fn guarded_by_claim(self) -> bool {
        !matches!(
            self,
            Operation::Claim | Operation::Start | Operation::Release
        )
    }
}

/// W-031：从 BLOCKED 进入等待时 phase 改为 IN_PROGRESS；同类同态保持 phase。
fn wait_target(from: WorkState, on: WaitingOn) -> WorkState {
    let phase = match from.phase() {
        Phase::Verifying => Phase::Verifying,
        _ => Phase::InProgress,
    };
    WorkState {
        phase,
        waiting_on: Some(on),
    }
}

/// 状态机拒绝（INVALID_TRANSITION，W-020）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InvalidTransition {
    pub operation: Operation,
    pub current: Status,
    pub requested: Status,
    pub legal_operations: Vec<Operation>,
}

/// W-020 + W-026：解析一次操作。`successor_reclaim` 只对 IN_PROGRESS 上的 claim 有意义
/// （ownership 模块的 `is_successor_reclaim` 给出）。
pub fn resolve(
    op: Operation,
    from: WorkState,
    successor_reclaim: bool,
) -> Result<WorkState, InvalidTransition> {
    let status = from.status();
    let target = op.target(from);
    let allowed = op.allowed_from().contains(&status)
        && !(op == Operation::Claim && status == Status::InProgress && !successor_reclaim);
    if allowed {
        Ok(target)
    } else {
        Err(InvalidTransition {
            operation: op,
            current: status,
            requested: target.status(),
            legal_operations: legal_operations(from)
                .into_iter()
                .map(|(op, _)| op)
                .collect(),
        })
    }
}

/// W-022：给定状态下状态机放行的操作及目标，按操作表顺序。
/// 不看依赖、领取、完成门；IN_PROGRESS 上的 claim 不列（它只在 successor reclaim 时成立）。
pub fn legal_operations(from: WorkState) -> Vec<(Operation, Status)> {
    let status = from.status();
    Operation::ALL
        .iter()
        .copied()
        .filter(|&op| !(op == Operation::Claim && status == Status::InProgress))
        .filter(|op| op.allowed_from().contains(&status))
        .map(|op| (op, op.target(from).status()))
        .collect()
}

/// R11 P1-1 自动补 start 的适用面：这些写入遇到 BACKLOG / READY / CLAIMED 时，
/// 在同一事务里先 start（调用方能领取时）。BLOCKED / WAITING_* **不**补：start 会解除
/// ACTIVE blocker，而 blocker 可能是真的拦截条件；那时错误里的 fix 就是那条 start。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StateWrite {
    Basic(Operation),
    VerifyAndComplete,
    /// 不带 blocker 的任务进度（U-1）：记进度就是在做这件事。和状态写入不同，补不上
    /// （前置没完成、领不到）时不报错，进度照记、不开工。
    Progress,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AutoStart {
    /// 先 start，再执行本操作。
    Apply,
    /// 不补；需要开工时请调用方显式 start（fix.call）。
    SuggestStart,
    /// 与自动 start 无关。
    NotApplicable,
}

pub fn auto_start(write: StateWrite, current: Status) -> AutoStart {
    let op = match write {
        StateWrite::Basic(
            op @ (Operation::Complete
            | Operation::Verify
            | Operation::WaitAgent
            | Operation::WaitUser
            | Operation::Block),
        ) => op,
        StateWrite::Basic(_) => return AutoStart::NotApplicable,
        // verify_and_complete 的第一步就是 verify（W-052）。
        StateWrite::VerifyAndComplete => Operation::Verify,
        // 进度在任何未终结状态上都能记，BLOCKED / WAITING_* 上不需要提示。
        StateWrite::Progress => {
            return match current {
                Status::Backlog | Status::Ready | Status::Claimed => AutoStart::Apply,
                _ => AutoStart::NotApplicable,
            };
        }
    };
    match current {
        Status::Backlog | Status::Ready | Status::Claimed => AutoStart::Apply,
        Status::Blocked | Status::WaitingAgent | Status::WaitingUser => {
            // 状态机本来就放行的（block 在 BLOCKED 上同态、wait 从 BLOCKED 重新归类、
            // verify 从 WAITING_* 进入验收）不需要提示；单独的 complete 在这三种状态上
            // 必然撞完成门的 current_state 谓词，所以总是提示 start。
            let refused = write == StateWrite::Basic(Operation::Complete)
                || resolve(op, WorkState::from_status(current), false).is_err();
            if refused {
                AutoStart::SuggestStart
            } else {
                AutoStart::NotApplicable
            }
        }
        _ => AutoStart::NotApplicable,
    }
}

/// 版本入参的要求（R11 P1-1 第 2 条）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VersionNeed {
    Required,
    Optional,
}

/// 需要版本号的写入种类：基础操作，加上五种复合操作。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PatchKind {
    Basic(Operation),
    VerifyAndComplete,
    ChecklistSingle,
    ChecklistBatch,
    ReviewRequest,
    ReviewSubmit,
}

/// R11 P1-1：
/// - edit、cancel、reopen（内容编辑类）永远要版本；review 两种复合操作绑定版本本身就是语义，也要；
/// - 其余写入在**本 lineage 持有领取**（含这次 claim / start / 自动 start 刚拿到领取）时可省略，
///   以执行那一刻的状态为准，由状态机、完成门和 R1 的领取归属把关；
/// - 非 owner 的写入（包括 User、release 别人的过期领取）都要版本。
pub fn version_need(kind: PatchKind, holds_claim: bool) -> VersionNeed {
    match kind {
        PatchKind::Basic(Operation::Edit | Operation::Cancel | Operation::Reopen)
        | PatchKind::ReviewRequest
        | PatchKind::ReviewSubmit => VersionNeed::Required,
        _ if holds_claim => VersionNeed::Optional,
        _ => VersionNeed::Required,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_round_trip_through_phase_and_waiting() {
        for &s in Status::ALL {
            assert_eq!(WorkState::from_status(s).status(), s);
        }
        assert!(WorkState::new(Phase::Blocked, Some(WaitingOn::User)).is_none());
        assert!(WorkState::new(Phase::Ready, Some(WaitingOn::Agent)).is_none());
        assert!(WorkState::new(Phase::Verifying, Some(WaitingOn::User)).is_some());
    }
}
