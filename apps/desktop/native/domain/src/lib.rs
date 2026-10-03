//! ATM 3 领域规则（W2a）。不依赖存储：服务读出事实，交给这里判定，再按结果写入。
//!
//! 权威规格在 `output/atm3-spec/`：01（工作项）、03（权限）、11（Agent 易用性），
//! 以及优先于它们的 00（裁决）与 10（W0 评审的解决方案）。
//!
//! - [`principal`] / [`capability`]：谁在调用、能做什么（03 §2、§3）。
//! - [`error`]：错误目录与统一错误信封（01 §7、11 §3）。
//! - [`work`]：状态机、自动补 start、版本要求（01 §2；10 R11 P1-1）。
//! - [`ownership`]：领取归属、租约、自动转移（10 R1、R2）。
//! - [`gate`]：完成门（01 §4；00 C-10、C-11）。
//! - [`progress`]：进度（01 §6；00 C-02、C-04、C-23、C-24）。
//! - [`evidence`]：证据与候选哈希的格式（01 W-010、W-011）。
//! - [`keys`] / [`time`] / [`text`]：公开 key、时间戳、与 JS 一致的字符串工具。

pub mod capability;
pub mod error;
pub mod evidence;
pub mod gate;
pub mod keys;
pub mod ownership;
pub mod principal;
pub mod progress;
pub mod text;
pub mod time;
pub mod work;
