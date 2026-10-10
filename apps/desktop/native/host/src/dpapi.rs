//! `AyanamiTaskManager.exe --dpapi protect|unprotect`: Windows DPAPI for the core.
//!
//! The core keeps the phone-sync relay token and pairing secret on disk, sealed so that they are
//! never written in plain text (docs/security-model.md). Electron's safeStorage did that and left
//! with Electron (ADR-016); Node has no DPAPI binding, so the core starts this binary the way it
//! does for `--process-identity`. It sits in the same version directory as the core bundle, so
//! it is exactly as trusted as the code asking.
//!
//! Protocol: one line of hex on stdin, the result as one line of lowercase hex on stdout. The
//! data never travels on the command line. Exit code 1 and no output for an unknown operation,
//! malformed or oversized input, or a failed call. The calls are `atm_sync::dpapi` (current
//! Windows user, bound to its `ENTROPY`, never any UI), the same code the 3.0 sync store and the
//! conversion's self-check use, so there is one definition of the purpose binding.

use std::io::{Read, Write};

pub const FLAG: &str = "--dpapi";

/// Secrets are short (a relay token, a pairing secret); the cap bounds memory for any input.
const MAX_INPUT_HEX: usize = 64 * 1024;

pub fn run(operation: Option<&str>) -> i32 {
    let protect = match operation {
        Some("protect") => true,
        Some("unprotect") => false,
        _ => return 1,
    };
    let Some(input) = read_input(std::io::stdin().lock()) else {
        return 1;
    };
    let Some(output) = transform(&input, protect) else {
        return 1;
    };
    let mut stdout = std::io::stdout();
    if stdout
        .write_all(format!("{}\n", encode(&output)).as_bytes())
        .is_err()
        || stdout.flush().is_err()
    {
        return 1;
    }
    0
}

/// One hex line, optionally ending in LF or CRLF; anything longer than the cap is refused.
fn read_input(reader: impl Read) -> Option<Vec<u8>> {
    let mut text = String::new();
    // Two bytes for a CRLF and one more to notice input past the cap.
    reader
        .take(MAX_INPUT_HEX as u64 + 3)
        .read_to_string(&mut text)
        .ok()?;
    let line = text
        .strip_suffix('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .unwrap_or(&text);
    if line.len() > MAX_INPUT_HEX {
        return None;
    }
    decode(line)
}

fn encode(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push(char::from(DIGITS[usize::from(byte >> 4)]));
        text.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    text
}

fn decode(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    text.as_bytes()
        .chunks(2)
        .map(|pair| {
            let high = char::from(pair[0]).to_digit(16)?;
            let low = char::from(pair[1]).to_digit(16)?;
            u8::try_from(high * 16 + low).ok()
        })
        .collect()
}

fn transform(data: &[u8], protect: bool) -> Option<Vec<u8>> {
    if protect {
        atm_sync::dpapi::protect(data)
    } else {
        atm_sync::dpapi::unprotect(data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2.x 的密文就是这里加密的：转换前的自检（`atm_runtime::secrets::check`）必须解得开，
    /// 否则每个真实用户都会被判成手机配对要重做。
    #[test]
    fn a_secret_the_2x_host_sealed_passes_the_conversion_check() {
        const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let sealed = transform(b"space:secret", true).unwrap();
        let mut b64 = String::new();
        for chunk in sealed.chunks(3) {
            let mut b = [0u8; 3];
            b[..chunk.len()].copy_from_slice(chunk);
            let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
            for i in 0..4 {
                b64.push(if i <= chunk.len() {
                    char::from(A[(n >> (18 - 6 * i) & 63) as usize])
                } else {
                    '='
                });
            }
        }
        let file = format!(r#"{{"relay-token":"{b64}","space-secret":"{b64}"}}"#);
        assert!(atm_runtime::secrets::check(file.as_bytes()));
        assert_eq!(
            transform(&sealed, false).as_deref(),
            Some(&b"space:secret"[..])
        );
    }

    #[test]
    fn hex_round_trips_and_rejects_malformed_text() {
        let bytes = [0x00, 0x0f, 0xa5, 0xff];
        assert_eq!(encode(&bytes), "000fa5ff");
        assert_eq!(decode("000fa5ff").as_deref(), Some(&bytes[..]));
        assert_eq!(decode("000FA5FF").as_deref(), Some(&bytes[..]));
        assert_eq!(decode("").as_deref(), Some(&[][..]));
        assert_eq!(decode("abc"), None);
        assert_eq!(decode("zz"), None);
        assert_eq!(decode("+1"), None);
    }

    #[test]
    fn input_is_one_line_within_the_cap() {
        assert_eq!(
            read_input(&b"0aff\n"[..]).as_deref(),
            Some(&[0x0a, 0xff][..])
        );
        assert_eq!(
            read_input(&b"0aff\r\n"[..]).as_deref(),
            Some(&[0x0a, 0xff][..])
        );
        assert_eq!(read_input(&b"0aff"[..]).as_deref(), Some(&[0x0a, 0xff][..]));
        assert_eq!(read_input(&b"0a\nff\n"[..]), None);
        let at_cap = "a".repeat(MAX_INPUT_HEX) + "\r\n";
        assert_eq!(
            read_input(at_cap.as_bytes()).map(|data| data.len()),
            Some(MAX_INPUT_HEX / 2)
        );
        let over_cap = "a".repeat(MAX_INPUT_HEX + 2);
        assert_eq!(read_input(over_cap.as_bytes()), None);
    }

    #[test]
    fn sealed_data_opens_only_through_dpapi() {
        let secret = b"atr_relay-token:space-secret";
        let sealed = transform(secret, true).expect("protect");
        assert!(!sealed.is_empty());
        assert!(
            !sealed.windows(secret.len()).any(|window| window == secret),
            "the blob must not contain the plaintext"
        );
        assert_eq!(transform(&sealed, false).as_deref(), Some(&secret[..]));
        let mut tampered = sealed.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0x01;
        assert_eq!(transform(&tampered, false), None);
        assert_eq!(transform(b"not a dpapi blob", false), None);
    }

    #[test]
    fn unknown_operations_are_refused_before_reading_input() {
        assert_eq!(run(None), 1);
        assert_eq!(run(Some("decrypt")), 1);
    }
}
