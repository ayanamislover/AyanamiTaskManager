//! 日志里的密钥脱敏：宿主日志（`host.log`）与更新日志共用一套语义（peer W5 r1 P1-02、r2 P1-01）。
//!
//! 在原字符串上逐个位置扫描「键 → 分隔符 → 值」，不先按空白切词：同一个词里的多个键值对
//! （`{"token":"a","authorization":"Bearer x"}`）、键与冒号之间的空白（`{"token" : "x"}`）、
//! 带空格的引号值（`password="a b"`）都按值本身的边界换成占位。
//!
//! - 键：`token=`、`api_key:`、`"secret": "x"`……键后可以夹一个引号，键与分隔符、分隔符与值之间可以有空白；
//!   键前面只能是开头、空白或 `?` `&` `_` `-` `.` `=` `:`、引号、括号、逗号、分号，免得把 `monkey=` 当成 `key=`。
//! - 值：引号开头的到配对的引号为止（没有配对就到结尾），否则到空白或 `&` `,` `;` `)` `]` `}` 为止。
//! - `Authorization` 的值是「[认证方案] 密钥」，整段一个占位；引号包着的整段同样。
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

/// 键前面允许的字符（另加开头与空白）。
fn opens_key(c: u8) -> bool {
    c.is_ascii_whitespace() || b"?&_-.=:\"'([{,;".contains(&c)
}

/// 不带引号的值在这些字符处结束。
fn ends_value(c: u8) -> bool {
    c.is_ascii_whitespace() || b"&,;)]}".contains(&c)
}

fn skip_space(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && b[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}

/// 从 `i` 开始的一个值的结束位置（不含）。
fn value_end(b: &[u8], i: usize) -> usize {
    match b.get(i) {
        Some(&q @ (b'"' | b'\'')) => b[i + 1..]
            .iter()
            .position(|&c| c == q)
            .map_or(b.len(), |at| i + 1 + at + 1),
        _ => {
            let mut j = i;
            while j < b.len() && !ends_value(b[j]) {
                j += 1;
            }
            j
        }
    }
}

/// `Authorization` 的值：引号包着的整段，或「[方案] 密钥」。
fn authorization_end(lower: &[u8], i: usize) -> usize {
    if matches!(lower.get(i), Some(b'"' | b'\'')) {
        return value_end(lower, i);
    }
    let first = value_end(lower, i);
    let word = std::str::from_utf8(&lower[i..first]).unwrap_or("");
    if !SCHEMES.contains(&word) {
        return first;
    }
    let next = skip_space(lower, first);
    let end = value_end(lower, next);
    if end > next { end } else { first }
}

/// `i` 处起的密钥：`(值开始, 值结束)`。
fn secret_at(lower: &[u8], i: usize) -> Option<(usize, usize)> {
    let rest = &lower[i..];
    if rest.starts_with(b"bearer") && lower.get(i + 6).is_some_and(u8::is_ascii_whitespace) {
        let start = skip_space(lower, i + 6);
        let end = value_end(lower, start);
        return (end > start).then_some((start, end));
    }
    let key = KEYS.iter().find(|key| {
        if !rest.starts_with(key.as_bytes()) {
            return false;
        }
        let mut j = i + key.len();
        if matches!(lower.get(j), Some(b'"' | b'\'')) {
            j += 1;
        }
        matches!(lower.get(skip_space(lower, j)), Some(b'=' | b':'))
    })?;
    let mut j = i + key.len();
    if matches!(lower.get(j), Some(b'"' | b'\'')) {
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

/// `i` 处（开头或空白之后）起的本机路径的结束位置：引号包着的到配对引号，否则到空白。
fn local_path_end(text: &str, i: usize) -> Option<usize> {
    let b = text.as_bytes();
    let mut start = i;
    while matches!(b.get(start), Some(b'"' | b'\'' | b'(')) {
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
    let end = match b[i] {
        q @ (b'"' | b'\'') => b[i + 1..]
            .iter()
            .position(|&c| c == q)
            .map_or(b.len(), |at| i + 1 + at + 1),
        _ => {
            i + b[i..]
                .iter()
                .position(u8::is_ascii_whitespace)
                .unwrap_or(b.len() - i)
        }
    };
    Some(end)
}

/// 脱敏一段文本：密钥换成 `<redacted>`，按 `paths` 处理本机路径，空白压成单个空格。
pub fn redact_secrets(text: &str, paths: Paths) -> String {
    // 只把 ASCII 变小写，字节位置不变；匹配用的字符都是 ASCII，切片都落在字符边界上。
    let lower = text.to_ascii_lowercase();
    let b = lower.as_bytes();
    let mut out = String::with_capacity(text.len());
    let (mut i, mut copied) = (0, 0);
    while i < b.len() {
        let after_space = i == 0 || b[i - 1].is_ascii_whitespace();
        if paths == Paths::Hide
            && after_space
            && let Some(end) = local_path_end(text, i)
        {
            out.push_str(&text[copied..i]);
            out.push_str(LOCAL_PATH);
            (i, copied) = (end, end);
            continue;
        }
        if (i == 0 || opens_key(b[i - 1]))
            && let Some((start, end)) = secret_at(b, i)
        {
            out.push_str(&text[copied..start]);
            out.push_str(PLACEHOLDER);
            (i, copied) = (end, end);
            continue;
        }
        i += 1;
    }
    out.push_str(&text[copied..]);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::{Paths, redact_secrets};

    const SECRET: &str = "SYNTHETIC_SECRET_9f3";

    /// 各种写法里，合成密钥一个字符都不能留下（peer W5 r1 P1-02 的反例在第一条，r2 的反例在后面一组）。
    #[test]
    fn secrets_never_survive() {
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
            r#"{"token"	:	"SYNTHETIC_SECRET_9f3"}"#,
            "token = SYNTHETIC_SECRET_9f3",
            r#"password="public SYNTHETIC_SECRET_9f3" operation failed"#,
            "secret='a b SYNTHETIC_SECRET_9f3'",
            r#"authorization: "Bearer SYNTHETIC_SECRET_9f3""#,
            "token=a&password=SYNTHETIC_SECRET_9f3",
            "token=a,api_key=SYNTHETIC_SECRET_9f3",
            r#"password="unterminated SYNTHETIC_SECRET_9f3"#,
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
                "basic database validation failed",
                "basic database validation failed",
            ),
            ("bearers are fine", "bearers are fine"),
            ("tokens counted: 5", "tokens counted: 5"),
            ("authorized: yes", "authorized: yes"),
            ("token: ", "token:"),
            ("  many \n spaces\t", "many spaces"),
            ("数据库 token=秘密 之后", "数据库 token=<redacted> 之后"),
        ];
        for (input, want) in cases {
            assert_eq!(redact_secrets(input, Paths::Keep), want, "{input:?}");
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
        assert_eq!(
            redact_secrets("open \"C:\\Program Files\\atm\\x.db\" failed", Paths::Hide),
            "open <local-path> failed"
        );
    }
}
