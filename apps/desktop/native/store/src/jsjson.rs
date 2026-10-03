//! 2.0 运行时（V8）的 `JSON.parse`、对象展开与 `JSON.stringify`，供 2.x 转换器重建补投影的 payload
//! （W1 peer r3 P1-r3-01 / P1-r3-02）。
//!
//! 不用 SQLite 的 JSON 函数：`json_each` 把数组元素先转成 SQLite 值再编码，落单代理项变成非法 UTF-8、
//! 长小数被截成 15 位；嵌套超过 1000 层的合法 JSON 被 `json_valid` 判为非法，再被当成解析失败清空。这里：
//! - 字符串按 UTF-16 码元保存，落单代理项原样保留，输出时按 `JSON.stringify` 转义；
//! - 数字解析成 f64（与 JS 一样就近舍入），输出按 JS 的 `Number::toString`，非有限值输出 `null`；
//! - 对象的重复键后者覆盖、位置不变；输出时数组下标形状的键按数值升序排在前面，其余按插入顺序；
//! - 嵌套超过 [`MAX_DEPTH`] 层时返回 [`TooDeep`]：转换据此显式拒绝，不当作解析失败。
//!
//! 解析、输出和释放都不递归（节点放在一个数组里，用显式栈遍历），嵌套深度不受调用线程的栈大小限制。
//! 期望由 node 生成（`tests/data/spread-vectors.mjs`），输出与 node 逐字节一致。

use std::collections::HashMap;

/// 支持的最大嵌套层数（对象和数组都算一层）。2.x 的 payload 来自 `JSON.stringify`，实际远小于它。
pub const MAX_DEPTH: usize = 2048;

/// 嵌套超过 [`MAX_DEPTH`]。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TooDeep;

/// 一棵 JSON 值树。节点按创建顺序放在 `nodes` 里，容器用下标引用子节点。
#[derive(Debug, Default)]
pub struct Doc {
    nodes: Vec<Node>,
}

#[derive(Debug)]
enum Node {
    Null,
    Bool(bool),
    Number(f64),
    /// UTF-16 码元，可以含落单的代理项。
    String(Vec<u16>),
    Array(Vec<usize>),
    Object(Object),
}

/// JS 普通对象：键按创建顺序保存，重复设置同一个键只改值、不改位置。值是节点下标。
#[derive(Debug, Default)]
struct Object {
    entries: Vec<(Vec<u16>, usize)>,
    index: HashMap<Vec<u16>, usize>,
}

impl Object {
    fn set(&mut self, key: Vec<u16>, value: usize) {
        match self.index.get(&key) {
            Some(&i) => self.entries[i].1 = value,
            None => {
                self.index.insert(key.clone(), self.entries.len());
                self.entries.push((key, value));
            }
        }
    }

    fn get(&self, key: &str) -> Option<usize> {
        let key: Vec<u16> = key.encode_utf16().collect();
        self.index.get(&key).map(|&i| self.entries[i].1)
    }

    /// `OrdinaryOwnPropertyKeys` 的顺序：数组下标按数值升序，其余按创建顺序。
    fn ordered(&self) -> Vec<&(Vec<u16>, usize)> {
        let mut indices = Vec::new();
        let mut rest = Vec::new();
        for (i, (key, _)) in self.entries.iter().enumerate() {
            match array_index(key) {
                Some(n) => indices.push((n, i)),
                None => rest.push(i),
            }
        }
        indices.sort_unstable();
        indices
            .into_iter()
            .map(|(_, i)| i)
            .chain(rest)
            .map(|i| &self.entries[i])
            .collect()
    }

    fn from_items(items: impl IntoIterator<Item = usize>) -> Object {
        let mut o = Object::default();
        for (i, v) in items.into_iter().enumerate() {
            o.set(i.to_string().encode_utf16().collect(), v);
        }
        o
    }
}

/// 数组下标：不带前导零的十进制整数，取值 0..=2^32-2。
fn array_index(key: &[u16]) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || (key.len() > 1 && key[0] == u16::from(b'0')) {
        return None;
    }
    let mut n: u64 = 0;
    for &c in key {
        if !(u16::from(b'0')..=u16::from(b'9')).contains(&c) {
            return None;
        }
        n = n * 10 + u64::from(c - u16::from(b'0'));
    }
    u32::try_from(n).ok().filter(|&n| n != u32::MAX)
}

impl Doc {
    fn push(&mut self, node: Node) -> usize {
        self.nodes.push(node);
        self.nodes.len() - 1
    }

    /// 顶层值是数字时返回它。
    pub fn as_number(&self) -> Option<f64> {
        match self.nodes.last() {
            Some(Node::Number(x)) => Some(*x),
            _ => None,
        }
    }

    /// 把 `text` 解析进这棵树，返回根节点下标；不合法时 `Ok(None)`（JS 会抛 SyntaxError）。
    fn parse_into(&mut self, text: &str) -> Result<Option<usize>, TooDeep> {
        let mut p = Parser {
            text,
            i: 0,
            doc: self,
        };
        match p.document() {
            Ok(root) => Ok(Some(root)),
            Err(Fail::Invalid) => Ok(None),
            Err(Fail::TooDeep) => Err(TooDeep),
        }
    }

    /// 把一个节点取出来，原位置留下 Null（节点之间没有共享，取出后不会再被引用）。
    fn take(&mut self, i: usize) -> Node {
        std::mem::replace(&mut self.nodes[i], Node::Null)
    }

    /// `{ ...值 }`：对象原样，数组按下标展开，字符串按 UTF-16 码元展开，其余没有可展开的属性。
    fn spread(&mut self, root: Option<usize>) -> Object {
        match root.map(|r| self.take(r)) {
            Some(Node::Object(o)) => o,
            Some(Node::Array(items)) => Object::from_items(items),
            Some(Node::String(units)) => {
                let items: Vec<usize> = units
                    .into_iter()
                    .map(|u| self.push(Node::String(vec![u])))
                    .collect();
                Object::from_items(items)
            }
            _ => Object::default(),
        }
    }

    /// `JSON.stringify(节点)`，用显式栈遍历。
    fn stringify(&self, root: usize) -> String {
        enum Task<'a> {
            Value(usize),
            Key(&'a [u16]),
            Punct(&'static str),
        }
        let mut out = String::new();
        let mut tasks = vec![Task::Value(root)];
        while let Some(task) = tasks.pop() {
            match task {
                Task::Punct(p) => out.push_str(p),
                Task::Key(k) => {
                    write_string(&mut out, k);
                    out.push(':');
                }
                Task::Value(i) => match &self.nodes[i] {
                    Node::Null => out.push_str("null"),
                    Node::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
                    Node::Number(x) if x.is_finite() => out.push_str(&number_to_string(*x)),
                    Node::Number(_) => out.push_str("null"),
                    Node::String(units) => write_string(&mut out, units),
                    Node::Array(items) => {
                        out.push('[');
                        tasks.push(Task::Punct("]"));
                        for (n, &item) in items.iter().enumerate().rev() {
                            tasks.push(Task::Value(item));
                            if n > 0 {
                                tasks.push(Task::Punct(","));
                            }
                        }
                    }
                    Node::Object(o) => {
                        out.push('{');
                        tasks.push(Task::Punct("}"));
                        let ordered = o.ordered();
                        for (n, (key, value)) in ordered.into_iter().enumerate().rev() {
                            tasks.push(Task::Value(*value));
                            tasks.push(Task::Key(key));
                            if n > 0 {
                                tasks.push(Task::Punct(","));
                            }
                        }
                    }
                },
            }
        }
        out
    }
}

enum Fail {
    Invalid,
    TooDeep,
}

/// 正在解析的容器。
enum Frame {
    Array(Vec<usize>),
    /// 对象和它正在等值的键。
    Object(Object, Vec<u16>),
}

struct Parser<'a, 'd> {
    text: &'a str,
    i: usize,
    doc: &'d mut Doc,
}

impl Parser<'_, '_> {
    fn peek(&self) -> Option<u8> {
        self.text.as_bytes().get(self.i).copied()
    }

    fn eat(&mut self, b: u8) -> bool {
        let hit = self.peek() == Some(b);
        if hit {
            self.i += 1;
        }
        hit
    }

    /// JSON 的空白只有这四个（ECMA-404）；不含垂直制表符、不换行空格、BOM 等。
    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    /// 读一个键和它后面的冒号。
    fn key(&mut self) -> Result<Vec<u16>, Fail> {
        self.ws();
        if self.peek() != Some(b'"') {
            return Err(Fail::Invalid);
        }
        let key = self.string()?;
        self.ws();
        if !self.eat(b':') {
            return Err(Fail::Invalid);
        }
        Ok(key)
    }

    /// 整个文本是一个值，前后可以有空白。
    fn document(&mut self) -> Result<usize, Fail> {
        let mut stack: Vec<Frame> = Vec::new();
        'value: loop {
            self.ws();
            // 读一个值的开头：容器入栈后回到这里读它的第一个成员，标量或空容器直接得到节点。
            let mut done = match self.peek() {
                Some(c @ (b'{' | b'[')) => {
                    if stack.len() >= MAX_DEPTH {
                        return Err(Fail::TooDeep);
                    }
                    self.i += 1;
                    self.ws();
                    if c == b'{' {
                        if self.eat(b'}') {
                            self.doc.push(Node::Object(Object::default()))
                        } else {
                            let key = self.key()?;
                            stack.push(Frame::Object(Object::default(), key));
                            continue 'value;
                        }
                    } else if self.eat(b']') {
                        self.doc.push(Node::Array(Vec::new()))
                    } else {
                        stack.push(Frame::Array(Vec::new()));
                        continue 'value;
                    }
                }
                Some(b'"') => {
                    let s = self.string()?;
                    self.doc.push(Node::String(s))
                }
                Some(b't') => self.literal("true", Node::Bool(true))?,
                Some(b'f') => self.literal("false", Node::Bool(false))?,
                Some(b'n') => self.literal("null", Node::Null)?,
                Some(b'-' | b'0'..=b'9') => self.number()?,
                _ => return Err(Fail::Invalid),
            };
            // 把完成的值挂到外层容器上；外层也随之完成时继续往外挂。
            loop {
                self.ws();
                match stack.last_mut() {
                    None => {
                        return if self.i == self.text.len() {
                            Ok(done)
                        } else {
                            Err(Fail::Invalid)
                        };
                    }
                    Some(Frame::Array(items)) => {
                        items.push(done);
                        if self.eat(b',') {
                            continue 'value;
                        }
                        if !self.eat(b']') {
                            return Err(Fail::Invalid);
                        }
                        let Some(Frame::Array(items)) = stack.pop() else {
                            unreachable!()
                        };
                        done = self.doc.push(Node::Array(items));
                    }
                    Some(Frame::Object(o, key)) => {
                        o.set(std::mem::take(key), done);
                        if self.eat(b',') {
                            *key = self.key()?;
                            continue 'value;
                        }
                        if !self.eat(b'}') {
                            return Err(Fail::Invalid);
                        }
                        let Some(Frame::Object(o, _)) = stack.pop() else {
                            unreachable!()
                        };
                        done = self.doc.push(Node::Object(o));
                    }
                }
            }
        }
    }

    fn literal(&mut self, word: &str, node: Node) -> Result<usize, Fail> {
        if self.text[self.i..].starts_with(word) {
            self.i += word.len();
            Ok(self.doc.push(node))
        } else {
            Err(Fail::Invalid)
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.i;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.i += 1;
        }
        self.i - start
    }

    fn number(&mut self) -> Result<usize, Fail> {
        let start = self.i;
        self.eat(b'-');
        match self.peek() {
            Some(b'0') => self.i += 1,
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return Err(Fail::Invalid),
        }
        if self.eat(b'.') && self.digits() == 0 {
            return Err(Fail::Invalid);
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.i += 1;
            if !self.eat(b'+') {
                self.eat(b'-');
            }
            if self.digits() == 0 {
                return Err(Fail::Invalid);
            }
        }
        // Rust 的 f64 解析与 JS 一样按 IEEE 754 就近舍入；溢出得到无穷大。
        let x = self.text[start..self.i]
            .parse::<f64>()
            .map_err(|_| Fail::Invalid)?;
        Ok(self.doc.push(Node::Number(x)))
    }

    fn hex4(&mut self) -> Result<u16, Fail> {
        let mut u: u16 = 0;
        for _ in 0..4 {
            let d = match self.peek() {
                Some(c @ b'0'..=b'9') => c - b'0',
                Some(c @ b'a'..=b'f') => c - b'a' + 10,
                Some(c @ b'A'..=b'F') => c - b'A' + 10,
                _ => return Err(Fail::Invalid),
            };
            u = u * 16 + u16::from(d);
            self.i += 1;
        }
        Ok(u)
    }

    fn string(&mut self) -> Result<Vec<u16>, Fail> {
        self.i += 1; // 开头的引号
        let mut units = Vec::new();
        loop {
            match self.peek() {
                None => return Err(Fail::Invalid),
                Some(b'"') => {
                    self.i += 1;
                    return Ok(units);
                }
                Some(b'\\') => {
                    self.i += 1;
                    let unit = match self.peek() {
                        Some(b'"') => 0x22,
                        Some(b'\\') => 0x5c,
                        Some(b'/') => 0x2f,
                        Some(b'b') => 0x08,
                        Some(b'f') => 0x0c,
                        Some(b'n') => 0x0a,
                        Some(b'r') => 0x0d,
                        Some(b't') => 0x09,
                        Some(b'u') => {
                            self.i += 1;
                            units.push(self.hex4()?);
                            continue;
                        }
                        _ => return Err(Fail::Invalid),
                    };
                    self.i += 1;
                    units.push(unit);
                }
                Some(0x00..=0x1f) => return Err(Fail::Invalid),
                Some(b) if b < 0x80 => {
                    self.i += 1;
                    units.push(u16::from(b));
                }
                Some(_) => {
                    let c = self.text[self.i..].chars().next().ok_or(Fail::Invalid)?;
                    let mut buf = [0u16; 2];
                    units.extend_from_slice(c.encode_utf16(&mut buf));
                    self.i += c.len_utf8();
                }
            }
        }
    }
}

/// `QuoteJSONString`：短转义；其余控制字符和落单的代理项用小写四位十六进制转义；成对的代理项输出字符本身。
fn write_string(out: &mut String, units: &[u16]) {
    out.push('"');
    let mut i = 0;
    while i < units.len() {
        let u = units[i];
        match u {
            0x08 => out.push_str("\\b"),
            0x09 => out.push_str("\\t"),
            0x0a => out.push_str("\\n"),
            0x0c => out.push_str("\\f"),
            0x0d => out.push_str("\\r"),
            0x22 => out.push_str("\\\""),
            0x5c => out.push_str("\\\\"),
            0xd800..=0xdbff if matches!(units.get(i + 1), Some(0xdc00..=0xdfff)) => {
                let c =
                    0x10000 + ((u32::from(u) - 0xd800) << 10) + (u32::from(units[i + 1]) - 0xdc00);
                out.push(char::from_u32(c).unwrap_or(char::REPLACEMENT_CHARACTER));
                i += 1;
            }
            0x00..=0x1f | 0xd800..=0xdfff => {
                out.push_str("\\u");
                out.push_str(&format!("{u:04x}"));
            }
            _ => out.push(char::from_u32(u32::from(u)).unwrap_or(char::REPLACEMENT_CHARACTER)),
        }
        i += 1;
    }
    out.push('"');
}

/// JS 的 `Number::toString(x)`（radix 10）：最短能往返的十进制数字，按 JS 的规则决定小数点和指数形式。
pub fn number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    let sign = if x < 0.0 { "-" } else { "" };
    // Rust 的 `{:e}` 给出最短能往返的数字（多个最短候选时取最接近的，与 JS 相同）：d[.ddd]e<指数>。
    let sci = format!("{:e}", x.abs());
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i64;
    let n = exp.parse::<i64>().unwrap_or(0) + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let m = if k == 1 {
            digits.clone()
        } else {
            format!("{}.{}", &digits[..1], &digits[1..])
        };
        format!("{m}e{}{}", if e >= 0 { "+" } else { "-" }, e.abs())
    };
    format!("{sign}{body}")
}

/// `JSON.parse(text)`：不合法时 `Ok(None)`。
pub fn parse(text: &str) -> Result<Option<Doc>, TooDeep> {
    let mut doc = Doc::default();
    Ok(doc.parse_into(text)?.map(|_| doc))
}

/// 2.0 `readJson`：空值或解析失败时回退（返回 None，调用方按 `{}` 处理）。
fn read_json(doc: &mut Doc, text: Option<&str>) -> Result<Option<usize>, TooDeep> {
    match text.filter(|t| !t.is_empty()) {
        Some(t) => doc.parse_into(t),
        None => Ok(None),
    }
}

/// `JSON.stringify({ ...readJson(text, {}) })`。
pub fn spread_json(text: Option<&str>) -> Result<String, TooDeep> {
    let mut doc = Doc::default();
    let root = read_json(&mut doc, text)?;
    let o = doc.spread(root);
    let root = doc.push(Node::Object(o));
    Ok(doc.stringify(root))
}

/// `JSON.stringify({ ...readJson(payload, {}), ...fields })`。`fields` 是一个 JSON 对象。
pub fn mirror_payload(payload: Option<&str>, fields: &str) -> Result<String, TooDeep> {
    let mut doc = Doc::default();
    let root = read_json(&mut doc, payload)?;
    let mut o = doc.spread(root);
    let fields = doc.parse_into(fields)?;
    if let Some(Node::Object(f)) = fields.map(|f| doc.take(f)) {
        for (key, value) in f.entries {
            o.set(key, value);
        }
    }
    let root = doc.push(Node::Object(o));
    Ok(doc.stringify(root))
}

/// `JSON.parse(text)[key]`：顶层是对象、键对应的值是字符串时返回它（落单代理项无法成为 Rust 字符串，返回 None）。
pub fn top_level_string(text: &str, key: &str) -> Result<Option<String>, TooDeep> {
    let mut doc = Doc::default();
    let Some(root) = doc.parse_into(text)? else {
        return Ok(None);
    };
    Ok(match &doc.nodes[root] {
        Node::Object(o) => match o.get(key).map(|v| &doc.nodes[v]) {
            Some(Node::String(units)) => String::from_utf16(units).ok(),
            _ => None,
        },
        _ => None,
    })
}
