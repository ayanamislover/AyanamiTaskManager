//! `N\runtime\damaged.json`（W8h）：宿主最终判定已发布的这一代库读不出时写下的状态。
//!
//! 存储层（宿主写、`atm.exe` 读）和 `atm-mcp.exe` 桥（另一个工作区）都用这一份代码读它，所以两边对
//! 同一个文件的判定逐字节一致（W8 关口 peer r11 P2-01d：原来两边各用各的 JSON 解析器，特殊对象被一边
//! 当成数字、嵌套深度的上限也不同）。这里自带一个严格的 JSON 读取：RFC 8259，UTF-8，不认 BOM，键不许
//! 重复，字符串里不许有落单的代理项，嵌套不超过 [`MAX_DEPTH`] 层。
//!
//! 文件的形状是固定的：`state` 是 `DATABASE_DAMAGED`，`since`、`generation`、`reason` 是字符串，
//! 可选的 `writer` 是 `{pid, startedAtMs}`（非负整数，不超过 2^53，pid 不超过 u32）。别的键、别的类型，
//! 都让 [`DamagedState::parse`] 返回 `None`：读的一方把它当作坏文件（库照样算读不出，原因写明，
//! 但不当作「还在跑的宿主写的」）。

use std::collections::BTreeMap;

/// 嵌套上限。正常文件只有两层。
pub const MAX_DEPTH: usize = 32;

/// 2^53：JSON 数在 JS 里能精确表示的整数上限，宿主写的 pid 与毫秒都远小于它。
const MAX_WHOLE: f64 = 9_007_199_254_740_992.0;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DamagedState {
    pub since: String,
    pub generation: String,
    pub reason: String,
    /// 写下它的宿主。没有这一项就当作上一次运行留下的（W8 关口 peer r9 P2-01b）。
    pub writer: Option<Writer>,
}

/// 一个进程的身份：pid 与启动时间（Unix 毫秒，与 `runtime\host.json` 同一个口径）。pid 会被复用，
/// 两者合起来才认得出。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Writer {
    pub pid: u32,
    pub started_at_ms: u64,
}

impl DamagedState {
    /// 键按字典序、没有多余空白，与存储层其他状态文件的写法（JCS）一致。
    pub fn to_json(&self) -> String {
        let mut out = String::from("{");
        out.push_str(&format!("\"generation\":{}", quote(&self.generation)));
        out.push_str(&format!(",\"reason\":{}", quote(&self.reason)));
        out.push_str(&format!(",\"since\":{}", quote(&self.since)));
        out.push_str(",\"state\":\"DATABASE_DAMAGED\"");
        if let Some(w) = self.writer {
            out.push_str(&format!(
                ",\"writer\":{{\"pid\":{},\"startedAtMs\":{}}}",
                w.pid, w.started_at_ms
            ));
        }
        out.push('}');
        out
    }

    /// 读文件的字节。不是这个形状（见模块说明）就是 `None`。
    pub fn parse(bytes: &[u8]) -> Option<DamagedState> {
        let text = std::str::from_utf8(bytes).ok()?;
        let mut reader = Reader {
            s: text.as_bytes(),
            i: 0,
        };
        reader.ws();
        let value = reader.value(0)?;
        reader.ws();
        if reader.i != reader.s.len() {
            return None;
        }
        let Json::Object(mut top) = value else {
            return None;
        };
        let string = |top: &mut BTreeMap<String, Json>, key: &str| match top.remove(key) {
            Some(Json::String(s)) => Some(s),
            _ => None,
        };
        if string(&mut top, "state")? != "DATABASE_DAMAGED" {
            return None;
        }
        let since = string(&mut top, "since")?;
        let generation = string(&mut top, "generation")?;
        let reason = string(&mut top, "reason")?;
        let writer = match top.remove("writer") {
            None => None,
            Some(Json::Object(mut w)) => {
                let pid = whole(w.remove("pid")?)?;
                let started_at_ms = whole(w.remove("startedAtMs")?)?;
                if !w.is_empty() {
                    return None;
                }
                Some(Writer {
                    pid: u32::try_from(pid).ok()?,
                    started_at_ms,
                })
            }
            Some(_) => return None,
        };
        if !top.is_empty() {
            return None;
        }
        Some(DamagedState {
            since,
            generation,
            reason,
            writer,
        })
    }
}

fn whole(v: Json) -> Option<u64> {
    match v {
        Json::Number(n) if n.is_finite() && n.fract() == 0.0 && (0.0..MAX_WHOLE).contains(&n) => {
            Some(n as u64)
        }
        _ => None,
    }
}

fn quote(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

enum Json {
    Null,
    Bool,
    Number(f64),
    String(String),
    Array,
    Object(BTreeMap<String, Json>),
}

struct Reader<'a> {
    s: &'a [u8],
    i: usize,
}

impl Reader<'_> {
    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }

    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    fn eat(&mut self, lit: &[u8]) -> Option<()> {
        if self.s.get(self.i..self.i + lit.len())? == lit {
            self.i += lit.len();
            Some(())
        } else {
            None
        }
    }

    fn value(&mut self, depth: usize) -> Option<Json> {
        match self.peek()? {
            b'{' => self.object(depth + 1),
            b'[' => self.array(depth + 1),
            b'"' => self.string().map(Json::String),
            b't' => self.eat(b"true").map(|_| Json::Bool),
            b'f' => self.eat(b"false").map(|_| Json::Bool),
            b'n' => self.eat(b"null").map(|_| Json::Null),
            b'-' | b'0'..=b'9' => self.number().map(Json::Number),
            _ => None,
        }
    }

    fn object(&mut self, depth: usize) -> Option<Json> {
        if depth > MAX_DEPTH {
            return None;
        }
        self.i += 1;
        let mut map = BTreeMap::new();
        self.ws();
        if self.peek()? == b'}' {
            self.i += 1;
            return Some(Json::Object(map));
        }
        loop {
            self.ws();
            if self.peek()? != b'"' {
                return None;
            }
            let key = self.string()?;
            self.ws();
            self.eat(b":")?;
            self.ws();
            let v = self.value(depth)?;
            if map.insert(key, v).is_some() {
                return None;
            }
            self.ws();
            match self.peek()? {
                b',' => self.i += 1,
                b'}' => {
                    self.i += 1;
                    return Some(Json::Object(map));
                }
                _ => return None,
            }
        }
    }

    fn array(&mut self, depth: usize) -> Option<Json> {
        if depth > MAX_DEPTH {
            return None;
        }
        self.i += 1;
        self.ws();
        if self.peek()? == b']' {
            self.i += 1;
            return Some(Json::Array);
        }
        loop {
            self.ws();
            self.value(depth)?;
            self.ws();
            match self.peek()? {
                b',' => self.i += 1,
                b']' => {
                    self.i += 1;
                    return Some(Json::Array);
                }
                _ => return None,
            }
        }
    }

    fn hex4(&mut self) -> Option<u32> {
        let digits = std::str::from_utf8(self.s.get(self.i..self.i + 4)?).ok()?;
        if !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        self.i += 4;
        u32::from_str_radix(digits, 16).ok()
    }

    fn string(&mut self) -> Option<String> {
        self.i += 1; // the opening quote
        let mut out = String::new();
        loop {
            let b = self.peek()?;
            match b {
                b'"' => {
                    self.i += 1;
                    return Some(out);
                }
                b'\\' => {
                    self.i += 1;
                    let e = self.peek()?;
                    self.i += 1;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{08}'),
                        b'f' => out.push('\u{0c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hi = self.hex4()?;
                            let c = match hi {
                                0xD800..=0xDBFF => {
                                    self.eat(b"\\u")?;
                                    let lo = self.hex4()?;
                                    if !(0xDC00..=0xDFFF).contains(&lo) {
                                        return None;
                                    }
                                    0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)
                                }
                                0xDC00..=0xDFFF => return None,
                                _ => hi,
                            };
                            out.push(char::from_u32(c)?);
                        }
                        _ => return None,
                    }
                }
                0x00..=0x1f => return None,
                _ => {
                    // A whole UTF-8 sequence (the input is valid UTF-8).
                    let len = match b {
                        0x00..=0x7f => 1,
                        0xc0..=0xdf => 2,
                        0xe0..=0xef => 3,
                        _ => 4,
                    };
                    out.push_str(std::str::from_utf8(self.s.get(self.i..self.i + len)?).ok()?);
                    self.i += len;
                }
            }
        }
    }

    fn number(&mut self) -> Option<f64> {
        let start = self.i;
        if self.peek() == Some(b'-') {
            self.i += 1;
        }
        match self.peek()? {
            b'0' => self.i += 1,
            b'1'..=b'9' => {
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.i += 1;
                }
            }
            _ => return None,
        }
        if self.peek() == Some(b'.') {
            self.i += 1;
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return None;
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.i += 1;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.i += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.i += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return None;
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.i += 1;
            }
        }
        std::str::from_utf8(&self.s[start..self.i])
            .ok()?
            .parse()
            .ok()
    }
}

/// 跨端差分用例（W8 关口 peer r11 P2-01d）：原始字节与它们该读成什么。存储层（`read_damaged`）
/// 和 atm-mcp（`damaged_report`）的用例各自经自己的读文件路径读这同一批字节，结果都必须与这里
/// 一致；哪一边换回别的解析器，那一边的用例就红。`writer` 用调用方给的身份（它自己），
/// 读成功的 `reason` 一律是 `r`。
#[doc(hidden)]
pub mod corpus {
    /// 一条用例：字节，和读出的 `(reason, writer)`；`None` 是坏文件。
    pub type Case = (Vec<u8>, Option<(String, Option<(u32, u64)>)>);

    pub fn cases(pid: u32, started_at_ms: u64) -> Vec<Case> {
        const BODY: &str =
            r#""generation":"G","reason":"r","since":"s","state":"DATABASE_DAMAGED""#;
        let ok = |w: Option<(u32, u64)>| Some(("r".to_owned(), w));
        let with = |extra: &str| format!("{{{BODY}{extra}}}").into_bytes();
        let me = Some((pid, started_at_ms));
        let mut bom = vec![0xef, 0xbb, 0xbf];
        bom.extend_from_slice(&with(""));
        vec![
            (with(""), ok(None)),
            (
                with(&format!(r#","writer":{{"pid":{pid},"startedAtMs":{started_at_ms}}}"#)),
                ok(me),
            ),
            // The same numbers written as decimals are the same writer.
            (
                with(&format!(r#","writer":{{"pid":{pid}.0,"startedAtMs":{started_at_ms}.0}}"#)),
                ok(me),
            ),
            // serde_json with arbitrary_precision reads this object as a number.
            (
                with(&format!(
                    r#","writer":{{"pid":{{"$serde_json::private::Number":"{pid}"}},"startedAtMs":{started_at_ms}}}"#
                )),
                None,
            ),
            (
                with(&format!(r#","writer":{{"pid":{pid},"startedAtMs":"{started_at_ms}"}}"#)),
                None,
            ),
            (
                with(&format!(
                    r#","writer":{{"pid":{pid},"startedAtMs":{started_at_ms},"x":1}}"#
                )),
                None,
            ),
            (with(r#","writer":null"#), None),
            (with(r#","reason":"r""#), None),
            (with(r#","extra":1"#), None),
            (with(&format!(r#","extra":{}{}"#, "[".repeat(40), "]".repeat(40))), None),
            (with(&format!(r#","extra":{}{}"#, "[".repeat(200), "]".repeat(200))), None),
            (
                format!("{}1{}", "[".repeat(20_000), "]".repeat(20_000)).into_bytes(),
                None,
            ),
            ([with(""), b" x".to_vec()].concat(), None),
            (bom, None),
            (
                br#"{"generation":"G","reason":"\ud800","since":"s","state":"DATABASE_DAMAGED"}"#
                    .to_vec(),
                None,
            ),
            (
                b"{\"generation\":\"G\",\"reason\":\"r\x01\",\"since\":\"s\",\"state\":\"DATABASE_DAMAGED\"}"
                    .to_vec(),
                None,
            ),
            (
                br#"{"generation":"G","reason":"r","since":"s","state":"OTHER"}"#.to_vec(),
                None,
            ),
            (b"{not json".to_vec(), None),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_differential_cases_say_what_this_reader_reads() {
        for (bytes, expect) in corpus::cases(4242, 1_760_000_000_123) {
            let got = DamagedState::parse(&bytes)
                .map(|s| (s.reason, s.writer.map(|w| (w.pid, w.started_at_ms))));
            assert_eq!(got, expect, "{}", String::from_utf8_lossy(&bytes));
        }
    }

    const BODY: &str = r#""generation":"G","reason":"r","since":"s","state":"DATABASE_DAMAGED""#;

    fn with(extra: &str) -> Vec<u8> {
        format!("{{{BODY}{extra}}}").into_bytes()
    }

    fn writer_of(extra: &str) -> Option<Option<Writer>> {
        DamagedState::parse(&with(extra)).map(|s| s.writer)
    }

    #[test]
    fn what_the_host_writes_reads_back() {
        for writer in [
            None,
            Some(Writer {
                pid: 4242,
                started_at_ms: 1_760_000_000_123,
            }),
        ] {
            let state = DamagedState {
                since: "2026-10-14T00:00:00.000Z".into(),
                generation: "01J0".into(),
                reason: "file is not a database: \"x\"\n\\ \u{1} 中文 😀".into(),
                writer,
            };
            assert_eq!(
                DamagedState::parse(state.to_json().as_bytes()),
                Some(state.clone())
            );
        }
        // Whitespace and escapes another writer could use are fine.
        let spaced = b" {\n \"state\" : \"DATABASE_DAMAGED\", \"since\":\"s\",\t\"generation\":\"G\",\r\n \"reason\":\"\\u4e2d\\ud83d\\ude00\\/\" } ";
        assert_eq!(DamagedState::parse(spaced).unwrap().reason, "中😀/");
    }

    #[test]
    fn the_writer_is_two_whole_numbers_and_nothing_else() {
        assert_eq!(writer_of(""), Some(None));
        assert_eq!(
            writer_of(r#","writer":{"pid":1,"startedAtMs":2}"#),
            Some(Some(Writer {
                pid: 1,
                started_at_ms: 2
            }))
        );
        // Whole values written another way are the same numbers.
        assert_eq!(
            writer_of(r#","writer":{"pid":1.0,"startedAtMs":2e3}"#),
            Some(Some(Writer {
                pid: 1,
                started_at_ms: 2000
            }))
        );
        assert_eq!(
            writer_of(r#","writer":{"pid":4294967295,"startedAtMs":9007199254740991}"#),
            Some(Some(Writer {
                pid: u32::MAX,
                started_at_ms: 9_007_199_254_740_991
            }))
        );
        for bad in [
            r#","writer":null"#,
            r#","writer":[1,2]"#,
            r#","writer":{"pid":1}"#,
            r#","writer":{"pid":1,"startedAtMs":2,"x":3}"#,
            r#","writer":{"pid":1.5,"startedAtMs":2}"#,
            r#","writer":{"pid":-1,"startedAtMs":2}"#,
            r#","writer":{"pid":4294967296,"startedAtMs":2}"#,
            r#","writer":{"pid":1,"startedAtMs":9007199254740992}"#,
            r#","writer":{"pid":1,"startedAtMs":1e400}"#,
            r#","writer":{"pid":"1","startedAtMs":2}"#,
            // peer r11 P2-01d: serde_json with arbitrary_precision reads this as the number 1.
            r#","writer":{"pid":{"$serde_json::private::Number":"1"},"startedAtMs":2}"#,
        ] {
            assert_eq!(writer_of(bad), None, "{bad}");
        }
    }

    #[test]
    fn anything_but_the_exact_shape_is_a_broken_file() {
        for bad in [
            r#"{"state":"DATABASE_DAMAGED","since":"s","generation":"G"}"#,
            r#"{"state":"OTHER","since":"s","generation":"G","reason":"r"}"#,
            r#"{"state":"DATABASE_DAMAGED","since":"s","generation":"G","reason":7}"#,
            r#"{"state":"DATABASE_DAMAGED","since":"s","generation":"G","reason":"r","extra":1}"#,
            r#"{"state":"DATABASE_DAMAGED","since":"s","generation":"G","reason":"r","reason":"r"}"#,
            r#"[]"#,
            r#""#,
            r#"{"state":"DATABASE_DAMAGED","since":"s","generation":"G","reason":"r"} x"#,
            r#"{"state":"DATABASE_DAMAGED","since":"s","generation":"G","reason":"r",}"#,
            r#"{"state":"DATABASE_DAMAGED","since":"s","generation":"G","reason":"\ud800"}"#,
            r#"{"state":"DATABASE_DAMAGED","since":"s","generation":"G","reason":"\udc00\ud800"}"#,
            r#"{"state":"DATABASE_DAMAGED","since":"s","generation":"G","reason":"\x"}"#,
            "{\"state\":\"DATABASE_DAMAGED\",\"since\":\"s\",\"generation\":\"G\",\"reason\":\"a\u{1}\"}",
        ] {
            assert_eq!(DamagedState::parse(bad.as_bytes()), None, "{bad}");
        }
        // Not UTF-8, and a BOM.
        assert_eq!(DamagedState::parse(&[b'{', 0xff, b'}']), None);
        let mut bom = vec![0xef, 0xbb, 0xbf];
        bom.extend_from_slice(&with(""));
        assert_eq!(DamagedState::parse(&bom), None);
    }

    /// peer r11 P2-01d: nesting has one limit for every reader of this file.
    #[test]
    fn nesting_past_the_limit_is_a_broken_file_and_within_it_only_the_shape_counts() {
        let nested = |n: usize| format!("{}{}", "[".repeat(n), "]".repeat(n));
        // A nested writer is not a writer: the file is broken whatever the depth.
        for n in [1, MAX_DEPTH - 1, MAX_DEPTH, 130, 3000] {
            assert_eq!(
                writer_of(&format!(",\"writer\":{}", nested(n))),
                None,
                "{n}"
            );
        }
        // Too deep is rejected before the shape is looked at, and does not overflow the stack.
        let deep = format!("{}1{}", "[".repeat(100_000), "]".repeat(100_000));
        assert_eq!(DamagedState::parse(deep.as_bytes()), None);
    }
}
