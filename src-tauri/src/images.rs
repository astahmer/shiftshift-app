//! Save-image support: a dedicated global shortcut (`fallback_image` in
//! Settings, alongside the toggle/capture ones) grabs whatever image is
//! currently on the system clipboard and stores it as a PNG file under the
//! app data dir. `Item::text` holds that file's absolute path for
//! `ItemKind::Image` items — the frontend renders it via Tauri's asset
//! protocol (`convertFileSrc`) rather than through any IPC round-trip of
//! the image bytes themselves.
//!
//! Double-shift capture now checks for an image *before* simulating the
//! text-copy chord (see `capture::do_capture`), so a screenshot already on
//! the clipboard is saved as-is. The dedicated shortcut remains for when
//! you want an image save without also trying a text selection.

use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Manager};

use crate::store::{Item, ItemKind};

fn images_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("images");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn write_png(image: &arboard::ImageData, path: &std::path::Path) -> Result<(), String> {
    let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let mut encoder = png::Encoder::new(
        std::io::BufWriter::new(file),
        image.width as u32,
        image.height as u32,
    );
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    writer
        .write_image_data(&image.bytes)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Copies a saved image item back to the system clipboard — the inverse of
/// `capture_clipboard_image`, so clicking a thumbnail is useful the way
/// cooper's is ("click a thumbnail to copy the image back to your clipboard").
pub fn copy_image_to_clipboard(path: &str) -> Result<(), String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let decoder = png::Decoder::new(std::io::BufReader::new(file));
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let mut buf = vec![
        0;
        reader
            .output_buffer_size()
            .ok_or("could not determine the PNG's buffer size")?
    ];
    let info = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
    buf.truncate(info.buffer_size());

    let mut clip = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clip.set_image(arboard::ImageData {
        width: info.width as usize,
        height: info.height as usize,
        bytes: std::borrow::Cow::Owned(buf),
    })
    .map_err(|e| e.to_string())
}

/// Fingerprint of the clipboard image, if any — used by `capture::do_capture`
/// to skip a second save of the same screenshot still sitting on the clipboard.
pub fn clipboard_image_fingerprint() -> Option<u64> {
    use std::hash::{Hash, Hasher};
    let mut clip = arboard::Clipboard::new().ok()?;
    let image = clip.get_image().ok()?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    image.width.hash(&mut hasher);
    image.height.hash(&mut hasher);
    image.bytes.hash(&mut hasher);
    Some(hasher.finish())
}

/// Saves the clipboard's current image as a new item, returning it (so the
/// frontend can push an undo entry the same way it does for text captures).
/// Errors (surfaced to the caller, e.g. a settings-screen toast) if the
/// clipboard has no image.
pub fn capture_clipboard_image(app: &AppHandle) -> Result<Item, String> {
    let mut clip = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    let image = clip
        .get_image()
        .map_err(|_| "the clipboard has no image right now".to_string())?;
    let path = images_dir(app)?.join(format!("{}.png", uuid::Uuid::new_v4()));
    write_png(&image, &path)?;

    let db = app.state::<crate::db::Db>();
    let item = {
        let _guard = db.store_lock.lock().map_err(|e| e.to_string())?;
        let item = db.store.add_item(
            &path.to_string_lossy(),
            ItemKind::Image,
            crate::capture::frontmost_app_name(),
        )?;
        let _ = db.store.log_event(Some(&item.id), "created", Some("image"));
        item
    };
    let _ = app.emit("refresh", ());
    let mode = app
        .state::<crate::settings::SettingsState>()
        .0
        .lock()
        .unwrap()
        .capture_mode;
    if mode == crate::capture::CaptureMode::Open {
        crate::panel::show(app);
    }
    crate::notify::notify_captured(app, &item);
    crate::automation::dispatch(
        app,
        crate::settings::AutomationEvent::ItemCreated,
        Some(item.clone()),
    );
    Ok(item)
}
