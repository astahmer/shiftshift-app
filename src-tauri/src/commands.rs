use tauri::{AppHandle, Emitter, Manager, State};

use crate::capture;
use crate::db::Db;
use crate::export;
use crate::settings::{self, Settings, SettingsState};
use crate::store::{Item, ItemKind};
use crate::templates::{self, Template, TemplatesState};

#[tauri::command]
pub fn list_items(db: State<Db>) -> Result<Vec<Item>, String> {
    db.0.list_items()
}

#[tauri::command]
pub fn add_item(db: State<Db>, app: AppHandle, text: String, kind: ItemKind) -> Result<Item, String> {
    let item = db.0.add_item(&text, kind, None)?;
    let _ = app.emit("refresh", ());
    crate::notify::notify_captured(&app, &item);
    Ok(item)
}

#[tauri::command]
pub fn toggle_done(db: State<Db>, app: AppHandle, id: String) -> Result<(), String> {
    db.0.toggle_done(&id)?;
    let _ = app.emit("refresh", ());
    Ok(())
}

#[tauri::command]
pub fn toggle_bookmarked(db: State<Db>, app: AppHandle, id: String) -> Result<(), String> {
    db.0.toggle_bookmarked(&id)?;
    let _ = app.emit("refresh", ());
    Ok(())
}

#[tauri::command]
pub fn set_kind(db: State<Db>, app: AppHandle, id: String, kind: ItemKind) -> Result<(), String> {
    db.0.set_kind(&id, kind)?;
    let _ = app.emit("refresh", ());
    Ok(())
}

#[tauri::command]
pub fn delete_item(db: State<Db>, app: AppHandle, id: String) -> Result<(), String> {
    db.0.delete_item(&id)?;
    let _ = app.emit("refresh", ());
    Ok(())
}

#[tauri::command]
pub fn clear_completed(db: State<Db>, app: AppHandle) -> Result<(), String> {
    db.0.clear_completed()?;
    let _ = app.emit("refresh", ());
    Ok(())
}

#[tauri::command]
pub fn get_settings(settings: State<SettingsState>) -> Settings {
    settings.0.lock().unwrap().clone()
}

/// Persists the whole settings object and, if the fallback shortcut
/// accelerators changed, re-registers them immediately (new ones first, so a
/// bad accelerator string never leaves the user with no fallback at all).
#[tauri::command]
pub fn set_settings(settings: State<SettingsState>, app: AppHandle, next: Settings) -> Result<(), String> {
    let previous = settings.0.lock().unwrap().clone();
    if next.fallback_toggle != previous.fallback_toggle || next.fallback_capture != previous.fallback_capture {
        capture::reregister_fallback_shortcuts(
            &app,
            &previous.fallback_toggle,
            &previous.fallback_capture,
            &next.fallback_toggle,
            &next.fallback_capture,
        )?;
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
    let items = db.0.list_items()?;
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
