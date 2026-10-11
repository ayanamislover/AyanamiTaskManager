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

/// 本次在钉住的目录里排他新建的一个文件：清理时按 (卷序列号, 文件号) 核对，还是它才删。
pub(crate) struct FileMark {
    path: PathBuf,
    #[cfg_attr(not(windows), allow(dead_code))]
    id: (u32, u64),
}

/// 本次排他新建、一直开着的文件（W3 r4 P1-R4-01）：句柄带 DELETE 权限、共享方式不含 `FILE_SHARE_DELETE`，
/// 所以从新建到改名（或丢弃）这段时间里，别人既改不了它的名、也删不掉它，名字上不会换成别的文件。
/// 改名与丢弃都按句柄做，不按路径。
pub(crate) struct NewFile {
    file: File,
    path: PathBuf,
}

impl NewFile {
    pub(crate) fn file(&mut self) -> &mut File {
        &mut self.file
    }

    /// 按句柄改名成钉住的 `dir` 里的 `name`；名字已存在就失败（不替换）。失败时文件仍开着、仍归调用方。
    /// 改名成功就记下新位置，再刷盘：之后刷盘、丢弃的错误报的都是文件实际所在的名字（W3 peer r5 P2-R5-01）。
    pub(crate) fn rename_into(&mut self, dir: &Dir, name: &OsStr) -> std::io::Result<()> {
        single(name)?;
        let to = dir.path().join(name);
        imp::rename_handle(&self.file, &self.path, &to)?;
        self.path = to;
        self.file.sync_all().map_err(|e| {
            std::io::Error::new(e.kind(), format!("flush {}: {e}", self.path.display()))
        })
    }

    /// 文件现在的位置（改名之前是临时名，之后是新名）。
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// 按句柄删掉它（改名失败之后用）。
    pub(crate) fn discard(self) -> std::io::Result<()> {
        imp::discard_handle(self.file, &self.path)
    }
}

/// 要搬走的一个已有目录（peer W6 r4 P1-03：恢复把暂存换入成项目附件目录）。不跟随链接地打开，句柄带 DELETE
/// 权限、共享方式不含 `FILE_SHARE_DELETE`；打开时核对它是目录、不是链接、最终路径就是钉住的父目录里的那个名字。
/// 从打开到 [`Movable::move_into`] 生效，别人改不了它的名、删不掉它，这个名字上也换不成别的东西——核对的
/// 与搬走的是同一个对象。改名按句柄做。
pub(crate) struct Movable {
    file: File,
    path: PathBuf,
}

/// [`open_movable`] 发现这个名字上是链接、不是目录，或者打开的不是父目录里的这一项。
pub(crate) const NOT_MOVABLE: &str = "not a plain directory inside its pinned parent";

/// 打开 `parent` 里的 `name` 准备搬走（见 [`Movable`]）。不存在时报 NotFound；是链接、普通文件或别处的目录时报
/// [`NOT_MOVABLE`]（`ErrorKind::InvalidData`）。
pub(crate) fn open_movable(parent: &Dir, name: &OsStr) -> std::io::Result<Movable> {
    single(name)?;
    let path = parent.path().join(name);
    let file = imp::open_movable(&path)?;
    Ok(Movable { file, path })
}

impl Movable {
    /// 按句柄改名成钉住的 `dir` 里的 `name`；名字已存在就失败（不替换）。成功后刷盘。
    pub(crate) fn move_into(self, dir: &Dir, name: &OsStr) -> std::io::Result<()> {
        single(name)?;
        let to = dir.path().join(name);
        imp::rename_handle(&self.file, &self.path, &to)?;
        self.file
            .sync_all()
            .map_err(|e| std::io::Error::new(e.kind(), format!("flush {}: {e}", to.display())))
    }
}

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

    /// (卷序列号, 文件号)：同一个目录任何时候读到的都相同。
    pub(crate) fn id(&self) -> (u32, u64) {
        self.id
    }

    /// 测试用：让清理时的身份核对对不上，等于「放开钉住到重新打开之间，这个名字被换成了别的目录」。
    #[cfg(test)]
    pub(crate) fn forge_identity(&mut self) {
        self.id.1 ^= 1;
    }

    /// 删掉本次新建的这个目录。它必须已经是空的（本次在里面建的东西先由调用方按身份删掉）：放开钉住、不跟随
    /// 链接地重新打开，文件号与新建时相同才删；不同就是被换过，原样留下。目录里还有别的东西时删除失败，也原样
    /// 留下——不认识的条目一律不删（W3 r3 P1-R3-01：枚举着删，会把换进来的外来目录连同内容一起删掉）。
    /// 打开的已有目录不删。调用时它的父目录要仍是钉住的。
    pub(crate) fn remove(self) -> std::io::Result<()> {
        if !self.owned {
            return Err(std::io::Error::other(format!(
                "{} was not created here",
                self.path.display()
            )));
        }
        imp::delete(self, None)
    }

    /// 整棵删：先删里面的条目（不跟随链接：junction、符号链接只删链接本身），再按 [`Dir::remove`] 删自己。
    /// 只用于转换器自己写满的 `data`：那里面的目录由转换器按路径新建，不经过钉住（REPORT.md「目录身份」的边界）。
    pub(crate) fn remove_tree(self) -> std::io::Result<()> {
        if !self.owned {
            return Err(std::io::Error::other(format!(
                "{} was not created here",
                self.path.display()
            )));
        }
        clear(&self.path)?;
        #[cfg(test)]
        AFTER_CLEAR.with(|h| {
            if let Some(f) = h.borrow_mut().take() {
                f(&self.path)
            }
        });
        // 删自己时目录又不是空的（列完之后里面又冒出了条目，或者有条目删了但还挂着）：在删除句柄还开着、别人
        // 换不走这个目录的时候再清一次，再删（W6 r11 的全量里遇到过一次）。
        imp::delete(self, Some(&clear))
    }
}

/// 删目录时「目录不是空的」，先拿它把目录再清一次（只有整棵删才给）。
type Again<'a> = Option<&'a dyn Fn(&Path) -> std::io::Result<()>>;

/// 删掉目录里的全部条目（不跟随链接：junction、符号链接只删链接本身）。
fn clear(dir: &Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
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
    Ok(())
}

/// 用例在 `remove_tree` 清完、删自己之前往目录里放东西（造「列完之后又冒出条目」）。只用一次。
#[cfg(test)]
type AfterClear = Box<dyn FnOnce(&Path)>;

#[cfg(test)]
thread_local! {
    static AFTER_CLEAR: std::cell::RefCell<Option<AfterClear>> = const { std::cell::RefCell::new(None) };
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
    single(name)?;
    imp::create(parent, name)
}

/// 在钉住的 `parent` 里排他新建文件 `name`（名字被占就失败），记下它的身份。
pub(crate) fn create_file(parent: &Dir, name: &OsStr) -> std::io::Result<(File, FileMark)> {
    single(name)?;
    let path = parent.path().join(name);
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    let id = imp::file_identity(&file)?;
    Ok((file, FileMark { path, id }))
}

/// 删掉本次新建的一个文件：不跟随链接地打开，身份与新建时相同才删；被换过就原样留下并报错。
pub(crate) fn remove_file(mark: FileMark) -> std::io::Result<()> {
    imp::remove_file(mark)
}

/// 在钉住的 `parent` 里排他新建文件 `name` 并一直开着（见 [`NewFile`]）。
pub(crate) fn create_open(parent: &Dir, name: &OsStr) -> std::io::Result<NewFile> {
    single(name)?;
    let path = parent.path().join(name);
    let file = imp::create_open(&path)?;
    Ok(NewFile { file, path })
}

fn single(name: &OsStr) -> std::io::Result<()> {
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
    Ok(())
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
    const FILE_RENAME_INFO_CLASS: i32 = 3;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const CREATE_NEW: u32 = 1;
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
        open_shared(path, access, SHARE, flags)
    }

    /// 要搬走的目录打开时的共享方式：同样不含 FILE_SHARE_DELETE，打开期间别人改不了它的名（peer W6 r4 P1-03）。
    const MOVABLE_SHARE: u32 = SHARE;

    fn open_shared(path: &Path, access: u32, share: u32, flags: u32) -> std::io::Result<File> {
        let name: Vec<u16> = wide(path.as_os_str()).into_iter().chain(Some(0)).collect();
        // SAFETY: `name` 以 0 结尾、调用期间存活；其余指针参数按文档可为空。
        let h = unsafe {
            CreateFileW(
                name.as_ptr(),
                access,
                share,
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

    pub(super) fn file_identity(file: &File) -> std::io::Result<(u32, u64)> {
        identity(file)
    }

    /// 见 [`super::open_movable`]。FILE_ADD_FILE（目录的写数据权限）是为了改名后能刷盘。
    pub(super) fn open_movable(path: &Path) -> std::io::Result<File> {
        const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        let file = transient(|| {
            open_shared(
                path,
                DELETE | FILE_ADD_FILE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                MOVABLE_SHARE,
                FILE_FLAG_OPEN_REPARSE_POINT,
            )
        })?;
        let mut info = [0u32; 13];
        // SAFETY: 同 `identity`；第 0 个 DWORD 是文件属性。
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let refused = || {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("{}: {}", path.display(), super::NOT_MOVABLE),
            )
        };
        if info[0] & FILE_ATTRIBUTE_DIRECTORY == 0 || info[0] & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(refused());
        }
        // 不跟随链接打开的就是这个名字本身；最终路径再对一次，确认它就在钉住的父目录里。
        let actual = final_path(&file)?;
        if actual.to_string_lossy().to_lowercase() != path.to_string_lossy().to_lowercase() {
            return Err(refused());
        }
        Ok(file)
    }

    pub(super) fn remove_file(mark: super::FileMark) -> std::io::Result<()> {
        delete_named(&mark.path, mark.id, None)
    }

    /// `again`：标记删除得到「目录不是空的」时，先用它把目录再清一次（只有整棵删才给）。
    pub(super) fn delete(dir: Dir, again: super::Again<'_>) -> std::io::Result<()> {
        let Dir { file, path, id, .. } = dir;
        drop(file);
        delete_named(&path, id, again)
    }

    /// 按名字删一个条目，但只删身份对得上的那一个。
    fn delete_named(path: &Path, id: (u32, u64), clear: super::Again<'_>) -> std::io::Result<()> {
        // 不跟随链接：此刻这个名字若被换成 junction，打开的是链接本身，文件号对不上。
        // 共享方式里没有 FILE_SHARE_DELETE：打开之后到删除之前，别人也改不了它的名。
        // 别的程序（杀毒、索引）短暂开着它时打开会得到共享冲突：退避重试约 2 秒，仍不行就原样留下并报错。
        let again = transient(|| {
            open_raw(
                path,
                DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                FILE_FLAG_OPEN_REPARSE_POINT,
            )
        })
        .map_err(|e| std::io::Error::new(e.kind(), format!("{}: {e}", path.display())))?;
        if identity(&again)? != id {
            return Err(std::io::Error::other(format!(
                "{} was replaced; left as is",
                path.display()
            )));
        }
        // 标记删除得到「目录不是空的」（145）：整棵删的，在 `again` 开着时（没有 FILE_SHARE_DELETE，别人改不了它的
        // 名、换不走它）再清一次再标记；只删空目录的不清，只等挂着的条目消失。都退避约 2 秒，仍不行就原样留下并报错。
        let mut tried = false;
        retry(&[145], || {
            // 头一次直接标记（调用方已经清过）；之后每次先清再标记。
            if let Some(clear) = clear.filter(|_| tried) {
                clear(path)?;
            }
            tried = true;
            dispose(&again)
        })
        .map_err(|e| std::io::Error::new(e.kind(), format!("{}: {e}", path.display())))?;
        // 关掉句柄时真正删除。
        drop(again);
        Ok(())
    }

    /// 共享冲突（32）与锁冲突（33）重试约 2 秒；其余错误立即返回。
    fn transient<T>(f: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
        retry(&[32, 33], f)
    }

    /// 给定的几种错误码退避重试约 2 秒；其余错误立即返回。
    fn retry<T>(codes: &[i32], mut f: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
        let mut delay = std::time::Duration::from_millis(10);
        let mut waited = std::time::Duration::ZERO;
        loop {
            match f() {
                Err(e)
                    if e.raw_os_error().is_some_and(|c| codes.contains(&c))
                        && waited < std::time::Duration::from_secs(2) =>
                {
                    std::thread::sleep(delay);
                    waited += delay;
                    delay = (delay * 2).min(std::time::Duration::from_millis(250));
                }
                other => return other,
            }
        }
    }

    /// 标记删除：句柄关掉时删除。
    fn dispose(file: &File) -> std::io::Result<()> {
        let flag: u8 = 1;
        // SAFETY: 句柄有效且带 DELETE 权限；信息结构是一个 BOOLEAN，长度如实传入。
        let ok = unsafe {
            SetFileInformationByHandle(
                file.as_raw_handle(),
                FILE_DISPOSITION_INFO_CLASS,
                (&flag as *const u8).cast(),
                1,
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    pub(super) fn create_open(path: &Path) -> std::io::Result<File> {
        let name: Vec<u16> = wide(path.as_os_str()).into_iter().chain(Some(0)).collect();
        // SAFETY: `name` 以 0 结尾、调用期间存活；其余指针参数按文档可为空。
        let h = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_WRITE | DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                FILE_SHARE_READ,
                std::ptr::null_mut(),
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        };
        if h as isize == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: 刚打开的有效句柄，所有权交给 File。
        Ok(unsafe { File::from_raw_handle(h) })
    }

    /// FILE_RENAME_INFO（ReplaceIfExists = FALSE、RootDirectory = NULL、完整目标路径）。
    pub(super) fn rename_handle(file: &File, from: &Path, to: &Path) -> std::io::Result<()> {
        let name = wide(to.as_os_str());
        let bytes = name.len() * 2;
        // 布局（x64）：Flags u32 @0、RootDirectory @8、FileNameLength u32 @16、FileName @20。按 u64 分配保证对齐。
        let size = 20 + bytes + 2;
        let mut buf = vec![0u64; size.div_ceil(8)];
        let base = buf.as_mut_ptr().cast::<u8>();
        // SAFETY: 缓冲区至少 `size` 字节且 8 字节对齐；各字段按上面的偏移写入，名字之后留 0 结尾。
        unsafe {
            std::ptr::write(base.add(16).cast::<u32>(), bytes as u32);
            std::ptr::copy_nonoverlapping(name.as_ptr().cast::<u8>(), base.add(20), bytes);
        }
        // SAFETY: 句柄有效且带 DELETE 权限；信息结构按上面的布局构造，长度如实传入。
        let ok = unsafe {
            SetFileInformationByHandle(
                file.as_raw_handle(),
                FILE_RENAME_INFO_CLASS,
                base.cast(),
                size as u32,
            )
        };
        if ok == 0 {
            let e = std::io::Error::last_os_error();
            return Err(std::io::Error::new(
                e.kind(),
                format!("{} -> {}: {e}", from.display(), to.display()),
            ));
        }
        Ok(())
    }

    pub(super) fn discard_handle(file: File, path: &Path) -> std::io::Result<()> {
        dispose(&file)
            .map_err(|e| std::io::Error::new(e.kind(), format!("{}: {e}", path.display())))?;
        drop(file);
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

    pub(super) fn delete(dir: Dir, again: super::Again<'_>) -> std::io::Result<()> {
        if let Some(clear) = again {
            clear(&dir.path)?;
        }
        std::fs::remove_dir(&dir.path)
    }

    pub(super) fn file_identity(_: &File) -> std::io::Result<(u32, u64)> {
        Ok((0, 0))
    }

    pub(super) fn open_movable(path: &Path) -> std::io::Result<File> {
        let meta = std::fs::symlink_metadata(path)?;
        if !meta.is_dir() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                super::NOT_MOVABLE,
            ));
        }
        File::open(path)
    }

    pub(super) fn remove_file(mark: super::FileMark) -> std::io::Result<()> {
        std::fs::remove_file(&mark.path)
    }

    pub(super) fn create_open(path: &Path) -> std::io::Result<File> {
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
    }

    pub(super) fn rename_handle(_: &File, from: &Path, to: &Path) -> std::io::Result<()> {
        if std::fs::symlink_metadata(to).is_ok() {
            return Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists));
        }
        std::fs::rename(from, to)
    }

    pub(super) fn discard_handle(file: File, path: &Path) -> std::io::Result<()> {
        drop(file);
        std::fs::remove_file(path)
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::var_os("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .unwrap()
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

    /// W3 r4 P1-R4-01：开着的临时文件别人改不了名、删不掉；改名不替换已有的名字，失败后按句柄丢弃，
    /// 只删自己的临时文件；成功改名后内容就在新名字下。
    #[test]
    fn an_open_new_file_keeps_its_name_until_renamed_or_discarded() {
        use std::io::Write;
        let base = scratch("pin-new-file");
        let dir = open(&base).unwrap();
        std::fs::write(base.join("taken"), b"theirs").unwrap();

        let mut f = create_open(&dir, OsStr::new("a.tmp")).unwrap();
        assert!(
            create_open(&dir, OsStr::new("a.tmp")).is_err(),
            "names are exclusive"
        );
        f.file().write_all(b"mine").unwrap();
        assert!(std::fs::rename(base.join("a.tmp"), base.join("moved")).is_err());
        assert!(std::fs::remove_file(base.join("a.tmp")).is_err());
        assert!(
            f.rename_into(&dir, OsStr::new("taken")).is_err(),
            "no replacing"
        );
        assert_eq!(std::fs::read(base.join("taken")).unwrap(), b"theirs");
        f.discard().unwrap();
        assert!(!base.join("a.tmp").exists());
        assert_eq!(std::fs::read(base.join("taken")).unwrap(), b"theirs");

        let mut g = create_open(&dir, OsStr::new("b.tmp")).unwrap();
        g.file().write_all(b"report").unwrap();
        g.rename_into(&dir, OsStr::new("report.json")).unwrap();
        assert_eq!(g.path().file_name(), Some(OsStr::new("report.json")));
        drop(g);
        assert!(!base.join("b.tmp").exists());
        assert_eq!(std::fs::read(base.join("report.json")).unwrap(), b"report");
        drop(dir);
        std::fs::remove_dir_all(&base).unwrap();
    }

    /// W3 peer r5 P2-R5-01：丢弃失败时，错误报的是文件实际所在的名字——改名之前是临时名，改名之后是新名。
    #[test]
    fn a_failed_discard_names_where_the_file_is() {
        let base = scratch("pin-discard-names");
        let dir = open(&base).unwrap();
        let read_only = |p: &Path| {
            let mut perm = std::fs::metadata(p).unwrap().permissions();
            perm.set_readonly(true);
            std::fs::set_permissions(p, perm).unwrap();
        };
        let writable = |p: &Path| {
            let mut perm = std::fs::metadata(p).unwrap().permissions();
            #[allow(clippy::permissions_set_readonly_false)]
            perm.set_readonly(false);
            std::fs::set_permissions(p, perm).unwrap();
        };

        // 改名之前：名字被占，改名失败；临时文件只读，丢弃也失败。
        std::fs::write(base.join("taken.json"), b"theirs").unwrap();
        let mut f = create_open(&dir, OsStr::new("a.tmp")).unwrap();
        assert!(f.rename_into(&dir, OsStr::new("taken.json")).is_err());
        read_only(&base.join("a.tmp"));
        let e = f.discard().unwrap_err().to_string();
        assert!(e.contains("a.tmp"), "{e}");
        writable(&base.join("a.tmp"));

        // 改名之后：文件已在新名下，只读，丢弃失败——报的是新名，不是早已不存在的临时名。
        let mut g = create_open(&dir, OsStr::new("b.tmp")).unwrap();
        g.rename_into(&dir, OsStr::new("report.json")).unwrap();
        read_only(&base.join("report.json"));
        let e = g.discard().unwrap_err().to_string();
        assert!(e.contains("report.json") && !e.contains("b.tmp"), "{e}");
        writable(&base.join("report.json"));
        assert_eq!(std::fs::read(base.join("taken.json")).unwrap(), b"theirs");
        drop(dir);
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
    fn remove_tree_unlinks_without_following() {
        let base = scratch("pin-remove-tree");
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
        mine.remove_tree().unwrap();
        assert!(!base.join("mine").exists());
        assert_eq!(std::fs::read(target.join("keep.txt")).unwrap(), b"keep");
        assert!(open(&target).unwrap().remove_tree().is_err());
        assert!(target.is_dir());
        drop(outer);
        std::fs::remove_dir_all(&base).unwrap();
    }

    /// 整棵删时，列完之后目录里又冒出条目（W6 r11 的全量里 `pinned_directories_cannot_be_swapped_mid_run` 收尾时
    /// 「目录不是空的」）：删自己之前再清一次，照样删掉。只删空目录的 `remove` 不清：冒出来的条目原样留下、报错。
    #[test]
    fn a_tree_removal_clears_what_appears_after_it_was_listed() {
        let base = scratch("pin-late-entry");
        let outer = open(&base).unwrap();
        let mine = create(&outer, OsStr::new("mine")).unwrap();
        std::fs::write(mine.path().join("first"), b"x").unwrap();
        super::AFTER_CLEAR.with(|h| {
            *h.borrow_mut() = Some(Box::new(|dir: &Path| {
                std::fs::write(dir.join("late"), b"x").unwrap()
            }))
        });
        mine.remove_tree().unwrap();
        assert!(!base.join("mine").exists());
        let strict = create(&outer, OsStr::new("strict")).unwrap();
        std::fs::write(strict.path().join("late"), b"x").unwrap();
        assert!(strict.remove().is_err());
        assert!(base.join("strict").join("late").is_file());
        drop(outer);
        std::fs::remove_dir_all(&base).unwrap();
    }

    /// W3 r3 P1-R3-01：`remove` 只删空目录，不认识的条目（目录、文件、junction）原样留下，删除失败；
    /// 文件按新建时的身份删，被换过就留下。
    #[test]
    fn remove_leaves_what_it_did_not_create() {
        let base = scratch("pin-remove");
        let outer = open(&base).unwrap();
        let mine = create(&outer, OsStr::new("mine")).unwrap();
        let foreign = base.join("mine").join("foreign");
        std::fs::create_dir(&foreign).unwrap();
        std::fs::write(foreign.join("business.txt"), b"keep").unwrap();
        let mine = match mine.remove() {
            Ok(()) => panic!("a directory with foreign entries was removed"),
            Err(_) => open(&base.join("mine")).unwrap(),
        };
        assert_eq!(
            std::fs::read(foreign.join("business.txt")).unwrap(),
            b"keep"
        );
        drop(mine);
        std::fs::remove_dir_all(&foreign).unwrap();

        let mine = create(&outer, OsStr::new("mine2")).unwrap();
        let (f, kept) = create_file(&mine, OsStr::new("a")).unwrap();
        drop(f);
        let (f, swapped) = create_file(&mine, OsStr::new("b")).unwrap();
        drop(f);
        assert!(
            create_file(&mine, OsStr::new("a")).is_err(),
            "names are exclusive"
        );
        assert!(create_file(&mine, OsStr::new("x/y")).is_err());
        std::fs::remove_file(mine.path().join("b")).unwrap();
        std::fs::write(mine.path().join("b"), b"theirs").unwrap();
        remove_file(kept).unwrap();
        let e = remove_file(swapped).unwrap_err();
        assert!(e.to_string().contains("was replaced"), "{e}");
        assert_eq!(std::fs::read(mine.path().join("b")).unwrap(), b"theirs");
        assert!(!mine.path().join("a").exists());
        std::fs::remove_file(mine.path().join("b")).unwrap();
        mine.remove().unwrap();
        assert!(!base.join("mine2").exists());

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
