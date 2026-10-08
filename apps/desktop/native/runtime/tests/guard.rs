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

fn junction(link: &Path, target: &Path) {
    let made = Command::new("cmd")
        .args(["/c", "mklink", "/J", &s(link), &s(target)])
        .stdout(Stdio::null())
        .status()
        .unwrap();
    assert!(made.success(), "mklink /J {}", link.display());
}

/// 文件的内容（目录与链接本身记空），用来确认受保护的树逐字节没变。
fn contents(root: &Path) -> Vec<(String, bool, Vec<u8>)> {
    listing(root)
        .into_iter()
        .map(|(rel, is_dir, _)| {
            let p = root.join(&rel);
            let file = std::fs::symlink_metadata(&p).unwrap().is_file();
            let bytes = if file {
                std::fs::read(&p).unwrap()
            } else {
                Vec::new()
            };
            (rel, is_dir, bytes)
        })
        .collect()
}

/// W4i peer r2 P1-01：参数根本身安全，但根里已有的目录或文件是链接时，写入会经它离开比较过的位置
/// （`N\runtime` 是指向 3.x 根的 junction，准入锁、lease、descriptor 就落进 3.x 根）。三个根里已有的树
/// 有任何 junction 或硬链接都拒绝，指向哪里都一样；拒绝在任何写入之前，受保护的树逐字节不变。
#[test]
fn links_inside_a_given_root_are_refused_before_any_write() {
    let d = dir("guard-links");
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
    let elsewhere = d.join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();

    // (说明, 被检查的参数, 布局)：布局在一个新建的根里造出链接，返回 (N, L, 安装根)。
    type Layout = Box<dyn Fn(&Path) -> (PathBuf, PathBuf, Option<PathBuf>)>;
    let (v2c, v3c, installc, elsewherec) =
        (v2.clone(), v3.clone(), install.clone(), elsewhere.clone());
    let cases: Vec<(&str, Layout)> = vec![
        (
            "N\\runtime is a junction to the 3.x root",
            Box::new(move |c: &Path| {
                let n = c.join("N");
                std::fs::create_dir_all(&n).unwrap();
                junction(&n.join("runtime"), &v3c);
                (n, c.join("L"), None)
            }),
        ),
        (
            "a directory deep in N is a junction to an unprotected place",
            Box::new(move |c: &Path| {
                let n = c.join("N");
                std::fs::create_dir_all(n.join("data").join("projects")).unwrap();
                junction(&n.join("data").join("projects").join("p1"), &elsewherec);
                (n, c.join("L"), None)
            }),
        ),
        (
            "a file in N is a hard link to a file in the 3.x root",
            Box::new({
                let v3c = v3.clone();
                move |c: &Path| {
                    let n = c.join("N");
                    std::fs::create_dir_all(n.join("data")).unwrap();
                    std::fs::hard_link(
                        v3c.join("data").join("marker"),
                        n.join("data").join("atm.db"),
                    )
                    .unwrap();
                    (n, c.join("L"), None)
                }
            }),
        ),
        (
            "N is itself a junction, and its runtime one to the 3.x root",
            Box::new({
                let v3c = v3.clone();
                move |c: &Path| {
                    let real = c.join("real-N");
                    std::fs::create_dir_all(&real).unwrap();
                    junction(&real.join("runtime"), &v3c);
                    let n = c.join("N");
                    junction(&n, &real);
                    (n, c.join("L"), None)
                }
            }),
        ),
        (
            "L\\data is a junction to the 2.x root",
            Box::new(move |c: &Path| {
                let l = c.join("L");
                std::fs::create_dir_all(&l).unwrap();
                junction(&l.join("data"), &v2c.join("data"));
                (c.join("N"), l, None)
            }),
        ),
        (
            "the install root's state is a junction to the install root",
            Box::new(move |c: &Path| {
                let i = c.join("install");
                std::fs::create_dir_all(&i).unwrap();
                junction(&i.join("state"), &installc);
                (c.join("N"), c.join("L"), Some(i))
            }),
        ),
    ];
    let before = contents(&local);
    for (i, (case, layout)) in cases.iter().enumerate() {
        let c = d.join(format!("case{i}"));
        std::fs::create_dir_all(&c).unwrap();
        let (n, l, install_root) = layout(&c);
        let mut args = vec!["--n".into(), s(&n), "--legacy".into(), s(&l)];
        if let Some(i) = &install_root {
            args.extend([
                "--txn-start".into(),
                "T1".into(),
                "--install-root".into(),
                s(i),
            ]);
        }
        let inside = contents(&c);
        let (code, stderr) = run(&local, &args, &[]);
        assert_eq!(code, Some(2), "{case}: {stderr}");
        assert!(stderr.contains("refusing"), "{case}: {stderr}");
        assert_eq!(contents(&c), inside, "{case}: a refused start wrote");
    }
    assert_eq!(contents(&local), before, "a protected tree changed");
    assert!(std::fs::read_dir(&elsewhere).unwrap().next().is_none());
}
