//! Native "glass" backdrop for the capture panel, using each platform's
//! cheapest compositor-backed blur (ported from cooper's `glass.rs`, same
//! approach): macOS `NSVisualEffectView` vibrancy, Windows DWM acrylic.
//! Linux has no cross-compositor blur API — the translucent CSS theme is
//! used as-is; window managers like KWin/picom can blur it if configured.

use tauri::WebviewWindow;

pub fn apply(window: &WebviewWindow) {
    let win = window.clone();
    // Effect APIs must run on the main thread (hard requirement on macOS).
    let _ = window.run_on_main_thread(move || set_effect(&win));
}

#[cfg(target_os = "macos")]
fn set_effect(window: &WebviewWindow) {
    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
    if let Err(e) = apply_vibrancy(
        window,
        NSVisualEffectMaterial::HudWindow,
        Some(NSVisualEffectState::Active),
        Some(12.0),
    ) {
        eprintln!("shiftshift: vibrancy unavailable: {e}");
    }
}

#[cfg(target_os = "windows")]
fn set_effect(window: &WebviewWindow) {
    use window_vibrancy::apply_acrylic;
    if let Err(e) = apply_acrylic(window, Some((20, 20, 28, 120))) {
        eprintln!("shiftshift: acrylic unavailable: {e}");
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn set_effect(_window: &WebviewWindow) {}
