//! 手写描述表驱动的工具参数（W4c；R11 P1-4，11 §4、§5 U-5）。
//!
//! 一张表同时产出三样东西，所以三者不会走样：
//! - `tools/list` 的 `inputSchema`：只有类型、枚举与必填（不用 `$ref`，不写 `additionalProperties:false`
//!   ——别名和大小写由服务端规范化，客户端侧的严格校验只会把它们挡在门外）；
//! - 工具说明末尾自动生成的「必填 / 枚举 / 上限」一行（客户端常把 required、enum、default 渲染丢，U-5）；
//! - 服务端校验器：别名改成规范名、枚举不分大小写、显式 `null` 视同省略、未知键带 `did_you_mean`。
//!
//! 校验器只做形状；跨字段约束挂在 [`Tool::check`] 上，业务规则仍在 service。

use atm_domain::error::{Problem, ProblemKind};
use serde_json::{Map, Value, json};

/// 参数类型。
#[derive(Clone, Copy, Debug)]
pub enum Ty {
    /// 字符串；`max` 按 code point 计，0 表示不设上限。
    Str {
        max: usize,
    },
    /// 非空字符串（去掉首尾空白后不能为空）。
    Text {
        max: usize,
    },
    Int {
        min: i64,
        max: i64,
    },
    /// 数；`min`、`max` 都含端点。
    Num {
        min: f64,
        max: f64,
    },
    Bool,
    /// 大小写不敏感的枚举，规范化成表里的写法。
    Enum(&'static [&'static str]),
    /// 同 `Enum`，另外照收第二张表里的旧写法（不发布、不改写，交给映射层分派）。
    EnumPlus(&'static [&'static str], &'static [&'static str]),
    /// 布尔，或者表里的某个字符串（例如 `resume`：true / false / "auto"）。
    BoolOr(&'static [&'static str]),
    List {
        of: &'static Ty,
        max: usize,
    },
    Obj(&'static [Field]),
    /// 非空文本，或者一个对象（证据：`"pytest 全绿"` 或 `{kind, value}`）。
    TextOr {
        max: usize,
        obj: &'static [Field],
    },
    /// 任意 JSON，形状由 service 判断。
    Any,
}

/// 一个参数。
#[derive(Clone, Copy, Debug)]
pub struct Field {
    pub name: &'static str,
    /// 也接受的旧名或常见猜法；出现时改成 `name` 并记一条 `normalized`。
    pub aliases: &'static [&'static str],
    pub ty: Ty,
    pub required: bool,
    /// 默认值的 JSON 文本；只用于说明与 schema，服务端的默认由 service 决定。
    pub default: Option<&'static str>,
    /// 只收不发布：旧调用照常可用，但 schema 与说明里不出现（为 U-7 的字节预算让位）。
    pub hidden: bool,
    /// 紧凑发布：列表只写「对象数组」，说明里用这句话代替逐字段展开（task_patch 的 `items` 与顶层同形）。
    pub compact: Option<&'static str>,
    /// 显式 `null` 有意义（edit 的「清空」）：保留在参数里，schema 写成 `[类型, "null"]`。其余字段的 `null` 视同省略。
    pub nullable: bool,
}

impl Field {
    pub const fn new(name: &'static str, ty: Ty) -> Field {
        Field {
            name,
            aliases: &[],
            ty,
            required: false,
            default: None,
            hidden: false,
            compact: None,
            nullable: false,
        }
    }

    pub const fn hidden(mut self) -> Field {
        self.hidden = true;
        self
    }

    pub const fn nullable(mut self) -> Field {
        self.nullable = true;
        self
    }

    pub const fn compact(mut self, note: &'static str) -> Field {
        self.compact = Some(note);
        self
    }

    pub const fn required(mut self) -> Field {
        self.required = true;
        self
    }

    pub const fn optional(mut self) -> Field {
        self.required = false;
        self
    }

    pub const fn aliases(mut self, aliases: &'static [&'static str]) -> Field {
        self.aliases = aliases;
        self
    }

    pub const fn default(mut self, json: &'static str) -> Field {
        self.default = Some(json);
        self
    }
}

/// 跨字段约束：拿到规范化之后的参数，返回问题清单。
pub type Check = fn(&Map<String, Value>) -> Vec<Problem>;

/// 一个对外工具。
#[derive(Debug)]
pub struct Tool {
    pub name: &'static str,
    /// 说明正文；必填、枚举与上限由 [`Tool::description`] 自动接在后面。
    pub summary: &'static str,
    pub fields: &'static [Field],
    pub check: Option<Check>,
    /// MCP annotations。
    pub read_only: bool,
    pub destructive: bool,
}

/// 校验通过的参数。
#[derive(Debug, PartialEq)]
pub struct Checked {
    /// 规范名、规范枚举写法；显式 `null` 已去掉。
    pub args: Map<String, Value>,
    /// 别名改名记录（R11 P1-4：ACK 里的 `normalized:[{from,to}]`）。
    pub normalized: Vec<Renamed>,
}

#[derive(Debug, PartialEq, serde::Serialize)]
pub struct Renamed {
    pub from: String,
    pub to: String,
}

/// 校验失败。
#[derive(Debug, PartialEq)]
pub struct Rejected {
    pub problems: Vec<Problem>,
    /// 每个问题都能按 `did_you_mean` 自动更正时，更正后的完整参数（`fix.call` 用）；否则 `None`。
    pub corrected: Option<Map<String, Value>>,
}

impl Tool {
    /// 对外说明（单行）：正文 + 自动生成的参数摘要。U-5 要求每个必填项、枚举值、上限都出现在这段文字里。
    pub fn description(&self) -> String {
        let mut out = self.summary.trim_end().to_owned();
        let required: Vec<String> = self
            .fields
            .iter()
            .filter(|f| f.required && !f.hidden)
            .map(|f| f.name.to_owned())
            .collect();
        let mut notes = Vec::new();
        for f in self.fields.iter().filter(|f| !f.hidden) {
            note(&mut notes, f.name, f);
        }
        // 单行（2.0 的发布约束：有的客户端会把换行渲染丢或截断）。
        if !required.is_empty() {
            out.push_str(" 必填：");
            out.push_str(&required.join("、"));
            out.push('。');
        }
        if !notes.is_empty() {
            out.push_str(" 参数：");
            out.push_str(&notes.join("；"));
            out.push('。');
        }
        out
    }

    /// `inputSchema`。
    pub fn input_schema(&self) -> Value {
        object_schema(self.fields)
    }

    /// 校验并规范化。`args` 缺省（`null`）视同空对象。
    pub fn validate(&self, args: &Value) -> Result<Checked, Rejected> {
        let empty = Map::new();
        let map = match args {
            Value::Object(m) => m,
            Value::Null => &empty,
            other => {
                return Err(Rejected {
                    problems: vec![
                        Problem::new("$", ProblemKind::Pattern)
                            .got(other.clone())
                            .allowed("object"),
                    ],
                    corrected: None,
                });
            }
        };
        let mut v = Validation::default();
        let args = v.object(self.fields, map, "");
        if v.problems.is_empty()
            && let Some(check) = self.check
        {
            v.problems.extend(check(&args));
            v.fixable = false;
        }
        // 输出顺序与调用方写键的顺序无关。
        v.problems.sort_by(|a, b| a.path.cmp(&b.path));
        v.renamed.sort_by(|a, b| a.from.cmp(&b.from));
        if v.problems.is_empty() {
            return Ok(Checked {
                args,
                normalized: v.renamed,
            });
        }
        let corrected = v.fixable.then_some(args);
        Err(Rejected {
            problems: v.problems,
            corrected,
        })
    }
}

/// 一个字段在说明里的摘要；对象与列表展开到子字段（`items[].title`）。
fn note(notes: &mut Vec<String>, path: &str, f: &Field) {
    let mut ty = &f.ty;
    let mut path = path.to_owned();
    if let Ty::List { of, max } = ty {
        if *max > 0 {
            notes.push(format!("{path} 最多 {max} 项"));
        }
        if let Some(c) = f.compact {
            notes.push(format!("{path} 每项{c}"));
            return;
        }
        path.push_str("[]");
        ty = of;
    }
    let text = match ty {
        Ty::Str { max } | Ty::Text { max } if *max > 0 => Some(format!("{path}≤{max}")),
        // 下限 0、没有上限的整数（版本号、seq）没有值得写的约束。
        Ty::Int { min: 0, max } if *max == i64::MAX => None,
        Ty::Int { min, max } if *max == i64::MAX => Some(format!("{path}≥{min}")),
        Ty::Int { min, max } => Some(format!("{path}={min}–{max}")),
        Ty::Num { min, max } => Some(format!("{path}={min}–{max}")),
        Ty::Enum(values) | Ty::EnumPlus(values, _) => Some(format!("{path}={}", values.join("|"))),
        Ty::BoolOr(values) => Some(format!("{path}=true|false|{}", values.join("|"))),
        Ty::Obj(fields) | Ty::TextOr { obj: fields, .. } => {
            if let Ty::TextOr { max, .. } = ty {
                let limit = if *max > 0 {
                    format!("≤{max}")
                } else {
                    String::new()
                };
                notes.push(format!("{path} 是文本{limit}或对象"));
            }
            let required: Vec<&str> = fields
                .iter()
                .filter(|c| c.required)
                .map(|c| c.name)
                .collect();
            if !required.is_empty() {
                let each = if path.ends_with("[]") { "每项" } else { "" };
                notes.push(format!("{path} {each}必填 {}", required.join("、")));
            }
            for c in fields.iter().filter(|c| !c.hidden) {
                note(notes, &format!("{path}.{}", c.name), c);
            }
            return;
        }
        _ => None,
    };
    // 默认值接在同一条后面（「mode=auto|quick|project，默认 auto」）。
    let default = f.default.map(|d| d.trim_matches('"'));
    match (text, default) {
        (Some(t), Some(d)) => notes.push(format!("{t}，默认 {d}")),
        (Some(t), None) => notes.push(t),
        (None, Some(d)) => notes.push(format!("{path} 默认 {d}")),
        (None, None) => {}
    }
}

fn object_schema(fields: &[Field]) -> Value {
    let mut properties = Map::new();
    for f in fields.iter().filter(|f| !f.hidden) {
        let mut schema = match (f.compact, &f.ty) {
            (Some(_), Ty::List { .. }) => json!({"type": "array", "items": {"type": "object"}}),
            _ => type_schema(&f.ty),
        };
        if f.nullable
            && let Some(t) = schema.get("type").cloned()
        {
            schema["type"] = json!([t, "null"]);
        }
        properties.insert(f.name.into(), schema);
    }
    let required: Vec<&str> = fields
        .iter()
        .filter(|f| f.required && !f.hidden)
        .map(|f| f.name)
        .collect();
    let mut out = Map::new();
    out.insert("type".into(), json!("object"));
    out.insert("properties".into(), Value::Object(properties));
    if !required.is_empty() {
        out.insert("required".into(), json!(required));
    }
    Value::Object(out)
}

/// 发布口径：schema 只放类型、枚举与必填；长度与数值上限、默认值、条数上限只写在 description
/// （U-5：客户端常把这些渲染丢；两处都写会让 core 超出 U-7 的字节预算），由服务端校验。
fn type_schema(ty: &Ty) -> Value {
    match ty {
        Ty::Str { .. } | Ty::Text { .. } => json!({"type": "string"}),
        Ty::Int { .. } => json!({"type": "integer"}),
        Ty::Num { .. } => json!({"type": "number"}),
        Ty::Bool => json!({"type": "boolean"}),
        Ty::Enum(values) | Ty::EnumPlus(values, _) => json!({"type": "string", "enum": values}),
        Ty::TextOr { obj, .. } => json!({"anyOf": [{"type": "string"}, object_schema(obj)]}),
        Ty::BoolOr(values) => {
            let mut all = vec![json!(true), json!(false)];
            all.extend(values.iter().map(|v| json!(v)));
            json!({"enum": all})
        }
        Ty::List { of, .. } => json!({"type": "array", "items": type_schema(of)}),
        Ty::Obj(fields) => object_schema(fields),
        Ty::Any => json!({}),
    }
}

#[derive(Default)]
struct Validation {
    problems: Vec<Problem>,
    renamed: Vec<Renamed>,
    /// 目前为止的每个问题都能自动更正。
    fixable: bool,
    started: bool,
}

impl Validation {
    fn fail(&mut self, problem: Problem, fixable: bool) {
        if !self.started {
            self.started = true;
            self.fixable = true;
        }
        self.fixable &= fixable;
        self.problems.push(problem);
    }

    fn object(
        &mut self,
        fields: &[Field],
        map: &Map<String, Value>,
        prefix: &str,
    ) -> Map<String, Value> {
        let mut out = Map::new();
        let path = |name: &str| {
            if prefix.is_empty() {
                name.to_owned()
            } else {
                format!("{prefix}.{name}")
            }
        };
        // 先放规范名，再放别名：同一字段两种写法都给了而且值不同，是冲突。
        let mut entries: Vec<(&String, &Value)> = map.iter().collect();
        entries.sort_by_key(|(k, _)| !fields.iter().any(|f| f.name == k.as_str()));
        for (key, value) in entries {
            // 规范名与别名都不分大小写（`Task_Key` 按别名处理）；表里没有只差大小写的两个名字。
            let field = fields.iter().find(|f| {
                f.name.eq_ignore_ascii_case(key)
                    || f.aliases.iter().any(|a| a.eq_ignore_ascii_case(key))
            });
            let Some(field) = field else {
                let mut p = Problem::new(path(key), ProblemKind::Unknown);
                match nearest(
                    key,
                    fields.iter().flat_map(|f| {
                        std::iter::once((f.name, f.name))
                            .chain(f.aliases.iter().map(|a| (*a, f.name)))
                    }),
                ) {
                    Some(name) if !map.contains_key(name) => {
                        p.did_you_mean = Some(name.to_owned());
                        if !value.is_null() {
                            let checked =
                                self.value(&field_named(fields, name).ty, value, &path(name));
                            out.insert(name.to_owned(), checked);
                        }
                        self.fail(p, true);
                    }
                    _ => {
                        p.allowed = Some(json!(fields.iter().map(|f| f.name).collect::<Vec<_>>()));
                        self.fail(p, false);
                    }
                }
                continue;
            };
            if value.is_null() && !field.nullable {
                continue;
            }
            let checked = if value.is_null() {
                Value::Null
            } else {
                self.value(&field.ty, value, &path(field.name))
            };
            if key != field.name {
                if let Some(existing) = out.get(field.name) {
                    if *existing != checked {
                        self.fail(
                            Problem::new(path(key), ProblemKind::Conflict)
                                .got(value.clone())
                                .allowed(field.name),
                            false,
                        );
                    }
                    continue;
                }
                self.renamed.push(Renamed {
                    from: path(key),
                    to: path(field.name),
                });
            }
            out.insert(field.name.to_owned(), checked);
        }
        for f in fields {
            if f.required && !out.contains_key(f.name) {
                self.fail(Problem::new(path(f.name), ProblemKind::Missing), false);
            }
        }
        out
    }

    /// 校验一个值，返回规范化后的值（失败时原样返回，用于拼更正后的参数）。
    fn value(&mut self, ty: &Ty, value: &Value, path: &str) -> Value {
        let mismatch = |v: &mut Validation, allowed: &str| {
            v.fail(
                Problem::new(path, ProblemKind::Pattern)
                    .got(value.clone())
                    .allowed(allowed),
                false,
            );
            value.clone()
        };
        match ty {
            Ty::Str { max } | Ty::Text { max } => {
                let Some(s) = value.as_str() else {
                    // 数字当成文本传来（例如 `"op_id": 42`）不是猜错，只是类型不严：照字面收下。
                    return match value {
                        Value::Number(n) => self.value(ty, &Value::String(n.to_string()), path),
                        _ => mismatch(self, "string"),
                    };
                };
                if matches!(ty, Ty::Text { .. }) && s.trim().is_empty() {
                    self.fail(Problem::new(path, ProblemKind::Empty), false);
                    return value.clone();
                }
                let n = s.chars().count();
                if *max > 0 && n > *max {
                    self.fail(
                        Problem::new(path, ProblemKind::TooLong)
                            .allowed(*max)
                            .over_by(n - max),
                        false,
                    );
                }
                value.clone()
            }
            Ty::Int { min, max } => {
                let n = match value {
                    Value::Number(n) => n.as_i64(),
                    Value::String(s) => s.trim().parse::<i64>().ok(),
                    _ => None,
                };
                match n {
                    Some(n) if n < *min || n > *max => {
                        self.fail(
                            Problem::new(path, ProblemKind::Pattern)
                                .got(value.clone())
                                .allowed(format!("{min}..={max}")),
                            false,
                        );
                        value.clone()
                    }
                    Some(n) => json!(n),
                    None => mismatch(self, "integer"),
                }
            }
            Ty::Num { min, max } => {
                let n = match value {
                    Value::Number(n) => n.as_f64(),
                    Value::String(s) => s.trim().parse::<f64>().ok().filter(|n| n.is_finite()),
                    _ => None,
                };
                match n {
                    Some(n) if n < *min || n > *max => {
                        self.fail(
                            Problem::new(path, ProblemKind::Pattern)
                                .got(value.clone())
                                .allowed(format!("{min}..={max}")),
                            false,
                        );
                        value.clone()
                    }
                    Some(n) => json!(n),
                    None => mismatch(self, "number"),
                }
            }
            Ty::Bool => match value {
                Value::Bool(_) => value.clone(),
                Value::String(s) if s.eq_ignore_ascii_case("true") => json!(true),
                Value::String(s) if s.eq_ignore_ascii_case("false") => json!(false),
                _ => mismatch(self, "boolean"),
            },
            Ty::Enum(values) | Ty::BoolOr(values) | Ty::EnumPlus(values, _) => {
                if let Value::Bool(_) = value
                    && matches!(ty, Ty::BoolOr(_))
                {
                    return value.clone();
                }
                let Some(s) = value.as_str() else {
                    return mismatch(self, &values.join("|"));
                };
                let old: &[&str] = match ty {
                    Ty::EnumPlus(_, old) => old,
                    _ => &[],
                };
                if let Some(v) = values
                    .iter()
                    .chain(old)
                    .find(|v| v.eq_ignore_ascii_case(s.trim()))
                {
                    return json!(v);
                }
                if matches!(ty, Ty::BoolOr(_)) {
                    for b in ["true", "false"] {
                        if b.eq_ignore_ascii_case(s.trim()) {
                            return json!(b == "true");
                        }
                    }
                }
                let mut p = Problem::new(path, ProblemKind::Enum)
                    .got(value.clone())
                    .allowed(json!(values));
                match nearest(s, values.iter().map(|v| (*v, *v))) {
                    Some(v) => {
                        p.did_you_mean = Some(v.to_owned());
                        self.fail(p, true);
                        json!(v)
                    }
                    None => {
                        self.fail(p, false);
                        value.clone()
                    }
                }
            }
            Ty::List { of, max } => {
                // 只给一个元素时不包数组也收下（`depends_on: "1"`）。
                let items: Vec<Value> = match value {
                    Value::Array(a) => a.clone(),
                    other => vec![other.clone()],
                };
                if *max > 0 && items.len() > *max {
                    self.fail(
                        Problem::new(path, ProblemKind::TooMany)
                            .allowed(*max)
                            .over_by(items.len() - max),
                        false,
                    );
                }
                Value::Array(
                    items
                        .iter()
                        .enumerate()
                        .map(|(i, item)| self.value(of, item, &format!("{path}[{i}]")))
                        .collect(),
                )
            }
            Ty::Obj(fields) => match value {
                Value::Object(m) => Value::Object(self.object(fields, m, path)),
                _ => mismatch(self, "object"),
            },
            Ty::TextOr { max, obj } => match value {
                Value::Object(m) => Value::Object(self.object(obj, m, path)),
                Value::String(_) => self.value(&Ty::Text { max: *max }, value, path),
                _ => mismatch(self, "string or object"),
            },
            Ty::Any => value.clone(),
        }
    }
}

fn field_named<'a>(fields: &'a [Field], name: &str) -> &'a Field {
    fields
        .iter()
        .find(|f| f.name == name)
        .expect("did_you_mean only names fields of the same table")
}

/// 最接近的候选（编辑距离，忽略大小写与 `-`/`_`）；太远就没有建议。返回候选对应的规范名。
fn nearest<'a>(got: &str, candidates: impl Iterator<Item = (&'a str, &'a str)>) -> Option<&'a str> {
    let squash = |s: &str| -> Vec<char> {
        s.chars()
            .filter(|c| *c != '_' && *c != '-')
            .flat_map(char::to_lowercase)
            .collect()
    };
    let g = squash(got);
    let mut best: Option<(usize, &str)> = None;
    for (candidate, canonical) in candidates {
        let d = distance(&g, &squash(candidate));
        let limit = (candidate.chars().count().max(g.len()) / 3).max(2);
        if d <= limit && best.is_none_or(|(b, _)| d < b) {
            best = Some((d, canonical));
        }
    }
    best.map(|(_, name)| name)
}

fn distance(a: &[char], b: &[char]) -> usize {
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut prev = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cur = row[j + 1];
            row[j + 1] = (prev + usize::from(ca != cb)).min(row[j] + 1).min(cur + 1);
            prev = cur;
        }
    }
    row[b.len()]
}
