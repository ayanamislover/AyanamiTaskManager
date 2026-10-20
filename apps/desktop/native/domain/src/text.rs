//! 与 2.x（JS）逐字一致的字符串小工具。
//!
//! 入参长度上限在 2.x 由 zod 检查，按 UTF-16 码元计数；`trim()` 按 ECMAScript 的
//! WhiteSpace + LineTerminator 去除。Rust 的 `str::trim` 用的是 Unicode `White_Space`，
//! 两者差两个字符：U+0085（Rust 去、JS 不去）和 U+FEFF（JS 去、Rust 不去）。
//! 规范化后的值进入存储和幂等指纹，所以这里必须按 JS 来。

/// ECMAScript `String.prototype.trim` 认的空白。
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `s.trim()`（JS 语义）。
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

/// JS 的 `s.length`：UTF-16 码元个数。
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// JS 的 `Math.round`：最近整数，恰好 .5 时取正无穷方向（不是银行家舍入，W-112）。
///
/// 不能写成 `(x + 0.5).floor()`：0.49999999999999994 + 0.5 在浮点里恰好是 1。
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_follows_ecmascript_not_unicode_white_space() {
        assert_eq!(js_trim("\u{FEFF} a \u{3000}"), "a");
        assert_eq!(js_trim("\u{0085}a\u{0085}"), "\u{0085}a\u{0085}");
        assert_eq!(js_trim("\u{2028}\t a b \r\n"), "a b");
        assert_eq!(js_trim("\u{180E}a"), "\u{180E}a");
    }

    #[test]
    fn length_counts_utf16_units() {
        assert_eq!(utf16_len("abc"), 3);
        assert_eq!(utf16_len("中文"), 2);
        assert_eq!(utf16_len("😀"), 2);
    }

    #[test]
    fn round_matches_math_round() {
        assert_eq!(js_round(0.5), 1.0);
        assert_eq!(js_round(1.5), 2.0);
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(0.49999999999999994), 0.0);
        assert_eq!(js_round(666.6666), 667.0);
        assert_eq!(js_round(4.4), 4.0);
    }
}
