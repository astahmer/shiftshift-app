use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt;

use crate::capture;
use crate::custom_themes::{self, CustomTheme, CustomThemesState, ThemeColors};
use crate::db::Db;
use crate::export;
use crate::settings::{self, Settings, SettingsState};
use crate::store::{HistoryEntry, Item, ItemKind, MoveDirection};
use crate::templates::{self, Template, TemplatesState};

#[tauri::command]
pub fn list_items(db: State<Db>) -> Result<Vec<Item>, String> {
    db.store.list_items()
}

#[tauri::command]
pub fn add_item(db: State<Db>, app: AppHandle, text: String, kind: ItemKind) -> Result<Item, String> {
    let item = db.store.add_item(&text, kind, None)?;
    let _ = db.store.log_event(Some(&item.id), "created", Some(&item.text));
    let _ = app.emit("refresh", ());
    crate::notify::notify_captured(&app, &item);
    Ok(item)
}

#[tauri::command]
pub fn toggle_done(db: State<Db>, app: AppHandle, id: String) -> Result<(), String> {
    db.store.toggle_done(&id)?;
    let _ = db.store.log_event(Some(&id), "toggled_done", None);
    let _ = app.emit("refresh", ());
    Ok(())
}

#[tauri::command]
pub fn toggle_bookmarked(db: State<Db>, app: AppHandle, id: String) -> Result<(), String> {
    db.store.toggle_bookmarked(&id)?;
    let _ = db.store.log_event(Some(&id), "toggled_bookmark", None);
    let _ = app.emit("refresh", ());
    Ok(())
}

#[tauri::command]
pub fn set_kind(db: State<Db>, app: AppHandle, id: String, kind: ItemKind) -> Result<(), String> {
    db.store.set_kind(&id, kind)?;
    let _ = db.store.log_event(Some(&id), "kind_changed", Some(&format!("{kind:?}")));
    let _ = app.emit("refresh", ());
    Ok(())
}

#[tauri::command]
pub fn update_item_text(db: State<Db>, app: AppHandle, id: String, text: String) -> Result<(), String> {
    db.store.update_text(&id, &text)?;
    let _ = db.store.log_event(Some(&id), "edited", Some(&text));
    let _ = app.emit("refresh", ());
    Ok(())
}

#[tauri::command]
pub fn delete_item(db: State<Db>, app: AppHandle, id: String) -> Result<(), String> {
    let detail = db.store.list_items().ok().and_then(|items| items.into_iter().find(|i| i.id == id)).map(|i| i.text);
    db.store.delete_item(&id)?;
    let _ = db.store.log_event(Some(&id), "deleted", detail.as_deref());
    let _ = app.emit("refresh", ());
    Ok(())
}

#[tauri::command]
pub fn clear_completed(db: State<Db>, app: AppHandle) -> Result<(), String> {
    db.store.clear_completed()?;
    let _ = app.emit("refresh", ());
    Ok(())
}

#[tauri::command]
pub fn move_item(db: State<Db>, app: AppHandle, id: String, direction: MoveDirection) -> Result<(), String> {
    db.store.move_item(&id, direction)?;
    let _ = app.emit("refresh", ());
    Ok(())
}

/// Undo side of a delete, redo side of an add — see `Store::restore_item`'s
/// doc comment for why this takes a full previously-returned `Item` rather
/// than reconstructing one.
#[tauri::command]
pub fn restore_item(db: State<Db>, app: AppHandle, item: Item) -> Result<(), String> {
    db.store.restore_item(item.clone())?;
    let _ = db.store.log_event(Some(&item.id), "restored", Some(&item.text));
    let _ = app.emit("refresh", ());
    Ok(())
}

/// Undo/redo for `move_item` — sets an exact rank rather than "one slot
/// up/down", so reordering can be reverted precisely.
#[tauri::command]
pub fn set_rank(db: State<Db>, app: AppHandle, id: String, rank: f64) -> Result<(), String> {
    db.store.set_rank(&id, rank)?;
    let _ = app.emit("refresh", ());
    Ok(())
}

#[tauri::command]
pub fn list_history(db: State<Db>, limit: u32) -> Result<Vec<HistoryEntry>, String> {
    db.store.list_history(limit)
}

/// Called by the frontend right after copying/opening a selected row, purely
/// to record it in history — not a mutation, so no "refresh" event.
#[tauri::command]
pub fn log_used(db: State<Db>, id: String) -> Result<(), String> {
    db.store.log_event(Some(&id), "used", None)
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
    std::process::Command::new("open").arg("-R").arg(&path).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn reveal_in_finder(_path: String) -> Result<(), String> {
    Err("revealing a file in the system file manager isn't wired up on this platform yet".to_string())
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

/// Persists the whole settings object, re-registers the fallback shortcuts if
/// any changed (new ones first, so a bad accelerator string never leaves the
/// user with none at all), and syncs the OS-level login-item registration.
#[tauri::command]
pub fn set_settings(settings: State<SettingsState>, app: AppHandle, next: Settings) -> Result<(), String> {
    let previous = settings.0.lock().unwrap().clone();
    if next.fallback_toggle != previous.fallback_toggle
        || next.fallback_capture != previous.fallback_capture
        || next.fallback_image != previous.fallback_image
    {
        capture::reregister_fallback_shortcuts(
            &app,
            (&previous.fallback_toggle, &previous.fallback_capture, &previous.fallback_image),
            (&next.fallback_toggle, &next.fallback_capture, &next.fallback_image),
        )?;
    }
    if next.launch_at_login != previous.launch_at_login {
        let result = if next.launch_at_login { app.autolaunch().enable() } else { app.autolaunch().disable() };
        if let Err(e) = result {
            eprintln!("shiftshift: could not update login-item registration: {e}");
        }
    }
    if next.show_in_dock != previous.show_in_dock {
        #[cfg(target_os = "macos")]
        if let Err(e) = app.set_dock_visibility(next.show_in_dock) {
            eprintln!("shiftshift: could not update Dock visibility: {e}");
        }
    }
    if next.show_tray_icon != previous.show_tray_icon {
        if let Err(e) = crate::tray::apply(&app, next.show_tray_icon) {
            eprintln!("shiftshift: could not update tray icon: {e}");
        }
    }
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    settings::save(&app_data_dir, &next)?;
    *settings.0.lock().unwrap() = next;
    Ok(())
}

/// Writes a timestamped `.md` file under the app data dir and returns its
/// path, so the frontend can open it (e.g. via `plugin-shell`'s `open`).
#[tauri::command]
pub fn export_markdown(db: State<Db>, app: AppHandle) -> Result<String, String> {
    let items = db.store.list_items()?;
    let markdown = export::to_markdown(&items);
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("exports");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("shiftshift-{}.md", chrono::Utc::now().format("%Y%m%d-%H%M%S")));
    std::fs::write(&path, markdown).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn list_templates(templates: State<TemplatesState>) -> Vec<Template> {
    templates.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn add_template(templates: State<TemplatesState>, app: AppHandle, name: String, body: String) -> Result<Template, String> {
    let template = Template { id: uuid::Uuid::new_v4().to_string(), name, body };
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
    let template = list.iter_mut().find(|t| t.id == id).ok_or("template not found")?;
    template.name = name;
    template.body = body;
    persist_templates(&app, &list)
}

#[tauri::command]
pub fn delete_template(templates: State<TemplatesState>, app: AppHandle, id: String) -> Result<(), String> {
    let mut list = templates.0.lock().unwrap();
    list.retain(|t| t.id != id);
    persist_templates(&app, &list)
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
    let theme = CustomTheme { id: uuid::Uuid::new_v4().to_string(), name, mode, colors };
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
    let theme = list.iter_mut().find(|t| t.id == id).ok_or("theme not found")?;
    theme.name = name;
    theme.mode = mode;
    theme.colors = colors;
    persist_custom_themes(&app, &list)
}

#[tauri::command]
pub fn delete_custom_theme(themes: State<CustomThemesState>, app: AppHandle, id: String) -> Result<(), String> {
    let mut list = themes.0.lock().unwrap();
    list.retain(|t| t.id != id);
    persist_custom_themes(&app, &list)
}

fn persist_custom_themes(app: &AppHandle, themes: &[CustomTheme]) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    custom_themes::save(&app_data_dir, themes)
}
