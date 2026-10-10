//! `migrate --dry-run`（07 §9、06 §6）的 atm.exe 入口：参数交给 [`atm_store::conversion::dry_run`]（转换与核对的
//! 成功路径由 store 的用例覆盖），这里核对入口自己的承诺——只有演练形式、2.x 服务在跑时什么都不做、
//! 输出目录不许落在 3.0 根里、源根与 `N` 一个字节都不变。

mod support;

use std::path::PathBuf;
use support::*;

struct Roots {
    base: PathBuf,
    legacy: PathBuf,
    n: PathBuf,
}

fn roots(name: &str) -> Roots {
    let base = test_dir(name);
    let _ = std::fs::remove_dir_all(&base);
    let legacy = base.join("L");
    let n = base.join("N");
    std::fs::create_dir_all(legacy.join("registry")).unwrap();
    std::fs::write(legacy.join("registry").join("note.txt"), "2.x").unwrap();
    std::fs::create_dir_all(n.join("data")).unwrap();
    std::fs::write(n.join("data").join("keep.txt"), "3.0").unwrap();
    Roots { base, legacy, n }
}

fn run(r: &Roots, args: &[&str]) -> Run {
    atm_with(&r.base, args, &[("ATM3_DATA_DIR", r.n.to_str().unwrap())])
}

#[test]
fn migrate_only_rehearses_and_never_touches_either_root() {
    let r = roots("cli-migrate");
    let (legacy, n) = (tree(&r.legacy), tree(&r.n));
    let source = r.legacy.to_str().unwrap();

    let plain = run(&r, &["migrate", "--source", source, "--out", "out"]);
    assert_eq!(plain.code, 2, "{}", plain.stderr);
    assert!(
        plain.stderr.contains("migrate 只有演练形式"),
        "{}",
        plain.stderr
    );

    // 输出目录在 N 里：拒绝，什么都不建。
    let inside = r.n.join("dry");
    let refused = run(
        &r,
        &[
            "--json",
            "migrate",
            "--dry-run",
            "--source",
            source,
            "--out",
            inside.to_str().unwrap(),
        ],
    );
    assert_eq!(refused.code, 1, "{}{}", refused.stdout, refused.stderr);
    assert_eq!(refused.json()["error"]["code"], "ATM_MIGRATE_REFUSED");
    assert!(!inside.exists());

    // 2.x 服务还在跑（租约的持有者活着）：只报告，输出目录都不建。
    std::fs::create_dir_all(r.legacy.join("runtime")).unwrap();
    std::fs::write(
        r.legacy.join("runtime").join("daemon.lock"),
        format!("{{\"pid\":{}}}", std::process::id()),
    )
    .unwrap();
    let busy = run(
        &r,
        &[
            "--json",
            "migrate",
            "--dry-run",
            "--source",
            source,
            "--out",
            "busy-out",
        ],
    );
    assert_eq!(busy.code, 5, "{}{}", busy.stdout, busy.stderr);
    assert_eq!(busy.json()["error"]["code"], "ATM_ADMISSION_CONFLICT");
    assert!(!r.base.join("busy-out").exists());
    std::fs::remove_dir_all(r.legacy.join("runtime")).unwrap();

    // 不是 2.x 根：转换的扫描拒绝，原因照实给出。
    let wrong = run(
        &r,
        &[
            "--json",
            "migrate",
            "--dry-run",
            "--source",
            source,
            "--out",
            "out",
        ],
    );
    assert_eq!(wrong.code, 1, "{}{}", wrong.stdout, wrong.stderr);
    let v = wrong.json();
    assert!(
        v["error"]["message"]
            .as_str()
            .unwrap()
            .contains("unsupported source state"),
        "{v}"
    );

    assert_eq!(
        tree(&r.legacy),
        legacy,
        "the dry run wrote into the 2.x root"
    );
    assert_eq!(tree(&r.n), n, "the dry run wrote into N");
}
