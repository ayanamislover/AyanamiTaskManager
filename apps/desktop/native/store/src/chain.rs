//! 数据根里的目录链（peer W6 r2 P1-01）：删除、解包、复制、换入之前，把要碰的目录从数据根往下逐层钉住，
//! 每一层都必须是上一层里真实的子目录，不能是链接（junction、符号链接等 reparse point）。
//!
//! 不变量是「ATM 写入、删除的位置都在数据根的真实位置里面」：
//! - 数据根本身按链接打开（它以上的链接，比如用户把 AppData 挪到别的盘再链回来，只是把整个数据根搬了地方，
//!   里面的东西仍是这个数据根的；一律拒绝的话这类用户就再也导出、备份不了）；
//! - 数据根往下的每一层：钉住后句柄的最终路径（不含任何链接）必须等于「上一层的最终路径 + 这一层的名字」。
//!   哪一层是链接，最终路径就会落到别处，拒绝，此时还没有任何副作用。
//!
//! 钉住的句柄不给 `FILE_SHARE_DELETE`（见 [`crate::pin`]）：持有期间这些目录和它们的祖先都改不了名、删不掉，
//! 所以检查之后到操作结束，链不会被换成别的。[`Pinned`] 要一直拿到操作结束。
//! 还不存在的那层不钉（之后由 ATM 自己按路径新建），从那层起的下面也不再看；是普通文件的那层也一样
//! （文件不是链接，挡不挡路由后面的操作照原样报错，比如恢复把 `.restore-old` 当目录用时）。

use std::path::{Component, Path, PathBuf};

use crate::pin::{self, Dir};

/// 钉住的一串目录：持有期间链不变。
pub(crate) struct Pinned {
    #[allow(dead_code)]
    dirs: Vec<Dir>,
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

/// 钉住 `root`（跟随链接），再对 `rels` 里的每个相对路径从 `root` 往下逐层钉住、核对。`rels` 只能由普通的名字
/// 组成（不能有 `..`、盘符、根）。
pub(crate) fn pin_inside(root: &Path, rels: &[&Path]) -> Result<Pinned, ChainError> {
    let top = pin::open(root).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotADirectory => ChainError::NotADirectory(root.to_path_buf()),
        _ => ChainError::Io(e),
    })?;
    let mut dirs = vec![top];
    for rel in rels {
        let mut lexical = root.to_path_buf();
        let mut parent_final = dirs[0].path().to_path_buf();
        for c in rel.components() {
            let Component::Normal(name) = c else {
                return Err(ChainError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("{} is not a plain relative path", rel.display()),
                )));
            };
            lexical.push(name);
            let meta = match std::fs::symlink_metadata(&lexical) {
                Ok(m) => m,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                Err(e) => return Err(ChainError::Io(e)),
            };
            if !meta.is_dir() && !meta.file_type().is_symlink() && !is_reparse(&meta) {
                break;
            }
            let dir = match pin::open(&lexical) {
                Ok(d) => d,
                // 指向不存在的目标的链接、指向文件的链接：都是链接。
                Err(_) if meta.file_type().is_symlink() || is_reparse(&meta) => {
                    return Err(ChainError::Linked(lexical));
                }
                Err(e) => return Err(ChainError::Io(e)),
            };
            let expected = parent_final.join(name);
            if !same_name(dir.path(), &expected) {
                return Err(ChainError::Linked(lexical));
            }
            parent_final = dir.path().to_path_buf();
            dirs.push(dir);
        }
    }
    Ok(Pinned { dirs })
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
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
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
}
