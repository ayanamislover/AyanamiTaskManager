//! 桌面端的手机同步（W7b 起；06 §2 #88–96；docs/mobile-sync.md）。线格式在 `atm-sync-protocol`，这里是
//! 桌面一侧要落盘、要联网的部分：
//!
//! - [`dpapi`]：Windows DPAPI（当前用户、绑定 [`dpapi::ENTROPY`]），进程内调用。2.x 经宿主的 `--dpapi`
//!   一次性模式调同一个接口，所以 2.x 加密的密文这里打得开，反过来也一样；
//! - [`secrets`]：中继 token 与空间密钥的存储 `<数据目录>/sync/secrets.dpapi.json`，文件格式与 2.x 的
//!   `apps/desktop/src/dpapi-secret-store.ts` 逐字节相同（`tests/data/secret-vectors.json` 守着），以及连接器
//!   持有密钥的 [`secrets::SecretVault`]。
//!
//! 2.x 的独立 daemon 用过明文 `sync/secrets.json`（开发 / e2e）；3.0 只有桌面宿主一种形态，Windows 上
//! 总有 DPAPI，所以不再有明文存储。DPAPI 不可用时拒绝保存，绝不退回明文。

pub mod dpapi;
pub mod secrets;
