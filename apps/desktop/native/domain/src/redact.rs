//! 日志里的密钥脱敏：宿主日志（`host.log`）与更新日志共用一套语义（peer W5 r1 P1-02）。
//!
//! 按空白切词，逐词判断：
//! - `Bearer` / `Basic` 之后的那个词是密钥；
//! - `Authorization` 作为键（`Authorization:`、`authorization=`、JSON 的 `"authorization":`）之后是
//!   `[认证方案] 密钥`，整段只留一个占位，紧凑写法（`Authorization:Bearer x`、`"authorization":"Bearer x"`）同样；
//! - `token=`、`api_key:`、`"secret": "x"` 这类键值对的值换成占位；值在下一个词时下一个词换掉。
//!
//! 键前面只能是开头或 `?` `&` `_` `-` `.` `=` `:`、引号、括号、逗号、分号，免得把 `monkey=` 当成 `key=`。
//! 路径怎么处理由调用方决定：宿主日志要留路径定位问题，更新日志换成占位。截断也由调用方做。

/// 本机路径（`C:\…`、`\\server\…`、`file:///…`）的处理。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Paths {
    Keep,
    Hide,
}

const PLACEHOLDER: &str = "<redacted>";

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

/// 一个词去掉包在外面的引号、括号与标点之后的样子（小写）。
fn core(token: &str) -> String {
    token
        .trim_matches(|c: char| "\"'()[]{},;".contains(c))
        .to_ascii_lowercase()
}

fn is_local_path(token: &str) -> bool {
    let t = token
        .trim_start_matches(['"', '\'', '('])
        .trim_start_matches("file:///");
    let b = t.as_bytes();
    (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
        || t.starts_with("\\\\")
}

/// 词里的键值对：`(键, 值开始的字节位置)`。键后可以夹一个引号再接 `=` 或 `:`。
fn assignment(token: &str) -> Option<(&'static str, usize)> {
    let lower = token.to_ascii_lowercase();
    for at in (0..lower.len()).filter(|&i| lower.is_char_boundary(i)) {
        let before = lower[..at].chars().last();
        if at > 0
            && !matches!(
                before,
                Some(
                    '?' | '&'
                        | '_'
                        | '-'
                        | '.'
                        | '='
                        | ':'
                        | '"'
                        | '\''
                        | '('
                        | '['
                        | '{'
                        | ','
                        | ';'
                )
            )
        {
            continue;
        }
        for key in KEYS {
            if !lower[at..].starts_with(key) {
                continue;
            }
            let mut i = at + key.len();
            if matches!(lower.as_bytes().get(i), Some(b'"' | b'\'')) {
                i += 1;
            }
            if matches!(lower.as_bytes().get(i), Some(b'=' | b':')) {
                return Some((key, i + 1));
            }
        }
    }
    None
}

#[derive(PartialEq)]
enum Next {
    Plain,
    /// 下一个词是密钥，换成占位。
    Secret,
    /// 下一个词是密钥，已经有占位了，直接去掉。
    Drop,
    /// `Authorization` 之后：可能先来一个认证方案，再来密钥。
    AfterAuthorization,
}

/// 脱敏一段文本：空白压成单个空格，密钥换成 `<redacted>`，按 `paths` 处理本机路径。
pub fn redact_secrets(text: &str, paths: Paths) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut next = Next::Plain;
    for token in text.split_whitespace() {
        let c = core(token);
        match next {
            Next::AfterAuthorization if SCHEMES.contains(&c.as_str()) => {
                next = Next::Secret;
                continue;
            }
            Next::AfterAuthorization | Next::Secret => {
                out.push(PLACEHOLDER.into());
                next = Next::Plain;
                continue;
            }
            Next::Drop => {
                next = Next::Plain;
                continue;
            }
            Next::Plain => {}
        }
        if c == "bearer" || c == "basic" {
            out.push(token.to_owned());
            next = Next::Secret;
            continue;
        }
        if paths == Paths::Hide && is_local_path(token) {
            out.push("<local-path>".into());
            continue;
        }
        let Some((key, cut)) = assignment(token) else {
            out.push(token.to_owned());
            continue;
        };
        let value = core(&token[cut..]);
        out.push(if value.is_empty() {
            token[..cut].to_owned()
        } else {
            format!("{}{PLACEHOLDER}", &token[..cut])
        });
        next = match (key, value.is_empty()) {
            // `Authorization:` 单独一个词：后面是 `[方案] 密钥`。
            ("authorization", true) => Next::AfterAuthorization,
            // `Authorization:Bearer`：密钥在下一个词，占位已经写了。
            ("authorization", false) if SCHEMES.contains(&value.as_str()) => Next::Drop,
            // `"token":` 后面跟空格：值在下一个词。
            (_, true) => Next::Secret,
            _ => Next::Plain,
        };
    }
    out.join(" ")
}

#[cfg(test)]
mod tests {
    use super::{Paths, redact_secrets};

    const SECRET: &str = "SYNTHETIC_SECRET_9f3";

    /// 各种写法里，合成密钥一个字符都不能留下（peer W5 r1 P1-02 的反例在第一条）。
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
                "url ?token=<redacted> user_key=<redacted> monkey=fine",
            ),
            ("api_key=K1 monkey=fine", "api_key=<redacted> monkey=fine"),
            (
                r#"{"token": "abc", "n": 1}"#,
                r#"{"token": <redacted> "n": 1}"#,
            ),
            ("tokens counted: 5", "tokens counted: 5"),
            ("authorized: yes", "authorized: yes"),
            ("  many \n spaces\t", "many spaces"),
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
    }
}
