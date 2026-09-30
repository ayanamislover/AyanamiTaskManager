//! Update package: `atm-x.y.z-win-x64.zip` + `atm-x.y.z-win-x64.json` (§6).
//!
//! The manifest is published last, after the zip is complete, and lists every file with its
//! size and sha256. The zip hash proves the package is complete and unmodified since it was
//! built; it does not prove who built it (security-model.md says so). Extraction trusts
//! nothing in the archive: names, counts and sizes are checked before a byte is written,
//! and every file is hashed as it is written.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::fsx;

pub const MANIFEST_FORMAT: u32 = 1;
const MAX_MANIFEST_BYTES: u64 = 8 * 1024 * 1024;
const MAX_FILES: usize = 20_000;
const MAX_UNPACKED_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;

/// Files the transaction itself depends on; a payload without them is not a version.
pub const REQUIRED: &[&str] = &[
    "AyanamiTaskManager.exe",
    "atm-setup.exe",
    "launcher/AyanamiTaskManager.exe",
    "resources/atm-mcp.exe",
    "resources/mcp-stdio.cjs",
    "runtime/atm-core.exe",
    "runtime/core.mjs",
    "runtime/cli.mjs",
    "renderer/index.html",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: u32,
    pub version: String,
    pub arch: String,
    pub package: String,
    pub package_sha256: String,
    pub package_bytes: u64,
    pub unpacked_bytes: u64,
    pub min_web_view2: String,
    /// sha256 over the bundled migrations (scope/name/hash lines); informational, the probe
    /// does the real schema check.
    pub schema_set: String,
    pub files: Vec<FileEntry>,
}

#[derive(Debug)]
pub struct Package {
    pub manifest: Manifest,
    pub zip_path: PathBuf,
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn valid_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 64
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
        && version.starts_with(|c: char| c.is_ascii_digit())
}

const RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// A relative path made only of ordinary components, with nothing Windows would reinterpret.
pub fn safe_relative(name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.len() > 400 {
        return Err("empty or overlong name".into());
    }
    if name.starts_with(['/', '\\']) || name.contains(':') {
        return Err("absolute, drive or stream name".into());
    }
    let mut path = PathBuf::new();
    for part in name.split(['/', '\\']) {
        if part.is_empty() || part == "." || part == ".." {
            return Err(format!("component {part:?}"));
        }
        if part.ends_with(['.', ' '])
            || part
                .chars()
                .any(|c| c.is_control() || "<>\"|?*".contains(c))
        {
            return Err(format!("component {part:?}"));
        }
        let stem = part.split('.').next().unwrap_or("").to_ascii_lowercase();
        if RESERVED.contains(&stem.as_str()) {
            return Err(format!("reserved name {part:?}"));
        }
        path.push(part);
    }
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("non-normal component".into());
    }
    Ok(path)
}

impl Manifest {
    fn validate(&self) -> Result<(), String> {
        if self.format != MANIFEST_FORMAT {
            return Err(format!("manifest format {}", self.format));
        }
        if !valid_version(&self.version) {
            return Err("version".into());
        }
        if self.arch != "x64" {
            return Err(format!("arch {}", self.arch));
        }
        if self.package != format!("atm-{}-win-x64.zip", self.version) {
            return Err("package name".into());
        }
        if self.files.is_empty() || self.files.len() > MAX_FILES {
            return Err("file count".into());
        }
        let mut seen = HashSet::new();
        let mut total = 0u64;
        for file in &self.files {
            safe_relative(&file.path).map_err(|error| format!("{}: {error}", file.path))?;
            if !seen.insert(file.path.to_ascii_lowercase().replace('\\', "/")) {
                return Err(format!("duplicate {}", file.path));
            }
            if file.size > MAX_FILE_BYTES || file.sha256.len() != 64 {
                return Err(format!("entry {}", file.path));
            }
            total += file.size;
        }
        if total != self.unpacked_bytes || total > MAX_UNPACKED_BYTES {
            return Err("unpacked size".into());
        }
        for required in REQUIRED {
            if !seen.contains(&required.to_ascii_lowercase()) {
                return Err(format!("missing {required}"));
            }
        }
        Ok(())
    }
}

pub fn load(manifest_path: &Path) -> io::Result<Package> {
    let manifest: Manifest = fsx::read_json_limited(manifest_path, MAX_MANIFEST_BYTES)?
        .ok_or_else(|| invalid("PACKAGE_MANIFEST_MISSING"))?;
    manifest
        .validate()
        .map_err(|error| invalid(format!("PACKAGE_MANIFEST_INVALID: {error}")))?;
    let zip_path = manifest_path
        .parent()
        .ok_or_else(|| invalid("PACKAGE_MANIFEST_INVALID: no directory"))?
        .join(&manifest.package);
    Ok(Package { manifest, zip_path })
}

/// The zip on disk is the one the manifest describes, byte for byte.
pub fn verify_archive(package: &Package) -> io::Result<()> {
    let metadata = fs::metadata(&package.zip_path).map_err(|_| {
        invalid(format!(
            "PACKAGE_ARCHIVE_MISSING: {}",
            package.zip_path.display()
        ))
    })?;
    if metadata.len() != package.manifest.package_bytes {
        return Err(invalid("PACKAGE_ARCHIVE_SIZE_MISMATCH"));
    }
    if fsx::sha256_file(&package.zip_path)? != package.manifest.package_sha256 {
        return Err(invalid("PACKAGE_ARCHIVE_HASH_MISMATCH"));
    }
    Ok(())
}

/// Extract into `target` (which must not exist). Every entry must be listed in the
/// manifest with the same size and hash, and every listed file must be present.
pub fn extract(package: &Package, target: &Path) -> io::Result<()> {
    if target.exists() {
        return Err(invalid(format!(
            "STAGE_TARGET_EXISTS: {}",
            target.display()
        )));
    }
    let expected: std::collections::HashMap<String, &FileEntry> = package
        .manifest
        .files
        .iter()
        .map(|file| (file.path.to_ascii_lowercase().replace('\\', "/"), file))
        .collect();
    let mut archive = zip::ZipArchive::new(File::open(&package.zip_path)?)
        .map_err(|error| invalid(format!("PACKAGE_ARCHIVE_INVALID: {error}")))?;
    if archive.len() > MAX_FILES * 2 {
        return Err(invalid("PACKAGE_ARCHIVE_TOO_MANY_ENTRIES"));
    }
    fs::create_dir_all(target)?;
    let mut written = HashSet::new();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| invalid(format!("PACKAGE_ARCHIVE_INVALID: {error}")))?;
        let name = entry.name().to_owned();
        if entry.is_symlink() {
            return Err(invalid(format!("PACKAGE_ENTRY_LINK: {name}")));
        }
        if entry.is_dir() {
            safe_relative(name.trim_end_matches('/'))
                .map_err(|error| invalid(format!("PACKAGE_ENTRY_NAME: {name}: {error}")))?;
            continue;
        }
        let relative = safe_relative(&name)
            .map_err(|error| invalid(format!("PACKAGE_ENTRY_NAME: {name}: {error}")))?;
        let key = name.to_ascii_lowercase().replace('\\', "/");
        let Some(file) = expected.get(&key) else {
            return Err(invalid(format!("PACKAGE_ENTRY_UNLISTED: {name}")));
        };
        if !written.insert(key) {
            return Err(invalid(format!("PACKAGE_ENTRY_DUPLICATE: {name}")));
        }
        if entry.size() != file.size {
            return Err(invalid(format!("PACKAGE_ENTRY_SIZE: {name}")));
        }
        let destination = target.join(&relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut output = File::create(&destination)?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 256 * 1024];
        let mut total = 0u64;
        // Read one byte past the declared size so an archive that lies about it is caught.
        let mut limited = (&mut entry).take(file.size + 1);
        loop {
            let read = limited.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            total += read as u64;
            if total > file.size {
                return Err(invalid(format!("PACKAGE_ENTRY_SIZE: {name}")));
            }
            hasher.update(&buffer[..read]);
            output.write_all(&buffer[..read])?;
        }
        output.sync_all()?;
        if total != file.size || fsx::hex(&hasher.finalize()) != file.sha256 {
            return Err(invalid(format!("PACKAGE_ENTRY_HASH: {name}")));
        }
    }
    if written.len() != expected.len() {
        let missing = expected
            .keys()
            .find(|key| !written.contains(*key))
            .cloned()
            .unwrap_or_default();
        return Err(invalid(format!("PACKAGE_ENTRY_MISSING: {missing}")));
    }
    Ok(())
}

/// Re-hash an installed or staged version directory against its manifest (repair, probe).
pub fn verify_tree(manifest: &Manifest, root: &Path) -> Result<(), String> {
    for file in &manifest.files {
        let path = root.join(safe_relative(&file.path)?);
        let hash = fsx::sha256_file(&path).map_err(|error| format!("{}: {error}", file.path))?;
        if hash != file.sha256 {
            return Err(format!("{} changed", file.path));
        }
    }
    Ok(())
}

/// Newer-than for dotted numeric versions with an optional `-pre` suffix (pre < release).
pub fn compare_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let split = |version: &str| {
        let (core, pre) = version.split_once('-').unwrap_or((version, ""));
        let numbers: Vec<u64> = core
            .split('.')
            .map(|part| part.parse().unwrap_or(0))
            .collect();
        (numbers, pre.to_owned())
    };
    let (left_core, left_pre) = split(left);
    let (right_core, right_pre) = split(right);
    let width = left_core.len().max(right_core.len());
    for index in 0..width {
        let ordering = left_core
            .get(index)
            .unwrap_or(&0)
            .cmp(right_core.get(index).unwrap_or(&0));
        if ordering.is_ne() {
            return ordering;
        }
    }
    match (left_pre.is_empty(), right_pre.is_empty()) {
        (true, true) => std::cmp::Ordering::Equal,
        (true, false) => std::cmp::Ordering::Greater,
        (false, true) => std::cmp::Ordering::Less,
        (false, false) => left_pre.cmp(&right_pre),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_names_windows_would_reinterpret_are_rejected() {
        for bad in [
            "",
            "/etc/x",
            r"\\server\share\x",
            "C:/x",
            "a/../b",
            "./a",
            "a//b",
            "file.txt:stream",
            "CON",
            "nul.txt",
            "dir/lpt1.log",
            "trailing.",
            "trailing ",
            "a|b",
        ] {
            assert!(safe_relative(bad).is_err(), "{bad:?} should be rejected");
        }
        assert_eq!(
            safe_relative("runtime/core.mjs").unwrap(),
            PathBuf::from(r"runtime\core.mjs")
        );
        assert!(safe_relative("resources/docs/接入说明.md").is_ok());
        assert!(safe_relative("console.log").is_ok());
    }

    #[test]
    fn versions_compare_numerically_with_prerelease_below_release() {
        use std::cmp::Ordering::*;
        assert_eq!(compare_versions("2.0.10", "2.0.9"), Greater);
        assert_eq!(compare_versions("2.0.0", "2.0"), Equal);
        assert_eq!(compare_versions("2.0.0-rc.1", "2.0.0"), Less);
        assert_eq!(compare_versions("1.2.2", "2.0.0"), Less);
    }
}
