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

/// Raises the panel without toggling it shut if already open — used by the
/// tray menu and by capture modes that want the panel visible (`open`/`draft`
/// in `capture::handle_captured_text`).
pub fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(PANEL_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
