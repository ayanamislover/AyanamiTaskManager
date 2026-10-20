//! 字节编码（`encoding.ts`）：base64url（不补位）、小写 hex、JS 语义的长度与 trim、UTF-8 解码、系统随机数。

const B64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// 不补位的 base64url（`toBase64Url`）。
pub fn to_base64url(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let mut b = [0u8; 3];
        b[..chunk.len()].copy_from_slice(chunk);
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..=chunk.len() {
            out.push(char::from(B64URL[((n >> (18 - 6 * i)) & 63) as usize]));
        }
    }
    out
}

/// `fromBase64Url`：只认 `[A-Za-z0-9_-]`，长度除以 4 余 1 的不是 base64。尾部多出的位与 `atob` 一样忽略。
pub fn from_base64url(text: &str) -> Option<Vec<u8>> {
    if text.len() % 4 == 1 {
        return None;
    }
    let value = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        } as u32)
    };
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    for chunk in text.as_bytes().chunks(4) {
        let mut acc = 0u32;
        for (i, c) in chunk.iter().enumerate() {
            acc |= value(*c)? << (18 - 6 * i);
        }
        let bytes = acc.to_be_bytes();
        out.extend_from_slice(&bytes[1..chunk.len()]);
    }
    Some(out)
}

pub fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(char::from(DIGITS[usize::from(b >> 4)]));
        s.push(char::from(DIGITS[usize::from(b & 15)]));
    }
    s
}

/// JS 的 `string.length`：UTF-16 码元数。
pub fn js_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// JS `String.prototype.trim` 去掉的字符：Unicode White_Space 去掉 U+0085，再加上 U+FEFF。
pub fn js_is_whitespace(c: char) -> bool {
    c == '\u{FEFF}' || (c.is_whitespace() && c != '\u{85}')
}

pub fn js_trim(s: &str) -> &str {
    s.trim_matches(js_is_whitespace)
}

/// `new TextDecoder("utf-8", { fatal: true }).decode`：严格 UTF-8，开头的 BOM 去掉。
pub fn from_utf8_js(bytes: &[u8]) -> Option<&str> {
    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    std::str::from_utf8(body).ok()
}

/// 系统随机数（`BCryptGenRandom`，与 cli 的 ULID 同一来源）；取不到就是取不到，不退回弱随机。
pub fn random_bytes<const N: usize>() -> Option<[u8; N]> {
    let mut buf = [0u8; N];
    fill(&mut buf)?;
    Some(buf)
}

#[cfg(windows)]
fn fill(buf: &mut [u8]) -> Option<()> {
    use std::ffi::c_void;
    const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x2;
    #[link(name = "bcrypt")]
    unsafe extern "system" {
        fn BCryptGenRandom(alg: *mut c_void, buf: *mut u8, len: u32, flags: u32) -> i32;
    }
    // SAFETY: the pointer and length describe `buf`; the system-preferred RNG needs no handle.
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            buf.as_mut_ptr(),
            u32::try_from(buf.len()).ok()?,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    (status >= 0).then_some(())
}

#[cfg(not(windows))]
fn fill(buf: &mut [u8]) -> Option<()> {
    use std::io::Read;
    std::fs::File::open("/dev/urandom")
        .ok()?
        .read_exact(buf)
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64url_round_trips_without_padding() {
        for n in 0..10 {
            let bytes: Vec<u8> = (0..n).map(|i| (i * 37 + 251) as u8).collect();
            let text = to_base64url(&bytes);
            assert!(!text.contains('='));
            assert_eq!(from_base64url(&text).unwrap(), bytes);
        }
        assert_eq!(to_base64url(&[0xfb, 0xff]), "-_8");
        assert_eq!(from_base64url("a"), None);
        assert_eq!(from_base64url("ab=="), None);
        assert_eq!(from_base64url("ab+/"), None);
        // atob 忽略多出的位。
        assert_eq!(from_base64url("AB").unwrap(), vec![0]);
    }

    #[test]
    fn js_string_semantics() {
        assert_eq!(js_len("a😀"), 3);
        assert_eq!(js_trim("\u{FEFF}\u{3000} x \u{2028}"), "x");
        assert_eq!(js_trim("\u{85}x"), "\u{85}x");
        assert_eq!(from_utf8_js(b"\xEF\xBB\xBF{}"), Some("{}"));
        assert_eq!(from_utf8_js(b"\xff"), None);
    }
}
