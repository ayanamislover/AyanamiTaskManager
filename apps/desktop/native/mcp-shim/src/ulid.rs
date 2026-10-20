//! `auto:<ULID>` op ids for calls the Agent sent without one (10 R11 A3). A ULID is 48 bits
//! of Unix milliseconds and 80 random bits in Crockford base32; the randomness comes from
//! the system RNG (`BCryptGenRandom`), so two bridges never collide and no crate is added.

const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// A new ULID, or None when the system RNG is unavailable (the caller fails the call
/// rather than inventing a predictable id).
pub fn new() -> Option<String> {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as u64
        & 0xFFFF_FFFF_FFFF;
    let mut random = [0u8; 10];
    fill(&mut random)?;
    let mut value: u128 = u128::from(millis) << 80;
    for (i, b) in random.iter().enumerate() {
        value |= u128::from(*b) << (8 * (9 - i));
    }
    Some(encode(value))
}

fn encode(mut value: u128) -> String {
    let mut out = [0u8; 26];
    for slot in out.iter_mut().rev() {
        *slot = ALPHABET[(value & 31) as usize];
        value >>= 5;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(windows)]
fn fill(buf: &mut [u8]) -> Option<()> {
    use std::ffi::c_void;
    const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x2;
    #[link(name = "bcrypt")]
    unsafe extern "system" {
        fn BCryptGenRandom(alg: *mut c_void, buf: *mut u8, len: u32, flags: u32) -> i32;
    }
    // SAFETY: the buffer pointer and length describe `buf`; no algorithm handle is needed
    // with the system-preferred RNG flag.
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            buf.as_mut_ptr(),
            buf.len() as u32,
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
    fn ulids_are_26_crockford_characters_and_unique() {
        let a = new().unwrap();
        let b = new().unwrap();
        assert_eq!(a.len(), 26);
        assert!(a.bytes().all(|c| ALPHABET.contains(&c)), "{a}");
        assert_ne!(a, b);
        // The timestamp leads, so ids sort by time at millisecond resolution.
        assert_eq!(encode(0), "0".repeat(26));
        assert_eq!(&encode(1u128 << 80)[..10], "0000000001");
    }
}
