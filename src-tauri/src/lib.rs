mod capture;
pub mod cli_protocol;
mod cli_server;
mod commands;
mod db;
mod export;
#[cfg(target_os = "macos")]
mod mac_tap;
mod notify;
mod panel;
mod settings;
mod store;
mod templates;
mod vibrancy;

use tauri::Manager;

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
            let db = db::Db::open(&app_data_dir).expect("failed to open local store");
            app.manage(db);

            let settings = settings::load(&app_data_dir);
            let fallback_toggle = settings.fallback_toggle.clone();
            let fallback_capture = settings.fallback_capture.clone();
            app.manage(settings::SettingsState(std::sync::Mutex::new(settings)));

            let templates = templates::load(&app_data_dir);
            app.manage(templates::TemplatesState(std::sync::Mutex::new(templates)));

            let handle = app.handle().clone();
            if let Err(e) = capture::register_fallback_shortcuts(&handle, &fallback_toggle, &fallback_capture) {
                eprintln!("shiftshift: {e}");
            }
            cli_server::start(handle.clone());

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
            commands::get_settings,
            commands::set_settings,
            commands::export_markdown,
            commands::list_templates,
            commands::add_template,
            commands::update_template,
            commands::delete_template,
        ])
        .run(tauri::generate_context!())
        .expect("error while running shiftshift");
}
