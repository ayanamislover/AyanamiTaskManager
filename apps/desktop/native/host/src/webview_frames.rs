//! No frames, ever (§5 spike): a same-origin iframe could call `parent.ipc` and its
//! message would carry the top document's Source. CSP already forbids frames; the host
//! cancels every frame navigation as a second, independent layer.

use webview2_com::NavigationStartingEventHandler;
use wry::{WebView, WebViewExtWindows};

pub fn deny_frames(webview: &WebView) {
    let core = webview.webview();
    // WebView2 reuses the NavigationStarting handler type for frame navigations.
    let mut token: i64 = 0;
    let handler = NavigationStartingEventHandler::create(Box::new(|_, args| {
        if let Some(args) = args {
            unsafe { args.SetCancel(true)? };
        }
        Ok(())
    }));
    let _ = unsafe { core.add_FrameNavigationStarting(&handler, &mut token) };
}
