//! 连接器对派单的全部需求（2.x `packages/sync/src/dispatch-port.ts`）。派单本身在 W7d；没有派单时传 `None`，
//! 手机勾「交给 Claude」会得到 `dispatchError`。

use atm_domain::principal::Principal;

use crate::errors::Failure;

/// 任务卡片上的派单状态；`at` 取最近一次状态变化的时间；`error` 是派单记下的失败原因（原文，发布时只给
/// failed 带上并截断）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchRun {
    pub run: String,
    pub state: String,
    pub at: String,
    pub error: Option<String>,
}

/// head 里的派单摘要。`mode` 不在协议的取值里时按 `auto`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchSummary {
    pub enabled: bool,
    pub mode: String,
    pub running: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnqueueInput {
    pub project: String,
    pub key: String,
    pub requested_by: Option<String>,
    /// 手机命令 ID：派单层按它持久幂等，同一个 ID 再来只返回那次派单（或那次的拒绝），不再起会话。
    pub request_id: Option<String>,
}

pub trait DispatchPort: Send + Sync {
    fn summary(&self) -> DispatchSummary;
    fn run_for_task(&self, project: &str, key: &str) -> Option<DispatchRun>;
    /// 被拒时是 [`Failure::Dispatch`]（码是 SCREAMING_SNAKE，说明是中文）；派单器已随宿主退出关闭时码是
    /// `DISPATCH_CLOSED`：命令不写失败回执，留到下次启动再处理。`principal` 是手机（Phone）。
    fn enqueue(&self, principal: &Principal, input: EnqueueInput) -> Result<DispatchRun, Failure>;
}
