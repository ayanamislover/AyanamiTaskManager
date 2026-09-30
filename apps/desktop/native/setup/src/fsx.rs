//! File-system primitives with the guarantees the transaction relies on: atomic replace,
//! same-volume moves, junctions that are created and removed without ever following them,
//! and deletes that refuse to leave the install root.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr::null_mut;

use sha2::{Digest, Sha256};
use windows_sys::Win32::Foundation::{CloseHandle, GENERIC_WRITE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW, OPEN_EXISTING,
};
use windows_sys::Win32::System::IO::DeviceIoControl;
use windows_sys::Win32::System::Ioctl::FSCTL_SET_REPARSE_POINT;

pub fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn last_error() -> io::Error {
    io::Error::last_os_error()
}

fn move_file(from: &Path, to: &Path, flags: u32) -> io::Result<()> {
    if unsafe { MoveFileExW(wide(from).as_ptr(), wide(to).as_ptr(), flags) } == 0 {
        return Err(last_error());
    }
    Ok(())
}

/// Temporary file in the same directory, flushed, then MoveFileEx(REPLACE_EXISTING |
/// WRITE_THROUGH): a reader sees the complete old or the complete new content, never
/// a torn file, and the rename is on disk when this returns.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path.parent().ok_or_else(|| io::Error::other("no parent"))?;
    fs::create_dir_all(dir)?;
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::other("no file name"))?
        .to_string_lossy();
    let temporary = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    {
        let mut file = File::create(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    move_file(
        &temporary,
        path,
        MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
    )
    .inspect_err(|_| {
        let _ = fs::remove_file(&temporary);
    })
}

pub fn write_json_atomic<T: serde::Serialize>(path: &Path, value: &T) -> io::Result<()> {
    let bytes = serde_json::to_vec_pretty(value).map_err(io::Error::other)?;
    write_atomic(path, &bytes)
}

pub fn read_json_limited<T: for<'de> serde::Deserialize<'de>>(
    path: &Path,
    limit: u64,
) -> io::Result<Option<T>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(io::Error::other(format!("{} too large", path.display())));
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(io::Error::other)
}

/// Same-volume rename of a file or directory. Never copies: a move that would need a copy
/// fails instead, so a half-copied tree can never be mistaken for a moved one.
pub fn move_path(from: &Path, to: &Path) -> io::Result<()> {
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    move_file(from, to, MOVEFILE_WRITE_THROUGH)
}

pub fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex(&hasher.finalize()))
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn lower(path: &Path) -> String {
    path.to_string_lossy().trim_end_matches('\\').to_lowercase()
}

pub fn same_path(left: &Path, right: &Path) -> bool {
    lower(left) == lower(right)
}

/// `path` strictly inside `root` (textually, after both are made absolute).
pub fn is_within(path: &Path, root: &Path) -> bool {
    let (path, root) = (lower(path), lower(root));
    path.len() > root.len() + 1 && path.starts_with(&root) && path.as_bytes()[root.len()] == b'\\'
}

/// Recursive delete that refuses anything outside `root`. std's remove_dir_all removes
/// junctions and symlinks themselves rather than descending into their targets.
pub fn remove_tree_within(path: &Path, root: &Path) -> io::Result<()> {
    if !is_within(path, root) {
        return Err(io::Error::other(format!(
            "refusing to delete {} outside {}",
            path.display(),
            root.display()
        )));
    }
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            fs::remove_dir_all(path)
        }
        // A junction's own metadata is "symlink", not "dir"; remove the link entry only.
        Ok(metadata) if metadata.file_type().is_symlink() => {
            fs::remove_dir(path).or_else(|_| fs::remove_file(path))
        }
        Ok(_) => fs::remove_file(path),
    }
}

const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;

/// NTFS junction (mount point reparse point): no administrator rights needed, unlike a
/// directory symlink. Fails if `link` already exists.
pub fn create_junction(link: &Path, target: &Path) -> io::Result<()> {
    let target = std::path::absolute(target)?;
    let substitute: Vec<u16> = format!(r"\??\{}", target.display())
        .encode_utf16()
        .collect();
    let print: Vec<u16> = target.as_os_str().encode_wide().collect();
    let substitute_bytes = substitute.len() * 2;
    let print_bytes = print.len() * 2;
    // Path buffer: substitute name, NUL, print name, NUL.
    let path_bytes = substitute_bytes + 2 + print_bytes + 2;
    let data_length = 8 + path_bytes;
    let mut buffer = Vec::with_capacity(8 + data_length);
    buffer.extend_from_slice(&IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
    buffer.extend_from_slice(&(data_length as u16).to_le_bytes());
    buffer.extend_from_slice(&0u16.to_le_bytes());
    buffer.extend_from_slice(&0u16.to_le_bytes()); // SubstituteNameOffset
    buffer.extend_from_slice(&(substitute_bytes as u16).to_le_bytes());
    buffer.extend_from_slice(&((substitute_bytes + 2) as u16).to_le_bytes()); // PrintNameOffset
    buffer.extend_from_slice(&(print_bytes as u16).to_le_bytes());
    for unit in substitute
        .iter()
        .chain(std::iter::once(&0))
        .chain(print.iter())
        .chain(std::iter::once(&0))
    {
        buffer.extend_from_slice(&unit.to_le_bytes());
    }
    fs::create_dir(link)?;
    let handle = unsafe {
        CreateFileW(
            wide(link).as_ptr(),
            GENERIC_WRITE,
            0,
            null_mut(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        let error = last_error();
        let _ = fs::remove_dir(link);
        return Err(error);
    }
    let mut returned = 0u32;
    let ok = unsafe {
        DeviceIoControl(
            handle,
            FSCTL_SET_REPARSE_POINT,
            buffer.as_ptr().cast(),
            buffer.len() as u32,
            null_mut(),
            0,
            &mut returned,
            null_mut(),
        )
    };
    let error = (ok == 0).then(last_error);
    unsafe { CloseHandle(handle) };
    if let Some(error) = error {
        let _ = fs::remove_dir(link);
        return Err(error);
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkState {
    Missing,
    /// A junction/symlink and where it points (verbatim prefix stripped).
    Link(PathBuf),
    /// Something real sits there (a directory or file): never ours to remove.
    Occupied,
}

pub fn link_state(link: &Path) -> LinkState {
    match fs::symlink_metadata(link) {
        Err(_) => LinkState::Missing,
        Ok(metadata) if metadata.file_type().is_symlink() => match fs::read_link(link) {
            Ok(target) => LinkState::Link(strip_verbatim(&target)),
            Err(_) => LinkState::Link(PathBuf::new()),
        },
        Ok(_) => LinkState::Occupied,
    }
}

pub fn strip_verbatim(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    for prefix in [r"\\?\", r"\??\"] {
        if let Some(rest) = text.strip_prefix(prefix)
            && !rest.starts_with("UNC\\")
        {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

/// Point `link` at `target`, replacing an existing link but never a real directory.
/// Removal uses remove_dir on the link itself, which cannot recurse into the target.
pub fn retarget_junction(link: &Path, target: &Path) -> io::Result<()> {
    match link_state(link) {
        LinkState::Link(current) if same_path(&current, target) => return Ok(()),
        LinkState::Link(_) => fs::remove_dir(link)?,
        LinkState::Occupied => {
            return Err(io::Error::other(format!(
                "{} is a real directory, not a link",
                link.display()
            )));
        }
        LinkState::Missing => {}
    }
    if let Some(parent) = link.parent() {
        fs::create_dir_all(parent)?;
    }
    create_junction(link, target)
}

/// Replace a possibly running executable: write `.new`, rename the old one aside to
/// `.old` (allowed while it runs), rename `.new` into place. Returns the aside path.
pub fn replace_file(target: &Path, source: &Path) -> io::Result<Option<PathBuf>> {
    if target.is_file() && sha256_file(target)? == sha256_file(source)? {
        return Ok(None);
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let name = target
        .file_name()
        .ok_or_else(|| io::Error::other("no file name"))?
        .to_string_lossy()
        .into_owned();
    let incoming = target.with_file_name(format!("{name}.new"));
    fs::copy(source, &incoming)?;
    // FlushFileBuffers needs a handle with write access.
    fs::OpenOptions::new()
        .write(true)
        .open(&incoming)?
        .sync_all()?;
    let mut aside = None;
    if target.exists() {
        // A previous .old may still be running; pick a free name instead of failing.
        let mut candidate = target.with_file_name(format!("{name}.old"));
        let mut index = 1;
        while candidate.exists() && fs::remove_file(&candidate).is_err() {
            candidate = target.with_file_name(format!("{name}.old{index}"));
            index += 1;
        }
        move_file(target, &candidate, MOVEFILE_WRITE_THROUGH)?;
        aside = Some(candidate);
    }
    move_file(&incoming, target, MOVEFILE_WRITE_THROUGH)?;
    Ok(aside)
}

/// Best effort: `.old`/`.oldN` files left beside stable root files once nothing runs them.
pub fn sweep_aside(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if name.ends_with(".old")
            || name.contains(".old") && name.ends_with(|c: char| c.is_ascii_digit())
        {
            let _ = fs::remove_file(entry.path());
        }
    }
}

pub fn dir_size(path: &Path) -> u64 {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return 0;
    };
    if metadata.file_type().is_symlink() {
        return 0;
    }
    if metadata.is_file() {
        return metadata.len();
    }
    fs::read_dir(path)
        .map(|entries| entries.flatten().map(|entry| dir_size(&entry.path())).sum())
        .unwrap_or(0)
}

pub fn list_dir(path: &Path) -> Vec<PathBuf> {
    fs::read_dir(path)
        .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("target")
            .join("setup-tests")
            .join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        std::path::absolute(dir).unwrap()
    }

    #[test]
    fn junctions_are_created_read_retargeted_and_removed_without_touching_targets() {
        let dir = scratch("junction");
        let (a, b) = (dir.join("a"), dir.join("b"));
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        fs::write(a.join("keep.txt"), b"a").unwrap();
        let link = dir.join("current");
        create_junction(&link, &a).unwrap();
        assert_eq!(link_state(&link), LinkState::Link(a.clone()));
        assert!(link.join("keep.txt").is_file());
        retarget_junction(&link, &b).unwrap();
        assert_eq!(link_state(&link), LinkState::Link(b.clone()));
        // Removing the link never removes what it pointed at.
        remove_tree_within(&link, &dir).unwrap();
        assert_eq!(link_state(&link), LinkState::Missing);
        assert!(a.join("keep.txt").is_file());
        // A real directory in the link's place is never replaced.
        fs::create_dir_all(&link).unwrap();
        assert_eq!(link_state(&link), LinkState::Occupied);
        assert!(retarget_junction(&link, &a).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn deletes_stay_inside_the_root() {
        let dir = scratch("within");
        assert!(is_within(&dir.join("x"), &dir));
        assert!(!is_within(&dir, &dir));
        assert!(!is_within(
            &PathBuf::from(format!("{}-other", dir.display())),
            &dir
        ));
        assert!(remove_tree_within(&dir, &dir).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn atomic_write_and_running_file_replacement() {
        let dir = scratch("replace");
        let target = dir.join("tool.exe");
        write_atomic(&target, b"v1").unwrap();
        let source = dir.join("incoming.exe");
        fs::write(&source, b"v2").unwrap();
        let aside = replace_file(&target, &source).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"v2");
        assert_eq!(fs::read(aside.unwrap()).unwrap(), b"v1");
        // Identical content: nothing moves.
        assert_eq!(replace_file(&target, &source).unwrap(), None);
        fs::remove_dir_all(&dir).unwrap();
    }
}
