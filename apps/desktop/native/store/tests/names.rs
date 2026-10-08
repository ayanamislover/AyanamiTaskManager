//! W4i peer r3 P1-01：拼进 `N\staging\<g>` 的 generation 在动手之前核对。不是单独一层（带 `..`、分隔符、盘符）时，
//! 转换、全新安装与丢弃上一次尝试都在任何写入、删除之前拒绝：N 外面的目录原样不动。

use atm_store::conversion::{self as cv, Layout, RunOptions};
use std::fs;
use std::path::PathBuf;

fn scratch(name: &str) -> PathBuf {
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("target")
        });
    let dir = target.join("store-tests").join(name);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn a_generation_that_is_not_one_name_is_refused_before_any_write() {
    let d = scratch("names-generation");
    let n = d.join("N");
    let layout = Layout::new(&n);
    // `N\staging\..\..\victim` 就是 d\victim：丢弃尝试会删它，转换与全新安装会在它下面建 staging。
    let victim = d.join("victim");
    fs::create_dir_all(&victim).unwrap();
    fs::write(victim.join("keep"), b"outside N").unwrap();
    let bad = [r"..\..\victim", "../../victim", r"C:\victim", "..", "CON"];
    for g in bad {
        let refused = |r: cv::Result<()>| matches!(r, Err(cv::Error::Refused(_)));
        assert!(refused(cv::discard_attempt(&layout, g)), "discard {g}");
        assert!(
            refused(cv::fresh_install(&layout, g, "2026-10-08T00:00:00.000Z").map(|_| ())),
            "fresh {g}"
        );
        let run = cv::run(
            &layout,
            RunOptions {
                at: "2026-10-08T00:00:00.000Z",
                generation: g,
                legacy_root: &d.join("L-missing"),
                allow_real_data_root: false,
                real_data_root: None,
                secrets_check: None,
                accept_unconvertible: &[],
                hook: &mut |_| true,
                progress: None,
            },
        );
        assert!(refused(run.map(|_| ())), "run {g}");
        assert_eq!(fs::read(victim.join("keep")).unwrap(), b"outside N", "{g}");
        assert_eq!(
            fs::read_dir(&victim).unwrap().count(),
            1,
            "{g}: something was created outside N"
        );
        assert!(!n.exists(), "{g}: a refused call wrote into N");
    }
}
