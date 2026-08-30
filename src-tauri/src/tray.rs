//! Menu-bar tray icon: left-click toggles the panel, right-click (or the
//! menu item) offers Show/Quit. Exists so the app has a discoverable way
//! back once the panel is hidden and to make "close to tray" mean something
//! for a borderless, chrome-less overlay window — see `lib.rs`'s
//! `ExitRequested` handler for the other half (Cmd+Q doesn't quit outright).

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    App,
};

pub fn build(app: &App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show shiftshift", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::new()
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
    Ok(())
}
