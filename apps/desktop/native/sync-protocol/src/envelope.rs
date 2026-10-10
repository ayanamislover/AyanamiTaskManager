//! 信封与分片（`envelope.ts`）。
//!
//! 一个对象加密后按 base64url 每 160000 字符切一片，最多 64 片。第 0 片写在逻辑键本身，是**提交点**：写入时
//! 必须最后写它；其余写在 `<逻辑键>.<i>`。每片带密文 sha256 的前 16 位 hex（`d`），读的时候摘要对不上说明写的
//! 一方正在更新（OBJECT_INCOMPLETE，稍后再读）；各片都对得上、拼起来却不符，是篡改或损坏（DECRYPT_FAILED）。

use serde_json::{Value, json};

use crate::Result;
use crate::crypto::{
    IV_BYTES, SealedBytes, SpaceKeys, open_bytes, seal_bytes, seal_bytes_with_iv, sha256_hex,
};
use crate::encoding::{from_base64url, from_utf8_js, js_len, to_base64url};
use crate::error::{SyncError, SyncErrorCode as C};
use crate::keys::part_key;
use crate::schema::{Fields, int_in, is_lower_hex};

pub const PART_CHARS: usize = 160_000;
pub const MAX_PARTS: usize = 64;

/// 第 0 片（`HeadEnvelopeSchema`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeadEnvelope {
    pub kid: String,
    pub iv: String,
    pub compressed: bool,
    pub parts: usize,
    pub digest: String,
    pub chunk: String,
}

impl HeadEnvelope {
    pub fn to_json(&self) -> Value {
        json!({
            "v": 1,
            "kid": self.kid,
            "iv": self.iv,
            "z": u8::from(self.compressed),
            "n": self.parts,
            "d": self.digest,
            "c": self.chunk,
        })
    }
}

/// 第 1..n 片（`PartEnvelopeSchema`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartEnvelope {
    pub digest: String,
    pub index: usize,
    pub chunk: String,
}

/// 要写到中继的一片：`key` 是文档键，`data` 是文档内容。
#[derive(Debug, Clone, PartialEq)]
pub struct SealedPart {
    pub key: String,
    pub data: Value,
}

/// `sealObject`：返回的第 0 项是提交点，必须**最后**写。
pub fn seal_object(keys: &SpaceKeys, logical_key: &str, value: &Value) -> Result<Vec<SealedPart>> {
    let sealed = seal_bytes(keys, logical_key, &plaintext(value)?)?;
    split(keys, logical_key, sealed)
}

/// 指定 IV 的 [`seal_object`]：只给向量与测试用。
pub fn seal_object_with_iv(
    keys: &SpaceKeys,
    logical_key: &str,
    value: &Value,
    iv: [u8; IV_BYTES],
) -> Result<Vec<SealedPart>> {
    let sealed = seal_bytes_with_iv(keys, logical_key, &plaintext(value)?, iv)?;
    split(keys, logical_key, sealed)
}

/// `JSON.stringify(value)` 的 UTF-8。serde_json 的紧凑写法与它相同；数字由调用方保证按 JS 的写法给（整数用整数）。
fn plaintext(value: &Value) -> Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(|_| SyncError::with(C::SchemaInvalid, "明文"))
}

fn split(keys: &SpaceKeys, logical_key: &str, sealed: SealedBytes) -> Result<Vec<SealedPart>> {
    let text = to_base64url(&sealed.ciphertext);
    let digest = sha256_hex(&sealed.ciphertext)[..16].to_owned();
    // base64url 全是 ASCII，按字节切等于按 UTF-16 码元切。
    let count = text.len().div_ceil(PART_CHARS).max(1);
    if count > MAX_PARTS {
        return Err(SyncError::new(C::ObjectTooLarge));
    }
    let slice = |i: usize| {
        text[(i * PART_CHARS).min(text.len())..((i + 1) * PART_CHARS).min(text.len())].to_owned()
    };
    let head = HeadEnvelope {
        kid: keys.kid.clone(),
        iv: to_base64url(&sealed.iv),
        compressed: sealed.compressed,
        parts: count,
        digest: digest.clone(),
        chunk: slice(0),
    };
    let mut out = vec![SealedPart {
        key: logical_key.to_owned(),
        data: head.to_json(),
    }];
    for i in 1..count {
        out.push(SealedPart {
            key: part_key(logical_key, i)?,
            data: json!({ "v": 1, "d": digest, "i": i, "c": slice(i) }),
        });
    }
    Ok(out)
}

/// `parseHeadEnvelope`：结构不对是 SCHEMA_INVALID「信封」。多出的字段忽略。
pub fn parse_head_envelope(data: &Value) -> Result<HeadEnvelope> {
    head(data).ok_or_else(|| SyncError::with(C::SchemaInvalid, "信封"))
}

fn head(data: &Value) -> Option<HeadEnvelope> {
    let f = Fields::of(data)?;
    f.literal_one("v")?;
    let kid = f.str("kid")?;
    let iv = f.str("iv")?;
    let digest = f.str("d")?;
    let chunk = f.str("c")?;
    let z = int_in(f.get("z")?, 0, 1)?;
    let parts = int_in(f.get("n")?, 1, MAX_PARTS as i64)?;
    (kid.len() == 8
        && is_lower_hex(kid)
        && js_len(iv) == 16
        && digest.len() == 16
        && is_lower_hex(digest)
        && js_len(chunk) <= PART_CHARS)
        .then(|| HeadEnvelope {
            kid: kid.to_owned(),
            iv: iv.to_owned(),
            compressed: z == 1,
            parts: parts as usize,
            digest: digest.to_owned(),
            chunk: chunk.to_owned(),
        })
}

/// `parsePartEnvelope`：结构不对是 SCHEMA_INVALID「分片」。
pub fn parse_part_envelope(data: &Value) -> Result<PartEnvelope> {
    part(data).ok_or_else(|| SyncError::with(C::SchemaInvalid, "分片"))
}

fn part(data: &Value) -> Option<PartEnvelope> {
    let f = Fields::of(data)?;
    f.literal_one("v")?;
    let digest = f.str("d")?;
    let chunk = f.str("c")?;
    let index = int_in(f.get("i")?, 1, MAX_PARTS as i64 - 1)?;
    (digest.len() == 16 && is_lower_hex(digest) && js_len(chunk) <= PART_CHARS).then(|| {
        PartEnvelope {
            digest: digest.to_owned(),
            index: index as usize,
            chunk: chunk.to_owned(),
        }
    })
}

/// `openObject`：按第 0 片的声明读其余各片（`read_part` 返回 `None` 表示没有这片）再解密，得到明文 JSON。
pub fn open_object(
    keys: &SpaceKeys,
    logical_key: &str,
    head: &HeadEnvelope,
    mut read_part: impl FnMut(&str) -> Result<Option<Value>>,
) -> Result<Value> {
    if head.kid != keys.kid {
        return Err(SyncError::new(C::KeyMismatch));
    }
    let mut text = head.chunk.clone();
    for index in 1..head.parts {
        let Some(raw) = read_part(&part_key(logical_key, index)?)? else {
            return Err(SyncError::new(C::ObjectIncomplete));
        };
        let p = parse_part_envelope(&raw)?;
        if p.digest != head.digest || p.index != index {
            return Err(SyncError::new(C::ObjectIncomplete));
        }
        text.push_str(&p.chunk);
    }
    let (Some(ciphertext), Some(iv)) = (from_base64url(&text), from_base64url(&head.iv)) else {
        return Err(SyncError::with(C::DecryptFailed, "编码"));
    };
    if sha256_hex(&ciphertext)[..16] != head.digest {
        return Err(SyncError::with(C::DecryptFailed, "摘要不符"));
    }
    let plain = open_bytes(
        keys,
        logical_key,
        &SealedBytes {
            iv,
            ciphertext,
            compressed: head.compressed,
        },
    )?;
    from_utf8_js(&plain)
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .ok_or_else(|| SyncError::with(C::SchemaInvalid, "明文不是 JSON"))
}

/// 测试与向量用：把一组 [`SealedPart`] 当作中继上的文档读回来。
pub fn reader(parts: &[SealedPart]) -> impl FnMut(&str) -> Result<Option<Value>> + '_ {
    move |key| Ok(parts.iter().find(|p| p.key == key).map(|p| p.data.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::MAX_PLAINTEXT_BYTES;

    fn keys() -> SpaceKeys {
        SpaceKeys::derive(&to_base64url(&[7u8; 32])).unwrap()
    }

    /// 不可压缩的明文：逐段 sha256 的十六进制再 base64url，压缩后与原文差不多长。
    fn incompressible(n: usize) -> String {
        use sha2::{Digest, Sha256};
        let mut bytes = Vec::with_capacity(n);
        let mut i = 0u64;
        while bytes.len() < n {
            bytes.extend_from_slice(&Sha256::digest(i.to_le_bytes()));
            i += 1;
        }
        to_base64url(&bytes)[..n].to_owned()
    }

    #[test]
    fn random_ivs_round_trip_and_differ() {
        let k = keys();
        let value = json!({ "v": 1, "text": "ATM ".repeat(1000) });
        let a = seal_object(&k, "atm1/x", &value).unwrap();
        let b = seal_object(&k, "atm1/x", &value).unwrap();
        assert_ne!(a[0].data["iv"], b[0].data["iv"]);
        let head = parse_head_envelope(&a[0].data).unwrap();
        assert_eq!(open_object(&k, "atm1/x", &head, reader(&a)).unwrap(), value);
    }

    #[test]
    fn more_than_64_parts_is_too_large() {
        let k = keys();
        // 上限是 64 × 160000 = 10.24M 字符。base64url 明文压到约 0.76 倍，再 base64 回来约 1.01 倍：11M 切出约 70 片。
        let big = json!({ "blob": incompressible(11_000_000) });
        let e = seal_object(&k, "atm1/x", &big).unwrap_err();
        assert_eq!(e.code, crate::SyncErrorCode::ObjectTooLarge);
        // 差一点到上限的照样切开，第 0 片在最前。
        let fits = json!({ "blob": incompressible(9_000_000) });
        let parts = seal_object(&k, "atm1/x", &fits).unwrap();
        assert!((40..=MAX_PARTS).contains(&parts.len()), "{}", parts.len());
        assert_eq!(parts[0].key, "atm1/x");
        assert_eq!(parts[1].key, "atm1/x.1");
        let head = parse_head_envelope(&parts[0].data).unwrap();
        assert_eq!(head.parts, parts.len());
        assert_eq!(
            open_object(&k, "atm1/x", &head, reader(&parts)).unwrap(),
            fits
        );
    }

    #[test]
    fn plaintext_over_the_limit_is_too_large_before_sealing() {
        let k = keys();
        let big = Value::from("a".repeat(MAX_PLAINTEXT_BYTES));
        let e = seal_object(&k, "atm1/x", &big).unwrap_err();
        assert_eq!(e.code, crate::SyncErrorCode::ObjectTooLarge);
    }
}
