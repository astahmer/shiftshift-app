//! The dedicated small "toast" window used by `NotificationStyle::Custom`
//! (see `notify.rs`) — separate from the main capture panel so it can be
//! small, positioned independently (Settings -> Notifications -> Position),
//! and never steals focus or interferes with a concurrently-open panel.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::settings::{SettingsState, ToastPosition};

const TOAST_LABEL: &str = "toast";
/// Bumped on every `reveal` so a stale auto-hide thread (the optimistic
/// "Capturing…" toast, then the real one ~100ms later) doesn't hide the
/// newer toast when its own timer fires.
static TOAST_GEN: AtomicU64 = AtomicU64::new(0);
/// Last payload — delivered once `toast.ts` is listening. `reveal` used to
/// emit immediately *and* `toast_ready` replayed the same payload, so the
/// check drew twice (almost finished, then from scratch).
static LAST_TOAST: Mutex<Option<CaptureToast>> = Mutex::new(None);
static WEBVIEW_READY: AtomicBool = AtomicBool::new(false);
static LAST_DELIVERED_GEN: AtomicU64 = AtomicU64::new(0);
/// `preview_at` / `start_arrange` — `toast.ts` blur/mouseup always call
/// `finish_arrange`; ignore those unless we're actually placing the toast.
static ARRANGING: AtomicBool = AtomicBool::new(false);
/// Gap kept between the toast and the nearest screen edge for every preset
/// except `Custom`.
const MARGIN: i32 = 16;
/// How close (in physical pixels) a dragged-and-dropped toast has to land to
/// a preset's position to snap to it instead of keeping the exact drop spot.
const SNAP_THRESHOLD: i32 = 48;

#[derive(Clone, serde::Serialize)]
pub struct CaptureToast {
    pub title: String,
    pub body: String,
    /// Percent scale (100 = normal) — see `Settings::toast_font_scale`.
    pub font_scale: u8,
    pub duration_ms: Option<u32>,
    /// Built-in or custom theme id so the toast window can restyle without
    /// a separate settings round-trip (it is created once and kept around).
    pub theme: String,
}

/// Shows the toast at `Settings::toast_position`, fills it with
/// `title`/`body`, and auto-hides it after `Settings::toast_duration_ms`.
pub fn show_capture_toast(app: &AppHandle, title: &str, body: &str) {
    let settings = app.state::<SettingsState>().0.lock().unwrap().clone();
    reveal(
        app,
        settings.toast_position,
        (settings.toast_custom_x, settings.toast_custom_y),
        title,
        body,
        settings.toast_font_scale,
        Some(settings.toast_duration_ms),
        false,
    );
}

/// Settings -> Notifications -> "Preview" for a position that hasn't been
/// saved yet — shows sample text at an explicit candidate position rather
/// than reading `Settings` off disk/state. Honors the current
/// `notify_content` so "icon only" actually previews as just the icon.
pub fn preview_at(app: &AppHandle, position: ToastPosition, custom: (i32, i32)) {
    let settings = app.state::<SettingsState>().0.lock().unwrap().clone();
    let (title, body) = crate::notify::custom_toast_copy(
        settings.notify_content,
        "Note saved",
        "This is what it looks like",
    );
    // Persistent + interactive so the preview can be dragged to a free
    // spot (same gesture as "Drag to place"). A timed click-through
    // preview couldn't be grabbed, which is what "free mode" needs.
    reveal(
        app,
        position,
        custom,
        &title,
        &body,
        settings.toast_font_scale,
        None,
        false,
    );
    if let Some(window) = app.get_webview_window(TOAST_LABEL) {
        let _ = window.set_ignore_cursor_events(false);
    }
}

/// Settings -> Notifications -> "Drag to place": shows a persistent sample
/// toast (no auto-hide, draggable — see `finish_arrange` for what happens on
/// release) at whatever position was last saved.
pub fn start_arrange(app: &AppHandle) {
    let settings = app.state::<SettingsState>().0.lock().unwrap().clone();
    reveal(
        app,
        settings.toast_position,
        (settings.toast_custom_x, settings.toast_custom_y),
        "Drag me anywhere",
        "Release to place it",
        settings.toast_font_scale,
        None,
        true,
    );
    if let Some(window) = app.get_webview_window(TOAST_LABEL) {
        let _ = window.set_ignore_cursor_events(false);
    }
}

/// Webview boot handshake — see `LAST_TOAST`. Delivers at most once per gen.
pub fn replay_pending(app: &AppHandle) {
    WEBVIEW_READY.store(true, Ordering::SeqCst);
    deliver_pending(app);
}

fn deliver_pending(app: &AppHandle) {
    if !WEBVIEW_READY.load(Ordering::SeqCst) {
        return;
    }
    let gen = TOAST_GEN.load(Ordering::SeqCst);
    if LAST_DELIVERED_GEN.load(Ordering::SeqCst) == gen {
        return;
    }
    let Some(payload) = LAST_TOAST.lock().unwrap().clone() else {
        return;
    };
    let Some(window) = app.get_webview_window(TOAST_LABEL) else {
        return;
    };
    LAST_DELIVERED_GEN.store(gen, Ordering::SeqCst);
    let _ = window.emit("capture-toast", payload);
}

/// Drops a visible toast without waiting out `toast_duration_ms` — used
/// when an optimistic "Capturing…" toast (see `notify::notify_capturing`)
/// has to go away because the gesture didn't actually save anything.
pub fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(TOAST_LABEL) {
        let _ = window.eval(
            "document.querySelector('.capture-toast')?.classList.remove('capture-toast-play')",
        );
        let _ = window.hide();
    }
}

/// `duration_ms: None` also doubles as "not the arrange flow" — a transient
/// toast is click-through (`ignore_cursor_events`) *and* non-focusable, so
/// showing it never blocks whatever's underneath it and never steals key-
/// window status from the panel (which used to make `hide_on_blur` close
/// the panel the instant a save fired a toast — the window didn't need
/// keyboard focus at all, just visibility). The draggable arrange sample
/// needs both real mouse events and to actually become key for the drag
/// gesture, hence both flip the other way there.
fn ensure_window(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(window) = app.get_webview_window(TOAST_LABEL) {
        return Some(window);
    }
    WebviewWindowBuilder::new(app, TOAST_LABEL, WebviewUrl::App("toast.html".into()))
        .title("shiftshift-toast")
        .inner_size(280.0, 60.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .visible(false)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(false)
        .focusable(false)
        .build()
        .ok()
}

fn reveal(
    app: &AppHandle,
    position: ToastPosition,
    custom: (i32, i32),
    title: &str,
    body: &str,
    font_scale: u8,
    duration_ms: Option<u32>,
    focusable: bool,
) {
    let duration_ms = duration_ms.map(|duration| duration.max(1));
    let Some(window) = ensure_window(app) else {
        return;
    };
    let size = toast_window_size(title, body, font_scale);
    let _ = window.set_size(size);
    if let Ok(Some(monitor)) = window.current_monitor() {
        let (x, y) = place(position, custom, *monitor.position(), *monitor.size(), size);
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
    let _ = window.set_ignore_cursor_events(duration_ms.is_some());
    let _ = window.set_focusable(focusable);
    let theme = app.state::<SettingsState>().0.lock().unwrap().theme.clone();
    let payload = CaptureToast {
        title: title.to_string(),
        body: body.to_string(),
        font_scale,
        duration_ms,
        theme,
    };
    *LAST_TOAST.lock().unwrap() = Some(payload);
    ARRANGING.store(duration_ms.is_none(), Ordering::SeqCst);
    let gen = TOAST_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    // Strip play while the window is still up so `forwards` doesn't paint
    // a finished check. Do **not** `hide()` here — the toast webview has
    // no `allow-show`, so a JS `show()` after hide never comes back.
    let _ = window
        .eval("document.querySelector('.capture-toast')?.classList.remove('capture-toast-play')");
    deliver_pending(app);
    let _ = window.show();
    if let Some(duration_ms) = duration_ms {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(u64::from(duration_ms)));
            if TOAST_GEN.load(Ordering::SeqCst) != gen {
                return;
            }
            crate::toast::hide(&app);
        });
    }
}

/// Reads back wherever the user actually dropped the toast window, snaps it
/// to the nearest preset if it's close enough, otherwise keeps the exact
/// coordinates as a custom position — either way, persists the result and
/// hides the window.
pub fn finish_arrange(app: &AppHandle) -> Result<(), String> {
    if !ARRANGING.swap(false, Ordering::SeqCst) {
        return Ok(());
    }
    let window = app
        .get_webview_window(TOAST_LABEL)
        .ok_or("toast window missing")?;
    let dropped_at = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("no monitor under the toast")?;
    let (position, custom) = snap(dropped_at, size, *monitor.position(), *monitor.size());

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let state = app.state::<SettingsState>();
    let mut settings = state.0.lock().unwrap();
    settings.toast_position = position;
    settings.toast_custom_x = custom.0;
    settings.toast_custom_y = custom.1;
    crate::settings::save(&app_data_dir, &settings)?;
    drop(settings);

    let _ = window.set_focusable(false);
    let _ = window.hide();
    let _ = app.emit_to("panel", "toast-position-changed", ());
    Ok(())
}

/// Icon-only toasts shrink to a square so the empty text column doesn't
/// leave a wide blank pill; text modes keep the configured banner size,
/// scaled by `toast_font_scale`.
fn toast_window_size(title: &str, body: &str, font_scale: u8) -> PhysicalSize<u32> {
    let scale = (f32::from(font_scale.max(50)) / 100.0).clamp(0.5, 2.0);
    if title.is_empty() && body.is_empty() {
        let n = (64.0 * scale).round() as u32;
        PhysicalSize::new(n.max(48), n.max(48))
    } else {
        PhysicalSize::new(
            (280.0 * scale.min(1.25)).round() as u32,
            (68.0 * scale).round() as u32,
        )
    }
}

/// The physical top-left corner for each preset, given the monitor's own
/// bounds and the toast's own size — `Custom` just passes `custom` through.
/// `pub(crate)`: also used by `dock.rs`, which shares the same 3x3-grid
/// positioning concept for a different (persistent, not transient) window.
pub(crate) fn place(
    position: ToastPosition,
    custom: (i32, i32),
    monitor_pos: PhysicalPosition<i32>,
    monitor_size: PhysicalSize<u32>,
    toast_size: PhysicalSize<u32>,
) -> (i32, i32) {
    let (mx, my, mw, mh) = (
        monitor_pos.x,
        monitor_pos.y,
        monitor_size.width as i32,
        monitor_size.height as i32,
    );
    let (tw, th) = (toast_size.width as i32, toast_size.height as i32);
    let left = mx + MARGIN;
    let right = mx + mw - tw - MARGIN;
    let h_center = mx + (mw - tw) / 2;
    let top = my + MARGIN;
    let bottom = my + mh - th - MARGIN;
    let v_center = my + (mh - th) / 2;
    let v_upper = my + (mh - th) / 4;
    let v_lower = my + 3 * (mh - th) / 4;
    let h_mid_left = mx + (mw - tw) / 4;
    let h_mid_right = mx + 3 * (mw - tw) / 4;
    match position {
        ToastPosition::TopLeft => (left, top),
        ToastPosition::TopMidLeft => (h_mid_left, top),
        ToastPosition::TopCenter => (h_center, top),
        ToastPosition::TopMidRight => (h_mid_right, top),
        ToastPosition::TopRight => (right, top),
        ToastPosition::MiddleLeft => (left, v_center),
        ToastPosition::LeftTop => (left, top),
        ToastPosition::LeftUpper => (left, v_upper),
        ToastPosition::LeftLower => (left, v_lower),
        ToastPosition::LeftBottom => (left, bottom),
        ToastPosition::RightTop => (right, top),
        ToastPosition::RightUpper => (right, v_upper),
        ToastPosition::RightLower => (right, v_lower),
        ToastPosition::RightBottom => (right, bottom),
        ToastPosition::Center => (h_center, v_center),
        ToastPosition::MiddleRight => (right, v_center),
        ToastPosition::BottomLeft => (left, bottom),
        ToastPosition::BottomMidLeft => (h_mid_left, bottom),
        ToastPosition::BottomCenter => (h_center, bottom),
        ToastPosition::BottomMidRight => (h_mid_right, bottom),
        ToastPosition::BottomRight => (right, bottom),
        ToastPosition::Custom => custom,
    }
}

/// Given where the toast window actually ended up after a drag, finds the
/// nearest preset; snaps to it if within `SNAP_THRESHOLD` physical pixels,
/// otherwise reports the drop as an exact `Custom` position. `pub(crate)`
/// for the same reason as `place` above.
pub(crate) fn snap(
    dropped_at: PhysicalPosition<i32>,
    toast_size: PhysicalSize<u32>,
    monitor_pos: PhysicalPosition<i32>,
    monitor_size: PhysicalSize<u32>,
) -> (ToastPosition, (i32, i32)) {
    const PRESETS: [ToastPosition; 9] = [
        ToastPosition::TopLeft,
        ToastPosition::TopCenter,
        ToastPosition::TopRight,
        ToastPosition::MiddleLeft,
        ToastPosition::Center,
        ToastPosition::MiddleRight,
        ToastPosition::BottomLeft,
        ToastPosition::BottomCenter,
        ToastPosition::BottomRight,
    ];
    let nearest = PRESETS
        .into_iter()
        .map(|preset| {
            let (px, py) = place(preset, (0, 0), monitor_pos, monitor_size, toast_size);
            let distance = (px - dropped_at.x).pow(2) + (py - dropped_at.y).pow(2);
            (preset, distance)
        })
        .min_by_key(|&(_, distance)| distance);

    match nearest {
        Some((preset, distance)) if distance <= SNAP_THRESHOLD.pow(2) => {
            (preset, (dropped_at.x, dropped_at.y))
        }
        _ => (ToastPosition::Custom, (dropped_at.x, dropped_at.y)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn monitor() -> (PhysicalPosition<i32>, PhysicalSize<u32>) {
        (PhysicalPosition::new(0, 0), PhysicalSize::new(1920, 1080))
    }
    fn toast() -> PhysicalSize<u32> {
        PhysicalSize::new(260, 64)
    }

    #[test]
    fn top_right_hugs_the_top_right_corner_with_margin() {
        let (pos, size) = monitor();
        let (x, y) = place(ToastPosition::TopRight, (0, 0), pos, size, toast());
        assert_eq!((x, y), (1920 - 260 - MARGIN, MARGIN));
    }

    #[test]
    fn left_top_is_the_top_left_preset() {
        let (pos, size) = monitor();
        let (x, y) = place(ToastPosition::LeftTop, (0, 0), pos, size, toast());
        assert_eq!((x, y), (MARGIN, MARGIN));
    }

    #[test]
    fn center_is_actually_centered() {
        let (pos, size) = monitor();
        let (x, y) = place(ToastPosition::Center, (0, 0), pos, size, toast());
        assert_eq!((x, y), ((1920 - 260) / 2, (1080 - 64) / 2));
    }

    #[test]
    fn custom_passes_through_the_given_coordinates() {
        let (pos, size) = monitor();
        let (x, y) = place(ToastPosition::Custom, (500, 300), pos, size, toast());
        assert_eq!((x, y), (500, 300));
    }

    #[test]
    fn dropping_near_a_preset_snaps_to_it() {
        let (pos, size) = monitor();
        // A few pixels off from the exact top-left preset spot.
        let dropped = PhysicalPosition::new(MARGIN + 5, MARGIN - 3);
        let (position, coords) = snap(dropped, toast(), pos, size);
        assert_eq!(position, ToastPosition::TopLeft);
        assert_eq!(coords, (dropped.x, dropped.y));
    }

    #[test]
    fn dropping_far_from_any_preset_stays_custom() {
        let (pos, size) = monitor();
        let dropped = PhysicalPosition::new(700, 500);
        let (position, coords) = snap(dropped, toast(), pos, size);
        assert_eq!(position, ToastPosition::Custom);
        assert_eq!(coords, (700, 500));
    }

    #[test]
    fn icon_only_toast_is_a_square_not_a_wide_banner() {
        let size = toast_window_size("", "", 100);
        assert_eq!(size.width, size.height);
        assert!(size.width <= 80);
    }

    #[test]
    fn text_toast_stays_a_wide_banner() {
        let size = toast_window_size("Note saved", "buy milk", 100);
        assert!(size.width > size.height);
    }

    #[test]
    fn transient_toast_payload_exposes_duration() {
        let payload = serde_json::to_value(CaptureToast {
            title: "Image saved".to_string(),
            body: String::new(),
            font_scale: 100,
            duration_ms: Some(1800),
            theme: "light".to_string(),
        })
        .unwrap();

        assert_eq!(payload["duration_ms"], serde_json::json!(1800));
    }
}
