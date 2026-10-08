//! 开发二进制的真实根守卫（W4i peer r1 P1-01）：开发二进制不碰真实数据。
//!
//! 受保护的根固定列出，不因环境变量的覆盖而取消：2.x 与 3.x 的默认数据根、默认安装根，以及
//! `ATM_DATA_DIR`、`AYANAMI_TASK_DATA_DIR`、`ATM3_DATA_DIR` 指向的根（它们指向的同样是真实数据）。
//! 比较的是真实位置：最近一个存在的祖先经 `canonicalize` 解开 junction、符号链接、`\\?\` 扩展前缀与短名，
//! 再接上还不存在的部分。任一方向的包含都算重叠。给出的几个根彼此也不能重叠：N 落在 L 里，写 N 就动了源数据。

use std::path::{Component, Path, PathBuf};

/// 受保护的根：(名字, 路径)。
pub fn protected_roots() -> Vec<(String, PathBuf)> {
    let env = |name: &str| {
        std::env::var_os(name)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    let mut roots = Vec::new();
    if let Some(local) = env("LOCALAPPDATA") {
        roots.push(("the 2.x data root".into(), local.join("AyanamiTaskManager")));
        roots.push((
            "the 3.x data root".into(),
            local.join(atm_install_state::startup::V3_DIR_NAME),
        ));
        roots.push((
            "the install root".into(),
            local.join("AyanamiTaskManagerDesktop"),
        ));
    }
    for name in ["ATM_DATA_DIR", "AYANAMI_TASK_DATA_DIR", "ATM3_DATA_DIR"] {
        if let Some(p) = env(name) {
            roots.push((format!("the data root {name} points to"), p));
        }
    }
    roots
}

/// `p` 的真实位置：最近一个存在的祖先解开 junction、符号链接、扩展前缀与短名后，接上还不存在的部分。
pub fn resolve(p: &Path) -> std::io::Result<PathBuf> {
    let abs = std::path::absolute(p)?;
    let mut rest = Vec::new();
    let mut cur = abs.as_path();
    loop {
        match std::fs::canonicalize(cur) {
            Ok(real) => {
                let mut out = real;
                for part in rest.iter().rev() {
                    out.push(part);
                }
                return Ok(out);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let (Some(name), Some(parent)) = (cur.file_name(), cur.parent()) else {
                    return Err(e);
                };
                rest.push(name.to_os_string());
                cur = parent;
            }
            Err(e) => return Err(e),
        }
    }
}

/// 两个已解开的路径是否一个包含另一个（含相同）。Windows 的路径不分大小写。
pub fn overlaps(a: &Path, b: &Path) -> bool {
    let parts = |p: &Path| -> Vec<String> {
        p.components()
            .filter(|c| !matches!(c, Component::CurDir))
            .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
            .collect()
    };
    let (a, b) = (parts(a), parts(b));
    let n = a.len().min(b.len());
    a[..n] == b[..n]
}

/// 给出的根（(参数名, 路径)）与受保护的根、彼此之间都不重叠时 `Ok`；解不开的路径也拒绝。
pub fn refuse_overlaps(
    given: &[(&str, &Path)],
    protected: &[(String, PathBuf)],
) -> Result<(), String> {
    let real = |p: &Path| -> Result<PathBuf, String> {
        resolve(p).map_err(|e| format!("cannot resolve {}: {e}", p.display()))
    };
    let mut resolved: Vec<(&str, PathBuf)> = Vec::new();
    for (arg, p) in given {
        let r = real(p)?;
        for (name, root) in protected {
            if overlaps(&r, &real(root)?) {
                return Err(format!(
                    "refusing {arg} {}: it overlaps {name}",
                    p.display()
                ));
            }
        }
        for (other, o) in &resolved {
            if overlaps(&r, o) {
                return Err(format!(
                    "refusing {arg} {}: it overlaps {other}",
                    p.display()
                ));
            }
        }
        resolved.push((*arg, r));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlap_is_containment_either_way_ignoring_case() {
        let p = |s: &str| PathBuf::from(s);
        assert!(overlaps(&p(r"C:\A\B"), &p(r"c:\a\b")));
        assert!(overlaps(&p(r"C:\A\B\C"), &p(r"C:\A\B")));
        assert!(overlaps(&p(r"C:\A"), &p(r"C:\A\B")));
        assert!(!overlaps(&p(r"C:\A\B"), &p(r"C:\A\BC")));
        assert!(!overlaps(&p(r"C:\A\B"), &p(r"C:\A\C")));
    }

    #[test]
    fn resolve_keeps_the_missing_tail_under_the_real_ancestor() {
        let base = std::env::temp_dir();
        let real = std::fs::canonicalize(&base).unwrap();
        let r = resolve(&base.join("atm-guard-missing").join("x")).unwrap();
        assert_eq!(r, real.join("atm-guard-missing").join("x"));
        let verbatim = PathBuf::from(format!(
            r"\\?\{}",
            real.display().to_string().trim_start_matches(r"\\?\")
        ));
        assert_eq!(resolve(&verbatim).unwrap(), real);
    }
}
