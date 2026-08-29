mod capture;
mod commands;
mod db;
#[cfg(target_os = "macos")]
mod mac_tap;
mod panel;
mod store;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir().expect("resolvable app data dir");
            let db = db::Db::open(&app_data_dir).expect("failed to open local store");
            app.manage(db);

            let handle = app.handle().clone();
            capture::register_fallback_shortcuts(&handle);

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
            commands::toggle_pinned,
            commands::delete_item,
            commands::clear_completed,
        ])
        .run(tauri::generate_context!())
        .expect("error while running shiftshift");
}
