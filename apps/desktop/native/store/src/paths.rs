//! 项目路径的唯一键（04 L-009、C-L09）。
//!
//! 2.0 的唯一约束落在 realpath 返回的原样字符串上，目录被改过大小写之后会出现两种写法。3.0 的唯一键是
//! `path_key`：去掉末尾的分隔符，再按 Windows 规则做大小写折叠。realpath 由调用方（HTTP / 桥 / 转换器）做，
//! 这里只做纯字符串的部分，所有入口都调用同一个函数，库里的键和查询用的键才不会对不上。

/// 由 realpath 之后的路径得到唯一键。
///
/// 大小写折叠用 Unicode 的小写映射：NTFS 的比较表是按码点做的大写映射，对路径里实际会出现的字符
/// 两者给出相同的等价类。盘符根（`C:\`）保留一个分隔符，否则会变成驱动器相对路径 `c:`。
pub fn path_key(canonical: &str) -> String {
    let trimmed = canonical.trim_end_matches(['\\', '/']);
    let kept = if trimmed.len() == 2 && trimmed.ends_with(':') {
        &canonical[..3.min(canonical.len())]
    } else if trimmed.is_empty() {
        canonical
    } else {
        trimmed
    };
    kept.to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::path_key;

    #[test]
    fn folds_case_and_trailing_separators() {
        assert_eq!(path_key(r"R:\A\Proj\"), r"r:\a\proj");
        assert_eq!(path_key(r"r:\a\proj"), r"r:\a\proj");
        assert_eq!(path_key("R:/a/Proj//"), "r:/a/proj");
        assert_eq!(path_key(r"C:\"), r"c:\");
        assert_eq!(path_key(r"D:\项目\Ä"), r"d:\项目\ä");
    }
}
