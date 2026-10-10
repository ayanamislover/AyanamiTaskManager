//! 一个配对空间的加密对象存储（2.x `packages/sync-protocol/src/space-store.ts`）：分片、修订号与写入顺序，
//! 不做业务判断。修订号缓存只是优化：猜错时中继回 409 并带当前版本，这里用它重试一次。

use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;
use std::time::Duration;

use atm_sync_protocol::SpaceKeys;
use atm_sync_protocol::envelope::{open_object, parse_head_envelope, seal_object};
use atm_sync_protocol::error::{SyncError, SyncErrorCode};
use atm_sync_protocol::keys::{
    ack_key, command_key, device_key, head_key, new_command_id, part_key, project_key, revoked_key,
    space_prefix,
};
use atm_sync_protocol::schema::{
    ACK_DOC, COMMAND_DOC, DEVICE_DOC, HEAD_DOC, PROJECT_DOC, REVOKED_DOC, S, check,
};
use serde_json::{Map, Value};

use crate::relay::{RelayClient, RelayError};
use crate::transport::{Cancel, Sleeper, sleeper};

/// 存储层的失败：中继的（网络、HTTP）与协议的（密钥不对、内容不完整、格式不对）。
#[derive(Debug, Clone, PartialEq)]
pub enum StoreError {
    Relay(RelayError),
    Protocol(SyncError),
}

impl From<RelayError> for StoreError {
    fn from(e: RelayError) -> Self {
        StoreError::Relay(e)
    }
}

impl From<SyncError> for StoreError {
    fn from(e: SyncError) -> Self {
        StoreError::Protocol(e)
    }
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Relay(e) => f.write_str(&e.message),
            StoreError::Protocol(e) => f.write_str(&e.message()),
        }
    }
}

impl StoreError {
    pub fn is_incomplete(&self) -> bool {
        matches!(self, StoreError::Protocol(e) if e.code == SyncErrorCode::ObjectIncomplete)
    }
}

pub type StoreResult<T> = Result<T, StoreError>;

/// 文档的种类：只在一类文档的 `schema` 上校验，写入前也校验（2.x 的 `Schema.parse(doc)`）。
fn checked(schema: &S, doc: &Value, what: &str) -> StoreResult<Value> {
    check(schema, doc)
        .ok_or_else(|| StoreError::Protocol(SyncError::with(SyncErrorCode::SchemaInvalid, what)))
}

const READ_ATTEMPTS: u32 = 4;

/// JS `Number(text)` 用在分片序号上：键里只可能有 `[A-Za-z0-9_./-]`，所以只需要认空串、十进制（带小数与
/// 指数）、`0x` / `0o` / `0b` 与 `Infinity`。不是数是 NaN（`None`）。
fn js_number_of(text: &str) -> Option<f64> {
    if text.is_empty() {
        return Some(0.0);
    }
    let radix = |digits: &str, r: u32| -> Option<f64> {
        if digits.is_empty() {
            return None;
        }
        digits.chars().try_fold(0f64, |acc, c| {
            Some(acc * f64::from(r) + f64::from(c.to_digit(r)?))
        })
    };
    let lower = text.get(..2).map(str::to_ascii_lowercase);
    match lower.as_deref() {
        Some("0x") => return radix(&text[2..], 16),
        Some("0o") => return radix(&text[2..], 8),
        Some("0b") => return radix(&text[2..], 2),
        _ => {}
    }
    let (sign, body) = match text.strip_prefix('-') {
        Some(rest) => (-1.0, rest),
        None => (1.0, text),
    };
    if body == "Infinity" {
        return Some(sign * f64::INFINITY);
    }
    let (mantissa, exponent) = match body.find(['e', 'E']) {
        Some(i) => (&body[..i], Some(&body[i + 1..])),
        None => (body, None),
    };
    let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if (int.is_empty() && frac.is_empty()) || !digits(int) || !digits(frac) {
        return None;
    }
    if let Some(exp) = exponent {
        let e = exp
            .strip_prefix('-')
            .or_else(|| exp.strip_prefix('+'))
            .unwrap_or(exp);
        if e.is_empty() || !digits(e) {
            return None;
        }
    }
    // 形状已经核对过，标准库的解析与 JS 的结果相同（`"5."`、`".5"` 也收）。
    let normalized = format!(
        "{}{}{}",
        if int.is_empty() { "0" } else { int },
        if frac.is_empty() {
            String::new()
        } else {
            format!(".{frac}")
        },
        exponent.map(|e| format!("e{e}")).unwrap_or_default()
    );
    normalized.parse::<f64>().ok().map(|n| sign * n)
}

/// 分片键：逻辑键后面是 `.` 加 1–3 位数字（`/\.\d{1,3}$/`）。
fn is_part_key(key: &str) -> bool {
    match key.rsplit_once('.') {
        Some((_, digits)) => {
            (1..=3).contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_digit())
        }
        None => false,
    }
}

pub struct SpaceStoreOptions {
    pub client: RelayClient,
    pub keys: SpaceKeys,
    pub space_id: String,
    /// 读到正在更新的分片对象时的重试间隔，默认 400 ms（第 n 次等 n 倍）。
    pub retry_delay: Option<Duration>,
    /// 重试等待期间可以被它打断（会话停下时）。
    pub lifetime: Option<Cancel>,
    /// 换掉默认的等待（用例）。
    pub sleep: Option<Sleeper>,
}

#[derive(Default)]
struct Cache {
    revisions: HashMap<String, f64>,
    part_counts: HashMap<String, f64>,
}

pub struct SpaceStore {
    client: RelayClient,
    keys: SpaceKeys,
    space_id: String,
    prefix: String,
    retry_delay: Duration,
    sleep: Sleeper,
    cache: Mutex<Cache>,
}

/// 设备的名字与 ID（命令里的 `device`、撤销标记里的 `host`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceRef {
    pub id: String,
    pub name: String,
}

impl SpaceStore {
    /// 空间 ID 不合法时返回协议层的 `KEY_INVALID`。
    pub fn new(options: SpaceStoreOptions) -> Result<SpaceStore, SyncError> {
        Ok(SpaceStore {
            prefix: space_prefix(&options.space_id)?,
            client: options.client,
            keys: options.keys,
            space_id: options.space_id,
            retry_delay: options.retry_delay.unwrap_or(Duration::from_millis(400)),
            sleep: options.sleep.unwrap_or_else(|| sleeper(options.lifetime)),
            cache: Mutex::new(Cache::default()),
        })
    }

    pub fn client(&self) -> &RelayClient {
        &self.client
    }

    pub fn space_id(&self) -> &str {
        &self.space_id
    }

    pub fn prefix(&self) -> &str {
        &self.prefix
    }

    pub fn project_hash(&self, code: &str) -> String {
        self.keys.project_hash(code)
    }

    fn cache(&self) -> std::sync::MutexGuard<'_, Cache> {
        self.cache.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 让缓存忘掉某个键（例如变更流里看到别的设备删除了它）。
    pub fn forget(&self, key: &str) {
        self.cache().revisions.remove(key);
    }

    fn remember(&self, key: &str, revision: f64) {
        self.cache().revisions.insert(key.to_owned(), revision);
    }

    fn put(&self, key: &str, data: &Value) -> StoreResult<f64> {
        let expected = self.cache().revisions.get(key).copied().unwrap_or(0.0);
        let doc = match self.client.put_document(key, expected, data) {
            Ok(doc) => doc,
            Err(e) if e.status == 409 => {
                // 删除后重建要用 0；current 缺失即说明当前不存在。
                let retry = e.current.map_or(0.0, |c| c.revision);
                self.client.put_document(key, retry, data)?
            }
            Err(e) => return Err(e.into()),
        };
        self.remember(key, doc.meta.revision);
        Ok(doc.meta.revision)
    }

    fn delete(&self, key: &str) -> StoreResult<bool> {
        let cached = self.cache().revisions.get(key).copied();
        let expected = match cached {
            Some(r) => r,
            None => match self.client.get_document(key, None)? {
                Some(current) => current.meta.revision,
                None => return Ok(false),
            },
        };
        match self.client.delete_document(key, expected) {
            Ok(deleted) => {
                self.forget(key);
                Ok(deleted)
            }
            Err(e) if e.status == 409 => {
                let Some(current) = self.client.get_document(key, None)? else {
                    self.forget(key);
                    return Ok(false);
                };
                let deleted = self.client.delete_document(key, current.meta.revision)?;
                self.forget(key);
                Ok(deleted)
            }
            Err(e) => Err(e.into()),
        }
    }

    fn existing_part_count(&self, logical_key: &str) -> StoreResult<f64> {
        if let Some(n) = self.cache().part_counts.get(logical_key) {
            return Ok(*n);
        }
        let listed = self.client.list_documents(&format!("{logical_key}."))?;
        let mut highest = 0.0f64;
        for meta in &listed {
            let index = meta.key.get(logical_key.len() + 1..).and_then(js_number_of);
            if let Some(i) = index
                && i.is_finite()
                && i.fract() == 0.0
                && i > highest
            {
                highest = i;
            }
            self.remember(&meta.key, meta.revision);
        }
        Ok(highest + 1.0)
    }

    /// 加密写入一个对象：先写 1..n-1 片，最后写第 0 片（提交点），再删掉旧版本多出来的片。
    /// `fresh` 表示键是新生成的（命令、回执），省掉一次列举旧分片的请求。
    pub fn write_object(
        &self,
        logical_key: &str,
        value: &Value,
        fresh: bool,
    ) -> StoreResult<usize> {
        let parts = seal_object(&self.keys, logical_key, value)?;
        let previous = if fresh {
            1.0
        } else {
            self.existing_part_count(logical_key)?
        };
        if let Some((head, rest)) = parts.split_first() {
            for part in rest {
                self.put(&part.key, &part.data)?;
            }
            self.put(&head.key, &head.data)?;
        }
        let mut index = parts.len();
        while (index as f64) < previous {
            self.delete(&part_key(logical_key, index)?)?;
            index += 1;
        }
        self.cache()
            .part_counts
            .insert(logical_key.to_owned(), parts.len() as f64);
        Ok(parts.len())
    }

    fn open_once(&self, logical_key: &str, schema: &S) -> StoreResult<Option<Value>> {
        let Some(doc) = self.client.get_document(logical_key, None)? else {
            self.forget(logical_key);
            return Ok(None);
        };
        self.remember(logical_key, doc.meta.revision);
        let envelope = parse_head_envelope(doc.data.as_ref().unwrap_or(&Value::Null))?;
        let mut relay_failure: Option<RelayError> = None;
        let opened = open_object(&self.keys, logical_key, &envelope, |key| {
            match self.client.get_document(key, None) {
                Ok(Some(part)) => {
                    self.remember(key, part.meta.revision);
                    Ok(part.data.filter(|d| !d.is_null()))
                }
                Ok(None) => Ok(None),
                Err(e) => {
                    relay_failure = Some(e);
                    Err(SyncError::new(SyncErrorCode::ObjectIncomplete))
                }
            }
        });
        if let Some(e) = relay_failure {
            return Err(e.into());
        }
        let plain = opened?;
        self.cache()
            .part_counts
            .insert(logical_key.to_owned(), envelope.parts as f64);
        check(schema, &plain)
            .map(Some)
            .ok_or_else(|| SyncError::with(SyncErrorCode::SchemaInvalid, logical_key).into())
    }

    /// 读取并解密；不存在返回 `None`。写入进行中会稍等重读，超过次数是 `OBJECT_INCOMPLETE`。
    pub fn read_object(&self, logical_key: &str, schema: &S) -> StoreResult<Option<Value>> {
        let mut attempt = 1;
        loop {
            match self.open_once(logical_key, schema) {
                Err(e) if e.is_incomplete() && attempt < READ_ATTEMPTS => {
                    if !(self.sleep)(self.retry_delay * attempt) {
                        return Err(RelayError::aborted().into());
                    }
                    attempt += 1;
                }
                other => return other,
            }
        }
    }

    pub fn delete_object(&self, logical_key: &str) -> StoreResult<()> {
        let count = self.existing_part_count(logical_key)?.max(1.0);
        self.delete(logical_key)?;
        let mut index = 1usize;
        while (index as f64) < count {
            self.delete(&part_key(logical_key, index)?)?;
            index += 1;
        }
        self.cache().part_counts.remove(logical_key);
        Ok(())
    }

    /// 列出本空间里某一类文档（`p` / `cmd` / `ack` / `dev`）的逻辑键（跳过分片）。
    pub fn list_keys(&self, group: &str) -> StoreResult<Vec<String>> {
        let listed = self
            .client
            .list_documents(&format!("{}{group}/", self.prefix))?;
        let mut keys = Vec::new();
        for meta in listed {
            self.remember(&meta.key, meta.revision);
            if !is_part_key(&meta.key) {
                keys.push(meta.key);
            }
        }
        Ok(keys)
    }

    // ─── 具体文档 ───

    pub fn read_head(&self) -> StoreResult<Option<Value>> {
        self.read_object(&head_key(&self.space_id)?, &HEAD_DOC)
    }

    pub fn write_head(&self, doc: &Value) -> StoreResult<()> {
        let doc = checked(&HEAD_DOC, doc, "HeadDoc")?;
        self.write_object(&head_key(&self.space_id)?, &doc, false)
            .map(drop)
    }

    pub fn read_project(&self, hash: &str) -> StoreResult<Option<Value>> {
        self.read_object(&project_key(&self.space_id, hash)?, &PROJECT_DOC)
    }

    pub fn write_project(&self, hash: &str, doc: &Value) -> StoreResult<()> {
        let doc = checked(&PROJECT_DOC, doc, "ProjectDoc")?;
        self.write_object(&project_key(&self.space_id, hash)?, &doc, false)
            .map(drop)
    }

    pub fn delete_project(&self, hash: &str) -> StoreResult<()> {
        self.delete_object(&project_key(&self.space_id, hash)?)
    }

    /// 手机发命令：生成命令 ID 并以「新建」写入（ID 唯一，不会覆盖别人的命令）。`input` 是
    /// `{ type, body }`。电脑一侧只在用例里用它扮演手机。
    pub fn send_command(
        &self,
        device: &DeviceRef,
        input: &Value,
        now_ms: u64,
        at: &str,
    ) -> StoreResult<Value> {
        let id = new_command_id(&device.id, now_ms)?;
        let mut doc = Map::new();
        doc.insert("v".into(), Value::from(1));
        doc.insert("id".into(), Value::from(id.clone()));
        doc.insert(
            "device".into(),
            serde_json::json!({ "id": device.id, "name": device.name }),
        );
        doc.insert("at".into(), Value::from(at));
        if let Some(fields) = input.as_object() {
            for (k, v) in fields {
                doc.insert(k.clone(), v.clone());
            }
        }
        let doc = checked(&COMMAND_DOC, &Value::Object(doc), "CommandDoc")?;
        self.write_object(&command_key(&self.space_id, &id)?, &doc, true)?;
        Ok(doc)
    }

    pub fn read_command(&self, command_id: &str) -> StoreResult<Option<Value>> {
        self.read_object(&command_key(&self.space_id, command_id)?, &COMMAND_DOC)
    }

    pub fn delete_command(&self, command_id: &str) -> StoreResult<()> {
        self.delete_object(&command_key(&self.space_id, command_id)?)
    }

    pub fn write_ack(&self, doc: &Value) -> StoreResult<()> {
        let doc = checked(&ACK_DOC, doc, "AckDoc")?;
        let id = doc.get("id").and_then(Value::as_str).unwrap_or_default();
        self.write_object(&ack_key(&self.space_id, id)?, &doc, true)
            .map(drop)
    }

    pub fn read_ack(&self, command_id: &str) -> StoreResult<Option<Value>> {
        self.read_object(&ack_key(&self.space_id, command_id)?, &ACK_DOC)
    }

    pub fn delete_ack(&self, command_id: &str) -> StoreResult<()> {
        self.delete_object(&ack_key(&self.space_id, command_id)?)
    }

    pub fn write_device(&self, doc: &Value) -> StoreResult<()> {
        let doc = checked(&DEVICE_DOC, doc, "DeviceDoc")?;
        let id = doc.get("id").and_then(Value::as_str).unwrap_or_default();
        self.write_object(&device_key(&self.space_id, id)?, &doc, false)
            .map(drop)
    }

    pub fn read_device(&self, device_id: &str) -> StoreResult<Option<Value>> {
        self.read_object(&device_key(&self.space_id, device_id)?, &DEVICE_DOC)
    }

    pub fn delete_device(&self, device_id: &str) -> StoreResult<()> {
        self.delete_object(&device_key(&self.space_id, device_id)?)
    }

    pub fn read_revoked(&self) -> StoreResult<Option<Value>> {
        self.read_object(&revoked_key(&self.space_id)?, &REVOKED_DOC)
    }

    pub fn write_revoked(&self, doc: &Value) -> StoreResult<()> {
        let doc = checked(&REVOKED_DOC, doc, "RevokedDoc")?;
        self.write_object(&revoked_key(&self.space_id)?, &doc, false)
            .map(drop)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn part_indexes_are_read_like_js_number() {
        let cases: &[(&str, Option<f64>)] = &[
            ("", Some(0.0)),
            ("3", Some(3.0)),
            ("03", Some(3.0)),
            ("5.", Some(5.0)),
            (".5", Some(0.5)),
            ("1e2", Some(100.0)),
            ("1E-1", Some(0.1)),
            ("0x1f", Some(31.0)),
            ("0b101", Some(5.0)),
            ("0o17", Some(15.0)),
            ("-2", Some(-2.0)),
            ("Infinity", Some(f64::INFINITY)),
            ("1/2", None),
            ("abc", None),
            ("1e", None),
            (".", None),
            ("0x", None),
            ("1.2.3", None),
        ];
        for (text, want) in cases {
            assert_eq!(js_number_of(text), *want, "{text}");
        }
    }

    #[test]
    fn part_keys_end_in_one_to_three_digits() {
        assert!(is_part_key("atm1/s/head.1"));
        assert!(is_part_key("atm1/s/head.999"));
        assert!(!is_part_key("atm1/s/head.1000"));
        assert!(!is_part_key("atm1/s/head"));
        assert!(!is_part_key("atm1/s/head."));
    }
}
