//! 无边框窗口的外框：Windows 10 上左、右、下三边不再贴一圈亮线。
//!
//! tao 的「无边框 + 阴影」（`with_undecorated_shadow(true)`）在 WM_NCCALCSIZE 里给左、右、下各留
//! 一条缩放边宽（SM_CXSIZEFRAME + SM_CXPADDEDBORDER，96 DPI 下 8px）的非客户区，系统在那里画阴影、
//! 认缩放。Windows 10 的 DWM 在这条非客户区最里面那一像素画窗口边框线：开了「在标题栏和窗口边框上
//! 显示强调色」就是强调色，没开是半透明的灰线，跟的是系统设置，不跟界面的主题——暗色界面四周于是
//! 贴着一圈亮边（顶上 tao 不留非客户区，也就没有线）。这条线跟着客户区的边走：把非客户区收窄 1px，
//! 线只是往里挪 1px（实测，`scripts/native-window.ps1` 的 ScreenCorner 从屏幕上拍）。Windows 10 也
//! 没有改边框颜色的接口（DWMWA_BORDER_COLOR 从 Windows 11 才有）。
//!
//! 所以 Windows 10 上不要非客户区：窗口按 tao 的「无边框、无阴影」建（客户区就是整个外框，DWM 不画
//! 边框线），阴影由这里把 DWM 框架往客户区里扩 1px 找回来（被 WebView 盖住，看不见那 1px）。左、右、
//! 下没有了系统的缩放边，改由界面贴边的几条把手发起缩放（`startWindowResize` →
//! [`resize_direction`] → tao 的 `drag_resize_window`，交给系统的缩放循环）；顶边本来就由 WebView2
//! 在拖动区最上面那几像素答 HTTOP。Windows 11 的边框由 DWM 另画（带圆角），照旧用 tao 的阴影模式。

use tao::window::ResizeDirection;
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::Graphics::Dwm::DwmExtendFrameIntoClientArea;
use windows_sys::Win32::UI::Controls::MARGINS;

/// Windows 11 从这个版本号起。
const WINDOWS_11_BUILD: u32 = 22000;

/// 只为让 DWM 画阴影：往客户区里扩 1px 框架（在顶上，被 WebView 盖住）。
const SHADOW_MARGINS: MARGINS = MARGINS {
    cxLeftWidth: 0,
    cxRightWidth: 0,
    cyTopHeight: 1,
    cyBottomHeight: 0,
};

fn is_client_frame(build: u32) -> bool {
    build < WINDOWS_11_BUILD
}

/// Windows 10：窗口没有非客户区，缩放由界面的贴边把手发起。
pub fn client_frame() -> bool {
    is_client_frame(windows_version::OsVersion::current().build)
}

/// 窗口建好、WebView 建起来之前调用（事件循环线程）。
pub fn install(hwnd: isize) {
    if !client_frame() {
        return;
    }
    // SAFETY: 窗口是本线程刚建的；MARGINS 在调用期间有效。
    unsafe {
        DwmExtendFrameIntoClientArea(hwnd as HWND, &SHADOW_MARGINS);
    }
}

/// 界面把手报的边 → tao 的缩放方向。顶边不在里面：那一条 WebView2 自己答 HTTOP。
pub fn resize_direction(edge: &str) -> Option<ResizeDirection> {
    Some(match edge {
        "left" => ResizeDirection::West,
        "right" => ResizeDirection::East,
        "bottom" => ResizeDirection::South,
        "bottomLeft" => ResizeDirection::SouthWest,
        "bottomRight" => ResizeDirection::SouthEast,
        "topLeft" => ResizeDirection::NorthWest,
        "topRight" => ResizeDirection::NorthEast,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_windows_10_draws_its_own_frame() {
        assert!(is_client_frame(19045));
        assert!(is_client_frame(17763));
        assert!(!is_client_frame(22000));
        assert!(!is_client_frame(26100));
    }

    #[test]
    fn every_handle_maps_to_one_direction_and_nothing_else_does() {
        let handles = [
            ("left", ResizeDirection::West),
            ("right", ResizeDirection::East),
            ("bottom", ResizeDirection::South),
            ("bottomLeft", ResizeDirection::SouthWest),
            ("bottomRight", ResizeDirection::SouthEast),
            ("topLeft", ResizeDirection::NorthWest),
            ("topRight", ResizeDirection::NorthEast),
        ];
        for (edge, direction) in handles {
            assert_eq!(resize_direction(edge), Some(direction), "{edge}");
        }
        for edge in ["top", "Left", "west", "", "left ", "bottom-left"] {
            assert_eq!(resize_direction(edge), None, "{edge:?}");
        }
    }
}
