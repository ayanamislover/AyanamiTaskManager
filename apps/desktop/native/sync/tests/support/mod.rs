//! 用例共用的内存中继（2.x `packages/sync/test/support/memory-relay.ts` 同一语义）：按 AyanamiCloud 应用数据
//! 的规则——修订号跨删除单调、409 带 current、变更游标、裁剪后 410、别家游标回 400；另有断网开关与请求记录。
#![allow(dead_code)]

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, MutexGuard};

use atm_sync::relay::{RelayClient, RelayClientOptions};
use atm_sync::transport::{
    Cancel, HttpRequest, HttpResponse, NetFailure, Transport, any_cancelled,
};
use serde_json::{Value, json};

#[derive(Debug, Clone)]
pub struct StoredDoc {
    pub key: String,
    pub revision: u64,
    pub data: Value,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct StoredChange {
    pub seq: u64,
    pub key: String,
    pub revision: u64,
    pub op: &'static str,
}

#[derive(Debug, Clone)]
pub struct Recorded {
    pub method: &'static str,
    pub url: String,
    pub key: Option<String>,
    pub body: Option<Value>,
}

#[derive(Default)]
pub struct RelayState {
    pub docs: BTreeMap<String, StoredDoc>,
    pub last_revision: HashMap<String, u64>,
    pub changes: Vec<StoredChange>,
    pub seq: u64,
    pub requests: Vec<Recorded>,
    pub long_poll: bool,
    /// 为真时所有请求都像断网一样失败。
    pub offline: bool,
    pub token: String,
    pub app_id: String,
    /// 下一个匹配的请求按这个回（方法、键名片段、状态、错误码），只用一次。
    pub faults: Vec<(&'static str, String, u16, String)>,
    /// 注入的 429 带上这个 Retry-After（秒）。
    pub retry_after: Option<u64>,
}

#[derive(Clone)]
pub struct MemoryRelay(pub Arc<Mutex<RelayState>>);

pub const TOKEN: &str = "test-relay-token-7c1f";

fn reply(status: u16, body: Option<Value>) -> HttpResponse {
    HttpResponse {
        status,
        headers: Vec::new(),
        body: body
            .map(|b| serde_json::to_vec(&b).unwrap())
            .unwrap_or_default(),
    }
}

fn error(status: u16, code: &str) -> HttpResponse {
    reply(
        status,
        Some(json!({ "error": { "code": code, "message": code } })),
    )
}

impl MemoryRelay {
    pub fn new(long_poll: bool) -> MemoryRelay {
        MemoryRelay(Arc::new(Mutex::new(RelayState {
            long_poll,
            token: TOKEN.to_owned(),
            app_id: "atm".to_owned(),
            ..Default::default()
        })))
    }

    pub fn state(&self) -> MutexGuard<'_, RelayState> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn client(&self, token: &str, lifetime: Option<Cancel>) -> RelayClient {
        RelayClient::new(RelayClientOptions {
            base_url: "https://relay.example.com".into(),
            app_id: "atm".into(),
            token: token.into(),
            transport: Arc::new(self.clone()),
            timeout: None,
            lifetime,
        })
        .unwrap()
    }

    /// 模拟中继裁剪：只保留最后 keep 条变更。
    pub fn prune(&self, keep: usize) {
        let mut s = self.state();
        let n = s.changes.len();
        if n > keep {
            s.changes.drain(..n - keep);
        }
    }

    /// 第 `index` 个请求之后写入（PUT）过的键。
    pub fn puts_since(&self, index: usize) -> Vec<String> {
        self.state().requests[index..]
            .iter()
            .filter(|r| r.method == "PUT")
            .filter_map(|r| r.key.clone())
            .collect()
    }

    pub fn request_count(&self) -> usize {
        self.state().requests.len()
    }

    pub fn keys(&self) -> Vec<String> {
        self.state().docs.keys().cloned().collect()
    }

    /// 直接写一份文档（像别的设备那样），记一条变更。
    pub fn put_raw(&self, key: &str, data: Value) {
        let mut s = self.state();
        let revision = s.last_revision.get(key).copied().unwrap_or(0) + 1;
        s.last_revision.insert(key.to_owned(), revision);
        s.docs.insert(
            key.to_owned(),
            StoredDoc {
                key: key.to_owned(),
                revision,
                data,
                updated_at: "2026-10-10T00:00:00.000Z".into(),
            },
        );
        record(&mut s, key, revision, "put");
    }

    pub fn delete_raw(&self, key: &str) {
        let mut s = self.state();
        if s.docs.remove(key).is_some() {
            let revision = s.last_revision.get(key).copied().unwrap_or(0) + 1;
            s.last_revision.insert(key.to_owned(), revision);
            record(&mut s, key, revision, "delete");
        }
    }
}

fn record(s: &mut RelayState, key: &str, revision: u64, op: &'static str) {
    s.seq += 1;
    let seq = s.seq;
    s.changes.push(StoredChange {
        seq,
        key: key.to_owned(),
        revision,
        op,
    });
}

fn meta(doc: &StoredDoc) -> serde_json::Map<String, Value> {
    let mut m = serde_json::Map::new();
    m.insert("key".into(), json!(doc.key));
    m.insert("schema_version".into(), json!(1));
    m.insert("revision".into(), json!(doc.revision));
    m.insert("updated_at".into(), json!(doc.updated_at));
    m.insert("updated_by_device".into(), Value::Null);
    m.insert(
        "size_bytes".into(),
        json!(serde_json::to_string(&doc.data).unwrap().len()),
    );
    m
}

fn with_data(doc: &StoredDoc) -> Value {
    let mut m = meta(doc);
    m.insert("data".into(), doc.data.clone());
    Value::Object(m)
}

impl Transport for MemoryRelay {
    fn send(&self, request: &HttpRequest, cancel: &[&Cancel]) -> Result<HttpResponse, NetFailure> {
        // 像真的请求一样：令牌已取消的请求直接失败（停下的会话写不出任何东西）。
        if any_cancelled(cancel) {
            return Err(NetFailure::Cancelled);
        }
        let url = url::Url::parse(&request.url).unwrap();
        let mut s = self.state();
        let prefix = format!("/v1/apps/{}", s.app_id);
        let path = url.path().to_owned();
        let rest = path.strip_prefix(&prefix).unwrap_or("").to_owned();
        let key = rest.strip_prefix("/documents/").map(percent_decode);
        let body: Option<Value> = request
            .body
            .as_ref()
            .map(|b| serde_json::from_slice(b).unwrap());
        s.requests.push(Recorded {
            method: request.method,
            url: request.url.clone(),
            key: key.clone(),
            body: body.clone(),
        });
        if s.offline {
            return Err(NetFailure::Failed {
                code: Some("ECONNREFUSED".into()),
            });
        }
        if request.header("Authorization") != Some(&format!("Bearer {}", s.token)) {
            return Ok(error(401, "UNAUTHORIZED"));
        }
        if let Some(i) = s.faults.iter().position(|(m, part, _, _)| {
            *m == request.method && key.as_deref().unwrap_or(&rest).contains(part.as_str())
        }) {
            let (_, _, status, code) = s.faults.remove(i);
            let mut response = error(status, &code);
            if status == 429
                && let Some(seconds) = s.retry_after
            {
                response
                    .headers
                    .push(("Retry-After".into(), seconds.to_string()));
            }
            return Ok(response);
        }
        if !path.starts_with(&prefix) {
            return Ok(error(404, "NOT_FOUND"));
        }
        let query: HashMap<String, String> = url.query_pairs().into_owned().collect();
        let q = |name: &str| query.get(name).cloned();
        if rest.is_empty() && request.method == "GET" {
            let mut body = json!({ "id": s.app_id, "name": "ATM" });
            if s.long_poll {
                body["relay"] =
                    json!({ "name": "memory", "version": "0", "long_poll": true, "max_wait": 25 });
            }
            return Ok(reply(200, Some(body)));
        }
        if rest == "/documents" && request.method == "GET" {
            let wanted = q("prefix").unwrap_or_default();
            let documents: Vec<Value> = s
                .docs
                .values()
                .filter(|d| d.key.starts_with(&wanted))
                .map(|d| Value::Object(meta(d)))
                .collect();
            return Ok(reply(
                200,
                Some(json!({ "documents": documents, "next_cursor": null })),
            ));
        }
        if rest == "/changes" && request.method == "GET" {
            // 别家中继的游标格式对不上：像 atm-relay 一样回 400。
            let raw = q("cursor");
            if let Some(r) = &raw
                && !r.bytes().all(|b| b.is_ascii_digit())
            {
                return Ok(error(400, "INVALID_CURSOR"));
            }
            let cursor: u64 = raw
                .as_deref()
                .filter(|r| !r.is_empty())
                .map_or(0, |r| r.parse().unwrap());
            let limit: usize = q("limit").map_or(100, |l| l.parse().unwrap());
            if cursor > 0 && !s.changes.is_empty() && !s.changes.iter().any(|c| c.seq <= cursor) {
                return Ok(error(410, "CURSOR_EXPIRED"));
            }
            let after: Vec<&StoredChange> = s.changes.iter().filter(|c| c.seq > cursor).collect();
            let page: Vec<Value> = after
                .iter()
                .take(limit)
                .map(|c| json!({ "seq": c.seq, "key": c.key, "revision": c.revision, "op": c.op, "device_id": null, "at": "2026-10-10T00:00:00.000Z" }))
                .collect();
            let next = match after.iter().take(limit).next_back() {
                Some(c) => json!(c.seq.to_string()),
                None if cursor > 0 => json!(cursor.to_string()),
                None => Value::Null,
            };
            return Ok(reply(
                200,
                Some(
                    json!({ "changes": page, "next_cursor": next, "has_more": after.len() > limit }),
                ),
            ));
        }
        if let Some(key) = key {
            let current = s.docs.get(&key).cloned();
            match request.method {
                "GET" => {
                    return Ok(match current {
                        Some(doc) => reply(200, Some(with_data(&doc))),
                        None => error(404, "NOT_FOUND"),
                    });
                }
                "PUT" => {
                    let body = body.unwrap_or_else(|| json!({}));
                    let have = current.as_ref().map_or(0, |d| d.revision);
                    if body["expected_revision"].as_u64() != Some(have) {
                        let mut out = json!({ "error": { "code": "REVISION_CONFLICT", "message": "REVISION_CONFLICT" } });
                        if let Some(doc) = &current {
                            out["current"] = with_data(doc);
                        }
                        return Ok(reply(409, Some(out)));
                    }
                    let revision = s.last_revision.get(&key).copied().unwrap_or(0) + 1;
                    s.last_revision.insert(key.clone(), revision);
                    let doc = StoredDoc {
                        key: key.clone(),
                        revision,
                        data: body["data"].clone(),
                        updated_at: "2026-10-10T00:00:00.000Z".into(),
                    };
                    s.docs.insert(key.clone(), doc.clone());
                    record(&mut s, &key, revision, "put");
                    return Ok(reply(
                        if current.is_some() { 200 } else { 201 },
                        Some(with_data(&doc)),
                    ));
                }
                "DELETE" => {
                    let Some(doc) = current else {
                        return Ok(error(404, "NOT_FOUND"));
                    };
                    if q("expected_revision").and_then(|r| r.parse::<u64>().ok())
                        != Some(doc.revision)
                    {
                        return Ok(error(409, "REVISION_CONFLICT"));
                    }
                    let revision = s.last_revision.get(&key).copied().unwrap_or(0) + 1;
                    s.last_revision.insert(key.clone(), revision);
                    s.docs.remove(&key);
                    record(&mut s, &key, revision, "delete");
                    return Ok(reply(204, None));
                }
                _ => {}
            }
        }
        Ok(error(404, "NOT_FOUND"))
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).unwrap();
            out.push(u8::from_str_radix(hex, 16).unwrap());
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap()
}
pub mod world;
