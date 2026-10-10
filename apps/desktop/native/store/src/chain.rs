//! 数据根里的目录链（peer W6 r2 P1-01、r3 P1-01）：删除、解包、复制、换入之前，把要碰的目录从数据根往下逐层
//! 钉住，每一层都必须是上一层里真实的子目录，不能是链接（junction、符号链接等 reparse point）。
//!
//! 不变量是「ATM 写入、删除的位置都在数据根的真实位置里面」：
//! - 数据根本身按链接打开（它以上的链接，比如用户把 AppData 挪到别的盘再链回来，只是把整个数据根搬了地方，
//!   里面的东西仍是这个数据根的；一律拒绝的话这类用户就再也导出、备份不了）；
//! - 数据根往下的每一层：钉住后句柄的最终路径（不含任何链接）必须等于「上一层的最终路径 + 这一层的名字」。
//!   哪一层是链接，最终路径就会落到别处，拒绝，此时还没有任何副作用；
//! - **之后的读写一律从数据根的真实位置拼路径**（[`Pinned::real`]），不再经过调用方给的字面路径：字面路径上
//!   数据根以上的链接在操作中途可以被换掉（r3 复现 A），真实位置不能——钉住的句柄不给 `FILE_SHARE_DELETE`
//!   （见 [`crate::pin`]），持有期间这些目录和它们的每一层祖先都改不了名、删不掉；
//! - 还不存在的层用 [`Pinned::ensure`] 相对上一层的句柄排他新建，建出来就是钉住的（r3 复现 B：先按路径建、
//!   之后才钉，中间可以被换成链接）。
//!
//! - 钉的时候还不存在的层，之后可能被别人建出来（甚至建成链接，peer W6 r4 P1-01）。要枚举、读标记、删除或改名
//!   某个位置，先用 [`Pinned::existing`] 重新钉一次：新出现的层照样逐层核对、钉住，是链接就拒绝；整条链都钉住了
//!   才给出真实位置，否则说明这次操作里它不存在，跳过。不能拿 [`Pinned::real`] 拼出来的路径直接去枚举、删除。
//!
//! 内部读写一律用句柄给出的 `\\?\` 完整写法（peer W6 r4 P2-01）：普通写法下超过 MAX_PATH 的路径打不开，
//! 尾点、尾空格、保留设备名（`CON.txt`）也会被系统改写成别的名字。
//!
//! [`Pinned`] 要一直拿到操作结束（包括失败后的回滚与清理）。操作要删掉或改名的那一层先 [`Pinned::release`]：
//! 放开以后它若被换成链接，`remove_dir_all`、改名作用的都是链接本身，碰不到链接目标里的东西。
//! 钉住的层里面由 ATM 自己新建的子目录按路径读写（与 REPORT.md「目录身份」的边界相同）。同一个边界：防的是
//! 路径与祖先在检查之后被改名、换成链接（同步工具、脚本、并发操作）；有意构造 `FSCTL_SET_REPARSE_POINT` 把一个
//! 钉住的空目录原地变成链接，属于同一用户下有意篡改的进程，它本来就能直接写数据根，不在防护范围。
//! `pin_existing` 遇到不存在的层就停在那里，是普通文件的那层也一样（文件不是链接，挡不挡路由后面的操作照原样报错，
//! 比如恢复把 `.restore-old` 当目录用时）。

use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

use crate::pin::{self, Dir};

/// 钉住的数据根与它下面的若干层：持有期间链不变。
pub(crate) struct Pinned {
    /// 数据根的真实位置：句柄的最终路径，`\\?\` 完整写法。
    root: PathBuf,
    /// 调用方给的数据根：只用于报错，不用于读写。
    literal: PathBuf,
    /// (相对数据根的路径，小写、以 `\` 连接；钉住的目录)。第一项是数据根本身（空路径）。
    dirs: Vec<(String, Dir)>,
}

#[derive(Debug)]
pub(crate) enum ChainError {
    /// 这一层是链接（或换成了数据根外面的东西）。
    Linked(PathBuf),
    /// 数据根本身不是目录。
    NotADirectory(PathBuf),
    Io(std::io::Error),
}

fn same_name(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

fn invalid(rel: &Path) -> ChainError {
    ChainError::Io(std::io::Error::new(
        std::io::ErrorKind::InvalidInput,
        format!("{} is not a plain relative path", rel.display()),
    ))
}

/// 相对路径的每一段，只能是普通名字（不能有 `..`、盘符、根）。
fn names(rel: &Path) -> Result<Vec<&OsStr>, ChainError> {
    rel.components()
        .map(|c| match c {
            Component::Normal(n) => Ok(n),
            _ => Err(invalid(rel)),
        })
        .collect()
}

fn key(names: &[&OsStr]) -> String {
    names
        .iter()
        .map(|n| n.to_string_lossy().to_lowercase())
        .collect::<Vec<_>>()
        .join("\\")
}

impl Pinned {
    /// 钉住数据根（跟随链接）。
    pub(crate) fn open(root: &Path) -> Result<Self, ChainError> {
        let top = pin::open(root).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotADirectory => ChainError::NotADirectory(root.to_path_buf()),
            _ => ChainError::Io(e),
        })?;
        Ok(Self {
            root: top.path().to_path_buf(),
            literal: root.to_path_buf(),
            dirs: vec![(String::new(), top)],
        })
    }

    /// 数据根的真实位置。
    #[cfg(test)]
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    /// `rel` 在数据根真实位置里的路径（不论钉没钉住、存不存在）。
    pub(crate) fn real(&self, rel: &Path) -> PathBuf {
        let mut p = self.root.clone();
        for c in rel.components() {
            p.push(c.as_os_str());
        }
        p
    }

    fn index(&self, k: &str) -> Option<usize> {
        self.dirs.iter().position(|(d, _)| d == k)
    }

    /// 钉住 `rel` 上已经存在的各层；遇到不存在或是普通文件的那层就停下。
    pub(crate) fn pin_existing(&mut self, rel: &Path) -> Result<(), ChainError> {
        self.walk(rel, false)
    }

    /// `rel` 的每一层现在都钉住了吗（不存在的层、是普通文件的层都不算）。
    fn complete(&self, rel: &Path) -> bool {
        let Ok(names) = names(rel) else {
            return false;
        };
        (1..=names.len()).all(|depth| self.index(&key(&names[..depth])).is_some())
    }

    /// 要枚举、读、删或改名 `rel` 之前用（peer W6 r4 P1-01）：再钉一次 `rel` 上已经存在的各层——取得守卫之后才
    /// 出现的层也照样核对，是链接就拒绝（[`ChainError::Linked`]）。整条链都钉住时返回真实位置；还缺某一层
    /// （不存在，或是普通文件）时返回 `None`：这次操作里它不存在。
    pub(crate) fn existing(&mut self, rel: &Path) -> Result<Option<PathBuf>, ChainError> {
        self.walk(rel, false)?;
        Ok(self.complete(rel).then(|| self.real(rel)))
    }

    /// 钉住 `rel` 的每一层，不存在的相对上一层的句柄排他新建（建出来就是钉住的）。返回真实路径。
    pub(crate) fn ensure(&mut self, rel: &Path) -> Result<PathBuf, ChainError> {
        self.walk(rel, true)?;
        Ok(self.real(rel))
    }

    fn walk(&mut self, rel: &Path, create: bool) -> Result<(), ChainError> {
        let names = names(rel)?;
        let mut parent = 0;
        for depth in 1..=names.len() {
            let k = key(&names[..depth]);
            if let Some(i) = self.index(&k) {
                parent = i;
                continue;
            }
            let name = names[depth - 1];
            let lexical = self.real(&names[..depth].iter().collect::<PathBuf>());
            let dir = match std::fs::symlink_metadata(&lexical) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    if !create {
                        return Ok(());
                    }
                    match pin::create(&self.dirs[parent].1, name) {
                        Ok(d) => d,
                        // 刚好被别人建了：按已存在的核对。
                        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                            self.open_checked(&names[..depth], parent, None)?
                        }
                        Err(e) => return Err(ChainError::Io(e)),
                    }
                }
                Err(e) => return Err(ChainError::Io(e)),
                Ok(m) if !m.is_dir() && !m.file_type().is_symlink() && !is_reparse(&m) => {
                    if !create {
                        return Ok(());
                    }
                    return Err(ChainError::Io(std::io::Error::new(
                        std::io::ErrorKind::NotADirectory,
                        format!("{} is not a directory", lexical.display()),
                    )));
                }
                Ok(m) => self.open_checked(&names[..depth], parent, Some(&m))?,
            };
            self.dirs.push((k, dir));
            parent = self.dirs.len() - 1;
        }
        Ok(())
    }

    /// 打开已有的一层并核对：最终路径必须是上一层的最终路径加这一层的名字。
    fn open_checked(
        &self,
        names: &[&OsStr],
        parent: usize,
        meta: Option<&std::fs::Metadata>,
    ) -> Result<Dir, ChainError> {
        let rel: PathBuf = names.iter().collect();
        let lexical = self.real(&rel);
        let linked = || ChainError::Linked(self.literal.join(&rel));
        let dir = match pin::open(&lexical) {
            Ok(d) => d,
            // 指向不存在的目标的链接、指向文件的链接：都是链接。
            Err(_) if meta.is_none_or(|m| m.file_type().is_symlink() || is_reparse(m)) => {
                return Err(linked());
            }
            Err(e) => return Err(ChainError::Io(e)),
        };
        let expected = self.dirs[parent].1.path().join(names[names.len() - 1]);
        if !same_name(dir.path(), &expected) {
            return Err(linked());
        }
        Ok(dir)
    }

    /// 钉住的 `rel` 这一层的句柄；没钉住时 `None`。
    pub(crate) fn dir(&self, rel: &Path) -> Option<&Dir> {
        let i = self.index(&key(&names(rel).ok()?))?;
        Some(&self.dirs[i].1)
    }

    /// 在已钉住的 `parent` 里排他新建 `name`，钉住交给调用方（导出暂存、恢复暂存这类用完要删或改名的目录）。
    /// 调用方删它、改它的名之前先放开（drop）。
    pub(crate) fn create_owned(&self, parent: &Path, name: &OsStr) -> Result<Dir, ChainError> {
        let i = self
            .index(&key(&names(parent)?))
            .ok_or_else(|| invalid(parent))?;
        pin::create(&self.dirs[i].1, name).map_err(ChainError::Io)
    }

    /// 放开 `rel` 以及它下面钉住的层（接下来要删掉或改名它们）。
    pub(crate) fn release(&mut self, rel: &Path) {
        let Ok(names) = names(rel) else {
            return;
        };
        let k = key(&names);
        let below = format!("{k}\\");
        self.dirs
            .retain(|(d, _)| d.is_empty() || !(*d == k || d.starts_with(&below)));
    }
}

/// 钉住 `root`（跟随链接），再对 `rels` 里的每个相对路径从 `root` 往下钉住已经存在的各层、逐层核对。
pub(crate) fn pin_inside(root: &Path, rels: &[&Path]) -> Result<Pinned, ChainError> {
    let mut pinned = Pinned::open(root)?;
    for rel in rels {
        pinned.pin_existing(rel)?;
    }
    Ok(pinned)
}

#[cfg(windows)]
fn is_reparse(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    meta.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse(_meta: &std::fs::Metadata) -> bool {
    false
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn junction(link: &Path, target: &Path) {
        let ok = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap()
            .success();
        assert!(ok, "mklink /J {}", link.display());
    }

    /// 与 pin.rs 的单元测试一样放在 target 下，不进 %TEMP%。
    fn scratch(name: &str) -> PathBuf {
        let d = std::env::var_os("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .unwrap()
                    .join("target")
            })
            .join("store-unit")
            .join(format!("chain-{name}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn links_below_the_root_are_refused_and_links_above_it_are_not() {
        let d = scratch("links");
        let real = d.join("real");
        std::fs::create_dir_all(real.join("N").join("exports").join(".staging")).unwrap();
        let outside = d.join("outside");
        std::fs::create_dir_all(&outside).unwrap();

        // 数据根以上是链接：整个数据根搬了地方，照常钉住。
        let moved = d.join("moved");
        junction(&moved, &real);
        let n = moved.join("N");
        assert!(pin_inside(&n, &[Path::new("exports/.staging")]).is_ok());

        // 数据根下面的任何一层是链接：拒绝，报那一层。
        let link = real.join("N").join("artifacts");
        junction(&link, &outside);
        match pin_inside(&n, &[Path::new("artifacts/.restore-staging")]) {
            Err(ChainError::Linked(p)) => assert_eq!(p, n.join("artifacts")),
            other => panic!("{:?}", other.err()),
        }
        let deep = real.join("N").join("exports").join(".staging").join("x");
        junction(&deep, &outside);
        assert!(matches!(
            pin_inside(&n, &[Path::new("exports/.staging/x")]),
            Err(ChainError::Linked(_))
        ));
        // 不存在的一层停在那里，不报错。
        assert!(pin_inside(&n, &[Path::new("exports/none/deeper")]).is_ok());
        // 是普通文件：不是链接，停在那一层（后面的操作照原样报错）。
        std::fs::write(real.join("N").join("file"), b"x").unwrap();
        assert!(pin_inside(&n, &[Path::new("file/below")]).is_ok());
        // 数据根本身是文件：不是目录。
        assert!(matches!(
            pin_inside(&real.join("N").join("file"), &[]),
            Err(ChainError::NotADirectory(_))
        ));
        // 悬空链接也是链接。
        let dangling = real.join("N").join("dangling");
        junction(&dangling, &d.join("gone"));
        assert!(matches!(
            pin_inside(&n, &[Path::new("dangling")]),
            Err(ChainError::Linked(_))
        ));

        for l in [&deep, &link, &dangling, &moved] {
            std::fs::remove_dir(l).unwrap();
        }
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_pinned_chain_cannot_be_renamed_away() {
        let d = scratch("rename");
        std::fs::create_dir_all(d.join("N").join("artifacts")).unwrap();
        let pinned = pin_inside(&d.join("N"), &[Path::new("artifacts")]).unwrap();
        // 钉住期间换不掉这一层，也换不掉它的上一层。
        assert!(std::fs::rename(d.join("N").join("artifacts"), d.join("N").join("moved")).is_err());
        assert!(std::fs::rename(d.join("N"), d.join("M")).is_err());
        // 钉住的目录里面照常可以建、删、改名（导出暂存、附件换入都在里面做）。
        let child = d.join("N").join("artifacts").join("child");
        std::fs::create_dir_all(child.join("deep")).unwrap();
        std::fs::write(child.join("deep").join("f"), b"x").unwrap();
        std::fs::rename(&child, d.join("N").join("artifacts").join("child2")).unwrap();
        std::fs::remove_dir_all(d.join("N").join("artifacts").join("child2")).unwrap();
        drop(pinned);
        std::fs::rename(d.join("N").join("artifacts"), d.join("N").join("moved")).unwrap();
        std::fs::remove_dir_all(&d).unwrap();
    }

    /// r3 复现 A：钉住之后把数据根以上的 junction 换成指向别处的，经真实路径的读写仍落在原来的数据根里。
    #[test]
    fn io_through_the_real_root_ignores_a_swapped_upper_link() {
        let d = scratch("upper-swap");
        let real = d.join("real");
        let other = d.join("other");
        for t in [&real, &other] {
            std::fs::create_dir_all(t.join("N").join("exports").join(".staging")).unwrap();
        }
        std::fs::write(
            other
                .join("N")
                .join("exports")
                .join(".staging")
                .join("keep.txt"),
            b"keep",
        )
        .unwrap();
        let alias = d.join("alias");
        junction(&alias, &real);
        let staging = Path::new("exports/.staging");
        let pinned = pin_inside(&alias.join("N"), &[staging]).unwrap();
        // 真实位置是 `\\?\` 完整写法，不经过 alias。
        let shown = pinned.root().to_string_lossy().into_owned();
        let plain = Path::new(shown.strip_prefix(r"\\?\").unwrap());
        assert!(!plain.starts_with(&alias), "{shown}");
        assert!(same_name(plain, &real.join("N")), "{shown}");

        // 链接本身没被钉住，换得掉。
        std::fs::rename(&alias, d.join("alias-old")).unwrap();
        junction(&alias, &other);
        std::fs::write(pinned.real(staging).join("ours.txt"), b"ours").unwrap();
        assert!(real.join("N/exports/.staging/ours.txt").is_file());
        assert!(!other.join("N/exports/.staging/ours.txt").exists());
        // 删的也是真实位置里的东西。
        std::fs::remove_file(pinned.real(staging).join("ours.txt")).unwrap();
        assert_eq!(
            std::fs::read(other.join("N/exports/.staging/keep.txt")).unwrap(),
            b"keep"
        );
        drop(pinned);
        for l in [&alias, &d.join("alias-old")] {
            std::fs::remove_dir(l).unwrap();
        }
        std::fs::remove_dir_all(&d).unwrap();
    }

    /// r3 复现 B：钉住时还不存在的层由 `ensure` 相对父句柄建出来，一直钉着，换不成链接。
    #[test]
    fn missing_layers_are_created_pinned_and_released_on_demand() {
        let d = scratch("ensure");
        std::fs::create_dir_all(d.join("N")).unwrap();
        let mut pinned =
            pin_inside(&d.join("N"), &[Path::new("artifacts/.restore-staging")]).unwrap();
        assert!(!d.join("N/artifacts").exists());
        let made = pinned
            .ensure(Path::new("artifacts/.restore-staging"))
            .unwrap();
        assert!(made.is_dir());
        assert!(std::fs::rename(d.join("N/artifacts"), d.join("N/moved")).is_err());
        assert!(std::fs::rename(&made, d.join("N/artifacts/moved")).is_err());
        // 已钉住的层再 ensure 一次不变。
        assert_eq!(
            pinned.ensure(Path::new("artifacts")).unwrap(),
            pinned.real(Path::new("artifacts"))
        );

        // 交给调用方的目录：钉着时改不了名，放开以后可以。
        let owned = pinned
            .create_owned(Path::new("artifacts/.restore-staging"), OsStr::new("P1"))
            .unwrap();
        let p1 = made.join("P1");
        std::fs::write(p1.join("f"), b"x").unwrap();
        assert!(std::fs::rename(&p1, made.join("P2")).is_err());
        drop(owned);
        std::fs::rename(&p1, made.join("P2")).unwrap();
        // 已存在的名字不能排他新建。
        assert!(
            pinned
                .create_owned(Path::new("artifacts/.restore-staging"), OsStr::new("P2"))
                .is_err()
        );

        // 放开 `.restore-staging` 以后它可以改名，`artifacts` 仍钉着。
        pinned.release(Path::new("artifacts/.restore-staging"));
        std::fs::rename(&made, d.join("N/artifacts/renamed")).unwrap();
        assert!(std::fs::rename(d.join("N/artifacts"), d.join("N/moved")).is_err());
        drop(pinned);
        std::fs::remove_dir_all(&d).unwrap();
    }

    /// `ensure` 遇到已经存在的链接照样拒绝，什么都不建；遇到普通文件报不是目录。
    #[test]
    fn ensure_refuses_links_and_files() {
        let d = scratch("ensure-links");
        std::fs::create_dir_all(d.join("N")).unwrap();
        let outside = d.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let link = d.join("N").join("artifacts");
        junction(&link, &outside);
        let mut pinned = Pinned::open(&d.join("N")).unwrap();
        assert!(matches!(
            pinned.ensure(Path::new("artifacts/.restore-old")),
            Err(ChainError::Linked(_))
        ));
        assert!(std::fs::read_dir(&outside).unwrap().next().is_none());
        std::fs::write(d.join("N/file"), b"x").unwrap();
        assert!(matches!(
            pinned.ensure(Path::new("file/below")),
            Err(ChainError::Io(e)) if e.kind() == std::io::ErrorKind::NotADirectory
        ));
        assert!(matches!(
            pinned.ensure(Path::new("../x")),
            Err(ChainError::Io(_))
        ));
        drop(pinned);
        std::fs::remove_dir(&link).unwrap();
        std::fs::remove_dir_all(&d).unwrap();
    }

    /// peer W6 r4 P1-01：钉的时候不存在的层，之后被建成链接，`existing` 拒绝；建成普通目录就钉住它；
    /// 原先是普通文件、后来换成目录的也一样钉住。
    #[test]
    fn layers_that_appear_after_pinning_are_checked_before_use() {
        let d = scratch("late");
        std::fs::create_dir_all(d.join("N")).unwrap();
        let outside = d.join("outside");
        std::fs::create_dir_all(outside.join(".withdrawn")).unwrap();
        let mut pinned = pin_inside(&d.join("N"), &[Path::new("backups/.withdrawn")]).unwrap();
        let rel = Path::new("backups/.withdrawn");
        assert!(pinned.existing(rel).unwrap().is_none());
        // 守卫拿到之后才出现、而且是链接：拒绝，什么都不给。
        junction(&d.join("N").join("backups"), &outside);
        assert!(matches!(pinned.existing(rel), Err(ChainError::Linked(_))));
        std::fs::remove_dir(d.join("N").join("backups")).unwrap();
        // 出现的是普通目录：钉住，此后改不了名。
        std::fs::create_dir_all(d.join("N").join("backups").join(".withdrawn")).unwrap();
        assert_eq!(pinned.existing(rel).unwrap(), Some(pinned.real(rel)));
        assert!(std::fs::rename(d.join("N").join("backups"), d.join("N").join("moved")).is_err());
        // 普通文件那一层不算存在；换成目录之后钉住。
        let below = Path::new("file/below");
        std::fs::write(d.join("N").join("file"), b"x").unwrap();
        assert!(pinned.existing(below).unwrap().is_none());
        std::fs::remove_file(d.join("N").join("file")).unwrap();
        std::fs::create_dir_all(d.join("N").join("file").join("below")).unwrap();
        assert!(pinned.existing(below).unwrap().is_some());
        assert!(std::fs::rename(d.join("N").join("file"), d.join("N").join("file2")).is_err());
        drop(pinned);
        std::fs::remove_dir_all(&d).unwrap();
    }

    /// peer W6 r4 P2-01：内部路径保留 `\\?\`：超过 MAX_PATH 的数据根，以及尾点、尾空格、保留设备名的数据根，
    /// 都能照常钉住已有的层、新建缺的层、读写。
    #[test]
    fn long_and_special_roots_keep_working() {
        let d = scratch("long");
        let parent = pin::open(&d).unwrap();
        for name in ["ending.", "ending ", "CON.txt"] {
            let own = pin::create(&parent, OsStr::new(name)).unwrap();
            let mut guarded = Pinned::open(own.path()).unwrap();
            assert!(guarded.root().to_string_lossy().starts_with(r"\\?\"));
            let p = guarded.ensure(Path::new("exports/.staging")).unwrap();
            std::fs::write(p.join("ok.txt"), b"ours").unwrap();
            let back = own.path().join("exports").join(".staging").join("ok.txt");
            assert_eq!(std::fs::read(back).unwrap(), b"ours");
        }
        let mut long = parent.path().to_path_buf();
        for _ in 0..14 {
            long.push("long-name-1234567890");
        }
        std::fs::create_dir_all(long.join("exports").join(".staging")).unwrap();
        assert!(long.as_os_str().len() > 300);
        let mut guarded = Pinned::open(&long).unwrap();
        let p = guarded.ensure(Path::new("exports/.staging")).unwrap();
        std::fs::write(p.join("ok.txt"), b"ours").unwrap();
        let fresh = guarded.ensure(Path::new("exports/new/deeper")).unwrap();
        std::fs::write(fresh.join("f"), b"x").unwrap();
        // 别处按 `/` 分隔的相对路径（附件清单）直接 `join` 到真实位置上：Rust 遇到 `\\?\` 前缀会把 `/` 归一成 `\`。
        std::fs::create_dir(p.join("sub")).unwrap();
        std::fs::write(p.join("sub/inner.txt"), b"nested").unwrap();
        let nested = long
            .join("exports")
            .join(".staging")
            .join("sub")
            .join("inner.txt");
        assert_eq!(std::fs::read(nested).unwrap(), b"nested");
        let back = long.join("exports").join(".staging").join("ok.txt");
        assert_eq!(std::fs::read(back).unwrap(), b"ours");
        drop(guarded);
        let verbatim = parent.path().to_path_buf();
        drop(parent);
        std::fs::remove_dir_all(verbatim).unwrap();
    }
}
