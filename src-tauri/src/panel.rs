use std::sync::Mutex;
#[cfg(target_os = "macos")]
use std::time::Duration;

use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewWindow,
};

use crate::settings::SettingsState;

const PANEL_LABEL: &str = "panel";
const MIN_PANEL_WIDTH: u32 = 320;
const MIN_PANEL_HEIGHT: u32 = 200;
const MAX_PANEL_WIDTH: u32 = 1200;
const MAX_PANEL_HEIGHT: u32 = 900;
const PANEL_EDGE_MARGIN: u32 = 24;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PanelFrame {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) x: i32,
    pub(crate) y: i32,
}

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
            let panel_visible = app
                .get_webview_window(PANEL_LABEL)
                .and_then(|window| window.is_visible().ok())
                .unwrap_or(false);
            if should_hide_dock(show_in_dock, panel_visible) {
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
    apply_dock_visibility(app, true);
    activate_app();
    let _ = window.show();
    let _ = window.set_focus();
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
    apply_dock_visibility(app, false);
    restore_previous_focus();
}

fn should_hide_dock(show_in_dock: bool, panel_visible: bool) -> bool {
    !show_in_dock && !panel_visible
}

/// Hide, hand focus back, then paste — the default highlighted-item Enter
/// (`HighlightSubmit::CopyHideWrite`). Restore is waited out (not spawned)
/// so the paste chord lands in the previous app, not a still-frontmost
/// shiftshift or a race with `osascript`.
/// Restores a user-resized/dragged frame. Size applies whenever it looks
/// like a real window (not the unset 0×0 default); position only after the
/// user has actually placed the panel once (`placed`).
pub(crate) fn apply_saved_frame(
    window: &WebviewWindow,
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    placed: bool,
) -> PanelFrame {
    let frame = clamp_frame_for_window(
        window,
        PanelFrame {
            width,
            height,
            x,
            y,
        },
    );
    if frame.width >= MIN_PANEL_WIDTH && frame.height >= MIN_PANEL_HEIGHT {
        let _ = window.set_size(LogicalSize::new(frame.width as f64, frame.height as f64));
    }
    if placed {
        let _ = window.set_position(LogicalPosition::new(frame.x as f64, frame.y as f64));
    }
    frame
}

pub(crate) fn clamp_frame_for_window(window: &WebviewWindow, frame: PanelFrame) -> PanelFrame {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return frame;
    };
    clamp_frame(
        frame,
        *monitor.position(),
        *monitor.size(),
        monitor.scale_factor(),
    )
}

fn clamp_frame(
    frame: PanelFrame,
    monitor_position: PhysicalPosition<i32>,
    monitor_size: PhysicalSize<u32>,
    scale_factor: f64,
) -> PanelFrame {
    if frame.width < MIN_PANEL_WIDTH || frame.height < MIN_PANEL_HEIGHT {
        return frame;
    }

    let scale = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    let monitor_x = (f64::from(monitor_position.x) / scale).round() as i32;
    let monitor_y = (f64::from(monitor_position.y) / scale).round() as i32;
    let monitor_width = (f64::from(monitor_size.width) / scale).floor() as u32;
    let monitor_height = (f64::from(monitor_size.height) / scale).floor() as u32;
    let max_width = monitor_width
        .saturating_sub(PANEL_EDGE_MARGIN * 2)
        .max(MIN_PANEL_WIDTH)
        .min(MAX_PANEL_WIDTH);
    let max_height = monitor_height
        .saturating_sub(PANEL_EDGE_MARGIN * 2)
        .max(MIN_PANEL_HEIGHT)
        .min(MAX_PANEL_HEIGHT);
    let width = frame.width.min(max_width);
    let height = frame.height.min(max_height);
    let min_x = monitor_x + PANEL_EDGE_MARGIN as i32;
    let min_y = monitor_y + PANEL_EDGE_MARGIN as i32;
    let max_x = monitor_x + monitor_width as i32 - PANEL_EDGE_MARGIN as i32 - width as i32;
    let max_y = monitor_y + monitor_height as i32 - PANEL_EDGE_MARGIN as i32 - height as i32;

    PanelFrame {
        width,
        height,
        x: if max_x >= min_x {
            frame.x.clamp(min_x, max_x)
        } else {
            monitor_x
        },
        y: if max_y >= min_y {
            frame.y.clamp(min_y, max_y)
        } else {
            monitor_y
        },
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dock_stays_visible_while_panel_is_open() {
        assert!(!should_hide_dock(false, true));
        assert!(!should_hide_dock(true, false));
        assert!(should_hide_dock(false, false));
    }

    #[test]
    fn clamp_frame_limits_oversized_frame_and_keeps_edges_visible() {
        let frame = clamp_frame(
            PanelFrame {
                width: 1900,
                height: 1000,
                x: 0,
                y: 0,
            },
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(1920, 1080),
            1.0,
        );

        assert_eq!(
            frame,
            PanelFrame {
                width: 1200,
                height: 900,
                x: 24,
                y: 24,
            }
        );
    }

    #[test]
    fn clamp_frame_uses_logical_dimensions_on_retina_displays() {
        let frame = clamp_frame(
            PanelFrame {
                width: 1400,
                height: 950,
                x: 1400,
                y: 900,
            },
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(3024, 1964),
            2.0,
        );

        assert_eq!(
            frame,
            PanelFrame {
                width: 1200,
                height: 900,
                x: 288,
                y: 58,
            }
        );
    }

    #[test]
    fn clamp_frame_leaves_unset_size_untouched() {
        let frame = PanelFrame {
            width: 0,
            height: 0,
            x: -400,
            y: -200,
        };

        assert_eq!(
            clamp_frame(
                frame,
                PhysicalPosition::new(0, 0),
                PhysicalSize::new(1920, 1080),
                1.0,
            ),
            frame
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn build_activate_script_escapes_quotes_and_backslashes() {
        let script = build_activate_script(r#"Weird "App" \ Name"#);
        assert_eq!(
            script,
            r#"tell application "System Events" to set frontmost of process "Weird \"App\" \\ Name" to true"#
        );
    }
}
