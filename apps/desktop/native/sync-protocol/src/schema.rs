//! 解密后的明文结构（`schemas.ts`，zod）。照 zod 的语义写成一张声明表，[`check`] 的结果就是 zod `parse` 的输出：
//! - 不认识的字段丢掉（`strict` 的除外，有就拒绝）；可选字段缺了就缺着，给 `null` 不行；
//! - 字符串长度按 UTF-16 码元；`Trimmed` 先按 JS 的 `trim` 去空白再判长度，输出去过空白的；
//! - `Int` 是安全整数（|n| ≤ 2^53−1），`1.0` 算 1；数字按 JS 的写法输出（整数值写成整数）；
//! - 判别联合按顺序试，第一个合格的就是结果（各分支的判别字段互斥，与 zod 按判别字段选分支等价）。

use serde_json::{Map, Number, Value};

use crate::encoding::{js_len, js_trim};
use crate::keys::{
    is_app_id, is_command_id, is_device_id, is_project_code, is_project_hash, is_space_id,
    is_task_key,
};

/// 手机判定「电脑在线」的窗口。电脑每 5 分钟写一次在线状态。
pub const HOST_ONLINE_WINDOW_MS: u64 = 7 * 60 * 1000;
/// 早于这个时间的命令直接拒绝。
pub const COMMAND_MAX_AGE_MS: u64 = 7 * 24 * 60 * 60 * 1000;

const MAX_SAFE: i64 = (1 << 53) - 1;

pub enum S {
    /// UTF-16 长度在 `min..=max` 的字符串。
    Str {
        min: usize,
        max: usize,
    },
    /// 先 trim 再判长度，输出 trim 过的。
    Trimmed {
        min: usize,
        max: usize,
    },
    /// 满足格式的字符串（对应 TS 的正则）。
    Pat(fn(&str) -> bool),
    Lit(&'static str),
    OneOf(&'static [&'static str]),
    /// 有限数，`min..=max`。
    Num {
        min: f64,
        max: f64,
    },
    /// 安全整数，`min..=max`。
    Int {
        min: i64,
        max: i64,
    },
    /// `z.literal(1)`。
    One,
    Bool,
    BoolLit(bool),
    Obj {
        fields: &'static [F],
        strict: bool,
    },
    Arr {
        item: &'static S,
        max: usize,
    },
    Union(&'static [&'static S]),
}

pub struct F {
    pub name: &'static str,
    pub s: &'static S,
    pub optional: bool,
}

const fn req(name: &'static str, s: &'static S) -> F {
    F {
        name,
        s,
        optional: false,
    }
}

const fn opt(name: &'static str, s: &'static S) -> F {
    F {
        name,
        s,
        optional: true,
    }
}

/// JS 写法的数：整数值（安全范围内）写成整数，`-0` 写成 `0`。
fn js_number(n: f64) -> Option<Value> {
    if n.fract() == 0.0 && n.abs() <= MAX_SAFE as f64 {
        Some(Value::from(n as i64))
    } else {
        Number::from_f64(n).map(Value::Number)
    }
}

/// 按 `s` 校验 `v`，合格时返回 zod 的输出。
pub fn check(s: &S, v: &Value) -> Option<Value> {
    match s {
        S::Str { min, max } => {
            let t = v.as_str()?;
            (min..=max).contains(&&js_len(t)).then(|| v.clone())
        }
        S::Trimmed { min, max } => {
            let t = js_trim(v.as_str()?);
            (min..=max).contains(&&js_len(t)).then(|| Value::from(t))
        }
        S::Pat(ok) => ok(v.as_str()?).then(|| v.clone()),
        S::Lit(x) => (v.as_str()? == *x).then(|| v.clone()),
        S::OneOf(xs) => xs.contains(&v.as_str()?).then(|| v.clone()),
        S::Num { min, max } => {
            let n = v.as_f64()?;
            (n.is_finite() && *min <= n && n <= *max).then(|| js_number(n))?
        }
        S::Int { min, max } => int_in(v, *min, *max).map(Value::from),
        S::One => (v.as_f64()? == 1.0).then(|| Value::from(1)),
        S::Bool => v.as_bool().map(Value::from),
        S::BoolLit(b) => (v.as_bool()? == *b).then(|| Value::from(*b)),
        S::Obj { fields, strict } => {
            let map = v.as_object()?;
            if *strict && map.keys().any(|k| !fields.iter().any(|f| f.name == k)) {
                return None;
            }
            let mut out = Map::new();
            for f in *fields {
                match map.get(f.name) {
                    Some(x) => {
                        out.insert(f.name.to_owned(), check(f.s, x)?);
                    }
                    None if f.optional => {}
                    None => return None,
                }
            }
            Some(Value::Object(out))
        }
        S::Arr { item, max } => {
            let xs = v.as_array()?;
            if xs.len() > *max {
                return None;
            }
            xs.iter()
                .map(|x| check(item, x))
                .collect::<Option<Vec<_>>>()
                .map(Value::Array)
        }
        S::Union(cases) => cases.iter().find_map(|c| check(c, v)),
    }
}

/// 安全整数且在 `min..=max` 里。
pub fn int_in(v: &Value, min: i64, max: i64) -> Option<i64> {
    let n = v.as_f64()?;
    if n.fract() != 0.0 || n.abs() > MAX_SAFE as f64 {
        return None;
    }
    let n = n as i64;
    (min..=max).contains(&n).then_some(n)
}

pub fn is_lower_hex(s: &str) -> bool {
    s.bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 一个 JSON 对象的字段读取（信封与配对码用）。
pub struct Fields<'a>(&'a Map<String, Value>);

impl<'a> Fields<'a> {
    pub fn of(v: &'a Value) -> Option<Fields<'a>> {
        v.as_object().map(Fields)
    }

    pub fn get(&self, k: &str) -> Option<&'a Value> {
        self.0.get(k)
    }

    pub fn str(&self, k: &str) -> Option<&'a str> {
        self.0.get(k)?.as_str()
    }

    pub fn literal_one(&self, k: &str) -> Option<()> {
        (self.0.get(k)?.as_f64()? == 1.0).then_some(())
    }
}

// ---- 表 ----

pub const TASK_STATUSES: &[&str] = &[
    "BACKLOG",
    "READY",
    "CLAIMED",
    "IN_PROGRESS",
    "BLOCKED",
    "WAITING_AGENT",
    "WAITING_USER",
    "VERIFYING",
    "DONE",
    "CANCELLED",
];
pub const TASK_PRIORITIES: &[&str] = &["LOW", "NORMAL", "HIGH", "CRITICAL"];
pub const TASK_TYPES: &[&str] = &["EPIC", "TASK", "SUBTASK", "BUG", "RESEARCH", "REVIEW"];
pub const DISPATCH_STATES: &[&str] = &["queued", "running", "succeeded", "failed", "cancelled"];
pub const PERMISSION_MODES: &[&str] = &["auto", "acceptEdits", "bypassPermissions", "plan"];

static TIMESTAMP: S = S::Str { min: 1, max: 64 };
static TEXT_32: S = S::Str { min: 0, max: 32 };
static TEXT_64: S = S::Str { min: 0, max: 64 };
static TEXT_128: S = S::Str { min: 0, max: 128 };
static TEXT_200: S = S::Str { min: 0, max: 200 };
static TEXT_500: S = S::Str { min: 0, max: 500 };
static TEXT_2000: S = S::Str { min: 0, max: 2000 };
static TEXT_8000: S = S::Str { min: 0, max: 8000 };
static COUNT: S = S::Int {
    min: 0,
    max: MAX_SAFE,
};
static PERCENT: S = S::Num {
    min: 0.0,
    max: 100.0,
};
static ONE: S = S::One;
static BOOL: S = S::Bool;
static TASK_KEY: S = S::Pat(is_task_key);
static PROJECT_CODE: S = S::Pat(is_project_code);
static PROJECT_HASH: S = S::Pat(is_project_hash);
static DEVICE_ID: S = S::Pat(is_device_id);
static COMMAND_ID: S = S::Pat(is_command_id);
static STATUS: S = S::OneOf(TASK_STATUSES);
static PRIORITY: S = S::OneOf(TASK_PRIORITIES);
static TYPE: S = S::OneOf(TASK_TYPES);
static DISPATCH_STATE: S = S::OneOf(DISPATCH_STATES);
static PERMISSION_MODE: S = S::OneOf(PERMISSION_MODES);

static CLAIM: S = S::Obj {
    fields: &[req("agent", &TEXT_128), opt("since", &TIMESTAMP)],
    strict: false,
};
static ACCEPTANCE: S = S::Arr {
    item: &TEXT_500,
    max: 12,
};
static CHECKLIST: S = S::Obj {
    fields: &[req("done", &COUNT), req("total", &COUNT)],
    strict: false,
};
static RECENT_ITEM: S = S::Obj {
    fields: &[
        req("at", &TIMESTAMP),
        req("summary", &TEXT_500),
        opt("percent", &PERCENT),
    ],
    strict: false,
};
static RECENT: S = S::Arr {
    item: &RECENT_ITEM,
    max: 3,
};
static CARD_DISPATCH: S = S::Obj {
    fields: &[
        req("state", &DISPATCH_STATE),
        req("at", &TIMESTAMP),
        req("run", &TEXT_64),
        opt("error", &TEXT_200),
    ],
    strict: false,
};

/// `TaskCardSchema`。
pub static TASK_CARD: S = S::Obj {
    fields: &[
        req("key", &TASK_KEY),
        req("title", &TEXT_500),
        req("type", &TYPE),
        req("status", &STATUS),
        req("priority", &PRIORITY),
        req("progress", &PERCENT),
        opt("parent", &TASK_KEY),
        req("updatedAt", &TIMESTAMP),
        opt("claim", &CLAIM),
        opt("waiting", &TEXT_500),
        opt("blocked", &TEXT_500),
        opt("desc", &TEXT_2000),
        opt("acceptance", &ACCEPTANCE),
        opt("checklist", &CHECKLIST),
        opt("recent", &RECENT),
        opt("dispatch", &CARD_DISPATCH),
    ],
    strict: false,
};

static PROJECT_COUNTS: S = S::Obj {
    fields: &[
        req("active", &COUNT),
        req("ready", &COUNT),
        req("inProgress", &COUNT),
        req("blocked", &COUNT),
        req("waitingUser", &COUNT),
        req("doneRecent", &COUNT),
    ],
    strict: false,
};
static DIGEST_TEXT: S = S::Str { min: 1, max: 64 };

/// `ProjectHeadSchema`。
pub static PROJECT_HEAD: S = S::Obj {
    fields: &[
        req("code", &PROJECT_CODE),
        req("name", &TEXT_200),
        req("h", &PROJECT_HASH),
        req("d", &DIGEST_TEXT),
        req("counts", &PROJECT_COUNTS),
        req("updatedAt", &TIMESTAMP),
    ],
    strict: false,
};

static HEAD_HOST: S = S::Obj {
    fields: &[
        req("id", &DEVICE_ID),
        req("name", &TEXT_64),
        req("app", &TEXT_32),
    ],
    strict: false,
};
static HEAD_DISPATCH: S = S::Obj {
    fields: &[
        req("enabled", &BOOL),
        req("mode", &PERMISSION_MODE),
        req("running", &COUNT),
    ],
    strict: false,
};
static PROJECT_HEADS: S = S::Arr {
    item: &PROJECT_HEAD,
    max: 500,
};

/// `HeadDocSchema`。
pub static HEAD_DOC: S = S::Obj {
    fields: &[
        req("v", &ONE),
        req("host", &HEAD_HOST),
        req("at", &TIMESTAMP),
        req("dispatch", &HEAD_DISPATCH),
        req("projects", &PROJECT_HEADS),
    ],
    strict: false,
};

static TASK_CARDS: S = S::Arr {
    item: &TASK_CARD,
    max: 5000,
};

/// `ProjectDocSchema`。
pub static PROJECT_DOC: S = S::Obj {
    fields: &[
        req("v", &ONE),
        req("code", &PROJECT_CODE),
        req("name", &TEXT_200),
        req("at", &TIMESTAMP),
        req("tasks", &TASK_CARDS),
    ],
    strict: false,
};

static DEVICE_REF: S = S::Obj {
    fields: &[req("id", &DEVICE_ID), req("name", &TEXT_64)],
    strict: false,
};
static TITLE: S = S::Trimmed { min: 1, max: 200 };

/// `TaskCreateBodySchema`。
pub static TASK_CREATE_BODY: S = S::Obj {
    fields: &[
        req("project", &PROJECT_CODE),
        req("title", &TITLE),
        opt("description", &TEXT_8000),
        opt("priority", &PRIORITY),
        opt("dispatch", &BOOL),
    ],
    strict: false,
};

/// `TaskDispatchBodySchema`。
pub static TASK_DISPATCH_BODY: S = S::Obj {
    fields: &[req("project", &PROJECT_CODE), req("key", &TASK_KEY)],
    strict: false,
};

static TYPE_CREATE: S = S::Lit("task.create");
static TYPE_DISPATCH: S = S::Lit("task.dispatch");
static COMMAND_CREATE: S = S::Obj {
    fields: &[
        req("v", &ONE),
        req("id", &COMMAND_ID),
        req("device", &DEVICE_REF),
        req("at", &TIMESTAMP),
        req("type", &TYPE_CREATE),
        req("body", &TASK_CREATE_BODY),
    ],
    strict: false,
};
static COMMAND_DISPATCH: S = S::Obj {
    fields: &[
        req("v", &ONE),
        req("id", &COMMAND_ID),
        req("device", &DEVICE_REF),
        req("at", &TIMESTAMP),
        req("type", &TYPE_DISPATCH),
        req("body", &TASK_DISPATCH_BODY),
    ],
    strict: false,
};

/// `CommandDocSchema`：`task.create` 或 `task.dispatch`。
pub static COMMAND_DOC: S = S::Union(&[&COMMAND_CREATE, &COMMAND_DISPATCH]);

static ACK_DISPATCH: S = S::Obj {
    fields: &[req("run", &TEXT_64), req("state", &DISPATCH_STATE)],
    strict: false,
};
static CODE_MESSAGE: S = S::Obj {
    fields: &[req("code", &TEXT_64), req("message", &TEXT_500)],
    strict: false,
};

/// `AckResultSchema`。派单被拒时任务仍已创建，`dispatchError` 给出原因。
pub static ACK_RESULT: S = S::Obj {
    fields: &[
        req("project", &PROJECT_CODE),
        req("key", &TASK_KEY),
        opt("dispatch", &ACK_DISPATCH),
        opt("dispatchError", &CODE_MESSAGE),
    ],
    strict: false,
};
static TRUE: S = S::BoolLit(true);
static FALSE: S = S::BoolLit(false);
static ACK_OK: S = S::Obj {
    fields: &[
        req("v", &ONE),
        req("id", &COMMAND_ID),
        req("at", &TIMESTAMP),
        req("ok", &TRUE),
        req("result", &ACK_RESULT),
    ],
    strict: false,
};
static ACK_ERR: S = S::Obj {
    fields: &[
        req("v", &ONE),
        req("id", &COMMAND_ID),
        req("at", &TIMESTAMP),
        req("ok", &FALSE),
        req("error", &CODE_MESSAGE),
    ],
    strict: false,
};

/// `AckDocSchema`：`ok: true` 带 `result`，`ok: false` 带 `error`。
pub static ACK_DOC: S = S::Union(&[&ACK_OK, &ACK_ERR]);

static DEVICE_KIND: S = S::OneOf(&["windows", "android", "other"]);
static DEVICE_ROLE: S = S::OneOf(&["host", "client"]);
static DEVICE_STATE: S = S::OneOf(&["online", "offline"]);

/// `DeviceDocSchema`。
pub static DEVICE_DOC: S = S::Obj {
    fields: &[
        req("v", &ONE),
        req("id", &DEVICE_ID),
        req("name", &TEXT_64),
        req("kind", &DEVICE_KIND),
        req("role", &DEVICE_ROLE),
        req("app", &TEXT_32),
        req("at", &TIMESTAMP),
        req("state", &DEVICE_STATE),
    ],
    strict: false,
};

/// `RevokedDocSchema`（严格：多一个字段都不行）。能解开就说明是持有这份密钥的一方写的。
pub static REVOKED_DOC: S = S::Obj {
    fields: &[
        req("v", &ONE),
        req("at", &TIMESTAMP),
        req("host", &DEVICE_REF),
    ],
    strict: true,
};

static RELAY_URL: S = S::Str { min: 1, max: 512 };
static APP_ID: S = S::Pat(is_app_id);
static RELAY_TOKEN: S = S::Str { min: 8, max: 512 };
static SPACE_ID: S = S::Pat(is_space_id);
static SPACE_SECRET: S = S::Str { min: 43, max: 43 };

/// `PairingPayloadSchema`。
pub static PAIRING_PAYLOAD: S = S::Obj {
    fields: &[
        req("v", &ONE),
        req("u", &RELAY_URL),
        req("a", &APP_ID),
        req("t", &RELAY_TOKEN),
        req("s", &SPACE_ID),
        req("k", &SPACE_SECRET),
        req("n", &TEXT_64),
    ],
    strict: false,
};

/// 按名字取表（向量用）。
pub fn by_name(name: &str) -> Option<&'static S> {
    Some(match name {
        "TaskCard" => &TASK_CARD,
        "ProjectHead" => &PROJECT_HEAD,
        "HeadDoc" => &HEAD_DOC,
        "ProjectDoc" => &PROJECT_DOC,
        "TaskCreateBody" => &TASK_CREATE_BODY,
        "TaskDispatchBody" => &TASK_DISPATCH_BODY,
        "CommandDoc" => &COMMAND_DOC,
        "AckResult" => &ACK_RESULT,
        "AckDoc" => &ACK_DOC,
        "DeviceDoc" => &DEVICE_DOC,
        "RevokedDoc" => &REVOKED_DOC,
        "PairingPayload" => &PAIRING_PAYLOAD,
        _ => return None,
    })
}
