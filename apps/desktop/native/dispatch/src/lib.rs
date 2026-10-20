//! Claude Code 无头派单（W7d；docs/mobile-sync.md §8、ADR-017；2.x `packages/agent-dispatch`）。
//! 只处理用户点名的任务；默认关闭；只有 User 与 Phone 能起会话（P-017）。
//!
//! - [`dispatcher`]：排队、限并发、起进程、落日志、记历史、取消、宿主重启后接管；
//! - [`ledger`]：手机派单的请求账本（同一个命令 ID 只起一次会话）；[`record`]：派单历史的一条；
//! - [`launch`]：claude 的参数、命令行与子进程环境；[`prompt`]：提示词；[`outcome`]：按日志定结局；
//! - [`process`]：拉起、出生标识、结束进程树（直接调 Windows）；[`probe`]：claude 的版本与登录探测；
//! - [`port`]：接到手机同步连接器上；[`mobile`]：宿主里两个手机功能的起停与状态槽。
//!
//! 状态在库里（`atm_service::dispatch_state`），日志在 `<数据根>\dispatch\logs`。

pub mod config;
pub mod dispatcher;
pub mod errors;
pub mod launch;
pub mod ledger;
pub mod mobile;
pub mod outcome;
pub mod port;
pub mod probe;
pub mod process;
pub mod prompt;
pub mod record;

pub use dispatcher::{Dispatcher, Enqueue, Options};
