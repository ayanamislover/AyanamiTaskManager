//! 手机同步的线格式（W7a；06 §2 #88–96 的底层；docs/mobile-sync.md）：空间密钥、加密信封与分片、文档键、
//! 配对码与明文结构。手机 App 仍用 TS 的 `packages/sync-protocol`，协议不改，所以这里与它逐字节兼容：
//! 同样的输入得到同样的密钥、哈希、键与信封，对方写的东西两边都打得开，拒绝的理由（错误码）也一样。
//! 兼容性靠 `tests/data/sync-vectors.json`（TS 生成，Rust 核对）与 `tests/data/rust-sealed.json`
//! （Rust 生成，TS 核对）两个方向的向量守着。
//!
//! 照 TS 原样保留的细节（改了就和手机对不上）：
//! - 字符串长度按 UTF-16 码元数（JS 的 `length`），不是字节、也不是字符；
//! - `title` 先按 JS 的 `trim` 去空白再判长度，结果是去过空白的；
//! - 明文结构里不认识的字段丢掉（向前兼容），只有撤销标记是严格的；
//! - JSON 里的 `1.0` 就是整数 1；
//! - 明文按 UTF-8 严格解码，开头的 BOM 去掉（`TextDecoder` 的默认行为）。
//!
//! 本 crate 不做网络、不碰磁盘、不持有令牌：中继客户端与连接器在 W7c。

pub mod crypto;
pub mod encoding;
pub mod envelope;
pub mod error;
pub mod keys;
pub mod pairing;
pub mod schema;

pub use crypto::SpaceKeys;
pub use envelope::{HeadEnvelope, SealedPart, open_object, parse_head_envelope, seal_object};
pub use error::{SyncError, SyncErrorCode};

pub type Result<T> = std::result::Result<T, SyncError>;
