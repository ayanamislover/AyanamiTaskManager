//! 转换前的密文自检（05 §3.4）：2.x 的 `sync/secrets.dpapi.json` 是 `{名字: base64(DPAPI 密文)}`，
//! 当前 Windows 账户逐个解得开才算通过。解不开说明换了账户或机器，手机配对要重做，由用户决定。
//! 只判断能不能解开，明文不留、不记。

use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
};

/// [`atm_store::legacy::ConvertOptions::secrets_check`] 的实现。
pub fn check(bytes: &[u8]) -> bool {
    let Ok(serde_json::Value::Object(map)) = serde_json::from_slice::<serde_json::Value>(bytes)
    else {
        return false;
    };
    map.values().all(|v| {
        v.as_str()
            .and_then(base64)
            .is_some_and(|sealed| opens(&sealed))
    })
}

fn opens(sealed: &[u8]) -> bool {
    let input = CRYPT_INTEGER_BLOB {
        cbData: sealed.len() as u32,
        pbData: sealed.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if !output.pbData.is_null() {
        // 明文立刻抹掉再释放。
        unsafe {
            std::ptr::write_bytes(output.pbData, 0, output.cbData as usize);
            LocalFree(output.pbData.cast());
        }
    }
    ok != 0
}

/// 标准 base64（Node 的 `toString("base64")`），带或不带补位。
fn base64(text: &str) -> Option<Vec<u8>> {
    let value = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let body = text.trim_end_matches('=');
    if body.is_empty() || text.len() - body.len() > 2 || body.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(body.len() * 3 / 4);
    for chunk in body.as_bytes().chunks(4) {
        let mut acc = 0u32;
        for (i, c) in chunk.iter().enumerate() {
            acc |= value(*c)? << (18 - 6 * i);
        }
        let bytes = acc.to_be_bytes();
        out.extend_from_slice(&bytes[1..chunk.len()]);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::Security::Cryptography::CryptProtectData;

    fn protect(plain: &[u8]) -> Vec<u8> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: plain.len() as u32,
            pbData: plain.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = unsafe {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        assert_ne!(ok, 0);
        let sealed =
            unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
        unsafe { LocalFree(output.pbData.cast()) };
        sealed
    }

    fn encode(bytes: &[u8]) -> String {
        const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut s = String::new();
        for chunk in bytes.chunks(3) {
            let mut b = [0u8; 3];
            b[..chunk.len()].copy_from_slice(chunk);
            let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
            for i in 0..4 {
                if i <= chunk.len() {
                    s.push(A[(n >> (18 - 6 * i) & 63) as usize] as char);
                } else {
                    s.push('=');
                }
            }
        }
        s
    }

    #[test]
    fn only_secrets_this_account_can_open_pass() {
        let sealed = encode(&protect(b"relay-secret"));
        let good = format!(r#"{{"relayToken":"{sealed}","deviceKey":"{sealed}"}}"#);
        assert!(check(good.as_bytes()));
        assert!(check(b"{}"));
        let mut broken = protect(b"relay-secret");
        let last = broken.len() - 1;
        broken[last] ^= 0xff;
        let tampered = format!(r#"{{"relayToken":"{}"}}"#, encode(&broken));
        assert!(!check(tampered.as_bytes()));
        for junk in [&b"not json"[..], b"[]", br#"{"a":1}"#, br#"{"a":"@@@"}"#] {
            assert!(!check(junk));
        }
    }

    #[test]
    fn base64_matches_node() {
        assert_eq!(base64("aGk="), Some(b"hi".to_vec()));
        assert_eq!(base64("aGk"), Some(b"hi".to_vec()));
        assert_eq!(base64("aGVsbG8="), Some(b"hello".to_vec()));
        assert_eq!(base64("a"), None);
        assert_eq!(base64("a==="), None);
    }
}
