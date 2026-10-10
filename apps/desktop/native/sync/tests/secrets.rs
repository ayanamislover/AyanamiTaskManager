//! 同步密钥存储与 2.x 的兼容（W7b）。
//!
//! - 文件格式：`tests/data/secret-vectors.json` 由 `secret-vectors.ts` 直接跑 2.x 的 `DpapiSecretStore` 与
//!   `SecretVault` 生成。这里用同一个确定的假加密照样重放：读到的值相同，写完的文件一字节不差。两边写出的
//!   字节相同，2.x 读 3.0 写的文件就等于读它自己写的文件（向量里每次写之后都读过），两个方向都在这里守着。
//! - DPAPI：下面独立写了一份 2.x 宿主 `--dpapi` 的调用（当前用户、`UI_FORBIDDEN`、entropy 照字面量写，不引用
//!   被测的常量）。2.x 加密的 3.0 打得开，3.0 加密的 2.x 打得开。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use atm_sync::secrets::{
    Cipher, Dpapi, DpapiSecretStore, FILE_NAME, SecretError, SecretName, SecretVault,
    UNAVAILABLE_REASON,
};
use serde_json::Value;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("target")
        })
        .join("sync-tests")
        .join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// 与 `secret-vectors.ts` 的 `fake` 相同：`fake:` + 每字节异或 0x5a；解密要求前缀。
struct Fake;

impl Cipher for Fake {
    fn protect(&self, data: &[u8]) -> Option<Vec<u8>> {
        Some(
            b"fake:"
                .iter()
                .copied()
                .chain(data.iter().map(|b| b ^ 0x5a))
                .collect(),
        )
    }
    fn unprotect(&self, sealed: &[u8]) -> Option<Vec<u8>> {
        Some(
            sealed
                .strip_prefix(b"fake:")?
                .iter()
                .map(|b| b ^ 0x5a)
                .collect(),
        )
    }
}

fn vectors() -> &'static Value {
    static V: OnceLock<Value> = OnceLock::new();
    V.get_or_init(|| {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/data/secret-vectors.json"
        );
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    })
}

fn b64(text: &str) -> Vec<u8> {
    let value = |c: u8| match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        _ => panic!("not base64: {text}"),
    } as u32;
    let body = text.trim_end_matches('=');
    let mut out = Vec::new();
    for chunk in body.as_bytes().chunks(4) {
        let acc = chunk
            .iter()
            .enumerate()
            .fold(0u32, |acc, (i, c)| acc | value(*c) << (18 - 6 * i));
        out.extend_from_slice(&acc.to_be_bytes()[1..chunk.len()]);
    }
    out
}

fn b64_encode(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::new();
    for chunk in bytes.chunks(3) {
        let mut b = [0u8; 3];
        b[..chunk.len()].copy_from_slice(chunk);
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            s.push(if i <= chunk.len() {
                char::from(A[(n >> (18 - 6 * i) & 63) as usize])
            } else {
                '='
            });
        }
    }
    s
}

fn name(v: &Value) -> SecretName {
    match v.as_str().unwrap() {
        "relay" => SecretName::RelayToken,
        "space" => SecretName::SpaceSecret,
        other => panic!("{other}"),
    }
}

fn file(path: &Path) -> Value {
    std::fs::read(path).map_or(Value::Null, |bytes| Value::from(b64_encode(&bytes)))
}

fn opt(v: Option<&str>) -> Value {
    v.map_or(Value::Null, Value::from)
}

#[test]
fn ts_vectors_replay_byte_for_byte() {
    let cases = vectors()["cases"].as_array().unwrap();
    assert!(cases.len() >= 18);
    for (i, case) in cases.iter().enumerate() {
        let what = case["name"].as_str().unwrap();
        let directory = scratch(&format!("vector-{i}")).join("sync");
        let path = directory.join(FILE_NAME);
        if let Some(initial) = case["initial"].as_str() {
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(&path, b64(initial)).unwrap();
        }
        let store = DpapiSecretStore::open(&directory, Some(Fake));
        assert!(store.available(), "{what}");
        let ops = case["ops"].as_array().unwrap();
        let results = case["results"].as_array().unwrap();
        assert_eq!(ops.len(), results.len());
        for (step, (op, expected)) in ops.iter().zip(results).enumerate() {
            let got = match op["op"].as_str().unwrap() {
                "read" => opt(store.read(name(&op["name"])).as_deref()),
                "write" => {
                    store
                        .write(name(&op["name"]), op["value"].as_str().unwrap())
                        .unwrap();
                    file(&path)
                }
                "remove" => {
                    store.remove(name(&op["name"])).unwrap();
                    file(&path)
                }
                "vault-load" => {
                    let mut vault =
                        SecretVault::new(DpapiSecretStore::open(&directory, Some(Fake)));
                    vault.load(op["spaceId"].as_str());
                    serde_json::json!({"token": opt(vault.token()), "secret": opt(vault.secret())})
                }
                "set-token" => {
                    let mut vault =
                        SecretVault::new(DpapiSecretStore::open(&directory, Some(Fake)));
                    vault.set_token(op["token"].as_str()).unwrap();
                    file(&path)
                }
                "set-space" => {
                    let mut vault =
                        SecretVault::new(DpapiSecretStore::open(&directory, Some(Fake)));
                    vault
                        .set_space(
                            op["spaceId"].as_str().unwrap(),
                            op["secret"].as_str().unwrap(),
                        )
                        .unwrap();
                    file(&path)
                }
                other => panic!("{other}"),
            };
            assert_eq!(&got, expected, "{what}, step {step}: {op}");
        }
        // 先写临时文件再改名：不留 `.tmp`。
        if directory.exists() {
            let left: Vec<_> = std::fs::read_dir(&directory)
                .unwrap()
                .map(|e| e.unwrap().file_name())
                .filter(|n| n != FILE_NAME)
                .collect();
            assert!(left.is_empty(), "{what}: {left:?}");
        }
    }
}

/// 2.x 宿主 `--dpapi` 的调用，照字面量独立写一份。`entropy` 为 `None` 时不绑定用途。
mod legacy {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
    };

    pub const ENTROPY_2X: &[u8] = b"AyanamiTaskManager/sync-secret/v1";

    pub fn call(data: &[u8], entropy: Option<&[u8]>, protect: bool) -> Option<Vec<u8>> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr().cast_mut(),
        };
        let purpose = entropy.map(|e| CRYPT_INTEGER_BLOB {
            cbData: e.len() as u32,
            pbData: e.as_ptr().cast_mut(),
        });
        let purpose = purpose.as_ref().map_or(std::ptr::null(), |p| p as *const _);
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = unsafe {
            if protect {
                CryptProtectData(
                    &input,
                    std::ptr::null(),
                    purpose,
                    std::ptr::null(),
                    std::ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            } else {
                CryptUnprotectData(
                    &input,
                    std::ptr::null_mut(),
                    purpose,
                    std::ptr::null(),
                    std::ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            }
        } != 0;
        if !ok {
            return None;
        }
        let out =
            unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
        unsafe { LocalFree(output.pbData.cast()) };
        Some(out)
    }
}

/// 2.x 的 `#save`：`JSON.stringify(v, null, 2) + "\n"`（这里的名字与 base64 都不用转义）。
fn write_2x(path: &Path, entries: &[(&str, String)]) {
    let body: Vec<String> = entries
        .iter()
        .map(|(k, v)| format!("  \"{k}\": \"{v}\""))
        .collect();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, format!("{{\n{}\n}}\n", body.join(",\n"))).unwrap();
}

#[test]
fn secrets_the_2x_host_sealed_open_and_ours_open_there() {
    let directory = scratch("legacy-dpapi").join("sync");
    let path = directory.join(FILE_NAME);
    let token = "atr_2x-relay-token";
    let space = "01JSPACE:pairing-secret-from-2x";
    let seal =
        |s: &str| b64_encode(&legacy::call(s.as_bytes(), Some(legacy::ENTROPY_2X), true).unwrap());
    write_2x(
        &path,
        &[("relay-token", seal(token)), ("space-secret", seal(space))],
    );
    let store = DpapiSecretStore::open(&directory, Some(Dpapi));
    assert!(store.available());
    assert_eq!(store.read(SecretName::RelayToken).as_deref(), Some(token));
    let mut vault = SecretVault::new(DpapiSecretStore::open(&directory, Some(Dpapi)));
    vault.load(Some("01JSPACE"));
    assert_eq!(vault.token(), Some(token));
    assert_eq!(vault.secret(), Some("pairing-secret-from-2x"));

    // 3.0 写的，2.x 的调用解得开；文件里没有明文。
    store.write(SecretName::RelayToken, "atr_3x-token").unwrap();
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(!text.contains("atr_3x-token") && !text.contains("pairing-secret"));
    let written: Value = serde_json::from_str(&text).unwrap();
    let sealed = b64(written["relay-token"].as_str().unwrap());
    assert_eq!(
        legacy::call(&sealed, Some(legacy::ENTROPY_2X), false).as_deref(),
        Some(&b"atr_3x-token"[..])
    );
    // 不带 entropy、或带别的用途，同一账户也解不开：用途确实绑上了。
    assert_eq!(legacy::call(&sealed, None, false), None);
    assert_eq!(
        legacy::call(&sealed, Some(b"AyanamiTaskManager/other/v1"), false),
        None
    );
}

#[test]
fn blobs_sealed_for_another_purpose_read_as_absent() {
    let directory = scratch("other-purpose").join("sync");
    let path = directory.join(FILE_NAME);
    for other in [None, Some(&b"AyanamiTaskManager/other/v1"[..])] {
        let sealed = b64_encode(&legacy::call(b"atr_x", other, true).unwrap());
        write_2x(&path, &[("relay-token", sealed)]);
        let store = DpapiSecretStore::open(&directory, Some(Dpapi));
        assert!(store.available());
        assert_eq!(store.read(SecretName::RelayToken), None, "{other:?}");
    }
}

/// 自检不通过的几种加密：调用失败、原样返回（密文里带着明文）、解出来不一样、密文为空（解密却照样还原，
/// 只有「密文不许为空」这一条挡得住）。
#[derive(Clone, Copy)]
struct Broken(u8);

thread_local! {
    static LAST: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
}

impl Cipher for Broken {
    fn protect(&self, data: &[u8]) -> Option<Vec<u8>> {
        match self.0 {
            0 => None,
            1 => Some(data.to_vec()),
            2 => Some(b"sealed".to_vec()),
            _ => {
                LAST.with(|l| *l.borrow_mut() = data.to_vec());
                Some(Vec::new())
            }
        }
    }
    fn unprotect(&self, sealed: &[u8]) -> Option<Vec<u8>> {
        match self.0 {
            0 => None,
            1 => Some(sealed.to_vec()),
            2 => Some(b"something else".to_vec()),
            _ => Some(LAST.with(|l| l.borrow().clone())),
        }
    }
}

#[test]
fn a_failed_self_test_refuses_writes_and_reads_nothing() {
    let ciphers = [
        ("no cipher", None),
        ("fails", Some(Broken(0))),
        ("plaintext", Some(Broken(1))),
        ("differs", Some(Broken(2))),
        ("empty", Some(Broken(3))),
    ];
    for (i, (what, cipher)) in ciphers.into_iter().enumerate() {
        let open = |d: &Path| DpapiSecretStore::open(d, cipher);
        let directory = scratch(&format!("broken-{i}")).join("sync");
        let path = directory.join(FILE_NAME);
        // 文件里有一项「原样存的」值：不可用时也不许当成密钥读出来。
        write_2x(&path, &[("relay-token", b64_encode(b"atr_plain-old"))]);
        let before = std::fs::read(&path).unwrap();
        let store = open(&directory);
        assert!(!store.available(), "{what}");
        assert_eq!(store.unavailable_reason(), Some(UNAVAILABLE_REASON));
        assert!(UNAVAILABLE_REASON.contains("DPAPI"));
        let err = store
            .write(SecretName::RelayToken, "atr_plain")
            .unwrap_err();
        assert!(matches!(err, SecretError::Unavailable), "{what}: {err:?}");
        assert_eq!(err.reason(), "SECRET_STORE_UNAVAILABLE");
        assert_eq!(err.to_string(), UNAVAILABLE_REASON);
        assert_eq!(store.read(SecretName::RelayToken), None, "{what}");
        assert_eq!(std::fs::read(&path).unwrap(), before, "{what}");

        let mut vault = SecretVault::new(open(&directory));
        vault.load(Some("s"));
        assert_eq!(vault.token(), None);
        assert_eq!(vault.unavailable_reason(), Some(UNAVAILABLE_REASON));
        assert!(matches!(
            vault.assert_writable(),
            Err(SecretError::Unavailable)
        ));
        assert!(matches!(
            vault.set_token(Some("atr_plain")),
            Err(SecretError::Unavailable)
        ));
        assert!(matches!(
            vault.set_space("s", "plain-secret"),
            Err(SecretError::Unavailable)
        ));
        assert_eq!(std::fs::read(&path).unwrap(), before, "{what}");
        // 清除不会让明文落盘，不可用时照样能清。
        vault.set_token(None).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}\n");
    }
}

/// 自检过了，单次加密却失败：不写文件，报 `DPAPI_FAILED`。
struct ProbeOnly;

impl Cipher for ProbeOnly {
    fn protect(&self, data: &[u8]) -> Option<Vec<u8>> {
        (data.len() == 16).then(|| Fake.protect(data))?
    }
    fn unprotect(&self, sealed: &[u8]) -> Option<Vec<u8>> {
        Fake.unprotect(sealed)
    }
}

#[test]
fn a_failed_seal_writes_nothing() {
    let directory = scratch("probe-only").join("sync");
    let store = DpapiSecretStore::open(&directory, Some(ProbeOnly));
    assert!(store.available());
    let err = store
        .write(SecretName::RelayToken, "atr_token")
        .unwrap_err();
    assert!(matches!(err, SecretError::Protect));
    assert_eq!(err.reason(), "DPAPI_FAILED");
    assert!(!directory.exists());
}

#[test]
fn a_failed_rename_leaves_no_temporary_file() {
    let directory = scratch("rename-fails").join("sync");
    // 目标位置是一个目录：改名失败。
    std::fs::create_dir_all(directory.join(FILE_NAME)).unwrap();
    let store = DpapiSecretStore::open(&directory, Some(Fake));
    let err = store
        .write(SecretName::RelayToken, "atr_token")
        .unwrap_err();
    assert!(matches!(err, SecretError::Io(_)), "{err:?}");
    assert_eq!(err.reason(), "SECRET_STORE_WRITE_FAILED");
    let names: Vec<_> = std::fs::read_dir(&directory)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(names, [FILE_NAME]);
}

#[test]
fn concurrent_writes_do_not_lose_each_other() {
    let directory = scratch("concurrent").join("sync");
    let store = DpapiSecretStore::open(&directory, Some(Fake));
    std::thread::scope(|s| {
        for round in 0..20 {
            let store = &store;
            s.spawn(move || {
                store
                    .write(SecretName::RelayToken, &format!("atr_{round}"))
                    .unwrap()
            });
            s.spawn(move || {
                store
                    .write(SecretName::SpaceSecret, &format!("space:{round}"))
                    .unwrap()
            });
        }
    });
    assert!(
        store
            .read(SecretName::RelayToken)
            .unwrap()
            .starts_with("atr_")
    );
    assert!(
        store
            .read(SecretName::SpaceSecret)
            .unwrap()
            .starts_with("space:")
    );
}

/// 读出的值只在第一次 `load` 时取；之后换了文件也不变（连接器启动时读一次，之后留在内存里）。
#[test]
fn the_vault_loads_once() {
    let directory = scratch("vault-once").join("sync");
    let store = DpapiSecretStore::open(&directory, Some(Fake));
    store.write(SecretName::RelayToken, "atr_first").unwrap();
    let mut vault = SecretVault::new(DpapiSecretStore::open(&directory, Some(Fake)));
    assert_eq!(vault.status_kind(), "os-encrypted");
    vault.load(None);
    assert_eq!(vault.token(), Some("atr_first"));
    store.write(SecretName::RelayToken, "atr_second").unwrap();
    vault.load(None);
    assert_eq!(vault.token(), Some("atr_first"));
    vault.set_space("space-9", "s").unwrap();
    assert_eq!(vault.secret(), Some("s"));
    assert_eq!(
        store.read(SecretName::SpaceSecret).as_deref(),
        Some("space-9:s")
    );
}

/// 键里有落单代理项转义的文件 serde_json 不收，整个当作空（模块文档里记着的唯一不一致）。
#[test]
fn a_lone_surrogate_key_reads_as_an_empty_file() {
    let directory = scratch("lone-surrogate").join("sync");
    let sealed = b64_encode(&Fake.protect(b"atr_x").unwrap());
    std::fs::create_dir_all(&directory).unwrap();
    let mut text = String::from("{\"");
    text.push('\\');
    text.push_str("ud800\":\"q\",\"relay-token\":\"");
    text.push_str(&sealed);
    text.push_str("\"}");
    std::fs::write(directory.join(FILE_NAME), text).unwrap();
    let store = DpapiSecretStore::open(&directory, Some(Fake));
    assert_eq!(store.read(SecretName::RelayToken), None);
}
