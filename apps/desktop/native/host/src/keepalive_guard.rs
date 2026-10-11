//! 静态守卫（方案 B1）：`user_quit` 只代表用户主动退出，熔断与标记只由用户自己的启动复位。
//! 托盘菜单与启动方式在用例里驱动不到，由这里钉住；每条都有去掉它的对照。

const APP: &str = include_str!("app.rs");
const MAIN: &str = include_str!("main.rs");

fn body<'a>(src: &'a str, head: &str) -> Option<&'a str> {
    let start = src.find(head)?;
    let rest = &src[start..];
    let end = rest[1..].find("\n    fn ").map_or(rest.len(), |i| i + 1);
    Some(&rest[..end])
}

/// 托盘「退出」写标记再退出；`quit()`（setup 的 QUIT、事务关门、冒烟退出也走它）不写。
fn only_the_tray_quit_marks(app: &str) -> bool {
    let marks = ["keepalive::mark_user_quit(", "self.quit();"];
    app.contains("Some(tray::Action::Quit) => self.quit_by_user(),")
        && body(app, "    fn quit_by_user(&mut self) {")
            .is_some_and(|b| marks.iter().all(|m| b.contains(m)))
        && body(app, "    fn quit(&mut self) {").is_some_and(|b| !b.contains("user_quit"))
        && app.matches("mark_user_quit(").count() == 1
        && app.matches("self.quit_by_user()").count() == 1
}

fn only_a_user_start_resets(main: &str) -> bool {
    main.contains(
        "    if !parsed.background && !parsed.agent_wake && !matches!(context, Context::TxnStart { .. }) {\n        keepalive_user_started(&layout.v3_root, lifecycle);\n    }\n",
    ) && main.matches("keepalive_user_started(").count() == 2
        && body(main, "fn keepalive_user_started(").is_some_and(|b| {
            ["keepalive::clear_user_quit(", "keepalive::reset_breaker(", "notify::show("]
                .iter()
                .all(|call| b.contains(call))
        })
        && !main.contains("mark_user_quit(")
}

#[test]
fn only_the_tray_quit_leaves_the_user_quit_marker() {
    assert!(only_the_tray_quit_marks(APP), "app.rs");
    for (from, to) in [
        (
            "Some(tray::Action::Quit) => self.quit_by_user(),",
            "Some(tray::Action::Quit) => self.quit(),",
        ),
        (
            "            Command::Quit => self.quit(),",
            "            Command::Quit => self.quit_by_user(),",
        ),
    ] {
        assert_eq!(APP.matches(from).count(), 1, "{from}");
        assert!(
            !only_the_tray_quit_marks(&APP.replace(from, to)),
            "对照：{to}"
        );
    }
    // 对照：把写标记挪进 quit()。
    assert_eq!(APP.matches("        self.quitting = true;\n").count(), 1);
    let moved = APP.replace(
        "        self.quitting = true;\n",
        "        self.quitting = true;\n        let _ = keepalive::mark_user_quit(&root, &quit);\n",
    );
    assert!(!only_the_tray_quit_marks(&moved));
}

#[test]
fn only_the_users_own_start_resets_the_breaker() {
    assert!(only_a_user_start_resets(MAIN), "main.rs");
    for (from, to) in [
        ("!parsed.background && ", ""),
        ("!parsed.agent_wake && ", ""),
        (" && !matches!(context, Context::TxnStart { .. })", ""),
        ("    keepalive::clear_user_quit(v3_root);\n", ""),
        ("    notify::show(\n", "    drop((\n"),
    ] {
        assert_eq!(MAIN.matches(from).count(), 1, "{from}");
        assert!(
            !only_a_user_start_resets(&MAIN.replace(from, to)),
            "对照：去掉 {from}"
        );
    }
}
