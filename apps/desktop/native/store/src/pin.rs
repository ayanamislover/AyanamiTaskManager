//! 钉住的目录（W3 r2 P1-R2-01）：dry-run 写入与清理期间，目录的身份不能被换掉。
//!
//! Windows 上持有目录句柄、不给 `FILE_SHARE_DELETE`：这个目录本身不能改名、不能删除，它的每一层祖先也不能改名
//! （实测：钉住子目录时改祖先的名得到 ERROR_ACCESS_DENIED，改它自己的名得到 ERROR_SHARING_VIOLATION）。
//! 所以钉住之后，句柄的最终路径（`GetFinalPathNameByHandleW`，不含任何 junction / 符号链接）一直指向这个目录。
//!
//! 新目录用 `NtCreateFile(FILE_CREATE)` 相对父目录的句柄排他新建，建出来就是钉住的：名字已经存在
//! （目录、文件、junction）就失败，中间没有「先建再打开」的空档可以被换掉。
//!
//! 其他平台没有这层保护：按路径建、按路径删（产品只在 Windows 上发布）。

use std::ffi::OsStr;
use std::fs::File;
use std::path::{Path, PathBuf};

/// 一个钉住的目录。`owned` 的是本次新建的，只有它们能 [`Dir::remove`]。
pub(crate) struct Dir {
    #[cfg_attr(not(windows), allow(dead_code))]
    file: File,
    path: PathBuf,
    owned: bool,
    /// (卷序列号, 文件号)：清理时重新打开，核对还是同一个目录才删。
    #[cfg_attr(not(windows), allow(dead_code))]
    id: (u32, u64),
}

impl Dir {
    /// 句柄的最终路径：真实位置，不含链接。钉住期间不变。
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// 删掉本次新建的这个目录：先删里面的条目（不跟随链接：junction、符号链接只删链接本身），
    /// 再删目录自己：放开钉住、不跟随链接地重新打开，文件号与新建时相同才删（不同就是被换过，不删）。
    /// 打开的已有目录不删。调用时它的父目录要仍是钉住的。
    pub(crate) fn remove(self) -> std::io::Result<()> {
        if !self.owned {
            return Err(std::io::Error::other(format!(
                "{} was not created here",
                self.path.display()
            )));
        }
        for entry in std::fs::read_dir(&self.path)? {
            let entry = entry?;
            let (kind, p) = (entry.file_type()?, entry.path());
            if kind.is_symlink() {
                unlink(&p)?;
            } else if kind.is_dir() {
                std::fs::remove_dir_all(&p)?;
            } else {
                std::fs::remove_file(&p)?;
            }
        }
        imp::delete(self)
    }
}

/// 删一个链接本身：目录链接（junction、目录符号链接）用 remove_dir，其余用 remove_file。都不碰目标。
fn unlink(p: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt;
        if std::fs::symlink_metadata(p)?.file_type().is_symlink_dir() {
            return std::fs::remove_dir(p);
        }
    }
    std::fs::remove_file(p)
}

/// 打开一个已存在的目录并钉住（跟随链接：钉住的是链接的目标）。
pub(crate) fn open(path: &Path) -> std::io::Result<Dir> {
    imp::open(path)
}

/// 在 `parent` 里排他新建子目录 `name` 并钉住。`name` 必须是单个分量。
pub(crate) fn create(parent: &Dir, name: &OsStr) -> std::io::Result<Dir> {
    let single = Path::new(name).components().count() == 1
        && matches!(
            Path::new(name).components().next(),
            Some(std::path::Component::Normal(_))
        );
    if !single {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!(
                "{} is not a single path component",
                Path::new(name).display()
            ),
        ));
    }
    imp::create(parent, name)
}

#[cfg(windows)]
mod imp {
    use super::Dir;
    use std::ffi::{OsStr, OsString, c_void};
    use std::fs::File;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::os::windows::io::{AsRawHandle, FromRawHandle, RawHandle};
    use std::path::{Path, PathBuf};

    const FILE_LIST_DIRECTORY: u32 = 0x0001;
    const FILE_ADD_FILE: u32 = 0x0002;
    const FILE_ADD_SUBDIRECTORY: u32 = 0x0004;
    const FILE_TRAVERSE: u32 = 0x0020;
    const FILE_READ_ATTRIBUTES: u32 = 0x0080;
    const DELETE: u32 = 0x0001_0000;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    /// 钉住要的权限：列目录、在里面建东西、读属性。不要 DELETE：持有 DELETE 的句柄会让目录里的条目都改不了名
    /// （实测 ERROR_SHARING_VIOLATION），报告与转换器的原子改名就做不成了。
    const ACCESS: u32 = FILE_LIST_DIRECTORY
        | FILE_ADD_FILE
        | FILE_ADD_SUBDIRECTORY
        | FILE_TRAVERSE
        | FILE_READ_ATTRIBUTES
        | SYNCHRONIZE;
    const FILE_SHARE_READ: u32 = 0x1;
    const FILE_SHARE_WRITE: u32 = 0x2;
    /// 共享方式里故意没有 FILE_SHARE_DELETE：这就是「钉住」。
    const SHARE: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE;
    const OPEN_EXISTING: u32 = 3;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;
    const FILE_CREATE: u32 = 2;
    const FILE_DIRECTORY_FILE: u32 = 0x0000_0001;
    const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x0000_0020;
    const FILE_OPEN_FOR_BACKUP_INTENT: u32 = 0x0000_4000;
    const OBJ_CASE_INSENSITIVE: u32 = 0x40;
    const FILE_DISPOSITION_INFO_CLASS: i32 = 4;
    const INVALID_HANDLE_VALUE: isize = -1;

    #[repr(C)]
    struct UnicodeString {
        length: u16,
        maximum_length: u16,
        buffer: *mut u16,
    }

    #[repr(C)]
    struct ObjectAttributes {
        length: u32,
        root_directory: RawHandle,
        object_name: *mut UnicodeString,
        attributes: u32,
        security_descriptor: *mut c_void,
        security_quality_of_service: *mut c_void,
    }

    #[repr(C)]
    struct IoStatusBlock {
        status: usize,
        information: usize,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            security: *mut c_void,
            disposition: u32,
            flags: u32,
            template: RawHandle,
        ) -> RawHandle;
        fn GetFinalPathNameByHandleW(handle: RawHandle, buf: *mut u16, len: u32, flags: u32)
        -> u32;
        fn GetFileInformationByHandle(handle: RawHandle, info: *mut [u32; 13]) -> i32;
        fn SetFileInformationByHandle(
            handle: RawHandle,
            class: i32,
            info: *const c_void,
            size: u32,
        ) -> i32;
    }

    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtCreateFile(
            handle: *mut RawHandle,
            access: u32,
            attributes: *mut ObjectAttributes,
            status: *mut IoStatusBlock,
            allocation: *mut i64,
            file_attributes: u32,
            share: u32,
            disposition: u32,
            options: u32,
            ea: *mut c_void,
            ea_length: u32,
        ) -> i32;
        fn RtlNtStatusToDosError(status: i32) -> u32;
    }

    fn wide(s: &OsStr) -> Vec<u16> {
        s.encode_wide().collect()
    }

    /// 句柄的最终路径（`\\?\` 形，链接都已解析）。
    fn final_path(file: &File) -> std::io::Result<PathBuf> {
        let mut buf = vec![0u16; 512];
        loop {
            // SAFETY: 句柄在 `file` 存活期间有效；缓冲区长度如实传入，函数只写 `len` 个以内的 u16。
            let n = unsafe {
                GetFinalPathNameByHandleW(
                    file.as_raw_handle(),
                    buf.as_mut_ptr(),
                    buf.len() as u32,
                    0,
                )
            } as usize;
            if n == 0 {
                return Err(std::io::Error::last_os_error());
            }
            if n < buf.len() {
                return Ok(PathBuf::from(OsString::from_wide(&buf[..n])));
            }
            buf.resize(n + 1, 0);
        }
    }

    /// BY_HANDLE_FILE_INFORMATION 里的 (卷序列号, 文件号)。
    fn identity(file: &File) -> std::io::Result<(u32, u64)> {
        let mut info = [0u32; 13];
        // SAFETY: 句柄有效；结构是 13 个 DWORD，按 Win32 布局：7 卷序列号、11/12 文件号的高/低位。
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok((info[7], (u64::from(info[11]) << 32) | u64::from(info[12])))
    }

    fn checked(file: File, owned: bool) -> std::io::Result<Dir> {
        let meta = file.metadata()?;
        if !meta.is_dir() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotADirectory,
                "not a directory",
            ));
        }
        let path = final_path(&file)?;
        let id = identity(&file)?;
        Ok(Dir {
            file,
            path,
            owned,
            id,
        })
    }

    fn open_raw(path: &Path, access: u32, flags: u32) -> std::io::Result<File> {
        let name: Vec<u16> = wide(path.as_os_str()).into_iter().chain(Some(0)).collect();
        // SAFETY: `name` 以 0 结尾、调用期间存活；其余指针参数按文档可为空。
        let h = unsafe {
            CreateFileW(
                name.as_ptr(),
                access,
                SHARE,
                std::ptr::null_mut(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | flags,
                std::ptr::null_mut(),
            )
        };
        if h as isize == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: 刚打开的有效句柄，所有权交给 File（drop 时关闭）。
        Ok(unsafe { File::from_raw_handle(h) })
    }

    pub(super) fn open(path: &Path) -> std::io::Result<Dir> {
        checked(open_raw(path, ACCESS, 0)?, false)
    }

    pub(super) fn create(parent: &Dir, name: &OsStr) -> std::io::Result<Dir> {
        let mut units = wide(name);
        let bytes = u16::try_from(units.len() * 2)
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "name too long"))?;
        let mut object_name = UnicodeString {
            length: bytes,
            maximum_length: bytes,
            buffer: units.as_mut_ptr(),
        };
        let mut attributes = ObjectAttributes {
            length: std::mem::size_of::<ObjectAttributes>() as u32,
            root_directory: parent.file.as_raw_handle(),
            object_name: &mut object_name,
            attributes: OBJ_CASE_INSENSITIVE,
            security_descriptor: std::ptr::null_mut(),
            security_quality_of_service: std::ptr::null_mut(),
        };
        let mut io = IoStatusBlock {
            status: 0,
            information: 0,
        };
        let mut h: RawHandle = std::ptr::null_mut();
        // SAFETY: 所有指针指向本函数里存活到调用结束的局部值；名字相对父目录句柄解析，父句柄由 `parent` 持有。
        let status = unsafe {
            NtCreateFile(
                &mut h,
                ACCESS,
                &mut attributes,
                &mut io,
                std::ptr::null_mut(),
                FILE_ATTRIBUTE_NORMAL,
                SHARE,
                FILE_CREATE,
                FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_FOR_BACKUP_INTENT,
                std::ptr::null_mut(),
                0,
            )
        };
        if status < 0 {
            // SAFETY: 纯函数，参数是 NTSTATUS。
            let code = unsafe { RtlNtStatusToDosError(status) };
            return Err(std::io::Error::from_raw_os_error(code as i32));
        }
        // SAFETY: 成功时 `h` 是新建目录的有效句柄，所有权交给 File。
        checked(unsafe { File::from_raw_handle(h) }, true)
    }

    pub(super) fn delete(dir: Dir) -> std::io::Result<()> {
        let Dir { file, path, id, .. } = dir;
        drop(file);
        // 不跟随链接：此刻这个名字若被换成 junction，打开的是链接本身，文件号对不上。
        // 共享方式里没有 FILE_SHARE_DELETE：打开之后到删除之前，别人也改不了它的名。
        let again = open_raw(
            &path,
            DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_FLAG_OPEN_REPARSE_POINT,
        )?;
        if identity(&again)? != id {
            return Err(std::io::Error::other(format!(
                "{} was replaced; left as is",
                path.display()
            )));
        }
        let flag: u8 = 1;
        // SAFETY: 句柄有效且带 DELETE 权限；信息结构是一个 BOOLEAN，长度如实传入。
        let ok = unsafe {
            SetFileInformationByHandle(
                again.as_raw_handle(),
                FILE_DISPOSITION_INFO_CLASS,
                (&flag as *const u8).cast(),
                1,
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        // 关掉句柄时目录真正删除。
        drop(again);
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    use super::Dir;
    use std::ffi::OsStr;
    use std::fs::File;
    use std::path::Path;

    pub(super) fn open(path: &Path) -> std::io::Result<Dir> {
        let path = std::fs::canonicalize(path)?;
        let file = File::open(&path)?;
        Ok(Dir {
            file,
            path,
            owned: false,
            id: (0, 0),
        })
    }

    pub(super) fn create(parent: &Dir, name: &OsStr) -> std::io::Result<Dir> {
        let path = parent.path.join(name);
        std::fs::create_dir(&path)?;
        let file = File::open(&path)?;
        Ok(Dir {
            file,
            path,
            owned: true,
            id: (0, 0),
        })
    }

    pub(super) fn delete(dir: Dir) -> std::io::Result<()> {
        std::fs::remove_dir(&dir.path)
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::var_os("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("target")
            })
            .join("store-unit")
            .join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn junction(alias: &Path, target: &Path) {
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(alias)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
    }

    /// 钉住的目录与它的祖先都改不了名、删不掉；钉住的目录里照常能建东西。
    #[test]
    fn a_pinned_directory_keeps_its_place() {
        let base = scratch("pin-place");
        let outer = open(&base).unwrap();
        let a = create(&outer, OsStr::new("a")).unwrap();
        let b = create(&a, OsStr::new("b")).unwrap();
        assert!(std::fs::rename(base.join("a"), base.join("a2")).is_err());
        assert!(std::fs::rename(base.join("a/b"), base.join("a/b2")).is_err());
        assert!(std::fs::remove_dir_all(base.join("a/b")).is_err());
        assert!(base.join("a/b").is_dir());
        std::fs::write(b.path().join("f"), b"x").unwrap();
        assert_eq!(std::fs::read(base.join("a/b/f")).unwrap(), b"x");
        // 钉住的目录里的条目照常能改名（报告与转换器要原子改名）。
        std::fs::rename(b.path().join("f"), b.path().join("g")).unwrap();
        // 阳性对照：放开之后就能改名。
        drop((b, a));
        std::fs::rename(base.join("a"), base.join("a2")).unwrap();
        drop(outer);
        std::fs::remove_dir_all(&base).unwrap();
    }

    /// 排他新建：名字被目录、文件或 junction 占了都失败，junction 的目标不变。名字只能是单个分量。
    #[test]
    fn create_never_reuses_an_existing_name() {
        let base = scratch("pin-exclusive");
        let elsewhere = base.join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        std::fs::create_dir(base.join("taken-dir")).unwrap();
        std::fs::write(base.join("taken-file"), b"x").unwrap();
        junction(&base.join("taken-link"), &elsewhere);
        let outer = open(&base).unwrap();
        for name in ["taken-dir", "taken-file", "taken-link", "TAKEN-DIR"] {
            let e = create(&outer, OsStr::new(name)).err();
            assert_eq!(
                e.map(|e| e.kind()),
                Some(std::io::ErrorKind::AlreadyExists),
                "{name}"
            );
        }
        for name in ["..", "a\\b", "a/b", "."] {
            assert!(create(&outer, OsStr::new(name)).is_err(), "{name}");
        }
        assert_eq!(std::fs::read_dir(&elsewhere).unwrap().count(), 0);
        let fresh = create(&outer, OsStr::new("fresh")).unwrap();
        assert_eq!(
            fresh.path().file_name(),
            Some(OsStr::new("fresh")),
            "{}",
            fresh.path().display()
        );
        drop((fresh, outer));
        std::fs::remove_dir(base.join("taken-link")).unwrap();
        std::fs::remove_dir_all(&base).unwrap();
    }

    /// 清理不跟随链接：目录里的 junction 只删链接，目标里的东西还在；打开的已有目录不许删。
    #[test]
    fn remove_unlinks_without_following() {
        let base = scratch("pin-remove");
        let target = base.join("target");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("keep.txt"), b"keep").unwrap();
        let outer = open(&base).unwrap();
        let mine = create(&outer, OsStr::new("mine")).unwrap();
        let sub = create(&mine, OsStr::new("sub")).unwrap();
        std::fs::write(sub.path().join("f"), b"x").unwrap();
        drop(sub);
        junction(&base.join("mine").join("link"), &target);
        std::fs::write(mine.path().join("file"), b"x").unwrap();
        mine.remove().unwrap();
        assert!(!base.join("mine").exists());
        assert_eq!(std::fs::read(target.join("keep.txt")).unwrap(), b"keep");
        assert!(open(&target).unwrap().remove().is_err());
        assert!(target.is_dir());
        // 重新打开时文件号对不上（被换过）就不删。
        let mut swapped = create(&outer, OsStr::new("swapped")).unwrap();
        swapped.id.1 ^= 1;
        let e = swapped.remove().unwrap_err();
        assert!(e.to_string().contains("was replaced"), "{e}");
        assert!(base.join("swapped").is_dir());
        drop(outer);
        std::fs::remove_dir_all(&base).unwrap();
    }
}
