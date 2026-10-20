//! P-010（03 §2.6、§7 M-18）：只能由用户操作的子命令在本地直接拒绝——退出码 3、带用户入口的提示，
//! 服务**收到 0 个请求**（连探活都没有），数据根零变化。服务端的拒绝桩是第二道保险，不在这里依赖它。

mod support;

use atm_domain::capability::Capability;
use support::*;

/// (命令, 对应的能力)。
fn cases() -> Vec<(Vec<&'static str>, &'static str, Capability)> {
    vec![
        (
            vec!["project", "archive", "ATM"],
            "project archive",
            Capability::ProjectArchive,
        ),
        (
            vec!["project", "restore", "ATM"],
            "project restore",
            Capability::ProjectUnarchive,
        ),
        (
            vec!["backup", "create", "--project", "ATM"],
            "backup create",
            Capability::BackupCreateManual,
        ),
        (
            vec!["backup", "restore", "01J0000000000000000000BKUP"],
            "backup restore",
            Capability::BackupRestoreScope,
        ),
        // 00 C-07（v6）：导出只给用户。
        (
            vec!["export", "ATM", "--format", "json"],
            "export",
            Capability::ExportCreate,
        ),
        // 不带 --preview 的导入：连预览请求也不先发（文件不存在也一样，先拒绝）。
        (
            vec!["import", "plan.md", "--project", "ATM"],
            "import",
            Capability::ImportApply,
        ),
        // 参数错了照样先拒绝，而不是报用法错误或者去连服务。
        (
            vec!["project", "archive"],
            "project archive",
            Capability::ProjectArchive,
        ),
    ]
}

#[test]
fn user_only_commands_are_refused_locally_without_a_single_request() {
    let root = bare_root("cli-refuse");
    let mock = Mock::start();
    write_descriptor(&root, mock.port, TOKEN);
    let before = tree(&root);
    let endpoint = format!("http://127.0.0.1:{}", mock.port);
    for (args, name, capability) in cases() {
        let entry = capability.user_entry().unwrap();
        let human = atm_in(&root, &args);
        assert_eq!(human.code, 3, "{args:?}: {}{}", human.stdout, human.stderr);
        assert_eq!(human.stdout, "", "{args:?}");
        assert_eq!(
            human.stderr,
            format!("该操作只能由用户在 ATM 桌面端操作：{entry}\n"),
            "{args:?}"
        );

        let mut json_args = vec!["--json"];
        json_args.extend(args.iter().copied());
        let json = atm_in(&root, &json_args);
        assert_eq!(json.code, 3, "{args:?}");
        let v = json.json();
        assert_eq!(v["error"]["code"], "USER_AUTHORIZATION_REQUIRED", "{v}");
        assert_eq!(v["error"]["command"], name, "{v}");
        assert_eq!(v["error"]["user_entry"], entry, "{v}");
        assert_eq!(v["error"]["committed"], false, "{v}");

        // 覆盖变量指向同一个假服务：一样不连。
        let overridden = atm_with(
            &root,
            &args,
            &[("ATM_ENDPOINT", &endpoint), ("ATM_TOKEN", TOKEN)],
        );
        assert_eq!(overridden.code, 3, "{args:?}");
        assert_eq!(mock.hits(), 0, "{args:?} reached the service");
    }
    assert_eq!(tree(&root), before, "the data root changed");

    // 阳性对照：同一个假服务、同一份描述，能用的命令确实会连过去——计数器是活的。
    let allowed = atm_in(&root, &["--json", "backup", "list"]);
    assert_eq!(allowed.code, 0, "{}{}", allowed.stdout, allowed.stderr);
    assert!(mock.hits() > 0, "the mock never saw the allowed command");
    let previews = mock.hits();
    std::fs::write(root.join("plan.md"), "# 计划\n").unwrap();
    let preview = atm_in(
        &root,
        &["import", "plan.md", "--project", "ATM", "--preview"],
    );
    assert_eq!(preview.code, 0, "{}{}", preview.stdout, preview.stderr);
    assert!(
        mock.hits() > previews,
        "--preview never reached the service"
    );
}

/// `--help` 列出这些子命令属于用户操作，Agent 看一眼就知道不该调。
#[test]
fn help_names_the_user_only_commands() {
    let root = bare_root("cli-help");
    let help = atm_in(&root, &["--help"]);
    assert_eq!(help.code, 0);
    assert!(
        help.stdout.contains(
            "project archive / restore、backup create / restore、export、import（不带 --preview）"
        ),
        "{}",
        help.stdout
    );
    let none = atm_in(&root, &[]);
    assert_eq!(none.code, 2);
    let unknown = atm_in(&root, &["--json", "frobnicate"]);
    assert_eq!(unknown.code, 2);
    assert_eq!(unknown.json()["error"]["code"], "USAGE");
}
