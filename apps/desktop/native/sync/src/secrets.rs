//! 手机同步的两项密钥（中继 token、空间密钥）：DPAPI 加密后以 base64 存在 `<数据目录>/sync/secrets.dpapi.json`，
//! 不进 Registry 的 settings 表（那张表 Agent 令牌可读；docs/security-model.md）。
//!
//! 与 2.x 的 `apps/desktop/src/dpapi-secret-store.ts`、`packages/sync/src/secret-store.ts` 逐项一致：
//! - 打开时做一次加密→解密往返自检（16 个随机字节，密文里不许带着明文），不通过就整体不可用：
//!   拒绝写入、读一律当作没有，绝不退回明文；
//! - 文件是 `{名字: base64(密文)}`，写成 `JSON.stringify(v, null, 2) + "\n"`，先写 `<文件>.<pid>.tmp` 再改名；
//!   键的顺序照 JS 对象（数组下标样的键升序在前，其余按出现顺序），不是字符串的值丢掉；
//! - 读：文件不存在、读不了、不是 JSON 对象都当作空；base64 照 `Buffer.from(s, "base64")` 宽松解码
//!   （两种字母表都认，别的字符跳过，遇到 `=` 停）；解不开的密文（换了 Windows 用户、拷到别的机器、
//!   被改坏）当作没有；明文照 `toString("utf8")` 把坏字节换成 U+FFFD。
//!
//! 有一处做不到一致：键里有落单代理项转义（`"\ud800"`）的文件 JSON.parse 收、serde_json 不收，这里整个当作空。
//! 2.x 自己写不出这种文件（键只有两个固定名字）。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// `<数据目录>/sync/` 下的文件名。
pub const FILE_NAME: &str = "secrets.dpapi.json";

/// 自检不通过时给用户看的原因（与 2.x 一字不差，界面与文档引用它）。
pub const UNAVAILABLE_REASON: &str = "Windows 数据保护（DPAPI）当前不可用：为了不把中继 token 和配对密钥明文落盘，手机同步暂时不能保存密钥";

/// 状态接口里的 `secretStore`：3.0 只有系统加密一种。
pub const STATUS_KIND: &str = "os-encrypted";

/// 落盘的两项密钥（`SECRET_NAMES`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SecretName {
    /// 中继 token。
    RelayToken,
    /// 空间密钥，存成 `<spaceId>:<secret>`（[`encode_space_secret`]）。
    SpaceSecret,
}

impl SecretName {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RelayToken => "relay-token",
            Self::SpaceSecret => "space-secret",
        }
    }
}

/// 加解密端口：正式用 [`Dpapi`]，用例里换成坏掉的实现来走不可用的路径。
pub trait Cipher {
    fn protect(&self, data: &[u8]) -> Option<Vec<u8>>;
    fn unprotect(&self, sealed: &[u8]) -> Option<Vec<u8>>;
}

/// 进程内的 Windows DPAPI（[`crate::dpapi`]）。
#[derive(Clone, Copy, Debug, Default)]
pub struct Dpapi;

impl Cipher for Dpapi {
    fn protect(&self, data: &[u8]) -> Option<Vec<u8>> {
        crate::dpapi::protect(data)
    }
    fn unprotect(&self, sealed: &[u8]) -> Option<Vec<u8>> {
        crate::dpapi::unprotect(sealed)
    }
}

#[derive(Debug)]
pub enum SecretError {
    /// 自检没通过：拒绝保存（`SECRET_STORE_UNAVAILABLE`）。
    Unavailable,
    /// 自检通过了，这一次加密却失败。
    Protect,
    /// 写文件失败。
    Io(std::io::Error),
}

impl SecretError {
    /// 错误详情里的 `reason`。
    pub const fn reason(&self) -> &'static str {
        match self {
            Self::Unavailable => "SECRET_STORE_UNAVAILABLE",
            Self::Protect => "DPAPI_FAILED",
            Self::Io(_) => "SECRET_STORE_WRITE_FAILED",
        }
    }
}

impl std::fmt::Display for SecretError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable => f.write_str(UNAVAILABLE_REASON),
            Self::Protect => f.write_str("Windows 数据保护（DPAPI）加密失败，同步密钥没有保存"),
            Self::Io(e) => write!(f, "保存同步密钥失败：{e}"),
        }
    }
}

impl std::error::Error for SecretError {}

/// `secrets.dpapi.json` 的读写。
pub struct DpapiSecretStore<C: Cipher = Dpapi> {
    path: PathBuf,
    cipher: Option<C>,
    available: bool,
    /// 读改写之间不让别的写插进来（2.x 靠「先加密，读和写之间没有 await」）。
    lock: Mutex<()>,
}

impl<C: Cipher> DpapiSecretStore<C> {
    /// `directory` 是 `<数据目录>/sync`。`cipher` 为 `None`（不是 Windows 等）时直接不可用。
    pub fn open(directory: &Path, cipher: Option<C>) -> Self {
        let available = cipher.as_ref().is_some_and(self_test);
        Self {
            path: directory.join(FILE_NAME),
            cipher,
            available,
            lock: Mutex::new(()),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn available(&self) -> bool {
        self.available
    }

    pub fn unavailable_reason(&self) -> Option<&'static str> {
        (!self.available).then_some(UNAVAILABLE_REASON)
    }

    /// 没有、解不开、或者不可用都是 `None`。
    pub fn read(&self, name: SecretName) -> Option<String> {
        let cipher = self.cipher.as_ref().filter(|_| self.available)?;
        let sealed = load(&self.path)
            .into_iter()
            .find_map(|(k, v)| (k == name.as_str()).then_some(v))
            .filter(|v| !v.is_empty())?;
        let mut plain = cipher.unprotect(&node_base64_decode(&sealed))?;
        let text = String::from_utf8_lossy(&plain).into_owned();
        plain.fill(0);
        Some(text)
    }

    pub fn write(&self, name: SecretName, value: &str) -> Result<(), SecretError> {
        let cipher = self
            .cipher
            .as_ref()
            .filter(|_| self.available)
            .ok_or(SecretError::Unavailable)?;
        let sealed = base64_encode(
            &cipher
                .protect(value.as_bytes())
                .ok_or(SecretError::Protect)?,
        );
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut values = load(&self.path);
        match values.iter_mut().find(|(k, _)| k == name.as_str()) {
            Some(entry) => entry.1 = sealed,
            None => values.push((name.as_str().to_owned(), sealed)),
        }
        save(&self.path, &values).map_err(SecretError::Io)
    }

    /// 不可用时也能删（清除不会让明文落盘）。本来就没有就不碰文件。
    pub fn remove(&self, name: SecretName) -> Result<(), SecretError> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut values = load(&self.path);
        let before = values.len();
        values.retain(|(k, _)| k != name.as_str());
        if values.len() == before {
            return Ok(());
        }
        save(&self.path, &values).map_err(SecretError::Io)
    }
}

fn self_test(cipher: &impl Cipher) -> bool {
    let Some(probe) = atm_sync_protocol::encoding::random_bytes::<16>() else {
        return false;
    };
    let Some(sealed) = cipher.protect(&probe) else {
        return false;
    };
    if sealed.is_empty() || sealed.windows(probe.len()).any(|w| w == probe) {
        return false;
    }
    cipher.unprotect(&sealed).as_deref() == Some(&probe[..])
}

/// 文件里的字符串项，按 JS 对象的键序。
fn load(path: &Path) -> Vec<(String, String)> {
    let Ok(bytes) = std::fs::read(path) else {
        return Vec::new();
    };
    let Ok(serde_json::Value::Object(map)) =
        serde_json::from_str::<serde_json::Value>(&String::from_utf8_lossy(&bytes))
    else {
        return Vec::new();
    };
    js_order(
        map.into_iter()
            .filter_map(|(k, v)| match v {
                serde_json::Value::String(s) => Some((k, s)),
                _ => None,
            })
            .collect(),
    )
}

fn save(path: &Path, values: &[(String, String)]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(format!(".{}.tmp", std::process::id()));
    let temporary = PathBuf::from(temporary);
    let result = std::fs::write(&temporary, serialize(values))
        .and_then(|()| std::fs::rename(&temporary, path));
    let _ = std::fs::remove_file(&temporary);
    result
}

/// JS 对象的自有键顺序：数组下标（`0`..=`4294967294` 的规范写法）升序在前，其余保持原顺序。
fn js_order(mut entries: Vec<(String, String)>) -> Vec<(String, String)> {
    fn index(key: &str) -> Option<u32> {
        let n: u32 = key.parse().ok()?;
        (n != u32::MAX && n.to_string() == key).then_some(n)
    }
    // 稳定排序：非下标的键都算同一档，保持原顺序。
    entries.sort_by_key(|(k, _)| index(k).map_or((1, 0), |n| (0, n)));
    entries
}

/// `JSON.stringify(values, null, 2) + "\n"`。
fn serialize(values: &[(String, String)]) -> String {
    if values.is_empty() {
        return "{}\n".to_owned();
    }
    let body: Vec<String> = values
        .iter()
        .map(|(k, v)| format!("  {}: {}", js_quote(k), js_quote(v)))
        .collect();
    format!("{{\n{}\n}}\n", body.join(",\n"))
}

/// `JSON.stringify` 的字符串写法：只转义引号、反斜杠与 U+0000–U+001F（有短写的用短写，其余小写 4 位 hex）。
fn js_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c < ' ' => {
                out.push('\\');
                out.push('u');
                out.push_str(&format!("{:04x}", u32::from(c)));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// 标准 base64，带补位（`toString("base64")`）。
fn base64_encode(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let mut b = [0u8; 3];
        b[..chunk.len()].copy_from_slice(chunk);
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            out.push(if i <= chunk.len() {
                char::from(A[((n >> (18 - 6 * i)) & 63) as usize])
            } else {
                '='
            });
        }
    }
    out
}

/// `Buffer.from(text, "base64")`：标准与 url 两种字母表都认，别的字符跳过，遇到 `=` 停；
/// 最后剩一个字符时丢掉。
fn node_base64_decode(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in text.chars() {
        let v = match c {
            '=' => break,
            'A'..='Z' => c as u32 - 'A' as u32,
            'a'..='z' => c as u32 - 'a' as u32 + 26,
            '0'..='9' => c as u32 - '0' as u32 + 52,
            '+' | '-' => 62,
            '/' | '_' => 63,
            _ => continue,
        };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

/// 空间密钥连同空间 ID 一起存，读出时核对，错配（例如写到一半崩溃）按「没有空间」处理。
pub fn encode_space_secret(space_id: &str, secret: &str) -> String {
    format!("{space_id}:{secret}")
}

pub fn decode_space_secret(value: Option<&str>, space_id: Option<&str>) -> Option<String> {
    let (value, space_id) = (value?, space_id?);
    let (id, secret) = value.split_once(':')?;
    (!id.is_empty() && id == space_id && !secret.is_empty()).then(|| secret.to_owned())
}

/// 连接器持有的密钥：第一次 [`load`](Self::load) 从存储读一次，之后留在内存里（不进状态、不进日志）。
/// 写入前检查系统加密是否可用，不可用就拒绝，绝不退回明文。
///
/// 2.x 还有一个 `loadError`：3.0 的读取不会失败（读不了就是没有），所以没有这一项。
pub struct SecretVault<C: Cipher = Dpapi> {
    store: DpapiSecretStore<C>,
    loaded: bool,
    token: Option<String>,
    secret: Option<String>,
}

impl<C: Cipher> SecretVault<C> {
    pub fn new(store: DpapiSecretStore<C>) -> Self {
        Self {
            store,
            loaded: false,
            token: None,
            secret: None,
        }
    }

    /// 中继 token；没有为 `None`。
    pub fn token(&self) -> Option<&str> {
        self.token.as_deref()
    }

    /// 当前配对空间的密钥（已核对空间 ID）；没有为 `None`。
    pub fn secret(&self) -> Option<&str> {
        self.secret.as_deref()
    }

    pub fn status_kind(&self) -> &'static str {
        STATUS_KIND
    }

    /// 系统加密不可用时的原因；可用时为 `None`。
    pub fn unavailable_reason(&self) -> Option<&'static str> {
        self.store.unavailable_reason()
    }

    /// 只在第一次读；`space_id` 是配置里的空间，密钥里记的空间对不上就当作没有。
    pub fn load(&mut self, space_id: Option<&str>) {
        if self.loaded {
            return;
        }
        self.loaded = true;
        self.token = self
            .store
            .read(SecretName::RelayToken)
            .filter(|t| !t.is_empty());
        self.secret = decode_space_secret(
            self.store.read(SecretName::SpaceSecret).as_deref(),
            space_id,
        );
    }

    pub fn assert_writable(&self) -> Result<(), SecretError> {
        match self.store.unavailable_reason() {
            None => Ok(()),
            Some(_) => Err(SecretError::Unavailable),
        }
    }

    /// `None` 或空串表示清除。
    pub fn set_token(&mut self, token: Option<&str>) -> Result<(), SecretError> {
        match token.filter(|t| !t.is_empty()) {
            Some(t) => {
                self.assert_writable()?;
                self.store.write(SecretName::RelayToken, t)?;
                self.token = Some(t.to_owned());
            }
            None => {
                self.store.remove(SecretName::RelayToken)?;
                self.token = None;
            }
        }
        Ok(())
    }

    pub fn set_space(&mut self, space_id: &str, secret: &str) -> Result<(), SecretError> {
        self.assert_writable()?;
        self.store.write(
            SecretName::SpaceSecret,
            &encode_space_secret(space_id, secret),
        )?;
        self.secret = Some(secret.to_owned());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_decodes_like_node_buffer() {
        // 期望值是 Node 24 的 `Buffer.from(s, "base64").toString("hex")`。
        for (text, hex) in [
            ("aGk=", "6869"),
            ("aGk", "6869"),
            ("aGk=aGk=", "6869"),
            ("aG k=", "6869"),
            ("aG\nk=", "6869"),
            ("aG@k", "6869"),
            ("aGk===", "6869"),
            ("a", ""),
            ("ab", "69"),
            ("-_8", "fbff"),
            ("+/8", "fbff"),
            ("aG=k", "68"),
            ("a=Gk", ""),
            ("=aGk", ""),
            ("aGVs bG8=", "68656c6c6f"),
            ("\u{e9}aGk", "6869"),
            ("aGkx\0", "686931"),
        ] {
            let got: String = node_base64_decode(text)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            assert_eq!(got, hex, "{text:?}");
        }
        for n in 0..8 {
            let bytes: Vec<u8> = (0..n).map(|i| (i * 89 + 250) as u8).collect();
            assert_eq!(node_base64_decode(&base64_encode(&bytes)), bytes);
        }
        assert_eq!(base64_encode(b"hi"), "aGk=");
        assert_eq!(base64_encode(&[0xfb, 0xff]), "+/8=");
    }

    #[test]
    fn keys_and_strings_serialize_like_json_stringify() {
        let entries = |pairs: &[(&str, &str)]| -> Vec<(String, String)> {
            pairs
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect()
        };
        // Node：JSON.parse 之后的键序（`4294967295` 与 `01` 不是下标）。
        let ordered = js_order(entries(&[
            ("b", "3"),
            ("9", "x"),
            ("2", "y"),
            ("a", "2"),
            ("4294967295", "z"),
            ("01", "w"),
            ("4294967294", "v"),
        ]));
        let keys: Vec<&str> = ordered.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["2", "9", "4294967294", "b", "a", "4294967295", "01"]);
        assert_eq!(serialize(&[]), "{}\n");
        assert_eq!(
            serialize(&entries(&[(
                "a",
                "\u{1}\u{1f}\u{7f}\u{2028}\"\\\u{8}\u{c}\n\r\t/"
            )])),
            "{\n  \"a\": \"\\u0001\\u001f\u{7f}\u{2028}\\\"\\\\\\b\\f\\n\\r\\t/\"\n}\n"
        );
    }

    #[test]
    fn space_secrets_carry_their_space() {
        let v = encode_space_secret("space-1", "a:b");
        assert_eq!(v, "space-1:a:b");
        assert_eq!(
            decode_space_secret(Some(&v), Some("space-1")).as_deref(),
            Some("a:b")
        );
        assert_eq!(decode_space_secret(Some(&v), Some("space-2")), None);
        assert_eq!(decode_space_secret(Some(&v), None), None);
        assert_eq!(decode_space_secret(None, Some("space-1")), None);
        assert_eq!(decode_space_secret(Some(":x"), Some("")), None);
        assert_eq!(decode_space_secret(Some("space-1:"), Some("space-1")), None);
        assert_eq!(decode_space_secret(Some("space-1"), Some("space-1")), None);
    }
}
