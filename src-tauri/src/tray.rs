//! Menu-bar tray icon: left-click toggles the panel, right-click (or the
//! menu item) offers Show/Quit. Exists so the app has a discoverable way
//! back once the panel is hidden and to make "close to tray" mean something
//! for a borderless, chrome-less overlay window — see `lib.rs`'s
//! `ExitRequested` handler for the other half (Cmd+Q doesn't quit outright).
//!
//! Off by default (Settings -> "Show in menu bar") — this app is meant to be
//! invoked purely via the double-shift gesture / fallback shortcuts, so a
//! menu-bar icon is an opt-in convenience, not the primary way in.

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle,
};

const TRAY_ID: &str = "main";

/// Creates or removes the tray icon to match `show` — called once at startup
/// and again whenever the setting changes, so it takes effect live. Cheap to
/// call redundantly: no-ops if the icon already matches the requested state.
pub fn apply(app: &AppHandle, show: bool) -> tauri::Result<()> {
    let exists = app.tray_by_id(TRAY_ID).is_some();
    if show && !exists {
        let show_item = MenuItem::with_id(app, "show", "Show shiftshift", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&show_item, &quit])?;

        TrayIconBuilder::with_id(TRAY_ID)
            .icon(app.default_window_icon().cloned().expect("bundled tray icon"))
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id.as_ref() {
                "show" => crate::panel::show(app),
                "quit" => app.exit(0),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
                    crate::panel::toggle(tray.app_handle());
                }
            })
            .build(app)?;
    } else if !show {
        if let Some(tray) = app.remove_tray_by_id(TRAY_ID) {
            drop(tray);
        }
    }
    Ok(())
}
