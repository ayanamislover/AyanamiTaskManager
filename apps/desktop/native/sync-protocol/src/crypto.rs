//! 空间密钥与对象加密（`crypto.ts`）。
//!
//! - 空间密钥：32 字节，base64url；HKDF-SHA256（salt `atm-sync/v1`）派生两把 32 字节的钥：`aead`（AES-256-GCM）
//!   与 `names`（HMAC-SHA256，给 kid 与项目哈希用）。kid = HMAC(names, "kid") 的前 8 位 hex。
//! - 加密：明文超过 1 KiB 先 raw deflate（level 6），AES-256-GCM，12 字节 IV，AAD 是逻辑键的 UTF-8。
//! - 解密：解压后的长度上限 16 MiB（不信对方声明的大小，边解边数）。

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

use crate::Result;
use crate::encoding::{from_base64url, random_bytes, to_hex};
use crate::error::{SyncError, SyncErrorCode as C};

pub const SPACE_SECRET_BYTES: usize = 32;
pub const MAX_PLAINTEXT_BYTES: usize = 16 * 1024 * 1024;
pub const COMPRESS_THRESHOLD_BYTES: usize = 1024;
pub const IV_BYTES: usize = 12;

const HKDF_SALT: &[u8] = b"atm-sync/v1";
/// fflate `deflateSync(…, { level: 6 })`。字节不必与 fflate 相同，对方解得开即可。
const DEFLATE_LEVEL: u8 = 6;

/// 一个配对空间的钥。`Debug` 不打印钥本身。
#[derive(Clone)]
pub struct SpaceKeys {
    /// 识别配错密钥用的 8 位 hex，不是秘密。
    pub kid: String,
    aead: [u8; 32],
    names: [u8; 32],
}

impl std::fmt::Debug for SpaceKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SpaceKeys")
            .field("kid", &self.kid)
            .finish_non_exhaustive()
    }
}

/// `decodeSpaceSecret`：base64url 的 32 字节。
pub fn decode_space_secret(secret: &str) -> Result<[u8; SPACE_SECRET_BYTES]> {
    let bytes = from_base64url(secret)
        .ok_or_else(|| SyncError::with(C::PairingCodeInvalid, "空间密钥不是 base64url"))?;
    bytes
        .try_into()
        .map_err(|_| SyncError::with(C::PairingCodeInvalid, "空间密钥长度不对"))
}

impl SpaceKeys {
    /// `deriveSpaceKeys`。
    pub fn derive(secret: &str) -> Result<SpaceKeys> {
        let raw = decode_space_secret(secret)?;
        let hk = hkdf::Hkdf::<Sha256>::new(Some(HKDF_SALT), &raw);
        let mut aead = [0u8; 32];
        let mut names = [0u8; 32];
        // 32 字节远小于 HKDF-SHA256 的输出上限（255 × 32），不会失败。
        let _ = hk.expand(b"aead", &mut aead);
        let _ = hk.expand(b"names", &mut names);
        let mut keys = SpaceKeys {
            kid: String::new(),
            aead,
            names,
        };
        keys.kid = keys.hmac_hex("kid")[..8].to_owned();
        Ok(keys)
    }

    /// HMAC-SHA256(names, message) 的 hex。
    pub fn hmac_hex(&self, message: &str) -> String {
        // HMAC 接受任意长度的钥，不会失败。
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&self.names)
            .unwrap_or_else(|_| unreachable!("HMAC takes any key length"));
        mac.update(message.as_bytes());
        to_hex(&mac.finalize().into_bytes())
    }

    /// `projectHash`：项目码经 HMAC 才进文档键，中继看不到项目名。
    pub fn project_hash(&self, project_code: &str) -> String {
        self.hmac_hex(&format!("project:{project_code}"))[..20].to_owned()
    }

    fn cipher(&self) -> Aes256Gcm {
        Aes256Gcm::new(&self.aead.into())
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    to_hex(&Sha256::digest(bytes))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedBytes {
    pub iv: Vec<u8>,
    pub ciphertext: Vec<u8>,
    pub compressed: bool,
}

/// `sealBytes`，IV 取系统随机数。
pub fn seal_bytes(keys: &SpaceKeys, aad: &str, plaintext: &[u8]) -> Result<SealedBytes> {
    let iv = random_bytes::<IV_BYTES>()
        .ok_or_else(|| SyncError::with(C::DecryptFailed, "系统随机数不可用"))?;
    seal_bytes_with_iv(keys, aad, plaintext, iv)
}

/// 指定 IV 的 `sealBytes`：只给向量与测试用，同一把钥绝不能重复用 IV。
pub fn seal_bytes_with_iv(
    keys: &SpaceKeys,
    aad: &str,
    plaintext: &[u8],
    iv: [u8; IV_BYTES],
) -> Result<SealedBytes> {
    if plaintext.len() > MAX_PLAINTEXT_BYTES {
        return Err(SyncError::new(C::ObjectTooLarge));
    }
    let compressed = plaintext.len() > COMPRESS_THRESHOLD_BYTES;
    let body = if compressed {
        miniz_oxide::deflate::compress_to_vec(plaintext, DEFLATE_LEVEL)
    } else {
        plaintext.to_vec()
    };
    let ciphertext = keys
        .cipher()
        .encrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: &body,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| SyncError::new(C::DecryptFailed))?;
    Ok(SealedBytes {
        iv: iv.to_vec(),
        ciphertext,
        compressed,
    })
}

/// `openBytes`。
pub fn open_bytes(keys: &SpaceKeys, aad: &str, sealed: &SealedBytes) -> Result<Vec<u8>> {
    if sealed.iv.len() != IV_BYTES {
        return Err(SyncError::with(C::DecryptFailed, "iv"));
    }
    let body = keys
        .cipher()
        .decrypt(
            Nonce::from_slice(&sealed.iv),
            Payload {
                msg: &sealed.ciphertext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| SyncError::new(C::DecryptFailed))?;
    if sealed.compressed {
        inflate_limited(&body, MAX_PLAINTEXT_BYTES)
    } else {
        Ok(body)
    }
}

/// `inflateLimited`：raw deflate，解出来超过上限就停（OBJECT_TOO_LARGE），其他任何坏流（截断、没有结束块、
/// 坏码）都是 DECRYPT_FAILED「解压失败」。照 fflate 实测：空输入解出空内容，结束块之后多出的字节不管。
/// TS 里还有一句「压缩流不完整」，但 fflate 在 `final` 推入时对没结束的流一律抛错，那句走不到，这里也不用。
pub fn inflate_limited(data: &[u8], limit: usize) -> Result<Vec<u8>> {
    use miniz_oxide::inflate::{TINFLStatus, decompress_to_vec_with_limit};
    if data.is_empty() {
        return Ok(Vec::new());
    }
    decompress_to_vec_with_limit(data, limit).map_err(|e| match e.status {
        TINFLStatus::HasMoreOutput => SyncError::new(C::ObjectTooLarge),
        _ => SyncError::with(C::DecryptFailed, "解压失败"),
    })
}
