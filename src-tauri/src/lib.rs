mod capture;
mod clipboard_watch;
pub mod cli_protocol;
mod cli_server;
mod commands;
mod custom_themes;
mod db;
mod db_encryption;
mod export;
mod images;
mod link_preview;
#[cfg(target_os = "macos")]
mod mac_tap;
mod notify;
mod panel;
mod settings;
mod store;
mod templates;
mod tray;
mod vibrancy;

use tauri::Manager;
use tauri_plugin_autostart::ManagerExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir().expect("resolvable app data dir");

            let settings = settings::load(&app_data_dir);
            let db = db::Db::open(&app_data_dir, &settings).expect("failed to open store");
            app.manage(db);

            let fallback_toggle = settings.fallback_toggle.clone();
            let fallback_capture = settings.fallback_capture.clone();
            let fallback_image = settings.fallback_image.clone();
            let launch_at_login = settings.launch_at_login;
            let show_in_dock = settings.show_in_dock;
            let show_tray_icon = settings.show_tray_icon;
            app.manage(settings::SettingsState(std::sync::Mutex::new(settings)));

            let templates = templates::load(&app_data_dir);
            app.manage(templates::TemplatesState(std::sync::Mutex::new(templates)));

            let custom_themes = custom_themes::load(&app_data_dir);
            app.manage(custom_themes::CustomThemesState(std::sync::Mutex::new(custom_themes)));

            let handle = app.handle().clone();
            if let Err(e) = capture::register_fallback_shortcuts(&handle, &fallback_toggle, &fallback_capture, &fallback_image) {
                eprintln!("shiftshift: {e}");
            }
            cli_server::start(handle.clone());
            clipboard_watch::start(handle.clone());
            tray::apply(&handle, show_tray_icon)?;
            #[cfg(target_os = "macos")]
            let _ = handle.set_dock_visibility(show_in_dock);

            // Sync the OS-level login-item registration in case it drifted
            // (e.g. the setting was toggled, then the app was reinstalled).
            let sync_result = if launch_at_login { app.autolaunch().enable() } else { app.autolaunch().disable() };
            if let Err(e) = sync_result {
                eprintln!("shiftshift: could not sync login-item registration: {e}");
            }

            if let Some(panel) = app.get_webview_window("panel") {
                vibrancy::apply(&panel);
            }

            #[cfg(target_os = "macos")]
            mac_tap::start(handle.clone());
            #[cfg(not(target_os = "macos"))]
            capture::start_double_shift_listener(handle.clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_items,
            commands::add_item,
            commands::toggle_done,
            commands::toggle_bookmarked,
            commands::set_kind,
            commands::update_item_text,
            commands::delete_item,
            commands::clear_completed,
            commands::move_item,
            commands::restore_item,
            commands::set_rank,
            commands::list_history,
            commands::log_used,
            commands::note_own_clipboard_write,
            commands::capture_clipboard_image,
            commands::copy_image_to_clipboard,
            commands::fetch_link_preview,
            commands::reveal_in_finder,
            commands::get_settings,
            commands::get_sync_status,
            commands::set_settings,
            commands::export_markdown,
            commands::list_templates,
            commands::add_template,
            commands::update_template,
            commands::delete_template,
            commands::list_custom_themes,
            commands::add_custom_theme,
            commands::update_custom_theme,
            commands::delete_custom_theme,
        ])
        .build(tauri::generate_context!())
        .expect("error while building shiftshift")
        // "Close to tray": Cmd+Q / Dock > Quit fire ExitRequested with
        // `code: None` (user interaction) — prevented, since the panel has no
        // title bar to close and the only way back would otherwise be
        // relaunching the whole app. `code: Some(_)` means an explicit
        // `app.exit()` call (the tray menu's "Quit"), which must go through.
        .run(|_app_handle, event| {
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = event {
                api.prevent_exit();
            }
        });
}
