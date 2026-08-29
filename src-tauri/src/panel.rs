use tauri::{AppHandle, Manager};

const PANEL_LABEL: &str = "panel";

pub fn toggle(app: &AppHandle) {
    let Some(window) = app.get_webview_window(PANEL_LABEL) else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    if visible {
        let _ = window.hide();
    } else {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Reserved for tray-menu / CLI-capture callers that need to raise the panel
/// without toggling it shut if already open.
#[allow(dead_code)]
pub fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(PANEL_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
