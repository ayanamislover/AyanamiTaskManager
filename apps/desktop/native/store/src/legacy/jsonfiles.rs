//! sync / dispatch 文件族 F1–F7（W3b5；05 §1.5、§3.4、§5.1）。
//!
//! 按 2.0 的读盘语义加载（zod 4：非 strict 的对象丢弃未知键，`strict` 的拒绝；数字必须有限，`int` 是安全整数；
//! 字符串长度按 UTF-16 码元），写进 3.0 的表；VERIFY 把目标表反投影成同一形状的 JSON，
//! 与源的加载结果比 JCS（RFC 8785）摘要。
//! - `sync/config.json`：缺失或损坏时不写 `sync_state`。2.0 把坏文件改名留档、下次启动从默认值开始，默认值的
//!   deviceId 是随机的、deviceName 取主机名；3.0 首启同样生成。损坏记信息项。
//! - `sync/secrets.dpapi.json`：逐字节复制到目标旁的 `sync/`，sha256 相等。DPAPI 自检由宿主给出
//!   （[`super::ConvertOptions::secrets_check`]），在动目标之前做；不能解密即停（手机配对要重做）。
//! - `dispatch/config.json`：不存在 → 默认值、`MISSING`；坏文件或不合法 → 默认值、`CORRUPT_DEFAULTED`（2.0 不重写它）。
//! - `dispatch/runs.json`（`loadRuns`）：逐条校验，坏条目丢弃并置 `runs_damaged_at_conversion`；整个文件坏了从空历史开始。
//! - `dispatch/requests.json`（`loadLedgerFile` + `RequestLedger#reload`）：发现丢失 → `lost_before = max(文件里的水位线, at)`；
//!   带 requestId 的历史补回成条目。不裁剪、不补 `requestsSince`：那两件是 2.0 下次读盘按当时时钟做的，
//!   3.0 运行时按它自己的时钟裁剪；`requestsSince` 只服务于两个文件分别丢失的判断，单库里没有这种情况。
//!   丢失判断不一样：转换之后它就观察不到了，所以在这里按 `at` 落成水位线。
//! - `dispatch/logs/`：非运行中的 run 的日志复制到目标旁的 `dispatch/logs/`（F6）；运行中的 run 的日志
//!   仍被旧根里的子进程写着，不复制、`log_root='LEGACY'`，只登记数量（F7）；历史里没有的 run 的日志
//!   2.0 下次保存历史就删，记 X9 不复制。

use super::{
    ConvertError, FamilyCheck, Report, Result, SourceDigest, canonical_utc_millis, file_sha256,
    json_string,
};
use crate::jsjson::{self, Value};
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

fn unsupported(root: &Path, what: String) -> ConvertError {
    ConvertError::Unsupported(format!("{}: {what}", root.display()))
}

// ---------------------------------------------------------------- 读盘

/// `files.ts` 的 `readJsonFile`。
enum Parsed {
    Missing,
    Corrupt,
    Ok(Value),
}

fn read(root: &Path, rel: &str) -> Result<Parsed> {
    let bytes = match std::fs::read(root.join(rel)) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Parsed::Missing),
        // 读不出来：内容未知，2.0 也不判断（派单账本据此 503）。转换停。
        Err(e) => return Err(unsupported(root, format!("{rel} cannot be read ({e})"))),
    };
    // `readFileSync(path, "utf8")`：坏字节换成 U+FFFD，BOM 保留（JSON.parse 因此失败）。
    match jsjson::parse_value(&String::from_utf8_lossy(&bytes)) {
        Ok(Some(v)) => Ok(Parsed::Ok(v)),
        Ok(None) => Ok(Parsed::Corrupt),
        Err(e) => Err(unsupported(root, format!("{rel}: {e}"))),
    }
}

// ---------------------------------------------------------------- zod 4 的校验

type Check<'a> = &'a dyn Fn(&Value) -> Option<Value>;

fn units(s: &str) -> usize {
    s.encode_utf16().count()
}

fn string(min: usize, max: usize) -> impl Fn(&Value) -> Option<Value> {
    move |v| match v {
        Value::String(s) if (min..=max).contains(&units(s)) => Some(v.clone()),
        _ => None,
    }
}

fn any_string(v: &Value) -> Option<Value> {
    matches!(v, Value::String(_)).then(|| v.clone())
}

fn pattern(p: fn(&str) -> bool) -> impl Fn(&Value) -> Option<Value> {
    move |v| match v {
        Value::String(s) if p(s) => Some(v.clone()),
        _ => None,
    }
}

fn one_of(set: &'static [&'static str]) -> impl Fn(&Value) -> Option<Value> {
    move |v| match v {
        Value::String(s) if set.contains(&s.as_str()) => Some(v.clone()),
        _ => None,
    }
}

fn boolean(v: &Value) -> Option<Value> {
    matches!(v, Value::Bool(_)).then(|| v.clone())
}

fn number(v: &Value) -> Option<Value> {
    matches!(v, Value::Number(x) if x.is_finite()).then(|| v.clone())
}

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// `z.number().int().min(lo).max(hi)`：安全整数。
fn int(lo: f64, hi: f64) -> impl Fn(&Value) -> Option<Value> {
    move |v| match v {
        Value::Number(x) if x.fract() == 0.0 && x.abs() <= MAX_SAFE && *x >= lo && *x <= hi => {
            Some(v.clone())
        }
        _ => None,
    }
}

fn literal_one(v: &Value) -> Option<Value> {
    matches!(v, Value::Number(x) if *x == 1.0).then(|| v.clone())
}

fn nullable<'a>(c: Check<'a>) -> impl Fn(&Value) -> Option<Value> + 'a {
    move |v| match v {
        Value::Null => Some(Value::Null),
        _ => c(v),
    }
}

fn array_of<'a>(c: Check<'a>, max: usize) -> impl Fn(&Value) -> Option<Value> + 'a {
    move |v| match v {
        Value::Array(items) if items.len() <= max => items
            .iter()
            .map(c)
            .collect::<Option<Vec<_>>>()
            .map(Value::Array),
        _ => None,
    }
}

fn any_array(v: &Value) -> Option<Value> {
    matches!(v, Value::Array(_)).then(|| v.clone())
}

/// 一个字段：(键, 可省略, 校验)。
type FieldSpec<'a> = (&'static str, bool, Check<'a>);

/// `z.object(shape)`（`strict` 时是 `.strict()`）：输出只含 shape 里的键。
fn object(v: &Value, fields: &[FieldSpec<'_>], strict: bool) -> Option<Value> {
    let Value::Object(entries) = v else {
        return None;
    };
    if strict
        && entries
            .iter()
            .any(|(k, _)| !fields.iter().any(|f| f.0 == k))
    {
        return None;
    }
    let mut out = Vec::new();
    for (name, optional, check) in fields {
        match entries.iter().find(|(k, _)| k == name) {
            Some((_, value)) => out.push((name.to_string(), check(value)?)),
            None if *optional => {}
            None => return None,
        }
    }
    Some(Value::Object(out))
}

fn get<'v>(v: &'v Value, key: &str) -> Option<&'v Value> {
    match v {
        Value::Object(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
        _ => None,
    }
}

fn text<'v>(v: &'v Value, key: &str) -> Option<&'v str> {
    match get(v, key) {
        Some(Value::String(s)) => Some(s),
        _ => None,
    }
}

fn items(v: &Value) -> &[Value] {
    match v {
        Value::Array(a) => a,
        _ => &[],
    }
}

// ---------------------------------------------------------------- 2.0 的字符集（全是 ASCII，`$` 只认串尾）

fn all(s: &str, ok: impl Fn(u8) -> bool) -> bool {
    s.bytes().all(ok)
}

fn lower_hex(b: u8) -> bool {
    b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
}

/// `APP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/`
fn app_id(s: &str) -> bool {
    let tail = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-';
    (2..=32).contains(&s.len())
        && (s.as_bytes()[0].is_ascii_lowercase() || s.as_bytes()[0].is_ascii_digit())
        && all(s, tail)
}

/// `DEVICE_ID_PATTERN = /^(pc|m)-[0-9a-f]{12}$/`
fn device_id(s: &str) -> bool {
    let rest = s.strip_prefix("pc-").or_else(|| s.strip_prefix("m-"));
    rest.is_some_and(|r| r.len() == 12 && all(r, lower_hex))
}

/// `SPACE_ID_PATTERN = /^[0-9a-f]{24}$/`
fn space_id(s: &str) -> bool {
    s.len() == 24 && all(s, lower_hex)
}

/// `COMMAND_ID_PATTERN = /^(pc|m)-[0-9a-f]{12}\.[0-9a-z]{13}[0-9a-f]{8}$/`
fn command_id(s: &str) -> bool {
    let Some((device, rest)) = s.split_once('.') else {
        return false;
    };
    device_id(device)
        && rest.len() == 21
        && all(&rest[..13], |b| {
            b.is_ascii_digit() || b.is_ascii_lowercase()
        })
        && all(&rest[13..], lower_hex)
}

/// `PROJECT_CODE_PATTERN = /^[A-Z][A-Z0-9_-]{0,31}$/`
fn project_code(s: &str) -> bool {
    let tail = |b: u8| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_' || b == b'-';
    (1..=32).contains(&s.len()) && s.as_bytes()[0].is_ascii_uppercase() && all(s, tail)
}

/// `PROJECT_HASH_PATTERN = /^[0-9a-f]{20}$/`
fn project_hash(s: &str) -> bool {
    s.len() == 20 && all(s, lower_hex)
}

/// `DISPATCH_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u`
fn request_id(s: &str) -> bool {
    let tail = |b: u8| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-');
    (1..=128).contains(&s.len()) && s.as_bytes()[0].is_ascii_alphanumeric() && all(s, tail)
}

/// `DISPATCH_MODEL_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u`
fn dispatch_model(s: &str) -> bool {
    (1..=64).contains(&s.len())
        && all(s, |b| {
            b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')
        })
}

// ---------------------------------------------------------------- 2.0 的 schema

/// `ProjectHeadSchema`（`sync-protocol/src/schemas.ts:80-87`）。
fn project_head(v: &Value) -> Option<Value> {
    let count = int(0.0, MAX_SAFE);
    let counts = |v: &Value| {
        object(
            v,
            &[
                ("active", false, &count),
                ("ready", false, &count),
                ("inProgress", false, &count),
                ("blocked", false, &count),
                ("waitingUser", false, &count),
                ("doneRecent", false, &count),
            ],
            false,
        )
    };
    object(
        v,
        &[
            ("code", false, &pattern(project_code)),
            ("name", false, &string(0, 200)),
            ("h", false, &pattern(project_hash)),
            ("d", false, &string(1, 64)),
            ("counts", false, &counts),
            ("updatedAt", false, &string(1, 64)),
        ],
        false,
    )
}

/// `published: z.record(z.string().regex(PROJECT_CODE_PATTERN), PublishedProjectSchema)`。
fn published(v: &Value) -> Option<Value> {
    let Value::Object(entries) = v else {
        return None;
    };
    let mut out = Vec::new();
    for (code, entry) in entries {
        if !project_code(code) {
            return None;
        }
        let entry = object(
            entry,
            &[
                ("h", false, &any_string),
                ("d", false, &any_string),
                ("head", false, &project_head),
            ],
            false,
        )?;
        out.push((code.clone(), entry));
    }
    Some(Value::Object(out))
}

/// `SyncConfigSchema`（`packages/sync/src/config.ts:41-56`）。
fn sync_config(v: &Value) -> Option<Value> {
    let command = pattern(command_id);
    object(
        v,
        &[
            ("v", false, &literal_one),
            ("enabled", false, &boolean),
            ("relayUrl", false, &nullable(&string(0, 512))),
            ("appId", false, &pattern(app_id)),
            ("deviceId", false, &pattern(device_id)),
            ("deviceName", false, &string(1, 64)),
            ("spaceId", false, &nullable(&pattern(space_id))),
            ("cursor", false, &nullable(&string(0, 512))),
            ("published", false, &published),
            ("headDigest", false, &nullable(&any_string)),
            ("processed", false, &array_of(&command, 2000)),
            ("lastSyncAt", false, &nullable(&any_string)),
            ("lastAckSweepAt", false, &nullable(&any_string)),
        ],
        false,
    )
}

const PERMISSION_MODES: &[&str] = &["auto", "acceptEdits", "bypassPermissions", "plan"];
const EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

/// `DispatchConfigSchema`（`agent-dispatch/src/config.ts:19-27`，strict）。
fn dispatch_config(v: &Value) -> Option<Value> {
    object(
        v,
        &[
            ("enabled", false, &boolean),
            ("permissionMode", false, &one_of(PERMISSION_MODES)),
            ("maxConcurrent", false, &int(1.0, 3.0)),
            ("model", false, &nullable(&pattern(dispatch_model))),
            ("effort", false, &nullable(&one_of(EFFORTS))),
        ],
        true,
    )
}

/// `DEFAULT_DISPATCH_CONFIG`。
fn default_dispatch_config() -> Value {
    Value::Object(vec![
        ("enabled".into(), Value::Bool(false)),
        ("permissionMode".into(), Value::String("auto".into())),
        ("maxConcurrent".into(), Value::Number(1.0)),
        ("model".into(), Value::Null),
        ("effort".into(), Value::Null),
    ])
}

const ORIGINS: &[&str] = &["mobile", "desktop"];
const RUN_STATES: &[&str] = &["queued", "running", "succeeded", "failed", "cancelled"];

/// `RunRecordSchema`（`run-store.ts:17-37`）。
fn run_record(v: &Value) -> Option<Value> {
    let nonempty = string(1, usize::MAX);
    let summary = |v: &Value| {
        object(
            v,
            &[
                ("numTurns", false, &nullable(&number)),
                ("durationMs", false, &nullable(&number)),
                ("totalCostUsd", false, &nullable(&number)),
                ("result", false, &any_string),
            ],
            false,
        )
    };
    object(
        v,
        &[
            ("run", false, &nonempty),
            ("project", false, &nonempty),
            ("key", false, &nonempty),
            ("title", false, &any_string),
            ("origin", false, &one_of(ORIGINS)),
            ("state", false, &one_of(RUN_STATES)),
            ("sessionId", false, &nonempty),
            ("createdAt", false, &any_string),
            ("startedAt", true, &any_string),
            ("endedAt", true, &any_string),
            ("exitCode", true, &nullable(&int(-MAX_SAFE, MAX_SAFE))),
            ("summary", true, &summary),
            ("error", true, &any_string),
            ("cwd", false, &any_string),
            ("requestedBy", true, &any_string),
            ("pid", true, &int(1.0, MAX_SAFE)),
            ("processIdentity", true, &nonempty),
            ("requestId", true, &nonempty),
        ],
        false,
    )
}

/// 快照的键（`SnapshotSchema`，`ledger-file.ts:45-58`）；`snapshotOf(toRunView(record))` 也正好留下这些。
const SNAPSHOT_KEYS: &[&str] = &[
    "run",
    "project",
    "key",
    "title",
    "origin",
    "state",
    "sessionId",
    "createdAt",
    "startedAt",
    "endedAt",
    "exitCode",
    "error",
];

fn snapshot(v: &Value) -> Option<Value> {
    let nonempty = string(1, usize::MAX);
    object(
        v,
        &[
            ("run", false, &nonempty),
            ("project", false, &nonempty),
            ("key", false, &nonempty),
            ("title", false, &any_string),
            ("origin", false, &one_of(ORIGINS)),
            ("state", false, &one_of(RUN_STATES)),
            ("sessionId", false, &nonempty),
            ("createdAt", false, &any_string),
            ("startedAt", true, &any_string),
            ("endedAt", true, &any_string),
            ("exitCode", true, &nullable(&int(-MAX_SAFE, MAX_SAFE))),
            ("error", true, &any_string),
        ],
        false,
    )
}

/// `DISPATCH_ERROR_POLICIES` 的键（`agent-dispatch/src/errors.ts:5-35`）。
const REJECTION_CODES: &[&str] = &[
    "DISPATCH_DISABLED",
    "DISPATCH_INVALID_ARGUMENT",
    "DISPATCH_PROJECT_NOT_FOUND",
    "DISPATCH_PROJECT_PATH_MISSING",
    "DISPATCH_TASK_NOT_FOUND",
    "DISPATCH_TASK_NOT_READY",
    "DISPATCH_ALREADY_ACTIVE",
    "DISPATCH_CLAUDE_NOT_FOUND",
    "DISPATCH_CLAUDE_NOT_LOGGED_IN",
    "DISPATCH_RUN_NOT_FOUND",
    "DISPATCH_RUN_NOT_ACTIVE",
    "DISPATCH_CANCEL_FAILED",
    "DISPATCH_TOO_MANY_REQUESTS",
    "DISPATCH_LEDGER_UNAVAILABLE",
    "DISPATCH_REQUEST_STATE_LOST",
    "DISPATCH_CLOSED",
];

/// `EntrySchema`（`ledger-file.ts:63-74`）：两个对象的 union，取第一个通过的。
fn ledger_entry(v: &Value) -> Option<Value> {
    let id = pattern(request_id);
    let rejected = |v: &Value| {
        object(
            v,
            &[
                ("code", false, &one_of(REJECTION_CODES)),
                ("message", false, &any_string),
            ],
            false,
        )
    };
    object(
        v,
        &[
            ("id", false, &id),
            ("at", false, &any_string),
            ("run", false, &snapshot),
        ],
        false,
    )
    .or_else(|| {
        object(
            v,
            &[
                ("id", false, &id),
                ("at", false, &any_string),
                ("rejected", false, &rejected),
            ],
            false,
        )
    })
}

// ---------------------------------------------------------------- 加载

/// 2.0 读盘的结果（`at` 时刻第一次加载后内存里的状态）。
pub(super) struct Loaded {
    /// `sync/config.json` 的读盘状态：OK / MISSING / CORRUPT。
    sync_state: &'static str,
    /// 只在 OK 时有：去掉未知键的配置。
    sync: Option<Value>,
    /// OK / MISSING / CORRUPT_DEFAULTED。
    dispatch_state: &'static str,
    dispatch: Value,
    runs_state: &'static str,
    /// 合法的 run，文件顺序。
    runs: Vec<Value>,
    damaged: bool,
    requests_since: Option<String>,
    ledger_state: &'static str,
    /// 文件里合法的条目（文件顺序）与水位线。
    file_entries: Vec<Value>,
    file_lost_before: Option<String>,
    /// 读盘时发现的丢失原因。
    loss: Option<&'static str>,
    /// 读盘之后：补回的条目追加在文件条目后面；水位线已按 `at` 落定。
    entries: Vec<Value>,
    lost_before: Option<String>,
    backfilled: usize,
}

pub(super) fn load(root: &Path, at: &str) -> Result<Loaded> {
    if !canonical_utc_millis(at) {
        return Err(ConvertError::Unsupported(format!(
            "the conversion time {at:?} is not in toISOString form"
        )));
    }
    let (sync_state, sync) = match read(root, "sync/config.json")? {
        Parsed::Missing => ("MISSING", None),
        Parsed::Corrupt => ("CORRUPT", None),
        Parsed::Ok(v) => match sync_config(&v) {
            Some(c) => ("OK", Some(c)),
            None => ("CORRUPT", None),
        },
    };
    // 2.0 的 rememberProcessed 不会记重复的命令 ID；真出现了，sync_processed 的唯一键放不下，停下。
    let mut seen = HashSet::new();
    if let Some(dup) = sync
        .iter()
        .flat_map(|c| items(get(c, "processed").unwrap_or(&Value::Null)))
        .find(|id| !seen.insert(jsjson::jcs(id)))
    {
        return Err(unsupported(
            root,
            format!(
                "sync/config.json lists processed command {} twice",
                jsjson::jcs(dup)
            ),
        ));
    }
    let (dispatch_state, dispatch) = match read(root, "dispatch/config.json")? {
        Parsed::Missing => ("MISSING", default_dispatch_config()),
        Parsed::Corrupt => ("CORRUPT_DEFAULTED", default_dispatch_config()),
        Parsed::Ok(v) => match dispatch_config(&v) {
            Some(c) => ("OK", c),
            None => ("CORRUPT_DEFAULTED", default_dispatch_config()),
        },
    };

    // loadRuns
    let (mut runs_state, mut runs, mut damaged, mut requests_since) =
        ("OK", Vec::new(), false, None);
    let runs_file = |v: &Value| {
        object(
            v,
            &[
                ("v", false, &literal_one),
                ("requestsSince", true, &string(1, usize::MAX)),
                ("runs", false, &any_array),
            ],
            false,
        )
    };
    match read(root, "dispatch/runs.json")? {
        Parsed::Missing => runs_state = "MISSING",
        Parsed::Corrupt => (runs_state, damaged) = ("CORRUPT", true),
        Parsed::Ok(v) => match runs_file(&v) {
            None => (runs_state, damaged) = ("CORRUPT", true),
            Some(file) => {
                requests_since = text(&file, "requestsSince").map(String::from);
                for entry in items(get(&file, "runs").unwrap_or(&Value::Null)) {
                    match run_record(entry) {
                        Some(r) => runs.push(r),
                        None => damaged = true,
                    }
                }
            }
        },
    }
    let mut seen = HashSet::new();
    if let Some(dup) = runs
        .iter()
        .filter_map(|r| text(r, "run"))
        .find(|id| !seen.insert(*id))
    {
        return Err(unsupported(
            root,
            format!("dispatch/runs.json lists run {dup:?} twice"),
        ));
    }

    // loadLedgerFile
    let ledger_file = |v: &Value| {
        object(
            v,
            &[
                ("v", false, &literal_one),
                ("lostBefore", true, &any_string),
                ("requests", false, &any_array),
            ],
            false,
        )
    };
    let (mut ledger_state, mut file_entries, mut file_lost_before, mut loss) =
        ("OK", Vec::new(), None::<String>, None);
    match read(root, "dispatch/requests.json")? {
        Parsed::Missing => {
            ledger_state = "MISSING";
            let used = requests_since.is_some()
                || runs
                    .iter()
                    .any(|r| get(r, "requestId").is_some() || text(r, "origin") == Some("mobile"));
            if damaged || used {
                loss = Some(
                    "the ledger is missing although phone dispatch was used (or the history is damaged)",
                );
            }
        }
        Parsed::Corrupt => (ledger_state, loss) = ("CORRUPT", Some("the ledger is corrupt")),
        Parsed::Ok(v) => match ledger_file(&v) {
            None => (ledger_state, loss) = ("CORRUPT", Some("the ledger is corrupt")),
            Some(file) => {
                if let Some(mark) = text(&file, "lostBefore") {
                    // Date.parse 的完整语义不复现：toISOString 的形状之外一律停下，不猜。
                    if !canonical_utc_millis(mark) {
                        return Err(unsupported(
                            root,
                            format!(
                                "dispatch/requests.json: lostBefore {mark:?} is not in toISOString form"
                            ),
                        ));
                    }
                    file_lost_before = Some(mark.to_string());
                }
                for raw in items(get(&file, "requests").unwrap_or(&Value::Null)) {
                    match ledger_entry(raw) {
                        Some(e) => file_entries.push(e),
                        None => loss = Some("the ledger has an invalid entry"),
                    }
                }
            }
        },
    }
    let mut known = HashSet::new();
    if let Some(dup) = file_entries
        .iter()
        .filter_map(|e| text(e, "id"))
        .find(|id| !known.insert(id.to_string()))
    {
        return Err(unsupported(
            root,
            format!("dispatch/requests.json lists request {dup:?} twice"),
        ));
    }

    // RequestLedger#reload：丢失时水位线取 max(文件里的, 现在)。在 toISOString 的形状里字符串序就是时间序。
    let lost_before = match (loss, &file_lost_before) {
        (Some(_), Some(mark)) if mark.as_str() > at => Some(mark.clone()),
        (Some(_), _) => Some(at.to_string()),
        (None, mark) => mark.clone(),
    };

    // 带 requestId 的历史补回成精确条目；同一个 requestId 出现多次时以创建时间最近的为准
    // （2.0 按 createdAt 的 localeCompare 排序后倒着取；这里只在 toISOString 形状里比较，其余停下）。
    let mut groups: BTreeMap<&str, Vec<(usize, &Value)>> = BTreeMap::new();
    for (i, r) in runs.iter().enumerate() {
        if let Some(id) = text(r, "requestId")
            && !known.contains(id)
        {
            groups.entry(id).or_default().push((i, r));
        }
    }
    let mut entries = file_entries.clone();
    let mut backfilled = 0;
    for (id, group) in groups {
        let winner = if group.len() == 1 {
            group[0].1
        } else {
            let created = |r: &Value| text(r, "createdAt").unwrap_or("").to_string();
            if !group.iter().all(|(_, r)| canonical_utc_millis(&created(r))) {
                return Err(unsupported(
                    root,
                    format!(
                        "dispatch/runs.json: request {id:?} has several runs whose createdAt cannot be ordered"
                    ),
                ));
            }
            group
                .iter()
                .max_by(|a, b| created(a.1).cmp(&created(b.1)).then(a.0.cmp(&b.0)))
                .map(|(_, r)| *r)
                .unwrap_or(group[0].1)
        };
        let snapshot: Vec<(String, Value)> = SNAPSHOT_KEYS
            .iter()
            .filter_map(|k| get(winner, k).map(|v| (k.to_string(), v.clone())))
            .collect();
        entries.push(Value::Object(vec![
            ("id".into(), Value::String(id.into())),
            (
                "at".into(),
                get(winner, "createdAt").cloned().unwrap_or(Value::Null),
            ),
            ("run".into(), Value::Object(snapshot)),
        ]));
        backfilled += 1;
    }

    Ok(Loaded {
        sync_state,
        sync,
        dispatch_state,
        dispatch,
        runs_state,
        runs,
        damaged,
        requests_since,
        ledger_state,
        file_entries,
        file_lost_before,
        loss,
        entries,
        lost_before,
        backfilled,
    })
}

// ---------------------------------------------------------------- 日志

/// `dispatch/logs/` 下一个文件所属的 run：`/^(.+?)\.(?:jsonl|stderr\.log)$/u`。
fn log_run(name: &str) -> Option<&str> {
    name.strip_suffix(".stderr.log")
        .or_else(|| name.strip_suffix(".jsonl"))
        .filter(|run| !run.is_empty())
}

pub(super) struct Logs {
    /// 非运行中的 run 的日志（F6，复制）。
    pub finals: Vec<(String, PathBuf, u64)>,
    /// 运行中的 run 的日志（F7，原地只读）。
    pub running: Vec<(String, PathBuf, u64)>,
    /// 历史里没有的 run 的日志（X9）。
    pub orphans: Vec<(String, PathBuf, u64)>,
}

pub(super) fn classify_logs(root: &Path, loaded: &Loaded) -> Result<Logs> {
    let states: BTreeMap<&str, &str> = loaded
        .runs
        .iter()
        .filter_map(|r| Some((text(r, "run")?, text(r, "state")?)))
        .collect();
    let mut logs = Logs {
        finals: Vec::new(),
        running: Vec::new(),
        orphans: Vec::new(),
    };
    for f in super::root::walk(&root.join("dispatch").join("logs"))? {
        let run = (!f.0.contains('/')).then(|| log_run(&f.0)).flatten();
        let Some(run) = run else {
            return Err(unsupported(
                root,
                format!("unregistered entry dispatch/logs/{}", f.0),
            ));
        };
        match states.get(run) {
            Some(&"running") => logs.running.push(f),
            Some(_) => logs.finals.push(f),
            None => logs.orphans.push(f),
        }
    }
    Ok(logs)
}

// ---------------------------------------------------------------- 转换

fn jcs(v: &Value) -> String {
    jsjson::jcs(v)
}

fn opt_text(v: &Value, key: &str) -> Option<String> {
    text(v, key).map(String::from)
}

fn opt_int(v: &Value, key: &str) -> Option<i64> {
    match get(v, key) {
        Some(Value::Number(x)) => Some(*x as i64),
        _ => None,
    }
}

fn flag(v: &Value, key: &str) -> bool {
    matches!(get(v, key), Some(Value::Bool(true)))
}

/// 转换阶段：写 sync / dispatch 的表，复制密文与非运行中的日志。在目标库已提交之后做。
pub(super) fn convert(
    t: &mut Connection,
    root: &Path,
    out: &Path,
    at: &str,
    report: &mut Report,
) -> Result<()> {
    let loaded = load(root, at)?;
    let logs = classify_logs(root, &loaded)?;
    let tx = t.transaction()?;
    let ctx = |table: &'static str| {
        move |error: rusqlite::Error| ConvertError::Constraint {
            table: table.into(),
            error,
        }
    };

    if let Some(c) = &loaded.sync {
        tx.execute(
            "INSERT INTO sync_state (singleton, v, enabled, relay_url, app_id, device_id, device_name, space_id,
                                     cursor, head_digest, last_sync_at, last_ack_sweep_at, updated_at)
             VALUES (1, 1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                flag(c, "enabled"),
                opt_text(c, "relayUrl"),
                opt_text(c, "appId"),
                opt_text(c, "deviceId"),
                opt_text(c, "deviceName"),
                opt_text(c, "spaceId"),
                opt_text(c, "cursor"),
                opt_text(c, "headDigest"),
                opt_text(c, "lastSyncAt"),
                opt_text(c, "lastAckSweepAt"),
                at
            ],
        )
        .map_err(ctx("sync_state"))?;
        for (ord, id) in items(get(c, "processed").unwrap_or(&Value::Null))
            .iter()
            .enumerate()
        {
            let Value::String(id) = id else { continue };
            tx.execute(
                "INSERT INTO sync_processed (ord, command_id) VALUES (?1, ?2)",
                params![ord as i64, id],
            )
            .map_err(ctx("sync_processed"))?;
        }
        if let Some(Value::Object(entries)) = get(c, "published") {
            for (code, entry) in entries {
                tx.execute(
                    "INSERT INTO sync_published (project_code, h, d, head_json) VALUES (?1, ?2, ?3, ?4)",
                    params![
                        code,
                        opt_text(entry, "h"),
                        opt_text(entry, "d"),
                        get(entry, "head").map(jcs)
                    ],
                )
                .map_err(ctx("sync_published"))?;
            }
        }
    }
    if loaded.sync_state == "CORRUPT" {
        report.notes.push(
            "sync/config.json is corrupt or invalid; like 2.0 the converted store starts unpaired from defaults"
                .into(),
        );
    }

    let d = &loaded.dispatch;
    tx.execute(
        "INSERT INTO dispatch_config (singleton, enabled, permission_mode, max_concurrent, model, effort, source_state, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            flag(d, "enabled"),
            opt_text(d, "permissionMode"),
            opt_int(d, "maxConcurrent"),
            opt_text(d, "model"),
            opt_text(d, "effort"),
            loaded.dispatch_state,
            at
        ],
    )
    .map_err(ctx("dispatch_config"))?;
    if loaded.dispatch_state == "CORRUPT_DEFAULTED" {
        report.notes.push("dispatch/config.json is corrupt or invalid; defaults are used (2.0 does not rewrite it)".into());
    }

    tx.execute(
        "INSERT INTO dispatch_meta (singleton, requests_since, lost_before, runs_damaged_at_conversion) VALUES (1, ?1, ?2, ?3)",
        params![loaded.requests_since, loaded.lost_before, loaded.damaged],
    )
    .map_err(ctx("dispatch_meta"))?;
    if loaded.damaged {
        report.notes.push(format!(
            "dispatch/runs.json: {}; history starts from what could be read",
            if loaded.runs_state == "CORRUPT" {
                "the file is corrupt"
            } else {
                "invalid runs were dropped"
            }
        ));
    }

    for r in &loaded.runs {
        let state = text(r, "state").unwrap_or("");
        tx.execute(
            "INSERT INTO dispatch_runs (run, project_code, task_key, title, task_id, origin, state, session_id, created_at,
                                        started_at, ended_at, exit_code, exit_code_set, summary_json, error, cwd,
                                        requested_by, pid, process_identity, request_id, log_root)
             VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
            params![
                opt_text(r, "run"),
                opt_text(r, "project"),
                opt_text(r, "key"),
                opt_text(r, "title"),
                opt_text(r, "origin"),
                state,
                opt_text(r, "sessionId"),
                opt_text(r, "createdAt"),
                opt_text(r, "startedAt"),
                opt_text(r, "endedAt"),
                opt_int(r, "exitCode"),
                get(r, "exitCode").is_some(),
                get(r, "summary").map(jcs),
                opt_text(r, "error"),
                opt_text(r, "cwd"),
                opt_text(r, "requestedBy"),
                opt_int(r, "pid"),
                opt_text(r, "processIdentity"),
                opt_text(r, "requestId"),
                if state == "running" { "LEGACY" } else { "CURRENT" }
            ],
        )
        .map_err(ctx("dispatch_runs"))?;
    }
    // R5：派单指向的任务补上实体 id；解析不到的计数。
    tx.execute(
        "UPDATE dispatch_runs SET task_id = (
           SELECT w.id FROM work_items w JOIN projects p ON p.id = w.project_id
           WHERE p.code = dispatch_runs.project_code
             AND dispatch_runs.task_key = p.code || '-T-' || printf('%04d', w.local_no))",
        [],
    )?;
    let unresolved: i64 = tx.query_row(
        "SELECT count(*) FROM dispatch_runs WHERE task_id IS NULL",
        [],
        |r| r.get(0),
    )?;
    if unresolved > 0 {
        report.notes.push(format!("dispatch_runs: {unresolved} runs point to a task that does not resolve; task_id left NULL"));
    }

    for e in &loaded.entries {
        let rejected = get(e, "rejected");
        tx.execute(
            "INSERT INTO dispatch_requests (id, at, run_snapshot_json, rejected_code, rejected_message)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                opt_text(e, "id"),
                opt_text(e, "at"),
                get(e, "run").map(jcs),
                rejected.and_then(|r| opt_text(r, "code")),
                rejected.and_then(|r| opt_text(r, "message"))
            ],
        )
        .map_err(ctx("dispatch_requests"))?;
    }
    if let Some(why) = loaded.loss {
        report.notes.push(format!(
            "dispatch/requests.json: {why}; lost_before set to {}",
            loaded.lost_before.as_deref().unwrap_or("")
        ));
    }
    if loaded.backfilled > 0 {
        report.notes.push(format!(
            "dispatch/requests.json: {} requests restored from the run history",
            loaded.backfilled
        ));
    }
    tx.commit()?;

    // 文件：密文逐字节复制；非运行中的日志复制。
    let secrets = root.join("sync").join("secrets.dpapi.json");
    if secrets.is_file() {
        let to = out.join("sync").join("secrets.dpapi.json");
        std::fs::create_dir_all(out.join("sync"))?;
        crate::progress::copy_path(&secrets, &to)?;
    }
    if !logs.finals.is_empty() {
        let dir = out.join("dispatch").join("logs");
        std::fs::create_dir_all(&dir)?;
        for (name, path, _) in &logs.finals {
            crate::progress::copy_path(path, &dir.join(name))?;
        }
    }
    if !logs.orphans.is_empty() {
        report.notes.push(format!(
            "dispatch/logs: {} files belong to runs that are not in the history; 2.0 deletes them on its next save, not copied",
            logs.orphans.len()
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------- VERIFY

fn sha_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn obj(fields: Vec<(&str, Value)>) -> Value {
    Value::Object(
        fields
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect(),
    )
}

fn s(v: Option<String>) -> Value {
    v.map_or(Value::Null, Value::String)
}

fn sorted_by(list: &[Value], key: &str) -> Vec<Value> {
    let mut list = list.to_vec();
    list.sort_by(|a, b| text(a, key).cmp(&text(b, key)));
    list
}

fn parse_json(root: &Path, what: &str, text: &str) -> Result<Value> {
    match jsjson::parse_value(text) {
        Ok(Some(v)) => Ok(v),
        _ => Err(unsupported(
            root,
            format!("{what}: the stored JSON does not parse"),
        )),
    }
}

/// 一项检查：两边的规范值比 JCS 摘要；不等时按 `key` 逐个元素找第一处不同（`list` 给出元素数组所在的键）。
fn check(
    report: &mut Report,
    spec: &'static str,
    label: &str,
    source: &Value,
    target: &Value,
    list: Option<(&str, &str)>,
    rows: (i64, i64),
) {
    let (sd, td) = (
        sha_hex(jcs(source).as_bytes()),
        sha_hex(jcs(target).as_bytes()),
    );
    let (mut errors, mut first) = (0i64, None);
    if sd != td {
        if let Some((field, key)) = list {
            let index = |v: &Value| -> BTreeMap<String, String> {
                items(get(v, field).unwrap_or(&Value::Null))
                    .iter()
                    .map(|e| (text(e, key).unwrap_or("").to_string(), jcs(e)))
                    .collect()
            };
            let (a, b) = (index(source), index(target));
            for k in a.keys().chain(b.keys().filter(|k| !a.contains_key(*k))) {
                if a.get(k) != b.get(k) {
                    errors += 1;
                    first.get_or_insert_with(|| format!("{label}({})", json_string(k)));
                }
            }
        }
        if errors == 0 {
            errors = 1;
            first = Some(label.to_string());
        }
    }
    report.checks.push(FamilyCheck {
        family: label.to_string(),
        spec,
        scope: "root".into(),
        source_rows: rows.0,
        target_rows: rows.1,
        source_digest: sd,
        target_digest: td,
        errors,
        first_failure_locator: first,
    });
}

fn source_digest(
    report: &mut Report,
    spec: &'static str,
    rows: i64,
    state: &str,
    value: Value,
    bytes: Option<i64>,
) {
    let v = obj(vec![
        ("parseState", Value::String(state.into())),
        ("value", value),
    ]);
    report.sources.push(SourceDigest {
        spec,
        scope: "root".into(),
        rows,
        digest: sha_hex(jcs(&v).as_bytes()),
        bytes,
    });
}

fn file_len(root: &Path, rel: &str) -> Option<i64> {
    std::fs::metadata(root.join(rel))
        .ok()
        .map(|m| m.len() as i64)
}

fn num(x: Option<i64>) -> Value {
    x.map_or(Value::Null, |x| Value::Number(x as f64))
}

/// VERIFY 的 sync / dispatch 部分。`at` 取目标库记下的转换时刻。
pub(super) fn verify(c: &Connection, root: &Path, out: &Path, report: &mut Report) -> Result<()> {
    let at: String = c.query_row(
        "SELECT converted_from ->> '$.convertedAt' FROM main.app_meta",
        [],
        |r| r.get(0),
    )?;
    let loaded = load(root, &at)?;
    let logs = classify_logs(root, &loaded)?;
    let parse_state = |s: &'static str| {
        if s == "CORRUPT_DEFAULTED" {
            "CORRUPT"
        } else {
            s
        }
    };

    // F1：sync/config.json。
    let source = match &loaded.sync {
        Some(cfg) => obj(vec![
            ("state", Value::String("OK".into())),
            ("config", cfg.clone()),
        ]),
        None => obj(vec![("state", Value::String("DEFAULTED".into()))]),
    };
    source_digest(
        report,
        "sync.config",
        i64::from(loaded.sync.is_some()),
        loaded.sync_state,
        loaded.sync.clone().unwrap_or(Value::Null),
        file_len(root, "sync/config.json"),
    );
    let row = c
        .query_row(
            "SELECT v, enabled, relay_url, app_id, device_id, device_name, space_id, cursor, head_digest,
                    last_sync_at, last_ack_sweep_at FROM main.sync_state",
            [],
            |r| {
                Ok(obj(vec![
                    ("v", Value::Number(r.get::<_, i64>(0)? as f64)),
                    ("enabled", Value::Bool(r.get(1)?)),
                    ("relayUrl", s(r.get(2)?)),
                    ("appId", s(r.get(3)?)),
                    ("deviceId", s(r.get(4)?)),
                    ("deviceName", s(r.get(5)?)),
                    ("spaceId", s(r.get(6)?)),
                    ("cursor", s(r.get(7)?)),
                    ("headDigest", s(r.get(8)?)),
                    ("lastSyncAt", s(r.get(9)?)),
                    ("lastAckSweepAt", s(r.get(10)?)),
                ]))
            },
        )
        .optional()?;
    let (target, target_rows) = match row {
        None => (obj(vec![("state", Value::String("DEFAULTED".into()))]), 0),
        Some(Value::Object(mut fields)) => {
            let processed: Vec<Value> = c
                .prepare("SELECT command_id FROM main.sync_processed ORDER BY ord")?
                .query_map([], |r| r.get::<_, String>(0))?
                .map(|r| r.map(Value::String))
                .collect::<rusqlite::Result<_>>()?;
            let mut published = Vec::new();
            let rows: Vec<(String, String, String, String)> = c
                .prepare("SELECT project_code, h, d, head_json FROM main.sync_published ORDER BY project_code")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                .collect::<rusqlite::Result<_>>()?;
            for (code, h, d, head) in rows {
                let head = parse_json(root, "sync_published.head_json", &head)?;
                published.push((
                    code,
                    obj(vec![
                        ("h", Value::String(h)),
                        ("d", Value::String(d)),
                        ("head", head),
                    ]),
                ));
            }
            fields.push(("processed".into(), Value::Array(processed)));
            fields.push(("published".into(), Value::Object(published)));
            (
                obj(vec![
                    ("state", Value::String("OK".into())),
                    ("config", Value::Object(fields)),
                ]),
                1,
            )
        }
        Some(_) => unreachable!(),
    };
    check(
        report,
        "sync.config",
        "r/sync.config",
        &source,
        &target,
        None,
        (i64::from(loaded.sync.is_some()), target_rows),
    );

    // F2：密文逐字节相等。
    let secrets = root.join("sync").join("secrets.dpapi.json");
    let copied = out.join("sync").join("secrets.dpapi.json");
    let (sd, td) = (
        secrets
            .is_file()
            .then(|| file_sha256(&secrets))
            .transpose()?,
        copied.is_file().then(|| file_sha256(&copied)).transpose()?,
    );
    report.sources.push(SourceDigest {
        spec: "sync.secrets",
        scope: "root".into(),
        rows: i64::from(sd.is_some()),
        digest: sd.clone().unwrap_or_default(),
        bytes: file_len(root, "sync/secrets.dpapi.json"),
    });
    report.checks.push(FamilyCheck {
        family: "r/sync.secrets".into(),
        spec: "sync.secrets",
        scope: "root".into(),
        source_rows: i64::from(sd.is_some()),
        target_rows: i64::from(td.is_some()),
        errors: i64::from(sd != td),
        first_failure_locator: (sd != td).then(|| "r/sync.secrets".to_string()),
        source_digest: sd.unwrap_or_default(),
        target_digest: td.unwrap_or_default(),
    });

    // F3：dispatch/config.json。
    let source = obj(vec![
        ("state", Value::String(loaded.dispatch_state.into())),
        ("config", loaded.dispatch.clone()),
    ]);
    source_digest(
        report,
        "dispatch.config",
        1,
        parse_state(loaded.dispatch_state),
        loaded.dispatch.clone(),
        file_len(root, "dispatch/config.json"),
    );
    let target = c
        .query_row(
            "SELECT enabled, permission_mode, max_concurrent, model, effort, source_state FROM main.dispatch_config",
            [],
            |r| {
                Ok(obj(vec![
                    ("state", Value::String(r.get(5)?)),
                    (
                        "config",
                        obj(vec![
                            ("enabled", Value::Bool(r.get(0)?)),
                            ("permissionMode", s(r.get(1)?)),
                            ("maxConcurrent", num(r.get(2)?)),
                            ("model", s(r.get(3)?)),
                            ("effort", s(r.get(4)?)),
                        ]),
                    ),
                ]))
            },
        )
        .optional()?
        .unwrap_or(Value::Null);
    let rows = i64::from(target != Value::Null);
    check(
        report,
        "dispatch.config",
        "r/dispatch.config",
        &source,
        &target,
        None,
        (1, rows),
    );

    // F4：runs。文件里的顺序按 createdAt 的 localeCompare 排，这里按 run 排，两边一样。
    let runs_value = |since: Option<String>, damaged: bool, runs: &[Value]| {
        obj(vec![
            ("requestsSince", s(since)),
            ("damaged", Value::Bool(damaged)),
            ("runs", Value::Array(sorted_by(runs, "run"))),
        ])
    };
    let source = runs_value(loaded.requests_since.clone(), loaded.damaged, &loaded.runs);
    source_digest(
        report,
        "dispatch.runs",
        loaded.runs.len() as i64,
        loaded.runs_state,
        source.clone(),
        file_len(root, "dispatch/runs.json"),
    );
    let (since, damaged): (Option<String>, bool) = c
        .query_row(
            "SELECT requests_since, runs_damaged_at_conversion FROM main.dispatch_meta",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .unwrap_or((None, false));
    type RunRow = (
        Vec<Option<String>>,
        Option<i64>,
        bool,
        Option<String>,
        Option<i64>,
    );
    let rows: Vec<RunRow> = c
        .prepare(
            "SELECT run, project_code, task_key, title, origin, state, session_id, created_at, started_at, ended_at,
                    error, cwd, requested_by, process_identity, request_id,
                    exit_code, exit_code_set, summary_json, pid
             FROM main.dispatch_runs ORDER BY run",
        )?
        .query_map([], |r| {
            Ok((
                (0..15).map(|i| r.get::<_, Option<String>>(i)).collect::<rusqlite::Result<_>>()?,
                r.get(15)?,
                r.get(16)?,
                r.get(17)?,
                r.get(18)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut target_runs = Vec::new();
    const TEXT_KEYS: [(&str, bool); 15] = [
        ("run", false),
        ("project", false),
        ("key", false),
        ("title", false),
        ("origin", false),
        ("state", false),
        ("sessionId", false),
        ("createdAt", false),
        ("startedAt", true),
        ("endedAt", true),
        ("error", true),
        ("cwd", false),
        ("requestedBy", true),
        ("processIdentity", true),
        ("requestId", true),
    ];
    for (texts, exit_code, exit_set, summary, pid) in rows {
        let mut fields = Vec::new();
        for ((key, optional), value) in TEXT_KEYS.iter().zip(texts) {
            match value {
                Some(v) => fields.push((key.to_string(), Value::String(v))),
                None if *optional => {}
                None => fields.push((key.to_string(), Value::Null)),
            }
        }
        if exit_set {
            fields.push(("exitCode".into(), num(exit_code)));
        }
        if let Some(summary) = summary {
            fields.push((
                "summary".into(),
                parse_json(root, "dispatch_runs.summary_json", &summary)?,
            ));
        }
        if let Some(pid) = pid {
            fields.push(("pid".into(), Value::Number(pid as f64)));
        }
        target_runs.push(Value::Object(fields));
    }
    let target = runs_value(since, damaged, &target_runs);
    check(
        report,
        "dispatch.runs",
        "r/dispatch.runs",
        &source,
        &target,
        Some(("runs", "run")),
        (loaded.runs.len() as i64, target_runs.len() as i64),
    );

    // F5：请求账本（读盘之后的状态：补回的条目与落定的水位线）。
    let ledger_value = |lost: Option<String>, entries: &[Value]| {
        obj(vec![
            ("lostBefore", s(lost)),
            ("requests", Value::Array(sorted_by(entries, "id"))),
        ])
    };
    source_digest(
        report,
        "dispatch.requests",
        loaded.file_entries.len() as i64,
        loaded.ledger_state,
        ledger_value(loaded.file_lost_before.clone(), &loaded.file_entries),
        file_len(root, "dispatch/requests.json"),
    );
    let source = ledger_value(loaded.lost_before.clone(), &loaded.entries);
    let lost: Option<String> = c
        .query_row("SELECT lost_before FROM main.dispatch_meta", [], |r| {
            r.get(0)
        })
        .optional()?
        .flatten();
    // (id, at, run_snapshot_json, rejected_code, rejected_message)
    type RequestRow = (
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let rows: Vec<RequestRow> = c
        .prepare("SELECT id, at, run_snapshot_json, rejected_code, rejected_message FROM main.dispatch_requests ORDER BY id")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut target_entries = Vec::new();
    for (id, at, run, code, message) in rows {
        let outcome = match run {
            Some(run) => (
                "run",
                parse_json(root, "dispatch_requests.run_snapshot_json", &run)?,
            ),
            None => (
                "rejected",
                obj(vec![("code", s(code)), ("message", s(message))]),
            ),
        };
        target_entries.push(obj(vec![
            ("id", Value::String(id)),
            ("at", Value::String(at)),
            outcome,
        ]));
    }
    let target = ledger_value(lost, &target_entries);
    check(
        report,
        "dispatch.requests",
        "r/dispatch.requests",
        &source,
        &target,
        Some(("requests", "id")),
        (loaded.entries.len() as i64, target_entries.len() as i64),
    );

    // F6：非运行中的日志，(名, size, sha256) 集合相等。
    let source: Vec<(String, u64, String)> = logs
        .finals
        .iter()
        .map(|(name, path, size)| Ok((name.clone(), *size, file_sha256(path)?)))
        .collect::<Result<_>>()?;
    let target = super::root::hashed(&out.join("dispatch").join("logs"))?;
    report.sources.push(SourceDigest {
        spec: "dispatch.logs.final",
        scope: "root".into(),
        rows: source.len() as i64,
        digest: super::root::set_digest(&source),
        bytes: Some(source.iter().map(|f| f.1 as i64).sum()),
    });
    super::root::set_check(
        report,
        "dispatch.logs.final",
        "root",
        "r/dispatch.logs",
        &source,
        &target,
    );

    // F7：运行中的日志不复制、不比内容（子进程还在写），只登记数量；对应的 run 必须是 log_root='LEGACY'（见下）。
    // 它们不进快照（W3d），数量按原始根数。
    let running = classify_logs(report.origin(root), &loaded)?.running;
    report.sources.push(SourceDigest {
        spec: "dispatch.logs.running",
        scope: "root".into(),
        rows: running.len() as i64,
        digest: String::new(),
        bytes: Some(running.iter().map(|f| f.2 as i64).sum()),
    });

    // 3.0 自己的列：log_root 由状态决定；task_id 指向的任务公开 key 与 task_key 一致。
    let bad_root: i64 = c.query_row(
        "SELECT count(*) FROM main.dispatch_runs
         WHERE log_root <> CASE state WHEN 'running' THEN 'LEGACY' ELSE 'CURRENT' END",
        [],
        |r| r.get(0),
    )?;
    if bad_root > 0 {
        report.graph_violations.push(format!(
            "dispatch_runs: {bad_root} runs have the wrong log_root"
        ));
    }
    let bad_task: Option<String> = c
        .query_row(
            "SELECT d.run FROM main.dispatch_runs d
             WHERE d.task_id IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM main.work_items w JOIN main.projects p ON p.id = w.project_id
               WHERE w.id = d.task_id AND p.code = d.project_code
                 AND d.task_key = p.code || '-T-' || printf('%04d', w.local_no))
             ORDER BY d.run LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(run) = bad_task {
        report.graph_violations.push(format!(
            "dispatch_runs: {run} task_id does not match its task_key"
        ));
    }
    Ok(())
}
