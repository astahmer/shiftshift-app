use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt;

use crate::capture;
use crate::custom_themes::{self, CustomTheme, CustomThemesState, ThemeColors};
use crate::db::Db;
use crate::export;
use crate::settings::{self, Settings, SettingsState, ToastPosition};
use crate::store::{
    Collection, FolderMergeReport, FolderStore, HistoryEntry, Item, ItemKind, MoveDirection,
};
use crate::templates::{self, Template, TemplatesState};

#[tauri::command]
pub fn list_items(db: State<Db>) -> Result<Vec<Item>, String> {
    db.store.list_items()
}

#[tauri::command]
pub fn list_collections(db: State<Db>) -> Result<Vec<Collection>, String> {
    db.store.list_collections()
}

#[tauri::command]
pub fn save_collection(
    db: State<Db>,
    app: AppHandle,
    collection: Collection,
) -> Result<(), String> {
    crate::store::validate_collection(&collection)?;
    db.store.save_collection(collection)?;
    let _ = app.emit("refresh", ());
    Ok(())
}

#[tauri::command]
pub fn delete_collection(db: State<Db>, app: AppHandle, id: String) -> Result<(), String> {
    db.store.delete_collection(&id)?;
    let _ = app.emit("refresh", ());
    Ok(())
}

#[tauri::command]
pub fn add_item(
    db: State<Db>,
    app: AppHandle,
    text: String,
    kind: ItemKind,
) -> Result<Item, String> {
    let item = db.store.add_item(&text, kind, None)?;
    let _ = db
        .store
        .log_event(Some(&item.id), "created", Some(&item.text));
    let _ = app.emit("refresh", ());
    crate::notify::notify_captured(&app, &item);
    crate::automation::dispatch(
        &app,
        crate::settings::AutomationEvent::ItemCreated,
        Some(item.clone()),
    );
    Ok(item)
}

#[tauri::command]
pub fn toggle_done(db: State<Db>, app: AppHandle, id: String) -> Result<(), String> {
    db.store.toggle_done(&id)?;
    let _ = db.store.log_event(Some(&id), "toggled_done", None);
    let _ = app.emit("refresh", ());
    crate::automation::dispatch_current_item(
        &app,
        crate::settings::AutomationEvent::ItemUpdated,
        &id,
    );
    Ok(())
}

#[tauri::command]
pub fn toggle_bookmarked(db: State<Db>, app: AppHandle, id: String) -> Result<(), String> {
    db.store.toggle_bookmarked(&id)?;
    let _ = db.store.log_event(Some(&id), "toggled_bookmark", None);
    let _ = app.emit("refresh", ());
    crate::automation::dispatch_current_item(
        &app,
        crate::settings::AutomationEvent::ItemBookmarked,
        &id,
    );
    Ok(())
}

#[tauri::command]
pub fn set_kind(db: State<Db>, app: AppHandle, id: String, kind: ItemKind) -> Result<(), String> {
    db.store.set_kind(&id, kind)?;
    let _ = db
        .store
        .log_event(Some(&id), "kind_changed", Some(&format!("{kind:?}")));
    let _ = app.emit("refresh", ());
    crate::automation::dispatch_current_item(
        &app,
        crate::settings::AutomationEvent::ItemUpdated,
        &id,
    );
    Ok(())
}

#[tauri::command]
pub fn set_item_tags(
    db: State<Db>,
    app: AppHandle,
    id: String,
    tags: Vec<String>,
) -> Result<(), String> {
    db.store.set_tags(&id, tags.clone())?;
    let detail =
        serde_json::to_string(&crate::store::normalize_tags(&tags)).map_err(|e| e.to_string())?;
    let _ = db.store.log_event(Some(&id), "tags_changed", Some(&detail));
    let _ = app.emit("refresh", ());
    crate::automation::dispatch_current_item(
        &app,
        crate::settings::AutomationEvent::ItemUpdated,
        &id,
    );
    Ok(())
}

#[tauri::command]
pub fn update_item_text(
    db: State<Db>,
    app: AppHandle,
    id: String,
    text: String,
) -> Result<(), String> {
    db.store.update_text(&id, &text)?;
    let _ = db.store.log_event(Some(&id), "edited", Some(&text));
    let _ = app.emit("refresh", ());
    crate::automation::dispatch_current_item(
        &app,
        crate::settings::AutomationEvent::ItemUpdated,
        &id,
    );
    Ok(())
}

#[tauri::command]
pub fn delete_item(db: State<Db>, app: AppHandle, id: String) -> Result<(), String> {
    let deleted_item = db
        .store
        .list_items()
        .ok()
        .and_then(|items| items.into_iter().find(|i| i.id == id));
    let detail = deleted_item.as_ref().map(|item| item.text.as_str());
    db.store.delete_item(&id)?;
    let _ = db.store.log_event(Some(&id), "deleted", detail);
    let _ = app.emit("refresh", ());
    crate::automation::dispatch(
        &app,
        crate::settings::AutomationEvent::ItemDeleted,
        deleted_item,
    );
    Ok(())
}

#[tauri::command]
pub fn clear_completed(db: State<Db>, app: AppHandle) -> Result<(), String> {
    let deleted = db
        .store
        .list_items()?
        .into_iter()
        .filter(|item| item.done)
        .collect::<Vec<_>>();
    db.store.clear_completed()?;
    let _ = app.emit("refresh", ());
    for item in deleted {
        crate::automation::dispatch(
            &app,
            crate::settings::AutomationEvent::ItemDeleted,
            Some(item),
        );
    }
    Ok(())
}

#[tauri::command]
pub fn move_item(
    db: State<Db>,
    app: AppHandle,
    id: String,
    direction: MoveDirection,
) -> Result<(), String> {
    db.store.move_item(&id, direction)?;
    let _ = app.emit("refresh", ());
    crate::automation::dispatch_current_item(
        &app,
        crate::settings::AutomationEvent::ItemUpdated,
        &id,
    );
    Ok(())
}

/// Undo side of a delete, redo side of an add — see `Store::restore_item`'s
/// doc comment for why this takes a full previously-returned `Item` rather
/// than reconstructing one.
#[tauri::command]
pub fn restore_item(db: State<Db>, app: AppHandle, item: Item) -> Result<(), String> {
    db.store.restore_item(item.clone())?;
    let _ = db
        .store
        .log_event(Some(&item.id), "restored", Some(&item.text));
    let _ = app.emit("refresh", ());
    crate::automation::dispatch_current_item(
        &app,
        crate::settings::AutomationEvent::ItemUpdated,
        &item.id,
    );
    Ok(())
}

/// Undo/redo for `move_item` — sets an exact rank rather than "one slot
/// up/down", so reordering can be reverted precisely.
#[tauri::command]
pub fn set_rank(db: State<Db>, app: AppHandle, id: String, rank: f64) -> Result<(), String> {
    db.store.set_rank(&id, rank)?;
    let _ = app.emit("refresh", ());
    crate::automation::dispatch_current_item(
        &app,
        crate::settings::AutomationEvent::ItemUpdated,
        &id,
    );
    Ok(())
}

/// Starts a native OS drag so notes land in text fields and images land in
/// file dropzones. HTML5 `dataTransfer` from WKWebView does not leave the window.
#[tauri::command]
pub fn start_item_drag(
    window: tauri::WebviewWindow,
    kind: String,
    text: String,
) -> Result<(), String> {
    let w = window.clone();
    window
        .run_on_main_thread(move || {
            if let Err(err) = crate::item_drag::start(&w, &kind, &text) {
                eprintln!("shiftshift: start_item_drag: {err}");
            }
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_history(db: State<Db>, limit: u32) -> Result<Vec<HistoryEntry>, String> {
    db.store.list_history(limit)
}

/// Called by the frontend right after copying/opening a selected row, purely
/// to record it in history — not a mutation, so no "refresh" event.
#[tauri::command]
pub fn log_used(db: State<Db>, app: AppHandle, id: String) -> Result<(), String> {
    db.store.log_event(Some(&id), "used", None)?;
    // Usage is an event in its own right, so a hook can build analytics or a
    // recency-based organizer without making capture/copy code provider-aware.
    // The item may have been deleted between the UI read and this call; in
    // that case there is simply no item payload to send.
    crate::automation::dispatch_current_item(&app, crate::settings::AutomationEvent::ItemUsed, &id);
    Ok(())
}

/// Called by the frontend right after it writes to the system clipboard
/// (Enter-to-copy, the multi-select numbered-list join), so clipboard-watch
/// doesn't re-capture that write as a brand-new external copy.
#[tauri::command]
pub fn note_own_clipboard_write(text: String) {
    crate::clipboard_watch::note_own_write(&text);
}

#[tauri::command]
pub fn capture_clipboard_image(app: AppHandle) -> Result<Item, String> {
    crate::images::capture_clipboard_image(&app)
}

#[tauri::command]
pub fn copy_image_to_clipboard(path: String) -> Result<(), String> {
    crate::images::copy_image_to_clipboard(&path)
}

#[tauri::command]
pub fn fetch_link_preview(url: String) -> Result<crate::link_preview::LinkPreview, String> {
    crate::link_preview::fetch(&url)
}

/// Creates the app-owned folder inside the user's iCloud Drive and copies
/// records missing from the folder before the backend switch takes effect.
#[tauri::command]
pub fn prepare_icloud_folder(db: State<Db>) -> Result<IcloudFolderSetup, String> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")
            .ok_or_else(|| "Could not determine your home folder".to_string())?;
        let cloud_root = std::path::PathBuf::from(home)
            .join("Library")
            .join("Mobile Documents")
            .join("com~apple~CloudDocs");
        if !cloud_root.is_dir() {
            return Err(format!(
                "iCloud Drive is not available at {}. Turn on iCloud Drive in System Settings and try again.",
                cloud_root.display()
            ));
        }
        let folder = cloud_root.join("shiftshift");
        let path = FolderStore::prepare(&folder.to_string_lossy())?;
        let folder_store = FolderStore::open(&path)?;
        let merge = if db.active_backend == "local" {
            folder_store.merge_from(db.store.as_ref())?
        } else {
            FolderMergeReport::default()
        };
        return Ok(IcloudFolderSetup { path, merge });
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("iCloud Drive setup is only available on macOS".to_string())
    }
}

/// Reveals a file in Finder so its native Share button (AirDrop, Mail,
/// Messages, third-party share extensions — everything) is one click away.
/// Not `NSSharingService` invoked directly: that reliably returns
/// `canPerformWithItems == false` when called from a spawned helper
/// process (confirmed live, both for AirDrop and Compose Email) — it needs
/// a real foreground NSApplication context, which neither `osascript` nor
/// a `std::process::Command`-spawned process has, regardless of what
/// spawned it. A true in-app share picker would need actual Cocoa linkage
/// (objc2 + a raw window handle), not a shell-out — deliberately not done
/// here without asking first, since it's a real new dependency.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Opens a captured image in the default macOS viewer (Preview.app for
/// png/jpeg). The in-panel overlay shrinks tall screenshots until they're
/// unreadable; the system viewer can zoom and scroll.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn preview_file(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn reveal_in_finder(_path: String) -> Result<(), String> {
    Err(
        "revealing a file in the system file manager isn't wired up on this platform yet"
            .to_string(),
    )
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn preview_file(_path: String) -> Result<(), String> {
    Err("opening a file preview isn't wired up on this platform yet".to_string())
}

/// Settings -> Visibility / the first-run banner — whether the double-Shift
/// hook can actually run right now. Always `true` on non-mac: the gesture
/// listener there (`rdev`, see `capture.rs`) has no comparable permission
/// gate to check.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn accessibility_trusted() -> bool {
    crate::mac_tap::is_trusted()
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn accessibility_trusted() -> bool {
    true
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn open_accessibility_settings() -> Result<(), String> {
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn open_accessibility_settings() -> Result<(), String> {
    Err("not applicable on this platform".to_string())
}

/// Input Monitoring is a *separate* permission from Accessibility and is the
/// one that actually lets the double-Shift tap read keystrokes from other
/// apps — Accessibility alone leaves the tap silently inert. The live tap is
/// also accepted here because macOS can report an unknown TCC result for an
/// ad-hoc app bundle after a rebuild even when the tap is already armed.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn input_monitoring_granted() -> bool {
    crate::mac_tap::input_monitoring_ready()
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn input_monitoring_granted() -> bool {
    true
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn open_input_monitoring_settings() -> Result<(), String> {
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn open_input_monitoring_settings() -> Result<(), String> {
    Err("not applicable on this platform".to_string())
}

#[derive(serde::Serialize)]
pub struct SyncStatus {
    /// "local" | "s3" | "folder" — what's actually in use right now, which
    /// can differ from `Settings::backend` if that backend failed to open
    /// and `Db::open` fell back to local storage.
    pub active_backend: String,
    pub configured_backend: String,
    pub fallback_reason: Option<String>,
}

#[derive(serde::Serialize)]
pub struct IcloudFolderSetup {
    pub path: String,
    pub merge: FolderMergeReport,
}

#[tauri::command]
pub fn get_sync_status(db: State<Db>, settings: State<SettingsState>) -> SyncStatus {
    SyncStatus {
        active_backend: db.active_backend.clone(),
        configured_backend: settings.0.lock().unwrap().backend.clone(),
        fallback_reason: db.fallback_reason.clone(),
    }
}

#[tauri::command]
pub fn get_settings(settings: State<SettingsState>) -> Settings {
    settings.0.lock().unwrap().clone()
}

/// The frontend's only way to hide the panel — routes through
/// `panel::hide` so focus hand-back to whatever app was frontmost before
/// (see `panel.rs`) happens no matter which UI action triggered the hide.
#[tauri::command]
pub fn hide_panel(app: AppHandle) {
    crate::panel::hide(&app);
}

/// Raise the panel without toggling it shut — used by `/settings` from the notch.
#[tauri::command]
pub fn show_panel(app: AppHandle) {
    crate::panel::show(&app);
}

/// Persist the panel's current size/position after the user resizes or
/// drags it — see `Settings::panel_width` / `panel_placed`.
#[tauri::command]
pub fn save_panel_frame(
    app: AppHandle,
    width: u32,
    height: u32,
    x: i32,
    y: i32,
) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let state = app.state::<SettingsState>();
    let mut settings = state.0.lock().unwrap();
    settings.panel_width = width;
    settings.panel_height = height;
    settings.panel_x = x;
    settings.panel_y = y;
    settings.panel_placed = true;
    crate::settings::save(&app_data_dir, &settings)
}

/// Hide + restore previous-app focus + paste. Used by the default
/// highlighted-item Enter (`copy_hide_write`).
#[tauri::command]
pub fn hide_panel_and_paste(app: AppHandle) {
    crate::panel::hide_and_paste(&app);
}

/// `/quit`'s backend half — the tray's "Quit" menu item does the same
/// `app.exit(0)` directly (see tray.rs), but the tray is off by default.
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Lets the settings UI audition a sound/volume combo before saving it,
/// independent of `notify_sound`/`notification_style` — see `notify::play_sound`.
#[tauri::command]
pub fn preview_sound(name: String, volume: u8) {
    crate::notify::play_sound(&name, volume);
}

/// Settings -> Notifications -> Position: shows the toast at a candidate
/// position without saving it, so picking a grid cell gives instant feedback.
#[tauri::command]
pub fn preview_toast_position(
    app: AppHandle,
    position: ToastPosition,
    custom_x: i32,
    custom_y: i32,
) {
    crate::toast::preview_at(&app, position, (custom_x, custom_y));
}

#[tauri::command]
pub fn preview_notification(app: AppHandle) {
    crate::notify::preview_sample(&app);
}

/// Settings -> Notifications -> "Drag to place": shows a persistent,
/// draggable sample toast the user can grab and drop anywhere on screen.
#[tauri::command]
pub fn start_toast_arrange(app: AppHandle) {
    crate::toast::start_arrange(&app);
}

/// Called once the drag ends — reads back wherever the toast window actually
/// landed, snaps/persists the result, and hides it. See `toast::finish_arrange`.
#[tauri::command]
pub fn finish_toast_arrange(app: AppHandle) -> Result<(), String> {
    crate::toast::finish_arrange(&app)
}

/// Toast webview finished loading — replay the last payload if `reveal`
/// raced the listener (blank first frame).
#[tauri::command]
pub fn toast_ready(app: AppHandle) {
    crate::toast::replay_pending(&app);
}

/// Settings -> Dock — visual expand/collapse only. Window size stays put.
#[tauri::command]
pub fn dock_set_expanded(app: AppHandle, expanded: bool) {
    crate::dock::set_expanded(&app, expanded);
}

/// Settings -> Dock -> "Drag to place". See `dock::start_arrange`.
#[tauri::command]
pub fn start_dock_arrange(app: AppHandle) {
    crate::dock::start_arrange(&app);
}

#[tauri::command]
pub fn prepare_dock_drag(app: AppHandle) {
    crate::dock::prepare_drag(&app);
}

/// See `dock::finish_arrange`.
#[tauri::command]
pub fn finish_dock_arrange(app: AppHandle) -> Result<(), String> {
    crate::dock::finish_arrange(&app)
}

#[tauri::command]
pub fn begin_dock_resize(app: AppHandle) {
    crate::dock::begin_resize(&app);
}

#[tauri::command]
pub fn finish_dock_resize(app: AppHandle) -> Result<(), String> {
    crate::dock::finish_resize(&app)
}

#[tauri::command]
pub fn save_dock_frame(app: AppHandle, width: u32, height: u32) -> Result<(), String> {
    crate::dock::save_expanded_size(&app, width, height)
}

#[tauri::command]
pub fn dock_set_composer(app: AppHandle, active: bool) {
    crate::dock::set_composer_active(&app, active);
}

/// Collapse the notch and restore the previous app, optionally pasting.
/// Same "On Enter" path as `hide_panel_and_paste`.
#[tauri::command]
pub fn dock_hide_and_submit(app: AppHandle, paste: bool) {
    crate::dock::hide_and_submit(&app, paste);
}

/// Persists the whole settings object, re-registers the fallback shortcuts if
/// any changed (new ones first, so a bad accelerator string never leaves the
/// user with none at all), and syncs the OS-level login-item registration.
#[tauri::command]
pub fn set_settings(
    settings: State<SettingsState>,
    app: AppHandle,
    mut next: Settings,
) -> Result<(), String> {
    let previous = settings.0.lock().unwrap().clone();
    let show_in_dock_changed = next.show_in_dock != previous.show_in_dock;
    // Write-only field — see `S3Settings`'s doc comment. Non-empty means
    // "the user just typed a new one," goes to the keychain and never
    // touches `Settings` (in memory or on disk) past this point; empty
    // means "untouched," left as-is (use `clear_s3_secret` to remove one).
    if !next.s3.secret_access_key.is_empty() {
        settings::set_s3_secret_access_key(&next.s3.secret_access_key)?;
    }
    next.s3.secret_access_key.clear();
    if next.fallback_toggle != previous.fallback_toggle
        || next.fallback_capture != previous.fallback_capture
        || next.fallback_image != previous.fallback_image
    {
        capture::reregister_fallback_shortcuts(
            &app,
            (
                &previous.fallback_toggle,
                &previous.fallback_capture,
                &previous.fallback_image,
            ),
            (
                &next.fallback_toggle,
                &next.fallback_capture,
                &next.fallback_image,
            ),
        )?;
    }
    if next.launch_at_login != previous.launch_at_login {
        let result = if next.launch_at_login {
            app.autolaunch().enable()
        } else {
            app.autolaunch().disable()
        };
        if let Err(e) = result {
            eprintln!("shiftshift: could not update login-item registration: {e}");
        }
    }
    if next.show_tray_icon != previous.show_tray_icon {
        if let Err(e) = crate::tray::apply(&app, next.show_tray_icon) {
            eprintln!("shiftshift: could not update tray icon: {e}");
        }
    }
    let dock_enabled_changed = next.dock_enabled != previous.dock_enabled;
    // Notify/toast rows used to spread a stale frontend `Settings` and
    // teleport the notch back to whatever edge was cached at last load.
    // A dock-grid click never writes notify fields, so this is safe.
    let notify_touched = next.notify_content != previous.notify_content
        || next.notification_style != previous.notification_style
        || next.notify_sound != previous.notify_sound
        || next.notify_sound_name != previous.notify_sound_name
        || next.notify_sound_volume != previous.notify_sound_volume
        || next.toast_position != previous.toast_position
        || next.toast_custom_x != previous.toast_custom_x
        || next.toast_custom_y != previous.toast_custom_y
        || next.toast_duration_ms != previous.toast_duration_ms
        || next.toast_font_scale != previous.toast_font_scale;
    if notify_touched && next.dock_enabled == previous.dock_enabled {
        next.dock_position = previous.dock_position;
        next.dock_custom_x = previous.dock_custom_x;
        next.dock_custom_y = previous.dock_custom_y;
    }
    let dock_moved = next.dock_position != previous.dock_position
        || next.dock_custom_x != previous.dock_custom_x
        || next.dock_custom_y != previous.dock_custom_y;
    let dock_resized = next.dock_expanded_width != previous.dock_expanded_width
        || next.dock_expanded_height != previous.dock_expanded_height
        || next.dock_row_height != previous.dock_row_height
        || next.dock_item_count != previous.dock_item_count;
    // The frontend cache of `panel_*` goes stale the moment the user
    // resizes/drags (`save_panel_frame` writes those fields without
    // round-tripping). Any later `set_settings` (toast position, sound, …)
    // used to replay the old frame and teleport the panel. Geometry lives
    // only in `save_panel_frame` now.
    next.panel_width = previous.panel_width;
    next.panel_height = previous.panel_height;
    next.panel_x = previous.panel_x;
    next.panel_y = previous.panel_y;
    next.panel_placed = previous.panel_placed;
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    settings::save(&app_data_dir, &next)?;
    let dock_enabled = next.dock_enabled;
    *settings.0.lock().unwrap() = next;
    if show_in_dock_changed {
        let show_in_dock = settings.0.lock().unwrap().show_in_dock;
        crate::panel::apply_dock_visibility(&app, show_in_dock);
    }
    // After the state update — `dock::apply_enabled`/`set_expanded` read
    // `dock_position`/custom coords back out of `SettingsState` to
    // (re)position the window.
    if dock_enabled_changed {
        crate::dock::apply_enabled(&app, dock_enabled);
    } else if dock_enabled && dock_moved {
        crate::dock::set_expanded(&app, false);
        crate::dock::relayout(&app);
    } else if dock_enabled && dock_resized {
        crate::dock::relayout(&app);
    }
    if dock_enabled {
        let _ = app.emit_to("dock", "refresh", ());
    }
    Ok(())
}

/// Factory defaults for every setting. Custom themes and the S3 keychain
/// secret are left alone — those are not "settings" in the form sense.
#[tauri::command]
pub fn reset_settings(settings: State<SettingsState>, app: AppHandle) -> Result<Settings, String> {
    set_settings(settings.clone(), app.clone(), Settings::default())?;
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    {
        let mut live = settings.0.lock().unwrap();
        live.panel_width = 0;
        live.panel_height = 0;
        live.panel_x = 0;
        live.panel_y = 0;
        live.panel_placed = false;
        settings::save(&app_data_dir, &live)?;
    }
    if let Some(panel) = app.get_webview_window("panel") {
        crate::panel::apply_saved_frame(&panel, 640, 420, 0, 0, false);
        let _ = panel.center();
    }
    Ok(settings.0.lock().unwrap().clone())
}

/// Settings -> Sync -> S3 — whether a secret access key is already stored in
/// the keychain, so the UI can show "(unchanged — leave blank to keep)"
/// instead of a real (or fake-empty) value. See `S3Settings`'s doc comment.
#[tauri::command]
pub fn s3_secret_configured() -> bool {
    settings::s3_secret_access_key().is_some()
}

#[tauri::command]
pub fn clear_s3_secret() -> Result<(), String> {
    settings::clear_s3_secret_access_key()
}

/// Writes a timestamped `.md` file under the app data dir and returns its
/// path, so the frontend can open it (e.g. via `plugin-shell`'s `open`).
#[tauri::command]
pub fn export_markdown(db: State<Db>, app: AppHandle) -> Result<String, String> {
    let items = db.store.list_items()?;
    let markdown = export::to_markdown(&items);
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("exports");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!(
        "shiftshift-{}.md",
        chrono::Utc::now().format("%Y%m%d-%H%M%S")
    ));
    std::fs::write(&path, markdown).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn list_templates(templates: State<TemplatesState>) -> Vec<Template> {
    templates.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn add_template(
    templates: State<TemplatesState>,
    app: AppHandle,
    name: String,
    body: String,
) -> Result<Template, String> {
    let template = Template {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        body,
    };
    let mut list = templates.0.lock().unwrap();
    list.push(template.clone());
    persist_templates(&app, &list)?;
    Ok(template)
}

#[tauri::command]
pub fn update_template(
    templates: State<TemplatesState>,
    app: AppHandle,
    id: String,
    name: String,
    body: String,
) -> Result<(), String> {
    let mut list = templates.0.lock().unwrap();
    let template = list
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or("template not found")?;
    template.name = name;
    template.body = body;
    persist_templates(&app, &list)
}

#[tauri::command]
pub fn delete_template(
    templates: State<TemplatesState>,
    app: AppHandle,
    id: String,
) -> Result<(), String> {
    let mut list = templates.0.lock().unwrap();
    list.retain(|t| t.id != id);
    persist_templates(&app, &list)
}

#[tauri::command]
pub fn replace_templates(
    templates: State<TemplatesState>,
    app: AppHandle,
    next: Vec<Template>,
) -> Result<(), String> {
    persist_templates(&app, &next)?;
    *templates.0.lock().unwrap() = next;
    Ok(())
}

fn persist_templates(app: &AppHandle, templates: &[Template]) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    templates::save(&app_data_dir, templates)
}

#[tauri::command]
pub fn list_custom_themes(themes: State<CustomThemesState>) -> Vec<CustomTheme> {
    themes.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn add_custom_theme(
    themes: State<CustomThemesState>,
    app: AppHandle,
    name: String,
    mode: String,
    colors: ThemeColors,
) -> Result<CustomTheme, String> {
    let theme = CustomTheme {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        mode,
        colors,
    };
    let mut list = themes.0.lock().unwrap();
    list.push(theme.clone());
    persist_custom_themes(&app, &list)?;
    Ok(theme)
}

#[tauri::command]
pub fn update_custom_theme(
    themes: State<CustomThemesState>,
    app: AppHandle,
    id: String,
    name: String,
    mode: String,
    colors: ThemeColors,
) -> Result<(), String> {
    let mut list = themes.0.lock().unwrap();
    let theme = list
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or("theme not found")?;
    theme.name = name;
    theme.mode = mode;
    theme.colors = colors;
    persist_custom_themes(&app, &list)
}

#[tauri::command]
pub fn delete_custom_theme(
    themes: State<CustomThemesState>,
    app: AppHandle,
    id: String,
) -> Result<(), String> {
    let mut list = themes.0.lock().unwrap();
    list.retain(|t| t.id != id);
    persist_custom_themes(&app, &list)
}

#[tauri::command]
pub fn replace_custom_themes(
    themes: State<CustomThemesState>,
    app: AppHandle,
    next: Vec<CustomTheme>,
) -> Result<(), String> {
    persist_custom_themes(&app, &next)?;
    *themes.0.lock().unwrap() = next;
    Ok(())
}

fn persist_custom_themes(app: &AppHandle, themes: &[CustomTheme]) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    custom_themes::save(&app_data_dir, themes)
}
