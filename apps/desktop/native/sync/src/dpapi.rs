//! Windows DPAPI，进程内调用：密文只有当前 Windows 用户解得开（不带 `CRYPTPROTECT_LOCAL_MACHINE`），
//! 绑定 [`ENTROPY`]，从不弹界面。2.x 的宿主 `--dpapi` 与 3.0 转换前的自检都走这里，entropy 只有这一处定义。

/// 用途绑定：同一用户下别的程序加密的东西在这里解不开，这里加密的东西别处不带它也解不开。
/// 2.x 的密文都带着它，改了就等于让每个用户重新配对手机。
pub const ENTROPY: &[u8] = b"AyanamiTaskManager/sync-secret/v1";

/// 加密。失败（不是 Windows、DPAPI 不可用）为 `None`。
pub fn protect(data: &[u8]) -> Option<Vec<u8>> {
    call(data, true)
}

/// 解密。密文被改过、换了 Windows 用户或机器、entropy 不同都是 `None`。
pub fn unprotect(sealed: &[u8]) -> Option<Vec<u8>> {
    call(sealed, false)
}

#[cfg(windows)]
fn call(data: &[u8], protect: bool) -> Option<Vec<u8>> {
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
    if output.pbData.is_null() {
        // 空明文可能不分配缓冲区。
        return ok.then(Vec::new);
    }
    // SAFETY: the call hands back `cbData` bytes at `pbData`.
    let bytes = unsafe { std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize) };
    let result = ok.then(|| bytes.to_vec());
    // 解出来的是明文：系统的那份抹掉再释放。
    bytes.fill(0);
    // SAFETY: allocated by the call with LocalAlloc and not used after this.
    unsafe { LocalFree(output.pbData.cast()) };
    result
}

#[cfg(not(windows))]
fn call(_: &[u8], _: bool) -> Option<Vec<u8>> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sealed_data_opens_only_through_dpapi() {
        let secret = b"atr_relay-token:space-secret";
        let sealed = protect(secret).expect("protect");
        assert!(!sealed.is_empty());
        assert!(
            !sealed.windows(secret.len()).any(|w| w == secret),
            "the blob must not contain the plaintext"
        );
        assert_eq!(unprotect(&sealed).as_deref(), Some(&secret[..]));
        let mut tampered = sealed.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0x01;
        assert_eq!(unprotect(&tampered), None);
        assert_eq!(unprotect(b"not a dpapi blob"), None);
        assert_eq!(protect(b"").map(|s| unprotect(&s)), Some(Some(Vec::new())));
    }
}
