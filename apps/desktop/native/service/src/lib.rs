//! ATM 3 服务层（W2b 起）。每个服务入口都带一个 [`atm_domain::principal::Principal`]，
//! 第一步做能力检查，先于一切副作用（03 P-004）；写入经存储的写线程，一次服务调用就是一个写事务。

pub(crate) mod evidence;
pub mod fp;
pub mod lineage;
pub mod memory;
pub mod project;
pub(crate) mod quick;
pub mod read;
mod rebind;
pub mod receipts;
pub mod session;
pub mod work;
pub mod write;
