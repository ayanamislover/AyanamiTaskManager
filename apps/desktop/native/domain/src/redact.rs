//! 日志里的密钥脱敏：宿主日志（`host.log`）与更新日志共用一套语义（peer W5 r1 P1-02、r2 P1-01、r3 P1-01）。
//!
//! 在原字符串上按字符边界扫描「键 → 分隔符 → 值」，不先按空白切词：同一个词里的多个键值对
//! （`{"token":"a","authorization":"Bearer x"}`）、键与冒号之间的空白（`{"token" : "x"}`）、
//! 带空格的引号值（`password="a b"`）都按值本身的边界换成占位。
//!
//! - 空白：一律是 Unicode 空白（`char::is_whitespace`），与最后压空白用的 `split_whitespace` 同一个口径，
//!   全角空格、不换行空格旁边的键与值照样识别。
//! - 键：`token=`、`api_key:`、`"secret": "x"`……键后可以夹一个引号，键与分隔符、分隔符与值之间可以有空白；
//!   键前面只能是开头或不是 ASCII 字母、数字的字符，免得把 `monkey=` 当成 `key=`。
//! - 值：引号开头的到配对的引号为止，反斜杠转义下一个字符（`\"` 不结束，`\\"` 结束），没有配对就到结尾；
//!   否则到空白或 `&` `,` `;` `)` `]` `}` 为止。
//! - `Authorization` 的值是「[认证方案] 密钥」，整段一个占位；引号包着的整段同样，引号里只有方案时连同下一个词。
//! - 单独出现的 `Bearer x`：`x` 是密钥。`Basic` 是常用词，只在 `Authorization` 之后才算方案。
//!
//! 路径怎么处理由调用方决定：宿主日志要留路径定位问题，更新日志换成占位。最后空白压成单个空格；截断由调用方做。

/// 本机路径（`C:\…`、`\\server\…`、`file:///…`）的处理。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Paths {
    Keep,
    Hide,
}

const PLACEHOLDER: &str = "<redacted>";
const LOCAL_PATH: &str = "<local-path>";

/// 键，长的在前（同一位置先认长的）。
const KEYS: [&str; 13] = [
    "authorization",
    "access_token",
    "access-token",
    "accesstoken",
    "signature",
    "password",
    "api_key",
    "api-key",
    "secret",
    "apikey",
    "token",
    "auth",
    "key",
];

/// 认证方案：`Authorization: <方案> <密钥>` 里方案本身不是密钥，但和密钥一起只留一个占位。
const SCHEMES: [&str; 5] = ["bearer", "basic", "digest", "negotiate", "token"];

/// 不跟在 `Authorization` 后面也认的方案：`Bearer x` 的 `x` 是密钥。
const LONE_SCHEMES: [&str; 1] = ["bearer"];

/// `i` 处的字符（`i` 在字符边界上）。
fn char_at(s: &str, i: usize) -> Option<char> {
    s[i..].chars().next()
}

/// 键前面允许的字符（另加开头）：不是 ASCII 字母、数字就行。`monkey=` 的 `key` 前面是 `n`，不算键；
/// `)password=`、`日志token=`、零宽字符后的键都算（peer W5 r5：路径的右括号紧贴着键）。
fn opens_key(c: char) -> bool {
    !c.is_ascii_alphanumeric()
}

/// 不带引号的值在这些字符处结束。
fn ends_value(c: char) -> bool {
    c.is_whitespace() || "&,;)]}".contains(c)
}

fn skip_space(s: &str, mut i: usize) -> usize {
    while let Some(c) = char_at(s, i).filter(|c| c.is_whitespace()) {
        i += c.len_utf8();
    }
    i
}

/// `i` 处是引号时，到配对引号之后的位置；反斜杠转义下一个字符，没有配对就到结尾。
fn quoted_end(s: &str, i: usize) -> Option<usize> {
    let q = char_at(s, i).filter(|c| matches!(c, '"' | '\''))?;
    let mut chars = s[i + 1..].char_indices();
    while let Some((at, c)) = chars.next() {
        if c == '\\' {
            chars.next();
        } else if c == q {
            return Some(i + 1 + at + 1);
        }
    }
    Some(s.len())
}

/// `i` 处是引号时，到下一个同样的引号之后的位置，反斜杠不转义（Windows 路径里它是分隔符，
/// `"C:\Program Files\"` 的结尾就是那个引号，peer W5 r4 P2-01）；没有配对就到结尾。
fn raw_quoted_end(s: &str, i: usize) -> Option<usize> {
    let q = char_at(s, i).filter(|c| matches!(c, '"' | '\''))?;
    Some(
        s[i + 1..]
            .find(q)
            .map_or(s.len(), |at| i + 1 + at + q.len_utf8()),
    )
}

/// 从 `i` 开始的一个值的结束位置（不含）。
fn value_end(s: &str, i: usize) -> usize {
    if let Some(end) = quoted_end(s, i) {
        return end;
    }
    let mut j = i;
    while let Some(c) = char_at(s, j).filter(|&c| !ends_value(c)) {
        j += c.len_utf8();
    }
    j
}

/// `Authorization` 的值：「[方案] 密钥」，方案可以单独被引号包着；整段引号同样是一个值。
fn authorization_end(lower: &str, i: usize) -> usize {
    let first = value_end(lower, i);
    let word = lower[i..first].trim_matches(|c| c == '"' || c == '\'');
    if !SCHEMES.contains(&word) {
        return first;
    }
    let next = skip_space(lower, first);
    let end = value_end(lower, next);
    if end > next { end } else { first }
}

/// `i` 处起的密钥：`(值开始, 值结束)`。
fn secret_at(lower: &str, i: usize) -> Option<(usize, usize)> {
    let rest = &lower[i..];
    for word in LONE_SCHEMES {
        let after = i + word.len();
        if rest.starts_with(word) && char_at(lower, after).is_some_and(char::is_whitespace) {
            let start = skip_space(lower, after);
            let end = value_end(lower, start);
            return (end > start).then_some((start, end));
        }
    }
    let key = KEYS.iter().find(|key| {
        if !rest.starts_with(**key) {
            return false;
        }
        let mut j = i + key.len();
        if matches!(char_at(lower, j), Some('"' | '\'')) {
            j += 1;
        }
        matches!(char_at(lower, skip_space(lower, j)), Some('=' | ':'))
    })?;
    let mut j = i + key.len();
    if matches!(char_at(lower, j), Some('"' | '\'')) {
        j += 1;
    }
    let start = skip_space(lower, skip_space(lower, j) + 1);
    let end = if *key == "authorization" {
        authorization_end(lower, start)
    } else {
        value_end(lower, start)
    };
    (end > start).then_some((start, end))
}

/// `i` 处（开头或空白之后）起的本机路径的结束位置。前面可以包着括号与引号：有引号时到下一个同样的引号
/// （路径里的反斜杠是分隔符，不当转义），再连同紧跟的括号等到空白为止；没有引号时到空白为止。
/// 尾部碰到密钥键就停下，把键交回密钥扫描（peer W5 r5 P1-01：`'C:\x\';password="a b"`、`C:\x;token=y`）。
fn local_path_end(text: &str, lower: &str, i: usize) -> Option<usize> {
    let mut start = i;
    let mut quote = None;
    while let Some(c) = char_at(text, start).filter(|c| matches!(c, '"' | '\'' | '(')) {
        if c != '(' {
            quote = Some(start);
        }
        start += 1;
    }
    let t = text[start..]
        .strip_prefix("file:///")
        .unwrap_or(&text[start..]);
    let p = t.as_bytes();
    let is_path = (p.len() >= 3
        && p[0].is_ascii_alphabetic()
        && p[1] == b':'
        && (p[2] == b'\\' || p[2] == b'/'))
        || t.starts_with("\\\\");
    if !is_path {
        return None;
    }
    let mut end = quote.and_then(|q| raw_quoted_end(text, q)).unwrap_or(start);
    while let Some(c) = char_at(text, end).filter(|c| !c.is_whitespace()) {
        let next = end + c.len_utf8();
        let key_here = text[..end].chars().next_back().is_some_and(opens_key)
            && secret_at(lower, end).is_some();
        // 分隔符留给后面的键：`<local-path>;password=<redacted>`。
        let key_next = opens_key(c) && secret_at(lower, next).is_some();
        if key_here || key_next {
            break;
        }
        end = next;
    }
    Some(end)
}

/// 脱敏一段文本：密钥换成 `<redacted>`，按 `paths` 处理本机路径，空白压成单个空格。
pub fn redact_secrets(text: &str, paths: Paths) -> String {
    // 只把 ASCII 变小写，字节位置不变；`i` 每次前进一个字符，切片都落在字符边界上。
    let lower = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let (mut i, mut copied) = (0, 0);
    while let Some(c) = char_at(text, i) {
        let before = text[..i].chars().next_back();
        if paths == Paths::Hide
            && before.is_none_or(char::is_whitespace)
            && let Some(end) = local_path_end(text, &lower, i)
        {
            out.push_str(&text[copied..i]);
            out.push_str(LOCAL_PATH);
            (i, copied) = (end, end);
            continue;
        }
        if before.is_none_or(opens_key)
            && let Some((start, end)) = secret_at(&lower, i)
        {
            out.push_str(&text[copied..start]);
            out.push_str(PLACEHOLDER);
            (i, copied) = (end, end);
            continue;
        }
        i += c.len_utf8();
    }
    out.push_str(&text[copied..]);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::{Paths, redact_secrets};

    const SECRET: &str = "SYNTHETIC_SECRET_9f3";

    /// 各种写法里，合成密钥一个字符都不能留下（peer W5 r1 P1-02 的反例在第一条，r2、r3 的反例在后面两组）。
    #[test]
    fn secrets_never_survive() {
        let long = format!(
            "password=\"{}\\\"SYNTHETIC_SECRET_9f3\" tail",
            "x".repeat(20_000)
        );
        for line in [
            "GET /x Authorization: Bearer SYNTHETIC_SECRET_9f3",
            "authorization: bearer SYNTHETIC_SECRET_9f3 tail",
            "AUTHORIZATION:   BEARER\tSYNTHETIC_SECRET_9f3",
            "Authorization:Bearer SYNTHETIC_SECRET_9f3",
            "Authorization: SYNTHETIC_SECRET_9f3",
            "Authorization:SYNTHETIC_SECRET_9f3",
            "Authorization: Basic SYNTHETIC_SECRET_9f3",
            "Proxy-Authorization: Bearer SYNTHETIC_SECRET_9f3",
            r#"{"authorization":"Bearer SYNTHETIC_SECRET_9f3"}"#,
            r#"{"Authorization": "Bearer SYNTHETIC_SECRET_9f3"}"#,
            r#"{"token": "SYNTHETIC_SECRET_9f3"}"#,
            r#"{"token":"SYNTHETIC_SECRET_9f3"}"#,
            "headers=authorization=SYNTHETIC_SECRET_9f3",
            "got bearer SYNTHETIC_SECRET_9f3 ok",
            "url ?token=SYNTHETIC_SECRET_9f3&x",
            "access_token:SYNTHETIC_SECRET_9f3",
            "user_key=SYNTHETIC_SECRET_9f3",
            "password=SYNTHETIC_SECRET_9f3",
            "(secret='SYNTHETIC_SECRET_9f3')",
            // r2：一个词里多个键、键与冒号之间有空白、引号值里有空格。
            r#"{"token":"public","authorization":"Bearer SYNTHETIC_SECRET_9f3"}"#,
            r#"{"token":"public","password":"SYNTHETIC_SECRET_9f3","n":1}"#,
            r#"{"token" : "SYNTHETIC_SECRET_9f3"}"#,
            "{\"token\"\t:\t\"SYNTHETIC_SECRET_9f3\"}",
            "token = SYNTHETIC_SECRET_9f3",
            r#"password="public SYNTHETIC_SECRET_9f3" operation failed"#,
            "secret='a b SYNTHETIC_SECRET_9f3'",
            r#"authorization: "Bearer SYNTHETIC_SECRET_9f3""#,
            "token=a&password=SYNTHETIC_SECRET_9f3",
            "token=a,api_key=SYNTHETIC_SECRET_9f3",
            r#"password="unterminated SYNTHETIC_SECRET_9f3"#,
            // r3：引号值里的转义引号、Unicode 空白、引号里只有方案、很长的前半段。
            r#"{"password":"public\"SYNTHETIC_SECRET_9f3"}"#,
            r#"Authorization: "public\"SYNTHETIC_SECRET_9f3""#,
            r#"password="a\\\"SYNTHETIC_SECRET_9f3" tail"#,
            "日志\u{3000}token=SYNTHETIC_SECRET_9f3",
            "token\u{a0}=SYNTHETIC_SECRET_9f3",
            "password=\u{3000}\"public SYNTHETIC_SECRET_9f3\"",
            "Bearer\u{a0}SYNTHETIC_SECRET_9f3",
            "Authorization:\u{3000}Bearer\u{3000}SYNTHETIC_SECRET_9f3",
            r#"Authorization: "Bearer" SYNTHETIC_SECRET_9f3"#,
            "key=,token=SYNTHETIC_SECRET_9f3",
            "key=&password=SYNTHETIC_SECRET_9f3",
            &long,
        ] {
            for paths in [Paths::Keep, Paths::Hide] {
                let got = redact_secrets(line, paths);
                assert!(!got.contains(SECRET), "{line:?} -> {got:?}");
                assert!(got.contains("<redacted>"), "{line:?} -> {got:?}");
            }
        }
    }

    #[test]
    fn the_rest_of_the_line_stays() {
        let cases = [
            (
                "GET /x Authorization: Bearer abc\nnext",
                "GET /x Authorization: <redacted> next",
            ),
            (
                "Authorization:Bearer abc next",
                "Authorization:<redacted> next",
            ),
            ("got bearer xyz ok", "got bearer <redacted> ok"),
            (
                "url ?token=abc&x user_key=k monkey=fine",
                "url ?token=<redacted>&x user_key=<redacted> monkey=fine",
            ),
            ("api_key=K1 monkey=fine", "api_key=<redacted> monkey=fine"),
            (
                r#"{"token": "abc", "n": 1}"#,
                r#"{"token": <redacted>, "n": 1}"#,
            ),
            (
                r#"{"token":"a","authorization":"Bearer b","n":1}"#,
                r#"{"token":<redacted>,"authorization":<redacted>,"n":1}"#,
            ),
            (
                r#"password="a b" operation failed"#,
                "password=<redacted> operation failed",
            ),
            (
                r#"{"password":"a\"b","n":1}"#,
                r#"{"password":<redacted>,"n":1}"#,
            ),
            (
                r#"password="public\\" status=ok"#,
                "password=<redacted> status=ok",
            ),
            (
                "basic database validation failed",
                "basic database validation failed",
            ),
            ("bearers are fine", "bearers are fine"),
            ("tokens counted: 5", "tokens counted: 5"),
            ("authorized: yes", "authorized: yes"),
            ("key=, status=ok", "key=, status=ok"),
            ("token=; status=ok", "token=; status=ok"),
            ("token: ", "token:"),
            ("  many \n spaces\t", "many spaces"),
            ("数据库 token=秘密 之后", "数据库 token=<redacted> 之后"),
            (
                "日志\u{3000}token=x\u{3000}之后",
                "日志 token=<redacted> 之后",
            ),
        ];
        for (input, want) in cases {
            assert_eq!(redact_secrets(input, Paths::Keep), want, "{input:?}");
        }
    }

    /// 路径后面紧跟的密钥键（peer W5 r5 P1-01）：盘符 / UNC × 单双引号 / 不带引号 × 有无括号 ×
    /// 空格、紧贴、分号、逗号 × 普通值、带空格的引号值、带转义引号的值，两种模式都不留密钥。
    #[test]
    fn secrets_right_after_a_path_are_still_found() {
        let mut leaks = Vec::new();
        for path in ["C:\\My Data\\", "\\\\server\\My Share\\", "D:\\data"] {
            for q in ["'", "\"", ""] {
                for (left, right) in [("", ""), ("(", ")")] {
                    for gap in [" ", "", ";", ","] {
                        for value in [
                            SECRET.to_owned(),
                            format!("\"public {SECRET}\""),
                            format!("\"public\\\" {SECRET}\""),
                        ] {
                            for key in ["password", "authorization", "token"] {
                                // `D:\datapassword=` 与 `monkeypassword=` 分不开：键直接粘在字母后面不算键。
                                if q.is_empty()
                                    && right.is_empty()
                                    && gap.is_empty()
                                    && path == "D:\\data"
                                {
                                    continue;
                                }
                                let line = format!(
                                    "open {left}{q}{path}{q}{right}{gap}{key}={value} tail"
                                );
                                for paths in [Paths::Keep, Paths::Hide] {
                                    let got = redact_secrets(&line, paths);
                                    if got.contains(SECRET) || !got.ends_with(" tail") {
                                        leaks.push(format!("{paths:?} {line:?} -> {got:?}"));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        assert!(leaks.is_empty(), "{}:\n{}", leaks.len(), leaks.join("\n"));
        for (input, want) in [
            (
                "open 'C:\\My Data\\';password=\"a b\" tail",
                "open <local-path>;password=<redacted> tail",
            ),
            (
                "open C:\\data\\x;token=y tail",
                "open <local-path>;token=<redacted> tail",
            ),
            (
                "open (\"C:\\My Data\\\"),api_key=k tail",
                "open <local-path>,api_key=<redacted> tail",
            ),
            (
                "open C:\\keys\\api_key.txt failed",
                "open <local-path> failed",
            ),
        ] {
            assert_eq!(redact_secrets(input, Paths::Hide), want, "{input:?}");
        }
    }

    #[test]
    fn paths_are_kept_or_hidden_as_asked() {
        let line = "open C:\\data\\atm.sqlite: denied \\\\server\\share\\f file:///D:/x.zip";
        assert_eq!(redact_secrets(line, Paths::Keep), line);
        assert_eq!(
            redact_secrets(line, Paths::Hide),
            "open <local-path> denied <local-path> <local-path>"
        );
        for (input, want) in [
            (
                "open \"C:\\Program Files\\atm\\x.db\" failed",
                "open <local-path> failed",
            ),
            // peer W5 r3 P2-01：括号包着引号。
            (
                "open (\"C:\\Program Files\\atm\\x.db\") failed",
                "open <local-path> failed",
            ),
            ("open ('D:\\My Data\\x') next", "open <local-path> next"),
            ("open (C:\\data\\x) next", "open <local-path> next"),
            // peer W5 r4 P2-01：目录以分隔符结尾时，结尾的引号就是路径的结尾，后面的失败原因留着。
            (
                "open \"C:\\Program Files\\\" failed: access denied",
                "open <local-path> failed: access denied",
            ),
            (
                "open '\\\\server\\share\\' failed",
                "open <local-path> failed",
            ),
            ("open (\"D:\\data\\\") next", "open <local-path> next"),
            ("open ('E:\\x\\') next", "open <local-path> next"),
        ] {
            assert_eq!(redact_secrets(input, Paths::Hide), want, "{input:?}");
        }
    }
}
