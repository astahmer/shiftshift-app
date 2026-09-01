use std::sync::Mutex;

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewWindow};

const PANEL_LABEL: &str = "panel";

/// Whatever app was frontmost right before the panel took focus — restored
/// on hide (see `hide`/`restore_previous_focus`) so summoning shiftshift to
/// jot something down doesn't strand you needing to click back into
/// whatever you were typing in. Set only from the show side (`toggle`'s
/// show branch, `show`); never touched on hide, so a hide-while-already-
/// hidden or a second toggle-to-close doesn't clobber it with shiftshift
/// itself (which would be the frontmost app by the time that runs).
static LAST_FRONTMOST: Mutex<Option<String>> = Mutex::new(None);

pub fn toggle(app: &AppHandle) {
    let Some(window) = app.get_webview_window(PANEL_LABEL) else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    if visible {
        hide(app);
    } else {
        remember_frontmost();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Raises the panel without toggling it shut if already open — used by the
/// tray menu and by capture modes that want the panel visible (`open`/`draft`
/// in `capture::handle_captured_text`).
pub fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(PANEL_LABEL) {
        remember_frontmost();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// The one place the panel actually gets hidden — both `toggle`'s hide
/// branch and every frontend-driven hide (Escape, acting on an item, click-
/// outside/blur) go through the `hide_panel` command into this, so focus
/// hand-back is never a per-call-site thing to remember.
pub fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(PANEL_LABEL) {
        let _ = window.hide();
    }
    restore_previous_focus();
}

/// Hide, hand focus back, then paste — the default highlighted-item Enter
/// (`HighlightSubmit::CopyHideWrite`). Restore is waited out (not spawned)
/// so the paste chord lands in the previous app, not a still-frontmost
/// shiftshift or a race with `osascript`.
/// Restores a user-resized/dragged frame. Size applies whenever it looks
/// like a real window (not the unset 0×0 default); position only after the
/// user has actually placed the panel once (`placed`).
pub fn apply_saved_frame(
    window: &WebviewWindow,
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    placed: bool,
) {
    if width >= 320 && height >= 200 {
        let _ = window.set_size(LogicalSize::new(width as f64, height as f64));
    }
    if placed {
        let _ = window.set_position(LogicalPosition::new(x as f64, y as f64));
    }
}

pub fn hide_and_paste(app: &AppHandle) {
    hide(app);
    let _ = crate::capture::send_paste(app);
}

pub(crate) fn remember_frontmost() {
    *LAST_FRONTMOST.lock().unwrap() = crate::capture::frontmost_app_name();
}

#[cfg(target_os = "macos")]
pub(crate) fn restore_previous_focus() {
    let Some(name) = LAST_FRONTMOST.lock().unwrap().take() else {
        return;
    };
    let _ = std::process::Command::new("osascript")
        .arg("-e")
        .arg(build_activate_script(&name))
        .output();
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn restore_previous_focus() {
    let _ = LAST_FRONTMOST.lock().unwrap().take();
}

/// Escapes backslashes and double quotes — the two characters that would
/// otherwise break out of the `"..."` the process name sits in (same
/// reasoning/escaping as `notify.rs`'s `applescript_string`).
#[cfg(target_os = "macos")]
fn build_activate_script(name: &str) -> String {
    let escaped = name.replace('\\', "\\\\").replace('"', "\\\"");
    format!(r#"tell application "System Events" to set frontmost of process "{escaped}" to true"#)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn build_activate_script_escapes_quotes_and_backslashes() {
        let script = build_activate_script(r#"Weird "App" \ Name"#);
        assert_eq!(
            script,
            r#"tell application "System Events" to set frontmost of process "Weird \"App\" \\ Name" to true"#
        );
    }
}
