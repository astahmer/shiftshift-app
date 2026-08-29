use tauri::{AppHandle, Emitter, State};

use crate::db::Db;
use crate::store::{Item, ItemKind};

#[tauri::command]
pub fn list_items(db: State<Db>) -> Result<Vec<Item>, String> {
    db.0.list_items()
}

#[tauri::command]
pub fn add_item(db: State<Db>, app: AppHandle, text: String, kind: ItemKind) -> Result<Item, String> {
    let item = db.0.add_item(&text, kind, None)?;
    let _ = app.emit("refresh", ());
    Ok(item)
}

#[tauri::command]
pub fn toggle_done(db: State<Db>, app: AppHandle, id: String) -> Result<(), String> {
    db.0.toggle_done(&id)?;
    let _ = app.emit("refresh", ());
    Ok(())
}

#[tauri::command]
pub fn toggle_pinned(db: State<Db>, app: AppHandle, id: String) -> Result<(), String> {
    db.0.toggle_pinned(&id)?;
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
