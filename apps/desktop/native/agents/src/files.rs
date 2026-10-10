//! 受管文件的读写（2.0 `agent-config/src/atomic-files.ts`）与 2.0 同样字节的 JSON 输出。
//!
//! - 替换：同目录临时文件 → 已有文件改名为 `<文件>.bak-<时刻>-<6 位十六进制>` → 临时文件改名就位；就位失败把备份放回。
//!   新文件落位之后才修剪旧备份（只留最近 [`BACKUP_RETENTION`] 份），修剪失败不算写入失败。
//! - JSON：与 `JSON.stringify(value, null, 2) + "\n"` 逐字节相同（两空格缩进、空对象 `{}`），内容没变就不写、不留备份，
//!   所以已经写对的配置每次启动核对都不会多出一份备份。

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub const BACKUP_RETENTION: usize = 5;

/// 备份名里的时刻：ISO 串把 `:` 与 `.` 换成 `-`（2.0 `backupName`）。
pub fn stamp() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64);
    atm_domain::time::Timestamp::from_millis(ms)
        .to_string()
        .replace([':', '.'], "-")
}

pub fn random_hex(bytes: usize) -> String {
    // 只用于文件名去重，不作任何安全用途：时刻与进程号混进 sha256。
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let seed = format!(
        "{}-{}-{:?}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed),
        std::time::SystemTime::now(),
        std::thread::current().name().unwrap_or("")
    );
    hex(&Sha256::digest(seed.as_bytes()))[..bytes * 2].to_string()
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn backup_name(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(format!(".bak-{}-{}", stamp(), random_hex(3)));
    PathBuf::from(name)
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// 只留最近的几份备份（按名字字典序，名字里带时刻），其他文件一律不碰。
fn prune_backups(path: &Path, keep: usize) {
    let Some(dir) = path.parent() else { return };
    let prefix = format!("{}.bak-", file_name(path));
    let Ok(it) = fs::read_dir(dir) else { return };
    let mut names: Vec<String> = it
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with(&prefix))
        .collect();
    names.sort();
    names.reverse();
    for stale in names.into_iter().skip(keep) {
        let _ = fs::remove_file(dir.join(stale));
    }
}

/// 原子替换并留备份；返回备份路径（原来没有这个文件时是 `None`）。
pub fn replace_with_backup(path: &Path, content: &[u8]) -> io::Result<Option<PathBuf>> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut temp = path.as_os_str().to_owned();
    temp.push(format!(".tmp-{}-{}", std::process::id(), random_hex(4)));
    let temp = PathBuf::from(temp);
    {
        use std::io::Write;
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        f.write_all(content)?;
        f.sync_all()?;
    }
    if !path.exists() {
        if let Err(e) = fs::rename(&temp, path) {
            let _ = fs::remove_file(&temp);
            return Err(e);
        }
        return Ok(None);
    }
    let backup = backup_name(path);
    if let Err(e) = fs::rename(path, &backup) {
        let _ = fs::remove_file(&temp);
        return Err(e);
    }
    if let Err(e) = fs::rename(&temp, path) {
        if !path.exists() && backup.exists() {
            let _ = fs::rename(&backup, path);
        }
        let _ = fs::remove_file(&temp);
        return Err(e);
    }
    prune_backups(path, BACKUP_RETENTION);
    Ok(Some(backup))
}

/// 内容与现有的不同才替换（2.0 每个写入方都是「没变就不写」）。
pub fn write_if_changed(path: &Path, content: &str) -> io::Result<Option<PathBuf>> {
    let current = read_text(path)?;
    if current.as_deref() == Some(content) || (current.is_none() && content.is_empty()) {
        return Ok(None);
    }
    replace_with_backup(path, content.as_bytes())
}

/// 读 UTF-8 文本；不存在是 `None`。
pub fn read_text(path: &Path) -> io::Result<Option<String>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// `JSON.stringify(value, null, 2) + "\n"`。
pub fn js_json_pretty(v: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, v, 0);
    out.push('\n');
    out
}

/// `JSON.stringify(value)`（紧凑）。
pub fn js_json(v: &Value) -> String {
    let mut out = String::new();
    write_compact(&mut out, v);
    out
}

fn number(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    let f = n.as_f64().unwrap_or(0.0);
    if f.fract() == 0.0 && f.abs() < 1e21 {
        format!("{f:.0}")
    } else {
        format!("{f}")
    }
}

fn string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

fn write_value(out: &mut String, v: &Value, depth: usize) {
    let pad = |n: usize| "  ".repeat(n);
    match v {
        Value::Object(m) if m.is_empty() => out.push_str("{}"),
        Value::Array(a) if a.is_empty() => out.push_str("[]"),
        Value::Object(m) => {
            out.push_str("{\n");
            for (i, (k, val)) in m.iter().enumerate() {
                out.push_str(&pad(depth + 1));
                out.push_str(&string(k));
                out.push_str(": ");
                write_value(out, val, depth + 1);
                if i + 1 < m.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            out.push_str(&pad(depth));
            out.push('}');
        }
        Value::Array(a) => {
            out.push_str("[\n");
            for (i, val) in a.iter().enumerate() {
                out.push_str(&pad(depth + 1));
                write_value(out, val, depth + 1);
                if i + 1 < a.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            out.push_str(&pad(depth));
            out.push(']');
        }
        other => write_compact(out, other),
    }
}

fn write_compact(out: &mut String, v: &Value) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&number(n)),
        Value::String(s) => out.push_str(&string(s)),
        Value::Array(a) => {
            out.push('[');
            for (i, val) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_compact(out, val);
            }
            out.push(']');
        }
        Value::Object(m) => {
            out.push('{');
            for (i, (k, val)) in m.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&string(k));
                out.push(':');
                write_compact(out, val);
            }
            out.push('}');
        }
    }
}

/// 2.0 `directoryFingerprint`：按名字（UTF-16 码元序，与 JS 的 sort 相同）递归，`相对路径 \0 内容 \0` 的 sha256。
/// 安装基线 `.atm-skills.json` 里存的就是它，必须与 2.0 算出的一致，老安装的基线才认得。
pub fn directory_fingerprint(path: &Path) -> io::Result<Option<String>> {
    if !path.exists() {
        return Ok(None);
    }
    let mut h = Sha256::new();
    fn visit(h: &mut Sha256, dir: &Path, prefix: &str) -> io::Result<()> {
        let mut names: Vec<String> = fs::read_dir(dir)?
            .map(|e| e.map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect::<io::Result<_>>()?;
        names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        for name in names {
            let abs = dir.join(&name);
            let rel = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            if fs::metadata(&abs)?.is_dir() {
                visit(h, &abs, &rel)?;
            } else {
                h.update(rel.as_bytes());
                h.update([0]);
                h.update(fs::read(&abs)?);
                h.update([0]);
            }
        }
        Ok(())
    }
    visit(&mut h, path, "")?;
    Ok(Some(hex(&h.finalize())))
}

/// 递归复制目录（跳过符号链接与重解析点）。
pub fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for e in fs::read_dir(from)? {
        let e = e?;
        let meta = fs::symlink_metadata(e.path())?;
        if meta.file_type().is_symlink() || is_reparse_point(&meta) {
            return Err(io::Error::other(format!(
                "AGENT_SOURCE_LINK: {}",
                e.path().display()
            )));
        }
        let target = to.join(e.file_name());
        if meta.is_dir() {
            copy_dir(&e.path(), &target)?;
        } else {
            fs::copy(e.path(), &target)?;
        }
    }
    Ok(())
}

#[cfg(windows)]
pub fn is_reparse_point(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    meta.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
pub fn is_reparse_point(_meta: &fs::Metadata) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn json_matches_javascript_stringify() {
        let v = json!({"mcpServers": {}, "a": [], "b": [1, 2.5, "x\"y\n"], "c": {"d": null, "e": true}, "f": 3.0});
        assert_eq!(
            js_json_pretty(&v),
            "{\n  \"mcpServers\": {},\n  \"a\": [],\n  \"b\": [\n    1,\n    2.5,\n    \"x\\\"y\\n\"\n  ],\n  \"c\": {\n    \"d\": null,\n    \"e\": true\n  },\n  \"f\": 3\n}\n"
        );
        assert_eq!(
            js_json(&json!({"command": "C:\\x", "args": ["--profile", "core"], "env": {}})),
            "{\"command\":\"C:\\\\x\",\"args\":[\"--profile\",\"core\"],\"env\":{}}"
        );
    }
}
