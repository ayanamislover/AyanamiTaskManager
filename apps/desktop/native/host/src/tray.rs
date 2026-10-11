//! Tray icon and menu. Same items and wording as the Electron tray (window-host.ts);
//! the counts and modes come from the core's tray snapshot.

use serde::Deserialize;
use tray_icon::menu::{CheckMenuItem, Menu, MenuId, MenuItem, PredefinedMenuItem, Submenu};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub blocked: u64,
    pub waiting: u64,
    pub pending_update: Option<String>,
    pub notification_mode: String,
    /// 数据源冲突，等用户选（07 §7）。宿主自己设，不来自核心的快照。
    #[serde(skip)]
    pub needs_source: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Open,
    QuickTask,
    Settings,
    NotificationMode(&'static str),
    InstallUpdate,
    Quit,
}

pub const OPEN: &str = "atm.open";
pub const SOURCE: &str = "atm.source";
pub const QUICK: &str = "atm.quick";
pub const SETTINGS: &str = "atm.settings";
pub const UPDATE: &str = "atm.update";
pub const QUIT: &str = "atm.quit";
const MODES: [(&str, &str, &str); 3] = [
    ("ALL", "atm.mode.all", "全部通知"),
    ("CRITICAL", "atm.mode.critical", "仅严重事件"),
    ("OFF", "atm.mode.off", "不通知"),
];

pub fn action(id: &MenuId) -> Option<Action> {
    Some(match id.as_ref() {
        OPEN | SOURCE => Action::Open,
        QUICK => Action::QuickTask,
        SETTINGS => Action::Settings,
        UPDATE => Action::InstallUpdate,
        QUIT => Action::Quit,
        other => {
            let (mode, _, _) = MODES.iter().find(|(_, menu_id, _)| *menu_id == other)?;
            Action::NotificationMode(mode)
        }
    })
}

fn mode_label(mode: &str) -> &'static str {
    MODES
        .iter()
        .find(|(value, _, _)| *value == mode)
        .map(|(_, _, label)| *label)
        .unwrap_or("全部通知")
}

pub fn menu(snapshot: &Snapshot) -> Menu {
    let menu = Menu::new();
    if snapshot.needs_source {
        let _ = menu.append(&MenuItem::with_id(
            SOURCE,
            "需要选择数据来源，点击打开",
            true,
            None,
        ));
        let _ = menu.append(&PredefinedMenuItem::separator());
    }
    let _ = menu.append(&MenuItem::with_id(OPEN, "打开绫波任务管理器", true, None));
    let _ = menu.append(&MenuItem::with_id(QUICK, "新建临时任务", true, None));
    let _ = menu.append(&MenuItem::new(
        format!("受阻 {} / 等待用户 {}", snapshot.blocked, snapshot.waiting),
        false,
        None,
    ));
    if let Some(version) = &snapshot.pending_update {
        let _ = menu.append(&MenuItem::with_id(
            UPDATE,
            format!("{version} 已就绪，点击重启更新"),
            true,
            None,
        ));
    }
    let _ = menu.append(&PredefinedMenuItem::separator());
    let modes = Submenu::new(
        format!("系统通知 · {}", mode_label(&snapshot.notification_mode)),
        true,
    );
    for (value, id, label) in MODES {
        let _ = modes.append(&CheckMenuItem::with_id(
            id,
            label,
            true,
            value == snapshot.notification_mode,
            None,
        ));
    }
    let _ = menu.append(&modes);
    let _ = menu.append(&MenuItem::with_id(SETTINGS, "设置", true, None));
    let _ = menu.append(&PredefinedMenuItem::separator());
    let _ = menu.append(&MenuItem::with_id(QUIT, "完全退出", true, None));
    menu
}

/// Icon resource 1 is logo.ico, embedded by build.rs.
pub fn icon() -> Option<Icon> {
    Icon::from_resource(1, Some((20, 20))).ok()
}

/// 托盘提示：数据源冲突时直接说要做什么（07 §7）。
pub fn tooltip(snapshot: &Snapshot) -> String {
    if snapshot.needs_source {
        "AyanamiTaskManager：需要选择数据来源".into()
    } else {
        "AyanamiTaskManager".into()
    }
}

pub fn build(snapshot: &Snapshot) -> Result<TrayIcon, String> {
    let mut builder = TrayIconBuilder::new()
        .with_tooltip(tooltip(snapshot))
        .with_menu(Box::new(menu(snapshot)))
        .with_menu_on_left_click(false);
    if let Some(icon) = icon() {
        builder = builder.with_icon(icon);
    }
    builder.build().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_ids_map_to_actions() {
        assert_eq!(action(&MenuId::new(OPEN)), Some(Action::Open));
        assert_eq!(action(&MenuId::new(UPDATE)), Some(Action::InstallUpdate));
        assert_eq!(action(&MenuId::new(SOURCE)), Some(Action::Open));
        assert_eq!(
            action(&MenuId::new("atm.mode.critical")),
            Some(Action::NotificationMode("CRITICAL"))
        );
        assert_eq!(action(&MenuId::new("atm.mode.bogus")), None);
        assert_eq!(mode_label("OFF"), "不通知");
    }
}
