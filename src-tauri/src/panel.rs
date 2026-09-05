use std::sync::Mutex;
#[cfg(target_os = "macos")]
use std::time::Duration;

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewWindow};

use crate::settings::SettingsState;

const PANEL_LABEL: &str = "panel";

/// Whatever app was frontmost right before the panel took focus — restored
/// on hide (see `hide`/`restore_previous_focus`) so summoning shiftshift to
/// jot something down doesn't strand you needing to click back into
/// whatever you were typing in. Set only from the show side (`toggle`'s
/// show branch, `show`); never touched on hide, so a hide-while-already-
/// hidden or a second toggle-to-close doesn't clobber it with shiftshift
/// itself (which would be the frontmost app by the time that runs).
static LAST_FRONTMOST: Mutex<Option<String>> = Mutex::new(None);

/// Applies the user's Dock preference while accounting for macOS's
/// asynchronous process-type transition. Tao ignores a hide requested within
/// roughly one second of a show, so delayed hides are required after the
/// temporary regular-policy activation used by `activate_and_show`.
pub fn apply_dock_visibility(app: &AppHandle, visible: bool) {
    #[cfg(target_os = "macos")]
    {
        if visible {
            let _ = app.set_dock_visibility(true);
            return;
        }

        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1_100));
            let show_in_dock = app.state::<SettingsState>().0.lock().unwrap().show_in_dock;
            if !show_in_dock {
                let _ = app.set_dock_visibility(false);
            }
        });
    }

    #[cfg(not(target_os = "macos"))]
    let _ = (app, visible);
}

pub fn toggle(app: &AppHandle) {
    let Some(window) = app.get_webview_window(PANEL_LABEL) else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    if visible {
        hide(app);
    } else {
        remember_frontmost();
        activate_and_show(app, &window);
    }
}

/// Raises the panel without toggling it shut if already open — used by the
/// tray menu and by capture modes that want the panel visible (`open`/`draft`
/// in `capture::handle_captured_text`).
pub fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(PANEL_LABEL) {
        remember_frontmost();
        activate_and_show(app, &window);
    }
}

/// `window.show()` + `window.set_focus()` alone make the panel key *within
/// shiftshift's own app*, but don't reliably make macOS switch which
/// application is frontmost system-wide when shiftshift is running with no
/// Dock icon (the default — see `show_in_dock`/`set_dock_visibility`): an
/// accessory-policy app's `activateIgnoringOtherApps` call can silently fail
/// to steal focus from whatever app currently has it, verified empirically
/// (the panel would visibly appear yet the previously frontmost app kept
/// receiving keystrokes). The fix every Spotlight-alternative launcher
/// uses: flip to a regular activation policy just long enough to activate,
/// then restore the user's preference after macOS's process-type transition
/// is allowed to settle.
///
/// Don't "simplify" this to a bare `activate_app()`. That was re-measured
/// after the Input Monitoring and code-signing fixes landed, in case the
/// flip had only ever been compensating for those: without it, 0 of 3 runs
/// took focus (the previously frontmost app stayed frontmost and went on
/// receiving the typed characters), against 3 of 3 with it.
fn activate_and_show(app: &AppHandle, window: &WebviewWindow) {
    let restore_to = app.state::<SettingsState>().0.lock().unwrap().show_in_dock;
    apply_dock_visibility(app, true);
    activate_app();
    let _ = window.show();
    let _ = window.set_focus();
    if !restore_to {
        apply_dock_visibility(app, false);
    }
}

/// The actual macOS app-level activation — see `activate_and_show` for why
/// this alone isn't sufficient without the dock-visibility flip.
#[cfg(target_os = "macos")]
fn activate_app() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApp;
    let mtm = unsafe { MainThreadMarker::new_unchecked() };
    #[allow(deprecated)]
    NSApp(mtm).activateIgnoringOtherApps(true);
}

#[cfg(not(target_os = "macos"))]
fn activate_app() {}

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
