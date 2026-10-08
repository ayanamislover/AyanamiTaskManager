//! 开发二进制的真实根守卫（W4i peer r1 P1-01）：合成的 LOCALAPPDATA 下，受保护的根怎么拼都拒绝，
//! 拒绝发生在任何写入之前（受保护的目录前后一模一样）。正常的沙箱根能起来由 `handoff.rs` 的用例覆盖。

mod support;

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use support::*;

/// 目录下全部条目（相对路径、是不是目录、大小），排好序。
fn listing(root: &Path) -> Vec<(String, bool, u64)> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).unwrap() {
            let e = e.unwrap();
            let meta = std::fs::symlink_metadata(e.path()).unwrap();
            let rel = e.path().strip_prefix(root).unwrap().display().to_string();
            if meta.is_dir() && !meta.file_type().is_symlink() {
                stack.push(e.path());
            }
            out.push((
                rel,
                meta.is_dir(),
                if meta.is_dir() { 0 } else { meta.len() },
            ));
        }
    }
    out.sort();
    out
}

/// 拉起开发二进制：LOCALAPPDATA 换成 `local`，三个数据根的覆盖先清掉再按 `envs` 设。返回退出码与 stderr。
fn run(local: &Path, args: &[String], envs: &[(&str, &Path)]) -> (Option<i32>, String) {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_atm-runtime"));
    cmd.args(args)
        .env("LOCALAPPDATA", local)
        .env_remove("ATM_DATA_DIR")
        .env_remove("AYANAMI_TASK_DATA_DIR")
        .env_remove("ATM3_DATA_DIR")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    while child.try_wait().unwrap().is_none() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    if child.try_wait().unwrap().is_none() {
        // 守卫没拦住：结束自己拉起的这个子进程，再让断言报出来。
        child.kill().unwrap();
    }
    let out = child.wait_with_output().unwrap();
    (
        out.status.code(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

/// (说明, 参数, 环境变量)。
type Case<'a> = (&'a str, Vec<String>, Vec<(&'a str, &'a Path)>);

fn s(p: &Path) -> String {
    p.display().to_string()
}

#[test]
fn every_spelling_of_a_protected_root_is_refused_before_any_write() {
    let d = dir("guard");
    let local = d.join("local");
    let (v2, v3, install) = (
        local.join("AyanamiTaskManager"),
        local.join("AyanamiTaskManager3"),
        local.join("AyanamiTaskManagerDesktop"),
    );
    for root in [&v2, &v3, &install] {
        std::fs::create_dir_all(root.join("data")).unwrap();
        std::fs::write(root.join("data").join("marker"), b"real").unwrap();
    }
    let overridden = d.join("overridden-data");
    std::fs::create_dir_all(&overridden).unwrap();
    std::fs::write(overridden.join("marker"), b"real").unwrap();
    let link = d.join("link-to-3x");
    let made = Command::new("cmd")
        .args(["/c", "mklink", "/J", &s(&link), &s(&v3)])
        .stdout(Stdio::null())
        .status()
        .unwrap();
    assert!(made.success(), "mklink /J");
    let (n, l) = (d.join("N"), d.join("L"));
    let before = (listing(&local), listing(&overridden));

    let plain = |n: &Path, l: &Path| vec!["--n".into(), s(n), "--legacy".into(), s(l)];
    let extended = PathBuf::from(format!(r"\\?\{}", s(&v3)));
    let cases: Vec<Case> = vec![
        ("the 3.x default", plain(&v3, &l), vec![]),
        (
            "the 3.x default while ATM3_DATA_DIR points elsewhere",
            plain(&v3, &l),
            vec![("ATM3_DATA_DIR", &overridden)],
        ),
        (
            "the 3.x default as an extended path",
            plain(&extended, &l),
            vec![],
        ),
        (
            "the 3.x default through a junction",
            plain(&link, &l),
            vec![],
        ),
        (
            "a directory inside the 3.x default",
            plain(&v3.join("sub"), &l),
            vec![],
        ),
        (
            "a directory holding the defaults",
            plain(&local, &l),
            vec![],
        ),
        ("the 2.x default as the source", plain(&n, &v2), vec![]),
        (
            "the ATM_DATA_DIR target as the source",
            plain(&n, &overridden),
            vec![("ATM_DATA_DIR", &overridden)],
        ),
        (
            "the AYANAMI_TASK_DATA_DIR target as the new root",
            plain(&overridden, &l),
            vec![("AYANAMI_TASK_DATA_DIR", &overridden)],
        ),
        (
            "the ATM3_DATA_DIR target as the new root",
            plain(&overridden, &l),
            vec![("ATM3_DATA_DIR", &overridden)],
        ),
        (
            "the new root inside the source",
            plain(&l.join("N"), &l),
            vec![],
        ),
        (
            "the default install root",
            [
                plain(&n, &l),
                vec![
                    "--txn-start".into(),
                    "T1".into(),
                    "--install-root".into(),
                    s(&install),
                ],
            ]
            .concat(),
            vec![],
        ),
    ];
    for (case, args, envs) in &cases {
        let (code, stderr) = run(&local, args, envs);
        assert_eq!(code, Some(2), "{case}: {stderr}");
        assert!(stderr.contains("refusing"), "{case}: {stderr}");
    }
    assert_eq!((listing(&local), listing(&overridden)), before);
    assert!(!n.exists() && !l.exists(), "a refused start created a root");
}
