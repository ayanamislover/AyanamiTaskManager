//! Windows toast notifications for events the core decided to show (desktop-observer.ts).
//!
//! The AppUserModelId is Squirrel's, which existing Start-menu shortcuts carry: Windows
//! keeps per-app notification settings under it, so the user's choices survive the move
//! off Electron. Text goes into the toast XML escaped; nothing else from the core does.

use std::path::Path;

use windows::Data::Xml::Dom::XmlDocument;
use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
use windows::core::HSTRING;

use crate::win::APP_USER_MODEL_ID;

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c if c.is_control() && c != '\n' => {}
            c => out.push(c),
        }
    }
    out
}

pub fn toast_xml(title: &str, body: &str) -> String {
    format!(
        "<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>",
        escape(title),
        escape(body)
    )
}

fn show_toast(title: &str, body: &str) -> windows::core::Result<()> {
    let document = XmlDocument::new()?;
    document.LoadXml(&HSTRING::from(toast_xml(title, body)))?;
    let toast = ToastNotification::CreateToastNotification(&document)?;
    let notifier =
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_USER_MODEL_ID))?;
    notifier.Show(&toast)
}

pub fn show(data_dir: &Path, title: &str, body: &str) {
    if let Err(error) = show_toast(title, body) {
        crate::log(data_dir, &format!("toast failed: {error}"));
    }
}

/// Taskbar grouping and toasts attribute to the same identity as the shortcut.
pub fn set_process_identity() {
    use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
    let _ = unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(APP_USER_MODEL_ID)) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_text_cannot_inject_toast_markup() {
        let xml = toast_xml("A · 任务受阻", "</text><action content='x'/> & \"q\"");
        assert!(
            xml.contains("&lt;/text&gt;&lt;action content=&apos;x&apos;/&gt; &amp; &quot;q&quot;")
        );
        assert_eq!(xml.matches("<text>").count(), 2);
    }

    /// Manual check on a machine with ATM installed: the Start-menu shortcut registers the
    /// AUMID, so the notifier resolves and reports whether the user allows notifications.
    #[test]
    #[ignore]
    fn installed_identity_resolves_to_a_notifier() {
        let notifier =
            ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_USER_MODEL_ID))
                .unwrap();
        println!("notification setting: {:?}", notifier.Setting().unwrap());
        let document = XmlDocument::new().unwrap();
        document
            .LoadXml(&HSTRING::from(toast_xml("t", "b")))
            .unwrap();
        ToastNotification::CreateToastNotification(&document).unwrap();
    }
}
