//! 系统随机数：令牌、实例 id、generation。

use windows_sys::Win32::Security::Cryptography::{
    BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
};

/// 用系统首选的随机源填满 `buf`。失败只可能是系统坏了，不能拿弱随机数顶替。
pub fn fill(buf: &mut [u8]) {
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            buf.as_mut_ptr(),
            buf.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    assert_eq!(status, 0, "BCryptGenRandom failed: {status:#x}");
}

/// `bytes` 个随机字节的小写十六进制。
pub fn hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    fill(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// 26 位 Crockford base32 ULID（与 store 的 `events::ulid` 同一格式）。
pub fn ulid() -> String {
    let millis = atm_install_state::handoff::now_ms();
    let mut random = [0u8; 10];
    fill(&mut random);
    let mut value: u128 = u128::from(millis & 0xffff_ffff_ffff) << 80;
    for (i, b) in random.iter().enumerate() {
        value |= u128::from(*b) << (72 - 8 * i);
    }
    let mut out = [0u8; 26];
    for slot in out.iter_mut().rev() {
        *slot = CROCKFORD[(value & 31) as usize];
        value >>= 5;
    }
    String::from_utf8(out.to_vec()).expect("crockford alphabet is ascii")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_are_well_formed_and_differ() {
        let (a, b) = (hex(32), hex(32));
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert!(
            a.bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        );
        let (u, v) = (ulid(), ulid());
        assert_eq!(u.len(), 26);
        assert_ne!(u, v);
        assert!(u.bytes().all(|c| CROCKFORD.contains(&c)));
    }
}
