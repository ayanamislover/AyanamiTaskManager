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
//! malformed or oversized input, or a failed call. Blobs are bound to the current Windows user
//! (no CRYPTPROTECT_LOCAL_MACHINE) and to [`ENTROPY`], and the calls never show UI.

use std::io::{Read, Write};

pub const FLAG: &str = "--dpapi";

/// Purpose binding: a blob another program sealed for the same user does not open here.
const ENTROPY: &[u8] = b"AyanamiTaskManager/sync-secret/v1";
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
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(data.len()).ok()?,
        pbData: data.as_ptr().cast_mut(),
    };
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(ENTROPY.len()).ok()?,
        pbData: ENTROPY.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: `input` and `entropy` point at live buffers of the stated sizes, which the calls
    // only read; `output` is a local the call fills with a LocalAlloc'd buffer, freed below.
    let ok = unsafe {
        if protect {
            CryptProtectData(
                &input,
                std::ptr::null(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    } != 0;
    if !ok || output.pbData.is_null() {
        return None;
    }
    // SAFETY: on success the call hands back `cbData` bytes at `pbData`.
    let result =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    // SAFETY: allocated by the call with LocalAlloc and not used after this.
    unsafe { LocalFree(output.pbData.cast()) };
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

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
