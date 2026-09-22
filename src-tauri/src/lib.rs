mod automation;
mod capture;
pub mod cli_protocol;
mod cli_server;
mod clipboard_watch;
mod commands;
mod custom_themes;
mod db;
mod db_encryption;
mod dock;
mod export;
mod images;
mod instance;
mod item_drag;
mod link_preview;
#[cfg(target_os = "macos")]
mod mac_tap;
mod notify;
mod panel;
mod settings;
mod store;
mod templates;
mod toast;
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir().expect("resolvable app data dir");
            let instance_lock = match instance::acquire(&app_data_dir) {
                Ok(lock) => lock,
                Err(instance::InstanceLockError::AlreadyRunning) => {
                    eprintln!("shiftshift: another instance is already running; exiting duplicate");
                    app.handle().exit(0);
                    return Ok(());
                }
                Err(error) => return Err(Box::new(error)),
            };
            app.manage(instance_lock);

            let settings = settings::load(&app_data_dir);
            let db = db::Db::open(&app_data_dir, &settings).expect("failed to open store");
            app.manage(db);

            let fallback_toggle = settings.fallback_toggle.clone();
            let fallback_capture = settings.fallback_capture.clone();
            let fallback_image = settings.fallback_image.clone();
            let launch_at_login = settings.launch_at_login;
            let managed_launch_item = instance::launchd_is_managed(&app_data_dir);
            let show_in_dock = settings.show_in_dock;
            let show_tray_icon = settings.show_tray_icon;
            let dock_enabled = settings.dock_enabled;
            let panel_width = settings.panel_width;
            let panel_height = settings.panel_height;
            let panel_x = settings.panel_x;
            let panel_y = settings.panel_y;
            let panel_placed = settings.panel_placed;
            app.manage(settings::SettingsState(std::sync::Mutex::new(settings)));

            let templates = templates::load(&app_data_dir);
            app.manage(templates::TemplatesState(std::sync::Mutex::new(templates)));

            let custom_themes = custom_themes::load(&app_data_dir);
            app.manage(custom_themes::CustomThemesState(std::sync::Mutex::new(
                custom_themes,
            )));

            let handle = app.handle().clone();
            if let Err(e) = capture::register_fallback_shortcuts(
                &handle,
                &fallback_toggle,
                &fallback_capture,
                &fallback_image,
            ) {
                eprintln!("shiftshift: {e}");
            }
            cli_server::start(handle.clone());
            clipboard_watch::start(handle.clone());
            tray::apply(&handle, show_tray_icon)?;
            panel::apply_dock_visibility(&handle, show_in_dock);

            // Sync the OS-level login-item registration in case it drifted
            // (e.g. the setting was toggled, then the app was reinstalled).
            let sync_result = if managed_launch_item {
                Ok(())
            } else if launch_at_login {
                app.autolaunch().enable()
            } else {
                app.autolaunch().disable()
            };
            if let Err(e) = sync_result {
                eprintln!("shiftshift: could not sync login-item registration: {e}");
            }

            if let Some(panel) = app.get_webview_window("panel") {
                vibrancy::apply(&panel);
                let repaired = panel::apply_saved_frame(
                    &panel,
                    panel_width,
                    panel_height,
                    panel_x,
                    panel_y,
                    panel_placed,
                );
                if panel_placed {
                    if repaired.width != panel_width
                        || repaired.height != panel_height
                        || repaired.x != panel_x
                        || repaired.y != panel_y
                    {
                        let state = app.state::<settings::SettingsState>();
                        let mut live = state.0.lock().unwrap();
                        live.panel_width = repaired.width;
                        live.panel_height = repaired.height;
                        live.panel_x = repaired.x;
                        live.panel_y = repaired.y;
                        if let Err(error) = settings::save(&app_data_dir, &live) {
                            eprintln!("shiftshift: could not repair saved panel frame: {error}");
                        }
                    }
                }
            }
            dock::apply_enabled(&handle, dock_enabled);

            #[cfg(target_os = "macos")]
            mac_tap::start(handle.clone());
            #[cfg(not(target_os = "macos"))]
            capture::start_double_shift_listener(handle.clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_items,
            commands::list_collections,
            commands::save_collection,
            commands::delete_collection,
            commands::add_item,
            commands::toggle_done,
            commands::toggle_bookmarked,
            commands::set_kind,
            commands::set_item_tags,
            commands::update_item_text,
            commands::delete_item,
            commands::clear_completed,
            commands::move_item,
            commands::restore_item,
            commands::set_rank,
            commands::start_item_drag,
            commands::list_history,
            commands::log_used,
            commands::note_own_clipboard_write,
            commands::capture_clipboard_image,
            commands::copy_image_to_clipboard,
            commands::fetch_link_preview,
            commands::prepare_icloud_folder,
            commands::reveal_in_finder,
            commands::preview_file,
            commands::accessibility_trusted,
            commands::open_accessibility_settings,
            commands::input_monitoring_granted,
            commands::open_input_monitoring_settings,
            commands::get_settings,
            commands::hide_panel,
            commands::show_panel,
            commands::save_panel_frame,
            commands::hide_panel_and_paste,
            commands::quit_app,
            commands::get_sync_status,
            commands::set_settings,
            commands::reset_settings,
            commands::s3_secret_configured,
            commands::clear_s3_secret,
            commands::preview_sound,
            commands::preview_toast_position,
            commands::preview_notification,
            commands::start_toast_arrange,
            commands::finish_toast_arrange,
            commands::toast_ready,
            commands::dock_set_expanded,
            commands::start_dock_arrange,
            commands::prepare_dock_drag,
            commands::finish_dock_arrange,
            commands::begin_dock_resize,
            commands::finish_dock_resize,
            commands::save_dock_frame,
            commands::dock_set_composer,
            commands::dock_hide_and_submit,
            commands::export_markdown,
            commands::list_templates,
            commands::add_template,
            commands::update_template,
            commands::delete_template,
            commands::replace_templates,
            commands::list_custom_themes,
            commands::add_custom_theme,
            commands::update_custom_theme,
            commands::delete_custom_theme,
            commands::replace_custom_themes,
        ])
        .build(tauri::generate_context!())
        .expect("error while building shiftshift")
        // "Close to tray": Cmd+Q / Dock > Quit fire ExitRequested with
        // `code: None` (user interaction) — prevented, since the panel has no
        // title bar to close and the only way back would otherwise be
        // relaunching the whole app. `code: Some(_)` means an explicit
        // `app.exit()` call (the tray menu's "Quit"), which must go through.
        .run(|_app_handle, event| {
            if let tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } = event
            {
                api.prevent_exit();
            }
        });
}
