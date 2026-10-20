//! JS 口径的字符串长度与截断（长度按 UTF-16 码元，与 zod 的 `max` 同一口径）。

pub use atm_sync_protocol::encoding::js_len;

/// 前缀：整字符地取，总长不超过 `max` 个 UTF-16 码元（不劈开代理对）。
pub fn clip_units(text: &str, max: usize) -> String {
    let mut used = 0;
    let mut out = String::new();
    for c in text.chars() {
        used += c.len_utf16();
        if used > max {
            break;
        }
        out.push(c);
    }
    out
}

/// 2.x `clipText`：超过 `max` 时截到 `max - 1` 个码元再加省略号；不把代理对劈开，结果按码点数也不超过 `max`。
pub fn clip_text(text: &str, max: usize) -> String {
    if js_len(text) <= max {
        return text.to_owned();
    }
    format!("{}…", clip_units(text, max.saturating_sub(1)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipping_keeps_surrogate_pairs_whole() {
        assert_eq!(clip_text("abc", 3), "abc");
        assert_eq!(clip_text("abcd", 3), "ab…");
        // "a😀b"：a(1) 😀(2) b(1) = 4 个码元；截到 3 时只剩 2 个码元的位置，😀 放不下。
        assert_eq!(clip_text("a😀b", 3), "a…");
        assert_eq!(clip_text("😀😀", 3), "😀…");
        assert_eq!(clip_units("😀😀", 3), "😀");
    }
}
