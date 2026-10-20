//! 中继上的文档键（`keys.ts`）：`atm1/<空间>/head|revoked|p/<项目哈希>|cmd/<命令>|ack/<命令>|dev/<设备>`，
//! 分片是 `<逻辑键>.<1..999>`。各个 ID 的格式与 TS 的正则逐条对应（手写，不引正则库）。

use crate::Result;
use crate::encoding::{random_bytes, to_hex};
use crate::error::{SyncError, SyncErrorCode as C};

pub const KEY_PREFIX: &str = "atm1";

fn all(s: &str, ok: impl Fn(u8) -> bool) -> bool {
    s.bytes().all(ok)
}

fn lower_hex(b: u8) -> bool {
    b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
}

/// `DOC_KEY_PATTERN`：`^[A-Za-z0-9_./-]{1,200}$`。
pub fn is_doc_key(s: &str) -> bool {
    (1..=200).contains(&s.len()) && all(s, |b| b.is_ascii_alphanumeric() || b"_./-".contains(&b))
}

/// `APP_ID_PATTERN`：`^[a-z0-9][a-z0-9_-]{1,31}$`。
pub fn is_app_id(s: &str) -> bool {
    let body = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    (2..=32).contains(&s.len())
        && body(s.as_bytes()[0])
        && all(&s[1..], |b| body(b) || b == b'_' || b == b'-')
}

/// `SPACE_ID_PATTERN`：24 位小写 hex。
pub fn is_space_id(s: &str) -> bool {
    s.len() == 24 && all(s, lower_hex)
}

/// `DEVICE_ID_PATTERN`：`^(pc|m)-[0-9a-f]{12}$`。
pub fn is_device_id(s: &str) -> bool {
    let rest = s.strip_prefix("pc-").or_else(|| s.strip_prefix("m-"));
    rest.is_some_and(|r| r.len() == 12 && all(r, lower_hex))
}

/// `COMMAND_ID_PATTERN`：`^(pc|m)-[0-9a-f]{12}\.[0-9a-z]{13}[0-9a-f]{8}$`。
pub fn is_command_id(s: &str) -> bool {
    let Some((device, tail)) = s.split_once('.') else {
        return false;
    };
    is_device_id(device)
        && tail.len() == 21
        && tail.is_ascii()
        && all(&tail[..13], |b| {
            b.is_ascii_digit() || b.is_ascii_lowercase()
        })
        && all(&tail[13..], lower_hex)
}

/// `PROJECT_HASH_PATTERN`：20 位小写 hex。
pub fn is_project_hash(s: &str) -> bool {
    s.len() == 20 && all(s, lower_hex)
}

/// `PROJECT_CODE_PATTERN`：`^[A-Z][A-Z0-9_-]{0,31}$`。
pub fn is_project_code(s: &str) -> bool {
    (1..=32).contains(&s.len())
        && s.as_bytes()[0].is_ascii_uppercase()
        && all(s, |b| {
            b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_' || b == b'-'
        })
}

/// `TASK_KEY_PATTERN`：`^[A-Z][A-Z0-9_-]{0,31}-T-\d{4,}$`。后缀只有数字，所以只可能在最后一个 `-T-` 处切开。
pub fn is_task_key(s: &str) -> bool {
    s.rfind("-T-").is_some_and(|i| {
        let digits = &s[i + 3..];
        digits.len() >= 4 && all(digits, |b| b.is_ascii_digit()) && is_project_code(&s[..i])
    })
}

fn space(space_id: &str) -> Result<String> {
    if !is_space_id(space_id) {
        return Err(SyncError::with(C::KeyInvalid, "spaceId"));
    }
    Ok(format!("{KEY_PREFIX}/{space_id}"))
}

pub fn space_prefix(space_id: &str) -> Result<String> {
    Ok(format!("{}/", space(space_id)?))
}

pub fn head_key(space_id: &str) -> Result<String> {
    Ok(format!("{}/head", space(space_id)?))
}

/// 电脑「重置配对」后留在旧空间里的撤销标记（用旧密钥加密）。
pub fn revoked_key(space_id: &str) -> Result<String> {
    Ok(format!("{}/revoked", space(space_id)?))
}

pub fn project_key(space_id: &str, hash: &str) -> Result<String> {
    if !is_project_hash(hash) {
        return Err(SyncError::with(C::KeyInvalid, "projectHash"));
    }
    Ok(format!("{}/p/{hash}", space(space_id)?))
}

pub fn command_key(space_id: &str, command_id: &str) -> Result<String> {
    if !is_command_id(command_id) {
        return Err(SyncError::with(C::KeyInvalid, "commandId"));
    }
    Ok(format!("{}/cmd/{command_id}", space(space_id)?))
}

pub fn ack_key(space_id: &str, command_id: &str) -> Result<String> {
    if !is_command_id(command_id) {
        return Err(SyncError::with(C::KeyInvalid, "commandId"));
    }
    Ok(format!("{}/ack/{command_id}", space(space_id)?))
}

pub fn device_key(space_id: &str, device_id: &str) -> Result<String> {
    if !is_device_id(device_id) {
        return Err(SyncError::with(C::KeyInvalid, "deviceId"));
    }
    Ok(format!("{}/dev/{device_id}", space(space_id)?))
}

pub fn part_key(logical_key: &str, index: usize) -> Result<String> {
    if !(1..=999).contains(&index) {
        return Err(SyncError::with(C::KeyInvalid, "part"));
    }
    Ok(format!("{logical_key}.{index}"))
}

/// 新空间 ID：12 字节随机数的 hex。
pub fn new_space_id() -> Option<String> {
    random_bytes::<12>().map(|b| to_hex(&b))
}

/// `newDeviceId`：`pc-` 或 `m-` 加 6 字节随机数的 hex。
pub fn new_device_id(phone: bool) -> Option<String> {
    let kind = if phone { "m" } else { "pc" };
    random_bytes::<6>().map(|b| format!("{kind}-{}", to_hex(&b)))
}

/// `newCommandId`：`<设备>.<毫秒的 36 进制，补到 13 位><4 字节随机数的 hex>`。
pub fn new_command_id(device_id: &str, now_ms: u64) -> Result<String> {
    let rand = random_bytes::<4>().ok_or_else(|| SyncError::with(C::KeyInvalid, "random"))?;
    command_id(device_id, now_ms, rand)
}

/// 给定随机后缀的 [`new_command_id`]（向量用）。
pub fn command_id(device_id: &str, now_ms: u64, suffix: [u8; 4]) -> Result<String> {
    if !is_device_id(device_id) {
        return Err(SyncError::with(C::KeyInvalid, device_id));
    }
    Ok(format!(
        "{device_id}.{:0>13}{}",
        base36(now_ms),
        to_hex(&suffix)
    ))
}

fn base36(mut n: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// 键的种类（`classifyKey` 的结果）。`part` 为 0 表示逻辑键本身（第 0 片）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyKind {
    Head,
    Revoked,
    Project(String),
    Command(String),
    Ack(String),
    Device(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassifiedKey {
    pub kind: KeyKind,
    pub logical_key: String,
    pub part: usize,
}

/// `classifyKey`：不属于这个空间或格式不对的返回 `None`。
pub fn classify_key(space_id: &str, key: &str) -> Option<ClassifiedKey> {
    if !is_space_id(space_id) || !is_doc_key(key) {
        return None;
    }
    let prefix = space_prefix(space_id).ok()?;
    if !key.starts_with(&prefix) {
        return None;
    }
    // `/\.(\d{1,3})$/`：最后一个点后面是 1–3 位数字。
    let (logical_key, part) = match key.rsplit_once('.') {
        Some((logical, digits))
            if (1..=3).contains(&digits.len()) && all(digits, |b| b.is_ascii_digit()) =>
        {
            let part: usize = digits.parse().ok()?;
            if part < 1 {
                return None;
            }
            (logical, part)
        }
        _ => (key, 0),
    };
    let rest = logical_key.get(prefix.len()..)?;
    let kind = match rest {
        "head" => KeyKind::Head,
        "revoked" => KeyKind::Revoked,
        _ => {
            let mut it = rest.split('/');
            let group = it.next()?;
            let id = it.next().filter(|id| !id.is_empty())?;
            if it.next().is_some() {
                return None;
            }
            match group {
                "p" if is_project_hash(id) => KeyKind::Project(id.to_owned()),
                "cmd" if is_command_id(id) => KeyKind::Command(id.to_owned()),
                "ack" if is_command_id(id) => KeyKind::Ack(id.to_owned()),
                "dev" if is_device_id(id) => KeyKind::Device(id.to_owned()),
                _ => return None,
            }
        }
    };
    Some(ClassifiedKey {
        kind,
        logical_key: logical_key.to_owned(),
        part,
    })
}

/// `commandTimestamp`：命令 ID 里的发送时间（毫秒）。13 位 36 进制最大约 1.7e20，超过 u64 的按 u64::MAX 算
/// （TS 得到的是一个近似的大数；两边都会当作「来自未来」拒绝）。
pub fn command_timestamp(command_id: &str) -> Option<u64> {
    if !is_command_id(command_id) {
        return None;
    }
    let stamp = &command_id.split_once('.')?.1[..13];
    let n = u128::from_str_radix(stamp, 36).ok()?;
    Some(u64::try_from(n).unwrap_or(u64::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_keys_split_at_the_last_marker() {
        assert!(is_task_key("ATM-T-0001"));
        assert!(is_task_key("A-T-1234-T-5678"));
        assert!(is_task_key("A-T--T-1234"));
        assert!(!is_task_key("ATM-T-001"));
        assert!(!is_task_key("atm-T-0001"));
        assert!(!is_task_key("-T-0001"));
        assert!(!is_task_key("A-T-12a4"));
    }

    #[test]
    fn multi_byte_text_never_splits_inside_a_character() {
        assert!(!is_command_id("pc-0123456789ab.ééééééé1234567"));
        assert!(!is_app_id("éa"));
        assert!(!is_project_code("Éa"));
    }

    #[test]
    fn command_ids_carry_their_time() {
        let id = new_command_id("pc-0123456789ab", 1_700_000_000_000).unwrap();
        assert!(is_command_id(&id), "{id}");
        assert_eq!(command_timestamp(&id), Some(1_700_000_000_000));
        assert_eq!(base36(0), "0");
    }
}
